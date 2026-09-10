import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { memoryExpiryFrom, defaultVerificationState } from "../db/lifecycle.js";
import { validateMemoryText, unicodeLength } from "../security/filters.js";
import type { MemoryRow, MemoryType, OperationRow, Scope, VerificationState } from "../db/types.js";
import { validateIdempotencyKey, isLegacyOwnedDocumentRow } from "../provider/validation.js";
import { buildProviderMetadata, textHashOf } from "./remember-service.js";
import { claimMemoryMutation, beginOwnedOperation, boundMutationSignal, applyProgressScopedOutcome, MutationTxRollbackError, runAtomicFinalization, postIssuanceFailureMustKeepReconciling } from "./mutation-ownership.js";
import { mutationNowMs } from "./mutation-clock.js";

export interface ReplaceRequest {
  targetMemoryId: string;
  scope: Scope;
  memoryType: MemoryType;
  text: string;
  cwd: string;
  sourceSessionId: string | null;
  sourceRef: string | null;
  idempotencyKey: string;
  expectedProjectIdentity?: string | null;
  /** Optional expected target text hash; when set, reject before mutation if the target changed. */
  expectedTargetTextHash?: string;
  owner?: "command" | "tool" | "candidate";
  signal?: AbortSignal | undefined;
}

export type ReplaceResult =
  | { outcome: "replaced"; memoryId: string }
  | { outcome: "rejected"; reason: string; code: string }
  | { outcome: "in_progress"; memoryId: string | null }
  | { outcome: "unknown"; reason: string; memoryId: string | null };

export function getReplaceAuditCode(result: ReplaceResult): string | null {
  switch (result.outcome) {
    case "rejected":
      return result.code;
    case "in_progress":
      return "in_progress";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

interface TargetCheck {
  ok: boolean;
  reason: string;
  code: string;
}

function checkTargetIdentity(
  target: MemoryRow | undefined,
  scope: Scope,
  memoryType: MemoryType,
  projectIdentity: string | null,
  bankId: string,
): TargetCheck {
  if (!target) return { ok: false, reason: "target memory was not found", code: "target_not_found" };
  if (target.scope !== scope) return { ok: false, reason: "target memory scope does not match", code: "target_wrong_scope" };
  if (target.memory_type !== memoryType) {
    return { ok: false, reason: "target memory type does not match", code: "target_wrong_type" };
  }
  if (target.project_identity !== projectIdentity) {
    return { ok: false, reason: "target memory project identity does not match", code: "target_wrong_project" };
  }
  if (target.bank_id !== bankId) {
    return { ok: false, reason: "target memory bank does not match", code: "target_wrong_bank" };
  }
  return { ok: true, reason: "", code: "" };
}

function checkTargetForNewClaim(
  target: MemoryRow | undefined,
  scope: Scope,
  memoryType: MemoryType,
  projectIdentity: string | null,
  bankId: string,
): TargetCheck {
  const identity = checkTargetIdentity(target, scope, memoryType, projectIdentity, bankId);
  if (!identity.ok) return identity;
  if (target!.status !== "active") {
    return { ok: false, reason: `target memory is not active (status: ${target!.status})`, code: "target_not_active" };
  }
  return { ok: true, reason: "", code: "" };
}

type ClaimResult =
  | { kind: "operation"; op: OperationRow; generation: number }
  | { kind: "rejected"; reason: string; code: string };

/**
 * Replacement lifecycle is derived only from durable operation.created_at so
 * retries send identical provider metadata without mutating the active row
 * before exact provider success.
 */
function replacementLifecycleFromOperation(
  op: OperationRow,
  memoryType: MemoryType,
): {
  verificationState: VerificationState;
  updatedAt: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
} {
  const createdMs = Date.parse(op.created_at);
  const base = Number.isFinite(createdMs) ? new Date(createdMs) : new Date(op.created_at);
  const verificationState = defaultVerificationState(memoryType);
  return {
    verificationState,
    updatedAt: op.created_at,
    lastVerifiedAt: verificationState === "verified" ? op.created_at : null,
    expiresAt: memoryExpiryFrom(memoryType, base),
  };
}

function finalizeReplace(
  runtime: GlobalRuntime,
  operationKey: string,
  memoryId: string,
  unitId: string,
  expectedGeneration: number,
  progressToken: string,
  params: {
    textHash: string;
    textLength: number;
    verificationState: VerificationState;
    updatedAt: string;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    sourceSessionId: string | null;
    sourceRef: string | null;
    owner: "command" | "tool" | "candidate";
  },
): ReplaceResult {
  const finalized = runAtomicFinalization(runtime, () => {
    const existing = runtime.repos.operations.getByKey(operationKey);
    if (existing?.state === "committed") {
      const row = runtime.repos.memories.getById(memoryId);
      if (
        row &&
        row.status === "active" &&
        row.text_hash === params.textHash &&
        row.mutation_owner_key === null
      ) {
        return true;
      }
      throw new MutationTxRollbackError("committed replace does not match memory truth");
    }

    const ok = runtime.repos.memories.applyReplace({
      id: memoryId,
      unitId,
      textHash: params.textHash,
      textLength: params.textLength,
      verificationState: params.verificationState,
      updatedAt: params.updatedAt,
      lastVerifiedAt: params.lastVerifiedAt,
      expiresAt: params.expiresAt,
      sourceSessionId: params.sourceSessionId,
      sourceRef: params.sourceRef,
      ownerKey: operationKey,
      expectedGeneration,
      progressToken,
    });
    if (!ok) {
      throw new MutationTxRollbackError("replace memory CAS failed");
    }
    if (!runtime.repos.operations.tryCommitFromProgress(operationKey, progressToken)) {
      throw new MutationTxRollbackError("replace operation commit CAS failed");
    }
    runtime.repos.audit.record({
      eventType: "remember",
      memoryId,
      outcome: `replaced_${params.owner}`,
    });
    return true;
  });
  if (!finalized) {
    return {
      outcome: "unknown",
      reason: "replace provider succeeded but local finalization lost ownership/generation",
      memoryId,
    };
  }
  return { outcome: "replaced", memoryId };
}

/**
 * Governed content replacement for an existing, exact, locally-known target
 * memory: reuses the target's own owned bank/document id (never a
 * caller-supplied locator), revalidates scope/type/project/status
 * immediately before mutation, and proves exactly one provider unit survives
 * with the new text before finalizing SQLite atomically. The target row's
 * `status` is flipped to `reconciling` for the duration of the attempt (CAS
 * via the serialized claim transaction below), which doubles as the lock
 * that rejects a second concurrent replace against the same target before
 * any provider mutation.
 */
export async function replaceMemory(runtime: GlobalRuntime, request: ReplaceRequest): Promise<ReplaceResult> {
  if (request.signal?.aborted) {
    return { outcome: "unknown", reason: "request was cancelled before write", memoryId: null };
  }
  const trimmed = request.text.trim();
  const validation = validateMemoryText(trimmed);
  if (!validation.ok) {
    return { outcome: "rejected", reason: validation.reason ?? "invalid memory text", code: "invalid_text" };
  }

  let bankId = runtime.profileBankId;
  let projectIdentity: string | null = null;
  if (request.scope === "project") {
    const projectBank = await resolveProjectBank(request.cwd);
    if (!projectBank.enabled) {
      return { outcome: "rejected", reason: `project scope is unavailable: ${projectBank.reason}`, code: "project_unavailable" };
    }
    if (request.expectedProjectIdentity !== undefined && request.expectedProjectIdentity !== projectBank.identity) {
      return { outcome: "rejected", reason: "project identity changed since this request was created", code: "project_identity_changed" };
    }
    bankId = projectBank.bankId;
    projectIdentity = projectBank.identity;
  }

  const newTextHash = textHashOf(trimmed);
  const idempotencyKey = request.idempotencyKey;
  if (!validateIdempotencyKey(idempotencyKey).ok) {
    return { outcome: "rejected", reason: "computed idempotency key is invalid", code: "invalid_idempotency_key" };
  }

  // Identity is checked early so obviously invalid targets never claim an
  // operation. Status is deliberately not required here: a reconciling row is
  // the honest retry surface for an existing same-key replace operation.
  const preTarget = runtime.repos.memories.getById(request.targetMemoryId);
  const preIdentity = checkTargetIdentity(preTarget, request.scope, request.memoryType, projectIdentity, bankId);
  if (!preIdentity.ok) {
    return { outcome: "rejected", reason: preIdentity.reason, code: preIdentity.code };
  }
  if (preTarget!.status === "deleted" || preTarget!.status === "superseded" || preTarget!.status === "expired") {
    return {
      outcome: "rejected",
      reason: `target memory is not active (status: ${preTarget!.status})`,
      code: "target_not_active",
    };
  }
  const existingOpEarly = runtime.repos.operations.getByKey(idempotencyKey);
  if (existingOpEarly) {
    if (
      existingOpEarly.action !== "replace" ||
      existingOpEarly.memory_id !== request.targetMemoryId ||
      existingOpEarly.expected_text_hash !== newTextHash ||
      existingOpEarly.bank_id !== preTarget!.bank_id ||
      existingOpEarly.document_id !== preTarget!.document_id
    ) {
      return {
        outcome: "rejected",
        reason: "existing operation does not match this replace request",
        code: "mismatched_operation",
      };
    }
    if (existingOpEarly.state === "committed") {
      if (
        preTarget!.text_hash === newTextHash &&
        preTarget!.document_id === existingOpEarly.document_id &&
        preTarget!.bank_id === existingOpEarly.bank_id &&
        preTarget!.status === "active"
      ) {
        return { outcome: "replaced", memoryId: existingOpEarly.memory_id };
      }
      return {
        outcome: "rejected",
        reason: "committed replace operation does not match current memory state",
        code: "mismatched_committed_operation",
      };
    }
  }

  const pastExpiry = preTarget!.expires_at && Date.parse(preTarget!.expires_at) <= mutationNowMs();
  if (pastExpiry) {
    const sameKeyResume = existingOpEarly && existingOpEarly.state !== "committed";
    if (!sameKeyResume) {
      return {
        outcome: "rejected",
        reason: "target memory is past its expiry and cannot be updated",
        code: "target_expired",
      };
    }
  }

  if (
    request.expectedTargetTextHash !== undefined &&
    preTarget!.text_hash !== request.expectedTargetTextHash
  ) {
    return {
      outcome: "rejected",
      reason: "target memory content changed since this request was created",
      code: "stale_target",
    };
  }

  const claimed = runtime.db.transaction((): ClaimResult => {
    const existingOp = runtime.repos.operations.getByKey(idempotencyKey);
    if (existingOp) {
      const ownership = claimMemoryMutation(runtime, request.targetMemoryId, idempotencyKey, {
        requireActiveForNewClaim: false,
      });
      if (!ownership.ok) {
        if (ownership.code === "busy") {
          return { kind: "rejected", reason: ownership.reason, code: "mutation_busy" };
        }
        return { kind: "rejected", reason: ownership.reason, code: ownership.code === "not_found" ? "target_not_found" : "target_not_active" };
      }
      return { kind: "operation", op: existingOp, generation: ownership.generation };
    }
    const ownership = claimMemoryMutation(runtime, request.targetMemoryId, idempotencyKey, {
      requireActiveForNewClaim: true,
    });
    if (!ownership.ok) {
      if (ownership.code === "busy") {
        return { kind: "rejected", reason: ownership.reason, code: "mutation_busy" };
      }
      return {
        kind: "rejected",
        reason: ownership.reason,
        code: ownership.code === "not_found" ? "target_not_found" : "target_not_active",
      };
    }
    const target = ownership.row;
    const check = checkTargetIdentity(target, request.scope, request.memoryType, projectIdentity, bankId);
    if (!check.ok) {
      runtime.repos.memories.clearMutationOwner(target.id, idempotencyKey);
      return { kind: "rejected", reason: check.reason, code: check.code };
    }
    if (
      request.expectedTargetTextHash !== undefined &&
      target.text_hash !== request.expectedTargetTextHash
    ) {
      runtime.repos.memories.clearMutationOwner(target.id, idempotencyKey);
      return {
        kind: "rejected",
        reason: "target memory content changed since this request was created",
        code: "stale_target",
      };
    }
    // Freeze legacy document derivation key before text_hash can change.
    if (isLegacyOwnedDocumentRow(target)) {
      runtime.repos.memories.freezeLegacyDocumentTextHash(target.id, target.text_hash);
    }
    const created = runtime.repos.operations.tryCreate({
      idempotencyKey,
      memoryId: target.id,
      action: "replace",
      bankId: target.bank_id,
      documentId: target.document_id,
      expectedTextHash: newTextHash,
      memoryGeneration: ownership.generation,
    });
    if (!created) {
      const existingByKey = runtime.repos.operations.getByKey(idempotencyKey);
      if (existingByKey) return { kind: "operation", op: existingByKey, generation: ownership.generation };
      runtime.repos.memories.clearMutationOwner(target.id, idempotencyKey);
      return { kind: "rejected", reason: "could not claim replace operation", code: "claim_failed" };
    }
    return {
      kind: "operation",
      op: runtime.repos.operations.getByKey(idempotencyKey)!,
      generation: ownership.generation,
    };
  });

  if (claimed.kind === "rejected") {
    if (claimed.code === "mutation_busy") {
      return { outcome: "in_progress", memoryId: request.targetMemoryId };
    }
    return { outcome: "rejected", reason: claimed.reason, code: claimed.code };
  }
  const op = claimed.op;
  const claimedGeneration = claimed.generation;
  if (
    op.action !== "replace" ||
    op.memory_id !== request.targetMemoryId ||
    op.expected_text_hash !== newTextHash ||
    op.bank_id !== preTarget!.bank_id ||
    op.document_id !== preTarget!.document_id ||
    (op.memory_generation !== null && op.memory_generation !== claimedGeneration)
  ) {
    return { outcome: "rejected", reason: "existing operation does not match this replace request", code: "mismatched_operation" };
  }

  // Retry of an in-flight legacy replace may not have frozen the key yet.
  const claimTarget = runtime.repos.memories.getById(request.targetMemoryId);
  if (claimTarget && isLegacyOwnedDocumentRow(claimTarget)) {
    runtime.repos.memories.freezeLegacyDocumentTextHash(claimTarget.id, claimTarget.text_hash);
  }

  const begun = beginOwnedOperation(runtime, idempotencyKey);
  if (!begun.ok) {
    if (begun.code === "committed") {
      const row = runtime.repos.memories.getById(begun.op.memory_id);
      if (
        row &&
        row.text_hash === newTextHash &&
        row.document_id === begun.op.document_id &&
        row.bank_id === begun.op.bank_id &&
        row.status === "active"
      ) {
        return { outcome: "replaced", memoryId: begun.op.memory_id };
      }
      return {
        outcome: "rejected",
        reason: "committed replace operation does not match current memory state",
        code: "mismatched_committed_operation",
      };
    }
    if (begun.code === "in_progress") {
      return { outcome: "in_progress", memoryId: begun.op.memory_id };
    }
    return { outcome: "unknown", reason: begun.reason, memoryId: op.memory_id };
  }

  const { progressToken, wasReconciling } = begun;
  const mutationSignal = boundMutationSignal(request.signal);

  if (mutationSignal.aborted) {
    applyProgressScopedOutcome(runtime, {
      memoryId: op.memory_id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: claimedGeneration,
      opState: "reconciling",
      memory: "keep_reconciling",
    });
    return { outcome: "unknown", reason: "request was cancelled before provider write", memoryId: op.memory_id };
  }

  const target = runtime.repos.memories.getById(op.memory_id);
  if (
    !target ||
    target.bank_id !== op.bank_id ||
    target.document_id !== op.document_id ||
    target.mutation_generation !== claimedGeneration ||
    target.mutation_owner_key !== idempotencyKey
  ) {
    applyProgressScopedOutcome(runtime, {
      memoryId: op.memory_id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: claimedGeneration,
      opState: "failed",
      memory: "clear_owner",
    });
    return { outcome: "rejected", reason: "target memory changed identity during replace", code: "target_changed" };
  }

  const owner = request.owner ?? "candidate";
  const lifecycle = replacementLifecycleFromOperation(begun.op, request.memoryType);
  const finalizeParams = {
    textHash: newTextHash,
    textLength: unicodeLength(trimmed),
    verificationState: lifecycle.verificationState,
    updatedAt: lifecycle.updatedAt,
    lastVerifiedAt: lifecycle.lastVerifiedAt,
    expiresAt: lifecycle.expiresAt,
    sourceSessionId: request.sourceSessionId,
    sourceRef: request.sourceRef,
    owner,
  };

  // Reconciling retries / stale takeover must prove the first write before any second retain.
  // Once absence/mismatch is proven, local prior text is no longer provider truth: later
  // definite bank/retain failures must stay reconciling (never release_active).
  let providerTruthDisproven = false;
  if (wasReconciling) {
    const verified = await runtime.adapter.verifyOneUnitDocument(
      target.bank_id,
      target.document_id,
      trimmed,
      mutationSignal,
    );
    if (verified.ok) {
      return finalizeReplace(
        runtime,
        idempotencyKey,
        target.id,
        verified.value.unitId,
        claimedGeneration,
        progressToken,
        finalizeParams,
      );
    }
    if (verified.ambiguous) {
      applyProgressScopedOutcome(runtime, {
        memoryId: op.memory_id,
        ownerKey: idempotencyKey,
        progressToken,
        expectedGeneration: claimedGeneration,
        opState: "reconciling",
        memory: "keep_reconciling",
      });
      return {
        outcome: "unknown",
        reason: `write outcome is uncertain: ${verified.reason}`,
        memoryId: op.memory_id,
      };
    }
    providerTruthDisproven = true;
    // Non-ambiguous absence/mismatch: fall through to one retain retry.
  }

  if (mutationSignal.aborted) {
    applyProgressScopedOutcome(runtime, {
      memoryId: op.memory_id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: claimedGeneration,
      opState: "reconciling",
      memory: "keep_reconciling",
    });
    return { outcome: "unknown", reason: "request was cancelled before provider write", memoryId: op.memory_id };
  }

  const bankReady = await runtime.adapter.ensureOwnedBank(target.bank_id, mutationSignal);
  if (!bankReady.ok) {
    const keepReconciling = bankReady.ambiguous || providerTruthDisproven;
    applyProgressScopedOutcome(runtime, {
      memoryId: target.id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: claimedGeneration,
      opState: keepReconciling ? "reconciling" : "failed",
      memory: keepReconciling ? "keep_reconciling" : "release_active",
    });
    return bankReady.ambiguous || providerTruthDisproven
      ? { outcome: "unknown", reason: `bank configuration uncertain: ${bankReady.reason}`, memoryId: op.memory_id }
      : { outcome: "rejected", reason: `bank configuration failed: ${bankReady.reason}`, code: "bank_config_failed" };
  }

  if (
    !runtime.db.transaction(() =>
      runtime.repos.operations.markProviderMutationIssued(idempotencyKey, progressToken),
    )
  ) {
    return { outcome: "unknown", reason: "replace ownership changed before provider write", memoryId: op.memory_id };
  }

  const retained = await runtime.adapter.retainOneMemory(
    {
      bankId: target.bank_id,
      documentId: target.document_id,
      text: trimmed,
      metadata: buildProviderMetadata(
        { id: target.id, textHash: newTextHash },
        {
          scope: request.scope,
          memoryType: request.memoryType,
          verificationState: lifecycle.verificationState,
          createdAt: target.created_at,
          updatedAt: finalizeParams.updatedAt,
          expiresAt: finalizeParams.expiresAt,
          lastVerifiedAt: finalizeParams.lastVerifiedAt,
          projectIdentity,
          sourceSessionId: request.sourceSessionId,
          sourceRef: request.sourceRef,
        },
      ),
    },
    mutationSignal,
  );

  if (!retained.ok) {
    if (postIssuanceFailureMustKeepReconciling(retained)) {
      const verified = await runtime.adapter.verifyOneUnitDocument(
        target.bank_id,
        target.document_id,
        trimmed,
        mutationSignal,
      );
      if (verified.ok) {
        return finalizeReplace(
          runtime,
          idempotencyKey,
          target.id,
          verified.value.unitId,
          claimedGeneration,
          progressToken,
          finalizeParams,
        );
      }
    }
    const keepReconciling = postIssuanceFailureMustKeepReconciling(retained) || providerTruthDisproven;
    applyProgressScopedOutcome(runtime, {
      memoryId: target.id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: claimedGeneration,
      opState: keepReconciling ? "reconciling" : "failed",
      memory: keepReconciling ? "keep_reconciling" : "release_active",
    });
    return keepReconciling
      ? { outcome: "unknown", reason: `write outcome is uncertain: ${retained.reason}`, memoryId: op.memory_id }
      : { outcome: "rejected", reason: `write failed: ${retained.reason}`, code: "provider_write_failed" };
  }

  return finalizeReplace(
    runtime,
    idempotencyKey,
    target.id,
    retained.value.unitId,
    claimedGeneration,
    progressToken,
    finalizeParams,
  );
}

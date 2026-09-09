import { createHash, randomUUID } from "node:crypto";
import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { memoryExpiryFrom, defaultVerificationState } from "../db/lifecycle.js";
import { validateMemoryText, unicodeLength } from "../security/filters.js";
import type { MemoryRow, MemoryType, OperationRow, Scope, VerificationState } from "../db/types.js";
import { PROFILE_MEMORY_TYPES, PROJECT_MEMORY_TYPES } from "../db/types.js";
import {
  buildCurrentOwnedDocumentId,
  validateBankId,
  validateIdempotencyKey,
  validateSourceRef,
  validateSourceSessionId,
} from "../provider/validation.js";
import {
  applyProgressScopedOutcome,
  beginOwnedOperation,
  boundMutationSignal,
  claimMemoryMutation,
  isActiveDuplicateRow,
  MutationTxRollbackError,
  operationIsResumableCreate,
  postIssuanceFailureMustKeepReconciling,
  resolveCreateIdempotencyKey,
  runAtomicFinalization,
} from "./mutation-ownership.js";

export interface RememberRequest {
  scope: Scope;
  memoryType: MemoryType;
  text: string;
  cwd: string;
  sourceSessionId: string | null;
  sourceRef: string | null;
  owner: "command" | "tool" | "candidate";
  idempotencyKey?: string;
  expectedProjectIdentity?: string | null;
  signal?: AbortSignal | undefined;
}

export type RememberResult =
  | { outcome: "written"; memoryId: string }
  | { outcome: "duplicate"; memoryId: string }
  | { outcome: "rejected"; reason: string; code: string }
  | { outcome: "conflict"; reason: string; conflictingMemoryId: string }
  | { outcome: "in_progress"; memoryId: string | null }
  | { outcome: "unknown"; reason: string; memoryId: string | null };

interface PreparedRemember {
  id: string;
  trimmed: string;
  textHash: string;
  bankId: string;
  projectIdentity: string | null;
  verificationState: VerificationState;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  idempotencyKey: string;
}

/** Placeholder id: only ever used before a row is claimed/created; never persisted or compared. */
const UNASSIGNED_ID = "";

function preparedFromRow(row: MemoryRow, idempotencyKey: string): PreparedRemember {
  return {
    id: row.id,
    trimmed: row.text_hash,
    textHash: row.text_hash,
    bankId: row.bank_id,
    projectIdentity: row.project_identity,
    verificationState: row.verification_state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    idempotencyKey,
  };
}

function rowMatchesPrepared(row: MemoryRow, prepared: PreparedRemember, request: RememberRequest): boolean {
  return (
    row.scope === request.scope &&
    row.memory_type === request.memoryType &&
    row.project_identity === prepared.projectIdentity &&
    row.bank_id === prepared.bankId &&
    row.text_hash === prepared.textHash
  );
}

function operationMatchesPrepared(
  operation: { action: string; memory_id: string; bank_id: string; document_id: string; expected_text_hash: string | null },
  row: MemoryRow,
  prepared: PreparedRemember,
): boolean {
  return (
    operation.action === "create" &&
    operation.memory_id === row.id &&
    operation.bank_id === prepared.bankId &&
    operation.document_id === row.document_id &&
    operation.expected_text_hash === prepared.textHash
  );
}

export function buildProviderMetadata(prepared: { id: string; textHash: string }, source: {
  scope: Scope;
  memoryType: MemoryType;
  verificationState: VerificationState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  projectIdentity: string | null;
  sourceSessionId: string | null;
  sourceRef: string | null;
}): Record<string, string> {
  return {
    logical_id: prepared.id,
    content_hash: prepared.textHash,
    scope: source.scope,
    memory_type: source.memoryType,
    verification_state: source.verificationState,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
    ...(source.expiresAt ? { expires_at: source.expiresAt } : {}),
    ...(source.lastVerifiedAt ? { last_verified_at: source.lastVerifiedAt } : {}),
    ...(source.projectIdentity !== null ? { project_identity: source.projectIdentity } : {}),
    ...(source.sourceSessionId !== null ? { source_session_id: source.sourceSessionId } : {}),
    ...(source.sourceRef !== null ? { source_ref: source.sourceRef } : {}),
  };
}

function finalizeRememberSuccess(
  runtime: GlobalRuntime,
  operationKey: string,
  memoryId: string,
  unitId: string,
  prepared: PreparedRemember,
  request: RememberRequest,
  progressToken: string,
  expectedGeneration: number,
): RememberResult {
  const finalized = runAtomicFinalization(runtime, () => {
    const existing = runtime.repos.operations.getByKey(operationKey);
    if (existing?.state === "committed") {
      // Idempotent only when memory already reflects the intended terminal create.
      const row = runtime.repos.memories.getById(memoryId);
      if (
        row &&
        row.status === "active" &&
        row.text_hash === prepared.textHash &&
        row.mutation_owner_key === null
      ) {
        return true;
      }
      throw new MutationTxRollbackError("committed create does not match memory truth");
    }

    const ok = runtime.repos.memories.activate({
      id: memoryId,
      unitId,
      verificationState: prepared.verificationState,
      createdAt: prepared.createdAt,
      updatedAt: prepared.updatedAt,
      lastVerifiedAt: prepared.lastVerifiedAt,
      expiresAt: prepared.expiresAt,
      ownerKey: operationKey,
      progressToken,
      expectedGeneration,
    });
    if (!ok) {
      throw new MutationTxRollbackError("create activate CAS failed");
    }
    if (!runtime.repos.operations.tryCommitFromProgress(operationKey, progressToken)) {
      // Do not accept a pre-existing committed op after this transaction mutated memory.
      throw new MutationTxRollbackError("create operation commit CAS failed");
    }
    runtime.repos.audit.record({
      eventType: "remember",
      memoryId,
      outcome: `written_${request.owner}`,
    });
    return true;
  });
  if (!finalized) {
    return {
      outcome: "unknown",
      reason: "create provider succeeded but local finalization lost ownership",
      memoryId,
    };
  }
  return { outcome: "written", memoryId };
}

export function textHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function isAllowedType(scope: Scope, memoryType: MemoryType): boolean {
  return scope === "profile"
    ? (PROFILE_MEMORY_TYPES as readonly string[]).includes(memoryType)
    : (PROJECT_MEMORY_TYPES as readonly string[]).includes(memoryType);
}

async function prepareRemember(runtime: GlobalRuntime, request: RememberRequest): Promise<PreparedRemember | RememberResult> {
  const trimmed = request.text.trim();
  const validation = validateMemoryText(trimmed);
  if (!validation.ok) {
    return { outcome: "rejected", reason: validation.reason ?? "invalid memory text", code: "invalid_text" };
  }
  if (!isAllowedType(request.scope, request.memoryType)) {
    return { outcome: "rejected", reason: "scope and memory type are inconsistent", code: "invalid_scope_type" };
  }
  const sessionCheck = validateSourceSessionId(request.sourceSessionId);
  if (!sessionCheck.ok) {
    return { outcome: "rejected", reason: sessionCheck.reason!, code: "invalid_source_session" };
  }
  const sourceRefCheck = validateSourceRef(request.sourceRef);
  if (!sourceRefCheck.ok) {
    return { outcome: "rejected", reason: sourceRefCheck.reason!, code: "invalid_source_ref" };
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

  const textHash = textHashOf(trimmed);
  const now = new Date();
  const createdAt = now.toISOString();
  const updatedAt = createdAt;
  const verificationState = defaultVerificationState(request.memoryType);
  const expiresAt = memoryExpiryFrom(request.memoryType, now);
  const lastVerifiedAt = verificationState === "verified" ? createdAt : null;
  const idempotencyKey =
    request.idempotencyKey ??
    `remember:${request.scope}:${request.memoryType}:${projectIdentity ?? "-"}:${textHash}`;
  if (!validateBankId(bankId).ok) {
    return { outcome: "rejected", reason: "computed bank id is invalid", code: "invalid_bank_id" };
  }
  if (!validateIdempotencyKey(idempotencyKey).ok) {
    return { outcome: "rejected", reason: "computed idempotency key is invalid", code: "invalid_idempotency_key" };
  }

  return {
    id: UNASSIGNED_ID,
    trimmed,
    textHash,
    bankId,
    projectIdentity,
    verificationState,
    expiresAt,
    createdAt,
    updatedAt,
    lastVerifiedAt,
    idempotencyKey,
  };
}

export function getRememberAuditCode(result: RememberResult): string | null {
  switch (result.outcome) {
    case "rejected":
      return result.code;
    case "conflict":
      return "conflict";
    case "in_progress":
      return "in_progress";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

/**
 * Exact-duplicate resubmission may promote an unverified non-inference memory
 * by replacing provider metadata under the same document. This path participates
 * in the durable per-memory mutation ownership/generation protocol so it cannot
 * race forget/update and recreate a deleted document.
 *
 * Adapter verify proves exact text only, not metadata fields. After an ambiguous
 * retain, a successful text verify is treated as sufficient to CAS-finalize the
 * intended verified metadata write (same as replace reconcile). If verify is
 * itself ambiguous, remain reconciling with zero additional retain.
 */
type ReverifyOutcome =
  | { kind: "skipped" }
  | { kind: "completed" }
  | { kind: "in_progress"; memoryId: string }
  | { kind: "unknown"; memoryId: string; reason: string };

async function reverifyDuplicateIfNeeded(
  runtime: GlobalRuntime,
  row: MemoryRow,
  request: RememberRequest,
): Promise<ReverifyOutcome> {
  if (row.verification_state !== "unverified") return { kind: "skipped" };
  if (row.memory_type === "inference") return { kind: "skipped" };
  if (request.signal?.aborted) {
    return { kind: "unknown", memoryId: row.id, reason: "request was cancelled before reverify" };
  }

  const textHash = row.text_hash;
  const idempotencyKey = `reverify:${row.id}:${textHash}:g${row.mutation_generation}`;

  const claimed = runtime.db.transaction(() => {
    const existing = runtime.repos.operations.getByKey(idempotencyKey);
    if (existing) {
      if (
        existing.action !== "replace" ||
        existing.memory_id !== row.id ||
        existing.bank_id !== row.bank_id ||
        existing.document_id !== row.document_id ||
        existing.expected_text_hash !== textHash ||
        (existing.memory_generation !== null && existing.memory_generation !== row.mutation_generation)
      ) {
        return { kind: "mismatch" as const };
      }
      const ownership = claimMemoryMutation(runtime, row.id, idempotencyKey, {
        requireActiveForNewClaim: false,
      });
      if (!ownership.ok) {
        if (ownership.code === "busy") return { kind: "busy" as const };
        return { kind: "unavailable" as const, reason: ownership.reason };
      }
      return { kind: "operation" as const, op: existing, generation: ownership.generation, owned: ownership.row };
    }

    const ownership = claimMemoryMutation(runtime, row.id, idempotencyKey, {
      requireActiveForNewClaim: true,
    });
    if (!ownership.ok) {
      if (ownership.code === "busy") return { kind: "busy" as const };
      return { kind: "unavailable" as const, reason: ownership.reason };
    }
    if (
      ownership.row.verification_state !== "unverified" ||
      ownership.row.text_hash !== textHash ||
      ownership.row.bank_id !== row.bank_id ||
      ownership.row.document_id !== row.document_id
    ) {
      runtime.repos.memories.clearMutationOwner(row.id, idempotencyKey);
      return { kind: "skipped_claim" as const };
    }
    const created = runtime.repos.operations.tryCreate({
      idempotencyKey,
      memoryId: row.id,
      action: "replace",
      bankId: ownership.row.bank_id,
      documentId: ownership.row.document_id,
      expectedTextHash: textHash,
      memoryGeneration: ownership.generation,
    });
    if (!created) {
      const existingByKey = runtime.repos.operations.getByKey(idempotencyKey);
      if (existingByKey) {
        return {
          kind: "operation" as const,
          op: existingByKey,
          generation: ownership.generation,
          owned: ownership.row,
        };
      }
      runtime.repos.memories.clearMutationOwner(row.id, idempotencyKey);
      return { kind: "unavailable" as const, reason: "could not claim reverify operation" };
    }
    return {
      kind: "operation" as const,
      op: runtime.repos.operations.getByKey(idempotencyKey)!,
      generation: ownership.generation,
      owned: ownership.row,
    };
  });

  if (claimed.kind === "busy") {
    return { kind: "in_progress", memoryId: row.id };
  }
  if (claimed.kind === "mismatch" || claimed.kind === "unavailable") {
    return {
      kind: "unknown",
      memoryId: row.id,
      reason: claimed.kind === "mismatch" ? "reverify operation does not match this memory generation" : claimed.reason,
    };
  }
  if (claimed.kind === "skipped_claim") {
    return { kind: "skipped" };
  }

  const generation = claimed.generation;
  const ownedRow = claimed.owned;
  const begun = beginOwnedOperation(runtime, idempotencyKey);
  if (!begun.ok) {
    if (begun.code === "committed") {
      const current = runtime.repos.memories.getById(row.id);
      if (current?.status === "active" && current.verification_state === "verified" && current.text_hash === textHash) {
        return { kind: "completed" };
      }
      return {
        kind: "unknown",
        memoryId: row.id,
        reason: "committed reverify does not match current memory state",
      };
    }
    if (begun.code === "in_progress") {
      return { kind: "in_progress", memoryId: row.id };
    }
    return { kind: "unknown", memoryId: row.id, reason: begun.reason };
  }

  const { progressToken, wasReconciling } = begun;
  const mutationSignal = boundMutationSignal(request.signal);
  const op = begun.op;

  if (mutationSignal.aborted) {
    applyProgressScopedOutcome(runtime, {
      memoryId: row.id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: "reconciling",
      memory: "keep_reconciling",
    });
    return { kind: "unknown", memoryId: row.id, reason: "request was cancelled before reverify" };
  }

  const trimmed = request.text.trim();
  // Stable lifecycle bytes from the operation claim time so retries are identical.
  const updatedAt = op.created_at;

  const finalizeReverify = (unitId: string): ReverifyOutcome => {
    const ok = runAtomicFinalization(runtime, () => {
      const existing = runtime.repos.operations.getByKey(idempotencyKey);
      if (existing?.state === "committed") {
        const current = runtime.repos.memories.getById(row.id);
        if (
          current &&
          current.status === "active" &&
          current.verification_state === "verified" &&
          current.text_hash === textHash &&
          current.mutation_owner_key === null
        ) {
          return true;
        }
        throw new MutationTxRollbackError("committed reverify does not match memory truth");
      }

      const applied = runtime.repos.memories.applyReverifyCas({
        id: row.id,
        unitId,
        textHash,
        verificationState: "verified",
        updatedAt,
        lastVerifiedAt: updatedAt,
        ownerKey: idempotencyKey,
        expectedGeneration: generation,
        expectedBankId: ownedRow.bank_id,
        expectedDocumentId: ownedRow.document_id,
        progressToken,
      });
      if (!applied) {
        throw new MutationTxRollbackError("reverify memory CAS failed");
      }
      if (!runtime.repos.operations.tryCommitFromProgress(idempotencyKey, progressToken)) {
        throw new MutationTxRollbackError("reverify operation commit CAS failed");
      }
      runtime.repos.audit.record({
        eventType: "remember",
        memoryId: row.id,
        outcome: `reverified_${request.owner}`,
      });
      return true;
    });
    if (!ok) {
      return {
        kind: "unknown",
        memoryId: row.id,
        reason: "reverify provider succeeded but local finalization lost ownership/generation",
      };
    }
    return { kind: "completed" };
  };

  // Once reconciling verify proves absence/mismatch, local prior truth is not on the
  // provider document; later definite bank/retain failures must stay reconciling.
  let providerTruthDisproven = false;
  if (wasReconciling) {
    const verified = await runtime.adapter.verifyOneUnitDocument(
      ownedRow.bank_id,
      ownedRow.document_id,
      trimmed,
      mutationSignal,
    );
    if (verified.ok) {
      // Text proof only: adapter cannot confirm metadata. We treat exact text
      // presence after an owned reverify retain as enough to CAS-finalize the
      // intended verified metadata write (mirrors replace reconcile).
      return finalizeReverify(verified.value.unitId);
    }
    if (verified.ambiguous) {
      applyProgressScopedOutcome(runtime, {
        memoryId: row.id,
        ownerKey: idempotencyKey,
        progressToken,
        expectedGeneration: generation,
        opState: "reconciling",
        memory: "keep_reconciling",
      });
      return {
        kind: "unknown",
        memoryId: row.id,
        reason: `reverify outcome is uncertain: ${verified.reason}`,
      };
    }
    providerTruthDisproven = true;
    // Exact absence/mismatch: one retain retry below.
  }

  const bankReady = await runtime.adapter.ensureOwnedBank(ownedRow.bank_id, mutationSignal);
  if (!bankReady.ok) {
    const keepReconciling = bankReady.ambiguous || providerTruthDisproven;
    applyProgressScopedOutcome(runtime, {
      memoryId: row.id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: keepReconciling ? "reconciling" : "failed",
      memory: keepReconciling ? "keep_reconciling" : "release_active",
    });
    return {
      kind: "unknown",
      memoryId: row.id,
      reason: keepReconciling
        ? `bank configuration uncertain: ${bankReady.reason}`
        : `bank configuration failed: ${bankReady.reason}`,
    };
  }

  if (
    !runtime.db.transaction(() =>
      runtime.repos.operations.markProviderMutationIssued(idempotencyKey, progressToken),
    )
  ) {
    return { kind: "unknown", memoryId: row.id, reason: "reverify ownership changed before provider write" };
  }

  const metadata = buildProviderMetadata(
    { id: ownedRow.id, textHash },
    {
      scope: ownedRow.scope,
      memoryType: ownedRow.memory_type,
      verificationState: "verified",
      createdAt: ownedRow.created_at,
      updatedAt,
      expiresAt: ownedRow.expires_at,
      lastVerifiedAt: updatedAt,
      projectIdentity: ownedRow.project_identity,
      sourceSessionId: ownedRow.source_session_id,
      sourceRef: ownedRow.source_ref,
    },
  );
  const retained = await runtime.adapter.retainOneMemory(
    { bankId: ownedRow.bank_id, documentId: ownedRow.document_id, text: trimmed, metadata },
    mutationSignal,
  );
  if (!retained.ok) {
    if (postIssuanceFailureMustKeepReconciling(retained)) {
      const verified = await runtime.adapter.verifyOneUnitDocument(
        ownedRow.bank_id,
        ownedRow.document_id,
        trimmed,
        mutationSignal,
      );
      if (verified.ok) {
        return finalizeReverify(verified.value.unitId);
      }
    }
    const keepReconciling = postIssuanceFailureMustKeepReconciling(retained) || providerTruthDisproven;
    applyProgressScopedOutcome(runtime, {
      memoryId: row.id,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: keepReconciling ? "reconciling" : "failed",
      memory: keepReconciling ? "keep_reconciling" : "release_active",
    });
    return {
      kind: "unknown",
      memoryId: row.id,
      reason: keepReconciling
        ? `reverify outcome is uncertain: ${retained.reason}`
        : `reverify failed: ${retained.reason}`,
    };
  }
  return finalizeReverify(retained.value.unitId);
}

type ClaimResult =
  | { kind: "operation"; op: OperationRow }
  | { kind: "duplicate"; row: MemoryRow }
  | { kind: "reconciling_duplicate"; row: MemoryRow }
  | { kind: "in_progress"; row: MemoryRow }
  | { kind: "rejected"; reason: string; code: string };

export async function remember(runtime: GlobalRuntime, request: RememberRequest): Promise<RememberResult> {
  if (request.signal?.aborted) {
    return { outcome: "unknown", reason: "request was cancelled before write", memoryId: null };
  }
  const initialPrepared = await prepareRemember(runtime, request);
  if ("outcome" in initialPrepared) return initialPrepared;
  let prepared: PreparedRemember = initialPrepared;

  const preexisting = runtime.repos.memories.findActiveByTextHash(
    request.scope,
    prepared.projectIdentity,
    request.memoryType,
    prepared.textHash,
  );
  if (preexisting) {
    const reverify = await reverifyDuplicateIfNeeded(runtime, preexisting, request);
    if (reverify.kind === "in_progress") {
      return { outcome: "in_progress", memoryId: reverify.memoryId };
    }
    if (reverify.kind === "unknown") {
      return { outcome: "unknown", reason: reverify.reason, memoryId: reverify.memoryId };
    }
    return { outcome: "duplicate", memoryId: preexisting.id };
  }

  // Resolve content-keyed create against historical committed ops (e.g. after forget).
  // Walk stale generations until a resumable op or a collision-free revive key is found.
  const baseKey = prepared.idempotencyKey;
  const resolvedKey = resolveCreateIdempotencyKey(
    (key) => runtime.repos.operations.getByKey(key),
    (id) => runtime.repos.memories.getById(id),
    baseKey,
    prepared.textHash,
  );
  if (!resolvedKey.ok) {
    return { outcome: "rejected", reason: resolvedKey.reason, code: resolvedKey.code };
  }
  prepared = { ...prepared, idempotencyKey: resolvedKey.key };
  if (!validateIdempotencyKey(prepared.idempotencyKey).ok) {
    return { outcome: "rejected", reason: "computed idempotency key is invalid", code: "invalid_idempotency_key" };
  }

  const claimed = runtime.db.transaction((): ClaimResult | null => {
    const existingOp = runtime.repos.operations.getByKey(prepared.idempotencyKey);
    if (existingOp) {
      if (existingOp.action !== "create" || existingOp.expected_text_hash !== prepared.textHash) {
        return {
          kind: "rejected",
          reason: "existing operation does not match this request",
          code: "mismatched_operation",
        };
      }
      const row = runtime.repos.memories.getById(existingOp.memory_id);
      if (existingOp.state === "committed") {
        if (isActiveDuplicateRow(row, prepared.textHash)) {
          return { kind: "duplicate", row };
        }
        return {
          kind: "rejected",
          reason: "historical create operation is not an active duplicate",
          code: "stale_create_operation",
        };
      }
      if (!operationIsResumableCreate(existingOp, row, prepared.textHash)) {
        return {
          kind: "rejected",
          reason: "existing operation does not match this request",
          code: "mismatched_operation",
        };
      }
      const ownership = claimMemoryMutation(runtime, existingOp.memory_id, prepared.idempotencyKey, {
        requireActiveForNewClaim: false,
      });
      if (!ownership.ok) {
        if (ownership.code === "busy") {
          return row ? { kind: "in_progress", row } : null;
        }
        return {
          kind: "rejected",
          reason: ownership.reason,
          code: "mutation_busy",
        };
      }
      return { kind: "operation", op: existingOp };
    }
    const dup = runtime.repos.memories.findActiveOrReconcilingByTextHash(
      request.scope,
      prepared.projectIdentity,
      request.memoryType,
      prepared.textHash,
    );
    if (dup) {
      return dup.status === "active"
        ? { kind: "duplicate", row: dup }
        : { kind: "reconciling_duplicate", row: dup };
    }

    const newId = randomUUID();
    const documentId = buildCurrentOwnedDocumentId(request.scope, prepared.projectIdentity, request.memoryType, newId);
    const placeholder = runtime.repos.memories.create({
      id: newId,
      scope: request.scope,
      memoryType: request.memoryType,
      projectIdentity: prepared.projectIdentity,
      bankId: prepared.bankId,
      documentId,
      unitId: null,
      textHash: prepared.textHash,
      textLength: unicodeLength(prepared.trimmed),
      verificationState: prepared.verificationState,
      sourceSessionId: request.sourceSessionId,
      sourceRef: request.sourceRef,
      supersedesMemoryId: null,
      expiresAt: prepared.expiresAt,
      status: "reconciling",
      createdAt: prepared.createdAt,
      updatedAt: prepared.updatedAt,
      lastVerifiedAt: prepared.lastVerifiedAt,
      mutationGeneration: 1,
      mutationOwnerKey: prepared.idempotencyKey,
    });
    const created = runtime.repos.operations.tryCreate({
      idempotencyKey: prepared.idempotencyKey,
      memoryId: placeholder.id,
      action: "create",
      bankId: prepared.bankId,
      documentId,
      expectedTextHash: prepared.textHash,
      memoryGeneration: 1,
    });
    if (!created) {
      const existingByKey = runtime.repos.operations.getByKey(prepared.idempotencyKey);
      runtime.repos.memories.deleteById(placeholder.id);
      return existingByKey ? { kind: "operation", op: existingByKey } : null;
    }
    return { kind: "operation", op: runtime.repos.operations.getByKey(prepared.idempotencyKey)! };
  });

  if (!claimed) {
    return { outcome: "unknown", reason: "could not claim operation ownership", memoryId: null };
  }
  if (claimed.kind === "rejected") {
    return { outcome: "rejected", reason: claimed.reason, code: claimed.code };
  }
  if (claimed.kind === "duplicate") {
    if (!isActiveDuplicateRow(claimed.row, prepared.textHash)) {
      return { outcome: "rejected", reason: "duplicate target is not an active memory", code: "stale_duplicate" };
    }
    const reverify = await reverifyDuplicateIfNeeded(runtime, claimed.row, request);
    if (reverify.kind === "in_progress") {
      return { outcome: "in_progress", memoryId: reverify.memoryId };
    }
    if (reverify.kind === "unknown") {
      return { outcome: "unknown", reason: reverify.reason, memoryId: reverify.memoryId };
    }
    return { outcome: "duplicate", memoryId: claimed.row.id };
  }
  if (claimed.kind === "reconciling_duplicate") {
    // Exact-text reconciling row: resume duplicate reverify (or report busy for create).
    if (claimed.row.verification_state === "unverified") {
      const reverify = await reverifyDuplicateIfNeeded(runtime, claimed.row, request);
      if (reverify.kind === "in_progress") {
        return { outcome: "in_progress", memoryId: reverify.memoryId };
      }
      if (reverify.kind === "unknown") {
        return { outcome: "unknown", reason: reverify.reason, memoryId: reverify.memoryId };
      }
      if (reverify.kind === "completed" || reverify.kind === "skipped") {
        const current = runtime.repos.memories.getById(claimed.row.id);
        if (isActiveDuplicateRow(current, prepared.textHash)) {
          return { outcome: "duplicate", memoryId: claimed.row.id };
        }
      }
    }
    return { outcome: "in_progress", memoryId: claimed.row.id };
  }
  if (claimed.kind === "in_progress") {
    return { outcome: "in_progress", memoryId: claimed.row.id };
  }
  const claimedOp = claimed.op;
  const claimedRow = runtime.repos.memories.getById(claimedOp.memory_id);
  if (!claimedRow) {
    return { outcome: "unknown", reason: "claimed operation has no memory row", memoryId: null };
  }
  if (!rowMatchesPrepared(claimedRow, prepared, request)) {
    return { outcome: "rejected", reason: "claimed memory row does not match this request", code: "mismatched_memory_row" };
  }
  if (!operationMatchesPrepared(claimedOp, claimedRow, prepared)) {
    return { outcome: "rejected", reason: "existing operation does not match this request", code: "mismatched_operation" };
  }
  request = {
    ...request,
    sourceSessionId: claimedRow.source_session_id,
    sourceRef: claimedRow.source_ref,
    expectedProjectIdentity: claimedRow.project_identity,
  };
  const rowPrepared = preparedFromRow(claimedRow, claimedOp.idempotency_key);
  const operationKey = claimedOp.idempotency_key;
  const begun = beginOwnedOperation(runtime, operationKey);
  if (!begun.ok) {
    if (begun.code === "committed") {
      const row = runtime.repos.memories.getById(begun.op.memory_id);
      if (isActiveDuplicateRow(row, prepared.textHash)) {
        return { outcome: "duplicate", memoryId: begun.op.memory_id };
      }
      return {
        outcome: "rejected",
        reason: "historical create operation is not an active duplicate",
        code: "stale_create_operation",
      };
    }
    if (begun.code === "in_progress") {
      return { outcome: "in_progress", memoryId: begun.op.memory_id };
    }
    return { outcome: "unknown", reason: begun.reason, memoryId: claimedOp.memory_id };
  }

  const { progressToken, wasReconciling } = begun;
  const mutationSignal = boundMutationSignal(request.signal);

  if (mutationSignal.aborted) {
    applyProgressScopedOutcome(runtime, {
      memoryId: claimedOp.memory_id,
      ownerKey: operationKey,
      progressToken,
      expectedGeneration: claimedRow.mutation_generation,
      opState: "reconciling",
      memory: "keep_reconciling",
    });
    return { outcome: "unknown", reason: "request was cancelled before provider write", memoryId: claimedOp.memory_id };
  }

  // Ambiguous prior attempts / stale takeover: verify first. Ambiguous verify => unknown, zero retain.
  if (wasReconciling) {
    const verified = await runtime.adapter.verifyOneUnitDocument(
      claimedRow.bank_id,
      claimedRow.document_id,
      request.text.trim(),
      mutationSignal,
    );
    if (verified.ok) {
      return finalizeRememberSuccess(
        runtime,
        operationKey,
        claimedOp.memory_id,
        verified.value.unitId,
        rowPrepared,
        request,
        progressToken,
        claimedRow.mutation_generation,
      );
    }
    if (verified.ambiguous) {
      applyProgressScopedOutcome(runtime, {
        memoryId: claimedOp.memory_id,
        ownerKey: operationKey,
        progressToken,
        expectedGeneration: claimedRow.mutation_generation,
        opState: "reconciling",
        memory: "keep_reconciling",
      });
      return {
        outcome: "unknown",
        reason: `write outcome is uncertain: ${verified.reason}`,
        memoryId: claimedOp.memory_id,
      };
    }
    // Exact non-ambiguous absence/mismatch: one safe retain retry below.
  }

  const bankReady = await runtime.adapter.ensureOwnedBank(claimedRow.bank_id, mutationSignal);
  if (!bankReady.ok) {
    // Create never had prior active truth: keep reconciling even on definite bank failure.
    applyProgressScopedOutcome(runtime, {
      memoryId: claimedOp.memory_id,
      ownerKey: operationKey,
      progressToken,
      expectedGeneration: claimedRow.mutation_generation,
      opState: bankReady.ambiguous ? "reconciling" : "failed",
      memory: "keep_reconciling",
    });
    return bankReady.ambiguous
      ? { outcome: "unknown", reason: `bank configuration uncertain: ${bankReady.reason}`, memoryId: claimedOp.memory_id }
      : { outcome: "rejected", reason: `bank configuration failed: ${bankReady.reason}`, code: "bank_config_failed" };
  }

  if (
    !runtime.db.transaction(() =>
      runtime.repos.operations.markProviderMutationIssued(operationKey, progressToken),
    )
  ) {
    return {
      outcome: "unknown",
      reason: "create ownership changed before provider write",
      memoryId: claimedOp.memory_id,
    };
  }

  const retained = await runtime.adapter.retainOneMemory(
    {
      bankId: claimedRow.bank_id,
      documentId: claimedRow.document_id,
      text: request.text.trim(),
      metadata: buildProviderMetadata(
        { id: claimedRow.id, textHash: rowPrepared.textHash },
        {
          scope: request.scope,
          memoryType: request.memoryType,
          verificationState: rowPrepared.verificationState,
          createdAt: rowPrepared.createdAt,
          updatedAt: rowPrepared.updatedAt,
          expiresAt: rowPrepared.expiresAt,
          lastVerifiedAt: rowPrepared.lastVerifiedAt,
          projectIdentity: rowPrepared.projectIdentity,
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
        claimedRow.bank_id,
        claimedRow.document_id,
        request.text.trim(),
        mutationSignal,
      );
      if (verified.ok) {
        return finalizeRememberSuccess(
          runtime,
          operationKey,
          claimedOp.memory_id,
          verified.value.unitId,
          rowPrepared,
          request,
          progressToken,
          claimedRow.mutation_generation,
        );
      }
    }
    // Create never had prior active truth: keep reconciling even on definite retain failure.
    applyProgressScopedOutcome(runtime, {
      memoryId: claimedOp.memory_id,
      ownerKey: operationKey,
      progressToken,
      expectedGeneration: claimedRow.mutation_generation,
      opState: postIssuanceFailureMustKeepReconciling(retained) ? "reconciling" : "failed",
      memory: "keep_reconciling",
    });
    return postIssuanceFailureMustKeepReconciling(retained)
      ? { outcome: "unknown", reason: `write outcome is uncertain: ${retained.reason}`, memoryId: claimedOp.memory_id }
      : { outcome: "rejected", reason: `write failed: ${retained.reason}`, code: "provider_write_failed" };
  }

  return finalizeRememberSuccess(
    runtime,
    operationKey,
    claimedOp.memory_id,
    retained.value.unitId,
    rowPrepared,
    request,
    progressToken,
    claimedRow.mutation_generation,
  );
}

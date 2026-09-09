import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { projectBankId } from "../identity/bank-id.js";
import { rowOwnsDocumentId, validateBankId, validateDocumentId } from "../provider/validation.js";
import {
  beginOwnedOperation,
  boundMutationSignal,
  claimMemoryMutation,
  forgetIdempotencyKey,
  applyProgressScopedOutcome,
  MutationTxRollbackError,
  runAtomicFinalization,
  postIssuanceFailureMustKeepReconciling,
} from "./mutation-ownership.js";

export type ForgetResult =
  | { outcome: "forgotten" }
  | { outcome: "unknown"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "in_progress"; reason: string };

function finalizeForgetSuccess(
  runtime: GlobalRuntime,
  memoryId: string,
  idempotencyKey: string,
  progressToken: string,
  generation: number,
  expectedTextHash: string,
  expectedDocumentId: string,
): ForgetResult {
  const finalized = runAtomicFinalization(runtime, () => {
    const existing = runtime.repos.operations.getByKey(idempotencyKey);
    if (existing?.state === "committed") {
      const row = runtime.repos.memories.getById(memoryId);
      if (row && row.status === "deleted" && row.mutation_owner_key === null) {
        return true;
      }
      throw new MutationTxRollbackError("committed delete does not match memory truth");
    }

    const ok = runtime.repos.memories.markDeletedCas({
      id: memoryId,
      ownerKey: idempotencyKey,
      expectedGeneration: generation,
      expectedTextHash,
      expectedDocumentId,
      progressToken,
    });
    if (!ok) {
      throw new MutationTxRollbackError("delete memory CAS failed");
    }
    if (!runtime.repos.operations.tryCommitFromProgress(idempotencyKey, progressToken)) {
      throw new MutationTxRollbackError("delete operation commit CAS failed");
    }
    runtime.repos.audit.record({ eventType: "forget", memoryId, outcome: "deleted" });
    return true;
  });
  if (!finalized) {
    return {
      outcome: "unknown",
      reason: "delete provider succeeded but local finalization lost ownership/generation",
    };
  }
  return { outcome: "forgotten" };
}

export async function forgetMemory(runtime: GlobalRuntime, memoryId: string, signal?: AbortSignal): Promise<ForgetResult> {
  if (signal?.aborted) return { outcome: "unknown", reason: "request was cancelled before delete" };
  const preRow = runtime.repos.memories.getOwnedActiveOrReconcilingById(memoryId);
  if (!preRow) return { outcome: "rejected", reason: "unknown local memory id" };
  const expectedBankId =
    preRow.scope === "profile"
      ? runtime.profileBankId
      : preRow.project_identity
        ? projectBankId(preRow.project_identity)
        : null;
  if (
    !validateBankId(preRow.bank_id).ok ||
    !validateDocumentId(preRow.document_id).ok ||
    !/^[0-9a-f]{64}$/.test(preRow.text_hash) ||
    (preRow.scope === "profile" && preRow.project_identity !== null) ||
    (preRow.scope === "project" && preRow.project_identity === null) ||
    preRow.bank_id !== expectedBankId ||
    !rowOwnsDocumentId(preRow)
  ) {
    return { outcome: "rejected", reason: "stored memory locator is invalid" };
  }

  const idempotencyKey = forgetIdempotencyKey(
    memoryId,
    preRow.mutation_generation,
    preRow.text_hash,
    preRow.document_id,
  );

  const claimed = runtime.db.transaction(() => {
    const existing = runtime.repos.operations.getByKey(idempotencyKey);
    if (existing) {
      if (
        existing.action !== "delete" ||
        existing.memory_id !== memoryId ||
        existing.bank_id !== preRow.bank_id ||
        existing.document_id !== preRow.document_id ||
        existing.expected_text_hash !== preRow.text_hash ||
        (existing.memory_generation !== null && existing.memory_generation !== preRow.mutation_generation)
      ) {
        return { kind: "rejected" as const, reason: "delete operation locator mismatch" };
      }
      const ownership = claimMemoryMutation(runtime, memoryId, idempotencyKey, {
        requireActiveForNewClaim: false,
      });
      if (!ownership.ok) {
        if (ownership.code === "busy") {
          return { kind: "busy" as const, reason: ownership.reason };
        }
        return { kind: "rejected" as const, reason: ownership.reason };
      }
      return { kind: "operation" as const, op: existing, generation: ownership.generation };
    }

    const ownership = claimMemoryMutation(runtime, memoryId, idempotencyKey, {
      requireActiveForNewClaim: true,
    });
    if (!ownership.ok) {
      if (ownership.code === "busy") {
        return { kind: "busy" as const, reason: ownership.reason };
      }
      return { kind: "rejected" as const, reason: ownership.reason };
    }
    const row = ownership.row;
    if (
      row.text_hash !== preRow.text_hash ||
      row.document_id !== preRow.document_id ||
      row.mutation_generation !== preRow.mutation_generation
    ) {
      runtime.repos.memories.clearMutationOwner(memoryId, idempotencyKey);
      return { kind: "rejected" as const, reason: "memory generation changed before delete claim" };
    }
    const created = runtime.repos.operations.tryCreate({
      idempotencyKey,
      memoryId,
      action: "delete",
      bankId: row.bank_id,
      documentId: row.document_id,
      expectedTextHash: row.text_hash,
      memoryGeneration: ownership.generation,
    });
    if (!created) {
      const existingByKey = runtime.repos.operations.getByKey(idempotencyKey);
      if (existingByKey) {
        return { kind: "operation" as const, op: existingByKey, generation: ownership.generation };
      }
      runtime.repos.memories.clearMutationOwner(memoryId, idempotencyKey);
      return { kind: "rejected" as const, reason: "could not claim delete operation" };
    }
    return {
      kind: "operation" as const,
      op: runtime.repos.operations.getByKey(idempotencyKey)!,
      generation: ownership.generation,
    };
  });

  if (claimed.kind === "rejected") return { outcome: "rejected", reason: claimed.reason };
  if (claimed.kind === "busy") return { outcome: "in_progress", reason: claimed.reason };

  const generation = claimed.generation;
  const begun = beginOwnedOperation(runtime, idempotencyKey);
  if (!begun.ok) {
    if (begun.code === "committed") {
      const row = runtime.repos.memories.getById(memoryId);
      if (row?.status === "deleted") return { outcome: "forgotten" };
      return { outcome: "rejected", reason: "committed delete does not match current memory state" };
    }
    if (begun.code === "in_progress") {
      return { outcome: "unknown", reason: "delete already in progress" };
    }
    return { outcome: "unknown", reason: begun.reason };
  }

  const { progressToken, wasReconciling } = begun;
  const operation = begun.op;
  const mutationSignal = boundMutationSignal(signal);

  if (mutationSignal.aborted) {
    applyProgressScopedOutcome(runtime, {
      memoryId,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: "reconciling",
      memory: "keep_reconciling",
    });
    return { outcome: "unknown", reason: "request was cancelled before provider delete" };
  }

  const row = runtime.repos.memories.getById(memoryId);
  if (
    !row ||
    row.bank_id !== operation.bank_id ||
    row.document_id !== operation.document_id ||
    row.text_hash !== operation.expected_text_hash ||
    row.mutation_generation !== generation
  ) {
    applyProgressScopedOutcome(runtime, {
      memoryId,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: "failed",
      memory: "clear_owner",
    });
    return { outcome: "rejected", reason: "memory generation changed before provider delete" };
  }

  // Reconciling / stale takeover: prove absence before any DELETE.
  if (wasReconciling) {
    const proof = await runtime.adapter.verifyDeletionPostconditions(
      row.bank_id,
      row.document_id,
      mutationSignal,
    );
    if (proof.ok && proof.value.absent) {
      return finalizeForgetSuccess(
        runtime,
        memoryId,
        idempotencyKey,
        progressToken,
        generation,
        operation.expected_text_hash!,
        operation.document_id,
      );
    }
    if (!proof.ok && proof.ambiguous) {
      applyProgressScopedOutcome(runtime, {
        memoryId,
        ownerKey: idempotencyKey,
        progressToken,
        expectedGeneration: generation,
        opState: "reconciling",
        memory: "keep_reconciling",
      });
      return { outcome: "unknown", reason: `delete outcome is uncertain: ${proof.reason}` };
    }
    // Proven present: fall through to idempotent DELETE.
  }

  if (
    !runtime.db.transaction(() =>
      runtime.repos.operations.markProviderMutationIssued(idempotencyKey, progressToken),
    )
  ) {
    return { outcome: "unknown", reason: "delete ownership changed before provider delete" };
  }

  const deleted = await runtime.adapter.deleteMemoryDocument(row.bank_id, row.document_id, mutationSignal);
  if (!deleted.ok) {
    const keepReconciling = postIssuanceFailureMustKeepReconciling(deleted);
    applyProgressScopedOutcome(runtime, {
      memoryId,
      ownerKey: idempotencyKey,
      progressToken,
      expectedGeneration: generation,
      opState: keepReconciling ? "reconciling" : "failed",
      memory: keepReconciling ? "keep_reconciling" : "release_active",
    });
    return keepReconciling
      ? { outcome: "unknown", reason: `delete outcome is uncertain: ${deleted.reason}` }
      : { outcome: "rejected", reason: `delete failed: ${deleted.reason}` };
  }

  return finalizeForgetSuccess(
    runtime,
    memoryId,
    idempotencyKey,
    progressToken,
    generation,
    operation.expected_text_hash!,
    operation.document_id,
  );
}

import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { isValidOwnedMemoryLocator } from "./memory-locator.js";
import { mutationNowIso } from "./mutation-clock.js";
import {
  beginOwnedOperation,
  boundMutationSignal,
  claimMemoryMutation,
  expireIdempotencyKey,
  applyProgressScopedOutcome,
  MutationTxRollbackError,
  runAtomicFinalization,
  postIssuanceFailureMustKeepReconciling,
  prepareExpiryHandoff,
} from "./mutation-ownership.js";

export type ExpireResult =
  | { outcome: "expired" }
  | { outcome: "unknown"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "in_progress"; reason: string };

function finalizeExpireSuccess(
  runtime: GlobalRuntime,
  memoryId: string,
  idempotencyKey: string,
  progressToken: string,
  generation: number,
  expectedTextHash: string,
  expectedDocumentId: string,
): ExpireResult {
  const finalized = runAtomicFinalization(runtime, () => {
    const existing = runtime.repos.operations.getByKey(idempotencyKey);
    if (existing?.state === "committed") {
      const row = runtime.repos.memories.getById(memoryId);
      if (row && row.status === "expired" && row.mutation_owner_key === null) {
        runtime.repos.candidates.purgeBodiesForMemory(memoryId);
        return true;
      }
      throw new MutationTxRollbackError("committed expire does not match memory truth");
    }

    const ok = runtime.repos.memories.markExpiredCas({
      id: memoryId,
      ownerKey: idempotencyKey,
      expectedGeneration: generation,
      expectedTextHash,
      expectedDocumentId,
      progressToken,
    });
    if (!ok) {
      throw new MutationTxRollbackError("expire memory CAS failed");
    }
    if (!runtime.repos.operations.tryCommitFromProgress(idempotencyKey, progressToken)) {
      throw new MutationTxRollbackError("expire operation commit CAS failed");
    }
    runtime.repos.candidates.purgeBodiesForMemory(memoryId);
    runtime.repos.audit.record({ eventType: "expire", memoryId, outcome: "expired" });
    return true;
  });
  if (!finalized) {
    return {
      outcome: "unknown",
      reason: "expire provider succeeded but local finalization lost ownership/generation",
    };
  }
  return { outcome: "expired" };
}

/**
 * Governed formal-memory expiry: exact-document DELETE via the same durable
 * ownership/generation/progress-token protocol as forget, ending in `expired`.
 */
export async function expireMemory(
  runtime: GlobalRuntime,
  memoryId: string,
  signal?: AbortSignal,
): Promise<ExpireResult> {
  if (signal?.aborted) return { outcome: "unknown", reason: "request was cancelled before expire" };
  const nowIso = mutationNowIso();
  const handoff = prepareExpiryHandoff(runtime, memoryId);
  if (!handoff.ok) {
    switch (handoff.reason) {
      case "live_owner":
        return {
          outcome: "in_progress",
          reason: "memory expiry is blocked by a live foreign mutation lease",
        };
      case "incoherent":
        return { outcome: "rejected", reason: "memory expiry handoff is incoherent" };
      case "not_found":
        return { outcome: "rejected", reason: "unknown local memory id" };
      case "not_due":
      case "not_foreign":
        break;
    }
  }
  const preRow = runtime.repos.memories.getOwnedActiveOrReconcilingById(memoryId);
  if (!preRow) return { outcome: "rejected", reason: "unknown local memory id" };
  const expectedExpireKey = expireIdempotencyKey(
    memoryId,
    preRow.mutation_generation,
    preRow.text_hash,
    preRow.document_id,
  );
  if (!preRow.expires_at || preRow.expires_at > nowIso) {
    if (!(preRow.status === "reconciling" && preRow.mutation_owner_key === expectedExpireKey)) {
      return { outcome: "rejected", reason: "memory is not due for expiry" };
    }
  }
  if (!isValidOwnedMemoryLocator(runtime, preRow)) {
    return { outcome: "rejected", reason: "stored memory locator is invalid" };
  }

  const idempotencyKey = expireIdempotencyKey(
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
        return { kind: "rejected" as const, reason: "expire operation locator mismatch" };
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
      return { kind: "rejected" as const, reason: "memory generation changed before expire claim" };
    }
    if (!row.expires_at || row.expires_at > mutationNowIso()) {
      runtime.repos.memories.clearMutationOwner(memoryId, idempotencyKey);
      return { kind: "rejected" as const, reason: "memory is not due for expiry" };
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
      return { kind: "rejected" as const, reason: "could not claim expire operation" };
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
      if (row?.status === "expired") return { outcome: "expired" };
      return { outcome: "rejected", reason: "committed expire does not match current memory state" };
    }
    if (begun.code === "in_progress") {
      return { outcome: "unknown", reason: "expire already in progress" };
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
    return { outcome: "unknown", reason: "request was cancelled before provider expire delete" };
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
    return { outcome: "rejected", reason: "memory generation changed before provider expire delete" };
  }

  if (wasReconciling) {
    const proof = await runtime.adapter.verifyDeletionPostconditions(
      row.bank_id,
      row.document_id,
      mutationSignal,
    );
    if (proof.ok && proof.value.absent) {
      return finalizeExpireSuccess(
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
      return { outcome: "unknown", reason: `expire outcome is uncertain: ${proof.reason}` };
    }
  }

  if (
    !runtime.db.transaction(() =>
      runtime.repos.operations.markProviderMutationIssued(idempotencyKey, progressToken),
    )
  ) {
    return { outcome: "unknown", reason: "expire ownership changed before provider delete" };
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
      ? { outcome: "unknown", reason: `expire outcome is uncertain: ${deleted.reason}` }
      : { outcome: "rejected", reason: `expire failed: ${deleted.reason}` };
  }

  return finalizeExpireSuccess(
    runtime,
    memoryId,
    idempotencyKey,
    progressToken,
    generation,
    operation.expected_text_hash!,
    operation.document_id,
  );
}

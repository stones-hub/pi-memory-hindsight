/**
 * Durable per-memory mutation ownership coordinated through SQLite.
 * Multiple Pi windows share the same DB; never hold a transaction across network I/O.
 *
 * Crash recovery: `in_progress` operations hold a conservative lease derived from
 * the bounded provider HTTP timeout × max chained calls. After expiry, the same
 * logical operation may atomically take over into `reconciling` (same owner key /
 * generation) and must verify provider postconditions before any further mutation.
 * Stale delayed completions CAS on `(state=in_progress, updated_at=progressToken)`.
 */

import { createHash } from "node:crypto";
import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { MemoryRow, OperationRow, OperationState } from "../db/types.js";
import { PROVIDER_HTTP_TIMEOUT_MS } from "../provider/http-client.js";
import { validateIdempotencyKey } from "../provider/validation.js";
import { isValidOwnedMemoryLocator } from "./memory-locator.js";
import { mutationNowIso, mutationNowMs } from "./mutation-clock.js";

/**
 * Worst-case sequential HTTP calls in one mutation attempt:
 * verify(1) + ensureOwnedBank(3) + retain+verify(2) + post-ambiguous verify(1) = 7.
 * Delete verify-first + optional DELETE+postconditions ≤ 5. Use 8 for headroom.
 */
export const MUTATION_MAX_PROVIDER_HTTP_CALLS = 8;

/**
 * Conservative lease longer than every bounded provider/reconciliation path.
 * One extra timeout of slack beyond the max call budget.
 */
export const MUTATION_OPERATION_LEASE_MS =
  PROVIDER_HTTP_TIMEOUT_MS * MUTATION_MAX_PROVIDER_HTTP_CALLS + PROVIDER_HTTP_TIMEOUT_MS;

const BLOCKING_OWNER_STATES: ReadonlySet<OperationState> = new Set([
  "pending",
  "in_progress",
  "reconciling",
]);

export type MutationClaimFailure =
  | { ok: false; code: "busy"; reason: string; ownerKey: string | null }
  | { ok: false; code: "not_found"; reason: string }
  | { ok: false; code: "not_claimable"; reason: string; status: string };

export type MutationClaimSuccess = { ok: true; row: MemoryRow; generation: number };

export type MutationClaimResult = MutationClaimSuccess | MutationClaimFailure;

export type BeginOperationResult =
  | {
      ok: true;
      op: OperationRow;
      /** `operations.updated_at` after entering `in_progress`; required for CAS finalization. */
      progressToken: string;
      wasReconciling: boolean;
    }
  | { ok: false; code: "in_progress"; op: OperationRow }
  | { ok: false; code: "committed"; op: OperationRow }
  | { ok: false; code: "conflict"; reason: string; op?: OperationRow };

function parseUpdatedAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function isOperationLeaseExpired(op: OperationRow, nowMs: number = mutationNowMs()): boolean {
  return nowMs - parseUpdatedAtMs(op.updated_at) > MUTATION_OPERATION_LEASE_MS;
}

function providerMutationIssued(op: OperationRow): boolean {
  return Number(op.provider_mutation_issued) === 1;
}

/**
 * Combines an optional caller signal with the mutation lease bound so a single
 * attempt cannot outlive the durable lease window.
 */
export function boundMutationSignal(signal?: AbortSignal): AbortSignal {
  const lease = AbortSignal.timeout(MUTATION_OPERATION_LEASE_MS);
  return signal ? AbortSignal.any([signal, lease]) : lease;
}

function ownerOperationBlocks(runtime: GlobalRuntime, ownerKey: string): boolean {
  const ownerOp = runtime.repos.operations.getByKey(ownerKey);
  if (!ownerOp) return false;
  if (ownerOp.state === "in_progress" && isOperationLeaseExpired(ownerOp)) {
    // Expired in_progress still blocks other keys until same-key takeover
    // converts it to reconciling (or normalization restores a resumable owner).
    return true;
  }
  return BLOCKING_OWNER_STATES.has(ownerOp.state);
}

/**
 * Atomically converts a lease-expired `in_progress` op to `reconciling` while
 * retaining the same owner key on the memory row. Does not steal ownership
 * for a different logical operation.
 */
export function takeOverExpiredInProgress(runtime: GlobalRuntime, op: OperationRow): OperationRow {
  if (op.state !== "in_progress" || !isOperationLeaseExpired(op)) return op;
  if (!runtime.repos.operations.tryTransition(op.idempotency_key, "in_progress", "reconciling")) {
    return runtime.repos.operations.getByKey(op.idempotency_key) ?? op;
  }
  // Invalidate any in-flight progress token so a stale delayed completion cannot CAS-finalize.
  runtime.repos.memories.clearMutationProgressToken(op.memory_id, op.idempotency_key);
  return runtime.repos.operations.getByKey(op.idempotency_key) ?? op;
}

function restoreActiveClearOwner(runtime: GlobalRuntime, row: MemoryRow, ownerKey: string | null): MemoryRow {
  if (ownerKey) {
    runtime.repos.memories.releaseMutationOwnerToActive(row.id, ownerKey);
  } else {
    runtime.repos.memories.restoreOwnerlessReconcilingToActive(row.id);
  }
  return runtime.repos.memories.getById(row.id) ?? row;
}

function rebindOwner(runtime: GlobalRuntime, row: MemoryRow, ownerKey: string): MemoryRow {
  runtime.repos.memories.trySetMutationOwner(row.id, ownerKey, row.mutation_generation);
  return runtime.repos.memories.getById(row.id) ?? row;
}

/**
 * Forces MemoryDatabase.transaction to ROLLBACK. Used when a multi-step
 * mutation CAS sequence cannot complete atomically.
 */
export class MutationTxRollbackError extends Error {
  constructor(message = "mutation transaction rolled back") {
    super(message);
    this.name = "MutationTxRollbackError";
  }
}

/**
 * Applies an operation-state transition and a matching memory-side effect only
 * when the progress-token CAS succeeds. Both sides commit atomically: if the
 * memory CAS fails after the operation CAS succeeded, the transaction rolls
 * back so a stale delayed completion changes neither side.
 */
export function applyProgressScopedOutcome(
  runtime: GlobalRuntime,
  params: {
    memoryId: string;
    ownerKey: string;
    progressToken: string;
    expectedGeneration: number;
    opState: "reconciling" | "failed";
    memory: "keep_reconciling" | "release_active" | "clear_owner" | "none";
  },
): boolean {
  try {
    return runtime.db.transaction(() => {
      if (
        !runtime.repos.operations.tryUpdateFromProgress(
          params.ownerKey,
          params.progressToken,
          params.opState,
        )
      ) {
        return false;
      }
      if (params.memory === "none") return true;
      let memoryOk = false;
      if (params.memory === "keep_reconciling") {
        memoryOk = runtime.repos.memories.keepReconcilingUnderProgress({
          id: params.memoryId,
          ownerKey: params.ownerKey,
          expectedGeneration: params.expectedGeneration,
          progressToken: params.progressToken,
        });
      } else if (params.memory === "release_active") {
        memoryOk = runtime.repos.memories.releaseToActiveUnderProgress({
          id: params.memoryId,
          ownerKey: params.ownerKey,
          expectedGeneration: params.expectedGeneration,
          progressToken: params.progressToken,
        });
      } else {
        memoryOk = runtime.repos.memories.clearMutationOwnerUnderProgress({
          id: params.memoryId,
          ownerKey: params.ownerKey,
          expectedGeneration: params.expectedGeneration,
          progressToken: params.progressToken,
        });
      }
      if (!memoryOk) {
        throw new MutationTxRollbackError();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof MutationTxRollbackError) return false;
    throw err;
  }
}

/**
 * Runs a finalization transaction that must be all-or-nothing. Throws
 * MutationTxRollbackError inside `fn` to abort; returns false to the caller.
 */
export function runAtomicFinalization(runtime: GlobalRuntime, fn: () => boolean): boolean {
  try {
    return runtime.db.transaction(fn);
  } catch (err) {
    if (err instanceof MutationTxRollbackError) return false;
    throw err;
  }
}

export function operationMatchesCurrentRow(
  op: OperationRow,
  row: MemoryRow,
  allOps: OperationRow[],
): boolean {
  if (op.memory_id !== row.id) return false;
  if (op.bank_id !== row.bank_id || op.document_id !== row.document_id) return false;
  if (op.memory_generation === null) {
    // Legacy NULL generation: safe only when this is the sole operation for the
    // row and the locator still matches — otherwise fail closed.
    return allOps.length === 1;
  }
  return op.memory_generation === row.mutation_generation;
}

/**
 * Selects at most one uniquely eligible recoverable operation for the row's
 * current generation and locator. Ambiguous histories fail closed (undefined).
 */
export function pickRecoverableOperation(
  runtime: GlobalRuntime,
  row: MemoryRow,
): OperationRow | undefined {
  const allOps = runtime.repos.operations.listByMemoryId(row.id);
  const candidates = allOps.filter(
    (op) =>
      (op.state === "pending" ||
        op.state === "in_progress" ||
        op.state === "reconciling" ||
        op.state === "failed") &&
      operationMatchesCurrentRow(op, row, allOps),
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const live = candidates.filter((op) => op.state !== "failed");
  if (live.length === 1) return live[0];
  // Multiple live ops or multiple failed ops for the same generation/locator:
  // do not choose arbitrarily.
  return undefined;
}

/**
 * Normalizes durable ownership after crashes:
 * - expired in_progress → reconciling under the same owner (verify-first resume);
 * - terminal definite pre-mutation failure with valid prior truth → active;
 * - maybe-mutated / missing-but-reconciling → resumable owner + reconciling;
 * never blindly marks active when the provider may have mutated.
 *
 * Must run inside a DB transaction.
 */
export function normalizeMutationOwnership(runtime: GlobalRuntime, row: MemoryRow): MemoryRow {
  if (row.mutation_owner_key) {
    const ownerOp = runtime.repos.operations.getByKey(row.mutation_owner_key);
    if (!ownerOp) {
      // Dangling owner: clear only when the row is already a coherent active truth.
      // Reconciling + missing op is inconsistent — fail closed.
      if (row.status === "active") {
        runtime.repos.memories.clearMutationOwner(row.id, row.mutation_owner_key);
        return runtime.repos.memories.getById(row.id) ?? row;
      }
      return row;
    }

    const allOps = runtime.repos.operations.listByMemoryId(row.id);
    if (!operationMatchesCurrentRow(ownerOp, row, allOps)) {
      // Stale generation / locator / memory_id — do not clear, restore, or rebind.
      return row;
    }

    if (ownerOp.state === "in_progress" && isOperationLeaseExpired(ownerOp)) {
      takeOverExpiredInProgress(runtime, ownerOp);
      return runtime.repos.memories.getById(row.id) ?? row;
    }

    if (ownerOp.state === "committed") {
      // Committed owner + reconciling row is inconsistent: fail closed rather than
      // clearing and selecting unrelated history.
      if (
        row.status === "active" ||
        row.status === "deleted" ||
        row.status === "superseded" ||
        row.status === "expired"
      ) {
        runtime.repos.memories.clearMutationOwner(row.id, row.mutation_owner_key);
        return runtime.repos.memories.getById(row.id) ?? row;
      }
      return row;
    }

    if (ownerOp.state === "failed") {
      if (!providerMutationIssued(ownerOp)) {
        if (ownerOp.action === "create") {
          // Create never became active truth — keep owner for same-key resume.
          return row;
        }
        // Definite pre-mutation failure: prior active truth is still valid.
        return restoreActiveClearOwner(runtime, row, row.mutation_owner_key);
      }
      // Maybe-mutated failure: reopen as reconciling under same owner. Do not
      // use unguarded setStatus — the row is already reconciling while owned.
      runtime.repos.operations.tryTransition(ownerOp.idempotency_key, "failed", "reconciling");
      return runtime.repos.memories.getById(row.id) ?? row;
    }

    // pending / reconciling / live in_progress: leave as-is.
    return row;
  }

  if (row.status === "reconciling") {
    return normalizeOwnerlessReconciling(runtime, row);
  }
  return row;
}

function normalizeOwnerlessReconciling(runtime: GlobalRuntime, row: MemoryRow): MemoryRow {
  const recoverable = pickRecoverableOperation(runtime, row);
  if (!recoverable) {
    // No uniquely eligible durable op — fail closed (remain ownerless reconciling).
    return row;
  }

  if (recoverable.state === "failed" && !providerMutationIssued(recoverable)) {
    if (recoverable.action === "create") {
      return rebindOwner(runtime, row, recoverable.idempotency_key);
    }
    return restoreActiveClearOwner(runtime, row, null);
  }

  if (recoverable.state === "in_progress" && isOperationLeaseExpired(recoverable)) {
    takeOverExpiredInProgress(runtime, recoverable);
  } else if (recoverable.state === "failed" && providerMutationIssued(recoverable)) {
    runtime.repos.operations.tryTransition(recoverable.idempotency_key, "failed", "reconciling");
  }

  return rebindOwner(runtime, row, recoverable.idempotency_key);
}

/** @deprecated Use normalizeMutationOwnership. */
export function clearStaleMutationOwner(runtime: GlobalRuntime, row: MemoryRow): MemoryRow {
  return normalizeMutationOwnership(runtime, row);
}

/**
 * Claims exclusive mutation ownership for replace/delete/create on a memory.
 * Caller must already be inside `runtime.db.transaction`.
 */
export function claimMemoryMutation(
  runtime: GlobalRuntime,
  memoryId: string,
  ownerKey: string,
  options: {
    /** Fresh claims require an active row; resumes may continue a reconciling owner. */
    requireActiveForNewClaim: boolean;
  },
): MutationClaimResult {
  let row = runtime.repos.memories.getById(memoryId);
  if (!row) return { ok: false, code: "not_found", reason: "target memory was not found" };
  row = normalizeMutationOwnership(runtime, row);

  if (row.mutation_owner_key && row.mutation_owner_key !== ownerKey) {
    const foreign = runtime.repos.operations.getByKey(row.mutation_owner_key);
    if (foreign?.state === "in_progress" && isOperationLeaseExpired(foreign)) {
      // Convert to reconciling under the original owner; still blocks this claimant.
      takeOverExpiredInProgress(runtime, foreign);
      row = runtime.repos.memories.getById(memoryId) ?? row;
    }
    if (ownerOperationBlocks(runtime, row.mutation_owner_key!)) {
      return {
        ok: false,
        code: "busy",
        reason: "another mutation currently owns this memory generation",
        ownerKey: row.mutation_owner_key,
      };
    }
    row = normalizeMutationOwnership(runtime, row);
  }

  const resuming = row.mutation_owner_key === ownerKey;
  if (resuming) {
    if (row.status === "deleted" || row.status === "superseded" || row.status === "expired") {
      return {
        ok: false,
        code: "not_claimable",
        reason: `target memory is not active (status: ${row.status})`,
        status: row.status,
      };
    }
    // Same-key takeover of expired in_progress happens in beginOwnedOperation.
    return { ok: true, row, generation: row.mutation_generation };
  }

  if (row.status === "deleted" || row.status === "superseded" || row.status === "expired") {
    return {
      ok: false,
      code: "not_claimable",
      reason: `target memory is not active (status: ${row.status})`,
      status: row.status,
    };
  }

  if (options.requireActiveForNewClaim && row.status !== "active") {
    return {
      ok: false,
      code: "not_claimable",
      reason: `target memory is not active (status: ${row.status})`,
      status: row.status,
    };
  }

  if (!runtime.repos.memories.trySetMutationOwner(row.id, ownerKey, row.mutation_generation)) {
    const latest = runtime.repos.memories.getById(memoryId);
    return {
      ok: false,
      code: "busy",
      reason: "another mutation currently owns this memory generation",
      ownerKey: latest?.mutation_owner_key ?? null,
    };
  }
  const owned = runtime.repos.memories.getById(memoryId)!;
  return { ok: true, row: owned, generation: owned.mutation_generation };
}

/**
 * Transitions a claimed operation into `in_progress` with a progress token for CAS.
 * Lease-expired `in_progress` is taken over into `reconciling` first (verify-before-mutate).
 * Must not be called while holding a long transaction across network I/O; short DB tx only.
 */
export function beginOwnedOperation(
  runtime: GlobalRuntime,
  idempotencyKey: string,
): BeginOperationResult {
  return runtime.db.transaction(() => {
    let op = runtime.repos.operations.getByKey(idempotencyKey);
    if (!op) return { ok: false as const, code: "conflict" as const, reason: "operation not found" };

    if (op.state === "committed") {
      return { ok: false as const, code: "committed" as const, op };
    }

    if (op.state === "in_progress") {
      if (!isOperationLeaseExpired(op)) {
        return { ok: false as const, code: "in_progress" as const, op };
      }
      op = takeOverExpiredInProgress(runtime, op);
    }

    const wasReconciling =
      op.state === "reconciling" || (op.state === "failed" && providerMutationIssued(op));
    if (op.state === "failed" && providerMutationIssued(op)) {
      if (!runtime.repos.operations.tryTransition(idempotencyKey, "failed", "reconciling")) {
        op = runtime.repos.operations.getByKey(idempotencyKey)!;
        if (op.state === "in_progress") {
          return { ok: false as const, code: "in_progress" as const, op };
        }
        if (op.state === "committed") {
          return { ok: false as const, code: "committed" as const, op };
        }
      } else {
        op = runtime.repos.operations.getByKey(idempotencyKey)!;
      }
    }

    const fromState = op.state;
    if (fromState === "in_progress") {
      return { ok: false as const, code: "in_progress" as const, op };
    }
    if (!runtime.repos.operations.tryTransition(idempotencyKey, fromState, "in_progress")) {
      const current = runtime.repos.operations.getByKey(idempotencyKey);
      if (current?.state === "committed") {
        return { ok: false as const, code: "committed" as const, op: current };
      }
      if (current?.state === "in_progress") {
        return { ok: false as const, code: "in_progress" as const, op: current };
      }
      return {
        ok: false as const,
        code: "conflict" as const,
        reason: "operation ownership changed concurrently",
        ...(current ? { op: current } : {}),
      };
    }

    // Refresh lease clock / attempt counter; progress token is post-increment updated_at.
    runtime.repos.operations.incrementAttempt(idempotencyKey);
    const started = runtime.repos.operations.getByKey(idempotencyKey)!;
    if (
      !runtime.repos.memories.setMutationProgressToken(
        started.memory_id,
        idempotencyKey,
        started.updated_at,
      )
    ) {
      // Lost ownership mid-start — roll operation back to reconciling under CAS.
      runtime.repos.operations.tryUpdateFromProgress(idempotencyKey, started.updated_at, "reconciling");
      return {
        ok: false as const,
        code: "conflict" as const,
        reason: "mutation ownership changed while starting operation",
        op: started,
      };
    }
    return {
      ok: true as const,
      op: started,
      progressToken: started.updated_at,
      wasReconciling: wasReconciling || fromState === "reconciling",
    };
  });
}

export function forgetIdempotencyKey(
  memoryId: string,
  generation: number,
  textHash: string,
  documentId: string,
): string {
  return `forget:${memoryId}:g${generation}:${textHash}:${documentId}`;
}

export function expireIdempotencyKey(
  memoryId: string,
  generation: number,
  textHash: string,
  documentId: string,
): string {
  return `expire:${memoryId}:g${generation}:${textHash}:${documentId}`;
}

export function isExpireOwnerKey(row: MemoryRow): boolean {
  const key = expireIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
  return row.mutation_owner_key === key;
}

export type PrepareExpiryHandoffResult =
  | { ok: true; memoryId: string; alreadyExpireOwned: boolean }
  | {
      ok: false;
      reason: "not_found" | "not_due" | "not_foreign" | "live_owner" | "incoherent";
    };

const TEXT_HASH_HEX = /^[0-9a-f]{64}$/;

/** Test-only: force expire-op creation to fail after row handoff CAS. */
let blockHandoffExpireOpCreateForTests = false;
/** Test-only: force final expire-op coherence check to fail. */
let blockHandoffFinalCoherenceForTests = false;
/** Test-only: force foreign-op retirement to fail after coherence passes. */
let blockHandoffForeignRetireForTests = false;

export function setBlockHandoffExpireOpCreateForTests(value: boolean): void {
  blockHandoffExpireOpCreateForTests = value;
}

export function setBlockHandoffFinalCoherenceForTests(value: boolean): void {
  blockHandoffFinalCoherenceForTests = value;
}

export function setBlockHandoffForeignRetireForTests(value: boolean): void {
  blockHandoffForeignRetireForTests = value;
}

function retireForeignOperationForExpiryHandoff(
  runtime: GlobalRuntime,
  foreignKey: string,
): void {
  if (blockHandoffForeignRetireForTests) {
    throw new ExpiryHandoffRollbackError("incoherent");
  }
  const foreignOp = runtime.repos.operations.getByKey(foreignKey);
  if (!foreignOp) {
    throw new ExpiryHandoffRollbackError("incoherent");
  }
  if (foreignOp.state === "failed") return;
  if (foreignOp.state === "pending" || foreignOp.state === "reconciling") {
    if (!runtime.repos.operations.tryTransition(foreignKey, foreignOp.state, "failed")) {
      throw new ExpiryHandoffRollbackError("incoherent");
    }
    return;
  }
  throw new ExpiryHandoffRollbackError("incoherent");
}

/**
 * Forces MemoryDatabase.transaction to ROLLBACK during expiry handoff after any
 * mutation has begun.
 */
export class ExpiryHandoffRollbackError extends Error {
  constructor(public readonly reason: Extract<PrepareExpiryHandoffResult, { ok: false }>["reason"]) {
    super("expiry handoff rolled back");
    this.name = "ExpiryHandoffRollbackError";
  }
}

/** Read-only foreign-op locator/action/hash rules for expiry handoff eligibility. */
export function isForeignOpCoherentForHandoff(row: MemoryRow, op: OperationRow): boolean {
  if (op.memory_id !== row.id) return false;
  if (op.bank_id !== row.bank_id || op.document_id !== row.document_id) return false;
  if (op.memory_generation !== null && op.memory_generation !== row.mutation_generation) return false;
  if (op.state === "committed") return false;
  const hash = op.expected_text_hash;
  switch (op.action) {
    case "delete":
      return hash === row.text_hash;
    case "replace":
    case "create":
      return hash !== null && TEXT_HASH_HEX.test(hash);
    default:
      return false;
  }
}

/** Read-only: foreign-owned due row eligible for handoff (no SQLite mutations). */
export function isForeignHandoffEligibleReadOnly(
  runtime: GlobalRuntime,
  row: MemoryRow,
  nowIso: string,
): boolean {
  if (!isValidOwnedMemoryLocator(runtime, row)) return false;
  if (!row.expires_at || row.expires_at > nowIso) return false;
  if (!row.mutation_owner_key || isExpireOwnerKey(row)) return false;
  const foreignOp = runtime.repos.operations.getByKey(row.mutation_owner_key);
  if (!foreignOp) return false;
  const allOps = runtime.repos.operations.listByMemoryId(row.id);
  if (!operationMatchesCurrentRow(foreignOp, row, allOps)) return false;
  if (!isForeignOpCoherentForHandoff(row, foreignOp)) return false;
  if (foreignOp.state === "in_progress" && !isOperationLeaseExpired(foreignOp)) return false;
  if (pickRecoverableOperation(runtime, row)?.idempotency_key !== foreignOp.idempotency_key) return false;
  return true;
}

/**
 * When a time-bounded memory is due but still owned by an older mutation
 * (replace/forget/create), atomically bind the deterministic expire delete
 * operation at the next generation. Never steals a live in_progress lease;
 * stale delayed completions fail CAS on the old generation.
 */
export function prepareExpiryHandoff(
  runtime: GlobalRuntime,
  memoryId: string,
): PrepareExpiryHandoffResult {
  try {
    return runtime.db.transaction(() => {
      const nowIso = mutationNowIso();
      const row = runtime.repos.memories.getById(memoryId);
      if (!row) return { ok: false, reason: "not_found" };
      if (!row.expires_at || row.expires_at > nowIso) {
        return { ok: false, reason: "not_due" };
      }
      if (!row.mutation_owner_key) {
        return { ok: false, reason: "not_foreign" };
      }
      if (!isValidOwnedMemoryLocator(runtime, row)) {
        return { ok: false, reason: "incoherent" };
      }
      if (isExpireOwnerKey(row)) {
        return { ok: true, memoryId, alreadyExpireOwned: true };
      }

      const foreignKey = row.mutation_owner_key;
      let foreignOp = runtime.repos.operations.getByKey(foreignKey);
      if (!foreignOp) return { ok: false, reason: "incoherent" };
      const allOps = runtime.repos.operations.listByMemoryId(memoryId);
      if (!operationMatchesCurrentRow(foreignOp, row, allOps)) {
        return { ok: false, reason: "incoherent" };
      }
      if (!isForeignOpCoherentForHandoff(row, foreignOp)) {
        return { ok: false, reason: "incoherent" };
      }
      if (pickRecoverableOperation(runtime, row)?.idempotency_key !== foreignOp.idempotency_key) {
        return { ok: false, reason: "incoherent" };
      }

      if (foreignOp.state === "in_progress") {
        if (!isOperationLeaseExpired(foreignOp)) {
          return { ok: false, reason: "live_owner" };
        }
        foreignOp = takeOverExpiredInProgress(runtime, foreignOp);
        if (foreignOp.state === "in_progress") {
          throw new ExpiryHandoffRollbackError("live_owner");
        }
      }

      const newGeneration = row.mutation_generation + 1;
      const expireKey = expireIdempotencyKey(row.id, newGeneration, row.text_hash, row.document_id);

      if (
        !runtime.repos.memories.tryHandoffToExpireOwner({
          id: memoryId,
          foreignOwnerKey: foreignKey,
          expectedGeneration: row.mutation_generation,
          newGeneration,
          expireOwnerKey: expireKey,
          nowIso,
        })
      ) {
        throw new ExpiryHandoffRollbackError("incoherent");
      }

      if (blockHandoffExpireOpCreateForTests) {
        throw new ExpiryHandoffRollbackError("incoherent");
      }

      if (!runtime.repos.operations.getByKey(expireKey)) {
        const created = runtime.repos.operations.tryCreate({
          idempotencyKey: expireKey,
          memoryId,
          action: "delete",
          bankId: row.bank_id,
          documentId: row.document_id,
          expectedTextHash: row.text_hash,
          memoryGeneration: newGeneration,
        });
        if (!created && !runtime.repos.operations.getByKey(expireKey)) {
          throw new ExpiryHandoffRollbackError("incoherent");
        }
      }

      const updated = runtime.repos.memories.getById(memoryId)!;
      const expireOp = runtime.repos.operations.getByKey(expireKey)!;
      const updatedOps = runtime.repos.operations.listByMemoryId(memoryId);
      if (blockHandoffFinalCoherenceForTests) {
        throw new ExpiryHandoffRollbackError("incoherent");
      }
      if (!isCoherentExpireOperation(updated, expireOp, updatedOps)) {
        throw new ExpiryHandoffRollbackError("incoherent");
      }

      retireForeignOperationForExpiryHandoff(runtime, foreignKey);

      return { ok: true, memoryId, alreadyExpireOwned: false };
    });
  } catch (err) {
    if (err instanceof ExpiryHandoffRollbackError) {
      return { ok: false, reason: err.reason };
    }
    throw err;
  }
}

/** Exact expire-operation coherence: never infer from action='delete' or key prefix alone. */
export function isCoherentExpireOperation(
  row: MemoryRow,
  op: OperationRow,
  allOps: OperationRow[],
): boolean {
  if (op.action !== "delete") return false;
  const key = expireIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
  if (op.idempotency_key !== key || row.mutation_owner_key !== key) return false;
  if (op.memory_id !== row.id) return false;
  if (op.bank_id !== row.bank_id || op.document_id !== row.document_id) return false;
  if (op.expected_text_hash !== row.text_hash) return false;
  return operationMatchesCurrentRow(op, row, allOps);
}

export function isActiveDuplicateRow(row: MemoryRow | undefined, textHash: string): row is MemoryRow {
  return !!row && row.status === "active" && row.text_hash === textHash;
}

export function operationIsResumableCreate(
  op: OperationRow,
  row: MemoryRow | undefined,
  textHash: string,
): boolean {
  if (op.action !== "create" || op.expected_text_hash !== textHash) return false;
  if (!row) return false;
  if (op.state === "committed") return row.status === "active" && row.text_hash === textHash;
  if (row.status === "deleted" || row.status === "superseded" || row.status === "expired") return false;
  return row.status === "active" || row.status === "reconciling";
}

/** Practical bound on create→forget→create revive key walks (not a semantic fuzzy search). */
export const MAX_CREATE_REVIVE_WALK = 64;

/**
 * First-generation revive after the base content key. Persisted keys must keep this
 * exact shape for compatibility with already-written operations.
 */
export function reviveCreateIdempotencyKey(baseKey: string, deletedRow: MemoryRow): string {
  return `${baseKey}:after:${deletedRow.id}:g${deletedRow.mutation_generation}`;
}

/**
 * Later-generation revive keys stay compact/hashed under the 256-char idempotency
 * limit while remaining deterministic for the (priorKey, memoryId, generation) triple.
 */
export function mintCompactReviveCreateKey(
  baseKey: string,
  priorKey: string,
  memoryId: string,
  generation: number,
): string {
  const digest = createHash("sha256")
    .update(`${priorKey}\n${memoryId}\n${generation}`)
    .digest("hex")
    .slice(0, 40);
  return `${baseKey}:r${digest}`;
}

export type ResolveCreateKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: string; code: string };

/**
 * Walk historical stale create operations from the content base key until a
 * resumable/active slot is found or a collision-free next key is minted.
 * Never fuzzy-selects rows; each step follows only the exact prior operation's
 * memory locator and terminal state.
 */
export function resolveCreateIdempotencyKey(
  getOp: (key: string) => OperationRow | undefined,
  getMemory: (id: string) => MemoryRow | undefined,
  baseKey: string,
  textHash: string,
): ResolveCreateKeyResult {
  let key = baseKey;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_CREATE_REVIVE_WALK; i++) {
    if (seen.has(key)) {
      return { ok: false, reason: "create revive key cycle detected", code: "revive_cycle" };
    }
    seen.add(key);
    if (!validateIdempotencyKey(key).ok) {
      return { ok: false, reason: "computed idempotency key is invalid", code: "invalid_idempotency_key" };
    }
    const op = getOp(key);
    if (!op) {
      return { ok: true, key };
    }
    const row = getMemory(op.memory_id);
    if (operationIsResumableCreate(op, row, textHash)) {
      return { ok: true, key };
    }
    if (op.action !== "create" || op.expected_text_hash !== textHash || op.state !== "committed") {
      return {
        ok: false,
        reason: "existing create operation is not resumable for this content",
        code: "stale_create_operation",
      };
    }

    let next: string;
    if (row && (row.status === "deleted" || row.status === "superseded" || row.status === "expired")) {
      next =
        key === baseKey
          ? reviveCreateIdempotencyKey(baseKey, row)
          : mintCompactReviveCreateKey(baseKey, key, row.id, row.mutation_generation);
    } else {
      const generation = op.memory_generation ?? 0;
      next =
        key === baseKey
          ? `${baseKey}:after:orphan:${op.memory_id}`
          : mintCompactReviveCreateKey(baseKey, key, op.memory_id, generation);
    }
    if (next === key) {
      return { ok: false, reason: "create revive key did not advance", code: "revive_stuck" };
    }
    key = next;
  }
  return { ok: false, reason: "create revive walk exceeded bound", code: "revive_exhausted" };
}

/**
 * After `provider_mutation_issued`, only an explicit `ambiguous: false` proves the
 * mutating call did not execute. Missing/undefined ambiguous (custom mocks or
 * incomplete adapters) must be treated as maybe-executed — never release prior active truth.
 */
export function postIssuanceFailureMustKeepReconciling(failure: { ambiguous?: boolean }): boolean {
  return failure.ambiguous !== false;
}

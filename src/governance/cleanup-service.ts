import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { MemoryRow } from "../db/types.js";
import {
  AUDIT_MAX_ROWS,
  AUDIT_USAGE_RETENTION_DAYS,
  CANDIDATE_TERMINAL_RETENTION_DAYS,
  CLEANUP_BATCH_LIMIT,
  CONFLICT_RESOLVED_RETENTION_DAYS,
  DAY_MS,
  EXPIRY_BATCH_LIMIT,
  EXPIRY_RECONCILING_SCAN_LIMIT,
  MAINTENANCE_INTERVAL_MS,
  MEMORY_TOMBSTONE_RETENTION_DAYS,
  OPERATION_TERMINAL_RETENTION_DAYS,
  USAGE_MAX_ROWS,
} from "../db/lifecycle.js";
import { mutationNowIso, mutationNowMs } from "./mutation-clock.js";
import { expireMemory } from "./expire-service.js";
import { isValidOwnedMemoryLocator } from "./memory-locator.js";
import {
  expireIdempotencyKey,
  isCoherentExpireOperation,
  isExpireOwnerKey,
  isForeignHandoffEligibleReadOnly,
  pickRecoverableOperation,
  prepareExpiryHandoff,
} from "./mutation-ownership.js";

export interface CleanupCounts {
  candidateBodiesPurged: number;
  candidatesDeleted: number;
  operationsDeleted: number;
  conflictsDeleted: number;
  auditDeleted: number;
  usageDeleted: number;
  tombstonesDeleted: number;
  expiredAttempted: number;
  expiredSucceeded: number;
  expiredUncertain: number;
  expiredRejected: number;
}

export type MaintenanceIncompleteReason = "lease_lost" | "cancelled";

export interface ExpiryBatchResult {
  expiredAttempted: number;
  expiredSucceeded: number;
  expiredUncertain: number;
  expiredRejected: number;
  incomplete?: MaintenanceIncompleteReason;
}

export interface MaintenancePassResult {
  ran: boolean;
  reason?: string;
  counts?: CleanupCounts;
  incomplete?: MaintenanceIncompleteReason;
}

export interface CleanupStatusView {
  lastSuccessAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  dueForAutomatic: boolean;
  dueExpiryCount: number;
  lastStatus: CleanupCounts | null;
}

function emptyCounts(): CleanupCounts {
  return {
    candidateBodiesPurged: 0,
    candidatesDeleted: 0,
    operationsDeleted: 0,
    conflictsDeleted: 0,
    auditDeleted: 0,
    usageDeleted: 0,
    tombstonesDeleted: 0,
    expiredAttempted: 0,
    expiredSucceeded: 0,
    expiredUncertain: 0,
    expiredRejected: 0,
  };
}

function cutoffDays(days: number): string {
  return new Date(mutationNowMs() - days * DAY_MS).toISOString();
}

/** Local SQLite retention compaction only — no provider I/O. */
export function runLocalRetentionCleanup(runtime: GlobalRuntime): CleanupCounts {
  const counts = emptyCounts();
  // Separate transactions so one still-referenced row cannot roll back unrelated deletes.
  counts.candidateBodiesPurged = runtime.db.transaction(() =>
    runtime.repos.candidates.purgeLingeringTerminalBodies(CLEANUP_BATCH_LIMIT),
  );
  counts.conflictsDeleted = runtime.db.transaction(() =>
    runtime.repos.conflicts.deleteResolvedOlderThan(
      cutoffDays(CONFLICT_RESOLVED_RETENTION_DAYS),
      CLEANUP_BATCH_LIMIT,
    ),
  );
  counts.operationsDeleted = runtime.db.transaction(() =>
    runtime.repos.operations.deleteTerminalOlderThan(
      cutoffDays(OPERATION_TERMINAL_RETENTION_DAYS),
      CLEANUP_BATCH_LIMIT,
    ),
  );
  counts.candidatesDeleted = runtime.db.transaction(() =>
    runtime.repos.candidates.deleteTerminalOlderThan(
      cutoffDays(CANDIDATE_TERMINAL_RETENTION_DAYS),
      CLEANUP_BATCH_LIMIT,
    ),
  );
  counts.auditDeleted = runtime.db.transaction(() =>
    runtime.repos.audit.deleteOlderThan(cutoffDays(AUDIT_USAGE_RETENTION_DAYS), CLEANUP_BATCH_LIMIT),
  );
  counts.auditDeleted += runtime.db.transaction(() =>
    runtime.repos.audit.deleteOverflowBeyond(AUDIT_MAX_ROWS, CLEANUP_BATCH_LIMIT),
  );
  counts.usageDeleted = runtime.db.transaction(() =>
    runtime.repos.usage.deleteOlderThan(cutoffDays(AUDIT_USAGE_RETENTION_DAYS), CLEANUP_BATCH_LIMIT),
  );
  counts.usageDeleted += runtime.db.transaction(() =>
    runtime.repos.usage.deleteOverflowBeyond(USAGE_MAX_ROWS, CLEANUP_BATCH_LIMIT),
  );
  counts.tombstonesDeleted = runtime.db.transaction(() =>
    runtime.repos.memories.deleteEligibleTombstones(
      cutoffDays(MEMORY_TOMBSTONE_RETENTION_DAYS),
      CLEANUP_BATCH_LIMIT,
    ),
  );
  return counts;
}

/**
 * Read-only expiry maintenance discovery. Never mutates rows or operations.
 * Priority: expire-owned reconciling recovery, coherent foreign handoff, ownerless due.
 */
export function listExpiryMaintenanceTargets(
  runtime: GlobalRuntime,
  nowIso: string,
  limit: number,
): MemoryRow[] {
  const overfetch = Math.max(EXPIRY_RECONCILING_SCAN_LIMIT, limit * 8);
  const seen = new Set<string>();
  const result: MemoryRow[] = [];

  const reconcilingCandidates = runtime.repos.memories.listCoherentReconcilingExpiryCandidates(
    nowIso,
    overfetch,
  );
  for (const row of reconcilingCandidates) {
    if (seen.has(row.id)) continue;
    if (!isValidOwnedMemoryLocator(runtime, row)) continue;
    const key = expireIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
    const op = runtime.repos.operations.getByKey(key);
    if (!op) continue;
    const allOps = runtime.repos.operations.listByMemoryId(row.id);
    if (!isCoherentExpireOperation(row, op, allOps)) continue;
    const recoverable = pickRecoverableOperation(runtime, row);
    if (!recoverable || recoverable.idempotency_key !== key) continue;
    seen.add(row.id);
    result.push(row);
    if (result.length >= limit) return result;
  }

  const foreignDue = runtime.repos.memories.listCoherentForeignOwnedDueForExpiry(nowIso, overfetch);
  for (const row of foreignDue) {
    if (seen.has(row.id)) continue;
    if (!isValidOwnedMemoryLocator(runtime, row)) continue;
    if (!isForeignHandoffEligibleReadOnly(runtime, row, nowIso)) continue;
    seen.add(row.id);
    result.push(row);
    if (result.length >= limit) return result;
  }

  const active = runtime.repos.memories.listDueForExpiry(nowIso, overfetch);
  for (const row of active) {
    if (seen.has(row.id)) continue;
    if (!isValidOwnedMemoryLocator(runtime, row)) continue;
    seen.add(row.id);
    result.push(row);
    if (result.length >= limit) return result;
  }
  return result;
}

/** Read-only approximate due count for status surfaces. */
export function countExpiryMaintenanceDue(runtime: GlobalRuntime, maxCount: number): number {
  return listExpiryMaintenanceTargets(runtime, mutationNowIso(), maxCount).length;
}

function recordIncompleteMaintenance(
  runtime: GlobalRuntime,
  ownerKey: string,
  counts: CleanupCounts,
  incomplete: MaintenanceIncompleteReason,
  force: boolean,
): void {
  runtime.db.transaction(() => {
    const released = runtime.repos.maintenance.releaseLease(ownerKey, JSON.stringify(counts));
    runtime.repos.audit.record({
      eventType: "cleanup",
      outcome: incomplete === "cancelled" ? "incomplete_cancelled" : "incomplete_lease_lost",
      redactedCode: released ? (force ? "manual" : "automatic") : "stale_owner",
    });
  });
}

export async function runExpiryBatch(
  runtime: GlobalRuntime,
  options?: { signal?: AbortSignal; leaseOwnerKey?: string },
): Promise<ExpiryBatchResult> {
  const nowIso = mutationNowIso();
  const due = listExpiryMaintenanceTargets(runtime, nowIso, EXPIRY_BATCH_LIMIT);
  const result: ExpiryBatchResult = {
    expiredAttempted: 0,
    expiredSucceeded: 0,
    expiredUncertain: 0,
    expiredRejected: 0,
  };
  for (const row of due) {
    if (options?.signal?.aborted) {
      result.incomplete = "cancelled";
      return result;
    }
    if (options?.leaseOwnerKey) {
      const stillOwned = runtime.db.transaction(() =>
        runtime.repos.maintenance.renewLease(options.leaseOwnerKey!),
      );
      if (!stillOwned) {
        result.incomplete = "lease_lost";
        return result;
      }
    }
    const current = runtime.repos.memories.getById(row.id);
    if (
      current?.mutation_owner_key &&
      !isExpireOwnerKey(current) &&
      isForeignHandoffEligibleReadOnly(runtime, current, nowIso)
    ) {
      const handoff = prepareExpiryHandoff(runtime, row.id);
      if (!handoff.ok) {
        result.expiredAttempted += 1;
        result.expiredRejected += 1;
        continue;
      }
    }
    result.expiredAttempted += 1;
    const outcome = await expireMemory(runtime, row.id, options?.signal);
    if (outcome.outcome === "expired") result.expiredSucceeded += 1;
    else if (outcome.outcome === "unknown" || outcome.outcome === "in_progress") result.expiredUncertain += 1;
    else result.expiredRejected += 1;
    if (options?.signal?.aborted) {
      result.incomplete = "cancelled";
      return result;
    }
  }
  return result;
}

export function getCleanupStatus(runtime: GlobalRuntime): CleanupStatusView {
  const state = runtime.repos.maintenance.get();
  const nowMs = mutationNowMs();
  let dueForAutomatic = true;
  if (state.last_success_at) {
    const lastMs = Date.parse(state.last_success_at);
    if (Number.isFinite(lastMs) && nowMs - lastMs < MAINTENANCE_INTERVAL_MS) {
      dueForAutomatic = false;
    }
  }
  if (state.lease_owner && state.lease_until) {
    const leaseUntilMs = Date.parse(state.lease_until);
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
      dueForAutomatic = false;
    }
  }
  let lastStatus: CleanupCounts | null = null;
  if (state.last_status_json) {
    try {
      lastStatus = JSON.parse(state.last_status_json) as CleanupCounts;
    } catch {
      lastStatus = null;
    }
  }
  const dueExpiryCount = countExpiryMaintenanceDue(runtime, EXPIRY_BATCH_LIMIT + 1);
  return {
    lastSuccessAt: state.last_success_at,
    leaseOwner: state.lease_owner,
    leaseUntil: state.lease_until,
    dueForAutomatic,
    dueExpiryCount,
    lastStatus,
  };
}

/**
 * Manual or automatic maintenance pass. Uses durable SQLite lease coordination.
 * Never holds a SQLite transaction across provider calls.
 */
export async function runMaintenancePass(
  runtime: GlobalRuntime,
  options: { force: boolean; signal?: AbortSignal },
): Promise<MaintenancePassResult> {
  const claimed = runtime.db.transaction(() =>
    runtime.repos.maintenance.tryClaimLease({
      force: options.force,
      intervalMs: MAINTENANCE_INTERVAL_MS,
    }),
  );
  if (!claimed) {
    return { ran: false, reason: options.force ? "another window holds the cleanup lease" : "cleanup not due" };
  }

  const counts = emptyCounts();
  try {
    runtime.repos.candidates.sweepExpired();
    const local = runLocalRetentionCleanup(runtime);
    Object.assign(counts, local);
    const expiry = await runExpiryBatch(runtime, {
      ...(options.signal ? { signal: options.signal } : {}),
      leaseOwnerKey: claimed.ownerKey,
    });
    counts.expiredAttempted = expiry.expiredAttempted;
    counts.expiredSucceeded = expiry.expiredSucceeded;
    counts.expiredUncertain = expiry.expiredUncertain;
    counts.expiredRejected = expiry.expiredRejected;

    if (expiry.incomplete) {
      recordIncompleteMaintenance(runtime, claimed.ownerKey, counts, expiry.incomplete, options.force);
      return {
        ran: true,
        incomplete: expiry.incomplete,
        reason: expiry.incomplete === "cancelled" ? "maintenance cancelled during expiry batch" : "maintenance lease lost during expiry batch",
        counts,
      };
    }

    if (!runtime.repos.maintenance.holdsLease(claimed.ownerKey)) {
      recordIncompleteMaintenance(runtime, claimed.ownerKey, counts, "lease_lost", options.force);
      return { ran: true, incomplete: "lease_lost", reason: "maintenance lease lost before post-expiry cleanup", counts };
    }

    const localAfter = runLocalRetentionCleanup(runtime);
    counts.candidateBodiesPurged += localAfter.candidateBodiesPurged;
    counts.candidatesDeleted += localAfter.candidatesDeleted;
    counts.operationsDeleted += localAfter.operationsDeleted;
    counts.conflictsDeleted += localAfter.conflictsDeleted;
    counts.auditDeleted += localAfter.auditDeleted;
    counts.usageDeleted += localAfter.usageDeleted;
    counts.tombstonesDeleted += localAfter.tombstonesDeleted;

    const finalized = runtime.db.transaction(() => {
      const ok = runtime.repos.maintenance.completeSuccess(claimed.ownerKey, JSON.stringify(counts));
      if (!ok) return false;
      runtime.repos.audit.record({
        eventType: "cleanup",
        outcome: options.force ? "manual_ok" : "automatic_ok",
        redactedCode: `expired:${counts.expiredSucceeded}`,
      });
      return true;
    });
    if (!finalized) {
      recordIncompleteMaintenance(runtime, claimed.ownerKey, counts, "lease_lost", options.force);
      return { ran: true, incomplete: "lease_lost", reason: "maintenance lease lost before finalization", counts };
    }
    return { ran: true, counts };
  } catch (err) {
    runtime.db.transaction(() => {
      const released = runtime.repos.maintenance.releaseLease(claimed.ownerKey, JSON.stringify(counts));
      runtime.repos.audit.record({
        eventType: "cleanup",
        outcome: "failed",
        redactedCode: released ? "maintenance_error" : "stale_owner",
      });
    });
    return { ran: false, reason: `cleanup failed: ${String(err)}`, counts };
  }
}

/** Post-agent-settled automatic maintenance: at most once per 24h, non-blocking. */
export async function maybeRunAutomaticMaintenance(
  runtime: GlobalRuntime,
  signal?: AbortSignal,
): Promise<void> {
  await runMaintenancePass(runtime, {
    force: false,
    ...(signal ? { signal } : {}),
  });
}

export function renderCleanupStatus(status: CleanupStatusView): string {
  const lines = [
    `last_success_at: ${status.lastSuccessAt ?? "(never)"}`,
    `lease: ${status.leaseOwner ? `${status.leaseOwner} until ${status.leaseUntil}` : "(idle)"}`,
    `automatic_due: ${status.dueForAutomatic ? "yes" : "no"}`,
    `due_expiry_batch: ${status.dueExpiryCount}`,
  ];
  if (status.lastStatus) {
    lines.push(
      `last_counts: expired=${status.lastStatus.expiredSucceeded}/${status.lastStatus.expiredAttempted} candidates_deleted=${status.lastStatus.candidatesDeleted} ops=${status.lastStatus.operationsDeleted} tombstones=${status.lastStatus.tombstonesDeleted}`,
    );
  }
  return lines.join("\n");
}

export function renderCleanupResult(counts: CleanupCounts): string {
  return [
    `expired: ${counts.expiredSucceeded} ok, ${counts.expiredUncertain} uncertain, ${counts.expiredRejected} rejected (of ${counts.expiredAttempted})`,
    `candidate bodies purged: ${counts.candidateBodiesPurged}`,
    `candidates deleted: ${counts.candidatesDeleted}`,
    `operations deleted: ${counts.operationsDeleted}`,
    `conflicts deleted: ${counts.conflictsDeleted}`,
    `audit deleted: ${counts.auditDeleted}`,
    `usage deleted: ${counts.usageDeleted}`,
    `tombstones deleted: ${counts.tombstonesDeleted}`,
  ].join("\n");
}

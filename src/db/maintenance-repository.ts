import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { MaintenanceStateRow } from "./types.js";
import { mutationNowIso, mutationNowMs } from "../governance/mutation-clock.js";
import { MAINTENANCE_BATCH_LEASE_MS, MAINTENANCE_LEASE_RENEWAL_MS } from "./lifecycle.js";

export class MaintenanceRepository {
  constructor(private readonly db: MemoryDatabase) {}

  get(): MaintenanceStateRow {
    const row = this.db.prepare("SELECT * FROM maintenance_state WHERE id = 1").get() as
      | MaintenanceStateRow
      | undefined;
    if (row) return row;
    const now = mutationNowIso();
    this.db
      .prepare(
        `INSERT INTO maintenance_state (id, last_success_at, lease_owner, lease_until, last_status_json, updated_at)
         VALUES (1, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(now);
    return this.db.prepare("SELECT * FROM maintenance_state WHERE id = 1").get() as unknown as MaintenanceStateRow;
  }

  /**
   * Claims a maintenance lease when due (or forced). Returns null when another
   * window holds a live lease or when automatic maintenance is not yet due.
   */
  tryClaimLease(params: {
    force: boolean;
    intervalMs: number;
    ownerKey?: string;
  }): { ownerKey: string; leaseUntil: string } | null {
    const state = this.get();
    const nowMs = mutationNowMs();
    const nowIso = mutationNowIso();
    if (state.lease_owner && state.lease_until) {
      const leaseUntilMs = Date.parse(state.lease_until);
      if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
        return null;
      }
    }
    if (!params.force && state.last_success_at) {
      const lastMs = Date.parse(state.last_success_at);
      if (Number.isFinite(lastMs) && nowMs - lastMs < params.intervalMs) {
        return null;
      }
    }
    const ownerKey = params.ownerKey ?? `maint:${randomUUID()}`;
    const leaseUntil = new Date(nowMs + MAINTENANCE_BATCH_LEASE_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE maintenance_state
         SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE id = 1
           AND (
             lease_until IS NULL
             OR lease_until <= ?
             OR lease_owner IS NULL
           )
           AND (
             ? = 1
             OR last_success_at IS NULL
             OR last_success_at <= ?
           )`,
      )
      .run(
        ownerKey,
        leaseUntil,
        nowIso,
        nowIso,
        params.force ? 1 : 0,
        new Date(nowMs - params.intervalMs).toISOString(),
      );
    if (Number(result.changes) !== 1) return null;
    return { ownerKey, leaseUntil };
  }

  /** Extends the lease when `ownerKey` still holds an unexpired lease; returns false if lost. */
  renewLease(ownerKey: string): boolean {
    const nowMs = mutationNowMs();
    const nowIso = mutationNowIso();
    const leaseUntil = new Date(nowMs + MAINTENANCE_LEASE_RENEWAL_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE maintenance_state
         SET lease_until = ?, updated_at = ?
         WHERE id = 1
           AND lease_owner = ?
           AND lease_until IS NOT NULL
           AND lease_until > ?`,
      )
      .run(leaseUntil, nowIso, ownerKey, nowIso);
    return Number(result.changes) === 1;
  }

  holdsLease(ownerKey: string): boolean {
    const state = this.get();
    if (state.lease_owner !== ownerKey || !state.lease_until) return false;
    const leaseUntilMs = Date.parse(state.lease_until);
    return Number.isFinite(leaseUntilMs) && leaseUntilMs > mutationNowMs();
  }

  completeSuccess(ownerKey: string, statusJson: string): boolean {
    const nowIso = mutationNowIso();
    const result = this.db
      .prepare(
        `UPDATE maintenance_state
         SET last_success_at = ?, lease_owner = NULL, lease_until = NULL,
             last_status_json = ?, updated_at = ?
         WHERE id = 1
           AND lease_owner = ?
           AND lease_until IS NOT NULL
           AND lease_until > ?`,
      )
      .run(nowIso, statusJson, nowIso, ownerKey, nowIso);
    return Number(result.changes) === 1;
  }

  releaseLease(ownerKey: string, statusJson: string | null): boolean {
    const nowIso = mutationNowIso();
    const result = this.db
      .prepare(
        `UPDATE maintenance_state
         SET lease_owner = NULL, lease_until = NULL,
             last_status_json = COALESCE(?, last_status_json), updated_at = ?
         WHERE id = 1 AND lease_owner = ?`,
      )
      .run(statusJson, nowIso, ownerKey);
    return Number(result.changes) === 1;
  }
}

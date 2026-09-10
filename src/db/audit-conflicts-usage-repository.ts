import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { AuditEventRow, ConflictKind, ConflictResolutionState, ConflictRow, UsageEventRow } from "./types.js";
import { validateAuditFields, validateUsageFields } from "./validation.js";

export class ConflictsRepository {
  constructor(private readonly db: MemoryDatabase) {}

  create(params: {
    candidateId: string | null;
    memoryId: string | null;
    kind: ConflictKind;
  }): ConflictRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conflicts (id, candidate_id, memory_id, kind, resolution_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, params.candidateId, params.memoryId, params.kind, now, now);
    return this.db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id) as unknown as ConflictRow;
  }

  resolve(id: string, resolutionState: ConflictResolutionState): void {
    this.db
      .prepare("UPDATE conflicts SET resolution_state = ?, updated_at = ? WHERE id = ?")
      .run(resolutionState, new Date().toISOString(), id);
  }

  listOpenForCandidate(candidateId: string): ConflictRow[] {
    return this.db
      .prepare("SELECT * FROM conflicts WHERE candidate_id = ? AND resolution_state = 'open'")
      .all(candidateId) as unknown as ConflictRow[];
  }

  hasOpenForMemory(memoryId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM conflicts WHERE memory_id = ? AND resolution_state = 'open' LIMIT 1")
      .get(memoryId) as { present: number } | undefined;
    return row?.present === 1;
  }

  deleteResolvedOlderThan(cutoffIso: string, limit: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM conflicts
         WHERE id IN (
           SELECT id FROM conflicts
           WHERE resolution_state != 'open' AND updated_at < ?
           ORDER BY updated_at ASC
           LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(result.changes);
  }
}

/** Body-free audit log: event type, IDs, outcome, and a redacted code only. */
export class AuditRepository {
  constructor(private readonly db: MemoryDatabase) {}

  record(params: {
    eventType: string;
    memoryId?: string | null;
    candidateId?: string | null;
    outcome: string;
    redactedCode?: string | null;
  }): AuditEventRow {
    validateAuditFields(params);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO audit_events (id, event_type, memory_id, candidate_id, outcome, redacted_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.eventType,
        params.memoryId ?? null,
        params.candidateId ?? null,
        params.outcome,
        params.redactedCode ?? null,
        now,
      );
    return this.db.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as unknown as AuditEventRow;
  }

  listRecent(limit: number): AuditEventRow[] {
    return this.db
      .prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as AuditEventRow[];
  }

  deleteOlderThan(cutoffIso: string, limit: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM audit_events
         WHERE id IN (
           SELECT id FROM audit_events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(result.changes);
  }

  deleteOverflowBeyond(maxRows: number, limit: number): number {
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number };
    const overflow = Number(countRow.n) - maxRows;
    if (overflow <= 0) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM audit_events
         WHERE id IN (
           SELECT id FROM audit_events ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(Math.min(overflow, limit));
    return Number(result.changes);
  }
}

/** Independent-extraction token/cost accounting without any prompt/response bodies. */
export class UsageRepository {
  constructor(private readonly db: MemoryDatabase) {}

  record(params: {
    modelId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    outcome: string;
  }): void {
    validateUsageFields(params);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO usage_events (id, purpose, model_id, input_tokens, output_tokens, cost_usd, outcome, created_at)
         VALUES (?, 'extraction', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.modelId,
        params.inputTokens,
        params.outputTokens,
        params.costUsd,
        params.outcome,
        new Date().toISOString(),
      );
  }

  listRecent(limit: number): UsageEventRow[] {
    return this.db
      .prepare("SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as UsageEventRow[];
  }

  deleteOlderThan(cutoffIso: string, limit: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM usage_events
         WHERE id IN (
           SELECT id FROM usage_events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(result.changes);
  }

  deleteOverflowBeyond(maxRows: number, limit: number): number {
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    const overflow = Number(countRow.n) - maxRows;
    if (overflow <= 0) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM usage_events
         WHERE id IN (
           SELECT id FROM usage_events ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(Math.min(overflow, limit));
    return Number(result.changes);
  }
}

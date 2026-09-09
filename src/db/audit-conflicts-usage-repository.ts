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
}

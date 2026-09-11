import { createHash, randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { CandidateRow, CandidateState, MemoryType, ProposedAction, Scope } from "./types.js";
import { candidateExpiryFrom } from "./lifecycle.js";
import { mutationNowIso } from "../governance/mutation-clock.js";
import { assertScopeTypeProjectIdentityInvariant } from "./validation.js";

export interface NewCandidateInput {
  scope: Scope;
  memoryType: MemoryType;
  text: string;
  evidenceSummary: string | null;
  sourceSessionId: string | null;
  sourceRef: string | null;
  proposedAction: ProposedAction;
  targetMemoryId: string | null;
  /** Immutable snapshot of the target's text hash at candidate creation; required when targeting. */
  expectedTargetTextHash?: string | null;
  projectIdentity: string | null;
}

function hashCandidateText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export class CandidatesRepository {
  constructor(private readonly db: MemoryDatabase) {}

  create(input: NewCandidateInput): CandidateRow {
    assertScopeTypeProjectIdentityInvariant(input.scope, input.memoryType, input.projectIdentity);
    const expectedTargetTextHash = input.expectedTargetTextHash ?? null;
    if (input.targetMemoryId === null && expectedTargetTextHash !== null) {
      throw new Error("create candidates must not carry an expected target text hash");
    }
    if (input.targetMemoryId !== null) {
      if (expectedTargetTextHash === null || !/^[0-9a-f]{64}$/.test(expectedTargetTextHash)) {
        throw new Error("targeted candidates require an immutable expected target text hash");
      }
    }
    const id = randomUUID();
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO candidates (
          id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
          proposed_action, target_memory_id, expected_target_text_hash, project_identity, state, created_at, updated_at, expires_at,
          approved_memory_id, failure_code, text_hash, body_purged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        id,
        input.scope,
        input.memoryType,
        input.text,
        input.evidenceSummary,
        input.sourceSessionId,
        input.sourceRef,
        input.proposedAction,
        input.targetMemoryId,
        expectedTargetTextHash,
        input.projectIdentity,
        now.toISOString(),
        now.toISOString(),
        candidateExpiryFrom(now),
      );
    return this.getById(id)!;
  }

  getById(id: string): CandidateRow | undefined {
    return this.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as
      | CandidateRow
      | undefined;
  }

  /** Lists pending, unexpired candidates, most recent first. */
  listPending(): CandidateRow[] {
    const nowIso = new Date().toISOString();
    return this.db
      .prepare(
        "SELECT * FROM candidates WHERE state = 'pending' AND expires_at > ? ORDER BY created_at DESC",
      )
      .all(nowIso) as unknown as CandidateRow[];
  }

  listExpired(): CandidateRow[] {
    const nowIso = new Date().toISOString();
    return this.db
      .prepare(
        "SELECT * FROM candidates WHERE state = 'pending' AND expires_at <= ? ORDER BY created_at DESC",
      )
      .all(nowIso) as unknown as CandidateRow[];
  }

  listReviewable(includeExpired: boolean): CandidateRow[] {
    const nowIso = mutationNowIso();
    return this.db
      .prepare(
        `SELECT * FROM candidates
         WHERE
           state IN ('failed', 'reconciling')
           OR (state IN ('pending', 'approving') AND expires_at > ?)
           OR (? = 1 AND (state = 'expired' OR (state = 'pending' AND expires_at <= ?)))
         ORDER BY created_at DESC`,
      )
      .all(nowIso, includeExpired ? 1 : 0, nowIso) as unknown as CandidateRow[];
  }

  private sweepExpiredWhere(extraWhere: string, extraParams: Array<string | number | null>): number {
    const nowIso = mutationNowIso();
    const due = this.db
      .prepare(
        `SELECT id, text FROM candidates
         WHERE state = 'pending' AND expires_at <= ?${extraWhere}`,
      )
      .all(nowIso, ...extraParams) as Array<{ id: string; text: string | null }>;
    let changed = 0;
    const update = this.db.prepare(
      `UPDATE candidates
       SET state = 'expired', updated_at = ?, text = NULL, evidence_summary = NULL,
           text_hash = COALESCE(text_hash, ?), body_purged_at = COALESCE(body_purged_at, ?)
       WHERE id = ? AND state = 'pending' AND expires_at <= ?`,
    );
    for (const row of due) {
      const textHash = row.text != null ? hashCandidateText(row.text) : null;
      const result = update.run(nowIso, textHash, nowIso, row.id, nowIso);
      changed += Number(result.changes);
    }
    return changed;
  }

  /**
   * Sweeps unclaimed pending candidates past TTL into `expired` and purges bodies
   * atomically, system-wide. Failed/reconciling/approving candidates stay
   * recoverable. Reserved for system-owned, lease-coordinated maintenance
   * (`cleanup-service.ts`) which is intentionally not bound to any cwd's
   * project scope. Per-request/cwd-scoped call sites must use
   * `sweepExpiredInScope` instead so they cannot mutate candidates outside
   * the caller's authorized project scope.
   */
  sweepExpired(): number {
    return this.sweepExpiredWhere("", []);
  }

  /**
   * Same as `sweepExpired`, but restricted to candidates visible under
   * `scopeContext`: profile-scope rows plus project-scope rows matching the
   * caller's current project identity. Used by cwd-scoped candidate
   * operations (list/approve/reject) so a request bound to one project (or
   * to no project) cannot expire-and-purge another project's hidden pending
   * candidates as a side effect.
   */
  sweepExpiredInScope(scopeContext: { projectScopeEnabled: boolean; projectIdentity: string | null }): number {
    return this.sweepExpiredWhere(" AND (scope != 'project' OR (? = 1 AND project_identity = ?))", [
      scopeContext.projectScopeEnabled ? 1 : 0,
      scopeContext.projectIdentity,
    ]);
  }

  /**
   * Purges bodies for any terminal candidates that still retain text
   * (e.g. pre-v7 rows). Returns count purged.
   */
  purgeLingeringTerminalBodies(limit = 100): number {
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, text FROM candidates
         WHERE state IN ('approved', 'rejected', 'expired')
           AND body_purged_at IS NULL
           AND text IS NOT NULL
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; text: string }>;
    let purged = 0;
    const update = this.db.prepare(
      `UPDATE candidates
       SET text = NULL, evidence_summary = NULL,
           text_hash = COALESCE(text_hash, ?), body_purged_at = ?, updated_at = updated_at
       WHERE id = ? AND state IN ('approved', 'rejected', 'expired') AND body_purged_at IS NULL`,
    );
    for (const row of rows) {
      const result = update.run(hashCandidateText(row.text), nowIso, row.id);
      purged += Number(result.changes);
    }
    return purged;
  }

  tryMarkApproved(
    id: string,
    approvedMemoryId: string,
    coherence: {
      scope: Scope;
      memoryType: MemoryType;
      projectIdentity: string | null;
      textHash: string;
      /** When set (replace), the memory id must match this exact target. */
      requiredMemoryId?: string;
    },
  ): boolean {
    const requiredId = coherence.requiredMemoryId ?? approvedMemoryId;
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE candidates
         SET state = 'approved', approved_memory_id = ?, failure_code = NULL, updated_at = ?,
             text = NULL, evidence_summary = NULL, text_hash = ?, body_purged_at = ?
         WHERE id = ?
           AND state = 'approving'
           AND EXISTS (
             SELECT 1 FROM memories m
             WHERE m.id = ?
               AND m.id = ?
               AND m.status = 'active'
               AND m.scope = ?
               AND m.memory_type = ?
               AND (
                 (m.project_identity IS NULL AND ? IS NULL)
                 OR m.project_identity = ?
               )
               AND m.text_hash = ?
           )`,
      )
      .run(
        approvedMemoryId,
        nowIso,
        coherence.textHash,
        nowIso,
        id,
        approvedMemoryId,
        requiredId,
        coherence.scope,
        coherence.memoryType,
        coherence.projectIdentity,
        coherence.projectIdentity,
        coherence.textHash,
      );
    return Number(result.changes) === 1;
  }

  /** Manual rejection is allowed for untouched pending or definite failed candidates. */
  tryMarkRejected(id: string): boolean {
    return this.tryTransitionToTerminal(id, "rejected", ["pending", "failed"]);
  }

  tryMarkExpired(id: string): boolean {
    return this.tryTransitionToTerminal(id, "expired", ["pending"]);
  }

  updateText(id: string, text: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE candidates SET text = ?, failure_code = NULL, updated_at = ? WHERE id = ? AND state = 'approving'",
      )
      .run(text, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  /**
   * Atomically transitions a pending candidate to `approved`, guarded by a
   * compare-and-set on the current state so two concurrent windows cannot both
   * win the same approval. The name intentionally says "claim" rather than
   * "approve" because later higher-level services may still fail the provider
   * write and must report that honestly.
   */
  tryClaimForApproval(id: string): boolean {
    const nowIso = mutationNowIso();
    const result = this.db
      .prepare(
        `UPDATE candidates
         SET state = 'approving', failure_code = NULL, updated_at = ?
         WHERE id = ?
           AND text IS NOT NULL
           AND (
             (state = 'pending' AND expires_at > ?)
             OR state IN ('failed', 'reconciling')
           )`,
      )
      .run(nowIso, id, nowIso);
    return Number(result.changes) === 1;
  }

  markApprovalFailure(id: string, nextState: Extract<CandidateState, "failed" | "reconciling">, failureCode: string): void {
    this.db
      .prepare(
        "UPDATE candidates SET state = ?, failure_code = ?, updated_at = ? WHERE id = ? AND state = 'approving'",
      )
      .run(nextState, failureCode, new Date().toISOString(), id);
  }

  resetToPending(id: string): void {
    this.db
      .prepare(
        "UPDATE candidates SET state = 'pending', failure_code = NULL, updated_at = ? WHERE id = ? AND state = 'approving'",
      )
      .run(new Date().toISOString(), id);
  }

  /** Purge bodies for terminal candidates linked to a forgotten/expired memory. */
  purgeBodiesForMemory(memoryId: string): number {
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, text FROM candidates
         WHERE (approved_memory_id = ? OR target_memory_id = ?)
           AND state IN ('approved', 'rejected', 'expired')
           AND body_purged_at IS NULL`,
      )
      .all(memoryId, memoryId) as Array<{ id: string; text: string | null }>;
    let purged = 0;
    const update = this.db.prepare(
      `UPDATE candidates
       SET text = NULL, evidence_summary = NULL,
           text_hash = COALESCE(text_hash, ?), body_purged_at = COALESCE(body_purged_at, ?)
       WHERE id = ? AND state IN ('approved', 'rejected', 'expired')`,
    );
    for (const row of rows) {
      const textHash = row.text != null ? hashCandidateText(row.text) : null;
      purged += Number(update.run(textHash, nowIso, row.id).changes);
    }
    return purged;
  }

  deleteTerminalOlderThan(cutoffIso: string, limit: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM candidates
         WHERE id IN (
           SELECT id FROM candidates
           WHERE state IN ('approved', 'rejected', 'expired')
             AND body_purged_at IS NOT NULL
             AND updated_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM conflicts c WHERE c.candidate_id = candidates.id
             )
           ORDER BY updated_at ASC
           LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(result.changes);
  }

  private tryTransitionToTerminal(
    id: string,
    nextState: "rejected" | "expired",
    allowedStates: CandidateState[],
  ): boolean {
    const row = this.getById(id);
    if (!row || !allowedStates.includes(row.state)) return false;
    if (row.text == null) return false;
    const nowIso = new Date().toISOString();
    const textHash = hashCandidateText(row.text);
    const placeholders = allowedStates.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE candidates
         SET state = ?, updated_at = ?, text = NULL, evidence_summary = NULL,
             text_hash = ?, body_purged_at = ?
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(nextState, nowIso, textHash, nowIso, id, ...allowedStates);
    return Number(result.changes) === 1;
  }
}

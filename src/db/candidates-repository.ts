import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { CandidateRow, CandidateState, MemoryType, ProposedAction, Scope } from "./types.js";
import { candidateExpiryFrom } from "./lifecycle.js";
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
          approved_memory_id, failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)`,
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
    const nowIso = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM candidates
         WHERE
           (state IN ('pending', 'approving', 'failed', 'reconciling') AND expires_at > ?)
           OR (? = 1 AND (state = 'expired' OR (state = 'pending' AND expires_at <= ?)))
         ORDER BY created_at DESC`,
      )
      .all(nowIso, includeExpired ? 1 : 0, nowIso) as unknown as CandidateRow[];
  }

  /** Sweeps expired reviewable candidates into the `expired` state. Returns count changed. */
  sweepExpired(): number {
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE candidates SET state = 'expired', updated_at = ? WHERE state IN ('pending', 'failed', 'reconciling') AND expires_at <= ?",
      )
      .run(nowIso, nowIso);
    return Number(result.changes);
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
    const result = this.db
      .prepare(
        `UPDATE candidates
         SET state = 'approved', approved_memory_id = ?, failure_code = NULL, updated_at = ?
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
        new Date().toISOString(),
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

  tryMarkRejected(id: string): boolean {
    return this.tryTransitionFromPending(id, "rejected");
  }

  tryMarkExpired(id: string): boolean {
    return this.tryTransitionFromPending(id, "expired");
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
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE candidates
         SET state = 'approving', failure_code = NULL, updated_at = ?
         WHERE id = ?
           AND (
             state = 'pending'
             OR state = 'failed'
             OR state = 'reconciling'
           )
           AND expires_at > ?`,
      )
      .run(now, id, now);
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

  private tryTransitionFromPending(id: string, nextState: "rejected" | "expired"): boolean {
    const result = this.db
      .prepare(
        "UPDATE candidates SET state = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'failed', 'reconciling')",
      )
      .run(nextState, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }
}

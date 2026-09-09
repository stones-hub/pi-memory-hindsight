/**
 * Idempotent write-operation ledger. The idempotency key is the conditional
 * ownership token used to guarantee only one writer proceeds for a given
 * logical write, and the deterministic `(bank_id, document_id)` pair is the
 * reconciliation key for uncertain (timeout/ambiguous) outcomes.
 */

import type { MemoryDatabase } from "./database.js";
import type { OperationAction, OperationRow, OperationState } from "./types.js";
import { mutationNowIso } from "../governance/mutation-clock.js";

export class OperationsRepository {
  constructor(private readonly db: MemoryDatabase) {}

  /**
   * Attempts to create a new operation row for `idempotencyKey`. Returns
   * `false` (without modifying anything) if one already exists, which is how
   * concurrent windows are prevented from double-writing the same operation.
   */
  tryCreate(params: {
    idempotencyKey: string;
    memoryId: string;
    action: OperationAction;
    bankId: string;
    documentId: string;
    expectedTextHash: string | null;
    memoryGeneration?: number | null;
  }): boolean {
    const now = mutationNowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO operations (
            idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
            state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0)`,
        )
        .run(
          params.idempotencyKey,
          params.memoryId,
          params.action,
          params.bankId,
          params.documentId,
          params.expectedTextHash,
          now,
          now,
          params.memoryGeneration ?? null,
        );
      return true;
    } catch {
      return false;
    }
  }

  getByKey(idempotencyKey: string): OperationRow | undefined {
    return this.db
      .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
      .get(idempotencyKey) as unknown as OperationRow | undefined;
  }

  getByDocument(bankId: string, documentId: string): OperationRow | undefined {
    return this.db
      .prepare("SELECT * FROM operations WHERE bank_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(bankId, documentId) as unknown as OperationRow | undefined;
  }

  listByMemoryId(memoryId: string): OperationRow[] {
    return this.db
      .prepare("SELECT * FROM operations WHERE memory_id = ? ORDER BY updated_at DESC, created_at DESC")
      .all(memoryId) as unknown as OperationRow[];
  }

  /**
   * Unconditional state write. Prefer CAS helpers for terminal/finalization
   * transitions so a stale crashed process cannot overwrite a takeover.
   */
  setState(idempotencyKey: string, state: OperationState): void {
    this.db
      .prepare("UPDATE operations SET state = ?, updated_at = ? WHERE idempotency_key = ?")
      .run(state, mutationNowIso(), idempotencyKey);
  }

  tryTransition(idempotencyKey: string, fromState: OperationState, toState: OperationState): boolean {
    const result = this.db
      .prepare(
        "UPDATE operations SET state = ?, updated_at = ? WHERE idempotency_key = ? AND state = ?",
      )
      .run(toState, mutationNowIso(), idempotencyKey, fromState);
    return Number(result.changes) === 1;
  }

  /**
   * CAS on `(state=in_progress, updated_at=progressToken)`. The progress token
   * is the `updated_at` captured when this process entered `in_progress`.
   * A stale takeover changes `updated_at`, so delayed completions fail closed.
   */
  tryUpdateFromProgress(
    idempotencyKey: string,
    progressToken: string,
    toState: OperationState,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE operations
         SET state = ?, updated_at = ?
         WHERE idempotency_key = ? AND state = 'in_progress' AND updated_at = ?`,
      )
      .run(toState, mutationNowIso(), idempotencyKey, progressToken);
    return Number(result.changes) === 1;
  }

  tryCommitFromProgress(idempotencyKey: string, progressToken: string): boolean {
    return this.tryUpdateFromProgress(idempotencyKey, progressToken, "committed");
  }

  markProviderMutationIssued(idempotencyKey: string, progressToken: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE operations
         SET provider_mutation_issued = 1, updated_at = updated_at
         WHERE idempotency_key = ?
           AND state = 'in_progress'
           AND updated_at = ?
           AND provider_mutation_issued = 0`,
      )
      .run(idempotencyKey, progressToken);
    // Also succeed if already marked under the same progress token (retry).
    if (Number(result.changes) === 1) return true;
    const row = this.getByKey(idempotencyKey);
    return (
      !!row &&
      row.state === "in_progress" &&
      row.updated_at === progressToken &&
      row.provider_mutation_issued === 1
    );
  }

  incrementAttempt(idempotencyKey: string): void {
    this.db
      .prepare(
        "UPDATE operations SET attempt_count = attempt_count + 1, updated_at = ? WHERE idempotency_key = ?",
      )
      .run(mutationNowIso(), idempotencyKey);
  }
}

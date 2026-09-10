import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { MemoryRow, MemoryStatus, MemoryType, Scope, VerificationState } from "./types.js";
import { mutationNowIso } from "../governance/mutation-clock.js";
import { assertScopeTypeProjectIdentityInvariant } from "./validation.js";

export interface NewMemoryInput {
  id?: string;
  scope: Scope;
  memoryType: MemoryType;
  projectIdentity: string | null;
  bankId: string;
  documentId: string;
  unitId: string | null;
  textHash: string;
  textLength: number;
  verificationState: VerificationState;
  sourceSessionId: string | null;
  sourceRef: string | null;
  supersedesMemoryId: string | null;
  expiresAt: string | null;
  status?: MemoryStatus;
  createdAt?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
  legacyDocumentTextHash?: string | null;
  mutationGeneration?: number;
  mutationOwnerKey?: string | null;
}

export class MemoriesRepository {
  constructor(private readonly db: MemoryDatabase) {}

  create(input: NewMemoryInput): MemoryRow {
    assertScopeTypeProjectIdentityInvariant(input.scope, input.memoryType, input.projectIdentity);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "active";
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const lastVerifiedAt =
      input.lastVerifiedAt !== undefined
        ? input.lastVerifiedAt
        : input.verificationState === "verified" && status === "active"
          ? updatedAt
          : null;
    this.db
      .prepare(
        `INSERT INTO memories (
          id, scope, memory_type, project_identity, bank_id, document_id, unit_id,
          text_hash, text_length, status, verification_state, source_session_id, source_ref,
          supersedes_memory_id, created_at, updated_at, last_verified_at, expires_at,
          legacy_document_text_hash, mutation_generation, mutation_owner_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.memoryType,
        input.projectIdentity,
        input.bankId,
        input.documentId,
        input.unitId,
        input.textHash,
        input.textLength,
        status,
        input.verificationState,
        input.sourceSessionId,
        input.sourceRef,
        input.supersedesMemoryId,
        createdAt,
        updatedAt,
        lastVerifiedAt,
        input.expiresAt,
        input.legacyDocumentTextHash ?? null,
        input.mutationGeneration ?? 1,
        input.mutationOwnerKey ?? null,
      );
    return this.getById(id)!;
  }

  getById(id: string): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as
      | MemoryRow
      | undefined;
  }

  getByBankAndDocument(bankId: string, documentId: string): MemoryRow | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE bank_id = ? AND document_id = ?")
      .get(bankId, documentId) as unknown as MemoryRow | undefined;
  }

  deleteById(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  getOwnedActiveOrReconcilingById(id: string): MemoryRow | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND status IN ('active', 'reconciling')")
      .get(id) as unknown as MemoryRow | undefined;
  }

  findActiveByTextHash(
    scope: Scope,
    projectIdentity: string | null,
    memoryType: MemoryType,
    textHash: string,
  ): MemoryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE scope = ? AND (project_identity IS ?) AND memory_type = ? AND text_hash = ? AND status = 'active'`,
      )
      .get(scope, projectIdentity, memoryType, textHash) as unknown as MemoryRow | undefined;
  }

  /**
   * Exact-content convergence lookup used while claiming a create: an in-flight
   * (reconciling) write with the same scope/project/type/hash must be treated as
   * the same logical memory so concurrent callers do not open a second document.
   */
  findActiveOrReconcilingByTextHash(
    scope: Scope,
    projectIdentity: string | null,
    memoryType: MemoryType,
    textHash: string,
  ): MemoryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE scope = ? AND (project_identity IS ?) AND memory_type = ? AND text_hash = ?
           AND status IN ('active', 'reconciling')
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(scope, projectIdentity, memoryType, textHash) as unknown as MemoryRow | undefined;
  }

  listActive(scope: Scope, projectIdentity: string | null): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE scope = ? AND (project_identity IS ?) AND status = 'active' ORDER BY updated_at DESC`,
      )
      .all(scope, projectIdentity) as unknown as MemoryRow[];
  }

  /**
   * Effective-active memories: status active and not past expires_at.
   * Excludes rows with open conflicts when `excludeOpenConflicts` is true.
   */
  listEffectiveActive(params: {
    scope?: Scope;
    projectIdentity?: string | null;
    nowIso: string;
    limit: number;
    excludeOpenConflicts?: boolean;
  }): MemoryRow[] {
    const excludeConflicts = params.excludeOpenConflicts !== false;
    if (params.scope === undefined) {
      return this.db
        .prepare(
          `SELECT m.* FROM memories m
           WHERE m.status = 'active'
             AND (m.expires_at IS NULL OR m.expires_at > ?)
             AND (? = 0 OR NOT EXISTS (
               SELECT 1 FROM conflicts c WHERE c.memory_id = m.id AND c.resolution_state = 'open'
             ))
           ORDER BY m.updated_at DESC
           LIMIT ?`,
        )
        .all(params.nowIso, excludeConflicts ? 1 : 0, params.limit) as unknown as MemoryRow[];
    }
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.scope = ?
           AND (m.project_identity IS ?)
           AND m.status = 'active'
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND (? = 0 OR NOT EXISTS (
             SELECT 1 FROM conflicts c WHERE c.memory_id = m.id AND c.resolution_state = 'open'
           ))
         ORDER BY m.updated_at DESC
         LIMIT ?`,
      )
      .all(
        params.scope,
        params.projectIdentity ?? null,
        params.nowIso,
        excludeConflicts ? 1 : 0,
        params.limit,
      ) as unknown as MemoryRow[];
  }

  listDueForExpiry(nowIso: string, limit: number): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?
           AND mutation_owner_key IS NULL
         ORDER BY expires_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as MemoryRow[];
  }

  /**
   * Read-only scan for due rows with a joined foreign mutation owner that matches
   * locator/generation and allowed action/hash shapes. Overfetch callers filter
   * live leases and ambiguous histories in application code.
   */
  listCoherentForeignOwnedDueForExpiry(nowIso: string, limit: number): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         INNER JOIN operations o ON o.idempotency_key = m.mutation_owner_key
         WHERE m.expires_at IS NOT NULL
           AND m.expires_at <= ?
           AND m.status IN ('active', 'reconciling')
           AND m.mutation_owner_key IS NOT NULL
           AND m.mutation_owner_key != (
             'expire:' || m.id || ':g' || m.mutation_generation || ':' || m.text_hash || ':' || m.document_id
           )
           AND o.memory_id = m.id
           AND o.bank_id = m.bank_id
           AND o.document_id = m.document_id
           AND (o.memory_generation IS NULL OR o.memory_generation = m.mutation_generation)
           AND o.state IN ('pending', 'reconciling', 'failed', 'in_progress')
           AND (
             (o.action = 'delete' AND o.expected_text_hash = m.text_hash)
             OR (
               o.action IN ('replace', 'create')
               AND o.expected_text_hash IS NOT NULL
               AND length(o.expected_text_hash) = 64
               AND o.expected_text_hash GLOB '[0-9a-f]*'
             )
           )
         ORDER BY m.expires_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as MemoryRow[];
  }

  /**
   * Atomically abandons a foreign mutation owner and binds the deterministic
   * expire owner at the next generation. Caller must retire the foreign op first.
   */
  tryHandoffToExpireOwner(params: {
    id: string;
    foreignOwnerKey: string;
    expectedGeneration: number;
    newGeneration: number;
    expireOwnerKey: string;
    nowIso: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_generation = ?,
             mutation_owner_key = ?,
             mutation_progress_token = NULL,
             status = 'reconciling'
         WHERE id = ?
           AND mutation_generation = ?
           AND mutation_owner_key = ?
           AND status IN ('active', 'reconciling')
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .run(
        params.newGeneration,
        params.expireOwnerKey,
        params.id,
        params.expectedGeneration,
        params.foreignOwnerKey,
        params.nowIso,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Reconciling rows with an expire-owned delete operation whose locator and
   * generation match the memory row (exact key shape, not prefix-only).
   */
  listCoherentReconcilingExpiryCandidates(nowIso: string, limit: number): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         INNER JOIN operations o ON o.idempotency_key = m.mutation_owner_key
         WHERE m.status = 'reconciling'
           AND m.mutation_owner_key IS NOT NULL
           AND m.expires_at IS NOT NULL
           AND m.expires_at <= ?
           AND o.action = 'delete'
           AND o.memory_id = m.id
           AND o.bank_id = m.bank_id
           AND o.document_id = m.document_id
           AND o.expected_text_hash = m.text_hash
           AND (
             o.memory_generation IS NULL
             OR o.memory_generation = m.mutation_generation
           )
           AND m.mutation_owner_key = (
             'expire:' || m.id || ':g' || m.mutation_generation || ':' || m.text_hash || ':' || m.document_id
           )
           AND o.state IN ('pending', 'in_progress', 'reconciling', 'failed')
         ORDER BY m.expires_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as MemoryRow[];
  }

  deleteEligibleTombstones(cutoffIso: string, limit: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM memories
         WHERE id IN (
           SELECT m.id FROM memories m
           WHERE m.status IN ('deleted', 'expired')
             AND m.mutation_owner_key IS NULL
             AND m.updated_at < ?
             AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.memory_id = m.id)
             AND NOT EXISTS (SELECT 1 FROM conflicts c WHERE c.memory_id = m.id)
             AND NOT EXISTS (
               SELECT 1 FROM candidates c
               WHERE c.target_memory_id = m.id OR c.approved_memory_id = m.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM memories child WHERE child.supersedes_memory_id = m.id
             )
           ORDER BY m.updated_at ASC
           LIMIT ?
         )`,
      )
      .run(cutoffIso, limit);
    return Number(result.changes);
  }

  updateUnitAndHash(id: string, unitId: string | null, textHash: string, textLength: number): void {
    this.db
      .prepare(
        "UPDATE memories SET unit_id = ?, text_hash = ?, text_length = ?, updated_at = ? WHERE id = ?",
      )
      .run(unitId, textHash, textLength, new Date().toISOString(), id);
  }

  setStatus(id: string, status: MemoryStatus): void {
    this.db.prepare("UPDATE memories SET status = ? WHERE id = ?").run(status, id);
  }

  /**
   * Freezes the pre-fix document derivation key before a governed update
   * changes `text_hash`. No-op when already set.
   */
  freezeLegacyDocumentTextHash(id: string, textHash: string): void {
    this.db
      .prepare(
        `UPDATE memories
         SET legacy_document_text_hash = ?
         WHERE id = ? AND legacy_document_text_hash IS NULL`,
      )
      .run(textHash, id);
  }

  trySetMutationOwner(id: string, ownerKey: string, expectedGeneration: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = ?, status = 'reconciling', mutation_progress_token = NULL
         WHERE id = ?
           AND mutation_generation = ?
           AND status IN ('active', 'reconciling')
           AND (mutation_owner_key IS NULL OR mutation_owner_key = ?)`,
      )
      .run(ownerKey, id, expectedGeneration, ownerKey);
    return Number(result.changes) === 1;
  }

  setMutationProgressToken(id: string, ownerKey: string, progressToken: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_progress_token = ?
         WHERE id = ? AND mutation_owner_key = ? AND status = 'reconciling'`,
      )
      .run(progressToken, id, ownerKey);
    return Number(result.changes) === 1;
  }

  clearMutationProgressToken(id: string, ownerKey: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_progress_token = NULL
         WHERE id = ? AND mutation_owner_key = ?`,
      )
      .run(id, ownerKey);
    return Number(result.changes) === 1;
  }

  clearMutationOwner(id: string, ownerKey: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = NULL, mutation_progress_token = NULL
         WHERE id = ? AND mutation_owner_key = ?`,
      )
      .run(id, ownerKey);
    return Number(result.changes) === 1;
  }

  releaseMutationOwnerToActive(id: string, ownerKey: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = NULL, mutation_progress_token = NULL, status = 'active'
         WHERE id = ? AND mutation_owner_key = ? AND status = 'reconciling'`,
      )
      .run(id, ownerKey);
    return Number(result.changes) === 1;
  }

  /**
   * Keeps/asserts reconciling under the live progress token. Fails closed when
   * ownership/generation/token no longer match (e.g. after lease takeover or
   * a newer winner already finalized the row).
   */
  keepReconcilingUnderProgress(params: {
    id: string;
    ownerKey: string;
    expectedGeneration: number;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET status = 'reconciling'
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND status IN ('active', 'reconciling')`,
      )
      .run(params.id, params.ownerKey, params.expectedGeneration, params.progressToken);
    return Number(result.changes) === 1;
  }

  /**
   * Definite pre-mutation failure release: only when this attempt still owns
   * the generation and progress token.
   */
  releaseToActiveUnderProgress(params: {
    id: string;
    ownerKey: string;
    expectedGeneration: number;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = NULL, mutation_progress_token = NULL, status = 'active'
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND status = 'reconciling'`,
      )
      .run(params.id, params.ownerKey, params.expectedGeneration, params.progressToken);
    return Number(result.changes) === 1;
  }

  /** Clears owner only while the progress token still matches this attempt. */
  clearMutationOwnerUnderProgress(params: {
    id: string;
    ownerKey: string;
    expectedGeneration: number;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = NULL, mutation_progress_token = NULL
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?`,
      )
      .run(params.id, params.ownerKey, params.expectedGeneration, params.progressToken);
    return Number(result.changes) === 1;
  }

  /** Restores an ownerless reconciling row to active after definite pre-mutation failure. */
  restoreOwnerlessReconcilingToActive(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET mutation_owner_key = NULL, mutation_progress_token = NULL, status = 'active'
         WHERE id = ? AND status = 'reconciling' AND mutation_owner_key IS NULL`,
      )
      .run(id);
    return Number(result.changes) === 1;
  }

  activate(params: {
    id: string;
    unitId: string;
    verificationState: VerificationState;
    createdAt: string;
    updatedAt: string;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    ownerKey?: string;
    progressToken?: string;
    /** Required when `ownerKey` is set — owned create finalization is generation-scoped. */
    expectedGeneration?: number;
  }): boolean {
    if (params.ownerKey) {
      if (params.expectedGeneration === undefined || params.progressToken === undefined) {
        return false;
      }
      const result = this.db
        .prepare(
          `UPDATE memories
           SET unit_id = ?, status = 'active', verification_state = ?, created_at = ?, updated_at = ?,
               last_verified_at = ?, expires_at = ?, mutation_owner_key = NULL, mutation_progress_token = NULL
           WHERE id = ?
             AND mutation_owner_key = ?
             AND mutation_generation = ?
             AND mutation_progress_token = ?
             AND status = 'reconciling'
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(
          params.unitId,
          params.verificationState,
          params.createdAt,
          params.updatedAt,
          params.lastVerifiedAt,
          params.expiresAt,
          params.id,
          params.ownerKey,
          params.expectedGeneration,
          params.progressToken,
          mutationNowIso(),
        );
      return Number(result.changes) === 1;
    }
    this.db
      .prepare(
        `UPDATE memories
         SET unit_id = ?, status = 'active', verification_state = ?, created_at = ?, updated_at = ?, last_verified_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(
        params.unitId,
        params.verificationState,
        params.createdAt,
        params.updatedAt,
        params.lastVerifiedAt,
        params.expiresAt,
        params.id,
      );
    return true;
  }

  /**
   * Applies a same-document metadata/unit refresh (e.g. duplicate reverify)
   * under mutation ownership. Increments generation and clears the owner.
   */
  applyReverifyCas(params: {
    id: string;
    unitId: string;
    textHash: string;
    verificationState: VerificationState;
    updatedAt: string;
    lastVerifiedAt: string | null;
    ownerKey: string;
    expectedGeneration: number;
    expectedBankId: string;
    expectedDocumentId: string;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET unit_id = ?, verification_state = ?, updated_at = ?, last_verified_at = ?,
             mutation_owner_key = NULL, mutation_progress_token = NULL,
             mutation_generation = mutation_generation + 1, status = 'active'
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND text_hash = ?
           AND bank_id = ?
           AND document_id = ?
           AND status = 'reconciling'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(
        params.unitId,
        params.verificationState,
        params.updatedAt,
        params.lastVerifiedAt,
        params.id,
        params.ownerKey,
        params.expectedGeneration,
        params.progressToken,
        params.textHash,
        params.expectedBankId,
        params.expectedDocumentId,
        mutationNowIso(),
      );
    return Number(result.changes) === 1;
  }

  markVerified(id: string, at?: string): void {
    const now = at ?? new Date().toISOString();
    this.db
      .prepare(
        "UPDATE memories SET verification_state = 'verified', last_verified_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  /**
   * Applies a governed in-place content replacement to an existing row.
   * Preserves `id`, `bank_id`, `document_id`, `created_at`, `scope`,
   * `memory_type`, and `project_identity` (the stable logical-memory
   * identity); updates only the fields a replace legitimately changes.
   */
  applyReplace(params: {
    id: string;
    unitId: string;
    textHash: string;
    textLength: number;
    verificationState: VerificationState;
    updatedAt: string;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    sourceSessionId: string | null;
    sourceRef: string | null;
    ownerKey: string;
    expectedGeneration: number;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET unit_id = ?, text_hash = ?, text_length = ?, status = 'active', verification_state = ?,
             updated_at = ?, last_verified_at = ?, expires_at = ?, source_session_id = ?, source_ref = ?,
             mutation_owner_key = NULL, mutation_progress_token = NULL,
             mutation_generation = mutation_generation + 1
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND status = 'reconciling'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(
        params.unitId,
        params.textHash,
        params.textLength,
        params.verificationState,
        params.updatedAt,
        params.lastVerifiedAt,
        params.expiresAt,
        params.sourceSessionId,
        params.sourceRef,
        params.id,
        params.ownerKey,
        params.expectedGeneration,
        params.progressToken,
        mutationNowIso(),
      );
    return Number(result.changes) === 1;
  }

  markDeletedCas(params: {
    id: string;
    ownerKey: string;
    expectedGeneration: number;
    expectedTextHash: string;
    expectedDocumentId: string;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET status = 'deleted', mutation_owner_key = NULL, mutation_progress_token = NULL,
             mutation_generation = mutation_generation + 1
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND text_hash = ?
           AND document_id = ?
           AND status IN ('active', 'reconciling')`,
      )
      .run(
        params.id,
        params.ownerKey,
        params.expectedGeneration,
        params.progressToken,
        params.expectedTextHash,
        params.expectedDocumentId,
      );
    return Number(result.changes) === 1;
  }

  markExpiredCas(params: {
    id: string;
    ownerKey: string;
    expectedGeneration: number;
    expectedTextHash: string;
    expectedDocumentId: string;
    progressToken: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET status = 'expired', mutation_owner_key = NULL, mutation_progress_token = NULL,
             mutation_generation = mutation_generation + 1, updated_at = ?
         WHERE id = ?
           AND mutation_owner_key = ?
           AND mutation_generation = ?
           AND mutation_progress_token = ?
           AND text_hash = ?
           AND document_id = ?
           AND status IN ('active', 'reconciling')`,
      )
      .run(
        mutationNowIso(),
        params.id,
        params.ownerKey,
        params.expectedGeneration,
        params.progressToken,
        params.expectedTextHash,
        params.expectedDocumentId,
      );
    return Number(result.changes) === 1;
  }
}

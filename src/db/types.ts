/** Shared row/domain types for the SQLite governance store. */

export type Scope = "profile" | "project";

export type MemoryType =
  | "preference"
  | "habit"
  | "project_fact"
  | "decision"
  | "lesson"
  | "task_state"
  | "inference";

export const PROFILE_MEMORY_TYPES: readonly MemoryType[] = ["preference", "habit"];
export const PROJECT_MEMORY_TYPES: readonly MemoryType[] = [
  "project_fact",
  "decision",
  "lesson",
  "task_state",
  "inference",
];

export type ProposedAction = "create" | "update" | "supersede" | "ignore";
export type CandidateState =
  | "pending"
  | "approving"
  | "approved"
  | "rejected"
  | "expired"
  | "failed"
  | "reconciling";
export type MemoryStatus = "active" | "superseded" | "deleted" | "reconciling";
export type VerificationState = "verified" | "unverified";
export type OperationAction = "create" | "replace" | "delete";
export type OperationState = "pending" | "in_progress" | "committed" | "failed" | "reconciling";
export type ConflictKind = "duplicate" | "contradiction" | "cross_scope";
export type ConflictResolutionState =
  | "open"
  | "resolved_keep_existing"
  | "resolved_superseded"
  | "resolved_both_kept"
  | "dismissed";

export interface ProfileRow {
  id: 1;
  anonymous_profile_id: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryRow {
  id: string;
  scope: Scope;
  memory_type: MemoryType;
  project_identity: string | null;
  bank_id: string;
  document_id: string;
  unit_id: string | null;
  text_hash: string;
  text_length: number;
  status: MemoryStatus;
  verification_state: VerificationState;
  source_session_id: string | null;
  source_ref: string | null;
  supersedes_memory_id: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  expires_at: string | null;
  /**
   * When non-null, freezes the text-hash key used to derive a pre-fix
   * legacy document id so governed updates can change `text_hash` while
   * still recomputing the stored locator. Null for current-format rows.
   */
  legacy_document_text_hash: string | null;
  /**
   * Monotonic per-row mutation generation. Replace/delete finalization and
   * recreation after delete advance this so historical operations cannot
   * satisfy a newer generation.
   */
  mutation_generation: number;
  /**
   * Idempotency key of the in-flight replace/delete/create that currently
   * owns this generation. Null when idle. Durable across Pi windows via SQLite.
   */
  mutation_owner_key: string | null;
  /**
   * Progress token (`operations.updated_at`) for the current in_progress attempt.
   * Stale crash recoveries clear this so delayed finalization CAS fails.
   */
  mutation_progress_token: string | null;
}

export interface CandidateRow {
  id: string;
  scope: Scope;
  memory_type: MemoryType;
  text: string;
  evidence_summary: string | null;
  source_session_id: string | null;
  source_ref: string | null;
  proposed_action: ProposedAction;
  target_memory_id: string | null;
  expected_target_text_hash: string | null;
  project_identity: string | null;
  state: CandidateState;
  created_at: string;
  updated_at: string;
  expires_at: string;
  approved_memory_id: string | null;
  failure_code: string | null;
}

export interface OperationRow {
  idempotency_key: string;
  memory_id: string;
  action: OperationAction;
  bank_id: string;
  document_id: string;
  expected_text_hash: string | null;
  state: OperationState;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  /** Generation snapshotted when the operation was claimed; null on pre-v5 rows. */
  memory_generation: number | null;
  /**
   * 1 once a provider retain/delete (or equivalent mutating call) was issued
   * for this operation attempt. Distinguishes definite pre-mutation failure
   * (safe to restore prior active truth) from maybe-mutated reconciliation.
   */
  provider_mutation_issued: number;
}

export interface ConflictRow {
  id: string;
  candidate_id: string | null;
  memory_id: string | null;
  kind: ConflictKind;
  resolution_state: ConflictResolutionState;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRow {
  id: string;
  event_type: string;
  memory_id: string | null;
  candidate_id: string | null;
  outcome: string;
  redacted_code: string | null;
  created_at: string;
}

export interface UsageEventRow {
  id: string;
  purpose: "extraction";
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  outcome: string;
  created_at: string;
}

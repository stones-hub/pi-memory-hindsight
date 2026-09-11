import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { CandidateRow } from "../db/types.js";
import { normalizeLanguage, t, type Language } from "../i18n/messages.js";
import { validateMemoryText } from "../security/filters.js";
import { remember, type RememberResult, getRememberAuditCode, textHashOf } from "./remember-service.js";
import { replaceMemory, type ReplaceResult, getReplaceAuditCode } from "./replace-service.js";
import type { ProjectBankResult } from "../runtime/project-runtime.js";

/**
 * The current cwd's Project scope state. Resolved once by the caller (command
 * dispatch or reviewer open) and threaded through every candidate read and
 * write so a Project candidate can never be seen or mutated from the wrong
 * project, even when a direct candidate ID is supplied.
 */
export interface CandidateScopeContext {
  projectIdentity: string | null;
  projectScopeEnabled: boolean;
}

export function toCandidateScopeContext(bank: ProjectBankResult): CandidateScopeContext {
  return bank.enabled
    ? { projectIdentity: bank.identity, projectScopeEnabled: true }
    : { projectIdentity: null, projectScopeEnabled: false };
}

export function candidateVisibleInScope(row: CandidateRow, scopeContext: CandidateScopeContext): boolean {
  if (row.scope !== "project") return true;
  return scopeContext.projectScopeEnabled && row.project_identity === scopeContext.projectIdentity;
}

export interface CandidateApproveRequest {
  candidateId: string;
  cwd: string;
  scopeContext: CandidateScopeContext;
  sourceSessionId: string | null;
  editedText?: string;
  signal?: AbortSignal | undefined;
}

export type CandidateApproveResult =
  | { outcome: "approved"; memoryId: string }
  | { outcome: "rejected"; reason: string; code?: string }
  | { outcome: "retryable"; reason: string; code?: string }
  | { outcome: "not_found" }
  | { outcome: "already_decided" };

export type CandidateAuthorizationResult = { ok: true } | { ok: false; result: CandidateApproveResult };

/**
 * Local-only (no provider I/O) existence + project-scope authorization check.
 * Callers must run this against the local SQLite-only runtime, before ever
 * constructing a provider-capable runtime (`getGlobalRuntime()`), so a
 * wrong/disabled-project request never triggers a provider health/version
 * compatibility check as a side effect of building that runtime. Mirrors the
 * first guard inside `approveCandidate()`, which keeps its own copy of this
 * check as defense-in-depth against a caller that skips this pre-check.
 */
export function authorizeCandidateForApproval(
  runtime: GlobalRuntime,
  candidateId: string,
  scopeContext: CandidateScopeContext,
): CandidateAuthorizationResult {
  const row = runtime.repos.candidates.getById(candidateId);
  if (!row) return { ok: false, result: { outcome: "not_found" } };
  if (row.scope === "project") {
    if (!scopeContext.projectScopeEnabled) {
      return {
        ok: false,
        result: {
          outcome: "rejected",
          reason: "project scope is unavailable for this candidate",
          code: "project_unavailable",
        },
      };
    }
    if (scopeContext.projectIdentity !== row.project_identity) {
      return {
        ok: false,
        result: { outcome: "rejected", reason: "candidate belongs to a different project", code: "project_mismatch" },
      };
    }
  }
  return { ok: true };
}

/** Test-only hook: runs after provider mapping succeeds and before guarded approval CAS. */
let beforeCandidateApprovalFinalizeForTests:
  | ((runtime: GlobalRuntime, memoryId: string) => void | Promise<void>)
  | null = null;

export function setBeforeCandidateApprovalFinalizeForTests(
  fn: ((runtime: GlobalRuntime, memoryId: string) => void | Promise<void>) | null,
): void {
  beforeCandidateApprovalFinalizeForTests = fn;
}

/**
 * A candidate that explicitly names a target is, by this extension's only
 * supported deterministic rule, a conflict against that existing memory (no
 * semantic/model-based detection). Conflict state is materialized lazily
 * whenever such a candidate becomes reviewable, so it is visible before a
 * reviewer decides to approve or reject.
 */
export function listCandidates(
  runtime: GlobalRuntime,
  includeExpired: boolean,
  scopeContext: CandidateScopeContext,
): CandidateRow[] {
  // Scoped, not sweepExpired(): a profile-only or single-project listing must
  // never expire-and-purge another project's hidden pending candidates as a
  // side effect of this cwd-scoped read.
  runtime.repos.candidates.sweepExpiredInScope(scopeContext);
  const rows = runtime.repos.candidates
    .listReviewable(includeExpired)
    .filter((row) => candidateVisibleInScope(row, scopeContext));
  for (const row of rows) {
    if (row.target_memory_id !== null && runtime.repos.conflicts.listOpenForCandidate(row.id).length === 0) {
      runtime.repos.conflicts.create({ candidateId: row.id, memoryId: row.target_memory_id, kind: "contradiction" });
    }
  }
  return rows;
}

function mapRememberFailure(result: RememberResult, runtime: GlobalRuntime): CandidateApproveResult {
  switch (result.outcome) {
    case "written":
      return { outcome: "approved", memoryId: result.memoryId };
    case "duplicate": {
      const row = runtime.repos.memories.getById(result.memoryId);
      if (!row || row.status !== "active") {
        return {
          outcome: "rejected",
          reason: "duplicate target is not an active local memory",
          code: "stale_duplicate_target",
        };
      }
      return { outcome: "approved", memoryId: result.memoryId };
    }
    case "rejected":
    case "conflict": {
      const code = getRememberAuditCode(result);
      return { outcome: "rejected", reason: result.reason, ...(code ? { code } : {}) };
    }
    case "in_progress":
      return { outcome: "retryable", reason: "another write is already in progress", code: "in_progress" };
    case "unknown":
      return { outcome: "retryable", reason: result.reason, code: "unknown" };
  }
}

function mapReplaceFailure(result: ReplaceResult): CandidateApproveResult {
  switch (result.outcome) {
    case "replaced":
      return { outcome: "approved", memoryId: result.memoryId };
    case "rejected": {
      const code = getReplaceAuditCode(result);
      return { outcome: "rejected", reason: result.reason, ...(code ? { code } : {}) };
    }
    case "in_progress":
      return { outcome: "retryable", reason: "another write is already in progress", code: "in_progress" };
    case "unknown":
      return { outcome: "retryable", reason: result.reason, code: "unknown" };
  }
}

/** Deterministic (non-semantic) validity check for a proposed action/target combination. */
function checkProposedActionShape(row: CandidateRow): { ok: boolean; reason: string } {
  if (row.proposed_action === "ignore") {
    return { ok: false, reason: "ignore candidates cannot be approved" };
  }
  if (row.proposed_action === "create") {
    return row.target_memory_id === null
      ? { ok: true, reason: "" }
      : { ok: false, reason: "create candidates must not name a target memory" };
  }
  // "update" | "supersede"
  return row.target_memory_id !== null
    ? { ok: true, reason: "" }
    : { ok: false, reason: `${row.proposed_action} candidates must name a target memory` };
}

export async function approveCandidate(
  runtime: GlobalRuntime,
  request: CandidateApproveRequest,
): Promise<CandidateApproveResult> {
  // Existence, then authorization, before any other inspection or mutation:
  // a wrong/disabled-project direct-ID request must fail closed on the
  // project-scope check alone, before this candidate's state/shape/body is
  // read and before any scoped sweep or provider I/O happens. `scope` and
  // `project_identity` are immutable once a candidate is created, so this
  // check remains valid for the rest of the function. Kept here as
  // defense-in-depth even though every caller is also required to run
  // `authorizeCandidateForApproval()` itself before ever constructing a
  // provider-capable runtime.
  const authorization = authorizeCandidateForApproval(runtime, request.candidateId, request.scopeContext);
  if (!authorization.ok) return authorization.result;

  // Scoped, not sweepExpired(): an authorized direct-ID operation must never
  // expire-and-purge another project's hidden pending candidates as a side
  // effect. This may flip the target row itself (if past TTL); re-fetch below.
  runtime.repos.candidates.sweepExpiredInScope(request.scopeContext);
  const row = runtime.repos.candidates.getById(request.candidateId);
  if (!row) return { outcome: "not_found" };
  if (row.state === "approved" || row.state === "rejected") return { outcome: "already_decided" };
  if (row.state === "expired") return { outcome: "rejected", reason: "candidate expired", code: "candidate_expired" };
  const shapeCheck = checkProposedActionShape(row);
  if (!shapeCheck.ok) {
    return { outcome: "rejected", reason: shapeCheck.reason, code: "invalid_action_shape" };
  }

  const text = (request.editedText ?? row.text ?? "").trim();
  if (!row.text && request.editedText === undefined) {
    return { outcome: "rejected", reason: "candidate body is unavailable", code: "candidate_body_unavailable" };
  }
  const textValidation = validateMemoryText(text);
  if (!textValidation.ok) {
    return { outcome: "rejected", reason: textValidation.reason ?? "invalid candidate text", code: "invalid_text" };
  }

  if (!runtime.repos.candidates.tryClaimForApproval(row.id)) {
    return { outcome: "already_decided" };
  }

  const current = runtime.repos.candidates.getById(row.id);
  if (!current) return { outcome: "not_found" };
  if (current.scope !== row.scope || current.memory_type !== row.memory_type || current.project_identity !== row.project_identity) {
    runtime.repos.candidates.markApprovalFailure(row.id, "failed", "candidate_changed");
    return { outcome: "retryable", reason: "candidate changed before approval", code: "candidate_changed" };
  }
  if (request.editedText !== undefined) {
    if (!runtime.repos.candidates.updateText(row.id, text)) {
      runtime.repos.candidates.markApprovalFailure(row.id, "failed", "edit_claim_lost");
      return { outcome: "retryable", reason: "candidate edit lost its approval claim", code: "edit_claim_lost" };
    }
  }

  const isReplace = row.proposed_action === "update" || row.proposed_action === "supersede";
  if (isReplace) {
    if (row.expected_target_text_hash === null || !/^[0-9a-f]{64}$/.test(row.expected_target_text_hash)) {
      runtime.repos.candidates.markApprovalFailure(row.id, "failed", "missing_target_snapshot");
      runtime.repos.audit.record({
        eventType: "candidate",
        candidateId: row.id,
        outcome: "approval_rejected",
        redactedCode: "missing_target_snapshot",
      });
      return {
        outcome: "rejected",
        reason: "targeted candidate is missing an immutable target snapshot; recreate it against the current memory",
        code: "missing_target_snapshot",
      };
    }
    const target = runtime.repos.memories.getById(row.target_memory_id!);
    if (!target || target.text_hash !== row.expected_target_text_hash) {
      runtime.repos.candidates.markApprovalFailure(row.id, "failed", "stale_target");
      runtime.repos.audit.record({
        eventType: "candidate",
        candidateId: row.id,
        outcome: "approval_rejected",
        redactedCode: "stale_target",
      });
      return {
        outcome: "rejected",
        reason: "target memory changed since this candidate was created; review against the current value",
        code: "stale_target",
      };
    }
  }

  let mapped: CandidateApproveResult;
  let auditCode: string | null;
  if (isReplace) {
    const replaceResult = await replaceMemory(runtime, {
      targetMemoryId: row.target_memory_id!,
      scope: row.scope,
      memoryType: row.memory_type,
      text,
      cwd: request.cwd,
      sourceSessionId: request.sourceSessionId ?? row.source_session_id,
      sourceRef: row.source_ref,
      idempotencyKey: `candidate:${row.id}`,
      expectedProjectIdentity: row.project_identity,
      expectedTargetTextHash: row.expected_target_text_hash!,
      owner: "candidate",
      signal: request.signal,
    });
    mapped = mapReplaceFailure(replaceResult);
    auditCode = getReplaceAuditCode(replaceResult);
  } else {
    const rememberResult = await remember(runtime, {
      scope: row.scope,
      memoryType: row.memory_type,
      text,
      cwd: request.cwd,
      sourceSessionId: request.sourceSessionId ?? row.source_session_id,
      sourceRef: row.source_ref,
      owner: "candidate",
      idempotencyKey: `candidate:${row.id}`,
      expectedProjectIdentity: row.project_identity,
      signal: request.signal,
    });
    mapped = mapRememberFailure(rememberResult, runtime);
    auditCode = getRememberAuditCode(rememberResult);
  }

  if (mapped.outcome === "approved") {
    if (beforeCandidateApprovalFinalizeForTests) {
      await beforeCandidateApprovalFinalizeForTests(runtime, mapped.memoryId);
    }
    const textHash = textHashOf(text);
    let approvedOk = false;
    runtime.db.transaction(() => {
      approvedOk = runtime.repos.candidates.tryMarkApproved(row.id, mapped.memoryId, {
        scope: row.scope,
        memoryType: row.memory_type,
        projectIdentity: row.project_identity,
        textHash,
        ...(isReplace ? { requiredMemoryId: row.target_memory_id! } : {}),
      });
      if (!approvedOk) {
        runtime.repos.candidates.markApprovalFailure(row.id, "failed", "approve_memory_incoherent");
        runtime.repos.audit.record({
          eventType: "candidate",
          candidateId: row.id,
          memoryId: mapped.memoryId,
          outcome: "approval_rejected",
          redactedCode: "approve_memory_incoherent",
        });
        return;
      }
      if (isReplace) {
        for (const conflict of runtime.repos.conflicts.listOpenForCandidate(row.id)) {
          runtime.repos.conflicts.resolve(conflict.id, "resolved_superseded");
        }
      }
      runtime.repos.audit.record({
        eventType: "candidate",
        candidateId: row.id,
        memoryId: mapped.memoryId,
        outcome: "approved",
      });
    });
    if (!approvedOk) {
      return {
        outcome: "rejected",
        reason: "mapped memory is not an active coherent match for this candidate",
        code: "approve_memory_incoherent",
      };
    }
    return runtime.repos.candidates.getById(row.id)?.state === "approved"
      ? mapped
      : {
          outcome: "retryable",
          reason: "candidate approval finalization raced with another window",
          code: "approval_race",
        };
  }

  const code = auditCode ?? "approval_failed";
  const nextState = mapped.outcome === "retryable" ? "reconciling" : "failed";
  runtime.db.transaction(() => {
    runtime.repos.candidates.markApprovalFailure(row.id, nextState, code);
    runtime.repos.audit.record({
      eventType: "candidate",
      candidateId: row.id,
      outcome: mapped.outcome === "retryable" ? "approval_retryable" : "approval_rejected",
      redactedCode: code,
    });
  });
  return mapped;
}

export type RejectCandidateResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_rejectable" | "already_decided" | "project_unavailable" | "project_mismatch";
    };

export function rejectCandidate(
  runtime: GlobalRuntime,
  candidateId: string,
  scopeContext: CandidateScopeContext,
): RejectCandidateResult {
  // Existence, then authorization, before any scoped sweep or state mutation.
  const initialRow = runtime.repos.candidates.getById(candidateId);
  if (!initialRow) return { ok: false, reason: "not_found" };
  if (initialRow.scope === "project") {
    if (!scopeContext.projectScopeEnabled) return { ok: false, reason: "project_unavailable" };
    if (scopeContext.projectIdentity !== initialRow.project_identity) return { ok: false, reason: "project_mismatch" };
  }

  // Scoped, not sweepExpired(): see approveCandidate for rationale.
  runtime.repos.candidates.sweepExpiredInScope(scopeContext);
  const row = runtime.repos.candidates.getById(candidateId);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.state === "approved" || row.state === "rejected" || row.state === "expired") {
    return { ok: false, reason: "already_decided" };
  }
  if (row.state !== "pending" && row.state !== "failed") {
    return { ok: false, reason: "not_rejectable" };
  }
  const ok = runtime.repos.candidates.tryMarkRejected(candidateId);
  if (!ok) {
    return { ok: false, reason: "already_decided" };
  }
  runtime.db.transaction(() => {
    for (const conflict of runtime.repos.conflicts.listOpenForCandidate(candidateId)) {
      runtime.repos.conflicts.resolve(conflict.id, "resolved_keep_existing");
    }
    runtime.repos.audit.record({ eventType: "candidate", candidateId, outcome: "rejected" });
  });
  return { ok: true };
}

export function candidateHasOpenConflict(runtime: GlobalRuntime, candidateId: string): boolean {
  return runtime.repos.conflicts.listOpenForCandidate(candidateId).length > 0;
}

export type CandidateDiagnosticCategory =
  | "success"
  | "not_found"
  | "already_decided"
  | "project_unavailable"
  | "project_mismatch"
  | "validation"
  | "retryable"
  | "unrecognized";

const PROJECT_MISMATCH_CODES = new Set(["project_identity_changed", "project_mismatch"]);
const RETRYABLE_CODES = new Set([
  "in_progress",
  "unknown",
  "candidate_changed",
  "edit_claim_lost",
  "mutation_busy",
  "approval_race",
]);

/**
 * Every rejection/retry code that `remember-service.ts`, `replace-service.ts`,
 * and this file are known to produce for a plain "candidate-side validation"
 * failure (as opposed to a project-scope, retry, or unrecognized situation).
 * This set only ever selects which *fixed, generic, localized* copy to show
 * (`candidates.validation_failed`) — the underlying `reason` string carried
 * on the result (which for some of these codes, e.g. `provider_write_failed`
 * and `bank_config_failed`, nests provider/network-derived detail) is never
 * rendered to the user. Any code not on any allowlist below fails closed
 * into "unrecognized" and is shown a generic safe message instead.
 */
const KNOWN_SAFE_REASON_CODES = new Set([
  "invalid_text",
  "invalid_scope_type",
  "invalid_source_session",
  "invalid_source_ref",
  "invalid_bank_id",
  "invalid_idempotency_key",
  "invalid_action_shape",
  "candidate_body_unavailable",
  "candidate_expired",
  "missing_target_snapshot",
  "stale_target",
  "stale_duplicate_target",
  "stale_duplicate",
  "stale_create_operation",
  "approve_memory_incoherent",
  "target_not_found",
  "target_wrong_scope",
  "target_wrong_type",
  "target_wrong_project",
  "target_wrong_bank",
  "target_not_active",
  "target_changed",
  "target_expired",
  "claim_failed",
  "mismatched_memory_row",
  "mismatched_operation",
  "mismatched_committed_operation",
  "provider_write_failed",
  "bank_config_failed",
]);

/**
 * Buckets an internal result/failure code into one safe, localizable
 * category. A code not on any allowlist below fails closed into
 * "unrecognized" rather than ever surfacing its raw reason text to the user.
 */
function classifyCandidateCode(
  code: string | null | undefined,
): Exclude<CandidateDiagnosticCategory, "success" | "not_found" | "already_decided"> {
  if (code === "project_unavailable") return "project_unavailable";
  if (code && PROJECT_MISMATCH_CODES.has(code)) return "project_mismatch";
  if (code && RETRYABLE_CODES.has(code)) return "retryable";
  if (code && KNOWN_SAFE_REASON_CODES.has(code)) return "validation";
  return "unrecognized";
}

function classifyApproveResult(result: CandidateApproveResult): CandidateDiagnosticCategory {
  switch (result.outcome) {
    case "approved":
      return "success";
    case "not_found":
      return "not_found";
    case "already_decided":
      return "already_decided";
    case "rejected":
    case "retryable":
      return classifyCandidateCode(result.code);
  }
}

function classifyRejectResult(result: RejectCandidateResult): CandidateDiagnosticCategory {
  if (result.ok) return "success";
  if (result.reason === "not_rejectable") return "validation";
  return result.reason;
}

/**
 * Shared safe, localized result renderer for approve/edit-approve outcomes.
 * Used by both the interactive TUI reviewer and the deterministic
 * `/memory candidates approve|edit-approve` commands so they never diverge.
 * Never surfaces raw provider bodies, headers, credentials, or codes.
 */
export function renderApproveOutcome(language: Language, result: CandidateApproveResult): string {
  switch (classifyApproveResult(result)) {
    case "success":
      return t(language, "candidates.approved", { id: (result as { memoryId: string }).memoryId });
    case "not_found":
      return t(language, "candidates.not_found");
    case "already_decided":
      return t(language, "candidates.claim_failed");
    case "project_unavailable":
      return t(language, "candidates.project_unavailable");
    case "project_mismatch":
      return t(language, "candidates.project_mismatch");
    case "retryable":
      return t(language, "candidates.retryable");
    case "validation":
      return t(language, "candidates.validation_failed");
    case "unrecognized":
      return t(language, "candidates.rejected_unspecified");
  }
}

/**
 * Shared safe, localized result renderer for reject outcomes. Used by both
 * the interactive TUI reviewer (single and batch reject) and
 * `/memory candidates reject`.
 */
export function renderRejectOutcome(language: Language, result: RejectCandidateResult): string {
  switch (classifyRejectResult(result)) {
    case "success":
      return t(language, "candidates.rejected");
    case "not_found":
      return t(language, "candidates.not_found");
    case "already_decided":
      return t(language, "candidates.claim_failed");
    case "project_unavailable":
      return t(language, "candidates.project_unavailable");
    case "project_mismatch":
      return t(language, "candidates.project_mismatch");
    case "validation":
    case "retryable":
      return t(language, "candidates.reject_not_rejectable");
    case "unrecognized":
      return t(language, "candidates.rejected_unspecified");
  }
}

/**
 * Localized, allowlisted explanation of a persisted `failure_code`. Never
 * displays the raw code or any provider-originated text.
 */
export function explainCandidateFailureCode(language: Language, failureCode: string | null): string | null {
  if (!failureCode) return null;
  switch (classifyCandidateCode(failureCode)) {
    case "project_unavailable":
      return t(language, "candidates.detail.failure.project_unavailable");
    case "project_mismatch":
      return t(language, "candidates.detail.failure.project_mismatch");
    case "retryable":
      return t(language, "candidates.detail.failure.retryable");
    case "validation":
      return t(language, "candidates.detail.failure.validation");
    case "unrecognized":
      return t(language, "candidates.detail.failure.unrecognized");
  }
}

export function renderCandidateSummary(language: Language, row: CandidateRow, hasOpenConflict = false): string {
  const text = row.text ?? t(language, "candidates.body_purged");
  const base = t(language, hasOpenConflict ? "candidates.item.conflict" : "candidates.item", {
    id: row.id,
    scope: row.scope,
    type: row.memory_type,
    text,
  });
  const details = [t(language, "candidates.detail.state", { state: row.state })];
  if (row.scope === "project" && row.project_identity) {
    details.push(t(language, "candidates.detail.project", { identity: row.project_identity }));
  }
  const failureExplanation = explainCandidateFailureCode(language, row.failure_code);
  if (failureExplanation) {
    details.push(t(language, "candidates.detail.failure", { explanation: failureExplanation }));
  }
  return `${base} | ${details.join(" | ")}`;
}

export function languageForRuntime(runtime: GlobalRuntime): Language {
  return normalizeLanguage(runtime.profile.language);
}

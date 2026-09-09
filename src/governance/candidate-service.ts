import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { CandidateRow } from "../db/types.js";
import { normalizeLanguage, t, type Language } from "../i18n/messages.js";
import { validateMemoryText } from "../security/filters.js";
import { createHash } from "node:crypto";
import { remember, type RememberResult, getRememberAuditCode } from "./remember-service.js";
import { replaceMemory, type ReplaceResult, getReplaceAuditCode } from "./replace-service.js";

export interface CandidateApproveRequest {
  candidateId: string;
  cwd: string;
  sourceSessionId: string | null;
  editedText?: string;
  signal?: AbortSignal | undefined;
}

export type CandidateApproveResult =
  | { outcome: "approved"; memoryId: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "retryable"; reason: string }
  | { outcome: "not_found" }
  | { outcome: "already_decided" };

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
export function listCandidates(runtime: GlobalRuntime, includeExpired: boolean): CandidateRow[] {
  runtime.repos.candidates.sweepExpired();
  const rows = runtime.repos.candidates.listReviewable(includeExpired);
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
        };
      }
      return { outcome: "approved", memoryId: result.memoryId };
    }
    case "rejected":
    case "conflict":
      return { outcome: "rejected", reason: result.reason };
    case "in_progress":
      return { outcome: "retryable", reason: "another write is already in progress" };
    case "unknown":
      return { outcome: "retryable", reason: result.reason };
  }
}

function mapReplaceFailure(result: ReplaceResult): CandidateApproveResult {
  switch (result.outcome) {
    case "replaced":
      return { outcome: "approved", memoryId: result.memoryId };
    case "rejected":
      return { outcome: "rejected", reason: result.reason };
    case "in_progress":
      return { outcome: "retryable", reason: "another write is already in progress" };
    case "unknown":
      return { outcome: "retryable", reason: result.reason };
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
  runtime.repos.candidates.sweepExpired();
  const row = runtime.repos.candidates.getById(request.candidateId);
  if (!row) return { outcome: "not_found" };
  if (row.state === "approved" || row.state === "rejected") return { outcome: "already_decided" };
  if (row.state === "expired") return { outcome: "rejected", reason: "candidate expired" };
  const shapeCheck = checkProposedActionShape(row);
  if (!shapeCheck.ok) {
    return { outcome: "rejected", reason: shapeCheck.reason };
  }

  const text = (request.editedText ?? row.text).trim();
  const textValidation = validateMemoryText(text);
  if (!textValidation.ok) {
    return { outcome: "rejected", reason: textValidation.reason ?? "invalid candidate text" };
  }

  if (!runtime.repos.candidates.tryClaimForApproval(row.id)) {
    return { outcome: "already_decided" };
  }

  const current = runtime.repos.candidates.getById(row.id);
  if (!current) return { outcome: "not_found" };
  if (current.scope !== row.scope || current.memory_type !== row.memory_type || current.project_identity !== row.project_identity) {
    runtime.repos.candidates.markApprovalFailure(row.id, "failed", "candidate_changed");
    return { outcome: "retryable", reason: "candidate changed before approval" };
  }
  if (request.editedText !== undefined) {
    if (!runtime.repos.candidates.updateText(row.id, text)) {
      runtime.repos.candidates.markApprovalFailure(row.id, "failed", "edit_claim_lost");
      return { outcome: "retryable", reason: "candidate edit lost its approval claim" };
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
    const textHash = createHash("sha256").update(text).digest("hex");
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
      };
    }
    return runtime.repos.candidates.getById(row.id)?.state === "approved"
      ? mapped
      : { outcome: "retryable", reason: "candidate approval finalization raced with another window" };
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

export function rejectCandidate(runtime: GlobalRuntime, candidateId: string): boolean {
  runtime.repos.candidates.sweepExpired();
  const ok = runtime.repos.candidates.tryMarkRejected(candidateId);
  if (ok) {
    runtime.db.transaction(() => {
      for (const conflict of runtime.repos.conflicts.listOpenForCandidate(candidateId)) {
        runtime.repos.conflicts.resolve(conflict.id, "resolved_keep_existing");
      }
      runtime.repos.audit.record({ eventType: "candidate", candidateId, outcome: "rejected" });
    });
  }
  return ok;
}

export function candidateHasOpenConflict(runtime: GlobalRuntime, candidateId: string): boolean {
  return runtime.repos.conflicts.listOpenForCandidate(candidateId).length > 0;
}

export function renderCandidateSummary(language: Language, row: CandidateRow, hasOpenConflict = false): string {
  return t(language, hasOpenConflict ? "candidates.item.conflict" : "candidates.item", {
    scope: row.scope,
    type: row.memory_type,
    text: row.text,
  });
}

export function languageForRuntime(runtime: GlobalRuntime): Language {
  return normalizeLanguage(runtime.profile.language);
}

import type { CandidateRow } from "../db/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { getGlobalRuntime } from "../runtime/global-runtime.js";
import {
  approveCandidate,
  authorizeCandidateForApproval,
  candidateHasOpenConflict,
  candidateVisibleInScope,
  explainCandidateFailureCode,
  listCandidates,
  rejectCandidate,
  renderApproveOutcome,
  renderCandidateSummary,
  renderRejectOutcome,
  toCandidateScopeContext,
  type CandidateScopeContext,
} from "../governance/candidate-service.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { t, type Language } from "../i18n/messages.js";

const KEY_DOWN = "\u001b[B";
const KEY_UP = "\u001b[A";
const KEY_ESCAPE = "\u001b";

export interface CandidateReviewerDeps {
  runtime: GlobalRuntime;
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui" | "signal">;
  language: Language;
  scopeContext: CandidateScopeContext;
}

export function createCandidateReviewer(deps: CandidateReviewerDeps) {
  let includeExpired = false;
  let selectedIndex = 0;
  // Mutable: re-resolved immediately before every mutating action (and on
  // every refresh) so a config/identity change while this reviewer stays
  // open cannot authorize a write with stale scope. `deps.scopeContext` only
  // seeds the very first render, before any input has been handled.
  let scopeContext: CandidateScopeContext = deps.scopeContext;
  let items = listCandidates(deps.runtime, includeExpired, scopeContext);

  const resolveCurrentScopeContext = async (): Promise<CandidateScopeContext> => {
    const bank = await resolveProjectBank(deps.ctx.cwd);
    return toCandidateScopeContext(bank);
  };

  const refresh = async () => {
    scopeContext = await resolveCurrentScopeContext();
    items = listCandidates(deps.runtime, includeExpired, scopeContext);
    if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);
  };
  const current = (): CandidateRow | null => items[selectedIndex] ?? null;

  return {
    getItems() {
      return items;
    },
    render(width: number): string[] {
      const lines = [
        "",
        t(deps.language, "candidates.title"),
        scopeContext.projectScopeEnabled
          ? t(deps.language, "candidates.view.profile_and_project", { identity: scopeContext.projectIdentity! })
          : t(deps.language, "candidates.view.profile_only"),
        includeExpired ? t(deps.language, "candidates.filter.expired") : t(deps.language, "candidates.filter.pending"),
        "",
      ];
      if (items.length === 0) {
        lines.push(t(deps.language, "candidates.none"));
      } else {
        for (let index = 0; index < items.length; index += 1) {
          const row = items[index]!;
          const hasOpenConflict = candidateHasOpenConflict(deps.runtime, row.id);
          lines.push(`${index === selectedIndex ? "> " : "  "}${renderCandidateSummary(deps.language, row, hasOpenConflict)}`.slice(0, width));
        }
        const row = current();
        if (row) {
          lines.push("");
          lines.push(`id: ${row.id}`.slice(0, width));
          lines.push(`state: ${row.state}`.slice(0, width));
          if (row.scope === "project" && row.project_identity) {
            lines.push(t(deps.language, "candidates.detail.project", { identity: row.project_identity }).slice(0, width));
          }
          const failureExplanation = explainCandidateFailureCode(deps.language, row.failure_code);
          if (failureExplanation) {
            lines.push(
              t(deps.language, "candidates.detail.failure", { explanation: failureExplanation }).slice(0, width),
            );
          }
          lines.push(
            (row.evidence_summary
              ? t(deps.language, "candidates.detail.evidence", { evidence: row.evidence_summary })
              : t(deps.language, "candidates.detail.no_evidence")).slice(0, width),
          );
        }
      }
      lines.push("");
      lines.push(t(deps.language, "candidates.controls").slice(0, width));
      return lines.map((line) => line.slice(0, width));
    },
    invalidate() {},
    async handleInput(data: string): Promise<"done" | void> {
      // Empty input (e.g. a spurious/no-op read) must never be treated as
      // Escape or any other key: KEY_ESCAPE is a distinct, non-empty value
      // from "" and is the only string that signals close alongside "q".
      if (data === "") {
        /* no-op */
      } else if (data === "j" || data === KEY_DOWN) {
        selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
      } else if (data === "k" || data === KEY_UP) {
        selectedIndex = Math.max(0, selectedIndex - 1);
      } else if (data === "\t") {
        includeExpired = !includeExpired;
      } else if (data === "q" || data === KEY_ESCAPE) {
        return "done";
      } else if (data === "r") {
        const row = current();
        if (row) {
          const freshScope = await resolveCurrentScopeContext();
          const rejected = rejectCandidate(deps.runtime, row.id, freshScope);
          deps.ctx.ui.notify(renderRejectOutcome(deps.language, rejected), rejected.ok ? "info" : "error");
        }
      } else if (data === "a") {
        const row = current();
        if (row) {
          // Authorize against the local, non-provider runtime before ever
          // constructing a provider-capable runtime: a wrong/disabled-
          // project request must trigger zero provider I/O, including the
          // health/version compatibility check that getGlobalRuntime()
          // performs as part of building that runtime.
          const freshScope = await resolveCurrentScopeContext();
          const authorization = authorizeCandidateForApproval(deps.runtime, row.id, freshScope);
          if (!authorization.ok) {
            deps.ctx.ui.notify(renderApproveOutcome(deps.language, authorization.result), "error");
            await refresh();
            return;
          }
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            deps.ctx.ui.notify(t(deps.language, "memory.status.unavailable"), "error");
            await refresh();
            return;
          }
          // Re-resolve again: the provider readiness check above may have
          // taken an arbitrary amount of time, during which scope could
          // change again. approveCandidate() re-checks authorization
          // against this scope as defense-in-depth.
          const confirmedScope = await resolveCurrentScopeContext();
          const result = await approveCandidate(providerRuntime.runtime, {
            candidateId: row.id,
            cwd: deps.ctx.cwd,
            scopeContext: confirmedScope,
            sourceSessionId: deps.ctx.sessionManager.getSessionId(),
            signal: deps.ctx.signal,
          });
          deps.ctx.ui.notify(
            renderApproveOutcome(deps.language, result),
            result.outcome === "approved" ? "info" : "error",
          );
        }
      } else if (data === "e") {
        const row = current();
        if (row && row.text != null) {
          // Re-resolve before even opening the edit prompt: never edit or
          // display the body of a candidate that is no longer in the
          // caller's current project scope.
          const preEditScope = await resolveCurrentScopeContext();
          if (!candidateVisibleInScope(row, preEditScope)) {
            deps.ctx.ui.notify(
              t(deps.language, preEditScope.projectScopeEnabled ? "candidates.project_mismatch" : "candidates.project_unavailable"),
              "error",
            );
            await refresh();
            return;
          }
          const edited = await deps.ctx.ui.input(
            t(deps.language, "candidates.edit_title"),
            row.text,
          );
          if (typeof edited === "string" && edited.trim()) {
            // Re-resolve and authorize against the local runtime again: the
            // input prompt above may have taken an arbitrary amount of
            // time, during which scope could change. Authorize before ever
            // constructing a provider-capable runtime, same as "a" above.
            const freshScope = await resolveCurrentScopeContext();
            const authorization = authorizeCandidateForApproval(deps.runtime, row.id, freshScope);
            if (!authorization.ok) {
              deps.ctx.ui.notify(renderApproveOutcome(deps.language, authorization.result), "error");
              await refresh();
              return;
            }
            const providerRuntime = await getGlobalRuntime();
            if (!providerRuntime.ok) {
              deps.ctx.ui.notify(t(deps.language, "memory.status.unavailable"), "error");
              await refresh();
              return;
            }
            // Re-resolve once more: the provider readiness check above may
            // have taken an arbitrary amount of time.
            const confirmedScope = await resolveCurrentScopeContext();
            const result = await approveCandidate(providerRuntime.runtime, {
              candidateId: row.id,
              cwd: deps.ctx.cwd,
              scopeContext: confirmedScope,
              sourceSessionId: deps.ctx.sessionManager.getSessionId(),
              editedText: edited,
              signal: deps.ctx.signal,
            });
            deps.ctx.ui.notify(
              renderApproveOutcome(deps.language, result),
              result.outcome === "approved" ? "info" : "error",
            );
          }
        }
      } else if (data === "x") {
        const freshScope = await resolveCurrentScopeContext();
        const batch = items.filter(
          (row) =>
            candidateVisibleInScope(row, freshScope) &&
            (row.proposed_action === "ignore" || (row.text != null && row.text.length < 24)),
        );
        if (batch.length > 0) {
          const confirmed = await deps.ctx.ui.confirm(
            t(deps.language, "candidates.batch_title"),
            t(deps.language, "candidates.batch_body", { count: batch.length }),
          );
          if (confirmed) {
            // Re-resolve once more: the confirm prompt above may have taken
            // an arbitrary amount of time.
            const confirmScope = await resolveCurrentScopeContext();
            let rejectedCount = 0;
            for (const row of batch) {
              const result = rejectCandidate(deps.runtime, row.id, confirmScope);
              if (result.ok) rejectedCount += 1;
            }
            deps.ctx.ui.notify(
              rejectedCount > 0
                ? t(deps.language, "candidates.batch_done", { count: rejectedCount })
                : t(deps.language, "candidates.reject_not_rejectable"),
              rejectedCount > 0 ? "info" : "error",
            );
          }
        }
      }
      await refresh();
    },
  };
}

import type { CandidateRow } from "../db/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { getGlobalRuntime } from "../runtime/global-runtime.js";
import {
  approveCandidate,
  candidateHasOpenConflict,
  listCandidates,
  rejectCandidate,
  renderCandidateSummary,
} from "../governance/candidate-service.js";
import { t, type Language } from "../i18n/messages.js";

export interface CandidateReviewerDeps {
  runtime: GlobalRuntime;
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui" | "signal">;
  language: Language;
}

export function createCandidateReviewer(deps: CandidateReviewerDeps) {
  let includeExpired = false;
  let selectedIndex = 0;
  let items = listCandidates(deps.runtime, includeExpired);

  const refresh = () => {
    items = listCandidates(deps.runtime, includeExpired);
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
      if (data === "j" || data === "\u001b[B") selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
      else if (data === "k" || data === "\u001b[A") selectedIndex = Math.max(0, selectedIndex - 1);
      else if (data === "\t") includeExpired = !includeExpired;
      else if (data === "q" || data === "\u001b") return "done";
      else if (data === "r") {
        const row = current();
        if (row && rejectCandidate(deps.runtime, row.id)) {
          deps.ctx.ui.notify(t(deps.language, "candidates.rejected"), "info");
        }
      } else if (data === "a") {
        const row = current();
        if (row) {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            deps.ctx.ui.notify(t(deps.language, "memory.status.unavailable"), "error");
            refresh();
            return;
          }
          const result = await approveCandidate(providerRuntime.runtime, {
            candidateId: row.id,
            cwd: deps.ctx.cwd,
            sourceSessionId: deps.ctx.sessionManager.getSessionId(),
            signal: deps.ctx.signal,
          });
          deps.ctx.ui.notify(
            result.outcome === "approved" ? t(deps.language, "candidates.approved") : t(deps.language, "candidates.action_failed"),
            result.outcome === "approved" ? "info" : "error",
          );
        }
      } else if (data === "e") {
        const row = current();
        if (row) {
          const edited = await deps.ctx.ui.input(
            t(deps.language, "candidates.edit_title"),
            row.text,
          );
          if (typeof edited === "string" && edited.trim()) {
            const providerRuntime = await getGlobalRuntime();
            if (!providerRuntime.ok) {
              deps.ctx.ui.notify(t(deps.language, "memory.status.unavailable"), "error");
              refresh();
              return;
            }
            const result = await approveCandidate(providerRuntime.runtime, {
              candidateId: row.id,
              cwd: deps.ctx.cwd,
              sourceSessionId: deps.ctx.sessionManager.getSessionId(),
              editedText: edited,
              signal: deps.ctx.signal,
            });
            deps.ctx.ui.notify(
              result.outcome === "approved" ? t(deps.language, "candidates.approved") : t(deps.language, "candidates.action_failed"),
              result.outcome === "approved" ? "info" : "error",
            );
          }
        }
      } else if (data === "x") {
        const batch = items.filter((row) => row.proposed_action === "ignore" || row.text.length < 24);
        if (batch.length > 0) {
          const confirmed = await deps.ctx.ui.confirm(
            t(deps.language, "candidates.batch_title"),
            t(deps.language, "candidates.batch_body", { count: batch.length }),
          );
          if (confirmed) {
            for (const row of batch) rejectCandidate(deps.runtime, row.id);
            deps.ctx.ui.notify(t(deps.language, "candidates.batch_done"), "info");
          }
        }
      }
      refresh();
    },
  };
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getGlobalRuntime, getLocalRuntime, peekCachedLocalRuntime } from "../runtime/global-runtime.js";
import { appendSessionMemoryState } from "../runtime/session-persistence.js";
import { getSessionState, setSessionMemoryOff } from "../runtime/session-runtime.js";
import { normalizeLanguage, t, type Language } from "../i18n/messages.js";
import {
  approveCandidate,
  authorizeCandidateForApproval,
  candidateHasOpenConflict,
  languageForRuntime,
  listCandidates,
  rejectCandidate,
  renderApproveOutcome,
  renderCandidateSummary,
  renderRejectOutcome,
  toCandidateScopeContext,
} from "../governance/candidate-service.js";
import { remember, textHashOf } from "../governance/remember-service.js";
import { forgetMemory } from "../governance/forget-service.js";
import { reflectMemory } from "../governance/reflect-service.js";
import { replaceMemory } from "../governance/replace-service.js";
import {
  listMemories,
  renderMemoryListItem,
  renderMemoryShow,
  showMemory,
} from "../governance/discovery-service.js";
import {
  getCleanupStatus,
  renderCleanupResult,
  renderCleanupStatus,
  runMaintenancePass,
} from "../governance/cleanup-service.js";
import type { MemoryType, Scope } from "../db/types.js";
import { parseMemoryCommand } from "./memory-command-parser.js";
import { createCandidateReviewer } from "../ui/candidate-reviewer.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { mutationNowMs } from "../governance/mutation-clock.js";

function rememberOutcomeMessage(
  language: Language,
  result: Awaited<ReturnType<typeof remember>>,
  parsed: { scope: Scope; memoryType: MemoryType; content: string },
): string {
  switch (result.outcome) {
    case "written":
      return t(language, "remember.written", {
        scope: parsed.scope,
        type: parsed.memoryType,
        text: parsed.content.trim(),
        id: result.memoryId,
      });
    case "duplicate":
      return t(language, "remember.duplicate", { text: parsed.content.trim(), id: result.memoryId });
    case "rejected":
    case "conflict":
    case "unknown":
      return result.reason;
    case "in_progress":
      return "another remember operation is already in progress";
  }
}

function updateOutcomeMessage(
  language: Language,
  result: Awaited<ReturnType<typeof replaceMemory>>,
  id: string,
): string {
  switch (result.outcome) {
    case "replaced":
      return t(language, "update.written", { id });
    case "rejected":
    case "unknown":
      return t(language, "update.rejected", { reason: result.reason });
    case "in_progress":
      return t(language, "update.rejected", { reason: "another update operation is already in progress" });
  }
}

function helpText(language: Language): string {
  return t(language, "memory.help");
}

function resolveHelpLanguage(): Language {
  try {
    const cached = peekCachedLocalRuntime();
    if (cached?.ok) {
      return normalizeLanguage(cached.runtime.profile.language);
    }
  } catch {}
  return "en";
}

async function openCandidatesUi(ctx: ExtensionContext): Promise<void> {
  const runtimeResult = await getLocalRuntime();
  if (!runtimeResult.ok) {
    return;
  }
  const runtime = runtimeResult.runtime;
  const language = languageForRuntime(runtime);
  const projectBank = await resolveProjectBank(ctx.cwd);
  const scopeContext = toCandidateScopeContext(projectBank);
  await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    const reviewer = createCandidateReviewer({ runtime, ctx, language, scopeContext });
    return {
      render: (width: number) => reviewer.render(width),
      invalidate: () => reviewer.invalidate(),
      handleInput: async (data: string) => {
        const result = await reviewer.handleInput(data);
        tui.requestRender();
        if (result === "done") done();
      },
    };
  });
}

export function registerMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("memory", {
    description: "Governed memory commands",
    handler: async (args, ctx) => {
      const parsed = parseMemoryCommand(args);
      if (ctx.mode !== "tui") return;
      const fallbackLanguage: Language = "en";
      if (!parsed || parsed.kind === "help") {
        try {
          ctx.ui.notify(helpText(resolveHelpLanguage()), parsed ? "info" : "error");
        } catch {}
        return;
      }
      if (parsed.kind === "on" || parsed.kind === "off") {
        try {
          setSessionMemoryOff(ctx.sessionManager.getSessionId(), parsed.kind === "off");
          appendSessionMemoryState(pi, parsed.kind === "off");
          ctx.ui.notify(t(fallbackLanguage, parsed.kind === "off" ? "memory.off" : "memory.on"), "info");
        } catch {}
        return;
      }
      let localRuntimeResult;
      try {
        localRuntimeResult = await getLocalRuntime();
      } catch {
        return;
      }
      const language =
        localRuntimeResult && localRuntimeResult.ok
          ? normalizeLanguage(localRuntimeResult.runtime.profile.language)
          : fallbackLanguage;
      if (!localRuntimeResult || !localRuntimeResult.ok) {
        if (parsed.kind === "status") {
          try {
            const session = getSessionState(ctx.sessionManager.getSessionId());
            ctx.ui.notify(
              [
                t(language, "memory.status.unavailable"),
                session.memoryOff ? t(language, "memory.status.session.off") : t(language, "memory.status.session.on"),
              ].join(" "),
              "info",
            );
          } catch {}
        }
        return;
      }
      const localRuntime = localRuntimeResult.runtime;
      try {
        switch (parsed.kind) {
        case "status": {
          const session = getSessionState(ctx.sessionManager.getSessionId());
          let projectLine = t(language, "memory.status.project.disabled", {
            reason: t(language, "memory.status.project.unavailable"),
          });
          try {
            const project = await resolveProjectBank(ctx.cwd);
            projectLine = project.enabled
              ? t(language, "memory.status.project.enabled", { identity: project.identity })
              : t(language, "memory.status.project.disabled", { reason: project.reason });
          } catch {
            projectLine = t(language, "memory.status.project.disabled", {
              reason: t(language, "memory.status.project.unavailable"),
            });
          }
          const lines = [
            t(language, "memory.status.enabled"),
            session.memoryOff ? t(language, "memory.status.session.off") : t(language, "memory.status.session.on"),
            projectLine,
          ];
          try {
            const providerReady = await getGlobalRuntime();
            if (!providerReady.ok) {
              lines.unshift(t(language, "memory.status.unavailable"));
            }
          } catch {
            lines.unshift(t(language, "memory.status.unavailable"));
          }
          ctx.ui.notify(lines.join(" "), "info");
          return;
        }
        case "last": {
          const last = getSessionState(ctx.sessionManager.getSessionId()).lastRecall;
          if (!last) return void ctx.ui.notify(t(language, "memory.last.none"), "info");
          const text = [
            t(language, "memory.last.header", { count: last.items.length, when: last.injectedAt }),
            ...last.items.map((item) =>
              item.readOnlyShared || !item.memoryId
                ? t(language, "memory.last.item.shared", {
                    scope: item.scope,
                    type: item.memoryType,
                    text: item.text,
                  })
                : t(language, "memory.last.item", {
                    id: item.memoryId,
                    scope: item.scope,
                    type: item.memoryType,
                    text: item.text,
                  }),
            ),
          ].join("\n");
          ctx.ui.notify(text, "info");
          return;
        }
        case "list": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          let projectIdentity: string | null = null;
          try {
            const project = await resolveProjectBank(ctx.cwd);
            projectIdentity = project.enabled ? project.identity : null;
          } catch {
            projectIdentity = null;
          }
          if (parsed.filter === "project" && !projectIdentity) {
            ctx.ui.notify(t(language, "memory.list.none"), "info");
            return;
          }
          const items = await listMemories(providerRuntime.runtime, {
            filter: parsed.filter,
            projectIdentity,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          ctx.ui.notify(
            items.length
              ? [t(language, "memory.list.header", { count: items.length }), ...items.map(renderMemoryListItem)].join(
                  "\n",
                )
              : t(language, "memory.list.none"),
            "info",
          );
          return;
        }
        case "show": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const projectBank = await resolveProjectBank(ctx.cwd);
          const shown = await showMemory(providerRuntime.runtime, parsed.id, {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            expectedProjectIdentity: projectBank.enabled ? projectBank.identity : null,
            projectScopeEnabled: projectBank.enabled,
          });
          if ("outcome" in shown && shown.outcome === "not_found") {
            ctx.ui.notify(t(language, "memory.show.not_found", { id: parsed.id }), "error");
            return;
          }
          if ("outcome" in shown && shown.outcome === "rejected") {
            ctx.ui.notify(shown.reason, "error");
            return;
          }
          ctx.ui.notify(renderMemoryShow(shown as Exclude<typeof shown, { outcome: string }>), "info");
          return;
        }
        case "cleanup-status": {
          const status = getCleanupStatus(localRuntime);
          ctx.ui.notify(
            `${t(language, "memory.cleanup.status.header")}\n${renderCleanupStatus(status)}`,
            "info",
          );
          return;
        }
        case "cleanup-now": {
          const confirmed = await ctx.ui.confirm(
            t(language, "memory.cleanup.confirm_title"),
            t(language, "memory.cleanup.confirm_body"),
          );
          if (!confirmed) {
            ctx.ui.notify(t(language, "memory.cleanup.skipped", { reason: "cancelled" }), "info");
            return;
          }
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const result = await runMaintenancePass(providerRuntime.runtime, {
            force: true,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (!result.ran) {
            ctx.ui.notify(t(language, "memory.cleanup.skipped", { reason: result.reason ?? "unknown" }), "error");
            return;
          }
          if (result.incomplete) {
            ctx.ui.notify(
              t(language, "memory.cleanup.incomplete", {
                reason: result.reason ?? result.incomplete,
                detail: renderCleanupResult(result.counts!),
              }),
              "error",
            );
            return;
          }
          ctx.ui.notify(
            t(language, "memory.cleanup.done", { detail: renderCleanupResult(result.counts!) }),
            "info",
          );
          return;
        }
        case "language":
          localRuntime.repos.profiles.setLanguage(parsed.language);
          localRuntime.profile.language = parsed.language;
          ctx.ui.notify(t(parsed.language, "language.set", { language: parsed.language }), "info");
          return;
        case "candidates":
          await openCandidatesUi(ctx);
          return;
        case "candidates-list": {
          const projectBank = await resolveProjectBank(ctx.cwd);
          const scopeContext = toCandidateScopeContext(projectBank);
          const rows = listCandidates(localRuntime, false, scopeContext);
          ctx.ui.notify(
            rows.length
              ? rows
                  .map((row) => renderCandidateSummary(language, row, candidateHasOpenConflict(localRuntime, row.id)))
                  .join("\n")
              : t(language, "candidates.none"),
            "info",
          );
          return;
        }
        case "candidates-reject":
          {
            const projectBank = await resolveProjectBank(ctx.cwd);
            const scopeContext = toCandidateScopeContext(projectBank);
            const rejected = rejectCandidate(localRuntime, parsed.id, scopeContext);
            ctx.ui.notify(renderRejectOutcome(language, rejected), rejected.ok ? "info" : "error");
          }
          return;
        case "remember": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const runtime = providerRuntime.runtime;
          const result = await remember(runtime, {
            scope: parsed.scope,
            memoryType: parsed.memoryType,
            text: parsed.content,
            cwd: ctx.cwd,
            sourceSessionId: ctx.sessionManager.getSessionId(),
            sourceRef: "command:/memory remember",
            owner: "command",
            signal: ctx.signal,
          });
          const message = rememberOutcomeMessage(language, result, parsed);
          ctx.ui.notify(message, result.outcome === "written" || result.outcome === "duplicate" ? "info" : "error");
          return;
        }
        case "update": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const runtime = providerRuntime.runtime;
          const target = runtime.repos.memories.getById(parsed.id);
          if (!target || target.status !== "active") {
            ctx.ui.notify(
              t(language, "update.rejected", {
                reason: target ? `target memory is not active (status: ${target.status})` : "target memory was not found",
              }),
              "error",
            );
            return;
          }
          if (target.expires_at && Date.parse(target.expires_at) <= mutationNowMs()) {
            ctx.ui.notify(
              t(language, "update.rejected", { reason: "target memory is past its expiry and cannot be updated" }),
              "error",
            );
            return;
          }
          const result = await replaceMemory(runtime, {
            targetMemoryId: target.id,
            scope: target.scope,
            memoryType: target.memory_type,
            text: parsed.content,
            cwd: ctx.cwd,
            sourceSessionId: ctx.sessionManager.getSessionId(),
            sourceRef: "command:/memory update",
            idempotencyKey: `command:update:${target.id}:${target.text_hash}:${textHashOf(parsed.content)}`,
            expectedProjectIdentity: target.project_identity,
            expectedTargetTextHash: target.text_hash,
            owner: "command",
            signal: ctx.signal,
          });
          ctx.ui.notify(
            updateOutcomeMessage(language, result, target.id),
            result.outcome === "replaced" ? "info" : "error",
          );
          return;
        }
        case "candidates-approve": {
          const projectBank = await resolveProjectBank(ctx.cwd);
          const scopeContext = toCandidateScopeContext(projectBank);
          // Authorize against the local, non-provider runtime before ever
          // constructing a provider-capable runtime: a wrong/disabled-
          // project direct-ID command must trigger zero provider I/O,
          // including the health/version compatibility check that
          // getGlobalRuntime() performs as part of building that runtime.
          const authorization = authorizeCandidateForApproval(localRuntime, parsed.id, scopeContext);
          if (!authorization.ok) {
            ctx.ui.notify(renderApproveOutcome(language, authorization.result), "error");
            return;
          }
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          // Re-resolve once more: the provider readiness check above may
          // have taken an arbitrary amount of time. approveCandidate()
          // re-checks authorization against this scope as defense-in-depth.
          const freshProjectBank = await resolveProjectBank(ctx.cwd);
          const result = await approveCandidate(providerRuntime.runtime, {
            candidateId: parsed.id,
            cwd: ctx.cwd,
            scopeContext: toCandidateScopeContext(freshProjectBank),
            sourceSessionId: ctx.sessionManager.getSessionId(),
            signal: ctx.signal,
          });
          ctx.ui.notify(renderApproveOutcome(language, result), result.outcome === "approved" ? "info" : "error");
          return;
        }
        case "candidates-edit-approve": {
          const projectBank = await resolveProjectBank(ctx.cwd);
          const scopeContext = toCandidateScopeContext(projectBank);
          // Authorize before ever constructing a provider-capable runtime,
          // same rationale as candidates-approve above.
          const authorization = authorizeCandidateForApproval(localRuntime, parsed.id, scopeContext);
          if (!authorization.ok) {
            ctx.ui.notify(renderApproveOutcome(language, authorization.result), "error");
            return;
          }
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          // Re-resolve once more: the provider readiness check above may
          // have taken an arbitrary amount of time.
          const freshProjectBank = await resolveProjectBank(ctx.cwd);
          const result = await approveCandidate(providerRuntime.runtime, {
            candidateId: parsed.id,
            cwd: ctx.cwd,
            scopeContext: toCandidateScopeContext(freshProjectBank),
            sourceSessionId: ctx.sessionManager.getSessionId(),
            editedText: parsed.content,
            signal: ctx.signal,
          });
          ctx.ui.notify(renderApproveOutcome(language, result), result.outcome === "approved" ? "info" : "error");
          return;
        }
        case "forget": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const projectBank = await resolveProjectBank(ctx.cwd);
          const result = await forgetMemory(providerRuntime.runtime, parsed.id, {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            projectIdentity: projectBank.enabled ? projectBank.identity : null,
            projectScopeEnabled: projectBank.enabled,
          });
          ctx.ui.notify(
            result.outcome === "forgotten" ? t(language, "forget.done", { id: parsed.id }) : t(language, "forget.failed", { id: parsed.id, reason: result.reason }),
            result.outcome === "forgotten" ? "info" : "error",
          );
          return;
        }
        case "reflect": {
          const providerRuntime = await getGlobalRuntime();
          if (!providerRuntime.ok) {
            ctx.ui.notify(t(language, "memory.status.unavailable"), "error");
            return;
          }
          const result = await reflectMemory(providerRuntime.runtime, ctx, parsed.scope, parsed.query);
          if (result.outcome === "ok") ctx.ui.notify(t(language, "reflect.result", { text: result.text }), "info");
          else if (result.outcome === "rejected") ctx.ui.notify(result.reason, "error");
          return;
        }
        }
      } catch {
        try {
          ctx.ui.notify(t(language, "memory.unexpected_error"), "error");
        } catch {}
      }
    },
  });
}

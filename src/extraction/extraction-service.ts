/**
 * `agent_end` + `agent_settled` extraction pipeline (product-requirements.md
 * "Extraction", architecture.md "Extraction pipeline").
 *
 * `agent_end` carries `messages`; `agent_settled` carries none and fires only
 * once no automatic retry, compaction, or queued continuation is pending
 * (HANDOVER.md). This module caches `agent_end`'s messages per session and
 * runs the independent extraction call when `agent_settled` fires, using a
 * fresh isolated `Context` (no tools, own routing/session ID, own bounded
 * timeout) via `ctx.modelRegistry.complete()` — never the main agent context.
 *
 * Extraction only ever creates SQLite `candidates` rows. It never writes to
 * Hindsight directly, never falls back to another provider on failure, and
 * creates zero candidates on any malformed/oversized/invalid output.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentEndEvent, AgentSettledEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { getGlobalRuntime } from "../runtime/global-runtime.js";
import {
  claimPendingExtractionSnapshot,
  clearPendingExtractionSnapshot,
  enqueueSessionExtraction,
  getSessionState,
  peekSessionState,
  isSessionStateCurrent,
  setPendingExtractionSnapshot,
} from "../runtime/session-runtime.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { selectExtractionMaterial } from "./material.js";
import { parseExtractionResponse } from "./response-parser.js";
import { scanForSensitiveContent, looksLikeBulkContent, truncateUnicode } from "../security/filters.js";
import { t, normalizeLanguage } from "../i18n/messages.js";

const MIN_MATERIAL_CHARS = 40;
const MAX_MATERIAL_CHARS = 4000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const EXTRACTION_MAX_TOKENS = 800;
const SOURCE_REF_MAX_LENGTH = 64;

export function handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const sessionId = ctx.sessionManager.getSessionId();
  const session = getSessionState(sessionId);
  if (session.memoryOff) return;
  const material = selectExtractionMaterial(event.messages);
  if (material.trim().length < MIN_MATERIAL_CHARS) {
    clearPendingExtractionSnapshot(sessionId);
    return;
  }
  if (scanForSensitiveContent(material).sensitive || looksLikeBulkContent(material)) {
    clearPendingExtractionSnapshot(sessionId);
    return;
  }
  setPendingExtractionSnapshot(sessionId, truncateUnicode(material, MAX_MATERIAL_CHARS));
}

export async function handleAgentSettled(
  _event: AgentSettledEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  if (ctx.signal?.aborted) return;
  const sessionId = ctx.sessionManager.getSessionId();
  const session = peekSessionState(sessionId);
  if (!session || !isSessionStateCurrent(sessionId, session)) return;
  const snapshot = claimPendingExtractionSnapshot(sessionId);
  if (!snapshot || session.memoryOff) return;
  const model = ctx.model;
  if (!model) return;
  await enqueueSessionExtraction(sessionId, async () => {
    if (ctx.signal?.aborted || !isSessionStateCurrent(sessionId, session) || session.memoryOff) return;
    const material = snapshot.material;
    if (material.trim().length < MIN_MATERIAL_CHARS) return;

    const runtimeResult = await getGlobalRuntime();
    if (!runtimeResult.ok || ctx.signal?.aborted || !isSessionStateCurrent(sessionId, session) || session.memoryOff) return;
    const { runtime } = runtimeResult;
    runtime.repos.candidates.sweepExpired();

    const projectBank = await resolveProjectBank(ctx.cwd);
    if (ctx.signal?.aborted || !isSessionStateCurrent(sessionId, session)) return;
    const controller = new AbortController();
    session.extractionController = controller;
    const timeoutSignal = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS);
    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal, timeoutSignal])
      : AbortSignal.any([controller.signal, timeoutSignal]);

    try {
      const context: Context = {
        systemPrompt: buildExtractionSystemPrompt(projectBank.enabled),
        messages: [
          { role: "user", content: truncateUnicode(material, MAX_MATERIAL_CHARS), timestamp: Date.now() },
        ],
      };

      let response: AssistantMessage;
      try {
        response = await ctx.modelRegistry.complete(model, context, {
          signal,
          timeoutMs: EXTRACTION_TIMEOUT_MS,
          sessionId: `memory-extract:${randomUUID()}`,
          maxTokens: EXTRACTION_MAX_TOKENS,
          maxRetries: 0,
        });
      } catch {
        if (signal.aborted || !isSessionStateCurrent(sessionId, session)) return;
        runtime.repos.usage.record({
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          outcome: "call_failed",
        });
        runtime.repos.audit.record({ eventType: "extraction", outcome: "call_failed" });
        return;
      }

      if (signal.aborted || !isSessionStateCurrent(sessionId, session)) return;
      runtime.repos.usage.record({
        modelId: `${response.provider}/${response.model}`,
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        costUsd: response.usage.cost.total,
        outcome: response.stopReason,
      });
      if (response.stopReason !== "stop") {
        runtime.repos.audit.record({ eventType: "extraction", outcome: `stop_reason:${response.stopReason}` });
        return;
      }
      if (response.content.some((part) => part.type !== "text")) {
        runtime.repos.audit.record({ eventType: "extraction", outcome: "invalid_response", redactedCode: "non_text_part" });
        return;
      }

      const text = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("");
      const parsed = parseExtractionResponse(text, { projectEnabled: projectBank.enabled });
      if (!parsed.ok) {
        runtime.repos.audit.record({ eventType: "extraction", outcome: "invalid_response", redactedCode: "parse_error" });
        return;
      }

      const sourceRef = truncateUnicode(`turn:${snapshot.turnIndex}`, SOURCE_REF_MAX_LENGTH);
      const seen = new Set<string>();
      const rows = parsed.candidates.filter((candidate) => {
        const projectIdentity = candidate.scope === "project" && projectBank.enabled ? projectBank.identity : null;
        const key = `${candidate.scope}\u0000${projectIdentity ?? ""}\u0000${candidate.memoryType}\u0000${normalizedCandidateHash(candidate.text)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        if (runtime.repos.memories.findActiveByTextHash(candidate.scope, projectIdentity, candidate.memoryType, normalizedCandidateHash(candidate.text))) {
          return false;
        }
        return !runtime.repos
          .candidates
          .listPending()
          .some(
            (existing) =>
              existing.scope === candidate.scope &&
              existing.memory_type === candidate.memoryType &&
              existing.project_identity === projectIdentity &&
              normalizedCandidateHash(existing.text) === normalizedCandidateHash(candidate.text),
          );
      });

      if (rows.length === 0) {
        runtime.repos.audit.record({ eventType: "extraction", outcome: "no_candidates" });
        return;
      }

      if (signal.aborted || !isSessionStateCurrent(sessionId, session)) return;

      runtime.db.transaction(() => {
        for (const candidate of rows) {
          const projectIdentity = candidate.scope === "project" && projectBank.enabled ? projectBank.identity : null;
          const row = runtime.repos.candidates.create({
            scope: candidate.scope,
            memoryType: candidate.memoryType,
            text: candidate.text,
            evidenceSummary: candidate.evidence,
            sourceSessionId: sessionId,
            sourceRef,
            proposedAction: "create",
            targetMemoryId: null,
            projectIdentity,
          });
          runtime.repos.audit.record({ eventType: "extraction", candidateId: row.id, outcome: "candidate_created" });
        }
      });

      if (!signal.aborted && isSessionStateCurrent(sessionId, session)) {
        try {
          const language = normalizeLanguage(runtime.profile.language);
          ctx.ui.notify(t(language, "extract.done", { count: rows.length }), "info");
        } catch {
          // Notification failures must not affect persistence.
        }
      }
    } finally {
      if (session.extractionController === controller) {
        session.extractionController = null;
      }
      controller.abort();
    }
  });
}

function normalizedCandidateHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function buildExtractionSystemPrompt(projectEnabled: boolean): string {
  return [
    "You extract durable, worth-remembering facts from an excerpt of a coding assistant conversation.",
    "Output STRICTLY one JSON object and nothing else: no markdown, no code fences, no prose before or after it.",
    'Shape: {"candidates": [{"scope": "profile" | "project", "memory_type": "...", "text": "...", "evidence": "..."}]}',
    'Return {"candidates": []} if nothing in the excerpt is durably worth remembering.',
    "For scope \"profile\", memory_type must be one of: preference, habit — long-lived facts about the user that hold across all projects.",
    projectEnabled
      ? "For scope \"project\", memory_type must be one of: project_fact, decision, lesson, task_state, inference — facts specific to this repository."
      : 'Do not propose scope "project"; project memory is disabled for this repository.',
    "text must be a single, self-contained, atomic statement, under 1000 characters.",
    "Never include secrets, credentials, tokens, passwords, or full file/log contents in text or evidence.",
    "evidence is an optional short paraphrase (under 500 characters) of why this was extracted, not a verbatim quote of raw material.",
    "Do not invent facts not present in the excerpt. When in doubt, omit the candidate.",
  ].join("\n");
}

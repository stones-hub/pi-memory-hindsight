/**
 * `before_agent_start` recall pipeline (product-requirements.md "Recall",
 * architecture.md "Recall pipeline").
 *
 * Fires at most once per user turn (this event itself is per-agent-loop-start,
 * not per internal tool-loop step) and only in `ctx.mode === "tui"`. Recalled
 * text is appended to the turn-scoped system prompt only — never returned as
 * a persisted `message`, per HANDOVER.md's Session-persistence constraint.
 *
 * Every recalled item is cross-checked against the local `memories` table
 * (via `metadata.memory_id`) and dropped unless a locally governed, active
 * record confirms it — this is what stops untrusted/stale/deleted Hindsight
 * content from ever reaching the model as "memory".
 */

import { createHash } from "node:crypto";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getGlobalRuntime, type GlobalRuntime } from "../runtime/global-runtime.js";
import { isSessionStateCurrent, tryClaimRecallInput } from "../runtime/session-runtime.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { capRenderedRecallItems } from "./token-budget.js";
import { normalizeLanguage, t } from "../i18n/messages.js";
import type { MemoryRow, MemoryType, Scope, VerificationState } from "../db/types.js";
import type { RecallResultItem } from "../provider/types.js";
import { buildCurrentOwnedDocumentId, buildLegacyOwnedDocumentId, isLegacyOwnedDocumentRow, rowOwnsDocumentId, validateDocumentId, validateLegacyRetainMetadata, validateRetainMetadata } from "../provider/validation.js";
import { looksLikeBulkContent, scanForSensitiveContent, truncateUnicode, validateMemoryText, unicodeLength } from "../security/filters.js";
import { projectBankId } from "../identity/bank-id.js";

const RECALL_TIMEOUT_MS = 4000;
const DIAGNOSTIC_TEXT_PREVIEW_CHARS = 160;
const MAX_QUERY_CHARS = 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ReconciledItem {
  scope: Scope;
  memoryType: MemoryType;
  text: string;
  verificationState: VerificationState;
  memoryId: string | null;
  readOnlyShared: boolean;
}

const RECALL_MAX_TOKENS_PER_BANK = 2000;

interface RecallBankContext {
  scope: Scope;
  bankId: string;
  projectIdentity: string | null;
  currentProjectIdentity: string | null;
}

function textHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function isIsoInRange(value: string, minMs: number, maxMs: number): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= minMs && ms <= maxMs;
}

function validateLifecycle(
  scope: Scope,
  memoryType: MemoryType,
  metadata: Record<string, string>,
  nowMs: number,
): boolean {
  const createdAt = metadata.created_at;
  const updatedAt = metadata.updated_at;
  if (!createdAt || !updatedAt) return false;
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(updatedMs)) return false;
  if (createdMs > nowMs + MAX_FUTURE_SKEW_MS) return false;
  if (updatedMs < createdMs || updatedMs > nowMs + MAX_FUTURE_SKEW_MS) return false;

  const expiresAt = metadata.expires_at;
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return false;
    if (expiresMs < createdMs) return false;
    if (memoryType === "task_state" && expiresMs > createdMs + 30 * DAY_MS) return false;
    if (memoryType === "inference" && expiresMs > createdMs + 90 * DAY_MS) return false;
    if (memoryType === "project_fact" && expiresMs > createdMs + 180 * DAY_MS) return false;
  }

  if (memoryType === "task_state" || memoryType === "inference" || memoryType === "project_fact") {
    if (!expiresAt) return false;
  }
  if (memoryType === "inference" && metadata.verification_state !== "unverified") return false;
  if (scope === "profile" && metadata.project_identity !== undefined) return false;

  if (metadata.last_verified_at) {
    const lastVerifiedMs = Date.parse(metadata.last_verified_at);
    if (!Number.isFinite(lastVerifiedMs) || lastVerifiedMs < createdMs || lastVerifiedMs > nowMs + MAX_FUTURE_SKEW_MS) {
      return false;
    }
  }

  return true;
}

function isLocalRowCurrentMetadataConsistent(
  row: MemoryRow,
  metadata: Record<string, string>,
  text: string,
): boolean {
  if (row.text_hash !== textHashOf(text)) return false;
  if (row.text_hash !== metadata.content_hash) return false;
  if (row.id !== metadata.logical_id) return false;
  if (row.created_at !== metadata.created_at) return false;
  if (row.updated_at !== metadata.updated_at) return false;
  const metadataExpiry = metadata.expires_at ?? null;
  if ((row.expires_at ?? null) !== metadataExpiry) return false;
  const metadataCreatedAt = metadata.created_at;
  const metadataUpdatedAt = metadata.updated_at;
  if (!metadataCreatedAt || !metadataUpdatedAt) return false;
  const metadataCreatedMs = Date.parse(metadataCreatedAt);
  const metadataUpdatedMs = Date.parse(metadataUpdatedAt);
  if (!Number.isFinite(metadataCreatedMs) || !Number.isFinite(metadataUpdatedMs)) return false;
  if (metadataUpdatedMs < metadataCreatedMs) return false;
  if (row.verification_state === "verified" && row.last_verified_at === null) return false;
  if (row.verification_state === "unverified" && metadata.last_verified_at !== undefined) return false;
  if (metadata.last_verified_at !== undefined && row.last_verified_at !== metadata.last_verified_at) return false;
  return true;
}

/**
 * Pre-fix provider metadata: logical_id equals the content text hash and
 * content_hash is absent. Only accepted against a locally owned legacy locator
 * whose document still recomputes from the row's current text hash (pure
 * legacy, not yet upgraded by a governed update).
 */
function isLocalRowLegacyMetadataConsistent(
  row: MemoryRow,
  metadata: Record<string, string>,
  text: string,
): boolean {
  if (!isLegacyOwnedDocumentRow(row)) return false;
  if (row.text_hash !== textHashOf(text)) return false;
  if (metadata.content_hash !== undefined) return false;
  if (metadata.logical_id !== row.text_hash) return false;
  if (
    row.document_id !==
    buildLegacyOwnedDocumentId(row.scope, row.project_identity, row.text_hash)
  ) {
    return false;
  }
  if (row.created_at !== metadata.created_at) return false;
  if (row.updated_at !== metadata.updated_at) return false;
  const metadataExpiry = metadata.expires_at ?? null;
  if ((row.expires_at ?? null) !== metadataExpiry) return false;
  if (row.verification_state === "verified" && row.last_verified_at === null) return false;
  if (row.verification_state === "unverified" && metadata.last_verified_at !== undefined) return false;
  if (metadata.last_verified_at !== undefined && row.last_verified_at !== metadata.last_verified_at) return false;
  return true;
}

function localRowAcceptsProviderItem(
  row: MemoryRow,
  metadata: Record<string, string>,
  text: string,
  nowMs: number,
): boolean {
  if (!rowOwnsDocumentId(row)) return false;
  if (row.memory_type !== metadata.memory_type) return false;
  if (row.verification_state !== metadata.verification_state) return false;
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return false;

  const currentMeta = validateRetainMetadata(metadata);
  if (currentMeta.ok) {
    if (!validateLifecycle(row.scope, metadata.memory_type as MemoryType, metadata, nowMs)) return false;
    if (metadata.content_hash !== textHashOf(text)) return false;
    return isLocalRowCurrentMetadataConsistent(row, metadata, text);
  }

  const legacyMeta = validateLegacyRetainMetadata(metadata);
  if (!legacyMeta.ok) return false;
  if (!validateLifecycle(row.scope, metadata.memory_type as MemoryType, metadata, nowMs)) return false;
  return isLocalRowLegacyMetadataConsistent(row, metadata, text);
}

async function recallFromBank(
  runtime: GlobalRuntime,
  bank: RecallBankContext,
  query: string,
  signal: AbortSignal,
): Promise<ReconciledItem[]> {
  const result = await runtime.adapter.recall(
    { bankId: bank.bankId, query, budget: "mid", maxTokens: RECALL_MAX_TOKENS_PER_BANK },
    signal,
  );
  if (!result.ok) return [];
  return reconcile(runtime, bank, result.value, signal, Date.now());
}

/**
 * Drops any recalled item that cannot be confirmed against a locally
 * governed, active memory row for the same bank and document — this is what
 * prevents untrusted, stale, or already-deleted Hindsight content (or
 * content from a differently-scoped bank) from being injected as "memory".
 * Reconciliation keys on `(bankId, documentId)`, which is assigned
 * deterministically before the write completes, rather than on a
 * locally-generated row ID that would not yet exist at write time.
 */
function reconcile(
  runtime: GlobalRuntime,
  bank: RecallBankContext,
  items: RecallResultItem[],
  signal: AbortSignal,
  nowMs: number,
): ReconciledItem[] {
  const out: ReconciledItem[] = [];
  for (const item of items) {
    if (signal.aborted) break;
    if (!item.documentId) continue;
    if (item.type !== "world" && item.type !== "experience") continue;
    const documentCheck = validateDocumentId(item.documentId);
    if (!documentCheck.ok) continue;
    const textCheck = validateMemoryText(item.text);
    if (!textCheck.ok) continue;
    if (looksLikeBulkContent(item.text)) continue;
    if (scanForSensitiveContent(item.text).sensitive) continue;
    if (unicodeLength(item.text.trim()) > DIAGNOSTIC_TEXT_PREVIEW_CHARS * 8) continue;
    const metadata = item.metadata;
    if (!metadata) continue;
    if (metadata.scope !== bank.scope) continue;
    if (metadata.memory_type === "inference" && metadata.verification_state !== "unverified") continue;

    const row = runtime.repos.memories.getByBankAndDocument(bank.bankId, item.documentId);
    if (bank.scope === "profile") {
      if (!row || row.status !== "active" || row.scope !== "profile") continue;
      if (runtime.repos.conflicts.hasOpenForMemory(row.id)) continue;
      if (row.bank_id !== bank.bankId || row.document_id !== item.documentId) continue;
      if (!localRowAcceptsProviderItem(row, metadata, item.text, nowMs)) continue;
      out.push({
        scope: row.scope,
        memoryType: row.memory_type,
        text: item.text.trim(),
        verificationState: row.verification_state,
        memoryId: row.id,
        readOnlyShared: false,
      });
      continue;
    }

    if (row) {
      if (row.status !== "active" || row.scope !== "project") continue;
      if (runtime.repos.conflicts.hasOpenForMemory(row.id)) continue;
      if (row.bank_id !== bank.bankId || row.document_id !== item.documentId) continue;
      if (row.project_identity !== metadata.project_identity) continue;
      if (!localRowAcceptsProviderItem(row, metadata, item.text, nowMs)) continue;
      out.push({
        scope: "project",
        memoryType: row.memory_type,
        text: item.text.trim(),
        verificationState: row.verification_state,
        memoryId: row.id,
        readOnlyShared: false,
      });
      continue;
    }

    // Shared Project recall without a local row: current format only (fail closed on legacy).
    if (!isEligibleSharedProjectMetadata(bank, metadata, item.documentId, item.text, nowMs)) continue;
    out.push({
      scope: "project",
      memoryType: metadata.memory_type as MemoryType,
      text: item.text.trim(),
      verificationState: metadata.verification_state as VerificationState,
      memoryId: null,
      readOnlyShared: true,
    });
  }
  return out;
}

function isEligibleSharedProjectMetadata(
  bank: RecallBankContext,
  metadata: Record<string, string>,
  documentId: string,
  text: string,
  nowMs: number,
): boolean {
  if (bank.scope !== "project") return false;
  if (!bank.currentProjectIdentity || !metadata.project_identity) return false;
  if (metadata.project_identity !== bank.currentProjectIdentity) return false;
  if (bank.bankId !== projectBankId(bank.currentProjectIdentity)) return false;
  const metadataCheck = validateRetainMetadata(metadata);
  if (!metadataCheck.ok) return false;
  if (!validateLifecycle(bank.scope, metadata.memory_type as MemoryType, metadata, nowMs)) return false;
  if (metadata.content_hash !== textHashOf(text)) return false;
  if (!metadata.logical_id) return false;
  return (
    buildCurrentOwnedDocumentId(
      "project",
      bank.currentProjectIdentity,
      metadata.memory_type as MemoryType,
      metadata.logical_id,
    ) === documentId
  );
}

function renderRecallBlock(
  language: "en" | "zh",
  items: ReconciledItem[],
): string {
  const fixedPrefix = [t(language, "recall.block.header"), t(language, "recall.block.disclaimer")];
  const renderItem = (item: ReconciledItem) => {
    const suffix =
      item.verificationState === "unverified" && item.memoryType === "inference"
        ? t(language, "recall.block.unverified_inference_suffix")
        : "";
    return t(language, "recall.block.item", { scope: item.scope, type: item.memoryType, text: `${item.text}${suffix}` });
  };
  const capped = capRenderedRecallItems(items, fixedPrefix, renderItem);
  return [...fixedPrefix, ...capped.map(renderItem)].join("\n");
}

export async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | void> {
  if (ctx.mode !== "tui") return;

  const sessionId = ctx.sessionManager.getSessionId();
  // Claim the input identity before any memoryOff check (and before any
  // await): an off input must still be consumed here so that a later
  // duplicate before_agent_start callback for the same input — reached
  // after memory is switched back on — finds the identity already claimed
  // and does not retroactively Recall for it.
  const claim = tryClaimRecallInput(sessionId, { leafId: ctx.sessionManager.getLeafId(), prompt: event.prompt });
  if (!claim) return;
  if (claim.state.memoryOff) return;

  const query = truncateUnicode(typeof event.prompt === "string" ? event.prompt.trim() : "", MAX_QUERY_CHARS);
  if (!query) return;
  if (scanForSensitiveContent(query).sensitive) return;
  if (looksLikeBulkContent(query)) return;

  const signal = ctx.signal
    ? AbortSignal.any([claim.controller.signal, ctx.signal, AbortSignal.timeout(RECALL_TIMEOUT_MS)])
    : AbortSignal.any([claim.controller.signal, AbortSignal.timeout(RECALL_TIMEOUT_MS)]);
  const runtimeResult = await getGlobalRuntime();
  if (!runtimeResult.ok || signal.aborted || !isSessionStateCurrent(sessionId, claim.state)) return;
  const { runtime } = runtimeResult;

  const projectBank = await resolveProjectBank(ctx.cwd);
  if (signal.aborted || !isSessionStateCurrent(sessionId, claim.state)) return;

  const queries: Promise<ReconciledItem[]>[] = [
    recallFromBank(runtime, { scope: "profile", bankId: runtime.profileBankId, projectIdentity: null, currentProjectIdentity: null }, query, signal),
  ];
  if (projectBank.enabled) {
    queries.push(
      recallFromBank(
        runtime,
        {
          scope: "project",
          bankId: projectBank.bankId,
          projectIdentity: projectBank.identity,
          currentProjectIdentity: projectBank.identity,
        },
        query,
        signal,
      ),
    );
  }

  const settled = await Promise.allSettled(queries);
  if (signal.aborted || !isSessionStateCurrent(sessionId, claim.state)) return;

  const profileItems = settled[0]?.status === "fulfilled" ? settled[0].value : [];
  const projectItems = projectBank.enabled && settled[1]?.status === "fulfilled" ? settled[1].value : [];
  const merged = [...projectItems, ...profileItems].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.verificationState !== b.verificationState) return a.verificationState === "verified" ? -1 : 1;
    if (a.memoryType === "inference" && b.memoryType !== "inference") return 1;
    if (b.memoryType === "inference" && a.memoryType !== "inference") return -1;
    return 0;
  });
  const language = normalizeLanguage(runtime.profile.language);
  const block = renderRecallBlock(language, merged);
  const blockLines = block.split("\n");
  const itemCount = Math.max(0, blockLines.length - 2);
  if (itemCount === 0) return;

  claim.state.lastRecall = {
    injectedAt: new Date().toISOString(),
    promptPreview: query.slice(0, 80),
    items: merged.slice(0, itemCount).map((item) => ({
      scope: item.scope,
      memoryType: item.memoryType,
      text: truncateUnicode(item.text, DIAGNOSTIC_TEXT_PREVIEW_CHARS),
      memoryId: item.memoryId,
      readOnlyShared: item.readOnlyShared,
    })),
  };

  try {
    ctx.ui.notify(t(language, "recall.notified", { count: itemCount }), "info");
  } catch {
    // UI failure must not erase an otherwise valid prompt result.
  }

  return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
}

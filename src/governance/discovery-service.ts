import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { MemoryRow, Scope } from "../db/types.js";
import {
  effectiveMemoryStatus,
  MEMORY_LIST_FETCH_CONCURRENCY,
  MEMORY_LIST_FETCH_DEADLINE_MS,
  MEMORY_LIST_LIMIT,
  MEMORY_LIST_PREVIEW_CHARS,
} from "../db/lifecycle.js";
import { isValidOwnedMemoryLocator } from "./memory-locator.js";
import { truncateUnicode, validateMemoryText, scanForSensitiveContent, looksLikeBulkContent } from "../security/filters.js";
import { mutationNowIso, mutationNowMs } from "./mutation-clock.js";
import { providerMetadataMatchesLocalRow } from "../provider/metadata-consistency.js";

export type MemoryListScopeFilter = "all" | "profile" | "project";

export interface MemoryListItemView {
  id: string;
  scope: Scope;
  memoryType: string;
  projectIdentity: string | null;
  status: string;
  verificationState: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  preview: string | null;
  contentAvailable: boolean;
}

export interface MemoryShowView {
  id: string;
  scope: Scope;
  memoryType: string;
  projectIdentity: string | null;
  status: string;
  storedStatus: string;
  verificationState: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  text: string | null;
  contentAvailable: boolean;
  reason?: string;
}

async function fetchValidatedText(
  runtime: GlobalRuntime,
  row: MemoryRow,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (!isValidOwnedMemoryLocator(runtime, row)) {
    return { ok: false, reason: "stored memory locator is invalid" };
  }
  const fetched = await runtime.adapter.fetchExactOneUnitDocument(
    row.bank_id,
    row.document_id,
    row.text_hash,
    signal,
  );
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason };
  }
  const textCheck = validateMemoryText(fetched.value.text);
  if (!textCheck.ok) {
    return { ok: false, reason: textCheck.reason ?? "provider text failed validation" };
  }
  if (scanForSensitiveContent(fetched.value.text).sensitive || looksLikeBulkContent(fetched.value.text)) {
    return { ok: false, reason: "provider text failed sensitivity bounds" };
  }
  if (
    !providerMetadataMatchesLocalRow(
      row,
      fetched.value.metadata,
      fetched.value.text,
      mutationNowMs(),
    )
  ) {
    return { ok: false, reason: "provider metadata does not match local governance record" };
  }
  return { ok: true, text: fetched.value.text };
}

type PreviewResult = { preview: string | null; contentAvailable: boolean };

function combineFetchSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    throw new Error("combineFetchSignals requires at least one signal");
  }
  if (signals.length === 1) {
    return signals[0]!;
  }
  return AbortSignal.any(signals);
}

async function fetchPreviewsBounded(
  runtime: GlobalRuntime,
  entries: Array<{ row: MemoryRow; status: string }>,
  options: { signal?: AbortSignal; deadlineMs: number; concurrency: number },
): Promise<Map<string, PreviewResult>> {
  const results = new Map<string, PreviewResult>();
  const unavailable: PreviewResult = { preview: null, contentAvailable: false };
  const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
  const fetchSignal = options.signal
    ? combineFetchSignals([options.signal, deadlineSignal])
    : deadlineSignal;
  let nextIndex = 0;

  const fetchOne = async (entry: { row: MemoryRow; status: string }): Promise<void> => {
    if (fetchSignal.aborted) {
      results.set(entry.row.id, unavailable);
      return;
    }
    if (entry.row.status !== "active" || entry.status !== "active") {
      results.set(entry.row.id, unavailable);
      return;
    }
    try {
      const fetched = await fetchValidatedText(runtime, entry.row, fetchSignal);
      if (fetched.ok) {
        results.set(entry.row.id, {
          preview: truncateUnicode(fetched.text, MEMORY_LIST_PREVIEW_CHARS),
          contentAvailable: true,
        });
        return;
      }
    } catch {
      // Provider fetch aborted or failed — degrade to metadata-only.
    }
    results.set(entry.row.id, unavailable);
  };

  const workerCount = Math.min(options.concurrency, entries.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (fetchSignal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      try {
        await fetchOne(entries[index]!);
      } catch {
        results.set(entries[index]!.row.id, unavailable);
      }
    }
  });
  await Promise.allSettled(workers);

  for (const entry of entries) {
    if (!results.has(entry.row.id)) {
      results.set(entry.row.id, unavailable);
    }
  }
  return results;
}

export async function listMemories(
  runtime: GlobalRuntime,
  options: {
    filter: MemoryListScopeFilter;
    projectIdentity: string | null;
    signal?: AbortSignal;
    /** Test seam: override list provider fetch deadline (wall clock). */
    fetchDeadlineMs?: number;
  },
): Promise<MemoryListItemView[]> {
  const nowIso = mutationNowIso();
  const nowMs = mutationNowMs();
  let rows: MemoryRow[];
  if (options.filter === "profile") {
    rows = runtime.repos.memories.listEffectiveActive({
      scope: "profile",
      projectIdentity: null,
      nowIso,
      limit: MEMORY_LIST_LIMIT,
    });
  } else if (options.filter === "project") {
    if (!options.projectIdentity) return [];
    rows = runtime.repos.memories.listEffectiveActive({
      scope: "project",
      projectIdentity: options.projectIdentity,
      nowIso,
      limit: MEMORY_LIST_LIMIT,
    });
  } else {
    const profile = runtime.repos.memories.listEffectiveActive({
      scope: "profile",
      projectIdentity: null,
      nowIso,
      limit: MEMORY_LIST_LIMIT,
    });
    const project = options.projectIdentity
      ? runtime.repos.memories.listEffectiveActive({
          scope: "project",
          projectIdentity: options.projectIdentity,
          nowIso,
          limit: MEMORY_LIST_LIMIT,
        })
      : [];
    rows = [...profile, ...project]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, MEMORY_LIST_LIMIT);
  }

  const entries = rows.map((row) => ({
    row,
    status: effectiveMemoryStatus(row.status, row.expires_at, nowMs),
  }));
  const previews = await fetchPreviewsBounded(runtime, entries, {
    ...(options.signal ? { signal: options.signal } : {}),
    deadlineMs: options.fetchDeadlineMs ?? MEMORY_LIST_FETCH_DEADLINE_MS,
    concurrency: MEMORY_LIST_FETCH_CONCURRENCY,
  });
  return entries.map(({ row, status }) => {
    const previewResult = previews.get(row.id) ?? { preview: null, contentAvailable: false };
    return {
      id: row.id,
      scope: row.scope,
      memoryType: row.memory_type,
      projectIdentity: row.project_identity,
      status,
      verificationState: row.verification_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      preview: previewResult.preview,
      contentAvailable: previewResult.contentAvailable,
    };
  });
}

export interface ShowMemoryOptions {
  signal?: AbortSignal;
  /** Required for project rows: the currently enabled project identity from cwd. */
  expectedProjectIdentity?: string | null;
  /** When false, project-scoped content must not be fetched or shown. */
  projectScopeEnabled?: boolean;
}

export async function showMemory(
  runtime: GlobalRuntime,
  memoryId: string,
  options?: ShowMemoryOptions,
): Promise<MemoryShowView | { outcome: "not_found" } | { outcome: "rejected"; reason: string }> {
  const row = runtime.repos.memories.getById(memoryId);
  if (!row) return { outcome: "not_found" };
  if (row.scope === "project") {
    if (!options?.projectScopeEnabled) {
      return { outcome: "rejected", reason: "project memory is unavailable for the current project" };
    }
    if (row.project_identity !== (options.expectedProjectIdentity ?? null)) {
      return { outcome: "rejected", reason: "memory belongs to a different project identity" };
    }
  }
  const status = effectiveMemoryStatus(row.status, row.expires_at, mutationNowMs());
  const base: MemoryShowView = {
    id: row.id,
    scope: row.scope,
    memoryType: row.memory_type,
    projectIdentity: row.project_identity,
    status,
    storedStatus: row.status,
    verificationState: row.verification_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    lastVerifiedAt: row.last_verified_at,
    text: null,
    contentAvailable: false,
  };

  if (row.status !== "active" || status !== "active") {
    return {
      ...base,
      reason: `memory is not effective-active (status: ${status})`,
    };
  }
  if (runtime.repos.conflicts.hasOpenForMemory(row.id)) {
    return { ...base, reason: "memory has an open conflict" };
  }
  if (!isValidOwnedMemoryLocator(runtime, row)) {
    return { outcome: "rejected", reason: "stored memory locator is invalid" };
  }

  const fetched = await fetchValidatedText(runtime, row, options?.signal);
  if (!fetched.ok) {
    return { ...base, reason: fetched.reason };
  }
  return { ...base, text: fetched.text, contentAvailable: true };
}

export function renderMemoryListItem(item: MemoryListItemView): string {
  const project =
    item.scope === "project" && item.projectIdentity ? ` project=${item.projectIdentity}` : "";
  const preview = item.contentAvailable
    ? item.preview ?? ""
    : "(content unavailable)";
  return `- ${item.id} [${item.scope}/${item.memoryType}] status=${item.status} verify=${item.verificationState}${project} ${preview}`;
}

export function renderMemoryShow(view: MemoryShowView): string {
  const lines = [
    `id: ${view.id}`,
    `scope: ${view.scope}`,
    `type: ${view.memoryType}`,
    `status: ${view.status}`,
    `stored_status: ${view.storedStatus}`,
    `verification: ${view.verificationState}`,
    `created_at: ${view.createdAt}`,
    `updated_at: ${view.updatedAt}`,
    `expires_at: ${view.expiresAt ?? "(none)"}`,
    `last_verified_at: ${view.lastVerifiedAt ?? "(none)"}`,
  ];
  if (view.projectIdentity) lines.push(`project: ${view.projectIdentity}`);
  if (view.contentAvailable && view.text != null) {
    lines.push("content:");
    lines.push(view.text);
  } else {
    lines.push(`content: unavailable${view.reason ? ` (${view.reason})` : ""}`);
  }
  return lines.join("\n");
}

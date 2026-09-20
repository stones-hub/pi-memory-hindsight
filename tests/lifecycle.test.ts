import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import extension, { MEMORY_SESSION_STATE_ENTRY_TYPE, appendSessionMemoryState } from "../src/index.js";
import { MemoryDatabase } from "../src/db/database.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { buildOwnedDocumentId, buildLegacyOwnedDocumentId } from "../src/provider/validation.js";
import { handleAgentEnd, handleAgentSettled } from "../src/extraction/extraction-service.js";
import { selectExtractionMaterial } from "../src/extraction/material.js";
import { remember } from "../src/governance/remember-service.js";
import { handleBeforeAgentStart } from "../src/recall/recall-service.js";
import { estimateTokens } from "../src/recall/token-budget.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import {
  getSessionState,
  noteInputEvent,
  noteTurnStart,
  peekSessionState,
  resetAllSessionStateForTests,
  setSessionMemoryOff,
  shutdownSessionState,
} from "../src/runtime/session-runtime.js";

const { getGlobalRuntimeMock, resolveProjectBankMock } = vi.hoisted(() => ({
  getGlobalRuntimeMock: vi.fn(),
  resolveProjectBankMock: vi.fn(),
}));

vi.mock("../src/runtime/global-runtime.js", () => ({
  getGlobalRuntime: getGlobalRuntimeMock,
  peekCachedLocalRuntime: () => undefined,
}));

vi.mock("../src/runtime/project-runtime.js", () => ({
  resolveProjectBank: resolveProjectBankMock,
}));

function makeRuntime() {
  const db = MemoryDatabase.openInMemory();
  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  const runtime = {
    agentDir: "/tmp/pi-agent",
    db,
    hindsightUrl: "http://127.0.0.1:8888",
    minScore: 0.5,
    adapter: {
      recall: vi.fn(),
      getNegotiatedApiVersion: vi.fn().mockReturnValue("0.8.3"),
      ensureOwnedBank: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      retainOneMemory: vi.fn().mockResolvedValue({ ok: true, value: { unitId: "unit-1" } }),
      verifyOneUnitDocument: vi.fn().mockResolvedValue({ ok: false, reason: "missing", category: "http", status: 404 }),
      deleteMemoryDocument: vi.fn().mockResolvedValue({ ok: true, value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 } }),
    },
    profile,
    profileBankId: profileBankId(profile.anonymous_profile_id),
    repos: {
      profiles,
      memories: new MemoriesRepository(db),
      candidates: new CandidatesRepository(db),
      operations: new OperationsRepository(db),
      conflicts: new ConflictsRepository(db),
      audit: new AuditRepository(db),
      usage: new UsageRepository(db),
      maintenance: new MaintenanceRepository(db),
    },
  };
  return runtime;
}

function makeContext(overrides: Partial<any> = {}) {
  const sessionId = overrides.sessionId ?? "session-1";
  const branch = overrides.branch ?? [];
  const ui = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    onTerminalInput: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    custom: vi.fn(),
    pasteToEditor: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(),
    editor: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorComponent: vi.fn(),
    getAllThemes: vi.fn(),
    getTheme: vi.fn(),
    setTheme: vi.fn(),
    getToolsExpanded: vi.fn(),
    setToolsExpanded: vi.fn(),
  };
  return {
    ui,
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    cwd: overrides.cwd ?? "/repo",
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => overrides.leafId ?? null,
      getBranch: () => branch,
      getEntries: () => branch,
    },
    modelRegistry: {
      complete: vi.fn(),
    },
    model: overrides.model ?? ({ id: "model-1" } as any),
    scopedModels: [],
    thinkingLevel: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: overrides.signal,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "base",
  };
}

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "provider-x",
    model: "model-x",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function noteOrdinaryInput(sessionId: string, text = "question"): void {
  noteInputEvent(sessionId, { type: "input", text, source: "interactive" });
}

function noteQueuedInput(sessionId: string, streamingBehavior: "steer" | "followUp", text = "queued"): void {
  noteInputEvent(sessionId, { type: "input", text, source: "interactive", streamingBehavior });
}

describe("extension entrypoint and session state", () => {
  beforeEach(() => {
    resetAllSessionStateForTests();
    getGlobalRuntimeMock.mockReset();
    resolveProjectBankMock.mockReset();
  });

  it("registers the required public lifecycle hooks", () => {
    const handlers = new Map<string, Function>();
    extension({
      on: (event: string, handler: Function) => handlers.set(event, handler),
    } as any);

    expect([...handlers.keys()].sort()).toEqual([
      "agent_end",
      "agent_settled",
      "before_agent_start",
      "input",
      "session_shutdown",
      "session_start",
      "turn_start",
    ]);
  });

  it("restores only the latest valid versioned session-state entry on the active branch", async () => {
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    const sessionStart = handlers.get("session_start");
    if (!sessionStart) throw new Error("missing session_start");

    const ctx1 = makeContext({
      branch: [
        { type: "custom", customType: MEMORY_SESSION_STATE_ENTRY_TYPE, data: { v: 1, memoryOff: false } },
        { type: "custom", customType: MEMORY_SESSION_STATE_ENTRY_TYPE, data: { v: 1, memoryOff: true } },
      ],
    });
    await sessionStart({ type: "session_start", reason: "startup" }, ctx1);
    expect(getSessionState("session-1").memoryOff).toBe(true);

    const ctx2 = makeContext({
      sessionId: "session-2",
      branch: [
        { type: "custom", customType: MEMORY_SESSION_STATE_ENTRY_TYPE, data: { v: 1, memoryOff: true } },
        { type: "custom", customType: MEMORY_SESSION_STATE_ENTRY_TYPE, data: { v: 999, memoryOff: false } },
      ],
    });
    await sessionStart({ type: "session_start", reason: "startup" }, ctx2);
    expect(getSessionState("session-2").memoryOff).toBe(false);
  });

  it("exposes a helper that appends a body-free session-state entry", () => {
    const appendEntry = vi.fn();
    appendSessionMemoryState({ appendEntry } as any, true);
    expect(appendEntry).toHaveBeenCalledWith(MEMORY_SESSION_STATE_ENTRY_TYPE, { v: 1, memoryOff: true });
  });

  it("session shutdown only clears its own session state", async () => {
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    const shutdown = handlers.get("session_shutdown");
    if (!shutdown) throw new Error("missing session_shutdown");

    getSessionState("a").memoryOff = true;
    getSessionState("b").memoryOff = false;
    await shutdown({ type: "session_shutdown", reason: "quit" }, makeContext({ sessionId: "a" }));

    expect(getSessionState("b").memoryOff).toBe(false);
    expect(getSessionState("a").memoryOff).toBe(false);
  });

  it("registered session_start, input, and turn_start do no work outside tui, and shutdown does not create state", async () => {
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    const sessionStart = handlers.get("session_start");
    const input = handlers.get("input");
    const turnStart = handlers.get("turn_start");
    const shutdown = handlers.get("session_shutdown");
    if (!sessionStart || !input || !turnStart || !shutdown) throw new Error("missing handlers");

    for (const mode of ["print", "json", "rpc"] as const) {
      const sessionId = `non-tui-${mode}`;
      expect(peekSessionState(sessionId)).toBeUndefined();
      const ctx = makeContext({ mode, sessionId });
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      await input({ type: "input", text: "hello", source: "interactive" }, ctx);
      await turnStart({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
      await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(peekSessionState(sessionId)).toBeUndefined();
    }
  });

  it("package manifest exposes the packed Pi extension entrypoint", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { pi: { extensions: string[] }; keywords: string[] };
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
    expect(pkg.keywords).toContain("pi-package");

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd(), encoding: "utf8" }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = new Set((packed[0]?.files ?? []).map((file) => file.path));
    for (const extensionPath of pkg.pi.extensions) {
      expect(packedPaths.has(extensionPath.replace(/^\.\//, ""))).toBe(true);
    }
    expect(packedPaths.has("src/index.ts")).toBe(true);
    expect(packed[0]?.files.length ?? 0).toBeGreaterThan(0);
  });
});

describe("automatic recall lifecycle", () => {
  beforeEach(() => {
    resetAllSessionStateForTests();
    getGlobalRuntimeMock.mockReset();
    resolveProjectBankMock.mockReset();
  });

  it("recalls at most once per ordinary input, then allows the next input, with project results ranked before profile", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "zh";
    const profileText = "Prefer concise answers.";
    const profileHash = sha256(profileText);
    const profileId = randomUUID();
    const profileDoc = buildOwnedDocumentId("profile", null, "preference", profileId);
    const profileCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const profileUpdatedAt = new Date(Date.now() - 30_000).toISOString();
    runtime.repos.memories.create({
      id: profileId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: profileDoc,
      unitId: "u1",
      textHash: profileHash,
      textLength: profileText.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      createdAt: profileCreatedAt,
      updatedAt: profileUpdatedAt,
      lastVerifiedAt: profileUpdatedAt,
    });

    const projectIdentity = "repo";
    const projectText = "The project uses Vitest.";
    const projectHash = sha256(projectText);
    const projectId = randomUUID();
    const projectCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const projectUpdatedAt = new Date(Date.now() - 30_000).toISOString();
    const projectExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const projectDoc = buildOwnedDocumentId("project", projectIdentity, "project_fact", projectId);
    runtime.repos.memories.create({
      id: projectId,
      scope: "project",
      memoryType: "project_fact",
      projectIdentity,
      bankId: projectBankId(projectIdentity),
      documentId: projectDoc,
      unitId: "u2",
      textHash: projectHash,
      textLength: projectText.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: projectExpiresAt,
      createdAt: projectCreatedAt,
      updatedAt: projectUpdatedAt,
      lastVerifiedAt: projectUpdatedAt,
    });
    runtime.adapter.recall.mockImplementation(async ({ bankId }: { bankId: string }) => {
      if (bankId === runtime.profileBankId) {
        return {
          ok: true,
          value: [{
            id: "1",
            text: profileText,
            type: "world",
            documentId: profileDoc,
            metadata: {
              logical_id: profileId,
              content_hash: profileHash,
              scope: "profile",
              memory_type: "preference",
              verification_state: "verified",
              created_at: profileCreatedAt,
              updated_at: profileUpdatedAt,
              last_verified_at: profileUpdatedAt,
            },
            tags: null,
            context: null,
            mentionedAt: null,
          }],
        };
      }
      return {
        ok: true,
        value: [
          {
            id: "2",
            text: projectText,
            type: "world",
            documentId: projectDoc,
            metadata: {
              logical_id: projectId,
              content_hash: projectHash,
              scope: "project",
              memory_type: "project_fact",
              verification_state: "verified",
              created_at: projectCreatedAt,
              updated_at: projectUpdatedAt,
              last_verified_at: projectUpdatedAt,
              expires_at: projectExpiresAt,
              project_identity: projectIdentity,
            },
            tags: null,
            context: null,
            mentionedAt: null,
          },
        ],
      };
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: projectIdentity, bankId: projectBankId(projectIdentity) });

    noteOrdinaryInput("session-1");
    const ctx = makeContext();
    const result1 = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "How do I run tests?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result1?.message).toBeUndefined();
    expect(result1?.systemPrompt).toBeDefined();
    expect(result1?.systemPrompt).toContain("相关记忆");
    expect(result1?.systemPrompt?.indexOf("[project/project_fact]")).toBeLessThan(
      result1?.systemPrompt?.indexOf("[profile/preference]") ?? Infinity,
    );
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(getSessionState("session-1").lastRecall?.promptPreview.length ?? 0).toBeLessThanOrEqual(80);
    expect(getSessionState("session-1").lastRecall?.items[0]?.text.length ?? 0).toBeLessThanOrEqual(160);
    expect(estimateTokens((result1?.systemPrompt ?? "").split("BASE\n\n")[1] ?? "")).toBeLessThanOrEqual(1500);

    const result2 = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "How do I run tests?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result2).toBeUndefined();
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(2);

    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "And build?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(4);
  });

  it("carries validated scores into session-local /memory last diagnostics only for injected items", async () => {
    const runtime = makeRuntime();
    const profileText = "Prefer concise answers.";
    const profileHash = sha256(profileText);
    const profileId = randomUUID();
    const profileDoc = buildOwnedDocumentId("profile", null, "preference", profileId);
    const profileCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const profileUpdatedAt = new Date(Date.now() - 30_000).toISOString();
    runtime.repos.memories.create({
      id: profileId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: profileDoc,
      unitId: "u1",
      textHash: profileHash,
      textLength: profileText.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      createdAt: profileCreatedAt,
      updatedAt: profileUpdatedAt,
      lastVerifiedAt: profileUpdatedAt,
    });
    const scores = {
      final: 1.0986786712451455,
      reranker: null,
      semantic: 0.77,
      keyword: null,
    };
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "1",
          text: profileText,
          type: "world",
          documentId: profileDoc,
          metadata: {
            logical_id: profileId,
            content_hash: profileHash,
            scope: "profile",
            memory_type: "preference",
            verification_state: "verified",
            created_at: profileCreatedAt,
            updated_at: profileUpdatedAt,
            last_verified_at: profileUpdatedAt,
          },
          tags: null,
          context: null,
          mentionedAt: null,
          scores,
        },
        {
          id: "dropped",
          text: "Unreconciled provider noise",
          type: "world",
          documentId: "pi-memory-hindsight:memory:00000000000000000000000000000000",
          metadata: {
            logical_id: randomUUID(),
            content_hash: sha256("Unreconciled provider noise"),
            scope: "profile",
            memory_type: "preference",
            verification_state: "verified",
            created_at: profileCreatedAt,
            updated_at: profileUpdatedAt,
            last_verified_at: profileUpdatedAt,
          },
          tags: null,
          context: null,
          mentionedAt: null,
          scores: { final: 9.9, reranker: 9.9, semantic: 9.9, keyword: 9.9 },
        },
      ],
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false });

    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "How do I answer?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );

    const last = getSessionState("session-1").lastRecall;
    expect(last?.items).toHaveLength(1);
    expect(last?.items[0]).toMatchObject({
      memoryId: profileId,
      scores,
    });
    expect(JSON.stringify(last)).not.toContain("Unreconciled");
    expect(JSON.stringify(last)).not.toContain("9.9");

    // Diagnostics stay process-local: a different Session does not inherit them.
    expect(getSessionState("session-other").lastRecall).toBeNull();
  });

  it("isolates per-bank failures and rejects locally tombstoned shared-project memories", async () => {
    const runtime = makeRuntime();
    const projectIdentity = "repo";
    const deadId = randomUUID();
    const projectDoc = buildOwnedDocumentId("project", projectIdentity, "decision", deadId);
    runtime.repos.memories.create({
      id: deadId,
      scope: "project",
      memoryType: "decision",
      projectIdentity,
      bankId: projectBankId(projectIdentity),
      documentId: projectDoc,
      unitId: "u1",
      textHash: "dead",
      textLength: 10,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const local = runtime.repos.memories.getByBankAndDocument(projectBankId(projectIdentity), projectDoc);
    if (!local) throw new Error("missing local memory");
    runtime.repos.memories.setStatus(local.id, "deleted");

    runtime.adapter.recall.mockImplementation(async ({ bankId }: { bankId: string }) => {
      if (bankId === runtime.profileBankId) {
        throw new Error("profile failure");
      }
      return {
        ok: true,
        value: [
          {
            id: "2",
            text: "Do not inject me.",
            type: "world",
            documentId: projectDoc,
            metadata: {
              logical_id: deadId,
              content_hash: sha256("Do not inject me."),
              scope: "project",
              memory_type: "decision",
              verification_state: "verified",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              project_identity: projectIdentity,
            },
            tags: null,
            context: null,
            mentionedAt: null,
          },
        ],
      };
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: projectIdentity, bankId: projectBankId(projectIdentity) });

    noteOrdinaryInput("session-1");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result).toBeUndefined();
  });

  it("atomically claims an input before awaits so concurrent calls and same-input retries do not retry, but a new input can", async () => {
    const runtime = makeRuntime();
    let release!: () => void;
    runtime.adapter.recall.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, value: [] });
        }),
    );
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteOrdinaryInput("session-1");
    const ctx = makeContext();
    const p1 = handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    const p2 = handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([p1, p2]);
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });

    getGlobalRuntimeMock.mockResolvedValue({ ok: false, reason: "init failed" });
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(getGlobalRuntimeMock).toHaveBeenCalledTimes(1);

    noteOrdinaryInput("session-1");
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(getGlobalRuntimeMock).toHaveBeenCalledTimes(2);
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(2);
  });

  it("aborts in-flight recall on shutdown and does not inject after late completion", async () => {
    const runtime = makeRuntime();
    let resolveRecall!: (value: unknown) => void;
    runtime.adapter.recall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecall = resolve;
        }),
    );
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    noteOrdinaryInput("session-1");

    const ctx = makeContext();
    const pending = handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    shutdownSessionState("session-1");
    resolveRecall({ ok: true, value: [] });
    const result = await pending;
    expect(result).toBeUndefined();
  });

  it("rejects wrong project identity, missing expiry, and open-conflict local rows", async () => {
    const runtime = makeRuntime();
    const projectIdentity = "repo";
    const text = "Project fact";
    const hash = sha256(text);
    const rowId = randomUUID();
    const doc = buildOwnedDocumentId("project", projectIdentity, "project_fact", rowId);
    const row = runtime.repos.memories.create({
      id: rowId,
      scope: "project",
      memoryType: "project_fact",
      projectIdentity,
      bankId: projectBankId(projectIdentity),
      documentId: doc,
      unitId: "u1",
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    runtime.repos.conflicts.create({ candidateId: null, memoryId: row.id, kind: "duplicate" });
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: doc,
        metadata: {
          logical_id: row.id,
          content_hash: hash,
          scope: "project",
          memory_type: "project_fact",
          verification_state: "verified",
          created_at: new Date(Date.now() - 60000).toISOString(),
          updated_at: new Date(Date.now() - 30000).toISOString(),
          project_identity: "wrong",
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: projectIdentity, bankId: projectBankId(projectIdentity) });
    noteOrdinaryInput("session-1");

    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result).toBeUndefined();
  });

  it("rejects local rows when provider expiry metadata is missing or differs from local expiry", async () => {
    const runtime = makeRuntime();
    const projectIdentity = "repo";
    const text = "Project fact with expiry";
    const hash = sha256(text);
    const rowId = randomUUID();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const doc = buildOwnedDocumentId("project", projectIdentity, "project_fact", rowId);
    runtime.repos.memories.create({
      id: rowId,
      scope: "project",
      memoryType: "project_fact",
      projectIdentity,
      bankId: projectBankId(projectIdentity),
      documentId: doc,
      unitId: "u1",
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt,
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: projectIdentity, bankId: projectBankId(projectIdentity) });
    noteOrdinaryInput("session-1");

    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: doc,
        metadata: {
          logical_id: rowId,
          content_hash: hash,
          scope: "project",
          memory_type: "project_fact",
          verification_state: "verified",
          created_at: new Date(Date.now() - 60000).toISOString(),
          updated_at: new Date(Date.now() - 30000).toISOString(),
          project_identity: projectIdentity,
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    expect(
      await handleBeforeAgentStart(
        { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
        makeContext() as any,
      ),
    ).toBeUndefined();

    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: doc,
        metadata: {
          logical_id: rowId,
          content_hash: hash,
          scope: "project",
          memory_type: "project_fact",
          verification_state: "verified",
          created_at: new Date(Date.now() - 60000).toISOString(),
          updated_at: new Date(Date.now() - 30000).toISOString(),
          expires_at: new Date(Date.now() + 2 * 86400000).toISOString(),
          project_identity: projectIdentity,
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    expect(
      await handleBeforeAgentStart(
        { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
        makeContext() as any,
      ),
    ).toBeUndefined();
  });

  it("rejects otherwise valid recall items when provider timestamps differ from local row timestamps", async () => {
    const runtime = makeRuntime();
    const text = "Stable remembered fact";
    const rememberResult = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(rememberResult.outcome).toBe("written");
    const row = runtime.repos.memories.listActive("profile", null)[0]!;
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: row.document_id,
        metadata: {
          logical_id: row.id,
          content_hash: row.text_hash,
          scope: "profile",
          memory_type: "preference",
          verification_state: row.verification_state,
          created_at: new Date(Date.parse(row.created_at) - 1).toISOString(),
          updated_at: row.updated_at,
          last_verified_at: row.last_verified_at!,
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });

    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result).toBeUndefined();
  });

  it("caps the final rendered recall block to <=10 items and <=1500 estimated tokens", async () => {
    const runtime = makeRuntime();
    const texts = Array.from({ length: 12 }, (_, index) => `Remember item ${index} ${"x".repeat(220)}`);
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: texts.map((text, index) => {
        const hash = sha256(text);
        const id = `cap-item-${index}`;
        const doc = buildOwnedDocumentId("profile", null, "preference", id);
        const createdAt = new Date(Date.now() - 60000).toISOString();
        const updatedAt = new Date(Date.now() - 30000).toISOString();
        runtime.repos.memories.create({
          id,
          scope: "profile",
          memoryType: "preference",
          projectIdentity: null,
          bankId: runtime.profileBankId,
          documentId: doc,
          unitId: `u${index}`,
          textHash: hash,
          textLength: text.length,
          verificationState: "verified",
          sourceSessionId: null,
          sourceRef: null,
          supersedesMemoryId: null,
          expiresAt: null,
          createdAt,
          updatedAt,
          lastVerifiedAt: updatedAt,
        });
        return {
          id: `r${index}`,
          text,
          type: "world",
          documentId: doc,
          metadata: {
            logical_id: id,
            content_hash: hash,
            scope: "profile",
            memory_type: "preference",
            verification_state: "verified",
            created_at: createdAt,
            updated_at: updatedAt,
            last_verified_at: updatedAt,
          },
          tags: null,
          context: null,
          mentionedAt: null,
        };
      }),
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    noteOrdinaryInput("session-1");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    const block = (result?.systemPrompt ?? "").split("BASE\n\n")[1] ?? "";
    const lines = block.split("\n");
    expect(lines.length - 2).toBeLessThanOrEqual(10);
    expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
  });

  it("accepts exact legacy metadata/doc/text for a local legacy row and rejects tampering; shared project without local row fails closed on legacy", async () => {
    const runtime = makeRuntime();
    const text = "Legacy preference recalled exactly.";
    const textHash = sha256(text);
    const rowId = "legacy-recall-1";
    const legacyDoc = buildLegacyOwnedDocumentId("profile", null, textHash);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const updatedAt = new Date(Date.now() - 30_000).toISOString();
    runtime.repos.memories.create({
      id: rowId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: legacyDoc,
      unitId: "u-legacy",
      textHash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      createdAt,
      updatedAt,
      lastVerifiedAt: updatedAt,
      legacyDocumentTextHash: textHash,
    });

    const legacyMetadata = {
      logical_id: textHash,
      scope: "profile",
      memory_type: "preference",
      verification_state: "verified",
      created_at: createdAt,
      updated_at: updatedAt,
      last_verified_at: updatedAt,
    };

    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: legacyDoc,
        metadata: legacyMetadata,
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    const accepted = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(accepted?.systemPrompt).toContain(text);

    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text: "Tampered legacy preference text!!",
        type: "world",
        documentId: legacyDoc,
        metadata: legacyMetadata,
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    expect(
      await handleBeforeAgentStart(
        { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
        makeContext() as any,
      ),
    ).toBeUndefined();

    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: buildLegacyOwnedDocumentId("profile", null, sha256("other")),
        metadata: legacyMetadata,
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    expect(
      await handleBeforeAgentStart(
        { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
        makeContext() as any,
      ),
    ).toBeUndefined();

    const projectIdentity = "shared-repo";
    const projectText = "Shared legacy project fact text.";
    const projectHash = sha256(projectText);
    const projectLegacyDoc = buildLegacyOwnedDocumentId("project", projectIdentity, projectHash);
    const projectCreated = new Date(Date.now() - 60_000).toISOString();
    const projectUpdated = new Date(Date.now() - 30_000).toISOString();
    const projectExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    noteOrdinaryInput("session-1");
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: projectIdentity,
      bankId: projectBankId(projectIdentity),
    });
    runtime.adapter.recall.mockImplementation(async (req: { bankId: string }) => {
      if (req.bankId === runtime.profileBankId) return { ok: true, value: [] };
      return {
        ok: true,
        value: [{
          id: "p1",
          text: projectText,
          type: "world",
          documentId: projectLegacyDoc,
          metadata: {
            logical_id: projectHash,
            scope: "project",
            memory_type: "project_fact",
            verification_state: "verified",
            created_at: projectCreated,
            updated_at: projectUpdated,
            expires_at: projectExpires,
            project_identity: projectIdentity,
          },
          tags: null,
          context: null,
          mentionedAt: null,
        }],
      };
    });
    expect(
      await handleBeforeAgentStart(
        { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
        makeContext() as any,
      ),
    ).toBeUndefined();
  });

  it("after updating a legacy row, recall accepts current metadata on the reused legacy document", async () => {
    const runtime = makeRuntime();
    const original = "Legacy preference before update.";
    const updated = "Legacy preference after update.";
    const originalHash = sha256(original);
    const updatedHash = sha256(updated);
    const rowId = "legacy-recall-updated";
    const legacyDoc = buildLegacyOwnedDocumentId("profile", null, originalHash);
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    runtime.repos.memories.create({
      id: rowId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: legacyDoc,
      unitId: "u-legacy",
      textHash: originalHash,
      textLength: original.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      createdAt,
      updatedAt: createdAt,
      lastVerifiedAt: createdAt,
      legacyDocumentTextHash: originalHash,
    });

    const { replaceMemory } = await import("../src/governance/replace-service.js");
    const replaced = await replaceMemory(runtime as any, {
      targetMemoryId: rowId,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "test:legacy-recall-update",
      idempotencyKey: `command:update:${rowId}:${originalHash}:${updatedHash}`,
      expectedTargetTextHash: originalHash,
      owner: "command",
    });
    expect(replaced.outcome).toBe("replaced");
    const row = runtime.repos.memories.getById(rowId)!;
    expect(row.document_id).toBe(legacyDoc);
    expect(row.text_hash).toBe(updatedHash);

    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    noteOrdinaryInput("session-1");
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text: updated,
        type: "world",
        documentId: legacyDoc,
        metadata: {
          logical_id: row.id,
          content_hash: row.text_hash,
          scope: "profile",
          memory_type: "preference",
          verification_state: row.verification_state,
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_verified_at: row.last_verified_at!,
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    const accepted = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(accepted?.systemPrompt).toContain(updated);
  });

  it("recalls on the first prompt of a fresh Session, before any turn_start has been observed, matching Pi's real input -> before_agent_start -> turn_start order", async () => {
    const runtime = makeRuntime();
    const text = "Prefer concise answers.";
    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(written.outcome).toBe("written");
    const row = runtime.repos.memories.listActive("profile", null)[0]!;
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [{
        id: "1",
        text,
        type: "world",
        documentId: row.document_id,
        metadata: {
          logical_id: row.id,
          content_hash: row.text_hash,
          scope: "profile",
          memory_type: "preference",
          verification_state: row.verification_state,
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_verified_at: row.last_verified_at!,
        },
        tags: null,
        context: null,
        mentionedAt: null,
      }],
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    expect(peekSessionState("session-1")).toBeUndefined();
    noteOrdinaryInput("session-1", "What are my preferences?");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "What are my preferences?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result?.systemPrompt).toContain(text);
    // No turn_start was ever noted for this session, proving the claim did not depend on it.
    expect(getSessionState("session-1").currentTurnIndex).toBeNull();
  });

  it("falls back to a leaf+prompt-hash identity when before_agent_start is reached without an observed input event, staying stable for same-leaf retries but changing across leaves", async () => {
    const runtime = makeRuntime();
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    const ctxLeafA = makeContext({ leafId: "leaf-a" });
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "no input event seen", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctxLeafA as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);

    // Same leaf, identical prompt, no new input event observed: this must be treated as a retry
    // of the same request, not a new one.
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "no input event seen", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctxLeafA as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);

    // A later completed turn advances the Session leaf, so identical text is eligible again.
    const ctxLeafB = makeContext({ leafId: "leaf-b" });
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "no input event seen", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctxLeafB as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(2);
  });

  it("noteInputEvent classifies queued steer/followUp inputs without creating or overwriting the pending ordinary input", () => {
    noteOrdinaryInput("session-1", "ordinary one");
    const afterOrdinary = getSessionState("session-1").pendingOrdinaryInput;
    expect(afterOrdinary?.sequence).toBe(1);

    noteQueuedInput("session-1", "steer");
    noteQueuedInput("session-1", "followUp");

    const state = getSessionState("session-1");
    expect(state.pendingOrdinaryInput).toEqual(afterOrdinary);
    expect(state.inputSequence).toBe(1);
  });

  it("queued steer/followUp inputs do not duplicate the preceding recall or consume the next ordinary input's eligibility", async () => {
    const runtime = makeRuntime();
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const ctx = makeContext();

    noteOrdinaryInput("session-1", "first question");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "first question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);

    // A queued steer message never gets its own before_agent_start in real Pi; simulate a
    // tool-loop continuation re-entering before_agent_start for the same run to prove the
    // queued input did not open a new claim for it.
    noteQueuedInput("session-1", "steer", "steer message");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "first question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);

    noteQueuedInput("session-1", "followUp", "follow-up message");

    // The next genuinely new ordinary input still gets its own Recall attempt.
    noteOrdinaryInput("session-1", "second question");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "second question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(2);
  });

  it("/memory off skips provider recall, and the next newly submitted input recalls normally after /memory on", async () => {
    const runtime = makeRuntime();
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    setSessionMemoryOff("session-1", true);
    noteOrdinaryInput("session-1");
    const whileOff = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(whileOff).toBeUndefined();
    expect(runtime.adapter.recall).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();

    setSessionMemoryOff("session-1", false);
    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "next question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);
  });

  it("claims an off input's identity immediately so a later duplicate before_agent_start for that same input never retroactively recalls once /memory is turned back on", async () => {
    const runtime = makeRuntime();
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    setSessionMemoryOff("session-1", true);
    noteOrdinaryInput("session-1", "old question");

    // First callback for the off input: zero runtime/provider I/O.
    const first = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "old question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(first).toBeUndefined();
    expect(runtime.adapter.recall).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();

    // A duplicate before_agent_start for the same still-unsettled input (e.g. tool-loop or
    // retry re-entry) while still off: still zero I/O.
    const second = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "old question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(second).toBeUndefined();
    expect(runtime.adapter.recall).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();

    // Memory comes back on, but no new input was submitted: the pending input identity is
    // still the same already-claimed "old question". A late duplicate callback for it
    // (e.g. a delayed retry landing after the user flips /memory on) must not retroactively
    // recall.
    setSessionMemoryOff("session-1", false);
    const third = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "old question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(third).toBeUndefined();
    expect(runtime.adapter.recall).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();

    // Only a genuinely new, separately submitted ordinary input is eligible for Recall.
    noteOrdinaryInput("session-1", "new question");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "new question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(1);
  });

  it("does not share input sequence or claimed recall identities across sessions", async () => {
    const runtime = makeRuntime();
    runtime.adapter.recall.mockResolvedValue({ ok: true, value: [] });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteInputEvent("session-a", { type: "input", text: "hi", source: "interactive" });
    noteInputEvent("session-b", { type: "input", text: "hi", source: "interactive" });
    expect(getSessionState("session-a").pendingOrdinaryInput?.inputKey).not.toBe(
      getSessionState("session-b").pendingOrdinaryInput?.inputKey,
    );

    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext({ sessionId: "session-a" }) as any,
    );
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext({ sessionId: "session-b" }) as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(2);
  });

  it("does nothing in non-tui modes", async () => {
    const ctx = makeContext({ mode: "rpc" });
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
  });

  function seedLocalMemory(
    runtime: ReturnType<typeof makeRuntime>,
    opts: {
      scope: "profile" | "project";
      text: string;
      memoryType?: "preference" | "habit" | "project_fact" | "decision" | "lesson" | "task_state" | "inference";
      projectIdentity?: string;
      verificationState?: "verified" | "unverified";
      id?: string;
    },
  ) {
    const id = opts.id ?? randomUUID();
    const textHash = sha256(opts.text);
    const memoryType = opts.memoryType ?? (opts.scope === "profile" ? "preference" : "project_fact");
    const verificationState =
      opts.verificationState ?? (memoryType === "inference" ? "unverified" : "verified");
    const projectIdentity = opts.scope === "project" ? (opts.projectIdentity ?? "repo") : null;
    const documentId = buildOwnedDocumentId(opts.scope, projectIdentity, memoryType, id);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const updatedAt = new Date(Date.now() - 30_000).toISOString();
    const expiresAt =
      opts.scope === "project"
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null;
    runtime.repos.memories.create({
      id,
      scope: opts.scope,
      memoryType,
      projectIdentity,
      bankId: opts.scope === "profile" ? runtime.profileBankId : projectBankId(projectIdentity!),
      documentId,
      unitId: `u-${id.slice(0, 8)}`,
      textHash,
      textLength: opts.text.length,
      verificationState,
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt,
      createdAt,
      updatedAt,
      lastVerifiedAt: verificationState === "verified" ? updatedAt : null,
    });
    return {
      id,
      text: opts.text,
      documentId,
      textHash,
      createdAt,
      updatedAt,
      expiresAt,
      projectIdentity,
      memoryType,
      verificationState,
      recallItem: (scores: { final: number; reranker: number | null; semantic: number | null; keyword: number | null } | null) => ({
        id: `r-${id.slice(0, 8)}`,
        text: opts.text,
        type: "world" as const,
        documentId,
        metadata: {
          logical_id: id,
          content_hash: textHash,
          scope: opts.scope,
          memory_type: memoryType,
          verification_state: verificationState,
          created_at: createdAt,
          updated_at: updatedAt,
          ...(verificationState === "verified" ? { last_verified_at: updatedAt } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(projectIdentity ? { project_identity: projectIdentity } : {}),
        },
        tags: null,
        context: null,
        mentionedAt: null,
        scores,
      }),
    };
  }

  it("on 0.10.0 filters by semantic threshold authoritatively, keeps inclusive boundary, and sorts globally by semantic", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.10.0");
    const projectIdentity = "repo";
    const low = seedLocalMemory(runtime, { scope: "project", text: "Low relevance project note.", projectIdentity });
    const boundary = seedLocalMemory(runtime, { scope: "profile", text: "Boundary preference at exactly 0.5." });
    const highProfile = seedLocalMemory(runtime, { scope: "profile", text: "High relevance profile preference." });
    const highProject = seedLocalMemory(runtime, {
      scope: "project",
      text: "Slightly lower but still high project fact.",
      projectIdentity,
    });
    const nullSemantic = seedLocalMemory(runtime, { scope: "profile", text: "Null semantic preference." });

    runtime.adapter.recall.mockImplementation(async (input: { bankId: string }) => {
      expect(input).toMatchObject({ minScore: 0.5 });
      if (input.bankId === runtime.profileBankId) {
        return {
          ok: true,
          value: [
            boundary.recallItem({ final: 1, reranker: null, semantic: 0.5, keyword: null }),
            highProfile.recallItem({ final: 1, reranker: null, semantic: 0.9, keyword: null }),
            nullSemantic.recallItem({ final: 1, reranker: null, semantic: null, keyword: null }),
          ],
        };
      }
      return {
        ok: true,
        value: [
          low.recallItem({ final: 1, reranker: null, semantic: 0.49, keyword: null }),
          highProject.recallItem({ final: 1, reranker: null, semantic: 0.8, keyword: null }),
        ],
      };
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: projectIdentity,
      bankId: projectBankId(projectIdentity),
    });

    noteOrdinaryInput("session-1");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "relevant?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result?.systemPrompt).toContain(highProfile.text);
    expect(result?.systemPrompt).toContain(highProject.text);
    expect(result?.systemPrompt).toContain(boundary.text);
    expect(result?.systemPrompt).not.toContain(low.text);
    expect(result?.systemPrompt).not.toContain(nullSemantic.text);
    expect(result?.systemPrompt?.indexOf(highProfile.text)).toBeLessThan(
      result?.systemPrompt?.indexOf(highProject.text) ?? Infinity,
    );
    expect(result?.systemPrompt?.indexOf(highProject.text)).toBeLessThan(
      result?.systemPrompt?.indexOf(boundary.text) ?? Infinity,
    );
    const last = getSessionState("session-1").lastRecall;
    expect(last?.items.map((item) => item.text)).toEqual([highProfile.text, highProject.text, boundary.text]);
  });

  it("on 0.10.0 caps at 3 items without padding from rejected scores, and zero threshold preserves null semantics under the cap", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.10.0");
    const items = [0.95, 0.9, 0.85, 0.8, 0.75].map((semantic, index) =>
      seedLocalMemory(runtime, { scope: "profile", text: `Eligible preference ${index} score ${semantic}.` }),
    );
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: items.map((item, index) =>
        item.recallItem({ final: 1, reranker: null, semantic: [0.95, 0.9, 0.85, 0.8, 0.75][index]!, keyword: null }),
      ),
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteOrdinaryInput("session-1");
    const capped = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "cap?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(getSessionState("session-1").lastRecall?.items).toHaveLength(3);
    expect(capped?.systemPrompt).toContain(items[0]!.text);
    expect(capped?.systemPrompt).toContain(items[2]!.text);
    expect(capped?.systemPrompt).not.toContain(items[3]!.text);

    runtime.minScore = 0;
    const nullItem = seedLocalMemory(runtime, { scope: "profile", text: "Null semantic allowed when disabled." });
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: [nullItem.recallItem({ final: 1, reranker: null, semantic: null, keyword: null })],
    });
    noteOrdinaryInput("session-1");
    const zeroThreshold = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "zero?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(zeroThreshold?.systemPrompt).toContain(nullItem.text);
    expect(runtime.adapter.recall.mock.calls.at(-1)?.[0]).toMatchObject({ minScore: 0 });
  });

  it("on 0.8.3 keeps legacy project-first ordering, max 10, and still passes minScore without semantic filtering", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.8.3");
    const projectIdentity = "repo";
    const profile = seedLocalMemory(runtime, { scope: "profile", text: "Legacy profile preference." });
    const project = seedLocalMemory(runtime, {
      scope: "project",
      text: "Legacy project fact.",
      projectIdentity,
    });
    runtime.adapter.recall.mockImplementation(async (input: { bankId: string; minScore?: number }) => {
      expect(input.minScore).toBe(0.5);
      if (input.bankId === runtime.profileBankId) {
        return { ok: true, value: [profile.recallItem(null)] };
      }
      return { ok: true, value: [project.recallItem(null)] };
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: projectIdentity,
      bankId: projectBankId(projectIdentity),
    });

    noteOrdinaryInput("session-1");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "legacy?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result?.systemPrompt?.indexOf(project.text)).toBeLessThan(
      result?.systemPrompt?.indexOf(profile.text) ?? Infinity,
    );
  });

  it("on 0.10.0 equal-semantic ties use approved governance order: verified, non-inference, project, then memoryId", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.10.0");
    const projectIdentity = "repo";
    const equal = { final: 1, reranker: null, semantic: 0.8, keyword: null } as const;
    const unverifiedProfile = seedLocalMemory(runtime, {
      scope: "profile",
      text: "Tie unverified profile preference.",
      verificationState: "unverified",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const verifiedProfile = seedLocalMemory(runtime, {
      scope: "profile",
      text: "Tie verified profile preference.",
      verificationState: "verified",
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const verifiedProject = seedLocalMemory(runtime, {
      scope: "project",
      text: "Tie verified project fact.",
      memoryType: "project_fact",
      projectIdentity,
      verificationState: "verified",
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const inferenceProject = seedLocalMemory(runtime, {
      scope: "project",
      text: "Tie unverified project inference.",
      memoryType: "inference",
      projectIdentity,
      verificationState: "unverified",
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    const idEarlier = seedLocalMemory(runtime, {
      scope: "profile",
      text: "Tie id-earlier verified preference.",
      verificationState: "verified",
      id: "11111111-1111-4111-8111-111111111111",
    });
    const idLater = seedLocalMemory(runtime, {
      scope: "profile",
      text: "Tie id-later verified preference.",
      verificationState: "verified",
      id: "99999999-9999-4999-8999-999999999999",
    });

    runtime.adapter.recall.mockImplementation(async (input: { bankId: string }) => {
      if (input.bankId === runtime.profileBankId) {
        // Deliberately shuffled so sort cannot rely on provider order.
        return {
          ok: true,
          value: [
            idLater.recallItem(equal),
            unverifiedProfile.recallItem(equal),
            verifiedProfile.recallItem(equal),
            idEarlier.recallItem(equal),
          ],
        };
      }
      return {
        ok: true,
        value: [inferenceProject.recallItem(equal), verifiedProject.recallItem(equal)],
      };
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: projectIdentity,
      bankId: projectBankId(projectIdentity),
    });

    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "ties?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    // Cap 3: verified project, then verified profiles by memoryId ascending (id-earlier before id-later
    // and before verifiedProfile whose id starts with 'b').
    expect(getSessionState("session-1").lastRecall?.items.map((item) => item.text)).toEqual([
      verifiedProject.text,
      idEarlier.text,
      idLater.text,
    ]);

    // Second claim with only the remaining equal-score items proves type/scope/verification tails.
    runtime.adapter.recall.mockImplementation(async (input: { bankId: string }) => {
      if (input.bankId === runtime.profileBankId) {
        return {
          ok: true,
          value: [unverifiedProfile.recallItem(equal), verifiedProfile.recallItem(equal)],
        };
      }
      return { ok: true, value: [inferenceProject.recallItem(equal)] };
    });
    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "ties-tail?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(getSessionState("session-1").lastRecall?.items.map((item) => item.text)).toEqual([
      verifiedProfile.text,
      unverifiedProfile.text,
      inferenceProject.text,
    ]);
  });

  it("on 0.8.3 caps exactly at 10 when more than 10 short eligible items are available", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.8.3");
    const items = Array.from({ length: 12 }, (_, index) =>
      seedLocalMemory(runtime, {
        scope: "profile",
        text: `L${String(index).padStart(2, "0")}`,
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      }),
    );
    runtime.adapter.recall.mockResolvedValue({
      ok: true,
      value: items.map((item) => item.recallItem(null)),
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteOrdinaryInput("session-1");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "legacy-cap?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    const injected = getSessionState("session-1").lastRecall?.items ?? [];
    expect(injected).toHaveLength(10);
    expect(injected.map((item) => item.text)).toEqual(items.slice(0, 10).map((item) => item.text));
    expect(result?.systemPrompt).toContain("L00");
    expect(result?.systemPrompt).toContain("L09");
    expect(result?.systemPrompt).not.toContain("L10");
    expect(result?.systemPrompt).not.toContain("L11");
    // Short texts must not hit the ~1500-token ceiling before the item cap.
    expect(estimateTokens(result?.systemPrompt ?? "")).toBeLessThan(1500);
  });

  it("clears stale /memory last on a newer claimed input with no injectable result", async () => {
    const runtime = makeRuntime();
    runtime.minScore = 0.5;
    runtime.adapter.getNegotiatedApiVersion.mockReturnValue("0.10.0");
    const kept = seedLocalMemory(runtime, { scope: "profile", text: "Previously injected preference." });
    runtime.adapter.recall.mockResolvedValueOnce({
      ok: true,
      value: [kept.recallItem({ final: 1, reranker: null, semantic: 0.9, keyword: null })],
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "first", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(getSessionState("session-1").lastRecall?.items).toHaveLength(1);

    runtime.adapter.recall.mockResolvedValueOnce({
      ok: true,
      value: [kept.recallItem({ final: 1, reranker: null, semantic: 0.1, keyword: null })],
    });
    noteOrdinaryInput("session-1");
    const second = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "second", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(second).toBeUndefined();
    expect(getSessionState("session-1").lastRecall?.items).toEqual([]);
    expect(getSessionState("session-1").lastRecall?.promptPreview).toBe("second");
  });

  it("invalidates lastRecall before async work for sensitive prompts and provider failures", async () => {
    const runtime = makeRuntime();
    getSessionState("session-1").lastRecall = {
      injectedAt: "2026-01-01T00:00:00.000Z",
      promptPreview: "old",
      items: [
        {
          scope: "profile",
          memoryType: "preference",
          text: "stale",
          memoryId: "m1",
          readOnlyShared: false,
          scores: null,
        },
      ],
    };
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "Authorization: Bearer topsecret-token",
        systemPrompt: "BASE",
        systemPromptOptions: {} as any,
      },
      makeContext() as any,
    );
    expect(runtime.adapter.recall).not.toHaveBeenCalled();
    expect(getSessionState("session-1").lastRecall?.items).toEqual([]);

    runtime.adapter.recall.mockResolvedValue({ ok: false, reason: "timeout", category: "timeout" });
    noteOrdinaryInput("session-1");
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "provider fail", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(getSessionState("session-1").lastRecall?.items).toEqual([]);
    expect(getSessionState("session-1").lastRecall?.promptPreview).toBe("provider fail");
  });
});

describe("settled extraction lifecycle", () => {
  beforeEach(() => {
    resetAllSessionStateForTests();
    getGlobalRuntimeMock.mockReset();
    resolveProjectBankMock.mockReset();
  });

  afterEach(() => {
    shutdownSessionState("session-1");
  });

  it("extracts only latest-turn text material, uses an isolated model call, and persists one deduped batch", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });

    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockResolvedValue(
      assistantText(
        JSON.stringify({
          candidates: [
            { scope: "project", memory_type: "decision", text: "Use Vitest for automated tests.", evidence: "The assistant described the repo test stack." },
            { scope: "project", memory_type: "decision", text: "Use Vitest for automated tests.", evidence: "duplicate" },
          ],
        }),
      ),
    );

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 7, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "older question", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 } as any,
          { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "secret output" }], isError: false, timestamp: 3 },
          { role: "user", content: [{ type: "text", text: "latest question" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 4 },
          { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "latest answer" }], timestamp: 5 } as any,
        ],
      } as any,
      ctx as any,
    );
    const snapshot = getSessionState("session-1").pendingExtraction;
    expect(snapshot?.material).toContain("latest question");
    expect(snapshot?.material).toContain("latest answer");
    expect(snapshot?.material).not.toContain("older question");
    expect(snapshot?.material).not.toContain("secret output");
    expect(snapshot?.material).not.toContain("hidden");
    expect(JSON.stringify(snapshot)).not.toContain("messages");

    await Promise.all([
      handleAgentSettled({ type: "agent_settled" }, ctx as any),
      handleAgentSettled({ type: "agent_settled" }, ctx as any),
    ]);

    expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
    const [modelArg, modelContext, options] = (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(modelArg).toBe(ctx.model);
    expect(modelContext.tools).toBeUndefined();
    expect(modelContext.messages[0].content).toContain("latest question");
    expect(modelContext.messages[0].content).toContain("latest answer");
    expect(modelContext.messages[0].content).not.toContain("older question");
    expect(modelContext.messages[0].content).not.toContain("secret output");
    expect(options.sessionId).toMatch(/^memory-extract:/);
    expect(options.maxRetries).toBe(0);
    expect(options.maxTokens).toBe(800);
    expect(options.timeoutMs).toBe(30000);

    const pending = runtime.repos.candidates.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.source_ref).toBe("turn:7");
    expect(runtime.repos.usage.listRecent(1)[0]?.model_id).toBe("provider-x/model-x");
    expect(Object.keys(runtime.repos.audit.listRecent(1)[0] ?? {})).not.toContain("text");
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("aborts cleanly on shutdown and never writes candidates after late model completion", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    let resolveModel!: (value: AssistantMessage) => void;
    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<AssistantMessage>((resolve) => {
          resolveModel = resolve;
        }),
    );

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "remember this preference", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "I will remember it later." }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );

    const settled = handleAgentSettled({ type: "agent_settled" }, ctx as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
    const usageBefore = runtime.repos.usage.listRecent(10).length;
    const auditBefore = runtime.repos.audit.listRecent(10).length;
    const candidatesBefore = runtime.repos.candidates.listPending().length;
    shutdownSessionState("session-1");
    resolveModel(
      assistantText(JSON.stringify({ candidates: [{ scope: "profile", memory_type: "preference", text: "Prefer terse answers." }] })),
    );
    await settled;

    expect(runtime.repos.candidates.listPending()).toHaveLength(candidatesBefore);
    expect(runtime.repos.audit.listRecent(10)).toHaveLength(auditBefore);
    expect(runtime.repos.usage.listRecent(10)).toHaveLength(usageBefore);
  });

  it("late model error after shutdown writes zero usage/audit/candidates rows", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    let rejectModel!: (error: Error) => void;
    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          rejectModel = reject;
        }),
    );

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "remember this preference in a durable way please", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "I will remember it later in a durable way." }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );

    const settled = handleAgentSettled({ type: "agent_settled" }, ctx as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const usageBefore = runtime.repos.usage.listRecent(10).length;
    const auditBefore = runtime.repos.audit.listRecent(10).length;
    const candidatesBefore = runtime.repos.candidates.listPending().length;
    shutdownSessionState("session-1");
    rejectModel(new Error("late failure"));
    await settled;

    expect(runtime.repos.candidates.listPending()).toHaveLength(candidatesBefore);
    expect(runtime.repos.audit.listRecent(10)).toHaveLength(auditBefore);
    expect(runtime.repos.usage.listRecent(10)).toHaveLength(usageBefore);
  });

  it("rejects abnormal or unsafe model output with zero rows", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...assistantText('{"candidates": []}'),
      content: [
        { type: "text", text: '{"candidates":[{"scope":"profile","memory_type":"preference","text":"x"}]}' },
        { type: "thinking", thinking: "nope" },
      ],
    });

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "safe request with enough length to pass the minimum material threshold", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "safe answer with enough length to pass the minimum material threshold" }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );
    await handleAgentSettled({ type: "agent_settled" }, ctx as any);

    expect(runtime.repos.candidates.listPending()).toHaveLength(0);
  });

  it("does not call the model when ctx.signal is already aborted", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ signal: controller.signal });

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "this is long enough to qualify as extraction material", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "this is also long enough to qualify as extraction material" }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );
    await handleAgentSettled({ type: "agent_settled" }, ctx as any);
    expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
    expect(runtime.repos.candidates.listPending()).toHaveLength(0);
  });

  it("dedupes against pending and active memories using the raw trimmed hash contract", async () => {
    const runtime = makeRuntime();
    const text = "Keep answers concise.";
    const hash = sha256(text);
    const memoryId = "dedupe-active-1";
    runtime.repos.memories.create({
      id: memoryId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", memoryId),
      unitId: "u1",
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Keep answers concise.",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockResolvedValue(
      assistantText(JSON.stringify({ candidates: [{ scope: "profile", memory_type: "preference", text }] })),
    );

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "please remember my preference in a durable way", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "I will keep answers concise." }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );
    await handleAgentSettled({ type: "agent_settled" }, ctx as any);
    expect(runtime.repos.candidates.listPending()).toHaveLength(1);
  });

  it("rolls back the whole candidate batch and audits on insertion failure", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const originalCreate = runtime.repos.candidates.create.bind(runtime.repos.candidates);
    let calls = 0;
    runtime.repos.candidates.create = ((input: any) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("boom");
      }
      return originalCreate(input);
    }) as typeof runtime.repos.candidates.create;

    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockResolvedValue(
      assistantText(
        JSON.stringify({
          candidates: [
            { scope: "profile", memory_type: "preference", text: "Prefer short answers." },
            { scope: "profile", memory_type: "habit", text: "Often asks for tests." },
          ],
        }),
      ),
    );

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "my preferences are stable and worth remembering", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "you prefer short answers and often ask for tests" }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );

    await expect(handleAgentSettled({ type: "agent_settled" }, ctx as any)).rejects.toThrow("boom");
    expect(runtime.repos.candidates.listPending()).toHaveLength(0);
    expect(runtime.repos.audit.listRecent(10).filter((row) => row.outcome === "candidate_created")).toHaveLength(0);
  });

  it("does not block agent_settled on automatic maintenance", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    let maintenanceFinished = false;
    const maintenanceSpy = vi
      .spyOn(await import("../src/governance/cleanup-service.js"), "maybeRunAutomaticMaintenance")
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        maintenanceFinished = true;
      });
    const ctx = makeContext();
    (ctx.modelRegistry.complete as ReturnType<typeof vi.fn>).mockResolvedValue(
      assistantText(JSON.stringify({ candidates: [] })),
    );
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "this is long enough to qualify as extraction material", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "this is also long enough to qualify as extraction material" }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );
    const started = Date.now();
    await handleAgentSettled({ type: "agent_settled" }, ctx as any);
    expect(Date.now() - started).toBeLessThan(35);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(maintenanceFinished).toBe(true);
    maintenanceSpy.mockRestore();
  });

  it("does nothing in print/json/rpc modes", async () => {
    for (const mode of ["print", "json", "rpc"] as const) {
      const ctx = makeContext({ mode });
      handleAgentEnd(
        {
          type: "agent_end",
          messages: [
            { role: "user", content: "hello", timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "world" }], timestamp: 2 } as any,
          ],
        } as any,
        ctx as any,
      );
      await handleAgentSettled({ type: "agent_settled" }, ctx as any);
      expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    }
  });
});

describe("extraction material selection", () => {
  it("uses only the latest real user text and the final visible assistant text", () => {
    const material = selectExtractionMaterial([
      { role: "user", content: "older", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 } as any,
      { role: "user", content: [{ type: "text", text: "latest user" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "retry answer" }], timestamp: 4 } as any,
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final answer" }], timestamp: 5 } as any,
      { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: 6 } as any,
    ] as any);
    expect(material).toContain("latest user");
    expect(material).toContain("final answer");
    expect(material).not.toContain("older");
    expect(material).not.toContain("retry answer");
    expect(material).not.toContain("tool output");
  });

  it("skips when there is no user text or no final visible assistant text", () => {
    expect(selectExtractionMaterial([{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1 } as any])).toBe("");
    expect(
      selectExtractionMaterial([
        { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }], timestamp: 2 } as any,
      ] as any),
    ).toBe("");
  });

  it("does not pair a trailing new user with a previous-turn assistant", () => {
    expect(
      selectExtractionMaterial([
        { role: "user", content: "older user", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "older assistant" }], timestamp: 2 } as any,
        { role: "user", content: "new user without answer yet", timestamp: 3 },
      ] as any),
    ).toBe("");
  });
});

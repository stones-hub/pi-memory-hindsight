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
  noteTurnStart,
  peekSessionState,
  resetAllSessionStateForTests,
  shutdownSessionState,
} from "../src/runtime/session-runtime.js";

const { getGlobalRuntimeMock, resolveProjectBankMock } = vi.hoisted(() => ({
  getGlobalRuntimeMock: vi.fn(),
  resolveProjectBankMock: vi.fn(),
}));

vi.mock("../src/runtime/global-runtime.js", () => ({
  getGlobalRuntime: getGlobalRuntimeMock,
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
    adapter: {
      recall: vi.fn(),
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

  it("registered session_start and turn_start do no work outside tui, and shutdown does not create state", async () => {
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    const sessionStart = handlers.get("session_start");
    const turnStart = handlers.get("turn_start");
    const shutdown = handlers.get("session_shutdown");
    if (!sessionStart || !turnStart || !shutdown) throw new Error("missing handlers");

    for (const mode of ["print", "json", "rpc"] as const) {
      const sessionId = `non-tui-${mode}`;
      expect(peekSessionState(sessionId)).toBeUndefined();
      const ctx = makeContext({ mode, sessionId });
      await sessionStart({ type: "session_start", reason: "startup" }, ctx);
      await turnStart({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
      await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
      expect(peekSessionState(sessionId)).toBeUndefined();
    }
  });

  it("package manifest exposes the packed Pi extension entrypoint", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { pi: { extensions: string[] }; keywords: string[] };
    expect(pkg.pi.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.keywords).toContain("pi-package");

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd(), encoding: "utf8" }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = new Set((packed[0]?.files ?? []).map((file) => `./${file.path}`));
    for (const extensionPath of pkg.pi.extensions) {
      expect(packedPaths.has(extensionPath)).toBe(true);
    }
  });
});

describe("automatic recall lifecycle", () => {
  beforeEach(() => {
    resetAllSessionStateForTests();
    getGlobalRuntimeMock.mockReset();
    resolveProjectBankMock.mockReset();
  });

  it("recalls at most once per turn, then allows the next turn, with project results ranked before profile", async () => {
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
    await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "And build?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(runtime.adapter.recall).toHaveBeenCalledTimes(4);
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "question", systemPrompt: "BASE", systemPromptOptions: {} as any },
      makeContext() as any,
    );
    expect(result).toBeUndefined();
  });

  it("atomically claims a turn before awaits so concurrent calls and same-turn failures do not retry, but a new turn can", async () => {
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
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

    noteTurnStart("session-1", { type: "turn_start", turnIndex: 3, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 4, timestamp: Date.now() });
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
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
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

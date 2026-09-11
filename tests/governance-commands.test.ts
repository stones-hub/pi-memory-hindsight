import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import extension from "../src/index.js";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import { approveCandidate, type CandidateScopeContext } from "../src/governance/candidate-service.js";
import { forgetIdempotencyKey } from "../src/governance/mutation-ownership.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import { projectForgetCtx } from "./forget-test-context.js";
import { reflectMemory } from "../src/governance/reflect-service.js";
import { remember } from "../src/governance/remember-service.js";
import { parseMemoryCommand } from "../src/commands/memory-command-parser.js";
import { t } from "../src/i18n/messages.js";
import { createCandidateReviewer } from "../src/ui/candidate-reviewer.js";
import { getSessionState, noteTurnStart, resetAllSessionStateForTests, setSessionMemoryOff } from "../src/runtime/session-runtime.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";
import { handleAgentEnd, handleAgentSettled } from "../src/extraction/extraction-service.js";

const PROFILE_SCOPE: CandidateScopeContext = { projectIdentity: null, projectScopeEnabled: false };

const { getGlobalRuntimeMock, getLocalRuntimeMock, peekCachedLocalRuntimeMock, resolveProjectBankMock } = vi.hoisted(() => ({
  getGlobalRuntimeMock: vi.fn(),
  getLocalRuntimeMock: vi.fn(),
  peekCachedLocalRuntimeMock: vi.fn(),
  resolveProjectBankMock: vi.fn(),
}));

vi.mock("../src/runtime/global-runtime.js", () => ({
  getGlobalRuntime: getGlobalRuntimeMock,
  getLocalRuntime: getLocalRuntimeMock,
  peekCachedLocalRuntime: peekCachedLocalRuntimeMock,
}));

vi.mock("../src/runtime/project-runtime.js", () => ({
  resolveProjectBank: resolveProjectBankMock,
}));

function makeRuntime() {
  const db = MemoryDatabase.openInMemory();
  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  return {
    agentDir: "/tmp/pi-agent",
    db,
    hindsightUrl: "http://127.0.0.1:8888",
    profile,
    profileBankId: profileBankId(profile.anonymous_profile_id),
    adapter: {
      ensureOwnedBank: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      retainOneMemory: vi.fn().mockResolvedValue({ ok: true, value: { unitId: "unit-1" } }),
      verifyOneUnitDocument: vi.fn().mockResolvedValue({ ok: false, reason: "missing", category: "http", status: 404 }),
      deleteMemoryDocument: vi.fn().mockResolvedValue({
        ok: true,
        value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 },
      }),
      verifyDeletionPostconditions: vi.fn().mockResolvedValue({ ok: true, value: { absent: true } }),
      fetchExactOneUnitDocument: vi.fn().mockResolvedValue({
        ok: true,
        value: { text: "Prefer concise answers.", unitId: "unit-1", metadata: null },
      }),
      reflect: vi.fn().mockResolvedValue({ ok: true, value: { text: "Reflect result" } }),
    },
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
}

function makeContext(overrides: Partial<any> = {}) {
  return {
    mode: overrides.mode ?? "tui",
    cwd: overrides.cwd ?? "/repo",
    signal: overrides.signal,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn().mockResolvedValue("edited memory"),
      custom: vi.fn().mockResolvedValue(undefined),
    },
    model: { id: "model-1" },
    modelRegistry: { complete: vi.fn() },
    sessionManager: {
      getSessionId: () => overrides.sessionId ?? "session-1",
      getBranch: () => [],
      getEntries: () => [],
    },
  };
}

function helpListsExecutableExtract(help: string): boolean {
  return help.split("\n").some((line) => /^\s*\/memory extract(?:\s|$)/.test(line));
}

function captureExtension() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const appendEntry = vi.fn();
  extension({
    on: vi.fn(),
    appendEntry,
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: (def: any) => tools.set(def.name, def),
  } as any);
  return { commands, tools, appendEntry };
}

describe("slice 4 governance commands and tools", () => {
  beforeEach(() => {
    resetAllSessionStateForTests();
    getGlobalRuntimeMock.mockReset();
    getLocalRuntimeMock.mockReset();
    peekCachedLocalRuntimeMock.mockReset();
    resolveProjectBankMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly one memory command and one memory_remember tool", () => {
    const { commands, tools } = captureExtension();
    expect(commands.has("memory")).toBe(true);
    expect(tools.has("memory_remember")).toBe(true);
    expect([...commands.keys()].filter((name) => name === "memory")).toHaveLength(1);
    expect([...tools.keys()].filter((name) => name === "memory_remember")).toHaveLength(1);
  });

  it("parses multi-word and unicode remainder exactly, without shell interpretation", () => {
    expect(parseMemoryCommand("remember profile preference  保留  多词 内容  ")).toEqual({
      kind: "remember",
      scope: "profile",
      memoryType: "preference",
      content: "保留  多词 内容",
    });
    expect(parseMemoryCommand("reflect project \n多行 查询\n第二行  ")).toEqual({
      kind: "reflect",
      scope: "project",
      query: "多行 查询\n第二行",
    });
    expect(parseMemoryCommand("candidates edit-approve abc  line1\nline2 && rm -rf /")).toEqual({
      kind: "candidates-edit-approve",
      id: "abc",
      content: "line1\nline2 && rm -rf /",
    });
    expect(parseMemoryCommand("status extra")).toBeNull();
    expect(parseMemoryCommand("forget one two")).toBeNull();
    expect(parseMemoryCommand("update mem-1  corrected content  ")).toEqual({
      kind: "update",
      id: "mem-1",
      content: "corrected content",
    });
    expect(parseMemoryCommand("update")).toBeNull();
    expect(parseMemoryCommand("update only-id")).toBeNull();
    expect(parseMemoryCommand("extract")).toBeNull();
    expect(parseMemoryCommand("extract extra")).toBeNull();
    expect(parseMemoryCommand("")).toEqual({ kind: "help" });
    expect(parseMemoryCommand("help")).toEqual({ kind: "help" });
    expect(parseMemoryCommand("help extra")).toBeNull();
    expect(helpListsExecutableExtract(t("en", "memory.help"))).toBe(false);
    expect(helpListsExecutableExtract(t("zh", "memory.help"))).toBe(false);
  });

  it("treats bare extract as an unknown command and shows help", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "en";
    peekCachedLocalRuntimeMock.mockReturnValue({ ok: true, runtime });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    const notify = vi.fn();
    ctx.ui.notify = notify;
    await command!.handler("extract", ctx);
    await command!.handler("extract extra", ctx);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0]).toBe(t("en", "memory.help"));
    expect(notify.mock.calls[0]?.[1]).toBe("error");
    expect(notify.mock.calls[1]?.[0]).toBe(t("en", "memory.help"));
    expect(notify.mock.calls[1]?.[1]).toBe("error");
    expect(getLocalRuntimeMock).not.toHaveBeenCalled();
  });

  it("parses exact help, renders the same detailed help for /memory help and bare /memory, and stays read-only", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "zh";
    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Keep help read-only.",
      evidenceSummary: "explicit",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    const auditBefore = runtime.repos.audit.listRecent(20).length;
    peekCachedLocalRuntimeMock.mockReturnValue({ ok: true, runtime });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    await command!.handler("help", ctx);
    await command!.handler("", ctx);
    await command!.handler("help extra", ctx);
    await command!.handler("not-a-command", ctx);

    const zhHelp = t("zh", "memory.help");
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify.mock.calls[0]?.[0]).toBe(zhHelp);
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    expect(notify.mock.calls[1]?.[0]).toBe(zhHelp);
    expect(notify.mock.calls[1]?.[1]).toBe("info");
    expect(notify.mock.calls[2]?.[0]).toBe(zhHelp);
    expect(notify.mock.calls[2]?.[1]).toBe("error");
    expect(notify.mock.calls[3]?.[0]).toBe(zhHelp);
    expect(notify.mock.calls[3]?.[1]).toBe("error");
    expect(getLocalRuntimeMock).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(runtime.adapter.reflect).not.toHaveBeenCalled();
    expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("pending");
    expect(runtime.repos.audit.listRecent(20)).toHaveLength(auditBefore);
  });

  it("help does not initialize local runtime and falls back to English without a successful cache", async () => {
    peekCachedLocalRuntimeMock.mockReturnValue(undefined);
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    await command!.handler("help", ctx);
    await command!.handler("", ctx);

    expect(notify.mock.calls).toEqual([
      [t("en", "memory.help"), "info"],
      [t("en", "memory.help"), "info"],
    ]);
    expect(getLocalRuntimeMock).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(peekCachedLocalRuntimeMock).toHaveBeenCalled();
  });

  it("renders English help when local runtime is unavailable and still skips provider I/O", async () => {
    peekCachedLocalRuntimeMock.mockReturnValue({ ok: false, reason: "sqlite unavailable" });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    const notify = vi.fn();
    ctx.ui.notify = notify;

    await command!.handler("help", ctx);
    await command!.handler("", ctx);
    await command!.handler("extract", ctx);

    expect(notify.mock.calls).toEqual([
      [t("en", "memory.help"), "info"],
      [t("en", "memory.help"), "info"],
      [t("en", "memory.help"), "error"],
    ]);
    expect(getLocalRuntimeMock).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
  });

  it("does not render help outside TUI mode", async () => {
    const { commands } = captureExtension();
    const command = commands.get("memory");
    for (const mode of ["rpc", "json", "print"]) {
      const ctx = makeContext({ mode });
      await command!.handler("help", ctx);
      await command!.handler("", ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    }
    expect(getLocalRuntimeMock).not.toHaveBeenCalled();
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
  });

  it("routes /memory update and tool update through the shared replace path", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    const original = "Old preference text.";
    const target = runtime.repos.memories.create({
      id: "upd-1",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "upd-1"),
      unitId: "unit-1",
      textHash: createHash("sha256").update(original).digest("hex"),
      textLength: original.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const { commands, tools } = captureExtension();
    const command = commands.get("memory");
    const tool = tools.get("memory_remember");
    const ctx = makeContext();

    await command.handler("update upd-1 New preference from command.", ctx);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.retainOneMemory.mock.calls[0]![0].documentId).toBe(target.document_id);
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(
      createHash("sha256").update("New preference from command.").digest("hex"),
    );

    runtime.adapter.retainOneMemory.mockClear();
    const toolResult = await tool.execute(
      "call-update",
      {
        action: "update",
        targetMemoryId: "upd-1",
        content: "New preference from tool.",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(toolResult.details.outcome).toBe("replaced");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.retainOneMemory.mock.calls[0]![0].documentId).toBe(target.document_id);
  });

  it("rejects malformed tool create/update combinations before provider I/O", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    const { tools } = captureExtension();
    const tool = tools.get("memory_remember");
    const ctx = makeContext();

    const cases = [
      { action: "create", targetMemoryId: "x", scope: "profile", memoryType: "preference", content: "x" },
      { action: "create", content: "missing scope" },
      { action: "update", content: "missing target" },
      { action: "update", targetMemoryId: "x", scope: "profile", content: "no scope allowed" },
      { action: "update", targetMemoryId: "x", memoryType: "preference", content: "no type allowed" },
    ];
    for (const params of cases) {
      const result = await tool.execute("bad", params, undefined, undefined, ctx);
      expect(result.details.outcome).toBe("rejected");
    }
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
  });

  it("rejects command update for unknown or non-active targets before provider I/O", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    runtime.repos.memories.create({
      id: "deleted-1",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "deleted-1"),
      unitId: "u",
      textHash: "c".repeat(64),
      textLength: 4,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      status: "deleted",
    });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();

    await command.handler("update missing-id New text.", ctx);
    await command.handler("update deleted-1 New text.", ctx);
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("rejects command and tool mutations outside tui mode", async () => {
    const { commands, tools } = captureExtension();
    const command = commands.get("memory");
    const tool = tools.get("memory_remember");
    const ctx = makeContext({ mode: "rpc" });

    await command.handler("remember profile preference keep it", ctx);
    const toolResult = await tool.execute("call-1", {
      action: "create",
      scope: "profile",
      memoryType: "preference",
      content: "Keep it",
    }, undefined, undefined, ctx);

    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(toolResult.details).toEqual({ outcome: "unsupported_mode" });
  });

  it("persists /memory off and on per session only, without runtime initialization", async () => {
    const { commands, appendEntry } = captureExtension();
    const command = commands.get("memory");
    const ctxA = makeContext({ sessionId: "a" });
    const ctxB = makeContext({ sessionId: "b" });

    await command.handler("off", ctxA);
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(getSessionState("a").memoryOff).toBe(true);
    expect(getSessionState("b").memoryOff).toBe(false);
    expect(appendEntry).toHaveBeenLastCalledWith("pi-memory-hindsight:session-state", { v: 1, memoryOff: true });

    await command.handler("on", ctxA);
    expect(getSessionState("a").memoryOff).toBe(false);
    expect(appendEntry).toHaveBeenLastCalledWith("pi-memory-hindsight:session-state", { v: 1, memoryOff: false });
    expect(getSessionState("b").memoryOff).toBe(false);
  });

  it("queued settled extraction does zero work once session memory is turned off", async () => {
    const runtime = makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const ctx = makeContext();
    noteTurnStart("session-1", { type: "turn_start", turnIndex: 1, timestamp: Date.now() } as any);
    handleAgentEnd(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "this is long enough to become pending extraction material", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "this answer is also long enough to become extraction material" }], timestamp: 2 } as any,
        ],
      } as any,
      ctx as any,
    );
    setSessionMemoryOff("session-1", true);
    await handleAgentSettled({ type: "agent_settled" } as any, ctx as any);
    expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
  });

  it("command, tool, and candidate approval share the same remember path semantics", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });
    const { commands, tools } = captureExtension();
    const command = commands.get("memory");
    const tool = tools.get("memory_remember");
    const ctx = makeContext();

    await command.handler("remember profile preference Prefer concise answers.", ctx);
    await tool.execute("call-1", {
      action: "create",
      scope: "profile",
      memoryType: "habit",
      content: "Often asks for terse code reviews.",
    }, undefined, undefined, ctx);
    const candidate = runtime.repos.candidates.create({
      scope: "project",
      memoryType: "decision",
      text: "Use bilingual UI labels.",
      evidenceSummary: "Explicit request",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: "repo",
    });
    const approval = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      scopeContext: { projectIdentity: "repo", projectScopeEnabled: true },
      sourceSessionId: "session-1",
    });

    expect(approval.outcome).toBe("approved");
    expect(runtime.adapter.ensureOwnedBank).toHaveBeenCalledTimes(3);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(3);
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(2);
    expect(runtime.repos.memories.listActive("project", "repo")).toHaveLength(1);
    expect(runtime.repos.audit.listRecent(10).map((row) => row.event_type)).toContain("remember");
  });

  it("opens candidates reviewer through ui.custom and supports text listing", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Keep replies concise.",
      evidenceSummary: "Stable preference",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();

    await command.handler("candidates", ctx);
    await command.handler("candidates list", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Keep replies concise."), "info");
  });

  it("candidate approval remains retryable on ambiguous provider write", async () => {
    const runtime = makeRuntime();
    runtime.adapter.retainOneMemory.mockResolvedValue({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Prefer tests first.",
      evidenceSummary: "Explicit",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });

    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      scopeContext: PROFILE_SCOPE,
      sourceSessionId: "s1",
    });

    expect(result.outcome).toBe("retryable");
    expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("reconciling");
  });

  it("preserves provider metadata timestamps into the activated local row", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Use concise answers.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    const row = runtime.repos.memories.listActive("profile", null)[0]!;
    expect(row.created_at).toBe(row.updated_at);
    expect(row.last_verified_at).toBe(row.created_at);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_verified_at: row.last_verified_at,
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("reuses the original metadata byte-identically across ambiguous retain and retry verify success", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const retainBodies: Array<Record<string, string>> = [];
    runtime.adapter.retainOneMemory.mockImplementation(async (input: any) => {
      retainBodies.push(input.metadata);
      return { ok: false, reason: "timeout", category: "timeout", ambiguous: true };
    });
    runtime.adapter.verifyOneUnitDocument
      .mockResolvedValueOnce({ ok: false, reason: "missing", category: "http", status: 404 })
      .mockResolvedValueOnce({ ok: true, value: { unitId: "unit-1" } });

    const first = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Keep exact timestamps.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    const second = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Keep exact timestamps.",
      cwd: "/repo",
      sourceSessionId: "session-2",
      sourceRef: "turn:2",
      owner: "tool",
    });

    expect(first.outcome).toBe("unknown");
    expect(second.outcome).toBe("written");
    expect(retainBodies).toHaveLength(1);
    const row = runtime.repos.memories.listActive("profile", null)[0]!;
    expect(retainBodies[0]).toEqual({
      logical_id: row.id,
      content_hash: row.text_hash,
      scope: row.scope,
      memory_type: row.memory_type,
      verification_state: row.verification_state,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_verified_at: row.last_verified_at!,
      source_session_id: "session-1",
      source_ref: "turn:1",
    });
  });

  it("rejects invalid source metadata before any sqlite or provider write", async () => {
    const runtime = makeRuntime();
    const result = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Safe memory",
      cwd: "/repo",
      sourceSessionId: "bad session id with spaces",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(0);
  });

  it("reconciles ambiguous retain via verify before retrying, and reuses deterministic ids", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    runtime.adapter.retainOneMemory
      .mockResolvedValueOnce({ ok: false, reason: "timeout", category: "timeout", ambiguous: true })
      .mockResolvedValueOnce({ ok: true, value: { unitId: "unit-2" } });
    runtime.adapter.verifyOneUnitDocument
      .mockResolvedValueOnce({ ok: false, reason: "missing", category: "http", status: 404 })
      .mockResolvedValueOnce({ ok: true, value: { unitId: "unit-2" } });

    const first = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Remember me.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    const second = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Remember me.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });

    expect(first.outcome).toBe("unknown");
    expect(second.outcome).toBe("written");
    expect(runtime.adapter.verifyOneUnitDocument).toHaveBeenCalledTimes(2);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched existing operations without provider I/O", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const memoryId = "mismatch-op-memory";
    const memory = runtime.repos.memories.create({
      id: memoryId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", memoryId),
      unitId: null,
      textHash: "a".repeat(64),
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "reconciling",
    });
    runtime.repos.operations.tryCreate({
      idempotencyKey: `remember:profile:preference:-:${"a".repeat(64)}`,
      memoryId: memory.id,
      action: "delete",
      bankId: runtime.profileBankId,
      documentId: memory.document_id,
      expectedTextHash: "a".repeat(64),
    });

    const result = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "wrong",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
      idempotencyKey: `remember:profile:preference:-:${"a".repeat(64)}`,
    });

    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
  });

  it("allows multiple same-type distinct memories and converges concurrent duplicates honestly", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    let release!: () => void;
    runtime.adapter.retainOneMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, value: { unitId: "unit-1" } });
        }),
    );
    const p1 = remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Pref A",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
      idempotencyKey: "k1",
    });
    const p2 = remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Pref A",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "tool",
      idempotencyKey: "k2",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    const third = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Pref B",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:2",
      owner: "command",
    });
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(2);
    expect([a.outcome, b.outcome].sort()).toEqual(["in_progress", "written"]);
    expect(third.outcome).toBe("written");
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(2);
  });

  it("forgets only exact locally owned memory ids after verified delete", async () => {
    const runtime = makeRuntime();
    const text = "Use Vitest.";
    const hash = "b".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "known-id-1",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "known-id-1"),
      unitId: "unit-1",
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });

    const ok = await forgetMemory(runtime as any, memory.id);
    const missing = await forgetMemory(runtime as any, "missing");

    expect(ok.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(memory.id)?.status).toBe("deleted");
    expect(missing.outcome).toBe("rejected");
  });

  it("rejects invalid local locator before forget I/O and keeps active memory on definite delete failure", async () => {
    const runtime = makeRuntime();
    const invalid = runtime.repos.memories.create({
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: "bad-bank",
      documentId: "bad-doc",
      unitId: "unit-1",
      textHash: "c".repeat(64),
      textLength: 4,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    expect((await forgetMemory(runtime as any, invalid.id)).outcome).toBe("rejected");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();

    const valid = runtime.repos.memories.create({
      id: "known-id-valid",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "known-id-valid"),
      unitId: "unit-2",
      textHash: "d".repeat(64),
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: false,
      reason: "bad request",
      category: "http",
      status: 400,
      ambiguous: false,
    });
    expect((await forgetMemory(runtime as any, valid.id)).outcome).toBe("rejected");
    expect(runtime.repos.memories.getById(valid.id)?.status).toBe("active");
  });

  it("forgets project memory only when cwd project identity matches", async () => {
    const runtime = makeRuntime();
    const hash = "a".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-ok",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: projectBankId("repo"),
      documentId: buildOwnedDocumentId("project", "repo", "decision", "proj-forget-ok"),
      unitId: "unit-proj",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const ok = await forgetMemory(runtime as any, memory.id, projectForgetCtx("repo"));
    expect(ok.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(memory.id)?.status).toBe("deleted");
  });

  it("rejects cross-project forget before provider delete", async () => {
    const runtime = makeRuntime();
    const hash = "b".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-cross",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo-a",
      bankId: projectBankId("repo-a"),
      documentId: buildOwnedDocumentId("project", "repo-a", "decision", "proj-forget-cross"),
      unitId: "unit-cross",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const before = JSON.stringify(runtime.repos.memories.getById(memory.id));
    const result = await forgetMemory(runtime as any, memory.id, projectForgetCtx("repo-b"));
    expect(result).toEqual({
      outcome: "rejected",
      reason: "memory belongs to a different project identity",
    });
    expect(JSON.stringify(runtime.repos.memories.getById(memory.id))).toBe(before);
    expect(runtime.repos.operations.listByMemoryId(memory.id)).toHaveLength(0);
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });

  it("rejects project forget when cwd project scope is disabled", async () => {
    const runtime = makeRuntime();
    const hash = "c".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-disabled",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: projectBankId("repo"),
      documentId: buildOwnedDocumentId("project", "repo", "decision", "proj-forget-disabled"),
      unitId: "unit-disabled",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const result = await forgetMemory(runtime as any, memory.id, {
      projectIdentity: "repo",
      projectScopeEnabled: false,
    });
    expect(result).toEqual({
      outcome: "rejected",
      reason: "project memory forget is unavailable for the current project",
    });
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });

  it("rejects project forget when trusted context is omitted", async () => {
    const runtime = makeRuntime();
    const hash = "d".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-omitted",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: projectBankId("repo"),
      documentId: buildOwnedDocumentId("project", "repo", "decision", "proj-forget-omitted"),
      unitId: "unit-omitted",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const result = await forgetMemory(runtime as any, memory.id);
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });

  it("forget command resolves cwd project before delete", async () => {
    const runtime = makeRuntime();
    const hash = "e".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-cmd",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: projectBankId("repo"),
      documentId: buildOwnedDocumentId("project", "repo", "decision", "proj-forget-cmd"),
      unitId: "unit-cmd",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "repo",
      bankId: projectBankId("repo"),
      reason: "ok",
    });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    await command.handler(`forget ${memory.id}`, ctx);
    expect(runtime.repos.memories.getById(memory.id)?.status).toBe("deleted");
    expect(resolveProjectBankMock).toHaveBeenCalledWith(ctx.cwd);
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalled();
  });

  it("forget command rejects cross-project memory without provider delete", async () => {
    const runtime = makeRuntime();
    const hash = "f".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "proj-forget-cmd-cross",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo-a",
      bankId: projectBankId("repo-a"),
      documentId: buildOwnedDocumentId("project", "repo-a", "decision", "proj-forget-cmd-cross"),
      unitId: "unit-cmd-cross",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "repo-b",
      bankId: projectBankId("repo-b"),
      reason: "ok",
    });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();
    await command.handler(`forget ${memory.id}`, ctx);
    expect(runtime.repos.memories.getById(memory.id)?.status).toBe("active");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect((ctx.ui.notify as any).mock.calls.at(-1)?.[1]).toBe("error");
  });

  it("rejects corrupted but namespace-valid owned locators before forget provider I/O", async () => {
    const runtime = makeRuntime();
    const projectIdentity = "repo";
    const foreignBankId = projectBankId("other");
    const hash = "f".repeat(64);
    const memory = runtime.repos.memories.create({
      id: "foreign-id",
      scope: "project",
      memoryType: "decision",
      projectIdentity,
      bankId: foreignBankId,
      documentId: buildOwnedDocumentId("project", projectIdentity, "decision", "foreign-id"),
      unitId: "unit-4",
      textHash: hash,
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });

    const result = await forgetMemory(runtime as any, memory.id);
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });

  it("rejects mismatched existing delete operations before forget provider I/O", async () => {
    const runtime = makeRuntime();
    const memory = runtime.repos.memories.create({
      id: "mismatch-id",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "mismatch-id"),
      unitId: "unit-3",
      textHash: "e".repeat(64),
      textLength: 5,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    runtime.repos.operations.tryCreate({
      idempotencyKey: forgetIdempotencyKey(memory.id, memory.mutation_generation, memory.text_hash, memory.document_id),
      memoryId: memory.id,
      action: "create",
      bankId: memory.bank_id,
      documentId: memory.document_id,
      expectedTextHash: memory.text_hash,
      memoryGeneration: memory.mutation_generation,
    });

    const result = await forgetMemory(runtime as any, memory.id);
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });

  it("cancels reflect before any provider call when user does not confirm", async () => {
    const runtime = makeRuntime();
    const ctx = makeContext();
    ctx.ui.confirm.mockResolvedValue(false);
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });

    const result = await reflectMemory(runtime as any, ctx as any, "project", "What matters?");

    expect(result).toEqual({ outcome: "cancelled" });
    expect(runtime.adapter.reflect).not.toHaveBeenCalled();
  });

  it("rejects unsafe reflect query before project resolution/provider and keeps no persistence", async () => {
    const runtime = makeRuntime();
    const ctx = makeContext();
    const result = await reflectMemory(runtime as any, ctx as any, "project", "x".repeat(1201));
    expect(result.outcome).toBe("rejected");
    expect(resolveProjectBankMock).not.toHaveBeenCalled();
    expect(runtime.adapter.reflect).not.toHaveBeenCalled();
    expect(runtime.repos.audit.listRecent(10)).toHaveLength(0);
  });

  it("shows a distinct localized timeout message when reflect exceeds its own long-running ceiling", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "en";
    runtime.adapter.reflect.mockResolvedValue({
      ok: false,
      reason: "hindsight request timed out: POST /v1/default/banks/x/reflect",
      category: "timeout",
    });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });
    const ctx = makeContext();

    const result = await reflectMemory(runtime as any, ctx as any, "project", "What matters?");

    expect(result).toEqual({ outcome: "rejected", reason: t("en", "reflect.timeout") });
    expect(result).not.toEqual({ outcome: "rejected", reason: t("en", "reflect.failed") });
  });

  it("treats reflect's external cancellation as cancelled, not as a timeout or generic failure", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "en";
    runtime.adapter.reflect.mockResolvedValue({
      ok: false,
      reason: "hindsight request cancelled: POST /v1/default/banks/x/reflect",
      category: "aborted",
    });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });
    const ctx = makeContext();

    const result = await reflectMemory(runtime as any, ctx as any, "project", "What matters?");

    expect(result).toEqual({ outcome: "cancelled" });
  });

  it("keeps a generic redacted failure message for non-timeout, non-aborted reflect failures", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "en";
    runtime.adapter.reflect.mockResolvedValue({
      ok: false,
      reason: "hindsight reflect failed: HTTP 502",
      category: "http",
      status: 502,
    });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo", bankId: projectBankId("repo") });
    const ctx = makeContext();

    const result = await reflectMemory(runtime as any, ctx as any, "project", "What matters?");

    expect(result).toEqual({ outcome: "rejected", reason: t("en", "reflect.failed") });
  });

  it("candidate reviewer controller renders, filters, edits, rejects, and batch rejects safely", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "short low value",
      evidenceSummary: "e1",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      proposedAction: "ignore",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Often wants concise answers.",
      evidenceSummary: "e2",
      sourceSessionId: "s1",
      sourceRef: "turn:2",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    const ctx = makeContext();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    const reviewer = createCandidateReviewer({ runtime: runtime as any, ctx: ctx as any, language: "en", scopeContext: PROFILE_SCOPE });
    expect(reviewer.render(20).every((line) => line.length <= 20)).toBe(true);
    await reviewer.handleInput("j");
    await reviewer.handleInput("e");
    await reviewer.handleInput("a");
    await reviewer.handleInput("\t");
    await reviewer.handleInput("x");
    expect(ctx.ui.input).toHaveBeenCalled();
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(reviewer.render(30).length).toBeGreaterThan(0);
  });

  it("keeps local governance commands working when provider is unavailable, and recovers later", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    runtime.profile.language = "en";
    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Keep local governance alive.",
      evidenceSummary: "explicit",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: true, runtime });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();

    await command.handler("language zh", ctx);
    await command.handler("candidates list", ctx);
    await command.handler(`candidates reject ${candidate.id}`, ctx);
    await command.handler("status", ctx);
    await command.handler("remember profile preference remote path", ctx);
    await command.handler("remember profile preference remote path", ctx);

    expect(runtime.profile.language).toBe("zh");
    expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("rejected");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect((ctx.ui.notify as any).mock.calls.some((call: any[]) => call[1] === "error")).toBe(true);
  });

  it("passes cancellation signals into remember and forget and avoids provider mutation when pre-aborted", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const controller = new AbortController();
    controller.abort();

    const rememberResult = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Cancelled memory",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
      signal: controller.signal,
    });
    expect(rememberResult.outcome).toBe("unknown");
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();

    const memory = runtime.repos.memories.create({
      id: "cancel-test-id",
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", "cancel-test-id"),
      unitId: "unit-1",
      textHash: "1".repeat(64),
      textLength: 4,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const forgetResult = await forgetMemory(runtime as any, memory.id, { signal: controller.signal });
    expect(forgetResult.outcome).toBe("unknown");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(memory.id)?.status).toBe("active");
  });

  it("status reports localized project state without mutating banks", async () => {
    const runtime = makeRuntime();
    runtime.profile.language = "zh";
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValueOnce({ enabled: true, identity: "repo" });
    const { commands } = captureExtension();
    const command = commands.get("memory");
    const ctx = makeContext();

    await command.handler("status", ctx);
    const [[message]] = (ctx.ui.notify as any).mock.calls;
    expect(message).toContain("项目范围：已启用（repo）");
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
  });

  describe("candidates approve/edit-approve commands: zero provider I/O before authorization", () => {
    function makeProjectCandidate(runtime: ReturnType<typeof makeRuntime>) {
      return runtime.repos.candidates.create({
        scope: "project",
        memoryType: "project_fact",
        text: "The build uses pnpm workspaces.",
        evidenceSummary: "explicit",
        sourceSessionId: "s1",
        sourceRef: "turn:1",
        proposedAction: "create",
        targetMemoryId: null,
        projectIdentity: "repo-a",
      });
    }

    it("does not call getGlobalRuntime for 'candidates approve' against a mismatched-project candidate", async () => {
      const runtime = makeRuntime();
      const candidate = makeProjectCandidate(runtime);
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo-b", bankId: projectBankId("repo-b") });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates approve ${candidate.id}`, ctx);

      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("pending");
      expect((ctx.ui.notify as any).mock.calls.at(-1)?.[1]).toBe("error");
    });

    it("does not call getGlobalRuntime for 'candidates approve' when the current project is disabled", async () => {
      const runtime = makeRuntime();
      const candidate = makeProjectCandidate(runtime);
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates approve ${candidate.id}`, ctx);

      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("pending");
    });

    it("does call getGlobalRuntime and approves for 'candidates approve' against a matching-project candidate", async () => {
      const runtime = makeRuntime();
      const candidate = makeProjectCandidate(runtime);
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo-a", bankId: projectBankId("repo-a") });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates approve ${candidate.id}`, ctx);

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("approved");
    });

    it("does call getGlobalRuntime for 'candidates approve' against a Profile candidate even when the project is disabled", async () => {
      const runtime = makeRuntime();
      const candidate = runtime.repos.candidates.create({
        scope: "profile",
        memoryType: "preference",
        text: "Profile visible everywhere.",
        evidenceSummary: "explicit",
        sourceSessionId: "s1",
        sourceRef: "turn:1",
        proposedAction: "create",
        targetMemoryId: null,
        projectIdentity: null,
      });
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates approve ${candidate.id}`, ctx);

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("approved");
    });

    it("does not call getGlobalRuntime for 'candidates edit-approve' against a mismatched-project candidate", async () => {
      const runtime = makeRuntime();
      const candidate = makeProjectCandidate(runtime);
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo-b", bankId: projectBankId("repo-b") });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates edit-approve ${candidate.id} A maliciously edited body.`, ctx);

      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("pending");
    });

    it("does call getGlobalRuntime and approves the edited body for 'candidates edit-approve' against a matching-project candidate", async () => {
      const runtime = makeRuntime();
      const candidate = makeProjectCandidate(runtime);
      getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: "repo-a", bankId: projectBankId("repo-a") });
      const { commands } = captureExtension();
      const command = commands.get("memory");
      const ctx = makeContext();

      await command.handler(`candidates edit-approve ${candidate.id} An edited body of sufficient length.`, ctx);

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(candidate.id)?.state).toBe("approved");
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase } from "../src/db/database.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import { projectForgetCtx } from "./forget-test-context.js";
import { remember } from "../src/governance/remember-service.js";
import { replaceMemory } from "../src/governance/replace-service.js";
import { handleBeforeAgentStart } from "../src/recall/recall-service.js";
import { noteInputEvent, resetAllSessionStateForTests } from "../src/runtime/session-runtime.js";
import { startMockHindsightServer, type MockHindsightServer } from "../src/testing/mock-hindsight.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { HindsightAdapter } from "../src/provider/hindsight-adapter.js";

// Only the runtime-getter seam is mocked here (handleBeforeAgentStart normally
// resolves this from a module-level singleton) — SQLite, HindsightAdapter, and
// the HTTP server underneath it are all real, per the requirement that these
// integration tests exercise the actual recall pipeline, not a stubbed adapter.
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

const servers: MockHindsightServer[] = [];

afterEach(async () => {
  resetAllSessionStateForTests();
  getGlobalRuntimeMock.mockReset();
  resolveProjectBankMock.mockReset();
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

async function makeRuntime(apiKey?: string) {
  const db = MemoryDatabase.openInMemory();
  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  const server = await startMockHindsightServer();
  servers.push(server);
  const adapter = new (await import("../src/provider/hindsight-adapter.js")).HindsightAdapter({
    baseUrl: server.baseUrl,
    apiKey,
  });
  const compat = await adapter.checkCompatibility();
  if (!compat.ok) {
    throw new Error(`integration makeRuntime compatibility failed: ${compat.reason}`);
  }
  return {
    server,
    runtime: {
      agentDir: "/tmp/pi-agent",
      db,
      hindsightUrl: server.baseUrl,
      adapter,
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
    },
  };
}

describe("integration with real sqlite + adapter + mock hindsight", () => {
  it("remembers, recalls, and forgets through the adapter without bank enumeration", async () => {
    const { runtime, server } = await makeRuntime();
    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Prefer concise answers.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(written.outcome).toBe("written");

    const recalled = await runtime.adapter.recall({
      bankId: runtime.profileBankId,
      query: "concise",
      budget: "mid",
      maxTokens: 100,
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.value[0]?.text).toBe("Prefer concise answers.");
    }

    const memoryId = runtime.repos.memories.listActive("profile", null)[0]!.id;
    await expect(forgetMemory(runtime as any, memoryId)).resolves.toEqual({ outcome: "forgotten" });
    expect(runtime.repos.memories.getById(memoryId)?.status).toBe("deleted");
    expect(server.journal.some((entry) => entry.path.includes("/banks/list"))).toBe(false);
    expect(server.journal.some((entry) => entry.path.includes("/documents/"))).toBe(true);
  });

  it("never leaks the real API key value into the request journal", async () => {
    const secretApiKey = "sk-live-ACTUAL-SECRET-9f3d8c2b7a1e4f6091c2b8a7d5e3f102";
    const { runtime, server } = await makeRuntime(secretApiKey);
    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Prefer concise answers.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(written.outcome).toBe("written");

    await runtime.adapter.recall({
      bankId: runtime.profileBankId,
      query: "concise",
      budget: "mid",
      maxTokens: 100,
    });

    // Prove the key was actually sent (authPresent) and that its value never
    // appears anywhere in the serialized journal, not that a header *name*
    // (like "authorization") is absent — the header name is not a secret.
    expect(server.journal.length).toBeGreaterThan(0);
    expect(server.journal.every((entry) => entry.authPresent)).toBe(true);
    expect(JSON.stringify(server.journal)).not.toContain(secretApiKey);
  });

  it("shares a project bank id across runtimes and exposes stored project memory through recall", async () => {
    const { runtime } = await makeRuntime();
    const projectIdentity = "shared-project";
    const text = "Use Vitest for tests.";
    const textHash = "3a1245143e2b719b5f0f9e7833eb967ca978a5f3499fcb32d1f6c95b5a1045f9";
    const row = runtime.repos.memories.create({
      scope: "project",
      memoryType: "decision",
      projectIdentity,
      bankId: projectBankId(projectIdentity),
      documentId: "pi-memory-hindsight:memory:11111111111111111111111111111111",
      unitId: "unit-1",
      textHash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const bank = runtime.repos.memories.getByBankAndDocument(row.bank_id, row.document_id);
    expect(bank?.bank_id).toBe(projectBankId(projectIdentity));
    const remembered = await runtime.adapter.retainOneMemory({
      bankId: row.bank_id,
      documentId: row.document_id,
      text,
      metadata: {
        logical_id: row.id,
        content_hash: textHash,
        scope: "project",
        memory_type: "decision",
        verification_state: "verified",
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_verified_at: row.last_verified_at!,
        project_identity: projectIdentity,
      },
    });
    expect(remembered.ok).toBe(true);
    const recalled = await runtime.adapter.recall({
      bankId: projectBankId(projectIdentity),
      query: "Vitest",
      budget: "mid",
      maxTokens: 100,
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) expect(recalled.value[0]?.text).toBe(text);
  });

  it("fails closed on config drift and reconciles ambiguous retain without duplicates", async () => {
    const { runtime, server } = await makeRuntime();
    server.setMode({ configDrift: true });
    const drifted = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Keep it short.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(drifted.outcome).toBe("rejected");

    server.reset();
    server.setMode({ ambiguousRetain: true });
    const ambiguous = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Keep it short.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:2",
      owner: "command",
    });
    expect(ambiguous.outcome).toBe("unknown");
    const retry = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Keep it short.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:2",
      owner: "command",
    });
    expect(["written", "unknown"]).toContain(retry.outcome);
    expect(server.journal.some((entry) => entry.path.includes("/banks/list"))).toBe(false);
  });

  it("recovers after provider outage without touching non-owned banks", async () => {
    const { runtime, server } = await makeRuntime();
    server.setMode({ fail: { retain: 503 } });
    const failed = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Recover later.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(["unknown", "rejected"]).toContain(failed.outcome);

    server.setMode({});
    const recovered = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Recover later.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:2",
      owner: "command",
    });
    expect(recovered.outcome).toBe("written");
    expect(server.journal.every((entry) => !entry.path.includes("sentinel"))).toBe(true);
  });

  it("keeps replace reconciling when an acknowledged retain POST is followed by zero-unit postcondition", async () => {
    const db = MemoryDatabase.openInMemory();
    const profiles = new ProfileRepository(db);
    const profile = profiles.getOrCreate();
    const bankId = profileBankId(profile.anonymous_profile_id);
    const memoryId = "replace-postcondition-1";
    const documentId = buildOwnedDocumentId("profile", null, "preference", memoryId);
    const originalText = "Original preference.";
    const originalHash = createHash("sha256").update(originalText).digest("hex");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const memories = new MemoriesRepository(db);
    memories.create({
      id: memoryId,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId,
      documentId,
      unitId: "unit-original",
      textHash: originalHash,
      textLength: originalText.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      createdAt,
      updatedAt: createdAt,
      lastVerifiedAt: createdAt,
    });

    let retainPosts = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => {
        const pathname = url.pathname;
        if (req.method === "GET" && pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.method === "GET" && pathname === "/version") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ api_version: "0.8.3" }));
          return;
        }
        if (req.method === "PUT" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ bank_id: bankId }));
          return;
        }
        if (req.method === "PATCH" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/config`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/config`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              bank_id: bankId,
              config: {
                retain_extraction_mode: "chunks",
                retain_chunk_size: 2048,
                enable_observations: false,
                enable_auto_consolidation: false,
              },
              overrides: {
                retain_extraction_mode: "chunks",
                retain_chunk_size: 2048,
                enable_observations: false,
                enable_auto_consolidation: false,
              },
            }),
          );
          return;
        }
        if (req.method === "POST" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/memories`) {
          retainPosts += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true, bank_id: bankId, items_count: 1, async: false }));
          return;
        }
        if (req.method === "GET" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ items: [], total: 0, limit: 2, offset: 0 }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const adapter = new HindsightAdapter({ baseUrl });
    const runtime = {
      agentDir: "/tmp/pi-agent",
      db,
      hindsightUrl: baseUrl,
      adapter,
      profile,
      profileBankId: bankId,
      repos: {
        profiles,
        memories,
        candidates: new CandidatesRepository(db),
        operations: new OperationsRepository(db),
        conflicts: new ConflictsRepository(db),
        audit: new AuditRepository(db),
        usage: new UsageRepository(db),
        maintenance: new MaintenanceRepository(db),
      },
    };

    const result = await replaceMemory(runtime as any, {
      targetMemoryId: memoryId,
      scope: "profile",
      memoryType: "preference",
      text: "Replacement that postcondition cannot prove.",
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-ack-then-empty",
      owner: "command",
    });
    expect(result.outcome).toBe("unknown");
    expect(retainPosts).toBe(1);
    const row = memories.getById(memoryId)!;
    expect(row.status).toBe("reconciling");
    expect(row.text_hash).toBe(originalHash);
    expect(row.updated_at).toBe(createdAt);
    expect(row.last_verified_at).toBe(createdAt);
    expect(row.expires_at).toBeNull();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

function makeRecallCtx(sessionId: string, cwd: string, leafId: string | null = null) {
  const getBranch = vi.fn(() => []);
  const appendEntry = vi.fn();
  return {
    ctx: {
      mode: "tui" as const,
      cwd,
      signal: undefined,
      sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId, getBranch, appendEntry },
      ui: { notify: vi.fn() },
    },
    getBranch,
    appendEntry,
  };
}

function noteOrdinaryInput(sessionId: string, text = "question"): void {
  noteInputEvent(sessionId, { type: "input", text, source: "interactive" });
}

describe("handleBeforeAgentStart with real sqlite + real adapter + mock hindsight", () => {
  it("profile scope: remember -> recall injects systemPrompt only -> forget -> no later injection", async () => {
    const { runtime } = await makeRuntime();
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });

    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Prefer concise answers.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(written.outcome).toBe("written");

    const sessionId = "session-1";
    noteOrdinaryInput(sessionId);
    const { ctx, getBranch, appendEntry } = makeRecallCtx(sessionId, "/repo");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "What are my preferences?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result?.message).toBeUndefined();
    expect(result?.systemPrompt).toContain("Prefer concise answers.");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    // Recall injection must never touch the session-message APIs — only the
    // returned systemPrompt and a UI notification are allowed side effects.
    expect(getBranch).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();

    const memoryId = runtime.repos.memories.listActive("profile", null)[0]!.id;
    await expect(forgetMemory(runtime as any, memoryId)).resolves.toEqual({ outcome: "forgotten" });

    noteOrdinaryInput(sessionId);
    const result2 = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "What are my preferences?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result2).toBeUndefined();
  });

  it("shared-project scope: remember -> recall injects systemPrompt only -> forget -> no later injection", async () => {
    const { runtime } = await makeRuntime();
    const projectIdentity = "repo";
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: true, identity: projectIdentity, bankId: projectBankId(projectIdentity) });

    const written = await remember(runtime as any, {
      scope: "project",
      memoryType: "decision",
      text: "Use Vitest for automated tests.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "turn:1",
      owner: "command",
    });
    expect(written.outcome).toBe("written");

    const sessionId = "session-1";
    noteOrdinaryInput(sessionId);
    const { ctx, getBranch, appendEntry } = makeRecallCtx(sessionId, "/repo");
    const result = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "What did we decide about testing?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result?.message).toBeUndefined();
    expect(result?.systemPrompt).toContain("Use Vitest for automated tests.");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(getBranch).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();

    const memoryId = runtime.repos.memories.listActive("project", projectIdentity)[0]!.id;
    await expect(forgetMemory(runtime as any, memoryId, projectForgetCtx(projectIdentity))).resolves.toEqual({
      outcome: "forgotten",
    });

    noteOrdinaryInput(sessionId);
    const result2 = await handleBeforeAgentStart(
      { type: "before_agent_start", prompt: "What did we decide about testing?", systemPrompt: "BASE", systemPromptOptions: {} as any },
      ctx as any,
    );
    expect(result2).toBeUndefined();
  });
});

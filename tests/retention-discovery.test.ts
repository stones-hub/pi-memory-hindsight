import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import { buildLegacyOwnedDocumentId, buildOwnedDocumentId } from "../src/provider/validation.js";
import type { MemoryRow } from "../src/db/types.js";
import { listMemories, showMemory } from "../src/governance/discovery-service.js";
import { expireMemory } from "../src/governance/expire-service.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import { projectForgetCtx } from "./forget-test-context.js";
import { replaceMemory } from "../src/governance/replace-service.js";
import {
  approveCandidate,
  listCandidates,
  rejectCandidate,
  renderCandidateSummary,
  type CandidateScopeContext,
} from "../src/governance/candidate-service.js";
import { buildProviderMetadata } from "../src/governance/remember-service.js";
import * as cleanupService from "../src/governance/cleanup-service.js";
import {
  countExpiryMaintenanceDue,
  getCleanupStatus,
  listExpiryMaintenanceTargets,
  runExpiryBatch,
  runLocalRetentionCleanup,
  runMaintenancePass,
} from "../src/governance/cleanup-service.js";
import {
  expireIdempotencyKey,
  forgetIdempotencyKey,
  isForeignHandoffEligibleReadOnly,
  MUTATION_OPERATION_LEASE_MS,
  prepareExpiryHandoff,
  setBlockHandoffExpireOpCreateForTests,
  setBlockHandoffFinalCoherenceForTests,
  setBlockHandoffForeignRetireForTests,
} from "../src/governance/mutation-ownership.js";
import * as expireService from "../src/governance/expire-service.js";
import {
  effectiveMemoryStatus,
  EXPIRY_BATCH_LIMIT,
  EXPIRY_RECONCILING_SCAN_LIMIT,
  MAINTENANCE_BATCH_LEASE_MS,
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_LEASE_RENEWAL_MS,
  DAY_MS,
  MEMORY_TOMBSTONE_RETENTION_DAYS,
  OPERATION_TERMINAL_RETENTION_DAYS,
  USAGE_MAX_ROWS,
} from "../src/db/lifecycle.js";
import {
  advanceMutationNowForTests,
  mutationNowIso,
  mutationNowMs,
  resetMutationNowForTests,
  setMutationNowForTests,
} from "../src/governance/mutation-clock.js";
import { parseMemoryCommand } from "../src/commands/memory-command-parser.js";
import extension from "../src/index.js";
import { HindsightAdapter } from "../src/provider/hindsight-adapter.js";
import { startMockHindsightServer } from "../src/testing/mock-hindsight.js";

const PROFILE_SCOPE: CandidateScopeContext = { projectIdentity: null, projectScopeEnabled: false };

const { getGlobalRuntimeMock, getLocalRuntimeMock, resolveProjectBankMock } = vi.hoisted(() => ({
  getGlobalRuntimeMock: vi.fn(),
  getLocalRuntimeMock: vi.fn(),
  resolveProjectBankMock: vi.fn(),
}));

vi.mock("../src/runtime/global-runtime.js", () => ({
  getGlobalRuntime: getGlobalRuntimeMock,
  getLocalRuntime: getLocalRuntimeMock,
  peekCachedLocalRuntime: () => undefined,
}));

vi.mock("../src/runtime/project-runtime.js", () => ({
  resolveProjectBank: resolveProjectBankMock,
}));

function hash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function makeRuntime() {
  const db = MemoryDatabase.openInMemory();
  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  const bankId = profileBankId(profile.anonymous_profile_id);
  return {
    agentDir: "/tmp/pi-agent",
    db,
    hindsightUrl: "http://127.0.0.1:8888",
    profile,
    profileBankId: bankId,
    adapter: {
      ensureOwnedBank: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      retainOneMemory: vi.fn().mockResolvedValue({ ok: true, value: { unitId: "unit-1" } }),
      verifyOneUnitDocument: vi.fn().mockResolvedValue({ ok: false, reason: "missing", category: "http", status: 404 }),
      deleteMemoryDocument: vi.fn().mockResolvedValue({
        ok: true,
        value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 },
      }),
      verifyDeletionPostconditions: vi.fn().mockResolvedValue({ ok: true, value: { absent: true } }),
      fetchExactOneUnitDocument: vi.fn(),
      reflect: vi.fn().mockResolvedValue({ ok: true, value: { text: "ok" } }),
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

type Runtime = ReturnType<typeof makeRuntime>;

function providerPayload(row: MemoryRow, text: string) {
  return {
    text,
    unitId: row.unit_id ?? "unit-1",
    metadata: buildProviderMetadata(
      { id: row.id, textHash: row.text_hash },
      {
        scope: row.scope,
        memoryType: row.memory_type,
        verificationState: row.verification_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        lastVerifiedAt: row.last_verified_at,
        projectIdentity: row.project_identity,
        sourceSessionId: row.source_session_id,
        sourceRef: row.source_ref,
      },
    ),
  };
}

function plantTombstone(
  runtime: Runtime,
  opts: { id?: string; text?: string; status?: "deleted" | "expired" },
) {
  const row = plantActive(runtime, {
    ...(opts.id ? { id: opts.id } : {}),
    text: opts.text ?? "tombstone body",
    scope: "profile",
  });
  runtime.db
    .prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?")
    .run(opts.status ?? "deleted", "2025-01-01T00:00:00.000Z", row.id);
  return runtime.repos.memories.getById(row.id)!;
}

function plantReconcilingExpiry(runtime: Runtime, opts: {
  id?: string;
  text: string;
  expiresAt: string;
  scope?: "profile" | "project";
  type?: "preference" | "habit" | "project_fact" | "task_state" | "inference" | "decision";
}) {
  const planted = plantActive(runtime, {
    ...opts,
    scope: opts.scope ?? "project",
    type: opts.type ?? "task_state",
  });
  const key = expireIdempotencyKey(
    planted.id,
    planted.mutation_generation,
    planted.text_hash,
    planted.document_id,
  );
  runtime.db.transaction(() => {
    runtime.repos.operations.tryCreate({
      idempotencyKey: key,
      memoryId: planted.id,
      action: "delete",
      bankId: planted.bank_id,
      documentId: planted.document_id,
      expectedTextHash: planted.text_hash,
      memoryGeneration: planted.mutation_generation,
    });
    runtime.repos.memories.trySetMutationOwner(planted.id, key, planted.mutation_generation);
  });
  return runtime.repos.memories.getById(planted.id)!;
}

function plantForeignDueWithOpState(
  runtime: Runtime,
  opts: {
    text: string;
    expiresAt: string;
    opState: "pending" | "reconciling" | "failed" | "in_progress";
    newText?: string;
    replaceKey?: string;
    providerIssued?: boolean;
  },
) {
  const planted = plantForeignReplaceDue(runtime, {
    text: opts.text,
    expiresAt: opts.expiresAt,
    ...(opts.newText !== undefined ? { newText: opts.newText } : {}),
    ...(opts.replaceKey !== undefined ? { replaceKey: opts.replaceKey } : {}),
    providerIssued: opts.providerIssued ?? false,
  });
  runtime.db
    .prepare("UPDATE operations SET state=? WHERE idempotency_key=?")
    .run(opts.opState, planted.replaceKey);
  return {
    ...planted,
    row: runtime.repos.memories.getById(planted.row.id)!,
  };
}

function snapshotExpiryState(runtime: Runtime, memoryId: string): string {
  return JSON.stringify({
    memory: runtime.repos.memories.getById(memoryId),
    operations: runtime.repos.operations.listByMemoryId(memoryId),
  });
}

function syncOpLocatorToMemory(runtime: Runtime, memoryId: string): void {
  const row = runtime.repos.memories.getById(memoryId)!;
  runtime.db
    .prepare(
      "UPDATE operations SET bank_id=?, document_id=?, expected_text_hash=? WHERE memory_id=?",
    )
    .run(row.bank_id, row.document_id, row.text_hash, memoryId);
}

function plantForeignReplaceDue(
  runtime: Runtime,
  opts: {
    text: string;
    expiresAt: string;
    scope?: "profile" | "project";
    newText?: string;
    replaceKey?: string;
    providerIssued?: boolean;
  },
) {
  const scope = opts.scope ?? "project";
  const row = plantActive(runtime, {
    scope,
    type: scope === "profile" ? "preference" : "task_state",
    text: opts.text,
    expiresAt: opts.expiresAt,
  });
  const newText = opts.newText ?? "Updated task body";
  const newHash = hash(newText);
  const replaceKey = opts.replaceKey ?? `command:update:${row.id}`;
  runtime.db.transaction(() => {
    runtime.repos.operations.tryCreate({
      idempotencyKey: replaceKey,
      memoryId: row.id,
      action: "replace",
      bankId: row.bank_id,
      documentId: row.document_id,
      expectedTextHash: newHash,
      memoryGeneration: row.mutation_generation,
    });
    runtime.repos.memories.trySetMutationOwner(row.id, replaceKey, row.mutation_generation);
  });
  runtime.db
    .prepare(
      `UPDATE operations
       SET state = 'reconciling', provider_mutation_issued = ?
       WHERE idempotency_key = ?`,
    )
    .run(opts.providerIssued ? 1 : 0, replaceKey);
  return {
    row: runtime.repos.memories.getById(row.id)!,
    replaceKey,
    newText,
    newHash,
  };
}

function plantActive(
  runtime: Runtime,
  opts: {
    id?: string;
    scope?: "profile" | "project";
    type?: "preference" | "habit" | "project_fact" | "task_state" | "inference" | "decision";
    text: string;
    projectIdentity?: string | null;
    expiresAt?: string | null;
  },
) {
  const scope = opts.scope ?? "profile";
  const memoryType = opts.type ?? (scope === "profile" ? "preference" : "project_fact");
  const projectIdentity = scope === "project" ? (opts.projectIdentity ?? "demo") : null;
  const bankId = scope === "profile" ? runtime.profileBankId : projectBankId(projectIdentity!);
  const id = opts.id ?? randomUUID();
  const textHash = hash(opts.text);
  const documentId = buildOwnedDocumentId(scope, projectIdentity, memoryType, id);
  return runtime.repos.memories.create({
    id,
    scope,
    memoryType,
    projectIdentity,
    bankId,
    documentId,
    unitId: "unit-1",
    textHash,
    textLength: opts.text.length,
    verificationState: memoryType === "inference" ? "unverified" : "verified",
    sourceSessionId: null,
    sourceRef: null,
    supersedesMemoryId: null,
    expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
  });
}

function captureExtension() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  extension({
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: () => undefined,
    on: () => undefined,
  } as any);
  return { commands };
}

afterEach(() => {
  resetMutationNowForTests();
  getGlobalRuntimeMock.mockReset();
  getLocalRuntimeMock.mockReset();
  resolveProjectBankMock.mockReset();
});

describe("memory discovery", () => {
  it("parses list/show/cleanup commands exactly", () => {
    expect(parseMemoryCommand("list")).toEqual({ kind: "list", filter: "all" });
    expect(parseMemoryCommand("list profile")).toEqual({ kind: "list", filter: "profile" });
    expect(parseMemoryCommand("list project")).toEqual({ kind: "list", filter: "project" });
    expect(parseMemoryCommand("list weird")).toBeNull();
    expect(parseMemoryCommand("show abc")).toEqual({ kind: "show", id: "abc" });
    expect(parseMemoryCommand("show abc extra")).toBeNull();
    expect(parseMemoryCommand("cleanup status")).toEqual({ kind: "cleanup-status" });
    expect(parseMemoryCommand("cleanup now")).toEqual({ kind: "cleanup-now" });
    expect(parseMemoryCommand("cleanup")).toBeNull();
  });

  it("lists effective-active memories with exact provider previews and degrades on outage", async () => {
    const runtime = makeRuntime();
    const live = plantActive(runtime, { text: "Prefer Chinese replies." });
    plantActive(runtime, {
      id: "expired-row",
      scope: "project",
      type: "task_state",
      text: "Old task",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    runtime.adapter.fetchExactOneUnitDocument
      .mockResolvedValueOnce({
        ok: true,
        value: providerPayload(live, "Prefer Chinese replies."),
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "provider down",
        category: "network",
        ambiguous: true,
      });

    const items = await listMemories(runtime as any, { filter: "profile", projectIdentity: null });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(live.id);
    expect(items[0]!.contentAvailable).toBe(true);
    expect(items[0]!.preview).toContain("Prefer Chinese");

    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: false,
      reason: "provider down",
      category: "network",
      ambiguous: true,
    });
    const degraded = await listMemories(runtime as any, { filter: "profile", projectIdentity: null });
    expect(degraded[0]!.contentAvailable).toBe(false);
    expect(degraded[0]!.preview).toBeNull();
  });

  it("shows validated content or content-unavailable without inventing bodies", async () => {
    const runtime = makeRuntime();
    const row = plantActive(runtime, { text: "Use vitest for unit tests." });
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: providerPayload(row, "Use vitest for unit tests."),
    });
    const shown = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in shown && shown.contentAvailable).toBe(true);
    if ("text" in shown) expect(shown.text).toBe("Use vitest for unit tests.");

    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });
    const unavailable = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in unavailable && unavailable.contentAvailable).toBe(false);
    if ("text" in unavailable) expect(unavailable.text).toBeNull();
  });

  it("exposes memory and candidate ids on command surfaces", async () => {
    const runtime = makeRuntime();
    const row = plantActive(runtime, { text: "Prefer Chinese replies." });
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: providerPayload(row, "Prefer Chinese replies."),
    });
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "no git", identity: null, bankId: null });

    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Candidate body",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    expect(renderCandidateSummary("en", candidate)).toContain(candidate.id);

    const { commands } = captureExtension();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), input: vi.fn(), custom: vi.fn() },
      signal: undefined,
    };
    await commands.get("memory")!.handler(`show ${row.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(row.id), "info");
    await commands.get("memory")!.handler("candidates list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(candidate.id), "info");
  });
});

describe("candidate body purge", () => {
  it("only sweeps unclaimed pending candidates past TTL", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const pending = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Expire me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    const failed = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Recover me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db.prepare("UPDATE candidates SET state='failed' WHERE id=?").run(failed.id);
    const reconciling = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Reconcile me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db.prepare("UPDATE candidates SET state='reconciling' WHERE id=?").run(reconciling.id);
    const approving = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Approving me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db.prepare("UPDATE candidates SET state='approving' WHERE id=?").run(approving.id);
    const past = "2000-01-01T00:00:00.000Z";
    for (const id of [pending.id, failed.id, reconciling.id, approving.id]) {
      runtime.db.prepare("UPDATE candidates SET expires_at=? WHERE id=?").run(past, id);
    }
    expect(runtime.repos.candidates.sweepExpired()).toBe(1);
    expect(runtime.repos.candidates.getById(pending.id)!.state).toBe("expired");
    expect(runtime.repos.candidates.getById(pending.id)!.text).toBeNull();
    expect(runtime.repos.candidates.getById(failed.id)!.text).toBe("Recover me");
    expect(runtime.repos.candidates.getById(reconciling.id)!.text).toBe("Reconcile me");
    expect(runtime.repos.candidates.getById(approving.id)!.text).toBe("Approving me");
  });

  it("purges bodies atomically on reject/expire/approve", async () => {
    const runtime = makeRuntime();
    const rejected = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Reject me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    expect(rejectCandidate(runtime as any, rejected.id, PROFILE_SCOPE).ok).toBe(true);
    const afterReject = runtime.repos.candidates.getById(rejected.id)!;
    expect(afterReject.state).toBe("rejected");
    expect(afterReject.text).toBeNull();
    expect(afterReject.evidence_summary).toBeNull();
    expect(afterReject.body_purged_at).toBeTruthy();
    expect(afterReject.text_hash).toBe(hash("Reject me"));
    expect(renderCandidateSummary("en", afterReject)).toContain("body purged");

    const pending = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Expire me",
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db
      .prepare("UPDATE candidates SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", pending.id);
    expect(runtime.repos.candidates.sweepExpired()).toBe(1);
    const afterExpire = runtime.repos.candidates.getById(pending.id)!;
    expect(afterExpire.state).toBe("expired");
    expect(afterExpire.text).toBeNull();
    expect(afterExpire.body_purged_at).toBeTruthy();
  });
});

describe("formal memory expiry", () => {
  it("physically deletes due memories into expired and blocks update resurrection", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Ship phase one",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const result = await expireMemory(runtime as any, row.id);
    expect(result).toEqual({ outcome: "expired" });
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("expired");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalled();

    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "demo",
      bankId: projectBankId("demo"),
      reason: "ok",
    });
    const update = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "project",
      memoryType: "task_state",
      text: "Resurrected",
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "command:update:x",
      expectedProjectIdentity: "demo",
      expectedTargetTextHash: row.text_hash,
      owner: "command",
    });
    expect(update.outcome).toBe("rejected");
  });

  it("coordinates expiry vs forget claim order without resurrecting content", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "inference",
      text: "Maybe index issue",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const forgotten = await forgetMemory(runtime as any, row.id, projectForgetCtx());
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("deleted");
    const expireAfter = await expireMemory(runtime as any, row.id);
    expect(expireAfter.outcome).toBe("rejected");
  });

  it("keeps uncertain expiry deletes reconciling for restart takeover", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "project_fact",
      text: "Entry is src/server.ts",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });
    const uncertain = await expireMemory(runtime as any, row.id);
    expect(uncertain.outcome).toBe("unknown");
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("reconciling");

    runtime.adapter.verifyDeletionPostconditions.mockResolvedValueOnce({
      ok: true,
      value: { absent: true },
    });
    advanceMutationNowForTests(120_000);
    const recovered = await expireMemory(runtime as any, row.id);
    expect(recovered.outcome).toBe("expired");
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("expired");
  });

  it("hands off due memories stuck behind foreign replace owners and expires them", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignReplaceDue(runtime, {
      text: "Due task",
      expiresAt: "2025-12-01T00:00:00.000Z",
      providerIssued: true,
    });
    expect(listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 10).some((r) => r.id === row.id)).toBe(
      true,
    );
    const expired = await expireMemory(runtime as any, row.id);
    expect(expired.outcome).toBe("expired");
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("expired");
    expect(runtime.repos.operations.getByKey(replaceKey)?.state).toBe("failed");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalled();
  });

  it.each([
    ["pending", "pending"],
    ["reconciling", "reconciling"],
    ["failed", "failed"],
    ["expired in_progress", "in_progress"],
  ] as const)("retires foreign %s op to failed on successful handoff", (label, opState) => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignDueWithOpState(runtime, {
      text: `Handoff from ${label}`,
      expiresAt: "2025-12-01T00:00:00.000Z",
      opState,
    });
    if (opState === "in_progress") {
      advanceMutationNowForTests(MUTATION_OPERATION_LEASE_MS + 1);
    }
    expect(prepareExpiryHandoff(runtime as any, row.id).ok).toBe(true);
    expect(runtime.repos.operations.getByKey(replaceKey)!.state).toBe("failed");
    const expireKey = expireIdempotencyKey(
      runtime.repos.memories.getById(row.id)!.id,
      runtime.repos.memories.getById(row.id)!.mutation_generation,
      row.text_hash,
      row.document_id,
    );
    const expireOp = runtime.repos.operations.getByKey(expireKey);
    expect(expireOp).toBeDefined();
    expect(expireOp!.action).toBe("delete");
  });

  it("rolls back foreign op state when final coherence check fails", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignDueWithOpState(runtime, {
      text: "Coherence rollback",
      expiresAt: "2025-12-01T00:00:00.000Z",
      opState: "reconciling",
    });
    const before = JSON.stringify(runtime.repos.operations.getByKey(replaceKey));
    setBlockHandoffFinalCoherenceForTests(true);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
    setBlockHandoffFinalCoherenceForTests(false);
    expect(JSON.stringify(runtime.repos.operations.getByKey(replaceKey))).toBe(before);
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBe(replaceKey);
  });

  it("rolls back foreign op state when foreign retirement fails", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignDueWithOpState(runtime, {
      text: "Retire rollback",
      expiresAt: "2025-12-01T00:00:00.000Z",
      opState: "pending",
    });
    const before = JSON.stringify(runtime.repos.operations.getByKey(replaceKey));
    setBlockHandoffForeignRetireForTests(true);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
    setBlockHandoffForeignRetireForTests(false);
    expect(JSON.stringify(runtime.repos.operations.getByKey(replaceKey))).toBe(before);
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBe(replaceKey);
  });

  it("allows terminal operation and tombstone compaction after handed-off expiry", async () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignDueWithOpState(runtime, {
      text: "Compact me",
      expiresAt: "2025-12-01T00:00:00.000Z",
      opState: "reconciling",
      providerIssued: true,
    });
    const expired = await expireMemory(runtime as any, row.id);
    expect(expired.outcome).toBe("expired");
    expect(runtime.repos.operations.getByKey(replaceKey)!.state).toBe("failed");
    const expireOp = runtime.repos.operations
      .listByMemoryId(row.id)
      .find((op) => op.action === "delete" && op.state === "committed");
    expect(expireOp).toBeDefined();
    const expireKey = expireOp!.idempotency_key;

    const aged = new Date(
      mutationNowMs() - Math.max(OPERATION_TERMINAL_RETENTION_DAYS, MEMORY_TOMBSTONE_RETENTION_DAYS) * DAY_MS - DAY_MS,
    ).toISOString();
    runtime.db.prepare("UPDATE memories SET updated_at=? WHERE id=?").run(aged, row.id);
    runtime.db.prepare("UPDATE operations SET updated_at=? WHERE memory_id=?").run(aged, row.id);

    const counts = runLocalRetentionCleanup(runtime as any);
    expect(counts.operationsDeleted).toBeGreaterThanOrEqual(2);
    expect(runtime.repos.operations.getByKey(replaceKey)).toBeUndefined();
    expect(runtime.repos.operations.getByKey(expireKey)).toBeUndefined();
    expect(counts.tombstonesDeleted).toBeGreaterThanOrEqual(1);
    expect(runtime.repos.memories.getById(row.id)).toBeUndefined();
    expect(runtime.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("blocks expiry handoff while a foreign replace lease is still live", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignReplaceDue(runtime, {
      text: "Live lease task",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.db
      .prepare("UPDATE operations SET state='in_progress', updated_at=? WHERE idempotency_key=?")
      .run(mutationNowIso(), replaceKey);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "live_owner" });
    advanceMutationNowForTests(MUTATION_OPERATION_LEASE_MS + 1);
    expect(prepareExpiryHandoff(runtime as any, row.id).ok).toBe(true);
  });

  it("rejects stale delayed replace finalization after expiry handoff", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "demo",
      bankId: projectBankId("demo"),
      reason: "ok",
    });
    const { row, replaceKey, newText, newHash } = plantForeignReplaceDue(runtime, {
      text: "Late retain task",
      expiresAt: "2025-12-01T00:00:00.000Z",
      providerIssued: true,
    });
    const originalGeneration = row.mutation_generation;
    expect(prepareExpiryHandoff(runtime as any, row.id).ok).toBe(true);
    runtime.adapter.retainOneMemory.mockResolvedValue({ ok: true, value: { unitId: "late-unit" } });
    runtime.adapter.verifyOneUnitDocument.mockResolvedValue({
      ok: true,
      value: { text: newText, unitId: "late-unit", metadata: null },
    });
    const stale = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "project",
      memoryType: "task_state",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: replaceKey,
      expectedProjectIdentity: "demo",
      expectedTargetTextHash: row.text_hash,
      owner: "command",
    });
    expect(stale.outcome).not.toBe("replaced");
    const afterStale = runtime.repos.memories.getById(row.id)!;
    expect(afterStale.mutation_generation).toBeGreaterThan(originalGeneration);
    expect(afterStale.status).not.toBe("active");
    const expired = await expireMemory(runtime as any, row.id);
    expect(expired.outcome).toBe("expired");
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("expired");
  });

  it("rolls back handoff when expire-op creation fails after row CAS", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignReplaceDue(runtime, {
      text: "Atomic handoff",
      expiresAt: "2025-12-01T00:00:00.000Z",
      providerIssued: true,
    });
    const generationBefore = runtime.repos.memories.getById(row.id)!.mutation_generation;
    const ownerBefore = runtime.repos.memories.getById(row.id)!.mutation_owner_key;
    const opStateBefore = runtime.repos.operations.getByKey(replaceKey)!.state;
    setBlockHandoffExpireOpCreateForTests(true);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
    setBlockHandoffExpireOpCreateForTests(false);
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.mutation_generation).toBe(generationBefore);
    expect(after.mutation_owner_key).toBe(ownerBefore);
    expect(runtime.repos.operations.getByKey(replaceKey)!.state).toBe(opStateBefore);
  });

  it("still rejects fresh replace after expiry even when a stale replace op exists", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "demo",
      bankId: projectBankId("demo"),
      reason: "ok",
    });
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "No resurrection",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    await expireMemory(runtime as any, row.id);
    const update = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "project",
      memoryType: "task_state",
      text: "Too late",
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "command:update:late",
      expectedProjectIdentity: "demo",
      expectedTargetTextHash: row.text_hash,
      owner: "command",
    });
    expect(update.outcome).toBe("rejected");
  });
});

describe("cleanup retention and maintenance lease", () => {
  it("bounds retention deletes and never removes live/recoverable rows", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const live = plantActive(runtime, { text: "Keep me" });
    const tombstone = plantActive(runtime, { id: "old-del", text: "Forgotten" });
    runtime.db
      .prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=?")
      .run("2025-01-01T00:00:00.000Z", tombstone.id);

    const terminal = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "old",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db
      .prepare(
        `UPDATE candidates
         SET state='rejected', text=NULL, evidence_summary=NULL, text_hash=?, body_purged_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(hash("old"), "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", terminal.id);

    runtime.repos.audit.record({ eventType: "test", outcome: "old" });
    runtime.db.prepare("UPDATE audit_events SET created_at=? WHERE outcome='old'").run("2025-01-01T00:00:00.000Z");

    const counts = runLocalRetentionCleanup(runtime as any);
    expect(counts.tombstonesDeleted).toBe(1);
    expect(counts.candidatesDeleted).toBe(1);
    expect(counts.auditDeleted).toBeGreaterThanOrEqual(1);
    expect(runtime.repos.memories.getById(live.id)?.status).toBe("active");
    expect(runtime.repos.memories.getById(tombstone.id)).toBeUndefined();
  });

  it("purges aged terminal operations and usage overflow without deleting referenced tombstones", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const referenced = plantTombstone(runtime, { id: "referenced-tomb", text: "referenced" });
    const opKey = forgetIdempotencyKey(
      referenced.id,
      referenced.mutation_generation,
      referenced.text_hash,
      referenced.document_id,
    );
    runtime.repos.operations.tryCreate({
      idempotencyKey: opKey,
      memoryId: referenced.id,
      action: "delete",
      bankId: referenced.bank_id,
      documentId: referenced.document_id,
      expectedTextHash: referenced.text_hash,
      memoryGeneration: referenced.mutation_generation,
    });
    runtime.db.prepare("UPDATE operations SET state='committed' WHERE idempotency_key=?").run(opKey);

    const live = plantActive(runtime, { text: "Live op memory" });
    const liveOpKey = "live:terminal:op";
    runtime.repos.operations.tryCreate({
      idempotencyKey: liveOpKey,
      memoryId: live.id,
      action: "create",
      bankId: live.bank_id,
      documentId: live.document_id,
      expectedTextHash: live.text_hash,
      memoryGeneration: live.mutation_generation,
    });
    runtime.db
      .prepare("UPDATE operations SET state='committed', updated_at=? WHERE idempotency_key=?")
      .run("2025-01-01T00:00:00.000Z", liveOpKey);

    for (let i = 0; i < USAGE_MAX_ROWS + 3; i++) {
      runtime.repos.usage.record({
        modelId: "m",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        outcome: `row-${i}`,
      });
    }

    const counts = runLocalRetentionCleanup(runtime as any);
    expect(counts.operationsDeleted).toBeGreaterThanOrEqual(1);
    expect(counts.usageDeleted).toBeGreaterThanOrEqual(1);
    expect(runtime.repos.operations.getByKey(opKey)).toBeDefined();
    expect(runtime.repos.memories.getById(referenced.id)?.status).toBe("deleted");
    expect(runtime.repos.memories.getById(live.id)?.status).toBe("active");
  });

  it("getCleanupStatus is read-only for foreign due owners", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row, replaceKey } = plantForeignReplaceDue(runtime, {
      text: "Status probe",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const rowBefore = JSON.stringify(runtime.repos.memories.getById(row.id));
    const opBefore = JSON.stringify(runtime.repos.operations.getByKey(replaceKey));
    const dueBefore = countExpiryMaintenanceDue(runtime as any, EXPIRY_BATCH_LIMIT + 1);
    getCleanupStatus(runtime as any);
    expect(JSON.stringify(runtime.repos.memories.getById(row.id))).toBe(rowBefore);
    expect(JSON.stringify(runtime.repos.operations.getByKey(replaceKey))).toBe(opBefore);
    expect(countExpiryMaintenanceDue(runtime as any, EXPIRY_BATCH_LIMIT + 1)).toBe(dueBefore);
  });

  it("stale maintenance worker does not mutate before lease renewal", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const claimed = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({
        force: true,
        intervalMs: MAINTENANCE_INTERVAL_MS,
        ownerKey: "stale-worker",
      }),
    );
    expect(claimed).not.toBeNull();
    const { row } = plantForeignReplaceDue(runtime, {
      text: "Lease guarded",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const generationBefore = runtime.repos.memories.getById(row.id)!.mutation_generation;
    advanceMutationNowForTests(MAINTENANCE_BATCH_LEASE_MS + 1);
    const batch = await runExpiryBatch(runtime as any, { leaseOwnerKey: claimed!.ownerKey });
    expect(batch.incomplete).toBe("lease_lost");
    expect(runtime.repos.memories.getById(row.id)!.mutation_generation).toBe(generationBefore);
  });

  it("coordinates multi-window maintenance leases and at-most-daily automatic runs", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const first = await runMaintenancePass(runtime as any, { force: true });
    expect(first.ran).toBe(true);
    const secondAuto = await runMaintenancePass(runtime as any, { force: false });
    expect(secondAuto.ran).toBe(false);

    const claimA = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({ force: true, intervalMs: MAINTENANCE_INTERVAL_MS, ownerKey: "window-a" }),
    );
    expect(claimA).not.toBeNull();
    const claimB = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({ force: true, intervalMs: MAINTENANCE_INTERVAL_MS, ownerKey: "window-b" }),
    );
    expect(claimB).toBeNull();
    runtime.repos.maintenance.releaseLease(claimA!.ownerKey, null);
    advanceMutationNowForTests(MAINTENANCE_INTERVAL_MS + 1000);
    const third = await runMaintenancePass(runtime as any, { force: false });
    expect(third.ran).toBe(true);
    const status = getCleanupStatus(runtime as any);
    expect(status.lastSuccessAt).toBeTruthy();
  });

  it("reports incomplete cleanup honestly from the command surface", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "no git", identity: null, bankId: null });
    const passSpy = vi.spyOn(cleanupService, "runMaintenancePass").mockResolvedValue({
      ran: true,
      incomplete: "lease_lost",
      reason: "maintenance lease lost during expiry batch",
      counts: {
        candidateBodiesPurged: 0,
        candidatesDeleted: 0,
        operationsDeleted: 0,
        conflictsDeleted: 0,
        auditDeleted: 0,
        usageDeleted: 0,
        tombstonesDeleted: 0,
        expiredAttempted: 1,
        expiredSucceeded: 0,
        expiredUncertain: 0,
        expiredRejected: 0,
      },
    });
    const { commands } = captureExtension();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), input: vi.fn(), custom: vi.fn() },
      signal: undefined,
    };
    await commands.get("memory")!.handler("cleanup now", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/incomplete|未完成/i), "error");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/Cleanup finished|清理完成/i), "info");
    passSpy.mockRestore();
  });

  it("runs confirmed cleanup now from the command surface", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "no git", identity: null, bankId: null });
    const { commands } = captureExtension();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), input: vi.fn(), custom: vi.fn() },
      signal: undefined,
    };
    await commands.get("memory")!.handler("cleanup now", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cleanup finished"), "info");
    await commands.get("memory")!.handler("cleanup status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("last_success_at"), "info");
  });

  it("recovers ambiguous expiry via maintenance selection without direct expireMemory", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "project_fact",
      text: "Entry is src/server.ts",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });
    await expireMemory(runtime as any, row.id);
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("reconciling");
    expect(listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 10).map((r) => r.id)).toContain(row.id);

    runtime.adapter.verifyDeletionPostconditions.mockResolvedValueOnce({
      ok: true,
      value: { absent: true },
    });
    const pass = await runMaintenancePass(runtime as any, { force: true });
    expect(pass.ran).toBe(true);
    expect(runtime.repos.memories.getById(row.id)?.status).toBe("expired");
  });

  it("selects foreign-owned due forget operations after deterministic expiry handoff", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Stale task",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const forgetKey = forgetIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
    runtime.db.transaction(() => {
      runtime.repos.operations.tryCreate({
        idempotencyKey: forgetKey,
        memoryId: row.id,
        action: "delete",
        bankId: row.bank_id,
        documentId: row.document_id,
        expectedTextHash: row.text_hash,
        memoryGeneration: row.mutation_generation,
      });
      runtime.repos.memories.trySetMutationOwner(row.id, forgetKey, row.mutation_generation);
      runtime.repos.operations.tryTransition(forgetKey, "pending", "reconciling");
    });
    const targets = listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 10);
    expect(targets.some((target) => target.id === row.id)).toBe(true);
    const expired = await expireMemory(runtime as any, row.id);
    expect(expired.outcome).toBe("expired");
  });

  it("does not hand off due rows with incoherent foreign operation locators", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Incoherent owner",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.db
      .prepare("UPDATE memories SET mutation_owner_key=? WHERE id=?")
      .run("replace:missing-operation", row.id);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
    expect(listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 10).some((r) => r.id === row.id)).toBe(
      false,
    );
  });

  it("renews maintenance lease across long batches and blocks stale workers", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const claimed = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({ force: true, intervalMs: MAINTENANCE_INTERVAL_MS, ownerKey: "worker-a" }),
    );
    expect(claimed).not.toBeNull();
    expect(MAINTENANCE_BATCH_LEASE_MS).toBeGreaterThan(EXPIRY_BATCH_LIMIT * MUTATION_OPERATION_LEASE_MS);

    advanceMutationNowForTests(MAINTENANCE_BATCH_LEASE_MS - 1000);
    expect(runtime.repos.maintenance.renewLease("worker-a")).toBe(true);
    expect(runtime.repos.maintenance.holdsLease("worker-a")).toBe(true);

    const takeover = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({ force: true, intervalMs: MAINTENANCE_INTERVAL_MS, ownerKey: "worker-b" }),
    );
    expect(takeover).toBeNull();

    advanceMutationNowForTests(MAINTENANCE_LEASE_RENEWAL_MS + 1);
    expect(runtime.repos.maintenance.holdsLease("worker-a")).toBe(false);
    const takeoverAfter = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({ force: true, intervalMs: MAINTENANCE_INTERVAL_MS, ownerKey: "worker-b" }),
    );
    expect(takeoverAfter).not.toBeNull();
  });

  it("deletes retention rows in FK-safe order without aborting unrelated deletes", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const live = plantActive(runtime, { text: "Keep me" });
    const terminal = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "old",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db
      .prepare(
        `UPDATE candidates
         SET state='rejected', text=NULL, evidence_summary=NULL, text_hash=?, body_purged_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(hash("old"), "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", terminal.id);
    runtime.repos.conflicts.create({
      candidateId: terminal.id,
      memoryId: null,
      kind: "duplicate",
    });
    runtime.repos.conflicts.resolve(
      runtime.repos.conflicts.listOpenForCandidate(terminal.id)[0]!.id,
      "resolved_keep_existing",
    );
    runtime.db
      .prepare("UPDATE conflicts SET updated_at=? WHERE candidate_id=?")
      .run("2025-01-01T00:00:00.000Z", terminal.id);

    const counts = runLocalRetentionCleanup(runtime as any);
    expect(counts.conflictsDeleted).toBeGreaterThanOrEqual(1);
    expect(counts.candidatesDeleted).toBeGreaterThanOrEqual(1);
    expect(runtime.repos.memories.getById(live.id)?.status).toBe("active");
    const fk = runtime.db.prepare("PRAGMA foreign_key_check").all();
    expect(fk).toHaveLength(0);
  });
});

describe("discovery metadata validation", () => {
  it("accepts matching current-format metadata and rejects null/mismatch", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const planted = plantActive(runtime, { text: "Use vitest for unit tests." });
    const nowIso = mutationNowIso();
    runtime.db
      .prepare("UPDATE memories SET created_at=?, updated_at=?, last_verified_at=? WHERE id=?")
      .run(nowIso, nowIso, nowIso, planted.id);
    const row = runtime.repos.memories.getById(planted.id)!;
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: providerPayload(row, "Use vitest for unit tests."),
    });
    const ok = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in ok && ok.contentAvailable).toBe(true);

    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: { text: "Use vitest for unit tests.", unitId: "unit-1", metadata: null },
    });
    const nullMeta = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in nullMeta && nullMeta.contentAvailable).toBe(false);

    const badMeta = providerPayload(row, "Use vitest for unit tests.");
    badMeta.metadata.logical_id = randomUUID();
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({ ok: true, value: badMeta });
    const wrongId = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in wrongId && wrongId.contentAvailable).toBe(false);
    if ("text" in wrongId) expect(wrongId.text).toBeNull();

    const hashMismatch = providerPayload(row, "Different body than stored hash");
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({ ok: true, value: hashMismatch });
    const mismatched = await showMemory(runtime as any, row.id);
    expect("contentAvailable" in mismatched && mismatched.contentAvailable).toBe(false);
    expect("reason" in mismatched && mismatched.reason).toMatch(/metadata|governance/i);
    if ("text" in mismatched) expect(mismatched.text).toBeNull();
  });

  it("accepts strict legacy-format metadata for list/show and rejects current mismatch", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const text = "Legacy discovery preference body.";
    const textHash = hash(text);
    const id = "legacy-discovery-1";
    const nowIso = mutationNowIso();
    const documentId = buildLegacyOwnedDocumentId("profile", null, textHash);
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId,
      unitId: "unit-legacy",
      textHash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
      lastVerifiedAt: nowIso,
      legacyDocumentTextHash: textHash,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const row = runtime.repos.memories.getById(id)!;
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: {
        text,
        unitId: "unit-legacy",
        metadata: {
          logical_id: textHash,
          scope: "profile",
          memory_type: "preference",
          verification_state: "verified",
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_verified_at: row.last_verified_at!,
        },
      },
    });
    const listed = await listMemories(runtime as any, { filter: "profile", projectIdentity: null });
    expect(listed.some((item) => item.id === id && item.contentAvailable && item.preview?.includes("Legacy discovery"))).toBe(
      true,
    );
    const shown = await showMemory(runtime as any, id);
    expect("contentAvailable" in shown && shown.contentAvailable).toBe(true);
    if ("text" in shown) expect(shown.text).toBe(text);

    const mismatchedCurrent = providerPayload(row, text);
    mismatchedCurrent.metadata.logical_id = randomUUID();
    runtime.adapter.fetchExactOneUnitDocument.mockResolvedValue({
      ok: true,
      value: mismatchedCurrent,
    });
    const currentMismatch = await showMemory(runtime as any, id);
    expect("contentAvailable" in currentMismatch && currentMismatch.contentAvailable).toBe(false);
    if ("text" in currentMismatch) expect(currentMismatch.text).toBeNull();
  });

  it("loads list/show via document_metadata when real list units return null metadata", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const server = await startMockHindsightServer();
    try {
      const runtime = makeRuntime();
      const text = "Adapter-integrated discovery body.";
      const live = plantActive(runtime, { text });
      const row = runtime.repos.memories.getById(live.id)!;
      const nowIso = mutationNowIso();
      runtime.db
        .prepare("UPDATE memories SET created_at=?, updated_at=?, last_verified_at=? WHERE id=?")
        .run(nowIso, nowIso, nowIso, live.id);
      const metadata = buildProviderMetadata(
        { id: row.id, textHash: row.text_hash },
        {
          scope: row.scope,
          memoryType: row.memory_type,
          verificationState: row.verification_state,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAt: row.expires_at,
          lastVerifiedAt: nowIso,
          projectIdentity: row.project_identity,
          sourceSessionId: row.source_session_id,
          sourceRef: row.source_ref,
        },
      );
      await fetch(`${server.baseUrl}/v1/default/banks/${encodeURIComponent(row.bank_id)}`, { method: "PUT" });
      await fetch(`${server.baseUrl}/v1/default/banks/${encodeURIComponent(row.bank_id)}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ content: text, document_id: row.document_id, update_mode: "replace", metadata }],
          async: false,
        }),
      });
      runtime.adapter = new HindsightAdapter({ baseUrl: server.baseUrl }) as any;
      runtime.hindsightUrl = server.baseUrl;

      const listed = await listMemories(runtime as any, { filter: "profile", projectIdentity: null });
      expect(
        listed.some((item) => item.id === live.id && item.contentAvailable && item.preview?.includes("Adapter-integrated")),
      ).toBe(true);
      const shown = await showMemory(runtime as any, live.id);
      expect("contentAvailable" in shown && shown.contentAvailable).toBe(true);
      if ("text" in shown) expect(shown.text).toBe(text);
      expect(server.journal.some((entry) => entry.route === "document_get")).toBe(true);
      expect(server.journal.some((entry) => entry.route === "list")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("fails closed on cross-project show without provider fetch", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const otherProject = "other-repo";
    const row = plantActive(runtime, {
      scope: "project",
      type: "project_fact",
      text: "Secret project fact",
      projectIdentity: otherProject,
      expiresAt: null,
    });
    const rejected = await showMemory(runtime as any, row.id, {
      projectScopeEnabled: true,
      expectedProjectIdentity: "demo",
    });
    expect(rejected).toEqual({
      outcome: "rejected",
      reason: "memory belongs to a different project identity",
    });
    expect(runtime.adapter.fetchExactOneUnitDocument).not.toHaveBeenCalled();

    const disabled = await showMemory(runtime as any, row.id, {
      projectScopeEnabled: false,
      expectedProjectIdentity: null,
    });
    expect(disabled).toEqual({
      outcome: "rejected",
      reason: "project memory is unavailable for the current project",
    });
    expect(runtime.adapter.fetchExactOneUnitDocument).not.toHaveBeenCalled();
  });
});

describe("candidate recovery lifecycle", () => {
  const pastTtl = "2000-01-01T00:00:00.000Z";

  function plantCandidate(runtime: Runtime, text: string) {
    return runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text,
      evidenceSummary: "ev",
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
  }

  it("keeps failed and reconciling candidates visible with bodies after TTL", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const failed = plantCandidate(runtime, "Failed but recoverable");
    const reconciling = plantCandidate(runtime, "Reconciling uncertain");
    runtime.db.prepare("UPDATE candidates SET state='failed', expires_at=? WHERE id=?").run(pastTtl, failed.id);
    runtime.db.prepare("UPDATE candidates SET state='reconciling', expires_at=? WHERE id=?").run(pastTtl, reconciling.id);

    const visible = listCandidates(runtime as any, false, PROFILE_SCOPE);
    expect(visible.map((row) => row.id)).toEqual(expect.arrayContaining([failed.id, reconciling.id]));
    expect(runtime.repos.candidates.getById(failed.id)!.text).toBe("Failed but recoverable");
    expect(runtime.repos.candidates.getById(reconciling.id)!.text).toBe("Reconciling uncertain");
  });

  it("allows retry claim on failed/reconciling candidates past original TTL", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const failed = plantCandidate(runtime, "Retry me");
    runtime.db.prepare("UPDATE candidates SET state='failed', expires_at=? WHERE id=?").run(pastTtl, failed.id);
    expect(runtime.repos.candidates.tryClaimForApproval(failed.id)).toBe(true);
    expect(runtime.repos.candidates.getById(failed.id)!.state).toBe("approving");
    expect(runtime.repos.candidates.getById(failed.id)!.text).toBe("Retry me");
  });

  it("rejects manual rejection of reconciling candidates without purging bodies", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const reconciling = plantCandidate(runtime, "Keep body");
    runtime.db.prepare("UPDATE candidates SET state='reconciling', expires_at=? WHERE id=?").run(pastTtl, reconciling.id);
    expect(rejectCandidate(runtime as any, reconciling.id, PROFILE_SCOPE)).toEqual({ ok: false, reason: "not_rejectable" });
    expect(runtime.repos.candidates.getById(reconciling.id)!.text).toBe("Keep body");
    expect(runtime.repos.candidates.getById(reconciling.id)!.state).toBe("reconciling");
  });

  it("allows manual rejection of definite failed candidates and purges bodies", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const failed = plantCandidate(runtime, "Stale target rejection");
    runtime.db
      .prepare("UPDATE candidates SET state='failed', failure_code='stale_target', expires_at=? WHERE id=?")
      .run(pastTtl, failed.id);
    expect(rejectCandidate(runtime as any, failed.id, PROFILE_SCOPE)).toEqual({ ok: true });
    const after = runtime.repos.candidates.getById(failed.id)!;
    expect(after.state).toBe("rejected");
    expect(after.text).toBeNull();
    expect(after.body_purged_at).toBeTruthy();
    expect(after.text_hash).toBeTruthy();
  });

  it("expires only untouched pending rows and does not race an approving claim", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const live = plantCandidate(runtime, "Still live");
    const expiredPending = plantCandidate(runtime, "TTL expired");
    runtime.db.prepare("UPDATE candidates SET expires_at=? WHERE id=?").run(pastTtl, expiredPending.id);

    expect(runtime.repos.candidates.tryClaimForApproval(live.id)).toBe(true);
    expect(runtime.repos.candidates.sweepExpired()).toBe(1);
    expect(runtime.repos.candidates.getById(live.id)!.state).toBe("approving");
    expect(runtime.repos.candidates.getById(expiredPending.id)!.state).toBe("expired");
    expect(runtime.repos.candidates.getById(expiredPending.id)!.text).toBeNull();
  });

  it("lets sweep win when pending is past TTL before claim", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const expiredPending = plantCandidate(runtime, "Too late");
    runtime.db.prepare("UPDATE candidates SET expires_at=? WHERE id=?").run(pastTtl, expiredPending.id);
    expect(runtime.repos.candidates.sweepExpired()).toBe(1);
    expect(runtime.repos.candidates.tryClaimForApproval(expiredPending.id)).toBe(false);
    expect(runtime.repos.candidates.getById(expiredPending.id)!.state).toBe("expired");
  });

  it("recovers a failed candidate after TTL and approves with body purge", async () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "disabled" });
    const failed = plantCandidate(runtime, "Prefer concise answers.");
    runtime.db.prepare("UPDATE candidates SET state='failed', expires_at=? WHERE id=?").run(pastTtl, failed.id);
    const approved = await approveCandidate(runtime as any, {
      candidateId: failed.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
      scopeContext: PROFILE_SCOPE,
    });
    expect(approved.outcome).toBe("approved");
    const after = runtime.repos.candidates.getById(failed.id)!;
    expect(after.state).toBe("approved");
    expect(after.text).toBeNull();
    expect(after.body_purged_at).toBeTruthy();
  });

  it("reports command reject failure for reconciling candidates", async () => {
    const runtime = makeRuntime();
    getLocalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
    resolveProjectBankMock.mockResolvedValue({ enabled: false, reason: "no git", identity: null, bankId: null });
    const reconciling = plantCandidate(runtime, "Cannot reject");
    runtime.db.prepare("UPDATE candidates SET state='reconciling' WHERE id=?").run(reconciling.id);
    const { commands } = captureExtension();
    const ctx = {
      mode: "tui",
      cwd: "/repo",
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: vi.fn(), confirm: vi.fn(), input: vi.fn(), custom: vi.fn() },
      signal: undefined,
    };
    await commands.get("memory")!.handler(`candidates reject ${reconciling.id}`, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/reconciling|recover|恢复|审批中/i), "error");
    expect(runtime.repos.candidates.getById(reconciling.id)!.text).toBe("Cannot reject");
  });
});

describe("update expiry boundary", () => {
  it("rejects replace at the exact expiry instant via mutation clock", async () => {
    const expiryMs = Date.parse("2026-01-01T12:00:00.000Z");
    setMutationNowForTests(expiryMs);
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Due exactly now",
      expiresAt: new Date(expiryMs).toISOString(),
    });
    resolveProjectBankMock.mockResolvedValue({
      enabled: true,
      identity: "demo",
      bankId: projectBankId("demo"),
      reason: "ok",
    });
    const update = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "project",
      memoryType: "task_state",
      text: "Resurrected",
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "command:update:boundary",
      expectedProjectIdentity: "demo",
      expectedTargetTextHash: row.text_hash,
      owner: "command",
    });
    expect(update.outcome).toBe("rejected");
  });
});

describe("lifecycle clock consistency", () => {
  it("uses mutation clock for effective status boundaries", () => {
    setMutationNowForTests(Date.parse("2026-01-01T12:00:00.000Z"));
    const expiresAt = "2026-01-01T12:00:00.000Z";
    expect(effectiveMemoryStatus("active", expiresAt)).toBe("expired");
    advanceMutationNowForTests(-1);
    expect(effectiveMemoryStatus("active", expiresAt)).toBe("active");
  });
});

describe("maintenance pass completion safety", () => {
  it("does not rewrite a newer last_success_at when a stale worker throws", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const newerSuccess = "2026-06-01T00:00:00.000Z";
    runtime.db.prepare("UPDATE maintenance_state SET last_success_at=? WHERE id=1").run(newerSuccess);
    const sweepSpy = vi.spyOn(runtime.repos.candidates, "sweepExpired").mockImplementation(() => {
      throw new Error("stale worker boom");
    });
    const pass = await runMaintenancePass(runtime as any, { force: true });
    expect(pass.ran).toBe(false);
    expect(runtime.repos.maintenance.get().last_success_at).toBe(newerSuccess);
    sweepSpy.mockRestore();
  });

  it("does not record success when lease renewal fails mid-batch", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const oldDate = "2025-12-01T00:00:00.000Z";
    plantActive(runtime, { id: "due-1", scope: "project", type: "task_state", text: "Task one", expiresAt: oldDate });
    plantActive(runtime, { id: "due-2", scope: "project", type: "task_state", text: "Task two", expiresAt: oldDate });
    const beforeSuccess = runtime.repos.maintenance.get().last_success_at;
    let renewCalls = 0;
    const originalRenew = runtime.repos.maintenance.renewLease.bind(runtime.repos.maintenance);
    runtime.repos.maintenance.renewLease = (ownerKey: string) => {
      renewCalls += 1;
      if (renewCalls >= 2) return false;
      return originalRenew(ownerKey);
    };
    const expireSpy = vi.spyOn(expireService, "expireMemory");
    const pass = await runMaintenancePass(runtime as any, { force: true });
    expect(pass.incomplete).toBe("lease_lost");
    expect(pass.counts?.expiredAttempted).toBe(1);
    expect(expireSpy).toHaveBeenCalledTimes(1);
    expect(runtime.repos.maintenance.get().last_success_at).toBe(beforeSuccess);
    expect(
      runtime.repos.audit.listRecent(5).find((row) => row.event_type === "cleanup")?.outcome,
    ).toBe("incomplete_lease_lost");
    expireSpy.mockRestore();
  });

  it("rejects stale renewal and completion after lease expiry", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({
        force: true,
        intervalMs: MAINTENANCE_INTERVAL_MS,
        ownerKey: "stale-worker",
      }),
    );
    advanceMutationNowForTests(MAINTENANCE_BATCH_LEASE_MS + 1);
    expect(runtime.repos.maintenance.renewLease("stale-worker")).toBe(false);
    expect(runtime.repos.maintenance.completeSuccess("stale-worker", "{}")).toBe(false);
    const takeover = runtime.db.transaction(() =>
      runtime.repos.maintenance.tryClaimLease({
        force: true,
        intervalMs: MAINTENANCE_INTERVAL_MS,
        ownerKey: "fresh-worker",
      }),
    );
    expect(takeover).not.toBeNull();
  });
});

describe("expiry target selection", () => {
  it("does not starve valid foreign handoff behind dangling foreign owners", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const oldDate = "2025-12-01T00:00:00.000Z";
    for (let i = 0; i < EXPIRY_RECONCILING_SCAN_LIMIT; i++) {
      const bad = plantActive(runtime, {
        id: `dangling-${i}`,
        scope: "project",
        type: "task_state",
        text: `Bad ${i}`,
        expiresAt: oldDate,
      });
      runtime.db
        .prepare("UPDATE memories SET mutation_owner_key=? WHERE id=?")
        .run(`replace:missing:${bad.id}`, bad.id);
    }
    const valid = plantForeignReplaceDue(runtime, {
      text: "Valid handoff",
      expiresAt: "2025-11-01T00:00:00.000Z",
    });
    const targets = listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 1);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(valid.row.id);
  });

  it("rejects malformed replace ops with invalid expected hash for handoff discovery", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Malformed replace",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    const badKey = `replace:bad:${row.id}`;
    runtime.db.transaction(() => {
      runtime.repos.operations.tryCreate({
        idempotencyKey: badKey,
        memoryId: row.id,
        action: "replace",
        bankId: row.bank_id,
        documentId: row.document_id,
        expectedTextHash: "not-a-valid-hash",
        memoryGeneration: row.mutation_generation,
      });
      runtime.repos.memories.trySetMutationOwner(row.id, badKey, row.mutation_generation);
    });
    const current = runtime.repos.memories.getById(row.id)!;
    expect(isForeignHandoffEligibleReadOnly(runtime as any, current, mutationNowIso())).toBe(false);
    expect(listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 10).some((r) => r.id === row.id)).toBe(
      false,
    );
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
  });

  it("prioritizes recoverable reconciling rows ahead of many active due rows", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const oldDate = "2025-12-01T00:00:00.000Z";
    for (let i = 0; i < EXPIRY_BATCH_LIMIT + 2; i++) {
      plantActive(runtime, {
        id: `active-${i}`,
        scope: "project",
        type: "task_state",
        text: `Active ${i}`,
        expiresAt: oldDate,
      });
    }
    const recover = plantReconcilingExpiry(runtime, {
      id: "recover",
      text: "Recover me",
      expiresAt: oldDate,
    });
    const targets = listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), EXPIRY_BATCH_LIMIT);
    expect(targets[0]!.id).toBe(recover.id);
    expect(targets.some((row) => row.id === recover.id)).toBe(true);
  });

  it("does not let ambiguous reconciling rows hide a later coherent recoverable row", () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const oldDate = "2025-12-01T00:00:00.000Z";
    for (let i = 0; i < EXPIRY_RECONCILING_SCAN_LIMIT; i++) {
      const row = plantActive(runtime, {
        id: `ambiguous-${i}`,
        scope: "project",
        type: "task_state",
        text: `Ambiguous ${i}`,
        expiresAt: oldDate,
      });
      const expireKey = expireIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
      const forgetKey = forgetIdempotencyKey(row.id, row.mutation_generation, row.text_hash, row.document_id);
      runtime.db.transaction(() => {
        runtime.repos.operations.tryCreate({
          idempotencyKey: expireKey,
          memoryId: row.id,
          action: "delete",
          bankId: row.bank_id,
          documentId: row.document_id,
          expectedTextHash: row.text_hash,
          memoryGeneration: row.mutation_generation,
        });
        runtime.repos.operations.tryCreate({
          idempotencyKey: forgetKey,
          memoryId: row.id,
          action: "delete",
          bankId: row.bank_id,
          documentId: row.document_id,
          expectedTextHash: row.text_hash,
          memoryGeneration: row.mutation_generation,
        });
        runtime.repos.memories.trySetMutationOwner(row.id, expireKey, row.mutation_generation);
      });
    }
    const recover = plantReconcilingExpiry(runtime, {
      id: "coherent-recover",
      text: "Coherent recover",
      expiresAt: "2025-11-01T00:00:00.000Z",
    });
    const targets = listExpiryMaintenanceTargets(runtime as any, mutationNowIso(), 1);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(recover.id);
  });
});

describe("expire handoff fail-closed", () => {
  it("rejects expire when foreign handoff is incoherent without provider or mutation", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const { row } = plantForeignDueWithOpState(runtime, {
      text: "Incoherent handoff expire",
      expiresAt: "2025-12-01T00:00:00.000Z",
      opState: "reconciling",
      providerIssued: true,
    });
    runtime.db
      .prepare("UPDATE memories SET bank_id=? WHERE id=?")
      .run(projectBankId("wrong"), row.id);
    syncOpLocatorToMemory(runtime, row.id);
    const before = snapshotExpiryState(runtime, row.id);
    const deleteSpy = vi.spyOn(runtime.adapter, "deleteMemoryDocument");
    const result = await expireMemory(runtime as any, row.id);
    expect(result).toEqual({ outcome: "rejected", reason: "memory expiry handoff is incoherent" });
    expect(snapshotExpiryState(runtime, row.id)).toBe(before);
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
  });
});

describe("malformed memory locators", () => {
  async function assertExcludedFromExpiryMaintenance(
    runtime: Runtime,
    memoryId: string,
    before: string,
  ): Promise<void> {
    const nowIso = mutationNowIso();
    expect(isForeignHandoffEligibleReadOnly(runtime as any, runtime.repos.memories.getById(memoryId)!, nowIso)).toBe(
      false,
    );
    expect(listExpiryMaintenanceTargets(runtime as any, nowIso, 50).some((r) => r.id === memoryId)).toBe(false);
    expect(countExpiryMaintenanceDue(runtime as any, 50)).toBe(0);
    expect(prepareExpiryHandoff(runtime as any, memoryId)).toEqual({ ok: false, reason: "incoherent" });
    expect(snapshotExpiryState(runtime, memoryId)).toBe(before);
    const deleteSpy = vi.spyOn(runtime.adapter, "deleteMemoryDocument");
    const expireSpy = vi.spyOn(expireService, "expireMemory");
    const batch = await runExpiryBatch(runtime as any);
    expect(batch.expiredAttempted).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(expireSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    expireSpy.mockRestore();
  }

  it.each([
    ["wrong bank", (runtime: Runtime, id: string) => {
      const wrongBank = projectBankId("other-project");
      runtime.db.prepare("UPDATE memories SET bank_id=? WHERE id=?").run(wrongBank, id);
      syncOpLocatorToMemory(runtime, id);
    }],
    ["wrong document", (runtime: Runtime, id: string) => {
      const row = runtime.repos.memories.getById(id)!;
      const wrongDoc = buildOwnedDocumentId(row.scope, row.project_identity, row.memory_type, randomUUID());
      runtime.db.prepare("UPDATE memories SET document_id=? WHERE id=?").run(wrongDoc, id);
      syncOpLocatorToMemory(runtime, id);
    }],
    ["malformed hash", (runtime: Runtime, id: string) => {
      runtime.db.prepare("UPDATE memories SET text_hash=? WHERE id=?").run("not-a-valid-hash", id);
      syncOpLocatorToMemory(runtime, id);
    }],
    ["project scope with profile bank", (runtime: Runtime, id: string) => {
      runtime.db.prepare("UPDATE memories SET bank_id=? WHERE id=?").run(runtime.profileBankId, id);
      syncOpLocatorToMemory(runtime, id);
    }],
    ["profile scope with project bank", (runtime: Runtime, id: string) => {
      runtime.db.prepare("UPDATE memories SET bank_id=? WHERE id=?").run(projectBankId("demo"), id);
      syncOpLocatorToMemory(runtime, id);
    }],
  ])("excludes foreign due rows with %s from maintenance and handoff", async (label, corrupt) => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const scope = label === "profile scope with project bank" ? "profile" : "project";
    const { row } = plantForeignReplaceDue(runtime, {
      scope,
      text: `Corrupt ${label}`,
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    corrupt(runtime, row.id);
    const before = snapshotExpiryState(runtime, row.id);
    await assertExcludedFromExpiryMaintenance(runtime, row.id, before);
  });

  it("excludes ownerless active due rows with invalid locators without provider calls", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantActive(runtime, {
      scope: "project",
      type: "task_state",
      text: "Ownerless corrupt",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.db.prepare("UPDATE memories SET bank_id=? WHERE id=?").run(projectBankId("wrong"), row.id);
    const before = snapshotExpiryState(runtime, row.id);
    const nowIso = mutationNowIso();
    expect(listExpiryMaintenanceTargets(runtime as any, nowIso, 10).some((r) => r.id === row.id)).toBe(false);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "not_foreign" });
    expect(snapshotExpiryState(runtime, row.id)).toBe(before);
    const deleteSpy = vi.spyOn(runtime.adapter, "deleteMemoryDocument");
    const outcome = await expireMemory(runtime as any, row.id);
    expect(outcome).toEqual({ outcome: "rejected", reason: "stored memory locator is invalid" });
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
  });

  it("excludes expire-owned reconciling rows with invalid locators before provider calls", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const row = plantReconcilingExpiry(runtime, {
      text: "Expire-owned corrupt",
      expiresAt: "2025-12-01T00:00:00.000Z",
    });
    runtime.db.prepare("UPDATE memories SET bank_id=? WHERE id=?").run(projectBankId("wrong"), row.id);
    syncOpLocatorToMemory(runtime, row.id);
    const before = snapshotExpiryState(runtime, row.id);
    const nowIso = mutationNowIso();
    expect(listExpiryMaintenanceTargets(runtime as any, nowIso, 10).some((r) => r.id === row.id)).toBe(false);
    expect(prepareExpiryHandoff(runtime as any, row.id)).toEqual({ ok: false, reason: "incoherent" });
    expect(snapshotExpiryState(runtime, row.id)).toBe(before);
    const deleteSpy = vi.spyOn(runtime.adapter, "deleteMemoryDocument");
    const batch = await runExpiryBatch(runtime as any);
    expect(batch.expiredAttempted).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
  });
});

describe("tombstone FK safety", () => {
  it("retains tombstones referenced by operations, conflicts, or candidates", () => {
    setMutationNowForTests(Date.parse("2026-06-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const safe = plantTombstone(runtime, { id: "safe-tomb", text: "safe" });
    const opBlocked = plantTombstone(runtime, { id: "op-blocked", text: "op blocked" });
    const conflictBlocked = plantTombstone(runtime, { id: "conflict-blocked", text: "conflict blocked" });
    const candidateBlocked = plantTombstone(runtime, { id: "candidate-blocked", text: "candidate blocked" });

    const opKey = forgetIdempotencyKey(
      opBlocked.id,
      opBlocked.mutation_generation,
      opBlocked.text_hash,
      opBlocked.document_id,
    );
    runtime.repos.operations.tryCreate({
      idempotencyKey: opKey,
      memoryId: opBlocked.id,
      action: "delete",
      bankId: opBlocked.bank_id,
      documentId: opBlocked.document_id,
      expectedTextHash: opBlocked.text_hash,
      memoryGeneration: opBlocked.mutation_generation,
    });
    runtime.db.prepare("UPDATE operations SET state='committed' WHERE idempotency_key=?").run(opKey);

    const conflict = runtime.repos.conflicts.create({
      candidateId: null,
      memoryId: conflictBlocked.id,
      kind: "duplicate",
    });
    runtime.repos.conflicts.resolve(conflict.id, "resolved_keep_existing");

    const terminal = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "still referenced",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    runtime.db
      .prepare("UPDATE candidates SET state='approved', approved_memory_id=? WHERE id=?")
      .run(candidateBlocked.id, terminal.id);

    const counts = runLocalRetentionCleanup(runtime as any);
    expect(counts.tombstonesDeleted).toBe(1);
    expect(runtime.repos.memories.getById(safe.id)).toBeUndefined();
    expect(runtime.repos.memories.getById(opBlocked.id)?.status).toBe("deleted");
    expect(runtime.repos.memories.getById(conflictBlocked.id)?.status).toBe("deleted");
    expect(runtime.repos.memories.getById(candidateBlocked.id)?.status).toBe("deleted");
    expect(runtime.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
});

describe("discovery list fetch bounds", () => {
  it("aborts in-flight provider fetches at the wall-clock deadline", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const rows: MemoryRow[] = [];
    const textByDocument = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const text = `Memory number ${i}`;
      const planted = plantActive(runtime, { id: `deadline-${i}`, text });
      const nowIso = mutationNowIso();
      runtime.db
        .prepare("UPDATE memories SET created_at=?, updated_at=?, last_verified_at=? WHERE id=?")
        .run(nowIso, nowIso, nowIso, planted.id);
      const row = runtime.repos.memories.getById(planted.id)!;
      rows.push(row);
      textByDocument.set(row.document_id, text);
    }
    const aborted: string[] = [];
    runtime.adapter.fetchExactOneUnitDocument.mockImplementation((_bank, doc, _hash, signal) => {
      return new Promise((resolve) => {
        const onAbort = () => {
          aborted.push(doc);
          resolve({ ok: false, reason: "aborted", category: "timeout", ambiguous: true });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          const row = rows.find((candidate) => candidate.document_id === doc)!;
          resolve({ ok: true, value: providerPayload(row, textByDocument.get(doc)!) });
        }, 200);
      });
    });
    const items = await listMemories(runtime as any, {
      filter: "profile",
      projectIdentity: null,
      fetchDeadlineMs: 60,
    });
    expect(items).toHaveLength(6);
    expect(aborted.length).toBeGreaterThan(0);
    expect(items.some((item) => !item.contentAvailable)).toBe(true);
  });

  it("returns metadata-only rows when the caller cancels list fetches", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    for (let i = 0; i < 4; i++) {
      const planted = plantActive(runtime, { id: `cancel-${i}`, text: `Cancel ${i}` });
      const nowIso = mutationNowIso();
      runtime.db
        .prepare("UPDATE memories SET created_at=?, updated_at=?, last_verified_at=? WHERE id=?")
        .run(nowIso, nowIso, nowIso, planted.id);
    }
    runtime.adapter.fetchExactOneUnitDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ ok: true, value: { text: "late", unitId: "u", metadata: null } }),
            200,
          );
        }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const items = await listMemories(runtime as any, {
      filter: "profile",
      projectIdentity: null,
      signal: controller.signal,
      fetchDeadlineMs: 5_000,
    });
    expect(items).toHaveLength(4);
    expect(items.every((item) => !item.contentAvailable)).toBe(true);
  });

  it("uses bounded concurrency instead of serializing all provider timeouts", async () => {
    setMutationNowForTests(Date.parse("2026-01-01T00:00:00.000Z"));
    const runtime = makeRuntime();
    const rows: MemoryRow[] = [];
    const textByDocument = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const text = `Memory number ${i}`;
      const planted = plantActive(runtime, { id: `list-${i}`, text });
      const nowIso = mutationNowIso();
      runtime.db
        .prepare("UPDATE memories SET created_at=?, updated_at=?, last_verified_at=? WHERE id=?")
        .run(nowIso, nowIso, nowIso, planted.id);
      const row = runtime.repos.memories.getById(planted.id)!;
      rows.push(row);
      textByDocument.set(row.document_id, text);
    }
    let inFlight = 0;
    let maxInFlight = 0;
    runtime.adapter.fetchExactOneUnitDocument.mockImplementation(async (_bank, doc) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      const row = rows.find((candidate) => candidate.document_id === doc)!;
      return { ok: true, value: providerPayload(row, textByDocument.get(doc)!) };
    });
    const started = Date.now();
    const items = await listMemories(runtime as any, { filter: "profile", projectIdentity: null });
    const elapsed = Date.now() - started;
    expect(items).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(40 * 6);
  });
});

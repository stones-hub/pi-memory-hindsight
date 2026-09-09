import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId } from "../src/identity/bank-id.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";
import { remember } from "../src/governance/remember-service.js";
import { replaceMemory } from "../src/governance/replace-service.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import { approveCandidate, setBeforeCandidateApprovalFinalizeForTests } from "../src/governance/candidate-service.js";
import {
  mintCompactReviveCreateKey,
  reviveCreateIdempotencyKey,
} from "../src/governance/mutation-ownership.js";
import { HindsightAdapter } from "../src/provider/hindsight-adapter.js";

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, bodyText: string) => void | Promise<void>;

interface MockServer {
  baseUrl: string;
  setRoute(method: string, url: string, handler: RouteHandler): void;
  close(): Promise<void>;
}

const servers: MockServer[] = [];

async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, RouteHandler>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const key = `${req.method ?? "GET"} ${req.url ?? "/"}`;
    const handler = routes.get(key);
    if (!handler) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected route: ${key}` }));
      return;
    }
    await handler(req, res, bodyText);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server failed to bind");
  const mock: MockServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  servers.push(mock);
  return mock;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

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
      retainOneMemory: vi.fn().mockResolvedValue({ ok: true, value: { unitId: "unit-new" } }),
      verifyOneUnitDocument: vi.fn().mockResolvedValue({ ok: false, reason: "missing", category: "validation" }),
      deleteMemoryDocument: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 } }),
      verifyDeletionPostconditions: vi.fn().mockResolvedValue({ ok: true, value: { absent: true } }),
      recall: vi.fn(),
    },
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
}

type Runtime = ReturnType<typeof makeRuntime>;

function seedActive(runtime: Runtime, text = "Seeded preference content.") {
  const id = "mem-seed-1";
  return runtime.repos.memories.create({
    id,
    scope: "profile",
    memoryType: "preference",
    projectIdentity: null,
    bankId: runtime.profileBankId,
    documentId: buildOwnedDocumentId("profile", null, "preference", id),
    unitId: "unit-seed",
    textHash: sha256(text),
    textLength: text.length,
    verificationState: "verified",
    sourceSessionId: null,
    sourceRef: null,
    supersedesMemoryId: null,
    expiresAt: null,
  });
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("mutation generation concurrency and recovery", () => {
  it("create → verified forget → same-content remember retains again; candidate approves only active duplicates", async () => {
    const runtime = makeRuntime();
    const text = "Preference that will be forgotten then recreated.";
    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "command:/memory remember",
      owner: "command",
    });
    expect(written.outcome).toBe("written");
    if (written.outcome !== "written") return;
    const firstId = written.memoryId;
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);

    const forgotten = await forgetMemory(runtime as any, firstId);
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(firstId)!.status).toBe("deleted");

    const rewritten = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s2",
      sourceRef: "command:/memory remember",
      owner: "command",
    });
    expect(rewritten.outcome).toBe("written");
    if (rewritten.outcome !== "written") return;
    expect(rewritten.memoryId).not.toBe(firstId);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(2);
    expect(runtime.repos.memories.getById(rewritten.memoryId)!.status).toBe("active");
    expect(runtime.repos.memories.getById(firstId)!.status).toBe("deleted");

    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text,
      evidenceSummary: null,
      sourceSessionId: "s3",
      sourceRef: "turn:1",
      proposedAction: "create",
      targetMemoryId: null,
      expectedTargetTextHash: null,
      projectIdentity: null,
    });
    const approved = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "s3",
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome === "approved") {
      expect(runtime.repos.memories.getById(approved.memoryId)!.status).toBe("active");
      expect(approved.memoryId).toBe(rewritten.memoryId);
    }
  });

  it("supports unbounded create→forget→create cycles with retain each recreation and later candidate approval", async () => {
    const runtime = makeRuntime();
    const text = "Preference cycled through three forget recreations.";
    const baseKey = `remember:profile:preference:-:${sha256(text)}`;
    const ids: string[] = [];
    let retainCount = 0;

    for (let cycle = 0; cycle < 3; cycle++) {
      const written = await remember(runtime as any, {
        scope: "profile",
        memoryType: "preference",
        text,
        cwd: "/repo",
        sourceSessionId: `s-c${cycle}`,
        sourceRef: `command:/memory remember:${cycle}`,
        owner: "command",
      });
      expect(written.outcome).toBe("written");
      if (written.outcome !== "written") return;
      ids.push(written.memoryId);
      retainCount += 1;
      expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(retainCount);
      expect(runtime.repos.memories.getById(written.memoryId)!.status).toBe("active");
      for (const prior of ids.slice(0, -1)) {
        expect(runtime.repos.memories.getById(prior)!.status).toBe("deleted");
      }

      const forgotten = await forgetMemory(runtime as any, written.memoryId);
      expect(forgotten.outcome).toBe("forgotten");
      expect(runtime.repos.memories.getById(written.memoryId)!.status).toBe("deleted");
    }

    const final = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s-final",
      sourceRef: "command:/memory remember:final",
      owner: "command",
    });
    expect(final.outcome).toBe("written");
    if (final.outcome !== "written") return;
    retainCount += 1;
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(retainCount);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(final.memoryId).not.toBe(ids[0]);
    expect(final.memoryId).not.toBe(ids[1]);
    expect(final.memoryId).not.toBe(ids[2]);
    for (const prior of ids) {
      expect(runtime.repos.memories.getById(prior)!.status).toBe("deleted");
      expect(runtime.repos.memories.getById(prior)!.document_id).not.toBe(
        runtime.repos.memories.getById(final.memoryId)!.document_id,
      );
    }
    expect(runtime.repos.memories.getById(final.memoryId)!.status).toBe("active");

    // First-generation revive key shape remains compatible; later keys are compact.
    const firstDeleted = runtime.repos.memories.getById(ids[0]!)!;
    const firstRevive = reviveCreateIdempotencyKey(baseKey, firstDeleted);
    expect(runtime.repos.operations.getByKey(firstRevive)?.state).toBe("committed");
    const secondDeleted = runtime.repos.memories.getById(ids[1]!)!;
    const secondRevive = mintCompactReviveCreateKey(baseKey, firstRevive, secondDeleted.id, secondDeleted.mutation_generation);
    expect(secondRevive.length).toBeLessThanOrEqual(256);
    expect(runtime.repos.operations.getByKey(secondRevive)?.state).toBe("committed");

    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text,
      evidenceSummary: null,
      sourceSessionId: "s-cand",
      sourceRef: "turn:later",
      proposedAction: "create",
      targetMemoryId: null,
      expectedTargetTextHash: null,
      projectIdentity: null,
    });
    const approved = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "s-cand",
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome === "approved") {
      expect(approved.memoryId).toBe(final.memoryId);
      expect(runtime.repos.candidates.getById(candidate.id)!.state).toBe("approved");
      expect(runtime.repos.memories.getById(approved.memoryId)!.status).toBe("active");
    }
  });

  it("does not approve a candidate when forget wins before guarded approval finalization", async () => {
    const runtime = makeRuntime();
    const text = "Candidate race body that forget deletes first.";
    setBeforeCandidateApprovalFinalizeForTests(async (_rt, memoryId) => {
      const forgotten = await forgetMemory(runtime as any, memoryId);
      expect(forgotten.outcome).toBe("forgotten");
    });
    try {
      const candidate = runtime.repos.candidates.create({
        scope: "profile",
        memoryType: "preference",
        text,
        evidenceSummary: null,
        sourceSessionId: "s-race",
        sourceRef: "turn:race",
        proposedAction: "create",
        targetMemoryId: null,
        expectedTargetTextHash: null,
        projectIdentity: null,
      });
      const result = await approveCandidate(runtime as any, {
        candidateId: candidate.id,
        cwd: "/repo",
        sourceSessionId: "s-race",
      });
      expect(result.outcome).toBe("rejected");
      expect(runtime.repos.candidates.getById(candidate.id)!.state).not.toBe("approved");
      expect(runtime.repos.candidates.getById(candidate.id)!.failure_code).toBe("approve_memory_incoherent");
      expect(runtime.repos.audit.listRecent(10).some((e) => e.outcome === "approved")).toBe(false);
    } finally {
      setBeforeCandidateApprovalFinalizeForTests(null);
    }
  });

  it("allows a legitimate forget after candidate approval has already finalized", async () => {
    const runtime = makeRuntime();
    const text = "Approve then forget is allowed.";
    const candidate = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "preference",
      text,
      evidenceSummary: null,
      sourceSessionId: "s-ok",
      sourceRef: "turn:ok",
      proposedAction: "create",
      targetMemoryId: null,
      expectedTargetTextHash: null,
      projectIdentity: null,
    });
    const approved = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "s-ok",
    });
    expect(approved.outcome).toBe("approved");
    if (approved.outcome !== "approved") return;
    expect(runtime.repos.candidates.getById(candidate.id)!.state).toBe("approved");
    const forgotten = await forgetMemory(runtime as any, approved.memoryId);
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.repos.candidates.getById(candidate.id)!.state).toBe("approved");
    expect(runtime.repos.memories.getById(approved.memoryId)!.status).toBe("deleted");
  });

  it("failed forget then replace then forget of the current generation uses a new delete key", async () => {
    const runtime = makeRuntime();
    const original = "Original preference before failed forget.";
    const updated = "Updated preference after failed forget.";
    const row = seedActive(runtime, original);
    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: false,
      reason: "http 400",
      category: "http",
      status: 400,
      ambiguous: false,
    });
    const failed = await forgetMemory(runtime as any, row.id);
    expect(failed.outcome).toBe("rejected");
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("active");
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBeNull();

    const replaced = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:replace-after-failed-forget",
      idempotencyKey: `command:update:${row.id}:${sha256(original)}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(replaced.outcome).toBe("replaced");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.text_hash).toBe(sha256(updated));
    expect(after.mutation_generation).toBe(2);

    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: true,
      value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 },
    });
    const forgotten = await forgetMemory(runtime as any, row.id);
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalledTimes(2);
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");
  });

  it("replace-first claim blocks forget until replace finalizes; delayed delete cannot reactivate", async () => {
    const runtime = makeRuntime();
    const original = "Content before concurrent replace.";
    const updated = "Content after concurrent replace.";
    const row = seedActive(runtime, original);

    let resolveRetain!: (value: unknown) => void;
    runtime.adapter.retainOneMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetain = resolve;
        }),
    );

    const replacePromise = replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:replace-first",
      idempotencyKey: `command:update:${row.id}:${sha256(original)}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });

    await vi.waitFor(() => {
      expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toContain("command:update:");
    });

    const forgetWhileReplace = await forgetMemory(runtime as any, row.id);
    expect(forgetWhileReplace.outcome).toBe("in_progress");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();

    resolveRetain({ ok: true, value: { unitId: "unit-replaced" } });
    expect(await replacePromise).toEqual({ outcome: "replaced", memoryId: row.id });
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("active");
    expect(runtime.repos.memories.getById(row.id)!.text_hash).toBe(sha256(updated));

    const forgetAfter = await forgetMemory(runtime as any, row.id);
    expect(forgetAfter.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");
  });

  it("delete-first claim blocks replace; delayed replace finalize cannot revive a deleted row", async () => {
    const runtime = makeRuntime();
    const original = "Content before concurrent delete.";
    const updated = "Content that must not revive after delete.";
    const row = seedActive(runtime, original);

    let resolveDelete!: (value: unknown) => void;
    runtime.adapter.deleteMemoryDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const forgetPromise = forgetMemory(runtime as any, row.id);
    await vi.waitFor(() => {
      expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key?.startsWith("forget:")).toBe(true);
    });

    const replaceWhileDelete = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:delete-first",
      idempotencyKey: `command:update:${row.id}:${sha256(original)}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(replaceWhileDelete.outcome).toBe("in_progress");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();

    resolveDelete({ ok: true, value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 } });
    expect(await forgetPromise).toEqual({ outcome: "forgotten" });
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");

    const stale = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:stale-after-delete",
      idempotencyKey: `command:update:${row.id}:${sha256(original)}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(stale.outcome).toBe("rejected");
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");
  });

  it("ambiguous create verify causes zero additional retain; exact absence permits one retry", async () => {
    const runtime = makeRuntime();
    const text = "Ambiguous create reconciliation text.";
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });
    const first = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:ambiguous-create",
      owner: "command",
    });
    expect(first.outcome).toBe("unknown");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "list timed out",
      category: "timeout",
      ambiguous: true,
    });
    const second = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:ambiguous-create",
      owner: "command",
    });
    expect(second.outcome).toBe("unknown");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "missing",
      category: "validation",
    });
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: true, value: { unitId: "unit-retry" } });
    const third = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:ambiguous-create",
      owner: "command",
    });
    expect(third.outcome).toBe("written");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(2);
  });

  it("retries after process/window handoff use only durable SQLite ownership state", async () => {
    const runtime = makeRuntime();
    const original = "Handoff preference original.";
    const updated = "Handoff preference updated.";
    const row = seedActive(runtime, original);
    const key = `command:update:${row.id}:${sha256(original)}:${sha256(updated)}`;

    runtime.db.transaction(() => {
      runtime.repos.operations.tryCreate({
        idempotencyKey: key,
        memoryId: row.id,
        action: "replace",
        bankId: row.bank_id,
        documentId: row.document_id,
        expectedTextHash: sha256(updated),
        memoryGeneration: row.mutation_generation,
      });
      runtime.repos.memories.trySetMutationOwner(row.id, key, row.mutation_generation);
      runtime.repos.operations.setState(key, "reconciling");
    });

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({ ok: false, reason: "missing", category: "validation" });
    const resumed = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:handoff",
      idempotencyKey: key,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(resumed.outcome).toBe("replaced");
    expect(runtime.repos.memories.getById(row.id)!.text_hash).toBe(sha256(updated));
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBeNull();
  });

  it("reverify-first claim blocks forget and update until CAS finalize; audit stays body-free", async () => {
    const runtime = makeRuntime();
    const text = "Unverified preference awaiting reverify.";
    const hash = sha256(text);
    const id = "reverify-block-1";
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", id),
      unitId: "unit-u",
      textHash: hash,
      textLength: text.length,
      verificationState: "unverified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });

    let resolveRetain!: (value: unknown) => void;
    runtime.adapter.retainOneMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetain = resolve;
        }),
    );

    const reverifyPromise = remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:reverify-first",
      owner: "tool",
    });

    await vi.waitFor(() => {
      expect(runtime.repos.memories.getById(id)!.mutation_owner_key?.startsWith("reverify:")).toBe(true);
    });

    expect(await forgetMemory(runtime as any, id)).toMatchObject({ outcome: "in_progress" });
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(
      await replaceMemory(runtime as any, {
        targetMemoryId: id,
        scope: "profile",
        memoryType: "preference",
        text: "Different update text while reverify owns.",
        cwd: "/repo",
        sourceSessionId: "s1",
        sourceRef: "test:update-during-reverify",
        idempotencyKey: `command:update:${id}:${hash}:${sha256("Different update text while reverify owns.")}`,
        expectedTargetTextHash: hash,
        owner: "command",
      }),
    ).toMatchObject({ outcome: "in_progress" });
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);

    resolveRetain({ ok: true, value: { unitId: "unit-reverified" } });
    expect(await reverifyPromise).toEqual({ outcome: "duplicate", memoryId: id });
    const after = runtime.repos.memories.getById(id)!;
    expect(after.verification_state).toBe("verified");
    expect(after.mutation_owner_key).toBeNull();
    expect(after.mutation_generation).toBe(2);
    const audit = runtime.db.prepare("SELECT outcome, redacted_code FROM audit_events WHERE memory_id = ?").all(id) as Array<{
      outcome: string;
      redacted_code: string | null;
    }>;
    expect(audit.some((event) => event.outcome === "reverified_tool")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(text);
  });

  it("forget-first claim blocks duplicate reverify; stale reverify CAS cannot recreate after delete", async () => {
    const runtime = makeRuntime();
    const text = "Unverified preference deleted during reverify race.";
    const hash = sha256(text);
    const id = "reverify-race-delete";
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", id),
      unitId: "unit-u",
      textHash: hash,
      textLength: text.length,
      verificationState: "unverified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });

    let resolveDelete!: (value: unknown) => void;
    runtime.adapter.deleteMemoryDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const forgetPromise = forgetMemory(runtime as any, id);
    await vi.waitFor(() => {
      expect(runtime.repos.memories.getById(id)!.mutation_owner_key?.startsWith("forget:")).toBe(true);
    });

    const blocked = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:reverify-blocked",
      owner: "tool",
    });
    expect(blocked.outcome).toBe("in_progress");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();

    resolveDelete({ ok: true, value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 } });
    expect(await forgetPromise).toEqual({ outcome: "forgotten" });
    expect(runtime.repos.memories.getById(id)!.status).toBe("deleted");
    expect(runtime.repos.memories.getById(id)!.mutation_generation).toBe(2);

    // Stale delayed reverify CAS against the pre-delete generation must not revive the row.
    const staleKey = `reverify:${id}:${hash}:g1`;
    expect(
      runtime.repos.memories.applyReverifyCas({
        id,
        unitId: "unit-stale",
        textHash: hash,
        verificationState: "verified",
        updatedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        ownerKey: staleKey,
        expectedGeneration: 1,
        expectedBankId: runtime.profileBankId,
        expectedDocumentId: buildOwnedDocumentId("profile", null, "preference", id),
        progressToken: "stale-token",
      }),
    ).toBe(false);
    expect(runtime.repos.memories.getById(id)!.status).toBe("deleted");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
  });

  it("update-first claim blocks duplicate reverify until replace completes", async () => {
    const runtime = makeRuntime();
    const original = "Unverified preference before update race.";
    const updated = "Updated preference winning the race.";
    const hash = sha256(original);
    const id = "reverify-race-update";
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", id),
      unitId: "unit-u",
      textHash: hash,
      textLength: original.length,
      verificationState: "unverified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });

    let resolveRetain!: (value: unknown) => void;
    runtime.adapter.retainOneMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetain = resolve;
        }),
    );

    const replacePromise = replaceMemory(runtime as any, {
      targetMemoryId: id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:update-first",
      idempotencyKey: `command:update:${id}:${hash}:${sha256(updated)}`,
      expectedTargetTextHash: hash,
      owner: "command",
    });
    await vi.waitFor(() => {
      expect(runtime.repos.memories.getById(id)!.mutation_owner_key).toContain("command:update:");
    });

    const blocked = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: original,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:reverify-during-update",
      owner: "tool",
    });
    expect(blocked.outcome).toBe("in_progress");

    resolveRetain({ ok: true, value: { unitId: "unit-updated" } });
    expect(await replacePromise).toEqual({ outcome: "replaced", memoryId: id });
    expect(runtime.repos.memories.getById(id)!.text_hash).toBe(sha256(updated));
  });

  it("already-verified exact duplicate performs no mutation and no ownership claim", async () => {
    const runtime = makeRuntime();
    const text = "Already verified preference stays cheap duplicate.";
    const written = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:cheap-dup",
      owner: "command",
    });
    expect(written.outcome).toBe("written");
    runtime.adapter.retainOneMemory.mockClear();
    runtime.adapter.ensureOwnedBank.mockClear();
    const before = runtime.repos.memories.listActive("profile", null)[0]!;
    const dup = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s2",
      sourceRef: "test:cheap-dup",
      owner: "command",
    });
    expect(dup.outcome).toBe("duplicate");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    const after = runtime.repos.memories.getById(before.id)!;
    expect(after.mutation_generation).toBe(before.mutation_generation);
    expect(after.mutation_owner_key).toBeNull();
  });
});

describe("adapter delete postcondition ambiguity", () => {
  const VALID_BANK_ID = profileBankId("profile-test-id");
  const VALID_DOCUMENT_ID = buildOwnedDocumentId("profile", null, "preference", "memory-1");

  it("marks GET/list transport, malformed, and inconsistent postconditions ambiguous after acknowledged DELETE", async () => {
    const bankId = VALID_BANK_ID;
    const documentId = VALID_DOCUMENT_ID;
    const encodedBank = encodeURIComponent(bankId);
    const encodedDocument = encodeURIComponent(documentId);

    const timeoutServer = await startMockServer();
    timeoutServer.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    timeoutServer.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    const timedOut = await new HindsightAdapter({ baseUrl: timeoutServer.baseUrl }).deleteMemoryDocument(bankId, documentId);
    expect(timedOut).toMatchObject({ ok: false, ambiguous: true });

    const malformedServer = await startMockServer();
    malformedServer.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    malformedServer.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    malformedServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`, (_req, res) => {
      json(res, 200, { items: "bad", total: 0, limit: 2, offset: 0 });
    });
    const malformed = await new HindsightAdapter({ baseUrl: malformedServer.baseUrl }).deleteMemoryDocument(bankId, documentId);
    expect(malformed).toMatchObject({ ok: false, ambiguous: true });

    const inconsistentServer = await startMockServer();
    inconsistentServer.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    inconsistentServer.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    inconsistentServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`, (_req, res) => {
      json(res, 200, { items: [{ id: "u1" }], total: 1, limit: 2, offset: 0 });
    });
    const inconsistent = await new HindsightAdapter({ baseUrl: inconsistentServer.baseUrl }).deleteMemoryDocument(
      bankId,
      documentId,
    );
    expect(inconsistent).toMatchObject({ ok: false, ambiguous: true });
  });
});

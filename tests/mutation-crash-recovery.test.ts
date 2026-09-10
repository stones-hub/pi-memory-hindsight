import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId } from "../src/identity/bank-id.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";
import { remember } from "../src/governance/remember-service.js";
import { replaceMemory } from "../src/governance/replace-service.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import {
  MUTATION_OPERATION_LEASE_MS,
  normalizeMutationOwnership,
  applyProgressScopedOutcome,
} from "../src/governance/mutation-ownership.js";
import {
  advanceMutationNowForTests,
  mutationNowIso,
  resetMutationNowForTests,
  setMutationNowForTests,
} from "../src/governance/mutation-clock.js";
import { HindsightAdapter } from "../src/provider/hindsight-adapter.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
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
      maintenance: new MaintenanceRepository(db),
    },
  };
}

type Runtime = ReturnType<typeof makeRuntime>;

function plantActiveMemory(runtime: Runtime, text: string, id = "crash-mem-1") {
  const hash = sha256(text);
  const documentId = buildOwnedDocumentId("profile", null, "preference", id);
  runtime.repos.memories.create({
    id,
    scope: "profile",
    memoryType: "preference",
    projectIdentity: null,
    bankId: runtime.profileBankId,
    documentId,
    unitId: "unit-1",
    textHash: hash,
    textLength: text.length,
    verificationState: "verified",
    sourceSessionId: "s1",
    sourceRef: "test:crash",
    supersedesMemoryId: null,
    expiresAt: null,
    status: "active",
  });
  return runtime.repos.memories.getById(id)!;
}

/**
 * Simulates a crashed Pi window: operation left in_progress with owner + progress token.
 */
function plantInProgressCrash(
  runtime: Runtime,
  row: ReturnType<typeof plantActiveMemory>,
  params: {
    key: string;
    action: "create" | "replace" | "delete";
    expectedTextHash: string;
    crashAtMs: number;
  },
) {
  setMutationNowForTests(params.crashAtMs);
  const at = mutationNowIso();
  runtime.db
    .prepare(
      `INSERT INTO operations (
        idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
        state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
      ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', 1, ?, ?, ?, 1)`,
    )
    .run(
      params.key,
      row.id,
      params.action,
      row.bank_id,
      row.document_id,
      params.expectedTextHash,
      at,
      at,
      row.mutation_generation,
    );
  runtime.db
    .prepare(
      `UPDATE memories
       SET status = 'reconciling', mutation_owner_key = ?, mutation_progress_token = ?
       WHERE id = ?`,
    )
    .run(params.key, at, row.id);
  return { progressToken: at, key: params.key };
}

afterEach(() => {
  resetMutationNowForTests();
});

describe("mutation crash recovery and leases", () => {
  it("blocks second window for replace/delete/reverify while in_progress lease is live", async () => {
    const cases: Array<{
      action: "replace" | "delete" | "reverify";
      id: string;
    }> = [
      { action: "replace", id: "lease-replace" },
      { action: "delete", id: "lease-delete" },
      { action: "reverify", id: "lease-reverify" },
    ];
    for (const { action, id } of cases) {
      const runtime = makeRuntime();
      const text = `Lease live ${action}`;
      const hash = sha256(text);
      if (action === "reverify") {
        runtime.repos.memories.create({
          id,
          scope: "profile",
          memoryType: "preference",
          projectIdentity: null,
          bankId: runtime.profileBankId,
          documentId: buildOwnedDocumentId("profile", null, "preference", id),
          unitId: "unit-1",
          textHash: hash,
          textLength: text.length,
          verificationState: "unverified",
          sourceSessionId: "s1",
          sourceRef: "test:crash",
          supersedesMemoryId: null,
          expiresAt: null,
          status: "active",
        });
      } else {
        plantActiveMemory(runtime, text, id);
      }
      const row = runtime.repos.memories.getById(id)!;
      const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
      const key =
        action === "delete"
          ? `forget:${row.id}:g1:${row.text_hash}:${row.document_id}`
          : action === "replace"
            ? `command:update:${row.id}:${row.text_hash}:${sha256("next")}`
            : `reverify:${row.id}:${row.text_hash}:g1`;
      plantInProgressCrash(runtime, row, {
        key,
        action: action === "delete" ? "delete" : "replace",
        expectedTextHash: action === "replace" ? sha256("next") : row.text_hash,
        crashAtMs: crashAt,
      });
      setMutationNowForTests(crashAt + Math.floor(MUTATION_OPERATION_LEASE_MS / 2));

      // A different logical mutation must observe busy while the lease is live.
      if (action === "delete") {
        expect(
          (
            await replaceMemory(runtime as any, {
              targetMemoryId: row.id,
              scope: "profile",
              memoryType: "preference",
              text: "hijack",
              cwd: "/repo",
              sourceSessionId: "s1",
              sourceRef: "test:lease",
              idempotencyKey: `other:update:${row.id}`,
              owner: "command",
            })
          ).outcome,
        ).toBe("in_progress");
      } else {
        expect((await forgetMemory(runtime as any, row.id)).outcome).toBe("in_progress");
      }
      expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
      expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    }
  });

  it("after lease expiry same replace takes over, verifies first, and finalizes without duplicate retain", async () => {
    const runtime = makeRuntime();
    const original = "Crash replace original.";
    const updated = "Crash replace updated.";
    const row = plantActiveMemory(runtime, original);
    const key = `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: sha256(updated),
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: true,
      value: { unitId: "unit-already" },
    });

    const resumed = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:takeover-replace",
      idempotencyKey: key,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(resumed.outcome).toBe("replaced");
    expect(runtime.adapter.verifyOneUnitDocument).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(row.id)!.text_hash).toBe(sha256(updated));
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBeNull();
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
  });

  it("after lease expiry same delete proves absence without issuing DELETE", async () => {
    const runtime = makeRuntime();
    const text = "Crash delete target.";
    const row = plantActiveMemory(runtime, text);
    const key = `forget:${row.id}:g1:${row.text_hash}:${row.document_id}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "delete",
      expectedTextHash: row.text_hash,
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    runtime.adapter.verifyDeletionPostconditions.mockResolvedValueOnce({
      ok: true,
      value: { absent: true },
    });

    const resumed = await forgetMemory(runtime as any, row.id);
    expect(resumed.outcome).toBe("forgotten");
    expect(runtime.adapter.verifyDeletionPostconditions).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");
    const audits = runtime.db.prepare("SELECT event_type, outcome, redacted_code FROM audit_events").all() as Array<{
      event_type: string;
      outcome: string;
      redacted_code: string | null;
    }>;
    expect(audits.some((a) => a.event_type === "forget" && a.outcome === "deleted")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(text);
  });

  it("ambiguous GET/list on delete takeover performs no mutation", async () => {
    const runtime = makeRuntime();
    const row = plantActiveMemory(runtime, "Ambiguous delete proof.");
    const key = `forget:${row.id}:g1:${row.text_hash}:${row.document_id}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "delete",
      expectedTextHash: row.text_hash,
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    runtime.adapter.verifyDeletionPostconditions.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      category: "timeout",
      ambiguous: true,
    });

    const result = await forgetMemory(runtime as any, row.id);
    expect(result.outcome).toBe("unknown");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("reconciling");
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("reconciling");
  });

  it("reconciling create/replace/reverify issue zero retain when direct verify is unproven", async () => {
    const cases: Array<"create" | "replace" | "reverify"> = ["create", "replace", "reverify"];
    for (const action of cases) {
      const runtime = makeRuntime();
      const text =
        action === "replace" ? "Replace prior body." : `Unproven verify ${action} body.`;
      const updated = action === "replace" ? "Replace next body." : text;
      const hash = sha256(text);
      const id = `unproven-${action}`;
      if (action === "reverify") {
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
          sourceSessionId: "s1",
          sourceRef: "test:unproven-verify",
          supersedesMemoryId: null,
          expiresAt: null,
          status: "active",
        });
      } else if (action === "create") {
        const documentId = buildOwnedDocumentId("profile", null, "preference", id);
        runtime.repos.memories.create({
          id,
          scope: "profile",
          memoryType: "preference",
          projectIdentity: null,
          bankId: runtime.profileBankId,
          documentId,
          unitId: null,
          textHash: hash,
          textLength: text.length,
          verificationState: "verified",
          sourceSessionId: "s1",
          sourceRef: "test:unproven-verify",
          supersedesMemoryId: null,
          expiresAt: null,
          status: "reconciling",
        });
      } else {
        plantActiveMemory(runtime, text, id);
      }
      const row = runtime.repos.memories.getById(id)!;
      const crashAt = Date.parse("2026-07-01T00:00:00.000Z");
      const key =
        action === "create"
          ? `remember:profile:preference:-:${hash}`
          : action === "replace"
            ? `command:update:${id}:${hash}:${sha256(updated)}`
            : `reverify:${id}:${hash}:g1`;
      plantInProgressCrash(runtime, row, {
        key,
        action: action === "reverify" ? "replace" : action,
        expectedTextHash: action === "replace" ? sha256(updated) : hash,
        crashAtMs: crashAt,
      });
      setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

      runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
        ok: false,
        reason: "list timed out",
        category: "timeout",
        ambiguous: true,
      });

      if (action === "replace") {
        const result = await replaceMemory(runtime as any, {
          targetMemoryId: id,
          scope: "profile",
          memoryType: "preference",
          text: updated,
          cwd: "/repo",
          sourceSessionId: "s1",
          sourceRef: "test:unproven-verify",
          idempotencyKey: key,
          expectedTargetTextHash: hash,
          owner: "command",
        });
        expect(result.outcome).toBe("unknown");
      } else {
        const result = await remember(runtime as any, {
          scope: "profile",
          memoryType: "preference",
          text,
          cwd: "/repo",
          sourceSessionId: "s1",
          sourceRef: "test:unproven-verify",
          owner: action === "create" ? "command" : "tool",
          ...(action === "create" ? { idempotencyKey: key } : {}),
        });
        expect(result.outcome).toBe("unknown");
      }
      expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
      expect(runtime.repos.memories.getById(id)!.status).toBe("reconciling");
      expect(runtime.repos.operations.getByKey(key)!.state).toBe("reconciling");
    }
  });

  it("reconciling create/replace/reverify allow exactly one retain after proven zero-unit verify", async () => {
    const cases: Array<"create" | "replace" | "reverify"> = ["create", "replace", "reverify"];
    for (const action of cases) {
      const runtime = makeRuntime();
      const text =
        action === "replace" ? "Retry prior body." : `Proven zero ${action} body.`;
      const updated = action === "replace" ? "Retry next body." : text;
      const hash = sha256(text);
      const id = `proven-zero-${action}`;
      if (action === "reverify") {
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
          sourceSessionId: "s1",
          sourceRef: "test:proven-zero",
          supersedesMemoryId: null,
          expiresAt: null,
          status: "active",
        });
      } else if (action === "create") {
        runtime.repos.memories.create({
          id,
          scope: "profile",
          memoryType: "preference",
          projectIdentity: null,
          bankId: runtime.profileBankId,
          documentId: buildOwnedDocumentId("profile", null, "preference", id),
          unitId: null,
          textHash: hash,
          textLength: text.length,
          verificationState: "verified",
          sourceSessionId: "s1",
          sourceRef: "test:proven-zero",
          supersedesMemoryId: null,
          expiresAt: null,
          status: "reconciling",
        });
      } else {
        plantActiveMemory(runtime, text, id);
      }
      const row = runtime.repos.memories.getById(id)!;
      const crashAt = Date.parse("2026-07-02T00:00:00.000Z");
      const key =
        action === "create"
          ? `remember:profile:preference:-:${hash}`
          : action === "replace"
            ? `command:update:${id}:${hash}:${sha256(updated)}`
            : `reverify:${id}:${hash}:g1`;
      plantInProgressCrash(runtime, row, {
        key,
        action: action === "reverify" ? "replace" : action,
        expectedTextHash: action === "replace" ? sha256(updated) : hash,
        crashAtMs: crashAt,
      });
      setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

      runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
        ok: false,
        reason: "post-write verification failed: expected exactly one live unit, found 0",
        category: "validation",
      });
      runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: true, value: { unitId: "unit-retry" } });

      if (action === "replace") {
        const result = await replaceMemory(runtime as any, {
          targetMemoryId: id,
          scope: "profile",
          memoryType: "preference",
          text: updated,
          cwd: "/repo",
          sourceSessionId: "s1",
          sourceRef: "test:proven-zero",
          idempotencyKey: key,
          expectedTargetTextHash: hash,
          owner: "command",
        });
        expect(result.outcome).toBe("replaced");
      } else {
        const result = await remember(runtime as any, {
          scope: "profile",
          memoryType: "preference",
          text,
          cwd: "/repo",
          sourceSessionId: "s1",
          sourceRef: "test:proven-zero",
          owner: action === "create" ? "command" : "tool",
          ...(action === "create" ? { idempotencyKey: key } : {}),
        });
        expect(["written", "duplicate"]).toContain(result.outcome);
      }
      expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
      expect(runtime.repos.memories.getById(id)!.status).toBe("active");
      expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
    }
  });

  it("wrong action remains blocked until original reconciliation resolves after expiry takeover", async () => {
    const runtime = makeRuntime();
    const original = "Owned by replace crash.";
    const row = plantActiveMemory(runtime, original);
    const key = `command:update:${row.id}:${row.text_hash}:${sha256("next-body")}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: sha256("next-body"),
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    // Foreign forget: takeover converts foreign? No — foreign claim should still be busy
    // after expired in_progress is normalized to reconciling under original owner.
    const blocked = await forgetMemory(runtime as any, row.id);
    expect(blocked.outcome).toBe("in_progress");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(row.id)!.mutation_owner_key).toBe(key);
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("reconciling");
  });

  it("stale old completion after takeover cannot change row/op", async () => {
    const runtime = makeRuntime();
    const original = "Stale completion victim.";
    const updated = "Stale completion new.";
    const row = plantActiveMemory(runtime, original);
    const key = `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    const planted = plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: sha256(updated),
      crashAtMs: crashAt,
    });
    const staleToken = planted.progressToken;

    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: true,
      value: { unitId: "unit-takeover" },
    });
    const resumed = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:stale-complete",
      idempotencyKey: key,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(resumed.outcome).toBe("replaced");
    const gen = runtime.repos.memories.getById(row.id)!.mutation_generation;

    // Old process still holding stale progress token cannot reactivate/delete/replace.
    expect(
      runtime.repos.memories.applyReplace({
        id: row.id,
        unitId: "unit-stale",
        textHash: sha256("evil"),
        textLength: 4,
        verificationState: "verified",
        updatedAt: mutationNowIso(),
        lastVerifiedAt: mutationNowIso(),
        expiresAt: null,
        sourceSessionId: null,
        sourceRef: null,
        ownerKey: key,
        expectedGeneration: gen - 1,
        progressToken: staleToken,
      }),
    ).toBe(false);
    expect(
      runtime.repos.operations.tryCommitFromProgress(key, staleToken),
    ).toBe(false);
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
    expect(runtime.repos.memories.getById(row.id)!.text_hash).toBe(sha256(updated));
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("active");
  });

  it("reverify crash takeover verifies before retain and blocks competing forget", async () => {
    const runtime = makeRuntime();
    const text = "Unverified reverify crash.";
    const hash = sha256(text);
    const id = "reverify-crash-1";
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
      sourceSessionId: "s1",
      sourceRef: "test:reverify-crash",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "active",
    });
    const row = runtime.repos.memories.getById(id)!;
    const key = `reverify:${id}:${hash}:g1`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: hash,
      crashAtMs: crashAt,
    });

    setMutationNowForTests(crashAt + Math.floor(MUTATION_OPERATION_LEASE_MS / 2));
    const blocked = await forgetMemory(runtime as any, id);
    expect(blocked.outcome).toBe("in_progress");

    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: true,
      value: { unitId: "unit-reverified" },
    });
    const resumed = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:reverify-resume",
      owner: "tool",
    });
    expect(resumed.outcome).toBe("duplicate");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(id)!.verification_state).toBe("verified");
  });

  it("create crash takeover verifies first and converges without duplicate retain", async () => {
    const runtime = makeRuntime();
    const text = "Create crash body.";
    const hash = sha256(text);
    const id = "create-crash-1";
    const documentId = buildOwnedDocumentId("profile", null, "preference", id);
    const key = `command:remember:profile:preference:${hash}`;
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId,
      unitId: null,
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: "s1",
      sourceRef: "test:create-crash",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "reconciling",
      mutationGeneration: 1,
      mutationOwnerKey: key,
    });
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES (?, ?, 'create', ?, ?, ?, 'in_progress', 1, ?, ?, 1, 1)`,
      )
      .run(key, id, runtime.profileBankId, documentId, hash, at, at);
    runtime.repos.memories.setMutationProgressToken(id, key, at);

    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: true,
      value: { unitId: "unit-created" },
    });

    const resumed = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:create-crash",
      owner: "command",
      idempotencyKey: key,
    });
    expect(resumed.outcome).toBe("written");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(id)!.status).toBe("active");
  });

  it("normalizes ownerless reconciling: definite pre-mutation failure restores active; maybe-mutated rebinds owner", () => {
    const runtime = makeRuntime();
    const text = "Normalize ownerless.";
    const row = plantActiveMemory(runtime, text, "norm-1");
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();

    // Definite pre-mutation failed replace, owner already cleared.
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES ('failed-pre', ?, 'replace', ?, ?, ?, 'failed', 1, ?, ?, 1, 0)`,
      )
      .run(row.id, row.bank_id, row.document_id, sha256("x"), at, at);
    runtime.db
      .prepare(`UPDATE memories SET status = 'reconciling', mutation_owner_key = NULL, mutation_progress_token = NULL WHERE id = ?`)
      .run(row.id);

    const restored = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row.id)!),
    );
    expect(restored.status).toBe("active");
    expect(restored.mutation_owner_key).toBeNull();

    // Maybe-mutated reconciling op without owner.
    const row2 = plantActiveMemory(runtime, "Maybe mutated row.", "norm-2");
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES ('maybe-mut', ?, 'replace', ?, ?, ?, 'reconciling', 1, ?, ?, 1, 1)`,
      )
      .run(row2.id, row2.bank_id, row2.document_id, sha256("y"), at, at);
    runtime.db
      .prepare(`UPDATE memories SET status = 'reconciling', mutation_owner_key = NULL WHERE id = ?`)
      .run(row2.id);

    const rebound = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row2.id)!),
    );
    expect(rebound.status).toBe("reconciling");
    expect(rebound.mutation_owner_key).toBe("maybe-mut");
  });

  it("reconciling replace absence then definite bank failure stays reconciling", async () => {
    const runtime = makeRuntime();
    const original = "Replace prior truth.";
    const updated = "Replace new truth.";
    const row = plantActiveMemory(runtime, original, "abs-bank-1");
    const key = `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`;
    const crashAt = Date.parse("2026-04-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: sha256(updated),
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "missing",
      category: "validation",
    });
    runtime.adapter.ensureOwnedBank.mockResolvedValueOnce({
      ok: false,
      reason: "bank down",
      category: "http",
      status: 500,
      // definite (not ambiguous)
    });

    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:abs-bank",
      idempotencyKey: key,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(result.outcome).toBe("unknown");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.mutation_owner_key).toBe(key);
    expect(after.text_hash).toBe(sha256(original));
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("reconciling");
  });

  it("reconciling reverify mismatch then definite retain failure stays reconciling", async () => {
    const runtime = makeRuntime();
    const text = "Reverify mismatch body.";
    const hash = sha256(text);
    const id = "abs-reverify-1";
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
      sourceSessionId: "s1",
      sourceRef: "test:abs-reverify",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "active",
    });
    const row = runtime.repos.memories.getById(id)!;
    const key = `reverify:${id}:${hash}:g1`;
    const crashAt = Date.parse("2026-04-02T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "replace",
      expectedTextHash: hash,
      crashAtMs: crashAt,
    });
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "text mismatch",
      category: "validation",
    });
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "retain rejected",
      category: "http",
      status: 400,
    });

    const result = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:abs-reverify",
      owner: "tool",
    });
    expect(result.outcome).toBe("unknown");
    const after = runtime.repos.memories.getById(id)!;
    expect(after.status).toBe("reconciling");
    expect(after.mutation_owner_key).toBe(key);
    expect(after.verification_state).toBe("unverified");
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("reconciling");
  });

  it("fresh non-reconciling definite bank failure still restores active on replace", async () => {
    const runtime = makeRuntime();
    const original = "Fresh replace prior.";
    const updated = "Fresh replace next.";
    const row = plantActiveMemory(runtime, original, "fresh-bank-1");
    runtime.adapter.ensureOwnedBank.mockResolvedValueOnce({
      ok: false,
      reason: "bank down",
      category: "http",
      status: 400,
      ambiguous: false,
    });
    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:fresh-bank",
      idempotencyKey: `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(result.outcome).toBe("rejected");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("active");
    expect(after.mutation_owner_key).toBeNull();
    expect(after.text_hash).toBe(sha256(original));
  });

  it("post-issuance definite 4xx (ambiguous:false) may release prior active truth on replace", async () => {
    const runtime = makeRuntime();
    const original = "Pre-issuance truth.";
    const updated = "Would-be replacement.";
    const row = plantActiveMemory(runtime, original, "post-iss-4xx");
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "retain rejected",
      category: "http",
      status: 400,
      ambiguous: false,
    });
    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:post-iss-4xx",
      idempotencyKey: `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(result.outcome).toBe("rejected");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("active");
    expect(after.text_hash).toBe(sha256(original));
    expect(after.mutation_owner_key).toBeNull();
    const ops = runtime.db.prepare("SELECT * FROM operations WHERE memory_id = ?").all(row.id) as Array<{
      provider_mutation_issued: number;
      state: string;
    }>;
    expect(ops.some((o) => o.provider_mutation_issued === 1 && o.state === "failed")).toBe(true);
  });

  it("post-issuance failure without ambiguous flag must not release_active on replace", async () => {
    const runtime = makeRuntime();
    const original = "Must stay reconciling.";
    const updated = "Unproven mutation outcome.";
    const row = plantActiveMemory(runtime, original, "post-iss-undef");
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "custom adapter omitted ambiguous",
      category: "validation",
    });
    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:post-iss-undef",
      idempotencyKey: `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(result.outcome).toBe("unknown");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.text_hash).toBe(sha256(original));
    expect(after.mutation_owner_key).not.toBeNull();
  });

  it("post-issuance delete failure without ambiguous flag must not release_active", async () => {
    const runtime = makeRuntime();
    const row = plantActiveMemory(runtime, "Delete unproven.", "post-iss-del");
    runtime.adapter.deleteMemoryDocument.mockResolvedValueOnce({
      ok: false,
      reason: "custom adapter omitted ambiguous",
      category: "validation",
    });
    const result = await forgetMemory(runtime as any, row.id);
    expect(result.outcome).toBe("unknown");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.mutation_owner_key).not.toBeNull();
  });

  it("mismatched/stale-generation owner and committed+reconciling fail closed without history rebound", () => {
    const runtime = makeRuntime();
    const row = plantActiveMemory(runtime, "Owner eligibility.", "owner-elig-1");
    const crashAt = Date.parse("2026-05-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();

    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES
          ('stale-owner-g1', ?, 'replace', ?, ?, ?, 'failed', 1, ?, ?, 1, 0),
          ('hist-rebind', ?, 'replace', ?, ?, ?, 'reconciling', 1, ?, ?, 2, 1)`,
      )
      .run(
        row.id,
        row.bank_id,
        row.document_id,
        sha256("x"),
        at,
        at,
        row.id,
        row.bank_id,
        row.document_id,
        sha256("y"),
        at,
        at,
      );
    runtime.db
      .prepare(
        `UPDATE memories
         SET status = 'reconciling', mutation_generation = 2, mutation_owner_key = 'stale-owner-g1',
             mutation_progress_token = NULL
         WHERE id = ?`,
      )
      .run(row.id);

    const staleOwned = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row.id)!),
    );
    expect(staleOwned.mutation_owner_key).toBe("stale-owner-g1");
    expect(staleOwned.status).toBe("reconciling");

    // committed owner + reconciling row must not clear and select hist-rebind.
    runtime.db
      .prepare(`UPDATE operations SET state = 'committed' WHERE idempotency_key = 'stale-owner-g1'`)
      .run();
    // Re-point owner to a committed op that still fails generation match after we fix generation on op?
    // Use a committed op with matching generation but reconciling row:
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES ('committed-owner', ?, 'replace', ?, ?, ?, 'committed', 1, ?, ?, 2, 1)`,
      )
      .run(row.id, row.bank_id, row.document_id, sha256("z"), at, at);
    runtime.db
      .prepare(
        `UPDATE memories SET mutation_owner_key = 'committed-owner', status = 'reconciling' WHERE id = ?`,
      )
      .run(row.id);

    const committedReconciling = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row.id)!),
    );
    expect(committedReconciling.mutation_owner_key).toBe("committed-owner");
    expect(committedReconciling.status).toBe("reconciling");
  });

  it("applyProgressScopedOutcome rolls back op CAS when memory CAS fails", () => {
    const runtime = makeRuntime();
    const row = plantActiveMemory(runtime, "Atomic outcome.", "atomic-1");
    const key = "atomic-op-1";
    const crashAt = Date.parse("2026-06-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES (?, ?, 'replace', ?, ?, ?, 'in_progress', 1, ?, ?, 1, 0)`,
      )
      .run(key, row.id, row.bank_id, row.document_id, sha256("n"), at, at);
    runtime.db
      .prepare(
        `UPDATE memories
         SET status = 'reconciling', mutation_owner_key = ?, mutation_progress_token = ?
         WHERE id = ?`,
      )
      .run(key, at, row.id);

    const ok = applyProgressScopedOutcome(runtime as any, {
      memoryId: row.id,
      ownerKey: key,
      progressToken: at,
      expectedGeneration: 99, // force memory CAS mismatch while op progress matches
      opState: "failed",
      memory: "release_active",
    });
    expect(ok).toBe(false);
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("in_progress");
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.mutation_owner_key).toBe(key);
    expect(after.mutation_progress_token).toBe(at);
  });

  it("does not rebind prior-generation failed/reconciling history onto current ownerless reconciling", () => {
    const runtime = makeRuntime();
    const row = plantActiveMemory(runtime, "Current generation truth.", "gen-hist-1");
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();

    // Prior generation replace failed (definite) — must not restore/govern gen 2.
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES ('old-failed-g1', ?, 'replace', ?, ?, ?, 'failed', 1, ?, ?, 1, 0)`,
      )
      .run(row.id, row.bank_id, row.document_id, sha256("old"), at, at);
    // Advance local generation as if a later mutation committed.
    runtime.db.prepare(`UPDATE memories SET mutation_generation = 2 WHERE id = ?`).run(row.id);
    runtime.db
      .prepare(
        `UPDATE memories SET status = 'reconciling', mutation_owner_key = NULL, mutation_progress_token = NULL WHERE id = ?`,
      )
      .run(row.id);

    const unchanged = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row.id)!),
    );
    expect(unchanged.status).toBe("reconciling");
    expect(unchanged.mutation_owner_key).toBeNull();
    expect(unchanged.mutation_generation).toBe(2);

    // Two eligible current-generation live ops — fail closed, do not pick arbitrarily.
    const row2 = plantActiveMemory(runtime, "Tie row.", "gen-hist-2");
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES
          ('tie-a', ?, 'replace', ?, ?, ?, 'reconciling', 1, ?, ?, 1, 1),
          ('tie-b', ?, 'delete', ?, ?, ?, 'reconciling', 1, ?, ?, 1, 1)`,
      )
      .run(
        row2.id,
        row2.bank_id,
        row2.document_id,
        sha256("a"),
        at,
        at,
        row2.id,
        row2.bank_id,
        row2.document_id,
        row2.text_hash,
        at,
        at,
      );
    runtime.db
      .prepare(`UPDATE memories SET status = 'reconciling', mutation_owner_key = NULL WHERE id = ?`)
      .run(row2.id);
    const tied = runtime.db.transaction(() =>
      normalizeMutationOwnership(runtime as any, runtime.repos.memories.getById(row2.id)!),
    );
    expect(tied.mutation_owner_key).toBeNull();
    expect(tied.status).toBe("reconciling");
  });

  it("stale delayed create verify failure cannot overwrite a committed create", async () => {
    const runtime = makeRuntime();
    const text = "Stale create second body.";
    const hash = sha256(text);
    const id = "stale-create-2";
    const documentId = buildOwnedDocumentId("profile", null, "preference", id);
    const key = `remember:profile:preference:-:${hash}`;
    const crashAt = Date.parse("2026-02-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    const at = mutationNowIso();
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId,
      unitId: null,
      textHash: hash,
      textLength: text.length,
      verificationState: "verified",
      sourceSessionId: "s1",
      sourceRef: "test:stale-create-2",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "reconciling",
      mutationGeneration: 1,
      mutationOwnerKey: key,
    });
    runtime.db
      .prepare(
        `INSERT INTO operations (
          idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
          state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
        ) VALUES (?, ?, 'create', ?, ?, ?, 'in_progress', 1, ?, ?, 1, 1)`,
      )
      .run(key, id, runtime.profileBankId, documentId, hash, at, at);
    runtime.repos.memories.setMutationProgressToken(id, key, at);

    let releaseVerify!: (value: unknown) => void;
    const verifyGate = new Promise((resolve) => {
      releaseVerify = resolve;
    });
    let verifyCalls = 0;
    runtime.adapter.verifyOneUnitDocument.mockImplementation(async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        await verifyGate;
        return { ok: false, reason: "timeout", category: "timeout", ambiguous: true };
      }
      return { ok: true, value: { unitId: "unit-winner" } };
    });

    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);
    const stalePromise = remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:stale-create-2",
      owner: "command",
      idempotencyKey: key,
    });

    // Wait until the stale attempt is blocked inside verify.
    for (let i = 0; i < 20 && verifyCalls < 1; i++) await Promise.resolve();
    expect(verifyCalls).toBe(1);

    // Expire the stale attempt's refreshed lease; second window verifies and commits.
    const begunAt = Date.parse(runtime.repos.operations.getByKey(key)!.updated_at);
    setMutationNowForTests(begunAt + MUTATION_OPERATION_LEASE_MS + 1);
    const winner = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:stale-create-2",
      owner: "command",
      idempotencyKey: key,
    });
    expect(winner.outcome).toBe("written");
    expect(runtime.repos.memories.getById(id)!.status).toBe("active");
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");

    releaseVerify(undefined);
    const stale = await stalePromise;
    expect(stale.outcome).toBe("unknown");
    const finalRow = runtime.repos.memories.getById(id)!;
    expect(finalRow.status).toBe("active");
    expect(finalRow.mutation_owner_key).toBeNull();
    expect(finalRow.mutation_progress_token).toBeNull();
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
  });

  it("stale delayed delete ambiguous verify cannot revive a committed delete", async () => {
    const runtime = makeRuntime();
    const text = "Stale delete target.";
    const row = plantActiveMemory(runtime, text, "stale-del-1");
    const key = `forget:${row.id}:g1:${row.text_hash}:${row.document_id}`;
    const crashAt = Date.parse("2026-03-01T00:00:00.000Z");
    plantInProgressCrash(runtime, row, {
      key,
      action: "delete",
      expectedTextHash: row.text_hash,
      crashAtMs: crashAt,
    });

    let releaseProof!: (value: unknown) => void;
    const proofGate = new Promise((resolve) => {
      releaseProof = resolve;
    });
    let proofCalls = 0;
    runtime.adapter.verifyDeletionPostconditions.mockImplementation(async () => {
      proofCalls += 1;
      if (proofCalls === 1) {
        await proofGate;
        return { ok: false, reason: "timeout", category: "timeout", ambiguous: true };
      }
      return { ok: true, value: { absent: true } };
    });

    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 1);
    const stalePromise = forgetMemory(runtime as any, row.id);
    for (let i = 0; i < 20 && proofCalls < 1; i++) await Promise.resolve();
    expect(proofCalls).toBe(1);

    const begunAt = Date.parse(runtime.repos.operations.getByKey(key)!.updated_at);
    setMutationNowForTests(begunAt + MUTATION_OPERATION_LEASE_MS + 1);
    const won = await forgetMemory(runtime as any, row.id);
    expect(won.outcome).toBe("forgotten");
    expect(runtime.repos.memories.getById(row.id)!.status).toBe("deleted");
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
    const gen = runtime.repos.memories.getById(row.id)!.mutation_generation;

    releaseProof(undefined);
    const stale = await stalePromise;
    expect(stale.outcome).toBe("unknown");
    const finalRow = runtime.repos.memories.getById(row.id)!;
    expect(finalRow.status).toBe("deleted");
    expect(finalRow.mutation_generation).toBe(gen);
    expect(finalRow.mutation_owner_key).toBeNull();
    expect(finalRow.mutation_progress_token).toBeNull();
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("committed");
  });

  it("uses controllable time rather than sleeping for lease expiry", () => {
    const crashAt = Date.parse("2026-01-01T00:00:00.000Z");
    setMutationNowForTests(crashAt);
    expect(mutationNowIso()).toBe("2026-01-01T00:00:00.000Z");
    advanceMutationNowForTests(MUTATION_OPERATION_LEASE_MS + 5);
    setMutationNowForTests(crashAt + MUTATION_OPERATION_LEASE_MS + 5);
    expect(Date.parse(mutationNowIso())).toBe(crashAt + MUTATION_OPERATION_LEASE_MS + 5);
  });

  it("rolls back create finalization when operation commit CAS fails after memory would activate", async () => {
    const runtime = makeRuntime();
    const text = "Atomic create body.";
    const commitSpy = vi.spyOn(runtime.repos.operations, "tryCommitFromProgress").mockReturnValue(false);
    const result = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:atomic-create",
      owner: "command",
    });
    expect(result.outcome).toBe("unknown");
    expect(commitSpy).toHaveBeenCalled();
    const ops = runtime.db.prepare("SELECT * FROM operations").all() as Array<{
      idempotency_key: string;
      state: string;
      memory_id: string;
    }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.state).toBe("in_progress");
    const row = runtime.repos.memories.getById(ops[0]!.memory_id)!;
    expect(row.status).toBe("reconciling");
    expect(row.unit_id).toBeNull();
    expect(row.mutation_owner_key).toBe(ops[0]!.idempotency_key);
    expect(row.mutation_progress_token).not.toBeNull();
    expect(row.mutation_generation).toBe(1);
    commitSpy.mockRestore();
  });

  it("rolls back replace finalization when operation commit CAS fails after memory would apply", async () => {
    const runtime = makeRuntime();
    const original = "Atomic replace prior.";
    const updated = "Atomic replace next.";
    const row = plantActiveMemory(runtime, original, "atomic-replace-1");
    const before = { ...runtime.repos.memories.getById(row.id)! };
    const key = `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`;
    const commitSpy = vi.spyOn(runtime.repos.operations, "tryCommitFromProgress").mockReturnValue(false);
    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:atomic-replace",
      idempotencyKey: key,
      expectedTargetTextHash: sha256(original),
      owner: "command",
    });
    expect(result.outcome).toBe("unknown");
    expect(commitSpy).toHaveBeenCalled();
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.text_hash).toBe(before.text_hash);
    expect(after.unit_id).toBe(before.unit_id);
    expect(after.mutation_generation).toBe(before.mutation_generation);
    expect(after.mutation_owner_key).toBe(key);
    expect(after.mutation_progress_token).not.toBeNull();
    expect(runtime.repos.operations.getByKey(key)!.state).toBe("in_progress");
    commitSpy.mockRestore();
  });

  it("rolls back delete finalization when operation commit CAS fails after memory would delete", async () => {
    const runtime = makeRuntime();
    const text = "Atomic delete target.";
    const row = plantActiveMemory(runtime, text, "atomic-del-1");
    const before = { ...runtime.repos.memories.getById(row.id)! };
    const commitSpy = vi.spyOn(runtime.repos.operations, "tryCommitFromProgress").mockReturnValue(false);
    const result = await forgetMemory(runtime as any, row.id);
    expect(result.outcome).toBe("unknown");
    expect(commitSpy).toHaveBeenCalled();
    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.status).toBe("reconciling");
    expect(after.text_hash).toBe(before.text_hash);
    expect(after.mutation_generation).toBe(before.mutation_generation);
    expect(after.mutation_owner_key).not.toBeNull();
    expect(after.mutation_progress_token).not.toBeNull();
    const op = runtime.repos.operations.getByKey(after.mutation_owner_key!)!;
    expect(op.state).toBe("in_progress");
    commitSpy.mockRestore();
  });

  it("rolls back reverify finalization when operation commit CAS fails after memory would verify", async () => {
    const runtime = makeRuntime();
    const text = "Atomic reverify body.";
    const hash = sha256(text);
    const id = "atomic-reverify-1";
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
      sourceSessionId: "s1",
      sourceRef: "test:atomic-reverify",
      supersedesMemoryId: null,
      expiresAt: null,
      status: "active",
    });
    const before = { ...runtime.repos.memories.getById(id)! };
    runtime.adapter.verifyOneUnitDocument.mockResolvedValue({
      ok: false,
      reason: "missing",
      category: "validation",
    });
    const commitSpy = vi.spyOn(runtime.repos.operations, "tryCommitFromProgress").mockReturnValue(false);
    const result = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "test:atomic-reverify",
      owner: "tool",
    });
    expect(result.outcome).toBe("unknown");
    expect(commitSpy).toHaveBeenCalled();
    const after = runtime.repos.memories.getById(id)!;
    expect(after.status).toBe("reconciling");
    expect(after.verification_state).toBe("unverified");
    expect(after.unit_id).toBe(before.unit_id);
    expect(after.mutation_generation).toBe(before.mutation_generation);
    expect(after.mutation_owner_key?.startsWith("reverify:")).toBe(true);
    expect(after.mutation_progress_token).not.toBeNull();
    expect(runtime.repos.operations.getByKey(after.mutation_owner_key!)!.state).toBe("in_progress");
    commitSpy.mockRestore();
  });
});

describe("provider HTTP timeout ceiling", () => {
  it("clamps requested timeoutMs above the lease basis and exposes effective timeout", async () => {
    const { clampProviderHttpTimeoutMs, PROVIDER_HTTP_TIMEOUT_MS, HttpClient } = await import(
      "../src/provider/http-client.js"
    );
    expect(clampProviderHttpTimeoutMs(60_000)).toBe(PROVIDER_HTTP_TIMEOUT_MS);
    expect(clampProviderHttpTimeoutMs(1_000)).toBe(1_000);
    expect(clampProviderHttpTimeoutMs(undefined)).toBe(PROVIDER_HTTP_TIMEOUT_MS);

    const client = new HttpClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 55_000 });
    expect(client.timeoutMs).toBe(PROVIDER_HTTP_TIMEOUT_MS);

    const adapter = new HindsightAdapter({ baseUrl: "http://127.0.0.1:9", timeoutMs: 55_000 });
    expect(adapter.httpTimeoutMs).toBe(PROVIDER_HTTP_TIMEOUT_MS);
    expect(MUTATION_OPERATION_LEASE_MS).toBe(
      PROVIDER_HTTP_TIMEOUT_MS * 8 + PROVIDER_HTTP_TIMEOUT_MS,
    );
  });
});

describe("adapter verifyDeletionPostconditions", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function startServer(
    routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void>,
  ): Promise<string> {
    const server = http.createServer((req, res) => {
      const key = `${req.method ?? "GET"} ${req.url ?? "/"}`;
      const handler = routes[key];
      if (!handler) {
        res.writeHead(500);
        res.end(`unexpected ${key}`);
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    });
    return baseUrl;
  }

  it("proves absence without DELETE and reports present without mutation", async () => {
    const bankId = profileBankId("profile-test-id");
    const documentId = buildOwnedDocumentId("profile", null, "preference", "doc-logical-1");
    const encodedBank = encodeURIComponent(bankId);
    const encodedDocument = encodeURIComponent(documentId);
    let deleteHits = 0;
    const baseUrl = await startServer({
      [`GET /v1/default/banks/${encodedBank}/documents/${encodedDocument}`]: (_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "missing" }));
      },
      [`GET /v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`]: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [], total: 0, limit: 2, offset: 0 }));
      },
      [`DELETE /v1/default/banks/${encodedBank}/documents/${encodedDocument}`]: (_req, res) => {
        deleteHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, document_id: documentId, memory_units_deleted: 0 }));
      },
    });
    const adapter = new HindsightAdapter({ baseUrl });
    const absent = await adapter.verifyDeletionPostconditions(bankId, documentId);
    expect(absent).toEqual({ ok: true, value: { absent: true } });
    expect(deleteHits).toBe(0);

    const presentUrl = await startServer({
      [`GET /v1/default/banks/${encodedBank}/documents/${encodedDocument}`]: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: documentId }));
      },
    });
    const present = await new HindsightAdapter({ baseUrl: presentUrl }).verifyDeletionPostconditions(
      bankId,
      documentId,
    );
    expect(present).toEqual({ ok: true, value: { absent: false } });
  });
});

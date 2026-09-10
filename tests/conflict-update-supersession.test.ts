import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import { buildOwnedDocumentId, buildLegacyOwnedDocumentId, buildCurrentOwnedDocumentId } from "../src/provider/validation.js";
import { remember } from "../src/governance/remember-service.js";
import { replaceMemory } from "../src/governance/replace-service.js";
import { forgetMemory } from "../src/governance/forget-service.js";
import {
  approveCandidate,
  candidateHasOpenConflict,
  listCandidates,
  rejectCandidate,
} from "../src/governance/candidate-service.js";
import type { MemoryStatus, MemoryType, Scope } from "../src/db/types.js";

const { resolveProjectBankMock } = vi.hoisted(() => ({
  resolveProjectBankMock: vi.fn(),
}));

vi.mock("../src/runtime/project-runtime.js", () => ({
  resolveProjectBank: resolveProjectBankMock,
}));

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

function makeTarget(
  runtime: Runtime,
  overrides: {
    id?: string;
    scope?: Scope;
    memoryType?: MemoryType;
    projectIdentity?: string | null;
    bankId?: string;
    text?: string;
    status?: MemoryStatus;
    verificationState?: "verified" | "unverified";
  } = {},
) {
  const id = overrides.id ?? "target-1";
  const scope = overrides.scope ?? "profile";
  const memoryType = overrides.memoryType ?? "preference";
  const projectIdentity = overrides.projectIdentity ?? null;
  const bankId = overrides.bankId ?? runtime.profileBankId;
  const text = overrides.text ?? "Original preference text.";
  const documentId = buildOwnedDocumentId(scope, projectIdentity, memoryType, id);
  return runtime.repos.memories.create({
    id,
    scope,
    memoryType,
    projectIdentity,
    bankId,
    documentId,
    unitId: "unit-original",
    textHash: sha256(text),
    textLength: text.length,
    verificationState: overrides.verificationState ?? "verified",
    sourceSessionId: null,
    sourceRef: null,
    supersedesMemoryId: null,
    expiresAt: null,
    status: overrides.status ?? "active",
  });
}

function makeUpdateCandidate(
  runtime: Runtime,
  targetMemoryId: string | null,
  overrides: {
    proposedAction?: "create" | "update" | "supersede" | "ignore";
    text?: string;
    scope?: Scope;
    memoryType?: MemoryType;
    projectIdentity?: string | null;
    expectedTargetTextHash?: string | null;
  } = {},
) {
  const expectedTargetTextHash =
    overrides.expectedTargetTextHash !== undefined
      ? overrides.expectedTargetTextHash
      : targetMemoryId
        ? runtime.repos.memories.getById(targetMemoryId)?.text_hash ?? null
        : null;
  return runtime.repos.candidates.create({
    scope: overrides.scope ?? "profile",
    memoryType: overrides.memoryType ?? "preference",
    text: overrides.text ?? "Corrected preference text.",
    evidenceSummary: "user correction",
    sourceSessionId: "session-1",
    sourceRef: "turn:1",
    proposedAction: overrides.proposedAction ?? "update",
    targetMemoryId,
    expectedTargetTextHash,
    projectIdentity: overrides.projectIdentity ?? null,
  });
}

afterEach(() => {
  resolveProjectBankMock.mockReset();
});

describe("exact duplicate revalidation", () => {
  it("converges a resubmitted exact duplicate onto the same row and refreshes an unverified memory's verification", async () => {
    const runtime = makeRuntime();
    const text = "Prefer numbered lists.";
    const hash = sha256(text);
    const id = "unverified-pref-1";
    runtime.repos.memories.create({
      id,
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: runtime.profileBankId,
      documentId: buildOwnedDocumentId("profile", null, "preference", id),
      unitId: "unit-original",
      textHash: hash,
      textLength: text.length,
      verificationState: "unverified",
      sourceSessionId: null,
      sourceRef: null,
      supersedesMemoryId: null,
      expiresAt: null,
    });
    const before = runtime.repos.memories.getById(id)!;
    expect(before.verification_state).toBe("unverified");

    runtime.adapter.retainOneMemory.mockResolvedValue({ ok: true, value: { unitId: "unit-reverified" } });
    const second = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text,
      cwd: "/repo",
      sourceSessionId: "s2",
      sourceRef: "turn:2",
      owner: "tool",
    });

    expect(second.outcome).toBe("duplicate");
    const after = runtime.repos.memories.listActive("profile", null);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(id);
    expect(after[0]?.verification_state).toBe("verified");
    expect(after[0]?.mutation_generation).toBe(2);
    expect(after[0]?.mutation_owner_key).toBeNull();
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect(runtime.adapter.retainOneMemory.mock.calls[0]![0].documentId).toBe(before.document_id);
  });

  it("allows two independent same-scope/type memories with distinct text", async () => {
    const runtime = makeRuntime();
    const first = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Prefer short answers.",
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "turn:1",
      owner: "command",
    });
    const second = await remember(runtime as any, {
      scope: "profile",
      memoryType: "preference",
      text: "Prefer bullet lists.",
      cwd: "/repo",
      sourceSessionId: "s1",
      sourceRef: "turn:2",
      owner: "command",
    });
    expect(first.outcome).toBe("written");
    expect(second.outcome).toBe("written");
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(2);
  });
});

describe("conflict disclosure for update/supersede candidates", () => {
  it("lazily creates and discloses an open conflict for a candidate naming a target, without ever mutating the target", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);
    const candidate = makeUpdateCandidate(runtime, target.id);

    expect(candidateHasOpenConflict(runtime as any, candidate.id)).toBe(false);
    const rows = listCandidates(runtime as any, false);
    expect(rows.map((r) => r.id)).toContain(candidate.id);
    expect(candidateHasOpenConflict(runtime as any, candidate.id)).toBe(true);

    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    const stillTarget = runtime.repos.memories.getById(target.id)!;
    expect(stillTarget.text_hash).toBe(target.text_hash);
    expect(stillTarget.status).toBe("active");

    // Independent create-action candidates must not be treated as conflicting.
    const independent = runtime.repos.candidates.create({
      scope: "profile",
      memoryType: "habit",
      text: "Unrelated habit.",
      evidenceSummary: null,
      sourceSessionId: null,
      sourceRef: null,
      proposedAction: "create",
      targetMemoryId: null,
      expectedTargetTextHash: null,
      projectIdentity: null,
    });
    listCandidates(runtime as any, false);
    expect(candidateHasOpenConflict(runtime as any, independent.id)).toBe(false);
  });
});

describe("malformed and invalid-target candidate approval", () => {
  it("rejects malformed action/target combinations locally with zero provider mutation", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);

    const ignoreCandidate = makeUpdateCandidate(runtime, null, { proposedAction: "ignore" });
    const createWithTarget = makeUpdateCandidate(runtime, target.id, { proposedAction: "create" });
    const updateWithoutTarget = makeUpdateCandidate(runtime, null, { proposedAction: "update" });

    for (const candidate of [ignoreCandidate, createWithTarget, updateWithoutTarget]) {
      const result = await approveCandidate(runtime as any, {
        candidateId: candidate.id,
        cwd: "/repo",
        sourceSessionId: "session-1",
      });
      expect(result.outcome).toBe("rejected");
    }
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
  });

  it("rejects a stale, wrong-scope, wrong-type, deleted, reconciling, or nonexistent target before any provider mutation", async () => {
    const runtime = makeRuntime();

    const wrongScopeTarget = makeTarget(runtime, {
      id: "wrong-scope",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: projectBankId("repo"),
      text: "Project decision.",
    });
    const wrongTypeTarget = makeTarget(runtime, { id: "wrong-type", memoryType: "habit", text: "A habit." });
    const deletedTarget = makeTarget(runtime, { id: "deleted-target", status: "deleted" });
    const reconcilingTarget = makeTarget(runtime, { id: "reconciling-target", status: "reconciling" });

    const cases: Array<{ targetId: string | null; label: string }> = [
      { targetId: wrongScopeTarget.id, label: "wrong scope" },
      { targetId: wrongTypeTarget.id, label: "wrong type" },
      { targetId: deletedTarget.id, label: "deleted" },
      { targetId: reconcilingTarget.id, label: "reconciling" },
    ];

    for (const testCase of cases) {
      const candidate = makeUpdateCandidate(runtime, testCase.targetId);
      const result = await approveCandidate(runtime as any, {
        candidateId: candidate.id,
        cwd: "/repo",
        sourceSessionId: "session-1",
      });
      expect(result.outcome, testCase.label).toBe("rejected");
    }

    // Nonexistent targets cannot be inserted under the candidates FK; exercise
    // replaceMemory directly so approval-equivalent rejection is still covered.
    const missing = await replaceMemory(runtime as any, {
      targetMemoryId: "does-not-exist",
      scope: "profile",
      memoryType: "preference",
      text: "Corrected preference text.",
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: null,
      idempotencyKey: "replace-missing-target",
    });
    expect(missing.outcome).toBe("rejected");

    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    // None of the targets were mutated.
    expect(runtime.repos.memories.getById(wrongScopeTarget.id)!.status).toBe("active");
    expect(runtime.repos.memories.getById(deletedTarget.id)!.status).toBe("deleted");
    expect(runtime.repos.memories.getById(reconcilingTarget.id)!.status).toBe("reconciling");
  });

  it("rejects a target belonging to a different project identity before provider mutation", async () => {
    const runtime = makeRuntime();
    resolveProjectBankMock.mockResolvedValue({ enabled: true, bankId: projectBankId("repo-a"), identity: "repo-a" });
    const target = makeTarget(runtime, {
      id: "other-project-target",
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo-b",
      bankId: projectBankId("repo-b"),
      text: "Decision in another project.",
    });
    const candidate = makeUpdateCandidate(runtime, target.id, {
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo-a",
    });
    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo-a",
      sourceSessionId: "session-1",
    });
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
  });
});

describe("governed update/supersede approval", () => {
  it("reuses the exact existing document id, replaces the content, and resolves the conflict as superseded", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime, { text: "Old preference." });
    const originalDocumentId = target.document_id;
    const candidate = makeUpdateCandidate(runtime, target.id, {
      proposedAction: "supersede",
      text: "New preference.",
    });
    listCandidates(runtime as any, false); // materializes the conflict, as the reviewer UI would trigger

    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
    });

    expect(result.outcome).toBe("approved");
    if (result.outcome === "approved") {
      expect(result.memoryId).toBe(target.id);
    }
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    const call = runtime.adapter.retainOneMemory.mock.calls[0]![0];
    expect(call.documentId).toBe(originalDocumentId);
    expect(call.metadata.logical_id).toBe(target.id);
    expect(call.metadata.content_hash).toBe(sha256("New preference."));

    const updated = runtime.repos.memories.getById(target.id)!;
    expect(updated.document_id).toBe(originalDocumentId);
    expect(updated.id).toBe(target.id);
    expect(updated.text_hash).toBe(sha256("New preference."));
    expect(updated.status).toBe("active");
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(1);

    const conflicts = runtime.repos.conflicts.listOpenForCandidate(candidate.id);
    expect(conflicts).toHaveLength(0);

    const auditRows = runtime.repos.audit.listRecent(5);
    expect(auditRows.some((row) => row.outcome === "replaced_candidate")).toBe(true);
    for (const row of auditRows) {
      expect(JSON.stringify(row)).not.toContain("New preference");
      expect(JSON.stringify(row)).not.toContain("Old preference");
    }
  });

  it("preserves prior active truth and leaves the candidate unapproved on a definite replace failure", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime, { text: "Stable preference." });
    const originalHash = target.text_hash;
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "rejected",
      category: "http",
      status: 400,
      ambiguous: false,
    });
    const candidate = makeUpdateCandidate(runtime, target.id, { text: "Attempted change." });
    listCandidates(runtime as any, false);

    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
    });

    expect(result.outcome).toBe("rejected");
    const row = runtime.repos.memories.getById(target.id)!;
    expect(row.status).toBe("active");
    expect(row.text_hash).toBe(originalHash);
    expect(runtime.repos.candidates.getById(candidate.id)!.state).not.toBe("approved");
    expect(runtime.repos.conflicts.listOpenForCandidate(candidate.id)).toHaveLength(1);
  });

  it("reconciles an ambiguous replace via post-write verification without a duplicate provider mutation", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime, { text: "Ambiguous target." });
    const newText = "Reconciled text.";
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: false, reason: "timed out", category: "timeout", ambiguous: true });
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({ ok: true, value: { unitId: "unit-verified" } });
    const candidate = makeUpdateCandidate(runtime, target.id, { text: newText });

    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
    });

    expect(result.outcome).toBe("approved");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    const row = runtime.repos.memories.getById(target.id)!;
    expect(row.text_hash).toBe(sha256(newText));
    expect(row.status).toBe("active");
  });

  it("stays reconciling when both the replace and its verification are ambiguous, then converges on retry", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);
    const newText = "Retried replacement text.";
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: false, reason: "timed out", category: "timeout", ambiguous: true });
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({ ok: false, reason: "still uncertain", category: "validation", ambiguous: true });

    const first = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-retry-1",
    });
    expect(first.outcome).toBe("unknown");
    expect(runtime.repos.memories.getById(target.id)!.status).toBe("reconciling");

    // Ambiguous verification on retry must not blindly retain.
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "list timed out",
      category: "timeout",
      ambiguous: true,
    });
    const stillUnknown = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-retry-1",
    });
    expect(stillUnknown.outcome).toBe("unknown");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);

    // Exact absence is safely retryable: one retain, then success.
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "post-write verification failed: expected exactly one live unit, found 0",
      category: "validation",
    });
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: true, value: { unitId: "unit-final" } });
    const second = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-retry-1",
    });
    expect(second.outcome).toBe("replaced");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(2);
    expect(runtime.repos.memories.getById(target.id)!.status).toBe("active");
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(sha256(newText));
  });

  it("finalizes a reconciling replace from verification alone when the first write already applied", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);
    const newText = "Already written text.";
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({ ok: false, reason: "timed out", category: "timeout", ambiguous: true });
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "still uncertain",
      category: "validation",
      ambiguous: true,
    });
    const first = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-verify-only",
    });
    expect(first.outcome).toBe("unknown");

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({ ok: true, value: { unitId: "unit-already-there" } });
    const second = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-verify-only",
    });
    expect(second.outcome).toBe("replaced");
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(sha256(newText));
  });

  it("preserves original lifecycle bytes when reconciling absence is followed by definite rewrite failure", async () => {
    const runtime = makeRuntime();
    const originalText = "Stable preference.";
    const target = makeTarget(runtime, { text: originalText });
    const original = {
      textHash: target.text_hash,
      updatedAt: target.updated_at,
      lastVerifiedAt: target.last_verified_at,
      expiresAt: target.expires_at,
      createdAt: target.created_at,
    };
    const newText = "Attempted replacement.";

    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "timed out",
      category: "timeout",
      ambiguous: true,
    });
    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "still uncertain",
      category: "validation",
      ambiguous: true,
    });
    const first = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-lifecycle-preserve",
    });
    expect(first.outcome).toBe("unknown");
    const afterAmbiguous = runtime.repos.memories.getById(target.id)!;
    expect(afterAmbiguous.status).toBe("reconciling");
    expect(afterAmbiguous.text_hash).toBe(original.textHash);
    expect(afterAmbiguous.updated_at).toBe(original.updatedAt);
    expect(afterAmbiguous.last_verified_at).toBe(original.lastVerifiedAt);
    expect(afterAmbiguous.expires_at).toBe(original.expiresAt);
    expect(afterAmbiguous.created_at).toBe(original.createdAt);

    runtime.adapter.verifyOneUnitDocument.mockResolvedValueOnce({
      ok: false,
      reason: "post-write verification failed: expected exactly one live unit, found 0",
      category: "validation",
    });
    runtime.adapter.retainOneMemory.mockResolvedValueOnce({
      ok: false,
      reason: "rejected",
      category: "http",
      status: 400,
    });
    const second = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: newText,
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "replace-lifecycle-preserve",
    });
    expect(second.outcome).toBe("unknown");
    const restored = runtime.repos.memories.getById(target.id)!;
    expect(restored.status).toBe("reconciling");
    expect(restored.mutation_owner_key).toBe("replace-lifecycle-preserve");
    expect(restored.text_hash).toBe(original.textHash);
    expect(restored.updated_at).toBe(original.updatedAt);
    expect(restored.last_verified_at).toBe(original.lastVerifiedAt);
    expect(restored.expires_at).toBe(original.expiresAt);
    expect(restored.created_at).toBe(original.createdAt);
  });

  it("rejects a stale candidate after an intervening update with zero provider mutation", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime, { text: "Original preference." });
    const candidate = makeUpdateCandidate(runtime, target.id, { text: "Candidate correction." });
    listCandidates(runtime as any, false);

    // Intervening governed update changes the target hash under the same document.
    const intervening = await replaceMemory(runtime as any, {
      targetMemoryId: target.id,
      scope: "profile",
      memoryType: "preference",
      text: "Intervening newer preference.",
      cwd: "/repo",
      sourceSessionId: null,
      sourceRef: null,
      idempotencyKey: "intervening-update",
      owner: "command",
    });
    expect(intervening.outcome).toBe("replaced");
    runtime.adapter.retainOneMemory.mockClear();
    runtime.adapter.ensureOwnedBank.mockClear();

    const result = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
    });
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(sha256("Intervening newer preference."));
    expect(runtime.repos.candidates.getById(candidate.id)!.state).toBe("failed");
  });

  it("rejects a second concurrent replace against the same target while the first is in flight", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);

    const [first, second] = await Promise.all([
      replaceMemory(runtime as any, {
        targetMemoryId: target.id,
        scope: "profile",
        memoryType: "preference",
        text: "Winner text.",
        cwd: "/repo",
        sourceSessionId: null,
        sourceRef: null,
        idempotencyKey: "concurrent-a",
      }),
      replaceMemory(runtime as any, {
        targetMemoryId: target.id,
        scope: "profile",
        memoryType: "preference",
        text: "Loser text.",
        cwd: "/repo",
        sourceSessionId: null,
        sourceRef: null,
        idempotencyKey: "concurrent-b",
      }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["in_progress", "replaced"]);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(1);
    expect(runtime.repos.memories.listActive("profile", null)).toHaveLength(1);
  });
});

describe("reject resolves conflicts and forget removes the reused document", () => {
  it("resolves an open conflict as resolved_keep_existing when its candidate is rejected", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);
    const candidate = makeUpdateCandidate(runtime, target.id);
    listCandidates(runtime as any, false);
    expect(candidateHasOpenConflict(runtime as any, candidate.id)).toBe(true);

    expect(rejectCandidate(runtime as any, candidate.id).ok).toBe(true);
    expect(candidateHasOpenConflict(runtime as any, candidate.id)).toBe(false);
    const target2 = runtime.repos.memories.getById(target.id)!;
    expect(target2.status).toBe("active");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
  });

  it("deletes the reused document id after a replacement, and rejects forget for a stale locator", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime, { text: "Before replace." });
    const originalDocumentId = target.document_id;
    const originalBankId = target.bank_id;
    const candidate = makeUpdateCandidate(runtime, target.id, { text: "After replace." });

    const approved = await approveCandidate(runtime as any, {
      candidateId: candidate.id,
      cwd: "/repo",
      sourceSessionId: "session-1",
    });
    expect(approved.outcome).toBe("approved");

    const forgetResult = await forgetMemory(runtime as any, target.id);
    expect(forgetResult.outcome).toBe("forgotten");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalledWith(
      originalBankId,
      originalDocumentId,
      expect.any(AbortSignal),
    );
    expect(runtime.repos.memories.getById(target.id)!.status).toBe("deleted");
  });

  it("rejects legacy targeted candidates that lack a target snapshot before provider mutation", async () => {
    const runtime = makeRuntime();
    const target = makeTarget(runtime);
    runtime.db
      .prepare(
        `INSERT INTO candidates (
          id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
          proposed_action, target_memory_id, expected_target_text_hash, project_identity, state,
          created_at, updated_at, expires_at, approved_memory_id, failure_code
        ) VALUES (?, 'profile', 'preference', 'Legacy correction.', NULL, 'session-1', 'turn:1',
          'update', ?, NULL, NULL, 'pending', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        "legacy-candidate",
        target.id,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
      );
    const result = await approveCandidate(runtime as any, {
      candidateId: "legacy-candidate",
      cwd: "/repo",
      sourceSessionId: "session-1",
    });
    expect(result.outcome).toBe("rejected");
    expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    expect(runtime.repos.candidates.getById("legacy-candidate")!.failure_code).toBe("missing_target_snapshot");
  });
});

describe("explicit update idempotency across history", () => {
  it("treats A->B, B->C, and C->B as three distinct replaces and retries the same transition without a fourth retain", async () => {
    const runtime = makeRuntime();
    const textA = "Preference version A content.";
    const textB = "Preference version B content.";
    const textC = "Preference version C content.";
    const hashA = sha256(textA);
    const hashB = sha256(textB);
    const hashC = sha256(textC);
    const target = makeTarget(runtime, { id: "hist-1", text: textA });

    const replace = async (fromHash: string, text: string, ownerKey: string) =>
      replaceMemory(runtime as any, {
        targetMemoryId: target.id,
        scope: "profile",
        memoryType: "preference",
        text,
        cwd: "/repo",
        sourceSessionId: "session-1",
        sourceRef: "test:history",
        idempotencyKey: `${ownerKey}:update:${target.id}:${fromHash}:${sha256(text)}`,
        expectedTargetTextHash: fromHash,
        owner: "command",
      });

    expect(await replace(hashA, textB, "command")).toEqual({ outcome: "replaced", memoryId: target.id });
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(hashB);

    expect(await replace(hashB, textC, "command")).toEqual({ outcome: "replaced", memoryId: target.id });
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(hashC);

    expect(await replace(hashC, textB, "command")).toEqual({ outcome: "replaced", memoryId: target.id });
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(hashB);
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(3);

    const retry = await replace(hashC, textB, "command");
    expect(retry).toEqual({ outcome: "replaced", memoryId: target.id });
    expect(runtime.adapter.retainOneMemory).toHaveBeenCalledTimes(3);
    expect(runtime.repos.memories.getById(target.id)!.text_hash).toBe(hashB);
  });
});

describe("legacy document locator compatibility", () => {
  function makeLegacyTarget(runtime: Runtime, text = "Legacy preference text body.") {
    const id = "legacy-row-1";
    const textHash = sha256(text);
    const documentId = buildLegacyOwnedDocumentId("profile", null, textHash);
    return runtime.repos.memories.create({
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
      legacyDocumentTextHash: textHash,
    });
  }

  it("forgets a populated legacy row against its exact recomputed legacy document id", async () => {
    const runtime = makeRuntime();
    const text = "Legacy preference text body.";
    const row = makeLegacyTarget(runtime, text);
    const forgotten = await forgetMemory(runtime as any, row.id);
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalledWith(
      row.bank_id,
      buildLegacyOwnedDocumentId("profile", null, sha256(text)),
      expect.any(AbortSignal),
    );
  });

  it("updates a legacy row by reusing its document id and writing current metadata", async () => {
    const runtime = makeRuntime();
    const original = "Legacy preference text body.";
    const updated = "Updated legacy preference text.";
    const row = makeLegacyTarget(runtime, original);
    const legacyDoc = row.document_id;

    const result = await replaceMemory(runtime as any, {
      targetMemoryId: row.id,
      scope: "profile",
      memoryType: "preference",
      text: updated,
      cwd: "/repo",
      sourceSessionId: "session-1",
      sourceRef: "test:legacy-update",
      idempotencyKey: `command:update:${row.id}:${row.text_hash}:${sha256(updated)}`,
      expectedTargetTextHash: row.text_hash,
      owner: "command",
    });
    expect(result).toEqual({ outcome: "replaced", memoryId: row.id });

    const after = runtime.repos.memories.getById(row.id)!;
    expect(after.document_id).toBe(legacyDoc);
    expect(after.text_hash).toBe(sha256(updated));
    expect(after.legacy_document_text_hash).toBe(sha256(original));
    expect(after.document_id).not.toBe(
      buildCurrentOwnedDocumentId("profile", null, "preference", row.id),
    );

    const retainCall = (runtime.adapter.retainOneMemory as any).mock.calls[0][0];
    expect(retainCall.documentId).toBe(legacyDoc);
    expect(retainCall.metadata.logical_id).toBe(row.id);
    expect(retainCall.metadata.content_hash).toBe(sha256(updated));

    const forgotten = await forgetMemory(runtime as any, row.id);
    expect(forgotten.outcome).toBe("forgotten");
    expect(runtime.adapter.deleteMemoryDocument).toHaveBeenCalledWith(
      row.bank_id,
      legacyDoc,
      expect.any(AbortSignal),
    );
  });

  it("rejects forget when a legacy locator no longer recomputes from stored fields", async () => {
    const runtime = makeRuntime();
    const row = makeLegacyTarget(runtime);
    runtime.db
      .prepare("UPDATE memories SET document_id = ? WHERE id = ?")
      .run(buildCurrentOwnedDocumentId("profile", null, "preference", "other-id"), row.id);
    // Force a non-matching legacy freeze key so neither formula owns the stored id.
    runtime.db
      .prepare("UPDATE memories SET legacy_document_text_hash = ?, document_id = ? WHERE id = ?")
      .run("b".repeat(64), "pi-memory-hindsight:memory:cccccccccccccccccccccccccccccccc", row.id);
    const forgotten = await forgetMemory(runtime as any, row.id);
    expect(forgotten.outcome).toBe("rejected");
    expect(runtime.adapter.deleteMemoryDocument).not.toHaveBeenCalled();
  });
});

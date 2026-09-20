import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository, type NewCandidateInput } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";
import {
  approveCandidate,
  explainCandidateFailureCode,
  listCandidates,
  rejectCandidate,
  renderApproveOutcome,
  renderRejectOutcome,
  toCandidateScopeContext,
  type CandidateScopeContext,
} from "../src/governance/candidate-service.js";
import { createCandidateReviewer } from "../src/ui/candidate-reviewer.js";

const { resolveProjectBankMock, getGlobalRuntimeMock } = vi.hoisted(() => ({
  resolveProjectBankMock: vi.fn(),
  getGlobalRuntimeMock: vi.fn(),
}));

vi.mock("../src/runtime/project-runtime.js", () => ({
  resolveProjectBank: resolveProjectBankMock,
}));

vi.mock("../src/runtime/global-runtime.js", () => ({
  getGlobalRuntime: getGlobalRuntimeMock,
}));

const PROFILE_SCOPE: CandidateScopeContext = { projectIdentity: null, projectScopeEnabled: false };
const PROJECT_A_SCOPE: CandidateScopeContext = { projectIdentity: "repo-a", projectScopeEnabled: true };
const PROJECT_B_SCOPE: CandidateScopeContext = { projectIdentity: "repo-b", projectScopeEnabled: true };
const DISABLED_SCOPE: CandidateScopeContext = { projectIdentity: null, projectScopeEnabled: false };

function makeRuntime() {
  const db = MemoryDatabase.openInMemory();
  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  return {
    agentDir: "/tmp/pi-agent",
    db,
    hindsightUrl: "http://127.0.0.1:8888",
    minScore: 0.5,
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

type Runtime = ReturnType<typeof makeRuntime>;

function newCandidate(overrides: Partial<NewCandidateInput> = {}): NewCandidateInput {
  return {
    scope: "profile",
    memoryType: "preference",
    text: "Prefer concise answers.",
    evidenceSummary: null,
    sourceSessionId: "session-1",
    sourceRef: null,
    proposedAction: "create",
    targetMemoryId: null,
    projectIdentity: null,
    ...overrides,
  };
}

function projectCandidateInput(projectIdentity: string, overrides: Partial<NewCandidateInput> = {}): NewCandidateInput {
  return newCandidate({
    scope: "project",
    memoryType: "project_fact",
    text: "The build uses pnpm workspaces.",
    projectIdentity,
    ...overrides,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function snapshot(runtime: Runtime, id: string) {
  const row = runtime.repos.candidates.getById(id)!;
  return {
    state: row.state,
    text: row.text,
    failure_code: row.failure_code,
  };
}

function counts(runtime: Runtime) {
  const db = runtime.db as unknown as { prepare: (sql: string) => { get: () => { c: number } } };
  const conflictCount = (db.prepare("SELECT COUNT(*) as c FROM conflicts").get() as { c: number }).c;
  const auditCount = (db.prepare("SELECT COUNT(*) as c FROM audit_events").get() as { c: number }).c;
  const memoryCount = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  const operationCount = (db.prepare("SELECT COUNT(*) as c FROM operations").get() as { c: number }).c;
  return { conflictCount, auditCount, memoryCount, operationCount };
}

function makePastTtl(runtime: Runtime, id: string) {
  runtime.db
    .prepare("UPDATE candidates SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), id);
}


describe("candidate project isolation and diagnostics", () => {
  beforeEach(() => {
    resolveProjectBankMock.mockImplementation(async (cwd: string) => {
      const identity = cwd.replace(/^\//, "");
      return { enabled: true, identity, bankId: projectBankId(identity) };
    });
    // Default: no test relies on a real provider-capable runtime unless it
    // explicitly overrides this. Any accidental call to getGlobalRuntime
    // that a test forgot to guard against fails closed rather than
    // constructing a real GlobalRuntime.
    getGlobalRuntimeMock.mockResolvedValue({ ok: false, reason: "provider not configured in unit test" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("visibility: listCandidates", () => {
    it("shows a Profile candidate from any scope context, including disabled/mismatched project", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(newCandidate());

      for (const scope of [PROFILE_SCOPE, PROJECT_A_SCOPE, PROJECT_B_SCOPE, DISABLED_SCOPE]) {
        const rows = listCandidates(runtime as any, false, scope);
        expect(rows.map((r) => r.id)).toContain(row.id);
      }
    });

    it("shows a Project candidate only under its own enabled Project scope", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));

      expect(listCandidates(runtime as any, false, PROJECT_A_SCOPE).map((r) => r.id)).toContain(row.id);
      expect(listCandidates(runtime as any, false, PROJECT_B_SCOPE).map((r) => r.id)).not.toContain(row.id);
      expect(listCandidates(runtime as any, false, DISABLED_SCOPE).map((r) => r.id)).not.toContain(row.id);
      expect(listCandidates(runtime as any, false, PROFILE_SCOPE).map((r) => r.id)).not.toContain(row.id);
    });

    it("respects the same isolation rule when includeExpired is true", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const db = runtime.db as unknown as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      db.prepare("UPDATE candidates SET state = 'expired' WHERE id = ?").run(row.id);

      expect(listCandidates(runtime as any, true, PROJECT_A_SCOPE).map((r) => r.id)).toContain(row.id);
      expect(listCandidates(runtime as any, true, PROJECT_B_SCOPE).map((r) => r.id)).not.toContain(row.id);
      expect(listCandidates(runtime as any, true, DISABLED_SCOPE).map((r) => r.id)).not.toContain(row.id);
    });

    it("does not materialize a conflict row for a Project candidate hidden from the current scope", () => {
      const runtime = makeRuntime();
      const seedText = "Existing fact.";
      const memory = runtime.repos.memories.create({
        id: "memory-seed-1",
        scope: "project",
        memoryType: "project_fact",
        projectIdentity: "repo-a",
        bankId: projectBankId("repo-a"),
        documentId: buildOwnedDocumentId("project", "repo-a", "project_fact", "memory-seed-1"),
        unitId: "unit-seed-1",
        textHash: sha256(seedText),
        textLength: seedText.length,
        verificationState: "verified",
        sourceSessionId: null,
        sourceRef: null,
        supersedesMemoryId: null,
        expiresAt: null,
      });
      runtime.repos.candidates.create(
        projectCandidateInput("repo-a", {
          proposedAction: "update",
          targetMemoryId: memory.id,
          expectedTargetTextHash: memory.text_hash,
        }),
      );

      listCandidates(runtime as any, false, PROJECT_B_SCOPE);
      expect(counts(runtime).conflictCount).toBe(0);

      listCandidates(runtime as any, false, PROJECT_A_SCOPE);
      expect(counts(runtime).conflictCount).toBe(1);
    });
  });

  describe("direct-ID rejectCandidate cross-project safety", () => {
    it("refuses to reject a Project candidate from a mismatched Project with zero side effects", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const before = snapshot(runtime, row.id);
      const beforeCounts = counts(runtime);

      const result = rejectCandidate(runtime as any, row.id, PROJECT_B_SCOPE);

      expect(result).toEqual({ ok: false, reason: "project_mismatch" });
      expect(snapshot(runtime, row.id)).toEqual(before);
      expect(counts(runtime)).toEqual(beforeCounts);
    });

    it("refuses to reject a Project candidate when the current cwd has no enabled project, zero side effects", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const before = snapshot(runtime, row.id);
      const beforeCounts = counts(runtime);

      const result = rejectCandidate(runtime as any, row.id, DISABLED_SCOPE);

      expect(result).toEqual({ ok: false, reason: "project_unavailable" });
      expect(snapshot(runtime, row.id)).toEqual(before);
      expect(counts(runtime)).toEqual(beforeCounts);
    });

    it("allows rejecting a Project candidate from its matching Project", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));

      const result = rejectCandidate(runtime as any, row.id, PROJECT_A_SCOPE);

      expect(result).toEqual({ ok: true });
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("rejected");
    });

    it("allows rejecting a Profile candidate from any scope context", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(newCandidate());

      const result = rejectCandidate(runtime as any, row.id, PROJECT_A_SCOPE);

      expect(result).toEqual({ ok: true });
    });
  });

  describe("direct-ID approveCandidate cross-project safety", () => {
    it("refuses to approve a Project candidate from a mismatched Project before any claim/body/provider mutation", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const before = snapshot(runtime, row.id);
      const beforeCounts = counts(runtime);

      const result = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-b",
        scopeContext: PROJECT_B_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result).toEqual({
        outcome: "rejected",
        reason: "candidate belongs to a different project",
        code: "project_mismatch",
      });
      expect(snapshot(runtime, row.id)).toEqual(before);
      expect(counts(runtime)).toEqual(beforeCounts);
      expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
      expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    });

    it("refuses to approve a Project candidate when the project is unavailable, zero side effects and zero provider I/O", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const before = snapshot(runtime, row.id);
      const beforeCounts = counts(runtime);

      const result = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/no-project",
        scopeContext: DISABLED_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result).toEqual({
        outcome: "rejected",
        reason: "project scope is unavailable for this candidate",
        code: "project_unavailable",
      });
      expect(snapshot(runtime, row.id)).toEqual(before);
      expect(counts(runtime)).toEqual(beforeCounts);
      expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
      expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    });

    it("refuses even with an edited body supplied for a mismatched-project direct approve, zero side effects", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const before = snapshot(runtime, row.id);
      const beforeCounts = counts(runtime);

      const result = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-b",
        scopeContext: PROJECT_B_SCOPE,
        sourceSessionId: "session-1",
        editedText: "A maliciously edited body.",
      });

      expect(result.outcome).toBe("rejected");
      expect((result as any).code).toBe("project_mismatch");
      expect(snapshot(runtime, row.id)).toEqual(before);
      expect(counts(runtime)).toEqual(beforeCounts);
    });

    it("approves a Project candidate from its matching Project", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));

      const result = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-a",
        scopeContext: PROJECT_A_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result.outcome).toBe("approved");
    });

    it("allows approving a Profile candidate from any scope context", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(newCandidate());

      const result = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-a",
        scopeContext: PROJECT_A_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result.outcome).toBe("approved");
    });
  });

  describe("retry of previously failed project candidates", () => {
    it("lets a failed/project_unavailable candidate be retried successfully from its matching Project", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      runtime.db
        .prepare("UPDATE candidates SET state='failed', failure_code='project_unavailable' WHERE id=?")
        .run(row.id);
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("failed");

      const stillBlocked = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-b",
        scopeContext: PROJECT_B_SCOPE,
        sourceSessionId: "session-1",
      });
      expect(stillBlocked.outcome).toBe("rejected");
      expect((stillBlocked as any).code).toBe("project_mismatch");

      const retried = await approveCandidate(runtime as any, {
        candidateId: row.id,
        cwd: "/repo-a",
        scopeContext: PROJECT_A_SCOPE,
        sourceSessionId: "session-1",
      });
      expect(retried.outcome).toBe("approved");
    });

    it("also allows a matching-project reject after a prior failed approval attempt", () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      runtime.db
        .prepare("UPDATE candidates SET state='failed', failure_code='project_unavailable' WHERE id=?")
        .run(row.id);
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("failed");

      const result = rejectCandidate(runtime as any, row.id, PROJECT_A_SCOPE);
      expect(result).toEqual({ ok: true });
    });
  });

  describe("batch rejection respects scope", () => {
    it("only rejects candidates visible in the caller's current scope", () => {
      const runtime = makeRuntime();
      const profileRow = runtime.repos.candidates.create(newCandidate());
      const projectARow = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const projectBRow = runtime.repos.candidates.create(projectCandidateInput("repo-b"));

      const visible = listCandidates(runtime as any, false, PROJECT_A_SCOPE);
      for (const row of visible) {
        rejectCandidate(runtime as any, row.id, PROJECT_A_SCOPE);
      }

      expect(runtime.repos.candidates.getById(profileRow.id)!.state).toBe("rejected");
      expect(runtime.repos.candidates.getById(projectARow.id)!.state).toBe("rejected");
      expect(runtime.repos.candidates.getById(projectBRow.id)!.state).toBe("pending");
    });
  });

  describe("diagnostic rendering consistency (en/zh)", () => {
    it("renders the same project_mismatch message from renderApproveOutcome and renderRejectOutcome shapes", () => {
      for (const language of ["en", "zh"] as const) {
        const approveMsg = renderApproveOutcome(language, {
          outcome: "rejected",
          reason: "candidate belongs to a different project",
          code: "project_mismatch",
        });
        const rejectMsg = renderRejectOutcome(language, { ok: false, reason: "project_mismatch" });
        expect(approveMsg).toBe(rejectMsg);
        expect(approveMsg.length).toBeGreaterThan(0);
      }
    });

    it("renders the same project_unavailable message from renderApproveOutcome and renderRejectOutcome shapes", () => {
      for (const language of ["en", "zh"] as const) {
        const approveMsg = renderApproveOutcome(language, {
          outcome: "rejected",
          reason: "project scope is unavailable for this candidate",
          code: "project_unavailable",
        });
        const rejectMsg = renderRejectOutcome(language, { ok: false, reason: "project_unavailable" });
        expect(approveMsg).toBe(rejectMsg);
      }
    });

    it("never leaks raw provider reason text for validation-classified codes", () => {
      const raw = "Bearer secret-token-abc rejected by upstream at https://internal.example/v1/documents";
      for (const language of ["en", "zh"] as const) {
        const msg = renderApproveOutcome(language, {
          outcome: "rejected",
          reason: raw,
          code: "some_unrecognized_code",
        });
        expect(msg).not.toContain("secret-token-abc");
        expect(msg).not.toContain("internal.example");
      }
    });

    it("never echoes a hostile raw reason for the known provider_write_failed/bank_config_failed codes", () => {
      const hostile =
        'Bearer sk-live-abc123 rejected by upstream 10.0.0.5:9999 body={"password":"hunter2"}';
      for (const code of ["provider_write_failed", "bank_config_failed"]) {
        for (const language of ["en", "zh"] as const) {
          const msg = renderApproveOutcome(language, {
            outcome: "rejected",
            reason: `write failed: ${hostile}`,
            code,
          });
          expect(msg).not.toContain("sk-live-abc123");
          expect(msg).not.toContain("hunter2");
          expect(msg).not.toContain("10.0.0.5");
        }
      }
    });

    it("never echoes a hostile raw reason for retryable-classified codes", () => {
      const hostile = "internal trace: session=xyz leaked-secret=sk-live-abc123";
      for (const code of ["unknown", "in_progress", "candidate_changed"]) {
        for (const language of ["en", "zh"] as const) {
          const msg = renderApproveOutcome(language, {
            outcome: "retryable",
            reason: hostile,
            code,
          });
          expect(msg).not.toContain("sk-live-abc123");
          expect(msg).not.toContain("session=xyz");
        }
      }
    });

    it("never echoes a hostile raw reason for a totally unrecognized code", () => {
      const hostile = "X-Api-Key: sk-live-abc123";
      for (const language of ["en", "zh"] as const) {
        const msg = renderApproveOutcome(language, {
          outcome: "rejected",
          reason: hostile,
          code: "totally_unknown_code_xyz",
        });
        expect(msg).not.toContain("sk-live-abc123");
      }
    });

    it("classifies unrecognized failure codes as validation (fail closed), never echoing the raw code", () => {
      for (const language of ["en", "zh"] as const) {
        const msg = explainCandidateFailureCode(language, "some_never_seen_internal_code");
        expect(msg).not.toBeNull();
        expect(msg).not.toContain("some_never_seen_internal_code");
      }
    });

    it("explains project_unavailable and project_mismatch failure codes distinctly", () => {
      for (const language of ["en", "zh"] as const) {
        const unavailable = explainCandidateFailureCode(language, "project_unavailable");
        const mismatch = explainCandidateFailureCode(language, "project_mismatch");
        expect(unavailable).not.toBeNull();
        expect(mismatch).not.toBeNull();
        expect(unavailable).not.toBe(mismatch);
      }
    });

    it("returns null when there is no failure code", () => {
      expect(explainCandidateFailureCode("en", null)).toBeNull();
    });
  });

  describe("toCandidateScopeContext", () => {
    it("maps an enabled project bank result to an enabled scope context", () => {
      expect(toCandidateScopeContext({ enabled: true, identity: "repo-a", bankId: "bank-1" } as any)).toEqual(
        PROJECT_A_SCOPE,
      );
    });

    it("maps a disabled project bank result to the profile-only scope context", () => {
      expect(toCandidateScopeContext({ enabled: false, reason: "disabled" } as any)).toEqual(DISABLED_SCOPE);
    });
  });

  describe("reviewer scope wiring", () => {
    it("only lists Profile+matching-Project candidates, and states its current scope in the reviewer view", async () => {
      const runtime = makeRuntime();
      runtime.repos.candidates.create(newCandidate());
      runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      runtime.repos.candidates.create(projectCandidateInput("repo-b"));

      const ctx = {
        mode: "tui",
        cwd: "/repo-a",
        ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), input: vi.fn() },
        sessionManager: { getSessionId: () => "session-1" },
      };

      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      const view = reviewer.render(120);
      expect(view.join("\n")).toMatch(/repo-a/);
      expect(reviewer).toBeTruthy();
    });
  });

  describe("scoped expiry sweep never mutates hidden other-project candidates", () => {
    it("listCandidates from a disabled/no-project scope leaves a hidden past-TTL Project candidate, and an unrelated hidden past-TTL Project candidate, untouched", () => {
      const runtime = makeRuntime();
      const target = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const unrelated = runtime.repos.candidates.create(projectCandidateInput("repo-b"));
      makePastTtl(runtime, target.id);
      makePastTtl(runtime, unrelated.id);
      const beforeTarget = snapshot(runtime, target.id);
      const beforeUnrelated = snapshot(runtime, unrelated.id);
      const beforeCounts = counts(runtime);

      listCandidates(runtime as any, false, DISABLED_SCOPE);

      expect(snapshot(runtime, target.id)).toEqual(beforeTarget);
      expect(snapshot(runtime, unrelated.id)).toEqual(beforeUnrelated);
      expect(runtime.repos.candidates.getById(target.id)!.state).toBe("pending");
      expect(runtime.repos.candidates.getById(unrelated.id)!.state).toBe("pending");
      expect(counts(runtime)).toEqual(beforeCounts);
    });

    it("listCandidates from Project A leaves a hidden past-TTL Project B candidate untouched while its own past-TTL candidate is swept", () => {
      const runtime = makeRuntime();
      const hiddenProjectB = runtime.repos.candidates.create(projectCandidateInput("repo-b"));
      const ownProjectA = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      makePastTtl(runtime, hiddenProjectB.id);
      makePastTtl(runtime, ownProjectA.id);
      const beforeHidden = snapshot(runtime, hiddenProjectB.id);

      listCandidates(runtime as any, true, PROJECT_A_SCOPE);

      expect(snapshot(runtime, hiddenProjectB.id)).toEqual(beforeHidden);
      expect(runtime.repos.candidates.getById(hiddenProjectB.id)!.state).toBe("pending");
      expect(runtime.repos.candidates.getById(ownProjectA.id)!.state).toBe("expired");
    });

    it("direct-ID rejectCandidate on a wrong-project past-TTL candidate leaves it, and an unrelated hidden past-TTL candidate, untouched with zero side effects", () => {
      const runtime = makeRuntime();
      const target = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const unrelated = runtime.repos.candidates.create(projectCandidateInput("repo-c"));
      makePastTtl(runtime, target.id);
      makePastTtl(runtime, unrelated.id);
      const beforeTarget = snapshot(runtime, target.id);
      const beforeUnrelated = snapshot(runtime, unrelated.id);
      const beforeCounts = counts(runtime);

      const result = rejectCandidate(runtime as any, target.id, PROJECT_B_SCOPE);

      expect(result).toEqual({ ok: false, reason: "project_mismatch" });
      expect(snapshot(runtime, target.id)).toEqual(beforeTarget);
      expect(runtime.repos.candidates.getById(target.id)!.state).toBe("pending");
      expect(snapshot(runtime, unrelated.id)).toEqual(beforeUnrelated);
      expect(counts(runtime)).toEqual(beforeCounts);
    });

    it("direct-ID approveCandidate on a wrong-project past-TTL candidate leaves it, and an unrelated hidden past-TTL candidate, untouched with zero side effects and zero provider I/O", async () => {
      const runtime = makeRuntime();
      const target = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      const unrelated = runtime.repos.candidates.create(projectCandidateInput("repo-c"));
      makePastTtl(runtime, target.id);
      makePastTtl(runtime, unrelated.id);
      const beforeTarget = snapshot(runtime, target.id);
      const beforeUnrelated = snapshot(runtime, unrelated.id);
      const beforeCounts = counts(runtime);

      const result = await approveCandidate(runtime as any, {
        candidateId: target.id,
        cwd: "/repo-b",
        scopeContext: PROJECT_B_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result).toEqual({
        outcome: "rejected",
        reason: "candidate belongs to a different project",
        code: "project_mismatch",
      });
      expect(runtime.repos.candidates.getById(target.id)!.state).toBe("pending");
      expect(snapshot(runtime, target.id)).toEqual(beforeTarget);
      expect(snapshot(runtime, unrelated.id)).toEqual(beforeUnrelated);
      expect(counts(runtime)).toEqual(beforeCounts);
      expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
      expect(runtime.adapter.retainOneMemory).not.toHaveBeenCalled();
    });

    it("direct-ID approveCandidate on a past-TTL candidate from a disabled-project scope leaves it untouched, zero provider I/O", async () => {
      const runtime = makeRuntime();
      const target = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      makePastTtl(runtime, target.id);
      const beforeCounts = counts(runtime);

      const result = await approveCandidate(runtime as any, {
        candidateId: target.id,
        cwd: "/no-project",
        scopeContext: DISABLED_SCOPE,
        sourceSessionId: "session-1",
      });

      expect(result).toEqual({
        outcome: "rejected",
        reason: "project scope is unavailable for this candidate",
        code: "project_unavailable",
      });
      expect(runtime.repos.candidates.getById(target.id)!.state).toBe("pending");
      expect(counts(runtime)).toEqual(beforeCounts);
      expect(runtime.adapter.ensureOwnedBank).not.toHaveBeenCalled();
    });
  });

  describe("candidate reviewer TOCTOU: scope re-resolved before each write", () => {
    function makeCtx(overrides: Partial<{ notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> }> = {}) {
      return {
        mode: "tui",
        cwd: "/repo-a",
        ui: {
          notify: overrides.notify ?? vi.fn(),
          confirm: overrides.confirm ?? vi.fn().mockResolvedValue(true),
          input: overrides.input ?? vi.fn(),
        },
        sessionManager: { getSessionId: () => "session-1" },
      };
    }

    it("blocks approve ('a') if the project context changes after the reviewer opened", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const notify = vi.fn();
      const ctx = makeCtx({ notify });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });
      expect(reviewer.getItems().map((r) => r.id)).toContain(row.id);

      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-b",
        bankId: projectBankId("repo-b"),
      }));

      await reviewer.handleInput("a");

      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
      const lastNotify = notify.mock.calls.at(-1);
      expect(lastNotify?.[1]).toBe("error");
    });

    it("blocks reject ('r') if the project context changes after the reviewer opened", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const notify = vi.fn();
      const ctx = makeCtx({ notify });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-b",
        bankId: projectBankId("repo-b"),
      }));

      await reviewer.handleInput("r");

      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
      const lastNotify = notify.mock.calls.at(-1);
      expect(lastNotify?.[1]).toBe("error");
    });

    it("does not open the edit prompt ('e') for a candidate that fell out of scope before the key is pressed", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const input = vi.fn();
      const ctx = makeCtx({ input });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-b",
        bankId: projectBankId("repo-b"),
      }));

      await reviewer.handleInput("e");

      expect(input).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
    });

    it("re-resolves scope again after the edit prompt returns, blocking approval if context changed mid-edit", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const notify = vi.fn();
      const input = vi.fn().mockImplementation(async () => {
        resolveProjectBankMock.mockImplementation(async () => ({
          enabled: true,
          identity: "repo-b",
          bankId: projectBankId("repo-b"),
        }));
        return "an edited body of sufficient length";
      });
      const ctx = makeCtx({ notify, input });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      await reviewer.handleInput("e");

      expect(input).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
      const lastNotify = notify.mock.calls.at(-1);
      expect(lastNotify?.[1]).toBe("error");
    });

    it("excludes a candidate from batch reject ('x') once it falls out of scope before the key is pressed", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a", { text: "short" }));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const confirm = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({ confirm });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-b",
        bankId: projectBankId("repo-b"),
      }));

      await reviewer.handleInput("x");

      expect(confirm).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
    });

    it("re-resolves scope again after the batch confirm prompt returns, excluding a candidate that fell out of scope mid-confirm", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a", { text: "short" }));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const confirm = vi.fn().mockImplementation(async () => {
        resolveProjectBankMock.mockImplementation(async () => ({
          enabled: true,
          identity: "repo-b",
          bankId: projectBankId("repo-b"),
        }));
        return true;
      });
      const ctx = makeCtx({ confirm });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      await reviewer.handleInput("x");

      expect(confirm).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
    });
  });

  describe("handleInput key handling: arrow navigation, Escape, empty input", () => {
    function selectedLineIndex(view: string[]): number {
      return view.findIndex((line) => line.startsWith("> "));
    }

    function makeCtx() {
      return {
        mode: "tui",
        cwd: "/repo-a",
        ui: { notify: vi.fn(), confirm: vi.fn(), input: vi.fn() },
        sessionManager: { getSessionId: () => "session-1" },
      };
    }

    it("moves selection down and up using the escaped arrow-key sequences, clamping at the ends", async () => {
      const runtime = makeRuntime();
      runtime.repos.candidates.create(newCandidate({ text: "first" }));
      runtime.repos.candidates.create(newCandidate({ text: "second" }));
      runtime.repos.candidates.create(newCandidate({ text: "third" }));
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROFILE_SCOPE,
      });

      const base = selectedLineIndex(reviewer.render(120));

      await reviewer.handleInput("\u001b[B");
      expect(selectedLineIndex(reviewer.render(120))).toBe(base + 1);

      await reviewer.handleInput("\u001b[B");
      expect(selectedLineIndex(reviewer.render(120))).toBe(base + 2);

      await reviewer.handleInput("\u001b[B");
      expect(selectedLineIndex(reviewer.render(120))).toBe(base + 2);

      await reviewer.handleInput("\u001b[A");
      expect(selectedLineIndex(reviewer.render(120))).toBe(base + 1);

      await reviewer.handleInput("\u001b[A");
      await reviewer.handleInput("\u001b[A");
      expect(selectedLineIndex(reviewer.render(120))).toBe(base);
    });

    it("closes the reviewer on the Escape key alone", async () => {
      const runtime = makeRuntime();
      runtime.repos.candidates.create(newCandidate());
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROFILE_SCOPE,
      });

      const outcome = await reviewer.handleInput("\u001b");

      expect(outcome).toBe("done");
    });

    it("never treats empty input as Escape: it neither closes the reviewer nor moves selection", async () => {
      const runtime = makeRuntime();
      runtime.repos.candidates.create(newCandidate({ text: "first" }));
      runtime.repos.candidates.create(newCandidate({ text: "second" }));
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROFILE_SCOPE,
      });

      const before = selectedLineIndex(reviewer.render(120));

      const outcome = await reviewer.handleInput("");

      expect(outcome).toBeUndefined();
      expect(selectedLineIndex(reviewer.render(120))).toBe(before);
      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
    });
  });

  describe("reviewer approve/edit-approve: zero provider I/O before authorization", () => {
    function makeCtx(
      overrides: Partial<{ notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> }> = {},
    ) {
      return {
        mode: "tui",
        cwd: "/repo-a",
        ui: {
          notify: overrides.notify ?? vi.fn(),
          confirm: overrides.confirm ?? vi.fn().mockResolvedValue(true),
          input: overrides.input ?? vi.fn(),
        },
        sessionManager: { getSessionId: () => "session-1" },
      };
    }

    it("does not call getGlobalRuntime when approving ('a') a candidate that fell out of scope (mismatched project)", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const notify = vi.fn();
      const ctx = makeCtx({ notify });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-b",
        bankId: projectBankId("repo-b"),
      }));

      await reviewer.handleInput("a");

      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
      expect(notify.mock.calls.at(-1)?.[1]).toBe("error");
    });

    it("does not call getGlobalRuntime when approving ('a') a candidate whose project becomes disabled", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      resolveProjectBankMock.mockImplementation(async () => ({ enabled: false, reason: "disabled" }));

      await reviewer.handleInput("a");

      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
    });

    it("does call getGlobalRuntime and approves ('a') when the project still matches", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      await reviewer.handleInput("a");

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("approved");
    });

    it("does call getGlobalRuntime and approves ('a') a Profile candidate even when the current project is disabled", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(newCandidate());
      resolveProjectBankMock.mockImplementation(async () => ({ enabled: false, reason: "disabled" }));
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      const ctx = makeCtx();
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: DISABLED_SCOPE,
      });

      await reviewer.handleInput("a");

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("approved");
    });

    it("does not call getGlobalRuntime for the post-input TOCTOU path of edit-approve ('e') when scope changes during the edit prompt", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      const notify = vi.fn();
      const input = vi.fn().mockImplementation(async () => {
        resolveProjectBankMock.mockImplementation(async () => ({
          enabled: true,
          identity: "repo-b",
          bankId: projectBankId("repo-b"),
        }));
        return "an edited body of sufficient length";
      });
      const ctx = makeCtx({ notify, input });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      await reviewer.handleInput("e");

      expect(input).toHaveBeenCalled();
      expect(getGlobalRuntimeMock).not.toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("pending");
      expect(notify.mock.calls.at(-1)?.[1]).toBe("error");
    });

    it("does call getGlobalRuntime and approves the edited body ('e') when scope still matches after the edit prompt", async () => {
      const runtime = makeRuntime();
      const row = runtime.repos.candidates.create(projectCandidateInput("repo-a"));
      resolveProjectBankMock.mockImplementation(async () => ({
        enabled: true,
        identity: "repo-a",
        bankId: projectBankId("repo-a"),
      }));
      getGlobalRuntimeMock.mockResolvedValue({ ok: true, runtime });
      const input = vi.fn().mockResolvedValue("an edited body of sufficient length");
      const ctx = makeCtx({ input });
      const reviewer = createCandidateReviewer({
        runtime: runtime as any,
        ctx: ctx as any,
        language: "en",
        scopeContext: PROJECT_A_SCOPE,
      });

      await reviewer.handleInput("e");

      expect(getGlobalRuntimeMock).toHaveBeenCalled();
      expect(runtime.repos.candidates.getById(row.id)!.state).toBe("approved");
    });
  });
});

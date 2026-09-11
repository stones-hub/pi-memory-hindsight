import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryDatabase } from "../src/db/database.js";
import { ProfileRepository } from "../src/db/profile-repository.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { CandidatesRepository, type NewCandidateInput } from "../src/db/candidates-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { MaintenanceRepository } from "../src/db/maintenance-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { profileBankId } from "../src/identity/bank-id.js";
import type { CandidateScopeContext } from "../src/governance/candidate-service.js";
import { createCandidateReviewer } from "../src/ui/candidate-reviewer.js";

// Real Pi crash evidence: terminal width 180, Candidate summary lines with
// visible width 207-224 because the reviewer truncated with
// String.prototype.slice(0, width), which counts UTF-16 code units rather
// than terminal columns. These tests reproduce that class of content and
// assert the component contract using visibleWidth(), not `.length`.

const PROFILE_SCOPE: CandidateScopeContext = { projectIdentity: null, projectScopeEnabled: false };
const PROJECT_SCOPE: CandidateScopeContext = {
  projectIdentity: "项目仓库名称非常长很长很长很长很长",
  projectScopeEnabled: true,
};

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
      ensureOwnedBank: vi.fn(),
      retainOneMemory: vi.fn(),
      verifyOneUnitDocument: vi.fn(),
      deleteMemoryDocument: vi.fn(),
      verifyDeletionPostconditions: vi.fn(),
      fetchExactOneUnitDocument: vi.fn(),
      reflect: vi.fn(),
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

function makeContext(cwd = "/repo") {
  return {
    cwd,
    signal: undefined,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn().mockResolvedValue("edited"),
    },
    sessionManager: {
      getSessionId: () => "session-1",
    },
  };
}

function newCandidate(overrides: Partial<NewCandidateInput> = {}): NewCandidateInput {
  return {
    scope: "profile",
    memoryType: "preference",
    text: "short",
    evidenceSummary: null,
    sourceSessionId: "session-1",
    sourceRef: null,
    proposedAction: "create",
    targetMemoryId: null,
    projectIdentity: null,
    ...overrides,
  };
}

function assertEveryLineFits(lines: string[], width: number): void {
  const budget = Math.max(0, width);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(budget);
  }
}

describe("candidate reviewer terminal-width safety", () => {
  it("keeps every rendered line within visible width 180 for a Chinese/full-width Candidate summary (crash reproduction)", () => {
    const runtime = makeRuntime();
    // 130 CJK characters at width 2 each is 260 visible columns before
    // accounting for the "id [scope/type] " prefix - comfortably inside the
    // 207-224 range captured in the real crash, but a plain .slice(0, 180)
    // would keep up to 180 *code units* (still >180 visible columns).
    runtime.repos.candidates.create(
      newCandidate({ text: "候选记忆内容摘要".repeat(15), memoryType: "habit" }),
    );
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "zh",
      scopeContext: PROFILE_SCOPE,
    });

    const lines = reviewer.render(180);
    assertEveryLineFits(lines, 180);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("keeps long wide-character detail, evidence, project, and control lines within width 180", () => {
    const runtime = makeRuntime();
    runtime.repos.candidates.create(
      newCandidate({
        scope: "project",
        memoryType: "project_fact",
        text: "项目相关的长事实描述".repeat(10),
        evidenceSummary: "证据摘要内容也很长".repeat(10),
        projectIdentity: PROJECT_SCOPE.projectIdentity,
      }),
    );
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "zh", // zh controls/detail copy is wide-character text
      scopeContext: PROJECT_SCOPE,
    });

    const lines = reviewer.render(180);
    assertEveryLineFits(lines, 180);
    // Project and evidence detail lines must actually be present (not skipped).
    expect(lines.some((line) => line.includes("项目"))).toBe(true);
    expect(lines.some((line) => line.includes("证据"))).toBe(true);
  });

  it("keeps every line within a narrow width (40) despite wide-character content", () => {
    const runtime = makeRuntime();
    runtime.repos.candidates.create(
      newCandidate({ text: "宽字符候选内容".repeat(20), memoryType: "habit" }),
    );
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "zh",
      scopeContext: PROFILE_SCOPE,
    });

    assertEveryLineFits(reviewer.render(40), 40);
  });

  it("returns only empty lines at width 0 without throwing", () => {
    const runtime = makeRuntime();
    runtime.repos.candidates.create(newCandidate({ text: "宽字符".repeat(30), memoryType: "habit" }));
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "zh",
      scopeContext: PROFILE_SCOPE,
    });

    const lines = reviewer.render(0);
    assertEveryLineFits(lines, 0);
    for (const line of lines) {
      expect(line).toBe("");
    }
  });

  it("normalizes a negative width to zero without throwing", () => {
    const runtime = makeRuntime();
    runtime.repos.candidates.create(newCandidate({ text: "候选".repeat(10) }));
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "en",
      scopeContext: PROFILE_SCOPE,
    });

    const lines = reviewer.render(-5);
    assertEveryLineFits(lines, -5);
    for (const line of lines) {
      expect(line).toBe("");
    }
  });

  it("keeps an ANSI-styled evidence line within visible width while preserving Unicode content", () => {
    const runtime = makeRuntime();
    const ansiEvidence = `[31m${"红色警示证据说明".repeat(12)}[0m`;
    runtime.repos.candidates.create(
      newCandidate({ text: "候选正文", evidenceSummary: ansiEvidence, memoryType: "habit" }),
    );
    const ctx = makeContext();
    const reviewer = createCandidateReviewer({
      runtime: runtime as any,
      ctx: ctx as any,
      language: "zh",
      scopeContext: PROFILE_SCOPE,
    });

    const lines = reviewer.render(180);
    assertEveryLineFits(lines, 180);
    expect(lines.some((line) => line.includes("证据"))).toBe(true);
  });
});

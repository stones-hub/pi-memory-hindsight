// Packaged, fully-isolated Pi TUI black-box acceptance for Candidate project
// isolation and safe diagnostics (docs/decisions/candidate-project-isolation-and-diagnostics.md,
// .pi/tasks/candidate-project-isolation-and-diagnostics.md "Verify: 本机候选运行验收").
//
// Extends the acceptance-pi.mjs pattern with three cwd contexts (Project A,
// Project B, and a plain non-project directory) sharing one isolated Pi
// agent dir, and seeds synthetic candidates directly into the temporary
// SQLite governance DB (per the task's explicit permission to use only
// temporary directories and synthetic candidates for this scenario) so the
// scenario does not depend on driving real model-based extraction.
//
// Never touches the user's live ~/.pi/agent DB or live Hindsight; only
// connects to the loopback mock Hindsight server started below.
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  buildIsolatedPiEnv,
  cleanupIsolatedPaths,
  createIsolatedPaths,
  normalizeAnsi,
  runChild,
  writeGlobalMemoryConfig,
  writeProjectMemoryConfig,
} from "../dist/testing/acceptance-helpers.js";
import { startMockHindsightServer } from "../dist/testing/mock-hindsight.js";
import { projectBankId } from "../dist/identity/bank-id.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PY_DRIVER = path.join(ROOT, "scripts", "pi_pty_driver.py");
const FAKE_PROVIDER = path.join(ROOT, "tests", "e2e-harness", "fake-provider.ts");
const EVIDENCE_PATH = "/tmp/pi-memory-hindsight-acceptance-candidate-isolation.json";
const FAILURE_TRANSCRIPT_LIMIT = 4000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function packInto(tempDir) {
  await fs.mkdir(tempDir, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", tempDir], { cwd: ROOT });
  const parsed = JSON.parse(stdout);
  const filename = parsed[0]?.filename;
  assert(typeof filename === "string", "npm pack did not produce a tarball filename");
  return path.join(tempDir, filename);
}

async function unpackTarball(tarball, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", tarball, "-C", destDir], { cwd: ROOT });
  return path.join(destDir, "package");
}

function redactText(value, paths) {
  if (!value) return "";
  let redacted = String(value);
  for (const candidate of [
    paths?.rootDir,
    paths?.homeDir,
    paths?.agentDir,
    paths?.sessionDir,
    "acceptance-secret-token",
    "Bearer acceptance-secret-token",
    "authorization",
  ].filter(Boolean)) {
    redacted = redacted.split(candidate).join("<redacted>");
  }
  return redacted.slice(-FAILURE_TRANSCRIPT_LIMIT);
}

async function runPtySession(argv, env, cwd, steps, timeoutMs = 20000) {
  const specPath = path.join(env.PI_CODING_AGENT_DIR, `pty-${randomUUID()}.json`);
  await fs.writeFile(specPath, JSON.stringify({ argv, env, cwd, steps, timeoutMs }), "utf8");
  try {
    const result = await runChild("python3", [PY_DRIVER, specPath], {
      cwd: ROOT,
      env,
      timeoutMs: timeoutMs + 3000,
    });
    assert(result.exitCode === 0, `PTY driver shell failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`);
    const parsed = JSON.parse(result.stdout);
    parsed.output = normalizeAnsi(parsed.output);
    assert(parsed.driverExitCode === 0, `PTY expectation failure: ${JSON.stringify(parsed)}`);
    assert(parsed.processExitCode === 0, `Pi exited non-zero: ${JSON.stringify(parsed)}`);
    return parsed;
  } finally {
    await fs.rm(specPath, { force: true });
  }
}

function dbPath(agentDir) {
  return path.join(agentDir, "memory", "pi-memory-hindsight.db");
}

function openDb(agentDir) {
  return new DatabaseSync(dbPath(agentDir));
}

function getCandidate(db, id) {
  return db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
}

function countRoutes(journal, route) {
  return journal.filter((entry) => entry.route === route).length;
}

// Every route the mock Hindsight server can record (src/testing/mock-hindsight.ts
// RouteName, plus its "unknown" fallback for unmatched paths). A wrong/
// disabled-project command must trigger zero calls of ANY of these — not just
// the mutation-shaped ones (retain/document_delete) — because the blocker
// this acceptance guards against is specifically getGlobalRuntime()'s
// provider health/version compatibility check running before authorization.
// "health" and "version" are the routes that check would hit if it ran.
const ALL_ROUTES = [
  "health",
  "version",
  "bank_put",
  "bank_delete",
  "bank_config_patch",
  "bank_config_get",
  "retain",
  "list",
  "recall",
  "document_get",
  "document_delete",
  "unknown",
];

function journalSnapshot(journal) {
  const snapshot = {};
  for (const route of ALL_ROUTES) snapshot[route] = countRoutes(journal, route);
  return snapshot;
}

function diffSnapshot(before, after) {
  const diff = {};
  for (const route of ALL_ROUTES) {
    const delta = after[route] - before[route];
    if (delta !== 0) diff[route] = delta;
  }
  return diff;
}

// Mirrors mock-hindsight.js's own parseBankId() so this check inspects the
// bank id the mock server actually parsed off each request path, not a
// string that merely looks similar.
function bankIdFromJournalPath(requestPath) {
  const match = requestPath.match(/^\/v1\/default\/banks\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const NOW = Date.now();
const FUTURE = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

function seedCandidate(db, row) {
  db.prepare(
    `INSERT INTO candidates (
       id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
       proposed_action, target_memory_id, project_identity, state, created_at, updated_at,
       expires_at, approved_memory_id, failure_code, expected_target_text_hash, text_hash, body_purged_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'create', NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
  ).run(
    row.id,
    row.scope,
    row.memoryType,
    row.text,
    row.projectIdentity ?? null,
    row.state,
    NOW_ISO,
    NOW_ISO,
    FUTURE,
    row.failureCode ?? null,
  );
}

const PROJECT_A_IDENTITY = "accept-repo-a";
const PROJECT_B_IDENTITY = "accept-repo-b";

const CANDIDATES = {
  aVisible: { id: "cand-a-visible", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_A_IDENTITY, state: "pending", text: "Project A visible fact one." },
  bVisible: { id: "cand-b-visible", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_B_IDENTITY, state: "pending", text: "Project B visible fact one." },
  profileVisible: { id: "cand-profile-visible", scope: "profile", memoryType: "preference", projectIdentity: null, state: "pending", text: "Profile visible preference one." },
  aRetry: { id: "cand-a-retry", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_A_IDENTITY, state: "failed", failureCode: "project_unavailable", text: "Project A retry fact one." },
  aApproveBlock: { id: "cand-a-approveblock", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_A_IDENTITY, state: "pending", text: "Project A approve-block fact." },
  aEditAttempt: { id: "cand-a-editattempt", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_A_IDENTITY, state: "pending", text: "Project A edit target fact." },
  aUnrecognized: { id: "cand-a-unrecognized", scope: "project", memoryType: "project_fact", projectIdentity: PROJECT_A_IDENTITY, state: "failed", failureCode: "mystery_unallowlisted_code", text: "Project A unrecognized failure fact." },
};

const evidence = {
  packedArtifactLoaded: false,
  schemaInitialized: false,
  plainListShowsOnlyProfile: false,
  bListShowsOnlyBAndProfile: false,
  aListShowsOnlyAAndProfile: false,
  unrecognizedFailureCodeIsGeneric: false,
  plainRejectBlockedProjectUnavailable: false,
  bRejectBlockedProjectMismatch: false,
  aRejectSucceeded: false,
  plainApproveBlockedProjectUnavailable: false,
  bApproveBlockedProjectMismatch: false,
  aApproveSucceeded: false,
  aRetryApproveSucceeded: false,
  bEditApproveBlockedProjectMismatch: false,
  aEditApproveSucceeded: false,
  profileRejectSucceededFromPlainDir: false,
  reviewerHeaderMatchingProject: false,
  reviewerHeaderProfileOnly: false,
  zeroSideEffectsOnBlockedAttempts: false,
  noCrossProjectProviderMutation: false,
  pending: [],
};

function ensureRequiredSuccess(ev) {
  const required = Object.keys(evidence).filter((key) => key !== "pending");
  const failed = required.filter((key) => ev[key] !== true);
  if (failed.length > 0) {
    throw new Error(`candidate-project-isolation acceptance failed: ${failed.join(", ")}`);
  }
}

const paths = await createIsolatedPaths("pi-memory-hindsight-acceptance-candidate-iso-");
const projectBDir = path.join(paths.rootDir, "project-b");
const projectPlainDir = path.join(paths.rootDir, "project-plain");

let server;
const failure = {};
try {
  await fs.mkdir(projectBDir, { recursive: true });
  await fs.mkdir(projectPlainDir, { recursive: true });
  // resolveProjectIdentity() (src/identity/project-identity.ts) requires a
  // discoverable ".git" directory before it will even consult .pi/memory.json;
  // a plain directory at that path is sufficient (findGitRoot only stat()s
  // it), matching the pattern tests/identity.test.ts uses.
  await fs.mkdir(path.join(paths.projectDir, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectBDir, ".git"), { recursive: true });
  await writeProjectMemoryConfig(paths.projectDir, { enabled: true, project: PROJECT_A_IDENTITY });
  await writeProjectMemoryConfig(projectBDir, { enabled: true, project: PROJECT_B_IDENTITY });
  // projectPlainDir intentionally has no .git or .pi/memory.json: Project scope disabled.

  const packDir = path.join(paths.rootDir, "pack");
  const tarball = await packInto(packDir);
  const unpacked = await unpackTarball(tarball, path.join(paths.rootDir, "unpacked"));
  const manifest = JSON.parse(await fs.readFile(path.join(unpacked, "package.json"), "utf8"));
  assert(Array.isArray(manifest?.pi?.extensions) && manifest.pi.extensions.length > 0, "packed extension manifest missing");
  evidence.packedArtifactLoaded = true;

  server = await startMockHindsightServer();
  await writeGlobalMemoryConfig(paths.agentDir, server.baseUrl);

  const env = buildIsolatedPiEnv(paths, { HINDSIGHT_API_KEY: "acceptance-secret-token" });
  const baseArgs = [
    "--offline",
    "--approve",
    "--session-dir",
    paths.sessionDir,
    "--no-extensions",
    "-e",
    unpacked,
    "-e",
    FAKE_PROVIDER,
    "--provider",
    "acceptance-local",
    "--model",
    "acceptance-local-model",
  ];

  // Boot once in Project A to force schema/profile creation, then seed
  // synthetic candidates directly into the temporary SQLite governance DB.
  const bootSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-boot"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory status\r", expect: "Project scope: enabled", timeoutMs: 6000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    16000,
  );
  failure.bootSession = redactText(bootSession.output, paths);
  evidence.schemaInitialized = await fs
    .stat(dbPath(paths.agentDir))
    .then(() => true, () => false);
  assert(evidence.schemaInitialized, "boot session did not create the governance SQLite DB");

  {
    const db = openDb(paths.agentDir);
    for (const candidate of Object.values(CANDIDATES)) seedCandidate(db, candidate);
    db.close();
  }

  // --- Plain (Project disabled) dir: pass 1 — list visibility + blocked mutations ---
  // Baseline captured immediately before this session's own process starts:
  // this is a fresh `pi` child process, so it carries no leftover
  // provider-readiness state from the boot session above (getGlobalRuntime's
  // compatibility memoization is in-process only). Any health/version/etc.
  // entry that appears after this baseline within this session is therefore
  // caused by this session's own actions, not extension/process lifecycle.
  let before = journalSnapshot(server.journal);
  const plainSession1 = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-plain-1"],
    env,
    projectPlainDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory candidates list\r", expect: CANDIDATES.profileVisible.id, timeoutMs: 7000 },
      { input: `/memory candidates reject ${CANDIDATES.aVisible.id}\r`, expect: "unavailable for this candidate's project here", timeoutMs: 7000 },
      { input: `/memory candidates approve ${CANDIDATES.aApproveBlock.id}\r`, expect: "unavailable for this candidate's project here", timeoutMs: 7000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    22000,
  );
  failure.plainSession1 = redactText(plainSession1.output, paths);
  evidence.plainListShowsOnlyProfile =
    plainSession1.output.includes(CANDIDATES.profileVisible.id) &&
    !plainSession1.output.includes(CANDIDATES.aVisible.id) &&
    !plainSession1.output.includes(CANDIDATES.bVisible.id) &&
    !plainSession1.output.includes(CANDIDATES.aRetry.id) &&
    !plainSession1.output.includes(CANDIDATES.aApproveBlock.id) &&
    !plainSession1.output.includes(CANDIDATES.aEditAttempt.id) &&
    !plainSession1.output.includes(CANDIDATES.aUnrecognized.id);
  // Reject and approve share the same project_unavailable copy; each blocked
  // call must independently produce it (count occurrences, not mere presence).
  const plainUnavailableOccurrences = plainSession1.output.split("unavailable for this candidate's project here").length - 1;
  evidence.plainRejectBlockedProjectUnavailable = plainUnavailableOccurrences >= 1;
  evidence.plainApproveBlockedProjectUnavailable = plainUnavailableOccurrences >= 2;
  {
    const db = openDb(paths.agentDir);
    const a = getCandidate(db, CANDIDATES.aVisible.id);
    const ab = getCandidate(db, CANDIDATES.aApproveBlock.id);
    db.close();
    assert(a.state === "pending", `expected cand-a-visible to remain pending after plain-dir blocked reject, got ${a.state}`);
    assert(ab.state === "pending", `expected cand-a-approveblock to remain pending after plain-dir blocked approve, got ${ab.state}`);
  }
  let after = journalSnapshot(server.journal);
  let diff = diffSnapshot(before, after);
  const plainZeroIO = Object.keys(diff).length === 0;
  assert(
    plainZeroIO,
    `plain-dir blocked candidate attempts must not touch the provider on any route (including health/version readiness checks): new entries by route=${JSON.stringify(diff)}`,
  );

  // --- Project B dir: list visibility + blocked cross-project mutations ---
  before = journalSnapshot(server.journal);
  const bSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-project-b"],
    env,
    projectBDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory candidates list\r", expect: CANDIDATES.bVisible.id, timeoutMs: 7000 },
      { input: `/memory candidates reject ${CANDIDATES.aVisible.id}\r`, expect: "belongs to a different project", timeoutMs: 7000 },
      { input: `/memory candidates approve ${CANDIDATES.aApproveBlock.id}\r`, expect: "belongs to a different project", timeoutMs: 7000 },
      { input: `/memory candidates edit-approve ${CANDIDATES.aEditAttempt.id} B-authored edit attempt.\r`, expect: "belongs to a different project", timeoutMs: 7000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    26000,
  );
  failure.bSession = redactText(bSession.output, paths);
  evidence.bListShowsOnlyBAndProfile =
    bSession.output.includes(CANDIDATES.bVisible.id) &&
    bSession.output.includes(CANDIDATES.profileVisible.id) &&
    !bSession.output.includes(CANDIDATES.aVisible.id) &&
    !bSession.output.includes(CANDIDATES.aRetry.id) &&
    !bSession.output.includes(CANDIDATES.aApproveBlock.id) &&
    !bSession.output.includes(CANDIDATES.aEditAttempt.id) &&
    !bSession.output.includes(CANDIDATES.aUnrecognized.id);
  const mismatchOccurrences = bSession.output.split("belongs to a different project").length - 1;
  evidence.bRejectBlockedProjectMismatch = mismatchOccurrences >= 1;
  evidence.bApproveBlockedProjectMismatch = mismatchOccurrences >= 2;
  evidence.bEditApproveBlockedProjectMismatch = mismatchOccurrences >= 3;
  {
    const db = openDb(paths.agentDir);
    const a = getCandidate(db, CANDIDATES.aVisible.id);
    const ab = getCandidate(db, CANDIDATES.aApproveBlock.id);
    const ae = getCandidate(db, CANDIDATES.aEditAttempt.id);
    db.close();
    assert(a.state === "pending", `expected cand-a-visible to remain pending after B-dir blocked reject, got ${a.state}`);
    assert(ab.state === "pending", `expected cand-a-approveblock to remain pending after B-dir blocked approve, got ${ab.state}`);
    assert(ae.state === "pending" && ae.text === CANDIDATES.aEditAttempt.text, "expected cand-a-editattempt untouched after B-dir blocked edit-approve");
  }
  after = journalSnapshot(server.journal);
  diff = diffSnapshot(before, after);
  const bZeroIO = Object.keys(diff).length === 0;
  assert(
    bZeroIO,
    `Project-B blocked cross-project attempts must not touch the provider on any route (including health/version readiness checks): new entries by route=${JSON.stringify(diff)}`,
  );
  evidence.zeroSideEffectsOnBlockedAttempts = plainZeroIO && bZeroIO;

  // --- Project A dir (matching): list visibility, diagnostics, and successful mutations ---
  before = journalSnapshot(server.journal);
  const aSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-project-a"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory candidates list\r", expect: CANDIDATES.aUnrecognized.id, timeoutMs: 7000 },
      { input: `/memory candidates reject ${CANDIDATES.aVisible.id}\r`, expect: "Candidate rejected.", timeoutMs: 7000 },
      { input: `/memory candidates approve ${CANDIDATES.aApproveBlock.id}\r`, expect: "Candidate approved and remembered as", timeoutMs: 9000 },
      { input: `/memory candidates approve ${CANDIDATES.aRetry.id}\r`, expect: "Candidate approved and remembered as", timeoutMs: 9000 },
      { input: `/memory candidates edit-approve ${CANDIDATES.aEditAttempt.id} A-authored edit approved.\r`, expect: "Candidate approved and remembered as", timeoutMs: 9000 },
      { input: "/memory candidates\r", expect: "Showing Profile candidates plus Project (accept-repo-a)", timeoutMs: 7000 },
      { input: "q", waitBeforeMs: 500 },
      // The driver only pumps output before a step (via waitBeforeMs), never
      // after; without this pause here the closing overlay's teardown races
      // the immediately-following "/quit\r" and can swallow it as stray
      // keystrokes routed to the still-mounted reviewer.
      { input: "/quit\r", waitBeforeMs: 800, timeoutMs: 6000 },
    ],
    40000,
  );
  failure.aSession = redactText(aSession.output, paths);
  evidence.aListShowsOnlyAAndProfile =
    aSession.output.includes(CANDIDATES.aVisible.id) &&
    aSession.output.includes(CANDIDATES.aRetry.id) &&
    aSession.output.includes(CANDIDATES.aApproveBlock.id) &&
    aSession.output.includes(CANDIDATES.aEditAttempt.id) &&
    aSession.output.includes(CANDIDATES.aUnrecognized.id) &&
    aSession.output.includes(CANDIDATES.profileVisible.id) &&
    !aSession.output.includes(CANDIDATES.bVisible.id);
  evidence.unrecognizedFailureCodeIsGeneric =
    aSession.output.includes("failed for a reason that cannot be safely detailed") &&
    !aSession.output.includes("mystery_unallowlisted_code");
  evidence.aRejectSucceeded = aSession.output.includes("Candidate rejected.");
  const approvedOccurrences = aSession.output.split("Candidate approved and remembered as").length - 1;
  evidence.aApproveSucceeded = approvedOccurrences >= 1;
  evidence.aRetryApproveSucceeded = approvedOccurrences >= 2;
  evidence.aEditApproveSucceeded = approvedOccurrences >= 3;
  evidence.reviewerHeaderMatchingProject = aSession.output.includes(
    "Showing Profile candidates plus Project (accept-repo-a)",
  );
  {
    const db = openDb(paths.agentDir);
    const a = getCandidate(db, CANDIDATES.aVisible.id);
    const ab = getCandidate(db, CANDIDATES.aApproveBlock.id);
    const ar = getCandidate(db, CANDIDATES.aRetry.id);
    const ae = getCandidate(db, CANDIDATES.aEditAttempt.id);
    const b = getCandidate(db, CANDIDATES.bVisible.id);
    db.close();
    assert(a.state === "rejected", `expected cand-a-visible rejected from matching project, got ${a.state}`);
    assert(ab.state === "approved", `expected cand-a-approveblock approved from matching project, got ${ab.state}`);
    assert(ar.state === "approved", `expected cand-a-retry approved on retry from matching project, got ${ar.state}`);
    assert(ae.state === "approved", `expected cand-a-editattempt approved via edit-approve, got ${ae.state}`);
    assert(b.state === "pending", "Project A operations must never mutate Project B's candidate");
  }
  after = journalSnapshot(server.journal);
  assert(after.retain - before.retain === 3, `expected exactly 3 new retain routes (approve x2 create + edit-approve), got ${after.retain - before.retain}`);

  // --- Plain dir: pass 2 — Profile candidate operable even with Project disabled ---
  const plainSession2 = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-plain-2"],
    env,
    projectPlainDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: `/memory candidates reject ${CANDIDATES.profileVisible.id}\r`, expect: "Candidate rejected.", timeoutMs: 7000 },
      { input: "/memory candidates\r", expect: "Showing Profile candidates only", timeoutMs: 7000 },
      { input: "q", waitBeforeMs: 500 },
      { input: "/quit\r", waitBeforeMs: 800, timeoutMs: 6000 },
    ],
    22000,
  );
  failure.plainSession2 = redactText(plainSession2.output, paths);
  evidence.profileRejectSucceededFromPlainDir = plainSession2.output.includes("Candidate rejected.");
  evidence.reviewerHeaderProfileOnly = plainSession2.output.includes("Showing Profile candidates only");
  {
    const db = openDb(paths.agentDir);
    const p = getCandidate(db, CANDIDATES.profileVisible.id);
    db.close();
    assert(p.state === "rejected", `expected cand-profile-visible rejected from disabled-project cwd, got ${p.state}`);
  }

  // Code-level proof, not a self-reported boolean: cand-b-visible is never
  // legitimately approved anywhere in this script, so Project B's bank must
  // never appear as the target of any request the mock server received
  // across the entire run (every session shares this one mock server
  // instance and journal). A cross-project write bug would show up here even
  // if it happened to also satisfy the per-session zero-IO deltas above
  // (e.g. a mutation that targets B's bank without changing A's/plain's
  // route counts).
  const projectBBankId = projectBankId(PROJECT_B_IDENTITY);
  const crossProjectBTouches = server.journal.filter((entry) => bankIdFromJournalPath(entry.path) === projectBBankId);
  assert(
    crossProjectBTouches.length === 0,
    `Project B's bank (${projectBBankId}) must never be touched by any Pi session in this run: ${JSON.stringify(crossProjectBTouches)}`,
  );
  evidence.noCrossProjectProviderMutation = crossProjectBTouches.length === 0;

  ensureRequiredSuccess(evidence);
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify({ ...evidence, journal: server.journal }, null, 2)}\n`, "utf8");
  console.log(`wrote evidence to ${EVIDENCE_PATH}`);
} catch (error) {
  const failureEvidence = { ...evidence, error: String(error), failure };
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(failureEvidence, null, 2)}\n`, "utf8");
  throw error;
} finally {
  try {
    await server?.close();
  } finally {
    await cleanupIsolatedPaths(paths);
  }
}

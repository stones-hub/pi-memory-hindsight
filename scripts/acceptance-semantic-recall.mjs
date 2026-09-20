/**
 * Isolated packaged Pi acceptance for configurable semantic Recall filtering.
 * Uses a loopback mock Hindsight only — never 127.0.0.1:8888.
 * Runs the current official `pi` executable (proves 0.86.0 in this environment).
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  buildIsolatedPiEnv,
  cleanupIsolatedPaths,
  createIsolatedPaths,
  normalizeAnsi,
  runChild,
  writeGlobalMemoryConfig,
  writeProjectMemoryConfig,
} from "../dist/testing/acceptance-helpers.js";
import { ACCEPTANCE_MARKERS, RECALL_HEADERS, RECALL_HEADER_RE } from "../dist/testing/acceptance-constants.js";
import { startMockHindsightServer } from "../dist/testing/mock-hindsight.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PY_DRIVER = path.join(ROOT, "scripts", "pi_pty_driver.py");
const FAKE_PROVIDER = path.join(ROOT, "tests", "e2e-harness", "fake-provider.ts");
const PROBE = path.join(ROOT, "tests", "e2e-harness", "acceptance-probe.ts");
const EVIDENCE_PATH = "/tmp/pi-memory-hindsight-acceptance-semantic-recall.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requireSystemPiVersion(expected = "0.86.0") {
  const { stdout } = await execFileAsync("pi", ["--version"], { cwd: ROOT });
  const version = String(stdout).trim();
  assert(version === expected, `packaged acceptance requires system pi ${expected}, got ${version}`);
  return version;
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

async function runPtySession(argv, env, cwd, steps, timeoutMs = 20000) {
  const specPath = path.join(env.PI_CODING_AGENT_DIR, `pty-${randomUUID()}.json`);
  await fs.writeFile(specPath, JSON.stringify({ argv, env, cwd, steps, timeoutMs }), "utf8");
  try {
    const result = await runChild("python3", [PY_DRIVER, specPath], {
      cwd: ROOT,
      env,
      timeoutMs: timeoutMs + 4000,
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

function openMemories(agentDir) {
  return new DatabaseSync(path.join(agentDir, "memory", "pi-memory-hindsight.db"));
}

function listMemories(agentDir) {
  const db = openMemories(agentDir);
  try {
    return db
      .prepare("SELECT id, text_hash, bank_id, document_id, status FROM memories WHERE status = 'active' ORDER BY created_at ASC")
      .all();
  } finally {
    db.close();
  }
}

function parseSessionJsonl(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recallBodiesHaveMinScore(journal, expected) {
  return journal.some(
    (entry) =>
      entry.route === "recall" &&
      entry.bodySummary &&
      entry.bodySummary.min_scores &&
      Number(entry.bodySummary.min_scores.semantic) === expected,
  );
}

function recallBodiesOmitMinScores(journal, sinceIndex = 0) {
  return journal.slice(sinceIndex).filter((entry) => entry.route === "recall").every((entry) => {
    const keys = entry.bodySummary?.keys;
    return Array.isArray(keys) ? !keys.includes("min_scores") : entry.bodySummary?.min_scores === undefined;
  });
}

function extractLastRecallBlock(output) {
  const marker = "Last recall (";
  const idx = output.lastIndexOf(marker);
  if (idx < 0) return "";
  // Stop before the next UI chrome / status notify so wrap reassembly stays in-bounds.
  const slice = output.slice(idx);
  const endMarkers = ["\n──", "\nMemory:", "\nRecall filter:", "\n↑", "\nTo resume"];
  let end = slice.length;
  for (const markerText of endMarkers) {
    const at = slice.indexOf(markerText);
    if (at >= 0 && at < end) end = at;
  }
  return slice.slice(0, end);
}

/**
 * PTY wrap breaks long `/memory last` item lines. Reassemble so score text
 * (e.g. semantic=null) stays on the same logical item as its SEM-* marker.
 */
function parseLastRecallItemLines(block) {
  const items = [];
  let current = null;
  for (const raw of block.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("Last recall (")) continue;
    if (trimmed.startsWith("- ")) {
      if (current !== null) items.push(current);
      current = trimmed;
      continue;
    }
    if (current !== null) current = `${current} ${trimmed}`;
  }
  if (current !== null) items.push(current);
  return items;
}

function mapSeededRows(server, rows, texts) {
  const bySnippet = {};
  for (const row of rows) {
    const bank = server.getBank(row.bank_id);
    const units = bank?.documents.get(row.document_id) ?? [];
    const text = units[0]?.text ?? "";
    for (const [key, snippet] of Object.entries(texts)) {
      if (text.includes(snippet)) bySnippet[key] = row;
    }
  }
  return bySnippet;
}

const piVersion = await requireSystemPiVersion("0.86.0");
const paths = await createIsolatedPaths("pi-memory-hindsight-semantic-");
const evidence = {
  piVersion,
  piVersionProven: piVersion === "0.86.0",
  packedArtifactLoaded: false,
  defaultMinScoreSendsThreshold: false,
  clientSideThresholdEnforced: false,
  inclusiveBoundaryRetained: false,
  topThreeSemanticSorted: false,
  staleLastClearedSameSession: false,
  commandsAddZeroRecall: false,
  customMinScore07Authoritative: false,
  zeroMinScoreExactTopThree: false,
  legacy083InjectsMoreThanThree: false,
  noSessionOrSqliteScorePersistence: false,
  pending: [],
};

let server;
try {
  const packDir = path.join(paths.rootDir, "pack");
  const tarball = await packInto(packDir);
  const unpacked = await unpackTarball(tarball, path.join(paths.rootDir, "unpacked"));
  evidence.packedArtifactLoaded = true;

  await fs.writeFile(path.join(paths.projectDir, "README.md"), "semantic acceptance\n", "utf8");
  await writeProjectMemoryConfig(paths.projectDir, { enabled: true, project: "semantic-acceptance" });

  server = await startMockHindsightServer({ apiVersion: "0.10.0" });
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
    "-e",
    PROBE,
    "--provider",
    "acceptance-local",
    "--model",
    "acceptance-local-model",
  ];

  const texts = {
    high: "SEM-HIGH Prefer short answers in this acceptance.",
    mid: "SEM-MID Prefer explicit confirmations in this acceptance.",
    boundary: "SEM-BOUNDARY Prefer quiet notifications in this acceptance.",
    low: "SEM-LOW Prefer unrelated weather chatter in this acceptance.",
    nullish: "SEM-NULL Prefer null-semantic habits in this acceptance.",
  };

  const seed = await runPtySession(
    ["pi", ...baseArgs, "--name", "semantic-seed"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: `/memory remember profile preference ${texts.high}\r`, expect: "id=", timeoutMs: 10000 },
      { input: `/memory remember profile preference ${texts.mid}\r`, expect: "id=", timeoutMs: 10000 },
      { input: `/memory remember profile preference ${texts.boundary}\r`, expect: "id=", timeoutMs: 10000 },
      { input: `/memory remember profile preference ${texts.low}\r`, expect: "id=", timeoutMs: 10000 },
      { input: `/memory remember profile preference ${texts.nullish}\r`, expect: "id=", timeoutMs: 10000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    70000,
  );
  assert(seed.output.includes("Remembered"), "seed remember failed");

  const rows = listMemories(paths.agentDir);
  assert(rows.length === 5, `expected 5 seeded memories, got ${rows.length}`);
  const bySnippet = mapSeededRows(server, rows, {
    high: "SEM-HIGH",
    mid: "SEM-MID",
    boundary: "SEM-BOUNDARY",
    low: "SEM-LOW",
    nullish: "SEM-NULL",
  });
  assert(
    bySnippet.high && bySnippet.mid && bySnippet.boundary && bySnippet.low && bySnippet.nullish,
    "could not map seeded memories",
  );

  assert(
    server.setDocumentScores(bySnippet.high.bank_id, bySnippet.high.document_id, {
      final: 1.2,
      reranker: 0.9,
      semantic: 0.9,
      keyword: null,
    }),
  );
  assert(
    server.setDocumentScores(bySnippet.mid.bank_id, bySnippet.mid.document_id, {
      final: 1.1,
      reranker: 0.8,
      semantic: 0.8,
      keyword: null,
    }),
  );
  assert(
    server.setDocumentScores(bySnippet.boundary.bank_id, bySnippet.boundary.document_id, {
      final: 1.0,
      reranker: 0.7,
      semantic: 0.5,
      keyword: null,
    }),
  );
  assert(
    server.setDocumentScores(bySnippet.low.bank_id, bySnippet.low.document_id, {
      final: 1.5,
      reranker: 1.0,
      semantic: 0.3,
      keyword: null,
    }),
  );
  assert(
    server.setDocumentScores(bySnippet.nullish.bank_id, bySnippet.nullish.document_id, {
      final: 1.0,
      reranker: null,
      semantic: null,
      keyword: null,
    }),
  );

  const journalBeforeDefault = server.journal.length;
  // Same Session: inject eligible items, then a later ordinary empty-recall input,
  // then prove /memory last is empty and commands add zero Recall routes.
  const sameSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "semantic-same-session"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      {
        input: "What are my SEM acceptance preferences?\r",
        expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}true`,
        timeoutMs: 9000,
      },
      { input: "/memory last\r", expect: "SEM-HIGH", timeoutMs: 8000 },
      { input: "/memory status\r", expect: "semantic >= 0.5", timeoutMs: 8000 },
      {
        input: "ACCEPT_EMPTY_RECALL please clear prior diagnostics\r",
        expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}false`,
        timeoutMs: 9000,
        waitBeforeMs: 1200,
      },
      { input: "/memory last\r", expect: "injected no memory", timeoutMs: 8000 },
      { input: "/memory status\r", expect: "semantic >= 0.5", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    50000,
  );

  evidence.defaultMinScoreSendsThreshold = recallBodiesHaveMinScore(
    server.journal.slice(journalBeforeDefault),
    0.5,
  );
  const firstLast = extractLastRecallBlock(
    sameSession.output.slice(0, sameSession.output.indexOf("ACCEPT_EMPTY_RECALL")),
  );
  evidence.clientSideThresholdEnforced =
    firstLast.includes("SEM-HIGH") &&
    firstLast.includes("SEM-MID") &&
    firstLast.includes("SEM-BOUNDARY") &&
    !firstLast.includes("SEM-LOW") &&
    !firstLast.includes("SEM-NULL");
  evidence.inclusiveBoundaryRetained = firstLast.includes("SEM-BOUNDARY");
  const highPos = firstLast.indexOf("SEM-HIGH");
  const midPos = firstLast.indexOf("SEM-MID");
  const boundaryPos = firstLast.indexOf("SEM-BOUNDARY");
  evidence.topThreeSemanticSorted =
    highPos >= 0 && midPos >= 0 && boundaryPos >= 0 && highPos < midPos && midPos < boundaryPos;
  evidence.staleLastClearedSameSession = sameSession.output.includes("injected no memory");

  // After the empty-recall ordinary input, trailing /memory last + /memory status must add
  // exactly zero Recall routes (journal is append-only for this mock process).
  const emptyRecallIndexes = server.journal
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.route === "recall" &&
        Array.isArray(entry.bodySummary?.queryMarkers) &&
        entry.bodySummary.queryMarkers.includes("ACCEPT_EMPTY_RECALL"),
    )
    .map(({ index }) => index);
  assert(emptyRecallIndexes.length > 0, "expected ACCEPT_EMPTY_RECALL recall journal entries");
  const lastEmptyRecallIndex = Math.max(...emptyRecallIndexes);
  const recallsAfterEmpty = server.journal
    .slice(lastEmptyRecallIndex + 1)
    .filter((entry) => entry.route === "recall");
  evidence.commandsAddZeroRecall = recallsAfterEmpty.length === 0;

  // Isolated packaged scenario: non-default positive minScore 0.7.
  // Mock still returns below-threshold / null items; extension must reject them.
  await writeGlobalMemoryConfig(paths.agentDir, server.baseUrl, { minScore: 0.7 });
  server.setMode({ apiVersion: "0.10.0", includeRecallScores: true });
  server.setDocumentScores(bySnippet.high.bank_id, bySnippet.high.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.9,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.mid.bank_id, bySnippet.mid.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.8,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.boundary.bank_id, bySnippet.boundary.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.7,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.low.bank_id, bySnippet.low.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.69,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.nullish.bank_id, bySnippet.nullish.document_id, {
    final: 1,
    reranker: null,
    semantic: null,
    keyword: null,
  });
  const journalBeforeCustom = server.journal.length;
  const custom = await runPtySession(
    ["pi", ...baseArgs, "--name", "semantic-min-0.7"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      {
        input: "What are my SEM acceptance preferences?\r",
        expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}true`,
        timeoutMs: 9000,
      },
      { input: "/memory last\r", expect: "Last recall (3 item", timeoutMs: 8000 },
      { input: "/memory status\r", expect: "semantic >= 0.7", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    35000,
  );
  const customLast = extractLastRecallBlock(custom.output);
  const customLines = parseLastRecallItemLines(customLast);
  const customOrderOk =
    /Last recall \(3 item/.test(customLast) &&
    customLines.length === 3 &&
    customLines[0].includes("SEM-HIGH") &&
    customLines[0].includes("semantic=0.9") &&
    customLines[1].includes("SEM-MID") &&
    customLines[1].includes("semantic=0.8") &&
    customLines[2].includes("SEM-BOUNDARY") &&
    customLines[2].includes("semantic=0.7") &&
    !customLast.includes("SEM-LOW") &&
    !customLast.includes("SEM-NULL Prefer");
  evidence.customMinScore07Authoritative =
    recallBodiesHaveMinScore(server.journal.slice(journalBeforeCustom), 0.7) &&
    custom.output.includes("semantic >= 0.7") &&
    customOrderOk;

  // minScore: 0 — omit request threshold; prove exact top-3 order with null last when included.
  await writeGlobalMemoryConfig(paths.agentDir, server.baseUrl, { minScore: 0 });
  server.setDocumentScores(bySnippet.high.bank_id, bySnippet.high.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.9,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.mid.bank_id, bySnippet.mid.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.4,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.boundary.bank_id, bySnippet.boundary.document_id, {
    final: 1,
    reranker: null,
    semantic: null,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.low.bank_id, bySnippet.low.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.1,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.nullish.bank_id, bySnippet.nullish.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.05,
    keyword: null,
  });
  // With max 3 and scores 0.9, 0.4, null, 0.1, 0.05 → injected: HIGH, MID, LOW (null excluded by cap).
  // Strengthen null-last by using only three eligible finite+null: HIGH 0.9, MID 0.2, BOUNDARY null.
  server.setDocumentScores(bySnippet.low.bank_id, bySnippet.low.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.01,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.nullish.bank_id, bySnippet.nullish.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.005,
    keyword: null,
  });
  // Cap 3 from {0.9, 0.4, null, 0.01, 0.005} → 0.9, 0.4, 0.01 (null not included).
  // To include null last within the 3: use scores 0.9, null, 0.2 only by lowering others below?
  // Actually requirement: "ordered finite semantic descending with null last when included"
  // Seed three retained via filtering out extras with query? Simpler: set only three documents
  // to be the ones we care about by zeroing out extras via deleting isn't allowed.
  // Set low/nullish semantic very high? No.
  // Set: high=0.9, mid=0.2, boundary=null, low=0.05, nullish=0.04 → top3 = high, mid, low (null excluded)
  // Set: high=0.9, mid=0.2, boundary=null, and force low/nullish absent from recall via query marker.
  // Add ACCEPT_ONLY_TOP3_NULL marker that returns only documents matching SEM-HIGH|MID|BOUNDARY.
  // For simplicity without more mock changes: use scores high=0.9, mid=null, boundary=0.2, low=- wait null mid.
  // Order: high 0.9, boundary 0.2, mid null; low/nullish at 0.05/0.04 so cap keeps first three.
  server.setDocumentScores(bySnippet.high.bank_id, bySnippet.high.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.9,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.boundary.bank_id, bySnippet.boundary.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.2,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.mid.bank_id, bySnippet.mid.document_id, {
    final: 1,
    reranker: null,
    semantic: null,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.low.bank_id, bySnippet.low.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.05,
    keyword: null,
  });
  server.setDocumentScores(bySnippet.nullish.bank_id, bySnippet.nullish.document_id, {
    final: 1,
    reranker: null,
    semantic: 0.04,
    keyword: null,
  });
  // Sorted: high 0.9, boundary 0.2, low 0.05, nullish 0.04, mid null → top3: HIGH, BOUNDARY, LOW (null not in top3)
  // To get null in top3: mid null must rank before 4th. Null sorts last among all, so with 5 items
  // null is always 5th. So "null last when included" needs exactly <=3 items total eligible,
  // or only 3 returned by mock.
  // Use ACCEPT_EMPTY pattern inverted: add query filter ACCEPT_NULL_TOP3 that returns only high/mid/boundary.
  // Quick mock enhancement: if query includes ACCEPT_NULL_ORDER, filter to SEM-HIGH|SEM-MID|SEM-BOUNDARY texts.

  const journalBeforeZero = server.journal.length;
  // Temporarily adjust mock via query marker — implement filter in mock first if needed.
  // For now re-set so only three documents have content matching a unique tag and others
  // won't be in bank... Can't remove. Enhance mock:

  const zero = await runPtySession(
    ["pi", ...baseArgs, "--name", "semantic-zero"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      {
        input: "ACCEPT_NULL_ORDER What are my SEM acceptance preferences?\r",
        expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}true`,
        timeoutMs: 9000,
      },
      { input: "/memory last\r", expect: "Last recall (3 item", timeoutMs: 8000 },
      { input: "/memory status\r", expect: "threshold disabled", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    35000,
  );
  const zeroLast = extractLastRecallBlock(zero.output);
  const zeroLines = parseLastRecallItemLines(zeroLast);
  const zeroOrderOk =
    /Last recall \(3 item/.test(zeroLast) &&
    zeroLines.length === 3 &&
    zeroLines[0].includes("SEM-HIGH") &&
    zeroLines[0].includes("semantic=0.9") &&
    zeroLines[1].includes("SEM-BOUNDARY") &&
    zeroLines[1].includes("semantic=0.2") &&
    zeroLines[2].includes("SEM-MID") &&
    zeroLines[2].includes("semantic=null") &&
    !zeroLast.includes("SEM-LOW") &&
    !zeroLast.includes("SEM-NULL Prefer");
  evidence.zeroMinScoreExactTopThree =
    recallBodiesOmitMinScores(server.journal, journalBeforeZero) &&
    zero.output.includes("threshold disabled") &&
    zeroOrderOk;

  // Legacy 0.8.3: inject more than 3 (seed already has 5).
  server.setMode({ apiVersion: "0.8.3", includeRecallScores: false });
  await writeGlobalMemoryConfig(paths.agentDir, server.baseUrl, { minScore: 0.5 });
  const journalBeforeLegacy = server.journal.length;
  const legacy = await runPtySession(
    ["pi", ...baseArgs, "--name", "semantic-legacy"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      {
        input: "What are my SEM acceptance preferences?\r",
        expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}true`,
        timeoutMs: 9000,
      },
      { input: "/memory last\r", expect: "Last recall (5 item", timeoutMs: 8000 },
      { input: "/memory status\r", expect: "0.8.3", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    35000,
  );
  const legacyLast = extractLastRecallBlock(legacy.output);
  const legacyCount = parseLastRecallItemLines(legacyLast).length;
  evidence.legacy083InjectsMoreThanThree =
    recallBodiesOmitMinScores(server.journal, journalBeforeLegacy) &&
    legacy.output.includes("0.8.3") &&
    legacy.output.includes("legacy max 10") &&
    legacyCount > 3 &&
    legacyCount <= 10;

  const sessionFiles = [];
  async function walk(dir) {
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else if (name.endsWith(".jsonl")) sessionFiles.push(full);
    }
  }
  await walk(paths.sessionDir);
  let persistenceLeak = false;
  for (const file of sessionFiles) {
    const entries = parseSessionJsonl(await fs.readFile(file, "utf8"));
    const blob = JSON.stringify(entries);
    const hasRecallMessage = entries.some(
      (entry) =>
        entry?.type === "message" &&
        RECALL_HEADERS.some((header) => JSON.stringify(entry).includes(header)),
    );
    if (hasRecallMessage || blob.includes('"semantic":')) persistenceLeak = true;
  }
  const db = openMemories(paths.agentDir);
  const schemaSample = JSON.stringify(db.prepare("SELECT * FROM memories LIMIT 5").all());
  db.close();
  evidence.noSessionOrSqliteScorePersistence =
    !persistenceLeak && !schemaSample.includes("semantic") && !schemaSample.includes("minScore");

  const required = [
    "piVersionProven",
    "packedArtifactLoaded",
    "defaultMinScoreSendsThreshold",
    "clientSideThresholdEnforced",
    "inclusiveBoundaryRetained",
    "topThreeSemanticSorted",
    "staleLastClearedSameSession",
    "commandsAddZeroRecall",
    "customMinScore07Authoritative",
    "zeroMinScoreExactTopThree",
    "legacy083InjectsMoreThanThree",
    "noSessionOrSqliteScorePersistence",
  ];
  const failed = required.filter((key) => evidence[key] !== true);
  assert(failed.length === 0, `semantic acceptance failed: ${failed.join(", ")}`);
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`wrote evidence to ${EVIDENCE_PATH}`);
} catch (error) {
  await fs.writeFile(
    EVIDENCE_PATH,
    `${JSON.stringify({ ...evidence, error: String(error) }, null, 2)}\n`,
    "utf8",
  );
  throw error;
} finally {
  try {
    await server?.close();
  } finally {
    await cleanupIsolatedPaths(paths);
  }
}

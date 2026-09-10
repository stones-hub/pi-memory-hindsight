import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
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
const EVIDENCE_PATH = "/tmp/pi-memory-hindsight-acceptance-pi.json";
const FAILURE_TRANSCRIPT_LIMIT = 4000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listRelativeFiles(rootDir, relativeDir) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(path.join(rootDir, relativeDir));
  return files.sort();
}

async function readPackageManifest(packageDir) {
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
  const extensions = pkg?.pi?.extensions;
  assert(Array.isArray(extensions) && extensions.length > 0, "package pi.extensions missing");
  return { pkg, extensions };
}

async function verifyPackedExtension(packageDir, repoRoot) {
  const { extensions } = await readPackageManifest(packageDir);
  for (const rel of extensions) {
    const entryPath = path.join(packageDir, rel.replace(/^\.\//, ""));
    assert(await fs.stat(entryPath).then(() => true, () => false), `packed extension entry missing: ${rel}`);
  }
  const expectedSrc = await listRelativeFiles(repoRoot, "src");
  const packedSrc = await listRelativeFiles(packageDir, "src");
  assert(packedSrc.length > 0, "packed src directory missing");
  for (const rel of expectedSrc) {
    assert(packedSrc.includes(rel), `packed artifact missing src file: ${rel}`);
  }
  return {
    extensionManifestEntry: extensions[0],
    packedSourceFileCount: packedSrc.length,
  };
}

function redactText(value, paths) {
  if (!value) return "";
  let redacted = String(value);
  for (const candidate of [
    paths?.rootDir,
    paths?.homeDir,
    paths?.agentDir,
    paths?.sessionDir,
    paths?.projectDir,
    paths?.npmCacheDir,
    "acceptance-secret-token",
    "Bearer acceptance-secret-token",
    "authorization",
  ].filter(Boolean)) {
    redacted = redacted.split(candidate).join("<redacted>");
  }
  redacted = redacted.replace(RECALL_HEADER_RE, "<redacted-recall-header>");
  return redacted.slice(-FAILURE_TRANSCRIPT_LIMIT);
}

function ensureRequiredSuccess(evidence) {
  const required = [
    "packedArtifactLoaded",
    "commandsRegistered",
    "toolRegistered",
    "sessionStatePersisted",
    "candidateCreatedAndRejected",
    "explicitRememberRetained",
    "explicitUpdateReusedDocument",
    "recallInjectedWithoutPersistedRecallMessage",
    "forgetVerified",
    "memoryIdSurfaced",
    "memoryListShowWorked",
    "cleanupStatusWorked",
    "cleanupNowWorked",
    "memoryHelpWorked",
    "memoryHelpDidNotCreateSqlite",
    "providerOfflineDegraded",
    "printModeAutoNoop",
    "jsonModeAutoNoop",
    "rpcModeAutoNoop",
    "nonInteractiveAutoNoop",
    "journalSecretSafe",
  ];
  const failed = required.filter((key) => evidence[key] !== true);
  if (failed.length > 0 || evidence.pending.length > 0) {
    throw new Error(`acceptance failed: ${[...failed, ...evidence.pending.map((item) => `pending:${item}`)].join(", ")}`);
  }
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

async function runPtySession(argv, env, cwd, steps, timeoutMs = 12000) {
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

async function listSessionFiles(sessionDir) {
  const names = await fs.readdir(sessionDir);
  const files = [];
  for (const name of names) {
    const full = path.join(sessionDir, name);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      files.push(...(await listSessionFiles(full)));
    } else if (name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files.sort();
}

function readMaintenanceSuccessAt(agentDir) {
  const db = new DatabaseSync(path.join(agentDir, "memory", "pi-memory-hindsight.db"));
  const row = db.prepare("SELECT last_success_at FROM maintenance_state WHERE id = 1").get();
  db.close();
  return row?.last_success_at ?? null;
}

function readDb(agentDir) {
  const db = new DatabaseSync(path.join(agentDir, "memory", "pi-memory-hindsight.db"));
  return {
    db,
    candidate: db.prepare("SELECT id, state, text FROM candidates ORDER BY created_at DESC LIMIT 1").get(),
    memory: db.prepare("SELECT id, status, bank_id, document_id FROM memories ORDER BY created_at DESC LIMIT 1").get(),
    counts: {
      candidates: Number((db.prepare("SELECT COUNT(*) AS count FROM candidates").get() ?? { count: 0 }).count ?? 0),
      memories: Number((db.prepare("SELECT COUNT(*) AS count FROM memories").get() ?? { count: 0 }).count ?? 0),
    },
  };
}

async function waitForCandidateCount(agentDir, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = readDb(agentDir);
    const count = snapshot.counts.candidates;
    snapshot.db.close();
    if (count === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`candidate count did not reach ${expectedCount} within ${timeoutMs}ms`);
}

function countRoutes(journal, route) {
  return journal.filter((entry) => entry.route === route).length;
}

const HELP_GROUPS_EN = [
  "Help and status",
  "Session controls",
  "Formal memory creation, update, and deletion",
  "Memory discovery",
  "Candidate review",
  "Cleanup",
  "Language",
  "Reflection",
];

function mutationRouteCounts(journal) {
  return {
    retain: countRoutes(journal, "retain"),
    document_delete: countRoutes(journal, "document_delete"),
    recall: countRoutes(journal, "recall"),
    document_get: countRoutes(journal, "document_get"),
    list: countRoutes(journal, "list"),
  };
}

async function memorySqlitePresent(agentDir) {
  const dir = path.join(agentDir, "memory");
  try {
    const names = await fs.readdir(dir);
    return names.some((name) => name === "pi-memory-hindsight.db" || name.startsWith("pi-memory-hindsight.db"));
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseSessionJsonl(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sessionContainsRecall(entries) {
  for (const entry of entries) {
    if (entry.type === "custom_message" && typeof entry.content === "string" && RECALL_HEADER_RE.test(entry.content)) return true;
    if (entry.type === "message") {
      const message = entry.message;
      if (typeof message?.content === "string" && RECALL_HEADER_RE.test(message.content)) return true;
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (part?.type === "text" && typeof part.text === "string" && RECALL_HEADER_RE.test(part.text)) return true;
        }
      }
    }
  }
  return false;
}

// Drives Pi's RPC wire protocol correctly: sends a `prompt` command, waits for its
// `{"type":"response","command":"prompt","success":true}` acceptance and for `expectedMarker`
// to appear in the streamed events, then closes stdin so the RPC loop's own `stdin "end"`
// handler shuts the session down gracefully. Falls back to SIGTERM/SIGKILL if the process does
// not exit on its own. Closing stdin immediately after writing (the previous approach) races
// Pi's RPC mode, which treats stdin EOF as an immediate shutdown signal and can dispose the
// runtime before the async prompt finishes.
async function runRpcPrompt(env, cwd, args, message, expectedMarker, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const child = spawn("pi", args, { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let promptAccepted = false;
    let settled = false;

    const killHard = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };

    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killHard();
      reject(
        new Error(
          `rpc prompt "${message}" timed out after ${timeoutMs}ms waiting for marker "${expectedMarker}": stdout=${normalizeAnsi(stdout).slice(-2000)} stderr=${stderr.slice(-500)}`,
        ),
      );
    }, timeoutMs);

    function terminate() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      child.stdin?.end();
      const exitTimer = setTimeout(killHard, 3000);
      child.once("close", () => {
        clearTimeout(exitTimer);
        resolve(normalizeAnsi(stdout));
      });
    }

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      buffer += text;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "response" && event.command === "prompt" && event.id === requestId) {
          if (event.success !== true) {
            settled = true;
            clearTimeout(hardTimer);
            killHard();
            reject(new Error(`rpc prompt "${message}" rejected: ${event.error ?? "unknown"}`));
            return;
          }
          promptAccepted = true;
        }
      }
      if (promptAccepted && stdout.includes(expectedMarker)) terminate();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(err);
    });
    child.stdin?.write(`${JSON.stringify({ id: requestId, type: "prompt", message })}\n`);
  });
}

const paths = await createIsolatedPaths("pi-memory-hindsight-acceptance-");
const evidence = {
  packedArtifactLoaded: false,
  extensionManifestEntry: null,
  packedSourceFileCount: 0,
  commandsRegistered: false,
  toolRegistered: false,
  sessionStatePersisted: false,
  candidateCreatedAndRejected: false,
  explicitRememberRetained: false,
  explicitUpdateReusedDocument: false,
  recallInjectedWithoutPersistedRecallMessage: false,
  forgetVerified: false,
  memoryIdSurfaced: false,
  memoryListShowWorked: false,
  cleanupStatusWorked: false,
  cleanupNowWorked: false,
  memoryHelpWorked: false,
  memoryHelpDidNotCreateSqlite: false,
  providerOfflineDegraded: false,
  printModeAutoNoop: false,
  jsonModeAutoNoop: false,
  rpcModeAutoNoop: false,
  nonInteractiveAutoNoop: false,
  journalSecretSafe: false,
  pending: [],
  journal: [],
};

let server;
let helpOnlyPaths;
const failure = {};
try {
  const packDir = path.join(paths.rootDir, "pack");
  const tarball = await packInto(packDir);
  const unpacked = await unpackTarball(tarball, path.join(paths.rootDir, "unpacked"));
  const packed = await verifyPackedExtension(unpacked, ROOT);
  evidence.packedArtifactLoaded = true;
  evidence.extensionManifestEntry = packed.extensionManifestEntry;
  evidence.packedSourceFileCount = packed.packedSourceFileCount;

  await fs.writeFile(path.join(paths.projectDir, "README.md"), "acceptance fixture\n", "utf8");
  await writeProjectMemoryConfig(paths.projectDir, { enabled: true, project: "acceptance-project" });

  server = await startMockHindsightServer();
  await writeGlobalMemoryConfig(paths.agentDir, server.baseUrl);

  const env = buildIsolatedPiEnv(paths, {
    HINDSIGHT_API_KEY: "acceptance-secret-token",
  });
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

  const rpcCommandOutput = await runRpcPrompt(
    env,
    paths.projectDir,
    ["--mode", "rpc", "--no-session", ...baseArgs],
    "/accept-probe commands",
    ACCEPTANCE_MARKERS.commands,
  );
  evidence.commandsRegistered = rpcCommandOutput.includes("ACCEPT_PROBE commands=") && rpcCommandOutput.includes("memory");
  const rpcToolOutput = await runRpcPrompt(
    env,
    paths.projectDir,
    ["--mode", "rpc", "--no-session", ...baseArgs],
    "/accept-probe tools",
    ACCEPTANCE_MARKERS.tools,
  );
  evidence.toolRegistered = rpcToolOutput.includes("memory_remember");

  helpOnlyPaths = await createIsolatedPaths("pi-memory-hindsight-acceptance-help-");
  await writeGlobalMemoryConfig(helpOnlyPaths.agentDir, server.baseUrl);
  const helpOnlyEnv = buildIsolatedPiEnv(helpOnlyPaths, {
    HINDSIGHT_API_KEY: "acceptance-secret-token",
  });
  const helpOnlyArgs = [
    "--offline",
    "--approve",
    "--session-dir",
    helpOnlyPaths.sessionDir,
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
  assert(
    (await memorySqlitePresent(helpOnlyPaths.agentDir)) === false,
    "fresh help-only agent dir already had a memory SQLite file",
  );
  const helpOnlySession = await runPtySession(
    ["pi", ...helpOnlyArgs, "--name", "acceptance-help-fresh"],
    helpOnlyEnv,
    helpOnlyPaths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory help\r", expect: "Help and status", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    16000,
  );
  failure.helpOnlySession = redactText(helpOnlySession.output, helpOnlyPaths);
  evidence.memoryHelpDidNotCreateSqlite =
    helpOnlySession.output.includes("Help and status") &&
    (await memorySqlitePresent(helpOnlyPaths.agentDir)) === false;
  assert(evidence.memoryHelpDidNotCreateSqlite, "fresh /memory help created SQLite or a Profile");

  const firstSession = await runPtySession(
    ["pi", ...baseArgs],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory off\r", waitBeforeMs: 600 },
      { input: "/memory on\r", waitBeforeMs: 600 },
      { input: "/accept-probe session-stats\r", expect: `${ACCEPTANCE_MARKERS.sessionStats}2`, timeoutMs: 6000 },
      { input: "/accept-probe entries\r", expect: "pi-memory-hindsight:session-state", timeoutMs: 6000 },
      {
        input: "/memory remember profile preference Prefer concise answers.\r",
        expect: "id=",
        timeoutMs: 10_000,
      },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    16000,
  );
  failure.firstSession = redactText(firstSession.output, paths);
  evidence.sessionStatePersisted =
    firstSession.output.includes(`${ACCEPTANCE_MARKERS.sessionStats}2`) &&
    firstSession.output.includes("pi-memory-hindsight:session-state");
  evidence.explicitRememberRetained = countRoutes(server.journal, "retain") >= 1;

  const afterRemember = readDb(paths.agentDir);
  const rememberedRow = afterRemember.db
    .prepare("SELECT id, document_id, text_hash FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get();
  const helpCountsBefore = { ...afterRemember.counts };
  afterRemember.db.close();
  const beforeHelpRoutes = mutationRouteCounts(server.journal);
  const helpSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-help"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/memory help\r", expect: "Help and status", timeoutMs: 8000 },
      { input: "/memory\r", expect: "Candidate review", timeoutMs: 8000 },
      { input: "/memory help extra\r", expect: "There is no /memory extract command", timeoutMs: 8000 },
      { input: "/memory language zh\r", expect: "语言已设置为 zh。", timeoutMs: 6000 },
      { input: "/memory help\r", expect: "帮助与状态", timeoutMs: 8000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 6000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    45000,
  );
  failure.helpSession = redactText(helpSession.output, paths);
  const afterHelpRoutes = mutationRouteCounts(server.journal);
  const helpDbAfter = readDb(paths.agentDir);
  const helpCountsAfter = { ...helpDbAfter.counts };
  helpDbAfter.db.close();
  evidence.memoryHelpWorked =
    HELP_GROUPS_EN.every((group) => helpSession.output.includes(group)) &&
    helpSession.output.includes("There is no /memory extract command") &&
    helpSession.output.includes("帮助与状态") &&
    helpSession.output.includes("preference|habit") &&
    helpSession.output.includes("project_fact|decision|lesson|task_state|inference") &&
    helpSession.output.includes("/memory remember <scope> <type> <content>") &&
    helpSession.output.includes("/memory reflect profile <query>") &&
    helpSession.output.includes("/memory reflect project <query>") &&
    JSON.stringify(beforeHelpRoutes) === JSON.stringify(afterHelpRoutes) &&
    helpCountsAfter.candidates === helpCountsBefore.candidates &&
    helpCountsAfter.memories === helpCountsBefore.memories;
  assert(evidence.memoryHelpWorked, "packaged /memory help did not prove detailed read-only help");
  const updatedPreviewMarker = "short summaries";
  const surfacedIdMatch = firstSession.output.match(/id=([0-9a-f-]{36})/i);
  const surfacedId = surfacedIdMatch?.[1] ?? null;
  evidence.memoryIdSurfaced =
    Boolean(rememberedRow?.id) && Boolean(surfacedId) && surfacedId === rememberedRow.id;
  if (rememberedRow?.id) {
    const updateSession = await runPtySession(
      ["pi", ...baseArgs, "--name", "acceptance-update"],
      env,
      paths.projectDir,
      [
        { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
        { input: `/memory update ${rememberedRow.id} Prefer concise answers and short summaries.\r`, waitBeforeMs: 1200 },
        { input: "/quit\r", timeoutMs: 6000 },
      ],
      12000,
    );
    failure.updateSession = redactText(updateSession.output, paths);
    const afterUpdate = readDb(paths.agentDir);
    const updatedRow = afterUpdate.db
      .prepare("SELECT id, document_id, text_hash FROM memories WHERE id = ?")
      .get(rememberedRow.id);
    afterUpdate.db.close();
    evidence.explicitUpdateReusedDocument =
      Boolean(updatedRow) &&
      updatedRow.document_id === rememberedRow.document_id &&
      updatedRow.text_hash !== rememberedRow.text_hash &&
      countRoutes(server.journal, "retain") >= 2 &&
      updateSession.output.includes(rememberedRow.id);

    const beforeDiscoveryRetain = countRoutes(server.journal, "retain");
    const beforeDiscoveryDelete = countRoutes(server.journal, "delete");
    const beforeDiscoveryDocGet = countRoutes(server.journal, "document_get");
    const beforeDiscoveryList = countRoutes(server.journal, "list");
    const maintenanceBefore = readMaintenanceSuccessAt(paths.agentDir);
    const discoverySession = await runPtySession(
      ["pi", ...baseArgs, "--name", "acceptance-discovery"],
      env,
      paths.projectDir,
      [
        { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
        { input: "/memory list profile\r", expect: rememberedRow.id, timeoutMs: 8000 },
        { input: `/memory show ${rememberedRow.id}\r`, expect: "content:", timeoutMs: 8000 },
        { input: "/memory cleanup status\r", expect: "last_success_at:", timeoutMs: 7000 },
        { input: "/memory cleanup now\r", expect: "Memory Cleanup", timeoutMs: 8000 },
        { input: "\r", waitBeforeMs: 400, expect: "Cleanup finished", timeoutMs: 25000 },
        { input: "/quit\r", timeoutMs: 6000 },
      ],
      45000,
    );
    failure.discoverySession = redactText(discoverySession.output, paths);
    const afterDiscoveryRetain = countRoutes(server.journal, "retain");
    const afterDiscoveryDelete = countRoutes(server.journal, "delete");
    const afterDiscoveryDocGet = countRoutes(server.journal, "document_get");
    const afterDiscoveryList = countRoutes(server.journal, "list");
    const maintenanceAfter = readMaintenanceSuccessAt(paths.agentDir);
    evidence.memoryListShowWorked =
      discoverySession.output.includes(rememberedRow.id) &&
      discoverySession.output.includes(updatedPreviewMarker) &&
      afterDiscoveryDocGet > beforeDiscoveryDocGet &&
      afterDiscoveryList > beforeDiscoveryList;
    assert(
      afterDiscoveryDocGet > beforeDiscoveryDocGet,
      `list/show must use exact document GET: before=${beforeDiscoveryDocGet} after=${afterDiscoveryDocGet}`,
    );
    assert(
      afterDiscoveryList > beforeDiscoveryList,
      `list/show must use exact list-by-document: before=${beforeDiscoveryList} after=${afterDiscoveryList}`,
    );
    evidence.cleanupStatusWorked =
      discoverySession.output.includes("last_success_at:") &&
      discoverySession.output.includes("automatic_due:");
    evidence.cleanupNowWorked =
      discoverySession.output.includes("Cleanup finished") &&
      Boolean(maintenanceAfter) &&
      maintenanceAfter !== maintenanceBefore;
    assert(
      afterDiscoveryRetain === beforeDiscoveryRetain,
      `list/show/status must not retain: before=${beforeDiscoveryRetain} after=${afterDiscoveryRetain}`,
    );
    const activeAfterDiscovery = readDb(paths.agentDir);
    const stillActive = activeAfterDiscovery.db
      .prepare("SELECT status FROM memories WHERE id = ?")
      .get(rememberedRow.id);
    activeAfterDiscovery.db.close();
    assert(stillActive?.status === "active", "discovery/cleanup must not delete the active remembered memory");
  } else {
    evidence.explicitUpdateReusedDocument = false;
    evidence.memoryListShowWorked = false;
    evidence.cleanupStatusWorked = false;
    evidence.cleanupNowWorked = false;
  }

  const beforeRecallFiles = new Set(await listSessionFiles(paths.sessionDir));
  const beforeRecallRouteCount = countRoutes(server.journal, "recall");
  const recallSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-recall"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "first warmup question\r", expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}false`, timeoutMs: 7000 },
      { input: "What should I remember?\r", expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}true`, timeoutMs: 7000 },
      { input: "/accept-probe recall\r", expect: `${ACCEPTANCE_MARKERS.recall}true`, timeoutMs: 7000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    18000,
  );
  failure.recallSession = redactText(recallSession.output, paths);
  const afterRecallRouteCount = countRoutes(server.journal, "recall");
  assert(afterRecallRouteCount - beforeRecallRouteCount === 1, "expected exactly one recall route for the recalled turn");
  const afterRecallFiles = await listSessionFiles(paths.sessionDir);
  const newRecallFiles = afterRecallFiles.filter((file) => !beforeRecallFiles.has(file));
  assert(newRecallFiles.length === 1, "expected exactly one new session file for named recall run");
  const recallEntries = parseSessionJsonl(await fs.readFile(newRecallFiles[0], "utf8"));
  evidence.recallInjectedWithoutPersistedRecallMessage =
    recallSession.output.includes(`${ACCEPTANCE_MARKERS.promptRecallSeen}true`) &&
    recallSession.output.includes(`${ACCEPTANCE_MARKERS.recall}true`) &&
    sessionContainsRecall(recallEntries) === false;

  const candidateCreation = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-candidate"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "candidate warmup turn\r", expect: `${ACCEPTANCE_MARKERS.promptRecallSeen}false`, timeoutMs: 7000 },
      { input: "please remember this durable preference for future chats\r", expect: ACCEPTANCE_MARKERS.promptRecallSeen, timeoutMs: 7000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    15000,
  );
  failure.candidateCreation = redactText(candidateCreation.output, paths);
  await waitForCandidateCount(paths.agentDir, 1, 8000);

  const candidateProbeSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-candidate-probe"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/accept-probe candidate-stats\r", expect: `${ACCEPTANCE_MARKERS.candidateStats}1`, timeoutMs: 7000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    15000,
  );
  failure.candidateProbeSession = redactText(candidateProbeSession.output, paths);
  const { candidate, db } = readDb(paths.agentDir);
  assert(candidate?.id, "expected exactly one extracted candidate after settled turn");
  const candidateSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-candidate-review"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory candidates list\r", waitBeforeMs: 1200 },
      { input: `/memory candidates reject ${candidate.id}\r`, waitBeforeMs: 1200 },
      // Wait on "latest_state=rejected" alone, not the full "latest_id=...
      // latest_state=rejected" string: the probe line reliably wraps at the
      // terminal width between the 36-char candidate UUID and " latest_state="
      // (confirmed in captured transcripts), so a concatenated expect string
      // spanning that wrap point can never match.
      { input: "/accept-probe candidate-stats\r", expect: "latest_state=rejected", timeoutMs: 6000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    18000,
  );
  failure.candidateSession = redactText(candidateSession.output, paths);
  const rejected = db.prepare("SELECT state FROM candidates WHERE id = ?").get(candidate.id);
  evidence.candidateCreatedAndRejected = candidateSession.output.includes(candidate.id) && rejected?.state === "rejected";

  const memoryRow = db.prepare("SELECT id, status FROM memories ORDER BY created_at DESC LIMIT 1").get();
  assert(memoryRow?.id, "expected remembered memory row");
  const forgetSession = await runPtySession(
    ["pi", ...baseArgs, "--name", "acceptance-forget"],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: `/memory forget ${memoryRow.id}\r`, waitBeforeMs: 1200 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    16000,
  );
  failure.forgetSession = redactText(forgetSession.output, paths);
  const forgotten = db.prepare("SELECT status FROM memories WHERE id = ?").get(memoryRow.id);
  evidence.forgetVerified = forgotten?.status === "deleted";
  db.close();

  server.setMode({ fail: { health: 503 } });
  const degraded = await runPtySession(
    ["pi", ...baseArgs],
    env,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory status\r", expect: "unavailable", timeoutMs: 6000 },
      { input: "/memory help\r", expect: "Help and status", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    16000,
  );
  failure.degraded = redactText(degraded.output, paths);
  evidence.providerOfflineDegraded = degraded.output.toLowerCase().includes("unavailable");
  evidence.memoryHelpWorked =
    evidence.memoryHelpWorked === true && degraded.output.includes("Help and status");
  assert(evidence.memoryHelpWorked, "help must still render when Hindsight is unavailable");
  server.setMode({});

  const beforePrint = { recall: countRoutes(server.journal, "recall"), retain: countRoutes(server.journal, "retain") };
  const printDbBefore = readDb(paths.agentDir);
  printDbBefore.db.close();
  const printResult = await runChild("pi", ["-p", ...baseArgs, "What should I remember?"], {
    cwd: paths.projectDir,
    env,
    timeoutMs: 7000,
  });
  failure.print = redactText(`${printResult.stdout}\n${printResult.stderr}`, paths);
  const printDbAfter = readDb(paths.agentDir);
  evidence.printModeAutoNoop =
    normalizeAnsi(printResult.stdout).includes(ACCEPTANCE_MARKERS.printNoRecall) &&
    countRoutes(server.journal, "recall") === beforePrint.recall &&
    countRoutes(server.journal, "retain") === beforePrint.retain &&
    printDbAfter.counts.candidates === printDbBefore.counts.candidates &&
    printDbAfter.counts.memories === printDbBefore.counts.memories;
  printDbAfter.db.close();

  const beforeJson = { recall: countRoutes(server.journal, "recall"), retain: countRoutes(server.journal, "retain") };
  const jsonDbBefore = readDb(paths.agentDir);
  jsonDbBefore.db.close();
  const jsonResult = await runChild("pi", ["--mode", "json", ...baseArgs, "What should I remember?"], {
    cwd: paths.projectDir,
    env,
    timeoutMs: 7000,
  });
  failure.json = redactText(`${jsonResult.stdout}\n${jsonResult.stderr}`, paths);
  const jsonDbAfter = readDb(paths.agentDir);
  evidence.jsonModeAutoNoop =
    normalizeAnsi(jsonResult.stdout).includes(ACCEPTANCE_MARKERS.printNoRecall) &&
    countRoutes(server.journal, "recall") === beforeJson.recall &&
    countRoutes(server.journal, "retain") === beforeJson.retain &&
    jsonDbAfter.counts.candidates === jsonDbBefore.counts.candidates &&
    jsonDbAfter.counts.memories === jsonDbBefore.counts.memories;
  jsonDbAfter.db.close();

  const beforeRpc = { recall: countRoutes(server.journal, "recall"), retain: countRoutes(server.journal, "retain") };
  const rpcDbBefore = readDb(paths.agentDir);
  rpcDbBefore.db.close();
  const rpcOutput = await runRpcPrompt(
    env,
    paths.projectDir,
    ["--mode", "rpc", "--no-session", ...baseArgs],
    "What should I remember?",
    ACCEPTANCE_MARKERS.printNoRecall,
  );
  failure.rpc = redactText(rpcOutput, paths);
  const rpcDbAfter = readDb(paths.agentDir);
  evidence.rpcModeAutoNoop =
    rpcOutput.includes(ACCEPTANCE_MARKERS.printNoRecall) &&
    countRoutes(server.journal, "recall") === beforeRpc.recall &&
    countRoutes(server.journal, "retain") === beforeRpc.retain &&
    rpcDbAfter.counts.candidates === rpcDbBefore.counts.candidates &&
    rpcDbAfter.counts.memories === rpcDbBefore.counts.memories;
  rpcDbAfter.db.close();
  evidence.nonInteractiveAutoNoop = evidence.printModeAutoNoop && evidence.jsonModeAutoNoop && evidence.rpcModeAutoNoop;

  evidence.journal = server.journal.map((entry) => ({
    method: entry.method,
    path: entry.path,
    route: entry.route,
    authPresent: entry.authPresent,
    bodySummary: entry.bodySummary,
  }));
  const serialized = JSON.stringify(evidence.journal);
  evidence.journalSecretSafe =
    serialized.includes('"authPresent":true') &&
    !serialized.includes("acceptance-secret-token") &&
    !serialized.includes("Prefer concise answers.") &&
    !RECALL_HEADERS.some((header) => serialized.includes(header));

  ensureRequiredSuccess(evidence);
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`wrote evidence to ${EVIDENCE_PATH}`);
} catch (error) {
  const failureEvidence = {
    ...evidence,
    pending: evidence.pending,
    error: String(error),
    failure,
  };
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(failureEvidence, null, 2)}\n`, "utf8");
  throw error;
} finally {
  try {
    await server?.close();
  } finally {
    await cleanupIsolatedPaths(paths);
    if (helpOnlyPaths) await cleanupIsolatedPaths(helpOnlyPaths);
  }
}

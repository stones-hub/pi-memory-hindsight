import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import {
  buildIsolatedPiEnv,
  cleanupIsolatedPaths,
  createIsolatedPaths,
  runChild,
} from "../dist/testing/acceptance-helpers.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PY_DRIVER = path.join(ROOT, "scripts", "pi_pty_driver.py");
const FAKE_PROVIDER = path.join(ROOT, "tests", "e2e-harness", "fake-provider.ts");
const EVIDENCE_PATH = "/tmp/pi-memory-hindsight-git-install-acceptance.json";
const GIT_REPO_NAMESPACE = "stones-hub";
const GIT_REPO_NAME = "pi-memory-hindsight.git";
const LOWER_PRIORITY_USER_ALLOW_SCRIPTS = "allow-scripts=@anthropic-ai/claude-code";
const EXPECTED_LICENSE_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";
const INSTALL_TIMEOUT_MS = 120_000;

const PUBLISHABLE_TOP_LEVEL = ["package.json", "README.md", "LICENSE", "tsconfig.json"];
const PUBLISHABLE_DIRS = ["src", "docs"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDenyOnlyAllowScriptsPolicy(allowScripts) {
  if (!allowScripts || typeof allowScripts !== "object" || Array.isArray(allowScripts)) return false;
  const entries = Object.entries(allowScripts);
  return entries.length > 0 && entries.every(([, allowed]) => allowed === false);
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function copyPublishableTree(destDir) {
  await fs.mkdir(destDir, { recursive: true });
  for (const name of PUBLISHABLE_TOP_LEVEL) {
    await fs.copyFile(path.join(ROOT, name), path.join(destDir, name));
  }
  for (const name of PUBLISHABLE_DIRS) {
    await fs.cp(path.join(ROOT, name), path.join(destDir, name), { recursive: true });
  }
}

async function verifyLicenseFile(filePath) {
  const sha = await sha256File(filePath);
  assert(sha === EXPECTED_LICENSE_SHA256, `LICENSE SHA mismatch at ${filePath}: ${sha}`);
  return sha;
}

async function verifyPackedLicense(stagedDir, packDest) {
  await fs.mkdir(packDest, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDest],
    {
      cwd: stagedDir,
      env: {
        ...process.env,
        NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      },
    },
  );
  const parsed = JSON.parse(stdout);
  const filename = parsed[0]?.filename;
  assert(typeof filename === "string", "npm pack did not produce a tarball filename");
  const tarball = path.join(packDest, filename);
  const { stdout: listed } = await execFileAsync("tar", ["-tzf", tarball], { cwd: packDest });
  assert(listed.split("\n").some((entry) => entry === "package/LICENSE"), "packed tarball missing package/LICENSE");
  const { stdout: licenseText } = await execFileAsync("tar", ["-xOzf", tarball, "package/LICENSE"], { cwd: packDest });
  const packedSha = createHash("sha256").update(licenseText).digest("hex");
  assert(packedSha === EXPECTED_LICENSE_SHA256, `packed LICENSE SHA mismatch: ${packedSha}`);
  await fs.rm(tarball, { force: true });
  return packedSha;
}

async function runGit(cwd, args, env) {
  const result = await runChild("git", args, { cwd, env, timeoutMs: 30_000 });
  assert(result.exitCode === 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("failed to allocate loopback port"));
        else resolve(port);
      });
    });
  });
}

async function waitForDaemon(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(500);
        socket.on("timeout", () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`git daemon did not accept connections on 127.0.0.1:${port}`);
}

function startGitDaemon(basePath, port, env) {
  const child = spawn(
    "git",
    ["daemon", "--export-all", "--reuseaddr", `--base-path=${basePath}`, "--listen=127.0.0.1", `--port=${port}`],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("error", () => {});
  return child;
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore races during teardown
      }
      resolve();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode !== null && child.exitCode !== 0 && child.signal !== "SIGTERM" && child.signal !== "SIGKILL") {
    throw new Error(`${label} exited with code ${child.exitCode}`);
  }
}

async function runPtySession(argv, env, cwd, steps, timeoutMs = 12_000) {
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
    assert(parsed.driverExitCode === 0, `PTY expectation failure: ${JSON.stringify(parsed)}`);
    assert(parsed.processExitCode === 0, `Pi exited non-zero: ${JSON.stringify(parsed)}`);
    return parsed;
  } finally {
    await fs.rm(specPath, { force: true });
  }
}

const paths = await createIsolatedPaths("pi-memory-hindsight-git-install-");
const evidence = {
  stagedCommitCreated: false,
  gitDaemonStarted: false,
  lowerPriorityUserNpmrcAllowScriptsPresent: false,
  packageDenyOnlyAllowScripts: false,
  packageLicenseField: null,
  licenseFileSha256: null,
  stagedLicenseMatchesRemote: false,
  packedLicenseIncluded: false,
  npmInstallCompleted: false,
  piInstallCompleted: false,
  memoryCommandLoaded: false,
  installSource: null,
  settingsPackageSource: null,
  installedCloneRelativePath: null,
  extensionManifestEntry: null,
  distNotRequired: false,
  limitation:
    "Loopback git daemon only (127.0.0.1); no remote GitHub/network/credentials. Pi 0.85.1 cannot parse raw git:// URLs because git: prefix stripping treats git:// as prefixed; acceptance uses Pi shorthand git:127.0.0.1:<port>/stones-hub/pi-memory-hindsight.git. Pi clones via https://127.0.0.1:<port>/... internally, so isolated GIT_CONFIG_GLOBAL rewrites that to git:// for the daemon. True pi install runs npm install --omit=dev in the cloned package. Harness injects a lower-priority user ~/.npmrc allow-scripts entry and neutralizes host global npmrc plus npm_config_allow_scripts env so the run exercises normal project-scoped install with this package's deny-only allowScripts policy; npm intentionally rejects CLI/env allow-scripts during project installs, which this acceptance does not model.",
};

let daemonChild = null;
let port = null;

try {
  const staged = path.join(paths.rootDir, "staged");
  const daemonBase = path.join(paths.rootDir, "daemon-repos");
  const bareRepoDir = path.join(daemonBase, GIT_REPO_NAMESPACE, GIT_REPO_NAME);
  await copyPublishableTree(staged);

  const pkg = JSON.parse(await fs.readFile(path.join(staged, "package.json"), "utf8"));
  evidence.extensionManifestEntry = pkg.pi?.extensions?.[0] ?? null;
  evidence.packageLicenseField = pkg.license ?? null;
  evidence.packageDenyOnlyAllowScripts = isDenyOnlyAllowScriptsPolicy(pkg.allowScripts);
  assert(evidence.extensionManifestEntry === "./src/index.ts", "expected git package to load ./src/index.ts");
  assert(evidence.packageLicenseField === "Apache-2.0", "expected staged package license Apache-2.0");
  assert(evidence.packageDenyOnlyAllowScripts, "expected deny-only allowScripts policy in staged package.json");

  evidence.licenseFileSha256 = await verifyLicenseFile(path.join(staged, "LICENSE"));
  evidence.stagedLicenseMatchesRemote = evidence.licenseFileSha256 === EXPECTED_LICENSE_SHA256;
  evidence.packedLicenseIncluded =
    (await verifyPackedLicense(staged, path.join(paths.rootDir, "pack"))) === EXPECTED_LICENSE_SHA256;

  const gitEnv = {
    ...process.env,
    HOME: paths.homeDir,
    GIT_CONFIG_GLOBAL: path.join(paths.homeDir, ".gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "acceptance",
    GIT_AUTHOR_EMAIL: "acceptance@example.com",
    GIT_COMMITTER_NAME: "acceptance",
    GIT_COMMITTER_EMAIL: "acceptance@example.com",
  };
  await runGit(staged, ["init"], gitEnv);
  await runGit(staged, ["add", "."], gitEnv);
  await runGit(staged, ["commit", "-m", "git-install acceptance fixture"], gitEnv);
  evidence.stagedCommitCreated = true;

  await fs.mkdir(path.dirname(bareRepoDir), { recursive: true });
  await runGit(path.dirname(bareRepoDir), ["clone", "--bare", staged, bareRepoDir], gitEnv);

  port = await allocateLoopbackPort();
  daemonChild = startGitDaemon(daemonBase, port, gitEnv);
  await waitForDaemon(port);
  evidence.gitDaemonStarted = true;

  const gitConfigPath = path.join(paths.homeDir, ".gitconfig");
  await fs.writeFile(
    gitConfigPath,
    `[url "git://127.0.0.1:${port}/"]\n\tinsteadOf = https://127.0.0.1:${port}/\n`,
    "utf8",
  );

  const userNpmrcPath = path.join(paths.homeDir, ".npmrc");
  await fs.writeFile(userNpmrcPath, `${LOWER_PRIORITY_USER_ALLOW_SCRIPTS}\n`, "utf8");
  const userNpmrc = await fs.readFile(userNpmrcPath, "utf8");
  evidence.lowerPriorityUserNpmrcAllowScriptsPresent = userNpmrc.includes(LOWER_PRIORITY_USER_ALLOW_SCRIPTS);
  assert(evidence.lowerPriorityUserNpmrcAllowScriptsPresent, "failed to stage lower-priority user allow-scripts .npmrc");

  const installSource = `git:127.0.0.1:${port}/${GIT_REPO_NAMESPACE}/${GIT_REPO_NAME}`;
  evidence.installSource = installSource;

  const piEnv = buildIsolatedPiEnv(paths, {
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
  });
  for (const key of Object.keys(piEnv)) {
    if (key.toLowerCase() === "npm_config_allow_scripts" || key.toLowerCase() === "npm_config_allow_scripts_pending") {
      delete piEnv[key];
    }
  }

  const install = await runChild("pi", ["install", installSource], {
    cwd: paths.projectDir,
    env: piEnv,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const installOutput = `${install.stdout}\n${install.stderr}`;
  assert(install.exitCode === 0, `pi install failed: ${installOutput}`);
  assert(!installOutput.includes("EALLOWSCRIPTS"), `pi install hit npm EALLOWSCRIPTS: ${installOutput}`);
  evidence.piInstallCompleted = true;

  const settings = JSON.parse(await fs.readFile(path.join(paths.agentDir, "settings.json"), "utf8"));
  assert(Array.isArray(settings.packages) && settings.packages.length > 0, "settings packages missing after pi install");
  evidence.settingsPackageSource = settings.packages[0];

  const installedClonePath = path.join(
    paths.agentDir,
    "git",
    `127.0.0.1:${port}`,
    GIT_REPO_NAMESPACE,
    GIT_REPO_NAME.replace(/\.git$/, ""),
  );
  evidence.installedCloneRelativePath = path.relative(paths.agentDir, installedClonePath);
  assert(
    await fs.stat(installedClonePath).then(() => true, () => false),
    `installed git clone missing: ${installedClonePath}`,
  );
  assert(
    await fs.stat(path.join(installedClonePath, "src", "index.ts")).then(() => true, () => false),
    "installed clone missing src/index.ts",
  );
  assert(
    await fs.stat(path.join(installedClonePath, "LICENSE")).then(() => true, () => false),
    "installed clone missing LICENSE",
  );
  await verifyLicenseFile(path.join(installedClonePath, "LICENSE"));
  evidence.distNotRequired = !(await fs.stat(path.join(installedClonePath, "dist")).then(() => true, () => false));

  const installedPkg = JSON.parse(await fs.readFile(path.join(installedClonePath, "package.json"), "utf8"));
  assert(installedPkg.license === "Apache-2.0", "installed clone package.json license must be Apache-2.0");
  assert(
    isDenyOnlyAllowScriptsPolicy(installedPkg.allowScripts),
    "installed clone must retain deny-only allowScripts policy",
  );

  const npmInstallProbe = await runChild("npm", ["install", "--omit=dev"], {
    cwd: installedClonePath,
    env: piEnv,
    timeoutMs: 60_000,
  });
  const npmInstallOutput = `${npmInstallProbe.stdout}\n${npmInstallProbe.stderr}`;
  assert(npmInstallProbe.exitCode === 0, `npm install --omit=dev failed in installed clone: ${npmInstallOutput}`);
  assert(!npmInstallOutput.includes("EALLOWSCRIPTS"), `npm install hit EALLOWSCRIPTS: ${npmInstallOutput}`);
  evidence.npmInstallCompleted = true;

  const ptyArgs = [
    "pi",
    "--offline",
    "--approve",
    "--session-dir",
    paths.sessionDir,
    "-e",
    FAKE_PROVIDER,
    "--provider",
    "acceptance-local",
    "--model",
    "acceptance-local-model",
  ];
  const ptySession = await runPtySession(
    ptyArgs,
    piEnv,
    paths.projectDir,
    [
      { input: "\r", expect: "Press ctrl+o", timeoutMs: 7000 },
      { input: "/memory language en\r", expect: "Language set to en.", timeoutMs: 8000 },
      { input: "/quit\r", timeoutMs: 6000 },
    ],
    18_000,
  );
  evidence.memoryCommandLoaded = ptySession.output.includes("Language set to en.");

  assert(evidence.memoryCommandLoaded, "installed git package did not register /memory command without -e <package>");

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
  if (daemonChild) {
    await stopChild(daemonChild, "git daemon");
  }
  await cleanupIsolatedPaths(paths);
}

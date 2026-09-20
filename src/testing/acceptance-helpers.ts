import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { projectBankId } from "../identity/bank-id.js";

export interface IsolatedPaths {
  rootDir: string;
  homeDir: string;
  agentDir: string;
  sessionDir: string;
  projectDir: string;
  npmCacheDir: string;
}

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function normalizeAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+$/gm, "")
    .trim();
}

export function hashPathLabel(value: string): string {
  return path.basename(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function isLoopbackHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function deriveDisposableLiveBankId(nonce: string): string {
  const trimmed = nonce.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{7,64}$/.test(trimmed)) {
    throw new Error("live acceptance nonce must be 8-65 chars of lowercase letters, digits, or hyphen");
  }
  return projectBankId(`live-acceptance-${trimmed}`);
}

export async function createIsolatedPaths(prefix: string): Promise<IsolatedPaths> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(rootDir, "home");
  const agentDir = path.join(rootDir, "agent");
  const sessionDir = path.join(rootDir, "sessions");
  const projectDir = path.join(rootDir, "project");
  const npmCacheDir = path.join(rootDir, "npm-cache");
  await Promise.all([homeDir, agentDir, sessionDir, projectDir, npmCacheDir].map((dir) => mkdir(dir, { recursive: true })));
  return { rootDir, homeDir, agentDir, sessionDir, projectDir, npmCacheDir };
}

export async function cleanupIsolatedPaths(paths: IsolatedPaths): Promise<void> {
  await rm(paths.rootDir, { recursive: true, force: true });
}

export async function writeProjectMemoryConfig(projectDir: string, config: { enabled: boolean; project?: string }): Promise<void> {
  const piDir = path.join(projectDir, ".pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(path.join(piDir, "memory.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function writeGlobalMemoryConfig(
  agentDir: string,
  url: string,
  options?: { minScore?: number },
): Promise<void> {
  const body: { url: string; minScore?: number } = { url };
  if (options?.minScore !== undefined) {
    body.minScore = options.minScore;
  }
  await writeFile(path.join(agentDir, "memory-hindsight.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function buildIsolatedPiEnv(paths: IsolatedPaths, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.homeDir,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    npm_config_cache: paths.npmCacheDir,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    ...extraEnv,
  };
}

export async function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });
    collectChild(child, options.timeoutMs, options.input, resolve, reject);
  });
}

function collectChild(
  child: ChildProcess,
  timeoutMs: number,
  input: string | undefined,
  resolve: (result: ChildResult) => void,
  reject: (error: Error) => void,
): void {
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000).unref();
  }, timeoutMs);
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (exitCode, signal) => {
    clearTimeout(timer);
    resolve({ exitCode, signal, stdout, stderr });
  });
  // Always end stdin, even with no input: pi's non-interactive print/json
  // modes block reading stdin (to support piped context) until EOF, so an
  // unclosed pipe hangs the child forever until the timeout kills it.
  child.stdin?.end(input ?? "");
}

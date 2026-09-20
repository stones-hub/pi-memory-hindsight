/**
 * Global extension configuration.
 *
 * Location: `<agent-dir>/memory-hindsight.json`.
 * Contract: the file may contain only `url` and optional `minScore`.
 * Credentials are never read from this file — only from `HINDSIGHT_API_KEY`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface GlobalConfig {
  /** Hindsight HTTP API base URL, e.g. "http://127.0.0.1:8888". */
  url: string;
  /**
   * Minimum native Hindsight `scores.semantic` for automatic Recall on
   * negotiated `0.10.0`. Omission resolves to `0.5`. `0` disables the
   * threshold. Carried only in process-local runtime; never persisted elsewhere.
   */
  minScore: number;
}

export const DEFAULT_HINDSIGHT_URL = "http://127.0.0.1:8888";
export const DEFAULT_MIN_SCORE = 0.5;

export type GlobalConfigResult =
  | { ok: true; config: GlobalConfig }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMinScore(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: 'global config field "minScore" must be a finite number' };
  }
  if (value < 0 || value > 1) {
    return { ok: false, reason: 'global config field "minScore" must be in the inclusive range 0..1' };
  }
  return { ok: true, value };
}

/**
 * Validates a parsed global config JSON value against the strict allowlist.
 * Any field other than `url`/`minScore`, or an invalid value, is rejected.
 */
export function validateGlobalConfig(value: unknown): GlobalConfigResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "global config must be a JSON object" };
  }
  const keys = Object.keys(value);
  const allowed = new Set(["url", "minScore"]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `global config field "${key}" is not allowed` };
    }
  }

  let url = DEFAULT_HINDSIGHT_URL;
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || value.url.trim().length === 0) {
      return { ok: false, reason: 'global config field "url" must be a non-empty string' };
    }
    const normalizedUrl = value.url.trim();
    const urlCheck = validateHindsightUrl(normalizedUrl);
    if (!urlCheck.ok) {
      return { ok: false, reason: urlCheck.reason };
    }
    url = normalizedUrl;
  }

  let minScore = DEFAULT_MIN_SCORE;
  if (value.minScore !== undefined) {
    const scoreCheck = validateMinScore(value.minScore);
    if (!scoreCheck.ok) {
      return { ok: false, reason: scoreCheck.reason };
    }
    minScore = scoreCheck.value;
  }

  return { ok: true, config: { url, minScore } };
}

export type UrlCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Rejects URL-embedded credentials and non-HTTP(S) schemes per
 * hindsight-contract.md "Compatibility and startup checks".
 */
export function validateHindsightUrl(raw: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "url is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "url must use http or https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "url must not embed credentials" };
  }
  if (parsed.search) {
    return { ok: false, reason: "url must not include a query string" };
  }
  if (parsed.hash) {
    return { ok: false, reason: "url must not include a fragment" };
  }
  return { ok: true };
}

/**
 * Reads and validates the global config file. Missing file is not an error:
 * it resolves to the default URL and default minScore. Any parse/validation
 * failure disables the memory feature safely (caller decides how to report this).
 */
export async function loadGlobalConfig(agentDir: string): Promise<GlobalConfigResult> {
  const filePath = path.join(agentDir, "memory-hindsight.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, config: { url: DEFAULT_HINDSIGHT_URL, minScore: DEFAULT_MIN_SCORE } };
    }
    return { ok: false, reason: `failed to read global config: ${code ?? "unknown error"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "global config is not valid JSON" };
  }
  return validateGlobalConfig(parsed);
}

/** Reads the Hindsight API key from the environment only. Never persisted. */
export function loadHindsightApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.HINDSIGHT_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) {
    return undefined;
  }
  return key;
}

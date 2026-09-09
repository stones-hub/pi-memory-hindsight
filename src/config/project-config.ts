/**
 * Project extension configuration.
 *
 * Location: `<git-root>/.pi/memory.json`.
 * Contract (product-requirements.md "Configuration/Project"): the file may
 * contain only `enabled` (boolean) and optional `project` (string).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ProjectConfig {
  enabled: boolean;
  project?: string;
}

export type ProjectConfigResult =
  | { ok: true; config: ProjectConfig | undefined }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectConfig(value: unknown): ProjectConfigResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "project config must be a JSON object" };
  }
  const allowed = new Set(["enabled", "project"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `project config field "${key}" is not allowed` };
    }
  }
  if (typeof value.enabled !== "boolean") {
    return { ok: false, reason: "project config field \"enabled\" must be a boolean" };
  }
  let project: string | undefined;
  if (value.project !== undefined) {
    if (typeof value.project !== "string" || value.project.trim().length === 0) {
      return { ok: false, reason: "project config field \"project\" must be a non-empty string" };
    }
    project = value.project.trim();
  }
  const config: ProjectConfig = { enabled: value.enabled };
  if (project !== undefined) {
    config.project = project;
  }
  return { ok: true, config };
}

/**
 * Reads and validates `<gitRoot>/.pi/memory.json`. A missing file resolves to
 * `undefined` (Project Memory disabled by absence, not by error). Malformed
 * content is a validation error so callers can disable safely with a
 * diagnostic instead of silently guessing intent.
 */
export async function loadProjectConfig(gitRoot: string): Promise<ProjectConfigResult> {
  const filePath = path.join(gitRoot, ".pi", "memory.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, config: undefined };
    }
    return { ok: false, reason: `failed to read project config: ${code ?? "unknown error"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "project config is not valid JSON" };
  }
  return validateProjectConfig(parsed);
}

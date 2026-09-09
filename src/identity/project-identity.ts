/**
 * Project identity resolution (product-requirements.md "Configuration/Project",
 * "Scope and identity").
 */

import { loadProjectConfig, type ProjectConfig } from "../config/project-config.js";
import { deriveRepoNameFromRemoteUrl, findGitRoot, readOriginRemoteUrl } from "./git-remote.js";

export type ProjectIdentityResult =
  | { enabled: true; identity: string; gitRoot: string; config: ProjectConfig }
  | { enabled: false; reason: string };

/**
 * Resolves whether Project Memory is enabled for `cwd`, and if so, its
 * normalized (lowercase) project identity.
 *
 * Priority: explicit `project` field in `.pi/memory.json` > final Git remote
 * repository name. Neither present, or config invalid/disabled, disables
 * Project Memory with a diagnostic reason (never falls back to Profile scope).
 */
export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentityResult> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return { enabled: false, reason: "not inside a Git repository" };
  }

  const configResult = await loadProjectConfig(gitRoot);
  if (!configResult.ok) {
    return { enabled: false, reason: configResult.reason };
  }
  const config = configResult.config;
  if (!config) {
    return { enabled: false, reason: "no .pi/memory.json present" };
  }
  if (!config.enabled) {
    return { enabled: false, reason: "project memory disabled by .pi/memory.json" };
  }

  if (config.project) {
    return { enabled: true, identity: config.project.trim().toLowerCase(), gitRoot, config };
  }

  const remoteUrl = await readOriginRemoteUrl(gitRoot);
  if (!remoteUrl) {
    return { enabled: false, reason: "no explicit project name and no usable Git remote" };
  }
  const derived = deriveRepoNameFromRemoteUrl(remoteUrl);
  if (!derived) {
    return { enabled: false, reason: "could not derive a repository name from the Git remote" };
  }
  return { enabled: true, identity: derived, gitRoot, config };
}

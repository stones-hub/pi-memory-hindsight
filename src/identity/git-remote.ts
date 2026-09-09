/**
 * Minimal, dependency-free Git repository root and remote URL resolution,
 * implemented via direct filesystem reads (no subprocess spawn) so the
 * extension does not depend on a `git` binary being on PATH.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Walks upward from `startDir` to find the nearest ancestor containing `.git`. */
export async function findGitRoot(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    const gitPath = path.join(dir, ".git");
    try {
      await stat(gitPath);
      return dir;
    } catch {
      // not here, continue upward
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Resolves the actual git "common dir" (handles worktrees) containing `config`. */
async function resolveGitCommonDir(gitRoot: string): Promise<string | undefined> {
  const gitPath = path.join(gitRoot, ".git");
  let st;
  try {
    st = await stat(gitPath);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) {
    return gitPath;
  }
  // Worktree: ".git" is a file containing "gitdir: <path>"
  let content: string;
  try {
    content = await readFile(gitPath, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) {
    return undefined;
  }
  const gitDir = path.isAbsolute(match[1]!.trim())
    ? match[1]!.trim()
    : path.resolve(gitRoot, match[1]!.trim());
  try {
    const commonDirFile = path.join(gitDir, "commondir");
    const commonDirRaw = (await readFile(commonDirFile, "utf8")).trim();
    return path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(gitDir, commonDirRaw);
  } catch {
    // No commondir file: this gitDir is itself the common dir.
    return gitDir;
  }
}

/** Parses the `url` of `[remote "origin"]` out of a git config INI file. */
function parseOriginUrl(configText: string): string | undefined {
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      inOrigin = /^remote\s+"origin"$/i.test(sectionMatch[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (kv) {
      return kv[1];
    }
  }
  return undefined;
}

/** Reads the `origin` remote URL for the repository rooted at `gitRoot`, if any. */
export async function readOriginRemoteUrl(gitRoot: string): Promise<string | undefined> {
  const commonDir = await resolveGitCommonDir(gitRoot);
  if (!commonDir) return undefined;
  let configText: string;
  try {
    configText = await readFile(path.join(commonDir, "config"), "utf8");
  } catch {
    return undefined;
  }
  return parseOriginUrl(configText);
}

/**
 * Derives the final repository name from a git remote URL: the last path
 * segment, with a trailing `.git` removed, trimmed, and lowercased.
 * Handles `https://`, `ssh://`, scp-like `git@host:owner/repo.git`, and
 * plain filesystem paths.
 */
export function deriveRepoNameFromRemoteUrl(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return undefined;

  let pathPart = trimmed;
  // scp-like syntax: user@host:path
  const scpMatch = /^[^/]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    pathPart = scpMatch[1]!;
  } else {
    try {
      const url = new URL(trimmed);
      pathPart = url.pathname;
    } catch {
      pathPart = trimmed;
    }
  }

  const segments = pathPart.split(/[/\\]+/).filter((s) => s.length > 0);
  const last = segments.at(-1);
  if (!last) return undefined;

  const withoutGitSuffix = last.replace(/\.git$/i, "");
  const finalName = withoutGitSuffix.trim().toLowerCase();
  return finalName.length > 0 ? finalName : undefined;
}

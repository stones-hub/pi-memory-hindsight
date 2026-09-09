import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileBankId, projectBankId } from "../src/identity/bank-id.js";
import {
  deriveRepoNameFromRemoteUrl,
  findGitRoot,
  readOriginRemoteUrl,
} from "../src/identity/git-remote.js";
import { resolveProjectIdentity } from "../src/identity/project-identity.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-identity-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

describe("git remote parsing", () => {
  it("derives names from common remote formats", () => {
    expect(deriveRepoNameFromRemoteUrl("https://github.com/org/Repo.git")).toBe("repo");
    expect(deriveRepoNameFromRemoteUrl("ssh://git@github.com/org/Repo.git")).toBe("repo");
    expect(deriveRepoNameFromRemoteUrl("git@github.com:org/Repo.git")).toBe("repo");
    expect(deriveRepoNameFromRemoteUrl("/tmp/Repo.git")).toBe("repo");
  });

  it("finds the nearest git root and reads origin", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "nested", "dir"), { recursive: true });
    await writeFile(
      path.join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:Org/Repo.git\n',
      "utf8",
    );
    await mkdir(path.join(repo, ".pi"), { recursive: true });
    await writeFile(path.join(repo, ".pi", "memory.json"), JSON.stringify({ enabled: true }), "utf8");

    expect(await findGitRoot(path.join(repo, "nested", "dir"))).toBe(repo);
    expect(await readOriginRemoteUrl(repo)).toBe("git@github.com:Org/Repo.git");
    await expect(resolveProjectIdentity(path.join(repo, "nested"))).resolves.toMatchObject({
      enabled: true,
      identity: "repo",
      gitRoot: repo,
    });
  });

  it("supports git worktree style .git files", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-worktree-"));
    tempDirs.push(repo);
    const gitDir = path.join(repo, ".git-worktree");
    const common = path.join(repo, ".git-common");
    await mkdir(gitDir, { recursive: true });
    await mkdir(common, { recursive: true });
    await writeFile(path.join(repo, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(path.join(gitDir, "commondir"), "../.git-common\n", "utf8");
    await writeFile(path.join(common, "config"), '[remote "origin"]\nurl = https://example.com/Owner/Worktree.git\n', "utf8");

    expect(await readOriginRemoteUrl(repo)).toBe("https://example.com/Owner/Worktree.git");
  });
});

describe("project identity and bank ids", () => {
  it("prefers explicit configured project names", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, ".pi"), { recursive: true });
    await writeFile(
      path.join(repo, ".pi", "memory.json"),
      JSON.stringify({ enabled: true, project: "  My-Project  " }),
      "utf8",
    );
    const result = await resolveProjectIdentity(repo);
    expect(result).toEqual({
      enabled: true,
      identity: "my-project",
      gitRoot: repo,
      config: { enabled: true, project: "My-Project" },
    });
  });

  it("disables project memory when there is no config or no usable identity", async () => {
    const repo = await makeRepo();
    await expect(resolveProjectIdentity(repo)).resolves.toMatchObject({ enabled: false });
    await mkdir(path.join(repo, ".pi"), { recursive: true });
    await writeFile(path.join(repo, ".pi", "memory.json"), JSON.stringify({ enabled: true }), "utf8");
    await expect(resolveProjectIdentity(repo)).resolves.toMatchObject({
      enabled: false,
      reason: "no explicit project name and no usable Git remote",
    });
  });

  it("hashes bank ids deterministically without leaking source values", () => {
    const profile = profileBankId("profile-secret");
    const project = projectBankId("my-project");

    expect(profile).toBe(profileBankId("profile-secret"));
    expect(project).toBe(projectBankId("my-project"));
    expect(profile).not.toContain("profile-secret");
    expect(project).not.toContain("my-project");
    expect(profile).toMatch(/^pi-memory-hindsight:profile:/);
    expect(project).toMatch(/^pi-memory-hindsight:project:/);
    expect(profile.length).toBeLessThan(64);
    expect(project.length).toBeLessThan(64);
  });

  it("keeps the bank-id source file free of literal NUL bytes", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "identity", "bank-id.ts"),
      "utf8",
    );
    expect(source.includes("\u0000")).toBe(false);
    expect(source.includes('"\\0"')).toBe(true);
  });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HINDSIGHT_URL,
  loadGlobalConfig,
  loadHindsightApiKey,
  validateGlobalConfig,
  validateHindsightUrl,
} from "../src/config/global-config.js";
import { loadProjectConfig, validateProjectConfig } from "../src/config/project-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("global config", () => {
  it("uses the default URL when config is absent", async () => {
    const dir = await makeTempDir();
    await mkdir(dir, { recursive: true });
    const result = await loadGlobalConfig(dir);
    expect(result).toEqual({ ok: true, config: { url: DEFAULT_HINDSIGHT_URL } });
  });

  it("rejects unknown fields and unsafe URLs", () => {
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", extra: true }).ok).toBe(false);
    expect(validateHindsightUrl("ftp://127.0.0.1:8888").ok).toBe(false);
    expect(validateHindsightUrl("http://user:pass@127.0.0.1:8888").ok).toBe(false);
    expect(validateHindsightUrl("http://127.0.0.1:8888?q=1").ok).toBe(false);
    expect(validateHindsightUrl("http://127.0.0.1:8888#frag").ok).toBe(false);
  });

  it("trims a valid URL and treats whitespace-only API keys as absent", () => {
    expect(validateGlobalConfig({ url: "  http://127.0.0.1:8888  " })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888" },
    });
    expect(loadHindsightApiKey({ HINDSIGHT_API_KEY: "" })).toBeUndefined();
    expect(loadHindsightApiKey({ HINDSIGHT_API_KEY: "   " })).toBeUndefined();
    expect(loadHindsightApiKey({ HINDSIGHT_API_KEY: " secret\t" })).toBe(" secret\t");
  });

  it("rejects malformed JSON on disk", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "memory-hindsight.json"), "{oops", "utf8");
    const result = await loadGlobalConfig(dir);
    expect(result.ok).toBe(false);
  });
});

describe("project config", () => {
  it("accepts only enabled plus optional project", () => {
    expect(validateProjectConfig({ enabled: true, project: " Demo " })).toEqual({
      ok: true,
      config: { enabled: true, project: "Demo" },
    });
    expect(validateProjectConfig({ enabled: true, nested: true }).ok).toBe(false);
    expect(validateProjectConfig({ enabled: "yes" }).ok).toBe(false);
    expect(validateProjectConfig({ enabled: true, project: "   " }).ok).toBe(false);
  });

  it("reads only the git-root config path", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, ".pi"), { recursive: true });
    await writeFile(
      path.join(dir, ".pi", "memory.json"),
      JSON.stringify({ enabled: true, project: "Repo" }),
      "utf8",
    );
    const result = await loadProjectConfig(dir);
    expect(result).toEqual({ ok: true, config: { enabled: true, project: "Repo" } });
  });
});

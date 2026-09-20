import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HINDSIGHT_URL,
  DEFAULT_MIN_SCORE,
  loadGlobalConfig,
  loadHindsightApiKey,
  validateGlobalConfig,
  validateHindsightUrl,
} from "../src/config/global-config.js";
import { loadProjectConfig, validateProjectConfig } from "../src/config/project-config.js";
import { MemoryDatabase } from "../src/db/database.js";
import { peekCachedLocalRuntime, resetGlobalRuntimeForTests } from "../src/runtime/global-runtime.js";
import { t } from "../src/i18n/messages.js";
import extension from "../src/index.js";

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
  it("uses the default URL and minScore when config is absent", async () => {
    const dir = await makeTempDir();
    await mkdir(dir, { recursive: true });
    const result = await loadGlobalConfig(dir);
    expect(result).toEqual({
      ok: true,
      config: { url: DEFAULT_HINDSIGHT_URL, minScore: DEFAULT_MIN_SCORE },
    });
  });

  it("defaults omitted minScore to 0.5 and accepts explicit 0, 0.5, 1, and decimals", () => {
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888" })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888", minScore: 0.5 },
    });
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: 0 })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888", minScore: 0 },
    });
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: 0.5 })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888", minScore: 0.5 },
    });
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: 1 })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888", minScore: 1 },
    });
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: 0.55 })).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:8888", minScore: 0.55 },
    });
    expect(validateGlobalConfig({ minScore: 0.25 })).toEqual({
      ok: true,
      config: { url: DEFAULT_HINDSIGHT_URL, minScore: 0.25 },
    });
  });

  it("rejects invalid minScore values and unknown fields", () => {
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: -0.1 }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: 1.01 }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: null }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: "0.5" }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: true }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: [] }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: {} }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: Number.NaN }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", minScore: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateGlobalConfig({ url: "http://127.0.0.1:8888", extra: true }).ok).toBe(false);
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
      config: { url: "http://127.0.0.1:8888", minScore: 0.5 },
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

  it("carries effective minScore through local runtime without writing it back to disk", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "memory-hindsight.json"),
      JSON.stringify({ url: "http://127.0.0.1:18888", minScore: 0.6 }),
      "utf8",
    );
    const loaded = await loadGlobalConfig(dir);
    expect(loaded).toEqual({
      ok: true,
      config: { url: "http://127.0.0.1:18888", minScore: 0.6 },
    });
    const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(dir, "memory-hindsight.json"), "utf8"));
    expect(onDisk).toEqual({ url: "http://127.0.0.1:18888", minScore: 0.6 });
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

describe("cached local runtime peek for help", () => {
  afterEach(() => {
    resetGlobalRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("help does not open SQLite or create a Profile when no runtime is cached", async () => {
    resetGlobalRuntimeForTests();
    const open = vi.spyOn(MemoryDatabase, "open");
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    extension({
      on: vi.fn(),
      appendEntry: vi.fn(),
      registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, def),
      registerTool: vi.fn(),
    } as any);
    const notify = vi.fn();
    await commands.get("memory")!.handler("help", {
      mode: "tui",
      ui: { notify },
      sessionManager: { getSessionId: () => "help-peek-session" },
    });
    expect(open).not.toHaveBeenCalled();
    expect(peekCachedLocalRuntime()).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(t("en", "memory.help"), "info");
  });
});

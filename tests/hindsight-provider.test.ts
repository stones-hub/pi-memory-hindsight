import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileBankId } from "../src/identity/bank-id.js";
import { HindsightAdapter, validateRecallScores, redactApiVersionForReason } from "../src/provider/hindsight-adapter.js";
import { HttpClient, REFLECT_HTTP_TIMEOUT_MS, clampReflectHttpTimeoutMs } from "../src/provider/http-client.js";
import { OWNED_BANK_CONFIG_OVERRIDES } from "../src/provider/types.js";
import { buildOwnedDocumentId } from "../src/provider/validation.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  bodyText: string;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, bodyText: string) => void | Promise<void>;

interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  setRoute(method: string, url: string, handler: RouteHandler): void;
  close(): Promise<void>;
}

const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      bodyText,
    });
    const key = `${req.method ?? "GET"} ${req.url ?? "/"}`;
    const handler = routes.get(key);
    if (!handler) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected route: ${key}` }));
      return;
    }
    await handler(req, res, bodyText);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server failed to bind");
  }

  const mock: MockServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  servers.push(mock);
  return mock;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const VALID_BANK_ID = profileBankId("profile-test-id");
const VALID_DOCUMENT_ID = buildOwnedDocumentId("profile", null, "preference", "memory-1");

function validMetadata(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    logical_id: "memory-1",
    content_hash: "abcd".repeat(16),
    scope: "profile",
    memory_type: "preference",
    verification_state: "verified",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function textHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function documentGetBody(
  bankId: string,
  documentId: string,
  text: string,
  overrides: {
    wrongId?: string;
    wrongBankId?: string;
    wrongHash?: string;
    memoryUnitCount?: number;
    documentMetadata?: unknown;
    originalText?: string;
  } = {},
): Record<string, unknown> {
  const hash = overrides.wrongHash ?? textHash(text);
  const metadata =
    overrides.documentMetadata !== undefined
      ? overrides.documentMetadata
      : validMetadata({ content_hash: hash });
  return {
    id: overrides.wrongId ?? documentId,
    bank_id: overrides.wrongBankId ?? bankId,
    original_text: overrides.originalText ?? text,
    content_hash: hash,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T01:00:00.000Z",
    memory_unit_count: overrides.memoryUnitCount ?? 1,
    nodes_by_fact_type: {},
    tags: [],
    document_metadata: metadata,
    retain_params: {},
    observation_scopes: {},
  };
}

function listBody(
  documentId: string,
  text: string,
  overrides: {
    unitId?: string;
    metadata?: Record<string, string> | null;
    total?: number;
    items?: Array<Record<string, unknown>>;
    wrongDocId?: string;
    wrongText?: string;
  } = {},
): Record<string, unknown> {
  if (overrides.items) {
    return { items: overrides.items, total: overrides.total ?? overrides.items.length, limit: 2, offset: 0 };
  }
  const total = overrides.total ?? 1;
  if (total === 0) {
    return { items: [], total: 0, limit: 2, offset: 0 };
  }
  const metadata = overrides.metadata === undefined ? null : overrides.metadata;
  return {
    items: [
      {
        id: overrides.unitId ?? "u1",
        text: overrides.wrongText ?? text,
        document_id: overrides.wrongDocId ?? documentId,
        state: "valid",
        metadata,
      },
    ],
    total,
    limit: 2,
    offset: 0,
  };
}

function wireExactFetchRoutes(
  server: MockServer,
  bankId: string,
  documentId: string,
  text: string,
  options: {
    doc?: ReturnType<typeof documentGetBody> | null;
    docStatus?: number;
    list?: Record<string, unknown> | null;
    listStatus?: number;
    docOverrides?: Parameters<typeof documentGetBody>[3];
    listOverrides?: Parameters<typeof listBody>[2];
  } = {},
): void {
  const encodedBank = encodeURIComponent(bankId);
  const encodedDocument = encodeURIComponent(documentId);
  const documentQuery = new URLSearchParams({ document_id: documentId, limit: "2" }).toString();
  server.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
    json(res, options.docStatus ?? 200, options.doc ?? documentGetBody(bankId, documentId, text, options.docOverrides));
  });
  server.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
    json(res, options.listStatus ?? 200, options.list ?? listBody(documentId, text, options.listOverrides));
  });
}

describe("HttpClient", () => {
  it("sends bearer auth but never echoes it in errors", async () => {
    const server = await startMockServer();
    server.setRoute("GET", "/secret", (_req, res) => {
      json(res, 401, { error: "nope" });
    });

    const client = new HttpClient({ baseUrl: server.baseUrl, apiKey: "super-secret-token" });
    const result = await client.request("GET", "/secret");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("HTTP 401");
    expect(result.reason).not.toContain("super-secret-token");
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer super-secret-token");
  });

  it("classifies timeout, body-read timeout, caller abort, body-read abort, non-json, malformed json, and oversize responses", async () => {
    const server = await startMockServer();
    server.setRoute("GET", "/slow", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      json(res, 200, { ok: true });
    });
    server.setRoute("GET", "/slow-body", async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.end('"ok":true}');
    });
    server.setRoute("GET", "/text", (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    server.setRoute("GET", "/bad-json", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{bad");
    });
    server.setRoute("POST", "/too-big", (_req, res) => {
      json(res, 200, { ok: true });
    });

    const timeoutClient = new HttpClient({ baseUrl: server.baseUrl, timeoutMs: 10 });
    const timeout = await timeoutClient.request("GET", "/slow");
    expect(timeout).toMatchObject({ ok: false, category: "timeout" });

    const readTimeout = await timeoutClient.request("GET", "/slow-body");
    expect(readTimeout).toMatchObject({ ok: false, category: "timeout" });

    const controller = new AbortController();
    const aborting = new HttpClient({ baseUrl: server.baseUrl, timeoutMs: 1000 }).request("GET", "/slow", {
      signal: controller.signal,
    });
    controller.abort();
    const aborted = await aborting;
    expect(aborted).toMatchObject({ ok: false, category: "aborted" });

    const controller2 = new AbortController();
    const abortReading = new HttpClient({ baseUrl: server.baseUrl, timeoutMs: 1000 }).request("GET", "/slow-body", {
      signal: controller2.signal,
    });
    setTimeout(() => controller2.abort(), 10);
    const abortedRead = await abortReading;
    expect(abortedRead).toMatchObject({ ok: false, category: "aborted" });

    const nonJson = await timeoutClient.request("GET", "/text");
    expect(nonJson).toMatchObject({ ok: false, category: "malformed" });

    const badJson = await timeoutClient.request("GET", "/bad-json");
    expect(badJson).toMatchObject({ ok: false, category: "malformed" });

    const oversizedRequest = await new HttpClient({
      baseUrl: server.baseUrl,
      maxRequestBytes: 16,
    }).request("POST", "/too-big", { body: { huge: "x".repeat(100) } });
    expect(oversizedRequest).toMatchObject({ ok: false, category: "oversize" });
  });

  it("honors a per-call timeoutMs override beyond the client's own ceiling, hard-capped at REFLECT_HTTP_TIMEOUT_MS", async () => {
    expect(clampReflectHttpTimeoutMs(1_000)).toBe(1_000);
    expect(clampReflectHttpTimeoutMs(999_000)).toBe(REFLECT_HTTP_TIMEOUT_MS);
    expect(clampReflectHttpTimeoutMs(undefined)).toBe(REFLECT_HTTP_TIMEOUT_MS);
    expect(clampReflectHttpTimeoutMs(0)).toBe(REFLECT_HTTP_TIMEOUT_MS);

    const server = await startMockServer();
    server.setRoute("GET", "/slow-reflect-like", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      json(res, 200, { ok: true });
    });

    // Client's own ceiling (10ms) is far shorter than the delay; without an
    // override this would time out, proving the override is what lets it succeed.
    const client = new HttpClient({ baseUrl: server.baseUrl, timeoutMs: 10 });
    expect(client.timeoutMs).toBe(10);
    const overridden = await client.request("GET", "/slow-reflect-like", { timeoutMs: 200 });
    expect(overridden).toMatchObject({ ok: true });

    const stillDefaultCeiling = await client.request("GET", "/slow-reflect-like");
    expect(stillDefaultCeiling).toMatchObject({ ok: false, category: "timeout" });
  });

  it("hard-caps request()'s own effective per-call timeout at REFLECT_HTTP_TIMEOUT_MS via the single shared clamp, without waiting 180s", async () => {
    const server = await startMockServer();
    server.setRoute("GET", "/instant", (_req, res) => json(res, 200, { ok: true }));
    const client = new HttpClient({ baseUrl: server.baseUrl, timeoutMs: 10 });

    // AbortSignal.timeout(ms) is called synchronously before the first
    // `await` inside request(), so spying on it observes exactly the
    // effective timeout request() computed for this call, without needing
    // to let any timer actually fire.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const overCeiling = await client.request("GET", "/instant", { timeoutMs: 999_000 });
      expect(overCeiling).toMatchObject({ ok: true });
      expect(timeoutSpy).toHaveBeenLastCalledWith(REFLECT_HTTP_TIMEOUT_MS);

      // Invalid/nonpositive overrides must fall back to the same deliberate
      // ceiling as `clampReflectHttpTimeoutMs(undefined)`, not an ad hoc value.
      for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        timeoutSpy.mockClear();
        const result = await client.request("GET", "/instant", { timeoutMs: invalid });
        expect(result).toMatchObject({ ok: true });
        expect(timeoutSpy).toHaveBeenLastCalledWith(REFLECT_HTTP_TIMEOUT_MS);
      }

      // Omitting the override keeps using the client's own (here 10ms) ceiling.
      timeoutSpy.mockClear();
      await client.request("GET", "/instant");
      expect(timeoutSpy).toHaveBeenLastCalledWith(10);

      // An in-bounds override is passed through unchanged, matching clampReflectHttpTimeoutMs.
      timeoutSpy.mockClear();
      await client.request("GET", "/instant", { timeoutMs: 45_000 });
      expect(timeoutSpy).toHaveBeenLastCalledWith(45_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("validateRecallScores", () => {
  it("accepts final above 1 and nullable optional fields, and rejects non-finite values", () => {
    expect(
      validateRecallScores({
        final: 1.0986786712451455,
        reranker: null,
        semantic: 0.5,
        keyword: null,
        extra_ignored: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        final: 1.0986786712451455,
        reranker: null,
        semantic: 0.5,
        keyword: null,
      },
    });
    expect(validateRecallScores({ final: Number.NaN, reranker: null, semantic: null, keyword: null }).ok).toBe(false);
    expect(
      validateRecallScores({ final: Number.POSITIVE_INFINITY, reranker: null, semantic: null, keyword: null }).ok,
    ).toBe(false);
    expect(validateRecallScores({ final: 1, reranker: Number.NaN, semantic: null, keyword: null }).ok).toBe(false);
  });
});

describe("redactApiVersionForReason", () => {
  it("keeps short printable identifiers and redacts long or control-bearing strings", () => {
    expect(redactApiVersionForReason("0.8.0")).toBe("0.8.0");
    expect(redactApiVersionForReason("0.10.1")).toBe("0.10.1");
    const long = `0.9.${"x".repeat(200)}`;
    expect(redactApiVersionForReason(long)).toBe("<redacted>");
    expect(redactApiVersionForReason(long).length).toBeLessThan(32);
    expect(redactApiVersionForReason("0.9.0\nsecret")).toBe("<redacted>");
    expect(redactApiVersionForReason("0.9.0\u0000evil")).toBe("<redacted>");
    expect(redactApiVersionForReason("版本-奇怪")).toBe("<redacted>");
  });
});

function installCompatibleVersion(
  server: MockServer,
  apiVersion: "0.8.3" | "0.10.0" = "0.8.3",
): void {
  server.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
  server.setRoute("GET", "/version", (_req, res) =>
    json(res, 200, { api_version: apiVersion, features: { bank_config_api: true } }),
  );
}

async function negotiateAdapter(
  server: MockServer,
  apiVersion: "0.8.3" | "0.10.0" = "0.8.3",
): Promise<HindsightAdapter> {
  installCompatibleVersion(server, apiVersion);
  const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
  const compat = await adapter.checkCompatibility();
  expect(compat).toEqual({
    ok: true,
    value: { healthy: true, apiVersion, bankConfigApiEnabled: true },
  });
  expect(adapter.getNegotiatedApiVersion()).toBe(apiVersion);
  return adapter;
}

describe("HindsightAdapter", () => {
  it("accepts exact 0.8.3 and 0.10.0, rejects nearby/unknown versions, and keeps negotiation instance-local", async () => {
    const server083 = await startMockServer();
    const adapter083 = await negotiateAdapter(server083, "0.8.3");
    expect(adapter083.getNegotiatedApiVersion()).toBe("0.8.3");

    const server010 = await startMockServer();
    const adapter010 = await negotiateAdapter(server010, "0.10.0");
    expect(adapter010.getNegotiatedApiVersion()).toBe("0.10.0");
    // Negotiation must not leak across adapter instances.
    expect(adapter083.getNegotiatedApiVersion()).toBe("0.8.3");

    const server2 = await startMockServer();
    server2.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    server2.setRoute("GET", "/version", (_req, res) => json(res, 200, { api_version: 83, features: null }));
    const badAdapter = new HindsightAdapter({ baseUrl: server2.baseUrl });
    const bad = await badAdapter.checkCompatibility();
    expect(bad).toMatchObject({ ok: false, category: "validation" });
    expect(badAdapter.getNegotiatedApiVersion()).toBeNull();

    for (const apiVersion of ["0.8.0", "0.9.0", "0.10.1", "1.0.0", "0.10"] as const) {
      const nearby = await startMockServer();
      nearby.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
      nearby.setRoute("GET", "/version", (_req, res) =>
        json(res, 200, { api_version: apiVersion, features: { bank_config_api: true } }),
      );
      const rejected = await new HindsightAdapter({ baseUrl: nearby.baseUrl }).checkCompatibility();
      expect(rejected).toMatchObject({ ok: false, category: "validation" });
      expect(String((rejected as { reason: string }).reason)).toMatch(/not compatible with supported baselines/);
      expect(String((rejected as { reason: string }).reason)).toContain(apiVersion);
    }

    const longVersion = `evil-${"A".repeat(500)}\u0007`;
    const longServer = await startMockServer();
    longServer.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    longServer.setRoute("GET", "/version", (_req, res) =>
      json(res, 200, { api_version: longVersion, features: { bank_config_api: true } }),
    );
    const longRejected = await new HindsightAdapter({ baseUrl: longServer.baseUrl }).checkCompatibility();
    expect(longRejected).toMatchObject({ ok: false, category: "validation" });
    const longReason = String((longRejected as { reason: string }).reason);
    expect(longReason).toContain("<redacted>");
    expect(longReason).not.toContain("AAAA");
    expect(longReason).not.toContain("\u0007");
    expect(longReason.length).toBeLessThan(200);
  });

  it("clears negotiation on a later failed compatibility check", async () => {
    const server = await startMockServer();
    const adapter = await negotiateAdapter(server, "0.8.3");
    server.setRoute("GET", "/version", (_req, res) =>
      json(res, 200, { api_version: "9.9.9", features: { bank_config_api: true } }),
    );
    const failed = await adapter.checkCompatibility();
    expect(failed).toMatchObject({ ok: false, category: "validation" });
    expect(adapter.getNegotiatedApiVersion()).toBeNull();
  });

  it("preserves negotiated contract for Recall while a recheck is in flight, then clears if that recheck fails", async () => {
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    const server = await startMockServer();
    const adapter = await negotiateAdapter(server, "0.8.3");

    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).not.toHaveProperty("min_scores");
      json(res, 200, {
        results: [{ id: "r1", text: "ok", type: "world", document_id: "doc-1" }],
      });
    });

    let releaseVersion: (() => void) | undefined;
    const versionGate = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    let versionEntered = false;
    server.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    server.setRoute("GET", "/version", async (_req, res) => {
      versionEntered = true;
      await versionGate;
      json(res, 200, { api_version: "9.9.9", features: { bank_config_api: true } });
    });

    const recheck = adapter.checkCompatibility();
    // Wait until the recheck has entered the version await without clearing negotiation.
    for (let i = 0; i < 50 && !versionEntered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(versionEntered).toBe(true);
    expect(adapter.getNegotiatedApiVersion()).toBe("0.8.3");

    const recalledWhilePending = await adapter.recall({
      bankId: VALID_BANK_ID,
      query: "q",
      budget: "low",
      maxTokens: 100,
    });
    expect(recalledWhilePending).toMatchObject({
      ok: true,
      value: [{ id: "r1", scores: null }],
    });
    expect(adapter.getNegotiatedApiVersion()).toBe("0.8.3");

    releaseVersion!();
    const failed = await recheck;
    expect(failed).toMatchObject({ ok: false, category: "validation" });
    expect(adapter.getNegotiatedApiVersion()).toBeNull();

    const afterFailure = await adapter.recall({
      bankId: VALID_BANK_ID,
      query: "q",
      budget: "low",
      maxTokens: 100,
    });
    expect(afterFailure).toMatchObject({
      ok: false,
      category: "validation",
      reason: "recall rejected: hindsight compatibility has not been negotiated",
    });

    // Cold adapters still fail closed before any negotiation.
    const cold = new HindsightAdapter({ baseUrl: server.baseUrl });
    await expect(
      cold.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({
      ok: false,
      category: "validation",
      reason: "recall rejected: hindsight compatibility has not been negotiated",
    });
  });

  it("creates the owned bank, patches exact overrides, and verifies readback from both config and overrides", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    server.setRoute("PUT", `/v1/default/banks/${encodedBank}`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).toEqual({});
      json(res, 200, { success: true });
    });
    server.setRoute("PATCH", `/v1/default/banks/${encodedBank}/config`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).toEqual({ updates: OWNED_BANK_CONFIG_OVERRIDES });
      json(res, 200, { ok: true });
    });
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/config`, (_req, res) => {
      json(res, 200, {
        bank_id: bankId,
        config: { ...OWNED_BANK_CONFIG_OVERRIDES },
        overrides: { ...OWNED_BANK_CONFIG_OVERRIDES },
      });
    });

    const result = await new HindsightAdapter({ baseUrl: server.baseUrl }).ensureOwnedBank(bankId);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT /v1/default/banks/${encodedBank}`,
      `PATCH /v1/default/banks/${encodedBank}/config`,
      `GET /v1/default/banks/${encodedBank}/config`,
    ]);
    expect(server.requests.some((r) => r.url.includes("/banks/list"))).toBe(false);
  });

  it("fails closed on config drift or malformed config readback", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    server.setRoute("PUT", `/v1/default/banks/${encodedBank}`, (_req, res) => json(res, 200, { success: true }));
    server.setRoute("PATCH", `/v1/default/banks/${encodedBank}/config`, (_req, res) => json(res, 200, { ok: true }));
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/config`, (_req, res) => {
      json(res, 200, {
        bank_id: bankId,
        config: { ...OWNED_BANK_CONFIG_OVERRIDES, retain_chunk_size: 1024 },
        overrides: { ...OWNED_BANK_CONFIG_OVERRIDES },
      });
    });

    const drifted = await new HindsightAdapter({ baseUrl: server.baseUrl }).ensureOwnedBank(bankId);
    expect(drifted).toMatchObject({ ok: false, category: "validation" });

    const server2 = await startMockServer();
    server2.setRoute("PUT", `/v1/default/banks/${encodedBank}`, (_req, res) => json(res, 200, { success: true }));
    server2.setRoute("PATCH", `/v1/default/banks/${encodedBank}/config`, (_req, res) => json(res, 200, { ok: true }));
    server2.setRoute("GET", `/v1/default/banks/${encodedBank}/config`, (_req, res) => {
      json(res, 200, { bank_id: bankId, config: null, overrides: {} });
    });
    const malformed = await new HindsightAdapter({ baseUrl: server2.baseUrl }).ensureOwnedBank(bankId);
    expect(malformed).toMatchObject({ ok: false, category: "validation" });

    const server3 = await startMockServer();
    server3.setRoute("PUT", `/v1/default/banks/${encodedBank}`, (_req, res) => json(res, 200, { success: true }));
    server3.setRoute("PATCH", `/v1/default/banks/${encodedBank}/config`, (_req, res) => json(res, 200, { ok: true }));
    server3.setRoute("GET", `/v1/default/banks/${encodedBank}/config`, (_req, res) => {
      json(res, 200, {
        bank_id: `${bankId}-wrong`,
        config: { ...OWNED_BANK_CONFIG_OVERRIDES },
        overrides: { ...OWNED_BANK_CONFIG_OVERRIDES },
      });
    });
    const wrongBank = await new HindsightAdapter({ baseUrl: server3.baseUrl }).ensureOwnedBank(bankId);
    expect(wrongBank).toMatchObject({ ok: false, category: "validation" });
  });

  it("rejects invalid bank or document ids for every bank-scoped public method before network", async () => {
    const server = await startMockServer();
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });

    const results = await Promise.all([
      adapter.ensureOwnedBank("bad-bank"),
      adapter.retainOneMemory({ bankId: VALID_BANK_ID, documentId: "bad/doc", text: "x", metadata: validMetadata() }),
      adapter.verifyOneUnitDocument("bad-bank", VALID_DOCUMENT_ID, "x"),
      adapter.deleteMemoryDocument(VALID_BANK_ID, "bad/doc"),
      adapter.recall({ bankId: "bad-bank", query: "q", budget: "low", maxTokens: 10 }),
      adapter.reflect({ bankId: "bad-bank", query: "q", budget: "low", maxTokens: 10 }, new AbortController().signal),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, category: "validation" });
    }
    expect(server.requests).toHaveLength(0);
  });

  it("retains one exact memory with strict metadata, update_mode replace, and encoded document lookup", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const documentId = VALID_DOCUMENT_ID;
    const encodedBank = encodeURIComponent(bankId);
    const documentQuery = new URLSearchParams({ document_id: documentId, limit: "2" }).toString();
    const metadata = validMetadata({
      expires_at: "2026-06-01T00:00:00.000Z",
      last_verified_at: "2026-01-02T00:00:00.000Z",
      source_session_id: "session-1",
      source_ref: "entry:1",
      supersedes_memory_id: "memory-0",
    });
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res, bodyText) => {
      const parsed = JSON.parse(bodyText) as {
        items: Array<Record<string, unknown>>;
        async: boolean;
        update_mode?: unknown;
      };
      expect(parsed).toEqual({
        items: [
          {
            content: "记住这个决定",
            document_id: documentId,
            metadata,
            update_mode: "replace",
          },
        ],
        async: false,
      });
      expect(parsed).not.toHaveProperty("update_mode");
      json(res, 200, { success: true, bank_id: bankId, items_count: 1, async: false });
    });
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, {
        items: [
          {
            id: "unit-1",
            text: "记住这个决定",
            document_id: documentId,
            metadata: { logical_id: "memory-1" },
            state: "valid",
          },
        ],
        total: 1,
        limit: 2,
        offset: 0,
      });
    });

    const result = await new HindsightAdapter({ baseUrl: server.baseUrl }).retainOneMemory({
      bankId,
      documentId,
      text: "记住这个决定",
      metadata,
    });
    expect(result).toEqual({ ok: true, value: { unitId: "unit-1" } });
  });

  it("rejects missing, unknown, sensitive, or cross-field-invalid retain metadata before network", async () => {
    const server = await startMockServer();
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });

    const invalids = await Promise.all([
      adapter.retainOneMemory({ bankId: VALID_BANK_ID, documentId: VALID_DOCUMENT_ID, text: "x", metadata: {} }),
      adapter.retainOneMemory({
        bankId: VALID_BANK_ID,
        documentId: VALID_DOCUMENT_ID,
        text: "x",
        metadata: { ...validMetadata(), evidence: "nope" } as Record<string, string>,
      }),
      adapter.retainOneMemory({
        bankId: VALID_BANK_ID,
        documentId: VALID_DOCUMENT_ID,
        text: "x",
        metadata: { ...validMetadata(), source_ref: "Authorization: Bearer secret" },
      }),
      adapter.retainOneMemory({
        bankId: VALID_BANK_ID,
        documentId: VALID_DOCUMENT_ID,
        text: "x",
        metadata: validMetadata({ scope: "profile", memory_type: "decision" }),
      }),
      adapter.retainOneMemory({
        bankId: VALID_BANK_ID,
        documentId: VALID_DOCUMENT_ID,
        text: "x",
        metadata: validMetadata({ project_identity: "repo" }),
      }),
    ]);
    for (const result of invalids) {
      expect(result).toMatchObject({ ok: false, category: "validation" });
    }
    expect(server.requests).toHaveLength(0);
  });

  it("treats mutating timeout, 5xx, body-read failure, non-json, malformed json, and malformed success shape as ambiguous", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    const ambiguous = await new HindsightAdapter({ baseUrl: server.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(ambiguous).toMatchObject({ ok: false, category: "http", ambiguous: true });

    const server2 = await startMockServer();
    server2.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      json(res, 200, { success: true, bank_id: bankId, items_count: 1, async: false });
    });
    const timedOut = await new HindsightAdapter({ baseUrl: server2.baseUrl, timeoutMs: 10 }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(timedOut).toMatchObject({ ok: false, category: "timeout", ambiguous: true });

    const server3 = await startMockServer();
    server3.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    });
    const nonJson = await new HindsightAdapter({ baseUrl: server3.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(nonJson).toMatchObject({ ok: false, category: "malformed", ambiguous: true });

    const server4 = await startMockServer();
    server4.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{oops");
    });
    const malformedJson = await new HindsightAdapter({ baseUrl: server4.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(malformedJson).toMatchObject({ ok: false, category: "malformed", ambiguous: true });

    const server5 = await startMockServer();
    server5.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      setTimeout(() => res.destroy(), 10);
    });
    const bodyReadFailure = await new HindsightAdapter({ baseUrl: server5.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(bodyReadFailure).toMatchObject({ ok: false, ambiguous: true });

    const server6 = await startMockServer();
    server6.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "9999999" });
      res.end("{}");
    });
    const oversized = await new HindsightAdapter({ baseUrl: server6.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(oversized).toMatchObject({ ok: false, category: "oversize", ambiguous: true });

    const server7 = await startMockServer();
    server7.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      json(res, 200, { success: true, bank_id: bankId, items_count: 2, async: false });
    });
    const badShape = await new HindsightAdapter({ baseUrl: server7.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(badShape).toMatchObject({ ok: false, category: "validation", ambiguous: true });
  });

  it("rejects overlong retain text before network I/O", async () => {
    const server = await startMockServer();
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
    const result = await adapter.retainOneMemory({
      bankId: "bank",
      documentId: "doc",
      text: "记".repeat(1001),
      metadata: {},
    });
    expect(result).toMatchObject({ ok: false, category: "validation" });
    expect(server.requests).toHaveLength(0);
  });

  it("rejects verification pagination mismatches and exact-text mismatches", async () => {
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    const documentQuery = new URLSearchParams({ document_id: VALID_DOCUMENT_ID, limit: "2" }).toString();

    const zeroServer = await startMockServer();
    zeroServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, { items: [], total: 0, limit: 2, offset: 0 });
    });
    const zero = await new HindsightAdapter({ baseUrl: zeroServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(zero).toMatchObject({ ok: false, category: "validation" });
    expect(zero).not.toHaveProperty("ambiguous", true);

    const pageServer = await startMockServer();
    pageServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, {
        items: [{ id: "u1", text: "x", document_id: VALID_DOCUMENT_ID, state: "valid" }],
        total: 2,
        limit: 2,
        offset: 0,
      });
    });
    const paged = await new HindsightAdapter({ baseUrl: pageServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(paged).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const mismatchServer = await startMockServer();
    mismatchServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, {
        items: [{ id: "u1", text: "wrong", document_id: VALID_DOCUMENT_ID, state: "valid" }],
        total: 1,
        limit: 2,
        offset: 0,
      });
    });
    const mismatch = await new HindsightAdapter({ baseUrl: mismatchServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(mismatch).toMatchObject({ ok: false, category: "validation" });
    expect(mismatch).not.toHaveProperty("ambiguous", true);
  });

  it("marks direct verify list timeout, network, 5xx, and malformed responses as ambiguous", async () => {
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    const documentQuery = new URLSearchParams({ document_id: VALID_DOCUMENT_ID, limit: "2" }).toString();

    const timeoutServer = await startMockServer();
    timeoutServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      json(res, 200, { items: [], total: 0, limit: 2, offset: 0 });
    });
    const timedOut = await new HindsightAdapter({
      baseUrl: timeoutServer.baseUrl,
      timeoutMs: 10,
    }).verifyOneUnitDocument(bankId, VALID_DOCUMENT_ID, "x");
    expect(timedOut).toMatchObject({ ok: false, category: "timeout", ambiguous: true });

    const network = await new HindsightAdapter({
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 100,
    }).verifyOneUnitDocument(bankId, VALID_DOCUMENT_ID, "x");
    expect(network).toMatchObject({ ok: false, ambiguous: true });
    expect(["network", "timeout"]).toContain((network as { category: string }).category);

    const http5xxServer = await startMockServer();
    http5xxServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });
    const http5xx = await new HindsightAdapter({ baseUrl: http5xxServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(http5xx).toMatchObject({ ok: false, category: "http", status: 503, ambiguous: true });

    const malformedServer = await startMockServer();
    malformedServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, { items: "not-an-array", total: 0, limit: 2, offset: 0 });
    });
    const malformed = await new HindsightAdapter({ baseUrl: malformedServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(malformed).toMatchObject({
      ok: false,
      category: "validation",
      ambiguous: true,
      reason: "post-write verification failed: list response was malformed",
    });

    const badJsonServer = await startMockServer();
    badJsonServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{bad");
    });
    const badJson = await new HindsightAdapter({ baseUrl: badJsonServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(badJson).toMatchObject({ ok: false, category: "malformed", ambiguous: true });
  });

  it("marks post-retain zero-unit and text-mismatch verification as ambiguous after an acknowledged POST", async () => {
    const bankId = VALID_BANK_ID;
    const encodedBank = encodeURIComponent(bankId);
    const documentQuery = new URLSearchParams({ document_id: VALID_DOCUMENT_ID, limit: "2" }).toString();

    const zeroServer = await startMockServer();
    zeroServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      json(res, 200, { success: true, bank_id: bankId, items_count: 1, async: false });
    });
    zeroServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, { items: [], total: 0, limit: 2, offset: 0 });
    });
    const zeroRetain = await new HindsightAdapter({ baseUrl: zeroServer.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(zeroRetain).toMatchObject({
      ok: false,
      category: "validation",
      ambiguous: true,
      reason: "post-write verification failed: expected exactly one live unit, found 0",
    });
    const zeroDirect = await new HindsightAdapter({ baseUrl: zeroServer.baseUrl }).verifyOneUnitDocument(
      bankId,
      VALID_DOCUMENT_ID,
      "x",
    );
    expect(zeroDirect).toMatchObject({ ok: false, category: "validation" });
    expect(zeroDirect).not.toHaveProperty("ambiguous", true);

    const mismatchServer = await startMockServer();
    mismatchServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories`, (_req, res) => {
      json(res, 200, { success: true, bank_id: bankId, items_count: 1, async: false });
    });
    mismatchServer.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?${documentQuery}`, (_req, res) => {
      json(res, 200, {
        items: [{ id: "u1", text: "wrong", document_id: VALID_DOCUMENT_ID, state: "valid" }],
        total: 1,
        limit: 2,
        offset: 0,
      });
    });
    const mismatchRetain = await new HindsightAdapter({ baseUrl: mismatchServer.baseUrl }).retainOneMemory({
      bankId,
      documentId: VALID_DOCUMENT_ID,
      text: "x",
      metadata: validMetadata(),
    });
    expect(mismatchRetain).toMatchObject({
      ok: false,
      category: "validation",
      ambiguous: true,
      reason: "post-write verification failed: stored text does not match expected text",
    });
  });

  it("recalls only source types, disables expansions, omits min_scores, validates inputs, and rejects unsupported observation items", async () => {
    const server = await startMockServer();
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    const adapter = await negotiateAdapter(server, "0.8.3");
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      expect(body).toEqual({
        query: "how to build",
        types: ["world", "experience"],
        budget: "mid",
        max_tokens: 1200,
        include: { entities: null, chunks: null, source_facts: null },
      });
      expect(body).not.toHaveProperty("min_scores");
      json(res, 200, {
        results: [
          {
            id: "r1",
            text: "Use `npm run build`.",
            type: "world",
            document_id: "doc-1",
            metadata: { logical_id: "m1", scope: "profile" },
            tags: ["pi-memory"],
            context: "cli",
            mentioned_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    });
    const recalled = await adapter.recall({ bankId: VALID_BANK_ID, query: "  how to build  ", budget: "mid", maxTokens: 1200 });
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          id: "r1",
          text: "Use `npm run build`.",
          type: "world",
          documentId: "doc-1",
          metadata: { logical_id: "m1", scope: "profile" },
          tags: ["pi-memory"],
          context: "cli",
          mentionedAt: "2026-01-01T00:00:00.000Z",
          scores: null,
        },
      ],
    });

    const server2 = await startMockServer();
    const adapter2 = await negotiateAdapter(server2, "0.8.3");
    server2.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, { results: [{ id: "x", text: "ok", type: "observation" }] });
    });
    const malformed = await adapter2.recall({
      bankId: VALID_BANK_ID,
      query: "q",
      budget: "low",
      maxTokens: 100,
    });
    expect(malformed).toMatchObject({ ok: false, category: "validation" });

    const inputRejected = await adapter.recall({ bankId: VALID_BANK_ID, query: "   ", budget: "low", maxTokens: 100 });
    expect(inputRejected).toMatchObject({ ok: false, category: "validation" });

    const tokenRejected = await adapter.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 0 });
    expect(tokenRejected).toMatchObject({ ok: false, category: "validation" });
  });

  it("fail-closes Recall before negotiation and applies version-aware score validation", async () => {
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    const unnegotiated = await startMockServer();
    const cold = new HindsightAdapter({ baseUrl: unnegotiated.baseUrl });
    const before = await cold.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 });
    expect(before).toMatchObject({
      ok: false,
      category: "validation",
      reason: "recall rejected: hindsight compatibility has not been negotiated",
    });
    expect(unnegotiated.requests).toHaveLength(0);

    const validScores = {
      final: 1.0986786712451455,
      reranker: null,
      semantic: 0.8,
      keyword: null,
    };

    const server083 = await startMockServer();
    const adapter083 = await negotiateAdapter(server083, "0.8.3");
    server083.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, {
        results: [{ id: "a", text: "ok", type: "world", document_id: "doc-a", scores: validScores }],
      });
    });
    await expect(
      adapter083.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ id: "a", scores: validScores }],
    });

    const absent083 = await startMockServer();
    const adapterAbsent = await negotiateAdapter(absent083, "0.8.3");
    absent083.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, { results: [{ id: "b", text: "ok", type: "world", document_id: "doc-b" }] });
    });
    await expect(
      adapterAbsent.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: true, value: [{ id: "b", scores: null }] });

    const server010 = await startMockServer();
    const adapter010 = await negotiateAdapter(server010, "0.10.0");
    server010.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).not.toHaveProperty("min_scores");
      json(res, 200, {
        results: [{ id: "c", text: "ok", type: "world", document_id: "doc-c", scores: validScores }],
      });
    });
    await expect(
      adapter010.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: true, value: [{ id: "c", scores: validScores }] });

    const minScoresServer = await startMockServer();
    const minScoresAdapter = await negotiateAdapter(minScoresServer, "0.10.0");
    minScoresServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).toMatchObject({ min_scores: { semantic: 0.5 } });
      json(res, 200, {
        results: [{ id: "ms", text: "ok", type: "world", document_id: "doc-ms", scores: validScores }],
      });
    });
    await expect(
      minScoresAdapter.recall({
        bankId: VALID_BANK_ID,
        query: "q",
        budget: "low",
        maxTokens: 100,
        minScore: 0.5,
      }),
    ).resolves.toMatchObject({ ok: true, value: [{ id: "ms", scores: validScores }] });

    const zeroScoreServer = await startMockServer();
    const zeroScoreAdapter = await negotiateAdapter(zeroScoreServer, "0.10.0");
    zeroScoreServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).not.toHaveProperty("min_scores");
      json(res, 200, {
        results: [{ id: "z", text: "ok", type: "world", document_id: "doc-z", scores: validScores }],
      });
    });
    await expect(
      zeroScoreAdapter.recall({
        bankId: VALID_BANK_ID,
        query: "q",
        budget: "low",
        maxTokens: 100,
        minScore: 0,
      }),
    ).resolves.toMatchObject({ ok: true });

    const legacyMinServer = await startMockServer();
    const legacyMinAdapter = await negotiateAdapter(legacyMinServer, "0.8.3");
    legacyMinServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).not.toHaveProperty("min_scores");
      json(res, 200, { results: [{ id: "l", text: "ok", type: "world", document_id: "doc-l" }] });
    });
    await expect(
      legacyMinAdapter.recall({
        bankId: VALID_BANK_ID,
        query: "q",
        budget: "low",
        maxTokens: 100,
        minScore: 0.5,
      }),
    ).resolves.toMatchObject({ ok: true, value: [{ id: "l", scores: null }] });

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.01] as const) {
      const badServer = await startMockServer();
      const badAdapter = await negotiateAdapter(badServer, "0.10.0");
      const rejected = await badAdapter.recall({
        bankId: VALID_BANK_ID,
        query: "q",
        budget: "low",
        maxTokens: 100,
        minScore: bad,
      });
      expect(rejected).toMatchObject({
        ok: false,
        category: "validation",
        reason: /minScore must be a finite number/,
      });
      expect(badServer.requests.filter((entry) => entry.url.includes("/memories/recall"))).toHaveLength(0);
    }

    const missing010 = await startMockServer();
    const adapterMissing = await negotiateAdapter(missing010, "0.10.0");
    missing010.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, { results: [{ id: "d", text: "ok", type: "world", document_id: "doc-d" }] });
    });
    await expect(
      adapterMissing.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: false, category: "validation", reason: /scores were required but absent/ });

    const malformedCases: unknown[] = [
      { final: "1.0", reranker: null, semantic: null, keyword: null },
      { final: [1], reranker: null, semantic: null, keyword: null },
      { final: { v: 1 }, reranker: null, semantic: null, keyword: null },
      { reranker: null, semantic: null, keyword: null },
      { final: 1.1, reranker: "x", semantic: null, keyword: null },
      { final: 1.1, reranker: null, semantic: {}, keyword: null },
      { final: 1.1, reranker: null, semantic: null, keyword: "0.1" },
      null,
      "scores",
      [validScores],
    ];
    for (const scores of malformedCases) {
      const badServer = await startMockServer();
      const badAdapter = await negotiateAdapter(badServer, "0.10.0");
      badServer.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
        json(res, 200, {
          results: [{ id: "e", text: "ok", type: "world", document_id: "doc-e", scores }],
        });
      });
      const rejected = await badAdapter.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 });
      expect(rejected).toMatchObject({ ok: false, category: "validation" });
    }

    // JSON cannot encode NaN/Infinity; prove the validator rejects them directly, and
    // that JSON-nullified final (the wire-equivalent of those literals) also fails closed.
    const nullFinal = await startMockServer();
    const nullFinalAdapter = await negotiateAdapter(nullFinal, "0.10.0");
    nullFinal.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, {
        results: [
          {
            id: "nan",
            text: "ok",
            type: "world",
            document_id: "doc-nan",
            scores: { final: Number.NaN, reranker: null, semantic: null, keyword: null },
          },
        ],
      });
    });
    await expect(
      nullFinalAdapter.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: false, category: "validation" });

    // One malformed item rejects the complete response even when siblings are valid.
    const partial = await startMockServer();
    const partialAdapter = await negotiateAdapter(partial, "0.10.0");
    partial.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, {
        results: [
          { id: "ok", text: "ok", type: "world", document_id: "doc-ok", scores: validScores },
          { id: "bad", text: "bad", type: "world", document_id: "doc-bad", scores: { final: "nope", reranker: null, semantic: null, keyword: null } },
        ],
      });
    });
    await expect(
      partialAdapter.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: false, category: "validation" });

    // Present-but-malformed scores also fail closed on 0.8.3.
    const presentBad083 = await startMockServer();
    const presentBadAdapter = await negotiateAdapter(presentBad083, "0.8.3");
    presentBad083.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, {
        results: [{ id: "f", text: "ok", type: "world", document_id: "doc-f", scores: { final: "x", reranker: null, semantic: null, keyword: null } }],
      });
    });
    await expect(
      presentBadAdapter.recall({ bankId: VALID_BANK_ID, query: "q", budget: "low", maxTokens: 100 }),
    ).resolves.toMatchObject({ ok: false, category: "validation" });
  });

  it("uses reflect only through the dedicated endpoint and validates the response and input bounds", async () => {
    const server = await startMockServer();
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/reflect`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).toEqual({ query: "summarize", budget: "low", max_tokens: 80 });
      json(res, 200, { text: "summary" });
    });
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
    const reflected = await adapter.reflect({ bankId: VALID_BANK_ID, query: "summarize", budget: "low", maxTokens: 80 });
    expect(reflected).toEqual({ ok: true, value: { text: "summary" } });
    expect(server.requests.some((request) => request.url.includes("/memories/recall"))).toBe(false);

    const inputRejected = await adapter.reflect({ bankId: VALID_BANK_ID, query: " ", budget: "low", maxTokens: 80 });
    expect(inputRejected).toMatchObject({ ok: false, category: "validation" });
  });

  it("defaults reflectTimeoutMs to REFLECT_HTTP_TIMEOUT_MS, independent of the ordinary httpTimeoutMs ceiling", () => {
    const adapter = new HindsightAdapter({ baseUrl: "http://127.0.0.1:9" });
    expect(adapter.httpTimeoutMs).toBe(10_000);
    expect(adapter.reflectTimeoutMs).toBe(REFLECT_HTTP_TIMEOUT_MS);

    const overridden = new HindsightAdapter({ baseUrl: "http://127.0.0.1:9", reflectTimeoutMs: 60_000 });
    expect(overridden.reflectTimeoutMs).toBe(60_000);

    const clamped = new HindsightAdapter({ baseUrl: "http://127.0.0.1:9", reflectTimeoutMs: 999_000 });
    expect(clamped.reflectTimeoutMs).toBe(REFLECT_HTTP_TIMEOUT_MS);
  });

  it("gives reflect a distinct, longer request budget than ordinary requests on the same adapter, and still times out past its own ceiling", async () => {
    const server = await startMockServer();
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/reflect`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      json(res, 200, { text: "slow but successful summary" });
    });
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      json(res, 200, { results: [] });
    });

    // The ordinary ceiling (10ms) is far shorter than the 40ms server delay,
    // so recall must time out while reflect (200ms budget) succeeds.
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl, timeoutMs: 10, reflectTimeoutMs: 200 });
    installCompatibleVersion(server, "0.8.3");
    await expect(adapter.checkCompatibility()).resolves.toMatchObject({ ok: true });
    expect(adapter.httpTimeoutMs).toBe(10);
    expect(adapter.reflectTimeoutMs).toBe(200);

    const reflected = await adapter.reflect({ bankId: VALID_BANK_ID, query: "summarize", budget: "low", maxTokens: 80 });
    expect(reflected).toEqual({ ok: true, value: { text: "slow but successful summary" } });

    const recalled = await adapter.recall({ bankId: VALID_BANK_ID, query: "summarize", budget: "low", maxTokens: 80 });
    expect(recalled).toMatchObject({ ok: false, category: "timeout" });

    const server2 = await startMockServer();
    server2.setRoute("POST", `/v1/default/banks/${encodedBank}/reflect`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      json(res, 200, { text: "too slow" });
    });
    const tightAdapter = new HindsightAdapter({ baseUrl: server2.baseUrl, reflectTimeoutMs: 20 });
    const timedOut = await tightAdapter.reflect({ bankId: VALID_BANK_ID, query: "summarize", budget: "low", maxTokens: 80 });
    expect(timedOut).toMatchObject({ ok: false, category: "timeout" });
  });

  it("lets external cancellation abort reflect promptly, without waiting for the reflect ceiling and without being mislabeled as timeout", async () => {
    const server = await startMockServer();
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/reflect`, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      json(res, 200, { text: "never seen" });
    });
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl, reflectTimeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = adapter.reflect(
      { bankId: VALID_BANK_ID, query: "summarize", budget: "low", maxTokens: 80 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, category: "aborted" });
  });

  it("forgets via document delete and requires verified absence postconditions, including idempotent retry semantics", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const documentId = VALID_DOCUMENT_ID;
    const encodedBank = encodeURIComponent(bankId);
    const encodedDocument = encodeURIComponent(documentId);
    server.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`, (_req, res) => {
      json(res, 200, { items: [], total: 0, limit: 2, offset: 0 });
    });
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
    const deleted = await adapter.deleteMemoryDocument(bankId, documentId);
    expect(deleted).toEqual({ ok: true, value: { deleted: true, alreadyAbsent: false, memoryUnitsDeleted: 1 } });

    const server2 = await startMockServer();
    server2.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    server2.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    server2.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`, (_req, res) => {
      json(res, 200, { items: [], total: 0, limit: 2, offset: 0 });
    });
    const alreadyAbsent = await new HindsightAdapter({ baseUrl: server2.baseUrl }).deleteMemoryDocument(bankId, documentId);
    expect(alreadyAbsent).toEqual({
      ok: true,
      value: { deleted: false, alreadyAbsent: true, memoryUnitsDeleted: 0 },
    });
  });

  it("fetchExactOneUnitDocument cross-checks document GET and list with real 0.8.3 shapes", async () => {
    const bankId = VALID_BANK_ID;
    const documentId = VALID_DOCUMENT_ID;
    const text = "exact memory text";
    const expectedHash = textHash(text);
    const metadata = validMetadata({ content_hash: expectedHash });

    const okServer = await startMockServer();
    wireExactFetchRoutes(okServer, bankId, documentId, text);
    const ok = await new HindsightAdapter({ baseUrl: okServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(ok).toEqual({ ok: true, value: { text, unitId: "u1", metadata } });
    expect(okServer.requests.map((r) => `${r.method} ${r.url}`).sort()).toEqual(
      [
        `GET /v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
        `GET /v1/default/banks/${encodeURIComponent(bankId)}/memories/list?document_id=${encodeURIComponent(documentId)}&limit=2`,
      ].sort(),
    );

    const nullUnitMetaServer = await startMockServer();
    wireExactFetchRoutes(nullUnitMetaServer, bankId, documentId, text, {
      listOverrides: { metadata: null },
    });
    const nullUnitMeta = await new HindsightAdapter({ baseUrl: nullUnitMetaServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(nullUnitMeta).toEqual({ ok: true, value: { text, unitId: "u1", metadata } });

    const matchingUnitMetaServer = await startMockServer();
    wireExactFetchRoutes(matchingUnitMetaServer, bankId, documentId, text, {
      listOverrides: { metadata },
    });
    const matchingUnitMeta = await new HindsightAdapter({
      baseUrl: matchingUnitMetaServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(matchingUnitMeta).toEqual({ ok: true, value: { text, unitId: "u1", metadata } });

    const dupServer = await startMockServer();
    wireExactFetchRoutes(dupServer, bankId, documentId, text, {
      listOverrides: {
        items: [
          { id: "u1", text, document_id: documentId, state: "valid", metadata: null },
          { id: "u2", text, document_id: documentId, state: "valid", metadata: null },
        ],
        total: 2,
      },
    });
    const dup = await new HindsightAdapter({ baseUrl: dupServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(dup).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const zeroListServer = await startMockServer();
    wireExactFetchRoutes(zeroListServer, bankId, documentId, text, { listOverrides: { total: 0 } });
    const zeroList = await new HindsightAdapter({ baseUrl: zeroListServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(zeroList).toMatchObject({ ok: false, category: "validation" });

    const wrongListDocServer = await startMockServer();
    wireExactFetchRoutes(wrongListDocServer, bankId, documentId, text, {
      listOverrides: { wrongDocId: "pi-memory:deadbeef" },
    });
    const wrongListDoc = await new HindsightAdapter({ baseUrl: wrongListDocServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(wrongListDoc).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const wrongListTextServer = await startMockServer();
    wireExactFetchRoutes(wrongListTextServer, bankId, documentId, text, {
      listOverrides: { wrongText: "different text" },
    });
    const wrongListText = await new HindsightAdapter({
      baseUrl: wrongListTextServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(wrongListText).toMatchObject({ ok: false, category: "validation" });

    const badUnitMetaServer = await startMockServer();
    wireExactFetchRoutes(badUnitMetaServer, bankId, documentId, text, {
      listOverrides: { metadata: { logical_id: "1" } },
    });
    const badUnitMeta = await new HindsightAdapter({ baseUrl: badUnitMetaServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(badUnitMeta).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const malformedUnitMetaServer = await startMockServer();
    wireExactFetchRoutes(malformedUnitMetaServer, bankId, documentId, text, {
      list: {
        items: [{ id: "u1", text, document_id: documentId, state: "valid", metadata: { logical_id: 1 } }],
        total: 1,
        limit: 2,
        offset: 0,
      },
    });
    const malformedUnitMeta = await new HindsightAdapter({
      baseUrl: malformedUnitMetaServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(malformedUnitMeta).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const doc404Server = await startMockServer();
    wireExactFetchRoutes(doc404Server, bankId, documentId, text, { docStatus: 404, doc: { error: "missing" } });
    const doc404 = await new HindsightAdapter({ baseUrl: doc404Server.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(doc404).toMatchObject({ ok: false, ambiguous: true });

    const doc5xxServer = await startMockServer();
    wireExactFetchRoutes(doc5xxServer, bankId, documentId, text, { docStatus: 500, doc: { error: "boom" } });
    const doc5xx = await new HindsightAdapter({ baseUrl: doc5xxServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(doc5xx).toMatchObject({ ok: false, ambiguous: true });

    const malformedDocServer = await startMockServer();
    wireExactFetchRoutes(malformedDocServer, bankId, documentId, text, { doc: { document_id: documentId } });
    const malformedDoc = await new HindsightAdapter({ baseUrl: malformedDocServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(malformedDoc).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const wrongDocIdServer = await startMockServer();
    wireExactFetchRoutes(wrongDocIdServer, bankId, documentId, text, {
      docOverrides: { wrongId: "pi-memory:other" },
    });
    const wrongDocId = await new HindsightAdapter({ baseUrl: wrongDocIdServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(wrongDocId).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const wrongBankServer = await startMockServer();
    wireExactFetchRoutes(wrongBankServer, bankId, documentId, text, {
      docOverrides: { wrongBankId: "pi-memory-hindsight:profile:wrong" },
    });
    const wrongBank = await new HindsightAdapter({ baseUrl: wrongBankServer.baseUrl }).fetchExactOneUnitDocument(
      bankId,
      documentId,
      expectedHash,
    );
    expect(wrongBank).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const wrongDocBodyServer = await startMockServer();
    wireExactFetchRoutes(wrongDocBodyServer, bankId, documentId, text, {
      docOverrides: { originalText: "different body", wrongHash: textHash("different body") },
    });
    const wrongDocBody = await new HindsightAdapter({
      baseUrl: wrongDocBodyServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(wrongDocBody).toMatchObject({ ok: false, category: "validation" });

    const wrongDocHashServer = await startMockServer();
    wireExactFetchRoutes(wrongDocHashServer, bankId, documentId, text, {
      docOverrides: { wrongHash: "0".repeat(64) },
    });
    const wrongDocHash = await new HindsightAdapter({
      baseUrl: wrongDocHashServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(wrongDocHash).toMatchObject({ ok: false, category: "validation" });

    const missingDocMetaServer = await startMockServer();
    wireExactFetchRoutes(missingDocMetaServer, bankId, documentId, text, {
      docOverrides: { documentMetadata: null },
    });
    const missingDocMeta = await new HindsightAdapter({
      baseUrl: missingDocMetaServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(missingDocMeta).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const zeroUnitsDocServer = await startMockServer();
    wireExactFetchRoutes(zeroUnitsDocServer, bankId, documentId, text, {
      docOverrides: { memoryUnitCount: 0 },
    });
    const zeroUnitsDoc = await new HindsightAdapter({
      baseUrl: zeroUnitsDocServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(zeroUnitsDoc).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const twoUnitsDocServer = await startMockServer();
    wireExactFetchRoutes(twoUnitsDocServer, bankId, documentId, text, {
      docOverrides: { memoryUnitCount: 2 },
    });
    const twoUnitsDoc = await new HindsightAdapter({
      baseUrl: twoUnitsDocServer.baseUrl,
    }).fetchExactOneUnitDocument(bankId, documentId, expectedHash);
    expect(twoUnitsDoc).toMatchObject({ ok: false, category: "validation", ambiguous: true });
  });

  it("rejects forget when postconditions fail or pagination is inconsistent", async () => {
    const server = await startMockServer();
    const bankId = VALID_BANK_ID;
    const documentId = VALID_DOCUMENT_ID;
    const encodedBank = encodeURIComponent(bankId);
    const encodedDocument = encodeURIComponent(documentId);
    server.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    server.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { document_id: documentId });
    });

    const result = await new HindsightAdapter({ baseUrl: server.baseUrl }).deleteMemoryDocument(bankId, documentId);
    expect(result).toMatchObject({ ok: false, category: "validation", ambiguous: true });

    const server2 = await startMockServer();
    server2.setRoute("DELETE", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 200, { success: true, message: "deleted", document_id: documentId, memory_units_deleted: 1 });
    });
    server2.setRoute("GET", `/v1/default/banks/${encodedBank}/documents/${encodedDocument}`, (_req, res) => {
      json(res, 404, { error: "missing" });
    });
    server2.setRoute("GET", `/v1/default/banks/${encodedBank}/memories/list?document_id=${encodedDocument}&limit=2`, (_req, res) => {
      json(res, 200, { items: [], total: 1, limit: 2, offset: 0 });
    });
    const paged = await new HindsightAdapter({ baseUrl: server2.baseUrl }).deleteMemoryDocument(bankId, documentId);
    expect(paged).toMatchObject({ ok: false, category: "validation", ambiguous: true });
  });
});

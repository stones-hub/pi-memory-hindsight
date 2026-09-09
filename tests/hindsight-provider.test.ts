import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { profileBankId } from "../src/identity/bank-id.js";
import { HindsightAdapter } from "../src/provider/hindsight-adapter.js";
import { HttpClient } from "../src/provider/http-client.js";
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
});

describe("HindsightAdapter", () => {
  it("checks exact health/version compatibility and rejects malformed capability responses", async () => {
    const server = await startMockServer();
    server.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    server.setRoute("GET", "/version", (_req, res) =>
      json(res, 200, { api_version: "0.8.3", features: { bank_config_api: true } }),
    );
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
    await expect(adapter.checkCompatibility()).resolves.toEqual({
      ok: true,
      value: { healthy: true, apiVersion: "0.8.3", bankConfigApiEnabled: true },
    });

    const server2 = await startMockServer();
    server2.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    server2.setRoute("GET", "/version", (_req, res) => json(res, 200, { api_version: 83, features: null }));
    const bad = await new HindsightAdapter({ baseUrl: server2.baseUrl }).checkCompatibility();
    expect(bad).toMatchObject({ ok: false, category: "validation" });

    const server3 = await startMockServer();
    server3.setRoute("GET", "/health", (_req, res) => json(res, 200, { status: "healthy", database: "ok" }));
    server3.setRoute("GET", "/version", (_req, res) =>
      json(res, 200, { api_version: "0.8.0", features: { bank_config_api: true } }),
    );
    const exact = await new HindsightAdapter({ baseUrl: server3.baseUrl }).checkCompatibility();
    expect(exact).toMatchObject({ ok: false, category: "validation" });
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

  it("recalls only source types, disables expansions, validates inputs, and rejects unsupported observation items", async () => {
    const server = await startMockServer();
    const encodedBank = encodeURIComponent(VALID_BANK_ID);
    server.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res, bodyText) => {
      expect(JSON.parse(bodyText)).toEqual({
        query: "how to build",
        types: ["world", "experience"],
        budget: "mid",
        max_tokens: 1200,
        include: { entities: null, chunks: null, source_facts: null },
      });
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
    const adapter = new HindsightAdapter({ baseUrl: server.baseUrl });
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
        },
      ],
    });

    const server2 = await startMockServer();
    server2.setRoute("POST", `/v1/default/banks/${encodedBank}/memories/recall`, (_req, res) => {
      json(res, 200, { results: [{ id: "x", text: "ok", type: "observation" }] });
    });
    const malformed = await new HindsightAdapter({ baseUrl: server2.baseUrl }).recall({
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

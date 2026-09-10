import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIsolatedPiEnv,
  deriveDisposableLiveBankId,
  isLoopbackHttpUrl,
  normalizeAnsi,
} from "../src/testing/acceptance-helpers.js";
import { runLiveHindsightAcceptance, validateLiveAcceptanceEnv } from "../src/testing/live-hindsight-acceptance.js";
import { startMockHindsightServer, type MockHindsightServer } from "../src/testing/mock-hindsight.js";

describe("acceptance helpers", () => {
  it("normalizes ANSI output and preserves visible text", () => {
    expect(normalizeAnsi("\u001b[31mHello\u001b[0m\r\nWorld")).toBe("Hello\nWorld");
  });

  it("accepts only explicit loopback http urls", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:8888")).toBe(true);
    expect(isLoopbackHttpUrl("https://localhost:4443")).toBe(true);
    expect(isLoopbackHttpUrl("http://192.168.1.2:8888")).toBe(false);
    expect(isLoopbackHttpUrl("file:///tmp/nope")).toBe(false);
  });

  it("builds isolated pi env without mutating caller globals", () => {
    const env = buildIsolatedPiEnv(
      {
        rootDir: "/tmp/root",
        homeDir: "/tmp/root/home",
        agentDir: "/tmp/root/agent",
        sessionDir: "/tmp/root/sessions",
        projectDir: "/tmp/root/project",
        npmCacheDir: "/tmp/root/npm-cache",
      },
      { EXTRA_FLAG: "1" },
    );
    expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/root/agent");
    expect(env.PI_OFFLINE).toBe("1");
    expect(env.EXTRA_FLAG).toBe("1");
  });
});

describe("live hindsight acceptance gates", () => {
  it("derives a strict disposable bank id from nonce", () => {
    const bankId = deriveDisposableLiveBankId("nonce-1234");
    expect(bankId).toMatch(/^pi-memory-hindsight:project:[0-9a-f]{32}$/);
  });

  it("rejects missing acceptance env gates", () => {
    expect(() => validateLiveAcceptanceEnv({})).toThrow(/PI_MEMORY_HINDSIGHT_LIVE_ACCEPT=1/);
    expect(() =>
      validateLiveAcceptanceEnv({
        PI_MEMORY_HINDSIGHT_LIVE_ACCEPT: "1",
        PI_MEMORY_HINDSIGHT_BASE_URL: "http://example.com",
        PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION: "0.8.3",
        PI_MEMORY_HINDSIGHT_LIVE_NONCE: "nonce-1234",
        PI_MEMORY_HINDSIGHT_LIVE_BANK_ID: deriveDisposableLiveBankId("nonce-1234"),
      }),
    ).toThrow(/loopback/);
  });

  it("rejects mismatched disposable bank ids", () => {
    expect(() =>
      validateLiveAcceptanceEnv({
        PI_MEMORY_HINDSIGHT_LIVE_ACCEPT: "1",
        PI_MEMORY_HINDSIGHT_BASE_URL: "http://127.0.0.1:8888",
        PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION: "0.8.3",
        PI_MEMORY_HINDSIGHT_LIVE_NONCE: "nonce-1234",
        PI_MEMORY_HINDSIGHT_LIVE_BANK_ID: deriveDisposableLiveBankId("other-1234"),
      }),
    ).toThrow(/does not match/);
  });

  it("accepts fully gated loopback live config", () => {
    const bankId = deriveDisposableLiveBankId("nonce-1234");
    expect(
      validateLiveAcceptanceEnv({
        PI_MEMORY_HINDSIGHT_LIVE_ACCEPT: "1",
        PI_MEMORY_HINDSIGHT_BASE_URL: "http://127.0.0.1:8888",
        PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION: "0.8.3",
        PI_MEMORY_HINDSIGHT_LIVE_NONCE: "nonce-1234",
        PI_MEMORY_HINDSIGHT_LIVE_BANK_ID: bankId,
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8888",
      bankId,
      apiKey: undefined,
    });
  });
});

describe("live hindsight acceptance runner (mock)", () => {
  let server: MockHindsightServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  function buildEnv(nonce: string, baseUrl: string) {
    return {
      PI_MEMORY_HINDSIGHT_LIVE_ACCEPT: "1",
      PI_MEMORY_HINDSIGHT_BASE_URL: baseUrl,
      PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION: "0.8.3",
      PI_MEMORY_HINDSIGHT_LIVE_NONCE: nonce,
      PI_MEMORY_HINDSIGHT_LIVE_BANK_ID: deriveDisposableLiveBankId(nonce),
    };
  }

  it("proves retain/recall/replace/cleanup end to end and touches only the owned bank", async () => {
    server = await startMockHindsightServer();
    const env = buildEnv("mock-run-1234", server.baseUrl);

    const evidence = await runLiveHindsightAcceptance(env);

    expect(evidence.ok).toBe(true);
    expect(evidence.recallContainedExpectedItem).toBe(true);
    expect(evidence.bankDeleteAcknowledged).toBe(true);
    expect(evidence.knownDocumentAbsenceProven).toBe(true);
    expect(evidence.bankAbsenceEndpointUnavailable).toBe(true);
    expect(evidence.cleanupOperationallyComplete).toBe(true);
    expect(evidence.retainedHash).toBe(
      createHash("sha256").update("Synthetic live acceptance memory updated.").digest("hex"),
    );
    expect(evidence.routes).toContain("DELETE /v1/default/banks/{bankId}");
    expect(evidence.routes.some((route) => /banks$/.test(route) || /list.*banks/i.test(route))).toBe(false);

    const bankId = env.PI_MEMORY_HINDSIGHT_LIVE_BANK_ID;
    for (const entry of server.journal) {
      if (entry.path === "/health" || entry.path === "/version") continue;
      expect(entry.path.startsWith(`/v1/default/banks/${encodeURIComponent(bankId)}`)).toBe(true);
    }
    // The mock recreates an empty bank entry on any subsequent request for a
    // deleted bank id (mirroring real "no persistent bank" behavior), so the
    // meaningful postcondition is "no documents survived", not "map entry gone".
    expect(server.getBank(bankId)?.documents.size ?? 0).toBe(0);
  });

  it("throws the primary error alone when only the write path fails", async () => {
    server = await startMockHindsightServer({ fail: { retain: 500 } });
    const env = buildEnv("mock-run-5678", server.baseUrl);

    await expect(runLiveHindsightAcceptance(env)).rejects.toThrow(/live retain failed/);
  });

  it("throws the cleanup error alone when only cleanup fails", async () => {
    server = await startMockHindsightServer({ fail: { bank_delete: 500 } });
    const env = buildEnv("mock-run-9012", server.baseUrl);

    await expect(runLiveHindsightAcceptance(env)).rejects.toThrow(/bank delete was not acknowledged/);
  });

  it("preserves both failures via AggregateError when primary and cleanup both fail", async () => {
    server = await startMockHindsightServer({ fail: { retain: 500, bank_delete: 500 } });
    const env = buildEnv("mock-run-3456", server.baseUrl);

    try {
      await runLiveHindsightAcceptance(env);
      expect.unreachable("expected runLiveHindsightAcceptance to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(String(aggregate.errors[0])).toMatch(/live retain failed/);
      expect(String(aggregate.errors[1])).toMatch(/bank delete was not acknowledged/);
    }
  });

  it("rejects a non-owned bank id at the mock boundary (defense in depth)", async () => {
    server = await startMockHindsightServer();
    const response = await fetch(`${server.baseUrl}/v1/default/banks/not-an-owned-bank-id`, { method: "PUT" });
    expect(response.status).toBe(403);
  });

  it("rejects a legacy/fabricated bank-delete response that lacks a valid DeleteResponse shape", async () => {
    server = await startMockHindsightServer({ malformed: { bank_delete: true } });
    const env = buildEnv("mock-run-7890", server.baseUrl);

    await expect(runLiveHindsightAcceptance(env)).rejects.toThrow(/bank delete was not acknowledged/);
  });

  it("proves same-document replacement: identical document_id, exactly one surviving unit with the updated text, old text absent, and a truthful recomputed logical_id", async () => {
    server = await startMockHindsightServer();
    const bankId = deriveDisposableLiveBankId("mock-run-replace");
    const documentId = "pi-memory-hindsight:memory:00000000000000000000000000000001";
    const initialText = "Synthetic live acceptance memory.";
    const updatedText = "Synthetic live acceptance memory updated.";
    const initialLogicalId = createHash("sha256").update(initialText).digest("hex").slice(0, 32);
    const updatedLogicalId = createHash("sha256").update(updatedText).digest("hex").slice(0, 32);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-01T00:00:01.000Z";

    await fetch(`${server.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}`, { method: "PUT" });
    await fetch(`${server.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            content: initialText,
            document_id: documentId,
            update_mode: "replace",
            metadata: { logical_id: initialLogicalId, created_at: createdAt, updated_at: createdAt },
          },
        ],
        async: false,
      }),
    });
    await fetch(`${server.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            content: updatedText,
            document_id: documentId,
            update_mode: "replace",
            metadata: { logical_id: updatedLogicalId, created_at: createdAt, updated_at: updatedAt },
          },
        ],
        async: false,
      }),
    });

    const listResponse = await fetch(
      `${server.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?document_id=${encodeURIComponent(documentId)}&limit=2`,
    );
    const listed = (await listResponse.json()) as {
      total: number;
      items: Array<{ text: string; document_id: string; metadata: Record<string, string> | null }>;
    };

    expect(listed.total).toBe(1);
    expect(listed.items).toHaveLength(1);
    const [unit] = listed.items;
    expect(unit?.document_id).toBe(documentId);
    expect(unit?.text).toBe(updatedText);
    expect(unit?.text).not.toBe(initialText);
    expect(unit?.metadata).toBeNull();

    const documentResponse = await fetch(
      `${server.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
    );
    const document = (await documentResponse.json()) as {
      id: string;
      original_text: string;
      document_metadata: Record<string, string>;
    };
    expect(document.id).toBe(documentId);
    expect(document.original_text).toBe(updatedText);
    expect(document.document_metadata.logical_id).toBe(updatedLogicalId);
    expect(document.document_metadata.logical_id).not.toBe(initialLogicalId);
    expect(document.document_metadata.created_at).toBe(createdAt);
    expect(document.document_metadata.updated_at).toBe(updatedAt);
    expect(document.document_metadata.updated_at! > document.document_metadata.created_at!).toBe(true);
  });
});

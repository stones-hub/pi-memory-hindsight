import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { validateBankId } from "../provider/validation.js";
import { OWNED_BANK_CONFIG_OVERRIDES } from "../provider/types.js";

type RouteName =
  | "health"
  | "version"
  | "bank_put"
  | "bank_config_patch"
  | "bank_config_get"
  | "retain"
  | "list"
  | "recall"
  | "document_get"
  | "document_delete"
  | "bank_delete";

export interface MockHindsightMode {
  latencyMs?: number;
  unhealthy?: boolean;
  malformedVersion?: boolean;
  /** Exact `/version` api_version body. Defaults to `0.8.3`. */
  apiVersion?: "0.8.3" | "0.10.0";
  /**
   * When true, recall results include a valid score object. Defaults to true
   * for `apiVersion=0.10.0` and false for `0.8.3`.
   */
  includeRecallScores?: boolean;
  configDrift?: boolean;
  fail?: Partial<Record<RouteName, number>>;
  malformed?: Partial<Record<RouteName, boolean>>;
  ambiguousRetain?: boolean;
  ambiguousDelete?: boolean;
}

export interface MockHindsightJournalEntry {
  method: string;
  path: string;
  route: RouteName | "unknown";
  status: number;
  durationMs: number;
  authPresent: boolean;
  bodySummary: Record<string, unknown> | null;
}

interface MemoryUnit {
  id: string;
  text: string;
  documentId: string;
  metadata: Record<string, string>;
  state: "valid";
}

interface BankState {
  config: Record<string, unknown>;
  documents: Map<string, MemoryUnit[]>;
}

export interface MockHindsightServer {
  baseUrl: string;
  journal: MockHindsightJournalEntry[];
  setMode(mode: MockHindsightMode): void;
  reset(): void;
  close(): Promise<void>;
  getBank(bankId: string): BankState | undefined;
}

const DEFAULT_VERSION_FEATURES = {
  observations: true,
  worker: true,
  bank_config_api: true,
  raw_document_storage: true,
  llm_tracing: true,
  audit_log: false,
};

function versionBody(apiVersion: "0.8.3" | "0.10.0"): Record<string, unknown> {
  return {
    api_version: apiVersion,
    features: { ...DEFAULT_VERSION_FEATURES },
  };
}

function defaultIncludeRecallScores(mode: MockHindsightMode): boolean {
  if (mode.includeRecallScores !== undefined) return mode.includeRecallScores;
  return (mode.apiVersion ?? "0.8.3") === "0.10.0";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function buildDocumentGetBody(bankId: string, documentId: string, units: MemoryUnit[]): Record<string, unknown> {
  const unit = units[0]!;
  const originalText = unit.text;
  const internalNow = new Date().toISOString();
  return {
    id: documentId,
    bank_id: bankId,
    original_text: originalText,
    content_hash: contentHash(originalText),
    created_at: internalNow,
    updated_at: internalNow,
    memory_unit_count: units.length,
    nodes_by_fact_type: {},
    tags: [],
    document_metadata: unit.metadata,
    retain_params: {},
    observation_scopes: {},
  };
}

function summarizeBody(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return { kind: typeof value };
  }
  const body = value as Record<string, unknown>;
  if (Array.isArray(body.items)) {
    return {
      keys: Object.keys(body).sort(),
      itemsCount: body.items.length,
      documentIds: body.items
        .map((item) => (typeof item === "object" && item && "document_id" in item ? String((item as Record<string, unknown>).document_id) : null))
        .filter((item): item is string => item !== null),
      contentHashes: body.items
        .map((item) => (typeof item === "object" && item && "content" in item ? hashText(String((item as Record<string, unknown>).content)) : null))
        .filter((item): item is string => item !== null),
    };
  }
  if ("updates" in body && typeof body.updates === "object" && body.updates !== null) {
    return {
      keys: Object.keys(body).sort(),
      updateKeys: Object.keys(body.updates as Record<string, unknown>).sort(),
    };
  }
  return { keys: Object.keys(body).sort() };
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function parseBankId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/default\/banks\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

function readRequestJson(bodyText: string): unknown {
  return bodyText.length === 0 ? {} : JSON.parse(bodyText);
}

export async function startMockHindsightServer(initialMode: MockHindsightMode = {}): Promise<MockHindsightServer> {
  const journal: MockHindsightJournalEntry[] = [];
  const banks = new Map<string, BankState>();
  let mode: MockHindsightMode = { ...initialMode };
  let nextUnitId = 1;

  function getOrCreateBank(bankId: string): BankState {
    let bank = banks.get(bankId);
    if (!bank) {
      bank = {
        config: { ...OWNED_BANK_CONFIG_OVERRIDES },
        documents: new Map<string, MemoryUnit[]>(),
      };
      banks.set(bankId, bank);
    }
    return bank;
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    const finish = (status: number, route: RouteName | "unknown", bodySummary: Record<string, unknown> | null): void => {
      journal.push({
        method,
        path: `${pathname}${url.search}`,
        route,
        status,
        durationMs: Date.now() - startedAt,
        authPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        bodySummary,
      });
    };

    await delay(mode.latencyMs ?? 0);

    if (method === "GET" && pathname === "/health") {
      const status = mode.fail?.health ?? 200;
      if (status !== 200) {
        finish(status, "health", null);
        return json(res, status, { error: "health failed" });
      }
      finish(200, "health", null);
      return json(res, 200, { status: mode.unhealthy ? "unhealthy" : "healthy", database: "ok" });
    }

    if (method === "GET" && pathname === "/version") {
      const status = mode.fail?.version ?? 200;
      if (status !== 200) {
        finish(status, "version", null);
        return json(res, status, { error: "version failed" });
      }
      if (mode.malformedVersion || mode.malformed?.version) {
        finish(200, "version", null);
        return json(res, 200, { api_version: 83, features: null });
      }
      finish(200, "version", null);
      return json(res, 200, versionBody(mode.apiVersion ?? "0.8.3"));
    }

    const bankId = parseBankId(pathname);
    if (!bankId || !validateBankId(bankId).ok) {
      finish(403, "unknown", summarizeBody(bodyText ? { textLength: bodyText.length } : null));
      return json(res, 403, { error: "non-owned bank access rejected" });
    }

    if (method === "PUT" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}`) {
      const status = mode.fail?.bank_put ?? 200;
      if (status !== 200) {
        finish(status, "bank_put", summarizeBody(readRequestJson(bodyText)));
        return json(res, status, { error: "bank put failed" });
      }
      getOrCreateBank(bankId);
      finish(200, "bank_put", summarizeBody(readRequestJson(bodyText)));
      return json(res, 200, { success: true, bank_id: bankId });
    }

    if (method === "DELETE" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}`) {
      const status = mode.fail?.bank_delete ?? 200;
      if (status !== 200) {
        finish(status, "bank_delete", null);
        return json(res, status, { error: "bank delete failed" });
      }
      const bank = getOrCreateBank(bankId);
      const documentsDeleted = [...bank.documents.keys()].length;
      banks.delete(bankId);
      finish(200, "bank_delete", null);
      if (mode.malformed?.bank_delete) {
        // Legacy/fabricated shape carrying fields the real 0.8.3
        // DeleteResponse never has, used to prove the validator rejects it.
        return json(res, 200, { success: true, bank_id: bankId, documents_deleted: documentsDeleted });
      }
      // Real Hindsight 0.8.3 api_delete_bank returns DeleteResponse(success,
      // message, deleted_count) only; it never includes bank_id or
      // documents_deleted as top-level fields.
      return json(res, 200, { success: true, message: `deleted bank ${bankId}`, deleted_count: documentsDeleted });
    }

    if (method === "PATCH" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/config`) {
      const parsed = readRequestJson(bodyText) as { updates?: Record<string, unknown> };
      const status = mode.fail?.bank_config_patch ?? 200;
      if (status !== 200) {
        finish(status, "bank_config_patch", summarizeBody(parsed));
        return json(res, status, { error: "config patch failed" });
      }
      const bank = getOrCreateBank(bankId);
      bank.config = { ...bank.config, ...(parsed.updates ?? {}) };
      finish(200, "bank_config_patch", summarizeBody(parsed));
      return json(res, 200, { ok: true });
    }

    if (method === "GET" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/config`) {
      const status = mode.fail?.bank_config_get ?? 200;
      if (status !== 200) {
        finish(status, "bank_config_get", null);
        return json(res, status, { error: "config get failed" });
      }
      const bank = getOrCreateBank(bankId);
      const config = mode.configDrift ? { ...bank.config, retain_chunk_size: 1024 } : bank.config;
      if (mode.malformed?.bank_config_get) {
        finish(200, "bank_config_get", null);
        return json(res, 200, { bank_id: bankId, config: null, overrides: {} });
      }
      finish(200, "bank_config_get", null);
      return json(res, 200, {
        bank_id: bankId,
        config,
        overrides: { ...OWNED_BANK_CONFIG_OVERRIDES },
      });
    }

    if (method === "POST" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/memories`) {
      const parsed = readRequestJson(bodyText) as { items?: Array<Record<string, unknown>>; async?: boolean };
      const status = mode.fail?.retain ?? 200;
      if (status !== 200) {
        finish(status, "retain", summarizeBody(parsed));
        return json(res, status, { error: "retain failed" });
      }
      const bank = getOrCreateBank(bankId);
      const item = parsed.items?.[0];
      if (!item || typeof item.content !== "string" || typeof item.document_id !== "string") {
        finish(400, "retain", summarizeBody(parsed));
        return json(res, 400, { error: "bad retain input" });
      }
      const unit: MemoryUnit = {
        id: `unit-${nextUnitId++}`,
        text: item.content,
        documentId: item.document_id,
        metadata: ((item.metadata ?? {}) as Record<string, string>) || {},
        state: "valid",
      };
      bank.documents.set(item.document_id, mode.ambiguousRetain ? [unit, { ...unit, id: `unit-${nextUnitId++}` }] : [unit]);
      if (mode.malformed?.retain) {
        finish(200, "retain", summarizeBody(parsed));
        return json(res, 200, { success: true, bank_id: bankId, items_count: 2, async: false });
      }
      finish(200, "retain", summarizeBody(parsed));
      return json(res, 200, { success: true, bank_id: bankId, items_count: 1, async: false });
    }

    if (method === "GET" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list`) {
      const status = mode.fail?.list ?? 200;
      if (status !== 200) {
        finish(status, "list", null);
        return json(res, status, { error: "list failed" });
      }
      const documentId = url.searchParams.get("document_id") ?? "";
      const bank = getOrCreateBank(bankId);
      const items = bank.documents.get(documentId) ?? [];
      if (mode.malformed?.list) {
        finish(200, "list", null);
        return json(res, 200, { items: "not-an-array", total: 1, limit: 2, offset: 0 });
      }
      finish(200, "list", null);
      return json(res, 200, {
        items: items.map((item) => ({
          id: item.id,
          text: item.text,
          document_id: item.documentId,
          metadata: null,
          state: item.state,
          type: "world",
        })),
        total: items.length,
        limit: Number(url.searchParams.get("limit") ?? 2),
        offset: 0,
      });
    }

    if (method === "POST" && pathname === `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`) {
      const parsed = readRequestJson(bodyText) as { query?: string };
      const status = mode.fail?.recall ?? 200;
      if (status !== 200) {
        finish(status, "recall", summarizeBody(parsed));
        return json(res, status, { error: "recall failed" });
      }
      if (mode.malformed?.recall) {
        finish(200, "recall", summarizeBody(parsed));
        return json(res, 200, { results: [{ id: "oops", text: 1 }] });
      }
      const bank = getOrCreateBank(bankId);
      const withScores = defaultIncludeRecallScores(mode);
      const results = [...bank.documents.values()]
        .flat()
        .map((item) => ({
          id: item.id,
          text: item.text,
          type: "world",
          document_id: item.documentId,
          metadata: item.metadata,
          tags: ["pi-memory-hindsight"],
          context: null,
          mentioned_at: null,
          ...(withScores
            ? {
                scores: {
                  final: 1.0986786712451455,
                  reranker: 0.91,
                  semantic: null,
                  keyword: 0.42,
                },
              }
            : {}),
        }));
      finish(200, "recall", summarizeBody(parsed));
      return json(res, 200, { results });
    }

    const documentPrefix = `/v1/default/banks/${encodeURIComponent(bankId)}/documents/`;
    if (pathname.startsWith(documentPrefix)) {
      const documentId = decodeURIComponent(pathname.slice(documentPrefix.length));
      const bank = getOrCreateBank(bankId);

      if (method === "GET") {
        const status = mode.fail?.document_get ?? 200;
        if (status !== 200) {
          finish(status, "document_get", null);
          return json(res, status, { error: "document get failed" });
        }
        const items = bank.documents.get(documentId);
        if (!items || items.length === 0) {
          finish(404, "document_get", null);
          return json(res, 404, { error: "missing" });
        }
        if (mode.malformed?.document_get) {
          finish(200, "document_get", null);
          return json(res, 200, { document_id: documentId });
        }
        finish(200, "document_get", null);
        return json(res, 200, buildDocumentGetBody(bankId, documentId, items));
      }

      if (method === "DELETE") {
        const status = mode.fail?.document_delete ?? 200;
        if (status !== 200) {
          finish(status, "document_delete", null);
          return json(res, status, { error: "document delete failed" });
        }
        const items = bank.documents.get(documentId);
        if (!items || items.length === 0) {
          finish(404, "document_delete", null);
          return json(res, 404, { error: "missing" });
        }
        if (!mode.ambiguousDelete) {
          bank.documents.delete(documentId);
        }
        if (mode.malformed?.document_delete) {
          finish(200, "document_delete", null);
          return json(res, 200, { success: true, document_id: documentId });
        }
        finish(200, "document_delete", null);
        return json(res, 200, {
          success: true,
          message: "deleted",
          document_id: documentId,
          memory_units_deleted: items.length,
        });
      }
    }

    finish(404, "unknown", bodyText ? { bodyLength: bodyText.length } : null);
    json(res, 404, { error: routeKey(method, pathname) });
  }

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    journal,
    setMode(nextMode) {
      mode = { ...nextMode };
    },
    reset() {
      mode = {};
      journal.length = 0;
      banks.clear();
      nextUnitId = 1;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        (server as Server).close((err) => (err ? reject(err) : resolve()));
      });
    },
    getBank(bankId: string) {
      return banks.get(bankId);
    },
  };
}

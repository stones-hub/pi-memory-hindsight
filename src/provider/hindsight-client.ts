/**
 * Typed bindings for the exact Hindsight 0.8.3 HTTP endpoints the Extension
 * uses, confirmed against a local instance's `/openapi.json` and live
 * request/response round trips (hindsight-contract.md). This module speaks
 * the wire format (snake_case) verbatim; `hindsight-adapter.ts` translates to
 * and from the Extension's domain types and applies governance policy.
 */

import type { HttpClient } from "./http-client.js";
import type { ProviderResult } from "./types.js";

export interface HealthResponse {
  status: string;
  database: string;
}

export interface VersionResponse {
  api_version: string;
  features: Record<string, boolean>;
}

export interface BankConfigResponse {
  bank_id: string;
  config: Record<string, unknown>;
  overrides: Record<string, unknown>;
}

export interface MemoryItemWire {
  content: string;
  document_id?: string;
  metadata?: Record<string, string>;
  timestamp?: string;
  update_mode?: "replace";
}

export interface RetainRequestWire {
  items: MemoryItemWire[];
  async: false;
}

export interface RetainResponseWire {
  success: boolean;
  bank_id: string;
  items_count: number;
  async: boolean;
}

export interface ListMemoryUnitWire {
  id: string;
  text: string;
  type?: string | null;
  document_id?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[] | null;
  context?: string | null;
  mentioned_at?: string | null;
  state?: string;
}

export interface ListMemoryUnitsResponseWire {
  items: ListMemoryUnitWire[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeleteDocumentResponseWire {
  success: boolean;
  message: string;
  document_id: string;
  memory_units_deleted: number;
}

export interface RecallRequestWire {
  query: string;
  types?: string[];
  budget?: "low" | "mid" | "high";
  max_tokens?: number;
  include?: {
    entities?: null;
    chunks?: null;
    source_facts?: null;
  };
}

export interface RecallResultWire {
  id: string;
  text: string;
  type?: string | null;
  document_id?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[] | null;
  context?: string | null;
  mentioned_at?: string | null;
}

export interface RecallResponseWire {
  results: RecallResultWire[];
}

export interface ReflectRequestWire {
  query: string;
  budget?: "low" | "mid" | "high";
  max_tokens?: number;
}

export interface ReflectResponseWire {
  text: string;
}

export class HindsightClient {
  constructor(private readonly http: HttpClient) {}

  private withSignal(signal?: AbortSignal): { signal?: AbortSignal } {
    return signal ? { signal } : {};
  }

  health(signal?: AbortSignal): Promise<ProviderResult<HealthResponse>> {
    return this.http.request<HealthResponse>("GET", "/health", this.withSignal(signal));
  }

  version(signal?: AbortSignal): Promise<ProviderResult<VersionResponse>> {
    return this.http.request<VersionResponse>("GET", "/version", this.withSignal(signal));
  }

  /** Idempotent bank create/update. Body is intentionally empty: no deprecated disposition/mission fields. */
  createOrUpdateBank(bankId: string, signal?: AbortSignal): Promise<ProviderResult<unknown>> {
    return this.http.request("PUT", `/v1/default/banks/${encodeURIComponent(bankId)}`, {
      body: {},
      ...this.withSignal(signal),
    });
  }

  getBankConfig(bankId: string, signal?: AbortSignal): Promise<ProviderResult<BankConfigResponse>> {
    return this.http.request<BankConfigResponse>(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}/config`,
      this.withSignal(signal),
    );
  }

  patchBankConfig(
    bankId: string,
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ProviderResult<BankConfigResponse>> {
    return this.http.request<BankConfigResponse>(
      "PATCH",
      `/v1/default/banks/${encodeURIComponent(bankId)}/config`,
      { body: { updates }, ...this.withSignal(signal) },
    );
  }

  retainMemories(
    bankId: string,
    request: RetainRequestWire,
    signal?: AbortSignal,
  ): Promise<ProviderResult<RetainResponseWire>> {
    return this.http.request<RetainResponseWire>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      { body: request, ...this.withSignal(signal) },
    );
  }

  listMemoriesByDocument(
    bankId: string,
    documentId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ListMemoryUnitsResponseWire>> {
    return this.http.request<ListMemoryUnitsResponseWire>(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list`,
      { query: { document_id: documentId, limit }, ...this.withSignal(signal) },
    );
  }

  deleteDocument(
    bankId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<DeleteDocumentResponseWire>> {
    return this.http.request<DeleteDocumentResponseWire>(
      "DELETE",
      `/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
      this.withSignal(signal),
    );
  }

  getDocument(bankId: string, documentId: string, signal?: AbortSignal): Promise<ProviderResult<unknown>> {
    return this.http.request(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
      this.withSignal(signal),
    );
  }

  recall(
    bankId: string,
    request: RecallRequestWire,
    signal?: AbortSignal,
  ): Promise<ProviderResult<RecallResponseWire>> {
    return this.http.request<RecallResponseWire>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      { body: request, ...this.withSignal(signal) },
    );
  }

  reflect(
    bankId: string,
    request: ReflectRequestWire,
    signal?: AbortSignal,
  ): Promise<ProviderResult<ReflectResponseWire>> {
    return this.http.request<ReflectResponseWire>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/reflect`,
      { body: request, ...this.withSignal(signal) },
    );
  }
}

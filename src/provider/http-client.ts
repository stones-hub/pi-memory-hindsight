/**
 * Minimal HTTP client for the Hindsight API
 * (hindsight-contract.md "Compatibility and startup checks", "Authentication").
 *
 * Responsibilities kept deliberately narrow: URL/auth handling, timeout and
 * external cancellation, bounded response reading, and redacted error
 * messages. No retry policy lives here — retry/reconciliation is a governance
 * concern driven by the local operation ledger, not a transport concern.
 */

import type { ProviderFailureCategory, ProviderResult } from "./types.js";

/** Per-request HTTP timeout ceiling. Mutation leases are derived from this bound. */
export const PROVIDER_HTTP_TIMEOUT_MS = 10_000;

/**
 * Effective provider HTTP timeout: requested values above the ceiling are
 * clamped so the durable mutation lease always outlasts every bounded call chain.
 */
export function clampProviderHttpTimeoutMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return PROVIDER_HTTP_TIMEOUT_MS;
  }
  return Math.min(requested, PROVIDER_HTTP_TIMEOUT_MS);
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;

class ResponseReadError extends Error {
  constructor(
    readonly category: ProviderFailureCategory,
    readonly label: string,
  ) {
    super(label);
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** External cancellation, e.g. extension shutdown. Combined with the per-call timeout. */
  signal?: AbortSignal;
}

/**
 * Reads a Response body up to `maxBytes`, aborting the underlying stream and
 * throwing rather than buffering an oversized or unbounded (chunked) body.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new ResponseReadError("oversize", "oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseReadError("oversize", "oversized");
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): URL {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function failure(
  reason: string,
  category: ProviderFailureCategory,
  method: string,
  status?: number,
): Extract<ProviderResult<never>, { ok: false }> {
  return {
    ok: false,
    reason,
    category,
    ...(status !== undefined ? { status } : {}),
    ...(isMutationMethod(method) && (category === "timeout" || category === "aborted" || category === "network" || category === "http")
      ? { ambiguous: status === undefined || status >= 500 }
      : {}),
  };
}

export class HttpClient {
  readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.timeoutMs = clampProviderHttpTimeoutMs(opts.timeoutMs);
    this.opts = { ...opts, timeoutMs: this.timeoutMs };
  }

  private readonly opts: HttpClientOptions;

  private authHeaders(): Record<string, string> {
    if (!this.opts.apiKey) return {};
    return { Authorization: `Bearer ${this.opts.apiKey}` };
  }

  async request<T>(
    method: "GET" | "PUT" | "PATCH" | "DELETE" | "POST",
    path: string,
    options: RequestOptions = {},
  ): Promise<ProviderResult<T>> {
    const url = buildUrl(this.opts.baseUrl, path, options.query);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const maxBytes = this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxRequestBytes = this.opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.authHeaders(),
        },
        signal,
      };
      if (options.body !== undefined) {
        const encodedBody = JSON.stringify(options.body);
        if (Buffer.byteLength(encodedBody, "utf8") > maxRequestBytes) {
          return failure(`hindsight request rejected (oversized): ${method} ${path}`, "oversize", method);
        }
        init.body = encodedBody;
      }
      response = await fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return failure(`hindsight request timed out: ${method} ${path}`, "timeout", method);
      }
      if (err instanceof Error && err.name === "AbortError") {
        return failure(`hindsight request cancelled: ${method} ${path}`, "aborted", method);
      }
      return failure(`hindsight request failed: ${method} ${path}`, "network", method);
    }

    let text: string;
    try {
      text = await readBoundedText(response, maxBytes);
    } catch (err) {
      if (err instanceof ResponseReadError) {
        return {
          ok: false,
          reason: `hindsight response rejected (${err.label}): ${method} ${path}`,
          category: err.category,
          ...(isMutationMethod(method) ? { ambiguous: true } : {}),
        };
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        return {
          ok: false,
          reason: `hindsight response read timed out: ${method} ${path}`,
          category: "timeout",
          ...(isMutationMethod(method) ? { ambiguous: true } : {}),
        };
      }
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          reason: `hindsight response read cancelled: ${method} ${path}`,
          category: "aborted",
          ...(isMutationMethod(method) ? { ambiguous: true } : {}),
        };
      }
      return {
        ok: false,
        reason: `hindsight response read failed: ${method} ${path}`,
        category: "network",
        ...(isMutationMethod(method) ? { ambiguous: true } : {}),
      };
    }

    if (!response.ok) {
      return failure(`hindsight ${method} ${path} failed: HTTP ${response.status}`, "http", method, response.status);
    }

    if (text.length === 0) {
      return { ok: true, value: undefined as T };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return {
        ok: false,
        reason: `hindsight response rejected (non-json): ${method} ${path}`,
        category: "malformed",
        ...(isMutationMethod(method) ? { ambiguous: true } : {}),
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        reason: `hindsight response was not valid JSON: ${method} ${path}`,
        category: "malformed",
        ...(isMutationMethod(method) ? { ambiguous: true } : {}),
      };
    }
  }
}

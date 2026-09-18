import { createHash } from "node:crypto";
import { HindsightAdapter } from "../provider/hindsight-adapter.js";
import { buildOwnedDocumentId } from "../provider/validation.js";
import { deriveDisposableLiveBankId, isLoopbackHttpUrl } from "./acceptance-helpers.js";

export interface LiveAcceptanceEnv {
  PI_MEMORY_HINDSIGHT_LIVE_ACCEPT?: string;
  PI_MEMORY_HINDSIGHT_BASE_URL?: string;
  PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION?: string;
  PI_MEMORY_HINDSIGHT_LIVE_NONCE?: string;
  PI_MEMORY_HINDSIGHT_LIVE_BANK_ID?: string;
  HINDSIGHT_API_KEY?: string;
}

export interface LiveAcceptanceEvidence {
  ok: boolean;
  routes: string[];
  expectedApiVersion: "0.8.3" | "0.10.0";
  negotiatedApiVersion: string | null;
  retainedDocumentId: string;
  retainedHash: string | null;
  recalledCount: number;
  recallContainedExpectedItem: boolean;
  recallScoresValidated: boolean | null;
  bankDeleteAcknowledged: boolean;
  knownDocumentAbsenceProven: boolean;
  bankAbsenceEndpointUnavailable: boolean;
  cleanupOperationallyComplete: boolean;
}

const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_TEXT_LENGTH = 65536;

interface RequestJsonResult {
  status: number;
  ok: boolean;
  json: unknown;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

// Bounded, content-type-checked, redacted-on-failure JSON request helper. Never
// exposes the API key, request/response body, or unparsed URL query in any
// thrown error, so acceptance evidence and failure messages stay safe to log.
async function requestJson(
  method: string,
  url: string,
  apiKey: string | undefined,
  body?: unknown,
): Promise<RequestJsonResult> {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown error";
    throw new Error(`live acceptance request failed: ${method} ${redactUrl(url)}: ${name}`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_TEXT_LENGTH) {
    throw new Error(`live acceptance response exceeded bounded size: ${method} ${redactUrl(url)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (text.length === 0 || !contentType.includes("application/json")) {
    return { status: response.status, ok: response.ok, json: null };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json };
}

// Hindsight 0.8.3's DELETE /v1/default/banks/{bank_id} has response_model
// DeleteResponse: required success:boolean, optional message:string|null,
// optional deleted_count:integer|null. It never returns bank_id or
// documents_deleted. Validate against exactly that contract (allow-listing
// keys) so a legacy/fabricated shape carrying those nonexistent fields is
// rejected rather than accidentally accepted.
const DELETE_RESPONSE_ALLOWED_KEYS = new Set(["success", "message", "deleted_count"]);

function isValidBankDeleteResponse(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const value = json as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!DELETE_RESPONSE_ALLOWED_KEYS.has(key)) return false;
  }
  if (value.success !== true) return false;
  if ("message" in value && value.message !== null && typeof value.message !== "string") return false;
  if ("deleted_count" in value && value.deleted_count !== null && !Number.isInteger(value.deleted_count)) return false;
  return true;
}

export function validateLiveAcceptanceEnv(env: LiveAcceptanceEnv): {
  baseUrl: string;
  bankId: string;
  expectedApiVersion: "0.8.3" | "0.10.0";
  apiKey?: string;
} {
  if (env.PI_MEMORY_HINDSIGHT_LIVE_ACCEPT !== "1") {
    throw new Error("refusing live acceptance: PI_MEMORY_HINDSIGHT_LIVE_ACCEPT=1 is required");
  }
  const baseUrl = env.PI_MEMORY_HINDSIGHT_BASE_URL?.trim();
  if (!baseUrl || !isLoopbackHttpUrl(baseUrl)) {
    throw new Error("refusing live acceptance: PI_MEMORY_HINDSIGHT_BASE_URL must be explicit loopback http(s)");
  }
  const expectedApiVersion = env.PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION?.trim();
  if (expectedApiVersion !== "0.8.3" && expectedApiVersion !== "0.10.0") {
    throw new Error("refusing live acceptance: PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION must equal 0.8.3 or 0.10.0");
  }
  const nonce = env.PI_MEMORY_HINDSIGHT_LIVE_NONCE?.trim();
  const bankId = env.PI_MEMORY_HINDSIGHT_LIVE_BANK_ID?.trim();
  if (!nonce || !bankId) {
    throw new Error("refusing live acceptance: both PI_MEMORY_HINDSIGHT_LIVE_NONCE and PI_MEMORY_HINDSIGHT_LIVE_BANK_ID are required");
  }
  const expectedBankId = deriveDisposableLiveBankId(nonce);
  if (bankId !== expectedBankId) {
    throw new Error("refusing live acceptance: supplied bank id does not match the disposable live-acceptance nonce");
  }
  return {
    baseUrl,
    bankId,
    expectedApiVersion,
    ...(env.HINDSIGHT_API_KEY ? { apiKey: env.HINDSIGHT_API_KEY } : {}),
  };
}

interface PrimaryFlowResult {
  routes: string[];
  negotiatedApiVersion: string | null;
  retainedDocumentId: string;
  retainedHash: string | null;
  recalledCount: number;
  recallContainedExpectedItem: boolean;
  recallScoresValidated: boolean | null;
}

// Retains one synthetic memory, proves recall surfaces the exact item, then
// replaces the SAME document id in place (requirement: stable documentId /
// created_at, monotonic updated_at) and re-proves exactly one unit survives
// with the new text and the old text is gone. Never calls reflect().
async function runPrimaryFlow(
  adapter: HindsightAdapter,
  baseUrl: string,
  bankId: string,
  apiKey: string | undefined,
  expectedApiVersion: "0.8.3" | "0.10.0",
  documentId: string,
  initialText: string,
  updatedText: string,
  projectIdentity: string,
): Promise<PrimaryFlowResult> {
  const routes: string[] = [];

  const compat = await adapter.checkCompatibility(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  routes.push("GET /health", "GET /version");
  if (!compat.ok) throw new Error(`live acceptance compatibility failed: ${compat.reason}`);
  if (compat.value.apiVersion !== expectedApiVersion) {
    throw new Error(
      `live acceptance negotiated api_version ${compat.value.apiVersion} did not match expected ${expectedApiVersion}`,
    );
  }
  const negotiatedApiVersion = adapter.getNegotiatedApiVersion();

  const bankCreate = await requestJson("PUT", `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}`, apiKey, {});
  routes.push("PUT /v1/default/banks/{bankId}");
  if (!bankCreate.ok) throw new Error(`live acceptance bank create failed with HTTP ${bankCreate.status}`);

  const bankPatch = await requestJson(
    "PATCH",
    `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/config`,
    apiKey,
    { updates: { retain_extraction_mode: "chunks", retain_chunk_size: 2048, enable_observations: false, enable_auto_consolidation: false } },
  );
  routes.push("PATCH /v1/default/banks/{bankId}/config");
  if (!bankPatch.ok) throw new Error(`live acceptance bank config patch failed with HTTP ${bankPatch.status}`);

  const bankConfig = await requestJson("GET", `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/config`, apiKey);
  routes.push("GET /v1/default/banks/{bankId}/config");
  if (!bankConfig.ok) throw new Error(`live acceptance bank config get failed with HTTP ${bankConfig.status}`);

  const initialTimestamp = new Date().toISOString();
  const metadata = {
    logical_id: "live-acceptance-doc",
    content_hash: textHash(initialText),
    scope: "project",
    memory_type: "decision",
    verification_state: "verified",
    created_at: initialTimestamp,
    updated_at: initialTimestamp,
    last_verified_at: initialTimestamp,
    project_identity: projectIdentity,
    source_ref: "acceptance:live",
  };

  const retained = await adapter.retainOneMemory({ bankId, documentId, text: initialText, metadata });
  routes.push("POST /v1/default/banks/{bankId}/memories", "GET /v1/default/banks/{bankId}/memories/list");
  if (!retained.ok) throw new Error(`live retain failed: ${retained.reason}`);

  const recalled = await adapter.recall({ bankId, query: "Synthetic live", budget: "low", maxTokens: 200 });
  routes.push("POST /v1/default/banks/{bankId}/memories/recall");
  if (!recalled.ok) throw new Error(`live recall failed: ${recalled.reason}`);
  const matched = recalled.value.find((item) => item.documentId === documentId && item.text === initialText);
  const recallContainedExpectedItem = matched !== undefined;
  if (!recallContainedExpectedItem) {
    throw new Error("live recall did not contain the exact synthetic expected item");
  }

  let recallScoresValidated: boolean | null = null;
  if (expectedApiVersion === "0.10.0") {
    if (!matched?.scores || typeof matched.scores.final !== "number" || !Number.isFinite(matched.scores.final)) {
      throw new Error("live recall 0.10.0 score shape was missing or final was not a finite number");
    }
    recallScoresValidated = true;
  } else {
    recallScoresValidated = null;
  }

  let updatedTimestamp = new Date().toISOString();
  while (updatedTimestamp <= initialTimestamp) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    updatedTimestamp = new Date().toISOString();
  }
  const replaced = await adapter.retainOneMemory({
    bankId,
    documentId,
    text: updatedText,
    metadata: {
      ...metadata,
      content_hash: textHash(updatedText),
      updated_at: updatedTimestamp,
      last_verified_at: updatedTimestamp,
    },
  });
  if (!replaced.ok) throw new Error(`live replace failed: ${replaced.reason}`);

  const reverified = await adapter.verifyOneUnitDocument(bankId, documentId, updatedText);
  if (!reverified.ok) throw new Error(`live replace verification failed: ${reverified.reason}`);

  return {
    routes,
    negotiatedApiVersion,
    retainedDocumentId: documentId,
    retainedHash: textHash(updatedText),
    recalledCount: recalled.value.length,
    recallContainedExpectedItem,
    recallScoresValidated,
  };
}

interface CleanupResult {
  routes: string[];
  bankDeleteAcknowledged: boolean;
  knownDocumentAbsenceProven: boolean;
  bankAbsenceEndpointUnavailable: boolean;
  cleanupOperationallyComplete: boolean;
}

// Cleanup never relies on a bank config GET 404 to infer bank absence (no such
// endpoint reliably signals bank absence in Hindsight 0.8.3). It DELETEs the
// bank, validates the DeleteResponse shape/success, then proves the known
// document id is unreachable (404 get + zero-item list) as an operational
// absence proof. `bankAbsenceEndpointUnavailable` is always true: this
// permanent gap is reported, never faked.
async function runCleanup(
  baseUrl: string,
  bankId: string,
  apiKey: string | undefined,
  documentId: string,
): Promise<CleanupResult> {
  const routes: string[] = [];

  const bankDelete = await requestJson("DELETE", `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}`, apiKey);
  routes.push("DELETE /v1/default/banks/{bankId}");
  const bankDeleteAcknowledged = bankDelete.status === 200 && isValidBankDeleteResponse(bankDelete.json);
  if (!bankDeleteAcknowledged) {
    throw new Error(`live acceptance cleanup: bank delete was not acknowledged (HTTP ${bankDelete.status})`);
  }

  const documentGet = await requestJson(
    "GET",
    `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
    apiKey,
  );
  routes.push("GET /v1/default/banks/{bankId}/documents/{documentId}");

  const documentList = await requestJson(
    "GET",
    `${baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?document_id=${encodeURIComponent(documentId)}&limit=2`,
    apiKey,
  );
  routes.push("GET /v1/default/banks/{bankId}/memories/list");

  const listJson = documentList.json as { total?: unknown; items?: unknown } | null;
  const knownDocumentAbsenceProven =
    documentGet.status === 404 &&
    documentList.status === 200 &&
    listJson !== null &&
    listJson.total === 0 &&
    Array.isArray(listJson.items) &&
    listJson.items.length === 0;
  if (!knownDocumentAbsenceProven) {
    throw new Error("live acceptance cleanup: could not prove known-document absence after bank delete");
  }

  return {
    routes,
    bankDeleteAcknowledged,
    knownDocumentAbsenceProven,
    bankAbsenceEndpointUnavailable: true,
    cleanupOperationallyComplete: bankDeleteAcknowledged && knownDocumentAbsenceProven,
  };
}

export async function runLiveHindsightAcceptance(env: LiveAcceptanceEnv): Promise<LiveAcceptanceEvidence> {
  const { baseUrl, bankId, expectedApiVersion, apiKey } = validateLiveAcceptanceEnv(env);
  const adapter = new HindsightAdapter({ baseUrl, apiKey, timeoutMs: REQUEST_TIMEOUT_MS });
  const initialText = "Synthetic live acceptance memory.";
  const updatedText = "Synthetic live acceptance memory updated.";
  const projectIdentity = `live-acceptance-${env.PI_MEMORY_HINDSIGHT_LIVE_NONCE!.trim().toLowerCase()}`;
  const documentId = buildOwnedDocumentId("project", projectIdentity, "decision", "live-acceptance-doc");

  let primary: PrimaryFlowResult | undefined;
  let primaryError: unknown;
  try {
    primary = await runPrimaryFlow(
      adapter,
      baseUrl,
      bankId,
      apiKey,
      expectedApiVersion,
      documentId,
      initialText,
      updatedText,
      projectIdentity,
    );
  } catch (error) {
    primaryError = error;
  }

  let cleanup: CleanupResult | undefined;
  let cleanupError: unknown;
  try {
    cleanup = await runCleanup(baseUrl, bankId, apiKey, documentId);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "live acceptance failed and cleanup also failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;

  const primaryResult = primary!;
  const cleanupResult = cleanup!;
  return {
    ok: true,
    routes: [...primaryResult.routes, ...cleanupResult.routes],
    expectedApiVersion,
    negotiatedApiVersion: primaryResult.negotiatedApiVersion,
    retainedDocumentId: primaryResult.retainedDocumentId,
    retainedHash: primaryResult.retainedHash,
    recalledCount: primaryResult.recalledCount,
    recallContainedExpectedItem: primaryResult.recallContainedExpectedItem,
    recallScoresValidated: primaryResult.recallScoresValidated,
    bankDeleteAcknowledged: cleanupResult.bankDeleteAcknowledged,
    knownDocumentAbsenceProven: cleanupResult.knownDocumentAbsenceProven,
    bankAbsenceEndpointUnavailable: cleanupResult.bankAbsenceEndpointUnavailable,
    cleanupOperationallyComplete: cleanupResult.cleanupOperationallyComplete,
  };
}

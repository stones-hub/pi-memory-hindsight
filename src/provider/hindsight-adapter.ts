/**
 * Governed Hindsight 0.8.3 adapter (hindsight-contract.md, architecture.md
 * "Bank and identity model").
 *
 * This is the only module allowed to talk to Hindsight. It enforces:
 * - compatibility/capability checks before any write;
 * - fail-closed owned-bank configuration (create, override, verify readback);
 * - the one-memory-per-document representation with mandatory post-write
 *   verification (retain does not return unit IDs);
 * - document-delete as the sole physical-forget path, with postcondition
 *   verification;
 * - source-types-only, expansion-disabled recall with a bounded budget;
 * - manual-only reflect.
 *
 * It never lists banks and never manages configuration on a bank other than
 * the exact owned bank ID it was asked to operate on.
 */

import { createHash } from "node:crypto";
import { HttpClient, clampReflectHttpTimeoutMs } from "./http-client.js";
import { HindsightClient } from "./hindsight-client.js";
import {
  validateBankId,
  validateDocumentId,
  validateListWindow,
  validateQueryInput,
  validateRetainMetadata,
} from "./validation.js";
import {
  OWNED_BANK_CONFIG_OVERRIDES,
  type CompatibilityCheck,
  type DeleteDocumentOutput,
  type ProviderResult,
  type ReflectInput,
  type ReflectOutput,
  type RecallInput,
  type RecallResultItem,
  type RetainOneMemoryInput,
  type RetainOneMemoryOutput,
} from "./types.js";

export interface HindsightAdapterOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  /**
   * Per-call timeout for the manual, read-only Reflect request only
   * (docs/decisions/reflect-long-running-timeout.md). Defaults to and is
   * clamped at `REFLECT_HTTP_TIMEOUT_MS`; does not affect Recall, governed
   * mutations, or any other ordinary request's `PROVIDER_HTTP_TIMEOUT_MS` ceiling.
   */
  reflectTimeoutMs?: number;
}

const SUPPORTED_API_VERSION = "0.8.3";
const MAX_RECALL_RESULTS = 50;
const MAX_TEXT_LENGTH = 4_000;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 512;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 128;
const MAX_CONTEXT_LENGTH = 2_000;

function failLike<T>(base: ProviderResult<unknown>, reason: string): ProviderResult<T> {
  if (base.ok) {
    return { ok: false, reason, category: "validation" };
  }
  return {
    ok: false,
    reason,
    category: base.category,
    ...(base.status !== undefined ? { status: base.status } : {}),
    ...(base.ambiguous !== undefined ? { ambiguous: base.ambiguous } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function validateMetadata(metadata: unknown): Record<string, string> | null {
  if (metadata === null || metadata === undefined) return null;
  if (!isStringRecord(metadata)) return null;
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_ENTRIES) return null;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) return null;
    if (value.length > MAX_METADATA_VALUE_LENGTH) return null;
  }
  return metadata;
}

function hashNormalizedText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function metadataRecordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i]!;
    if (key !== bKeys[i]) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

type ValidatedOwnedDocument = {
  originalText: string;
  documentMetadata: Record<string, string>;
};

function validateOwnedDocumentWire(
  raw: unknown,
  bankId: string,
  documentId: string,
  expectedTextHash: string,
): { ok: true; value: ValidatedOwnedDocument } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "document response was malformed" };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.id !== documentId) {
    return { ok: false, reason: "stored document id does not match" };
  }
  if (doc.bank_id !== bankId) {
    return { ok: false, reason: "stored bank id does not match" };
  }
  if (
    typeof doc.original_text !== "string" ||
    doc.original_text.length === 0 ||
    doc.original_text.length > MAX_TEXT_LENGTH
  ) {
    return { ok: false, reason: "document original text is invalid" };
  }
  if (typeof doc.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(doc.content_hash)) {
    return { ok: false, reason: "document content hash is invalid" };
  }
  const normalizedText = doc.original_text.trim();
  const normalizedHash = hashNormalizedText(doc.original_text);
  if (doc.content_hash !== expectedTextHash || doc.content_hash !== normalizedHash) {
    return { ok: false, reason: "document content hash mismatch" };
  }
  const documentMetadata = validateMetadata(doc.document_metadata);
  if (!documentMetadata) {
    return { ok: false, reason: "document metadata is invalid" };
  }
  if (doc.memory_unit_count !== 1) {
    return { ok: false, reason: "document memory unit count is not exactly one" };
  }
  return { ok: true, value: { originalText: normalizedText, documentMetadata } };
}

function validateTags(tags: unknown): string[] | null {
  if (tags === null || tags === undefined) return null;
  if (!Array.isArray(tags)) return null;
  if (tags.length > MAX_TAGS) return null;
  if (!tags.every((tag) => typeof tag === "string" && tag.length <= MAX_TAG_LENGTH)) return null;
  return tags;
}

function validateOptionalString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

export class HindsightAdapter {
  private readonly client: HindsightClient;
  /** Effective per-request HTTP timeout after ceiling clamp (≤ PROVIDER_HTTP_TIMEOUT_MS). */
  readonly httpTimeoutMs: number;
  /** Effective Reflect-only timeout after ceiling clamp (≤ REFLECT_HTTP_TIMEOUT_MS). */
  readonly reflectTimeoutMs: number;

  constructor(options: HindsightAdapterOptions) {
    const http = new HttpClient({
      baseUrl: options.baseUrl,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    this.httpTimeoutMs = http.timeoutMs;
    this.reflectTimeoutMs = clampReflectHttpTimeoutMs(options.reflectTimeoutMs);
    this.client = new HindsightClient(http);
  }

  /**
   * Verifies the deployment is reachable and speaks a compatible API/feature
   * set. Callers must disable memory (fail closed) on any `ok: false`.
   */
  async checkCompatibility(signal?: AbortSignal): Promise<ProviderResult<CompatibilityCheck>> {
    const health = await this.client.health(signal);
    if (!health.ok) {
      return failLike(health, `hindsight health check failed: ${health.reason}`);
    }
    if (typeof health.value.status !== "string" || health.value.status !== "healthy") {
      return { ok: false, reason: "hindsight reported unhealthy status", category: "validation" };
    }
    const version = await this.client.version(signal);
    if (!version.ok) {
      return failLike(version, `hindsight version check failed: ${version.reason}`);
    }
    const apiVersion = version.value.api_version;
    if (typeof apiVersion !== "string" || typeof version.value.features !== "object" || version.value.features === null) {
      return { ok: false, reason: "hindsight version response was malformed", category: "validation" };
    }
    if (apiVersion !== SUPPORTED_API_VERSION) {
      return {
        ok: false,
        reason: `hindsight api_version ${apiVersion} is not compatible with supported baseline ${SUPPORTED_API_VERSION}`,
        category: "validation",
      };
    }
    const bankConfigApiEnabled = version.value.features.bank_config_api === true;
    if (!bankConfigApiEnabled) {
      return {
        ok: false,
        reason: "hindsight deployment does not expose the bank configuration API",
        category: "validation",
      };
    }
    return {
      ok: true,
      value: { healthy: true, apiVersion, bankConfigApiEnabled },
    };
  }

  /**
   * Idempotently creates (or confirms) the owned bank and establishes the
   * required config overrides, then reads them back and verifies an exact
   * match. Fails closed (does not proceed) if the readback does not match.
   */
  async ensureOwnedBank(bankId: string, signal?: AbortSignal): Promise<ProviderResult<void>> {
    const bankIdCheck = validateBankId(bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const created = await this.client.createOrUpdateBank(bankId, signal);
    if (!created.ok) {
      return failLike(created, `failed to create/update owned bank: ${created.reason}`);
    }
    const patched = await this.client.patchBankConfig(bankId, { ...OWNED_BANK_CONFIG_OVERRIDES }, signal);
    if (!patched.ok) {
      return failLike(patched, `failed to set owned-bank config overrides: ${patched.reason}`);
    }
    const readback = await this.client.getBankConfig(bankId, signal);
    if (!readback.ok) {
      return failLike(readback, `failed to read back owned-bank config: ${readback.reason}`);
    }
    const config = readback.value.config;
    const overrides = readback.value.overrides;
    if (typeof config !== "object" || config === null || typeof overrides !== "object" || overrides === null) {
      return { ok: false, reason: "owned-bank config response was malformed", category: "validation" };
    }
    if (readback.value.bank_id !== bankId) {
      return { ok: false, reason: "owned-bank config response referenced the wrong bank id", category: "validation" };
    }
    for (const [key, expected] of Object.entries(OWNED_BANK_CONFIG_OVERRIDES)) {
      if (config[key] !== expected) {
        return {
          ok: false,
          reason: `owned-bank config mismatch for "${key}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(config[key])}`,
          category: "validation",
        };
      }
      if (overrides[key] !== expected) {
        return {
          ok: false,
          reason: `owned-bank override mismatch for "${key}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(overrides[key])}`,
          category: "validation",
        };
      }
    }
    return { ok: true, value: undefined };
  }

  /**
   * Retains exactly one approved memory as a dedicated document, then proves
   * (via list-by-document-id) that exactly one live unit exists with the
   * exact expected text. A mismatch is reported as failure, never success,
   * per hindsight-contract.md "Exact approved-memory representation".
   */
  async retainOneMemory(
    input: RetainOneMemoryInput,
    signal?: AbortSignal,
  ): Promise<ProviderResult<RetainOneMemoryOutput>> {
    const bankIdCheck = validateBankId(input.bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const documentIdCheck = validateDocumentId(input.documentId);
    if (!documentIdCheck.ok) {
      return { ok: false, reason: documentIdCheck.reason ?? "invalid document id", category: "validation" };
    }
    if (Array.from(input.text).length > 1000) {
      return { ok: false, reason: "retain rejected: memory text exceeds 1000 Unicode characters", category: "validation" };
    }
    const metadataCheck = validateRetainMetadata(input.metadata);
    if (!metadataCheck.ok) {
      return { ok: false, reason: `retain rejected: ${metadataCheck.reason}`, category: "validation" };
    }
    const retained = await this.client.retainMemories(
      input.bankId,
      {
        items: [{ content: input.text, document_id: input.documentId, metadata: input.metadata, update_mode: "replace" }],
        async: false,
      },
      signal,
    );
    if (!retained.ok) {
      return failLike(retained, `retain failed: ${retained.reason}`);
    }
    if (
      retained.value.success !== true ||
      retained.value.items_count !== 1 ||
      retained.value.async !== false ||
      retained.value.bank_id !== input.bankId
    ) {
      return {
        ok: false,
        reason: "retain response did not report exactly one synchronous item for the expected bank",
        category: "validation",
        ambiguous: true,
      };
    }
    // The retain POST has already been acknowledged. Any postcondition failure
    // (including exact zero-unit/text-mismatch) may still mean the old document
    // was replaced/deleted, so callers must treat this as ambiguous/maybe-mutated.
    // Direct verifyOneUnitDocument remains free to classify absence/mismatch as
    // safely retryable on a later reconciling attempt.
    const verified = await this.verifyOneUnitDocument(input.bankId, input.documentId, input.text, signal);
    if (!verified.ok) {
      return {
        ok: false,
        reason: verified.reason,
        category: verified.category,
        ...(verified.status !== undefined ? { status: verified.status } : {}),
        ambiguous: true,
      };
    }
    return verified;
  }

  /**
   * Proves that exactly one live memory unit exists for `documentId` and its
   * text equals `expectedText` exactly. Used both after a fresh retain and to
   * reconcile an ambiguous/timed-out write by re-querying the deterministic
   * document ID (hindsight-contract.md "Idempotency and updates").
   *
   * Direct verification classifies as non-ambiguous/retry-safe ONLY when a
   * valid complete pagination window positively proves exact zero live units
   * or exactly one valid unit whose text mismatches. Transport/timeout/abort/
   * HTTP errors, malformed responses, pagination inconsistency, wrong document,
   * invalid unit id, or multiple units are ambiguous/unproven — callers must
   * not treat them as safe absence for a second retain.
   */
  async verifyOneUnitDocument(
    bankId: string,
    documentId: string,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<RetainOneMemoryOutput>> {
    const bankIdCheck = validateBankId(bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const documentIdCheck = validateDocumentId(documentId);
    if (!documentIdCheck.ok) {
      return { ok: false, reason: documentIdCheck.reason ?? "invalid document id", category: "validation" };
    }
    const listed = await this.client.listMemoriesByDocument(bankId, documentId, 2, signal);
    if (!listed.ok) {
      // List-by-document is GET: HttpClient does not attach mutation ambiguity.
      // Any transport/HTTP failure leaves provider state unproven.
      return {
        ok: false,
        reason: `post-write verification failed: ${listed.reason}`,
        category: listed.category,
        ...(listed.status !== undefined ? { status: listed.status } : {}),
        ambiguous: true,
      };
    }
    const pagination = validateListWindow(listed.value.total, listed.value.limit, listed.value.offset);
    if (!pagination.ok || !Array.isArray(listed.value.items)) {
      return {
        ok: false,
        reason: "post-write verification failed: list response was malformed",
        category: "validation",
        ambiguous: true,
      };
    }
    const liveItems = listed.value.items.filter((item) => item.state === undefined || item.state === "valid");
    if (listed.value.offset !== 0 || listed.value.limit < 2 || liveItems.length > listed.value.total || listed.value.total !== liveItems.length) {
      return {
        ok: false,
        reason: "post-write verification failed: list pagination was inconsistent",
        category: "validation",
        ambiguous: true,
      };
    }
    if (liveItems.length === 0) {
      // Exact absence is safely retryable under document-replace semantics.
      return {
        ok: false,
        reason: "post-write verification failed: expected exactly one live unit, found 0",
        category: "validation",
      };
    }
    if (liveItems.length !== 1) {
      return {
        ok: false,
        reason: `post-write verification failed: expected exactly one live unit, found ${liveItems.length}`,
        category: "validation",
        ambiguous: true,
      };
    }
    const unit = liveItems[0]!;
    if (unit.document_id !== documentId) {
      return {
        ok: false,
        reason: "post-write verification failed: stored document id does not match",
        category: "validation",
        ambiguous: true,
      };
    }
    if (typeof unit.id !== "string" || unit.id.length === 0) {
      return {
        ok: false,
        reason: "post-write verification failed: unit id is invalid",
        category: "validation",
        ambiguous: true,
      };
    }
    if (unit.text !== expectedText) {
      // Exact single-unit text mismatch is safely retryable by replacing the same document.
      return {
        ok: false,
        reason: "post-write verification failed: stored text does not match expected text",
        category: "validation",
      };
    }
    return { ok: true, value: { unitId: unit.id } };
  }

  /**
   * Exact owned-document retrieval for list/show. Never enumerates banks.
   * Performs one document GET and one list-by-document read under the same
   * signal, cross-checks body/hash/metadata, and returns governance metadata
   * from document_metadata (unit metadata may be null on real 0.8.3).
   */
  async fetchExactOneUnitDocument(
    bankId: string,
    documentId: string,
    expectedTextHash: string,
    signal?: AbortSignal,
  ): Promise<
    ProviderResult<{ text: string; unitId: string; metadata: Record<string, string> | null }>
  > {
    const bankIdCheck = validateBankId(bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const documentIdCheck = validateDocumentId(documentId);
    if (!documentIdCheck.ok) {
      return { ok: false, reason: documentIdCheck.reason ?? "invalid document id", category: "validation" };
    }
    if (!/^[0-9a-f]{64}$/.test(expectedTextHash)) {
      return { ok: false, reason: "invalid expected text hash", category: "validation" };
    }

    const [getDoc, listed] = await Promise.all([
      this.client.getDocument(bankId, documentId, signal),
      this.client.listMemoriesByDocument(bankId, documentId, 2, signal),
    ]);

    if (!getDoc.ok) {
      return {
        ok: false,
        reason: `exact document fetch failed: ${getDoc.reason}`,
        category: getDoc.category,
        ...(getDoc.status !== undefined ? { status: getDoc.status } : {}),
        ambiguous: true,
      };
    }
    const validatedDoc = validateOwnedDocumentWire(getDoc.value, bankId, documentId, expectedTextHash);
    if (!validatedDoc.ok) {
      return {
        ok: false,
        reason: `exact document fetch failed: ${validatedDoc.reason}`,
        category: "validation",
        ambiguous: true,
      };
    }

    if (!listed.ok) {
      return {
        ok: false,
        reason: `exact document fetch failed: ${listed.reason}`,
        category: listed.category,
        ...(listed.status !== undefined ? { status: listed.status } : {}),
        ambiguous: true,
      };
    }
    const pagination = validateListWindow(listed.value.total, listed.value.limit, listed.value.offset);
    if (!pagination.ok || !Array.isArray(listed.value.items)) {
      return {
        ok: false,
        reason: "exact document fetch failed: list response was malformed",
        category: "validation",
        ambiguous: true,
      };
    }
    const liveItems = listed.value.items.filter((item) => item.state === undefined || item.state === "valid");
    if (
      listed.value.offset !== 0 ||
      listed.value.limit < 2 ||
      liveItems.length > listed.value.total ||
      listed.value.total !== liveItems.length
    ) {
      return {
        ok: false,
        reason: "exact document fetch failed: list pagination was inconsistent",
        category: "validation",
        ambiguous: true,
      };
    }
    if (liveItems.length === 0) {
      return {
        ok: false,
        reason: "exact document fetch failed: document has no live units",
        category: "validation",
      };
    }
    if (liveItems.length !== 1) {
      return {
        ok: false,
        reason: `exact document fetch failed: expected exactly one live unit, found ${liveItems.length}`,
        category: "validation",
        ambiguous: true,
      };
    }
    const unit = liveItems[0]!;
    if (unit.document_id !== documentId) {
      return {
        ok: false,
        reason: "exact document fetch failed: stored document id does not match",
        category: "validation",
        ambiguous: true,
      };
    }
    if (typeof unit.id !== "string" || unit.id.length === 0) {
      return {
        ok: false,
        reason: "exact document fetch failed: unit id is invalid",
        category: "validation",
        ambiguous: true,
      };
    }
    if (typeof unit.text !== "string" || unit.text.length === 0 || unit.text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        reason: "exact document fetch failed: unit text is invalid",
        category: "validation",
      };
    }
    const normalizedUnitText = unit.text.trim();
    const unitHash = hashNormalizedText(unit.text);
    if (unitHash !== expectedTextHash || unitHash !== hashNormalizedText(validatedDoc.value.originalText)) {
      return {
        ok: false,
        reason: "exact document fetch failed: text hash mismatch",
        category: "validation",
      };
    }
    if (normalizedUnitText !== validatedDoc.value.originalText) {
      return {
        ok: false,
        reason: "exact document fetch failed: unit text does not match document original text",
        category: "validation",
        ambiguous: true,
      };
    }
    const unitMetadata = validateMetadata(unit.metadata);
    if (unit.metadata !== null && unit.metadata !== undefined) {
      if (!unitMetadata || !metadataRecordsEqual(unitMetadata, validatedDoc.value.documentMetadata)) {
        return {
          ok: false,
          reason: "exact document fetch failed: unit metadata does not match document metadata",
          category: "validation",
          ambiguous: true,
        };
      }
    }
    return {
      ok: true,
      value: {
        text: normalizedUnitText,
        unitId: unit.id,
        metadata: validatedDoc.value.documentMetadata,
      },
    };
  }

  /**
   * Proves physical absence of a one-memory document without issuing DELETE.
   * Used by stale delete takeover / reconciling retries so a crashed process
   * does not blindly re-DELETE when absence is already proven.
   *
   * - `{ ok: true, value: { absent: true } }` — GET 404 and zero live units.
   * - `{ ok: true, value: { absent: false } }` — document or units still present.
   * - `{ ok: false, ambiguous: true }` — GET/list could not prove either side.
   */
  async verifyDeletionPostconditions(
    bankId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<{ absent: boolean }>> {
    const bankIdCheck = validateBankId(bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const documentIdCheck = validateDocumentId(documentId);
    if (!documentIdCheck.ok) {
      return { ok: false, reason: documentIdCheck.reason ?? "invalid document id", category: "validation" };
    }

    const getDoc = await this.client.getDocument(bankId, documentId, signal);
    if (getDoc.ok) {
      return { ok: true, value: { absent: false } };
    }
    if (getDoc.status !== 404) {
      return {
        ok: false,
        reason: `delete postcondition check failed: ${getDoc.reason}`,
        category: getDoc.category,
        ...(getDoc.status !== undefined ? { status: getDoc.status } : {}),
        ambiguous: true,
      };
    }

    const listed = await this.client.listMemoriesByDocument(bankId, documentId, 2, signal);
    if (!listed.ok) {
      return {
        ok: false,
        reason: `delete postcondition check failed: ${listed.reason}`,
        category: listed.category,
        ...(listed.status !== undefined ? { status: listed.status } : {}),
        ambiguous: true,
      };
    }
    const pagination = validateListWindow(listed.value.total, listed.value.limit, listed.value.offset);
    if (!pagination.ok || !Array.isArray(listed.value.items)) {
      return {
        ok: false,
        reason: "delete postcondition failed: list response was malformed",
        category: "validation",
        ambiguous: true,
      };
    }
    if (listed.value.offset !== 0 || listed.value.limit < 2) {
      return {
        ok: false,
        reason: "delete postcondition failed: list pagination was inconsistent",
        category: "validation",
        ambiguous: true,
      };
    }
    if (listed.value.total === 0 && listed.value.items.length === 0) {
      return { ok: true, value: { absent: true } };
    }
    return { ok: true, value: { absent: false } };
  }

  /**
   * Physically deletes the one-memory document and proves the postconditions
   * from hindsight-contract.md "Physical forget": a 404 on document lookup
   * and zero live units by document ID. A 404 on the delete call itself is
   * reported as `alreadyAbsent: true`, not as failure — the caller (SQLite
   * operation ledger) decides whether that counts as idempotent completion.
   */
  async deleteMemoryDocument(
    bankId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult<DeleteDocumentOutput>> {
    const bankIdCheck = validateBankId(bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const documentIdCheck = validateDocumentId(documentId);
    if (!documentIdCheck.ok) {
      return { ok: false, reason: documentIdCheck.reason ?? "invalid document id", category: "validation" };
    }
    const deleted = await this.client.deleteDocument(bankId, documentId, signal);
    let memoryUnitsDeleted = 0;
    let alreadyAbsent = false;
    if (!deleted.ok) {
      if (deleted.status === 404) {
        alreadyAbsent = true;
      } else {
        return failLike(deleted, `delete failed: ${deleted.reason}`);
      }
    } else {
      if (
        deleted.value.success !== true ||
        deleted.value.document_id !== documentId ||
        typeof deleted.value.memory_units_deleted !== "number"
      ) {
        return { ok: false, reason: "delete failed: response was malformed", category: "validation", ambiguous: true };
      }
      memoryUnitsDeleted = deleted.value.memory_units_deleted;
    }

    const absence = await this.verifyDeletionPostconditions(bankId, documentId, signal);
    if (!absence.ok) {
      return {
        ok: false,
        reason: absence.reason,
        category: absence.category,
        ...(absence.status !== undefined ? { status: absence.status } : {}),
        ambiguous: true,
      };
    }
    if (!absence.value.absent) {
      return {
        ok: false,
        reason: "delete postcondition failed: document or live units remain after delete",
        category: "validation",
        ambiguous: true,
      };
    }

    return { ok: true, value: { deleted: !alreadyAbsent, alreadyAbsent, memoryUnitsDeleted } };
  }

  /**
   * Recalls only source fact types with all optional expansions disabled and
   * a bounded provider budget. Extension-side scope/lifecycle/sensitivity/
   * conflict/count/token filtering happens in the recall pipeline, not here.
   */
  async recall(input: RecallInput, signal?: AbortSignal): Promise<ProviderResult<RecallResultItem[]>> {
    const bankIdCheck = validateBankId(input.bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const queryCheck = validateQueryInput(input.query, input.maxTokens);
    if (!queryCheck.ok) {
      return { ok: false, reason: `recall rejected: ${queryCheck.reason}`, category: "validation" };
    }
    const queryValue = queryCheck.value!;
    if (input.budget !== "low" && input.budget !== "mid" && input.budget !== "high") {
      return { ok: false, reason: "recall rejected: invalid budget", category: "validation" };
    }
    const result = await this.client.recall(
      input.bankId,
      {
        query: queryValue.query,
        types: ["world", "experience"],
        budget: input.budget,
        max_tokens: queryValue.maxTokens,
        include: { entities: null, chunks: null, source_facts: null },
      },
      signal,
    );
    if (!result.ok) {
      return failLike(result, `recall failed: ${result.reason}`);
    }
    if (!Array.isArray(result.value.results) || result.value.results.length > MAX_RECALL_RESULTS) {
      return { ok: false, reason: "recall failed: response was malformed", category: "validation" };
    }
    const items: RecallResultItem[] = [];
    for (const r of result.value.results) {
      const metadata = validateMetadata(r.metadata);
      const tags = validateTags(r.tags);
      const text = validateOptionalString(r.text, MAX_TEXT_LENGTH);
      const id = validateOptionalString(r.id, 256);
      if (text === null || id === null) {
        return { ok: false, reason: "recall failed: response item was malformed", category: "validation" };
      }
      if (r.metadata !== null && r.metadata !== undefined && metadata === null) {
        return { ok: false, reason: "recall failed: metadata was malformed", category: "validation" };
      }
      if (r.tags !== null && r.tags !== undefined && tags === null) {
        return { ok: false, reason: "recall failed: tags were malformed", category: "validation" };
      }
      const documentId = validateOptionalString(r.document_id, 256);
      const type = validateOptionalString(r.type, 64);
      const context = validateOptionalString(r.context, MAX_CONTEXT_LENGTH);
      const mentionedAt = validateOptionalString(r.mentioned_at, 128);
      if (
        (r.document_id !== null && r.document_id !== undefined && documentId === null) ||
        (r.type !== null && r.type !== undefined && type === null) ||
        (r.context !== null && r.context !== undefined && context === null) ||
        (r.mentioned_at !== null && r.mentioned_at !== undefined && mentionedAt === null)
      ) {
        return { ok: false, reason: "recall failed: response item was malformed", category: "validation" };
      }
      if (type !== null && type !== "world" && type !== "experience") {
        return { ok: false, reason: "recall failed: response item type was unsupported", category: "validation" };
      }
      items.push({
        id,
        text,
        type,
        documentId,
        metadata,
        tags,
        context,
        mentionedAt,
      });
    }
    return { ok: true, value: items };
  }

  /** Manual-only reflect. Results are untrusted and never auto-promoted to approved memory. */
  async reflect(input: ReflectInput, signal?: AbortSignal): Promise<ProviderResult<ReflectOutput>> {
    const bankIdCheck = validateBankId(input.bankId);
    if (!bankIdCheck.ok) {
      return { ok: false, reason: bankIdCheck.reason ?? "invalid bank id", category: "validation" };
    }
    const queryCheck = validateQueryInput(input.query, input.maxTokens);
    if (!queryCheck.ok) {
      return { ok: false, reason: `reflect rejected: ${queryCheck.reason}`, category: "validation" };
    }
    const queryValue = queryCheck.value!;
    if (input.budget !== "low" && input.budget !== "mid" && input.budget !== "high") {
      return { ok: false, reason: "reflect rejected: invalid budget", category: "validation" };
    }
    const result = await this.client.reflect(
      input.bankId,
      { query: queryValue.query, budget: input.budget, max_tokens: queryValue.maxTokens },
      signal,
      this.reflectTimeoutMs,
    );
    if (!result.ok) {
      return failLike(result, `reflect failed: ${result.reason}`);
    }
    if (typeof result.value.text !== "string" || result.value.text.length > MAX_TEXT_LENGTH) {
      return { ok: false, reason: "reflect failed: response was malformed", category: "validation", ambiguous: true };
    }
    return { ok: true, value: { text: result.value.text } };
  }
}

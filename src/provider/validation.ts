import { createHash } from "node:crypto";
import type { MemoryType, Scope } from "../db/types.js";
import { PROJECT_MEMORY_TYPES, PROFILE_MEMORY_TYPES } from "../db/types.js";
import { APPROVED_MEMORY_MAX_CHARS, looksLikeBulkContent, scanForSensitiveContent, unicodeLength } from "../security/filters.js";

const PROFILE_BANK_PREFIX = "pi-memory-hindsight:profile:";
const PROJECT_BANK_PREFIX = "pi-memory-hindsight:project:";
const DOCUMENT_ID_PREFIX = "pi-memory-hindsight:memory:";
const HASH_HEX_LENGTH = 32;
const MAX_BANK_ID_LENGTH = 64;
const MAX_DOCUMENT_ID_LENGTH = 64;
const HEX_RE = /^[0-9a-f]+$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_ID_RE = /^[A-Za-z0-9:_./-]{1,128}$/;
const SOURCE_REF_RE = /^[A-Za-z0-9:_./#,\- ]{1,256}$/;
const LOGICAL_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_./#,\-]{1,256}$/;

const REQUIRED_METADATA_KEYS = [
  "logical_id",
  "content_hash",
  "scope",
  "memory_type",
  "verification_state",
  "created_at",
  "updated_at",
] as const;

const OPTIONAL_METADATA_KEYS = [
  "expires_at",
  "last_verified_at",
  "source_session_id",
  "source_ref",
  "supersedes_memory_id",
  "project_identity",
] as const;

const ALLOWED_METADATA_KEYS = new Set<string>([...REQUIRED_METADATA_KEYS, ...OPTIONAL_METADATA_KEYS]);

export type RetainMetadata = Record<string, string>;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

export function isDedicatedBankId(bankId: string): boolean {
  return (
    bankId.length < MAX_BANK_ID_LENGTH &&
    ((bankId.startsWith(PROFILE_BANK_PREFIX) && hasExpectedHex(bankId.slice(PROFILE_BANK_PREFIX.length))) ||
      (bankId.startsWith(PROJECT_BANK_PREFIX) && hasExpectedHex(bankId.slice(PROJECT_BANK_PREFIX.length))))
  );
}

function hasExpectedHex(hash: string): boolean {
  return hash.length === HASH_HEX_LENGTH && HEX_RE.test(hash);
}

export function validateBankId(bankId: string): ValidationResult<string> {
  if (!isDedicatedBankId(bankId)) {
    return { ok: false, reason: "bank id is not an owned dedicated profile/project bank id" };
  }
  return { ok: true, value: bankId };
}

/**
 * Current document id: derived from scope, project identity, memory type, and
 * the stable logical row id — never from the mutable text hash — so governed
 * update/supersede can replace content while reusing the same document.
 */
export function buildCurrentOwnedDocumentId(
  scope: Scope,
  projectIdentity: string | null,
  memoryType: MemoryType,
  logicalId: string,
): string {
  const hash = createHash("sha256")
    .update("pi-memory-hindsight:document:")
    .update(scope)
    .update(":")
    .update(projectIdentity ?? "")
    .update(":")
    .update(memoryType)
    .update(":")
    .update(logicalId)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
  return `${DOCUMENT_ID_PREFIX}${hash}`;
}

/**
 * Pre-fix / pre-v3 legacy document id: derived only from scope, project
 * identity, and the content text hash (no memory type, no row id). Existing
 * populated banks keep this locator until a governed update reuses it.
 */
export function buildLegacyOwnedDocumentId(
  scope: Scope,
  projectIdentity: string | null,
  textHash: string,
): string {
  const hash = createHash("sha256")
    .update("pi-memory-hindsight:document:")
    .update(scope)
    .update(":")
    .update(projectIdentity ?? "")
    .update(":")
    .update(textHash)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
  return `${DOCUMENT_ID_PREFIX}${hash}`;
}

/** Alias for the current formula; prefer `buildCurrentOwnedDocumentId` in new code. */
export const buildOwnedDocumentId = buildCurrentOwnedDocumentId;

/**
 * Proves a local memory row owns its stored document id under exactly one of:
 * current (scope/project/type/row id) or legacy (scope/project/text-hash key).
 * After a governed update of a legacy row, `legacy_document_text_hash` freezes
 * the original derivation key so the stable document still recomputes.
 */
export function rowOwnsDocumentId(row: {
  id: string;
  scope: Scope;
  project_identity: string | null;
  memory_type: MemoryType;
  document_id: string;
  text_hash: string;
  legacy_document_text_hash: string | null;
}): boolean {
  if (!validateDocumentId(row.document_id).ok) return false;
  if (
    row.document_id ===
    buildCurrentOwnedDocumentId(row.scope, row.project_identity, row.memory_type, row.id)
  ) {
    return true;
  }
  const legacyKey = row.legacy_document_text_hash ?? row.text_hash;
  if (!CONTENT_HASH_RE.test(legacyKey)) return false;
  return row.document_id === buildLegacyOwnedDocumentId(row.scope, row.project_identity, legacyKey);
}

export function isLegacyOwnedDocumentRow(row: {
  scope: Scope;
  project_identity: string | null;
  document_id: string;
  text_hash: string;
  legacy_document_text_hash: string | null;
}): boolean {
  if (row.legacy_document_text_hash !== null) {
    return (
      CONTENT_HASH_RE.test(row.legacy_document_text_hash) &&
      row.document_id ===
        buildLegacyOwnedDocumentId(row.scope, row.project_identity, row.legacy_document_text_hash)
    );
  }
  return (
    CONTENT_HASH_RE.test(row.text_hash) &&
    row.document_id === buildLegacyOwnedDocumentId(row.scope, row.project_identity, row.text_hash)
  );
}

export function validateDocumentId(documentId: string): ValidationResult<string> {
  if (
    !documentId.startsWith(DOCUMENT_ID_PREFIX) ||
    documentId.length >= MAX_DOCUMENT_ID_LENGTH ||
    !hasExpectedHex(documentId.slice(DOCUMENT_ID_PREFIX.length))
  ) {
    return { ok: false, reason: "document id is not an adapter-owned deterministic id" };
  }
  return { ok: true, value: documentId };
}

export function validateIdempotencyKey(idempotencyKey: string): ValidationResult<string> {
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return { ok: false, reason: "idempotency key is invalid" };
  }
  if (scanForSensitiveContent(idempotencyKey).sensitive) {
    return { ok: false, reason: "idempotency key contains sensitive content" };
  }
  return { ok: true, value: idempotencyKey };
}

function includesType(scope: Scope, memoryType: MemoryType): boolean {
  return scope === "profile"
    ? (PROFILE_MEMORY_TYPES as readonly string[]).includes(memoryType)
    : (PROJECT_MEMORY_TYPES as readonly string[]).includes(memoryType);
}

function validateIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function validateMetadataValue(key: string, value: string): string | null {
  if (value.length === 0 || value.length > 256) {
    return `${key} must be a non-empty bounded string`;
  }
  if (scanForSensitiveContent(value).sensitive) {
    return `${key} contains sensitive content`;
  }
  return null;
}

function validateMetadataShape(
  metadata: RetainMetadata,
  requiredKeys: readonly string[],
  options: { allowContentHash: boolean },
): ValidationResult<RetainMetadata> {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return { ok: false, reason: "metadata must not be empty" };
  }
  for (const required of requiredKeys) {
    if (!(required in metadata)) {
      return { ok: false, reason: `metadata missing required key ${required}` };
    }
  }
  if (!options.allowContentHash && "content_hash" in metadata) {
    return { ok: false, reason: "legacy metadata must not include content_hash" };
  }
  for (const [key, value] of entries) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      return { ok: false, reason: `metadata key ${key} is not allowed` };
    }
    if (typeof value !== "string") {
      return { ok: false, reason: `metadata key ${key} must have a string value` };
    }
    const valueError = validateMetadataValue(key, value);
    if (valueError) {
      return { ok: false, reason: valueError };
    }
  }

  const scope = metadata.scope as Scope;
  const memoryType = metadata.memory_type as MemoryType;
  const logicalId = metadata.logical_id!;
  const createdAt = metadata.created_at!;
  const updatedAt = metadata.updated_at!;
  if ((scope !== "profile" && scope !== "project") || !includesType(scope, memoryType)) {
    return { ok: false, reason: "metadata scope and memory_type are inconsistent" };
  }
  if (metadata.verification_state !== "verified" && metadata.verification_state !== "unverified") {
    return { ok: false, reason: "metadata verification_state is invalid" };
  }
  if (!LOGICAL_ID_RE.test(logicalId)) {
    return { ok: false, reason: "metadata logical_id is invalid" };
  }
  if (options.allowContentHash && metadata.content_hash !== undefined) {
    if (!CONTENT_HASH_RE.test(metadata.content_hash)) {
      return { ok: false, reason: "metadata content_hash is invalid" };
    }
  }
  if (!validateIsoTimestamp(createdAt) || !validateIsoTimestamp(updatedAt)) {
    return { ok: false, reason: "metadata created_at/updated_at must be ISO timestamps" };
  }
  if (metadata.expires_at !== undefined && !validateIsoTimestamp(metadata.expires_at)) {
    return { ok: false, reason: "metadata expires_at must be an ISO timestamp" };
  }
  if (metadata.last_verified_at !== undefined && !validateIsoTimestamp(metadata.last_verified_at)) {
    return { ok: false, reason: "metadata last_verified_at must be an ISO timestamp" };
  }
  if (metadata.source_session_id !== undefined && !SESSION_ID_RE.test(metadata.source_session_id)) {
    return { ok: false, reason: "metadata source_session_id is invalid" };
  }
  if (metadata.source_ref !== undefined && !SOURCE_REF_RE.test(metadata.source_ref)) {
    return { ok: false, reason: "metadata source_ref is invalid" };
  }
  if (metadata.supersedes_memory_id !== undefined && !LOGICAL_ID_RE.test(metadata.supersedes_memory_id)) {
    return { ok: false, reason: "metadata supersedes_memory_id is invalid" };
  }
  if (scope === "project") {
    if (!metadata.project_identity || metadata.project_identity !== metadata.project_identity.toLowerCase()) {
      return { ok: false, reason: "project metadata requires lowercase project_identity" };
    }
  } else if (metadata.project_identity !== undefined) {
    return { ok: false, reason: "profile metadata must not include project_identity" };
  }
  return { ok: true, value: metadata };
}

/** Current retain/recall metadata: requires content_hash and logical_id = row id. */
export function validateRetainMetadata(metadata: RetainMetadata): ValidationResult<RetainMetadata> {
  return validateMetadataShape(metadata, REQUIRED_METADATA_KEYS, { allowContentHash: true });
}

/**
 * Pre-fix approved metadata shape: logical_id was the text hash and
 * content_hash was not written. New retains must not use this shape.
 */
export function validateLegacyRetainMetadata(metadata: RetainMetadata): ValidationResult<RetainMetadata> {
  return validateMetadataShape(
    metadata,
    ["logical_id", "scope", "memory_type", "verification_state", "created_at", "updated_at"],
    { allowContentHash: false },
  );
}

export function validateSourceSessionId(value: string | null): ValidationResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (scanForSensitiveContent(value).sensitive) {
    return { ok: false, reason: "source_session_id contains sensitive content" };
  }
  if (!SESSION_ID_RE.test(value)) {
    return { ok: false, reason: "source_session_id is invalid" };
  }
  return { ok: true, value };
}

export function validateSourceRef(value: string | null): ValidationResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (scanForSensitiveContent(value).sensitive) {
    return { ok: false, reason: "source_ref contains sensitive content" };
  }
  if (looksLikeBulkContent(value)) {
    return { ok: false, reason: "source_ref looks like bulk content" };
  }
  if (!SOURCE_REF_RE.test(value)) {
    return { ok: false, reason: "source_ref is invalid" };
  }
  return { ok: true, value };
}

export function validateQueryInput(query: string, maxTokens: number): ValidationResult<{ query: string; maxTokens: number }> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "query must not be empty" };
  }
  if (unicodeLength(trimmed) > APPROVED_MEMORY_MAX_CHARS) {
    return { ok: false, reason: "query exceeds maximum length" };
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 4096) {
    return { ok: false, reason: "maxTokens is out of bounds" };
  }
  return { ok: true, value: { query: trimmed, maxTokens } };
}

export function validateListWindow(total: unknown, limit: unknown, offset: unknown): ValidationResult<void> {
  if (
    !Number.isInteger(total) ||
    !Number.isInteger(limit) ||
    !Number.isInteger(offset) ||
    (total as number) < 0 ||
    (limit as number) < 0 ||
    (offset as number) < 0 ||
    (limit as number) > 100 ||
    (offset as number) > 10_000
  ) {
    return { ok: false, reason: "list response pagination fields are invalid" };
  }
  return { ok: true, value: undefined };
}

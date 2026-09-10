import { createHash } from "node:crypto";
import type { MemoryRow, MemoryType, Scope } from "../db/types.js";
import { DAY_MS } from "../db/lifecycle.js";
import {
  buildLegacyOwnedDocumentId,
  isLegacyOwnedDocumentRow,
  validateLegacyRetainMetadata,
  validateRetainMetadata,
} from "./validation.js";

const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export function textHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function validateLifecycle(
  scope: Scope,
  memoryType: MemoryType,
  metadata: Record<string, string>,
  nowMs: number,
): boolean {
  const createdAt = metadata.created_at;
  const updatedAt = metadata.updated_at;
  if (!createdAt || !updatedAt) return false;
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(updatedMs)) return false;
  if (createdMs > nowMs + MAX_FUTURE_SKEW_MS) return false;
  if (updatedMs < createdMs || updatedMs > nowMs + MAX_FUTURE_SKEW_MS) return false;

  const expiresAt = metadata.expires_at;
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return false;
    if (expiresMs < createdMs) return false;
    if (memoryType === "task_state" && expiresMs > createdMs + 30 * DAY_MS) return false;
    if (memoryType === "inference" && expiresMs > createdMs + 90 * DAY_MS) return false;
    if (memoryType === "project_fact" && expiresMs > createdMs + 180 * DAY_MS) return false;
  }

  if (memoryType === "task_state" || memoryType === "inference" || memoryType === "project_fact") {
    if (!expiresAt) return false;
  }
  if (memoryType === "inference" && metadata.verification_state !== "unverified") return false;
  if (scope === "profile" && metadata.project_identity !== undefined) return false;

  if (metadata.last_verified_at) {
    const lastVerifiedMs = Date.parse(metadata.last_verified_at);
    if (!Number.isFinite(lastVerifiedMs) || lastVerifiedMs < createdMs || lastVerifiedMs > nowMs + MAX_FUTURE_SKEW_MS) {
      return false;
    }
  }

  return true;
}

function isLocalRowCurrentMetadataConsistent(
  row: MemoryRow,
  metadata: Record<string, string>,
  text: string,
): boolean {
  if (row.text_hash !== textHashOf(text)) return false;
  if (row.text_hash !== metadata.content_hash) return false;
  if (row.id !== metadata.logical_id) return false;
  if (row.scope !== metadata.scope) return false;
  if (row.memory_type !== metadata.memory_type) return false;
  if (row.verification_state !== metadata.verification_state) return false;
  if (row.created_at !== metadata.created_at) return false;
  if (row.updated_at !== metadata.updated_at) return false;
  const metadataExpiry = metadata.expires_at ?? null;
  if ((row.expires_at ?? null) !== metadataExpiry) return false;
  if (row.scope === "project") {
    if (row.project_identity !== (metadata.project_identity ?? null)) return false;
  } else if (metadata.project_identity !== undefined) {
    return false;
  }
  const metadataCreatedAt = metadata.created_at;
  const metadataUpdatedAt = metadata.updated_at;
  if (!metadataCreatedAt || !metadataUpdatedAt) return false;
  const metadataCreatedMs = Date.parse(metadataCreatedAt);
  const metadataUpdatedMs = Date.parse(metadataUpdatedAt);
  if (!Number.isFinite(metadataCreatedMs) || !Number.isFinite(metadataUpdatedMs)) return false;
  if (metadataUpdatedMs < metadataCreatedMs) return false;
  if (row.verification_state === "verified" && row.last_verified_at === null) return false;
  if (row.verification_state === "unverified" && metadata.last_verified_at !== undefined) return false;
  if (metadata.last_verified_at !== undefined && row.last_verified_at !== metadata.last_verified_at) return false;
  return true;
}

function isLocalRowLegacyMetadataConsistent(
  row: MemoryRow,
  metadata: Record<string, string>,
  text: string,
): boolean {
  if (!isLegacyOwnedDocumentRow(row)) return false;
  if (row.text_hash !== textHashOf(text)) return false;
  if (metadata.content_hash !== undefined) return false;
  if (metadata.logical_id !== row.text_hash) return false;
  if (row.scope !== metadata.scope) return false;
  if (row.memory_type !== metadata.memory_type) return false;
  if (row.verification_state !== metadata.verification_state) return false;
  if (
    row.document_id !==
    buildLegacyOwnedDocumentId(row.scope, row.project_identity, row.text_hash)
  ) {
    return false;
  }
  if (row.created_at !== metadata.created_at) return false;
  if (row.updated_at !== metadata.updated_at) return false;
  const metadataExpiry = metadata.expires_at ?? null;
  if ((row.expires_at ?? null) !== metadataExpiry) return false;
  if (row.scope === "project") {
    if (row.project_identity !== (metadata.project_identity ?? null)) return false;
  } else if (metadata.project_identity !== undefined) {
    return false;
  }
  if (row.verification_state === "verified" && row.last_verified_at === null) return false;
  if (row.verification_state === "unverified" && metadata.last_verified_at !== undefined) return false;
  if (metadata.last_verified_at !== undefined && row.last_verified_at !== metadata.last_verified_at) return false;
  return true;
}

/**
 * Validates provider retain metadata and text against a governed local row.
 * Fails closed on null/malformed metadata or any governance field mismatch.
 */
export function providerMetadataMatchesLocalRow(
  row: MemoryRow,
  metadata: Record<string, string> | null | undefined,
  text: string,
  nowMs: number,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  if (row.memory_type !== metadata.memory_type) return false;
  if (row.verification_state !== metadata.verification_state) return false;
  if (row.scope !== metadata.scope) return false;
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return false;

  const currentMeta = validateRetainMetadata(metadata);
  if (currentMeta.ok) {
    if (!validateLifecycle(row.scope, metadata.memory_type as MemoryType, metadata, nowMs)) return false;
    if (metadata.content_hash !== textHashOf(text)) return false;
    return isLocalRowCurrentMetadataConsistent(row, metadata, text);
  }

  const legacyMeta = validateLegacyRetainMetadata(metadata);
  if (!legacyMeta.ok) return false;
  if (!validateLifecycle(row.scope, metadata.memory_type as MemoryType, metadata, nowMs)) return false;
  return isLocalRowLegacyMetadataConsistent(row, metadata, text);
}

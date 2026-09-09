/**
 * Deterministic, hashed Hindsight bank IDs.
 *
 * architecture.md "Bank and identity model": bank IDs must never contain the
 * clear-text profile directory, repository path, remote URL, or project
 * name, and must stay under 64 characters for backend compatibility. The
 * extension never lists banks; it only computes these IDs directly.
 */

import { createHash } from "node:crypto";

const PROFILE_PREFIX = "pi-memory-hindsight:profile:";
const PROJECT_PREFIX = "pi-memory-hindsight:project:";
const HASH_HEX_LENGTH = 32; // 16 bytes; keeps total id length well under 64 chars.
const MAX_BANK_ID_LENGTH = 64;

function hashPrefix(namespace: string, value: string): string {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}

/** Bank ID for a Profile, derived from the profile's anonymous random ID (never a filesystem path). */
export function profileBankId(anonymousProfileId: string): string {
  const id = PROFILE_PREFIX + hashPrefix("profile", anonymousProfileId);
  assertBounded(id);
  return id;
}

/** Bank ID for a Project, derived from the normalized (lowercase) project identity. */
export function projectBankId(normalizedProjectIdentity: string): string {
  const id = PROJECT_PREFIX + hashPrefix("project", normalizedProjectIdentity);
  assertBounded(id);
  return id;
}

function assertBounded(id: string): void {
  if (id.length >= MAX_BANK_ID_LENGTH) {
    throw new Error(`bank id exceeds bound: ${id.length} >= ${MAX_BANK_ID_LENGTH}`);
  }
}

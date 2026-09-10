import type { MemoryType, VerificationState } from "./types.js";
import { PROVIDER_HTTP_TIMEOUT_MS } from "../provider/http-client.js";
import { mutationNowMs } from "../governance/mutation-clock.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_DAYS = 30;

/** Body-free terminal candidate metadata retention. */
export const CANDIDATE_TERMINAL_RETENTION_DAYS = 90;
/** Terminal (committed/failed) operations retention. */
export const OPERATION_TERMINAL_RETENTION_DAYS = 30;
/** Resolved conflicts retention. */
export const CONFLICT_RESOLVED_RETENTION_DAYS = 90;
/** Audit and usage age retention. */
export const AUDIT_USAGE_RETENTION_DAYS = 90;
/** Soft caps after age retention. */
export const AUDIT_MAX_ROWS = 10_000;
export const USAGE_MAX_ROWS = 10_000;
/** Body-free deleted/expired memory tombstone retention. */
export const MEMORY_TOMBSTONE_RETENTION_DAYS = 90;
/** Automatic maintenance interval. */
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Max formal-memory expiry deletes per maintenance pass. */
export const EXPIRY_BATCH_LIMIT = 10;
/** Bounded scan for coherent reconciling expiry rows before exact app filtering. */
export const EXPIRY_RECONCILING_SCAN_LIMIT = EXPIRY_BATCH_LIMIT * 4;
/** Max local row deletions per table per cleanup pass. */
export const CLEANUP_BATCH_LIMIT = 100;
/** Per-item maintenance lease renewal: one full mutation operation budget. */
const MUTATION_MAX_PROVIDER_HTTP_CALLS = 8;
export const MAINTENANCE_LEASE_RENEWAL_MS =
  PROVIDER_HTTP_TIMEOUT_MS * MUTATION_MAX_PROVIDER_HTTP_CALLS + PROVIDER_HTTP_TIMEOUT_MS;
/** Initial claim covers a full expiry batch plus one renewal slack. */
export const MAINTENANCE_BATCH_LEASE_MS =
  EXPIRY_BATCH_LIMIT * MAINTENANCE_LEASE_RENEWAL_MS + MAINTENANCE_LEASE_RENEWAL_MS;
/** @deprecated alias — use MAINTENANCE_BATCH_LEASE_MS for initial claims. */
export const MAINTENANCE_LEASE_MS = MAINTENANCE_BATCH_LEASE_MS;
/** Default list page size. */
export const MEMORY_LIST_LIMIT = 20;
/** Bounded preview for list/last surfaces. */
export const MEMORY_LIST_PREVIEW_CHARS = 120;
/** Max concurrent exact provider fetches for `/memory list`. */
export const MEMORY_LIST_FETCH_CONCURRENCY = 3;
/** Overall wall-clock budget for list provider fetches (not per-item). */
export const MEMORY_LIST_FETCH_DEADLINE_MS = 30_000;

export function candidateExpiryFrom(now: Date): string {
  return new Date(now.getTime() + CANDIDATE_TTL_DAYS * DAY_MS).toISOString();
}

export function defaultVerificationState(memoryType: MemoryType): VerificationState {
  return memoryType === "inference" ? "unverified" : "verified";
}

export function memoryExpiryFrom(memoryType: MemoryType, now: Date): string | null {
  switch (memoryType) {
    case "project_fact":
      return new Date(now.getTime() + 180 * DAY_MS).toISOString();
    case "task_state":
      return new Date(now.getTime() + 30 * DAY_MS).toISOString();
    case "inference":
      return new Date(now.getTime() + 90 * DAY_MS).toISOString();
    case "preference":
    case "habit":
    case "decision":
    case "lesson":
      return null;
  }
}

/** Effective lifecycle status for list/show: past-due active rows report as expired. */
export function effectiveMemoryStatus(
  status: string,
  expiresAt: string | null,
  nowMs?: number,
): string {
  const effectiveNowMs = nowMs ?? mutationNowMs();
  if (status === "active" && expiresAt && Date.parse(expiresAt) <= effectiveNowMs) {
    return "expired";
  }
  return status;
}

export function isEffectivelyActive(
  status: string,
  expiresAt: string | null,
  nowMs?: number,
): boolean {
  const effectiveNowMs = nowMs ?? mutationNowMs();
  return status === "active" && !(expiresAt && Date.parse(expiresAt) <= effectiveNowMs);
}

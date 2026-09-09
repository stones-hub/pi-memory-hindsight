import type { MemoryType, VerificationState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_DAYS = 30;

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

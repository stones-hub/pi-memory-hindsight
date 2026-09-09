import type { Language } from "../i18n/messages.js";
import { scanForSensitiveContent } from "../security/filters.js";
import { PROFILE_MEMORY_TYPES, PROJECT_MEMORY_TYPES, type MemoryType, type Scope } from "./types.js";

const MAX_AUDIT_FIELD_LENGTH = 64;
const MAX_USAGE_MODEL_ID_LENGTH = 200;
const MAX_USAGE_OUTCOME_LENGTH = 64;
const BOUNDED_CODE_REGEX = /^[a-z0-9._:-]+$/;

function isNonEmptyTrimmedString(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertScopeTypeProjectIdentityInvariant(
  scope: Scope,
  memoryType: MemoryType,
  projectIdentity: string | null,
): void {
  if (scope === "profile") {
    if (!(PROFILE_MEMORY_TYPES as readonly string[]).includes(memoryType)) {
      throw new Error(`profile scope does not allow memory type "${memoryType}"`);
    }
    if (projectIdentity !== null) {
      throw new Error("profile scope requires projectIdentity to be null");
    }
    return;
  }

  if (!(PROJECT_MEMORY_TYPES as readonly string[]).includes(memoryType)) {
    throw new Error(`project scope does not allow memory type "${memoryType}"`);
  }
  if (!isNonEmptyTrimmedString(projectIdentity)) {
    throw new Error("project scope requires a non-empty projectIdentity");
  }
}

export function assertLanguage(language: string): asserts language is Language {
  if (language !== "en" && language !== "zh") {
    throw new Error(`unsupported language "${language}"`);
  }
}

function assertBoundedCode(fieldName: string, value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new Error(`${fieldName} must be 1-${maxLength} characters`);
  }
  if (!BOUNDED_CODE_REGEX.test(value)) {
    throw new Error(`${fieldName} contains unsupported characters`);
  }
}

export function validateAuditFields(params: {
  eventType: string;
  outcome: string;
  redactedCode?: string | null;
}): void {
  assertBoundedCode("eventType", params.eventType, MAX_AUDIT_FIELD_LENGTH);
  assertBoundedCode("outcome", params.outcome, MAX_AUDIT_FIELD_LENGTH);
  if (params.redactedCode == null) return;
  const scan = scanForSensitiveContent(params.redactedCode);
  if (scan.sensitive) {
    throw new Error(`redactedCode rejected: matched ${scan.matchedPatterns.join(",")}`);
  }
  assertBoundedCode("redactedCode", params.redactedCode, MAX_AUDIT_FIELD_LENGTH);
}

export function validateUsageFields(params: {
  modelId: string | null;
  outcome: string;
}): void {
  if (params.modelId !== null) {
    if (params.modelId.length === 0 || params.modelId.length > MAX_USAGE_MODEL_ID_LENGTH) {
      throw new Error(`modelId must be 1-${MAX_USAGE_MODEL_ID_LENGTH} characters when present`);
    }
    const scan = scanForSensitiveContent(params.modelId);
    if (scan.sensitive) {
      throw new Error(`modelId rejected: matched ${scan.matchedPatterns.join(",")}`);
    }
  }
  assertBoundedCode("outcome", params.outcome, MAX_USAGE_OUTCOME_LENGTH);
}

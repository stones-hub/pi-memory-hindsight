/**
 * Strict, all-or-nothing extraction-response parser (memory-policy.md
 * "Extraction output", HANDOVER.md "Parse one bounded JSON value, validate
 * strictly, and reject the complete response on any error"). One invalid
 * candidate rejects the whole response — never a partial candidate set.
 */

import { prepareEvidenceSummary, validateMemoryText } from "../security/filters.js";
import { PROFILE_MEMORY_TYPES, PROJECT_MEMORY_TYPES, type MemoryType, type Scope } from "../db/types.js";

export interface ParsedCandidate {
  scope: Scope;
  memoryType: MemoryType;
  text: string;
  evidence: string | null;
}

export type ParseExtractionResult =
  | { ok: true; candidates: ParsedCandidate[] }
  | { ok: false; reason: string };

const MAX_RESPONSE_CHARS = 16_000;
const MAX_CANDIDATES = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParseState {
  text: string;
  index: number;
}

function skipWhitespace(state: ParseState): void {
  while (state.index < state.text.length && /\s/u.test(state.text[state.index]!)) {
    state.index += 1;
  }
}

function parseJsonWithDuplicateKeyCheck(raw: string): unknown {
  const state: ParseState = { text: raw, index: 0 };
  const value = parseValue(state);
  skipWhitespace(state);
  if (state.index !== state.text.length) {
    throw new Error("trailing content");
  }
  return value;
}

function parseValue(state: ParseState): unknown {
  skipWhitespace(state);
  const ch = state.text[state.index];
  if (ch === "{") return parseObject(state);
  if (ch === "[") return parseArray(state);
  if (ch === "\"") return parseString(state);
  if (ch === "-" || (ch !== undefined && /\d/u.test(ch))) return parseNumber(state);
  if (state.text.startsWith("true", state.index)) {
    state.index += 4;
    return true;
  }
  if (state.text.startsWith("false", state.index)) {
    state.index += 5;
    return false;
  }
  if (state.text.startsWith("null", state.index)) {
    state.index += 4;
    return null;
  }
  throw new Error("invalid JSON value");
}

function parseObject(state: ParseState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  state.index += 1;
  skipWhitespace(state);
  if (state.text[state.index] === "}") {
    state.index += 1;
    return out;
  }
  for (;;) {
    if (state.text[state.index] !== "\"") {
      throw new Error("object key must be a string");
    }
    const key = parseString(state);
    if (seen.has(key)) {
      throw new Error(`duplicate key "${key}"`);
    }
    seen.add(key);
    skipWhitespace(state);
    if (state.text[state.index] !== ":") {
      throw new Error("missing colon");
    }
    state.index += 1;
    out[key] = parseValue(state);
    skipWhitespace(state);
    const ch = state.text[state.index];
    if (ch === "}") {
      state.index += 1;
      return out;
    }
    if (ch !== ",") {
      throw new Error("missing comma");
    }
    state.index += 1;
    skipWhitespace(state);
  }
}

function parseArray(state: ParseState): unknown[] {
  const out: unknown[] = [];
  state.index += 1;
  skipWhitespace(state);
  if (state.text[state.index] === "]") {
    state.index += 1;
    return out;
  }
  for (;;) {
    out.push(parseValue(state));
    skipWhitespace(state);
    const ch = state.text[state.index];
    if (ch === "]") {
      state.index += 1;
      return out;
    }
    if (ch !== ",") {
      throw new Error("missing comma");
    }
    state.index += 1;
    skipWhitespace(state);
  }
}

function parseString(state: ParseState): string {
  const start = state.index;
  state.index += 1;
  while (state.index < state.text.length) {
    const ch = state.text[state.index]!;
    if (ch === "\"") {
      state.index += 1;
      return JSON.parse(state.text.slice(start, state.index)) as string;
    }
    if (ch === "\\") {
      state.index += 2;
      continue;
    }
    state.index += 1;
  }
  throw new Error("unterminated string");
}

function parseNumber(state: ParseState): number {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(state.text.slice(state.index));
  if (!match) {
    throw new Error("invalid number");
  }
  state.index += match[0].length;
  return Number(match[0]);
}

export function parseExtractionResponse(
  raw: string,
  opts: { projectEnabled: boolean },
): ParseExtractionResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty response" };
  }
  if (trimmed.length > MAX_RESPONSE_CHARS) {
    return { ok: false, reason: `response exceeds ${MAX_RESPONSE_CHARS} characters` };
  }
  let value: unknown;
  try {
    value = parseJsonWithDuplicateKeyCheck(trimmed);
  } catch (error) {
    return { ok: false, reason: `response is not valid JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "response is not a JSON object" };
  }
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || topKeys[0] !== "candidates") {
    return { ok: false, reason: 'response must contain exactly one field, "candidates"' };
  }
  const rawCandidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(rawCandidates)) {
    return { ok: false, reason: '"candidates" must be an array' };
  }
  if (rawCandidates.length > MAX_CANDIDATES) {
    return { ok: false, reason: `response exceeds ${MAX_CANDIDATES} candidates` };
  }

  const allowedFields = new Set(["scope", "memory_type", "text", "evidence", "action"]);
  const candidates: ParsedCandidate[] = [];

  for (const item of rawCandidates) {
    if (!isPlainObject(item)) {
      return { ok: false, reason: "candidate is not an object" };
    }
    for (const key of Object.keys(item)) {
      if (!allowedFields.has(key)) {
        return { ok: false, reason: `candidate field "${key}" is not allowed` };
      }
    }

    const scope = item.scope;
    if (scope !== "profile" && scope !== "project") {
      return { ok: false, reason: 'candidate "scope" must be "profile" or "project"' };
    }
    if (scope === "project" && !opts.projectEnabled) {
      return { ok: false, reason: "candidate proposes project scope but project memory is disabled" };
    }

    const memoryType = item.memory_type;
    const validTypes = scope === "profile" ? PROFILE_MEMORY_TYPES : PROJECT_MEMORY_TYPES;
    if (typeof memoryType !== "string" || !(validTypes as readonly string[]).includes(memoryType)) {
      return { ok: false, reason: `candidate "memory_type" invalid for scope "${scope}"` };
    }

    const text = item.text;
    if (typeof text !== "string") {
      return { ok: false, reason: 'candidate "text" must be a string' };
    }
    const trimmedText = text.trim();
    const textCheck = validateMemoryText(trimmedText);
    if (!textCheck.ok) {
      return { ok: false, reason: `candidate text rejected: ${textCheck.reason}` };
    }

    let evidence: string | null = null;
    if (item.evidence !== undefined) {
      if (typeof item.evidence !== "string") {
        return { ok: false, reason: 'candidate "evidence" must be a string' };
      }
      const prepared = prepareEvidenceSummary(item.evidence);
      if (!prepared.ok) {
        return { ok: false, reason: `candidate evidence rejected: ${prepared.reason}` };
      }
      evidence = prepared.redactedTruncated ?? null;
    }
    if (item.action !== undefined) {
      if (
        item.action !== "create" &&
        item.action !== "update" &&
        item.action !== "supersede" &&
        item.action !== "ignore"
      ) {
        return { ok: false, reason: 'candidate "action" must be create, update, supersede, or ignore' };
      }
    }

    candidates.push({ scope, memoryType: memoryType as MemoryType, text: trimmedText, evidence });
  }

  return { ok: true, candidates };
}

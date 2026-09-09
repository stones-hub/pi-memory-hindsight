/**
 * Local pre-send secret and content filtering
 * (threat-model.md "Mandatory mitigations", memory-policy.md "Content").
 *
 * This module is used at every boundary before content reaches a model call
 * or persistent storage: extraction source material, candidate text,
 * explicit remember input, and evidence summaries.
 */

import { REDACT_ONLY_PATTERNS, SECRET_PATTERNS } from "./secret-patterns.js";

export interface SensitivityScanResult {
  sensitive: boolean;
  matchedPatterns: string[];
}

/** Scans text for secret-like content. Any hard match makes the whole content rejected by callers. */
export function scanForSensitiveContent(text: string): SensitivityScanResult {
  const matched: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text) && !REDACT_ONLY_PATTERNS.has(pattern.name)) {
      matched.push(pattern.name);
    }
  }
  return { sensitive: matched.length > 0, matchedPatterns: matched };
}

/** Replaces every secret-pattern match (including redact-only patterns) with a fixed marker. */
export function redactSensitiveContent(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    result = result.replace(regex, `[REDACTED:${pattern.name}]`);
  }
  return result;
}

const MAX_LINE_COUNT = 40;
const MAX_CODE_FENCE_LINES = 20;
const MAX_LONG_LINE_LENGTH = 240;

/**
 * Rejects source material that looks like a full file, a large code block,
 * or full log/terminal output, per memory-policy.md "Forbidden".
 * This is a coarse heuristic gate applied before independent extraction and
 * before storing any evidence summary — not a semantic understanding of the
 * content.
 */
export function looksLikeBulkContent(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const lineCount = lines.length;
  if (lineCount > MAX_LINE_COUNT) return true;

  const fenceMatches = text.match(/```[\s\S]*?```/g) ?? [];
  for (const fence of fenceMatches) {
    if (fence.split(/\r?\n/).length > MAX_CODE_FENCE_LINES) return true;
  }

  const longLines = lines.filter((line) => line.length >= MAX_LONG_LINE_LENGTH).length;
  if (longLines >= 10) return true;

  const codeLikeLines = lines.filter((line) =>
    /^\s*(import |export |class |interface |type |function |\w+\s*[:=]\s*.+[;,]?$|if\s*\(|for\s*\(|while\s*\(|return\b)/.test(
      line,
    ),
  ).length;
  if (lineCount >= 20 && codeLikeLines >= 12) return true;

  const terminalLikeLines = lines.filter((line) =>
    /^(> |\$ |\+ |\-\-\- |pid: |cwd: |last_command: |last_exit_code: |at\s.+:\d+:\d+)/.test(line),
  ).length;
  if (lineCount >= 20 && terminalLikeLines >= 8) return true;

  return false;
}

/** Truncates to at most `maxChars` Unicode code points, preserving whole characters. */
export function truncateUnicode(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join("");
}

export function unicodeLength(text: string): number {
  return Array.from(text).length;
}

export const APPROVED_MEMORY_MAX_CHARS = 1000;
export const EVIDENCE_SUMMARY_MAX_CHARS = 500;

export interface PrepareEvidenceResult {
  ok: boolean;
  reason?: string;
  redactedTruncated?: string;
}

/**
 * Prepares a bounded, redacted evidence summary for SQLite candidate storage.
 * Hard-rejects (does not store at all) when a real secret pattern is found;
 * otherwise redacts soft patterns and truncates.
 */
export function prepareEvidenceSummary(rawEvidence: string): PrepareEvidenceResult {
  const scan = scanForSensitiveContent(rawEvidence);
  if (scan.sensitive) {
    return { ok: false, reason: `evidence rejected: matched ${scan.matchedPatterns.join(",")}` };
  }
  if (looksLikeBulkContent(rawEvidence)) {
    return { ok: false, reason: "evidence rejected: looks like bulk content (full file/log/code block)" };
  }
  const redacted = redactSensitiveContent(rawEvidence);
  const truncated = truncateUnicode(redacted, EVIDENCE_SUMMARY_MAX_CHARS);
  return { ok: true, redactedTruncated: truncated };
}

export interface ValidateMemoryTextResult {
  ok: boolean;
  reason?: string;
}

/** Validates that approved/candidate memory text is safe and within the atomic length cap. */
export function validateMemoryText(text: string): ValidateMemoryTextResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "memory text is empty" };
  }
  if (unicodeLength(trimmed) > APPROVED_MEMORY_MAX_CHARS) {
    return { ok: false, reason: `memory text exceeds ${APPROVED_MEMORY_MAX_CHARS} Unicode characters` };
  }
  const scan = scanForSensitiveContent(trimmed);
  if (scan.sensitive) {
    return { ok: false, reason: `memory text rejected: matched ${scan.matchedPatterns.join(",")}` };
  }
  if (looksLikeBulkContent(trimmed)) {
    return { ok: false, reason: "memory text looks like bulk content (full file/log/code block)" };
  }
  return { ok: true };
}

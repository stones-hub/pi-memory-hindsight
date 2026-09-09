import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SUMMARY_MAX_CHARS,
  looksLikeBulkContent,
  prepareEvidenceSummary,
  redactSensitiveContent,
  scanForSensitiveContent,
  truncateUnicode,
  unicodeLength,
  validateMemoryText,
} from "../src/security/filters.js";

describe("security filters", () => {
  it("detects representative secrets and preserves benign content", () => {
    expect(scanForSensitiveContent("Authorization: Bearer topsecret-token").sensitive).toBe(true);
    expect(scanForSensitiveContent("password=supersecret").sensitive).toBe(true);
    expect(scanForSensitiveContent("Cookie: a=b").sensitive).toBe(true);
    expect(scanForSensitiveContent("Run `npm test` in src/service.ts for EACCES failures.").sensitive).toBe(false);
  });

  it("redacts dotenv-style lines and rejects sensitive evidence", () => {
    expect(redactSensitiveContent("API_KEY=abc123\nPATH=/tmp")).toContain("[REDACTED:dotenv_line]");
    const result = prepareEvidenceSummary("Authorization: Bearer hidden");
    expect(result.ok).toBe(false);
  });

  it("detects bulk code and terminal/log output heuristically", () => {
    const codeBlock = Array.from({ length: 22 }, (_, i) => `import x${i} from "y${i}";`).join("\n");
    const terminalDump = [
      "pid: 1",
      "cwd: /tmp/repo",
      "last_command: npm test",
      "last_exit_code: 1",
      ...Array.from({ length: 20 }, (_, i) => `at file${i}.ts:10:2`),
    ].join("\n");

    expect(looksLikeBulkContent(codeBlock)).toBe(true);
    expect(looksLikeBulkContent(terminalDump)).toBe(true);
    expect(looksLikeBulkContent("Use `src/index.ts` and rerun `npm test` for EACCES.")).toBe(false);
  });

  it("enforces atomic memory length safely across Unicode", () => {
    expect(unicodeLength("你好ab")).toBe(4);
    expect(truncateUnicode("你好世界", 2)).toBe("你好");
    expect(validateMemoryText("  remember this path: src/index.ts  ").ok).toBe(true);
    expect(validateMemoryText("x".repeat(1001)).ok).toBe(false);
  });

  it("rejects bulk evidence before storing and still truncates safe evidence", () => {
    const bulk = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");
    expect(prepareEvidenceSummary(bulk).ok).toBe(false);

    const raw = "a".repeat(EVIDENCE_SUMMARY_MAX_CHARS + 20);
    const result = prepareEvidenceSummary(raw);
    expect(result.ok).toBe(true);
    expect(result.redactedTruncated).toHaveLength(EVIDENCE_SUMMARY_MAX_CHARS);
  });
});

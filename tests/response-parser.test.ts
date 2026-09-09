import { describe, expect, it } from "vitest";
import { parseExtractionResponse } from "../src/extraction/response-parser.js";

describe("parseExtractionResponse", () => {
  it("accepts one strict JSON object", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        candidates: [
          {
            scope: "profile",
            memory_type: "preference",
            text: "Prefer concise answers.",
            evidence: "User explicitly requested concise responses.",
            action: "create",
          },
        ],
      }),
      { projectEnabled: false },
    );
    expect(result).toEqual({
      ok: true,
      candidates: [
        {
          scope: "profile",
          memoryType: "preference",
          text: "Prefer concise answers.",
          evidence: "User explicitly requested concise responses.",
        },
      ],
    });
  });

  it("rejects prose, fences, duplicate keys, and unknown fields", () => {
    expect(parseExtractionResponse("```json\n{\"candidates\":[]}\n```", { projectEnabled: true }).ok).toBe(false);
    expect(parseExtractionResponse('note {"candidates":[]}', { projectEnabled: true }).ok).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"profile","scope":"project","memory_type":"preference","text":"x"}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"profile","memory_type":"preference","text":"x","extra":1}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
  });

  it("rejects invalid scope, type, action, evidence, and project-disabled output", () => {
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"team","memory_type":"preference","text":"x"}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"profile","memory_type":"decision","text":"x"}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"profile","memory_type":"preference","text":"x","action":"merge"}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"profile","memory_type":"preference","text":"x","evidence":"Authorization: Bearer secret"}]}',
        { projectEnabled: true },
      ).ok,
    ).toBe(false);
    expect(
      parseExtractionResponse(
        '{"candidates":[{"scope":"project","memory_type":"decision","text":"x"}]}',
        { projectEnabled: false },
      ).ok,
    ).toBe(false);
  });

  it("rejects too many candidates, overlong text, and partial validity", () => {
    const tooMany = JSON.stringify({
      candidates: Array.from({ length: 21 }, () => ({
        scope: "profile",
        memory_type: "preference",
        text: "Keep answers concise.",
      })),
    });
    expect(parseExtractionResponse(tooMany, { projectEnabled: true }).ok).toBe(false);

    const overlong = JSON.stringify({
      candidates: [{ scope: "profile", memory_type: "preference", text: "x".repeat(1001) }],
    });
    expect(parseExtractionResponse(overlong, { projectEnabled: true }).ok).toBe(false);

    const partial = JSON.stringify({
      candidates: [
        { scope: "profile", memory_type: "preference", text: "valid" },
        { scope: "profile", memory_type: "decision", text: "invalid" },
      ],
    });
    expect(parseExtractionResponse(partial, { projectEnabled: true }).ok).toBe(false);
  });
});

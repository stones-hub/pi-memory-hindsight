import { describe, expect, it } from "vitest";
import { capRecallItems, estimateTokens, RECALL_MAX_ITEMS, RECALL_MAX_TOKENS } from "../src/recall/token-budget.js";
import {
  detectLanguageFromEnv,
  detectLanguageFromLocale,
  normalizeLanguage,
  t,
} from "../src/i18n/messages.js";

describe("token budget", () => {
  it("caps by item count and approximate token count deterministically", () => {
    const elevenItems = Array.from({ length: RECALL_MAX_ITEMS + 1 }, (_, i) => ({ text: `item-${i}` }));
    expect(capRecallItems(elevenItems)).toHaveLength(RECALL_MAX_ITEMS);

    const big = Array.from({ length: 10 }, (_, i) => ({ text: "x".repeat(700), id: i }));
    const capped = capRecallItems(big);
    expect(capped.length).toBeLessThan(10);
    expect(capped.reduce((sum, item) => sum + estimateTokens(item.text), 0)).toBeLessThanOrEqual(
      RECALL_MAX_TOKENS,
    );
  });

  it("does not undercount CJK text as chars divided by four", () => {
    const chinese = "记".repeat(1500);
    expect(estimateTokens(chinese)).toBeGreaterThan(RECALL_MAX_TOKENS);
    expect(capRecallItems([{ text: chinese }])).toHaveLength(0);
  });
});

describe("i18n", () => {
  it("normalizes and detects Chinese locales", () => {
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("en_US")).toBe("en");
    expect(detectLanguageFromLocale("zh_TW.UTF-8")).toBe("zh");
    expect(detectLanguageFromEnv({ LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: undefined, LANG: undefined })).toBe("zh");
  });

  it("falls back to English strings for unknown language or key", () => {
    expect(detectLanguageFromEnv({ LC_ALL: undefined, LC_MESSAGES: undefined, LANG: undefined })).toBe("en");
    expect(t("zh", "memory.on")).toContain("已开启");
    expect(t("zh", "nonexistent.key")).toBe("nonexistent.key");
  });
});

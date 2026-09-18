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

  it("formats optional recall score diagnostics without inventing thresholds", () => {
    expect(
      t("en", "memory.last.item", {
        id: "m1",
        scope: "profile",
        type: "preference",
        text: "Prefer concise answers.",
        scores: t("en", "memory.last.scores", {
          final: 1.0986786712451455,
          reranker: "null",
          semantic: 0.8,
          keyword: "null",
        }),
      }),
    ).toContain("scores(final=1.0986786712451455, reranker=null, semantic=0.8, keyword=null)");
    expect(
      t("en", "memory.last.item", {
        id: "m1",
        scope: "profile",
        type: "preference",
        text: "Prefer concise answers.",
        scores: "",
      }),
    ).toBe("- m1 [profile/preference] Prefer concise answers.");
  });

  it("covers every supported /memory command form in grouped bilingual help", () => {
    const requiredForms = [
      "/memory help",
      "/memory status",
      "/memory on",
      "/memory off",
      "/memory remember <scope> <type> <content>",
      "/memory update <memory-id> <content>",
      "/memory forget <memory-id>",
      "/memory list",
      "/memory list profile",
      "/memory list project",
      "/memory show <memory-id>",
      "/memory last",
      "/memory candidates",
      "/memory candidates list",
      "/memory candidates approve <candidate-id>",
      "/memory candidates reject <candidate-id>",
      "/memory candidates edit-approve <candidate-id> <content>",
      "/memory cleanup status",
      "/memory cleanup now",
      "/memory language zh",
      "/memory language en",
      "/memory reflect profile <query>",
      "/memory reflect project <query>",
    ];
    const groups = {
      en: [
        "Help and status",
        "Session controls",
        "Formal memory creation, update, and deletion",
        "Memory discovery",
        "Candidate review",
        "Cleanup",
        "Language",
        "Reflection",
      ],
      zh: ["帮助与状态", "会话控制", "正式记忆的创建、更新与删除", "记忆发现", "候选审阅", "清理", "语言", "回顾"],
    } as const;

    for (const language of ["en", "zh"] as const) {
      const help = t(language, "memory.help");
      for (const group of groups[language]) {
        expect(help).toContain(group);
      }
      for (const form of requiredForms) {
        expect(help).toContain(form);
      }
      expect(help).toContain("preference|habit");
      expect(help).toContain("project_fact|decision|lesson|task_state|inference");
      expect(help.split("\n").some((line) => /^\s*\/memory extract(?:\s|$)/.test(line))).toBe(false);
    }

    const english = t("en", "memory.help");
    expect(english).toContain("interactive TUI only");
    expect(english).toContain("Requires confirmation");
    expect(english).toContain("There is no /memory extract command");
    const chinese = t("zh", "memory.help");
    expect(chinese).toContain("仅交互式 TUI");
    expect(chinese).toContain("需要确认");
    expect(chinese).toContain("没有 /memory extract 命令");
  });
});

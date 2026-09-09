import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GlobalRuntime } from "../runtime/global-runtime.js";
import { resolveProjectBank } from "../runtime/project-runtime.js";
import { looksLikeBulkContent, scanForSensitiveContent, truncateUnicode } from "../security/filters.js";
import { normalizeLanguage, t } from "../i18n/messages.js";
import { validateQueryInput } from "../provider/validation.js";

const REFLECT_MAX_TOKENS = 700;
const REFLECT_MAX_TEXT = 1200;

export type ReflectResult =
  | { outcome: "ok"; text: string }
  | { outcome: "cancelled" }
  | { outcome: "rejected"; reason: string };

export async function reflectMemory(
  runtime: GlobalRuntime,
  ctx: ExtensionContext,
  scope: "profile" | "project",
  query: string,
): Promise<ReflectResult> {
  if (ctx.mode !== "tui") {
    return { outcome: "rejected", reason: "reflect requires tui mode" };
  }
  const language = normalizeLanguage(runtime.profile.language);
  const queryCheck = validateQueryInput(query, REFLECT_MAX_TOKENS);
  if (!queryCheck.ok) {
    return { outcome: "rejected", reason: t(language, "reflect.invalid_query") };
  }
  if (scanForSensitiveContent(queryCheck.value!.query).sensitive || looksLikeBulkContent(queryCheck.value!.query)) {
    return { outcome: "rejected", reason: t(language, "reflect.invalid_query") };
  }

  let bankId = runtime.profileBankId;
  if (scope === "project") {
    const projectBank = await resolveProjectBank(ctx.cwd);
    if (!projectBank.enabled) {
      return { outcome: "rejected", reason: t(language, "reflect.project_unavailable") };
    }
    bankId = projectBank.bankId;
  }

  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      t(language, "reflect.confirm_title"),
      t(language, "reflect.confirm_body"),
    );
  } catch {
    return { outcome: "rejected", reason: t(language, "memory.unexpected_error") };
  }
  if (!confirmed) return { outcome: "cancelled" };

  let result;
  try {
    result = await runtime.adapter.reflect(
      {
        bankId,
        query: queryCheck.value!.query,
        budget: "mid",
        maxTokens: REFLECT_MAX_TOKENS,
      },
      ctx.signal,
    );
  } catch {
    return { outcome: "rejected", reason: t(language, "memory.unexpected_error") };
  }
  if (!result.ok) {
    return { outcome: "rejected", reason: t(language, "reflect.failed") };
  }
  return { outcome: "ok", text: truncateUnicode(result.value.text.trim(), REFLECT_MAX_TEXT) };
}

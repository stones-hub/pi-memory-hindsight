/**
 * Resolve the effective system prompt text from a provider Context.
 *
 * Pi 0.86+ normalizes Context into a transcript where the current prompt lives
 * in `messages` (system role). Official docs recommend `getCurrentSystemPrompt`.
 * This helper also accepts the legacy top-level `context.systemPrompt` shape so
 * older runtimes and loose test fixtures keep working.
 */

type ContentPart = { type?: string; text?: string };
type LooseMessage = { role?: string; content?: string | ContentPart[] | unknown };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is ContentPart => typeof part === "object" && part !== null && (part as ContentPart).type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

/**
 * Prefer replaying system messages (0.86 transcript). Fall back to the legacy
 * top-level `systemPrompt` field when no system messages are present (0.85).
 */
export function resolveEffectiveSystemPrompt(context: {
  systemPrompt?: string;
  messages?: readonly LooseMessage[];
}): string {
  const parts: string[] = [];
  for (const message of context.messages ?? []) {
    if (message?.role !== "system") continue;
    const text = contentToText(message.content);
    if (text.length > 0) parts.push(text);
  }
  if (parts.length > 0) {
    return parts.join("\n\n");
  }
  return typeof context.systemPrompt === "string" ? context.systemPrompt : "";
}

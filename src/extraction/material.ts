/**
 * Minimal extraction material selection (memory-policy.md "Extraction
 * source"): only `user`/`assistant` text content from the just-ended turn.
 * Thinking content, tool calls, and tool results never enter extraction
 * material — this keeps internal reasoning and raw tool output (which can
 * contain full files, logs, or secrets) out of the independent model call.
 */

import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

const MAX_SEGMENT_CHARS = 2000;

function truncateUnicode(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join("");
}

export function selectExtractionMaterial(messages: AgentEndEvent["messages"]): string {
  let userIndex = -1;
  let userText: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? [message.content.trim()]
        : message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text.trim())
            .filter(Boolean);
    if (content.length === 0) continue;
    userIndex = index;
    userText = content;
    break;
  }
  if (userIndex < 0) return "";

  let assistantText: string[] = [];
  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const visible = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean);
    if (visible.length === 0) continue;
    assistantText = visible;
    break;
  }
  if (userText.length === 0 || assistantText.length === 0) return "";

  return [
    `User: ${truncateUnicode(userText.join("\n"), MAX_SEGMENT_CHARS)}`,
    `Assistant: ${truncateUnicode(assistantText.join("\n"), MAX_SEGMENT_CHARS)}`,
  ].join("\n\n");
}

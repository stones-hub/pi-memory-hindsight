import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { ACCEPTANCE_MARKERS, RECALL_HEADER_RE } from "../../src/testing/acceptance-constants.js";

function lastUserText(messages: Context["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}

function assistant(model: Model<any>, text: string): AssistantMessage {
  const output: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: Math.max(1, Math.ceil(text.length / 4)),
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  output.usage.totalTokens = output.usage.input + output.usage.output;
  calculateCost(model, output.usage);
  return output;
}

function buildResponse(model: Model<any>, context: Context, _options?: SimpleStreamOptions): AssistantMessage {
  const prompt = lastUserText(context.messages);
  if (context.systemPrompt?.includes("Output STRICTLY one JSON object")) {
    return assistant(
      model,
      JSON.stringify({
        candidates: prompt.trim().length > 0
          ? [{ scope: "profile", memory_type: "preference", text: "Prefer durable summaries in future chats.", evidence: "The user asked for a durable preference." }]
          : [],
      }),
    );
  }
  if (prompt.includes("use_tool_remember")) {
    return {
      ...assistant(model, ""),
      content: [
        {
          type: "toolCall",
          id: "tool-remember-1",
          name: "memory_remember",
          arguments: {
            action: "create",
            scope: "profile",
            memoryType: "preference",
            content: "Prefer concise answers.",
          },
        },
      ],
      stopReason: "toolUse",
    };
  }
  const sawRecall = RECALL_HEADER_RE.test(context.systemPrompt ?? "");
  return assistant(model, `${ACCEPTANCE_MARKERS.promptRecallSeen}${sawRecall ? "true" : "false"}`);
}

export default function registerFakeProvider(pi: ExtensionAPI): void {
  pi.registerProvider("acceptance-local", {
    name: "Acceptance Local",
    baseUrl: "http://127.0.0.1/acceptance-local",
    apiKey: "acceptance-local",
    api: "openai-completions",
    models: [
      {
        id: "acceptance-local-model",
        name: "Acceptance Local Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2048,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output = buildResponse(model, context, options);
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        if (output.content[0]?.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: output.content[0], partial: output });
        } else {
          const text = output.content[0]?.type === "text" ? output.content[0].text : "";
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        }
        stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}

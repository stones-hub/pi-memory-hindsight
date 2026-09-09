import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getGlobalRuntime } from "../runtime/global-runtime.js";
import { remember, textHashOf } from "../governance/remember-service.js";
import { replaceMemory } from "../governance/replace-service.js";
import { normalizeLanguage, t } from "../i18n/messages.js";

function rememberErrorReason(
  result: Exclude<Awaited<ReturnType<typeof remember>>, { outcome: "written" } | { outcome: "duplicate" }>,
): string {
  switch (result.outcome) {
    case "rejected":
    case "conflict":
    case "unknown":
      return result.reason;
    case "in_progress":
      return "another remember operation is already in progress";
  }
}

function replaceErrorReason(
  result: Exclude<Awaited<ReturnType<typeof replaceMemory>>, { outcome: "replaced" }>,
): string {
  switch (result.outcome) {
    case "rejected":
    case "unknown":
      return result.reason;
    case "in_progress":
      return "another update operation is already in progress";
  }
}

function isValidScopeType(scope: string, memoryType: string): boolean {
  return (
    (scope === "profile" && (memoryType === "preference" || memoryType === "habit")) ||
    (scope === "project" &&
      ["project_fact", "decision", "lesson", "task_state", "inference"].includes(memoryType))
  );
}

const MemoryRememberParams = Type.Object(
  {
    action: StringEnum(["create", "update"] as const),
    scope: Type.Optional(StringEnum(["profile", "project"] as const)),
    memoryType: Type.Optional(
      StringEnum(
        ["preference", "habit", "project_fact", "decision", "lesson", "task_state", "inference"] as const,
      ),
    ),
    targetMemoryId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Exact local logical memory id to replace. Required for action=update; forbidden for create.",
      }),
    ),
    content: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        "Durable information to remember or write as a replacement. Use only when the user explicitly asks.",
    }),
  },
  { additionalProperties: false },
);

function malformedShape(
  params: {
    action: "create" | "update";
    scope?: "profile" | "project";
    memoryType?: string;
    targetMemoryId?: string;
  },
): string | null {
  if (params.action === "create") {
    if (params.targetMemoryId !== undefined) return "create must not include targetMemoryId";
    if (params.scope === undefined || params.memoryType === undefined) {
      return "create requires scope and memoryType";
    }
    if (!isValidScopeType(params.scope, params.memoryType)) {
      return "invalid scope/memoryType combination";
    }
    return null;
  }
  if (params.targetMemoryId === undefined || params.targetMemoryId.trim().length === 0) {
    return "update requires targetMemoryId";
  }
  if (params.scope !== undefined || params.memoryType !== undefined) {
    return "update must not supply scope or memoryType; they are resolved from the target row";
  }
  return null;
}

export function registerMemoryRememberTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description:
      "Create or update durable memory only when the user explicitly asks. action=create writes a new memory; action=update replaces one exact local logical memory id.",
    parameters: MemoryRememberParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: t("en", "memory.non_tui_noop") }],
          details: { outcome: "unsupported_mode" },
        };
      }
      const shapeError = malformedShape(params);
      if (shapeError) {
        return {
          content: [{ type: "text", text: t("en", "remember.rejected", { reason: shapeError }) }],
          details: { outcome: "rejected", code: "malformed_action_target" },
        };
      }
      try {
        const runtimeResult = await getGlobalRuntime();
        if (!runtimeResult.ok) {
          return {
            content: [{ type: "text", text: t("en", "memory.status.unavailable") }],
            details: { outcome: "disabled" },
          };
        }
        const runtime = runtimeResult.runtime;
        const language = normalizeLanguage(runtime.profile.language);

        if (params.action === "update") {
          const target = runtime.repos.memories.getById(params.targetMemoryId!);
          if (!target || target.status !== "active") {
            return {
              content: [
                {
                  type: "text",
                  text: t(language, "update.rejected", {
                    reason: target ? `target memory is not active (status: ${target.status})` : "target memory was not found",
                  }),
                },
              ],
              details: { outcome: "rejected", code: target ? "target_not_active" : "target_not_found" },
            };
          }
          const result = await replaceMemory(runtime, {
            targetMemoryId: target.id,
            scope: target.scope,
            memoryType: target.memory_type,
            text: params.content,
            cwd: ctx.cwd,
            sourceSessionId: ctx.sessionManager.getSessionId(),
            sourceRef: "tool:memory_remember:update",
            idempotencyKey: `tool:update:${target.id}:${target.text_hash}:${textHashOf(params.content)}`,
            expectedProjectIdentity: target.project_identity,
            expectedTargetTextHash: target.text_hash,
            owner: "tool",
            signal: _signal,
          });
          if (result.outcome === "replaced") {
            return {
              content: [{ type: "text", text: t(language, "update.saved", { id: result.memoryId }) }],
              details: { outcome: "replaced", memoryId: result.memoryId },
            };
          }
          return {
            content: [{ type: "text", text: t(language, "update.rejected", { reason: replaceErrorReason(result) }) }],
            details: { outcome: result.outcome },
          };
        }

        const result = await remember(runtime, {
          scope: params.scope!,
          memoryType: params.memoryType!,
          text: params.content,
          cwd: ctx.cwd,
          sourceSessionId: ctx.sessionManager.getSessionId(),
          sourceRef: "tool:memory_remember",
          owner: "tool",
          signal: _signal,
        });
        if (result.outcome === "written") {
          return {
            content: [
              {
                type: "text",
                text: t(language, "remember.saved", {
                  scope: params.scope!,
                  type: params.memoryType!,
                }),
              },
            ],
            details: { outcome: "written", memoryId: result.memoryId },
          };
        }
        if (result.outcome === "duplicate") {
          return {
            content: [{ type: "text", text: t(language, "remember.duplicate_brief") }],
            details: { outcome: "duplicate", memoryId: result.memoryId },
          };
        }
        return {
          content: [{ type: "text", text: t(language, "remember.rejected", { reason: rememberErrorReason(result) }) }],
          details: { outcome: result.outcome },
        };
      } catch {
        return {
          content: [{ type: "text", text: t("en", "memory.unexpected_error") }],
          details: { outcome: "error" },
        };
      }
    },
  });
}

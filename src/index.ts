import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommand } from "./commands/memory-command.js";
import { handleAgentEnd, handleAgentSettled } from "./extraction/extraction-service.js";
import { registerMemoryRememberTool } from "./tools/memory-remember-tool.js";
import { handleBeforeAgentStart } from "./recall/recall-service.js";
import { restoreSessionMemoryState } from "./runtime/session-persistence.js";
import { noteInputEvent, noteTurnStart, peekSessionState, shutdownSessionState } from "./runtime/session-runtime.js";

function swallowSync(fn: () => void): void {
  try {
    fn();
  } catch {
    // Fail open: memory must never break normal Pi operation.
  }
}

async function swallowAsync<T>(fn: () => Promise<T>): Promise<T | void> {
  try {
    return await fn();
  } catch {
    // Fail open: memory must never break normal Pi operation.
  }
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  if ("registerCommand" in pi && typeof pi.registerCommand === "function") {
    registerMemoryCommand(pi);
  }
  if ("registerTool" in pi && typeof pi.registerTool === "function") {
    registerMemoryRememberTool(pi);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    swallowSync(() => {
      restoreSessionMemoryState(ctx.sessionManager);
    });
  });

  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    swallowSync(() => {
      noteInputEvent(ctx.sessionManager.getSessionId(), event);
    });
  });

  pi.on("turn_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    swallowSync(() => {
      noteTurnStart(ctx.sessionManager.getSessionId(), event);
    });
  });

  pi.on("before_agent_start", (event, ctx) =>
    swallowAsync(() => handleBeforeAgentStart(event, ctx)),
  );

  pi.on("agent_end", (event, ctx) => {
    swallowSync(() => {
      handleAgentEnd(event, ctx);
    });
  });

  pi.on("agent_settled", (event, ctx) =>
    swallowAsync(() => handleAgentSettled(event, ctx)),
  );

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui" && !peekSessionState(ctx.sessionManager.getSessionId())) return;
    swallowSync(() => {
      shutdownSessionState(ctx.sessionManager.getSessionId());
    });
  });
};

export default extension;
export { appendSessionMemoryState, MEMORY_SESSION_STATE_ENTRY_TYPE } from "./runtime/session-persistence.js";

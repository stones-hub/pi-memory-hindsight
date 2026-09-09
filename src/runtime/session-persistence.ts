import type { ExtensionAPI, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { getSessionState } from "./session-runtime.js";

export const MEMORY_SESSION_STATE_ENTRY_TYPE = "pi-memory-hindsight:session-state";
type SessionManagerView = Pick<SessionManager, "getSessionId" | "getBranch">;

interface SessionStateEntryV1 {
  v: 1;
  memoryOff: boolean;
}

function parseStateEntry(entry: SessionEntry): SessionStateEntryV1 | null {
  if (entry.type !== "custom" || entry.customType !== MEMORY_SESSION_STATE_ENTRY_TYPE) {
    return null;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("memoryOff")) {
    return null;
  }
  if ((data as { v?: unknown }).v !== 1 || typeof (data as { memoryOff?: unknown }).memoryOff !== "boolean") {
    return null;
  }
  return data as SessionStateEntryV1;
}

export function restoreSessionMemoryState(sessionManager: SessionManagerView): void {
  const sessionId = sessionManager.getSessionId();
  const state = getSessionState(sessionId);
  state.memoryOff = false;
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === MEMORY_SESSION_STATE_ENTRY_TYPE) {
      const parsed = parseStateEntry(entry);
      if (parsed) {
        state.memoryOff = parsed.memoryOff;
      }
      return;
    }
  }
}

export function appendSessionMemoryState(pi: Pick<ExtensionAPI, "appendEntry">, memoryOff: boolean): void {
  pi.appendEntry<SessionStateEntryV1>(MEMORY_SESSION_STATE_ENTRY_TYPE, { v: 1, memoryOff });
}

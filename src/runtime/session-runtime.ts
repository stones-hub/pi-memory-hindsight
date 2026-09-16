/**
 * Per-Pi-session mutable state for automatic lifecycle behavior.
 *
 * State is keyed by Pi's real Session ID so multiple windows stay isolated.
 * It tracks:
 * - persisted `/memory off|on` state restored from custom Session entries;
 * - last recall diagnostics for future `/memory last`;
 * - the pending ordinary user input and claimed Recall identities (gates
 *   automatic Recall — deliberately independent of turn/extraction state,
 *   since `before_agent_start` fires before `turn_start` for a new prompt);
 * - current logical turn index, used only for extraction source/scheduling;
 * - the latest eligible `agent_end` snapshot paired with `agent_settled`;
 * - in-flight extraction cancellation and duplicate-run suppression.
 */

import { createHash } from "node:crypto";
import type { InputEvent, TurnStartEvent } from "@earendil-works/pi-coding-agent";
import type { MemoryType, Scope } from "../db/types.js";

export interface LastRecallDiagnostic {
  injectedAt: string;
  promptPreview: string;
  items: {
    scope: Scope;
    memoryType: MemoryType;
    text: string;
    /** Local logical id when governed locally; null for shared Project-only recalls. */
    memoryId: string | null;
    readOnlyShared: boolean;
  }[];
}

export interface PendingExtractionSnapshot {
  turnIndex: number;
  runKey: string;
  material: string;
}

/** Ordinary (non-`steer`/`followUp`) input awaiting `before_agent_start`. */
export interface PendingOrdinaryInput {
  sequence: number;
  inputKey: string;
}

export interface SessionState {
  closed: boolean;
  memoryOff: boolean;
  lastRecall: LastRecallDiagnostic | null;
  inputSequence: number;
  pendingOrdinaryInput: PendingOrdinaryInput | null;
  claimedRecallInputKeys: string[];
  recallController: AbortController | null;
  currentTurnIndex: number | null;
  pendingExtraction: PendingExtractionSnapshot | null;
  processedExtractionRunKeys: string[];
  extractionQueue: Promise<void>;
  extractionController: AbortController | null;
}

const sessions = new Map<string, SessionState>();
const MAX_PROCESSED_RUN_KEYS = 32;
const MAX_CLAIMED_RECALL_INPUT_KEYS = 32;

function freshState(): SessionState {
  return {
    closed: false,
    memoryOff: false,
    lastRecall: null,
    inputSequence: 0,
    pendingOrdinaryInput: null,
    claimedRecallInputKeys: [],
    recallController: null,
    currentTurnIndex: null,
    pendingExtraction: null,
    processedExtractionRunKeys: [],
    extractionQueue: Promise.resolve(),
    extractionController: null,
  };
}

export function peekSessionState(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function getSessionState(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = freshState();
    sessions.set(sessionId, state);
  }
  return state;
}

/**
 * Records a model-turn boundary for extraction source/scheduling only.
 *
 * Deliberately does not touch Recall coordination state: `before_agent_start`
 * always fires and is fully awaited before the agent loop it started can
 * reach its own `turn_start`, so Recall claiming/aborting never needs to key
 * off turn changes, and keeping this function turn-only preserves the
 * required separation between Recall-input identity and extraction state.
 */
export function noteTurnStart(sessionId: string, event: TurnStartEvent): void {
  const state = getSessionState(sessionId);
  state.currentTurnIndex = event.turnIndex;
}

export function setSessionMemoryOff(sessionId: string, memoryOff: boolean): SessionState {
  const state = getSessionState(sessionId);
  state.memoryOff = memoryOff;
  if (memoryOff) {
    state.recallController?.abort();
    state.recallController = null;
    state.extractionController?.abort();
    state.extractionController = null;
    state.pendingExtraction = null;
  }
  return state;
}

/**
 * Records a new bounded identity for each ordinary (idle, non-queued)
 * submitted user input. Queued `steer`/`followUp` inputs are classified but
 * intentionally left untouched here so they can never overwrite or consume
 * the ordinary input identity that automatic Recall claims.
 */
export function noteInputEvent(sessionId: string, event: InputEvent): void {
  if (event.streamingBehavior) return;
  const state = getSessionState(sessionId);
  state.inputSequence += 1;
  state.pendingOrdinaryInput = {
    sequence: state.inputSequence,
    inputKey: `${sessionId}:input:${state.inputSequence}`,
  };
}

/**
 * Conservative identity for `before_agent_start` invocations reached without
 * an observed ordinary `input` event. Stores no prompt body — only a one-way
 * hash — and stays stable for repeated processing of the same request while
 * a later completed turn's new leaf ID yields a distinct identity.
 */
function fallbackRecallInputKey(sessionId: string, leafId: string | null, prompt: string): string {
  const leaf = leafId ?? "no-leaf";
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  return `${sessionId}:fallback:${leaf}:${promptHash}`;
}

export function tryClaimRecallInput(
  sessionId: string,
  fallback: { leafId: string | null; prompt: string },
): { state: SessionState; inputKey: string; controller: AbortController } | null {
  const state = peekSessionState(sessionId) ?? getSessionState(sessionId);
  const inputKey = state.pendingOrdinaryInput?.inputKey ?? fallbackRecallInputKey(sessionId, fallback.leafId, fallback.prompt);
  if (state.claimedRecallInputKeys.includes(inputKey)) return null;
  state.claimedRecallInputKeys.push(inputKey);
  if (state.claimedRecallInputKeys.length > MAX_CLAIMED_RECALL_INPUT_KEYS) {
    state.claimedRecallInputKeys.splice(0, state.claimedRecallInputKeys.length - MAX_CLAIMED_RECALL_INPUT_KEYS);
  }
  state.recallController?.abort();
  const controller = new AbortController();
  state.recallController = controller;
  return { state, inputKey, controller };
}

export function setPendingExtractionSnapshot(sessionId: string, material: string): void {
  const state = getSessionState(sessionId);
  if (state.currentTurnIndex === null) return;
  state.pendingExtraction = {
    turnIndex: state.currentTurnIndex,
    runKey: `${sessionId}:turn:${state.currentTurnIndex}`,
    material,
  };
}

export function clearPendingExtractionSnapshot(sessionId: string): void {
  const state = peekSessionState(sessionId);
  if (!state) return;
  state.pendingExtraction = null;
}

export function claimPendingExtractionSnapshot(sessionId: string): PendingExtractionSnapshot | null {
  const state = getSessionState(sessionId);
  const snapshot = state.pendingExtraction;
  state.pendingExtraction = null;
  if (!snapshot) return null;
  if (state.processedExtractionRunKeys.includes(snapshot.runKey)) {
    return null;
  }
  state.processedExtractionRunKeys.push(snapshot.runKey);
  if (state.processedExtractionRunKeys.length > MAX_PROCESSED_RUN_KEYS) {
    state.processedExtractionRunKeys.splice(0, state.processedExtractionRunKeys.length - MAX_PROCESSED_RUN_KEYS);
  }
  return snapshot;
}

export function enqueueSessionExtraction(sessionId: string, job: () => Promise<void>): Promise<void> {
  const state = getSessionState(sessionId);
  const next = state.extractionQueue.catch(() => undefined).then(job);
  state.extractionQueue = next.catch(() => undefined);
  return next;
}

export function isSessionStateCurrent(sessionId: string, state: SessionState): boolean {
  return sessions.get(sessionId) === state && !state.closed;
}

/** Aborts any in-flight extraction for `sessionId` and drops its state. */
export function shutdownSessionState(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) {
    state.closed = true;
    state.recallController?.abort();
    state.extractionController?.abort();
  }
  sessions.delete(sessionId);
}

export function resetAllSessionStateForTests(): void {
  sessions.clear();
}

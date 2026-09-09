/**
 * Per-Pi-session mutable state for automatic lifecycle behavior.
 *
 * State is keyed by Pi's real Session ID so multiple windows stay isolated.
 * It tracks:
 * - persisted `/memory off|on` state restored from custom Session entries;
 * - last recall diagnostics for future `/memory last`;
 * - current logical turn index for once-per-turn recall gating;
 * - the latest eligible `agent_end` snapshot paired with `agent_settled`;
 * - in-flight extraction cancellation and duplicate-run suppression.
 */

import type { TurnStartEvent } from "@earendil-works/pi-coding-agent";
import type { MemoryType, Scope } from "../db/types.js";

export interface LastRecallDiagnostic {
  injectedAt: string;
  promptPreview: string;
  items: { scope: Scope; memoryType: MemoryType; text: string }[];
}

export interface PendingExtractionSnapshot {
  turnIndex: number;
  runKey: string;
  material: string;
}

export interface SessionState {
  closed: boolean;
  memoryOff: boolean;
  lastRecall: LastRecallDiagnostic | null;
  currentTurnIndex: number | null;
  claimedRecallRunKeys: string[];
  recallController: AbortController | null;
  pendingExtraction: PendingExtractionSnapshot | null;
  processedExtractionRunKeys: string[];
  extractionQueue: Promise<void>;
  extractionController: AbortController | null;
}

const sessions = new Map<string, SessionState>();
const MAX_PROCESSED_RUN_KEYS = 32;
const MAX_CLAIMED_RECALL_RUN_KEYS = 32;

function freshState(): SessionState {
  return {
    closed: false,
    memoryOff: false,
    lastRecall: null,
    currentTurnIndex: null,
    claimedRecallRunKeys: [],
    recallController: null,
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

export function noteTurnStart(sessionId: string, event: TurnStartEvent): void {
  const state = getSessionState(sessionId);
  if (state.currentTurnIndex !== event.turnIndex) {
    state.recallController?.abort();
    state.recallController = null;
  }
  state.currentTurnIndex = event.turnIndex;
}

export function currentTurnRunKey(sessionId: string): string | null {
  const state = getSessionState(sessionId);
  if (state.currentTurnIndex === null) return null;
  return `${sessionId}:turn:${state.currentTurnIndex}`;
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

export function tryClaimRecallRun(sessionId: string): { state: SessionState; runKey: string; controller: AbortController } | null {
  const state = peekSessionState(sessionId) ?? getSessionState(sessionId);
  const runKey = currentTurnRunKey(sessionId);
  if (!runKey) return null;
  if (state.claimedRecallRunKeys.includes(runKey)) return null;
  state.claimedRecallRunKeys.push(runKey);
  if (state.claimedRecallRunKeys.length > MAX_CLAIMED_RECALL_RUN_KEYS) {
    state.claimedRecallRunKeys.splice(0, state.claimedRecallRunKeys.length - MAX_CLAIMED_RECALL_RUN_KEYS);
  }
  state.recallController?.abort();
  const controller = new AbortController();
  state.recallController = controller;
  return { state, runKey, controller };
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

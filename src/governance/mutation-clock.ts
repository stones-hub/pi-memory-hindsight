/**
 * Controllable wall clock for mutation lease detection.
 * Production uses Date.now(); tests advance time without sleeping.
 */

let nowMsImpl: () => number = () => Date.now();

export function mutationNowMs(): number {
  return nowMsImpl();
}

export function mutationNowIso(): string {
  return new Date(mutationNowMs()).toISOString();
}

/** Test-only: pin or replace the mutation clock. */
export function setMutationNowForTests(nowMs: number | (() => number)): void {
  nowMsImpl = typeof nowMs === "number" ? () => nowMs : nowMs;
}

export function advanceMutationNowForTests(deltaMs: number): void {
  const base = nowMsImpl();
  nowMsImpl = () => base + deltaMs;
}

export function resetMutationNowForTests(): void {
  nowMsImpl = () => Date.now();
}

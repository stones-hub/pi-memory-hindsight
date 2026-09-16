# Automatic recall user-input gating

Status: released as `v0.2.3` on 2026-09-16; packaged-Pi acceptance and independent Claude Code review both **PASS**. A follow-up narrow fix closed a gap Pi's diff review found: `handleBeforeAgentStart` checked `/memory off` before claiming the input identity, so an off input's later duplicate `before_agent_start` callback could retroactively Recall once memory was turned back on; the claim now happens first, unconditionally, before the `memoryOff` check, with `tests/lifecycle.test.ts` covering off-input-first-callback, same-input duplicate-while-off, same-old-input-after-on, and new-input-after-on. Implementation touched `src/index.ts`, `src/runtime/session-runtime.ts`, `src/recall/recall-service.ts`, `tests/lifecycle.test.ts`, `tests/integration.test.ts`, `scripts/acceptance-pi.mjs`, `tests/e2e-harness/fake-provider.ts`, and `src/testing/acceptance-constants.ts`.

## Problem

Automatic Recall currently depends on `turn_start.turnIndex` being recorded before `before_agent_start`. Pi 0.85.1 emits those events in the opposite order for a newly submitted prompt:

```text
input
→ before_agent_start
→ agent_start
→ turn_start
```

As a result, the first prompt in a new Session has no current turn index and Recall is skipped. Later prompts can be associated with the previous model-turn index. Existing unit tests hide this defect by calling `noteTurnStart()` before `handleBeforeAgentStart()`, and packaged acceptance hides it with a warmup prompt.

`turn_start` identifies a model execution turn, not a submitted user input, so it is not a reliable Recall identity.

## Decision

### Use user-input identity for ordinary prompts

Register the public Pi `input` event and maintain a bounded, in-memory sequence per Pi Session. Each accepted ordinary user input gets a new identity such as:

```text
<session-id>:input:<sequence>
```

The `input` handler only records bounded metadata needed for coordination. It performs no SQLite or Hindsight I/O and does not retain the input body.

At `before_agent_start`, atomically claim the pending input identity before any asynchronous work. A claimed identity gets at most one Recall attempt, including when Recall finds no match, fails, times out, or is cancelled. Concurrent callbacks, model/tool continuation, retry, or compaction retry must not produce another Recall for that identity.

A later accepted ordinary input receives a new identity and may Recall again, even when its text is identical to an earlier input. Prompt text hashes alone must not define user-input identity.

### Conservative fallback

If `before_agent_start` is reached through a path that did not emit `input`, derive a bounded fallback identity from:

- Pi Session ID;
- the current Session leaf ID, or an explicit empty-leaf marker;
- a one-way hash of the expanded prompt.

The fallback stores no prompt body. Repeated processing of the same request must produce the same fallback identity, while a later completed user turn changes the Session leaf and therefore permits a new Recall even for identical text.

Implementation must validate this assumption against Pi 0.85.1 behavior and fail conservatively if a stable identity cannot be formed.

### Keep extraction turn state separate

`turn_start.turnIndex` remains available for settled candidate-extraction source references and scheduling. It no longer gates or identifies automatic Recall. Recall coordination and extraction coordination must be separate state with separate names and tests.

### Session and switch behavior

Input sequence, pending input identity, claimed Recall identities, and Recall controllers are process-memory state scoped by the real Pi Session ID. They are bounded and removed on Session shutdown. `/new`, `/resume`, and `/fork` therefore bind fresh extension state and cannot inherit a claim from another Session.

The existing persisted `/memory off|on` setting remains body-free and unchanged.

## Ordinary prompt behavior

- First prompt in a new Session: one Recall attempt is allowed.
- A later ordinary follow-up after the run settles: a new identity allows one new Recall attempt.
- Two separately submitted prompts with identical text: each may Recall once.
- Tool loops, automatic retry, and compaction retry without new user input: no second Recall.
- Concurrent handling of one input: the identity is claimed before awaiting, so only one caller performs Recall.
- `/memory off`: no provider Recall. Turning memory on affects the next new eligible input; it does not retroactively Recall for an already processed input.
- Recall timeout/failure: Pi work continues and the same input is not retried.

## Steering and follow-up limitation

Pi 0.85.1 exposes `streamingBehavior: "steer" | "followUp"` on the `input` event, but queued messages are delivered inside the already-running Agent loop without a new `before_agent_start` event. The Extension therefore has no supported per-queued-user-message hook that can safely provide a new turn-specific system prompt.

For this fix:

- classify and track queued `steer` and `followUp` inputs so they cannot be mistaken for an ordinary pending prompt;
- do not perform a separate Recall for them;
- do not let them consume or overwrite the next ordinary prompt's Recall identity;
- do not persist recalled text as a Session/custom message;
- do not modify Pi internals or provider-specific payloads to simulate support.

Full Recall for queued steering/follow-up messages is deferred until Pi exposes a public hook for each user message immediately before it is sent to the model, with a stable message identity and turn-specific system-prompt modification. A future alternative based on transient `context` messages requires a separate security and provider-compatibility design.

## State shape

The exact names may change during implementation, but responsibilities must remain separate:

```text
inputSequence                 next per-Session accepted-input sequence
pendingOrdinaryInput          ordinary input awaiting before_agent_start
claimedRecallInputKeys        bounded set/list of already attempted identities
recallController              current cancellable Recall operation
currentTurnIndex              model-turn state used by extraction only
```

No new database table or migration is required. No user prompt body is stored in SQLite, Hindsight, custom Session entries, or Recall diagnostics.

## Implementation scope

Expected implementation files:

- `src/index.ts`
- `src/runtime/session-runtime.ts`
- `src/recall/recall-service.ts`
- `tests/lifecycle.test.ts`
- `tests/integration.test.ts`
- `scripts/acceptance-pi.mjs`
- directly related documentation

Out of scope:

- SQLite schema changes;
- Hindsight Bank, document, or metadata-format changes;
- changes to governed write, approval, discovery, or deletion behavior;
- Pi core/internal imports;
- full queued steering/follow-up Recall;
- live user Pi configuration, Memory SQLite, or Hindsight mutation.

## Required tests

### Event order and first prompt

- Exercise `input → before_agent_start → agent_start → turn_start`, not the artificial reverse order.
- A fresh Session's first eligible prompt performs one Recall.
- Packaged Pi acceptance has no warmup prompt before the Recall assertion.

### Deduplication and new inputs

- Concurrent `before_agent_start` handling for one identity performs one attempt.
- Tool loops, automatic retry, and compaction retry do not repeat Recall.
- No-match, provider failure, and timeout do not retry within the same input.
- A later ordinary input Recalls again.
- Two separately submitted identical texts Recall independently.
- Profile and enabled Project Banks are each queried at most once per attempt.
- At most one successful-injection notification is emitted per identity.

### Queued input behavior

- `steer` and `followUp` are classified but do not trigger unsafe Recall injection.
- They do not overwrite or consume the next ordinary input identity.
- They do not cause the preceding ordinary input to Recall again.

### Session, mode, and switch isolation

- Concurrent Pi Sessions do not share input sequence or claims.
- shutdown aborts in-flight Recall and rejects late injection.
- `/new`, `/resume`, and `/fork` do not inherit old claims.
- `/memory off|on` behavior remains correct.
- print, JSON, and RPC modes perform no automatic Recall state, provider, model, UI, or Session-entry work.

### Safety and persistence

- Recall is still returned only through a turn-specific `systemPrompt`.
- Recalled text is absent from Session JSONL and SQLite.
- Input bodies are absent from coordination state persistence and diagnostics.
- Existing scope, lifecycle, conflict, sensitivity, bulk-content, count, and token filters remain unchanged.

## Independent verification and acceptance

After separate coding authorization, the executor and Pi must independently run the affected tests, full test suite, typecheck, build, package dry-run, production audit, `git diff --check`, and source/test byte scans required by the project.

The packaged real-Pi acceptance must use an isolated temporary `PI_CODING_AGENT_DIR`, temporary SQLite, loopback Mock Hindsight, and the current packed candidate. It must prove:

1. the first prompt in a fresh Session performs exactly one Recall request;
2. the model request sees the Recall block;
3. Session JSONL does not persist recalled text;
4. tool continuation does not produce another Recall;
5. a later ordinary prompt produces one new Recall;
6. `/memory off|on` remains correct;
7. a queued steering/follow-up probe causes no duplicate or persisted injection;
8. no live user Memory database, Hindsight data, or Pi configuration is accessed or changed.

## Completion criteria

The fix is complete only when first-prompt Recall works, each ordinary user input is attempted at most once, later ordinary inputs remain eligible even with identical text, model/tool/retry loops do not duplicate Recall, extraction behavior has no regression, the packaged Pi acceptance passes without a warmup workaround, and the queued-message limitation is documented honestly.

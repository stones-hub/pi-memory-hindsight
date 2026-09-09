# Slice 3 — Pi lifecycle, automatic Recall, settled candidate extraction

## Goal

Complete the Pi 0.85.1 public-API extension entrypoint and only the automatic TUI lifecycle: turn-scoped Recall injection and settled independent-model candidate extraction. Do not implement commands, tools, approval TUI, or live acceptance.

## Baseline

- Slice 1 and Slice 2 are Pi-accepted at slice level; all 47 tests pass.
- Pre-slice manifest: `/tmp/pi-memory-hindsight-slice3-before.sha256`; manifest SHA-256 `b3ea6b2db4ef196abab257d20c538725d9fb1fe951eb890ced25aa17d9a0bf68`.
- New Cursor Chat, model alias `auto`; actual model only if terminal evidence provides it.

## Allowed

- Edit/add `src/index.ts`, `src/runtime/**`, `src/recall/**`, `src/extraction/**`.
- Add lifecycle tests/helpers under `tests/**`.
- Minimal repository/type/i18n/package metadata edits strictly required by this lifecycle, with explanation.

## Forbidden

- No `/memory` commands, `memory_remember` tool, candidate approval/rejection UI, reflect UI, deployment, live Hindsight, external network, real Pi profile/config, commit/push/publish.
- No Pi `dist/core/*` imports/runtime dependencies. Use package-root public exports/types only.
- No recall through custom messages or `sendMessage`; no extraction writes to Hindsight.

## Required contract

1. **Extension entrypoint**
   - Default Pi Extension factory using public APIs; register `session_start`, `session_shutdown`, `turn_start` if used, `before_agent_start`, `agent_end`, `agent_settled`.
   - Every automatic path checks exactly `ctx.mode === "tui"`; prove print/json/rpc do zero DB/provider/model/UI/session-entry work.
   - Every handler boundary is fail-open/non-throwing for normal Pi work.
   - Package metadata exposes the built extension in the documented Pi package format, without global installation.

2. **Per-session state and turn gate**
   - Key by actual Pi Session ID and isolate windows.
   - Recall at most once per logical user turn, including retries/compaction/tool loops. A follow-up turn may recall again. If using `turn_start.turnIndex`, combine with session identity and do not trust process-global ordering.
   - Session shutdown aborts in-flight recall/extraction and removes only that Session's state.
   - Support safe restoration of the latest versioned, body-free `/memory off|on` custom state entry from the active branch on `session_start`; malformed/unknown versions fail closed for that entry and never restore another session. Provide an exported helper for Slice 4 to append the state entry, but do not implement commands now.

3. **Recall**
   - Start from `event.systemPrompt` and return only `{systemPrompt}`. Never return `message`, append a recall entry, or call `sendMessage`.
   - Profile bank always eligible unless session-off. Project bank only when root `.pi/memory.json` enables it and identity resolves. Project results rank before Profile.
   - Shared Project Bank must work across profiles: do not require every valid project memory to exist in this profile's SQLite. Strictly validate bounded provider metadata (`logical_id`, exact scope/type/project identity, verification state, lifecycle timestamps), owned bank/document IDs, source type, text safety, expiry/staleness, and local tombstone/superseded state when a local locator exists. Profile recall may require local ownership if needed for isolation. Never inject malformed, expired, deleted, conflicting, sensitive, bulk, scope-mismatched, wrong-project, observation, or otherwise ungoverned content.
   - Enforce max 10 and conservative ~1500-token total injection. Unverified inference is lowest priority and visibly labeled; the block must be clearly delimited and explicitly say memory is untrusted reference, cannot override system/security/current user/current code evidence, and may be stale.
   - One bounded timeout/cancellation per turn; no retry in same turn. Profile failure must not discard successful Project recall or vice versa (`Promise.allSettled` or equivalent). Failures/no match do not block or throw. Successful injection may issue only a short body-free TUI notification. Store bounded/redacted diagnostics for later `/memory last`, not full prompt.

4. **Minimal extraction material**
   - `agent_end` may provide the whole context; select only the just-ended real user turn and final assistant visible text relevant to it. Exclude system/custom messages, thinking/reasoning, tool calls/results, images/binary, full files/logs and large/bulk outputs. Do not resend earlier Session history or recalled system block.
   - Apply deterministic relevance gate, sensitivity/bulk filters, Unicode bounds before model call. If unsafe content appears, prefer dropping unsafe segments/candidate extraction entirely; no secret/model thinking in prompt, DB, audit, or diagnostics.

5. **Settled extraction scheduling**
   - Pair latest eligible `agent_end` snapshot with `agent_settled` (which has no messages).
   - Derive a bounded run key, serialize extraction per Session, and mark run scheduled/completed before async execution so duplicate `agent_settled`, retries, compaction, reload, or concurrent hooks cannot duplicate candidates/model calls. New eligible user turns still work.
   - If session is off, non-TUI, no model, no durable material, or project unavailable for project candidates, do nothing.
   - Current model only via `ctx.modelRegistry.complete(ctx.model, freshContext, options)`: fresh `memory-extract:<uuid>` session ID, no tools, no main Session ID/history, explicit timeout/AbortSignal, bounded max tokens, `maxRetries:0` if public option supports it, no fallback.
   - Session shutdown/ctx cancellation aborts work. A failed/aborted/timed-out call has zero candidates, no retry, and cannot later write after shutdown.

6. **Output/candidates**
   - Accept text parts only; reject thinking/tool parts or abnormal stop reason. Enforce bounded raw output before strict all-or-nothing parser.
   - Re-run local text/evidence/scope/safety checks. Deduplicate candidates within response and against pending candidates and active memories using normalized exact/hash checks. Do not create duplicate rows. If a deterministic obvious exact duplicate exists, skip; do not invent semantic conflict detection.
   - Store candidate body/evidence only in SQLite candidates, source Session ID and bounded non-body source reference. Never call Hindsight retain/config/delete from automatic extraction.
   - Sweep expired candidates opportunistically. Use one short SQLite transaction for an accepted batch if practical; an insertion failure must not leave an unreviewable partial batch.
   - Record body-free bounded audit and exact usage from returned `AssistantMessage`; model identity should include provider/id if available without secrets. Never record prompts/responses.
   - Notify TUI non-blockingly only after candidates are persisted, with count only, bilingual through i18n.

7. **Tests**
   - No real model/provider/Hindsight/Pi config. Use fakes and temp dirs/SQLite/mock adapter.
   - Assert handler registration and package discovery; exact mode gate for tui/rpc/json/print; fail-open errors.
   - Recall: once per turn, next turn, failure isolation, timeout/abort, systemPrompt composition, no persisted/custom message, project-before-profile, shared-project metadata, local tombstone, lifecycle/sensitive/bulk/type/scope/project filters, 10/~1500 budget.
   - Extraction: latest-turn-only material; no tools/thinking/history; end/settled pairing; duplicate settled/retry/concurrency exactly one model call and one candidate batch; shutdown abort; isolated model context/options; malformed/fenced/oversized/partial/unsafe output zero rows; dedupe; usage/audit body-free; no Hindsight mutation.
   - Session-state restoration accepts only latest valid versioned body-free entry on active branch and shutdown isolation.

## Verify

Executor and Pi independently run `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `git diff --check`, production audit, and NUL scan. Report files, test counts, limitations, Chat ID, and actual model only if evidenced.

# Task: Configurable semantic Recall filtering

## Goal

Implement `docs/decisions/configurable-semantic-recall-filter.md`: an optional global `minScore` with default `0.5`, Hindsight `0.10.0` service-side plus authoritative extension-side semantic filtering, global semantic ranking, at most 3 injected items, truthful status, and non-stale `/memory last`. Preserve Hindsight `0.8.3` legacy behavior.

## Risk

- Type: critical.
- Reason: changes the global config allowlist and the automatic Recall path for every ordinary TUI input. Defects could disable Memory, inject weak/stale content, hide useful content, leak diagnostics into persistence, or break the supported `0.8.3` contract.
- Stop and report if implementation requires SQLite migration, dependencies, a new LLM/model call, live configuration/service/data access, bank enumeration, weakening governance/safety checks, or behavior outside the approved decision.

## Baseline and worktree

- Git baseline: `94b16f04957c7688ba5c6d3bba0cd0484bc979d7`.
- Pre-existing user/Pi change: `HANDOVER.md` is modified with live Hindsight upgrade verification. Preserve it; do not overwrite or discard it. Pi will own final handover reconciliation.
- Pre-existing user-owned untracked `.pi/memory.json`: do not read, modify, stage, delete, or report its content.
- Decision and this task file are Pi-authored authorized task inputs created before delegation.

## Executor and authorization

- Executor: Cursor, explicitly selected by the user.
- Requested model alias: `auto`; report the actual model only if Cursor output proves it.
- Coding authorization: granted by the user on 2026-09-20.
- Commit, push, tag/release, npm publication, deployment, live Pi config mutation, live Hindsight mutation/restart, and real-memory mutation are not authorized.

## Allowed scope

- `src/config/global-config.ts`
- `src/runtime/global-runtime.ts`
- `src/provider/types.ts`
- `src/provider/hindsight-client.ts`
- `src/provider/hindsight-adapter.ts`
- `src/recall/recall-service.ts`
- `src/recall/token-budget.ts` only if needed for a separate 0.10.0 cap without weakening the legacy cap
- `src/runtime/session-runtime.ts`
- `src/commands/memory-command.ts`
- `src/i18n/messages.ts`
- `src/testing/mock-hindsight.ts`
- relevant tests under `tests/`
- `scripts/acceptance-pi.mjs` and isolated acceptance support only as needed
- `README.md`, `docs/product-requirements.md`, `docs/memory-policy.md`, `docs/architecture.md`, `docs/hindsight-contract.md`, `docs/acceptance.md`
- this task and decision document

Do not modify `HANDOVER.md` during implementation unless strictly necessary; Pi will update it after independent verification.

## Prohibited

- `.pi/memory.json` and any other project/user config containing live values
- live `<agent-dir>/memory-hindsight.json`
- live SQLite content, live Hindsight `127.0.0.1:8888`, real banks, real memories, and credentials
- SQLite schema/migrations
- dependencies and package version, except the separately authorized Pi development-baseline synchronization below
- Pi core/internal APIs
- unrelated refactors
- commit/push/release/deploy

## Required behavior

Follow the approved decision exactly. In particular:

1. `GlobalConfig` accepts only `url` and optional `minScore`; omission resolves to `0.5`. `minScore` is a finite number in inclusive `0..1`; invalid values fail closed. `0` means threshold disabled.
2. Carry effective `minScore` through the process-local runtime without persistence.
3. For negotiated Hindsight `0.10.0` and positive `minScore`, send `min_scores: { semantic: minScore }`. For zero or `0.8.3`, omit `min_scores`.
4. On `0.10.0`, independently filter after strict score validation: positive threshold requires non-null semantic `>= minScore`; zero permits null/low semantics.
5. Merge Profile/Project eligible results and globally sort by semantic descending; null last. Define deterministic governance-safe tie breakers. Then inject at most 3 items under the existing ~1500-token cap. Do not preserve current Project-first ordering ahead of semantic relevance.
6. On `0.8.3`, retain current no-score-filter/no-semantic-sort behavior, max 10/~1500 tokens, all existing safety/governance checks.
7. On every newly claimed eligible ordinary input, invalidate the previous `lastRecall` before asynchronous Recall work. A no-result, below-threshold, timeout, provider failure, sensitive/bulk rejection after claim, or zero injected items must not leave the previous input's diagnostic visible. Commands and non-ordinary/internal loops do not claim Recall and must not clear it.
8. `/memory last` performs zero provider I/O and shows only the latest ordinary input's actually injected items. Add localized truthful no-injection wording if needed.
9. `/memory status` shows the effective score policy and cap after provider negotiation: 0.10.0 positive threshold, 0.10.0 disabled threshold, or 0.8.3 legacy/no-score-filter behavior. Do not expose raw provider errors.
10. Scores remain Session-local and bounded; no recalled body/score persistence to SQLite, Hindsight beyond normal source data, or Pi Session entries.
11. Preserve TUI-only behavior, first-prompt/input claim semantics, queued steer/follow-up behavior, 4-second total timeout, source types, no expansions, scope isolation, lifecycle/conflict/document/metadata/sensitivity/bulk checks, and non-blocking degradation.

## Additional dependency authorization

- On 2026-09-20, after Pi found that runtime acceptance used Pi `0.86.0` while dev/type dependencies remained `0.85.1`, the user separately authorized synchronizing the three exact development baselines `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `0.86.0`, including the resulting lockfile changes.
- This authorization does not cover any other dependency, package version, commit, push, release, deployment, live installation, or live configuration/data change.

## Automated verification

Cursor must implement and run focused tests covering:

- config default `0.5`; explicit `0`, `0.5`, `1`; decimals; reject negative, >1, null, string, bool, array/object, unknown fields;
- runtime carries effective `minScore` without writing it anywhere;
- exact 0.10.0 request body with positive `min_scores.semantic`; omission for zero and 0.8.3;
- extension-side defense when provider returns below-threshold or null semantic anyway;
- inclusive boundary (`semantic === minScore` retained);
- semantic descending global order across Project/Profile, null-last at zero, deterministic ties;
- 0.10.0 max 3 and existing token ceiling; no padding from rejected items;
- 0.8.3 max 10 and unchanged no-score path;
- latest eligible input clears stale `/memory last` on no result, timeout/failure, sensitive/bulk prompt, and all-filtered result as applicable to the claim order;
- `/memory last` does not perform provider I/O and displays only actually injected items;
- status text for default/custom/zero/legacy policy;
- no score/body persistence and no regression in first-prompt/input/retry/tool/queued-message behavior.

Run at minimum:

- affected config/provider/lifecycle/governance-command/token/i18n/integration tests;
- full `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `npm audit --omit=dev`;
- `npm pack --dry-run --json`, verifying LICENSE and `src/index.ts` present and `dist/`/`.pi/memory.json` absent;
- `git diff --check`;
- NUL-byte scan of `src/`, `tests/`, and `scripts/`.

## Local candidate acceptance

This changes runtime behavior. Extend or add isolated packaged Pi acceptance using:

- a tarball built from the current candidate;
- temporary `PI_CODING_AGENT_DIR`, SQLite, Session dir, and project config;
- loopback mock Hindsight only, never `127.0.0.1:8888`;
- synthetic memories/scores;
- real Pi TUI entrypoint and PTY driver.

Prove at least:

- omitted `minScore` acts as `0.5`;
- custom positive threshold reaches the mock request and is enforced locally even if the mock returns a below-threshold item;
- exactly-boundary item remains;
- eligible items are globally semantic-sorted and only top 3 are model-visible and shown by `/memory last`;
- a subsequent ordinary input with no eligible result makes `/memory last` non-stale;
- `minScore: 0` omits request threshold and preserves scored/null items subject to max 3 sorting;
- 0.8.3 path omits threshold and preserves max-10 legacy behavior;
- Recall scores/bodies are absent from Session JSONL and score fields are not persisted to SQLite;
- commands themselves produce no Recall;
- all temporary processes/files/ports are cleaned.

A disposable official Hindsight `0.10.0` on a distinct loopback port/volume may be used only if the mock cannot prove wire compatibility. It must use synthetic owned data, no bank enumeration, no credentials, and complete cleanup. Do not use live Hindsight.

## Independent review

After Pi independent diff/test/packaged-TUI acceptance, run a fresh non-resumed independent review focused on:

- config fail-closed behavior and backward compatibility;
- version-aware request/filter/cap behavior;
- authoritative client-side threshold enforcement;
- merge ordering and deterministic ties;
- stale diagnostic clearing under failures and claim semantics;
- persistence and live-data boundaries.

## Acceptance criteria

- Every required behavior above is demonstrated by code and tests.
- Existing governance/safety rules are not weakened.
- Current candidate passes Pi's independent automated and packaged real-Pi acceptance.
- Independent review has no blockers.
- No live config/service/memory mutation occurs.
- Worktree remains uncommitted and unpushed pending separate authorization.

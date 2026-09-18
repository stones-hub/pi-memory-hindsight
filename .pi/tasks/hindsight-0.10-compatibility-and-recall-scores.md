# Task: Hindsight 0.10 compatibility and Recall score diagnostics

## Goal

Implement the approved `docs/decisions/hindsight-0.10-compatibility-and-recall-scores.md`: exact dual support for Hindsight `0.8.3` and `0.10.0`, strict native Recall-score validation, and bounded Session-local `/memory last` score diagnostics. Do not enable a relevance threshold in this task.

## Risk

Critical. This changes the provider compatibility gate and untrusted Recall response handling. A defect could allow an untested server, reject the current supported server, admit malformed scores, leak diagnostics into persistence, or weaken Recall governance.

Stop and report if implementation requires SQLite migration, live service/config access, a new LLM/model call, a fixed threshold, bank enumeration, or weakening any existing safety/governance rule.

## Baseline and authorization

- Git baseline: `268bdfe6827882fe80b62bd1f8a3ed61c589ba06`.
- User explicitly selected implementation route 1 on 2026-09-18: isolated Hindsight `0.10.0`, then extension compatibility implementation and validation.
- Executors: implementation used Cursor Agent with requested alias `auto` (actual model unproven); `v0.3.0` release-candidate version preparation used Claude Code with proven model `claude-fable-5-1`. Fresh independent review used Claude Code with proven model `claude-sonnet-5`.
- Coding and release-candidate preparation are authorized. Commit, push, release, deployment, live Hindsight upgrade/restart/migration, live Pi config changes, and live data access are not authorized.
- `.pi/memory.json` is pre-existing user-owned untracked data: do not read, modify, stage, or delete it.
- Release status (2026-09-18): the accepted local candidate is prepared as the `v0.3.0` release candidate. Only `package.json`, the root `package-lock.json` entries, the README current pinned install example, `HANDOVER.md`, and this task file changed for version preparation. The candidate remains uncommitted, unpushed, untagged, and unpublished; commit, push, tag, release, and npm publication still require separate authorization.

## Scope

Allowed implementation paths:

- `src/provider/types.ts`
- `src/provider/hindsight-client.ts`
- `src/provider/hindsight-adapter.ts`
- `src/recall/recall-service.ts`
- `src/runtime/session-runtime.ts`
- `src/commands/memory-command.ts`
- `src/i18n/messages.ts`
- `src/testing/mock-hindsight.ts`
- `src/testing/live-hindsight-acceptance.ts`
- relevant tests under `tests/`
- `scripts/acceptance-hindsight-live.mjs` only if strictly needed
- `README.md`, `docs/architecture.md`, `docs/hindsight-contract.md`, `docs/acceptance.md`
- this task file, the approved decision, and `HANDOVER.md`

Prohibited:

- `.pi/memory.json`
- SQLite schema/migrations or stored governance records
- real Hindsight at `127.0.0.1:8888`
- real Memory SQLite or user Pi configuration
- dependencies unless a demonstrated blocker requires renewed approval
- Pi core/internal APIs
- commit/push/release/deploy

## Required behavior

1. Compatibility accepts exactly `0.8.3` and `0.10.0`; all other versions fail closed with a bounded/redacted reason.
2. Capability state is associated with the adapter only after a successful compatibility check and must not leak across adapter instances. Recall before successful negotiation must remain safe and deterministic; choose a fail-closed design unless existing call flows/tests prove another design is required.
3. Recall score shape:
   - present `scores.final`: finite number, no `0..1` limit;
   - `reranker`, `semantic`, `keyword`: finite number or null;
   - on negotiated `0.10.0`, absent or malformed scores reject the whole Recall response;
   - on negotiated `0.8.3`, absent scores are allowed; a present object must validate.
4. Add narrow request typing for `min_scores`, but automatic Recall sends no threshold in this task.
5. Carry validated scores only for reconciled/injected items into bounded `lastRecall` state and `/memory last` display. Never persist scores to SQLite, Hindsight, or Session entries; never request/store trace payloads.
6. Preserve Recall semantics: 4-second total timeout, max 10/about 1500 tokens, Profile/Project separation, source types only, sensitive/bulk/lifecycle/conflict/document/metadata validation, TUI-only and non-persistent prompt injection.
7. Update list wire typing for `fact_type` without making governance depend on it.
8. Live acceptance supports exact expected version `0.8.3` or `0.10.0`, remains loopback/nonce/owned-bank guarded, and proves score shape for `0.10.0`. Preserve cleanup on failure.
9. Documentation truthfully distinguishes implemented compatibility from unselected threshold calibration and states that live rollback requires pre-upgrade database restore.

## Automated verification

Executor and Pi independently run:

- focused provider, lifecycle, integration, acceptance-safety, and token/i18n tests;
- full `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `npm audit --omit=dev`;
- `npm pack --dry-run --json` and inspect package identity/content (LICENSE and `src/index.ts`, no `dist/`);
- `git diff --check`;
- NUL-byte scan of `src/`, `tests/`, and `scripts/`.

Tests must include:

- accept `0.8.3` and `0.10.0`; reject nearby/unknown versions;
- `0.8.3` score absence allowed;
- `0.10.0` valid nullable score fields accepted;
- `final > 1` accepted;
- missing final, NaN/Infinity-equivalent malformed JSON values/types, arrays/strings/objects, and invalid optional values rejected;
- malformed one result rejects the complete response;
- diagnostics show scores only for injected reconciled results and remain bounded/session-local;
- no `min_scores` in automatic Recall request;
- no score persistence/regression in packaged Pi acceptance;
- existing update/delete/Reflect/config behavior remains green.

## Local candidate acceptance

- Build/package the current candidate.
- Run existing packaged Pi acceptance against its loopback mock and temporary Pi profile/SQLite; prove existing automatic Recall behavior remains non-persistent.
- Run disposable live Hindsight `0.10.0` acceptance only at `http://127.0.0.1:18888`, container `pi-memory-hindsight-0100-isolated`, independent volume `pi-memory-hindsight-0100-isolated-data`, synthetic nonce-derived bank, no API key, no bank enumeration.
- Prove `/version=0.10.0`, healthy database, owned config readback, chunks retain, exact one-unit verification, Recall scores including valid `final`, same-document replacement, delete acknowledgment, and known-document absence.
- Inspect isolated service logs for unexplained errors.
- Stop and remove the isolated container and volume after final acceptance. Delete `/tmp/pi-memory-hindsight-*` files created by this task after extracting required results into `HANDOVER.md`.

## Independent review

After Pi diff/test/live acceptance, run a fresh Claude Code review session (no resume), focused on exact version gating, negotiation state, malformed score fail-closed behavior, persistence boundaries, and acceptance isolation/cleanup.

## Acceptance criteria

- Both exact server versions work under their tested contracts; untested versions fail closed.
- Hindsight `0.10.0` scores are safely available in `/memory last`, with `final > 1` supported and null optional scores handled.
- No threshold or additional LLM call is introduced.
- Existing governance and non-persistence contracts remain intact.
- Current candidate passes all automated/package/real-Pi and isolated real-Hindsight checks, independent review, and cleanup.
- Worktree changes remain uncommitted and unpushed pending separate authorization.

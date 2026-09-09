# Slice 1 — Core foundation

## Goal

Audit and finish only the network-independent core foundation already present: global/project config, identity/bank IDs, SQLite schema/repositories/concurrency, security filters, lifecycle primitives, token budget, response parser, and i18n. Add comprehensive tests and leave provider/Pi integration behavior untouched except minimal type-only fixes needed for whole-project typecheck.

## Risk

Critical: local persistence, scope isolation, secret filtering, and concurrency underpin all later behavior.

## Baseline

- Uncommitted partial worktree after two timed-out executor calls.
- Pre-slice `src/` SHA manifest: `/tmp/pi-memory-hindsight-slice1-before.sha256`, manifest SHA `ebfa0615184c3425e14a7a9f6a78a7c402c9428143d24af664492fb40dc2f0e3`.
- `npm run typecheck` currently fails only on `exactOptionalPropertyTypes` calls in `src/provider/hindsight-client.ts`.
- `npm test` fails because no tests exist.

## Allowed

- Audit/edit `src/config/**`, `src/identity/**`, `src/db/**`, `src/security/**`, `src/recall/token-budget.ts`, `src/extraction/response-parser.ts`, `src/i18n/**`.
- Add tests for this slice under `tests/**`.
- Minimal mechanical typing fix in `src/provider/hindsight-client.ts` solely to make whole-project typecheck pass; do not redesign provider behavior.
- Adjust package/test/TS config only if required by tests.

## Forbidden

- Do not implement/edit Pi Extension entrypoint/lifecycle/UI/commands.
- Do not redesign Hindsight adapter, recall service, extraction service, or remember service.
- No live Hindsight/Pi config, credentials, external services, commit/push/publish/global install.
- Do not weaken strict TypeScript or security policy to pass tests.

## Required behavior/tests

1. Global config strict shape, only `url`; absent config default URL per docs if specified by implementation, reject malformed JSON, unknown fields, credentials in URL, non-http(s), query/fragment where unsafe; no key persistence.
2. Project config only at Git root, strict `enabled` boolean and optional nonempty string project; disabled/absent/invalid identity semantics; no nested/dirname fallback.
3. Git root and remote parsing safely handles common HTTPS/SSH/scp remotes, strips `.git`, lowercases; shell invocation is argument-safe and bounded.
4. Profile/project bank IDs deterministic, namespace/type-separated, below 64 chars, and do not include source identity.
5. SQLite migration is idempotent, foreign keys/WAL/busy timeout enabled as appropriate, profile ID stable, language persistent, repositories use parameterized SQL and explicit state transitions.
6. Concurrent candidate approval permits only one claimant; operation idempotency uniqueness works; no transaction held by core APIs over callbacks/network.
7. After approved-memory locator recording, SQLite stores no approved body; audit and usage contain no body/prompt/response.
8. Candidate expiry and lifecycle definitions match docs (preference/decision/lesson indefinite; project_fact 180d verify; task_state 30d; inference 90d unverified; candidates 30d).
9. Security filter rejects/redacts representative password/token/API key/JWT/cookie/private key/.env and oversized/full code/log/tool output; preserves allowed short paths, identifiers, commands, error signatures without false positive in representative cases.
10. Strict extraction response parser accepts one bounded JSON value only and rejects fences, prose, duplicate/unknown keys, invalid enum/scope/action/evidence, too many candidates, overlong text, partial validity (whole response rejected).
11. Token budget enforces both 10-item and approximate 1500-token caps deterministically.
12. i18n Chinese/English detection, switching and English fallback.

## Verify

Executor: Cursor Agent (user explicitly authorized switching from rate-limited Claude Code), model alias `auto`; actual model must be reported only if present in terminal evidence.

Executor and Pi independently run:

- `npm test`
- `npm run typecheck`
- `npm run build`

No formal candidate acceptance yet; this is slice-level verification only. Report exact files, test counts, limitations, session ID, and canonical model evidence. Stop if current architecture conflicts with docs rather than broadening scope.

# Slice 2 — Hindsight Provider contract

## Goal

Audit and complete only the Hindsight 0.8.3 HTTP client/adapter and provider-facing types, with exhaustive mock-server contract tests. Preserve the exact-write, deterministic document reconciliation, safe recall, and verified physical-forget design.

## Risk

Critical: remote boundary, authorization secrecy, idempotent persistence, deletion, timeout/ambiguous outcomes, and namespace isolation.

## Baseline

- Uncommitted worktree; Slice 1 accepted at slice level with 32 passing tests.
- Executor: new Cursor Agent chat, model alias `auto`; actual model only if terminal evidence provides it.

## Allowed

- Edit `src/provider/**` and add provider tests/helpers under `tests/**`.
- Minimal edits to DB/provider-facing types or repositories only if strictly necessary for the documented Provider contract; explain each.
- Update package/test config only if required for deterministic local mock HTTP tests.

## Forbidden

- No Pi extension lifecycle/entrypoint/UI/commands.
- No live Hindsight calls, bank enumeration, credentials, external network, Pi/system config, commit/push/publish.
- No Hindsight internal Python API and no Control Plane.
- Do not implement governance workflows beyond returning typed, honest Provider outcomes.

## Required contract

1. HTTP client:
   - HTTP(S) only; base URL already validated but safely join encoded path segments.
   - Optional API key only as `Authorization: Bearer ...`; never expose it in errors or returned diagnostics.
   - per-request timeout + caller cancellation; bounded request/response; strict JSON content and shape at adapter boundary.
   - no response body, URL credentials, Authorization, or secret echoed in errors.
   - classify timeout/abort/network/4xx/5xx/malformed/oversize sufficiently for caller decisions; ambiguous mutating outcomes distinguishable from definite rejection.
2. Startup/capability:
   - GET `/health`, GET `/version`; require 0.8.3-compatible API and bank config feature for writes.
   - never list banks.
3. Owned Bank:
   - deterministic caller-provided owned bank ID only.
   - idempotent PUT bank; PATCH config with exactly `retain_extraction_mode=chunks`, `retain_chunk_size=2048`, `enable_observations=false`, `enable_auto_consolidation=false`; GET readback and exact verification.
   - drift/missing/malformed blocks writes.
4. Exact retain/reconcile:
   - one item, <=1000 Unicode chars, deterministic document ID, string metadata, `async:false`, explicit replace behavior if supported.
   - synchronous response alone is insufficient; list by encoded `document_id`, require exactly one live source unit and exact text/document ID, return unit ID.
   - definite validation/auth/config failures versus ambiguous timeout/network/server outcomes represented honestly so governance can reconcile under same document ID.
   - no generated alternative document IDs.
5. Recall:
   - POST source types only (`world`,`experience`), no chunks/source facts/entities expansion where controllable; bounded budget/max tokens.
   - parse only needed bounded fields; reject malformed/oversized fields/results.
   - ordinary recall must not invoke reflect/generative endpoints.
6. Reflect:
   - separate explicit manual method only, bounded input/result, clearly typed; no automatic promotion.
7. Forget:
   - DELETE encoded owned document path.
   - verify document GET is 404 and list by document ID is zero.
   - retry 404 can be idempotent only with caller-owned locator semantics expressed in adapter API; postconditions still required.
   - soft invalidation/PATCH memory never used.
8. Metadata:
   - include bounded `logical_id`, scope, memory type, verification/lifecycle timestamps, source references needed for shared Project Bank enforcement; all string values, allowlisted keys, no body/evidence/secret.
9. Tests with an in-process `127.0.0.1` mock server must assert exact method/path/query/body/header behavior, including percent-encoding; success, drift, exact mismatch, zero/multiple units, timeout/abort, malformed JSON, oversize, 401/4xx, 500 ambiguity, auth redaction, recall bounds/types, reflect isolation, delete success/retry/failure/postcondition, and no bank-list endpoint.

## Verify

Executor and Pi independently run:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm pack --dry-run`

No live Hindsight mutation in this slice. Report files, exact test counts, limitations, Chat ID and actual model only if evidenced.

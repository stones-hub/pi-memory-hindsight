# Hindsight 0.10 compatibility and Recall score diagnostics

Status: approved for implementation on 2026-09-18.

## Goal

Prepare the extension for a safe Hindsight `0.8.3 → 0.10.0` service upgrade and expose native Recall relevance scores for later Chinese-query calibration. This phase must not upgrade or access the user's live Hindsight service and must not introduce another LLM call.

## Confirmed evidence

- The current adapter rejects every API version except `0.8.3` before normal provider operations.
- Hindsight `0.10.0` preserves the extension's used health/version, bank, bank-config, retain, document, list, Recall, delete, and Reflect routes.
- The four owned-bank overrides remain valid: `retain_extraction_mode=chunks`, `retain_chunk_size=2048`, `enable_observations=false`, and `enable_auto_consolidation=false`.
- Recall results in `0.10.0` expose `scores.final`, `scores.reranker`, `scores.semantic`, and `scores.keyword`; Recall accepts `min_scores`.
- `reranker`, `semantic`, and `keyword` may be null. `final` is required by the `0.10.0` contract and is not bounded to `0..1`; an isolated live probe observed `final=1.0986786712451455`.
- Absolute reranker scores are not calibrated across queries. A fixed threshold cannot be selected safely without representative Chinese and identifier-heavy queries.
- An isolated official `ghcr.io/vectorize-io/hindsight:0.10.0` container on loopback `127.0.0.1:18888`, with an independent Docker volume and synthetic bank, passed bank config, chunks retain, list, Recall scores, `min_scores` retain/abstain probes, whole-bank cleanup, and known-document absence checks.
- The `0.8.3` Alembic head is an ancestor of the `0.10.0` head through 23 migrations. Some migrations are not data-reversible, so live rollback requires restoring a pre-upgrade database snapshot rather than only switching the image back.

## Decision

### Explicit dual-version support

The adapter will allow only the exact tested versions:

- `0.8.3`: existing contract; Recall scores may be absent.
- `0.10.0`: score-capable contract; every ordinary Recall result must carry a valid score object.
- every other version: fail closed as untested.

No broad semver range is accepted. Compatibility checks remain mandatory before provider-ready runtime use.

### Score wire contract

The narrow wire/domain model gains an optional score object:

- `final`: required finite number inside a present score object; no artificial `0..1` bound.
- `reranker`: finite number or null.
- `semantic`: finite number or null.
- `keyword`: finite number or null; no artificial upper bound.
- unknown extra response fields remain ignored.

For negotiated `0.10.0`, a missing/malformed score object fails the Recall response closed. For `0.8.3`, absent scores preserve existing behavior; if a score object is present it must still validate.

The request wire type may represent `min_scores`, but automatic Recall will not send a threshold in this phase.

### Diagnostics, not filtering, in this phase

Validated scores travel through governance reconciliation into the current Session's bounded `/memory last` diagnostic and are shown per injected item. They are not persisted to SQLite, Hindsight, or Pi Session entries, and raw trace payloads are never requested or stored.

Automatic Recall behavior remains unchanged in this phase:

- no hard-coded relevance threshold;
- no local keyword filter;
- no extra embedding model or LLM reranker;
- no change to Profile/Project scope precedence;
- no change to 4-second total Recall timeout, source fact types, safety filters, maximum 10 injected items, or approximately 1500-token injection budget.

This produces trustworthy score observations before a separate threshold-calibration decision changes filtering behavior.

### Live acceptance safety

The disposable live runner may target exactly `0.8.3` or `0.10.0`, still requiring:

- explicit opt-in;
- an explicit loopback URL;
- a nonce-derived owned disposable bank ID;
- synthetic content only;
- no bank enumeration;
- cleanup and known-document absence proof.

For `0.10.0`, acceptance additionally proves score shape. `min_scores` behavior may be tested through a bounded raw HTTP probe or the adapted public client, but no production threshold is selected.

## Out of scope

- Upgrading, restarting, migrating, backing up, or changing the live Hindsight service.
- Reading live banks, live Memory SQLite, `.pi/memory.json`, credentials, or real memory bodies.
- Choosing or enabling a relevance threshold.
- Semantic duplicate folding.
- Changing Recall count/token budgets, timeout, scope isolation, lifecycle checks, or persistence.
- Commit, push, release, npm publication, deployment, or live Pi configuration changes.

## Verification

- Unit tests for exact version allowlisting and malformed/missing/finite/null score cases.
- Lifecycle tests proving scores reach `/memory last` only for injected items and remain bounded/session-local.
- Existing `0.8.3` mock and full regression suites remain green.
- Build, typecheck, audit, package-content, diff, and byte-safety checks.
- Packaged Pi acceptance remains green against its isolated mock.
- Disposable real Hindsight `0.10.0` acceptance on loopback proves create/config/retain/list/Recall scores/update/delete/cleanup.
- A fresh independent review is required because provider compatibility and safety gates are critical contracts.

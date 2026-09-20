# Configurable semantic Recall filtering

Status: approved; coding authorized on 2026-09-20. Cursor was explicitly selected by the user.

## Goal

Reduce weakly related memory injected into ordinary Pi conversations. Hindsight `0.10.0` Recall will use a configurable semantic-score floor and a smaller injection cap. `/memory last` remains a read-only view of what the most recent ordinary input actually injected; it never performs Recall itself.

## Calibration evidence

A read-only live calibration against the user's healthy Hindsight `0.10.0` used 13 representative Chinese queries covering Profile preferences, Project decisions, exact identifiers, and unrelated topics. No formal Memory or Candidate was changed: counts remained 16 Memories and 133 Candidates.

Observed behavior:

- `final` and `reranker` did not separate relevance reliably: unrelated weather results could score near `final=1.10` and `reranker=1.00`.
- `keyword` was commonly `null` for Chinese queries.
- `semantic` separated the tested useful results from unrelated results most consistently. Unrelated weather/market results were about `0.305–0.345`; useful results included address preference about `0.539`, browser cleanup about `0.558–0.563`, language about `0.601`, command formatting about `0.625–0.697`, terminal-width implementation about `0.689–0.699`, and README style about `0.713`.
- A `0.55` floor would have dropped the useful address preference, while `0.50` retained it.

This is an initial operational default, not a universal property of all future embedding/reranker models. Users can tune it.

## Configuration contract

Global config remains `<agent-dir>/memory-hindsight.json` and gains one optional field:

```json
{
  "url": "http://127.0.0.1:8888",
  "minScore": 0.5
}
```

- `minScore` means the minimum native Hindsight `scores.semantic` value for automatic Recall.
- If omitted, it defaults to `0.5`.
- It must be a finite JSON number in the inclusive range `0..1`. Booleans, strings, null, arrays, objects, negative values, and values above 1 are invalid and fail global configuration closed.
- `minScore: 0` explicitly disables score-threshold filtering. It does not disable the existing safety, governance, scope, lifecycle, count, or token filters.
- Credentials remain environment-only through `HINDSIGHT_API_KEY`.
- Project config remains unchanged.

`/memory status` will show the effective semantic rule and injection cap in localized text. For `0.10.0`, it reports either `semantic >= <effective minScore>, max 3` or filtering disabled at zero. For `0.8.3`, it truthfully reports that score filtering is unavailable and legacy Recall behavior is retained.

## Hindsight 0.10.0 behavior

For every eligible ordinary TUI input:

1. Recall Profile and enabled Project banks under the existing timeout, scope, source-type, sensitive-data, lifecycle, conflict, metadata, and document checks.
2. If `minScore > 0`, send `min_scores.semantic` to Hindsight and independently reject any returned item whose validated `scores.semantic` is `null` or below `minScore`.
3. If `minScore === 0`, omit `min_scores`; do not reject an otherwise governed item because its semantic score is null or low.
4. Merge eligible Profile and Project items, then rank globally by semantic score descending. A null semantic score, possible only when filtering is disabled, sorts after finite semantic values. Equal scores use deterministic governance-preserving tie breaks; Project scope does not automatically outrank a more semantically relevant Profile result.
5. Inject at most 3 items and still obey the existing approximately 1500-token ceiling. No padding with below-threshold items is allowed.
6. Keep validated scores only in bounded Session-local diagnostics; never persist them to SQLite, Hindsight, or Pi Session entries.

Service-side `min_scores.semantic` is an optimization, not a trust boundary. Extension-side validation and filtering are authoritative.

## Hindsight 0.8.3 behavior

The tested `0.8.3` contract permits absent scores and does not provide the required score guarantee. Therefore:

- do not send `min_scores`;
- do not apply `minScore` filtering or semantic sorting;
- preserve the existing maximum 10 items and approximately 1500-token cap;
- preserve all existing governance and safety checks.

This avoids silently breaking the supported legacy provider.

## `/memory last` semantics

- `/memory last` does not call Hindsight and does not calculate or filter anything.
- It displays only the items actually injected for the most recent eligible ordinary input in that Session.
- Starting a newer eligible ordinary input invalidates the previous diagnostic. If the new Recall attempt yields no injectable items, `/memory last` must not show the previous turn's items; it reports that the latest Recall injected nothing.
- Commands such as `/memory last` and `/memory status`, queued steer/follow-up messages, tool continuations, retries, and compaction loops do not create a separate Recall or overwrite the ordinary-input diagnostic.
- Provider/runtime failures remain non-blocking for the conversation and must not expose raw provider details.

## Out of scope

- Per-project thresholds or environment-variable threshold overrides.
- Filtering by `final`, `reranker`, or `keyword`.
- A configuration UI or command that mutates `minScore`.
- SQLite migration or score persistence.
- New model/LLM calls.
- Changes to remember, update, forget, Candidate approval, Reflect, or cleanup behavior.
- Modifying the user's live configuration, real memories, or live Hindsight data.
- Commit, push, release, publication, deployment, or live-service restart.

## Verification

- Strict config tests for omission/default, explicit boundaries, zero-disable, and invalid values/unknown fields.
- Provider request tests proving `min_scores.semantic` only for negotiated `0.10.0` with a positive threshold, never for `0.8.3` or zero.
- Lifecycle tests proving authoritative client-side filtering, semantic global ordering across Profile/Project, deterministic ties, null handling, max 3 plus token cap, and retained `0.8.3` behavior.
- Session tests proving a newer no-result Recall cannot leave stale `/memory last`, and commands/internal loops do not overwrite diagnostics.
- Command/i18n tests for effective status and last-result messages.
- Persistence tests proving scores and recalled bodies are absent from SQLite and Pi Session entries.
- Full tests, typecheck, build, audit, package-content inspection, diff check, and byte-safety scan.
- Packaged Pi TUI acceptance with a loopback Hindsight mock and temporary profile/config for default `0.5`, custom threshold, zero-disable, no-match stale clearing, max 3, and no Session persistence.
- Disposable loopback Hindsight `0.10.0` acceptance if needed to prove the real `min_scores.semantic` wire behavior; never use the live service for implementation acceptance.
- Fresh independent review because this changes a shared Recall/configuration contract.

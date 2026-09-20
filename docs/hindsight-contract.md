# Hindsight Contract Investigation

Status: Phase-0 source/OpenAPI contract established against `0.8.3`; dual exact support for `0.8.3` and `0.10.0` is implemented. Mutation behavior still requires a disposable-instance contract test during acceptance.

## Investigated deployment

- Image: `ghcr.io/vectorize-io/hindsight:latest` (historical Phase-0 investigation) and isolated `ghcr.io/vectorize-io/hindsight:0.10.0`
- Supported API versions (exact allowlist, no semver range): `0.8.3`, `0.10.0`
- Historical Phase-0 image source revision: `e1014cc790da502effacdb4bc914f8eea670606e`
- HTTP API: commonly `http://127.0.0.1:8888`; isolated `0.10.0` acceptance uses a separate loopback port
- OpenAPI title/version: `Hindsight HTTP API` matching the negotiated exact version
- Control Plane: port `9999`, explicitly outside product scope.
- Investigation inputs: `/health`, `/version`, OpenAPI, and a read-only copy of the matching container source.
- Existing banks were neither listed nor read. No Hindsight data was mutated during Phase-0 investigation.

The observed `/version` feature flags are:

- observations: enabled
- worker: enabled
- bank configuration API: enabled
- raw document text storage: enabled
- LLM tracing: enabled
- audit log: disabled

These are deployment observations, not portable assumptions. The adapter must capability-check required behavior and accept only the exact tested versions above.

## Authentication

Hindsight 0.8.3 has no global OpenAPI security scheme, but bank endpoints consume the `Authorization` header. The implementation accepts either:

```text
Authorization: Bearer <api-key>
```

or a direct key as the header value. The Extension will use the conventional Bearer form when `HINDSIGHT_API_KEY` is present, never persist the key, and never log the header.

An absent key is valid for a deployment whose authentication extension permits anonymous local access.

## Dedicated bank contract

The Extension must access only deterministic IDs in its own namespace. Proposed bounded forms are:

```text
pi-memory-hindsight:profile:<sha256-prefix>
pi-memory-hindsight:project:<sha256-prefix>
```

The clear-text profile directory, repository path, remote URL, and project name must not appear in a bank ID. Keep IDs below 64 characters even though current PostgreSQL migrations use `TEXT`; this preserves compatibility with older Hindsight schemas and other backends.

Bank creation is idempotent via:

```text
PUT /v1/default/banks/{bank_id}
```

For every owned bank the Extension must establish and verify these bank overrides before first write:

```json
{
  "retain_extraction_mode": "chunks",
  "retain_chunk_size": 2048,
  "enable_observations": false,
  "enable_auto_consolidation": false
}
```

These fields are bank-configurable in 0.8.3. `chunks` bypasses the retain LLM and creates one raw world fact per chunk. Approved memory text is capped at 1,000 Unicode characters, safely below the fixed 2,048-character chunk limit; post-write verification remains authoritative. Disabling observations and automatic consolidation prevents approved records from being rewritten into derived LLM observations.

The Extension must fail closed for writes if it cannot read back the required overrides. It must not reset or otherwise manage configuration on non-owned banks.

## Exact approved-memory representation

### Why ordinary retain is unsuitable

The default `concise` retain mode calls Hindsight's configured LLM and may split, omit, or rewrite an already approved atomic candidate. `verbose`, `custom`, and `verbatim` also use the retain LLM. `verbatim` eventually restores one raw fact per chunk, but still sends content to the LLM and therefore provides no advantage here.

### Selected representation

Each approved logical memory is represented as one dedicated Hindsight document:

- logical memory ID: generated and owned by the Extension;
- `document_id`: deterministic encoding of that logical ID under the current formula (`buildCurrentOwnedDocumentId`); pre-fix documents may still use the legacy text-hash formula (`buildLegacyOwnedDocumentId`) until a governed update reuses that same stored document id while writing current metadata;
- content: the exact approved, bounded memory text;
- retain mode: bank-level `chunks`;
- content length: at most 1,000 Unicode characters, strictly below the fixed chunk size, so exactly one chunk/unit is expected;
- metadata: string-valued governance fields including logical ID, content hash (current format), scope, memory type, lifecycle/verification timestamps and bounded source references; legacy provider items may omit `content_hash` and set `logical_id` to the text hash only when a local SQLite row proves the legacy locator;
- tags: optional fixed adapter tags, never relied on as the primary bank isolation boundary.

`MemoryItem.metadata` is `dict[str, str]` in 0.8.3. Structured values must be serialized into bounded strings or retained in SQLite workflow state; secrets and evidence bodies are forbidden. Metadata is required because Project Banks are shared by profiles and recall/lifecycle enforcement cannot depend on one profile's local SQLite locators.

A synchronous retain response reports success, item count, and usage but does **not** return memory-unit IDs. After retain, the adapter must call:

```text
GET /v1/default/banks/{bank_id}/memories/list?document_id=<document-id>
```

and prove that exactly one live unit exists and its text equals the approved text. Its Hindsight unit ID can then be recorded as a provider locator. A mismatch is an unknown/failed write, never success.

Direct list-by-document verification (used for create/replace/reverify reconcile-before-retry) treats only a valid complete pagination window that positively proves exact zero live units, or exactly one valid unit with text mismatch, as non-ambiguous/retry-safe. Transport, timeout, abort, HTTP errors, malformed responses, pagination inconsistency, wrong document id, invalid unit id, or multiple units are ambiguous/unproven and must not trigger another retain. `verifyDeletionPostconditions` already forces ambiguity on the same unproven GET/list classes.

### Exact discovery (`/memory list` / `/memory show`)

On real Hindsight 0.8.3, governance metadata for an owned one-memory document is returned on **document GET**, not on list units:

```text
GET /v1/default/banks/{bank_id}/documents/{document_id}
GET /v1/default/banks/{bank_id}/memories/list?document_id=<document-id>&limit=2
```

The document response includes `id` (document id), `bank_id`, `original_text`, `content_hash`, `memory_unit_count`, and `document_metadata` (`dict[str,str]`). Provider `created_at` / `updated_at` on the document are Hindsight-internal timestamps and must not be compared to SQLite governance timestamps. List units for the same document may return `metadata: null` even when retain carried governance fields; authoritative metadata for discovery is `document_metadata`.

`fetchExactOneUnitDocument` performs both reads under one abort/deadline, cross-checks ids/body/hash/`memory_unit_count === 1`/pagination, allows null unit metadata, requires matching non-null unit metadata when present, and returns validated `document_metadata` for `providerMetadataMatchesLocalRow`. Any malformed/404/5xx/timeout/abort/mismatch fails closed with content unavailable. Never enumerate banks or use fuzzy recall for discovery.

### Idempotency and updates

Retain with the same `document_id` defaults to replace semantics: old document data and associated units are deleted before the new representation is written. This makes the deterministic document ID the idempotency/reconciliation key.

For a timeout or lost response:

1. query by deterministic document ID;
2. accept success only if exactly one unit with exact expected text exists;
3. otherwise retry replacement under the same document ID, subject to the local operation state machine;
4. never create a second document ID for the same logical operation.

Updates/supersession use document replacement, not `PATCH` as the normal path. Although `PATCH /memories/{memory_id}` can edit a unit in place, it does not rewrite the stored source document/chunk text. Replacing the one-memory document removes stale source text and yields a new provider unit ID while preserving the Extension's logical memory ID.

Hindsight itself does not implement the product's lifecycle expiry. The Extension owns expiry, verification, conflict, and supersession state and filters recall accordingly.

## Recall

Endpoint:

```text
POST /v1/default/banks/{bank_id}/memories/recall
```

Relevant request controls include query, types, budget, max tokens, timestamp, tags, tag matching, and include options. Relevant result fields include unit ID, text, type, context, dates, document ID, string metadata, tags, and optional source/chunk data.

The adapter will request only source types (`world`, `experience`), disable optional chunk/source expansion, apply a bounded provider budget, then perform Extension-side scope, lifecycle, sensitivity, conflict, count, and token filtering. Recall may return fewer final items after those filters; safety outranks filling the quota.

In the observed deployment, embeddings and reranking are local and ordinary recall does not invoke the configured generative LLM. This is not assumed for arbitrary deployments: remote embedding or reranker configuration can send query and candidate text outside localhost. Documentation must tell operators to inspect their Hindsight deployment. Reflect is always treated as a potentially external LLM operation.

## Reflect

Endpoint:

```text
POST /v1/default/banks/{bank_id}/reflect
```

Reflect remains manual-only. It may send the query and recalled memory material to Hindsight's configured LLM provider. Results are untrusted and are not automatically promoted to approved memory.

## Physical forget

There is **no public HTTP endpoint in Hindsight 0.8.3 for deleting one memory unit**. An internal `delete_memory_unit()` exists, but the Extension must not depend on unexported internals.

The one-memory-per-document representation provides a supported physical-delete path:

```text
DELETE /v1/default/banks/{bank_id}/documents/{document_id}
```

The public contract synchronously deletes the document and cascades to its memory units and links. Success returns the document ID and count of deleted memory units; missing documents return 404.

The Extension may report forget success only after:

1. DELETE returns success for the expected owned bank/document;
2. a subsequent document lookup is 404; and
3. listing live units by that document ID returns zero.

A 404 on a retry may count as idempotent completion only when SQLite proves the document ID belongs to the requested logical memory and the postconditions pass. Local audit retains no memory body.

This deletes Hindsight's active database representation. External backups, provider logs, and infrastructure snapshots are outside the Extension's control and must be documented honestly.

## Public update semantics (available but not primary)

`PATCH /v1/default/banks/{bank_id}/memories/{memory_id}` supports:

- text and context edits;
- occurred start/end;
- world/experience reclassification;
- entity replacement;
- reversible invalidation/restoration.

A live edit re-embeds, removes links and dependent observations, and may queue graph maintenance/consolidation. Invalidation is soft retirement, not physical deletion. Consequently neither invalidation nor PATCH satisfies `/memory forget`.

## Data leaving localhost

For the selected bank configuration:

| Operation | Generative LLM use in Hindsight 0.8.3 | Notes |
|---|---:|---|
| chunks retain | No | Embedding backend still depends on deployment configuration. |
| recall | No generative LLM in observed setup | Embedding/reranker may be remote in another deployment. |
| update/re-embed | No generative LLM | Embedding backend may be remote. |
| document delete | No | May queue local maintenance depending on configuration. |
| reflect | Yes | Manual only; potentially sends memory content externally. |
| concise/verbose/custom/verbatim retain | Yes | Not used for approved-memory writes. |
| observation consolidation | Yes | Disabled on owned banks. |

The current local deployment's configured generative provider points outside localhost. No API key was read or printed. The selected chunks strategy is therefore a required privacy control, not merely an optimization.

## Compatibility and startup checks

The adapter must:

1. normalize and validate the configured URL;
2. reject URL credentials and non-HTTP(S) schemes;
3. call `/health` and `/version` with short timeouts;
4. require an exact tested baseline (`0.8.3` or `0.10.0`); every other version fails closed;
5. verify bank-config API availability before writes;
6. establish and read back owned-bank overrides;
7. never enumerate banks to discover ownership;
8. redact response bodies in user-facing errors and logs;
9. bound response sizes and reject malformed JSON;
10. for negotiated `0.10.0`, require a valid Recall `scores` object on every ordinary result (`final` finite, no artificial `0..1` bound; optional component scores may be null); for `0.8.3`, absent scores remain allowed while a present object still validates;
11. for negotiated `0.10.0` with a positive configured `minScore`, may send automatic Recall `min_scores.semantic` and must still filter authoritatively on the client; for `0.8.3` or a zero floor, omit `min_scores`. Score diagnostics are Session-local only and are never persisted.

A capability mismatch disables memory safely and never blocks normal Pi operation.

Live rollback from `0.10.0` to `0.8.3` requires restoring a pre-upgrade database snapshot. Some Alembic migrations between those heads are not data-reversible; switching the container image alone is not a safe rollback.

## Implementation-time contract tests

Run only against a disposable Hindsight `0.8.3` or `0.10.0` instance or synthetic owned test bank, never pre-existing user banks:

- create/update owned bank idempotently;
- set/read back chunks, fixed chunk size, and observation overrides;
- exact one-item retain and post-write lookup;
- repeat same document/text and reconcile;
- replace same document with new text and prove old text/source is gone;
- simulate ambiguous response and reconcile by document ID;
- recall source units and metadata in Chinese and English;
- for `0.10.0`, prove Recall score shape including `final > 1` when observed;
- physically delete document and prove all postconditions;
- verify known-document absence after cleanup;
- verify non-owned sentinel bank remains unchanged;
- exercise auth, 4xx/5xx, timeout, cancellation, malformed and oversized responses.

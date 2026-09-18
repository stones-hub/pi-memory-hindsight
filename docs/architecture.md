# Architecture

Status: Phase-0 baseline for implementation review.

## Components

```text
Pi interactive session
  ├─ Native Session / Compaction / AGENTS.md / Skills (unchanged)
  └─ Memory Extension
       ├─ Pi lifecycle adapter
       ├─ scope and identity resolver
       ├─ recall pipeline
       ├─ candidate extraction pipeline
       ├─ governance service
       ├─ security filters
       ├─ bilingual commands and TUI
       ├─ MemoryProvider interface
       │    └─ Hindsight adapter (exact `0.8.3` | `0.10.0`, HTTP)
       └─ local SQLite governance store (node:sqlite)
```

## Ownership

- Extension owns policy, lifecycle integration, scope, filtering, approval, conflict handling, injection budget, UI, and body-free audit.
- Hindsight owns persistence and semantic recall of approved long-term memory.
- SQLite owns workflow state and provider locators, not a second approved-memory corpus.
- Pi owns raw Session history and context compaction.

## Runtime baseline

- Supported Pi baseline: `0.85.1`.
- Pi requires Node `>=22.19.0`; this version includes stable `node:sqlite`.
- Use built-in `node:sqlite` to avoid native addon and cross-platform package-install risk.
- Support Node-run Pi on macOS and Linux. Pi standalone binaries must be treated as unsupported until a runtime probe proves `node:sqlite` is available there.
- Package code uses only Pi's exported extension/package APIs; no imports from `dist/core/*`.

## Bank and identity model

```text
Pi configuration directory
  └─ anonymous random profile ID in SQLite
       └─ hashed dedicated Profile Bank ID

normalized project identity
  └─ hashed dedicated Project Bank ID (not profile-bound)
```

Suggested bank IDs:

```text
pi-memory-hindsight:profile:<sha256-prefix>
pi-memory-hindsight:project:<sha256-prefix>
```

Hashing keeps profile paths and project names out of backend identifiers. The clear identity-to-bank mapping remains local. IDs are bounded below 64 characters for backend compatibility.

The adapter never lists all Hindsight banks to infer ownership. It computes and accesses only these IDs. Each owned bank is configured for one exact source unit per approved memory: chunks retain mode, fixed 2,048-character chunk size, observations disabled, and automatic consolidation disabled. Approved memory text is capped at 1,000 Unicode characters.

## Local SQLite model

The database is under `getAgentDir()/memory/pi-memory-hindsight.db`. `getAgentDir()` is Pi's public resolver and honors `PI_CODING_AGENT_DIR`.

Tables:

- `profile`: schema version, anonymous profile ID, language;
- `memories`: formal-memory governance rows (`active|reconciling|deleted|expired|superseded`), locators, hashes, mutation ownership; memory body is not duplicated after successful write. Hindsight metadata carries the bounded fields needed by other profiles sharing a Project Bank;
- `candidates`: reviewable bodies while pending/approving/failed/reconciling; terminal states purge bodies atomically (`text_hash`, `body_purged_at`);
- `operations`: idempotency key, expected content hash, action, attempt and reconciliation state, progress tokens, provider-issued flags;
- `conflicts`: candidate/logical-memory relationships and resolution state;
- `audit_events`: event type, IDs, timestamps, outcome and redacted codes, never memory bodies;
- `usage_events`: independent extraction token/cost accounting without prompt/response bodies;
- `maintenance_state`: durable cross-window cleanup lease and last-success metadata.

Use migrations, foreign keys, WAL where supported, busy timeout, explicit transactions, unique idempotency constraints, and compare-and-set approval transitions. Keep synchronous SQLite transactions short; never hold one over network or model calls. DB v7 adds `expired` memory status, candidate body-purge columns, and maintenance coordination while preserving v1–v6 data.

## Pi lifecycle integration

### Mode gate

Every automatic handler begins with:

```text
ctx.mode === "tui"
```

`ctx.hasUI` is insufficient because RPC can expose dialog-capable UI. Commands may report unsupported mode, but print/JSON/RPC perform no automatic recall or extraction.

### Recall path

```text
input for an ordinary user prompt
  → allocate a bounded, in-memory per-Session input identity without retaining the prompt body
before_agent_start for that prompt
  → atomically claim the input identity and enforce TUI/session/per-input gate
  → resolve Profile and optional Project scopes
  → query eligible banks with timeout/cancellation
  → reject expired/sensitive/out-of-scope/conflicting records
  → rank verified, current, specific items first
  → cap at 10 items / ~1,500 tokens
  → append a clearly delimited untrusted memory block to this turn's system prompt
  → record redacted diagnostics for /memory last (including validated native scores when present; never persisted)
```

Pi 0.85.1 allows `before_agent_start` to return a turn-specific `systemPrompt`. When omitted on the next turn Pi resets to the base prompt, so this avoids persisting recall as a Session message. The handler starts from `event.systemPrompt` (which includes earlier extension changes) and appends its block, preserving extension composition order. Returning `message`, or calling `sendMessage`, would persist memory content and is not used for recall injection.

Automatic Recall does not send a `min_scores` threshold in this phase. Validated native scores from Hindsight `0.10.0` (and optional present scores on `0.8.3`) are Session-local diagnostics only; they do not change injection filtering, count/token budgets, scope precedence, or safety gates. A separate calibration decision is required before any relevance threshold is enabled.

Recall must be guarded by a logical ordinary-user-input key, not `turn_start.turnIndex` or tool-loop count. Pi 0.85.1 emits `before_agent_start` before `turn_start`, so model-turn state cannot gate first-prompt Recall. The public `input` event supplies ordinary-input identity; `before_agent_start` atomically claims it before asynchronous work. A bounded Session-leaf-plus-prompt-hash fallback covers supported paths that reach `before_agent_start` without `input`, without retaining prompt bodies. Later separately submitted ordinary inputs are new identities even when their text is identical. Failures are swallowed after a short redacted warning and are not retried for the same identity.

Pi 0.85.1 queues streaming `steer` and `followUp` user messages inside the existing Agent loop and does not emit a new `before_agent_start` when they are delivered. The Extension classifies these inputs but does not separately Recall for them, persist Recall as a message, modify Pi internals, or consume the next ordinary input's eligibility. Full queued-message Recall is deferred until a supported per-user-message turn-specific injection hook exists. See `docs/decisions/automatic-recall-turn-gating.md`.

Precedence:

```text
system/security and AGENTS.md
> current explicit user instruction
> current project code/config/tool evidence
> Project memory
> Profile memory
> unverified inference
```

### Extraction path

```text
agent_end
  → capture only the minimal completed run snapshot in memory
agent_settled
  → ensure no queued continuation/retry remains
  → local relevance gate
  → select minimal source entries
  → local secret/content filtering and truncation
  → independent current-Pi-model structured extraction
  → validate untrusted output
  → compare pending and approved memory
  → propose create/update/supersede/ignore
  → SQLite pending candidate
  → non-blocking notification
```

`agent_settled` carries no messages, so the implementation pairs the most recent `agent_end` snapshot with the settle event. It serializes extraction per session and records a completed-run key before scheduling to prevent duplicate work.

The independent model call uses public `ctx.modelRegistry.complete(ctx.model, isolatedContext, options)`:

- a fresh context containing only a fixed extraction system prompt and filtered input;
- a new `memory-extract:<uuid>` session ID, never Pi's main Session ID;
- no registered Pi tools, so it cannot execute Extension tools or recursively trigger Pi lifecycle events;
- its own timeout/AbortController; session shutdown aborts outstanding work;
- conservative token cap and no provider fallback;
- token/cost usage copied from the returned `AssistantMessage` into body-free SQLite usage events.

Pi-AI provides provider-side constrained tool schemas only on some providers and `toolChoice` cannot force a named tool. Therefore provider-neutral correctness cannot depend on strict structured sampling. Request JSON-only output, extract one bounded JSON value, validate it with a strict local schema, and reject the entire output on any error. No partial candidate survives.

### Session state

`pi.appendEntry(customType, data)` is a public TUI-only persistence mechanism whose entries do not participate in LLM context. Use it for `/memory off|on` state. On `session_start`, scan the active branch in order and restore the latest supported state entry. No memory body is stored in that entry.

### Commands, Tool, and TUI

- Register one `memory` command and parse subcommands centrally.
- Register `memory_remember` as a governed tool with a strict TypeBox input schema.
- Both delegate to the same governance service.
- `/memory candidates` uses `ctx.ui.custom()` for the full reviewer; deterministic command forms call the same service and remain testable.
- All UI components are TUI-gated and localized; no Control Plane links are required.

## Explicit write and approval path

```text
memory_remember tool ─────────────┐
/memory remember command ────────┼→ governed remember service
candidate approval TUI/command ──┘
  → local scope/sensitivity/size checks
  → acquire conditional operation ownership in SQLite
  → ensure owned Hindsight bank contract
  → synchronous chunks retain under deterministic document ID
  → lookup by document ID and verify one exact unit
  → store provider locators and body-free audit
```

A deterministic document ID binds one Extension logical memory to one Hindsight document. Timeout reconciliation queries that document instead of creating a new one. Replacement updates the same document ID and can change the provider unit ID. Current writes derive the document from scope/project/type/logical row id; upgraded databases may still own pre-fix documents derived from scope/project/text-hash, proven only via local SQLite locator checks (never by enumerating Banks).

## Delete path

```text
/memory forget <logical-id>
  → resolve only from local owned-memory locator
  → DELETE owned Hindsight document
  → verify document absent and no units remain for document ID
  → mark local locator deleted
  → append body-free audit
```

Hindsight 0.8.3 has no public single-unit DELETE. One-memory-per-document makes public document deletion the supported physical-delete primitive. Never claim success from a soft invalidation or an uncertain HTTP outcome.

## Discovery path (`/memory list` / `/memory show`)

```text
SQLite owned locator (bank_id + document_id + text_hash)
  → parallel exact document GET + list-by-document (limit 2, offset 0)
  → validate document_metadata, original_text/content_hash, memory_unit_count === 1
  → cross-check single live unit text/hash (unit metadata may be null on real 0.8.3)
  → providerMetadataMatchesLocalRow against SQLite
  → bounded preview or full text, or content-unavailable on any failure
```

Never enumerate banks or fuzzy-recall for discovery. Provider document timestamps are not governance timestamps.

## Failure model

- Hindsight unavailable: recall/write reports a redacted warning; Pi continues.
- Recall timeout: no retry within that turn.
- Extraction failure: no fallback and no partial candidate.
- SQLite runtime/migration incompatibility: memory functionality disables safely; Pi continues.
- Ambiguous project identity: Project Memory disables; Profile Memory continues.
- Bank configuration mismatch: writes disable for that bank; unrelated Pi work and safe recall diagnostics continue.
- Ambiguous write: operation enters reconciliation state; no fresh logical ID is generated.
- Delete uncertainty: report unknown/failure and reconcile; never claim deletion without postconditions.

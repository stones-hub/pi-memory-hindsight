# Product Requirements

Status: Phase-0 baseline for implementation review.

## Goal

Deliver an open-source-quality Pi extension that adds governed, cross-session long-term memory using a local Hindsight service, without replacing or changing Pi's Session, Compaction, AGENTS.md, or Skill mechanisms.

## Users and platforms

- Initial use: one person on one local machine, with multiple concurrent Pi windows supported.
- Supported platforms: macOS and Linux.
- Windows: out of scope.
- Initial rollout: private local trial, designed for later open-source and npm distribution.

## Storage responsibilities

- Pi Session: complete original conversation and tool history.
- SQLite: pending candidates, redacted/truncated evidence summaries and source references, approval/conflict/retry state, anonymous profile identity, UI language, and body-free audit events.
- Hindsight: approved long-term Profile and Project memories and recall. Each approved logical memory is one dedicated Hindsight document so it can be reconciled and physically deleted through public APIs.
- SQLite keeps provider locators and lifecycle state but does not retain a second copy of an approved memory body after a successful write.
- No full Session, complete source file, large code block, full log, complete terminal output, `.env` body, credential, or model thinking is copied into memory storage.
- Backup and restore are operational concerns and are not implemented by the extension.

## Configuration

### Global

The global extension configuration contains only:

```json
{
  "url": "http://127.0.0.1:8888"
}
```

- Hindsight credentials are read only from `HINDSIGHT_API_KEY`.
- Credentials cannot be stored in JSON.
- Product safety and lifecycle policies are fixed defaults, not user-facing configuration.

### Project

At the Git root, `.pi/memory.json` accepts exactly:

```json
{
  "enabled": true,
  "project": "optional-project-name"
}
```

- `enabled` controls Project Memory.
- `project` is optional and has priority when present.
- Without `project`, use the final repository name from Git remote, remove `.git`, trim, and lowercase it.
- With neither a valid `project` nor a usable Git remote, Project Memory remains disabled and emits a clear diagnostic.
- Project identity is lowercase and case-insensitive.
- One Git repository is one project. Nested project configuration and subproject banks are unsupported.
- Different repositories with the same derived final repository name share an identity unless they configure distinct `project` values; this is an intentional consequence of the chosen simple identity rule.

## Scope and identity

- `PI_CODING_AGENT_DIR`, or Pi's default `~/.pi/agent`, defines a Memory Profile.
- First use creates one anonymous stable profile ID in that profile's SQLite database.
- Concurrent Pi windows sharing the same Pi configuration directory share the Profile Bank.
- Different Pi configuration directories have different Profile Banks.
- A Project Bank is derived only from normalized project identity and does not include profile identity.
- Different profiles using the same project identity share the Project Bank when connected to the same Hindsight service.
- One bank per Profile and one bank per enabled Project; memory types are metadata, not separate banks.
- Approved memory text is atomic and capped at 1,000 Unicode characters; longer explicit requests require editing or splitting after governance review.
- The extension uses a dedicated bank namespace and never touches pre-existing unrelated banks.

## Memory types

### Profile Bank

Allowed:
- Explicit long-term cross-project preferences.
- Cross-project work habits.
- General communication preferences.
- Explicitly requested non-project memories.

Disallowed:
- Project code, paths, architecture, failures, or task state.
- Personality profiling or sensitive user profiling.
- A preference inferred from one isolated behavior.
- Full conversations or tool output.

### Project Bank

Allowed:
- `project_fact`
- `decision`
- `lesson`
- `task_state`
- `inference`

A project without `enabled: true` receives no Project recall, extraction, creation, or writes. Project information must never fall back into Profile memory.

## Recall

- Interactive Pi mode only.
- Profile recall works in ordinary directories and projects regardless of Project Memory enablement, unless the Session is paused.
- Project recall works only when `.pi/memory.json` has `enabled: true` and project identity resolves.
- At most one automatic recall per new user turn; tool loops do not recall again.
- Follow-up messages are new turns. Steering may recall again only when it materially changes the task.
- Default injected budget: no more than 10 records and approximately 1,500 tokens total.
- Successful injection shows a short notification. No-match is silent. `/memory last` explains retrieval, filtering, injection, token usage, and latency.
- Recalled memory is clearly delimited as untrusted reference data and is injected through a turn-specific system-prompt extension, not a persistent Session message.
- Hindsight timeout or failure never blocks the Pi task.

## Candidate extraction

- The extension first performs a deterministic local relevance gate.
- Only potentially durable tasks trigger one independent call to Pi's current model.
- The extension supplies minimal, locally filtered, redacted, and truncated Session material.
- The model returns zero or more structured, atomic candidates.
- Model output is untrusted and must pass schema, scope, sensitivity, length, evidence, duplicate, and conflict validation.
- Automatic extraction writes candidates only to SQLite. It never writes approved memory to Hindsight.
- Candidates remain pending for 30 days, then become expired and disappear from the default pending view.
- Extraction failure is non-blocking, has no provider fallback, creates no partial candidate, and does not block Pi; a later eligible settled turn may extract normally. Users can also store content explicitly with `/memory remember` or `memory_remember`.

## Explicit remembering

Support deterministic, explicit create and target-specific update entry points:

- Natural language through a strict `memory_remember` tool: create has no target; update requires an exact local logical memory ID.
- `/memory remember <scope> <type> <content>` creates a new memory.
- `/memory update <logical-memory-id> <content>` replaces only that exact locally owned memory and derives scope, type, Project identity, Bank and document locator from the target row.

All entry points use the same governance services as candidate approval. Explicit “remember” is create authorization when scope is clear and content passes all checks. Replacement is authorized only when an exact target ID is supplied; the Extension does not guess an update target from similar text or memory type. Ambiguous scope, conflict, stale target, or risk requires user interaction. Project writes require Project Memory to be enabled. Explicit Profile writes remain available without Project Memory.

## Approval UX

- Automatic candidates are persisted in SQLite and announced without interrupting the task.
- `/memory candidates` opens a bilingual interactive TUI supporting detail, evidence summary, type/scope, proposed action, similarity/conflict, approve, reject, edit-and-approve, filters, expired view, and low-value batch rejection.
- A Project-scope candidate is only visible and operable (in the TUI, the deterministic text list, expired view, conflict materialization, batch rejection, and direct-id approve/reject/edit-approve) when the current cwd has Project Memory enabled with an identity matching the candidate's project exactly; the reviewer states whether it is showing Profile-only or Profile+Project. Candidate detail and listing show state, project identity, and a safe, localized, allowlisted explanation of any `failure_code` — never raw provider response bodies, headers, credentials, or unbounded exception text.
- Deterministic text commands use the same business service for testing and non-TUI recovery, but automatic memory is unsupported in print/JSON/RPC modes.

## Lifecycle

| Type | Default lifecycle |
|---|---|
| Profile preference | No automatic expiry |
| Decision | No automatic expiry; review on conflict |
| Project fact | 180 days; recall stops at `expires_at`; bounded maintenance physically deletes into `expired` |
| Lesson | No automatic expiry; show last verification |
| Task state | 30 days; same expiry protocol as project fact |
| Inference / reflection | 90 days, always unverified; same expiry protocol |
| Pending candidate | Expires after 30 days; terminal bodies purged immediately |

Current explicit instruction overrides old memory. An explicit long-term “remember” request may replace conflicting memory after conflict handling. “This time” never changes long-term memory. “From now on” without explicit remember creates an approval candidate.

## Discovery

- `/memory list`, `/memory list profile`, `/memory list project`, and `/memory show <id>` are exact, SQLite-proven, Bank-non-enumerating read paths.
- Default list is bounded to 20 effective-active local memories from Profile plus the current enabled Project.
- Provider outages may omit bodies (`content unavailable`) but never invent unverified text.
- Remember success, candidate approval, candidate listings, and `/memory last` expose IDs when locally governed; shared Project recalls without a local row are read-only.

## Retention and cleanup

- Terminal candidate bodies are purged immediately on approved/rejected/expired; metadata retained 90 days.
- Terminal operations 30 days; resolved conflicts 90 days; audit/usage 90 days with a 10,000-row cap each; deleted/expired memory tombstones 90 days.
- Never purge pending/in-progress/reconciling operations, open conflicts, reviewable Candidates, owned mutations, or referenced tombstones.
- `/memory cleanup status` and confirmed `/memory cleanup now`; automatic maintenance at most once per 24h after TUI `agent_settled`, max 10 formal expiries per pass, durable SQLite lease coordination, no automatic `VACUUM`.

## Deletion

- `/memory forget <id>` physically deletes that individual approved memory's dedicated Hindsight document through the public document-delete API.
- Success requires post-delete absence checks; soft invalidation is not deletion.
- Deleted content must not be recalled.
- SQLite retains only a body-free redacted audit event.
- No recovery is offered.
- Failure is reported honestly and may be retried.
- Scope-wide bulk clearing and extension backup/restore are out of scope.

## Language

- UI and user documentation support Chinese and English.
- First run detects locale; current Chinese environments default to Chinese.
- `/memory language` changes and persists the Profile language in SQLite.
- Missing translations fall back to English.
- Memory content remains in its source language; technical identifiers remain unchanged; no translated duplicate is stored.

## Command help

- `/memory help` and bare `/memory` display the same detailed, purpose-grouped command list in the persisted Memory UI language (`zh` or `en`) when a successful process-wide cached local runtime already exists, falling back to English when it does not. Help never starts local runtime initialization and therefore does not create SQLite or a Profile.
- Unknown commands or invalid arguments display that same help as an error.
- Help is TUI-only, remains available when Hindsight is unavailable, and performs no Hindsight I/O or SQLite mutation.
- The help lists every supported command form, including status, session on/off, remember/update/forget, list/show/last, candidate review, cleanup, language, `/memory reflect profile <query>`, and `/memory reflect project <query>`, plus Profile types `preference|habit` and Project types `project_fact|decision|lesson|task_state|inference`.
- There is no `/memory extract` command; candidates are created only by settled automatic extraction.

## Explicit non-goals

- Replacing Pi Session, Compaction, AGENTS.md, or Skills.
- Modifying Pi core.
- Automatic behavior in print, JSON, or RPC modes.
- Windows support.
- Hindsight Control Plane integration on port 9999.
- Supporting Hindsight's generative retain rewriting or automatic observation consolidation for approved memories.
- Multi-user authentication, ACLs, or remote team service operation in the first release.
- Nested projects or per-branch banks.
- Scope-wide bulk deletion.
- Backup and restore implementation.
- Automatic Skill or AGENTS.md modification.

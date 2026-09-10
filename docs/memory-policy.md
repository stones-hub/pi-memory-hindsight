# Memory Policy

Status: Phase-0 baseline for implementation review.

## Core rule

Memory is durable reference data, never an instruction authority. Current user intent and current verified repository state outrank recalled history.

## Atomicity and evidence

- Store one durable claim per memory record, capped at 1,000 Unicode characters.
- Preserve source Session ID, relevant entry IDs, file paths, origin kind, verification state, and timestamps when available.
- SQLite candidate evidence is redacted and truncated.
- Approved Hindsight memory stores the conclusion and bounded source references, not full evidence bodies.
- One approved logical memory maps to one dedicated Hindsight document and one exact source unit; the approved text is not re-extracted by Hindsight's generative model.
- Assistant or reflection output is never automatically treated as verified fact.

## Scope

- Profile scope: explicit cross-project preferences and habits only.
- Project scope: project facts, decisions, lessons, task state, and inference.
- Project-derived information cannot be stored in Profile scope when Project Memory is disabled.
- Ambiguous explicit writes require a Profile / Project / Do not save choice.

## Content

Allowed when directly useful:
- Short commands.
- Error signatures.
- Configuration keys.
- Small code identifiers.
- File paths, function names, module names, and versions.

Forbidden:
- Credentials and authorization material.
- `.env` bodies.
- Complete files or substantial source excerpts.
- Full logs or terminal output.
- Complete conversations.
- Model thinking.
- Persistent commands copied from untrusted external content.
- Sensitive personality or user profiling.

## Update and conflict policy

- Exact duplicate: update evidence/verification metadata rather than create another memory. Exact duplicates are keyed by scope, project identity, memory type, and text hash; the same text under an incompatible type is not the same logical record.
- New verified value replacing an old value: propose or perform supersession according to authorization. Provider replacement reuses the logical memory's deterministic document ID and must prove the old text/source is gone.
- Explicit replacement entry points: `/memory update <logical-memory-id> <content>` and tool `memory_remember` with `action=update` plus an exact `targetMemoryId`. Ordinary `/memory remember` and tool `action=create` remain create-only. Explicit update idempotency keys bind both the immutable expected/current target text hash and the new text hash so A→B, B→C, and C→B are distinct operations while retries of the same transition converge.
- Document locator compatibility: current writes derive `document_id` from scope/project/type/logical row id with metadata `logical_id=<row id>` and `content_hash=<text hash>`. Pre-fix/pre-v3 rows may still use the legacy formula (scope/project/text-hash) with metadata `logical_id=<text hash>` and no `content_hash`. Recall/forget accept only those two locally proven owned formats; shared Project recall without a local SQLite row fails closed on legacy metadata. A governed update of a legacy row reuses its stored legacy document id, freezes the legacy derivation key locally, and writes current metadata for that same document.
- Project forget authorization: `/memory forget <id>` and `forgetMemory` require the caller to prove the currently enabled cwd project identity before any operation claim or provider DELETE. Profile memories remain forgettable by exact id from any cwd. Project rows with a mismatched or disabled cwd project are rejected locally with no operation mutation. Formal-memory expiry maintenance is system-owned and does not use cwd project context.
- Per-memory mutation generation/ownership (SQLite): replace, delete, and duplicate reverify claim one durable owner key per generation so concurrent windows cannot race provider mutations; finalization CAS-advances generation so a stale completion cannot reactivate a deleted row. Forget keys are versioned by generation/hash/document. After verified forget, same-content recreate walks historical create operation keys (first revive keeps the legacy `:after:<id>:g<gen>` shape; later generations use compact hashed keys under the 256-char bound) until a resumable slot or a new collision-free key is minted, and must retain again. Candidate approval CAS requires the mapped memory to still be active and coherent with the candidate (scope/type/project/text hash, plus exact target id for replace); conflicts/audit approved only after that guard. Already-verified exact duplicates remain a cheap no-I/O duplicate.
- Crash recovery: an `in_progress` operation holds a conservative SQLite lease derived from the provider HTTP timeout × max chained mutation calls (plus slack). The Hindsight HTTP client clamps any requested `timeoutMs` to that same ceiling so a custom timeout cannot outlive the lease. After expiry, the same logical operation may take over into `reconciling` under the same owner key/generation, must verify provider postconditions before any further retain/DELETE, and finalizes only with owner+generation+progress-token CAS so a delayed completion from the crashed process cannot commit. Create/replace/delete/reverify/expire success finalizers commit memory and operation atomically (rollback if either CAS fails). Post-network failure/cancellation paths apply the same CAS before any memory status change; operation+memory transitions roll back atomically if the memory side fails. After `provider_mutation_issued`, only an explicit `ambiguous: false` (production HTTP 4xx / proven non-execution) may `release_active`; missing ambiguous flags are treated as maybe-executed. Direct `verifyOneUnitDocument` marks list transport/timeout/5xx/malformed/inconsistent results ambiguous so reconciling create/replace/reverify issue zero retain until absence or text mismatch is positively proven. If reconciling replace/reverify verify proves exact absence/mismatch, later definite bank/retain failures stay reconciling and do not restore prior active truth. Owner eligibility and ownerless recovery select at most one uniquely eligible operation matching the current `mutation_generation` and bank/document locator (legacy NULL generation only when it is the sole operation); mismatched owners and committed-owner+reconciling inconsistencies fail closed without clearing into unrelated history. Formal-memory expiry reuses the same delete protocol with `expire:` idempotency keys and ends in `expired` (manual forget ends in `deleted`); update/forget cannot resurrect expired content.
- Deterministic conflict rule for this release: an `update`/`supersede` candidate that names a validated local `target_memory_id` is treated as a conflict against that exact memory and must persist an immutable expected target text hash. Approval rejects with zero provider mutation when that snapshot is missing or the target hash changed. Untargeted statements are not classified as semantic conflicts; independent same-scope/type memories remain allowed when no exact target is named.
- Cross-scope conflict: Project memory is more specific than Profile memory in the project.
- Same-scope unresolved conflict: disclose conflict; do not silently merge.
- Current code/config/tool evidence overrides stale memory and may generate a supersession candidate.
- Candidate terminal body purge: approved/rejected/expired transitions atomically null `text`/`evidence_summary`, retaining `text_hash` and `body_purged_at`. Historical UI renders a purged placeholder.
- Manual candidate rejection: allowed for untouched `pending` or definite `failed` (non-ambiguous approval rejection such as stale target); forbidden for `approving` and `reconciling` (in-flight or maybe-issued provider outcomes). TTL auto-expiry applies only to untouched `pending`; `failed`/`reconciling` remain reviewable past the original `expires_at`.
- Formal-memory expiry handoff: when `expires_at` passes while a foreign mutation owner (replace/forget/create) remains, bounded maintenance may hand off only after any live `in_progress` lease expires. Handoff atomically abandons the foreign operation, bumps generation, binds the deterministic `expire:` delete owner, and proceeds with exact-document deletion. Stale delayed completions fail generation/owner/progress-token CAS and cannot restore active recalled content; fresh updates after expiry remain rejected.
- Exact discovery (`list`/`show`) fetches only through SQLite-proven owned bank/document locators, validates hash/metadata, and degrades to content-unavailable without Bank enumeration or fuzzy selection.
- Bounded retention cleanup covers terminal candidates, operations, resolved conflicts, audit, usage, and deleted/expired tombstones with durable multi-window maintenance leases.

## Provider-boundary rules

- Approved writes require an owned Hindsight bank configured for `chunks` retain with observations and automatic consolidation disabled.
- Recall requests only source facts and does not request raw chunk expansion.
- Reflect is manual-only and its output remains unverified.
- Forget uses physical document deletion plus postcondition checks; invalidation does not satisfy deletion.
- The Extension never enumerates or probes unrelated Hindsight banks.

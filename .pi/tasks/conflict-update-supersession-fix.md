# Conflict/update/supersession narrow fix

## Goal

Close the independently confirmed governance gap so contradictory or corrective memories are not silently stored as unrelated active records, and user-approved updates/supersessions replace the existing logical memory under its existing Hindsight document ID with verified old-text removal.

## Risk

- Type: critical task.
- Reason: this changes governed durable writes, conflict state, replacement, deletion/reconciliation behavior, and SQLite lifecycle state. A defect can preserve stale/contradictory memory, overwrite the wrong memory, falsely report success, or make later forget/recall unsafe.
- Critical contracts: owned-bank/document isolation; exact one-memory-per-document write; no automatic permanent write for ambiguous/conflicting content; no network transaction held in SQLite; CAS/idempotency; physical old-text removal; body-free audit; no existing non-test Bank access.
- Escalate and stop if a safe implementation requires semantic-model conflict detection, arbitrary provider searching, Bank enumeration, a destructive/non-additive migration, broad UI redesign, or changing approved product scope.

## Scope

- Baseline: repository has no commits; 83 pre-task files are captured by `/tmp/pi-memory-hindsight-conflict-fix-before.sha256` (manifest SHA-256 `a1a352fd2df88d7a37545d591ddc7f96c6c1cf3ded3e6eb4c0dd9dbd4db857f3`). Real disposable-Hindsight acceptance passed before this behavior-changing fix, so that acceptance is now considered invalid once code changes.
- Allowed: `src/governance/**`, governance-required `src/db/**`, extraction parsing/pipeline where needed, command/tool/UI/i18n surfaces needed to disclose/resolve conflicts, minimal provider/recall/runtime changes required by the existing contract, deterministic tests under `tests/**`, and documentation/HANDOVER corrections needed to describe implemented behavior honestly.
- Prefer additive migrations if persistence shape must change; never rewrite existing migration semantics in a way unsafe for populated databases.
- Forbidden: Pi core/internal imports, unrelated refactors, dependency additions unless stopped and approved, Hindsight Control Plane, Bank listing, automatic Reflect, broad fuzzy/LLM semantic conflict classification, real Pi profile/config changes, existing Hindsight Banks, SSH, commit, push, publish, or deployment.

## Executor and authorization

- Executor: Claude Code, fresh coding session.
- Requested model: `claude-sonnet-5`.
- Coding authorization: explicitly granted by user in this conversation.
- Permission: modify only the allowed candidate code/tests/docs; offline/mock verification only. Executor must not run the live Hindsight acceptance.

## Business problem

Today exact text duplicates converge, but two contradictory/corrective memories in the same scope and type can become separate active records and both be recalled. Candidate update/supersede actions are rejected as “not implemented yet”, and normal governance paths cannot preserve the old logical document ID while replacing its text.

Example: existing Project fact “This project uses Node 22” followed by an explicit request to remember “This project uses Node 24”. The extension must not silently retain both. It must disclose a conflict or route a clearly authorized target-specific replacement through governance, then ensure only the approved replacement is recallable.

## Confirmed source facts

- `remember()` detects only exact text hash duplicates and has no path that returns its declared `conflict` result.
- Duplicate return does not call `MemoriesRepository.markVerified()`.
- `ConflictsRepository.create/resolve/listOpenForCandidate` are not wired into production conflict creation/resolution.
- extraction persists every candidate as `proposedAction: "create"`, `targetMemoryId: null`.
- candidate approval rejects every non-create or targeted action with “not implemented yet”.
- ordinary writes derive document ID from the current text hash; only adapter/live-test code currently proves replacement when a caller manually reuses a document ID.
- Existing requirements are in `docs/memory-policy.md`, `docs/product-requirements.md`, `docs/architecture.md`, `docs/hindsight-contract.md`, and Slice 4 task section 3/4.

## Required behavior

### Exact duplicates

- Detect exact duplicates within exact scope, project identity, and compatible memory type. Do not silently treat same text under an incompatible type as the same logical record.
- Revalidate safety/scope/project first. For an accepted exact duplicate, refresh the existing local verification/evidence timestamps/metadata as appropriate and make any required provider metadata change safely under the same document ID; do not create another memory/document.
- Duplicate/reverification must be idempotent, concurrent-safe, body-safe, and must not falsely report success after an uncertain provider mutation.

### Conservative conflict handling

- Implement only deterministic, high-confidence conflict detection. Distinct memories sharing a type are not automatically conflicts; independent facts/preferences must remain allowed.
- A detected same-scope unresolved conflict must create/link durable conflict state and return/disclose a typed conflict or review path. It must perform zero automatic permanent provider replacement.
- Conflict detection and approval must recheck exact scope, type, current project identity, target status, ownership, and current text/hash to avoid stale-target replacement. A target-specific candidate must persist an immutable expected target version/hash (using a safe additive migration or equivalent durable snapshot) and approval must reject or return to review if the target changed after candidate creation; reading the target only at approval time is insufficient.
- If no safe deterministic rule can identify a contradiction without semantic guessing, preserve both only where they are independently valid; do not claim semantic conflict coverage. Document the precise supported rule.

### Explicit update entry points

- User-approved product decision: ordinary `/memory remember <scope> <type> <content>` remains create-only. Add `/memory update <logical-memory-id> <content>` as the deterministic explicit replacement entry point. It resolves scope/type/project/bank/document only from the exact local target row; callers cannot supply or override those locators.
- Extend the single `memory_remember` tool with a strict action/target shape: create requires no target; update requires an exact `targetMemoryId`. Keep `additionalProperties:false`; reject every malformed combination before provider I/O. The tool remains usable only for an explicit user request to remember or update durable information.
- The explicit command and tool must share the same governed replacement service used by candidate approval. They must expose body-free bounded outcomes and localized help/result text. Non-TUI invocation remains a zero-mutation no-op.
- Do not add an untargeted automatic update or infer the target from same scope/type. The target ID is mandatory for replacement.

### Candidate update/supersession

- Real production paths must support governed `update`/`supersede` with a non-null exact local `target_memory_id`; malformed combinations fail locally with zero provider mutation.
- Approval is explicit authorization for that exact target only. Revalidate candidate safety/expiry/CAS/conflict/target/project state immediately before mutation.
- Replacement reuses the target memory’s existing owned Bank and document ID. Never accept caller-supplied arbitrary locators and never enumerate Banks.
- Replace-retain must prove exactly one unit with the new exact text and therefore old provider text/source absence, using the existing adapter contract.
- SQLite finalization must be atomic after provider proof: preserve a stable logical memory/locator representation, update hash/length/unit/verification/source/lifecycle fields consistently, and resolve/supersede related local state without leaving two recall-eligible active rows.
- Definite failure must not change active truth or mark candidate approved. Ambiguous timeout/cancellation must remain honestly reconcilable under the same document ID and operation key, without a second provider mutation/logical record. On retry of an already-reconciling replacement, verify the exact target document/new text before any second retain; if verification proves success, finalize without another provider mutation. Retry and concurrent approvals converge safely.
- Forget after replacement must delete the reused document and update the correct local record.

### Automatic extraction

- Model-proposed `action` cannot be trusted to choose an arbitrary target. Either map only locally and deterministically validated target-specific actions into candidates or conservatively downgrade/reject them. Never silently advertise update/supersede while production approval cannot execute it.
- Automatic extraction still creates SQLite candidates only and never writes Hindsight.

### Recall and audit

- Open conflicts prevent affected local memory from being injected where required by the approved policy; resolved replacement exposes only the current text.
- Audit/session/usage entries remain body-free; no old/new memory text, candidate evidence, provider body, or secret is added.

## Verify: executor

Run offline only:

- focused governance/DB/lifecycle/integration tests added for this fix;
- `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `npm pack --dry-run`;
- `npm audit --omit=dev`;
- `git diff --check`;
- NUL scan over `src/` and `tests/`.

Do not invoke real Hindsight, external model/network, real Pi profile, `acceptance:hindsight:live`, commit, push, publish, or deploy.

## Verify: Pi independent acceptance

- Inspect every changed file against the pre-task manifest and this task.
- Independently rerun all executor checks and `npm run acceptance:pi` from the packed artifact.
- With separate authorization already limited to synthetic disposable test data, run one fresh nonce-derived `acceptance:hindsight:live` only after offline checks pass; clean only that exact Bank in `finally` and inspect evidence.
- Run a fresh independent review session after all fixes and tests. Any review finding must be reproduced before further coding.

## Required test scenarios

- exact duplicate converges to one document/row and safely refreshes verification metadata;
- two independent same-scope/type memories remain allowed;
- deterministic obvious conflict performs zero replacement and creates/discloses conflict state;
- explicit `/memory update` and tool update reach the shared replacement service; malformed action/target combinations and stale/wrong-scope/wrong-project/wrong-type/deleted/reconciling/arbitrary targets are rejected before provider mutation;
- a candidate whose target hash/version changed after candidate creation cannot overwrite the newer value and performs zero provider mutation;
- update/supersede approval reuses exact old document ID, old text is gone, one provider unit survives, and only current text is recalled;
- definite replace failure preserves prior active truth and candidate is not approved;
- ambiguous replace reconciles under the same document ID, verifies before retry, and does not duplicate provider mutation when the first write already applied;
- concurrent approvals converge to one replacement;
- forget after replacement removes the reused document;
- conflict resolution/retry and candidate state transitions are CAS-safe;
- SQLite migration from a populated prior schema preserves rows/conflicts;
- audit, Session entries, evidence, and provider request journal contain no memory bodies/secrets;
- no Bank enumeration and no access to non-owned locators.

## Final-review concurrency and recovery findings

The independent final review failed, and Pi confirmed all five findings against the implementation. They are in scope for this authorized narrow fix:

1. Forget followed by create of the same scope/type/text must not reuse a committed historical create operation and falsely return duplicate while the provider document is absent. Re-create must establish a valid active local/provider truth under a safely owned locator and operation generation; candidate approval must not convert a stale historical duplicate into approval.
2. A failed/reconciling delete operation must not permanently pin `forget:<memoryId>` to an old expected text hash after a later governed replacement. Delete identity/versioning must allow safe deletion of the current target generation while preserving retry semantics for an actually in-flight/ambiguous delete.
3. Replace and forget on the same logical memory must be mutually coordinated. No interleaving may let delete physically remove the document and a previously in-flight replace later finalize the row back to active, or let both provider mutations race without an honest recoverable state. Do not hold SQLite transactions over network.
4. Create reconciliation must match replace safety: when direct verification of a prior ambiguous create is itself ambiguous, return unknown and keep reconciling; do not issue another retain. Retry retain only after a non-ambiguous exact absence/mismatch that is safe under the adapter contract.
5. Once provider Document DELETE has been issued or acknowledged, any post-delete GET/list transport, timeout, malformed, pagination, or otherwise unproven postcondition must be returned as ambiguous/maybe-deleted. Governance must keep the row/operation reconciling and must not restore or report a definite old truth.

## Follow-up independent review (post atomic-finalizer pass)

Pi confirmed two additional blockers and requested an audit of a third:

A. Unbounded create→forget→same-content recreate must walk historical revive keys (not a single first-generation revive) until a resumable op or a new collision-free key is minted; preserve first-generation `:after:<id>:g<gen>` compatibility; bound/hash later keys.
B. Candidate approval must CAS-require the mapped memory to remain active and coherent before `approved`/conflict resolve/audit; concurrent forget before finalization must not approve.
C. Audit: production HttpClient/adapter mark timeout/network/5xx/malformed-after-ack as ambiguous; definite 4xx may set `ambiguous: false`. Service hardening: after `provider_mutation_issued`, only explicit `ambiguous: false` may `release_active`; missing flags are treated as maybe-executed.

Implementation must define one coherent per-memory mutation ownership/generation protocol across create, replace, and delete. It may use an additive migration and bounded local generation/version fields if needed. It must preserve legacy locator compatibility, stale-candidate snapshots, A→B→C→B update idempotency, exact document reuse, and body-free audit. Do not solve this with process-global locks only; correctness must survive multiple Pi windows sharing SQLite.

Additional required regressions:

- create → verified forget → same-content remember performs a real provider retain and ends with one valid active row/document; candidate approval cannot falsely approve from the deleted historical create;
- failed and ambiguous forget followed by replacement, then forget of the current version, has correct operation ownership and postconditions;
- deterministic replace-versus-forget interleavings cover both claim orders and delayed provider completions, proving no deleted document is finalized active and no uncoordinated dual mutation occurs;
- ambiguous create verify causes zero additional retain; exact absence permits one retry;
- acknowledged delete followed by GET/list timeout, malformed response, or inconsistent postcondition remains reconciling/unknown;
- retries after process/window handoff use only durable SQLite state, not in-memory locks;
- all prior explicit update, stale candidate, legacy v1/v2/v3/v4 migration, recall, and physical forget regressions remain green.

## Acceptance criteria

- No shipped “update/supersede ... not implemented” path remains for valid governed candidates.
- Contradictory/corrective target-specific requests cannot silently create a second active recallable memory.
- Replacement preserves the logical document ID and proves exact new content before local success.
- Failure, ambiguity, retries, cancellation, and concurrency never produce false approval or two active truths.
- All verification listed above passes, including packaged Pi acceptance, a fresh disposable live Hindsight run, and a fresh independent final review.

## Prohibited actions

- Do not read or output credentials, `.env`, authorization headers, or existing memory bodies.
- Do not access, list, mutate, or delete pre-existing Hindsight Banks.
- Do not modify Docker/container configuration during this task.
- Do not commit, push, publish, deploy, SSH, or globally install anything.
- Stop and report if safe correction exceeds this scope or requires a product decision not fixed above.

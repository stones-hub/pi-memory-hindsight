# Memory retention and discovery follow-up

## Status

- State: **accepted and publicly released as `v0.1.0`**; **publication-readiness independently signed off by Pi** and focused rereview `VERDICT: PASS`. User authorized commit, `origin` setup, push, tag, and GitHub Release; release tag resolves to `717c12e76110cc6a2f58ee1e7657a36c9db7bce7`, and the public Release is `https://github.com/stones-hub/pi-memory-hindsight/releases/tag/v0.1.0`. Blocker fixes: root `LICENSE` copied from remote Apache-2.0 (`c71d239d…`), `package.json` `license` `Apache-2.0`, `files` includes `LICENSE`, deny-only `allowScripts` wording corrected, git-install acceptance proves LICENSE in staged git source + `npm pack --ignore-scripts`, lower-priority isolated `~/.npmrc` precedence check, git-install vitest timeout **150000ms**. Pi verification: `npm test` **16 files / 272 tests**, pack **64 files** (54 TS sources, no `dist/`) evidence SHA-256 `55fcccf77ef9ac7b3e0fd6ad965dfdc6ae1fde3ee1dc71baca42634b47d78c81`, packaged Pi evidence SHA-256 `e0965b1cc3251a00b9485d5bfbc8a2063ed88a7589220d8ff7eddc4f1bfb9bdc`, git-install evidence SHA-256 `00605090a6d2e1b67c69b4c763713dff13f75c053a9339620b0053b261373fe6`.
- User confirmation: the design below is approved.
- Coding authorization: granted on 2026-03-21 for implementation only.
- Commit, remote setup, push, tag, and GitHub Release authorization: **granted in the current user turn**. npm publication and machine deployment were not requested.
- Executor (coding): Cursor Agent chat `93f0fce7-e569-4b4c-ac14-934a2ef1a61e`; requested model `composer-2.5`; actual model absent from response and therefore **unproven**. Earlier attempts with invalid `PI_MODEL` values or usage-limited models produced no changes.
- Baseline HEAD: `4fce7f1ef466cece83de34579b51df6f34c2e1c1`; feature commit `8b47280`; remote initial commit `65a6b32` preserved by no-force merge commit `40fd072`.
- Baseline manifest (historical): `/tmp/pi-memory-hindsight-retention-discovery-before.sha256`, SHA-256 `f75c3043cbcd49e4d593e152ad99ff28eca402e3a339c578b2722c0a36867d72`.

## Historical pre-fix verification (2026-09-09; superseded by current status above)

- Offline suite: `npm test` **15 files / 269 tests**; `npm run typecheck`; `npm run build`; `npm audit --omit=dev` **0 vulnerabilities**; `git diff --check`; byte NUL scan **clean**.
- Pack dry-run: **224 files**; evidence `/tmp/pi-memory-hindsight-retention-pack-dry-run-final3.json`, SHA-256 `e218c607eac483aa81c494099d8b91320a53c78fbfcec71295cc6c1620b1d40b`.
- Packaged isolated Pi acceptance: evidence `/tmp/pi-memory-hindsight-acceptance-pi.json`, SHA-256 `e92a9960de7aa13747833be6aaf8c7bbee2ae7cbc239201e9372f10fb8f539a9`; all **19** required booleans `true` (including `memoryIdSurfaced`, `memoryListShowWorked`, `cleanupStatusWorked`, `cleanupNowWorked`); `pending=[]`; isolated resources cleaned.
- Disposable live Hindsight 0.8.3 acceptance: evidence `/tmp/pi-memory-hindsight-acceptance-hindsight-live.json`, SHA-256 `c9408a9f52699a3ffe6190a82208d76245872ef9b14278118c682dc901ed78ca`; retain/recall/same-document replace/delete/known absence/cleanup pass; disposable Bank `pi-memory-hindsight:project:c9cd8e6c67fc9c322f4047e9186d1d42`, nonce `retention-final3-20260909141012-929ffb6a`, `cleanupOperationallyComplete=true`; never list Banks.
- Final read-only review: **PASS**; Cursor chat `c06e5d55-4faa-4dd6-b211-99e75977423a`; evidence `/tmp/pi-memory-hindsight-retention-discovery-ultimate-verdict-cursor.json`, SHA-256 `18b7b47f68d97db97a64ecfc8ebcc19e62bc5e2d0675dd67f961c69a2c59c1ff`.

## Pi installation nuance

- Pi settings/config were **not** modified in this follow-up, and no real Pi TUI acceptance was run against the user's live profile.
- The user's existing Pi package registration **points at this local repository**; repeated builds refreshed ignored `dist/`, so a future Pi process **may load the candidate code** without a separate install step.

## Non-blocking residuals (final review)

- Maintenance must run to physically delete expired documents; expiry alone does not guarantee immediate provider absence.
- No automatic `VACUUM` or promised SQLite file shrink.
- Post-migration cleanup failure path lacks a dedicated test.
- Standalone Pi `node:sqlite` compatibility and remote embedding locality remain environment/operator concerns.

## Confirmed gaps

### 1. SQLite retention and cleanup

The local SQLite database currently retains candidate rows after they become `approved`, `rejected`, or `expired`. Pending candidates have a 30-day expiry transition, but expiry changes state only; it does not physically delete or compact historical rows. Operations, conflicts, audit, and usage tables likewise have no bounded retention/compaction policy. Long-term use can therefore cause the database to grow continuously, and approved candidate bodies can remain locally after the formal memory has been written to Hindsight or later forgotten.

Required product outcome:

- Define bounded retention separately for candidates, operations, conflicts, audit, and usage.
- Decide which records may be physically deleted and which must be reduced to body-free tombstones or summaries.
- Expired/rejected/approved candidate bodies must not be retained indefinitely by default.
- Cleanup must preserve referential integrity, concurrency/crash recovery, candidate approval history needed for correctness, and physical-forget guarantees.
- Cleanup must be transactional, bounded per run, safe across multiple Pi windows, and observable without logging memory bodies.
- Provide an explicit/manual cleanup command and, if automatic cleanup is adopted, define exactly when it runs and how failures degrade.
- Add migration, retention, privacy, concurrency, and database-size regressions before enabling cleanup.

### 2. Formal-memory expiration lifecycle

Time-bounded formal Project memories currently write the same `expires_at` into SQLite and Hindsight metadata, but expiration is enforced only as a recall-time filter. After the deadline:

- the SQLite `memories` row can remain `status = 'active'`;
- the Hindsight document can remain physically present;
- no automatic governed delete is attempted;
- no formal-memory `expired` state exists;
- list/show functionality could misreport the row as active unless it computes effective expiration separately.

Affected formal-memory types:

- `project_fact`: 180 days;
- `task_state`: 30 days;
- `inference`: 90 days.

Required product outcome:

- Define an explicit lifecycle for formal-memory expiration, distinct from Candidate expiration.
- Stop recall immediately at `expires_at`, as today, while also representing the effective expired state honestly in list/show/status surfaces.
- Decide whether to add `expired`, `expiry_pending`, or equivalent durable states.
- Decide whether expiration triggers governed physical deletion of the exact Hindsight document, including post-delete proof and ambiguous/reconciling recovery.
- Preserve a body-free tombstone long enough to block stale operations and delayed provider completions before later compaction or deletion.
- Ensure cleanup is bounded, transactional, safe across multiple Pi windows, and never enumerates Banks.
- Add time-controlled tests for expiration, concurrent update/forget/cleanup, failed or ambiguous provider deletion, restart recovery, and final compaction.

### 3. Memory ID discovery and inspection

The extension supports exact `/memory update <logical-memory-id> <content>` and `/memory forget <logical-memory-id>`, but currently lacks a supported user-facing way to list active memories with their IDs or inspect one memory. `/memory last` displays recalled text/type without IDs; `/memory candidates list` does not display candidate IDs; ordinary remember/approval notifications do not consistently expose the resulting memory ID.

Required product outcome:

- Add a safe read-only memory listing capability, expected commands:
  - `/memory list`
  - `/memory list profile`
  - `/memory list project`
  - `/memory show <logical-memory-id>`
- Include logical memory ID, scope, type, project identity where applicable, verification/status, lifecycle timestamps, and enough bounded text to identify the memory.
- Retrieve formal text only through exact owned Bank/document locators already proven by SQLite; never enumerate Banks and never use fuzzy target selection.
- Respect project identity, active/deleted/reconciling status, open conflicts, sensitive-content filtering, output bounds, and TUI-only behavior.
- Update remember and candidate-approval success messages to expose the resulting memory ID.
- Consider showing IDs in `/memory last` and candidate IDs in textual candidate listings.
- List/show must never mutate memory or convert untrusted Hindsight-only content into locally governed truth.

## Questions to resolve before implementation

- Retention durations for each table and each candidate terminal state.
- Whether approved candidate text should be removed immediately after successful Hindsight write or retained briefly for undo/diagnostics.
- Whether deleted- and expired-memory tombstones are permanent, time-bounded, or compacted while preserving stale-operation safety.
- Whether formal expiration first changes status, immediately attempts physical Hindsight deletion, or uses a two-phase lifecycle.
- Whether list defaults to effective active-only and how expired/deleted/reconciling records are requested.
- Maximum text preview size and whether `show` may display full formal memory text after exact provider verification.
- Whether automatic cleanup runs at startup, after settled turns, on a schedule, or only via an explicit command.

## Approved implementation policy

- Add `/memory list`, `/memory list profile`, `/memory list project`, and `/memory show <logical-memory-id>` using only SQLite-proven exact Bank/document locators. Default list is bounded to 20 effective-active local memories from Profile plus the current enabled Project.
- Show IDs in remember success, candidate approval, candidate text listing, and locally governed `/memory last` items. Shared Project recalls without a local row are explicitly read-only and do not become update/delete targets.
- Candidate body policy: keep bodies only while pending/approving/failed/reconciling; after approved, rejected, or expired reaches a definite terminal state, immediately null `text` and `evidence_summary`, retaining a text hash and `body_purged_at`. Any state transition and purge must be atomic. Historical UI must safely render a purged body.
- Formal expiration policy: `project_fact` 180 days, `task_state` 30 days, and `inference` 90 days stop recall immediately at `expires_at`; bounded maintenance reuses the governed exact-document delete protocol and crash recovery, with successful expiry ending in `expired` and uncertain deletion remaining reconciling. Update and forget must coordinate with expiry ownership and cannot resurrect expired content.
- Memory update continues replacing the same Hindsight document and retains no old body. Manual forget physically deletes Hindsight content and ends in `deleted`; associated terminal Candidate bodies must be purged.
- Retention defaults: body-free terminal Candidate metadata 90 days; terminal operations 30 days; resolved conflicts 90 days; audit and usage 90 days with a maximum of 10,000 rows each; body-free deleted/expired Memory tombstones 90 days. Never purge pending/in-progress/reconciling operations, open conflicts, reviewable/recoverable Candidates, owned mutations, or referenced tombstones.
- Add bounded `/memory cleanup status` and confirmed `/memory cleanup now`. Automatic maintenance runs at most once per 24 hours after an agent-settled cycle, never on the recall critical path, handles at most 10 expired formal memories per pass, and uses durable SQLite coordination across Pi windows. Local row cleanup is bounded. Do not run full `VACUUM` automatically.
- SQLite deletes may leave reusable free pages; physical file shrinking is not promised in this slice.

## Acceptance requirements

- Additive migration from populated v1-v6 databases preserves active/recoverable data and permits purged Candidate bodies.
- Exact list/show must validate provider text/metadata/hash and fail closed; provider outages may still show ID/scope/type/status with content unavailable, never stale/unverified body.
- Deterministic tests cover all list/show scopes and visibility, success IDs, Candidate terminal transitions, body purge atomicity, expiration/update/forget races in both claim orders, ambiguous expiry delete and restart takeover, multi-window maintenance lease, bounded batches, every retention table, foreign-key safety, and no Bank enumeration.
- Update README and relevant architecture/policy/acceptance/HANDOVER documentation to match implemented behavior.
- Executor ran focused tests, current full `npm test`, typecheck, build, pack dry-run/remove tgz, `npm audit --omit=dev`, diff/NUL scan, and extended packaged `acceptance:pi` for list/show/cleanup TUI.
- Pi independently completed all acceptance gates listed under **Pi final verification** above.

## Constraints

- No Bank enumeration.
- No fuzzy/LLM selection of update or forget targets.
- Existing exact-ID update/forget and provider reconciliation guarantees must remain intact.
- Never put credentials, secrets, full logs, or large bodies into list output or audit.
- Any implementation requires a separately approved design/task and coding authorization.

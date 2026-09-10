# Acceptance Plan

Status: Slice 5 plus retention/discovery follow-up was **accepted** by Pi (2026-09-09) on baseline `4fce7f1ef466cece83de34579b51df6f34c2e1c1`, but a subsequent **real-profile smoke** exposed that Hindsight 0.8.3 returns governance metadata on `document_metadata` (document GET) while list units use `metadata: null`. Prior PASS hashes below are **invalidated** by the `document_metadata` discovery fix (Cursor chat `93f0fce7-e569-4b4c-ac14-934a2ef1a61e`). A temporary smoke memory was physically forgotten and proven absent; existing user memory was untouched. **Pi must rerun** offline tests, packaged `acceptance:pi`, and live-profile smoke before any new acceptance claim. **Commit authorization has not been granted.** **Pi settings/config were not modified** in this fix; the user's Pi package registration may still load candidate `dist/` from this repository.

## Evidence layers (do not conflate)

| Layer | Who runs it | What it proves | Final evidence (2026-09-09) |
|---|---|---|---|
| Agent/executor self-report | Coding agent during implementation | Implementation intent only; not acceptance by itself. | Chat `93f0fce7-e569-4b4c-ac14-934a2ef1a61e` |
| Pi independent offline checks | Pi reviewer | `npm test`, typecheck, build, pack dry-run, audit, diff/NUL on uncommitted tree. | **15 files / 269 tests**; audit **0** vulns; NUL clean; pack dry-run **224 files**, SHA-256 `e218c607…1d40b` |
| Packaged Pi offline acceptance | Pi reviewer (`npm run acceptance:pi`) | Packed tarball in isolated temp dirs with mock Hindsight; **19** required booleans `true`. | `/tmp/pi-memory-hindsight-acceptance-pi.json`, SHA-256 `e92a9960…f539a9` |
| Disposable live Hindsight contract | Pi reviewer (`npm run acceptance:hindsight:live`) | One nonce-derived bank only; never list Banks. | `/tmp/pi-memory-hindsight-acceptance-hindsight-live.json`, SHA-256 `c9408a9f…d78ca` |
| Final read-only review | Pi reviewer | Architecture/policy/safety verdict. | **PASS**; chat `c06e5d55-4faa-4dd6-b211-99e75977423a`; SHA-256 `18b7b47f…9c1ff` |
| Live Pi TUI against user profile | User | Not run in this follow-up. | Settings/config unchanged; local package registration may load candidate `dist/` |

## Automated coverage matrix

| Layer | Runner | Default | Current evidence |
|---|---|---:|---|
| Unit/integration | `npm test` | Yes | **269 tests** across **15 files** (Pi final, 2026-09-09). Covers SQLite v1–v7 migrations, provider adapter, lifecycle, governance commands/tools, retention/discovery/expiry cleanup, response parsing, security filters, Slice 5 acceptance/live-gate helpers, mock-Hindsight-backed integration, and the live-runner's retain/recall/replace/cleanup flow against a mock server. |
| Type safety | `npm run typecheck` | Yes | Must pass before packing. |
| Package build | `npm run build`, `npm pack --dry-run` | Yes | Verifies packed extension entrypoint and included files. |
| Packaged Pi offline acceptance | `npm run acceptance:pi` | Opt-in but offline-safe | Uses packed tarball contents in isolated temp dirs, loopback mock Hindsight, fake local provider, real `pi` subprocesses, hard timeouts, and cleanup. Hard-fails unless every required evidence boolean is `true` and `pending` is empty. Writes redacted evidence to `/tmp/pi-memory-hindsight-acceptance-pi.json`. |
| Disposable live Hindsight contract | `npm run acceptance:hindsight:live` | No | Explicitly gated; never run by default. Requires loopback base URL, expected API version, live accept flag, and a nonce-derived disposable bank ID. |

## Current packaged offline evidence

**Final (2026-09-09):** `/tmp/pi-memory-hindsight-acceptance-pi.json`, SHA-256 `e92a9960de7aa13747833be6aaf8c7bbee2ae7cbc239201e9372f10fb8f539a9`. All **19** required booleans `true`; `pending=[]`; isolated resources cleaned.

The isolated runner proves:

1. Packed tarball contents can be unpacked and loaded by real `pi` subprocesses in isolated temp dirs.
2. The package registers the `memory` command and `memory_remember` tool.
3. `/memory off` and `/memory on` persist per session through body-free custom Session entries.
4. Explicit remember/update writes one owned-bank document through the mock Hindsight contract without bank enumeration. `/memory remember` creates and surfaces the logical Memory ID; `/memory update <id>` reuses the existing document id.
5. While the memory remains active, `/memory list profile` and `/memory show <id>` surface the exact logical ID and updated bounded preview/content through exact document GET + list-by-document reads, validating `document_metadata` when list units return `metadata: null` (no bodies in evidence JSON). Packaged acceptance asserts `document_get` and `list` routes increase during discovery without extra retain/delete.
6. `/memory cleanup status` renders maintenance status without provider mutation; confirmed `/memory cleanup now` completes and advances `maintenance_state.last_success_at` while leaving the active remembered row intact.
7. Automatic extraction creates exactly one reviewable candidate, which can be listed and rejected through the TUI and is reflected as `rejected` in SQLite.
8. Turn-scoped recall injects exactly one relevant memory item into the system prompt for the triggering turn and creates no persisted recall message in the session's own `.jsonl` file (verified by diffing session files before/after and asserting exactly one new recall route was made).
9. Forget deletes that document and verifies document absence plus zero units by document ID.
10. Provider-unavailable status degrades without crashing the Pi session.
11. Print, JSON, and RPC modes perform no automatic recall/retain and leave SQLite candidate/memory counts unchanged.
12. The request journal proves auth was actually sent (`authPresent`) while never containing the real API key value or any remembered content.

Required evidence booleans include: `memoryIdSurfaced`, `memoryListShowWorked`, `cleanupStatusWorked`, and `cleanupNowWorked`, in addition to the Slice 5 booleans.

There is no remaining packaged-acceptance gap; `npm run acceptance:pi` hard-fails (`ensureRequiredSuccess`) if any of the above cannot be proven.

**Final live Hindsight evidence (2026-09-09):** `/tmp/pi-memory-hindsight-acceptance-hindsight-live.json`, SHA-256 `c9408a9f52699a3ffe6190a82208d76245872ef9b14278118c682dc901ed78ca`. Disposable Bank `pi-memory-hindsight:project:c9cd8e6c67fc9c322f4047e9186d1d42`, nonce `retention-final3-20260909141012-929ffb6a`, `cleanupOperationallyComplete=true`.

**Historical (pre-retention follow-up):** prior packaged Pi SHA-256 `0ea2e7c5…d92acd`; prior live SHA-256 `468baf1b…073070`. Do not treat as current.

## Non-blocking residuals (final review)

- Maintenance must run to physically delete expired documents.
- No automatic `VACUUM` or promised SQLite file shrink.
- Post-migration cleanup failure path lacks a dedicated test.
- Standalone Pi `node:sqlite` compatibility and remote embedding locality remain environment/operator concerns.


## Functional acceptance

1. Multiple interactive Pi windows under one Pi configuration directory share one Profile Bank without duplicate initialization.
2. A second Pi configuration directory receives a different Profile Bank.
3. Project config absent/disabled yields Profile-only behavior and never creates or queries a Project Bank.
4. Project config enabled with explicit `project` uses the lowercase value.
5. Without `project`, final Git remote repository name is used, lowercased and without `.git`.
6. Missing explicit identity and unusable remote safely disables Project Memory.
7. Different profiles with the same project identity share the same Project Bank.
8. Automatic recall runs at most once per user turn and never in tool loops.
9. At most 10 memories and ~1,500 tokens are injected as untrusted reference context.
10. Automatic extraction creates SQLite candidates only; approval writes to Hindsight.
11. Explicit remember/update supports natural-language tool and deterministic command paths. Tool create forbids a target; tool update requires an exact local logical memory id and forbids caller-supplied scope/type/locators.
12. TUI supports bilingual review, edit, approve, reject, filters, and evidence detail.
13. `/memory off` persists per Session without affecting other windows; `/memory on` restores it.
14. Print, JSON, and RPC modes perform no automatic memory behavior.
15. Physical forget deletes the target's dedicated Hindsight document, verifies post-delete absence, removes it from future recall, and stores no body in local audit. Project forget requires the currently enabled cwd project identity.
16. Recall injection changes only the current turn's system prompt and creates no recall message in the Session file.
17. An approved atomic candidate produces exactly one exact-text Hindsight source unit without Hindsight generative extraction or observation consolidation.
18. Repeating an ambiguous write under the same logical ID reconciles through the same document ID and creates no duplicate document.

## Safety acceptance

- Representative API keys, bearer tokens, JWTs, cookies, private keys, passwords, and `.env` bodies are rejected before model/storage boundaries.
- Complete files, large code/log/terminal bodies, and model thinking are not stored.
- A malicious instruction in tool output cannot become trusted instruction context or an automatically approved memory.
- Project content cannot enter Profile memory when Project Memory is disabled.
- Existing Hindsight banks outside the dedicated namespace remain untouched and are never enumerated by the Extension.
- Current repository evidence overrides stale recalled memory.
- Bank IDs reveal neither local profile paths nor project names.
- Owned-bank configuration drift blocks writes rather than silently enabling generative retain or observations.

## Failure acceptance

- Hindsight unavailable or slow does not block normal Pi work.
- Recall timeout does not retry within the same turn.
- Extraction failure creates no partial candidate and does not fall back to another provider.
- Concurrent approval allows only one writer.
- Ambiguous write outcome does not create silent duplicates.
- Delete failure or unknown completion is not reported as success; soft invalidation cannot pass the forget test.
- SQLite schema incompatibility or unavailable `node:sqlite` disables memory safely without breaking Pi.
- A malformed, fenced, oversized, partial, or schema-invalid extraction response creates zero candidates.
- Session shutdown cancels outstanding extraction without corrupting operation state.

## Test layers

- Unit: configuration, identity, scope, filtering, lifecycle, conflict, budgeting, rendering, i18n.
- Integration: SQLite migrations/concurrency, provider adapter, pipelines, failure and retry state.
- Contract: a disposable Hindsight 0.8.3 instance with synthetic owned banks/data and a non-owned sentinel; never the user's existing banks.
- Pi E2E: packaged extension installed into an isolated `PI_CODING_AGENT_DIR`, interactive lifecycle, per-turn system-prompt injection, Session resume, TUI, and no-op non-interactive modes.
- Platform: full local acceptance on macOS and CI coverage on Linux.

## Live runner safety gates

`npm run acceptance:hindsight:live` must refuse unless all of these are true:

1. `PI_MEMORY_HINDSIGHT_LIVE_ACCEPT=1`
2. `PI_MEMORY_HINDSIGHT_BASE_URL` is explicit loopback `http://` or `https://`
3. `PI_MEMORY_HINDSIGHT_EXPECTED_API_VERSION=0.8.3`
4. `PI_MEMORY_HINDSIGHT_LIVE_NONCE` is present
5. `PI_MEMORY_HINDSIGHT_LIVE_BANK_ID` exactly equals the nonce-derived disposable bank ID

The live runner may touch only that caller-supplied disposable bank. It never lists banks, never runs Reflect, never logs auth values, and must prove cleanup or fail.

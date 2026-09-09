# Acceptance Plan

Status: Slice 5 implementation landed. `npm run acceptance:pi` passes with every required evidence boolean `true` and `pending` empty. The gated disposable live-Hindsight contract runner (`npm run acceptance:hindsight:live`) is implemented, unit-tested against a mock Hindsight server, and honestly reports its one permanent gap (no reliable bank-absence endpoint), but has not been executed against a real Hindsight instance.

## Automated coverage matrix

| Layer | Runner | Default | Current evidence |
|---|---|---:|---|
| Unit/integration | `npm test` | Yes | 117 tests across 11 files. Covers SQLite, provider adapter, lifecycle, governance commands/tools, response parsing, security filters, Slice 5 acceptance/live-gate helpers, mock-Hindsight-backed integration (including `handleBeforeAgentStart` exercised against a real `HindsightAdapter` and real SQLite, for both Profile and shared-Project scope), and the live-runner's retain/recall/replace/cleanup flow against a mock server. |
| Type safety | `npm run typecheck` | Yes | Must pass before packing. |
| Package build | `npm run build`, `npm pack --dry-run` | Yes | Verifies packed extension entrypoint and included files. |
| Packaged Pi offline acceptance | `npm run acceptance:pi` | Opt-in but offline-safe | Uses packed tarball contents in isolated temp dirs, loopback mock Hindsight, fake local provider, real `pi` subprocesses, hard timeouts, and cleanup. Hard-fails unless every required evidence boolean is `true` and `pending` is empty. Writes redacted evidence to `/tmp/pi-memory-hindsight-acceptance-pi.json`. |
| Disposable live Hindsight contract | `npm run acceptance:hindsight:live` | No | Explicitly gated; never run by default. Requires loopback base URL, expected API version, live accept flag, and a nonce-derived disposable bank ID. |

## Current packaged offline evidence

From `/tmp/pi-memory-hindsight-acceptance-pi.json`, the isolated runner proves, with every required boolean `true` and `pending` empty:

1. Packed tarball contents can be unpacked and loaded by real `pi` subprocesses in isolated temp dirs.
2. The package registers the `memory` command and `memory_remember` tool.
3. `/memory off` and `/memory on` persist per session through body-free custom Session entries.
4. Explicit remember/update writes one owned-bank document through the mock Hindsight contract without bank enumeration. `/memory remember` creates; `/memory update <id>` and tool `action=update` replace under the existing document id.
5. Automatic extraction creates exactly one reviewable candidate, which can be listed and rejected through the TUI and is reflected as `rejected` in SQLite.
6. Turn-scoped recall injects exactly one relevant memory item into the system prompt for the triggering turn and creates no persisted recall message in the session's own `.jsonl` file (verified by diffing session files before/after and asserting exactly one new recall route was made).
7. Forget deletes that document and verifies document absence plus zero units by document ID.
8. Provider-unavailable status degrades without crashing the Pi session.
9. Print, JSON, and RPC modes perform no automatic recall/retain and leave SQLite candidate/memory counts unchanged.
10. The request journal proves auth was actually sent (`authPresent`) while never containing the real API key value or any remembered content.

There is no remaining packaged-acceptance gap; `npm run acceptance:pi` hard-fails (`ensureRequiredSuccess`) if any of the above cannot be proven.


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
15. Physical forget deletes the target's dedicated Hindsight document, verifies post-delete absence, removes it from future recall, and stores no body in local audit.
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

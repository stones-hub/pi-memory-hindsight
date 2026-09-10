# Handover

## Current task and plan

- Milestone: memory retention and discovery follow-up implemented.
- Design status: follow-up policy approved; coding authorization granted for Cursor Agent.
- Implementation status: retention/discovery follow-up is **accepted and committed locally**. After a real-profile smoke exposed that Hindsight 0.8.3 stores governance metadata in document GET `document_metadata` while list units return `metadata: null`, Cursor chat `93f0fce7-e569-4b4c-ac14-934a2ef1a61e` implemented dual exact-read validation and removed the unused `/memory extract` command surface (settled automatic extraction unchanged). **Publication-readiness (GitHub direct install, option A)** is implemented: `pi.extensions` loads `./src/index.ts`, root `LICENSE` matches remote Apache-2.0 (`c71d239d…`), `package.json` `license` is `Apache-2.0`, npm pack includes `LICENSE` (**64 files**), Pi core imports are `peerDependencies` with `"*"` ranges (exact versions remain in `devDependencies`), deny-only root `allowScripts` `{ "pi-memory-hindsight": false }` declares this package's own install scripts are not needed, README documents `pi install https://github.com/stones-hub/pi-memory-hindsight.git`, loopback `git daemon` + real `pi install` git-source acceptance exists, and packaged Pi acceptance waits for `id=` at remember time. **Publication acceptance was signed off** after Pi independently reran the release-critical checks and an independent focused rereview returned `VERDICT: PASS`. User authorized commit, remote setup, push, tag, and release; `main`, annotated tag `v0.1.0`, and GitHub Release are published. The immutable release tag points to `717c12e76110cc6a2f58ee1e7657a36c9db7bce7`.
- Baseline commit: `4fce7f1ef466cece83de34579b51df6f34c2e1c1` plus intentional README rewrite and task file.
- Compatibility: upgraded SQLite may still reference Hindsight documents created under the pre-fix text-hash document formula with legacy metadata (`logical_id=text_hash`, no `content_hash`). Recall/forget accept only that legacy format or the current row-id formula when locally proven; shared Project recall without a local row rejects legacy. Governed updates reuse the stored legacy document id and write current metadata. Formal expiry and list/show use the same locator rules.

## Completed

- Product decisions captured in `docs/product-requirements.md` and `docs/memory-policy.md`.
- Architecture, threat model, provider contract, and acceptance baseline documented.
- Local Hindsight identified as `vectorize-io/hindsight` version `0.8.3`, API on `127.0.0.1:8888`; Control Plane `9999` is out of scope.
- Pi baseline identified as `0.85.1`, requiring Node `>=22.19.0`.
- Pi public APIs validated for mode gating, turn-specific system-prompt injection, commands/tools/custom TUI, non-context Session entries, current model access, and agent settlement.
- Built-in `node:sqlite` selected for macOS/Linux Node runtime packaging.
- Hindsight exact-write design fixed: dedicated owned banks use `chunks` retain with observations and auto-consolidation disabled; one logical memory maps to one deterministic document.
- Hindsight physical-forget design fixed: delete the one-memory document and verify absence. Hindsight 0.8.3 has no public single-unit DELETE.

## Key implementation constraints

- Use only `ctx.mode === "tui"` for automatic behavior; `hasUI` also covers RPC and is not a sufficient gate.
- Recall injection must return a modified system prompt from `before_agent_start`. Do not return a custom message or call `sendMessage`, because those persist in Session context.
- Pair `agent_end` message data with `agent_settled`; the settled event itself has no messages.
- Independent extraction uses `ctx.modelRegistry.complete()` with a fresh context, no tools, a fresh routing/session ID, explicit timeout/cancellation, and separate usage accounting.
- Strict structured sampling is not provider-universal. Parse one bounded JSON value, validate strictly, and reject the complete response on any error.
- Use Pi's public `getAgentDir()` and `pi.appendEntry()` APIs; do not import internal `dist/core` modules.
- Do not list Hindsight banks. Compute only hashed dedicated bank IDs.
- Writes fail closed unless required owned-bank overrides are read back successfully.
- Synchronous retain does not return unit IDs. Reconcile by deterministic `document_id` and exact text.
- Normal edits replace the deterministic document rather than PATCHing only the unit, because PATCH leaves source document/chunk text stale.

## Verification status

- Formal implementation: Slices 1–4, conflict/update/supersession, retention/discovery, real `document_metadata` compatibility, and manual-extract command cleanup are accepted and committed locally.
- **Pi independent offline (accepted on current tree):** `npm test` **16 files / 272 tests**; `npm run typecheck`; `npm run build`; `npm audit --omit=dev` **0 vulnerabilities**; `git diff --check`; byte NUL scan **clean**.
- **Pack dry-run (accepted on current tree):** **64 files** including root `LICENSE`, 54 TypeScript source files, `src/index.ts`, and no `dist/`; evidence `/tmp/pi-memory-hindsight-publication-pack-final.json`, SHA-256 `55fcccf77ef9ac7b3e0fd6ad965dfdc6ae1fde3ee1dc71baca42634b47d78c81`.
- **Packaged Pi acceptance (accepted on current tree):** evidence `/tmp/pi-memory-hindsight-acceptance-pi.json`, SHA-256 `e0965b1cc3251a00b9485d5bfbc8a2063ed88a7589220d8ff7eddc4f1bfb9bdc`; all **19** required booleans true; `pending=[]`.
- **Loopback git-install acceptance (accepted on current tree):** evidence `/tmp/pi-memory-hindsight-git-install-acceptance.json`, SHA-256 `00605090a6d2e1b67c69b4c763713dff13f75c053a9339620b0053b261373fe6`; `packageLicenseField` `Apache-2.0`, `licenseFileSha256` `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`, `stagedLicenseMatchesRemote`, `packedLicenseIncluded`, `lowerPriorityUserNpmrcAllowScriptsPresent`, `packageDenyOnlyAllowScripts`, `npmInstallCompleted`, `piInstallCompleted`, `memoryCommandLoaded`. Harness injects lower-priority isolated `~/.npmrc` `allow-scripts=...` and neutralizes host global npmrc/CLI env so normal project-scoped install with package deny-only `allowScripts` is what is proven; does **not** model npm CLI/env allow-scripts rejection.
- **Packed README command-surface probe:** evidence `/tmp/pi-memory-hindsight-readme-surface.json`, SHA-256 `2f8f56dc6b84e6a40892b611987ed318b7ccb9184e4e19fca240820453ef95f0`; help has no manual extract, unknown extract returns help, language/status/last pass, and SQLite remains 0 Candidate/0 Memory in the isolated profile.
- **Disposable live Hindsight 0.8.3 acceptance (current):** evidence `/tmp/pi-memory-hindsight-acceptance-hindsight-live.json`, SHA-256 `03c31ce350bf3674b6bb6bdc3edd27d8a3d6c9839a6b84989cc90c10e5b5355e`; retain/recall/same-document replace/delete/known absence/cleanup pass; disposable Bank `pi-memory-hindsight:project:930308c9f0ac24961449050cee208174`, nonce `readme-full-20260910033000-1a36ba8d1357b5ed`, `cleanupOperationallyComplete=true`; never list Banks.
- **Independent README contract review:** **PASS**, no blockers; Claude Code session `e981bd95-f051-4b19-9070-4aeea2e642c5`; evidence `/tmp/pi-memory-hindsight-readme-contract-review-claude.json`.
- Retention/discovery follow-up proves: additive v7 migration from populated v1–v6; exact list/show with content-unavailable degradation; remember/approve/candidates/last IDs; atomic candidate body purge; formal expiry via owner/generation/progress-token protocol ending in `expired`; update/forget coordination; ambiguous expiry restart takeover; multi-window maintenance lease; bounded retention across candidates/operations/conflicts/audit/usage/tombstones; project-forget cwd gate; locator fail-closed gates; foreign-op retirement on expiry handoff; no Bank enumeration.
- Slice 1 safety probes: no NUL bytes in `src/` or `tests/`; DB scope/type/project constraints, guarded candidate transitions, language constraints, bounded audit/usage fields, bulk evidence rejection, conservative CJK budgeting, strict JSON parsing, config/identity rules are covered.
- Slice 2 provider probes use only an in-process `127.0.0.1` mock server and cover owned namespace rejection before I/O, exact Hindsight 0.8.3 capability gating, fixed Bank config readback, strict metadata, item-level `update_mode=replace`, exact one-unit reconciliation, recall/reflect bounds, mutation ambiguity, and verified Document deletion. No live Hindsight call was made.
- Slice 2 final manifest: `/tmp/pi-memory-hindsight-slice2-final.sha256` (manifest SHA-256 `e34842c25cc33e974e1173dbf6fda94f9720ac66f29b56871bd044edcabe24a6`).
- Slice 3 proves public package discovery, exact TUI-only mode gates, turn-specific non-persistent Recall, shared Project metadata governance, per-turn/per-run deduplication, minimal settled extraction material, isolated current-model calls, cancellation, atomic candidate batches, and body-free usage/audit. No real Pi profile or live service was used.
- Slice 3 final manifest: `/tmp/pi-memory-hindsight-slice3-final.sha256` (manifest SHA-256 `d15daa21cacbd53a54bf4c37ba5f73ee9d9e767122ffeb3406e345c3ed0a70cf`).
- Slice 4 proves one command/one strict tool registration, local/provider runtime separation, session on/off, localized status/language/last/help, shared governed writes, stable retry metadata, operation ownership, candidate CAS/reviewer actions, physical forget locator proof, manual-only Reflect confirmation, populated v1→v2 migration, cancellation, and offline local governance.
- Slice 4 final manifest: `/tmp/pi-memory-hindsight-slice4-final2.sha256` (manifest SHA-256 `903b32c29665294143101b0965388744fe04f3fb4611a307f74c298bf9df8cb5`).
- Hindsight mutation tests: the disposable live runner implements owned-bank retain/recall/exact-item-check/same-document replace/re-verify, followed by whole-bank DELETE and known-document absence proof. It validates the real Hindsight 0.8.3 `DeleteResponse` fields (`success`, optional `message`, optional `deleted_count`) and honestly reports that no public endpoint proves total Bank nonexistence. Mock tests cover success, individual/combined failures, malformed legacy delete responses, non-owned-bank rejection, and exact same-document replacement.
- **Historical (pre-retention follow-up):** prior packaged Pi acceptance SHA-256 `0ea2e7c5a4dd627d74881a5c8b7b3c33597d1032f3d4599180cb856937d92acd`; prior live Hindsight acceptance SHA-256 `468baf1b61cded359c1d161d81cb821ba6609d6998b8f301c7a41d6ba4103070`; prior final review chat `62022856-6ded-4158-b98f-6dd1a2723f11`. Do not treat these as current.
- Existing non-dedicated Hindsight banks were not listed, read, updated, or deleted during final live acceptance.
- **Pi installation nuance:** Pi settings/config were not modified in this follow-up, and no real Pi TUI acceptance was run against the user's live profile. The user's existing Pi package registration points at this local repository; repeated builds refreshed ignored `dist/`, so a future Pi process may load the candidate code.

## Git status

- Baseline HEAD: `4fce7f1ef466cece83de34579b51df6f34c2e1c1`.
- Feature commit: `8b47280` (`feat: add governed retention, discovery, and GitHub source install`).
- Remote-history merge commit: `40fd072`; remote initial commit `65a6b32` was preserved with no force-push.
- Published release commit: `717c12e76110cc6a2f58ee1e7657a36c9db7bce7`; annotated tag `v0.1.0` resolves to that exact commit.
- Current branch: local `main`, tracking `origin/main`.
- User authorized commit, `origin` setup, push, tag, and GitHub Release. No npm publication was requested or performed.
- GitHub publication: `main` and `v0.1.0` are public; Release URL: `https://github.com/stones-hub/pi-memory-hindsight/releases/tag/v0.1.0`. Public tag clone was verified to contain `src/index.ts`, matching Apache-2.0 `LICENSE`, and no `dist/index.js`.

## Non-blocking residuals (final review)

- Maintenance must run to physically delete expired documents; expiry alone does not guarantee immediate provider absence.
- No automatic `VACUUM` or promised SQLite file shrink.
- Post-migration cleanup failure path lacks a dedicated test.
- Standalone Pi `node:sqlite` compatibility and remote embedding locality remain environment/operator concerns.

## Next step

1. `v0.1.0` publication is complete. Any future code change, tag/release, npm publication, or machine deployment requires fresh authorization.
2. If committing, preserve evidence file paths and SHA-256 hashes recorded in this handover and `.pi/tasks/memory-retention-and-discovery-followup.md`.
3. Do not treat executor self-report or historical evidence hashes as substitutes for the final Pi evidence above.

## Executor session

- Phase-0 investigator: Claude Code model `claude-sonnet-5`, session `18e4ab87-8f78-4b64-8b73-28bf54cc58f5`.
- Two broad coding requests timed out without evidence files; their model/session identities are unproven.
- Slice 1 request used canonical model `claude-sonnet-5`, session `4de9f12b-b69f-4c5e-8e28-dc0e3bc1a9ef`.
- Claude Slice 1 attempt failed with upstream 503; evidence `/tmp/pi-memory-hindsight-slice1-code.json`.
- User explicitly authorized switching to Cursor Agent.
- Cursor Slice 1 model alias `auto`; actual model absent from terminal evidence and therefore unproven. Chat `ec2ebef3-c15e-4e4d-acd3-21c95e1d259f`.
- Cursor Slice 1 evidence: `/tmp/pi-memory-hindsight-slice1-cursor.json` and narrow-fix `/tmp/pi-memory-hindsight-slice1-cursor-fix.json`.
- Cursor Slice 2 model alias `auto`; actual model absent from terminal evidence and therefore unproven. Chat `21d7d7d3-811a-4e97-ae4c-0c5e43cd9995`.
- Cursor Slice 2 evidence: `/tmp/pi-memory-hindsight-slice2-cursor.json`, `/tmp/pi-memory-hindsight-slice2-cursor-fix.json`, and `/tmp/pi-memory-hindsight-slice2-cursor-fix2.json`.
- Cursor Slice 3 model alias `auto`; actual model absent from terminal evidence and therefore unproven. Chat `f31aa0fb-d6d8-4c03-a4e1-6a0f52ab92b3`.
- Cursor Slice 3 evidence: `/tmp/pi-memory-hindsight-slice3-cursor.json`, `/tmp/pi-memory-hindsight-slice3-cursor-fix.json`, and `/tmp/pi-memory-hindsight-slice3-cursor-fix2.json`.
- Cursor Slice 4 model alias `auto`; actual model absent from terminal evidence and therefore unproven. Chat `093454e5-d8a7-4a12-8972-2afa57ae0de6`.
- Cursor Slice 4 evidence: `/tmp/pi-memory-hindsight-slice4-cursor.json`, `/tmp/pi-memory-hindsight-slice4-cursor-fix.json`, `/tmp/pi-memory-hindsight-slice4-cursor-fix2.json`, and `/tmp/pi-memory-hindsight-slice4-cursor-fix3.json`.
- Slice 5 Claude Code coding/fix session: `20d3b4d5-4619-4c81-b1b3-738ae8520655`, canonical model `claude-sonnet-5`. Final narrow-fix evidence: `/tmp/pi-memory-hindsight-slice5-claude-live-validator-fix.json`.
- Latest offline source manifest: `/tmp/pi-memory-hindsight-slice5-offline-final.sha256`; manifest SHA-256 `1fc42918631e5672e3394683a3d9fa0f6d51723412f448da11e045266c23f272`.
- Retention/discovery follow-up coding: Cursor Agent chat `93f0fce7-e569-4b4c-ac14-934a2ef1a61e`; requested model `composer-2.5`; actual model unproven.
- No executor process remains. Slices 1–4 are accepted at slice level; Slice 5 and retention/discovery follow-up are **accepted** by Pi final verification (2026-09-09).

# Handover

## Current task and plan

- Milestone: initial implementation.
- Design status: phase-0 baseline approved by the user.
- Coding authorization: granted for narrow fix `.pi/tasks/conflict-update-supersession-fix.md` (sole coding executor), including the approved product decision for explicit `/memory update` and tool create/update shapes.
- Implementation status: release candidate complete and independently accepted. The conflict/update/supersession governance includes explicit target-only updates, replace verify-before-retry, candidate target-hash snapshots (DB v3), update idempotency keys binding expected+new hashes, DB v4 legacy document-key freeze, DB v5 per-memory mutation generation/ownership, and DB v6 provider-issued/progress-token crash recovery. Create/replace/delete/duplicate-reverify share durable ownership, generation, lease takeover, verify-first reconciliation, and atomic operation+memory finalization. Repeated create→forget→recreate chains, candidate-finalization races, stale delayed completions, post-delete ambiguity, and direct verification ambiguity are covered by deterministic regressions.
- Baseline: repository has no commits yet.
- Compatibility: upgraded SQLite may still reference Hindsight documents created under the pre-fix text-hash document formula with legacy metadata (`logical_id=text_hash`, no `content_hash`). Recall/forget accept only that legacy format or the current row-id formula when locally proven; shared Project recall without a local row rejects legacy. Governed updates reuse the stored legacy document id and write current metadata.

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

- Formal implementation: Slices 1–4 (`.pi/tasks/slice-1-core-foundation.md`, `.pi/tasks/slice-2-hindsight-provider.md`, `.pi/tasks/slice-3-pi-lifecycle.md`, `.pi/tasks/slice-4-governance-commands-ui.md`) completed by Cursor Agent and independently reviewed/fixed.
- Automated tests: latest independent run passes `npm test` (14 files, 193 tests), `npm run typecheck`, `npm run build`, `npm pack --dry-run` (200 files), `npm audit --omit=dev` (0 vulnerabilities), `git diff --check`, and byte-level NUL scanning of `src/` and `tests/`.
- Slice 1 safety probes: no NUL bytes in `src/` or `tests/`; DB scope/type/project constraints, guarded candidate transitions, language constraints, bounded audit/usage fields, bulk evidence rejection, conservative CJK budgeting, strict JSON parsing, config/identity rules are covered.
- Slice 2 provider probes use only an in-process `127.0.0.1` mock server and cover owned namespace rejection before I/O, exact Hindsight 0.8.3 capability gating, fixed Bank config readback, strict metadata, item-level `update_mode=replace`, exact one-unit reconciliation, recall/reflect bounds, mutation ambiguity, and verified Document deletion. No live Hindsight call was made.
- Slice 2 final manifest: `/tmp/pi-memory-hindsight-slice2-final.sha256` (manifest SHA-256 `e34842c25cc33e974e1173dbf6fda94f9720ac66f29b56871bd044edcabe24a6`).
- Slice 3 proves public package discovery, exact TUI-only mode gates, turn-specific non-persistent Recall, shared Project metadata governance, per-turn/per-run deduplication, minimal settled extraction material, isolated current-model calls, cancellation, atomic candidate batches, and body-free usage/audit. No real Pi profile or live service was used.
- Slice 3 final manifest: `/tmp/pi-memory-hindsight-slice3-final.sha256` (manifest SHA-256 `d15daa21cacbd53a54bf4c37ba5f73ee9d9e767122ffeb3406e345c3ed0a70cf`).
- Slice 4 proves one command/one strict tool registration, local/provider runtime separation, session on/off, localized status/language/last/help, shared governed writes, stable retry metadata, operation ownership, candidate CAS/reviewer actions, physical forget locator proof, manual-only Reflect confirmation, populated v1→v2 migration, cancellation, and offline local governance.
- Slice 4 final manifest: `/tmp/pi-memory-hindsight-slice4-final2.sha256` (manifest SHA-256 `903b32c29665294143101b0965388744fe04f3fb4611a307f74c298bf9df8cb5`).
- Local extension acceptance: packaged offline harness implemented and independently rerun successfully; latest evidence is `/tmp/pi-memory-hindsight-acceptance-pi.json`, with all 14 required booleans `true` and `pending` empty. The run left no Pi/PT​​Y subprocess or isolated temp directory behind.
- Hindsight mutation tests: the disposable live runner implements owned-bank retain/recall/exact-item-check/same-document replace/re-verify, followed by whole-bank DELETE and known-document absence proof. It validates the real Hindsight 0.8.3 `DeleteResponse` fields (`success`, optional `message`, optional `deleted_count`) and honestly reports that no public endpoint proves total Bank nonexistence. Mock tests cover success, individual/combined failures, malformed legacy delete responses, non-owned-bank rejection, and exact same-document replacement.
- Latest packaged Pi acceptance passed with every required boolean true and `pending=[]`; evidence `/tmp/pi-memory-hindsight-acceptance-pi.json`, SHA-256 `0ea2e7c5a4dd627d74881a5c8b7b3c33597d1032f3d4599180cb856937d92acd`.
- Latest real Hindsight 0.8.3 acceptance used one fresh nonce-derived disposable Bank only. Retain, recall, same-document replacement, Bank deletion, known-document absence, and cleanup passed; evidence `/tmp/pi-memory-hindsight-acceptance-hindsight-live.json`, SHA-256 `468baf1b61cded359c1d161d81cb821ba6609d6998b8f301c7a41d6ba4103070`. No Bank enumeration, Reflect, or existing-Bank access occurred.
- Existing non-dedicated Hindsight banks were not listed, read, updated, or deleted.
- Pi configuration: not modified.

## Git status

- Local candidate: release-candidate verification and disposable live acceptance pass.
- Independent final read-only review: PASS; Cursor chat `62022856-6ded-4158-b98f-6dd1a2723f11`, evidence `/tmp/pi-memory-hindsight-verdict-only-cursor.json`.
- Commit: authorized by the user; initial local commit is the next action.
- Push: not authorized / not performed.

## Residual risks to verify during implementation

- Contract behavior must be exercised against a disposable Hindsight 0.8.3 instance, including exact one-unit retain, replacement, timeout reconciliation, and post-delete proof.
- Pi E2E must prove turn-specific system prompt injection does not persist recall content in Session files.
- Current-model JSON reliability and cancellation must be tested across supported providers; invalid output must produce zero candidates.
- `node:sqlite` is valid for Node-run Pi; standalone Pi binary compatibility remains unsupported until probed.
- A Hindsight operator can configure remote embeddings/reranking. The Extension can avoid generative retain, but cannot guarantee all backend processing remains local without deployment inspection.

## Next step

1. Create the user-authorized local initial commit after reviewing the exact staged file set and confirming ignored build/dependency/runtime artifacts remain excluded.
2. Do not push, publish, deploy, or install into the user's live Pi configuration without separate authorization.
3. If code changes after the commit, rerun offline verification, packaged Pi acceptance, disposable live acceptance, and independent review before calling the new state a release candidate.

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
- No executor process remains. Slices 1–4 are accepted at slice level; Slice 5 is offline-verified but blocked on successful real disposable-Hindsight acceptance and independent final review.

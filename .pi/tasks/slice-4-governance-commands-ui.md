# Slice 4 — Governance services, command/tool surface, candidate review, explicit Reflect

## Goal

Complete explicit user-controlled memory operations and governance UI using Pi 0.85.1 public APIs: one `/memory` command, one strict `memory_remember` tool, candidate approval/rejection/edit flows, physical forget, session on/off/language/status/last, and manual-only Reflect. All paths share business services and preserve exact-write/delete safety.

## Baseline

- Slices 1–3 Pi-accepted at slice level; 8 files / 72 tests pass.
- Pre-slice manifest `/tmp/pi-memory-hindsight-slice4-before.sha256`; SHA-256 `d15daa21cacbd53a54bf4c37ba5f73ee9d9e767122ffeb3406e345c3ed0a70cf`.
- New Cursor Chat, model alias `auto`; actual model only if evidenced.

## Allowed

- Add/edit `src/commands/**`, `src/tools/**`, `src/governance/**`, `src/ui/**`, `src/index.ts`, i18n, and governance-required DB repositories/types/migrations/lifecycle.
- Minimal provider/runtime changes only where an already-defined Provider contract must be consumed correctly.
- Add deterministic unit/integration tests under `tests/**`.

## Forbidden

- No live Hindsight/model/external network, real Pi profile/config, global install, commit/push/publish/deploy.
- No Hindsight Control Plane or bank enumeration; no Pi internal `dist/core/*` imports.
- No automatic Reflect; no automatic approval; no bulk Hindsight delete; no backup/restore.
- No full Pi packaged E2E or live Hindsight acceptance (Slice 5).

## Required behavior

### 1. Public registration and strict inputs

- Register exactly one `memory` command and one `memory_remember` tool from the existing extension factory, preserving Slice 3 hooks.
- Tool schema uses TypeBox with `additionalProperties:false`, bounded content, explicit scope and memory type enums. Tool description must say it is only for an explicit user request to remember durable information, never implicit extraction.
- Reject invalid scope/type combinations locally before runtime/provider I/O. Project scope never falls back to Profile.
- Return standard Pi tool results (`content` text and bounded body-free details) with honest error/success wording; do not leak secrets/provider bodies/paths.
- Command parsing is central, deterministic, rejects unknown/ambiguous args, and never treats command text as shell syntax.

### 2. Command surface

Implement localized TUI-safe forms:

- `/memory status`
- `/memory on`, `/memory off` — update only this Session and append versioned body-free custom state via Slice 3 helper; off aborts/clears pending automatic work without affecting other sessions.
- `/memory last` — bounded redacted diagnostics only.
- `/memory language en|zh` — persist Profile language and update in-memory profile; exact allowlist.
- `/memory remember <profile|project> <memory-type> <content>` — explicit, unambiguous governed write.
- `/memory candidates` — open `ctx.ui.custom()` reviewer.
- deterministic recovery/test forms `/memory candidates list`, `/memory candidates approve <id>`, `/memory candidates reject <id>`, `/memory candidates edit-approve <id> <content>`.
- `/memory forget <logical-memory-id>` — one locally owned memory only.
- `/memory reflect <profile|project> <query>` — manual only, bounded and explicit. Warn/confirm that Hindsight Reflect may invoke the deployment's configured generative provider before first externalizing call; cancellation performs zero call. Project must be enabled; no fallback.
- `/memory extract` may trigger the same settled extraction service manually only if safely reusable; otherwise return a localized unsupported/not-enough-material result rather than inventing history.
- Bare `/memory` prints concise localized help.

Commands requiring terminal interaction must check `ctx.mode === "tui"`; unsupported modes return/report safely and perform zero DB/provider/session-entry/UI mutation. Do not use `hasUI` as gate.

### 3. Remember/write governance

Refactor `remember()` into the single path used by command, tool, and candidate approval.

- Apply text/sensitivity/bulk/scope/type/project checks and lifecycle defaults: inference always unverified + 90d; task_state 30d; project_fact 180d re-verification deadline; preference/habit/decision/lesson no expiry; timestamps/metadata consistent with Slice 3 Recall contract; lesson has last verification when verified.
- Metadata logical/document/hash contract remains deterministic and exact. Source refs/session IDs are bounded and validated before Provider.
- Detect exact duplicate before write. Detect obvious same-scope/type conflicts conservatively; never silently replace/supersede an unrelated memory. Conflict/ambiguous scope becomes pending review or a typed rejection, not an automatic permanent write.
- Use SQLite operation ledger/conditional ownership for cross-window concurrency. Do not hold transactions over network. A single logical request has a stable idempotency key/document ID; competing callers do not both perform Provider writes.
- Fix schema/repository shape if needed so create/approve can reserve ownership before network without storing a second body. Use an additive migration (never edit migration 1 semantics for an existing DB without a new version).
- Provider preflight `ensureOwnedBank`, exact retain and exact readback are mandatory. Reconcile only ambiguous/maybe-applied failures under the same document ID; do not treat definite validation/4xx as success and do not blindly reconcile every rejection.
- On unresolved ambiguity leave an honest `reconciling` operation/memory locator state and return unknown/retry, never `written`. On exact success atomically activate locator + commit operation + body-free audit. On definite failure record failed state; no active memory.
- Concurrent duplicate calls converge to one active memory/document and one Provider mutation; loser reports duplicate/in-progress/retry honestly.

### 4. Candidate governance

- Sweep expiry before listing/review. Default list only pending/unexpired; expired view available in custom reviewer.
- Approval revalidates candidate state, expiry, body, scope/type/current Project identity and conflict state, then delegates to the same remember service.
- Atomic claim must not permanently mark candidate approved before a Provider-confirmed write. Add a safe `approving`/retryable state or equivalent additive migration/CAS design. Concurrent windows yield one writer.
- Success marks candidate approved and links/audits body-free. Definite/ambiguous failure leaves a retryable/reconcilable honest state; no false approval. Reject is guarded pending CAS. Edit-and-approve revalidates edited text and never stores unsafe text.
- TUI reviewer via `ctx.ui.custom()` supports localized list/detail, scope/type/action, bounded evidence summary, approve, reject, edit-and-approve, pending/expired filters, and low-value batch rejection. It may be a simple keyboard-driven component but must handle resize/render/input safely and allow cancel. No raw provider bodies or source conversation.
- Deterministic text forms call exactly the same governance functions as TUI actions.

### 5. Physical forget

- Resolve only exact local logical memory ID; require owned bank/document validators and active/reconciling owned locator. Never accept arbitrary bank/document IDs and never enumerate banks.
- Acquire delete operation ownership; call Provider Document DELETE; success only after adapter's document 404 + zero-units postconditions.
- Mark local memory deleted and operation committed atomically after verified success, audit body-free. 404/idempotent result is success only because locator is locally owned and adapter postconditions passed.
- Timeout/ambiguous/failing postcondition returns unknown/failure, preserves retryable reconciliation, and does not report forgotten or mark deleted.

### 6. Manual Reflect

- Separate service invokes only `adapter.reflect`, never Recall or retain. Bounded query/max tokens/budget; selected exact owned bank only.
- Confirm privacy warning before call. Output is untrusted, bounded, localized, never persisted/candidate/promoted, and never inserted as system instruction. Provider failure is redacted and non-blocking.

### 7. UI/i18n/safety

- All visible command/tool/TUI strings have English/Chinese forms through i18n; memory body stays original language.
- Notifications/results are bounded. Audits contain only IDs/outcome/redacted codes; never memory/candidate/query/evidence/Reflect text.
- UI exceptions fail open for Pi but do not convert failed governance operations into success.
- Real secrets, `.env`, full logs/source, and unsafe edits are rejected before DB/provider.

### 8. Tests

Use in-memory/temp SQLite, fake ExtensionAPI/contexts, and fake adapter; no live network/config.

Assert at least:
- exact command/tool registration and strict schema; invalid input zero I/O;
- non-TUI command/tool safety policy and no mutations;
- on/off persistence/restoration and per-session isolation/abort;
- status/last/language/help localization and bounded output;
- command/tool/approval all hit the same remember path and exact metadata/lifecycle;
- Profile/Project scope matrix and no fallback;
- definite failure vs ambiguous reconciliation; operation transitions; concurrent calls one Provider mutation;
- candidate list/expiry/CAS race/reject/edit safety/failed approval retryability; custom reviewer opens through `ui.custom` and exercises actions;
- physical delete success, already-absent verified success, timeout/ambiguous/postcondition failure, unknown ID, arbitrary locator rejection, no soft PATCH/bulk delete;
- Reflect confirmation/cancel/exact endpoint isolation/no persistence/output bounds;
- audit contains no bodies/secrets;
- all prior 72 tests stay green.

## Verify

Run `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `git diff --check`, `npm audit --omit=dev`, and NUL scan. Report files, counts, limitations, Chat ID, actual model only if evidenced.

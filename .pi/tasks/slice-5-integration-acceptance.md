# Slice 5 — Integration harness, packaged Pi black-box acceptance, disposable Hindsight contract

## Goal

Make the package reproducibly acceptance-testable from its packed tarball, then document and automate isolated Pi 0.85.1 black-box checks and an explicitly gated disposable live Hindsight 0.8.3 contract check. Default tests must stay offline/local and never touch a user's Profile or Banks.

## Baseline

- Slices 1–4 Pi-accepted at slice level; 9 files / 98 tests pass.
- Pre-slice source/test manifest `/tmp/pi-memory-hindsight-slice5-before.sha256`; manifest SHA-256 `903b32c29665294143101b0965388744fe04f3fb4611a307f74c298bf9df8cb5`.
- New Cursor Chat, model alias `auto`; actual model only if evidenced.

## Allowed

- Add/edit tests, scripts under `scripts/`, test fixtures/helpers, package scripts/files, README/docs/acceptance/HANDOVER when needed.
- Fix production defects revealed by integration tests, narrowly and with regressions.
- Use subprocesses, pseudo-terminals, random localhost ports, temporary directories, tarball installation, and in-process mock Hindsight.

## Forbidden

- Executor must not call live Hindsight, external model/network, real Pi profile, SSH, git commit/push, npm publish/global install.
- Default `npm test`/build/pack must never require Docker, Pi auth, live Hindsight, network, or interactive input.
- Never enumerate Banks. Never use the existing real Profile/config. Never persist credentials/output bodies.
- Live contract script must refuse to run unless explicit environment gates and an exact dedicated random Bank ID are supplied. It must not derive/list/touch any other Bank.

## Required deliverables

### 1. Mock Hindsight executable fixture

- Standalone local mock server on `127.0.0.1` random port implementing only exact used Hindsight 0.8.3 routes: health/version, owned Bank PUT/config PATCH+GET, retain with item-level replace, list-by-document, recall, Document DELETE/GET.
- Stateful one-memory-per-document behavior, exact metadata/text, deterministic responses, request journal containing methods/paths and redacted body summaries only (no Authorization value/body persistence).
- Modes for latency, 4xx/5xx, malformed responses, config drift, ambiguous retain/delete, and sentinel non-owned bank rejection. Any bank ID outside the dedicated format fails.
- No bank-list route.

### 2. Packaged isolated Pi acceptance runner

- A deterministic script (Node preferred) that:
  1. builds and packs the package;
  2. creates random temp `PI_CODING_AGENT_DIR`, temp project/Git repo, temp HOME/session dir and npm cache/config as needed;
  3. installs the tarball only into that isolated Pi agent directory using Pi's documented package mechanism or loads the packed extension without modifying real settings;
  4. writes only temp `memory-hindsight.json` and temp project `.pi/memory.json`;
  5. starts mock Hindsight;
  6. launches real installed Pi 0.85.1 subprocesses with `--offline`, isolated env, and pseudo-TTY where TUI behavior is required;
  7. proves package discovery/command/tool registration, `/memory status`, language, on/off state entry persistence/resume, candidate list/reject local behavior, explicit remember exact provider request, Recall current-turn injection without a persisted recall message, forget postconditions, provider-offline degradation, and print/json/rpc automatic no-op where observable;
  8. never invokes an external model: use command-only TUI interactions, a safe local fake provider mechanism documented by Pi if public, or a purpose-built extension/test driver loaded through public APIs. Do not fake Pi internals. If full agent-turn Recall cannot be proven without a model, clearly separate it as pending manual/local-provider acceptance rather than silently claiming it;
  9. records redacted machine-readable evidence in `/tmp` (paths/IDs may be hashed), then cleans temp dirs/processes on success/failure.
- TUI runner must have hard timeouts, deterministic exit, ANSI normalization, and retain redacted logs only on failure.
- Script is opt-in (`npm run acceptance:pi`) and checks Pi version 0.85.1. Unit-test its orchestration helpers without requiring TUI.

### 3. Explicitly gated live Hindsight contract runner

- Opt-in script, not run by default. Requires all: `PI_MEMORY_HINDSIGHT_LIVE_ACCEPT=1`, base URL explicitly loopback HTTP(S), exact expected API version 0.8.3, and a caller-supplied Bank ID matching a stricter disposable prefix/nonce owned format. Refuse default/profile/project real IDs not created for this run.
- Must never list Banks. It may only PUT/PATCH/GET the supplied disposable Bank, retain one synthetic non-sensitive memory/document, exact readback/list, Recall source fact, replace same document, physical Document delete + GET 404 + zero units, then DELETE the supplied whole disposable Bank as cleanup through the public API.
- Cleanup runs in `finally`, verifies Bank GET/appropriate endpoint 404 if API supports it, and reports failure if cleanup cannot be proven. If cleanup endpoint response semantics cannot prove absence, state the residual explicitly and stop rather than touch anything else.
- Authorization only from `HINDSIGHT_API_KEY`; never print/log it. Evidence stores no full body; only booleans/counts/hash/route names/timing.
- Reflect is NOT run in live acceptance because it may externalize to the configured generative provider.
- Script is `npm run acceptance:hindsight:live`; add unit tests for every safety refusal and route restriction using a mock server.

### 4. Integration checks and docs

- Add integration tests across real local SQLite + real adapter + mock HTTP (not mocked adapter) for remember→provider exact unit→Recall reconciliation→forget, Profile and Project sharing, provider outage recovery, ambiguous retain reconciliation, config drift write block, sentinel non-owned bank untouched, and no bank enumeration.
- Assert Session custom entries contain no memory body and mock journal has no auth value.
- Update README with prerequisites, install/config, commands/tool, privacy boundaries (chunks vs Reflect), failure behavior, supported modes/platforms, development/test/acceptance instructions, explicit warnings for live script.
- Update acceptance doc with automated/manual coverage matrix and evidence expectations. Do not claim pass before Pi runs it.

### 5. Quality

- No secrets, absolute developer paths, temporary IDs, or generated tarballs committed/included.
- Scripts run on macOS/Linux Node >=22.19, use hard timeouts and signal cleanup.
- Keep production dependencies minimal; test-only PTY dependency allowed only if justified, portable, and audited. Prefer built-in subprocess plus available `script`/PTY abstraction only if robust.
- Preserve all 98 tests.

## Executor verification

Run offline/default: `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `git diff --check`, `npm audit --omit=dev`, NUL scan. Unit-run safety-gate tests. Do NOT run the live script. The executor may run mock packaged acceptance only if it provably invokes no external model/network and uses isolated dirs; otherwise leave it for Pi and state why.

## Pi acceptance after implementation

Pi independently runs all default checks, `acceptance:pi` from the produced tarball, inspects redacted evidence and temp cleanup, then invokes the live runner once with a random disposable owned Bank and cleans it. Failures return to the same Cursor coding chat only if workspace/task baseline remains suitable.

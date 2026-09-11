# Task: Candidate reviewer Unicode terminal-width fix

## Goal

Fix `/memory candidates` so its custom TUI renderer never emits a line wider than the supplied terminal width when Candidate text contains Chinese, emoji, full-width characters, or ANSI styling.

## Risk

- Type: normal task.
- Reason: localized TUI rendering and regression tests only; no governance state, authorization, database, Provider, or command-contract change.
- User explicitly authorized adding `@earendil-works/pi-tui` as a direct package dependency on 2026-09-11 after module-resolution investigation. Escalate and stop if the fix requires any other dependency/version change, a DB migration, Candidate data changes, project-isolation changes, or Pi core modification.

## Baseline

- HEAD: `a87783a580d88b3b4d1be2a8c16ebe7d6d578c91`.
- Branch: `main`, tracking `origin/main`.
- Pre-existing user-owned untracked `.pi/memory.json` must not be read, modified, staged, or output.
- Pi 0.85.1; Node >=22.19.0.
- Design: `docs/decisions/candidate-reviewer-unicode-width.md`.

## Executor and authorization

- Executor: Claude Code.
- Requested model: `claude-sonnet-5`.
- Coding authorization: granted by user on 2026-09-11.
- User additionally authorized the narrow direct `@earendil-works/pi-tui` dependency declaration and lockfile update on 2026-09-11.
- User authorized commit, push to `origin/main`, annotated tag, and GitHub Release publication on 2026-09-11. The next available patch version is `0.2.2`; release preparation may update `package.json`, `package-lock.json`, and the README current-version install example from `v0.2.1` to `v0.2.2`.
- “Deploy” is scoped to Git/GitHub publication because no target machine/path/service was specified; no live machine deployment or live Pi configuration change is authorized. No access/mutation of live Hindsight or live Memory SQLite is authorized.

## Allowed scope

- `src/ui/candidate-reviewer.ts`.
- `package.json` and `package-lock.json`, to add direct `@earendil-works/pi-tui` declarations aligned with Pi baseline `0.85.1` (`peerDependencies: "*"`, exact `devDependencies: "0.85.1"`), refresh the lockfile without unrelated dependency upgrades, and prepare patch version `0.2.2`.
- `README.md`, only to update the current formal-version install example to `v0.2.2`.
- Relevant tests under `tests/**`, preferably the existing Candidate reviewer/governance tests.
- If needed for isolated black-box regression only, a narrowly scoped acceptance script under `scripts/**`.
- This task and its decision document may be clarified, but do not rewrite unrelated docs.

## Required implementation

- Import and use supported `@earendil-works/pi-tui` width utilities (`truncateToWidth`, and `visibleWidth` in tests).
- Replace all Candidate reviewer `String.prototype.slice(0, width)` truncation with ANSI/Unicode-aware terminal-column truncation.
- Safely normalize non-positive render widths so every returned line obeys the component contract.
- Ensure every line from `render(width)` satisfies `visibleWidth(line) <= max(0, width)`.
- Preserve all Candidate project isolation, localized diagnostics, action behavior, item selection, and bounded output.
- Do not weaken content/sensitivity filtering or expose additional Candidate/provider data.

## Tests

Add regression coverage that would fail on the current implementation:

- Chinese/full-width Candidate summary at width 180 (matching crash evidence).
- Long wide-character detail/evidence/project/control lines.
- Narrow width and zero width.
- Prefer at least one ANSI-containing string if the renderer can receive/render one safely.
- Assertions must use `visibleWidth()`, not only JavaScript `.length`.
- Existing reviewer interaction test must continue to pass.

## Verify by coding executor

Run:

1. Focused affected tests.
2. `npm test`.
3. `npm run typecheck`.
4. `npm run build`.
5. `npm pack --dry-run`.
6. `npm audit --omit=dev`.
7. `git diff --check`.
8. NUL scan for `src/` and `tests/`.

Report changed files, exact test results, limitations, Claude session ID, and actual model only if evidenced. Do not commit.

## Pi independent acceptance

After implementation Pi will inspect the full diff and independently rerun focused/full tests, typecheck, build, pack, audit, diff/NUL checks.

Because runtime behavior changes, Pi will package the current workspace and invoke real Pi TUI in a completely isolated temporary Profile/Project with synthetic wide-character Candidate rows. It must execute `/memory candidates` at terminal width 180 (and preferably a narrower boundary), observe the reviewer, close it, and exit cleanly without `Rendered line ... exceeds terminal width`. Only temporary SQLite and loopback mocks may be used; no user live Profile, live Memory DB, live configuration, or live Hindsight.

## Acceptance criteria

- The captured class of width-180 Chinese Candidate rows cannot exceed the supplied render width.
- Real isolated Pi TUI opens and closes `/memory candidates` without uncaughtException.
- Existing Candidate governance/project-isolation behavior is unchanged.
- All required checks pass.
- After final release verification, commit, push `origin/main`, annotated tag `v0.2.2`, and public GitHub Release are authorized. Release assets must include the exact `pi-memory-hindsight-0.2.2.tgz` and `SHA256SUMS`; verify downloaded assets and tag/remote SHA. No npm-registry publication or target-machine deployment.

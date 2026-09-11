# Candidate reviewer Unicode terminal-width fix

Status: released as v0.2.2 (2026-09-11)

## Goal

Prevent `/memory candidates` from crashing Pi when Candidate rows contain Chinese, emoji, full-width characters, or other text whose terminal display width differs from JavaScript string length.

## Confirmed cause

Pi 0.85.1 requires every line returned by a custom TUI component's `render(width)` to have visible terminal width no greater than `width`. `src/ui/candidate-reviewer.ts` currently truncates with `String.prototype.slice(0, width)`, which counts UTF-16 code units rather than terminal columns. The captured Pi crash shows terminal width 180 but Candidate lines with visible widths 207–224.

The existing reviewer test checks `line.length <= width`, so it does not detect wide-character overflow.

## Approved behavior

- Candidate reviewer rendering must use Pi TUI's ANSI/Unicode-aware width utilities rather than string slicing.
- Every line returned by `render(width)` must satisfy `visibleWidth(line) <= max(0, width)` for normal and narrow widths.
- Preserve existing Candidate content bounds, project isolation, diagnostics, controls, and actions.
- Add regression coverage using Chinese/full-width content and ANSI-safe visible-width assertions. Include width 180 matching the observed crash and narrow/zero-width boundaries.
- No database, Hindsight, configuration, command syntax, or governance-state changes.

## Verification

- Focused Candidate reviewer/governance tests.
- Full test suite, typecheck, build, pack dry-run, audit, diff check, and source/test NUL scan.
- Build/package the current candidate and exercise the real Pi TUI `/memory candidates` entry in an isolated temporary Pi profile with synthetic wide-character Candidates and no live Hindsight or user Memory SQLite access. Prove clean exit and absence of the terminal-width crash.

# Candidate project isolation and actionable diagnostics

Status: approved for implementation (2026-09-11)

## Goal

Prevent Project candidates from being displayed or operated on from the wrong project, and show a clear safe reason when a candidate action does not complete.

## Confirmed current behavior

- Candidate review queries are global to one Memory Profile and do not filter Project candidates by the current cwd Project identity.
- The custom reviewer replaces every non-successful approval result with the generic `Candidate action did not complete` message.
- Candidate approval claims the row before `remember`/`replace` resolves the cwd Project. A wrong cwd can therefore move a candidate to `failed` with `project_unavailable`, even though no Hindsight write was attempted.
- Candidate rejection accepts an ID without checking cwd Project identity, so hiding rows in the UI alone would not prevent cross-project mutation.

## Approved behavior

### Visible candidates

- Profile candidates are visible in every TUI cwd using the same Memory Profile.
- Project candidates are visible only when cwd has enabled Project Memory and its normalized identity exactly matches `candidate.project_identity`.
- A cwd with no enabled Project Memory shows Profile candidates only.
- This rule applies to the custom reviewer, text listing, expired view, conflict materialization, and batch rejection.

### Candidate operations

- Approve, edit-and-approve, and reject enforce the same scope check even when invoked directly by candidate ID.
- Profile candidates remain operable from any cwd.
- Project candidates require enabled cwd Project Memory with the exact candidate identity.
- A missing or mismatched Project context is rejected before candidate claim, body edit, conflict mutation, audit mutation, or Hindsight/provider I/O. Candidate state, body, and failure code remain unchanged.
- Approval retains its existing expected-project check as a second fail-closed guard against a configuration change during the operation.

### Diagnostics

- The custom reviewer and deterministic command forms share one localized, safe result renderer.
- They distinguish at least: candidate not found/already decided, project unavailable, project mismatch, rejected validation/stale target, retryable/in-progress or uncertain provider outcome, and success.
- Do not display raw provider response bodies, authorization data, headers, credentials, or unbounded exception text.
- Candidate details show Project identity for Project candidates, state, and a localized allowlisted explanation of the last `failure_code` when present.
- The reviewer states whether it is showing Profile-only candidates or Profile plus the current Project.

## Compatibility

- No database migration is required: candidates already store `project_identity` and `failure_code`.
- Existing `failed/project_unavailable` candidates remain retryable in their matching Project.
- Existing Hindsight documents and banks are not migrated or enumerated.

## Verification

- Unit/integration coverage for Profile-only, matching Project, mismatched Project, disabled Project, expired view, direct ID operations, edit immutability, batch rejection, no side effects/no provider I/O, retry from the correct Project, and localized detailed TUI diagnostics.
- Full tests, typecheck, build, pack dry-run, audit, diff check, and NUL scan.
- Packaged isolated Pi TUI acceptance must exercise the public `/memory candidates` paths without live user configuration or live Hindsight data.

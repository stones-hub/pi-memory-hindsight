# `/memory help` command

Status: approved for implementation.

## Goal

Add a discoverable `/memory help` command that lists every supported `/memory` command and explains its purpose in plain language.

## Confirmed behavior

- `/memory help` displays detailed help grouped by purpose.
- Bare `/memory` displays the same detailed help.
- Unknown commands or invalid arguments display the same help as an error.
- Help follows the persisted Memory UI language (`zh` or `en`) when the local runtime is available; otherwise it falls back to English.
- Help remains available when Hindsight is unavailable and performs no Hindsight or SQLite mutation.
- All currently supported command forms are covered, including status, session controls, remember/update/forget, list/show/last, candidate review, cleanup, language, and reflect.
- The help explains supported Profile and Project memory types, notes that commands are TUI-only, notes confirmation where applicable, and states that there is no manual `/memory extract` command.

## Presentation

Use a readable multi-line, bilingual help view with these groups:

1. Help and status
2. Session controls
3. Formal memory creation, update, and deletion
4. Memory discovery
5. Candidate review
6. Cleanup
7. Language
8. Reflection

Each command receives a concise explanation. Technical placeholders such as `<memory-id>`, `<candidate-id>`, `<scope>`, and `<query>` remain unchanged.

## Scope

Expected implementation areas:

- command parsing and dispatch;
- English and Chinese help text;
- focused command/i18n tests;
- packaged Pi acceptance for the public command entrypoint;
- README and requirements documentation.

No memory governance, storage schema, provider protocol, identity, recall, extraction, cleanup, or deletion behavior may change.

## Verification

- Parser accepts exactly `help` and rejects extra arguments.
- `/memory help` and bare `/memory` render identical detailed help.
- Both languages include every supported command form and a plain-language explanation.
- Unknown/invalid input still renders help with error severity.
- Help can render when Hindsight is unavailable and causes no provider mutation.
- Relevant tests, full test suite, typecheck, build, package dry-run, and isolated packaged Pi acceptance pass.

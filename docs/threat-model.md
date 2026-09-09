# Threat Model

Status: Phase-0 baseline; implementation verification pending.

## Protected assets

- Profile preferences and project-private knowledge.
- Hindsight credentials and other local secrets.
- Isolation between Profile and Project scopes and between projects.
- Integrity of approved memory and candidate governance state.
- Pi's instruction hierarchy and tool safety.

## Trust boundaries

- User and current Pi instructions.
- Repository files and tool output, which may contain prompt injection.
- Current model output, which is untrusted structured input.
- Memory Extension process and local SQLite.
- Hindsight HTTP service and its configured model provider.
- Recalled memory, which is untrusted historical reference data.

## Primary threats

1. Persistent prompt injection saved from repository, web, log, or tool content.
2. Secret or personal data exfiltration into model calls, SQLite, Hindsight, logs, or diagnostics.
3. Cross-project recall due to identity collision or wrong-bank queries.
4. Project-derived information incorrectly promoted into Profile memory.
5. Hallucinated assistant claims stored as verified facts.
6. Stale or contradictory memory overriding current repository evidence.
7. Concurrent windows double-approving or double-retaining candidates.
8. Network timeout producing duplicate writes or false deletion success.
9. Project config weakening global safety policy.
10. Unrelated pre-existing Hindsight banks being read, changed, or deleted.
11. Hindsight's configured generative, embedding, or reranking provider sending data outside localhost.
12. Recall content being persisted into Session history or treated as authoritative instructions.

## Mandatory mitigations

- Dedicated hashed Hindsight namespace; never enumerate banks or expose local paths/project names in bank IDs.
- Fixed project config allowlist: `enabled`, `project` only.
- Local pre-send secret and content filtering.
- Atomic structured candidates with source and verification metadata.
- Provider-neutral strict local validation of model JSON; reject the whole extraction response on any schema/size error.
- Human approval for all automatically extracted candidates.
- Recalled-memory delimiters that explicitly mark it untrusted.
- Scope checks before every query and write.
- Global hard caps of 10 items and ~1,500 injected tokens.
- SQLite transactions, WAL/busy handling, unique constraints, and conditional state transitions.
- Deterministic one-memory document IDs, conditional operation state, and read-after-write reconciliation for uncertain writes.
- Owned banks use non-generative `chunks` retain and disable observations/automatic consolidation.
- Recall uses no persistent Session message and requests no raw chunk expansion.
- Physical document deletion with absence checks; invalidation is never reported as forget.
- Body-free audit after approval/rejection/deletion.
- Non-blocking safe degradation.

## Accepted limitations

- A local extension runs with the same OS permissions as Pi; it is not a sandbox.
- Secret detection is imperfect, so minimization and source restrictions are required in addition to patterns.
- Project identities derived only from the final Git repository name may collide. Users must set distinct `project` values when necessary.
- Hindsight backups, infrastructure snapshots, and external provider logs are outside the extension's deletion control.
- A Hindsight deployment may use remote embedding or reranking even when generative retain is disabled; deployment privacy remains an operator responsibility.
- A local SQLite database and Hindsight service are not encrypted by this Extension; OS permissions and disk encryption are relied upon.

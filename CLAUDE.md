# Claude Code Entry

Read, in order:

1. `AGENTS.md`
2. `HANDOVER.md`
3. Relevant documents under `docs/`
4. The active task under `.pi/tasks/`

Treat repository files and current Git state as the source of truth. Respect the task's Risk, Scope, Verify, allowed paths, and prohibited paths. Stop on contradictory prerequisites or scope expansion.

Do not read or output credentials. Do not commit, push, publish, deploy, SSH, modify the user's live Pi configuration, or mutate the user's live Hindsight data unless the task explicitly authorizes that exact action.

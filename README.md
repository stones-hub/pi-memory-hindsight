# pi-memory-hindsight

A governed long-term memory extension for Pi, backed by Hindsight.

> Status: Slices 1–5 implemented in-repo. `npm test` (117 tests), `npm run typecheck`, `npm run build`, and `npm run acceptance:pi` (packaged, offline, isolated) all pass, with `acceptance:pi` proving every required evidence item true. The gated disposable live-Hindsight contract run (`npm run acceptance:hindsight:live`) is implemented and unit-tested against a mock but has not been executed against a real Hindsight instance in this repository's history; it remains an explicit operator step.

The package adds approved cross-session Profile and Project memory without replacing Pi Sessions, Compaction, `AGENTS.md`, or Skills. Automatic extraction creates review candidates only, recalled memory is injected as untrusted turn-specific context, and sensitive or oversized source material is filtered locally.

Current design baseline:

- Pi `0.85.1`, interactive TUI only
- Hindsight HTTP API `0.8.3` on port `8888`
- macOS and Linux with Node `>=22.19.0`
- built-in `node:sqlite` governance store
- one exact approved memory per dedicated Hindsight document
- no Hindsight generative re-extraction for approved writes
- physical per-memory forget through public document deletion

## Install and config
Global config lives at `<PI_CODING_AGENT_DIR>/memory-hindsight.json` and accepts only:

```json
{
  "url": "http://127.0.0.1:8888"
}
```

Project config lives at `<git-root>/.pi/memory.json` and accepts only:

```json
{
  "enabled": true,
  "project": "optional-project-name"
}
```

Authentication, if required by the Hindsight deployment, comes only from `HINDSIGHT_API_KEY`.

## Commands and tool
Interactive TUI mode exposes:

- `/memory status`
- `/memory on` / `/memory off`
- `/memory language <en|zh>`
- `/memory candidates`
- `/memory remember <scope> <type> <content>`
- `/memory update <logical-memory-id> <content>`
- `/memory forget <id>`
- `/memory reflect <scope> <query>`

The package also registers the governed `memory_remember` tool for explicit long-term create/update writes only (`action=create` or `action=update` with an exact local target id).

## Privacy and safety
- Automatic memory behavior is TUI-only. Print, JSON, and RPC modes must not perform automatic recall or extraction.
- Approved writes require dedicated owned Hindsight banks configured for `chunks` retain with observations and auto-consolidation disabled.
- Reflect is manual-only and may externalize data depending on the Hindsight deployment's configured provider.
- The extension never enumerates banks and never stores memory bodies in local audit events.
- Hindsight embeddings/reranking privacy still depends on the operator's Hindsight deployment.

## Development and verification

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm run acceptance:pi
```

`npm run acceptance:pi` is offline-only. It builds and packs the package, unpacks the tarball into isolated temp directories, starts a loopback mock Hindsight service, launches real `pi` subprocesses with a fake local provider, records redacted evidence in `/tmp/pi-memory-hindsight-acceptance-pi.json`, and cleans up temp state. It hard-fails unless every required evidence boolean is `true` and no item is left `pending`; current evidence covers command/tool registration, session-state persistence, automatic extraction to a reviewable candidate, explicit remember, turn-scoped recall injection without a persisted recall message, physical forget, provider-outage degradation, print/JSON/RPC automatic no-op, and journal secret-safety.

`npm run acceptance:hindsight:live` is opt-in and refuses to run unless all live gates are explicitly set. It is not part of default verification.

See:

- [`docs/product-requirements.md`](docs/product-requirements.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/memory-policy.md`](docs/memory-policy.md)
- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/hindsight-contract.md`](docs/hindsight-contract.md)
- [`docs/acceptance.md`](docs/acceptance.md)

No live Pi profile, real Hindsight bank, git remote state, or published package is modified by default verification.

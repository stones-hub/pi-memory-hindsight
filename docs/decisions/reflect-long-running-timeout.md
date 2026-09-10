# Reflect long-running timeout

Status: approved for implementation (2026-09-10)

## Problem

`/memory reflect` is a manual, read-only synthesis operation that may perform several LLM/tool iterations inside Hindsight. The extension currently routes it through the same 10-second HTTP timeout used by ordinary provider requests. Real Hindsight 0.8.3 logs show successful Reflect work taking 10.76–14.19 seconds, while Pi reports `Error: Reflect failed` after its 10-second client timeout.

## Decision

- Keep the ordinary provider request timeout at 10 seconds, including Recall and governed mutation paths.
- Give Reflect an explicit 180-second request timeout.
- Preserve external cancellation: Pi Esc/session shutdown must still abort Reflect promptly.
- Report a localized, understandable timeout message distinct from generic provider/HTTP failure, without exposing URLs, query bodies, response bodies, credentials, or authorization headers.
- Keep Reflect manual-only and read-only; its output is not automatically stored as memory.
- Do not weaken mutation leases, retry/reconciliation behavior, safety filters, mode gates, or response-size limits.

## Rationale

A global timeout increase would make normal recall and failure handling stall unnecessarily and could invalidate assumptions around governed mutation leases. Reflect is intrinsically long-running and needs a separate policy. A bounded 180-second ceiling supports larger summaries while still preventing indefinite hangs. No finite timeout guarantees completion for unbounded work; cancellation and an explicit timeout error remain required.

## Verification

- A Reflect response delayed beyond 10 seconds but less than 180 seconds succeeds.
- A Reflect operation exceeding 180 seconds returns the localized timeout error.
- External cancellation aborts promptly and does not get mislabeled as timeout.
- Recall and ordinary provider operations retain their 10-second ceiling.
- HTTP/provider errors remain safely redacted and distinguishable from timeout where useful.
- Existing unit/integration, typecheck, build, packaged Pi acceptance, and live Hindsight behavior remain valid.

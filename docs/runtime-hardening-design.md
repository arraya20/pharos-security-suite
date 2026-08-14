# Runtime Hardening Design

Status: accepted on 2026-08-14

## Understanding

- Fix the confirmed cancellation, RPC validation, output validation, cache, and
  partial-result issues without changing the public assessment schema version.
- Keep the specialist modules dependency-free at runtime.
- Ensure deadlines bound actual upstream work, not only the response promise.
- Treat RPC, explorer, and specialist output as untrusted boundary data.
- Preserve useful partial assessments, but never label incomplete security probes
  as complete or cache structurally invalid output.
- Keep existing scoring behavior except where invalid or missing evidence
  previously produced a false-negative or unjustified confidence.

## Assumptions and non-goals

- Existing HTTP request shapes and the assessment 1.0 envelope remain compatible.
- In-memory cache and process-local rate limiting remain in scope; distributed
  coordination is not introduced.
- Cancellation is cooperative. Every bundled upstream operation must honor the
  supplied signal, while arbitrary third-party adapters remain responsible for
  honoring the adapter contract.
- No new runtime dependency is added.

## Design

### Cancellation and deadlines

Each specialist receives one parent signal. RPC attempt timeouts are combined
with that signal, retry backoff is abort-aware, hedged RPC requests share a
per-call controller, and losing requests are cancelled. Explorer, price, and
selector-resolution requests combine their local timeout with the parent signal.
HTTP/coordinator timeout paths abort first and do not cache late output.

### Boundary validation

JSON-RPC responses must be objects with `jsonrpc: "2.0"`, the matching request
ID, and exactly one valid `result` or `error` member. Method-specific consumers
validate required hex quantities/data before using them. Address Intelligence
requests `eth_chainId` and compares it with the configured network before taking
the snapshot.

Specialist output is normalized only after its top-level status, risk, findings,
evidence, confidence, and known incomplete-data signals are checked. Non-finite
numbers are rejected. A specialist-declared failure cannot become `COMPLETE`.
Only validated `COMPLETE` or explicitly marked `PARTIAL` results are cacheable.

### Partial evidence

Transient failures in proxy fallback, beacon implementation, interface probing,
metadata, selector lookup, explorer enrichment, and token scans are retained as
machine-readable incomplete-data reasons. They produce `PARTIAL` confidence while
preserving available evidence. Deterministic contract reverts remain negative
evidence rather than upstream failures.

## Testing strategy

Every defect receives a regression test that fails against the previous behavior:
no retries after abort, hedged losers cancelled, optional fetches observe the
parent signal, wrong chain rejected, malformed JSON-RPC rejected, failed/NaN
specialist output not cached, and transient security probes reported as partial.
Each slice runs its package tests and lint before the next slice begins; the final
gate runs all module tests, root tests, lint, audits, and module-drift checks.

## Decision log

1. Use shared behavioral invariants with small local helpers instead of adding a
   validation/cancellation dependency.
2. Preserve schema version 1.0 and add warnings/details rather than breaking the
   public envelope.
3. Fail closed for structurally invalid core output; degrade to `PARTIAL` only
   when trustworthy core evidence remains.
4. Cancel hedged losers to make concurrency limits reflect actual work.
5. Verify the configured chain in both on-chain specialists.

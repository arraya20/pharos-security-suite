# Pharos Security Suite Architecture

Status: accepted for implementation on 2026-07-31

## Understanding summary

- Pharos Security Suite targets Anvita-hosted execution rather than a privately
  managed VPS.
- The suite keeps three independently deployable specialists: Skill Inspector
  (Python), Contract Inspector (Node.js), and Address Intelligence (Node.js).
- A shared contract and coordinator provide consistent routing, deadlines, and
  result envelopes without requiring all specialists to share one process.
- Contract and address reads use parallel RPC calls pinned to a consistent block,
  bounded caches, provider failover, and explicit deadlines.
- A full assessment invokes only relevant specialists and runs independent work
  concurrently.
- Rewriting the Python module, migrating JavaScript to TypeScript, and adopting
  Bun are outside this implementation scope.
- Anvita-specific agent-to-agent and x402 adapters remain replaceable boundaries
  until the partner runtime contract is documented.

## Assumptions and non-functional requirements

- Treat one Anvita Service Agent as one runtime unless the platform confirms
  mixed-runtime support.
- Target p95 latency below five seconds for a single healthy-upstream assessment
  and below eight seconds for a full assessment, excluding large remote clones.
- Support five concurrent sessions as the initial operating baseline.
- Return partial, evidence-bearing reports when optional enrichment fails.
- Keep every operation read-only. Never request private keys, mnemonics,
  signatures, approvals, or transaction permissions.
- Start with bounded in-memory caching suitable for ephemeral workers and expose
  a cache interface for a future shared backend.
- Avoid new runtime dependencies unless they materially improve correctness.

## Selected approach

Use modular specialists with a coordinator contract:

```text
Pharos Security Coordinator
        |
        +-- Skill Inspector Agent      (Python)
        +-- Contract Inspector Agent   (Node.js)
        +-- Address Intelligence Agent (Node.js)
```

Each specialist can be packaged and published independently. The coordinator
depends on an adapter interface, not a particular process or Anvita invocation
mechanism. Local adapters are development infrastructure; an Anvita adapter will
implement the same interface once its agent-collaboration API is available.

Rejected alternatives:

1. A single Node.js process that shells out to Python depends on undocumented
   mixed-runtime and subprocess support.
2. Privately hosted specialist APIs add infrastructure ownership that conflicts
   with the intended Anvita-hosted model.

## Repository layout

```text
pharos-security-suite/
|-- contracts/
|   |-- assessment-request.schema.json
|   |-- assessment-result.schema.json
|   `-- error.schema.json
|-- coordinator/
|   |-- router
|   |-- result normalizer
|   |-- deadline budget
|   `-- adapter interface
|-- skill-inspector/
|-- contract-inspector/
`-- address-intelligence/
```

## Request routing

The public target types are `SKILL`, `CONTRACT`, `ADDRESS`, and `FULL`.

| Target type | Specialist |
| --- | --- |
| `SKILL` | Skill Inspector |
| `CONTRACT` | Contract Inspector |
| `ADDRESS` | Address Intelligence |
| `FULL` | Relevant specialists, concurrently |

Every specialist implements the logical interface:

```text
assess(request, deadline) -> normalized result
```

The normalized envelope is additive: the original module output remains under
`details` for compatibility and specialist-specific evidence.

## Consistent on-chain reads

An on-chain assessment obtains `eth_blockNumber` first and pins compatible RPC
reads to that block. This prevents bytecode, balance, nonce, storage, and metadata
from silently describing different chain states.

Address Intelligence executes independent core reads concurrently, then runs
applicable explorer enrichment concurrently. Contract Inspector keeps metadata
calls concurrent and propagates the snapshot to proxy and implementation reads.

## Provider strategy

RPC URLs come only from trusted network configuration. User-supplied custom RPC
URLs remain forbidden at hosted HTTP boundaries.

- Send to the primary provider first.
- Start a hedged secondary request only after a latency threshold.
- Fail over on network errors, timeouts, HTTP 429, and HTTP 5xx.
- Fail fast on deterministic JSON-RPC errors and contract reverts.
- Put repeatedly failing providers into a bounded cooldown.
- Bound attempts, total upstream calls, and overall deadline consumption.

## Cache strategy

Cache keys include chain ID, normalized target, data type, and block/reference
mode. Concurrent identical requests share in-flight work.

| Data class | Examples | Initial TTL guidance |
| --- | --- | --- |
| Static | Bytecode, selector signatures, fingerprints | 1 hour to 30 days |
| Semi-static | Proxy implementation, owner, metadata | 15 seconds to 1 hour |
| Dynamic | Balances, nonce, activity, full report | 5 to 30 seconds |

All caches are size-bounded. Dynamic state is never assigned a long TTL merely
because the contract bytecode is stable.

## Deadline and error semantics

The coordinator supplies an absolute deadline. Specialists consume the remaining
budget across core RPC, optional enrichment, and rendering.

Standard statuses:

- `COMPLETE`: required data is available.
- `PARTIAL`: core result exists but optional or secondary signals failed.
- `TIMEOUT`: the deadline expired before core analysis completed.
- `FAILED`: validated input could not be assessed.

Errors use a stable machine-readable envelope. Public responses do not include
stack traces, credentials, raw upstream bodies, or internal network details.

## Threat model and controls

Trust boundaries are HTTP input, skill/archive content, RPC responses, explorer
responses, and future agent-to-agent responses.

- Validate addresses, networks, target types, sizes, and schema at boundaries.
- Allowlist networks and configured upstream hosts.
- Reject path traversal, symlinks, oversized archives, and expansion bombs.
- Use argument arrays without shell interpolation in development subprocess
  adapters.
- Validate third-party response shapes before they affect risk scoring.
- Bound request bodies, concurrency, upstream fan-out, cache size, and deadlines.
- Never accept or log wallet secrets or authorization material.
- Describe every risk result as heuristic pre-flight evidence, not a guarantee.

## Observability

Each assessment records a generated assessment ID, module and schema versions,
duration, cache status, non-sensitive provider label, completion status, and
partial-data reasons. Logs exclude raw sensitive input and credentials.

## Testing and performance acceptance

Implementation follows TDD in vertical slices:

1. Shared schemas and contract tests.
2. Snapshot-pinned concurrent Address Intelligence reads.
3. Provider pool, hedging, failover, and circuit breaker.
4. Layered caches and in-flight deduplication.
5. Contract Inspector snapshot propagation and caching.
6. Coordinator routing, normalization, deadline propagation, and adapters.
7. Packaging, benchmark, load tests, and operational documentation.

Default tests use deterministic local fakes and no external network. External
Pharos smoke tests remain separate.

Acceptance criteria:

- Local fake-upstream specialist p95 is below 500 ms.
- Full coordinator latency follows the slowest specialist rather than their sum.
- Identical concurrent requests do not duplicate upstream work.
- A cache hit performs no upstream RPC.
- Five concurrent sessions respect the configured upstream budget.
- Deadline enforcement finishes before the platform execution cap.
- Timeout, 429, 5xx, invalid upstream data, SSRF attempts, malformed archives,
  oversized input, and partial results have explicit tests.

## Packaging

The intended artifacts are independently deployable:

```text
pharos-skill-inspector.zip
pharos-contract-inspector.zip
pharos-address-intelligence.zip
pharos-security-coordinator.zip
```

The coordinator package does not assume mixed runtime support.

## Open platform questions

- Mixed Node.js and Python runtime support.
- Official agent-to-agent invocation mechanism.
- Persistent or shared cache support.
- Environment-variable and secret-management contract.
- CPU, memory, outbound-network, and execution-time limits.
- Umbrella/coordinator publication format.

## Decision log

1. Keep specialists independent because mixed-runtime support is unknown.
2. Unify contracts and orchestration, not operating-system processes.
3. Preserve specialist-native output under `details` for compatibility.
4. Pin on-chain reads to one block for internal consistency.
5. Use trusted provider configuration with bounded hedging and failover.
6. Separate static, semi-static, and dynamic cache lifetimes.
7. Propagate one absolute deadline instead of stacking unrelated timeouts.
8. Keep Anvita-specific behavior behind an adapter.
9. Defer Bun, TypeScript rewrites, x402, and private infrastructure.

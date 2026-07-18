# 🕵️ Pharos Address Intelligence

> Read-only address profiling for the **Pharos L1** blockchain. Point it at any
> address and get: EOA-vs-contract detection, native (PHRS/PROS) + ERC-20 token
> holdings, sent-tx count, best-effort activity (first/last seen, protocol
> interactions), a behavioral **classification**, and a deterministic **0–100 risk
> score** — straight from on-chain data. No private key, no transactions, no gas.

This skill answers the question the [`pharos-contract-inspector`](https://github.com/arraya20/pharos-contract-inspector)
leaves open: **"who is this address?"** — is it an EOA or a contract, what does
it hold, how does it behave, and should I trust it before sending value to it?

Built for the **Pharos × Anvita Flow "Skill-to-Agent Dual Cascade" Hackathon**
(Phase 2 — Service Agent).

---

## Features

| Capability | Source | Always available? |
| --- | --- | --- |
| EOA vs Contract detection (+ bytecode size) | `eth_getCode` | ✅ RPC |
| Native balance (PHRS on testnet, PROS on mainnet) | `eth_getBalance` | ✅ RPC |
| ERC-20 token holdings | `eth_call balanceOf` | ✅ RPC |
| ERC-20 token discovery | Explorer API | ⚠️ best-effort |
| Sent-transaction count (nonce) | `eth_getTransactionCount` | ✅ RPC |
| Activity: first/last seen, tx count, protocols | Explorer API | ⚠️ best-effort |
| Behavioral classification | Derived | ✅ (partial if activity missing) |
| Risk score 0–100 + level + evidence | Derived | ✅ (conservative if activity missing) |

**Classification labels**

- **EOA:** New · Casual · Active · Whale · Bot · MEV · Dormant
- **Contract:** Token · DEX · Protocol · Unknown (unverified)

**Risk levels:** `LOW` (0–20) · `MODERATE` (21–40) · `ELEVATED` (41–60) · `HIGH` (61–80) · `CRITICAL` (81–100)

> **Confidence:** when the explorer API is unavailable, the report still returns
> all RPC-based signals but flags `confidence: partial`, applies a +15 uncertainty
> penalty, and floors the risk score at MODERATE (25) so an unverified-history
> address is never rated LOW.

> **Explorer API status (Jul 2026):** the Pharos explorer REST API
> (`pharosscan.xyz/api/v2`) is currently unavailable, so the tool runs in
> RPC-only mode. Core signals (address type, native + ERC-20 balances, nonce,
> classification, risk score) all work; activity enrichment (first/last seen,
> protocol interactions) is suspended until the explorer API is back. Token
> holdings are verified against the official
> [Pharos token registry](https://docs.pharos.xyz/getting-started/token-registry).

---

## Limitations

- Contract subtype classification is a shallow heuristic. When explorer metadata
  is available, the tool matches the target contract name against patterns such
  as `token`, `router`, `factory`, `swap`, `dex`, `stake`, `lend`, `vault`, and
  `pool`. Contract names can be spoofed, misleading, or simply not match these
  patterns. This is not bytecode or deep behavioral analysis.
- ERC-20 holdings are always checked against the manually bundled registry in
  `assets/tokens.json`. When the explorer API is available, the tool also uses
  explorer token-balance discovery. If the explorer is unavailable, token
  balances outside the bundled registry are not discovered or reported.
- Risk scores are coarse pre-flight heuristics, not security guarantees. Treat
  them as triage signals and verify independently before sending value.

---

## Why this matters for Pharos

Pharos Pacific Mainnet launched April 2026 and the ecosystem is young — verified
source and rich explorer data are not always available. This skill works on **any**
address with only a public RPC endpoint, and degrades gracefully when the explorer
API is rate-limited (it sits behind a checkpoint, like the contract inspector).

It is a natural safety companion for agents about to call `sendTransaction` or pay
an unknown counterparty over x402: check the destination first.

---

## Prerequisites

- **Node.js ≥ 18** (global `fetch` required)
- **No runtime npm dependencies**

---

## Quick Start (CLI)

```bash
git clone https://github.com/arraya20/pharos-address-intelligence.git
cd pharos-address-intelligence

# Inspect an address on Atlantic testnet (default)
node scripts/inspect.mjs 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network testnet

# Inspect on Pacific mainnet
node scripts/inspect.mjs 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet

# Machine-readable JSON
node scripts/inspect.mjs 0xYourAddress --network mainnet --json

# Pure RPC only (skip explorer enrichment — fastest, partial confidence)
node scripts/inspect.mjs 0xYourAddress --network mainnet --offline
```

> `--offline` means "skip explorer enrichment." Core analysis still reads the
> selected Pharos RPC endpoint, so the machine running the CLI still needs
> network access to the configured RPC URL.

### Example output (CLI)

```
=== PHAROS ADDRESS INTELLIGENCE REPORT ===
Address:       0x000000000022D473030F116dDEE9F6B43aC78BA3
Network:       Pharos Pacific Mainnet (chainId 1672)
...
--- IDENTITY ---
Type:          Contract (9152 bytes)
Classification: Contract - Unknown
  Smart contract; no verified source/name resolved.
--- FINANCIAL ---
Native:        0 PROS
--- RISK ASSESSMENT ---
Risk Score:    50/100 (ELEVATED)
...
```

---

## Quick Start (HTTP API)

```bash
# Start server (127.0.0.1:8800)
npm run serve

# Analyze via HTTP
curl -X POST http://127.0.0.1:8800/analyze \
  -H 'Content-Type: application/json' \
  --data '{"address":"0x000000000022D473030F116dDEE9F6B43aC78BA3","network":"mainnet","offline":true}'

# Health check
curl http://127.0.0.1:8800/health
```

Response is the same structured JSON the CLI prints.

The server is safe-by-default for local use and can be configured for hosted
deployment:

| Env var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind host. Use `0.0.0.0` only behind a platform/proxy. |
| `PORT` | `8800` | HTTP port. |
| `MAX_BODY_BYTES` | `32768` | Reject oversized request bodies. |
| `RATE_LIMIT_MAX` | `60` | Max `/analyze` requests per client per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `REQUEST_TIMEOUT_MS` | `20000` | Request socket timeout. |
| `CACHE_TTL_MS` | `15000` | Short in-memory cache for duplicate analyses. |
| `CORS_ORIGIN` | `*` | CORS origin. Set a specific origin for public deployments. |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For`/`X-Real-IP` for rate limiting only behind a trusted proxy. |
| `PROS_PRICE_USD` | unset | Optional PROS/USD override for price-adjusted mainnet whale/dormant thresholds. |
| `NATIVE_PRICE_USD` | unset | Generic native-token USD fallback if a network-specific env var is not set. |

`render.yaml` is included as a minimal hosted API example; it binds to
`0.0.0.0`, runs `npm test` at build time, and starts with `npm run serve`.

---

## How It Works

```
scripts/lib/analyze.mjs  ──►  collect signals (RPC + best-effort explorer)
     │
scripts/lib/report.mjs   ──►  classify()  +  riskScore()  +  formatText()/JSON
     │
scripts/inspect.mjs / scripts/server.mjs  ──►  CLI  /  HTTP API
```

- Core signals use a minimal `fetch`-based JSON-RPC client (`scripts/lib/rpc.mjs`, reused
  from `pharos-contract-inspector`) with retry + backoff for flaky public RPCs.
- The explorer API is used only for enrichment (first/last seen, protocol names).
  Any failure is caught and reported as `available: false` — never fatal.
- Explorer enrichment starts contract metadata, activity, and token discovery
  calls in parallel to keep hosted requests bounded when the explorer is healthy.
- Mainnet whale/dormant thresholds can auto-adjust from a USD target when a
  native token price is supplied by `PROS_PRICE_USD`, `NATIVE_PRICE_USD`, or a
  configured price feed.
- Risk scoring is **deterministic and evidence-based** (no ML), per
  `references/address-intel.md`.

---

## Project Structure

```
pharos-address-intelligence/
├── scripts/
│   ├── inspect.mjs       # CLI orchestrator
│   ├── server.mjs        # Optional dependency-free HTTP API (port 8800)
│   └── lib/
│       ├── rpc.mjs       # JSON-RPC client (fetch-based, retry/backoff)
│       ├── analyze.mjs   # Signal collection (RPC + best-effort explorer)
│       └── report.mjs    # Classification, risk score, formatting
├── package.json
├── assets/
│   ├── networks.json     # Pharos testnet/mainnet config
│   └── tokens.json       # Known ERC-20 registry per network
├── references/
│   └── address-intel.md  # Detailed operation reference + scoring matrix
└── SKILL.md              # Agent-facing skill entry point
```

## Publish to Anvita Flow

The package follows the Pharos Service Agent publishing flow:

- Folder name: `pharos-address-intelligence`
- Required root file: `SKILL.md`
- Frontmatter `name`: `pharos-address-intelligence` (must match folder name exactly)
- Package command:

```bash
npm run package:skill
```

This creates `dist/pharos-address-intelligence.zip` with
`pharos-address-intelligence/` as the top-level folder inside the zip. The upload
artifact follows the Agent Skills structure: root `SKILL.md`, optional
`scripts/`, `references/`, and `assets/`.
Before submitting, run one debug session in the Anvita Flow console and set
pricing to `Free` during beta to avoid paid-call failures.

## License

MIT-0 (No Attribution Required)

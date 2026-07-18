# Address Intelligence Operation Reference

Detailed reference for analyzing any address on the Pharos blockchain. All
operations are **read-only** — no transactions are sent, no gas is required, no
private key is needed. The executable implementation lives in
`scripts/lib/analyze.mjs` and `scripts/lib/report.mjs`; this document describes the
underlying JSON-RPC calls.

> **Network Configuration**: RPC URLs, chain IDs, and explorer endpoints are read
> from `assets/networks.json`. Defaults to the Atlantic testnet.
>
> **Private Key**: NOT REQUIRED. This skill is 100% read-only.
>
> **Explorer API status**: The Pharos explorer REST API (`pharosscan.xyz/api/v2`)
> is currently unavailable (returns 404). The tool degrades gracefully to
> RPC-only mode — sections marked **best-effort** below will report
> `available: false` and the classification/risk score adjust accordingly (see
> §9). When the explorer API comes back online, enrichment resumes automatically.

---

## 1. Address Type Detection

### Overview

Determine whether an address is an Externally Owned Account (EOA) or a smart
contract. This is the first step of any address analysis — it determines which
follow-up checks are relevant.

### JSON-RPC Method

```
eth_getCode(address, "latest")
```

| Parameter   | Type   | Required | Description                              |
| ----------- | ------ | -------- | ---------------------------------------- |
| `address`   | string | Yes      | The address to check (0x + 40 hex chars) |
| `"latest"`  | tag    | Yes      | Block tag                                |

### Output Parsing

| Result                     | Meaning                                   |
| -------------------------- | ----------------------------------------- |
| `0x` (empty)               | **EOA** — Externally Owned Account        |
| `0x` + hex data (bytecode) | **Contract** — Smart contract deployed    |

Bytecode size = `(hex.length - 2) / 2` bytes.

### Decision Logic

```
if result == "0x":
    address_type = "EOA"
    # → skip contract-specific checks
    # → focus on balance, tx count, activity patterns
else:
    address_type = "Contract"
    # → run additional contract checks (bytecode size, explorer name/verification)
```

> **Implementation**: `analyze.mjs` calls `rpc.getCode(addrLower)` and sets
> `result.addressType` plus `result.bytecodeSize` when code is present.

---

## 2. Balance Check — Native Token

### Overview

Get the native token balance (PHRS on testnet, PROS on mainnet) of any address.

### JSON-RPC Method

```
eth_getBalance(address, "latest")
```

Returns the balance in **wei** as a hex string. Divide by 10^18 for human units
(`formatUnits(hex, 18)` in `analyze.mjs`).

### Classification Thresholds

| Balance Range (native units) | Label           |
| ---------------------------- | --------------- |
| 0                            | Empty wallet    |
| 0 — 1                        | Low balance     |
| 1 — 100                      | Normal          |
| 100 — 10,000                 | High balance    |
| > 10,000                     | Whale candidate |

> **Note**: These thresholds are heuristics. The whale cutoff is
> network-aware — read from `whaleThresholdNative` in `assets/networks.json`
> (testnet: 10,000 PHRS, mainnet: 100,000 PROS ≈ $50k at PROS ≈ $0.50, Jul 2026).
> `report.mjs` looks it up by `chainId`. Revisit the mainnet value as PROS price
> moves; it only affects the `EOA - Whale` label, not the risk score.

---

## 3. Balance Check — ERC-20 Tokens

### Overview

Check an address's holding of any ERC-20 token by calling the `balanceOf`
function via `eth_call`.

### Encoding

`balanceOf(address)` selector is `0x70a08231`. The argument is the address
zero-padded to 32 bytes:

```
data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0")
```

### JSON-RPC Method

```
eth_call({ to: <token_address>, data: <balanceOf_payload> }, "latest")
```

Returns a uint256 hex string. Decode with `formatUnits(hex, decimals)`.

### Known Token Registry

Read from `assets/tokens.json` (sourced from the official Pharos token
registry at `docs.pharos.xyz/getting-started/token-registry`). All addresses are
verified on-chain via `eth_getCode` + `decimals()`.

This registry is intentionally explicit and finite. It is always scanned via RPC
because it works even when the explorer is unavailable. When the explorer API is
available, the implementation also calls the explorer token-balance endpoint for
dynamic ERC-20 discovery. If explorer enrichment is unavailable, ERC-20 balances
outside `assets/tokens.json` are not discovered or reported.

| Network          | Token | Address                                      | Decimals |
| ---------------- | ----- | -------------------------------------------- | -------- |
| Atlantic Testnet | WPHRS | `0x838800b758277CC111B2d48Ab01e5E164f8E9471` | 18       |
| Atlantic Testnet | USDC  | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` | 6        |
| Atlantic Testnet | USDT  | `0xE7E84B8B4f39C507499c40B4ac199B050e2882d5` | 6        |
| Atlantic Testnet | WETH  | `0x7d211F77525ea39A0592794f793cC1036eEaccD5` | 18       |
| Atlantic Testnet | WBTC  | `0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4` | 18       |
| Pacific Mainnet  | WPROS | `0x52c48d4213107b20bc583832b0d951fb9ca8f0b0` | 18       |
| Pacific Mainnet  | USDC  | `0xc879c018db60520f4355c26ed1a6d572cdac1815` | 6        |
| Pacific Mainnet  | WETH  | `0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9` | 18       |
| Pacific Mainnet  | LINK  | `0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29` | 18       |

### Multi-Token Scan

`analyze.mjs` iterates every token in `tokens.json` for the selected network,
calls `ethCallSafe(token.address, encodeBalanceOf(addr))`, and reports each
non-zero holding. `ethCallSafe` tolerates reverts (returns `{ok:false}`) so a
single broken token contract never breaks the whole scan.

When explorer enrichment is enabled, `analyze.mjs` also calls:

```
GET <explorerApiUrl>/addresses/<address>/tokens?type=ERC-20
```

The response is treated as untrusted external data and parsed defensively. Token
discovery is best-effort; failures are recorded in `tokenDiscovery.reason` and do
not fail the report.

---

## 4. Transaction Count (Nonce)

### Overview

Get the sent-transaction count (nonce) for an address. A nonce of 0 means the
address has never sent a transaction (receive-only or freshly created).

### JSON-RPC Method

```
eth_getTransactionCount(address, "latest")
```

Returns a hex string; parse with `parseInt(hex, 16)`.

| Nonce Value | Interpretation                                      |
| ----------- | --------------------------------------------------- |
| 0           | Never sent a transaction (new or receive-only)      |
| 1 — 10      | Minimal activity                                    |
| 10 — 100    | Regular user                                        |
| 100 — 1000  | Active user / power user                            |
| > 1000      | Very active — potential bot or high-frequency trader|

> **Note**: This is the **sent** count only. The explorer API provides the full
> sent+received count when available (§6).

---

## 5. Contract Details (Contract Addresses Only)

### Overview

When the address is a smart contract, retrieve its bytecode size and attempt to
identify its source via the explorer. The implementation resolves metadata for
the target contract itself; recent protocol interactions are kept separate and
must not be used as the target contract identity.

### Bytecode Size

Derived from the `eth_getCode` result in §1: `(hex.length - 2) / 2` bytes.

| Bytecode Size | Likely Type                         |
| ------------- | ----------------------------------- |
| < 500 bytes   | Proxy / minimal contract            |
| 500 — 5000    | Standard contract (ERC20, vault)    |
| > 5000 bytes  | Complex protocol (DEX, lending)     |

### Contract Name & Verification (best-effort — explorer API)

When the explorer API is available, `analyze.mjs` resolves contract names via:

```
GET <explorerApiUrl>/smart-contracts/<contract_address>
→ { name, is_verified, ... }
```

This is currently **unavailable** (see status note at the top). Without it, all
contracts fall back to the `Contract - Unknown` classification and receive a
+20 risk penalty (unverified, no known pattern).

> **Implementation**: target metadata is stored as `contractInfo` on the report.
> `activity.protocols` contains contracts touched by the address and is used for
> interaction diversity only.

---

## 6. Activity Analysis (best-effort — explorer API)

### Overview

Analyze the transaction history of an address to determine activity patterns:
frequency, recency, and interaction diversity.

### Explorer Endpoints

```
GET <explorerApiUrl>/addresses/<address>
  → { transactions_count, ... }

GET <explorerApiUrl>/addresses/<address>/transactions?limit=100
  → { items: [ { timestamp, to: { hash }, ... } ] }
```

### Derived Metrics

```
1. firstSeen = min(timestamps)
2. lastSeen  = max(timestamps)
3. ageDays   = (lastSeen - firstSeen) / 86_400_000
4. frequency = transactions_count / max(ageDays, 1)
5. uniqueContracts = count distinct `to` addresses
```

### Activity Classification

| Frequency (txs/day) | Label                  |
| ------------------- | ---------------------- |
| 0                   | Inactive / dormant     |
| 0 — 1               | Casual user            |
| 1 — 10              | Regular user           |
| 10 — 100            | Power user / bot       |
| > 100               | High-frequency / MEV   |

### Fallback when explorer is unavailable

When the explorer API returns an error, `analyze.mjs` sets
`activity = { available: false, reason }` and `confidence = "partial"`. The
classification falls back to the nonce (§4) for the `txCount` signal; frequency
and age cannot be computed. The risk score is floored at MODERATE (see §9).

Contract metadata, address activity, and token discovery are requested in
parallel when explorer enrichment is enabled. Recent destination contract name
lookups are also resolved in parallel with a cap of eight contracts.

---

## 7. Protocol Interaction Mapping (best-effort — explorer API)

### Overview

Identify which smart contracts / protocols an address has interacted with. This
reveals the address's DeFi footprint.

### Method

From the transaction list in §6, extract distinct `to` addresses (excluding the
address itself). For each (up to 8), resolve its name:

```
GET <explorerApiUrl>/smart-contracts/<contract_address>
  → { name, is_verified }
```

### Classification Categories

| Category       | Indicators                                              |
| -------------- | ------------------------------------------------------- |
| DEX            | Router contracts, swap method signatures                |
| Lending        | Supply/borrow/repay method calls                        |
| Staking        | Stake/unstake/claim methods                             |
| NFT            | `mint`, `transferFrom` on NFT contracts                 |
| Bridge         | Cross-chain message or lock/unlock patterns             |
| Governance     | `vote`, `propose`, `delegate` methods                   |
| MEV            | High-frequency calls to DEX routers, sandwich patterns  |
| Unknown        | Unverified contracts, no matching patterns              |

### Fallback when explorer is unavailable

`protocols` is empty when the explorer API is down. Classification explanations
qualify this (e.g. "protocol diversity unverifiable") rather than claiming the
address has zero protocol interactions.

---

## 8. Address Classification

### Overview

Combine all signals from previous sections into a single classification label.
Computed by `classify()` in `report.mjs`.

### Classification Labels

| Label                 | Criteria                                                      |
| --------------------- | ------------------------------------------------------------- |
| **EOA - New**         | Nonce 0, no transactions, recently created                    |
| **EOA - Casual**      | Low nonce, few protocols, sporadic activity                   |
| **EOA - Active**      | Regular activity, multiple protocols, healthy balance         |
| **EOA - Whale**       | High balance (>= `whaleThresholdNative` per network), moderate+ activity |
| **EOA - Bot**         | Very high frequency (>100 txs/day), repetitive patterns       |
| **EOA - MEV**         | High frequency + DEX router calls + sandwich-like patterns    |
| **EOA - Dormant**     | Was active, no recent activity (>30 days), balance preserved  |
| **Contract - Token**  | ERC20/ERC721 token contract (named in explorer)              |
| **Contract - DEX**    | DEX router/factory (named in explorer)                        |
| **Contract - Protocol** | DeFi protocol (named in explorer)                           |
| **Contract - Unknown**| Unverified, bytecode-only, no known pattern                  |

Contract subtype labels are shallow heuristics. When explorer metadata is
available, the implementation matches the target contract name against simple
string patterns such as `token`, `router`, `factory`, `swap`, `dex`, `stake`,
`lend`, `vault`, and `pool`. Contract names are not trustworthy security
evidence: a malicious contract can choose a benign-looking name, and a legitimate
contract can use a name outside these patterns. The classifier does not perform
bytecode or deep behavior analysis.

> When the explorer is unavailable, EOA labels are derived from nonce + balance
> only, and explanations explicitly note that protocol diversity is
> unverifiable (rather than asserting "multiple protocols").

---

## 9. Risk Score

### Overview

Generate a risk score (0-100) based on all collected signals. Lower = safer,
higher = riskier. Computed by `riskScore()` in `report.mjs`. Deterministic and
evidence-based (no ML).

For networks with USD target thresholds, the whale and dormant-balance cutoffs
can be price-adjusted when `nativePrice.usd` is available. Pacific Mainnet uses
`whaleThresholdUsd` and `dormantBalanceThresholdUsd` from `assets/networks.json`;
the analyzer can populate `nativePrice` from `PROS_PRICE_USD`,
`NATIVE_PRICE_USD`, or a configured `nativePriceUsdUrl`. If no price is
available, scoring falls back to `whaleThresholdNative` and
`dormantBalanceThreshold`.

### Risk Factors

| Factor                        | Score Impact | Condition                                     |
| ----------------------------- | ------------ | --------------------------------------------- |
| Empty balance                 | +15          | 0 native and 0 tokens                         |
| Very new address              | +10          | Age < 7 days                                  |
| No transaction history        | +10          | Nonce 0                                       |
| Unverified contract           | +20          | Contract with no verified source              |
| High-frequency bot pattern    | +10          | >100 txs/day, repetitive methods              |
| Dormant with large balance    | +5           | No activity >30 days + balance > `dormantBalanceThreshold` (testnet 100 PHRS, mainnet 10,000 PROS ≈ $5k) |
| Single-protocol interaction   | +5           | Only interacted with 1 contract               |
| Verified contract             | -10          | Source code visible on explorer               |
| Long history (>90 days)       | -10          | Established address                           |
| Multiple protocol diversity   | -5           | Interacted with 3+ distinct protocols         |
| Active with consistent pattern| -5           | Regular activity over time                    |
| Explorer enrichment unavailable | +15        | Activity data missing (age/diversity/dormancy/bot-pattern unverifiable) |

### Score Ranges

| Range  | Risk Level  | Recommendation                           |
| ------ | ----------- | ---------------------------------------- |
| 0 — 20 | LOW         | Safe to interact                         |
| 21 — 40| MODERATE    | Proceed with normal caution              |
| 41 — 60| ELEVATED    | Verify additional details before sending |
| 61 — 80| HIGH        | Do not send without thorough review      |
| 81 — 100| CRITICAL   | Do not interact — likely malicious/unknown |

### Behavior when explorer is unavailable

When activity enrichment is unavailable, several factors (very new, bot pattern,
dormant, single-protocol, long history, protocol diversity, active consistent)
cannot be evaluated. To avoid giving false confidence:

1. A **+15 uncertainty penalty** is applied (several risk signals are missing).
2. The score is **floored at 25 (MODERATE)** — an unverified-history address is
   never rated LOW / "Safe to interact".
3. The recommendation appends a partial-data caveat: *"(partial data — verify
   history independently before sending value.)"*

This ensures the tool errs toward caution when it cannot see the full picture,
which is the correct behavior for a pre-flight safety check.

> **Agent Guidelines:**
> 1. Run all analysis sections (1-8) before generating the risk score.
> 2. Present the full report in the CLI/HTTP output format.
> 3. ALWAYS include the disclaimer at the bottom.
> 4. If the explorer API is down, the report notes it and proceeds with RPC data.
> 5. Do NOT give binary "safe/unsafe" verdicts — always use the risk score range.

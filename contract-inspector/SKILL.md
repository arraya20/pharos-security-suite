---
name: pharos-contract-inspector
description: >
  ABI-free onchain contract introspection for Pharos L1. Point at any contract address
  and get: proxy detection (EIP-1167/1967/UUPS/OZ), function selector extraction from
  bytecode, interface detection (ERC-165), standard fingerprinting (ERC-20/721/1155),
  privileged function flagging (mint/pause/upgrade/blacklist), value-moving selector
  flagging (approval/permit/transfer), deterministic risk summary,
  optional HTTP API wrapper, and optional 4byte.directory resolution. Works on unverified
  contracts with no source code, no explorer API, and no
  ABI — pure JSON-RPC bytecode analysis. Defaults to Pharos Atlantic Testnet (688689).
  Triggers: "inspect contract", "check contract", "what does this contract do",
  "is this contract safe", "contract audit", "bytecode analysis".
metadata:
  openclaw:
    homepage: https://github.com/arraya20/pharos-contract-inspector
---

# Pharos Contract Inspector

ABI-free onchain contract introspection for Pharos L1. Point it at any address on Pharos and
get a function inventory, proxy resolution, interface detection, and a privileged/danger
function report — straight from bytecode, no verified source or explorer API required.

This skill fills the gap between Pharos Agent Center's primitive RPC calls (readContract,
checkBalance) and the question developers actually ask: **"What can this contract do, and
is it safe?"**

## When to load

- "Inspect contract at 0x..." on Pharos
- "What does this contract do?"
- "Is this contract safe?"
- Before interacting with any unfamiliar contract
- Debugging failed transactions
- Auditing token contracts (proxy detection + mint/pause/upgrade flagging)

## Prerequisites

- **Node.js ≥ 18** (global `fetch` required)
- No runtime npm dependencies

## Installation

```bash
git clone https://github.com/arraya20/pharos-contract-inspector.git
cd pharos-contract-inspector
npm install
```

## Quick Start

```bash
# Inspect Pharos USDC on testnet
node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network testnet

# Inspect Permit2 singleton on mainnet
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet

# JSON output (for programmatic use)
node inspect.js 0xcA11bde05977b3631167028862bE2a173976CA11 --json

# Offline mode (skip 4byte.directory lookups)
node inspect.js 0xcA11bde05977b3631167028862bE2a173976CA11 --offline

# Start optional HTTP API wrapper
npm run serve

# Inspect via HTTP API
curl -X POST http://127.0.0.1:8790/inspect \
  -H 'Content-Type: application/json' \
  --data '{"address":"0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B","network":"testnet","offline":true}'

# Custom RPC over HTTP is disabled by default for SSRF safety.
# Enable only for trusted/local deployments:
ALLOW_CUSTOM_RPC=1 npm run serve

# Custom RPC via CLI
node inspect.js 0x... --rpc https://atlantic.dplabs-internal.com
```

## What It Reports

### 1. Proxy Detection
Checks EIP-1167 minimal proxy (embedded impl in bytecode), EIP-1967 storage slot,
UUPS, OpenZeppelin legacy slot, and `implementation()` getter fallback.
If it's a proxy, the tool inspects both the proxy *and* the implementation contract,
flagging privileged functions in both layers.

### 2. Selector Extraction
Walks the EVM bytecode opcode-by-opcode, looking for the `PUSH4 selector / EQ`
dispatcher pattern. Extracts every function selector the contract compares against.
This works even when no ABI, source code, or explorer verification exists.

### 3. Interface Detection
If the contract implements `supportsInterface(bytes4)` (ERC-165), the tool probes
for ERC-165, ERC-721, ERC-721Metadata, ERC-721Enumerable, ERC-1155, and ERC-1155MetadataURI.

### 4. Standard Fingerprinting
Checks if the extracted selectors match the interface pattern of known standards:
ERC-20, ERC-721, ERC-1155, Ownable, AccessControl, Pausable, UUPS/Upgradeable, ERC-2612.

### 5. Metadata (live eth_call)
Best-effort reads of `name()`, `symbol()`, `decimals()`, `totalSupply()`, `owner()`.
Human-readable format for ERC-20 tokens. Falls back gracefully for non-token contracts.

### 6. Privileged Function Flagging
Functions that grant control, move/destroy value, or change contract state are flagged:
- `mint` — supply inflation
- `pause`, `unpause` — can freeze all transfers
- `upgradeTo`, `upgradeToAndCall` — can swap contract logic entirely
- `transferOwnership`, `changeAdmin` — ownership transfer
- `grantRole`, `revokeRole` — access control changes
- `approve`, `permit`, `transferFrom`, `setApprovalForAll` — value-moving or spend-authorization surfaces when resolved from selector signatures
- `DELEGATECALL` / `SELFDESTRUCT` opcodes — proxy/arbitrary call risk, contract destruction

### 7. 4byte.directory Resolution
Unknown selectors (not in the curated built-in dictionary) are resolved via
[4byte.directory](https://www.4byte.directory), the open function signature registry.
Tolerant to timeouts — degrades gracefully to showing raw selectors.

### 8. Risk Summary

Returns a deterministic pre-flight score and tier (`Low`, `Medium`, `High`) from the same introspection signals: proxy/upgradeability, privileged selectors, value-moving resolved signatures, unresolved selector opacity, owner/admin exposure, `DELEGATECALL`, `SELFDESTRUCT`, and factory opcodes.

This is not a full audit; it is a fast agent safety gate before `readContract` or `sendTransaction`.

### 9. HTTP API Wrapper

For agents that prefer HTTP tools, run:

```bash
npm run serve
```

Then call:

```txt
POST http://127.0.0.1:8790/inspect
```

Body:

```json
{
  "address": "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
  "network": "testnet",
  "offline": true
}
```

## Network Configuration

```json
{
  "testnet": {
    "name": "Pharos Atlantic Testnet",
    "chainId": 688689,
    "rpc": "https://atlantic.dplabs-internal.com",
    "explorer": "https://atlantic.pharosscan.xyz",
    "nativeSymbol": "PHRS"
  },
  "mainnet": {
    "name": "Pharos Pacific Mainnet",
    "chainId": 1672,
    "rpc": "https://rpc.pharos.xyz",
    "explorer": "https://www.pharosscan.xyz",
    "nativeSymbol": "PROS"
  }
}
```

## Example Output (Pharos USDC on Testnet)

```
  ╔══════════════════════════════════════════════════════╗
  ║   PHAROS CONTRACT INSPECTOR — ABI-Free Report       ║
  ╚══════════════════════════════════════════════════════╝

  Address:   0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B
  Network:   Pharos Atlantic Testnet (chainId 688689)
  Bytecode:  1798 bytes

  ────────────────────────────────────────────────────────
  PROXY STATUS
  ────────────────────────────────────────────────────────
  ⚠️  PROXY DETECTED — OZ legacy proxy
  Implementation: 0x02c3fe2d1700814ec27da9e447f7957329c96126

  ────────────────────────────────────────────────────────
  CONTRACT METADATA (live eth_call)
  ────────────────────────────────────────────────────────
  Name:         USDC
  Symbol:       USDC
  Decimals:     6
  Total Supply: 10,368,627,647.763 (10368627647762882)

  ────────────────────────────────────────────────────────
  IMPLEMENTATION CONTRACT ANALYSIS
  ────────────────────────────────────────────────────────
  Privileged functions IN IMPLEMENTATION:
  🚩 0x3f4ba83a  unpause()
  🚩 0x40c10f19  mint(address,uint256)
  🚩 0x8456cb59  pause()
  🚩 0xf2fde38b  transferOwnership(address)
```

## Architecture

```
pharos-contract-inspector/
├── inspect.js          # CLI orchestrator
├── server.js           # Optional dependency-free HTTP API wrapper
├── networks.json       # Pharos testnet/mainnet config
├── package.json
├── lib/
│   ├── rpc.js          # Minimal JSON-RPC client (fetch-based)
│   ├── disasm.js       # EVM bytecode disassembler → selector extraction
│   ├── signatures.js   # Curated selector database + interface fingerprints
│   ├── proxy.js        # Multi-pattern proxy resolver
│   ├── decode.js       # ERC metadata decoder (name/symbol/owner)
│   ├── fourbyte.js     # 4byte.directory resolver (optional, graceful fallback)
│   ├── inspect-core.js # Reusable inspection pipeline
│   └── risk.js         # Deterministic risk summary
└── SKILL.md            # This file
```

## How It Works (Technical)

The core innovation is the **bytecode selector extractor** (`disasm.js`).
Solidity's function dispatcher compiles to roughly:

```
PUSH1 0x80          ← calldata size check
CALLDATASIZE
LT
PUSH2 <fallback>
JUMPI
PUSH4 0x06fdde03    ← selector for name()
DUP1
EQ
PUSH2 <name_label>
JUMPI
PUSH4 0x95d89b41    ← selector for symbol()
DUP1
EQ
...
```

The disassembler walks the opcode stream (correctly skipping over push immediates
so data sections aren't misread as opcodes), collects every `PUSH4` immediate that
is followed by an `EQ` within a short window, and returns them as the contract's
function selector set. This is the same approach used by tools like `whatsabi` and
`evmole`, but implemented from scratch with zero external dependencies beyond Node.js built-ins.

## Why This Matters for Pharos

The Pharos Agent Center baseline provides primitive RPC calls:
- `checkBalance` → reads one balance
- `readContract` → calls one method (requires knowing the ABI)
- `sendTransaction` → sends a tx

This skill sits **above** those primitives: it answers "what can I even call?"
and "should I trust this?" before you start making RPC calls. On Pharos specifically,
where the explorer's API sits behind a Vercel checkpoint and verified source code is
scarce, an ABI-free introspector is particularly useful — you can fully analyze any
contract with only a public RPC endpoint.

## License

MIT-0 (No Attribution Required)

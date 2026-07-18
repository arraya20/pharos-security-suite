# Pharos Contract Inspector

ABI-free onchain contract introspection for the Pharos Agent Center.

Point it at any contract address on Pharos and get a function inventory, proxy resolution, interface detection, and a privileged function report — straight from bytecode, no verified source or explorer API required.

**Built for the [Pharos Agent Center Skill Builder Campaign](https://silken-muskox-24e.notion.site/pharos-agent-center-skill-builder-campaign).**

## Why

The Pharos Agent Center baseline provides primitive RPC calls (`checkBalance`, `readContract`, `sendTransaction`). This skill sits above those primitives: it answers **"what can I even call?"** and **"should I trust this?"** before you start making RPC calls.

On Pharos specifically, where the explorer's API sits behind a Vercel checkpoint and verified source code is scarce, an ABI-free introspector fills a real gap — you can fully analyze any contract with only a public RPC endpoint.

## Quick Start

```bash
git clone https://github.com/arraya20/pharos-contract-inspector.git
cd pharos-contract-inspector
npm install

# Inspect Pharos USDC on testnet
node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network testnet

# Inspect Permit2 on mainnet
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet

# JSON output for programmatic use
node inspect.js 0xcA11bde05977b3631167028862bE2a173976CA11 --json

# Offline mode (skip 4byte.directory lookups)
node inspect.js 0xcA11bde05977b3631167028862bE2a173976CA11 --offline

# Optional HTTP API wrapper
npm run serve

# Inspect via HTTP API
curl -X POST http://127.0.0.1:8790/inspect \
  -H 'Content-Type: application/json' \
  --data '{"address":"0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B","network":"testnet","offline":true}'
```

## What It Reports

| Layer | What |
|-------|------|
| **Proxy Detection** | EIP-1167 minimal, EIP-1967, UUPS, OZ legacy, `implementation()` getter |
| **Selector Extraction** | Walks bytecode opcodes → extracts every function selector in the dispatcher |
| **Interface Detection** | ERC-165 probe: ERC-721, ERC-1155, etc. |
| **Standard Fingerprinting** | ERC-20, ERC-721, ERC-1155, Ownable, AccessControl, Pausable, UUPS; proxy implementations are included |
| **Metadata** | `name()`, `symbol()`, `decimals()`, `totalSupply()`, `owner()` via live eth_call |
| **Privileged Flagging** | `mint`, `pause`, `upgradeTo`, `transferOwnership`, `DELEGATECALL`, `SELFDESTRUCT` |
| **4byte Resolution** | Unknown selectors → [4byte.directory](https://www.4byte.directory) lookup |
| **Risk Summary** | Deterministic Low/Medium/High score from proxy, admin, opcode, privileged, value-moving, and unresolved selector signals |

## HTTP API

The CLI is the primary skill surface. The repo also ships a tiny dependency-free HTTP wrapper for agents that prefer API calls.

```bash
npm run serve
```

Health:

```txt
GET http://127.0.0.1:8790/health
```

Inspect:

```txt
POST http://127.0.0.1:8790/inspect
Content-Type: application/json

{
  "address": "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
  "network": "testnet",
  "offline": true
}
```

Verified local API result against Pharos USDC testnet:

```json
{
  "ok": true,
  "level": "High",
  "score": 81,
  "proxy": "OZ legacy proxy",
  "name": "USDC"
}
```

Security note: the HTTP API rejects request-body custom RPC URLs by default to avoid SSRF when exposed outside localhost. For trusted local deployments only, enable them with:

```bash
ALLOW_CUSTOM_RPC=1 npm run serve
```

## Example Output

```
  ╔══════════════════════════════════════════════════════╗
  ║   PHAROS CONTRACT INSPECTOR — ABI-Free Report       ║
  ╚══════════════════════════════════════════════════════╝

  Address:   0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B
  Network:   Pharos Atlantic Testnet (chainId 688689)
  Bytecode:  1798 bytes

  RISK SUMMARY (pre-flight, not a full audit)
  Score:    81/100
  Level:    High
  Headline: High risk: review admin powers, upgradeability, and privileged selectors before interaction.

  PROXY STATUS
  ⚠️  PROXY DETECTED — OZ legacy proxy
  Implementation: 0x02c3fe2d1700814ec27da9e447f7957329c96126

  CONTRACT METADATA (live eth_call)
  Name:         USDC
  Symbol:       USDC
  Decimals:     6
  Total Supply: 10,368,627,647.763

  FUNCTION SELECTOR INVENTORY
  Extracted from bytecode:  5 selectors
  Matched to known sigs:    5

  IMPLEMENTATION CONTRACT ANALYSIS (23464 bytes, 55 selectors)
  Privileged functions IN IMPLEMENTATION:
  🚩 mint(address,uint256)
  🚩 pause()
  🚩 unpause()
  🚩 transferOwnership(address)
```

## How It Works

The core bytecode selector extractor walks the EVM opcode stream, looking for the `PUSH4 selector / EQ` dispatcher pattern that Solidity compiles every public function into. It correctly skips over push immediates so data sections aren't misread as opcodes. This is the same approach used by tools like `whatsabi` and `evmole`, implemented from scratch.

## Network Configuration

| | Atlantic Testnet | Pacific Mainnet |
|---|---|---|
| Chain ID | 688689 | 1672 |
| RPC | `https://atlantic.dplabs-internal.com` | `https://rpc.pharos.xyz` |
| Explorer | `https://atlantic.pharosscan.xyz` | `https://www.pharosscan.xyz` |
| Native Token | PHRS | PROS |

## Supported Frameworks

| Framework | Skill Path |
|-----------|-----------|
| OpenClaw | `~/.openclaw/skills/` |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |

## Testing

Pure-Node unit tests, no test framework, no network calls:

```bash
npm test
# risk tests passed
# core tests passed
# format tests passed
# disasm tests passed
# proxy + decode tests passed
# rpc tests passed
```

Coverage targets: bytecode disassembler (selector extraction, opcode flags,
data-section safety), proxy resolution (EIP-1167 / 1967 / OZ legacy / getter),
metadata decoder (ABI string / uint / address, transient-vs-revert tracking,
ERC-165 probe), RPC retry classification (transient vs permanent, backoff,
exhaustion), risk scoring (proxy, privileged, value-moving, unresolved, owner,
incomplete-metadata, opcodes), chain-id guard, and BigInt unit formatting.

```bash
npm run lint    # node --check on every .js file
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
│   ├── decode.js       # ERC metadata decoder
│   ├── fourbyte.js     # 4byte.directory resolver (optional)
│   ├── inspect-core.js # Reusable inspection pipeline
│   └── risk.js         # Deterministic risk summary
└── SKILL.md            # Agent skill definition
```

## Dependencies

- Node.js ≥ 18
- No runtime npm dependencies. Uses native `fetch`, `AbortController`, and small built-in ABI decoders.

## License

MIT-0

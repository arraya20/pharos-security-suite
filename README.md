# Pharos Security Suite

**Modular security toolkit for the Pharos Network ecosystem.**

Four independent modules that cover the full security surface for AI agents, smart contracts, and on-chain addresses on Pharos Pacific Mainnet.

```
pharos-security-suite/
├── skill-inspector/        → Scan AI agent skills for prompt injection & Web3 risks
├── contract-inspector/     → ABI-free bytecode introspection & risk scoring
├── address-intelligence/   → Address profiling, classification & risk scoring
└── trust-layer/            → Cryptographic attestation for audit results (planned)
```

---

## Modules

### 1. Skill Inspector `v1.0` — Python

> Detect prompt injection, data leakage, vulnerable dependencies, dangerous code, and on-chain risks in Pharos AI agent skills *before* you install or publish them.

- Zero runtime dependencies — runs on clean Python 3.10+
- Scans SKILL.md, scripts, configs, and Solidity contracts
- Multi-line taint tracking: private-key source → network/file/shell sink
- Live CVE lookups via OSV.dev with offline fallback
- Output: terminal, JSON, Markdown, SARIF

```bash
cd skill-inspector && pip install -e .
pharos-skill-inspector scan ./some-skill/
pharos-skill-inspector scan https://github.com/owner/some-skill
```

**[Full docs →](skill-inspector/README.md)**

---

### 2. Contract Inspector `v1.1` — Node.js

> Point it at any contract on Pharos and get function inventory, proxy resolution, interface detection, and risk scoring — straight from bytecode, no verified source required.

- ABI-free: works on any deployed contract, even unverified
- Proxy detection: EIP-1167, EIP-1967, UUPS, OZ legacy
- Standard fingerprinting: ERC-20/721/1155, Ownable, AccessControl, Pausable
- Privileged function flagging: mint, pause, upgradeTo, DELEGATECALL, SELFDESTRUCT
- Deterministic risk scoring (Low/Medium/High)
- CLI + HTTP API for agent integration

```bash
cd contract-inspector && npm install
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet
```

**[Full docs →](contract-inspector/README.md)**

---

### 3. Address Intelligence `v1.0` — Node.js

> Point it at any address on Pharos and get: EOA vs contract detection, native + ERC-20 holdings, behavioral classification, and a deterministic 0–100 risk score — straight from on-chain data. No private key, no gas.

- RPC-only mode works even when explorer API is down
- Classification: New/Casual/Active/Whale/Bot/MEV/Dormant (EOA) or Token/DEX/Protocol (contract)
- Risk levels: LOW → MODERATE → ELEVATED → HIGH → CRITICAL
- Graceful degradation: partial confidence + uncertainty penalty when explorer unavailable
- Token holdings verified against official Pharos token registry

```bash
cd address-intelligence && npm install
node scripts/profile.js 0x126cC4E8f6c24fdBe65e07AA8CaDB6dB1ec655e2 --network mainnet
```

**[Full docs →](address-intelligence/README.md)**

---

### 4. Agent Trust Layer `planned`

> Cryptographic attestation engine that seals audit results from modules 1-3 with verifiable signatures, enabling agent-to-agent trust without centralized authorities.

Planned features:
- Signed audit attestations (SHA-256 hash + Ed25519 signature)
- On-chain attestation registry on Pharos
- Cross-module composition (skill scan + contract scan → unified trust score)
- Verification SDK for consuming agents

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Pharos Mainnet RPC                  │
└──────────┬──────────────────────┬────────────────────┘
           │                      │
    ┌──────▼──────┐       ┌──────▼──────┐
    │  Contract   │       │   Address   │
    │  Inspector  │       │ Intelligence│
    │  (bytecode) │       │  (history)  │
    └──────┬──────┘       └──────┬──────┘
           │                      │
           └──────────┬───────────┘
                      │
              ┌───────▼───────┐
              │  Trust Layer  │
              │ (attestation) │
              └───────┬───────┘
                      │
    ┌─────────────────▼─────────────────┐
    │         Skill Inspector           │
    │    (agent skill pre-screening)    │
    └───────────────────────────────────┘

    ↓ All modules feed into unified security reports
    ↓ Attestations are signed & optionally posted on-chain
```

## Quick Start

```bash
git clone https://github.com/arraya20/pharos-security-suite.git
cd pharos-security-suite

# Module 1: Skill Inspector
cd skill-inspector && python3 -m venv .venv && source .venv/bin/activate
pip install -e . && pharos-skill-inspector scan ./examples/

# Module 2: Contract Inspector
cd ../contract-inspector && npm install
node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network mainnet

# Module 3: Address Intelligence
cd ../address-intelligence && npm install
node scripts/profile.js 0x126cC4E8f6c24fdBe65e07AA8CaDB6dB1ec655e2 --network mainnet
```

## Design Principles

- **Modular** — each tool is independent, use one or compose all four
- **Zero/minimal dependencies** — reduce supply-chain attack surface
- **Mainnet-first** — built for Pharos Pacific Mainnet, not just testnet demos
- **Deterministic** — no LLM hallucinations, pattern-matching with fixed rules
- **Agent-native** — designed as composable skills for autonomous AI agents

## Pharos Ecosystem

Built for [Pharos Network](https://pharos.xyz) — an EVM-compatible L1 with native AI agent infrastructure via [Anvita Flow](https://docs.pharos.xyz).

| Resource | Link |
|----------|------|
| Pharos Pacific Mainnet | Chain ID `688688` |
| Pharos Docs | [docs.pharos.xyz](https://docs.pharos.xyz) |
| Pharos Explorer | [pharosscan.xyz](https://pharosscan.xyz) |
| Pharos Agent Kit | [GitHub](https://github.com/aspect-build/pharos-agent-kit) |

## Author

**Namri** ([@DudutGante13465](https://x.com/DudutGante13465))
- Pharos Skill Builder Campaign winner
- Active Pharos mainnet contributor

## License

MIT — see individual module licenses.

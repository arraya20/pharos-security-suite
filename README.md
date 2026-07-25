# Pharos Security Suite

[![CI](https://github.com/arraya20/pharos-security-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/arraya20/pharos-security-suite/actions/workflows/ci.yml)

**Modular security toolkit for the Pharos Network ecosystem.**

Three production modules cover AI-agent skills, smart contracts, and on-chain
addresses on Pharos Pacific Mainnet. A cryptographic trust layer remains on the
roadmap.

```
pharos-security-suite/
├── skill-inspector/        → Scan AI agent skills for prompt injection & Web3 risks
├── contract-inspector/     → ABI-free bytecode introspection & risk scoring
├── address-intelligence/   → Address profiling, classification & risk scoring
└── trust-layer/            → Cryptographic attestation for audit results (planned)
```

---

## Modules

### 1. Skill Inspector `v0.1.0` — Python

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

### 2. Contract Inspector `v1.1.0` — Node.js

> Point it at any contract on Pharos and get function inventory, proxy resolution, interface detection, and risk scoring — straight from bytecode, no verified source required.

- ABI-free: works on any deployed contract, even unverified
- Proxy detection: EIP-1167, EIP-1967 implementation/beacon, confirmed UUPS, OZ legacy
- Standard fingerprinting: ERC-20/721/1155, Ownable, AccessControl, Pausable
- Privileged function flagging: mint, pause, upgradeTo, DELEGATECALL, SELFDESTRUCT
- Deterministic risk scoring (Low/Medium/High)
- CLI + HTTP API for agent integration

```bash
cd contract-inspector && npm ci
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet
```

**[Full docs →](contract-inspector/README.md)**

---

### 3. Address Intelligence `v0.1.0` — Node.js

> Point it at any address on Pharos and get: EOA vs contract detection, native + ERC-20 holdings, behavioral classification, and a deterministic 0–100 risk score — straight from on-chain data. No private key, no gas.

- RPC-only mode works even when explorer API is down
- Classification: New/Casual/Active/Whale/Bot/MEV/Dormant (EOA) or Token/DEX/Protocol (contract)
- Risk levels: LOW → MODERATE → ELEVATED → HIGH → CRITICAL
- SocialScan enrichment with explicit partial confidence when history is sampled or unavailable
- Token holdings verified against official Pharos token registry

```bash
cd address-intelligence && npm ci
node scripts/inspect.mjs 0x126cC4E8f6c24fdBe65e07AA8CaDB6dB1ec655e2 --network mainnet
```

**[Full docs →](address-intelligence/README.md)**

---

### Roadmap: Agent Trust Layer

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
           ┌──────────▼───────────┐
           │ Future Trust Layer   │
           │ (not yet available)  │
           └──────────────────────┘

    Skill Inspector currently runs independently as an agent pre-screen.
```

## Quick Start

```bash
git clone https://github.com/arraya20/pharos-security-suite.git
cd pharos-security-suite

# Module 1: Skill Inspector (Python 3.10+)
cd skill-inspector && python3 -m venv .venv && source .venv/bin/activate
pip install -e .
pharos-skill-inspector scan examples/benign-skill --no-network
pharos-skill-inspector scan examples/malicious-skill --no-network

# Module 2: Contract Inspector (Node.js 22+)
cd ../contract-inspector && npm ci
node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network mainnet

# Module 3: Address Intelligence (Node.js 22+)
cd ../address-intelligence && npm ci
node scripts/inspect.mjs 0x126cC4E8f6c24fdBe65e07AA8CaDB6dB1ec655e2 --network mainnet
```

For SocialScan enrichment, configure `SOCIALSCAN_API_KEY`. Without it, Address
Intelligence still returns RPC-based signals with explicit partial confidence.

## Module provenance and updates

The three module directories are Git subtrees pinned in
[`modules.lock.json`](modules.lock.json). Verify that their contents match the
recorded upstream commits:

```bash
npm ci
npm test
npm run check:modules
```

To update one module, start from a clean worktree:

```bash
npm run sync:module -- skill-inspector
npm run sync:module -- contract-inspector
npm run sync:module -- address-intelligence
```

The sync command performs a reviewed subtree pull and updates the corresponding
lock SHA. Run the full root CI commands before committing the update. See
[`docs/module-sync-design.md`](docs/module-sync-design.md) for the decision log.

## Design Principles

- **Modular** — each production tool is independently runnable
- **Reproducible** — upstream commits are pinned and checked for content drift
- **Zero/minimal dependencies** — reduce supply-chain attack surface
- **Mainnet-first** — built for Pharos Pacific Mainnet, not just testnet demos
- **Deterministic** — no LLM hallucinations, pattern-matching with fixed rules
- **Agent-native** — designed as composable skills for autonomous AI agents

## Pharos Ecosystem

Built for [Pharos Network](https://pharos.xyz) — an EVM-compatible L1 with native AI agent infrastructure via [Anvita Flow](https://docs.pharos.xyz).

| Resource | Link |
|----------|------|
| Pharos Pacific Mainnet | Chain ID `1672` |
| Pharos Docs | [docs.pharos.xyz](https://docs.pharos.xyz) |
| Pharos Explorer | [pharosscan.xyz](https://pharosscan.xyz) |
| Pharos Agent Kit | [GitHub](https://github.com/aspect-build/pharos-agent-kit) |

## Author

**Namri** ([@namri_20](https://x.com/namri_20))
- Pharos Skill Builder Campaign winner
- Active Pharos mainnet contributor

## License

MIT-0 (No Attribution Required). The root distribution and all three pinned
modules use MIT-0; see each module's `LICENSE` file.

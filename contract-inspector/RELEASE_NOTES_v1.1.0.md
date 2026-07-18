# Release v1.1.0 — RPC retry layer + metadata-incomplete uncertainty surfacing

ABI-free EVM contract introspection for the Pharos Agent Center. Point it at any
address on Pharos and get a function inventory, proxy resolution, interface
detection, standard fingerprinting, privileged/value-moving flagging, and a
deterministic risk summary — straight from bytecode, no verified source, no
explorer API, no ABI.

## What's new in 1.1.0

This release makes the risk score **deterministic** on flaky public RPCs.

- **RPC retry layer.** Transient failures (timeout, HTTP 429/5xx, network error)
  are retried with exponential backoff + jitter; permanent failures (genuine
  reverts, HTTP 4xx) fail fast. Public Pharos RPCs drop ~1 in 5 calls under load
  during testing, which previously made a contract's risk score swing between
  runs depending on which metadata field happened to drop.
- **Transient vs revert distinction.** `readMetadata` now records only
  *transient* read failures in an `errors` array. A genuine revert (the contract
  doesn't implement `owner()`) is information, not uncertainty, so it stays out.
- **Metadata-incomplete flag.** When admin-relevant metadata can't be read, the
  risk summary surfaces the uncertainty instead of silently under-reporting. The
  ERC-20 simplicity bonus is withheld when `owner()` is unknown.
- **New tests.** `test-rpc.js` covers retry classification (transient vs
  permanent, backoff, exhaustion) with a mocked `fetch`.

### Verified

- USDC testnet: stable **81/81** across 5 consecutive runs (was non-deterministic 69–83).
- Permit2 mainnet: **40**, no false-positive incomplete flag.
- Full suite green: `risk`, `core`, `format`, `disasm`, `proxy + decode`, `rpc`.

## Since 1.0.0 (full feature set)

Proxy detection (EIP-1167 / 1967 / OZ legacy / getter), bytecode selector
extraction, ERC-165 interface probing, standard fingerprinting
(ERC-20/721/1155/Ownable/AccessControl/Pausable/UUPS/2612), privileged +
value-moving flagging, deterministic risk scoring with evidence, optional
4byte.directory resolution, chain-id guard, and a dependency-free HTTP API with
SSRF guard. Zero runtime dependencies.

## Install

```bash
git clone https://github.com/arraya20/pharos-contract-inspector.git
cd pharos-contract-inspector
node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network testnet
```

Full changelog: [CHANGELOG.md](./CHANGELOG.md)

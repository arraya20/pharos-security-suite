# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-05-31

### Added
- RPC client now retries transient failures (timeout, HTTP 429/5xx, network
  errors) with exponential backoff + jitter, while failing fast on permanent
  errors (genuine reverts, HTTP 4xx). Public Pharos RPCs intermittently drop
  individual calls under load (~1 in 5 during testing); without retry a dropped
  `owner()` call silently swung a contract's risk score. Configurable via
  `new Rpc(url, { retries, retryBaseMs, timeoutMs })`.
- `readMetadata` now returns an `errors` array listing fields whose call failed
  *transiently* (after retries exhausted). Genuine reverts are excluded — a
  contract that doesn't implement `owner()` is "no owner", not "owner unknown".
- Risk summary surfaces a "Metadata read incomplete" flag when admin-relevant
  metadata could not be read, so the score can't silently under-report admin
  exposure. The ERC-20 simplicity bonus is withheld when `owner()` is unknown.
- CLI prints a metadata-incomplete warning line when reads fail transiently.
- `test-rpc.js`: retry classification tests (transient vs permanent, backoff,
  exhaustion) with a mocked `fetch`.

### Fixed
- Non-deterministic risk score on contracts read over a flaky RPC. Scores are
  now stable across repeated runs (verified: USDC testnet 81/81 across 5 runs;
  Permit2 mainnet 40 with no false-positive incomplete flag).

## [1.0.0] - 2026-06-01

Initial release for the Pharos Agent Center Skill Builder Campaign.

### Added
- ABI-free EVM contract introspection pipeline (`lib/inspect-core.js`).
- Bytecode selector extractor with `PUSH4`/`EQ` dispatcher heuristic and
  Vyper-style fallback (`lib/disasm.js`); correctly skips PUSH immediates so
  data sections are never misread as opcodes.
- Multi-pattern proxy resolver: EIP-1167 minimal, EIP-1967, OZ legacy slot,
  and `implementation()` getter fallback (`lib/proxy.js`).
- Standard fingerprinting: ERC-20, ERC-721, ERC-1155, Ownable, AccessControl,
  Pausable, UUPS/Upgradeable, ERC-2612 Permit (`lib/signatures.js`).
- ERC-165 interface probing for ERC-721/1155 family (`lib/decode.js`).
- Live `name()` / `symbol()` / `decimals()` / `totalSupply()` / `owner()`
  metadata reads with revert-tolerant `eth_callSafe`.
- Privileged selector flagging (mint, pause, upgrade, ownership, role,
  changeAdmin), DELEGATECALL / SELFDESTRUCT / CREATE / CREATE2 opcode flags,
  and value-moving signature flagging (approve, permit, transferFrom,
  setApprovalForAll, multicall, lockdown).
- Deterministic risk summary with score, level, evidence-attached flags, and
  remediation recommendations (`lib/risk.js`).
- Optional 4byte.directory resolver for unknown selectors with cache,
  timeout, and graceful network-failure fallback (`lib/fourbyte.js`).
- BigInt-precise `formatUnits` for token totals (`lib/format.js`).
- CLI runner with `--network`, `--rpc`, `--json`, `--offline` flags
  (`inspect.js`).
- Optional dependency-free HTTP API wrapper (`server.js`) with SSRF guard
  (custom RPC URLs disabled by default; opt in via `ALLOW_CUSTOM_RPC=1`).
- Unit tests for risk scoring, inspect-core helpers, BigInt formatting,
  bytecode disassembler, proxy resolution, and metadata decoding.

### Security
- RPC `chainId` mismatch guard prevents accidental cross-network reads when a
  custom RPC is supplied.
- HTTP API rejects custom RPC URLs by default.
- HTTP API caps request body at 64 KiB.

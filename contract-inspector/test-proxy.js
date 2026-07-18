#!/usr/bin/env node
// Tests for proxy resolution + metadata decoding using a mock RPC.
// No network: we feed canned eth_getStorageAt / eth_call responses and assert
// the resolver picks the right proxy pattern and the decoders parse ABI correctly.

import assert from "node:assert/strict";
import { resolveProxy, SLOT_1967_IMPL, SLOT_1967_ADMIN } from "./lib/proxy.js";
import { readMetadata, probeInterfaces } from "./lib/decode.js";

// Mock RPC: storage is a {slot: word} map, calls is a {selectorPrefix: {ok,data}} map.
class MockRpc {
  constructor({ storage = {}, calls = {} } = {}) {
    this.storage = storage;
    this.calls = calls;
  }
  async getStorageAt(_addr, slot) {
    return this.storage[slot.toLowerCase()] ?? "0x" + "0".repeat(64);
  }
  async getCode() {
    return "0x";
  }
  async ethCallSafe(_to, data) {
    const sel = data.slice(0, 10).toLowerCase();
    return this.calls[sel] ?? { ok: false, data: null };
  }
}

const padAddr = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const ZERO = "0x" + "0".repeat(64);

// ── 1. EIP-1167 minimal proxy: impl is embedded in bytecode ───────────────────
{
  const impl = "0x1234567890abcdef1234567890abcdef12345678";
  const code = "0x363d3d373d3d3d363d73" + impl.slice(2) + "5af43d82803e903d91602b57fd5bf3";
  const rpc = new MockRpc();
  const r = await resolveProxy(rpc, "0xproxy", code);
  assert.equal(r.isProxy, true);
  assert.equal(r.type, "EIP-1167 minimal proxy");
  assert.equal(r.impl.toLowerCase(), impl.toLowerCase());
}

// ── 2. EIP-1967 storage slot, with admin ──────────────────────────────────────
{
  const impl = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const admin = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const rpc = new MockRpc({
    storage: {
      [SLOT_1967_IMPL.toLowerCase()]: padAddr(impl),
      [SLOT_1967_ADMIN.toLowerCase()]: padAddr(admin),
    },
  });
  const r = await resolveProxy(rpc, "0xproxy", "0x6080");
  assert.equal(r.isProxy, true);
  assert.equal(r.type, "EIP-1967 proxy");
  assert.equal(r.impl.toLowerCase(), impl.toLowerCase());
  assert.equal(r.admin.toLowerCase(), admin.toLowerCase());
}

// ── 3. implementation() getter fallback ───────────────────────────────────────
{
  const impl = "0xcccccccccccccccccccccccccccccccccccccccc";
  const rpc = new MockRpc({
    calls: { "0x5c60da1b": { ok: true, data: padAddr(impl) } },
  });
  const r = await resolveProxy(rpc, "0xproxy", "0x6080");
  assert.equal(r.isProxy, true);
  assert.equal(r.type, "getter-based proxy (implementation())");
  assert.equal(r.impl.toLowerCase(), impl.toLowerCase());
}

// ── 4. not a proxy: all slots zero, no getter ─────────────────────────────────
{
  const rpc = new MockRpc({ storage: {}, calls: {} });
  const r = await resolveProxy(rpc, "0xplain", "0x6080");
  assert.equal(r.isProxy, false);
  assert.equal(r.impl, null);
}

// ── 5. zero-address in slot must NOT count as a proxy ──────────────────────────
{
  const rpc = new MockRpc({ storage: { [SLOT_1967_IMPL.toLowerCase()]: ZERO } });
  const r = await resolveProxy(rpc, "0xplain", "0x6080");
  assert.equal(r.isProxy, false);
}

// ── 6. metadata decode: ABI-encoded string, uint, address ─────────────────────
{
  // name() -> "USDC" as ABI string: offset(0x20) + len(4) + "USDC" padded
  const abiString = (s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    const len = (s.length).toString(16).padStart(64, "0");
    const data = hex.padEnd(64, "0");
    return "0x" + "20".padStart(64, "0") + len + data;
  };
  const u256 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
  const owner = "0xdddddddddddddddddddddddddddddddddddddddd";

  const rpc = new MockRpc({
    calls: {
      "0x06fdde03": { ok: true, data: abiString("USDC") }, // name()
      "0x95d89b41": { ok: true, data: abiString("USDC") }, // symbol()
      "0x313ce567": { ok: true, data: u256(6) },           // decimals()
      "0x18160ddd": { ok: true, data: u256("1000000") },   // totalSupply()
      "0x8da5cb5b": { ok: true, data: padAddr(owner) },    // owner()
    },
  });
  const m = await readMetadata(rpc, "0xtoken");
  assert.equal(m.name, "USDC");
  assert.equal(m.symbol, "USDC");
  assert.equal(m.decimals, 6);
  assert.equal(m.totalSupply, 1000000n);
  assert.equal(m.owner.toLowerCase(), owner.toLowerCase());
  assert.deepEqual(m.errors, [], "all calls succeeded -> no errors");
}

// ── 7. metadata decode: reverts degrade to null, no throw ─────────────────────
//   A revert is NOT a transient failure — the contract simply doesn't implement
//   the method. So `errors` must stay empty (revert = information, not uncertainty).
{
  const rpc = new MockRpc({ calls: {} }); // all calls return {ok:false} (revert)
  const m = await readMetadata(rpc, "0xnontoken");
  assert.equal(m.name, null);
  assert.equal(m.symbol, null);
  assert.equal(m.decimals, null);
  assert.equal(m.totalSupply, null);
  assert.equal(m.owner, null);
  assert.deepEqual(m.errors, [], "reverts must NOT be logged as transient errors");
}

// ── 7b. transient failure: owner() times out (transient:true) → tracked ───────
{
  const u256 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
  const abiString = (s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    const len = (s.length).toString(16).padStart(64, "0");
    return "0x" + "20".padStart(64, "0") + len + hex.padEnd(64, "0");
  };
  const rpc = new MockRpc({
    calls: {
      "0x06fdde03": { ok: true, data: abiString("TKN") },
      "0x95d89b41": { ok: true, data: abiString("TKN") },
      "0x313ce567": { ok: true, data: u256(18) },
      "0x18160ddd": { ok: true, data: u256("1000") },
      "0x8da5cb5b": { ok: false, data: null, transient: true }, // owner() timed out
    },
  });
  const m = await readMetadata(rpc, "0xtoken");
  assert.equal(m.owner, null);
  assert.deepEqual(m.errors, ["owner"], "transient owner() failure must be tracked");
}

// ── 7c. revert on owner() (transient:false) → NOT tracked ─────────────────────
{
  const u256 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
  const rpc = new MockRpc({
    calls: {
      "0x313ce567": { ok: true, data: u256(18) },
      "0x8da5cb5b": { ok: false, data: null, transient: false }, // owner() reverts (no owner)
    },
  });
  const m = await readMetadata(rpc, "0xtoken");
  assert.equal(m.owner, null);
  assert.deepEqual(m.errors, [], "a revert on owner() must NOT be flagged as an error");
}

// ── 8. ERC-165 interface probe ────────────────────────────────────────────────
{
  const SUPPORTED = "0x" + "0".repeat(63) + "1"; // bool true
  const NOT = "0x" + "0".repeat(64);
  const rpc = new MockRpc();
  // supportsInterface always returns supported for ERC721 id, not for ERC1155
  rpc.ethCallSafe = async (_to, data) => {
    // data = 0x01ffc9a7 + 32-byte padded interfaceId
    const id = "0x" + data.slice(10, 18);
    if (id === "0x80ac58cd") return { ok: true, data: SUPPORTED }; // ERC721
    return { ok: true, data: NOT };
  };
  const probed = await probeInterfaces(rpc, "0xnft", {
    "0x80ac58cd": "ERC721",
    "0xd9b67a26": "ERC1155",
  });
  const erc721 = probed.find((p) => p.name === "ERC721");
  const erc1155 = probed.find((p) => p.name === "ERC1155");
  assert.equal(erc721.supported, true);
  assert.equal(erc1155.supported, false);
}

console.log("proxy + decode tests passed");

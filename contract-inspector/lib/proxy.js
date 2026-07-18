// proxy.js — detect and resolve proxy implementations.
// Handles: EIP-1167 minimal proxy (impl embedded in bytecode), EIP-1967
// (storage slot), UUPS, and the implementation() getter fallback.

import { Rpc } from "./rpc.js";
import { stripHex } from "./disasm.js";

// EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const SLOT_1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// EIP-1967 admin slot
const SLOT_1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// OpenZeppelin legacy slot: keccak256("org.zeppelinos.proxy.implementation")
const SLOT_OZ_LEGACY = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

function addrFromSlot(word) {
  if (!word) return null;
  const clean = stripHex(word).padStart(64, "0");
  const addr = "0x" + clean.slice(24);
  if (/^0x0{40}$/.test(addr)) return null;
  return addr;
}

// EIP-1167: 363d3d373d3d3d363d73<20-byte impl>5af43d82803e903d91602b57fd5bf3
function eip1167Impl(codeHex) {
  const code = stripHex(codeHex).toLowerCase();
  const m = code.match(/363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3/);
  return m ? "0x" + m[1] : null;
}

/**
 * Resolve a proxy implementation address, trying methods in order of reliability.
 * Returns { isProxy, type, impl, admin } — impl is null if not a proxy.
 */
export async function resolveProxy(rpc, addr, codeHex) {
  // 1. EIP-1167 minimal proxy — impl is literally in the bytecode.
  const minimal = eip1167Impl(codeHex);
  if (minimal) return { isProxy: true, type: "EIP-1167 minimal proxy", impl: minimal, admin: null };

  // 2. EIP-1967 storage slot.
  const slot1967 = addrFromSlot(await rpc.getStorageAt(addr, SLOT_1967_IMPL));
  if (slot1967) {
    const admin = addrFromSlot(await rpc.getStorageAt(addr, SLOT_1967_ADMIN));
    return { isProxy: true, type: "EIP-1967 proxy", impl: slot1967, admin };
  }

  // 3. OpenZeppelin legacy slot.
  const slotOz = addrFromSlot(await rpc.getStorageAt(addr, SLOT_OZ_LEGACY));
  if (slotOz) return { isProxy: true, type: "OZ legacy proxy", impl: slotOz, admin: null };

  // 4. implementation() getter fallback (some proxies expose it; Pharos USDC does).
  const res = await rpc.ethCallSafe(addr, "0x5c60da1b");
  if (res.ok && res.data && res.data !== "0x") {
    const impl = addrFromSlot(res.data);
    if (impl) return { isProxy: true, type: "getter-based proxy (implementation())", impl, admin: null };
  }

  return { isProxy: false, type: null, impl: null, admin: null };
}

export { SLOT_1967_IMPL, SLOT_1967_ADMIN };

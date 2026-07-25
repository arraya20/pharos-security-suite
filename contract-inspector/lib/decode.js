// decode.js — decode standard contract metadata via eth_call, ABI-free.
// Implements tiny Solidity ABI decoders for string, uint256, and address.

function strip0x(hex) {
  return (hex || "").startsWith("0x") ? hex.slice(2) : (hex || "");
}

function readWord(raw, offsetWords = 0) {
  const start = offsetWords * 64;
  return raw.slice(start, start + 64);
}

function wordToNumber(word) {
  if (!word) return null;
  return Number(BigInt(`0x${word}`));
}

function decodeString(hex) {
  const raw = strip0x(hex);
  if (!raw) return null;
  try {
    if (raw.length >= 128) {
      const offset = wordToNumber(readWord(raw, 0));
      if (offset !== null && offset * 2 + 64 <= raw.length) {
        const len = wordToNumber(raw.slice(offset * 2, offset * 2 + 64));
        const start = offset * 2 + 64;
        const bytes = raw.slice(start, start + len * 2);
        const s = Buffer.from(bytes, "hex").toString("utf8").replace(/\u0000+$/g, "");
        return s || null;
      }
    }

    // Some old tokens return bytes32 instead of ABI string.
    const bytes = Buffer.from(raw.slice(0, 64), "hex");
    const s = bytes.toString("utf8").replace(/\u0000+$/g, "").replace(/[^\x20-\x7e]/g, "");
    return s || null;
  } catch {
    return null;
  }
}

function decodeUint(hex) {
  const raw = strip0x(hex);
  if (!raw) return null;
  try {
    return BigInt(`0x${readWord(raw, 0) || raw}`);
  } catch {
    return null;
  }
}

function decodeAddress(hex) {
  const raw = strip0x(hex);
  if (!raw || raw.length < 40) return null;
  try {
    return `0x${readWord(raw, 0).slice(-40)}`;
  } catch {
    return null;
  }
}

/**
 * Pull common metadata. Each is best-effort; missing fields are null.
 * Returns { name, symbol, decimals, totalSupply, owner, errors }.
 *
 * `errors` ONLY lists fields whose eth_call failed transiently (timeout, RPC
 * 5xx, network error after retries exhausted). A genuine revert — meaning the
 * contract does not implement that method — is information, not uncertainty,
 * so it does NOT go in errors. Permit2 reverting on owner() is "no owner",
 * not "owner unknown". This is what lets risk scoring distinguish "we know
 * there's no admin" from "we couldn't read admin".
 */
export async function readMetadata(rpc, addr) {
  const out = { name: null, symbol: null, decimals: null, totalSupply: null, owner: null, errors: [] };

  const [name, symbol, decimals, supply, owner] = await Promise.all([
    rpc.ethCallSafe(addr, "0x06fdde03"), // name()
    rpc.ethCallSafe(addr, "0x95d89b41"), // symbol()
    rpc.ethCallSafe(addr, "0x313ce567"), // decimals()
    rpc.ethCallSafe(addr, "0x18160ddd"), // totalSupply()
    rpc.ethCallSafe(addr, "0x8da5cb5b"), // owner()
  ]);

  const trackTransient = (name, res) => { if (!res.ok && res.transient) out.errors.push(name); };

  if (name.ok) out.name = decodeString(name.data); else trackTransient("name", name);
  if (symbol.ok) out.symbol = decodeString(symbol.data); else trackTransient("symbol", symbol);
  if (decimals.ok) {
    const d = decodeUint(decimals.data);
    out.decimals = d === null ? null : Number(d);
  } else { trackTransient("decimals", decimals); }
  if (supply.ok) out.totalSupply = decodeUint(supply.data); else trackTransient("totalSupply", supply);
  if (owner.ok) out.owner = decodeAddress(owner.data); else trackTransient("owner", owner);

  return out;
}

/**
 * Probe ERC-165 supportsInterface for a list of interface IDs.
 * Returns array of { id, name, supported }.
 */
export async function probeInterfaces(rpc, addr, interfaceIds) {
  const results = [];
  for (const [id, name] of Object.entries(interfaceIds)) {
    // supportsInterface(bytes4) selector 0x01ffc9a7 + padded interfaceId
    const data = "0x01ffc9a7" + id.slice(2).padEnd(64, "0");
    const res = await rpc.ethCallSafe(addr, data);
    const supported = Boolean(res.ok && res.data && res.data !== "0x" && res.data.slice(-2) === "01");
    results.push({ id, name, supported });
  }
  return results;
}

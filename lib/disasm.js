// disasm.js — extract function selectors from EVM runtime bytecode without an ABI.
//
// Solidity's function dispatcher loads the first 4 bytes of calldata
// (the selector) and compares it against each function via a sequence that
// almost always contains `PUSH4 <selector>` followed shortly by `EQ`.
// We scan for PUSH4 immediates that are used in equality comparisons.
//
// This is heuristic, not a full decompiler, but in practice it recovers the
// public/external function selector set for the overwhelming majority of
// Solidity- and Vyper-compiled contracts.

// Opcodes we care about
const EQ = 0x14;
const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;
const SOLIDITY_METADATA_KEYS = new Set([
  "ipfs",
  "solc",
  "bzzr0",
  "bzzr1",
  "experimental",
]);

// Build the set of valid PUSH opcodes -> immediate length
function pushLen(op) {
  if (op >= PUSH1 && op <= PUSH32) return op - PUSH1 + 1;
  return 0;
}

function readCborLength(bytes, offset, additionalInfo) {
  if (additionalInfo < 24) return { length: additionalInfo, next: offset };
  const width = additionalInfo === 24 ? 1
    : additionalInfo === 25 ? 2
      : additionalInfo === 26 ? 4
        : additionalInfo === 27 ? 8
          : 0;
  if (!width || offset + width > bytes.length) return null;

  let length = 0n;
  for (let i = 0; i < width; i++) {
    length = (length << 8n) | BigInt(bytes[offset + i]);
  }
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { length: Number(length), next: offset + width };
}

function skipCborValue(bytes, offset, depth = 0) {
  if (depth > 16 || offset >= bytes.length) return null;
  const initial = bytes[offset];
  const major = initial >> 5;
  const additionalInfo = initial & 0x1f;
  const argument = readCborLength(bytes, offset + 1, additionalInfo);
  if (!argument) return null;

  if (major <= 1) return argument.next;
  if (major === 2 || major === 3) {
    const end = argument.next + argument.length;
    return end <= bytes.length ? end : null;
  }
  if (major === 4 || major === 5) {
    let next = argument.next;
    const values = argument.length * (major === 5 ? 2 : 1);
    for (let i = 0; i < values; i++) {
      next = skipCborValue(bytes, next, depth + 1);
      if (next == null) return null;
    }
    return next;
  }
  if (major === 6) return skipCborValue(bytes, argument.next, depth + 1);
  // Simple values and fixed-width floats are valid when readCborLength
  // successfully consumed their argument bytes.
  return major === 7 && additionalInfo <= 27 ? argument.next : null;
}

function topLevelCborKeys(bytes) {
  if (!bytes.length || bytes[0] >> 5 !== 5) return null;
  const header = readCborLength(bytes, 1, bytes[0] & 0x1f);
  if (!header) return null;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const keys = [];
  let next = header.next;
  try {
    for (let i = 0; i < header.length; i++) {
      if (next >= bytes.length || bytes[next] >> 5 !== 3) return null;
      const keyHeader = readCborLength(bytes, next + 1, bytes[next] & 0x1f);
      if (!keyHeader) return null;
      const keyEnd = keyHeader.next + keyHeader.length;
      if (keyEnd > bytes.length) return null;
      keys.push(decoder.decode(bytes.slice(keyHeader.next, keyEnd)));
      next = skipCborValue(bytes, keyEnd, 1);
      if (next == null) return null;
    }
  } catch {
    return null;
  }
  return next === bytes.length ? keys : null;
}

export function stripSolidityMetadata(bytes) {
  if (bytes.length < 3) return bytes;
  const metadataLength =
    (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const metadataStart = bytes.length - metadataLength - 2;
  if (metadataLength === 0 || metadataStart < 0) return bytes;

  const metadata = bytes.slice(metadataStart, bytes.length - 2);
  // Solidity appends a complete CBOR map containing a compiler/content-address
  // key. Structural validation avoids truncating ordinary bytecode whose final
  // two bytes merely happen to look like a plausible metadata length.
  const keys = topLevelCborKeys(metadata);
  if (!keys || !keys.some((key) => SOLIDITY_METADATA_KEYS.has(key))) return bytes;
  return bytes.slice(0, metadataStart);
}

/**
 * Walk bytecode and return:
 *  - selectors: Set of 0x-prefixed 4-byte hex strings found in PUSH4 immediates
 *  - hasDelegateCall: bool (proxy signal)
 *  - hasSelfdestruct: bool (danger signal)
 *  - hasCreate / hasCreate2: bool (factory signal)
 */
export function disassemble(codeHex) {
  const code = stripHex(codeHex);
  const bytes = stripSolidityMetadata(hexToBytes(code));

  const push4Values = [];
  const eqAdjacentSelectors = new Set();
  let hasDelegateCall = false;
  let hasSelfdestruct = false;
  let hasCreate = false;
  let hasCreate2 = false;

  // First pass: record opcode stream with positions of PUSH4 immediates,
  // skipping over push immediates so we never misread data as opcodes.
  const ops = []; // { pc, op, imm? }
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc];
    const len = pushLen(op);
    if (len > 0) {
      const imm = bytes.slice(pc + 1, pc + 1 + len);
      ops.push({ pc, op, imm });
      if (op === PUSH4 && imm.length === 4) {
        push4Values.push({ idx: ops.length - 1, sel: "0x" + bytesToHex(imm) });
      }
      pc += len;
    } else {
      ops.push({ pc, op });
      if (op === 0xf4) hasDelegateCall = true; // DELEGATECALL
      if (op === 0xff) hasSelfdestruct = true; // SELFDESTRUCT
      if (op === 0xf0) hasCreate = true; // CREATE
      if (op === 0xf5) hasCreate2 = true; // CREATE2
    }
  }

  // Second pass: a PUSH4 immediate is "selector-like" if an EQ appears within
  // a short window after it (the dispatcher does `DUP1 PUSH4 sel EQ PUSH addr JUMPI`).
  for (const { idx, sel } of push4Values) {
    if (sel === "0xffffffff") continue; // mask constant, not a selector
    for (let k = idx + 1; k <= idx + 4 && k < ops.length; k++) {
      if (ops[k].op === EQ) {
        eqAdjacentSelectors.add(sel);
        break;
      }
    }
  }

  // Fallback: if the EQ-adjacency heuristic found nothing (e.g. Vyper or an
  // unusual dispatcher) but we have PUSH4 values, return all plausible ones.
  let selectors = eqAdjacentSelectors;
  if (selectors.size === 0 && push4Values.length > 0) {
    selectors = new Set(push4Values.map((p) => p.sel).filter((s) => s !== "0xffffffff"));
  }

  return {
    selectors: [...selectors].sort(),
    hasDelegateCall,
    hasSelfdestruct,
    hasCreate,
    hasCreate2,
    codeSize: bytes.length,
  };
}

// ---- hex helpers ----
export function stripHex(h) {
  return h && h.startsWith("0x") ? h.slice(2) : h || "";
}
export function hexToBytes(h) {
  const clean = stripHex(h);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
export function bytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

#!/usr/bin/env node
// Tests for the EVM bytecode disassembler — the core innovation.
// We hand-craft tiny bytecode fragments rather than load fixtures: that way the
// expected behaviour is obvious from the test, and there's no binary file to maintain.

import assert from "node:assert/strict";
import { disassemble, hexToBytes, bytesToHex, stripHex } from "./lib/disasm.js";

// ── helpers to assemble tiny bytecode in tests ────────────────────────────────
const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;
const EQ = 0x14;
const DUP1 = 0x80;
const STOP = 0x00;
const DELEGATECALL = 0xf4;
const SELFDESTRUCT = 0xff;
const CREATE = 0xf0;
const CREATE2 = 0xf5;

function asm(...parts) {
  const bytes = [];
  for (const p of parts) {
    if (typeof p === "number") bytes.push(p);
    else if (typeof p === "string") {
      const clean = stripHex(p);
      for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
    } else if (p instanceof Uint8Array) {
      for (const b of p) bytes.push(b);
    }
  }
  return "0x" + bytesToHex(new Uint8Array(bytes));
}

// ── 1. hex round-trip ─────────────────────────────────────────────────────────
{
  assert.equal(stripHex("0xdeadbeef"), "deadbeef");
  assert.equal(stripHex("deadbeef"), "deadbeef");
  assert.equal(stripHex(""), "");
  assert.equal(bytesToHex(hexToBytes("0xdeadbeef")), "deadbeef");
}

// ── 2. classic Solidity dispatcher: PUSH4 sel / DUP1 / EQ ─────────────────────
//   Two real ERC-20 selectors.
{
  const NAME = "06fdde03"; // name()
  const SYMBOL = "95d89b41"; // symbol()
  const code = asm(
    PUSH4, NAME, DUP1, EQ, STOP,
    PUSH4, SYMBOL, DUP1, EQ, STOP,
  );
  const r = disassemble(code);
  assert.deepEqual(r.selectors, ["0x" + NAME, "0x" + SYMBOL].sort());
  assert.equal(r.hasDelegateCall, false);
  assert.equal(r.hasSelfdestruct, false);
}

// ── 3. fallback path: PUSH4 with no nearby EQ → Vyper-style fallback ──────────
{
  const SEL = "12345678";
  // PUSH4 then unrelated ops, no EQ within window
  const code = asm(PUSH4, SEL, STOP, STOP, STOP, STOP, STOP, STOP);
  const r = disassemble(code);
  // Fallback returns all PUSH4 immediates when the EQ-adjacency heuristic finds nothing.
  assert.deepEqual(r.selectors, ["0x" + SEL]);
}

// ── 4. PUSH4 0xffffffff (selector mask) is filtered out ───────────────────────
{
  const code = asm(PUSH4, "ffffffff", DUP1, EQ, STOP);
  const r = disassemble(code);
  assert.deepEqual(r.selectors, []);
}

// ── 5. data section that LOOKS like opcodes must NOT be misread ───────────────
//   PUSH32 immediate contains 0x14 (EQ) and 0x63 (PUSH4) bytes. If the walker
//   reads these as opcodes, it'll spuriously emit a selector.
{
  const innerSelectorBytes = "63aabbccdd14"; // PUSH4 + selector + EQ INSIDE data
  // Pad to 32 bytes
  const immediate = innerSelectorBytes + "00".repeat(32 - innerSelectorBytes.length / 2);
  const code = asm(PUSH32, immediate, STOP);
  const r = disassemble(code);
  // No real PUSH4/EQ outside the immediate → must report empty selector set.
  assert.deepEqual(r.selectors, [], "data section was misread as opcodes");
}

// ── 6. opcode signal flags: DELEGATECALL / SELFDESTRUCT / CREATE / CREATE2 ────
{
  const r = disassemble(asm(DELEGATECALL, SELFDESTRUCT, CREATE, CREATE2, STOP));
  assert.equal(r.hasDelegateCall, true);
  assert.equal(r.hasSelfdestruct, true);
  assert.equal(r.hasCreate, true);
  assert.equal(r.hasCreate2, true);
}

{
  const r = disassemble(asm(PUSH1, "00", STOP));
  assert.equal(r.hasDelegateCall, false);
  assert.equal(r.hasSelfdestruct, false);
  assert.equal(r.hasCreate, false);
  assert.equal(r.hasCreate2, false);
}

// ── 7. opcode bytes hidden inside a PUSH immediate must NOT trip flags ────────
{
  // PUSH1 0xf4 (DELEGATECALL byte as DATA, not as opcode)
  const code = asm(PUSH1, "f4", STOP);
  const r = disassemble(code);
  assert.equal(r.hasDelegateCall, false, "data byte 0xf4 was misread as DELEGATECALL opcode");
}

// ── 8. empty / 0x bytecode is safe ────────────────────────────────────────────
{
  const r = disassemble("0x");
  assert.deepEqual(r.selectors, []);
  assert.equal(r.codeSize, 0);
}

// ── 9. codeSize equals byte length ────────────────────────────────────────────
{
  const r = disassemble(asm(PUSH1, "00", PUSH1, "00", STOP));
  assert.equal(r.codeSize, 5);
}

// ── 10. selectors are sorted, deduped ─────────────────────────────────────────
{
  const SEL = "06fdde03";
  // Same selector matched twice in the dispatcher
  const code = asm(
    PUSH4, SEL, DUP1, EQ, STOP,
    PUSH4, SEL, DUP1, EQ, STOP,
  );
  const r = disassemble(code);
  assert.deepEqual(r.selectors, ["0x" + SEL]);
}

// ── 11. Solidity CBOR metadata is excluded from opcode analysis ───────────────
{
  const REAL = "06fdde03";
  const METADATA_ONLY = "deadbeef";
  const runtime = asm(PUSH4, REAL, DUP1, EQ, STOP);
  // Valid CBOR map beginning with a1. The value deliberately contains a
  // selector-like PUSH4/EQ sequence that must not affect analysis.
  const metadata = asm("a164736f6c634663" + METADATA_ONLY + "14");
  const metadataLength = ((stripHex(metadata).length / 2).toString(16)).padStart(4, "0");
  const code = runtime + stripHex(metadata) + metadataLength;

  const r = disassemble(code);
  assert.deepEqual(r.selectors, ["0x" + REAL]);
  assert.equal(r.codeSize, stripHex(runtime).length / 2);
}

// ── 12. malformed metadata lengths are left untouched ────────────────────────
{
  const code = asm(PUSH4, "12345678", DUP1, EQ, STOP) + "ffff";
  const r = disassemble(code);
  assert.deepEqual(r.selectors, ["0x12345678"]);
  assert.equal(r.codeSize, stripHex(code).length / 2);
}

// ── 13. Solidity 0.8.x IPFS metadata trailer is recognized ───────────────────
{
  const runtime = asm(PUSH4, "abcdef01", DUP1, EQ, STOP);
  // Standard solc trailer shape:
  // a2 6469706673 5822 1220 <32-byte digest> 64736f6c63 43 000814
  // The digest contains a selector-looking sequence to guard against FPs.
  const digest = "63deadbeef14" + "00".repeat(26);
  const metadata =
    "a2646970667358221220" + digest + "64736f6c6343000814";
  const code = runtime + metadata + "0033";

  const r = disassemble(code);
  assert.deepEqual(r.selectors, ["0xabcdef01"]);
  assert.equal(r.codeSize, stripHex(runtime).length / 2);
}

// ── 14. map-like but structurally invalid CBOR is not stripped ────────────────
{
  const runtime = asm(PUSH4, "12345678", DUP1, EQ, STOP);
  const invalidMetadata = "a164736f6c6358ff";
  const length = (invalidMetadata.length / 2).toString(16).padStart(4, "0");
  const code = runtime + invalidMetadata + length;

  const r = disassemble(code);
  assert.equal(r.codeSize, stripHex(code).length / 2);
}

console.log("disasm tests passed");

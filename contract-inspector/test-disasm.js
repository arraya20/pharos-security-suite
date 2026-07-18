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

console.log("disasm tests passed");

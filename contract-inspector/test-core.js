#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertExpectedChainId, detectStandards } from "./lib/inspect-core.js";

{
  assert.doesNotThrow(() => assertExpectedChainId("0x688", 1672, "mainnet"));
  assert.throws(
    () => assertExpectedChainId("0x1", 1672, "mainnet"),
    /RPC chainId mismatch for mainnet: expected 1672, got 1/,
  );
}

{
  const proxySelectors = ["0x3659cfe6"];
  const implementationSelectors = [
    "0x18160ddd",
    "0x70a08231",
    "0xa9059cbb",
    "0x23b872dd",
    "0x095ea7b3",
    "0xdd62ed3e",
  ];
  const standards = detectStandards(proxySelectors, [], implementationSelectors);
  assert.ok(standards.includes("ERC-20"));
}

console.log("core tests passed");

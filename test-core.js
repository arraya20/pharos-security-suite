#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertExpectedChainId, detectStandards, inspectContract } from "./lib/inspect-core.js";

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

{
  const snapshotBlock = "0xabc";
  const observedBlocks = [];
  const fakeRpc = {
    chainId: async () => "0x688",
    getBlockNumber: async () => snapshotBlock,
    getCode: async (_address, block) => {
      observedBlocks.push(block);
      return "0x6000";
    },
    getStorageAt: async (_address, _slot, block) => {
      observedBlocks.push(block);
      return `0x${"0".repeat(64)}`;
    },
    ethCallSafe: async (_address, _data, block) => {
      observedBlocks.push(block);
      return { ok: false, data: null, transient: false };
    },
  };

  const report = await inspectContract({
    address: "0x0000000000000000000000000000000000000001",
    network: "mainnet",
    online: false,
    rpc: fakeRpc,
  });

  assert.equal(report.snapshotBlock, snapshotBlock);
  assert.ok(observedBlocks.length >= 10);
  assert.deepEqual(observedBlocks, Array(observedBlocks.length).fill(snapshotBlock));
}

console.log("core tests passed");

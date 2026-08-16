#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertExpectedChainId, detectStandards, inspectContract } from "./lib/inspect-core.js";
import { resolveSelector } from "./lib/fourbyte.js";

{
  assert.doesNotThrow(() => assertExpectedChainId("0x688", 1672, "mainnet"));
  assert.throws(
    () => assertExpectedChainId("0x1", 1672, "mainnet"),
    /RPC chainId mismatch for mainnet: expected 1672, got 1/,
  );
}

{
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let upstreamAborted = false;
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }, 30);
    options.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      clearTimeout(timer);
      const error = new Error("selector lookup aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  try {
    const pending = resolveSelector("0x12345679", { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, /aborted/i);
    assert.equal(upstreamAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ results: [{ id: "invalid" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [{ id: 1, text_signature: "recovered()" }],
    }), { status: 200 });
  };
  assert.equal(await resolveSelector("0x1234567b", { fetchImpl }), null);
  assert.equal(await resolveSelector("0x1234567b", { fetchImpl }), "recovered()");
  assert.equal(calls, 2);
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

{
  const zero = `0x${"0".repeat(64)}`;
  const fakeRpc = {
    chainId: async () => "0x688",
    getBlockNumber: async () => "0x10",
    getCode: async () => "0x63123456781400",
    getStorageAt: async () => zero,
    ethCallSafe: async (_address, data) =>
      data === "0x5c60da1b"
        ? { ok: false, data: null, transient: true, error: "RPC timeout" }
        : { ok: false, data: null, transient: false, error: "revert" },
  };

  const report = await inspectContract({
    address: "0x0000000000000000000000000000000000000001",
    network: "mainnet",
    online: false,
    rpc: fakeRpc,
  });

  assert.equal(report.proxy, null);
  assert.equal(report.incomplete[0].code, "PROXY_PROBE_FAILED");
}

{
  const zero = `0x${"0".repeat(64)}`;
  const fakeRpc = {
    chainId: async () => "0x688",
    getBlockNumber: async () => "0x10",
    getCode: async () => "0x6000",
    getStorageAt: async () => zero,
    ethCallSafe: async (_address, data) => data === "0x8da5cb5b"
      ? { ok: false, data: null, transient: true, error: "RPC timeout" }
      : { ok: false, data: null, transient: false, error: "revert" },
  };

  const report = await inspectContract({
    address: "0x0000000000000000000000000000000000000001",
    network: "mainnet",
    online: false,
    rpc: fakeRpc,
  });

  assert.equal(report.status, "PARTIAL");
  assert.ok(report.incomplete.some(({ code }) => code === "METADATA_READ_FAILED"));
}

{
  const originalFetch = globalThis.fetch;
  const zero = `0x${"0".repeat(64)}`;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const fakeRpc = {
    chainId: async () => "0x688",
    getBlockNumber: async () => "0x10",
    getCode: async () => "0x631234567a1400",
    getStorageAt: async () => zero,
    ethCallSafe: async () => ({ ok: false, data: null, transient: false, error: "revert" }),
  };
  try {
    const report = await inspectContract({
      address: "0x0000000000000000000000000000000000000001",
      network: "mainnet",
      online: true,
      rpc: fakeRpc,
    });
    assert.ok(report.incomplete.some(({ code }) => code === "SELECTOR_LOOKUP_FAILED"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("core tests passed");

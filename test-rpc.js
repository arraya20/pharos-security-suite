#!/usr/bin/env node
// Tests for the JSON-RPC client's retry/backoff classification.
// Mocks global fetch so we can control transient vs permanent failures.

import assert from "node:assert/strict";
import { Rpc, RpcPool } from "./lib/rpc.js";

const origFetch = globalThis.fetch;

function mockFetch(sequence) {
  // sequence: array of {kind: "ok"|"http5xx"|"http4xx"|"abort"|"throw"|"rpcerror", result?, status?, code?, message?}
  let i = 0;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    const requestId = JSON.parse(opts.body).id;
    i++;
    calls.push({ step: step.kind });
    if (step.kind === "ok") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: step.result }), { status: 200 });
    }
    if (step.kind === "rpcerror") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: step.code ?? -32000, message: step.message ?? "execution reverted" } }), { status: 200 });
    }
    if (step.kind === "http5xx") return new Response("server error", { status: step.status ?? 503 });
    if (step.kind === "http4xx") return new Response("bad request", { status: step.status ?? 400 });
    if (step.kind === "abort") {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    if (step.kind === "throw") {
      const e = new Error(step.message ?? "fetch failed"); throw e;
    }
    throw new Error("unknown step");
  };
  return calls;
}

function restore() { globalThis.fetch = origFetch; }

// ── 1. transient 5xx then ok → retried, succeeds ──────────────────────────────
{
  const calls = mockFetch([{ kind: "http5xx" }, { kind: "ok", result: "0xabc" }]);
  const rpc = new Rpc("http://mock", { retries: 2, retryBaseMs: 1, timeoutMs: 1000 });
  const r = await rpc.call("eth_chainId");
  assert.equal(r, "0xabc");
  assert.equal(calls.length, 2);
  restore();
}

// ── 2. permanent JSON-RPC error → fail fast, NO retry ─────────────────────────
{
  const calls = mockFetch([{ kind: "rpcerror", code: 3, message: "execution reverted" }, { kind: "ok", result: "should-not-reach" }]);
  const rpc = new Rpc("http://mock", { retries: 3, retryBaseMs: 1, timeoutMs: 1000 });
  await assert.rejects(rpc.call("eth_call"), /execution reverted/);
  assert.equal(calls.length, 1, "JSON-RPC error must not retry");
  restore();
}

// ── 3. permanent 4xx → fail fast, NO retry ────────────────────────────────────
{
  const calls = mockFetch([{ kind: "http4xx", status: 400 }, { kind: "ok" }]);
  const rpc = new Rpc("http://mock", { retries: 3, retryBaseMs: 1, timeoutMs: 1000 });
  await assert.rejects(rpc.call("eth_chainId"), /HTTP 400/);
  assert.equal(calls.length, 1, "4xx must not retry");
  restore();
}

// ── 4. transient 429 → retried ────────────────────────────────────────────────
{
  const calls = mockFetch([{ kind: "http4xx", status: 429 }, { kind: "ok", result: "0x1" }]);
  const rpc = new Rpc("http://mock", { retries: 2, retryBaseMs: 1, timeoutMs: 1000 });
  const r = await rpc.call("eth_chainId");
  assert.equal(r, "0x1");
  assert.equal(calls.length, 2, "429 must retry");
  restore();
}

// ── 5. all transient → exhaust retries → throw ────────────────────────────────
{
  const calls = mockFetch([{ kind: "http5xx" }, { kind: "http5xx" }, { kind: "http5xx" }]);
  const rpc = new Rpc("http://mock", { retries: 2, retryBaseMs: 1, timeoutMs: 1000 });
  await assert.rejects(rpc.call("eth_chainId"), /HTTP 503/);
  assert.equal(calls.length, 3, "should make initial + 2 retries = 3 attempts");
  restore();
}

// ── 6. timeout (AbortError) → transient, retried ──────────────────────────────
{
  const calls = mockFetch([{ kind: "abort" }, { kind: "ok", result: "0x2" }]);
  const rpc = new Rpc("http://mock", { retries: 2, retryBaseMs: 1, timeoutMs: 1000 });
  const r = await rpc.call("eth_chainId");
  assert.equal(r, "0x2");
  assert.equal(calls.length, 2);
  restore();
}

// ── 7. ethCallSafe: revert returns {ok:false, transient:false} (no retry) ─────
{
  const calls = mockFetch([{ kind: "rpcerror", code: 3, message: "execution reverted" }]);
  const rpc = new Rpc("http://mock", { retries: 3, retryBaseMs: 1, timeoutMs: 1000 });
  const res = await rpc.ethCallSafe("0xabc", "0x06fdde03");
  assert.equal(res.ok, false);
  assert.equal(res.transient, false);
  assert.equal(calls.length, 1, "revert must not retry");
  restore();
}

// ── 8. ethCallSafe: transient network → retries internally, eventually succeeds ─
{
  const calls = mockFetch([{ kind: "http5xx" }, { kind: "ok", result: "0xdeadbeef" }]);
  const rpc = new Rpc("http://mock", { retries: 2, retryBaseMs: 1, timeoutMs: 1000 });
  const res = await rpc.ethCallSafe("0xabc", "0x06fdde03");
  assert.equal(res.ok, true);
  assert.equal(res.data, "0xdeadbeef");
  assert.equal(calls.length, 2);
  restore();
}

console.log("rpc tests passed");

{
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const pool = new RpcPool(
    [
      {
        label: "primary",
        call: async () => {
          primaryCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "primary";
        },
      },
      {
        label: "secondary",
        call: async () => {
          secondaryCalls += 1;
          return "secondary";
        },
      },
    ],
    { hedgeDelayMs: 5 },
  );
  assert.equal(await pool.call("eth_blockNumber"), "secondary");
  assert.equal(primaryCalls, 1);
  assert.equal(secondaryCalls, 1);
}

{
  const timeout = new Error("timeout");
  timeout.transient = true;
  const pool = new RpcPool(
    [
      { label: "primary", call: async () => Promise.reject(timeout) },
      { label: "secondary", call: async () => "ok" },
    ],
    { hedgeDelayMs: 1000 },
  );
  assert.equal(await pool.call("eth_getCode", []), "ok");
}

{
  let secondaryCalls = 0;
  const permanent = new Error("execution reverted");
  permanent.transient = false;
  const pool = new RpcPool([
    { label: "primary", call: async () => Promise.reject(permanent) },
    {
      label: "secondary",
      call: async () => {
        secondaryCalls += 1;
        return "unexpected";
      },
    },
  ]);
  await assert.rejects(() => pool.call("eth_call", []), /execution reverted/);
  assert.equal(secondaryCalls, 0);
}

{
  const controller = new AbortController();
  const rpc = new Rpc("https://rpc.example", {
    retries: 0,
    signal: controller.signal,
    fetchImpl: async (_url, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const pending = rpc.getBlockNumber();
  controller.abort();
  await assert.rejects(() => pending, /RPC aborted/i);
}

// External cancellation is terminal: it must not consume the retry budget.
{
  const controller = new AbortController();
  let calls = 0;
  const rpc = new Rpc("https://rpc.example", {
    retries: 2,
    retryBaseMs: 1,
    signal: controller.signal,
    fetchImpl: async (_url, options) => new Promise((_, reject) => {
      calls += 1;
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const pending = rpc.getBlockNumber();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => pending, /RPC aborted/i);
  assert.equal(calls, 1, "an aborted RPC must not retry");
}

// Once a hedged provider wins, the slower request must be cancelled.
{
  let primaryAborted = false;
  const pool = new RpcPool(
    [
      {
        label: "primary",
        call: async (_method, _params, context = {}) =>
          new Promise((_, reject) => {
            context.signal?.addEventListener("abort", () => {
              primaryAborted = true;
              const error = new Error("hedged request cancelled");
              error.name = "AbortError";
              reject(error);
            });
          }),
      },
      { label: "secondary", call: async () => "secondary" },
    ],
    { hedgeDelayMs: 1 },
  );
  assert.equal(await pool.call("eth_blockNumber"), "secondary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(primaryAborted, true, "the losing hedge must be aborted");
}

// A 200 response is still untrusted JSON-RPC data.
for (const payload of [
  { jsonrpc: "2.0", id: 999, result: "0x1" },
  { jsonrpc: "2.0", id: 1 },
  { jsonrpc: "1.0", id: 1, result: "0x1" },
  { jsonrpc: "2.0", id: 1, result: "0x1", error: { code: -1, message: "both" } },
]) {
  const rpc = new Rpc("https://rpc.example", {
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  await assert.rejects(() => rpc.chainId(), /invalid JSON-RPC response/i);
}

{
  const rpc = new Rpc("https://rpc.example", {
    retries: 0,
    fetchImpl: async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "mainnet" }),
      { status: 200 },
    ),
  });
  await assert.rejects(() => rpc.chainId(), /invalid JSON-RPC result/i);
}

{
  const rpc = new Rpc("https://rpc.example", {
    retries: 0,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: async () => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("body aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    }),
  });
  await assert.rejects(
    () => Promise.race([
      rpc.chainId(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("body remained pending")), 30)),
    ]),
    /RPC timeout/i,
  );
}

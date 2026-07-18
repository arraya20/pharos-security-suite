#!/usr/bin/env node
// Tests for the JSON-RPC client's retry/backoff classification.
// Mocks global fetch so we can control transient vs permanent failures.

import assert from "node:assert/strict";
import { Rpc } from "./lib/rpc.js";

const origFetch = globalThis.fetch;

function mockFetch(sequence) {
  // sequence: array of {kind: "ok"|"http5xx"|"http4xx"|"abort"|"throw"|"rpcerror", result?, status?, code?, message?}
  let i = 0;
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    calls.push({ step: step.kind });
    if (step.kind === "ok") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: step.result }), { status: 200 });
    }
    if (step.kind === "rpcerror") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: step.code ?? -32000, message: step.message ?? "execution reverted" } }), { status: 200 });
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

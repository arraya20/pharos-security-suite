import assert from "node:assert/strict";
import test from "node:test";
import { Rpc, RpcPool } from "../scripts/lib/rpc.mjs";

function transient(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

test("hedges a slow primary and returns the faster secondary result", async () => {
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
    { hedgeDelayMs: 5 }
  );

  assert.equal(await pool.call("eth_blockNumber"), "secondary");
  assert.equal(primaryCalls, 1);
  assert.equal(secondaryCalls, 1);
});

test("fails over immediately after a transient primary failure", async () => {
  const pool = new RpcPool(
    [
      { label: "primary", call: async () => Promise.reject(transient("timeout")) },
      { label: "secondary", call: async () => "ok" },
    ],
    { hedgeDelayMs: 1000 }
  );

  assert.equal(await pool.call("eth_getCode", []), "ok");
});

test("does not fail over deterministic JSON-RPC errors", async () => {
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
});

test("opens a circuit after repeated transient failures and retries after cooldown", async () => {
  let now = 1000;
  let primaryCalls = 0;
  const primary = {
    label: "primary",
    call: async () => {
      primaryCalls += 1;
      throw transient("unavailable");
    },
  };
  const pool = new RpcPool(
    [primary, { label: "secondary", call: async () => "ok" }],
    {
      hedgeDelayMs: 1000,
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now,
    }
  );

  assert.equal(await pool.call("eth_chainId"), "ok");
  assert.equal(await pool.call("eth_chainId"), "ok");
  assert.equal(await pool.call("eth_chainId"), "ok");
  assert.equal(primaryCalls, 2);

  now += 101;
  assert.equal(await pool.call("eth_chainId"), "ok");
  assert.equal(primaryCalls, 3);
});

test("propagates an external abort signal into an in-flight RPC request", async () => {
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
  await assert.rejects(() => pending, /RPC timeout|aborted/i);
});

test("does not retry after external cancellation", async () => {
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
  assert.equal(calls, 1);
});

test("cancels a slower hedged provider after another provider succeeds", async () => {
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
    { hedgeDelayMs: 1 }
  );

  assert.equal(await pool.call("eth_blockNumber"), "secondary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(primaryAborted, true);
});

test("rejects malformed or mismatched JSON-RPC response envelopes", async () => {
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
});

test("rejects a malformed result for a known JSON-RPC method", async () => {
  const rpc = new Rpc("https://rpc.example", {
    retries: 0,
    fetchImpl: async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "mainnet" }),
      { status: 200 }
    ),
  });

  await assert.rejects(() => rpc.chainId(), /invalid JSON-RPC result/i);
});

test("keeps the RPC timeout active while reading the response body", async () => {
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
    /RPC timeout/i
  );
});

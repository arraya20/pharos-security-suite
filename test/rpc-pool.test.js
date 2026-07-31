import assert from "node:assert/strict";
import test from "node:test";
import { RpcPool } from "../scripts/lib/rpc.mjs";

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

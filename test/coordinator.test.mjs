import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTtlCache } from "../coordinator/cache.mjs";
import { defineAdapter } from "../coordinator/adapters.mjs";
import { createCoordinator } from "../coordinator/coordinator.mjs";

const ADDRESS = "0x0000000000000000000000000000000000000001";

function request(targetType, target, options = {}) {
  return { schemaVersion: "1.0", targetType, target, options };
}

function adapter(module, version, assess) {
  return { module, version, assess };
}

test("routes single target types only to their specialist", async () => {
  const calls = [];
  const coordinator = createCoordinator({
    adapters: {
      address: adapter("address-intelligence", "0.1.0", async () => {
        calls.push("address");
        return { risk: { score: 25, level: "MODERATE" }, confidence: "full" };
      }),
      contract: adapter("contract-inspector", "1.1.0", async () => {
        calls.push("contract");
        return { risk: { score: 40, level: "Medium" } };
      }),
      skill: adapter("skill-inspector", "0.1.0", async () => {
        calls.push("skill");
        return { score: 0, severity: "LOW", findings: [] };
      }),
    },
  });

  const result = await coordinator.assess(
    request("ADDRESS", { address: ADDRESS, network: "mainnet" })
  );

  assert.deepEqual(calls, ["address"]);
  assert.equal(result.targetType, "ADDRESS");
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result.risk, { score: 25, level: "MODERATE" });
});

test("runs relevant FULL specialists concurrently and aggregates worst risk", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delayed = (result) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return result;
  };
  const coordinator = createCoordinator({
    adapters: {
      address: adapter(
        "address-intelligence",
        "0.1.0",
        delayed({ risk: { score: 25, level: "MODERATE" }, confidence: "full" })
      ),
      contract: adapter(
        "contract-inspector",
        "1.1.0",
        delayed({ risk: { score: 65, level: "High" } })
      ),
      skill: adapter(
        "skill-inspector",
        "0.1.0",
        delayed({ score: 10, severity: "LOW", findings: [] })
      ),
    },
  });

  const result = await coordinator.assess(
    request("FULL", {
      address: ADDRESS,
      network: "mainnet",
      skillRef: "artifact:skill-1",
    })
  );

  assert.equal(maxInFlight, 3);
  assert.equal(result.targetType, "FULL");
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result.risk, { score: 65, level: "HIGH" });
  assert.equal(result.details.results.length, 3);
});

test("returns PARTIAL when one FULL specialist fails", async () => {
  const coordinator = createCoordinator({
    adapters: {
      address: adapter("address-intelligence", "0.1.0", async () => ({
        risk: { score: 10, level: "LOW" },
        confidence: "full",
      })),
      contract: adapter("contract-inspector", "1.1.0", async () => {
        throw new Error("private upstream detail");
      }),
    },
  });

  const result = await coordinator.assess(
    request("FULL", { address: ADDRESS, network: "mainnet" })
  );

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.confidence, "PARTIAL");
  assert.equal(result.warnings[0].code, "SPECIALIST_FAILED");
  assert.doesNotMatch(result.warnings[0].message, /private upstream/i);
});

test("returns TIMEOUT and aborts the adapter when the budget expires", async () => {
  let aborted = false;
  const coordinator = createCoordinator({
    adapters: {
      address: adapter("address-intelligence", "0.1.0", async (_request, context) => {
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        return {};
      }),
    },
    defaultDeadlineMs: 20,
  });

  const result = await coordinator.assess(
    request("ADDRESS", { address: ADDRESS, network: "mainnet" })
  );

  assert.equal(result.status, "TIMEOUT");
  assert.equal(aborted, true);
});

test("coalesces concurrent identical requests and serves later cache hits", async () => {
  let calls = 0;
  const coordinator = createCoordinator({
    adapters: {
      address: adapter("address-intelligence", "0.1.0", async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { risk: { score: 5, level: "LOW" }, confidence: "full" };
      }),
    },
    cacheTtlMs: 1000,
  });
  const input = request("ADDRESS", { address: ADDRESS, network: "mainnet" });

  const [first, second] = await Promise.all([
    coordinator.assess(input),
    coordinator.assess(input),
  ]);
  const third = await coordinator.assess(input);

  assert.equal(calls, 1);
  assert.equal(first.details.cache.status, "MISS");
  assert.equal(second.details.cache.status, "COALESCED");
  assert.equal(third.details.cache.status, "HIT");
});

test("bounded TTL cache evicts least-recently-used values and expires entries", () => {
  let now = 100;
  const cache = new BoundedTtlCache({ maxEntries: 2, now: () => now });
  cache.set("a", 1, 10);
  cache.set("b", 2, 10);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3, 10);
  assert.equal(cache.get("b"), undefined);
  now += 11;
  assert.equal(cache.get("a"), undefined);
});

test("adapter definitions require stable module metadata and an assess function", () => {
  const valid = defineAdapter({
    module: "address-intelligence",
    version: "0.1.0",
    assess: async () => ({}),
  });
  assert.equal(valid.module, "address-intelligence");
  assert.throws(
    () => defineAdapter({ module: "broken", version: "1.0.0" }),
    /assess must be a function/i
  );
});

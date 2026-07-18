import assert from "node:assert/strict";
import test from "node:test";
import { analyzeAddress, formatUnits } from "../scripts/lib/analyze.mjs";

test("rejects malformed addresses before making RPC calls", async () => {
  await assert.rejects(
    () => analyzeAddress("0xnot-an-address", "pacific_mainnet", { offline: true }),
    /Invalid address/
  );
});

test("rejects unknown networks before making RPC calls", async () => {
  await assert.rejects(
    () => analyzeAddress("0x0000000000000000000000000000000000000001", "unknown_net", { offline: true }),
    /Unknown network/
  );
});

test("formats raw integer token units into decimal strings", () => {
  assert.equal(formatUnits("0xde0b6b3a7640000", 18), "1");
  assert.equal(formatUnits("0x5f5e100", 6), "100");
  assert.equal(formatUnits("0xf4241", 6), "1.000001");
});

test("discovers explorer token holdings and starts explorer calls in parallel", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  let inFlight = 0;
  let maxInFlight = 0;
  const fakeRpc = {
    getCode: async () => "0x1234",
    getBalance: async () => "0x0",
    ethCallSafe: async () => ({ ok: true, data: "0x0" }),
    call: async (method) => {
      assert.equal(method, "eth_getTransactionCount");
      return "0x1";
    },
  };
  const fakeResponse = (json) => ({
    ok: true,
    json: async () => json,
  });
  const fakeFetch = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;

    if (url.includes(`/addresses/${address}/tokens`)) {
      return fakeResponse({
        items: [
          {
            value: "123450000",
            token: {
              address: "0x2222222222222222222222222222222222222222",
              symbol: "DYN",
              name: "Dynamic Token",
              decimals: "6",
              type: "ERC-20",
            },
          },
        ],
      });
    }
    if (url.endsWith(`/smart-contracts/${address.toLowerCase()}`)) {
      return fakeResponse({ name: "Verified Vault", is_verified: true });
    }
    if (url.includes(`/addresses/${address.toLowerCase()}/transactions`)) {
      return fakeResponse({
        items: [
          {
            timestamp: "2026-07-01T00:00:00.000Z",
            to: { hash: "0x3333333333333333333333333333333333333333" },
          },
          {
            timestamp: "2026-07-09T00:00:00.000Z",
            to: { hash: "0x3333333333333333333333333333333333333333" },
          },
        ],
      });
    }
    if (url.endsWith(`/addresses/${address.toLowerCase()}`)) {
      return fakeResponse({ transactions_count: 12 });
    }
    if (url.includes("/smart-contracts/0x3333333333333333333333333333333333333333")) {
      return fakeResponse({ name: "Protocol Router", is_verified: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const data = await analyzeAddress(address, "pacific_mainnet", {
    rpc: fakeRpc,
    fetch: fakeFetch,
  });

  assert.ok(maxInFlight >= 4);
  assert.equal(data.tokenDiscovery.available, true);
  assert.deepEqual(data.tokenHoldings, [
    {
      symbol: "DYN",
      address: "0x2222222222222222222222222222222222222222",
      balance: "123.45",
      source: "explorer",
      name: "Dynamic Token",
    },
  ]);
  assert.equal(data.contractInfo.name, "Verified Vault");
  assert.equal(data.activity.protocols[0].name, "Protocol Router");
});

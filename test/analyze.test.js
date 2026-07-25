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

test("degrades without calling SocialScan when its API key is missing", async () => {
  let explorerCalls = 0;
  const fakeRpc = {
    getCode: async () => "0x",
    getBalance: async () => "0x0",
    ethCallSafe: async () => ({ ok: true, data: "0x0" }),
    call: async () => "0x0",
  };

  const data = await analyzeAddress(
    "0x0000000000000000000000000000000000000001",
    "pacific_mainnet",
    {
      rpc: fakeRpc,
      explorerApiKey: "",
      fetch: async () => {
        explorerCalls += 1;
        throw new Error("must not fetch");
      },
    }
  );

  assert.equal(explorerCalls, 0);
  assert.equal(data.activity.available, false);
  assert.equal(data.activity.reason, "missing SocialScan API key");
  assert.equal(data.tokenDiscovery.reason, "missing SocialScan API key");
  assert.equal(data.confidence, "partial (explorer unavailable)");
});

test("marks the tracked token scan incomplete when an RPC balance call fails", async () => {
  const fakeRpc = {
    getCode: async () => "0x",
    getBalance: async () => "0x0",
    ethCallSafe: async (tokenAddress) => ({
      ok: false,
      error: `failed ${tokenAddress}`,
    }),
    call: async () => "0x0",
  };

  const data = await analyzeAddress(
    "0x0000000000000000000000000000000000000001",
    "pacific_mainnet",
    { rpc: fakeRpc, offline: true }
  );

  assert.equal(data.tokenScan.complete, false);
  assert.equal(data.tokenScan.failures.length, 4);
  assert.equal(data.tokenScan.failures[0].symbol, "WPROS");
  assert.match(data.tokenScan.failures[0].reason, /failed 0x/i);
  assert.equal(data.confidence, "partial (token scan incomplete)");
});

test("maps SocialScan enrichment and starts explorer calls in parallel", async () => {
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
  const fakeFetch = async (url, options) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;

    const parsed = new URL(url);
    assert.equal(options.headers["x-api-key"], "test-secret");
    const action = parsed.searchParams.get("action");
    const requestedAddress = parsed.searchParams.get("address");

    if (action === "addresstokenbalance") {
      return fakeResponse({
        status: "1",
        message: "OK",
        result: [
          {
            TokenQuantity: "123450000",
            tokenAddress: "0x2222222222222222222222222222222222222222",
            tokenSymbol: "DYN",
            tokenName: "Dynamic Token",
            tokenDecimal: "6",
          },
        ],
      });
    }
    if (action === "getsourcecode" && requestedAddress === address.toLowerCase()) {
      return fakeResponse({
        status: "1",
        message: "OK",
        result: [
          {
            ContractName: "Verified Vault",
            SourceCode: "contract Vault {}",
            ABI: "[]",
          },
        ],
      });
    }
    if (action === "txlist") {
      const ascending = parsed.searchParams.get("sort") === "asc";
      return fakeResponse({
        status: "1",
        message: "OK",
        result: [
          {
            hash: ascending ? "0xaaa" : "0xbbb",
            timeStamp: ascending ? "1782864000" : "1783555200",
            to: "0x3333333333333333333333333333333333333333",
          },
        ],
      });
    }
    if (
      action === "getsourcecode" &&
      requestedAddress === "0x3333333333333333333333333333333333333333"
    ) {
      return fakeResponse({
        status: "1",
        message: "OK",
        result: [
          {
            ContractName: "Protocol Router",
            SourceCode: "contract Router {}",
            ABI: "[]",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const data = await analyzeAddress(address, "pacific_mainnet", {
    rpc: fakeRpc,
    fetch: fakeFetch,
    explorerApiKey: "test-secret",
    explorerActivityPageSize: 1,
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
  assert.equal(data.activity.historyComplete, false);
  assert.equal(data.confidence, "partial (activity history sampled)");
});

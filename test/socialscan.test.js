import assert from "node:assert/strict";
import test from "node:test";
import { createSocialScanProvider } from "../scripts/lib/socialscan.mjs";

const BASE_URL = "https://api.socialscan.io/pharos-mainnet/v1/developer/api";
const ADDRESS = "0x0000000000000000000000000000000000000001";

function response(result, { status = "1", message = "OK", httpStatus = 200 } = {}) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: async () => ({ status, message, result }),
  };
}

test("requires an API key without attempting a request", async () => {
  let calls = 0;
  const provider = createSocialScanProvider({
    baseUrl: BASE_URL,
    apiKey: "",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });

  assert.deepEqual(await provider.contractInfo(ADDRESS), {
    available: false,
    reason: "missing SocialScan API key",
  });
  assert.equal(calls, 0);
});

test("maps verified contract source and sends the API key only in a header", async () => {
  let request;
  const provider = createSocialScanProvider({
    baseUrl: BASE_URL,
    apiKey: "test-secret",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response([
        {
          ContractName: "Verified Vault",
          SourceCode: "contract VerifiedVault {}",
          ABI: "[]",
        },
      ]);
    },
  });

  assert.deepEqual(await provider.contractInfo(ADDRESS), {
    available: true,
    name: "Verified Vault",
    verified: true,
  });
  assert.equal(new URL(request.url).searchParams.get("action"), "getsourcecode");
  assert.equal(new URL(request.url).searchParams.has("apikey"), false);
  assert.equal(request.options.headers["x-api-key"], "test-secret");
});

test("maps sampled transaction activity conservatively", async () => {
  const destination = "0x2222222222222222222222222222222222222222";
  const calls = [];
  const provider = createSocialScanProvider({
    baseUrl: BASE_URL,
    apiKey: "test-secret",
    activityPageSize: 2,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const action = parsed.searchParams.get("action");
      if (action === "txlist" && parsed.searchParams.get("sort") === "asc") {
        return response([
          {
            hash: "0xaaa",
            timeStamp: "1782864000",
            to: destination,
          },
          {
            hash: "0xbbb",
            timeStamp: "1782950400",
            to: destination,
          },
        ]);
      }
      if (action === "txlist" && parsed.searchParams.get("sort") === "desc") {
        return response([
          {
            hash: "0xccc",
            timeStamp: "1783555200",
            to: destination,
          },
          {
            hash: "0xbbb",
            timeStamp: "1782950400",
            to: destination,
          },
        ]);
      }
      if (action === "getsourcecode") {
        return response([
          {
            ContractName: "Protocol Router",
            SourceCode: "contract Router {}",
            ABI: "[]",
          },
        ]);
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  const activity = await provider.activity(ADDRESS);

  assert.equal(activity.available, true);
  assert.equal(activity.historyComplete, false);
  assert.equal(activity.txCount, 3);
  assert.equal(activity.recentCount, 3);
  assert.equal(activity.firstSeen, "2026-07-01T00:00:00.000Z");
  assert.equal(activity.lastSeen, "2026-07-09T00:00:00.000Z");
  assert.equal(activity.uniqueContracts, 1);
  assert.deepEqual(activity.protocols, [
    { address: destination, name: "Protocol Router", verified: true },
  ]);
  assert.equal(calls.filter((url) => url.searchParams.get("action") === "txlist").length, 2);
});

test("maps discovered ERC-20 balances and rejects malformed entries", async () => {
  const provider = createSocialScanProvider({
    baseUrl: BASE_URL,
    apiKey: "test-secret",
    fetchImpl: async () =>
      response([
        {
          tokenAddress: "0x3333333333333333333333333333333333333333",
          tokenName: "Dynamic Token",
          tokenSymbol: "DYN",
          tokenDecimal: "6",
          TokenQuantity: "123450000",
        },
        {
          tokenAddress: "not-an-address",
          tokenSymbol: "BAD",
          tokenDecimal: "18",
          TokenQuantity: "1",
        },
      ]),
  });

  assert.deepEqual(await provider.tokenHoldings(ADDRESS), {
    available: true,
    source: "explorer",
    count: 1,
    holdings: [
      {
        symbol: "DYN",
        name: "Dynamic Token",
        address: "0x3333333333333333333333333333333333333333",
        balance: "123.45",
        source: "explorer",
      },
    ],
  });
});

test("does not expose an untrusted upstream message in invalid-response errors", async () => {
  const provider = createSocialScanProvider({
    baseUrl: BASE_URL,
    apiKey: "test-secret",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "0",
        message: "secret internal upstream detail",
        result: null,
      }),
    }),
  });

  const info = await provider.contractInfo(ADDRESS);

  assert.equal(info.available, false);
  assert.equal(info.reason, "SocialScan invalid response");
});

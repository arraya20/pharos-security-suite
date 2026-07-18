import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "../scripts/server.mjs";

const sampleAnalysis = {
  address: "0x0000000000000000000000000000000000000001",
  network: "Pharos Pacific Mainnet",
  chainId: 1672,
  analyzedAt: "2026-07-09T00:00:00.000Z",
  addressType: "EOA",
  nativeBalanceWei: "0x0",
  nativeBalance: "0",
  tokenHoldings: [],
  nonce: 0,
  activity: { available: false, reason: "offline mode" },
  confidence: "partial (explorer unavailable)",
};

async function withServer(options, fn) {
  const server = createServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("returns service health", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      service: "pharos-address-intelligence",
    });
  });
});

test("analyzes an address through the HTTP API", async () => {
  const calls = [];

  await withServer(
    {
      analyze: async (address, network, opts) => {
        calls.push({ address, network, opts });
        return { ...sampleAnalysis, address };
      },
    },
    async (baseUrl) => {
      const address = "0x0000000000000000000000000000000000000001";
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, network: "mainnet", offline: true }),
      });

      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-cache"), "MISS");
      assert.deepEqual(calls, [
        {
          address,
          network: "pacific_mainnet",
          opts: { offline: true },
        },
      ]);
      assert.equal(json.classification.label, "EOA - New");
      assert.equal(json.risk.score, 40);
      assert.equal(json.risk.level, "MODERATE");
    }
  );
});

test("serves duplicate analyze requests from cache", async () => {
  let calls = 0;

  await withServer(
    {
      cacheTtlMs: 60_000,
      analyze: async () => {
        calls += 1;
        return sampleAnalysis;
      },
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: sampleAnalysis.address,
        network: "mainnet",
        offline: true,
      });

      const first = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const second = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.headers.get("x-cache"), "MISS");
      assert.equal(second.headers.get("x-cache"), "HIT");
      assert.equal(calls, 1);
    }
  );
});

test("rejects malformed JSON bodies", async () => {
  await withServer(
    {
      analyze: async () => {
        throw new Error("analyze should not be called");
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad json",
      });
      const json = await res.json();

      assert.equal(res.status, 400);
      assert.equal(typeof json.error, "string");
    }
  );
});

test("rejects analyze requests without an address", async () => {
  await withServer(
    {
      analyze: async () => {
        throw new Error("analyze should not be called");
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "mainnet" }),
      });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "missing 'address'" });
    }
  );
});

test("rejects analyze payloads over the configured body limit", async () => {
  await withServer(
    {
      maxBodyBytes: 16,
      analyze: async () => {
        throw new Error("analyze should not be called");
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: "0x0000000000000000000000000000000000000001",
        }),
      });

      assert.equal(res.status, 413);
      assert.deepEqual(await res.json(), { error: "request body too large" });
    }
  );
});

test("rate limits repeated analyze requests from the same client", async () => {
  await withServer(
    {
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
      analyze: async () => sampleAnalysis,
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: "0x0000000000000000000000000000000000000001",
        network: "mainnet",
        offline: true,
      });
      const first = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const second = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error, "rate limit exceeded");
    }
  );
});

test("ignores forwarded client IPs unless proxy trust is enabled", async () => {
  await withServer(
    {
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
      trustProxy: false,
      analyze: async () => sampleAnalysis,
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: "0x0000000000000000000000000000000000000001",
        network: "mainnet",
        offline: true,
      });
      const first = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
        body,
      });
      const second = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.11" },
        body,
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
    }
  );
});

test("uses forwarded client IPs for rate limiting when proxy trust is enabled", async () => {
  await withServer(
    {
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
      trustProxy: true,
      analyze: async () => sampleAnalysis,
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: "0x0000000000000000000000000000000000000001",
        network: "mainnet",
        offline: true,
      });
      const first = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
        body,
      });
      const second = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.11" },
        body,
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    }
  );
});

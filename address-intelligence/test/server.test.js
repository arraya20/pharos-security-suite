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
      assert.equal(calls.length, 1);
      assert.equal(calls[0].address, address);
      assert.equal(calls[0].network, "pacific_mainnet");
      assert.equal(calls[0].opts.offline, true);
      assert.ok(calls[0].opts.signal instanceof AbortSignal);
      assert.equal(calls[0].opts.signal.aborted, false);
      assert.ok(calls[0].opts.deadline > Date.now());
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

test("normalizes address casing in cache keys and bounds cache entries", async () => {
  let calls = 0;

  await withServer(
    {
      cacheTtlMs: 60_000,
      cacheMaxEntries: 1,
      analyze: async (address) => {
        calls += 1;
        return { ...sampleAnalysis, address };
      },
    },
    async (baseUrl) => {
      const request = (address) =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, network: "mainnet", offline: true }),
        });
      const firstAddress = "0x00000000000000000000000000000000000000aA";
      const secondAddress = "0x00000000000000000000000000000000000000bB";

      assert.equal((await request(firstAddress)).headers.get("x-cache"), "MISS");
      assert.equal((await request(firstAddress.toLowerCase())).headers.get("x-cache"), "HIT");
      assert.equal((await request(secondAddress)).headers.get("x-cache"), "MISS");
      assert.equal((await request(firstAddress)).headers.get("x-cache"), "MISS");
      assert.equal(calls, 3);
    }
  );
});

test("coalesces identical in-flight analyses", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  await withServer(
    {
      analyze: async () => {
        calls += 1;
        await pending;
        return sampleAnalysis;
      },
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: sampleAnalysis.address,
        network: "mainnet",
        offline: true,
      });
      const request = () =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

      const first = request();
      const second = request();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls, 1);
      release();

      const [firstRes, secondRes] = await Promise.all([first, second]);
      assert.deepEqual(
        [firstRes.headers.get("x-cache"), secondRes.headers.get("x-cache")].sort(),
        ["COALESCED", "MISS"]
      );
    }
  );
});

test("enforces a global upstream budget while allowing cache hits", async () => {
  let calls = 0;

  await withServer(
    {
      upstreamBudgetMax: 1,
      upstreamBudgetWindowMs: 60_000,
      analyze: async (address) => {
        calls += 1;
        return { ...sampleAnalysis, address };
      },
    },
    async (baseUrl) => {
      const request = (address) =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, network: "mainnet", offline: true }),
        });

      const first = await request(sampleAnalysis.address);
      const cached = await request(sampleAnalysis.address.toUpperCase().replace("0X", "0x"));
      const limited = await request("0x0000000000000000000000000000000000000002");

      assert.equal(first.status, 200);
      assert.equal(cached.status, 200);
      assert.equal(cached.headers.get("x-cache"), "HIT");
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error, "upstream request budget exceeded");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.equal(calls, 1);
    }
  );
});

test("rejects excess concurrent analyses without starting upstream work", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  await withServer(
    {
      maxConcurrentAnalyses: 1,
      analyze: async (address) => {
        calls += 1;
        await pending;
        return { ...sampleAnalysis, address };
      },
    },
    async (baseUrl) => {
      const request = (address) =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, network: "mainnet", offline: true }),
        });
      const firstPromise = request(sampleAnalysis.address);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const busy = await request("0x0000000000000000000000000000000000000002");
      assert.equal(busy.status, 503);
      assert.equal((await busy.json()).error, "analysis capacity exceeded");
      assert.equal(calls, 1);

      release();
      assert.equal((await firstPromise).status, 200);
    }
  );
});

test("aborts analysis at the overall deadline and returns 504", async () => {
  let received;

  await withServer(
    {
      requestTimeoutMs: 20,
      analyze: async (_address, _network, opts) => {
        received = opts;
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted upstream work");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        });
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: sampleAnalysis.address,
          network: "mainnet",
          offline: true,
        }),
      });

      assert.equal(res.status, 504);
      assert.deepEqual(await res.json(), { error: "analysis deadline exceeded" });
      assert.equal(received.signal.aborted, true);
      assert.ok(Number.isFinite(received.deadline));
    }
  );
});

test("keeps timed-out analysis counted until upstream settles", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const upstream = new Promise((resolve) => { release = resolve; });
  await withServer(
    {
      requestTimeoutMs: 5,
      maxConcurrentAnalyses: 1,
      analyze: async (_address, _network, opts) => {
        started();
        opts.signal.addEventListener("abort", () => {});
        await upstream;
        return { ...sampleAnalysis, address: _address };
      },
    },
    async (baseUrl) => {
      const request = (address) => fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, network: "mainnet", offline: true }),
      });
      const firstPromise = request(sampleAnalysis.address);
      await startedPromise;
      const first = await firstPromise;
      assert.equal(first.status, 504);
      const second = await request("0x0000000000000000000000000000000000000002");
      assert.equal(second.status, 503);
      assert.equal((await second.json()).error, "analysis capacity exceeded");
      release();
    }
  );
});

test("reports analyzer failures as upstream errors instead of invalid input", async () => {
  await withServer(
    {
      analyze: async () => {
        throw new Error("RPC HTTP 503 for eth_getBalance");
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: sampleAnalysis.address,
          network: "mainnet",
          offline: true,
        }),
      });

      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "upstream analysis failed" });
    }
  );
});

test("rejects structurally invalid reports and does not cache them", async () => {
  let calls = 0;
  await withServer(
    {
      analyze: async () => {
        calls += 1;
        return sampleAnalysis;
      },
      build: () => ({ bogus: true }),
    },
    async (baseUrl) => {
      const request = () => fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: sampleAnalysis.address,
          network: "mainnet",
          offline: true,
        }),
      });

      assert.equal((await request()).status, 500);
      assert.equal((await request()).status, 500);
      assert.equal(calls, 2);
    }
  );
});

test("maps structured analyzer validation errors to 400", async () => {
  await withServer(
    {
      analyze: async () => {
        const error = new Error("address failed analyzer validation");
        error.code = "INVALID_ADDRESS";
        throw error;
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: sampleAnalysis.address,
          network: "mainnet",
          offline: true,
        }),
      });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "invalid 'address'" });
    }
  );
});

test("keeps invalid requests at 400 and reports rendering failures as internal", async () => {
  await withServer(
    {
      analyze: async () => sampleAnalysis,
      build: () => {
        throw new Error("unexpected report invariant");
      },
    },
    async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "not-an-address", network: "mainnet" }),
      });
      const internal = await fetch(`${baseUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: sampleAnalysis.address, network: "mainnet" }),
      });

      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "invalid 'address'");
      assert.equal(internal.status, 500);
      assert.deepEqual(await internal.json(), { error: "internal report failure" });
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

test("bounds rate-limit buckets and lazily removes expired entries", async () => {
  await withServer(
    {
      rateLimitMax: 10,
      rateLimitWindowMs: 20,
      rateLimitMaxBuckets: 1,
      trustProxy: true,
      trustedProxyHops: 1,
      analyze: async () => sampleAnalysis,
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: sampleAnalysis.address,
        network: "mainnet",
        offline: true,
      });
      const request = (forwardedFor) =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
          body,
        });

      assert.equal((await request("203.0.113.10")).status, 200);
      assert.equal((await request("203.0.113.11")).status, 429);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await request("203.0.113.11")).status, 200);
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

test("uses the right-most forwarded address behind one trusted proxy", async () => {
  await withServer(
    {
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
      trustProxy: true,
      trustedProxyHops: 1,
      analyze: async () => sampleAnalysis,
    },
    async (baseUrl) => {
      const body = JSON.stringify({
        address: sampleAnalysis.address,
        network: "mainnet",
        offline: true,
      });
      const request = (forwardedFor) =>
        fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
          body,
        });

      const first = await request("198.51.100.1, 203.0.113.10");
      const spoofed = await request("198.51.100.2, 203.0.113.10");

      assert.equal(first.status, 200);
      assert.equal(spoofed.status, 429);
    }
  );
});

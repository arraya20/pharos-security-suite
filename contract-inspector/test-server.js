#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "./server.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const SECOND_ADDRESS = "0x0000000000000000000000000000000000000002";

async function withServer(options, fn) {
  const server = createServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

{
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
}

{
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "bad_request");
  });
}

{
  await withServer({ maxBodyBytes: 8 }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: ADDRESS }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "payload_too_large");
  });
}

{
  let calls = 0;
  await withServer(
    {
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
      inspect: async () => {
        calls += 1;
        return { address: ADDRESS, type: "EOA" };
      },
    },
    async (baseUrl) => {
      const request = () =>
        fetch(`${baseUrl}/inspect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: ADDRESS }),
        });
      assert.equal((await request()).status, 200);
      const limited = await request();
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error, "rate_limited");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.equal(calls, 1);
    },
  );
}

{
  await withServer(
    {
      inspect: async () => {
        throw new Error("RPC token and internal endpoint details");
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ADDRESS }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error, "upstream_error");
      assert.doesNotMatch(payload.message, /token|endpoint/i);
    },
  );
}

{
  let calls = 0;
  await withServer(
    {
      inspect: async () => {
        calls += 1;
        return { bogus: true };
      },
    },
    async (baseUrl) => {
      const request = () => fetch(`${baseUrl}/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ADDRESS }),
      });
      assert.equal((await request()).status, 502);
      assert.equal((await request()).status, 502);
      assert.equal(calls, 2, "invalid reports must not be cached");
    },
  );
}

{
  let calls = 0;
  await withServer(
    {
      cacheTtlMs: 60_000,
      inspect: async () => {
        calls += 1;
        return { address: ADDRESS, type: "Contract" };
      },
    },
    async (baseUrl) => {
      const request = (address) =>
        fetch(`${baseUrl}/inspect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address }),
        });
      assert.equal((await request(ADDRESS)).status, 200);
      const cached = await request(ADDRESS.toUpperCase().replace("0X", "0x"));
      assert.equal(cached.status, 200);
      assert.equal(cached.headers.get("x-cache"), "HIT");
      assert.equal(calls, 1);
    },
  );
}

{
  let calls = 0;
  await withServer(
    {
      inspect: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { address: ADDRESS, type: "Contract" };
      },
    },
    async (baseUrl) => {
      const request = () =>
        fetch(`${baseUrl}/inspect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: ADDRESS }),
        });
      const [first, second] = await Promise.all([request(), request()]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);
    },
  );
}

{
  let aborted = false;
  await withServer(
    {
      requestTimeoutMs: 5,
      inspect: async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({});
        });
      }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ADDRESS }),
      });
      assert.equal(response.status, 504);
      assert.equal((await response.json()).error, "inspection_timeout");
    },
  );
  assert.equal(aborted, true);
}

{
  await withServer(
    {
      allowCustomRpc: true,
      inspect: async () => ({ address: ADDRESS, type: "Contract" }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ADDRESS,
          rpc: "http://169.254.169.254/latest/meta-data",
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "custom_rpc_forbidden");
    },
  );
}

{
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await withServer(
    {
      maxConcurrentInspections: 1,
      inspect: async ({ address }) => {
        if (address === ADDRESS) {
          started();
          await blocked;
        }
        return { address, type: "Contract" };
      },
    },
    async (baseUrl) => {
      const request = (address) => fetch(`${baseUrl}/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const first = request(ADDRESS);
      await startedPromise;
      const overloaded = await Promise.race([
        request(SECOND_ADDRESS),
        new Promise((resolve) => setTimeout(() => resolve("queued"), 50)),
      ]);
      assert.notEqual(overloaded, "queued");
      assert.equal(overloaded.status, 503);
      assert.equal((await overloaded.json()).error, "inspection_capacity_exceeded");
      release();
      assert.equal((await first).status, 200);
    },
  );
}

console.log("server tests passed");

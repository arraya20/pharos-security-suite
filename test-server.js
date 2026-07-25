#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "./server.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";

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

console.log("server tests passed");

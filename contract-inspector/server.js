#!/usr/bin/env node
// server.js — tiny dependency-free HTTP API wrapper around the inspector.
// POST /inspect { address, network?, rpc?, offline? }

import http from "node:http";
import { inspectContract, jsonStringify } from "./lib/inspect-core.js";

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const ALLOW_CUSTOM_RPC = process.env.ALLOW_CUSTOM_RPC === "1";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(jsonStringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, service: "pharos-contract-inspector", endpoints: ["POST /inspect"] });
    }

    if (req.method !== "POST" || req.url !== "/inspect") {
      return send(res, 404, { ok: false, error: "not_found", message: "Use GET /health or POST /inspect" });
    }

    const body = await readJson(req);
    const address = body.address || body.contractAddress;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address || "")) {
      return send(res, 400, { ok: false, error: "bad_request", message: "address or contractAddress must be a valid EVM address" });
    }

    if (body.rpc && !ALLOW_CUSTOM_RPC) {
      return send(res, 400, { ok: false, error: "custom_rpc_disabled", message: "Custom RPC URLs are disabled for HTTP API by default. Set ALLOW_CUSTOM_RPC=1 only for trusted/local deployments." });
    }

    const report = await inspectContract({
      address,
      network: body.network || "testnet",
      rpcUrl: body.rpc || null,
      online: body.offline ? false : true,
    });

    return send(res, 200, { ok: true, report });
  } catch (e) {
    return send(res, 500, { ok: false, error: "internal_error", message: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pharos Contract Inspector API listening on http://${HOST}:${PORT}`);
  console.log(`GET /health, POST /inspect`);
});

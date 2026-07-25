#!/usr/bin/env node
// Dependency-free HTTP API wrapper around the inspector.
// POST /inspect { address, network?, rpc?, offline? }

import http from "node:http";
import { fileURLToPath } from "node:url";
import { inspectContract, jsonStringify } from "./lib/inspect-core.js";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = envNumber("MAX_BODY_BYTES", 64 * 1024);
const DEFAULT_RATE_LIMIT_MAX = envNumber("RATE_LIMIT_MAX", 60);
const DEFAULT_RATE_LIMIT_WINDOW_MS = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = envNumber("RATE_LIMIT_MAX_BUCKETS", 10_000);
const DEFAULT_REQUEST_TIMEOUT_MS = envNumber("REQUEST_TIMEOUT_MS", 20_000);
const DEFAULT_ALLOW_CUSTOM_RPC = process.env.ALLOW_CUSTOM_RPC === "1";

class ServiceError extends Error {
  constructor(status, code, publicMessage, headers = {}) {
    super(publicMessage);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.headers = headers;
  }
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(jsonStringify(body));
}

async function readJson(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) {
      throw new ServiceError(
        413,
        "payload_too_large",
        `Request body exceeds ${maxBodyBytes} bytes`,
      );
    }
    chunks.push(bytes);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ServiceError(400, "bad_request", "Malformed JSON body");
  }
}

function parseInspectPayload(body, allowCustomRpc) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ServiceError(400, "bad_request", "JSON body must be an object");
  }

  const address = body.address ?? body.contractAddress;
  if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new ServiceError(
      400,
      "bad_request",
      "address or contractAddress must be a valid EVM address",
    );
  }

  const network = body.network ?? "testnet";
  if (typeof network !== "string") {
    throw new ServiceError(400, "bad_request", "network must be a string");
  }
  const offline = body.offline ?? false;
  if (typeof offline !== "boolean") {
    throw new ServiceError(400, "bad_request", "offline must be a boolean");
  }
  if (body.rpc != null && typeof body.rpc !== "string") {
    throw new ServiceError(400, "bad_request", "rpc must be a string");
  }
  if (body.rpc && !allowCustomRpc) {
    throw new ServiceError(
      400,
      "custom_rpc_disabled",
      "Custom RPC URLs are disabled for the HTTP API",
    );
  }

  return {
    address,
    network,
    rpcUrl: body.rpc || null,
    online: !offline,
  };
}

function retryAfterSeconds(resetAt) {
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

export function createServer({
  inspect = inspectContract,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitMaxBuckets = DEFAULT_RATE_LIMIT_MAX_BUCKETS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  allowCustomRpc = DEFAULT_ALLOW_CUSTOM_RPC,
} = {}) {
  const buckets = new Map();

  function checkRateLimit(req) {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }

    const key = req.socket.remoteAddress || "unknown";
    const current = buckets.get(key);
    if (current) {
      current.count += 1;
      return {
        ok: current.count <= rateLimitMax,
        resetAt: current.resetAt,
      };
    }
    if (buckets.size >= rateLimitMaxBuckets) {
      return { ok: false, resetAt: now + rateLimitWindowMs };
    }

    const resetAt = now + rateLimitWindowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: rateLimitMax >= 1, resetAt };
  }

  return http.createServer(async (req, res) => {
    req.setTimeout(requestTimeoutMs, () => {
      send(res, 408, {
        ok: false,
        error: "request_timeout",
        message: "Request timed out",
      });
    });

    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, {
          ok: true,
          service: "pharos-contract-inspector",
          endpoints: ["POST /inspect"],
        });
      }

      if (req.method !== "POST" || req.url !== "/inspect") {
        return send(res, 404, {
          ok: false,
          error: "not_found",
          message: "Use GET /health or POST /inspect",
        });
      }

      const limit = checkRateLimit(req);
      if (!limit.ok) {
        throw new ServiceError(
          429,
          "rate_limited",
          "Too many requests",
          { "retry-after": retryAfterSeconds(limit.resetAt) },
        );
      }

      const body = await readJson(req, maxBodyBytes);
      const input = parseInspectPayload(body, allowCustomRpc);
      let report;
      try {
        report = await inspect(input);
      } catch {
        throw new ServiceError(
          502,
          "upstream_error",
          "Contract inspection failed",
        );
      }
      return send(res, 200, { ok: true, report });
    } catch (error) {
      if (error instanceof ServiceError) {
        return send(
          res,
          error.status,
          {
            ok: false,
            error: error.code,
            message: error.publicMessage,
          },
          error.headers,
        );
      }
      return send(res, 500, {
        ok: false,
        error: "internal_error",
        message: "Internal server error",
      });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Pharos Contract Inspector API listening on http://${HOST}:${PORT}`);
    console.log("GET /health, POST /inspect");
  });
}

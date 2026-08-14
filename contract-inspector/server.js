#!/usr/bin/env node
// Dependency-free HTTP API wrapper around the inspector.
// POST /inspect { address, network?, offline? }

import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectContract, jsonStringify } from "./lib/inspect-core.js";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || process.env.AUTH_TOKEN || null;
const DEFAULT_MAX_BODY_BYTES = envNumber("MAX_BODY_BYTES", 64 * 1024);
const DEFAULT_RATE_LIMIT_MAX = envNumber("RATE_LIMIT_MAX", 60);
const DEFAULT_RATE_LIMIT_WINDOW_MS = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = envNumber("RATE_LIMIT_MAX_BUCKETS", 10_000);
const DEFAULT_REQUEST_TIMEOUT_MS = envNumber("REQUEST_TIMEOUT_MS", 20_000);
const DEFAULT_CACHE_TTL_MS = envNumber("CACHE_TTL_MS", 15_000);
const DEFAULT_CACHE_MAX_ENTRIES = envNumber("CACHE_MAX_ENTRIES", 500);
const DEFAULT_MAX_CONCURRENT_INSPECTIONS = envNumber("MAX_CONCURRENT_INSPECTIONS", 4);

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

function parseInspectPayload(body) {
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
  if (body.rpc != null) {
    throw new ServiceError(
      400,
      "custom_rpc_forbidden",
      "Custom RPC URLs are not accepted by the HTTP API",
    );
  }

  return {
    address,
    network,
    online: !offline,
  };
}

function retryAfterSeconds(resetAt) {
  return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function hasValidAuth(req, apiKey) {
  const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer || req.headers["x-api-key"];
  if (!apiKey || typeof supplied !== "string") return false;
  const expected = Buffer.from(apiKey);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validateInspectionReport(report, input) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    typeof report.address !== "string" ||
    report.address.toLowerCase() !== input.address.toLowerCase() ||
    !["EOA", "Contract"].includes(report.type)
  ) {
    throw new TypeError("invalid contract inspection report");
  }
  if (
    report.risk !== undefined &&
    (!report.risk ||
      typeof report.risk !== "object" ||
      !Number.isFinite(report.risk.score) ||
      report.risk.score < 0 ||
      report.risk.score > 100)
  ) {
    throw new TypeError("invalid contract inspection risk");
  }
  return report;
}

export function createServer({
  inspect = inspectContract,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitMaxBuckets = DEFAULT_RATE_LIMIT_MAX_BUCKETS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  maxConcurrentInspections = DEFAULT_MAX_CONCURRENT_INSPECTIONS,
  host = HOST,
  apiKey = API_KEY,
} = {}) {
  if (!Number.isInteger(maxConcurrentInspections) || maxConcurrentInspections < 1) {
    throw new TypeError("maxConcurrentInspections must be a positive integer");
  }
  if (!isLoopbackHost(host) && !apiKey) {
    throw new TypeError("API_KEY is required when HOST is non-local");
  }
  const buckets = new Map();
  const cache = new Map();
  const inFlight = new Map();
  let activeInspections = 0;

  function cacheKey(input) {
    return JSON.stringify({
      address: input.address.toLowerCase(),
      network: input.network,
      online: input.online,
    });
  }

  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.report;
  }

  function cacheReport(key, report) {
    cache.delete(key);
    cache.set(key, { report, expiresAt: Date.now() + cacheTtlMs });
    while (cache.size > cacheMaxEntries) {
      cache.delete(cache.keys().next().value);
    }
  }

  async function inspectOnce(input) {
    const key = cacheKey(input);
    const hit = cached(key);
    if (hit) return { report: hit, cacheStatus: "HIT" };
    if (inFlight.has(key)) {
      return { report: await inFlight.get(key), cacheStatus: "COALESCED" };
    }
    if (activeInspections >= maxConcurrentInspections) {
      throw new ServiceError(
        503,
        "inspection_capacity_exceeded",
        "Inspection capacity is full; retry shortly",
        { "retry-after": "1" },
      );
    }

    const controller = new AbortController();
    activeInspections += 1;
    let timeout;
    const workPromise = Promise.resolve()
      .then(() => inspect({ ...input, signal: controller.signal }))
      .then((report) => {
        validateInspectionReport(report, input);
        cacheReport(key, report);
        return report;
      });
    // A request timeout only ends the caller-facing race. The inspection may
    // ignore AbortSignal, so keep the slot and coalescing entry until the
    // actual upstream promise settles.
    const settledPromise = workPromise.finally(() => {
      activeInspections -= 1;
      inFlight.delete(key);
    });
    settledPromise.catch(() => {});
    const job = Promise.race([
      workPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ServiceError(504, "inspection_timeout", "Contract inspection timed out"));
          controller.abort();
        }, requestTimeoutMs);
        timeout.unref?.();
      }),
    ]).finally(() => clearTimeout(timeout));
    inFlight.set(key, job);
    return { report: await job, cacheStatus: "MISS" };
  }

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
    let inspectionStarted = false;
    req.setTimeout(requestTimeoutMs, () => {
      if (!inspectionStarted) {
        send(res, 408, {
          ok: false,
          error: "request_timeout",
          message: "Request timed out",
        });
      }
    });

    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, {
          ok: true,
          service: "pharos-contract-inspector",
          endpoints: ["POST /inspect"],
        });
      }

      if (!isLoopbackHost(host) && !hasValidAuth(req, apiKey)) {
        throw new ServiceError(401, "authentication_required", "Authentication required", {
          "www-authenticate": "Bearer",
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
      const input = parseInspectPayload(body);
      inspectionStarted = true;
      req.setTimeout(0);
      let inspected;
      try {
        inspected = await inspectOnce(input);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(
          502,
          "upstream_error",
          "Contract inspection failed",
        );
      }
      return send(
        res,
        200,
        { ok: true, report: inspected.report },
        { "x-cache": inspected.cacheStatus },
      );
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

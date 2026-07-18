// server.mjs — dependency-free HTTP API wrapper for Pharos Address Intelligence.
//   node scripts/server.mjs   (listens on 127.0.0.1:8800)
//   POST /analyze  { "address": "0x...", "network": "mainnet"|"testnet", "offline": false }
//   GET  /health   → { ok: true }
//
// Custom RPC over HTTP is intentionally disabled (SSRF safety), like
// pharos-contract-inspector. Only configured network RPCs are used.

import http from "http";
import net from "net";
import { analyzeAddress } from "./lib/analyze.mjs";
import { buildReport } from "./lib/report.mjs";

const PORT = process.env.PORT || 8800;
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 32_768);
const DEFAULT_RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const DEFAULT_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20_000);
const DEFAULT_CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15_000);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";
const DEFAULT_TRUST_PROXY = process.env.TRUST_PROXY === "true";

function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value, null, status === 200 ? 2 : 0));
}

function forwardedClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const first = String(Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || "")
    .split(",")[0]
    .trim();
  if (first && net.isIP(first)) return first;

  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp && net.isIP(realIp)) return realIp;
  return null;
}

function clientKey(req, trustProxy = false) {
  if (trustProxy) return forwardedClientIp(req) || req.socket.remoteAddress || "unknown";
  return req.socket.remoteAddress || "unknown";
}

export function createServer({
  analyze = analyzeAddress,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  corsOrigin = ALLOWED_ORIGIN,
  trustProxy = DEFAULT_TRUST_PROXY,
} = {}) {
  const buckets = new Map();
  const cache = new Map();

  function checkRateLimit(req) {
    const now = Date.now();
    const key = clientKey(req, trustProxy);
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
      return { ok: true, resetAt: now + rateLimitWindowMs };
    }
    bucket.count += 1;
    return { ok: bucket.count <= rateLimitMax, resetAt: bucket.resetAt };
  }

  function cached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      cache.delete(key);
      return null;
    }
    return hit.value;
  }

  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    req.setTimeout(requestTimeoutMs, () => {
      sendJson(res, 408, { error: "request timeout" });
      req.destroy();
    });

    if (req.url === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "pharos-address-intelligence" });
      return;
    }

    if (req.url === "/analyze" && req.method === "POST") {
      const rate = checkRateLimit(req);
      if (!rate.ok) {
        const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
        sendJson(res, 429, { error: "rate limit exceeded" }, { "Retry-After": String(retryAfter) });
        return;
      }

      let body = "";
      let tooLarge = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (!tooLarge && Buffer.byteLength(body) > maxBodyBytes) {
          tooLarge = true;
          sendJson(res, 413, { error: "request body too large" });
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (tooLarge || res.writableEnded) return;
        try {
          const { address, network = "testnet", offline = false } = JSON.parse(body || "{}");
          if (!address) {
            sendJson(res, 400, { error: "missing 'address'" });
            return;
          }
          const netMap = { testnet: "atlantic_testnet", mainnet: "pacific_mainnet" };
          const netKey = netMap[network] || network;
          const cacheKey = JSON.stringify({ address, network: netKey, offline: offline === true });
          const cachedReport = cached(cacheKey);
          if (cachedReport) {
            sendJson(res, 200, cachedReport, { "X-Cache": "HIT" });
            return;
          }
          const data = await analyze(address, netKey, { offline });
          const report = buildReport(data);
          cache.set(cacheKey, { value: report, expiresAt: Date.now() + cacheTtlMs });
          sendJson(res, 200, report, { "X-Cache": "MISS" });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Pharos Address Intelligence API on http://${HOST}:${PORT}`);
    console.log(`  POST /analyze  { address, network, offline }`);
  });
}

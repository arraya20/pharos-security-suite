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
import { buildReport as defaultBuildReport } from "./lib/report.mjs";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PORT = process.env.PORT || 8800;
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = envNumber("MAX_BODY_BYTES", 32_768);
const DEFAULT_RATE_LIMIT_WINDOW_MS = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const DEFAULT_RATE_LIMIT_MAX = envNumber("RATE_LIMIT_MAX", 60);
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = envNumber("RATE_LIMIT_MAX_BUCKETS", 10_000);
const DEFAULT_REQUEST_TIMEOUT_MS = envNumber("REQUEST_TIMEOUT_MS", 20_000);
const DEFAULT_CACHE_TTL_MS = envNumber("CACHE_TTL_MS", 15_000);
const DEFAULT_CACHE_MAX_ENTRIES = envNumber("CACHE_MAX_ENTRIES", 500);
const DEFAULT_RESOURCE_SWEEP_INTERVAL_MS = envNumber("RESOURCE_SWEEP_INTERVAL_MS", 30_000);
// Atlantic's public RPC allows 500 requests per five minutes. One analysis fans
// out into several RPC calls, so keep a conservative process-wide request cap.
const DEFAULT_UPSTREAM_BUDGET_MAX = envNumber("UPSTREAM_BUDGET_MAX", 50);
const DEFAULT_UPSTREAM_BUDGET_WINDOW_MS = envNumber("UPSTREAM_BUDGET_WINDOW_MS", 300_000);
const DEFAULT_MAX_CONCURRENT_ANALYSES = envNumber("MAX_CONCURRENT_ANALYSES", 4);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";
const DEFAULT_TRUST_PROXY = process.env.TRUST_PROXY === "true";
const DEFAULT_TRUSTED_PROXY_HOPS = envNumber("TRUSTED_PROXY_HOPS", 1);

class ServiceError extends Error {
  constructor(status, publicMessage, headers = {}) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.headers = headers;
  }
}

function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value, null, status === 200 ? 2 : 0));
}

function forwardedClientIp(req, trustedProxyHops) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const chain = String(Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor || "")
    .split(",")
    .map((entry) => entry.trim());
  const hops = Math.max(1, Math.trunc(trustedProxyHops));
  const candidate = chain[chain.length - hops];
  return candidate && net.isIP(candidate) ? candidate : null;
}

function clientKey(req, trustProxy = false, trustedProxyHops = 1) {
  if (trustProxy)
    return forwardedClientIp(req, trustedProxyHops) || req.socket.remoteAddress || "unknown";
  return req.socket.remoteAddress || "unknown";
}

function retryAfterSeconds(resetAt, now = Date.now()) {
  return String(Math.max(1, Math.ceil((resetAt - now) / 1000)));
}

function sweepExpired(map, field, now) {
  for (const [key, value] of map) {
    if (now >= value[field]) map.delete(key);
  }
}

function evictOldest(map) {
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

function parseAnalyzePayload(body) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    throw new ServiceError(400, "malformed JSON body");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new ServiceError(400, "JSON body must be an object");

  const { address } = payload;
  if (address === undefined || address === null || address === "")
    throw new ServiceError(400, "missing 'address'");
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new ServiceError(400, "invalid 'address'");

  const network = payload.network ?? "testnet";
  if (typeof network !== "string") throw new ServiceError(400, "invalid 'network'");
  const networkMap = {
    testnet: "atlantic_testnet",
    mainnet: "pacific_mainnet",
    atlantic_testnet: "atlantic_testnet",
    pacific_mainnet: "pacific_mainnet",
  };
  const networkKey = networkMap[network];
  if (!networkKey) throw new ServiceError(400, "unsupported 'network'");

  const offline = payload.offline ?? false;
  if (typeof offline !== "boolean") throw new ServiceError(400, "invalid 'offline'");
  return { address, networkKey, offline };
}

export function createServer({
  analyze = analyzeAddress,
  build = defaultBuildReport,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitMaxBuckets = DEFAULT_RATE_LIMIT_MAX_BUCKETS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  resourceSweepIntervalMs = DEFAULT_RESOURCE_SWEEP_INTERVAL_MS,
  upstreamBudgetMax = DEFAULT_UPSTREAM_BUDGET_MAX,
  upstreamBudgetWindowMs = DEFAULT_UPSTREAM_BUDGET_WINDOW_MS,
  maxConcurrentAnalyses = DEFAULT_MAX_CONCURRENT_ANALYSES,
  corsOrigin = ALLOWED_ORIGIN,
  trustProxy = DEFAULT_TRUST_PROXY,
  trustedProxyHops = DEFAULT_TRUSTED_PROXY_HOPS,
} = {}) {
  const buckets = new Map();
  const cache = new Map();
  const inFlight = new Map();
  let nextBucketSweepAt = 0;
  let nextCacheSweepAt = 0;
  let activeAnalyses = 0;
  let upstreamBudget = { count: 0, resetAt: 0 };

  function checkRateLimit(req) {
    const now = Date.now();
    if (now >= nextBucketSweepAt) {
      sweepExpired(buckets, "resetAt", now);
      nextBucketSweepAt = now + resourceSweepIntervalMs;
    }
    const key = clientKey(req, trustProxy, trustedProxyHops);
    const bucket = buckets.get(key);
    if (bucket && now < bucket.resetAt) {
      bucket.count += 1;
      return { ok: bucket.count <= rateLimitMax, resetAt: bucket.resetAt };
    }
    if (bucket) buckets.delete(key);

    if (buckets.size >= rateLimitMaxBuckets) sweepExpired(buckets, "resetAt", now);
    if (rateLimitMaxBuckets <= 0 || buckets.size >= rateLimitMaxBuckets) {
      const earliestReset = Math.min(...[...buckets.values()].map((value) => value.resetAt));
      return {
        ok: false,
        resetAt: Number.isFinite(earliestReset) ? earliestReset : now + rateLimitWindowMs,
      };
    }

    const resetAt = now + rateLimitWindowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: rateLimitMax >= 1, resetAt };
  }

  function cached(key) {
    const now = Date.now();
    if (now >= nextCacheSweepAt) {
      sweepExpired(cache, "expiresAt", now);
      nextCacheSweepAt = now + resourceSweepIntervalMs;
    }
    const hit = cache.get(key);
    if (!hit) return null;
    if (now >= hit.expiresAt) {
      cache.delete(key);
      return null;
    }
    // Refresh insertion order so bounded eviction behaves as LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  function cacheReport(key, report) {
    if (cacheTtlMs <= 0 || cacheMaxEntries <= 0) return;
    const now = Date.now();
    if (cache.size >= cacheMaxEntries) sweepExpired(cache, "expiresAt", now);
    if (cache.has(key)) cache.delete(key);
    while (cache.size >= cacheMaxEntries) evictOldest(cache);
    cache.set(key, { value: report, expiresAt: now + cacheTtlMs });
  }

  function consumeUpstreamBudget() {
    const now = Date.now();
    if (now >= upstreamBudget.resetAt) {
      upstreamBudget = { count: 0, resetAt: now + upstreamBudgetWindowMs };
    }
    if (upstreamBudget.count >= upstreamBudgetMax) {
      return { ok: false, resetAt: upstreamBudget.resetAt };
    }
    upstreamBudget.count += 1;
    return { ok: true, resetAt: upstreamBudget.resetAt };
  }

  function abortJob(job, kind) {
    if (job.settled || job.controller.signal.aborted) return;
    job.abortKind = kind;
    job.controller.abort();
  }

  function mapAnalysisError(error, job) {
    if (job.abortKind === "deadline" || error?.code === "ANALYSIS_ABORTED")
      return new ServiceError(504, "analysis deadline exceeded");
    if (job.abortKind === "client") return new ServiceError(499, "client closed request");
    if (error?.code === "INVALID_ADDRESS") return new ServiceError(400, "invalid 'address'");
    if (error?.code === "INVALID_NETWORK") return new ServiceError(400, "unsupported 'network'");
    // CHAIN_ID_MISMATCH and RPC_* failures are upstream integrity/availability
    // failures. Unknown analyzer exceptions also stay on the 502 boundary.
    return new ServiceError(502, "upstream analysis failed");
  }

  function startAnalysis(cacheKey, address, networkKey, offline) {
    const controller = new AbortController();
    const deadline = Date.now() + requestTimeoutMs;
    const job = {
      abortKind: null,
      controller,
      deadline,
      promise: null,
      settled: false,
      waiters: 0,
    };
    activeAnalyses += 1;

    let timeout;
    const deadlinePromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        abortJob(job, "deadline");
        reject(new ServiceError(504, "analysis deadline exceeded"));
      }, Math.max(1, requestTimeoutMs));
      timeout.unref?.();
    });

    const workPromise = (async () => {
      let data;
      try {
        data = await analyze(address, networkKey, {
          offline,
          signal: controller.signal,
          deadline,
        });
      } catch (error) {
        throw mapAnalysisError(error, job);
      }

      if (controller.signal.aborted || Date.now() >= deadline) {
        abortJob(job, "deadline");
        throw new ServiceError(504, "analysis deadline exceeded");
      }
      try {
        return build(data);
      } catch {
        throw new ServiceError(500, "internal report failure");
      }
    })();

    job.promise = Promise.race([workPromise, deadlinePromise])
      .then((report) => {
        if (controller.signal.aborted || Date.now() >= deadline) {
          abortJob(job, "deadline");
          throw new ServiceError(504, "analysis deadline exceeded");
        }
        cacheReport(cacheKey, report);
        return report;
      })
      .finally(() => {
        clearTimeout(timeout);
        job.settled = true;
        activeAnalyses -= 1;
        if (inFlight.get(cacheKey) === job) inFlight.delete(cacheKey);
      });
    inFlight.set(cacheKey, job);
    return job;
  }

  async function waitForJob(job, res) {
    job.waiters += 1;
    let detached = false;
    const detach = (closedEarly) => {
      if (detached) return;
      detached = true;
      job.waiters -= 1;
      if (closedEarly && job.waiters === 0) abortJob(job, "client");
    };
    const onClose = () => {
      if (!res.writableEnded) detach(true);
    };
    res.once("close", onClose);
    try {
      return await job.promise;
    } finally {
      res.off("close", onClose);
      detach(false);
    }
  }

  function sendError(res, error) {
    if (error instanceof ServiceError) {
      sendJson(res, error.status, { error: error.publicMessage }, error.headers);
      return;
    }
    sendJson(res, 500, { error: "internal server error" });
  }

  async function handleAnalyze(body, res) {
    const { address, networkKey, offline } = parseAnalyzePayload(body);
    const cacheKey = JSON.stringify({
      address: address.toLowerCase(),
      network: networkKey,
      offline,
    });
    const cachedReport = cached(cacheKey);
    if (cachedReport) {
      sendJson(res, 200, cachedReport, { "X-Cache": "HIT" });
      return;
    }

    let cacheStatus = "COALESCED";
    let job = inFlight.get(cacheKey);
    if (!job) {
      if (activeAnalyses >= maxConcurrentAnalyses) {
        throw new ServiceError(503, "analysis capacity exceeded", { "Retry-After": "1" });
      }
      const budget = consumeUpstreamBudget();
      if (!budget.ok) {
        throw new ServiceError(429, "upstream request budget exceeded", {
          "Retry-After": retryAfterSeconds(budget.resetAt),
        });
      }
      cacheStatus = "MISS";
      job = startAnalysis(cacheKey, address, networkKey, offline);
    }

    const report = await waitForJob(job, res);
    sendJson(res, 200, report, { "X-Cache": cacheStatus });
  }

  return http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "pharos-address-intelligence" });
      return;
    }

    if (req.url === "/analyze" && req.method === "POST") {
      const rate = checkRateLimit(req);
      if (!rate.ok) {
        sendJson(res, 429, { error: "rate limit exceeded" }, {
          "Retry-After": retryAfterSeconds(rate.resetAt),
        });
        return;
      }

      req.setTimeout(requestTimeoutMs, () => {
        if (req.complete) return;
        sendJson(res, 408, { error: "request timeout" });
        req.destroy();
      });
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
      req.on("end", () => {
        req.setTimeout(0);
        if (tooLarge || res.writableEnded) return;
        handleAnalyze(body, res).catch((error) => sendError(res, error));
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

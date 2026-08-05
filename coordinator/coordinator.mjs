import { randomUUID } from "node:crypto";
import { BoundedTtlCache } from "./cache.mjs";
import { validateAssessmentRequest, validateAssessmentResult } from "./contracts.mjs";
import {
  aggregateResults,
  normalizeSpecialistError,
  normalizeSpecialistResult,
} from "./normalizer.mjs";

class DeadlineError extends Error {}

class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError("maxConcurrentAssessments must be a positive integer");
    }
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  run(task) {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.active -= 1;
      });
  }
}

function routeKeys(input) {
  if (input.targetType === "ADDRESS") return ["address"];
  if (input.targetType === "CONTRACT") return ["contract"];
  if (input.targetType === "SKILL") return ["skill"];
  const keys = [];
  if (input.target.address) keys.push("address", "contract");
  if (input.target.skillRef) keys.push("skill");
  return keys;
}

function requestCacheKey(input) {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    targetType: input.targetType,
    target: {
      ...input.target,
      ...(input.target.address ? { address: input.target.address.toLowerCase() } : {}),
    },
    offline: input.options?.offline === true,
  });
}

function withCacheStatus(result, status, assessmentId) {
  const cloned = structuredClone(result);
  cloned.assessmentId = assessmentId;
  if (cloned.targetType === "FULL" && Array.isArray(cloned.details?.results)) {
    cloned.details.results = cloned.details.results.map((specialist) => ({
      ...specialist,
      assessmentId,
    }));
  }
  cloned.details = {
    ...cloned.details,
    cache: { status },
  };
  return cloned;
}

function capacityResult(input, assessmentId, startMs, now) {
  return {
    schemaVersion: "1.0",
    assessmentId,
    targetType: input.targetType,
    status: "FAILED",
    risk: null,
    findings: [],
    evidence: [],
    warnings: [
      {
        code: "COORDINATOR_BUSY",
        message: "Assessment capacity is currently full; retry shortly.",
      },
    ],
    confidence: "UNKNOWN",
    timing: {
      startedAt: new Date(startMs).toISOString(),
      durationMs: now() - startMs,
    },
    source: { module: "pharos-security-coordinator", version: "0.1.0" },
    details: {},
  };
}

async function runWithDeadline(adapter, input, deadlineAt, now) {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) throw new DeadlineError("deadline exceeded");
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      adapter.assess(input, { deadlineAt, signal: controller.signal }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new DeadlineError("deadline exceeded"));
          controller.abort();
        }, remainingMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createCoordinator({
  adapters,
  defaultDeadlineMs = 8_000,
  cacheTtlMs = 15_000,
  cacheMaxEntries = 500,
  maxConcurrentAssessments = 5,
  now = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (!adapters || typeof adapters !== "object") {
    throw new TypeError("adapters are required");
  }
  const cache = new BoundedTtlCache({ maxEntries: cacheMaxEntries, now });
  const limiter = new ConcurrencyLimiter(maxConcurrentAssessments);
  const inFlight = new Map();

  async function execute(input, assessmentId, startMs) {
    const startedAt = new Date(startMs).toISOString();
    const deadlineMs = input.options?.deadlineMs ?? defaultDeadlineMs;
    const deadlineAt = startMs + deadlineMs;
    const keys = routeKeys(input);
    for (const key of keys) {
      if (!adapters[key]) throw new TypeError(`missing ${key} specialist adapter`);
    }

    const results = await Promise.all(
      keys.map(async (key) => {
        const adapter = adapters[key];
        const specialistStart = now();
        const specialistStartedAt = new Date(specialistStart).toISOString();
        try {
          const raw = await runWithDeadline(adapter, input, deadlineAt, now);
          return normalizeSpecialistResult({
            key,
            adapter,
            raw,
            assessmentId,
            startedAt: specialistStartedAt,
            durationMs: now() - specialistStart,
          });
        } catch (error) {
          return normalizeSpecialistError({
            key,
            adapter,
            assessmentId,
            startedAt: specialistStartedAt,
            durationMs: now() - specialistStart,
            timedOut: error instanceof DeadlineError,
          });
        }
      })
    );

    const result = input.targetType === "FULL"
      ? aggregateResults(results, {
          assessmentId,
          startedAt,
          durationMs: now() - startMs,
        })
      : results[0];
    validateAssessmentResult(result);
    return result;
  }

  async function assess(rawInput) {
    const input = validateAssessmentRequest(rawInput);
    const assessmentId = input.assessmentId || idFactory();
    const cacheKey = requestCacheKey(input);
    const deadlineMs = input.options?.deadlineMs ?? defaultDeadlineMs;
    const inFlightKey = `${cacheKey}:${deadlineMs}`;
    const hit = cache.get(cacheKey);
    if (hit) return withCacheStatus(hit, "HIT", assessmentId);
    if (inFlight.has(inFlightKey)) {
      return withCacheStatus(await inFlight.get(inFlightKey), "COALESCED", assessmentId);
    }

    const startMs = now();
    const job = limiter.run(() => execute(input, assessmentId, startMs))
    if (!job) {
      return withCacheStatus(
        capacityResult(input, assessmentId, startMs, now),
        "BYPASS",
        assessmentId
      );
    }
    const trackedJob = job.then((result) => {
        if (result.status === "COMPLETE" || result.status === "PARTIAL") {
          cache.set(cacheKey, result, cacheTtlMs);
        }
        return result;
      })
      .finally(() => inFlight.delete(inFlightKey));
    inFlight.set(inFlightKey, trackedJob);
    return withCacheStatus(await trackedJob, "MISS", assessmentId);
  }

  return { assess };
}

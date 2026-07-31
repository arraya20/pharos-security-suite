import { randomUUID } from "node:crypto";
import { BoundedTtlCache } from "./cache.mjs";
import { validateAssessmentRequest, validateAssessmentResult } from "./contracts.mjs";
import {
  aggregateResults,
  normalizeSpecialistError,
  normalizeSpecialistResult,
} from "./normalizer.mjs";

class DeadlineError extends Error {}

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
  cloned.details = {
    ...cloned.details,
    cache: { status },
  };
  return cloned;
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
  now = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (!adapters || typeof adapters !== "object") {
    throw new TypeError("adapters are required");
  }
  const cache = new BoundedTtlCache({ maxEntries: cacheMaxEntries, now });
  const inFlight = new Map();

  async function execute(input, assessmentId) {
    const startMs = now();
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
    const key = requestCacheKey(input);
    const hit = cache.get(key);
    if (hit) return withCacheStatus(hit, "HIT", assessmentId);
    if (inFlight.has(key)) {
      return withCacheStatus(await inFlight.get(key), "COALESCED", assessmentId);
    }

    const job = execute(input, assessmentId)
      .then((result) => {
        if (result.status === "COMPLETE" || result.status === "PARTIAL") {
          cache.set(key, result, cacheTtlMs);
        }
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return withCacheStatus(await job, "MISS", assessmentId);
  }

  return { assess };
}

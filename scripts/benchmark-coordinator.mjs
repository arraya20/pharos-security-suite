#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { defineAdapter } from "../coordinator/adapters.mjs";
import { createCoordinator } from "../coordinator/coordinator.mjs";

const TOTAL = Number(process.env.BENCHMARK_REQUESTS || 100);
const CONCURRENCY = Number(process.env.BENCHMARK_CONCURRENCY || 5);
const UPSTREAM_DELAY_MS = Number(process.env.BENCHMARK_UPSTREAM_DELAY_MS || 20);

let specialistInFlight = 0;
let maxSpecialistInFlight = 0;
const specialist = (module, version, score) =>
  defineAdapter({
    module,
    version,
    assess: async () => {
      specialistInFlight += 1;
      maxSpecialistInFlight = Math.max(maxSpecialistInFlight, specialistInFlight);
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_DELAY_MS));
      specialistInFlight -= 1;
      return { risk: { score, level: score > 60 ? "HIGH" : "LOW" }, confidence: "full" };
    },
  });

const coordinator = createCoordinator({
  adapters: {
    address: specialist("address-intelligence", "0.1.0", 10),
    contract: specialist("contract-inspector", "1.1.0", 65),
  },
  maxConcurrentAssessments: CONCURRENCY,
  cacheTtlMs: 1,
});

const durations = [];
let next = 0;
async function worker() {
  while (next < TOTAL) {
    const index = next++;
    const address = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    const started = performance.now();
    const result = await coordinator.assess({
      schemaVersion: "1.0",
      targetType: "FULL",
      target: { address, network: "mainnet" },
      options: { offline: true },
    });
    if (result.status !== "COMPLETE") throw new Error(`unexpected status ${result.status}`);
    durations.push(performance.now() - started);
  }
}

const benchmarkStarted = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const wallMs = performance.now() - benchmarkStarted;
durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)];
const report = {
  requests: TOTAL,
  concurrency: CONCURRENCY,
  upstreamDelayMs: UPSTREAM_DELAY_MS,
  p50Ms: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  wallMs: Number(wallMs.toFixed(2)),
  maxSpecialistInFlight,
};

console.log(JSON.stringify(report, null, 2));
if (report.p95Ms >= 500) {
  throw new Error(`coordinator p95 ${report.p95Ms}ms exceeds the 500ms local budget`);
}
if (maxSpecialistInFlight > CONCURRENCY * 2) {
  throw new Error("coordinator exceeded the expected specialist fan-out budget");
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("benchmark drains capacity responses instead of treating them as failed assessments", () => {
  const result = spawnSync(process.execPath, ["scripts/benchmark-coordinator.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      BENCHMARK_REQUESTS: "20",
      BENCHMARK_CONCURRENCY: "5",
      BENCHMARK_UPSTREAM_DELAY_MS: "5",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"requests": 20/);
});

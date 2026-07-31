#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const STAGE_PARENT = path.join(DIST, "coordinator-package");
const STAGE = path.join(STAGE_PARENT, "pharos-security-coordinator");
const ARCHIVE = path.join(DIST, "pharos-security-coordinator.zip");

fs.rmSync(STAGE_PARENT, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "scripts"), { recursive: true });
fs.cpSync(path.join(ROOT, "coordinator", "SKILL.md"), path.join(STAGE, "SKILL.md"));
fs.cpSync(path.join(ROOT, "coordinator", "agents"), path.join(STAGE, "agents"), { recursive: true });
fs.cpSync(path.join(ROOT, "contracts"), path.join(STAGE, "contracts"), { recursive: true });

for (const file of [
  "adapters.mjs",
  "cache.mjs",
  "contracts.mjs",
  "coordinator.mjs",
  "normalizer.mjs",
]) {
  fs.cpSync(path.join(ROOT, "coordinator", file), path.join(STAGE, "scripts", file));
}

fs.rmSync(ARCHIVE, { force: true });
execFileSync("zip", ["-q", "-r", ARCHIVE, "pharos-security-coordinator"], {
  cwd: STAGE_PARENT,
  stdio: "inherit",
});
console.log(ARCHIVE);

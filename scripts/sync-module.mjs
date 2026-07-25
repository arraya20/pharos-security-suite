#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./check-module-drift.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = path.join(ROOT, "modules.lock.json");

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })?.trim();
}

function main() {
  const requestedName = process.argv[2];
  if (!requestedName) {
    throw new Error("Usage: npm run sync:module -- <module-name>");
  }
  if (runGit(["status", "--porcelain"], { capture: true })) {
    throw new Error("Refusing to sync with a dirty worktree");
  }

  const manifest = validateManifest(
    JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"))
  );
  const module = manifest.modules.find(({ name }) => name === requestedName);
  if (!module) {
    throw new Error(
      `Unknown module "${requestedName}". Available: ${manifest.modules
        .map(({ name }) => name)
        .join(", ")}`
    );
  }

  const remoteLine = runGit(
    ["ls-remote", module.repository, `refs/heads/${module.branch}`],
    { capture: true }
  );
  const nextCommit = remoteLine?.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(nextCommit || "")) {
    throw new Error(`Unable to resolve ${module.name} upstream commit`);
  }
  if (nextCommit === module.commit) {
    console.log(`${module.name} is already locked to ${module.commit}`);
    return;
  }

  runGit([
    "subtree",
    "pull",
    `--prefix=${module.prefix}`,
    module.repository,
    module.branch,
    "--squash",
  ]);
  module.commit = nextCommit;
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `${module.name} synchronized to ${nextCommit}; review and commit modules.lock.json`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

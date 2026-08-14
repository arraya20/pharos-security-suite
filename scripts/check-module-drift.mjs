#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._/-]+$/;

function fail(message) {
  throw new Error(`Module manifest invalid: ${message}`);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("root must be an object");
  }
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    fail("modules must be a non-empty array");
  }

  const names = new Set();
  const prefixes = new Set();
  for (const module of manifest.modules) {
    if (!module || typeof module !== "object" || Array.isArray(module)) {
      fail("each module must be an object");
    }
    for (const field of ["name", "prefix", "repository", "branch", "commit"]) {
      if (typeof module[field] !== "string" || !module[field]) {
        fail(`${field} must be a non-empty string`);
      }
    }
    if (!SAFE_SEGMENT_PATTERN.test(module.name)) fail(`unsafe module name: ${module.name}`);
    if (
      !SAFE_SEGMENT_PATTERN.test(module.prefix) ||
      path.isAbsolute(module.prefix) ||
      module.prefix.split("/").includes("..")
    ) {
      fail(`unsafe module prefix: ${module.prefix}`);
    }
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        module.repository
      )
    ) {
      fail(`repository must be an HTTPS GitHub .git URL for ${module.name}`);
    }
    if (!SAFE_SEGMENT_PATTERN.test(module.branch)) {
      fail(`unsafe branch for ${module.name}`);
    }
    if (!COMMIT_PATTERN.test(module.commit)) {
      fail(`commit for ${module.name} must be a lowercase 40-character commit`);
    }
    if (!Array.isArray(module.requiredFiles) || module.requiredFiles.length === 0) {
      fail(`requiredFiles must be non-empty for ${module.name}`);
    }
    for (const requiredFile of module.requiredFiles) {
      if (
        typeof requiredFile !== "string" ||
        !requiredFile ||
        path.isAbsolute(requiredFile) ||
        requiredFile.split("/").includes("..")
      ) {
        fail(`unsafe required file for ${module.name}`);
      }
    }
    if (names.has(module.name)) fail(`duplicate module name: ${module.name}`);
    if (prefixes.has(module.prefix)) fail(`duplicate prefix: ${module.prefix}`);
    names.add(module.name);
    prefixes.add(module.prefix);
  }
  return manifest;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function subtreeSnapshot(root, prefix) {
  const commit = git(root, [
    "log",
    "--all",
    "-1",
    "--format=%H",
    "--fixed-strings",
    `--grep=git-subtree-dir: ${prefix}`,
  ]);
  if (!commit) throw new Error(`No subtree provenance found for ${prefix}`);

  const message = git(root, ["show", "-s", "--format=%B", commit]);
  const split = message.match(/^git-subtree-split:\s*([0-9a-f]{40})$/m)?.[1];
  if (!split) throw new Error(`No subtree split SHA found for ${prefix}`);
  return { commit, split };
}

export function checkModules({ root = ROOT, manifest }) {
  validateManifest(manifest);
  const checked = [];

  for (const module of manifest.modules) {
    for (const requiredFile of module.requiredFiles) {
      const target = path.join(root, module.prefix, requiredFile);
      if (!fs.existsSync(target)) {
        throw new Error(`${module.name} is missing required file ${requiredFile}`);
      }
    }

    const snapshot = subtreeSnapshot(root, module.prefix);
    if (snapshot.split !== module.commit) {
      throw new Error(
        `${module.name} lock ${module.commit} does not match subtree ${snapshot.split}`
      );
    }

    const currentTree = git(root, ["rev-parse", `HEAD:${module.prefix}`]);
    const snapshotTree = git(root, ["rev-parse", `${snapshot.commit}^{tree}`]);
    if (currentTree !== snapshotTree) {
      throw new Error(
        `${module.name} content drifted from locked subtree ${module.commit}`
      );
    }
    checked.push(module.name);
  }

  return { ok: true, checked };
}

function resolveRemoteHead(module) {
  const output = execFileSync(
    "git",
    ["ls-remote", module.repository, `refs/heads/${module.branch}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  return output.split(/\s+/)[0] ?? "";
}

export function checkRemoteHeads({ manifest, resolveHead = resolveRemoteHead }) {
  validateManifest(manifest);
  const checked = [];

  for (const module of manifest.modules) {
    const head = resolveHead(module);
    if (!COMMIT_PATTERN.test(head)) {
      throw new Error(
        `Unable to resolve upstream ${module.branch} head for ${module.name}`
      );
    }
    if (head !== module.commit) {
      throw new Error(
        `${module.name} lock ${module.commit} does not match upstream ${module.branch} head ${head}`
      );
    }
    checked.push(module.name);
  }

  return { ok: true, checked };
}

function requireText(text, expected, source) {
  if (!text.includes(expected)) {
    throw new Error(`${source} is missing expected text: ${expected}`);
  }
}

export function checkDocumentation({ root = ROOT }) {
  const read = (relativePath) =>
    fs.readFileSync(path.join(root, relativePath), "utf8");
  const skillProject = read("skill-inspector/pyproject.toml");
  const skillVersion = skillProject.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
  if (!skillVersion) throw new Error("Unable to read Skill Inspector version");

  const rootProject = JSON.parse(read("package.json"));
  const contractProject = JSON.parse(read("contract-inspector/package.json"));
  const addressProject = JSON.parse(read("address-intelligence/package.json"));
  const contractVersion = contractProject.version;
  const addressVersion = addressProject.version;
  const readme = read("README.md");
  const homepage = read("docs/index.html");

  const expectedVersions = [
    ["Skill Inspector", skillVersion],
    ["Contract Inspector", contractVersion],
    ["Address Intelligence", addressVersion],
  ];
  for (const [name, version] of expectedVersions) {
    requireText(readme, `${name} \`v${version}\``, "README.md");
    requireText(homepage, `${name} <span class="tag tag-live">v${version}</span>`, "docs/index.html");
  }

  for (const licensePath of [
    "LICENSE",
    "skill-inspector/LICENSE",
    "contract-inspector/LICENSE",
    "address-intelligence/LICENSE",
  ]) {
    if (!read(licensePath).startsWith("Proprietary Software License\n")) {
      throw new Error(`${licensePath} must use the proprietary license text`);
    }
  }

  for (const [projectPath, project] of [
    ["package.json", rootProject],
    ["contract-inspector/package.json", contractProject],
    ["address-intelligence/package.json", addressProject],
  ]) {
    if (project.license !== "UNLICENSED" || project.private !== true) {
      throw new Error(`${projectPath} must be private and UNLICENSED`);
    }
  }
  requireText(
    skillProject,
    'license = { text = "Proprietary" }',
    "skill-inspector/pyproject.toml"
  );
  requireText(
    skillProject,
    '"License :: Other/Proprietary License"',
    "skill-inspector/pyproject.toml"
  );
  for (const documentationPath of [
    "README.md",
    "skill-inspector/README.md",
    "contract-inspector/README.md",
    "contract-inspector/SKILL.md",
    "address-intelligence/README.md",
    "address-intelligence/SKILL.md",
    "docs/index.html",
  ]) {
    requireText(read(documentationPath), "Proprietary software", documentationPath);
  }

  if (fs.existsSync(path.join(root, "trust-layer"))) {
    throw new Error("Trust layer exists but documentation still marks it as roadmap");
  }
  requireText(readme, "### Roadmap: Agent Trust Layer", "README.md");
  requireText(
    homepage,
    'Agent Trust Layer <span class="tag tag-plan">roadmap</span>',
    "docs/index.html"
  );

  return {
    skillInspector: skillVersion,
    contractInspector: contractVersion,
    addressIntelligence: addressVersion,
    trustLayer: "roadmap",
  };
}

function main() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "modules.lock.json"), "utf8")
  );
  const result = checkModules({ root: ROOT, manifest });
  checkDocumentation({ root: ROOT });
  console.log(`Module drift check passed: ${result.checked.join(", ")}`);
  console.log("Documentation metadata check passed");
  if (process.argv.includes("--remote")) {
    const remoteResult = checkRemoteHeads({ manifest });
    console.log(
      `Upstream head check passed: ${remoteResult.checked.join(", ")}`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

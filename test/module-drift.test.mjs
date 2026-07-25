import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkDocumentation,
  checkModules,
  validateManifest,
} from "../scripts/check-module-drift.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const validModule = {
  name: "one",
  prefix: "module-one",
  repository: "https://github.com/example/one.git",
  branch: "main",
  commit: "a".repeat(40),
  requiredFiles: ["README.md"],
};

test("rejects abbreviated commit identifiers", () => {
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        modules: [{ ...validModule, commit: "abc123" }],
      }),
    /40-character commit/i
  );
});

test("rejects duplicate module prefixes", () => {
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        modules: [
          validModule,
          {
            ...validModule,
            name: "two",
            repository: "https://github.com/example/two.git",
          },
        ],
      }),
    /duplicate prefix/i
  );
});

test("the checked-in module snapshots match their locked subtree commits", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "modules.lock.json"), "utf8")
  );

  assert.deepEqual(checkModules({ root: ROOT, manifest }), {
    ok: true,
    checked: ["skill-inspector", "contract-inspector", "address-intelligence"],
  });
});

test("suite documentation matches module versions, licenses, and roadmap state", () => {
  assert.deepEqual(checkDocumentation({ root: ROOT }), {
    skillInspector: "0.1.0",
    contractInspector: "1.1.0",
    addressIntelligence: "0.1.0",
    trustLayer: "roadmap",
  });
});

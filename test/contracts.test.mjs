import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  validateAssessmentRequest,
  validateAssessmentResult,
} from "../coordinator/contracts.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "contracts", "assessment-request.schema.json"), "utf8")
);

test("checked-in JSON schemas expose the stable 1.0 contract", () => {
  for (const file of [
    "assessment-request.schema.json",
    "assessment-result.schema.json",
    "error.schema.json",
  ]) {
    const schema = JSON.parse(
      fs.readFileSync(path.join(ROOT, "contracts", file), "utf8")
    );
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
});

test("validates an address assessment request", () => {
  const input = {
    schemaVersion: "1.0",
    targetType: "ADDRESS",
    target: {
      address: "0x0000000000000000000000000000000000000001",
      network: "mainnet",
    },
    options: { offline: true, deadlineMs: 5000 },
  };

  assert.deepEqual(validateAssessmentRequest(input), input);
});

test("rejects request fields outside the public contract", () => {
  assert.throws(
    () =>
      validateAssessmentRequest({
        schemaVersion: "1.0",
        targetType: "ADDRESS",
        target: {
          address: "0x0000000000000000000000000000000000000001",
          network: "mainnet",
          rpcUrl: "http://169.254.169.254/latest/meta-data",
        },
      }),
    /unsupported target field: rpcUrl/i
  );
});

test("rejects remote skill references at the coordinator boundary", () => {
  for (const skillRef of [
    "https://attacker.example/skill.zip",
    "artifact:https://attacker.example/skill.zip",
    "artifact:../../private-key",
  ]) {
    assert.throws(
      () =>
        validateAssessmentRequest({
          schemaVersion: "1.0",
          targetType: "SKILL",
          target: { skillRef },
        }),
      /artifact reference/i
    );
  }
});

test("requires the target implied by targetType", () => {
  assert.throws(
    () =>
      validateAssessmentRequest({
        schemaVersion: "1.0",
        targetType: "CONTRACT",
        target: { network: "mainnet" },
      }),
    /address is required/i
  );
});

test("JSON Schema enforces the same target requirements as the runtime validator", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(requestSchema);
  const invalidRequests = [
    {
      schemaVersion: "1.0",
      targetType: "ADDRESS",
      target: { network: "mainnet" },
    },
    {
      schemaVersion: "1.0",
      targetType: "CONTRACT",
      target: {},
    },
    {
      schemaVersion: "1.0",
      targetType: "SKILL",
      target: {},
    },
    {
      schemaVersion: "1.0",
      targetType: "FULL",
      target: { network: "testnet" },
    },
  ];

  for (const input of invalidRequests) {
    assert.equal(validate(input), false, JSON.stringify(input));
    assert.throws(() => validateAssessmentRequest(input));
  }
});

test("validates normalized assessment results", () => {
  const input = {
    schemaVersion: "1.0",
    assessmentId: "assessment-1",
    targetType: "CONTRACT",
    status: "COMPLETE",
    risk: { score: 40, level: "MEDIUM" },
    findings: [],
    evidence: [],
    warnings: [],
    confidence: "FULL",
    timing: {
      startedAt: "2026-07-31T00:00:00.000Z",
      durationMs: 123,
    },
    source: { module: "contract-inspector", version: "1.1.0" },
    details: {},
  };

  assert.deepEqual(validateAssessmentResult(input), input);
});

test("rejects invalid scores and result statuses", () => {
  assert.throws(
    () =>
      validateAssessmentResult({
        schemaVersion: "1.0",
        assessmentId: "assessment-1",
        targetType: "ADDRESS",
        status: "SUCCESS",
        risk: { score: 101, level: "LOW" },
      }),
    /status must be one of/i
  );
});

test("rejects non-finite numbers in normalized results", () => {
  assert.throws(
    () => validateAssessmentResult({
      schemaVersion: "1.0",
      assessmentId: "assessment-1",
      targetType: "ADDRESS",
      status: "COMPLETE",
      risk: { score: Number.NaN, level: "CRITICAL" },
      findings: [],
      evidence: [],
      warnings: [],
      confidence: "FULL",
      timing: { startedAt: "2026-07-31T00:00:00.000Z", durationMs: 1 },
      source: { module: "address-intelligence", version: "0.1.0" },
      details: {},
    }),
    /finite/i
  );
});

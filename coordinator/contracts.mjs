const TARGET_TYPES = new Set(["SKILL", "CONTRACT", "ADDRESS", "FULL"]);
const NETWORKS = new Set(["mainnet", "testnet"]);
const RESULT_STATUSES = new Set(["COMPLETE", "PARTIAL", "TIMEOUT", "FAILED"]);
const CONFIDENCE_LEVELS = new Set(["FULL", "PARTIAL", "UNKNOWN"]);
const RISK_LEVELS = new Set([
  "LOW",
  "MEDIUM",
  "MODERATE",
  "ELEVATED",
  "HIGH",
  "CRITICAL",
]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SKILL_REF_RE = /^artifact:[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertAllowedKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unsupported ${name} field: ${key}`);
  }
}

function assertNonEmptyString(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
}

export function validateAssessmentRequest(input) {
  assertObject(input, "request");
  assertAllowedKeys(
    input,
    new Set(["schemaVersion", "assessmentId", "targetType", "target", "options"]),
    "request"
  );
  if (input.schemaVersion !== "1.0") throw new TypeError("schemaVersion must be 1.0");
  if (!TARGET_TYPES.has(input.targetType)) {
    throw new TypeError("targetType must be one of SKILL, CONTRACT, ADDRESS, FULL");
  }
  if (input.assessmentId !== undefined) {
    assertNonEmptyString(input.assessmentId, "assessmentId", 128);
  }

  assertObject(input.target, "target");
  assertAllowedKeys(input.target, new Set(["address", "network", "skillRef"]), "target");
  const needsAddress = input.targetType === "ADDRESS" || input.targetType === "CONTRACT";
  const needsSkill = input.targetType === "SKILL";
  if (needsAddress && !input.target.address) throw new TypeError("address is required");
  if (needsSkill && !input.target.skillRef) throw new TypeError("skillRef is required");
  if (input.targetType === "FULL" && !input.target.address && !input.target.skillRef) {
    throw new TypeError("FULL target requires address or skillRef");
  }
  if (input.target.address !== undefined && !ADDRESS_RE.test(input.target.address)) {
    throw new TypeError("address must be 0x followed by 40 hexadecimal characters");
  }
  if (input.target.network !== undefined && !NETWORKS.has(input.target.network)) {
    throw new TypeError("network must be mainnet or testnet");
  }
  if (input.target.skillRef !== undefined) {
    assertNonEmptyString(input.target.skillRef, "skillRef", 128);
    if (!SKILL_REF_RE.test(input.target.skillRef)) {
      throw new TypeError("skillRef must be an artifact reference, not a remote URL");
    }
  }

  if (input.options !== undefined) {
    assertObject(input.options, "options");
    assertAllowedKeys(input.options, new Set(["offline", "deadlineMs"]), "options");
    if (input.options.offline !== undefined && typeof input.options.offline !== "boolean") {
      throw new TypeError("offline must be boolean");
    }
    if (
      input.options.deadlineMs !== undefined &&
      (!Number.isInteger(input.options.deadlineMs) ||
        input.options.deadlineMs < 100 ||
        input.options.deadlineMs > 60_000)
    ) {
      throw new TypeError("deadlineMs must be an integer between 100 and 60000");
    }
  }
  return input;
}

export function validateAssessmentResult(input) {
  assertObject(input, "result");
  assertAllowedKeys(
    input,
    new Set([
      "schemaVersion",
      "assessmentId",
      "targetType",
      "status",
      "risk",
      "findings",
      "evidence",
      "warnings",
      "confidence",
      "timing",
      "source",
      "details",
    ]),
    "result"
  );
  if (input.schemaVersion !== "1.0") throw new TypeError("schemaVersion must be 1.0");
  assertNonEmptyString(input.assessmentId, "assessmentId", 128);
  if (!TARGET_TYPES.has(input.targetType)) {
    throw new TypeError("targetType must be one of SKILL, CONTRACT, ADDRESS, FULL");
  }
  if (!RESULT_STATUSES.has(input.status)) {
    throw new TypeError("status must be one of COMPLETE, PARTIAL, TIMEOUT, FAILED");
  }
  if (input.risk !== undefined && input.risk !== null) {
    assertObject(input.risk, "risk");
    assertAllowedKeys(input.risk, new Set(["score", "level"]), "risk");
    if (typeof input.risk.score !== "number" || input.risk.score < 0 || input.risk.score > 100) {
      throw new TypeError("risk score must be between 0 and 100");
    }
    if (!RISK_LEVELS.has(input.risk.level)) throw new TypeError("unsupported risk level");
  }
  for (const field of ["findings", "evidence", "warnings"]) {
    if (!Array.isArray(input[field])) throw new TypeError(`${field} must be an array`);
  }
  for (const warning of input.warnings) {
    assertObject(warning, "warning");
    assertAllowedKeys(warning, new Set(["code", "message"]), "warning");
    assertNonEmptyString(warning.code, "warning code", 128);
    assertNonEmptyString(warning.message, "warning message", 1000);
  }
  if (!CONFIDENCE_LEVELS.has(input.confidence)) {
    throw new TypeError("confidence must be one of FULL, PARTIAL, UNKNOWN");
  }
  assertObject(input.timing, "timing");
  assertAllowedKeys(input.timing, new Set(["startedAt", "durationMs"]), "timing");
  if (Number.isNaN(Date.parse(input.timing.startedAt))) {
    throw new TypeError("timing.startedAt must be an ISO date-time");
  }
  if (typeof input.timing.durationMs !== "number" || input.timing.durationMs < 0) {
    throw new TypeError("timing.durationMs must be non-negative");
  }
  assertObject(input.source, "source");
  assertAllowedKeys(input.source, new Set(["module", "version"]), "source");
  assertNonEmptyString(input.source.module, "source.module", 128);
  assertNonEmptyString(input.source.version, "source.version", 64);
  if (!("details" in input)) throw new TypeError("details is required");
  return input;
}

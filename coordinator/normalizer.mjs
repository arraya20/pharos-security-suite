const MODULE_TARGET_TYPES = {
  address: "ADDRESS",
  contract: "CONTRACT",
  skill: "SKILL",
};
const SUPPORTED_RISK_LEVELS = new Set([
  "LOW",
  "MEDIUM",
  "MODERATE",
  "ELEVATED",
  "HIGH",
  "CRITICAL",
]);

function levelFromScore(score) {
  if (score <= 20) return "LOW";
  if (score <= 40) return "MODERATE";
  if (score <= 60) return "ELEVATED";
  if (score <= 80) return "HIGH";
  return "CRITICAL";
}

function riskFrom(raw) {
  const candidate = raw?.risk ||
    (typeof raw?.score === "number"
      ? { score: raw.score, level: raw.severity || raw.level }
      : null);
  if (!candidate || !Number.isFinite(candidate.score)) return null;
  const normalizedLevel = candidate.level
    ? String(candidate.level).toUpperCase()
    : null;
  return {
    score: Math.max(0, Math.min(100, candidate.score)),
    level: SUPPORTED_RISK_LEVELS.has(normalizedLevel)
      ? normalizedLevel
      : levelFromScore(candidate.score),
  };
}

function assertSpecialistResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("specialist result must be an object");
  }
  if (raw.status !== undefined && !["COMPLETE", "PARTIAL"].includes(raw.status)) {
    throw new TypeError("specialist did not return a successful result");
  }
  if (raw.address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(raw.address)) {
    throw new TypeError("specialist address is invalid");
  }
  if (raw.risk !== undefined) {
    if (!raw.risk || typeof raw.risk !== "object" || Array.isArray(raw.risk)) {
      throw new TypeError("specialist risk must be an object");
    }
    if (!Number.isFinite(raw.risk.score)) {
      throw new TypeError("specialist risk score must be finite");
    }
  }
  if (raw.score !== undefined && !Number.isFinite(raw.score)) {
    throw new TypeError("specialist score must be finite");
  }
  for (const field of ["findings", "evidence", "incomplete"]) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) {
      throw new TypeError(`specialist ${field} must be an array`);
    }
  }
  for (const warning of raw.incomplete || []) {
    if (
      !warning ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      typeof warning.code !== "string" ||
      warning.code.length === 0 ||
      warning.code.length > 128 ||
      typeof warning.message !== "string" ||
      warning.message.length === 0 ||
      warning.message.length > 1000
    ) {
      throw new TypeError("specialist incomplete warning is invalid");
    }
  }
  const hasAssessmentData =
    raw.risk !== undefined ||
    raw.score !== undefined ||
    raw.address !== undefined ||
    (Array.isArray(raw.findings) && raw.findings.length > 0);
  if (!hasAssessmentData) {
    throw new TypeError("specialist result is missing assessment data");
  }
}

function sanitizeSpecialistValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("specialist data contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") {
    throw new TypeError("specialist data contains a non-serializable value");
  }
  if (seen.has(value)) throw new TypeError("specialist data contains a cycle");
  seen.add(value);
  let sanitized;
  if (Array.isArray(value)) {
    sanitized = value.map((item) => sanitizeSpecialistValue(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("specialist data must contain only plain objects");
    }
    sanitized = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeSpecialistValue(item, seen)])
    );
  }
  seen.delete(value);
  return sanitized;
}

function warningsFrom(raw) {
  const warnings = (raw.incomplete || []).map(({ code, message }) => ({ code, message }));
  if (Array.isArray(raw?.metadata?.errors) && raw.metadata.errors.length) {
    warnings.push({
      code: "INCOMPLETE_METADATA",
      message: "Some contract metadata could not be retrieved.",
    });
  }
  if (typeof raw?.confidence === "string" && raw.confidence.toLowerCase().startsWith("partial")) {
    warnings.push({
      code: "PARTIAL_DATA",
      message: "The specialist completed with partial upstream data.",
    });
  }
  if (raw.status === "PARTIAL" && warnings.length === 0) {
    warnings.push({
      code: "SPECIALIST_PARTIAL",
      message: "The specialist reported an incomplete assessment.",
    });
  }
  return warnings;
}

export function normalizeSpecialistResult({
  key,
  adapter,
  raw,
  assessmentId,
  startedAt,
  durationMs,
}) {
  assertSpecialistResult(raw);
  const sanitizedRaw = sanitizeSpecialistValue(raw);
  const warnings = warningsFrom(sanitizedRaw);
  return {
    schemaVersion: "1.0",
    assessmentId,
    targetType: MODULE_TARGET_TYPES[key],
    status: warnings.length ? "PARTIAL" : "COMPLETE",
    risk: riskFrom(sanitizedRaw),
    findings: Array.isArray(sanitizedRaw?.findings)
      ? sanitizedRaw.findings
      : Array.isArray(sanitizedRaw?.risk?.flags)
        ? sanitizedRaw.risk.flags
        : [],
    evidence: Array.isArray(sanitizedRaw?.evidence) ? sanitizedRaw.evidence : [],
    warnings,
    confidence: warnings.length ? "PARTIAL" : "FULL",
    timing: { startedAt, durationMs },
    source: { module: adapter.module, version: adapter.version },
    details: sanitizedRaw,
  };
}

export function normalizeSpecialistError({
  key,
  adapter,
  assessmentId,
  startedAt,
  durationMs,
  timedOut,
}) {
  return {
    schemaVersion: "1.0",
    assessmentId,
    targetType: MODULE_TARGET_TYPES[key],
    status: timedOut ? "TIMEOUT" : "FAILED",
    risk: null,
    findings: [],
    evidence: [],
    warnings: [
      {
        code: timedOut ? "SPECIALIST_TIMEOUT" : "SPECIALIST_FAILED",
        message: timedOut
          ? "A specialist exceeded its execution deadline."
          : "A specialist could not complete the assessment.",
      },
    ],
    confidence: "UNKNOWN",
    timing: { startedAt, durationMs },
    source: { module: adapter.module, version: adapter.version },
    details: {},
  };
}

export function aggregateResults(results, { assessmentId, startedAt, durationMs }) {
  const complete = results.filter((result) => result.status === "COMPLETE");
  const available = results.filter((result) => result.risk);
  const worst = available.reduce(
    (current, result) => (!current || result.risk.score > current.score ? result.risk : current),
    null
  );
  let status = "PARTIAL";
  if (complete.length === results.length) status = "COMPLETE";
  else if (results.every((result) => result.status === "TIMEOUT")) status = "TIMEOUT";
  else if (results.every((result) => result.status === "FAILED")) status = "FAILED";

  return {
    schemaVersion: "1.0",
    assessmentId,
    targetType: "FULL",
    status,
    risk: worst,
    findings: results.flatMap((result) => result.findings),
    evidence: results.flatMap((result) => result.evidence),
    warnings: results.flatMap((result) => result.warnings),
    confidence: status === "COMPLETE" ? "FULL" : status === "PARTIAL" ? "PARTIAL" : "UNKNOWN",
    timing: { startedAt, durationMs },
    source: { module: "pharos-security-coordinator", version: "0.1.0" },
    details: { results },
  };
}

const MODULE_TARGET_TYPES = {
  address: "ADDRESS",
  contract: "CONTRACT",
  skill: "SKILL",
};

function riskFrom(raw) {
  const candidate = raw?.risk ||
    (typeof raw?.score === "number"
      ? { score: raw.score, level: raw.severity || raw.level }
      : null);
  if (!candidate || typeof candidate.score !== "number") return null;
  return {
    score: Math.max(0, Math.min(100, candidate.score)),
    level: String(candidate.level || "UNKNOWN").toUpperCase(),
  };
}

function warningsFrom(raw) {
  const warnings = [];
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
  const warnings = warningsFrom(raw);
  return {
    schemaVersion: "1.0",
    assessmentId,
    targetType: MODULE_TARGET_TYPES[key],
    status: warnings.length ? "PARTIAL" : "COMPLETE",
    risk: riskFrom(raw),
    findings: Array.isArray(raw?.findings)
      ? raw.findings
      : Array.isArray(raw?.risk?.flags)
        ? raw.risk.flags
        : [],
    evidence: Array.isArray(raw?.evidence) ? raw.evidence : [],
    warnings,
    confidence: warnings.length ? "PARTIAL" : "FULL",
    timing: { startedAt, durationMs },
    source: { module: adapter.module, version: adapter.version },
    details: raw,
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

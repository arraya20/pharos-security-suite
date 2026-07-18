// risk.js — lightweight deterministic risk scoring from introspection signals.
// Not an audit. This is a pre-flight safety summary for agents before calls.

import { ADMIN_PRIVILEGED_SELECTORS } from "./signatures.js";

const PRIVILEGED_SIGNATURES = [
  /^mint\(/,
  /^pause\(/,
  /^unpause\(/,
  /^upgradeTo\(/i,
  /^upgradeToAndCall\(/i,
  /^transferOwnership\(/,
  /^renounceOwnership\(/,
  /^changeAdmin\(/,
  /^grantRole\(/,
  /^revokeRole\(/,
  /^blacklist\(/,
  /^setBlacklist\(/,
];

const VALUE_MOVING_SIGNATURES = [
  /^approve\(/,
  /^permit\(/,
  /^permitTransferFrom\(/,
  /^permitWitnessTransferFrom\(/,
  /^transferFrom\(/,
  /^safeTransferFrom\(/,
  /^setApprovalForAll\(/,
  /^lockdown\(/,
  /^multicall\(/,
];

function matchesAny(signature, patterns) {
  return Boolean(signature && patterns.some((pattern) => pattern.test(signature)));
}

function compactEvidence(items, limit = 8) {
  const unique = [...new Set(items.filter(Boolean))];
  if (unique.length <= limit) return unique;
  return [...unique.slice(0, limit), `+${unique.length - limit} more`];
}

export function assessRisk({ proxy, dis, implDis, dangerous, standards, meta, resolvedFunctions = [], unresolvedSelectors = [] }) {
  const flags = [];
  let score = 5;

  const add = (check, status, impact, details, evidence = []) => {
    score += impact;
    flags.push({ check, status, scoreImpact: impact, details, evidence });
  };

  if (proxy?.isProxy) {
    add("Proxy / upgradeability", "warn", 22, `${proxy.type} detected. Logic may change over time.`, [proxy.impl, proxy.admin].filter(Boolean));
  } else {
    add("Proxy / upgradeability", "pass", 0, "No proxy pattern detected by bytecode/storage/getter checks.");
  }

  const priv = new Set((dangerous || []).map((d) => d.selector));
  for (const fn of resolvedFunctions || []) {
    if (matchesAny(fn.signature, PRIVILEGED_SIGNATURES)) priv.add(fn.selector);
  }
  if (implDis?.selectors) {
    for (const s of implDis.selectors) {
      if (ADMIN_PRIVILEGED_SELECTORS.includes(s)) priv.add(s);
    }
  }
  if (priv.size) {
    const impact = Math.min(30, 8 + priv.size * 5);
    add("Privileged selectors", "warn", impact, "Admin/supply/upgrade controls detected. Review authority before moving funds.", [...priv]);
  } else {
    add("Privileged selectors", "pass", 0, "No common privileged selectors detected.");
  }

  const valueMoving = (resolvedFunctions || []).filter((fn) => matchesAny(fn.signature, VALUE_MOVING_SIGNATURES));
  if (valueMoving.length) {
    add(
      "Value-moving selectors",
      "warn",
      35,
      "Resolved signatures include approvals, permits, transfers, batching, or allowance lockdown controls. Review calldata and spending authority before signing.",
      compactEvidence(valueMoving.map((fn) => `${fn.selector} ${fn.signature}`)),
    );
  }

  const unresolvedCount = unresolvedSelectors?.length || 0;
  if (unresolvedCount >= 10) {
    add(
      "Unresolved selectors",
      "warn",
      35,
      `${unresolvedCount} selectors could not be classified. Risk confidence is limited without ABI/source or online signature resolution.`,
      compactEvidence(unresolvedSelectors),
    );
  } else if (unresolvedCount > 0) {
    add(
      "Unresolved selectors",
      "info",
      Math.min(12, unresolvedCount * 3),
      `${unresolvedCount} selectors could not be classified. Review raw selectors before value-moving calls.`,
      compactEvidence(unresolvedSelectors),
    );
  }

  if (meta?.owner) {
    add("Owner/admin exposure", "warn", 12, "owner() returned a non-zero address.", [meta.owner]);
  }

  // Metadata confidence: if owner() (or other admin-relevant reads) failed at the
  // RPC layer rather than legitimately returning empty, the score above may
  // UNDER-report risk — a flaky owner() call would silently drop the +12 admin
  // flag. Surface that uncertainty instead of letting the score quietly fall.
  const metaErrors = meta?.errors || [];
  if (metaErrors.length) {
    const ownerUnknown = metaErrors.includes("owner");
    add(
      "Metadata read incomplete",
      "info",
      ownerUnknown ? 6 : 2,
      `${metaErrors.length} metadata call(s) did not return (revert/timeout/RPC): ${metaErrors.join(", ")}.` +
        (ownerUnknown ? " owner() is unknown — admin exposure may be under-reported; re-run or verify before trusting the score." : ""),
      metaErrors,
    );
  }

  if (dis?.hasDelegateCall) add("DELEGATECALL opcode", "warn", 12, "Delegatecall present. Common in proxies, risky in arbitrary-call routers.");
  if (dis?.hasSelfdestruct || implDis?.hasSelfdestruct) add("SELFDESTRUCT opcode", "warn", 35, "Contract or implementation contains SELFDESTRUCT opcode.");
  if (dis?.hasCreate || dis?.hasCreate2 || implDis?.hasCreate || implDis?.hasCreate2) add("Factory behavior", "info", 8, "CREATE/CREATE2 opcode present; contract can deploy other contracts.");

  if ((standards || []).includes("ERC-20") && !meta?.owner && !metaErrors.includes("owner") && !proxy?.isProxy && !priv.size) {
    add("ERC-20 simplicity", "pass", -5, "ERC-20-like direct contract with no obvious admin getter/proxy signal.");
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  const headline = level === "High"
    ? "High risk: review admin powers, upgradeability, and privileged selectors before interaction."
    : level === "Medium"
      ? "Medium risk: proceed with limits and verify trust assumptions."
      : "Low observed risk from ABI-free bytecode scan.";

  const recommendations = [
    "Treat this as pre-flight triage, not a full source-level audit.",
    "For value-moving actions, verify target address, decoded calldata, and spend limits before signing.",
    proxy?.isProxy ? "Monitor implementation address before each major interaction." : "Prefer verified source when available for final review.",
    priv.size ? "Identify who controls privileged functions before depositing or approving tokens." : "Still check custom roles not covered by common selector fingerprints.",
    valueMoving.length ? "Treat resolved approval/permit/transfer surfaces as value-moving even when they are not admin-only." : null,
    unresolvedCount ? "Resolve unknown selectors with source, ABI, or a trusted signature database before high-value interactions." : null,
  ].filter(Boolean);

  return { score, level, headline, flags, recommendations };
}

// report.mjs — turn raw signals into a classification, risk score, and
// human-readable / JSON report. Mirrors the scoring matrix in references/.

import { networksConfig } from "./analyze.mjs";

// chainId → network config (from assets/networks.json). Per-network economics
// (PHRS vs PROS) make a single hardcoded balance threshold wrong, so the whale
// cutoff and dormant-balance cutoff are read from config by chainId.
const NET_BY_CHAIN = new Map(
  Object.values(networksConfig.networks).map((n) => [n.chainId, n])
);
const DEFAULT_WHALE_THRESHOLD = 10_000;
const DEFAULT_DORMANT_BALANCE = 100;

function num(v, d = 4) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function contractName(data) {
  return data.contractInfo?.available && data.contractInfo.name
    ? String(data.contractInfo.name).toLowerCase()
    : "";
}

function effectiveNativeThreshold(data, nativeKey, usdKey, fallback) {
  const net = NET_BY_CHAIN.get(data.chainId);
  const priceUsd = num(data.nativePrice?.usd);
  const usdThreshold = num(net?.[usdKey]);
  if (priceUsd > 0 && usdThreshold > 0) {
    return {
      value: usdThreshold / priceUsd,
      source: "price-adjusted",
      usdThreshold,
      priceUsd,
    };
  }
  return {
    value: net?.[nativeKey] ?? fallback,
    source: "native-config",
  };
}

function formatThreshold(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// ---- Classification -------------------------------------------------------
export function classify(data) {
  const act = data.activity && data.activity.available ? data.activity : null;
  const nativeBal = num(data.nativeBalance);
  const whaleThresholdInfo = effectiveNativeThreshold(data, "whaleThresholdNative", "whaleThresholdUsd", DEFAULT_WHALE_THRESHOLD);
  const whaleThreshold = whaleThresholdInfo.value;
  const txCount = act ? act.txCount : data.nonce;
  const freq = act && act.ageDays ? txCount / Math.max(act.ageDays, 1) : 0;
  const protocols = act?.protocols?.length ?? 0;

  let label = "EOA - Unknown";
  let explanation = "";

  if (data.addressType === "Contract") {
    // Classify the target contract from its own explorer metadata. Activity
    // protocols are contracts touched by the address and must not identify the
    // target itself.
    const name = contractName(data);
    if (/erc.?20|token|usdc|usdt|weth|wbtc|wrapped/.test(name)) {
      label = "Contract - Token";
      explanation = "Likely an ERC-20 / token contract from target contract metadata.";
    } else if (/router|factory|swap|dex/.test(name)) {
      label = "Contract - DEX";
      explanation = "Target contract metadata is named like a DEX router/factory.";
    } else if (/stake|lend|vault|pool|protocol/.test(name)) {
      label = "Contract - Protocol";
      explanation = "Target contract metadata is named like a DeFi protocol contract.";
    } else if (data.contractInfo?.available && data.contractInfo.verified === false) {
      label = "Contract - Unknown";
      explanation = "Unverified contract with no recognized pattern. Higher caution.";
    } else {
      label = "Contract - Unknown";
      explanation = "Smart contract; no verified source/name resolved.";
    }
  } else {
    // EOA
    if (txCount === 0 && data.nonce === 0) {
      label = "EOA - New";
      explanation = "No transaction history; freshly created or unused.";
    } else if (freq > 100) {
      if (protocols >= 1) {
        label = "EOA - MEV";
        explanation = "Very high tx frequency with protocol calls — possible MEV/bot.";
      } else {
        label = "EOA - Bot";
        explanation = "Very high tx frequency (>100/day) — automated pattern.";
      }
    } else if (nativeBal >= whaleThreshold) {
      label = "EOA - Whale";
      explanation = `Holds >=${formatThreshold(whaleThreshold)} native units with moderate+ activity.`;
    } else if (freq === 0 && act?.lastSeen && Date.now() - Date.parse(act.lastSeen) > 30 * 86_400_000) {
      label = "EOA - Dormant";
      explanation = "Previously active but no recent transactions (>30 days).";
    } else if (txCount < 10 && protocols <= 1) {
      label = "EOA - Casual";
      explanation = act
        ? "Low activity, few or single protocol interaction."
        : "Low sender activity; protocol footprint unverifiable (explorer enrichment unavailable).";
    } else {
      label = "EOA - Active";
      explanation = act
        ? "Regular activity across multiple protocols."
        : "Regular sender activity; protocol diversity unverifiable (explorer enrichment unavailable).";
    }
  }

  return {
    label,
    explanation,
    signals: {
      nativeBal,
      txCount,
      freq,
      protocols,
      whaleThreshold,
      whaleThresholdSource: whaleThresholdInfo.source,
    },
  };
}

// ---- Risk score -----------------------------------------------------------
export function riskScore(data, classification) {
  const act = data.activity && data.activity.available ? data.activity : null;
  const nativeBal = num(data.nativeBalance);
  const dormantBalanceInfo = effectiveNativeThreshold(
    data,
    "dormantBalanceThreshold",
    "dormantBalanceThresholdUsd",
    DEFAULT_DORMANT_BALANCE
  );
  const dormantBalance = dormantBalanceInfo.value;
  const hasTokens = (data.tokenHoldings || []).length > 0;
  let score = 0;
  const positives = [];
  const negatives = [];
  const notes = [];

  // Empty balance
  if (nativeBal === 0 && !hasTokens) {
    score += 15;
    negatives.push("Empty balance (no native or token holdings)");
  }
  // Very new / no history
  if (data.nonce === 0 && (!act || act.txCount === 0)) {
    score += 10;
    negatives.push("No transaction history (nonce 0)");
  } else if (act && act.ageDays != null && act.ageDays < 7) {
    score += 10;
    negatives.push(`Very new address (age ${act.ageDays.toFixed(1)} days)`);
  }
  // Contract-specific
  if (data.addressType === "Contract") {
    const info = data.contractInfo;
    const verified = info?.available && info.verified === true;
    const resolved = info?.available && Boolean(info.name);
    if (!verified && !resolved) {
      score += 20;
      negatives.push("Unverified contract, no known pattern");
    } else if (verified) {
      score -= 10;
      positives.push("Verified target contract source");
    }
  }
  // Bot pattern
  if (classification.signals.freq > 100) {
    score += 10;
    negatives.push("High-frequency bot-like pattern");
  }
  // Dormant + large balance
  if (act?.lastSeen && Date.now() - Date.parse(act.lastSeen) > 30 * 86_400_000 && nativeBal > dormantBalance) {
    score += 5;
    negatives.push("Dormant with large balance");
  }
  // Single protocol
  if (act && act.protocols?.length === 1) {
    score += 5;
    negatives.push("Single-protocol interaction");
  }
  // Long history
  if (act && act.ageDays != null && act.ageDays > 90) {
    score -= 10;
    positives.push("Long established history (>90 days)");
  }
  // Protocol diversity
  if (act && (act.protocols?.length ?? 0) >= 3) {
    score -= 5;
    positives.push("Interacts with 3+ distinct protocols");
  }
  // Active consistent
  if (classification.signals.freq > 0 && classification.signals.freq <= 100 && (act?.txCount ?? 0) > 10) {
    score -= 5;
    positives.push("Active with consistent activity");
  }

  if (!act) {
    notes.push(
      "Activity enrichment unavailable — age, protocol diversity, dormancy, and bot-pattern signals cannot be evaluated. Score reflects RPC data only and is floored at MODERATE."
    );
    score += 15; // significant uncertainty: several risk factors cannot be evaluated
    score = Math.max(score, 25); // never rate an unverified-history address as LOW
  }

  score = Math.max(0, Math.min(100, score));
  let level = "LOW";
  if (score > 80) level = "CRITICAL";
  else if (score > 60) level = "HIGH";
  else if (score > 40) level = "ELEVATED";
  else if (score > 20) level = "MODERATE";

  let recommendation =
    level === "LOW"
      ? "Safe to interact."
      : level === "MODERATE"
      ? "Proceed with normal caution."
      : level === "ELEVATED"
      ? "Verify additional details before sending."
      : level === "HIGH"
      ? "Do not send without thorough review."
      : "Do not interact — likely malicious/unknown.";

  if (!act)
    recommendation += " (partial data — verify history independently before sending value.)";

  return { score, level, positives, negatives, notes, recommendation };
}

// ---- Final assembled report ----------------------------------------------
export function buildReport(data) {
  const classification = classify(data);
  const risk = riskScore(data, classification);
  return {
    ...data,
    classification,
    risk,
  };
}

// ---- Human-readable text --------------------------------------------------
export function formatText(report) {
  const r = report;
  const L = [];
  L.push("=== PHAROS ADDRESS INTELLIGENCE REPORT ===");
  L.push(`Address:       ${r.address}`);
  L.push(`Network:       ${r.network} (chainId ${r.chainId})`);
  L.push(`Analyzed:      ${r.analyzedAt}`);
  L.push("");
  L.push("--- IDENTITY ---");
  L.push(`Type:          ${r.addressType}${r.bytecodeSize ? ` (${r.bytecodeSize} bytes)` : ""}`);
  L.push(`Classification: ${r.classification.label}`);
  L.push(`  ${r.classification.explanation}`);
  if (r.activity?.available && r.activity.firstSeen)
    L.push(`First seen:    ${r.activity.firstSeen}`);
  if (r.activity?.available && r.activity.lastSeen)
    L.push(`Last seen:     ${r.activity.lastSeen}`);
  L.push("");
  L.push("--- FINANCIAL ---");
  L.push(`Native:        ${r.nativeBalance} ${r.network.includes("Mainnet") ? "PROS" : "PHRS"}`);
  if (r.tokenHoldings?.length) {
    for (const t of r.tokenHoldings) L.push(`  ${t.symbol}: ${t.balance}`);
  } else {
    L.push("  (no tracked token holdings)");
  }
  L.push("");
  L.push("--- ACTIVITY ---");
  L.push(`Sent tx (nonce): ${r.nonce}`);
  if (r.activity?.available) {
    L.push(`Total tx:      ${r.activity.txCount}`);
    L.push(`Contracts touched: ${r.activity.uniqueContracts}`);
    if (r.activity.protocols?.length)
      L.push(`Protocols:     ${r.activity.protocols.map((p) => p.name).join(", ")}`);
  } else {
    L.push(`(activity enrichment unavailable: ${r.activity?.reason || "n/a"})`);
  }
  L.push("");
  L.push("--- RISK ASSESSMENT ---");
  L.push(`Risk Score:    ${r.risk.score}/100 (${r.risk.level})`);
  if (r.risk.positives.length) L.push("Positive factors:");
  for (const p of r.risk.positives) L.push(`  + ${p}`);
  if (r.risk.negatives.length) L.push("Risk factors:");
  for (const n of r.risk.negatives) L.push(`  - ${n}`);
  if (r.risk.notes.length) for (const n of r.risk.notes) L.push(`  * ${n}`);
  L.push(`Recommendation: ${r.risk.recommendation}`);
  L.push("");
  L.push("Disclaimer: based on public on-chain data. Risk scores are heuristic");
  L.push("estimates, not guarantees. Verify independently before sending funds.");
  L.push("===");
  return L.join("\n");
}

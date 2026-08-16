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

function contractVerification(data) {
  const info = data.contractInfo;
  const available = info?.available === true;
  return {
    info,
    available,
    verified: available && info.verified === true,
  };
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
  const historyComplete = act ? act.historyComplete !== false : false;
  const nativeBal = num(data.nativeBalance);
  const whaleThresholdInfo = effectiveNativeThreshold(data, "whaleThresholdNative", "whaleThresholdUsd", DEFAULT_WHALE_THRESHOLD);
  const whaleThreshold = whaleThresholdInfo.value;
  const txCount = act ? act.txCount : data.nonce;
  const freq = act && historyComplete && act.ageDays ? txCount / Math.max(act.ageDays, 1) : 0;
  const protocols = act?.protocols?.length ?? 0;

  let label = "EOA - Unknown";
  let explanation = "";

  if (data.addressType === "Contract") {
    // Classify the target contract from its own explorer metadata. Activity
    // protocols are contracts touched by the address and must not identify the
    // target itself. Names are spoofable, so only verified metadata may supply
    // a subtype.
    const verification = contractVerification(data);
    const name = verification.verified ? contractName(data) : "";
    if (!verification.available) {
      label = "Contract - Unknown";
      explanation = "Smart contract; explorer source verification and subtype metadata are unavailable.";
    } else if (!verification.verified) {
      label = "Contract - Unknown";
      explanation = verification.info.verified === false
        ? "Contract source is unverified; its metadata name is not trusted for subtype classification."
        : "Contract source verification was not confirmed; its metadata name is not trusted for subtype classification.";
    } else if (/erc.?20|token|usdc|usdt|weth|wbtc|wrapped/.test(name)) {
      label = "Contract - Token";
      explanation = "Likely an ERC-20 / token contract from target contract metadata.";
    } else if (/router|factory|swap|dex/.test(name)) {
      label = "Contract - DEX";
      explanation = "Target contract metadata is named like a DEX router/factory.";
    } else if (/stake|lend|vault|pool|protocol/.test(name)) {
      label = "Contract - Protocol";
      explanation = "Target contract metadata is named like a DeFi protocol contract.";
    } else {
      label = "Contract - Unknown";
      explanation = "Verified smart contract; metadata name has no recognized subtype pattern.";
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
    } else if (historyComplete && freq === 0 && act?.lastSeen && Date.now() - Date.parse(act.lastSeen) > 30 * 86_400_000) {
      label = "EOA - Dormant";
      explanation = "Previously active but no recent transactions (>30 days).";
    } else if (txCount < 10 && (!act || !historyComplete || protocols <= 1)) {
      label = "EOA - Casual";
      explanation = !act
        ? "Low sender activity; protocol footprint unverifiable (explorer enrichment unavailable)."
        : historyComplete
        ? "Low activity, few or single protocol interaction."
        : "Low sender activity; protocol footprint cannot be established from the partial transaction sample.";
    } else {
      label = "EOA - Active";
      explanation = !act
        ? "Regular sender activity; protocol diversity unverifiable (explorer enrichment unavailable)."
        : historyComplete
        ? "Regular activity across multiple protocols."
        : "Regular sender activity; frequency and protocol diversity cannot be established from the partial transaction sample.";
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
      activityHistoryComplete: historyComplete,
    },
  };
}

// ---- Risk score -----------------------------------------------------------
export function riskScore(data, classification) {
  const act = data.activity && data.activity.available ? data.activity : null;
  const historyComplete = act ? act.historyComplete !== false : false;
  const nativeBal = num(data.nativeBalance);
  const dormantBalanceInfo = effectiveNativeThreshold(
    data,
    "dormantBalanceThreshold",
    "dormantBalanceThresholdUsd",
    DEFAULT_DORMANT_BALANCE
  );
  const dormantBalance = dormantBalanceInfo.value;
  const hasTokens = (data.tokenHoldings || []).length > 0;
  const tokenScanIncomplete = data.tokenScan?.complete === false;
  let score = 0;
  const positives = [];
  const negatives = [];
  const notes = [];

  // Empty balance
  if (nativeBal === 0 && !hasTokens) {
    score += 15;
    if (tokenScanIncomplete) {
      negatives.push("Tracked token balance scan incomplete");
      notes.push(
        "No token holdings were reported, but the incomplete tracked token scan does not establish an empty token balance."
      );
    } else {
      negatives.push("Empty balance (no native or token holdings)");
    }
  } else if (tokenScanIncomplete) {
    notes.push("Tracked token scan incomplete — additional token holdings may be missing.");
  }
  // Very new / no history
  if (data.nonce === 0 && (!act || act.txCount === 0)) {
    score += 10;
    negatives.push("No transaction history (nonce 0)");
  } else if (act && historyComplete && act.ageDays != null && act.ageDays < 7) {
    score += 10;
    negatives.push(`Very new address (age ${act.ageDays.toFixed(1)} days)`);
  }
  // Contract-specific
  if (data.addressType === "Contract") {
    const verification = contractVerification(data);
    if (!verification.verified) {
      score += 20;
      if (!verification.available) {
        negatives.push("Target contract verification unavailable");
      } else if (verification.info.verified === false) {
        negatives.push("Unverified target contract source");
      } else {
        negatives.push("Target contract verification not confirmed");
      }
    } else {
      score -= 10;
      positives.push("Verified target contract source");
    }
  }
  // Bot pattern
  if (historyComplete && classification.signals.freq > 100) {
    score += 10;
    negatives.push("High-frequency bot-like pattern");
  }
  // Dormant + large balance
  if (act && historyComplete && act.lastSeen && Date.now() - Date.parse(act.lastSeen) > 30 * 86_400_000 && nativeBal > dormantBalance) {
    score += 5;
    negatives.push("Dormant with large balance");
  }
  // Single protocol
  if (act && historyComplete && act.protocols?.length === 1) {
    score += 5;
    negatives.push("Single-protocol interaction");
  }
  // Long history
  if (act && historyComplete && act.ageDays != null && act.ageDays > 90) {
    score -= 10;
    positives.push("Long established history (>90 days)");
  }
  // Protocol diversity
  if (act && historyComplete && (act.protocols?.length ?? 0) >= 3) {
    score -= 5;
    positives.push("Interacts with 3+ distinct protocols");
  }
  // Active consistent
  if (act && historyComplete && classification.signals.freq > 0 && classification.signals.freq <= 100 && act.txCount > 10) {
    score -= 5;
    positives.push("Active with consistent activity");
  }

  if (!act) {
    notes.push(
      "Activity enrichment unavailable — age, protocol diversity, dormancy, and bot-pattern signals cannot be evaluated. Score reflects RPC data only and is floored at MODERATE."
    );
    score += 15; // significant uncertainty: several risk factors cannot be evaluated
    score = Math.max(score, 25); // never rate an unverified-history address as LOW
  } else if (!historyComplete) {
    notes.push(
      "Activity history is sampled — age, frequency, dormancy, and protocol-diversity signals were not scored. Score is floored at MODERATE."
    );
    score += 10;
    score = Math.max(score, 25);
  }

  if (tokenScanIncomplete) {
    notes.push("Core financial data is incomplete, so the score is floored at MODERATE.");
    score = Math.max(score, 25);
  }

  score = Math.max(0, Math.min(100, score));
  let level = "LOW";
  if (score > 80) level = "CRITICAL";
  else if (score > 60) level = "HIGH";
  else if (score > 40) level = "ELEVATED";
  else if (score > 20) level = "MODERATE";

  let recommendation =
    level === "LOW"
      ? "Few risk signals were observed; verify independently before sending value."
      : level === "MODERATE"
      ? "Some risk or uncertainty signals were observed; verify independently before sending value."
      : level === "ELEVATED"
      ? "Meaningful risk or uncertainty signals were observed; perform additional verification before sending value."
      : level === "HIGH"
      ? "Strong risk signals were observed; avoid sending value unless independent review resolves them."
      : "Severe risk signals were observed; avoid interaction unless independent verification resolves them.";

  if (!act)
    recommendation += " (partial data — verify history independently before sending value.)";
  else if (!historyComplete)
    recommendation += " (sampled activity — verify full history independently before sending value.)";

  return { score, level, positives, negatives, notes, recommendation };
}

// ---- Final assembled report ----------------------------------------------
export function buildReport(data) {
  const classification = classify(data);
  const risk = riskScore(data, classification);
  return {
    ...data,
    status: typeof data.confidence === "string" && data.confidence.toLowerCase().startsWith("partial")
      ? "PARTIAL"
      : "COMPLETE",
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
  const nativeSymbol = r.nativeCurrency || (r.network.includes("Mainnet") ? "PROS" : "PHRS");
  L.push(`Native:        ${r.nativeBalance} ${nativeSymbol}`);
  if (r.tokenHoldings?.length) {
    for (const t of r.tokenHoldings) L.push(`  ${t.symbol}: ${t.balance}`);
    if (r.tokenScan?.complete === false)
      L.push("  (tracked token scan incomplete; additional holdings may be missing)");
  } else if (r.tokenScan?.complete === false) {
    L.push("  (tracked token scan incomplete; token holdings may be missing)");
  } else {
    L.push("  (no tracked token holdings)");
  }
  L.push("");
  L.push("--- ACTIVITY ---");
  L.push(`Sent tx (nonce): ${r.nonce}`);
  if (r.activity?.available) {
    L.push(`Total tx:      ${r.activity.txCount}`);
    L.push(
      `${r.activity.historyComplete === false ? "Contracts in sample" : "Contracts touched"}: ${r.activity.uniqueContracts}`
    );
    if (r.activity.protocols?.length)
      L.push(`Protocols:     ${r.activity.protocols.map((p) => p.name).join(", ")}`);
    if (r.activity.historyComplete === false)
      L.push("(activity history sampled; age, frequency, and protocol coverage are incomplete)");
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

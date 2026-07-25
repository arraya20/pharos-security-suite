import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, formatText } from "../scripts/lib/report.mjs";

const baseContract = {
  address: "0x0000000000000000000000000000000000000001",
  network: "Pharos Pacific Mainnet",
  chainId: 1672,
  analyzedAt: "2026-07-09T00:00:00.000Z",
  addressType: "Contract",
  bytecodeSize: 1024,
  nativeBalanceWei: "0x0",
  nativeBalance: "0",
  tokenHoldings: [],
  nonce: 1,
  activity: { available: false, reason: "offline mode" },
  confidence: "partial (explorer unavailable)",
};

test("classifies the target contract from its own explorer metadata", () => {
  const report = buildReport({
    ...baseContract,
    contractInfo: {
      available: true,
      name: "Pharos USDC Token",
      verified: true,
    },
    activity: {
      available: true,
      txCount: 50,
      protocols: [{ name: "Random Router", verified: false }],
      ageDays: 100,
    },
  });

  assert.equal(report.classification.label, "Contract - Token");
  assert.match(report.classification.explanation, /target contract metadata/i);
});

test("does not trust an unverified contract name for subtype classification", () => {
  const report = buildReport({
    ...baseContract,
    contractInfo: {
      available: true,
      name: "Pharos USDC Token",
      verified: false,
    },
    activity: {
      available: true,
      txCount: 20,
      protocols: [],
      ageDays: 30,
    },
  });

  assert.equal(report.classification.label, "Contract - Unknown");
  assert.match(report.classification.explanation, /name is not trusted/i);
  assert.ok(report.risk.negatives.includes("Unverified target contract source"));
});

test("does not trust a contract name when verification is not confirmed", () => {
  const report = buildReport({
    ...baseContract,
    contractInfo: {
      available: true,
      name: "Official DEX Router",
      verified: null,
    },
    activity: {
      available: true,
      txCount: 20,
      protocols: [],
      ageDays: 30,
    },
  });

  assert.equal(report.classification.label, "Contract - Unknown");
  assert.match(report.classification.explanation, /verification was not confirmed/i);
  assert.ok(report.risk.negatives.includes("Target contract verification not confirmed"));
});

test("applies the contract verification penalty without claiming explorer data exists", () => {
  const report = buildReport({
    ...baseContract,
    contractInfo: {
      available: false,
      reason: "explorer http 404",
    },
    activity: {
      available: true,
      txCount: 20,
      protocols: [],
      ageDays: 30,
    },
  });

  assert.equal(report.classification.label, "Contract - Unknown");
  assert.match(report.classification.explanation, /verification.*unavailable/i);
  assert.ok(report.risk.negatives.includes("Target contract verification unavailable"));
  assert.equal(report.risk.score, 30);
});

test("uses target contract verification status for risk scoring", () => {
  const report = buildReport({
    ...baseContract,
    contractInfo: {
      available: true,
      name: "Verified Vault",
      verified: true,
    },
    activity: {
      available: true,
      txCount: 20,
      protocols: [],
      ageDays: 120,
    },
  });

  assert.ok(report.risk.positives.includes("Verified target contract source"));
  assert.ok(!report.risk.negatives.includes("Unverified contract, no known pattern"));
  assert.doesNotMatch(report.risk.recommendation, /safe to interact|do not interact/i);
  assert.match(report.risk.recommendation, /verify independently/i);
});

test("classifies an unused EOA conservatively when explorer enrichment is unavailable", () => {
  const report = buildReport({
    address: "0x0000000000000000000000000000000000000002",
    network: "Pharos Atlantic Testnet",
    chainId: 688689,
    analyzedAt: "2026-07-09T00:00:00.000Z",
    addressType: "EOA",
    nativeBalanceWei: "0x0",
    nativeBalance: "0",
    tokenHoldings: [],
    nonce: 0,
    activity: { available: false, reason: "explorer http 404/404" },
    confidence: "partial (explorer unavailable)",
  });

  assert.equal(report.classification.label, "EOA - New");
  assert.equal(report.risk.score, 40);
  assert.equal(report.risk.level, "MODERATE");
  assert.match(report.risk.notes.join("\n"), /Activity enrichment unavailable/);
});

test("does not claim an empty token balance when the tracked token scan is incomplete", () => {
  const report = buildReport({
    address: "0x0000000000000000000000000000000000000004",
    network: "Pharos Atlantic Testnet",
    chainId: 688689,
    analyzedAt: "2026-07-09T00:00:00.000Z",
    addressType: "EOA",
    nativeBalanceWei: "0x0",
    nativeBalance: "0",
    tokenHoldings: [],
    tokenScan: {
      complete: false,
      failures: [{ symbol: "USDC", reason: "rpc unavailable" }],
    },
    nonce: 5,
    activity: {
      available: true,
      historyComplete: true,
      txCount: 5,
      protocols: [],
      ageDays: 30,
    },
    confidence: "partial (token scan incomplete)",
  });

  assert.ok(!report.risk.negatives.includes("Empty balance (no native or token holdings)"));
  assert.ok(report.risk.negatives.includes("Tracked token balance scan incomplete"));
  assert.match(report.risk.notes.join("\n"), /does not establish an empty token balance/i);
  assert.match(report.risk.notes.join("\n"), /floored at MODERATE/i);
  assert.equal(report.risk.score, 25);
  assert.equal(report.risk.level, "MODERATE");

  const text = formatText(report);
  assert.match(text, /tracked token scan incomplete/i);
  assert.doesNotMatch(text, /no tracked token holdings/i);
});

test("does not score full-history activity signals from a partial transaction sample", () => {
  const sampledDiverseActivity = buildReport({
    address: "0x0000000000000000000000000000000000000005",
    network: "Pharos Atlantic Testnet",
    chainId: 688689,
    analyzedAt: "2026-07-09T00:00:00.000Z",
    addressType: "EOA",
    nativeBalanceWei: "0x1",
    nativeBalance: "1",
    tokenHoldings: [],
    nonce: 20_000,
    activity: {
      available: true,
      historyComplete: false,
      txCount: 20_000,
      protocols: [{ name: "DEX" }, { name: "Lending" }, { name: "Bridge" }],
      ageDays: 100,
      firstSeen: "2025-01-01T00:00:00.000Z",
      lastSeen: "2025-04-11T00:00:00.000Z",
    },
    confidence: "partial (activity history sampled)",
  });

  assert.equal(sampledDiverseActivity.classification.label, "EOA - Active");
  assert.match(sampledDiverseActivity.classification.explanation, /cannot be established from the partial transaction sample/i);
  assert.ok(!sampledDiverseActivity.risk.negatives.includes("High-frequency bot-like pattern"));
  assert.ok(!sampledDiverseActivity.risk.positives.includes("Long established history (>90 days)"));
  assert.ok(!sampledDiverseActivity.risk.positives.includes("Interacts with 3+ distinct protocols"));
  assert.match(sampledDiverseActivity.risk.notes.join("\n"), /Activity history is sampled/i);
  assert.equal(sampledDiverseActivity.risk.score, 25);
  assert.equal(sampledDiverseActivity.risk.level, "MODERATE");
  const sampledText = formatText(sampledDiverseActivity);
  assert.match(sampledText, /activity history sampled/i);
  assert.match(sampledText, /Contracts in sample:/);
  assert.doesNotMatch(sampledText, /Contracts touched:/);

  const sampledSingleProtocol = buildReport({
    ...sampledDiverseActivity,
    classification: undefined,
    risk: undefined,
    activity: {
      ...sampledDiverseActivity.activity,
      txCount: 100,
      protocols: [{ name: "DEX" }],
    },
  });

  assert.ok(!sampledSingleProtocol.risk.negatives.includes("Single-protocol interaction"));
  assert.ok(!sampledSingleProtocol.risk.positives.includes("Active with consistent activity"));
});

test("formats a human-readable report with risk evidence and disclaimer", () => {
  const report = buildReport({
    address: "0x0000000000000000000000000000000000000002",
    network: "Pharos Atlantic Testnet",
    chainId: 688689,
    analyzedAt: "2026-07-09T00:00:00.000Z",
    addressType: "EOA",
    nativeBalanceWei: "0x0",
    nativeBalance: "0",
    tokenHoldings: [],
    nonce: 0,
    activity: { available: false, reason: "offline mode" },
    confidence: "partial (explorer unavailable)",
  });

  const text = formatText(report);

  assert.match(text, /PHAROS ADDRESS INTELLIGENCE REPORT/);
  assert.match(text, /Classification: EOA - New/);
  assert.match(text, /Risk Score:\s+40\/100 \(MODERATE\)/);
  assert.match(text, /Disclaimer: based on public on-chain data/);
});

test("uses native USD price to adjust mainnet whale threshold", () => {
  const staticThresholdReport = buildReport({
    address: "0x0000000000000000000000000000000000000003",
    network: "Pharos Pacific Mainnet",
    chainId: 1672,
    analyzedAt: "2026-07-09T00:00:00.000Z",
    addressType: "EOA",
    nativeBalanceWei: "0x0",
    nativeBalance: "150000",
    tokenHoldings: [],
    nonce: 12,
    activity: {
      available: true,
      txCount: 12,
      protocols: [],
      ageDays: 30,
    },
    confidence: "full",
  });
  const priceAdjustedReport = buildReport({
    ...staticThresholdReport,
    nativePrice: {
      available: true,
      usd: 0.25,
      source: "test",
    },
  });

  assert.equal(staticThresholdReport.classification.label, "EOA - Whale");
  assert.equal(priceAdjustedReport.classification.label, "EOA - Active");
  assert.equal(priceAdjustedReport.classification.signals.whaleThreshold, 200000);
});

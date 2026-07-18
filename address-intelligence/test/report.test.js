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

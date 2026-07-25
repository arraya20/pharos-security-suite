#!/usr/bin/env node
// inspect.mjs — CLI for Pharos Address Intelligence.
//   node scripts/inspect.mjs <address> [--network mainnet|testnet] [--json] [--offline]
//
// Pure read-only. No private key, no transactions, no gas.

import { analyzeAddress } from "./lib/analyze.mjs";
import { buildReport, formatText } from "./lib/report.mjs";

function parseArgs(argv) {
  const out = { address: null, network: "atlantic_testnet", json: false, offline: false };
  const map = { testnet: "atlantic_testnet", mainnet: "pacific_mainnet" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--network") out.network = map[argv[++i]] ?? argv[i];
    else if (a.startsWith("--network=")) out.network = map[a.split("=")[1]] ?? a.split("=")[1];
    else if (!out.address) out.address = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.address) {
    console.error("Usage: node scripts/inspect.mjs <address> [--network mainnet|testnet] [--json] [--offline]");
    process.exit(2);
  }
  try {
    const data = await analyzeAddress(args.address, args.network, { offline: args.offline });
    const report = buildReport(data);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatText(report));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();

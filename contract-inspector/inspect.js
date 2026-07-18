#!/usr/bin/env node
// inspect.js — Pharos Contract Inspector CLI.
// Thin wrapper around lib/inspect-core.js so CLI and HTTP API share one pipeline.
// Usage: node inspect.js <address> [--network testnet|mainnet] [--rpc URL] [--json]

import { inspectContract, loadNetworks, jsonStringify } from "./lib/inspect-core.js";
import { formatUnits } from "./lib/format.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { network: "testnet", rpc: null, json: false, online: true };
  let addr = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--network" || args[i] === "-n") opts.network = args[++i];
    else if (args[i] === "--rpc") opts.rpc = args[++i];
    else if (args[i] === "--json") opts.json = true;
    else if (args[i] === "--offline") opts.online = false;
    else if (args[i] === "--help" || args[i] === "-h") { usage(); process.exit(0); }
    else if (!addr && args[i].startsWith("0x")) addr = args[i];
  }
  if (!addr) { usage(); process.exit(1); }
  opts.addr = addr;
  return opts;
}

function usage() {
  console.log(`
  Pharos Contract Inspector — ABI-free EVM contract introspection

  Usage: node inspect.js <0xADDRESS> [options]

  Options:
    -n, --network <testnet|mainnet>   Pharos network (default: testnet)
    --rpc <URL>                       Custom RPC endpoint
    --json                            Output raw JSON
    --offline                         Skip 4byte.directory lookups
    -h, --help                        Show this help

  Examples:
    node inspect.js 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B --network testnet
    node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 -n mainnet
    node inspect.js 0xcA11bde05977b3631167028862bE2a173976CA11 --json
  `.trim());
}

function renderReport(report, net) {
  if (report.type === "EOA") {
    return `\n  RESULT: EOA (Externally Owned Account)\n\n  Address:       ${report.address}\n  Balance:       ${report.balanceNative} ${report.nativeSymbol}\n`;
  }

  const lines = [];
  const br = () => lines.push("");
  const sep = () => lines.push("  " + "─".repeat(56));
  const meta = report.metadata || {};
  const proxy = report.proxy;
  const risk = report.risk;
  const known = report.functions.known || [];
  const resolved = report.functions.resolved || [];
  const unresolved = report.functions.unresolved || [];
  const dangerous = report.dangerous || [];
  const op = report.opcodeSignals || {};

  lines.push("");
  lines.push("  ╔══════════════════════════════════════════════════════╗");
  lines.push("  ║   PHAROS CONTRACT INSPECTOR — ABI-Free Report       ║");
  lines.push("  ╚══════════════════════════════════════════════════════╝");
  br();
  lines.push(`  Address:   ${report.address}`);
  lines.push(`  Network:   ${net.name} (chainId ${report.chainId})`);
  lines.push(`  Bytecode:  ${report.bytecode.size} bytes`);
  br();

  sep();
  lines.push("  RISK SUMMARY (pre-flight, not a full audit)");
  sep();
  lines.push(`  Score:    ${risk.score}/100`);
  lines.push(`  Level:    ${risk.level}`);
  lines.push(`  Headline: ${risk.headline}`);
  lines.push("");
  lines.push("  Risk flags:");
  for (const f of risk.flags) {
    const icon = f.status === "pass" ? "✓" : f.status === "info" ? "ⓘ" : "⚠️";
    lines.push(`  ${icon} ${f.check} (${f.scoreImpact >= 0 ? "+" : ""}${f.scoreImpact}) — ${f.details}`);
    if (f.evidence?.length) lines.push(`     Evidence: ${f.evidence.join(", ")}`);
  }
  br();

  sep();
  lines.push("  PROXY STATUS");
  sep();
  if (proxy) {
    lines.push(`  ⚠️  PROXY DETECTED — ${proxy.type}`);
    lines.push(`  Implementation: ${proxy.implementation}`);
    if (proxy.admin) lines.push(`  Admin:          ${proxy.admin}`);
  } else {
    lines.push("  Not a proxy (direct deployment)");
  }
  br();

  sep();
  lines.push("  CONTRACT METADATA (live eth_call)");
  sep();
  if (meta.name) lines.push(`  Name:         ${meta.name}`);
  if (meta.symbol) lines.push(`  Symbol:       ${meta.symbol}`);
  if (meta.decimals != null) lines.push(`  Decimals:     ${meta.decimals}`);
  if (meta.totalSupply != null) {
    const d = meta.decimals ?? 18;
    const human = formatUnits(meta.totalSupply, d);
    lines.push(`  Total Supply: ${human} (${meta.totalSupply})`);
  }
  if (meta.owner) lines.push(`  Owner:        ${meta.owner}`);
  if (meta.errors?.length) {
    lines.push(`  ⚠️  Incomplete: ${meta.errors.length} metadata call(s) did not return (${meta.errors.join(", ")})`);
    if (meta.errors.includes("owner")) lines.push("     owner() unknown — risk score may under-report admin exposure. Re-run to confirm.");
  }
  br();

  if (report.standards.length) {
    sep();
    lines.push("  DETECTED STANDARDS");
    sep();
    for (const s of report.standards) lines.push(`  ✓ ${s}`);
    br();
  }

  sep();
  lines.push("  FUNCTION SELECTOR INVENTORY");
  sep();
  lines.push(`  Extracted from bytecode:  ${report.selectors.total} selectors`);
  lines.push(`  Matched to known sigs:    ${report.selectors.known}`);
  lines.push(`  Unknown (need 4byte/ABI): ${report.selectors.unknown}`);
  br();

  if (known.length) {
    lines.push("  KNOWN FUNCTIONS");
    lines.push("");
    for (const k of known) {
      const flag = dangerous.some((d) => d.selector === k.selector) ? " ⚠️" : "";
      lines.push(`  ${k.selector}  ${k.signature}${flag}`);
    }
    br();
  }

  if (resolved.length) {
    lines.push("  RESOLVED (via 4byte.directory)");
    lines.push("");
    for (const r of resolved) lines.push(`  ${r.selector}  ${r.signature}`);
    br();
  }

  if (unresolved.length) {
    lines.push("  UNRESOLVED SELECTORS");
    lines.push("");
    for (const s of unresolved) lines.push(`  ${s}`);
    br();
  }

  if (dangerous.length || op.hasDelegateCall || op.hasSelfdestruct) {
    sep();
    lines.push("  ⚠️  PRIVILEGED / DANGEROUS FUNCTIONS");
    sep();
    for (const d of dangerous) {
      lines.push(`  🚩 ${d.selector}  ${d.signature || d.reason}`);
      lines.push(`     Reason: ${d.reason}`);
    }
    if (op.hasDelegateCall) lines.push("  🚩 DELEGATECALL opcode present in bytecode (proxy/arbitrary call risk)");
    if (op.hasSelfdestruct) lines.push("  🚩 SELFDESTRUCT opcode present in bytecode (can destroy the contract)");
    if (op.hasCreate) lines.push("  ⚡ CREATE opcode present (factory — deploys new contracts)");
    if (op.hasCreate2) lines.push("  ⚡ CREATE2 opcode present (factory — deterministic deployment)");
    br();
  }

  if (report.implementation) {
    sep();
    lines.push("  IMPLEMENTATION CONTRACT ANALYSIS");
    sep();
    lines.push(`  Impl address:  ${report.implementation.address}`);
    lines.push(`  Impl bytecode: ${report.implementation.bytecodeSize} bytes`);
    lines.push(`  Impl selectors: ${report.implementation.selectors}`);
    if (report.implementation.privilegedSelectors.length) {
      lines.push("");
      lines.push("  Privileged functions IN IMPLEMENTATION:");
      for (const s of report.implementation.privilegedSelectors) lines.push(`  🚩 ${s.selector}  ${s.signature}`);
    }
    br();
  }

  sep();
  lines.push("  END OF REPORT");
  sep();
  br();
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs();
  const networks = loadNetworks();
  const net = networks[opts.network];
  if (!net) { console.error(`Unknown network: ${opts.network}`); process.exit(1); }

  process.stderr.write(`Inspecting ${opts.addr} on ${net.name} (${net.chainId})...\n`);
  const report = await inspectContract({ address: opts.addr, network: opts.network, rpcUrl: opts.rpc, online: opts.online });

  if (opts.json) console.log(jsonStringify(report));
  else console.log(renderReport(report, net));
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});

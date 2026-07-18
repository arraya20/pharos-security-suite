// inspect-core.js — reusable inspection pipeline for CLI and HTTP API.

import { readFileSync } from "fs";
import { Rpc } from "./rpc.js";
import { disassemble } from "./disasm.js";
import { KNOWN, PRIVILEGED, FINGERPRINTS, INTERFACE_IDS } from "./signatures.js";
import { resolveProxy } from "./proxy.js";
import { readMetadata, probeInterfaces } from "./decode.js";
import { resolveMany } from "./fourbyte.js";
import { assessRisk } from "./risk.js";
import { formatUnits } from "./format.js";

export function loadNetworks() {
  return JSON.parse(readFileSync(new URL("../networks.json", import.meta.url), "utf8"));
}

export function chainIdToNumber(chainId) {
  if (typeof chainId === "number") return chainId;
  if (typeof chainId === "bigint") return Number(chainId);
  if (typeof chainId === "string" && chainId.startsWith("0x")) return Number(BigInt(chainId));
  return Number(chainId);
}

export function assertExpectedChainId(actualChainId, expectedChainId, network) {
  const actual = chainIdToNumber(actualChainId);
  if (!Number.isSafeInteger(actual)) throw new Error(`Invalid RPC chainId for ${network}: ${actualChainId}`);
  if (actual !== expectedChainId) {
    throw new Error(`RPC chainId mismatch for ${network}: expected ${expectedChainId}, got ${actual}`);
  }
  return actual;
}

export function detectStandards(selectors, interfaces = [], implementationSelectors = []) {
  const selSet = new Set([...(selectors || []), ...(implementationSelectors || [])]);
  const standards = [];
  for (const fp of FINGERPRINTS) {
    const matched = fp.required.every((s) => selSet.has(s)) && (!fp.anyOf || fp.anyOf.some((s) => selSet.has(s)));
    if (matched) standards.push(fp.name);
  }
  for (const name of interfaces) if (!standards.includes(name)) standards.push(name);
  return standards;
}

export async function inspectContract({ address, network = "testnet", rpcUrl = null, online = true }) {
  const networks = loadNetworks();
  const net = networks[network];
  if (!net) throw new Error(`Unknown network: ${network}`);
  const rpc = new Rpc(rpcUrl || net.rpc);
  const chainId = assertExpectedChainId(await rpc.chainId(), net.chainId, network);

  const codeHex = await rpc.getCode(address);
  if (!codeHex || codeHex === "0x" || codeHex.length <= 2) {
    const bal = await rpc.getBalance(address);
    return {
      address,
      network,
      chainId,
      type: "EOA",
      balanceWei: BigInt(bal).toString(),
      balanceNative: formatUnits(BigInt(bal), 18),
      nativeSymbol: net.nativeSymbol,
    };
  }

  const dis = disassemble(codeHex);
  const proxy = await resolveProxy(rpc, address, codeHex);
  let implDis = null;
  if (proxy.isProxy && proxy.impl) {
    const implCode = await rpc.getCode(proxy.impl);
    if (implCode && implCode !== "0x" && implCode.length > 2) implDis = disassemble(implCode);
  }

  const known = [];
  const unknown = [];
  const dangerous = [];
  for (const sel of dis.selectors) {
    const sig = KNOWN[sel] || null;
    if (sig) known.push({ selector: sel, signature: sig });
    else unknown.push(sel);
    if (PRIVILEGED[sel]) dangerous.push({ selector: sel, signature: sig || PRIVILEGED[sel], reason: PRIVILEGED[sel] });
  }

  let resolved = {};
  if (unknown.length > 0 && online) resolved = await resolveMany(unknown);
  const resolvedFunctions = Object.entries(resolved).filter(([, v]) => v).map(([selector, signature]) => ({ selector, signature }));
  const unresolvedSelectors = unknown.filter((s) => !resolved[s]);

  const interfaces = [];
  if (known.some((k) => k.selector === "0x01ffc9a7")) {
    const probed = await probeInterfaces(rpc, address, INTERFACE_IDS);
    for (const p of probed) if (p.supported) interfaces.push(p.name);
  }

  const standards = detectStandards(dis.selectors, interfaces, implDis?.selectors || []);

  const meta = await readMetadata(rpc, address);

  const risk = assessRisk({ proxy, dis, implDis, dangerous, standards, meta, resolvedFunctions, unresolvedSelectors });

  return {
    address,
    network,
    chainId,
    type: "Contract",
    bytecode: { size: dis.codeSize, head: codeHex.slice(0, 10) },
    proxy: proxy.isProxy ? { type: proxy.type, implementation: proxy.impl, admin: proxy.admin } : null,
    metadata: meta,
    standards,
    interfaces,
    selectors: { total: dis.selectors.length, known: known.length, unknown: unknown.length },
    functions: {
      known: known.map((k) => ({ selector: k.selector, signature: k.signature })),
      resolved: resolvedFunctions,
      unresolved: unresolvedSelectors,
    },
    dangerous,
    risk,
    opcodeSignals: {
      hasDelegateCall: dis.hasDelegateCall,
      hasSelfdestruct: dis.hasSelfdestruct,
      hasCreate: dis.hasCreate,
      hasCreate2: dis.hasCreate2,
    },
    implementation: implDis ? {
      address: proxy.impl,
      bytecodeSize: implDis.codeSize,
      selectors: implDis.selectors.length,
      privilegedSelectors: implDis.selectors.filter((s) => PRIVILEGED[s]).map((selector) => ({ selector, signature: KNOWN[selector] || PRIVILEGED[selector] })),
    } : null,
  };
}

export function jsonStringify(value) {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

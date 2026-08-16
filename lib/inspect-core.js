// inspect-core.js — reusable inspection pipeline for CLI and HTTP API.

import { readFileSync } from "fs";
import { Rpc, createRpcClient } from "./rpc.js";
import { disassemble } from "./disasm.js";
import { KNOWN, PRIVILEGED, FINGERPRINTS, INTERFACE_IDS } from "./signatures.js";
import { resolveProxy } from "./proxy.js";
import { readMetadata, probeInterfaces } from "./decode.js";
import { resolveManyDetailed } from "./fourbyte.js";
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

export async function inspectContract({
  address,
  network = "testnet",
  rpcUrl = null,
  online = true,
  rpc: providedRpc = null,
  rpcOptions = null,
  rpcPoolOptions = null,
  signal = null,
}) {
  const networks = loadNetworks();
  const net = networks[network];
  if (!net) throw new Error(`Unknown network: ${network}`);
  const effectiveRpcOptions = { ...(rpcOptions || {}), signal };
  const rpc = providedRpc || (rpcUrl
    ? new Rpc(rpcUrl, effectiveRpcOptions)
    : createRpcClient(net, { rpcOptions: effectiveRpcOptions, poolOptions: rpcPoolOptions }));
  const [actualChainId, snapshotBlock] = await Promise.all([
    rpc.chainId(),
    rpc.getBlockNumber(),
  ]);
  const chainId = assertExpectedChainId(actualChainId, net.chainId, network);

  const codeHex = await rpc.getCode(address, snapshotBlock);
  if (!codeHex || codeHex === "0x" || codeHex.length <= 2) {
    const bal = await rpc.getBalance(address, snapshotBlock);
    return {
      address,
      network,
      chainId,
      snapshotBlock,
      type: "EOA",
      status: "COMPLETE",
      balanceWei: BigInt(bal).toString(),
      balanceNative: formatUnits(BigInt(bal), 18),
      nativeSymbol: net.nativeSymbol,
    };
  }

  const dis = disassemble(codeHex);
  const proxy = await resolveProxy(rpc, address, codeHex, snapshotBlock);
  const incomplete = [];
  if (proxy.errors?.length) {
    incomplete.push({
      code: "PROXY_PROBE_FAILED",
      message: "One or more proxy detection probes failed; upgradeability may be under-reported.",
    });
  }
  let implDis = null;
  if (proxy.isProxy && proxy.impl) {
    const implCode = await rpc.getCode(proxy.impl, snapshotBlock);
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
  if (unknown.length > 0 && online) {
    const lookup = await resolveManyDetailed(unknown, { signal });
    resolved = lookup.signatures;
    if (lookup.errors.length) {
      incomplete.push({
        code: "SELECTOR_LOOKUP_FAILED",
        message: "One or more selector signature lookups failed; function classification may be incomplete.",
      });
    }
  }
  const resolvedFunctions = Object.entries(resolved).filter(([, v]) => v).map(([selector, signature]) => ({ selector, signature }));
  const unresolvedSelectors = unknown.filter((s) => !resolved[s]);

  const interfaces = [];
  if (known.some((k) => k.selector === "0x01ffc9a7")) {
    const probed = await probeInterfaces(rpc, address, INTERFACE_IDS, snapshotBlock);
    for (const p of probed) if (p.supported) interfaces.push(p.name);
    if (probed.some((result) => result.error)) {
      incomplete.push({
        code: "INTERFACE_PROBE_FAILED",
        message: "One or more interface probes failed; detected standards may be incomplete.",
      });
    }
  }

  const standards = detectStandards(dis.selectors, interfaces, implDis?.selectors || []);

  const meta = await readMetadata(rpc, address, snapshotBlock);
  if (meta.errors.length) {
    incomplete.push({
      code: "METADATA_READ_FAILED",
      message: "One or more metadata reads failed; ownership or token details may be under-reported.",
    });
  }

  const risk = assessRisk({ proxy, dis, implDis, dangerous, standards, meta, resolvedFunctions, unresolvedSelectors });

  return {
    address,
    network,
    chainId,
    snapshotBlock,
    type: "Contract",
    status: incomplete.length ? "PARTIAL" : "COMPLETE",
    bytecode: { size: dis.codeSize, head: codeHex.slice(0, 10) },
    proxy: proxy.isProxy
      ? {
          type: proxy.type,
          implementation: proxy.impl,
          admin: proxy.admin,
          ...(proxy.beacon ? { beacon: proxy.beacon } : {}),
        }
      : null,
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
    ...(incomplete.length ? { incomplete } : {}),
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

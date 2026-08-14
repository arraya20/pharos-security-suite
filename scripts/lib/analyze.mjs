// analyze.mjs — collect on-chain signals for a Pharos address.
//
// Design goals (mirrors pharos-contract-inspector):
//   * Pure JSON-RPC for the core signals so the tool works even when the
//     explorer API is rate-limited / behind a checkpoint.
//   * Explorer API is used ONLY for best-effort enrichment (sampled activity,
//     first/last seen, protocol naming). If it fails, the report still works.
//   * Zero runtime dependencies beyond Node built-ins.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRpcClient } from "./rpc.mjs";
import { createSocialScanProvider } from "./socialscan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const networks = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "networks.json"), "utf8")
);
const tokensByNet = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "tokens.json"), "utf8")
);

// Exposed for report.mjs so per-network thresholds (e.g. whale cutoff) stay
// config-driven rather than hardcoded.
export const networksConfig = networks;

// balanceOf(address) selector + 32-byte left-padded address argument.
const BALANCE_OF_SELECTOR = "0x70a08231";
function encodeBalanceOf(addr) {
  return BALANCE_OF_SELECTOR + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// uint (hex) -> decimal string with `decimals` places, trailing zeros trimmed.
export function formatUnits(hexValue, decimals) {
  const v = typeof hexValue === "bigint" ? hexValue : BigInt(hexValue || "0x0");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function isValidAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export function chainIdToNumber(chainId) {
  try {
    const value = typeof chainId === "bigint"
      ? Number(chainId)
      : typeof chainId === "string" && chainId.startsWith("0x")
        ? Number(BigInt(chainId))
        : Number(chainId);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export function assertExpectedChainId(actualChainId, expectedChainId, network) {
  const actual = chainIdToNumber(actualChainId);
  if (actual === null) {
    const error = new Error(`Invalid RPC chainId for ${network}`);
    error.code = "RPC_INVALID_CHAIN_ID";
    throw error;
  }
  if (actual !== expectedChainId) {
    const error = new Error(
      `RPC chainId mismatch for ${network}: expected ${expectedChainId}, got ${actual}`
    );
    error.code = "CHAIN_ID_MISMATCH";
    throw error;
  }
  return actual;
}

function validNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function envPriceUsd(net) {
  const keys = [net.nativePriceUsdEnv, `${net.nativeCurrency}_PRICE_USD`, "NATIVE_PRICE_USD"].filter(Boolean);
  for (const key of keys) {
    const value = validNumber(process.env[key]);
    if (value) return { available: true, usd: value, source: `env:${key}` };
  }
  return null;
}

function parsePricePayload(json, net) {
  return (
    validNumber(json?.usd) ||
    validNumber(json?.priceUsd) ||
    validNumber(json?.price_usd) ||
    validNumber(json?.[net.nativeCurrency]?.usd) ||
    validNumber(json?.[String(net.nativeCurrency || "").toLowerCase()]?.usd)
  );
}

async function fetchNativePriceUsd(net, { offline, fetchImpl, signal = null }) {
  const envPrice = envPriceUsd(net);
  if (envPrice) return envPrice;
  if (offline) return { available: false, reason: "offline mode" };
  if (!net.nativePriceUsdUrl) return { available: false, reason: "no native price feed configured" };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const requestSignal = signal
      ? AbortSignal.any([ctrl.signal, signal])
      : ctrl.signal;
    const res = await fetchImpl(net.nativePriceUsdUrl, { signal: requestSignal });
    if (!res.ok) return { available: false, reason: `price feed http ${res.status}` };
    const json = await res.json();
    const usd = parsePricePayload(json, net);
    if (!usd) return { available: false, reason: "price feed missing usd value" };
    return { available: true, usd, source: net.nativePriceUsdUrl };
  } catch (e) {
    return { available: false, reason: e?.name === "AbortError" ? "price feed timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeTokenHoldings(registryHoldings, discoveredHoldings) {
  const byAddress = new Map();
  for (const holding of registryHoldings) {
    byAddress.set(holding.address.toLowerCase(), { ...holding, source: "registry" });
  }
  for (const holding of discoveredHoldings) {
    const key = holding.address.toLowerCase();
    const existing = byAddress.get(key);
    if (existing) {
      existing.sources = [...new Set([existing.source, "explorer"])];
      continue;
    }
    byAddress.set(key, holding);
  }
  return [...byAddress.values()];
}

// Main entry: gather all signals for an address.
export async function analyzeAddress(address, networkKey = "atlantic_testnet", opts = {}) {
  const offline = opts.offline === true;
  const fetchImpl = opts.fetch || fetch;
  const net = networks.networks[networkKey];
  if (!net) throw new Error(`Unknown network "${networkKey}". Available: ${Object.keys(networks.networks).join(", ")}`);
  if (!isValidAddress(address)) throw new Error(`Invalid address "${address}" — expected 0x + 40 hex chars`);

  const rpc = opts.rpc || createRpcClient(net, {
    rpcOptions: { ...(opts.rpcOptions || {}), signal: opts.signal || null },
    poolOptions: opts.rpcPoolOptions,
  });
  const explorerApiKey =
    opts.explorerApiKey ??
    process.env[net.explorerApiKeyEnv || "SOCIALSCAN_API_KEY"] ??
    "";
  const addrLower = address.toLowerCase(); // normalized for calls/comparisons
  const [actualChainId, snapshotBlock] = await Promise.all([
    rpc.chainId(),
    rpc.getBlockNumber(),
  ]);
  const chainId = assertExpectedChainId(actualChainId, net.chainId, networkKey);
  const explorer = createSocialScanProvider({
    baseUrl: net.explorerApiUrl,
    apiKey: explorerApiKey,
    fetchImpl,
    activityPageSize: opts.explorerActivityPageSize,
    getLatestBlock: async () => snapshotBlock,
    signal: opts.signal || null,
  });

  const result = {
    address, // keep original checksum casing in display
    network: net.name,
    chainId,
    analyzedAt: new Date().toISOString(),
    snapshotBlock,
  };
  const tokenCfg = tokensByNet[networkKey] || {};
  const [nativePrice, code, balWei, nonceHex, tokenResults] = await Promise.all([
    fetchNativePriceUsd(net, { offline, fetchImpl, signal: opts.signal || null }),
    rpc.getCode(addrLower, snapshotBlock),
    rpc.getBalance(addrLower, snapshotBlock),
    rpc.call("eth_getTransactionCount", [addrLower, snapshotBlock]),
    Promise.all(
      Object.entries(tokenCfg).map(async ([symbol, token]) => {
        const response = await rpc.ethCallSafe(
          token.address,
          encodeBalanceOf(addrLower),
          snapshotBlock
        );
        if (!response.ok) {
          return {
            failure: {
              symbol,
              reason: String(response.error || "balance query failed"),
            },
          };
        }
        if (!response.data || response.data === "0x" || response.data === "0x0") {
          return {};
        }
        const balance = formatUnits(response.data, token.decimals);
        return balance === "0"
          ? {}
          : {
              holding: {
                symbol,
                address: token.address,
                balance,
                source: "registry",
              },
            };
      })
    ),
  ]);

  result.nativePrice = nativePrice;
  const isContract = !!code && code !== "0x" && code.length > 2;
  result.addressType = isContract ? "Contract" : "EOA";
  if (isContract) result.bytecodeSize = (code.length - 2) / 2;

  const nativeDecimals = Number.isInteger(net.nativeDecimals) ? net.nativeDecimals : 18;
  result.nativeCurrency = net.nativeCurrency;
  result.nativeBalanceWei = balWei;
  result.nativeBalance = formatUnits(balWei, nativeDecimals);

  const registryHoldings = tokenResults
    .map(({ holding }) => holding)
    .filter(Boolean);
  const tokenFailures = tokenResults
    .map(({ failure }) => failure)
    .filter(Boolean);
  result.tokenScan = {
    complete: tokenFailures.length === 0,
    failures: tokenFailures,
  };
  result.tokenHoldings = registryHoldings;
  result.tokenDiscovery = offline
    ? { available: false, reason: "offline mode", holdings: [] }
    : { available: false, reason: "not attempted", holdings: [] };

  result.nonce = parseInt(nonceHex, 16);

  // 5. Activity (best-effort explorer enrichment)
  if (!offline) {
    const [contractInfo, activity, tokenDiscovery] = await Promise.all([
      isContract
        ? explorer.contractInfo(addrLower)
        : Promise.resolve(null),
      explorer.activity(addrLower),
      explorer.tokenHoldings(addrLower),
    ]);
    if (isContract) result.contractInfo = contractInfo;
    result.activity = activity;
    result.tokenDiscovery = tokenDiscovery;
    if (tokenDiscovery.available) {
      result.tokenHoldings = mergeTokenHoldings(registryHoldings, tokenDiscovery.holdings);
    }
  } else {
    if (isContract) result.contractInfo = { available: false, reason: "offline mode" };
    result.activity = { available: false, reason: "offline mode" };
  }

  // Confidence reflects incomplete inputs before downstream risk scoring.
  if (!result.tokenScan.complete) {
    result.confidence = "partial (token scan incomplete)";
  } else if (!result.activity?.available) {
    result.confidence = "partial (explorer unavailable)";
  } else if (result.activity.historyComplete === false) {
    result.confidence = "partial (activity history sampled)";
  } else {
    result.confidence = "full";
  }
  return result;
}

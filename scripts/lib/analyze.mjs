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
import { Rpc } from "./rpc.mjs";
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

async function fetchNativePriceUsd(net, { offline, fetchImpl }) {
  const envPrice = envPriceUsd(net);
  if (envPrice) return envPrice;
  if (offline) return { available: false, reason: "offline mode" };
  if (!net.nativePriceUsdUrl) return { available: false, reason: "no native price feed configured" };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(net.nativePriceUsdUrl, { signal: ctrl.signal });
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

  const rpc = opts.rpc || new Rpc(net.rpcUrl, opts.rpcOptions || {});
  const explorerApiKey =
    opts.explorerApiKey ??
    process.env[net.explorerApiKeyEnv || "SOCIALSCAN_API_KEY"] ??
    "";
  const explorer = createSocialScanProvider({
    baseUrl: net.explorerApiUrl,
    apiKey: explorerApiKey,
    fetchImpl,
    activityPageSize: opts.explorerActivityPageSize,
  });
  const addrLower = address.toLowerCase(); // normalized for calls/comparisons

  const result = {
    address, // keep original checksum casing in display
    network: net.name,
    chainId: net.chainId,
    analyzedAt: new Date().toISOString(),
  };
  result.nativePrice = await fetchNativePriceUsd(net, { offline, fetchImpl });

  // 1. Address type (EOA vs Contract)
  const code = await rpc.getCode(addrLower);
  const isContract = !!code && code !== "0x" && code.length > 2;
  result.addressType = isContract ? "Contract" : "EOA";
  if (isContract) result.bytecodeSize = (code.length - 2) / 2;

  // 2. Native balance
  const balWei = await rpc.getBalance(addrLower);
  const nativeDecimals = Number.isInteger(net.nativeDecimals) ? net.nativeDecimals : 18;
  result.nativeCurrency = net.nativeCurrency;
  result.nativeBalanceWei = balWei;
  result.nativeBalance = formatUnits(balWei, nativeDecimals);

  // 3. ERC20 token holdings (from assets/tokens.json)
  const tokenCfg = tokensByNet[networkKey] || {};
  const tokenResults = await Promise.all(
    Object.entries(tokenCfg).map(async ([symbol, token]) => {
      const response = await rpc.ethCallSafe(
        token.address,
        encodeBalanceOf(addrLower)
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
  );
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

  // 4. Nonce / sent-tx count
  const nonceHex = await rpc.call("eth_getTransactionCount", [addrLower, "latest"]);
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

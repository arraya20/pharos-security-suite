const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_ACTIVITY_PAGE_SIZE = 100;
const MAX_ACTIVITY_BLOCK_RANGE = 100_000n;

function unavailable(reason, extra = {}) {
  return { available: false, reason, ...extra };
}

function errorReason(error) {
  return error?.name === "AbortError"
    ? "SocialScan timeout"
    : String(error?.message || error);
}

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function timestampMs(value) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const millis = String(value).length <= 10 ? numeric * 1_000 : numeric;
    return Number.isFinite(millis) ? millis : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function activityBlockWindow(value) {
  const endBlock = BigInt(value);
  if (endBlock < 0n) throw new Error("invalid latest block");
  const startBlock =
    endBlock > MAX_ACTIVITY_BLOCK_RANGE
      ? endBlock - MAX_ACTIVITY_BLOCK_RANGE
      : 0n;
  return {
    startblock: startBlock.toString(),
    endblock: endBlock.toString(),
    coversGenesis: startBlock === 0n,
  };
}

function transactionKey(transaction, index) {
  return nonEmpty(transaction?.hash) || nonEmpty(transaction?.transactionHash) || `sample:${index}`;
}

function formatRawUnits(value, decimals) {
  const raw = BigInt(String(value));
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function normalizeTokenHolding(item) {
  const address = nonEmpty(
    item?.tokenAddress ??
      item?.TokenAddress ??
      item?.contractAddress ??
      item?.contract_address
  );
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;

  const decimals = Number(item?.tokenDecimal ?? item?.TokenDecimal ?? item?.decimals ?? 18);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;

  try {
    const raw = BigInt(
      String(item?.TokenQuantity ?? item?.tokenQuantity ?? item?.balance ?? item?.value)
    );
    if (raw <= 0n) return null;
    const name = nonEmpty(item?.tokenName ?? item?.TokenName ?? item?.name);
    return {
      symbol: nonEmpty(item?.tokenSymbol ?? item?.TokenSymbol ?? item?.symbol) || "UNKNOWN",
      ...(name ? { name } : {}),
      address,
      balance: formatRawUnits(raw, decimals),
      source: "explorer",
    };
  } catch {
    return null;
  }
}

export function createSocialScanProvider({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  activityPageSize = DEFAULT_ACTIVITY_PAGE_SIZE,
  getLatestBlock,
} = {}) {
  const missingReason = !baseUrl
    ? "no SocialScan API configured"
    : !apiKey
      ? "missing SocialScan API key"
      : null;

  async function request(params) {
    if (missingReason) throw new Error(missingReason);

    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`SocialScan HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.result)) {
        throw new Error("SocialScan invalid response");
      }
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function contractInfo(address) {
    if (missingReason) return unavailable(missingReason);
    try {
      const [item = {}] = await request({
        module: "contract",
        action: "getsourcecode",
        address,
      });
      const sourceCode = nonEmpty(item.SourceCode);
      const abi = nonEmpty(item.ABI);
      const verified = Boolean(
        sourceCode && abi && !/contract source code not verified/i.test(abi)
      );
      return {
        available: true,
        name: nonEmpty(item.ContractName),
        verified,
      };
    } catch (error) {
      return unavailable(errorReason(error));
    }
  }

  async function activity(address) {
    if (missingReason) return unavailable(missingReason);
    try {
      if (typeof getLatestBlock !== "function") {
        throw new Error("missing latest block provider");
      }
      const blockWindow = activityBlockWindow(await getLatestBlock());
      const baseParams = {
        module: "account",
        action: "txlist",
        address,
        startblock: blockWindow.startblock,
        endblock: blockWindow.endblock,
        page: 1,
        offset: activityPageSize,
      };
      const [oldest, newest] = await Promise.all([
        request({ ...baseParams, sort: "asc" }),
        request({ ...baseParams, sort: "desc" }),
      ]);

      const sampled = new Map();
      [...oldest, ...newest].forEach((transaction, index) => {
        sampled.set(transactionKey(transaction, index), transaction);
      });
      const items = [...sampled.values()];
      const timestamps = items
        .map((transaction) => timestampMs(transaction?.timeStamp ?? transaction?.timestamp))
        .filter((value) => value != null);
      const firstSeen = timestamps.length
        ? new Date(Math.min(...timestamps)).toISOString()
        : null;
      const lastSeen = timestamps.length
        ? new Date(Math.max(...timestamps)).toISOString()
        : null;

      const destinations = new Set();
      for (const transaction of items) {
        const destination = nonEmpty(transaction?.to);
        if (
          destination &&
          /^0x[0-9a-fA-F]{40}$/.test(destination) &&
          destination.toLowerCase() !== address.toLowerCase()
        ) {
          destinations.add(destination.toLowerCase());
        }
      }

      const protocols = (
        await Promise.all(
          [...destinations].slice(0, 8).map(async (destination) => {
            const info = await contractInfo(destination);
            if (!info.available || !info.name) return null;
            return {
              address: destination,
              name: info.name,
              verified: info.verified,
            };
          })
        )
      ).filter(Boolean);

      return {
        available: true,
        historyComplete:
          blockWindow.coversGenesis &&
          oldest.length < activityPageSize &&
          newest.length < activityPageSize,
        firstSeen,
        lastSeen,
        txCount: items.length,
        uniqueContracts: destinations.size,
        protocols,
        ageDays:
          firstSeen && lastSeen
            ? Math.max(0, (Date.parse(lastSeen) - Date.parse(firstSeen)) / 86_400_000)
            : null,
        recentCount: items.length,
      };
    } catch (error) {
      return unavailable(errorReason(error));
    }
  }

  async function tokenHoldings(address) {
    if (missingReason) return unavailable(missingReason, { holdings: [] });
    try {
      const items = await request({
        module: "account",
        action: "addresstokenbalance",
        address,
        page: 1,
        offset: 100,
      });
      const holdings = items.map(normalizeTokenHolding).filter(Boolean);
      return {
        available: true,
        source: "explorer",
        count: holdings.length,
        holdings,
      };
    } catch (error) {
      return unavailable(errorReason(error), { holdings: [] });
    }
  }

  return {
    contractInfo,
    activity,
    tokenHoldings,
    activityPageSize,
  };
}

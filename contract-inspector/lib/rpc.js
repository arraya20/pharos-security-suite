// rpc.js — minimal JSON-RPC client over fetch (Node 18+ has global fetch).
// No ethers provider dependency for raw calls keeps this resilient to RPC quirks.
//
// Public Pharos RPCs are observably flaky: under load, individual eth_call /
// eth_getStorageAt requests intermittently time out or 5xx (~1 in 5 during
// testing). For a pre-flight safety tool that's unacceptable — a dropped
// owner() call silently changes the risk score. So transient failures are
// retried with backoff, while permanent failures (a genuine contract revert,
// a 4xx) fail fast without wasting time.

// Classify whether a failed attempt is worth retrying.
export function isTransient(err) {
  if (!err) return false;
  if (err.transient === true) return true; // tagged below
  const msg = String(err.message || err);
  // Network-level: aborts (our timeout), DNS/socket resets, fetch failures.
  if (err.name === "AbortError") return true;
  if (/timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(msg)) return true;
  return false;
}

export class Rpc {
  constructor(url, { timeoutMs = 12_000, retries = 2, retryBaseMs = 250 } = {}) {
    this.url = url;
    this.id = 0;
    this.timeoutMs = timeoutMs;
    this.retries = retries; // number of RETRIES (so total attempts = retries + 1)
    this.retryBaseMs = retryBaseMs;
  }

  // One network attempt. Throws on any failure; the error is tagged `.transient`
  // so the retry loop knows whether to back off and try again or give up.
  async _attempt(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") {
        const err = new Error(`RPC timeout after ${this.timeoutMs}ms for ${method}`);
        err.transient = true;
        throw err;
      }
      e.transient = true; // network-level failure → retryable
      throw e;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const err = new Error(`RPC HTTP ${res.status} for ${method}`);
      // 429 (rate limit) and 5xx (server) are transient; 4xx are not.
      err.transient = res.status === 429 || res.status >= 500;
      throw err;
    }
    const json = await res.json();
    if (json.error) {
      // JSON-RPC errors are application-level (e.g. execution reverted). These
      // are deterministic — retrying won't change the answer, so fail fast.
      const err = new Error(`RPC error ${json.error.code}: ${json.error.message}`);
      err.transient = false;
      err.rpcError = json.error;
      throw err;
    }
    return json.result;
  }

  async call(method, params = []) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this._attempt(method, params);
      } catch (e) {
        lastErr = e;
        if (!isTransient(e) || attempt === this.retries) throw e;
        // Exponential backoff with jitter before the next attempt.
        const wait = this.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  getCode(addr, block = "latest") {
    return this.call("eth_getCode", [addr, block]);
  }

  getStorageAt(addr, slot, block = "latest") {
    return this.call("eth_getStorageAt", [addr, slot, block]);
  }

  getBalance(addr, block = "latest") {
    return this.call("eth_getBalance", [addr, block]);
  }

  getBlockNumber() {
    return this.call("eth_blockNumber");
  }

  chainId() {
    return this.call("eth_chainId");
  }

  // eth_call that tolerates reverts: returns { ok, data } instead of throwing.
  // Transient network failures are retried inside call(); a returned {ok:false}
  // therefore means a genuine revert or an exhausted-retry network failure.
  async ethCallSafe(to, data, block = "latest") {
    try {
      const result = await this.call("eth_call", [{ to, data }, block]);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, data: null, error: e.message, transient: isTransient(e) };
    }
  }
}

export class RpcPool {
  constructor(
    providers,
    {
      hedgeDelayMs = 500,
      failureThreshold = 2,
      cooldownMs = 30_000,
      now = () => Date.now(),
    } = {},
  ) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new TypeError("RpcPool requires at least one provider");
    }
    this.providers = providers;
    this.hedgeDelayMs = hedgeDelayMs;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.health = new Map(
      providers.map((provider) => [provider, { failures: 0, openUntil: 0 }]),
    );
  }

  _availableProviders() {
    const now = this.now();
    const available = this.providers.filter(
      (provider) => this.health.get(provider).openUntil <= now,
    );
    return available.length ? available : [this.providers[0]];
  }

  _success(provider) {
    const health = this.health.get(provider);
    health.failures = 0;
    health.openUntil = 0;
  }

  _failure(provider) {
    const health = this.health.get(provider);
    health.failures += 1;
    if (health.failures >= this.failureThreshold) {
      health.openUntil = this.now() + this.cooldownMs;
    }
  }

  async call(method, params = []) {
    const providers = this._availableProviders();
    if (providers.length === 1) return providers[0].call(method, params);

    return new Promise((resolve, reject) => {
      let settled = false;
      let active = 0;
      let nextIndex = 0;
      let lastError;
      const started = new Set();
      let hedgeTimer;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedgeTimer);
        fn(value);
      };

      const startNext = () => {
        while (nextIndex < providers.length && started.has(nextIndex)) nextIndex += 1;
        if (nextIndex >= providers.length) {
          if (active === 0) finish(reject, lastError);
          return;
        }
        const index = nextIndex++;
        const provider = providers[index];
        started.add(index);
        active += 1;
        Promise.resolve()
          .then(() => provider.call(method, params))
          .then((value) => {
            active -= 1;
            this._success(provider);
            finish(resolve, value);
          })
          .catch((error) => {
            active -= 1;
            lastError = error;
            if (!isTransient(error)) {
              finish(reject, error);
              return;
            }
            this._failure(provider);
            if (active === 0) startNext();
          });
      };

      startNext();
      hedgeTimer = setTimeout(() => {
        if (!settled) startNext();
      }, this.hedgeDelayMs);
      hedgeTimer.unref?.();
    });
  }

  getCode(addr, block = "latest") {
    return this.call("eth_getCode", [addr, block]);
  }

  getStorageAt(addr, slot, block = "latest") {
    return this.call("eth_getStorageAt", [addr, slot, block]);
  }

  getBalance(addr, block = "latest") {
    return this.call("eth_getBalance", [addr, block]);
  }

  getBlockNumber() {
    return this.call("eth_blockNumber");
  }

  chainId() {
    return this.call("eth_chainId");
  }

  async ethCallSafe(to, data, block = "latest") {
    try {
      const result = await this.call("eth_call", [{ to, data }, block]);
      return { ok: true, data: result };
    } catch (error) {
      return {
        ok: false,
        data: null,
        error: error.message,
        transient: isTransient(error),
      };
    }
  }
}

export function createRpcClient(net, options = {}) {
  const urls = Array.isArray(net.rpcUrls) && net.rpcUrls.length
    ? net.rpcUrls
    : [net.rpc];
  const providers = urls.map((url, index) => {
    const rpc = new Rpc(url, options.rpcOptions || {});
    rpc.label = index === 0 ? "primary" : `secondary-${index}`;
    return rpc;
  });
  return providers.length === 1
    ? providers[0]
    : new RpcPool(providers, options.poolOptions || {});
}

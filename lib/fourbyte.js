// fourbyte.js — optional online resolver for unknown selectors via 4byte.directory.
// Offline-first: the curated KNOWN map covers common cases. This only runs for
// leftovers, and degrades gracefully if the network/host is unreachable.

const CACHE = new Map();

export async function resolveSelector(
  sel,
  { signal = null, fetchImpl = fetch, onFailure = null } = {},
) {
  if (CACHE.has(sel)) return CACHE.get(sel);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  let failed = false;
  try {
    const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`;
    const requestSignal = signal
      ? AbortSignal.any([ctrl.signal, signal])
      : ctrl.signal;
    const res = await fetchImpl(url, { signal: requestSignal });
    if (!res.ok) {
      onFailure?.(new Error(`4byte HTTP ${res.status}`));
      return null;
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.results)) {
      throw new Error("4byte invalid response");
    }
    const candidates = json.results.filter((item) =>
      item &&
      typeof item === "object" &&
      Number.isInteger(item.id) &&
      typeof item.text_signature === "string" &&
      item.text_signature.length > 0 &&
      item.text_signature.length <= 512
    );
    if (json.results.length && candidates.length === 0) {
      throw new Error("4byte invalid signature entries");
    }
    if (candidates.length) {
      // Prefer the earliest-created (lowest id) — least likely to be a collision spoof.
      const best = candidates.sort((a, b) => a.id - b.id)[0];
      CACHE.set(sel, best.text_signature);
      return best.text_signature;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    failed = true;
    onFailure?.(error);
    // network blocked / timeout — that's fine, return null
  } finally {
    clearTimeout(t);
  }
  if (!failed) CACHE.set(sel, null);
  return null;
}

export async function resolveMany(selectors, { online = true, signal = null } = {}) {
  return (await resolveManyDetailed(selectors, { online, signal })).signatures;
}

export async function resolveManyDetailed(selectors, { online = true, signal = null } = {}) {
  const out = {};
  const errors = [];
  if (!online) return { signatures: out, errors };
  // Sequential with a small concurrency cap to be polite to the API.
  const queue = [...selectors];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const sel = queue.shift();
      out[sel] = await resolveSelector(sel, {
        signal,
        onFailure: (error) => errors.push({
          selector: sel,
          error: String(error?.message || error),
        }),
      });
    }
  });
  await Promise.all(workers);
  return { signatures: out, errors };
}

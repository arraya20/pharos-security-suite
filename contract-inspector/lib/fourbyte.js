// fourbyte.js — optional online resolver for unknown selectors via 4byte.directory.
// Offline-first: the curated KNOWN map covers common cases. This only runs for
// leftovers, and degrades gracefully if the network/host is unreachable.

const CACHE = new Map();

export async function resolveSelector(sel) {
  if (CACHE.has(sel)) return CACHE.get(sel);
  try {
    const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      CACHE.set(sel, null);
      return null;
    }
    const json = await res.json();
    if (json.results && json.results.length) {
      // Prefer the earliest-created (lowest id) — least likely to be a collision spoof.
      const best = json.results.sort((a, b) => a.id - b.id)[0];
      CACHE.set(sel, best.text_signature);
      return best.text_signature;
    }
  } catch {
    // network blocked / timeout — that's fine, return null
  }
  CACHE.set(sel, null);
  return null;
}

export async function resolveMany(selectors, { online = true } = {}) {
  const out = {};
  if (!online) return out;
  // Sequential with a small concurrency cap to be polite to the API.
  const queue = [...selectors];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const sel = queue.shift();
      out[sel] = await resolveSelector(sel);
    }
  });
  await Promise.all(workers);
  return out;
}

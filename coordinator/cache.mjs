export class BoundedTtlCache {
  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

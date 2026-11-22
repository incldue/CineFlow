'use strict';

const registry = new Map();

class Cache {
  constructor({ namespace, ttlMs = 0, max = 0, stale = false } = {}) {
    this.namespace = String(namespace || 'cache');
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.max = Math.max(0, Number(max) || 0);
    this.stale = Boolean(stale);
    this.store = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0, writes: 0 };
    registry.set(this.namespace, this);
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      if (this.stale) {
        this.stats.hits += 1;
        return { value: entry.value, stale: true };
      }
      this.store.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    this.stats.hits += 1;
    return { value: entry.value, stale: false };
  }

  peek(key) {
    const entry = this.store.get(key);
    return entry ? { value: entry.value, expired: entry.expiresAt <= Date.now() } : undefined;
  }

  set(key, value, ttlMs) {
    if (this.max && !this.store.has(key)) {
      while (this.store.size >= this.max) {
        this.store.delete(this.store.keys().next().value);
        this.stats.evictions += 1;
      }
    }
    const ttl = ttlMs === undefined ? this.ttlMs : Math.max(0, Number(ttlMs) || 0);
    this.store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : Infinity });
    this.stats.writes += 1;
  }

  delete(key) {
    return this.store.delete(key);
  }

  has(key) {
    const entry = this.store.get(key);
    return Boolean(entry) && entry.expiresAt > Date.now();
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== Infinity && entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  dump(limit = 20) {
    const now = Date.now();
    const rows = [];
    for (const [key, entry] of this.store) {
      rows.push({ key: String(key).slice(0, 120), expiresInMs: entry.expiresAt === Infinity ? null : entry.expiresAt - now });
      if (rows.length >= limit) break;
    }
    return {
      namespace: this.namespace,
      size: this.store.size,
      ttlMs: this.ttlMs,
      max: this.max,
      stale: this.stale,
      stats: { ...this.stats },
      rows
    };
  }
}

function createCache(options = {}) {
  return new Cache(options);
}

function getCache(namespace) {
  return registry.get(namespace) || null;
}

function listCaches() {
  return [...registry.values()].map((cache) => cache.dump(0));
}

function sweepAll() {
  let removed = 0;
  for (const cache of registry.values()) removed += cache.sweep();
  return removed;
}

function installCacheChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:cache.stats')) {
      ipcMain.handle('cf:cache.stats', () => ({ caches: listCaches() }));
    }
    if (!ipcMain._invokeHandlers.get('cf:cache.sweep')) {
      ipcMain.handle('cf:cache.sweep', () => ({ removed: sweepAll() }));
    }
  } catch {  }
}

module.exports = {
  createCache,
  getCache,
  listCaches,
  sweepAll,
  installCacheChannels,
  Cache,
  _registry: registry
};

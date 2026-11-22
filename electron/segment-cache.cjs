'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const telemetry = require('./telemetry.cjs');

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const CACHEABLE_CONTENT_RE = /video\/(?:mp2t|mp4|iso\.segment)|application\/octet-stream|video\/(?:x-)?mpegvideo/i;
const CACHEABLE_URL_RE = /\.(?:ts|m4s|mp4|seg)(?:$|[?#])/i;
const INDEX_FILE = 'index.json';

const state = {
  enabled: false,
  dir: '',
  maxBytes: DEFAULT_MAX_BYTES,
  index: new Map(),
  totalBytes: 0
};

function keyOf(url, requestHeaders) {
  const range = String(requestHeaders?.range || (requestHeaders instanceof Object ? requestHeaders.Range : '') || '');
  return crypto.createHash('sha1').update(`${url}|${range}`).digest('hex');
}

function init({ app, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    if (!app) return false;
    state.dir = path.join(app.getPath('userData'), 'cf9-seg-cache');
    state.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    state.index.clear();
    state.totalBytes = 0;
    fs.mkdirSync(state.dir, { recursive: true });
    const indexFile = path.join(state.dir, INDEX_FILE);
    if (fs.existsSync(indexFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        for (const [key, meta] of Object.entries(parsed.entries || {})) {
          const file = path.join(state.dir, meta.file);
          if (fs.existsSync(file)) {
            state.index.set(key, { ...meta, at: Number(meta.at) || 0 });
            state.totalBytes += Number(meta.size) || 0;
          }
        }
      } catch {  }
    }
    state.enabled = true;
    return true;
  } catch {
    return false;
  }
}

function persistIndex() {
  try {
    const entries = {};
    for (const [key, meta] of state.index) entries[key] = meta;
    fs.writeFileSync(path.join(state.dir, INDEX_FILE), JSON.stringify({ entries }, null, 0));
  } catch {  }
}

function evictToFit(incomingBytes = 0) {
  while (state.totalBytes + incomingBytes > state.maxBytes && state.index.size) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, meta] of state.index) {
      if (meta.at < oldestAt) { oldestAt = meta.at; oldestKey = key; }
    }
    if (!oldestKey) break;
    const meta = state.index.get(oldestKey);
    try { fs.unlinkSync(path.join(state.dir, meta.file)); } catch {  }
    state.index.delete(oldestKey);
    state.totalBytes -= Number(meta.size) || 0;
  }
}

async function serve(url, requestHeaders) {
  if (!state.enabled) return null;
  const key = keyOf(url, requestHeaders);
  const meta = state.index.get(key);
  if (!meta) return null;
  try {
    const buffer = fs.readFileSync(path.join(state.dir, meta.file));
    meta.at = Date.now();
    telemetry.count('segcache.hit');
    const headers = new Headers({ 'content-type': meta.contentType || 'video/mp2t', 'x-cf9-cache': 'hit' });
    return { response: new Response(buffer, { status: 200, headers }), from: 'disk' };
  } catch {
    state.index.delete(key);
    return null;
  }
}

function store(url, requestHeaders, contentType, buffer) {
  if (!state.enabled || !(buffer instanceof Buffer) || !buffer.length) return false;
  evictToFit(buffer.length);
  if (state.totalBytes + buffer.length > state.maxBytes) return false;
  const key = keyOf(url, requestHeaders);
  if (state.index.has(key)) return true;
  const file = `${key}.bin`;
  try {
    fs.writeFileSync(path.join(state.dir, file), buffer);
    state.index.set(key, { file, size: buffer.length, contentType: String(contentType || ''), at: Date.now() });
    state.totalBytes += buffer.length;
    telemetry.count('segcache.store');
    persistIndex();
    return true;
  } catch {
    state.index.delete(key);
    return false;
  }
}

function shouldCache(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (/json|html|xml|text\/plain|javascript/.test(ct)) return false;
  if (CACHEABLE_CONTENT_RE.test(ct)) return true;
  if (!ct || ct === 'application/octet-stream') return CACHEABLE_URL_RE.test(String(url || '').split('?')[0]);
  return false;
}

function stats() {
  return {
    enabled: state.enabled,
    dir: state.dir,
    entries: state.index.size,
    bytes: state.totalBytes,
    maxBytes: state.maxBytes
  };
}

module.exports = { init, serve, store, shouldCache, keyOf, stats, _state: state };

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');

const TMDB_API_HOST = 'api.themoviedb.org';
const TMDB_IMAGE_HOSTS = new Set(['image.tmdb.org', 'static-1.themoviedb.org', 'media.themoviedb.org']);
const TMDB_BASE_ORIGIN = 'https://api.themoviedb.org/3';
const TMDB_LANGUAGE = 'zh-CN';

const META_FRESH_MS = Number(process.env.CINEFLOW_META_TTL_MS || 30 * 60 * 1000);
const META_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const META_INDEX_MAX_ENTRIES = 500;
const META_ENTRY_MAX_BYTES = 512 * 1024;
const META_UPSTREAM_TIMEOUT_MS = Number(process.env.CINEFLOW_META_UPSTREAM_TIMEOUT_MS || 8000);
const IMG_MAX_FILES = 4000;
const SEARCH_INDEX_MAX = 6000;
const DECISION_CACHE_TTL_MS = 5000;

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function contentTypeForPath(pathname = '') {
  if (/\.png(?:$|\?)/i.test(pathname)) return 'image/png';
  if (/\.webp(?:$|\?)/i.test(pathname)) return 'image/webp';
  if (/\.svg(?:$|\?)/i.test(pathname)) return 'image/svg+xml';
  if (/\.gif(?:$|\?)/i.test(pathname)) return 'image/gif';
  return 'image/jpeg';
}

function createMetaServer(deps) {
  const { app, session, doh, getProxySetting, readSettings, getCredential } = deps;

  const rootDir = path.join(app.getPath('userData'), 'cineflow-meta');
  const imgDir = path.join(rootDir, 'img');
  const indexFile = path.join(rootDir, 'meta-index.json');
  const searchIndexFile = path.join(rootDir, 'search-index.json');
  const token = crypto.randomBytes(12).toString('hex');

  const apiIndex = new Map();
  const searchIndex = new Map();
  const inFlight = new Map();
  const decisionCache = new Map();
  let serverPort = 0;
  let starting = null;
  let lastWarmupAt = 0;
  let warmupPromise = null;

  const envDisabled = process.env.CINEFLOW_DOH_METADATA === '0';

  function enabled() {
    if (envDisabled) return false;
    try {
      const settings = readSettings();
      return settings.dohMetadata !== false;
    } catch {
      return true;
    }
  }

  function hashKey(...parts) {
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  function readJsonFile(file) {
    try {
      return safeJsonParse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function persistJson(file, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // best-effort
    }
  }

  let indexPersistTimer = null;
  function scheduleIndexPersist() {
    if (indexPersistTimer) return;
    indexPersistTimer = setTimeout(() => {
      indexPersistTimer = null;
      persistJson(indexFile, Object.fromEntries(apiIndex));
      persistJson(searchIndexFile, Object.fromEntries(searchIndex));
    }, 3000);
    if (typeof indexPersistTimer.unref === 'function') indexPersistTimer.unref();
  }

  function loadPersisted() {
    try {
      fs.mkdirSync(imgDir, { recursive: true });
    } catch {
      // best-effort
    }
    const rawIndex = readJsonFile(indexFile);
    const nowMs = Date.now();
    for (const [key, entry] of Object.entries(rawIndex)) {
      if (!entry || typeof entry !== 'object' || !entry.body) continue;
      if (nowMs - Number(entry.savedAt || 0) > META_STALE_MAX_MS) continue;
      apiIndex.set(String(key), entry);
    }
    const rawSearch = readJsonFile(searchIndexFile);
    for (const [key, entry] of Object.entries(rawSearch)) {
      if (!entry || !entry.id) continue;
      searchIndex.set(String(key), entry);
    }
  }

  function trimIndex() {
    while (apiIndex.size > META_INDEX_MAX_ENTRIES) {
      const oldestKey = [...apiIndex.entries()]
        .sort((a, b) => Number(a[1]?.savedAt || 0) - Number(b[1]?.savedAt || 0))
        .map((item) => item[0])[0];
      if (!oldestKey) break;
      apiIndex.delete(oldestKey);
    }
    while (searchIndex.size > SEARCH_INDEX_MAX) {
      const oldestKey = searchIndex.keys().next().value;
      if (!oldestKey) break;
      searchIndex.delete(oldestKey);
    }
  }

  function hostOf(urlStr) {
    try {
      return new URL(urlStr).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function isApiUrl(urlStr) {
    return hostOf(urlStr) === TMDB_API_HOST;
  }

  function isImageUrl(urlStr) {
    return TMDB_IMAGE_HOSTS.has(hostOf(urlStr));
  }

  async function directRouteAllowed(urlStr) {
    if (!enabled()) return false;
    let host = '';
    try {
      host = new URL(urlStr).hostname;
    } catch {
      return false;
    }
    const cached = decisionCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let value = false;
    try {
      const resolved = await session.defaultSession.resolveProxy(urlStr);
      value = /^\s*DIRECT/i.test(String(resolved || ''));
    } catch {
      value = false;
    }
    decisionCache.set(host, { value, expiresAt: Date.now() + DECISION_CACHE_TTL_MS });
    return value;
  }

  function authHeaderFrom(init) {
    const headers = init && init.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get('authorization') || '';
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === 'authorization') return String(value || '');
    }
    return '';
  }

  function headersToObject(init) {
    const out = { accept: 'application/json' };
    const headers = init && init.headers;
    if (!headers) return out;
    if (typeof headers.forEach === 'function') {
      headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
      return out;
    }
    for (const [key, value] of Object.entries(headers)) {
      out[String(key).toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
    }
    return out;
  }

  function buildResponseLike({ status, contentType, bodyBuffer, url }) {
    const headers = {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType || null;
        if (key === 'content-length') return String(bodyBuffer.length);
        return null;
      },
      has(name) {
        return this.get(name) !== null;
      },
      forEach(callback) {
        callback(contentType || 'application/octet-stream', 'content-type');
        callback(String(bodyBuffer.length), 'content-length');
      }
    };
    const text = () => bodyBuffer.toString('utf8');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      url,
      redirected: false,
      headers,
      text,
      json: async () => JSON.parse(text()),
      arrayBuffer: async () => bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength),
      body: Readable.toWeb(Readable.from(bodyBuffer))
    };
  }

  function entryToResponse(key, entry, urlStr) {
    const body = Buffer.from(entry.body, 'base64');
    return buildResponseLike({ status: entry.status, contentType: entry.contentType, bodyBuffer: body, url: urlStr });
  }

  function updateSearchIndex(urlStr, bodyText) {
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return;
    }
    const url = new URL(urlStr);
    const items = [];
    const push = (item, fallbackType) => {
      if (!item || !item.id) return;
      const mediaType = item.media_type || (url.pathname.startsWith('/3/tv/') ? 'tv' : fallbackType) || 'movie';
      items.push({
        key: `${mediaType}:${item.id}`,
        id: item.id,
        mediaType,
        title: item.title || item.name || '',
        posterPath: item.poster_path || null,
        backdropPath: item.backdrop_path || null,
        voteAverage: Number(item.vote_average || 0),
        releaseDate: item.release_date || item.first_air_date || ''
      });
    };
    if (Array.isArray(payload.results)) {
      for (const item of payload.results) push(item);
    }
    if (Array.isArray(payload.genres)) return;
    if (payload.id) push(payload);
    for (const item of items) {
      searchIndex.set(item.key, item);
    }
    if (items.length) {
      trimIndex();
      scheduleIndexPersist();
    }
  }

  function cacheEntry(status, contentType, bodyBuffer) {
    return {
      savedAt: Date.now(),
      status,
      contentType: contentType || 'application/json',
      body: bodyBuffer.toString('base64'),
      size: bodyBuffer.length
    };
  }

  async function revalidate(key, urlStr, headers) {
    try {
      const upstream = await doh.fetchUrl(urlStr, { headers, timeoutMs: META_UPSTREAM_TIMEOUT_MS });
      const text = await upstream.text();
      if (upstream.ok) {
        const bodyBuffer = Buffer.from(text, 'utf8');
        if (bodyBuffer.length <= META_ENTRY_MAX_BYTES) {
          apiIndex.set(key, cacheEntry(upstream.status, upstream.headers.get('content-type'), bodyBuffer));
          updateSearchIndex(urlStr, text);
          trimIndex();
          scheduleIndexPersist();
        }
      }
    } catch {
      // keep stale entry
    }
  }

  async function serveApi(urlStr, init = {}) {
    const headers = headersToObject(init);
    const key = hashKey('GET', urlStr, authHeaderFrom(init));
    const entry = apiIndex.get(key);
    const nowMs = Date.now();
    if (entry && nowMs - Number(entry.savedAt || 0) < META_FRESH_MS) {
      return entryToResponse(key, entry, urlStr);
    }
    if (entry) {
      revalidate(key, urlStr, headers).catch(() => {});
      return entryToResponse(key, entry, urlStr);
    }
    if (inFlight.has(key)) {
      return (await inFlight.get(key)).cloneLike();
    }
    const request = (async () => {
      const upstream = await doh.fetchUrl(urlStr, { headers, timeoutMs: META_UPSTREAM_TIMEOUT_MS, signal: init.signal });
      const text = await upstream.text();
      const bodyBuffer = Buffer.from(text, 'utf8');
      if (upstream.ok && bodyBuffer.length <= META_ENTRY_MAX_BYTES) {
        apiIndex.set(key, cacheEntry(upstream.status, upstream.headers.get('content-type'), bodyBuffer));
        updateSearchIndex(urlStr, text);
        trimIndex();
        scheduleIndexPersist();
      }
      return buildResponseLike({
        status: upstream.status,
        contentType: upstream.headers.get('content-type') || 'application/json',
        bodyBuffer,
        url: upstream.url || urlStr
      });
    })();
    const wrapped = request.then((response) => {
      response.cloneLike = () => Promise.resolve(response);
      inFlight.delete(key);
      return response;
    }, (error) => {
      inFlight.delete(key);
      const stale = apiIndex.get(key);
      if (stale) return entryToResponse(key, stale, urlStr);
      throw error;
    });
    inFlight.set(key, wrapped);
    const response = await wrapped;
    return response;
  }

  function imgCachePathFor(urlStr) {
    const url = new URL(urlStr);
    if (!TMDB_IMAGE_HOSTS.has(url.hostname)) return null;
    if (!url.pathname.startsWith('/t/p/')) return null;
    const digest = hashKey(url.hostname, url.pathname, url.search);
    const ext = path.extname(new URL(urlStr).pathname) || '.jpg';
    return path.join(imgDir, `${digest}${ext}`);
  }

  function readImgFile(file) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0) return null;
      const buffer = fs.readFileSync(file);
      try {
        const touched = new Date();
        fs.utimesSync(file, touched, touched);
      } catch {
        // best-effort
      }
      return buffer;
    } catch {
      return null;
    }
  }

  function pruneImgCache() {
    try {
      const files = fs.readdirSync(imgDir);
      if (files.length <= IMG_MAX_FILES) return;
      const stats = files
        .map((name) => {
          try {
            const stat = fs.statSync(path.join(imgDir, name));
            return { name, atimeMs: stat.atimeMs.getTime(), size: stat.size };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.atimeMs - b.atimeMs);
      for (const item of stats.slice(0, files.length - IMG_MAX_FILES)) {
        try {
          fs.unlinkSync(path.join(imgDir, item.name));
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }

  async function fetchImageBytes(urlStr) {
    const file = imgCachePathFor(urlStr);
    if (!file) {
      return { status: 400, contentType: 'text/plain; charset=utf-8', buffer: Buffer.from('Invalid image url', 'utf8') };
    }
    const cached = readImgFile(file);
    if (cached) {
      return { status: 200, contentType: contentTypeForPath(new URL(urlStr).pathname), buffer: cached, fromCache: true };
    }
    const upstream = await doh.fetchUrl(urlStr, { headers: { accept: 'image/*,*/*' }, timeoutMs: META_UPSTREAM_TIMEOUT_MS });
    const chunks = [];
    for await (const chunk of upstream.nodeStream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (upstream.ok && buffer.length > 0) {
      try {
        fs.mkdirSync(imgDir, { recursive: true });
        fs.writeFileSync(file, buffer);
        pruneImgCache();
      } catch {
        // best-effort
      }
    }
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || contentTypeForPath(new URL(urlStr).pathname),
      buffer
    };
  }

  function handleImgRequest(req, res, url) {
    const target = url.searchParams.get('u') || '';
    if (!isImageUrl(target)) {
      res.writeHead(400, { 'access-control-allow-origin': '*' });
      res.end('Invalid image url');
      return;
    }
    fetchImageBytes(target).then((result) => {
      res.writeHead(result.status, {
        'access-control-allow-origin': '*',
        'content-type': result.contentType || 'image/jpeg',
        'content-length': String(result.buffer.length),
        'cache-control': 'public, max-age=86400'
      });
      res.end(result.buffer);
    }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Image fetch failed');
    });
  }

  function handleMetaRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    if (url.pathname === '/img' && url.searchParams.get('token') === token) {
      handleImgRequest(req, res, url);
      return;
    }
    if (url.pathname === '/api' && url.searchParams.get('token') === token) {
      const target = url.searchParams.get('u') || '';
      if (!isApiUrl(target)) {
        res.writeHead(400, { 'access-control-allow-origin': '*' });
        res.end('Invalid api url');
        return;
      }
      serveApi(target, {}).then(async (response) => {
        const body = Buffer.from(await response.text(), 'utf8');
        res.writeHead(response.status, {
          'access-control-allow-origin': '*',
          'content-type': response.headers.get('content-type') || 'application/json',
          'content-length': String(body.length)
        });
        res.end(body);
      }).catch(() => {
        if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' });
        res.end('Meta fetch failed');
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  }

  function start() {
    if (serverPort) return Promise.resolve(serverPort);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handleMetaRequest(req, res);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve(serverPort);
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  function patchSessionFetch() {
    const ses = session.defaultSession;
    const originalFetch = ses.fetch.bind(ses);
    ses.fetch = (input, init) => {
      let urlStr = '';
      try {
        urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);
      } catch {
        urlStr = '';
      }
      const isGet = !init || !init.method || String(init.method).toUpperCase() === 'GET';
      if (!isGet || (!isApiUrl(urlStr) && !isImageUrl(urlStr))) {
        return originalFetch(input, init);
      }
      return directRouteAllowed(urlStr).then((direct) => {
        if (!direct || !serverPort) return originalFetch(input, init);
        if (isApiUrl(urlStr)) return serveApi(urlStr, init || {});
        return fetchImageBytes(urlStr).then((result) => buildResponseLike({
          status: result.status,
          contentType: result.contentType,
          bodyBuffer: result.buffer,
          url: urlStr
        }));
      });
    };
  }

  function registerImageRedirect() {
    const ses = session.defaultSession;
    const urls = [...TMDB_IMAGE_HOSTS].map((host) => `https://${host}/*`);
    ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
      if (details.method !== 'GET' || !serverPort) {
        callback({});
        return;
      }
      directRouteAllowed(details.url).then((direct) => {
        if (!direct) {
          callback({});
          return;
        }
        const redirect = new URL(`http://127.0.0.1:${serverPort}/img`);
        redirect.searchParams.set('token', token);
        redirect.searchParams.set('u', details.url);
        callback({ redirectURL: redirect.toString() });
      }).catch(() => callback({}));
    });
  }

  function buildWarmUrl(pathname, params, credential) {
    const url = new URL(`${TMDB_BASE_ORIGIN}${pathname}`);
    url.searchParams.set('language', TMDB_LANGUAGE);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    if (credential && credential.type === 'apiKey') {
      url.searchParams.set('api_key', credential.value);
    }
    return url.toString();
  }

  async function warmup() {
    if (warmupPromise) return warmupPromise;
    warmupPromise = (async () => {
      if (!enabled()) return { skipped: 'disabled' };
      const credential = typeof getCredential === 'function' ? getCredential() : null;
      if (!credential) return { skipped: 'no-credential' };
      try {
        await start();
      } catch {
        return { skipped: 'server-error' };
      }
      const init = credential.type === 'readToken'
        ? { headers: { accept: 'application/json', authorization: `Bearer ${credential.value}` } }
        : {};
      const endpoints = [
        ['/configuration', {}],
        ['/trending/all/day', { page: 1 }],
        ['/movie/popular', { page: 1, region: 'CN' }],
        ['/tv/popular', { page: 1 }],
        ['/genre/movie/list', {}],
        ['/genre/tv/list', {}]
      ];
      const payloads = [];
      for (const [pathname, params] of endpoints) {
        try {
          const response = await serveApi(buildWarmUrl(pathname, params, credential), init);
          const text = await response.text();
          payloads.push(safeJsonParse(text));
        } catch {
          // keep whatever was cached before
        }
      }
      lastWarmupAt = Date.now();
      prewarmImages(payloads).catch(() => {});
      return { warmedAt: lastWarmupAt };
    })().finally(() => {
      warmupPromise = null;
    });
    return warmupPromise;
  }

  async function prewarmImages(payloads) {
    const posters = [];
    const backdrops = [];
    const seen = new Set();
    for (const payload of payloads) {
      for (const item of Array.isArray(payload?.results) ? payload.results : []) {
        if (!item || !item.id) continue;
        const key = `${item.media_type || 'movie'}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.poster_path) posters.push(item.poster_path);
        if (item.backdrop_path) backdrops.push(item.backdrop_path);
      }
    }
    const jobs = [];
    for (const posterPath of posters.slice(0, 120)) {
      for (const size of ['w185', 'w342']) {
        jobs.push(`https://image.tmdb.org/t/p/${size}${posterPath}`);
      }
    }
    for (const backdropPath of backdrops.slice(0, 40)) {
      jobs.push(`https://image.tmdb.org/t/p/w780${backdropPath}`);
    }
    const queue = [...jobs];
    const workerCount = 3;
    const worker = async () => {
      while (queue.length) {
        const urlStr = queue.shift();
        try {
          await fetchImageBytes(urlStr);
        } catch {
          // best-effort
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  function getStatus() {
    let imgFiles = 0;
    let imgBytes = 0;
    try {
      for (const name of fs.readdirSync(imgDir)) {
        try {
          imgFiles += 1;
          imgBytes += fs.statSync(path.join(imgDir, name)).size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return {
      enabled: enabled(),
      endpoint: doh && doh.endpoint || '',
      port: serverPort,
      indexCount: apiIndex.size,
      searchIndexCount: searchIndex.size,
      imgFiles,
      imgBytes,
      lastWarmupAt
    };
  }

  function install() {
    loadPersisted();
    const started = start().then((port) => {
      try {
        patchSessionFetch();
        registerImageRedirect();
      } catch {
        // feature degrades to the original request path
      }
      warmup().catch(() => {});
      setInterval(() => {
        warmup().catch(() => {});
      }, 6 * 60 * 60 * 1000);
      return port;
    });
    return started;
  }

  return { install, start, warmup, getStatus, serveApi, fetchImageBytes };
}

module.exports = { createMetaServer };

'use strict';

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const DEFAULT_DOH_ENDPOINT = process.env.CINEFLOW_DOH_ENDPOINT || 'https://arkdo.ddd.oaifree.com/query-dns';
const DOH_TYPES = { 4: 'A', 6: 'AAAA' };
const KEEP_ALIVE_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 80,
  maxFreeSockets: 24,
  timeout: 30000
});
const KEEP_ALIVE_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 80,
  maxFreeSockets: 24,
  timeout: 30000
});
const DOH_UNREACHABLE_AFTER_FAILURES = 3;
const DOH_REPROBE_MS = 20000;

function normalizeDohEndpoint(value) {
  const text = String(value || DEFAULT_DOH_ENDPOINT).trim();
  if (!text) return DEFAULT_DOH_ENDPOINT;
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function createHeaderBag(rawHeaders = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined || value === null) continue;
    map.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
  return {
    get(name) {
      return map.get(String(name).toLowerCase()) ?? null;
    },
    has(name) {
      return map.has(String(name).toLowerCase());
    },
    forEach(callback) {
      for (const [key, value] of map) callback(value, key);
    },
    entries() {
      return map.entries();
    }
  };
}

function createDohResolver(options = {}) {
  const endpoint = normalizeDohEndpoint(options.endpoint);
  const cacheDir = options.cacheDir || null;
  const lookupTimeoutMs = Number(options.timeoutMs || 2500);
  const entryTtlFloorMs = Number(options.entryTtlFloorMs || 60 * 1000);
  const entryTtlCapMs = Number(options.entryTtlCapMs || 30 * 60 * 1000);
  const negativeTtlMs = Number(options.negativeTtlMs || 30 * 1000);
  const maxRedirects = Number(options.maxRedirects || 5);
  const cacheFile = cacheDir ? path.join(cacheDir, 'doh-cache.json') : null;

  const memory = new Map();
  const pending = new Map();
  const failUntil = new Map();
  let persistTimer = null;
  let closed = false;
  let endpointFailures = 0;
  let endpointLastOkAt = 0;
  let endpointLastFailAt = 0;
  let endpointEverOk = false;

  function loadPersisted() {
    if (!cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      for (const [host, entry] of Object.entries(raw)) {
        if (!entry || !Array.isArray(entry.addresses) || !entry.addresses.length) continue;
        memory.set(String(host).toLowerCase(), {
          addresses: entry.addresses.map(String),
          family: Number(entry.family) === 6 ? 6 : 4,
          expiresAt: Number(entry.expiresAt) || 0
        });
      }
    } catch {
      // best-effort
    }
  }

  function schedulePersist() {
    if (!cacheFile || closed) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const plain = {};
        for (const [host, entry] of memory) {
          plain[host] = { addresses: entry.addresses, family: entry.family, expiresAt: entry.expiresAt };
        }
        const tmp = `${cacheFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(plain), 'utf8');
        fs.renameSync(tmp, cacheFile);
      } catch {
        // best-effort
      }
    }, 1500);
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
  }

  function memoryGet(hostname) {
    return memory.get(String(hostname).toLowerCase()) || null;
  }

  function markEndpointOk() {
    endpointFailures = 0;
    endpointLastOkAt = Date.now();
    endpointEverOk = true;
  }

  function markEndpointFailure() {
    endpointFailures += 1;
    endpointLastFailAt = Date.now();
  }

  function endpointHealthy() {
    if (endpointFailures < DOH_UNREACHABLE_AFTER_FAILURES) return true;
    return Date.now() - endpointLastFailAt >= DOH_REPROBE_MS;
  }

  function withEndpointFlag(error, reachable) {
    try {
      error.endpointReachable = reachable;
    } catch {
      // ignore
    }
    return error;
  }

  function queryDoH(hostname, family) {
    return new Promise((resolve, reject) => {
      const type = DOH_TYPES[family] || 'A';
      let url;
      try {
        url = new URL(endpoint);
        url.searchParams.set('name', hostname);
        url.searchParams.set('type', type);
      } catch (error) {
        reject(error);
        return;
      }
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.get(url.toString(), {
        agent: url.protocol === 'http:' ? KEEP_ALIVE_HTTP_AGENT : KEEP_ALIVE_HTTPS_AGENT,
        headers: { accept: 'application/dns-json', 'user-agent': 'CineFlow-DoH/3.4.4' },
        timeout: lookupTimeoutMs
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 60000) req.destroy(withEndpointFlag(new Error('DoH response too large'), true));
        });
        res.on('end', () => {
          markEndpointOk();
          try {
            const payload = JSON.parse(text);
            if (Number(payload.Status) !== 0) {
              const answerError = new Error(`DoH status ${payload.Status}`);
              answerError.endpointReachable = true;
              reject(answerError);
              return;
            }
            const wantedType = family === 6 ? 28 : 1;
            const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
            const addresses = answers
              .filter((item) => Number(item.type) === wantedType && item.data)
              .map((item) => String(item.data));
            const minTtl = answers.length
              ? Math.min(...answers.map((item) => Math.max(30, Number(item.TTL) || 300)))
              : 300;
            resolve({ addresses, ttlMs: Math.min(Math.max(minTtl * 1000, entryTtlFloorMs), entryTtlCapMs) });
          } catch (error) {
            reject(withEndpointFlag(error, true));
          }
        });
      });
      req.on('error', (error) => {
        if (error?.endpointReachable !== true) markEndpointFailure();
        reject(error);
      });
      req.on('timeout', () => req.destroy(withEndpointFlag(new Error('DoH query timeout'), false)));
    });
  }

  async function resolveWithDoH(hostname, family) {
    const { addresses, ttlMs } = await queryDoH(hostname, family);
    if (!addresses.length) {
      const failure = new Error('DoH empty answer');
      failure.emptyAnswer = true;
      throw failure;
    }
    const entry = {
      addresses,
      family: family === 6 ? 6 : 4,
      expiresAt: Date.now() + ttlMs
    };
    memory.set(String(hostname).toLowerCase(), entry);
    schedulePersist();
    return entry;
  }

  async function resolveOnce(host, preferredFamily) {
    const attempts = preferredFamily === 6 ? [6, 4] : [4, 6];
    for (const family of attempts) {
      try {
        return await resolveWithDoH(host, family);
      } catch (error) {
        if (error?.emptyAnswer) {
          failUntil.set(host, Date.now() + negativeTtlMs);
          return null;
        }
        // 换下一个 family / 交给下方负缓存与陈旧回退
      }
    }
    failUntil.set(host, Date.now() + negativeTtlMs);
    return null;
  }

  async function resolve(hostname, options = {}) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return null;
    const cached = memoryGet(host);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const failedRecently = failUntil.get(host) || 0;
    if (failedRecently > Date.now() || !endpointHealthy()) return cached || null;
    const inFlight = pending.get(host);
    if (inFlight) return inFlight;
    const preferredFamily = Number(options.family) === 6 ? 6 : 4;
    const task = resolveOnce(host, preferredFamily).finally(() => pending.delete(host));
    pending.set(host, task);
    const result = await task;
    return result || cached || null;
  }

  function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = options || {};
    resolve(hostname, { family: Number(opts.family) === 6 ? 6 : 4 }).then((entry) => {
      if (entry && entry.addresses.length) {
        if (opts.all) {
          callback(null, entry.addresses.map((address) => ({ address, family: entry.family })));
        } else {
          callback(null, entry.addresses[0], entry.family);
        }
        return;
      }
      dns.lookup(hostname, opts, callback);
    }).catch(() => {
      dns.lookup(hostname, opts, callback);
    });
  }

  function requestOnce(targetUrl, { method = 'GET', headers = {}, timeoutMs = 10000, signal } = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
      const isHttps = targetUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const cleanHeaders = { 'accept-encoding': 'identity', ...headers };
      const req = lib.request({
        protocol: targetUrl.protocol,
        agent: isHttps ? KEEP_ALIVE_HTTPS_AGENT : KEEP_ALIVE_HTTP_AGENT,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: cleanHeaders,
        servername: isHttps ? targetUrl.hostname : undefined,
        lookup,
        timeout: timeoutMs
      }, (res) => {
        const response = {
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          url: targetUrl.toString(),
          redirected: false,
          headers: createHeaderBag(res.headers),
          nodeStream: res,
          async text() {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            res.resume();
            return Buffer.concat(chunks).toString('utf8');
          },
          async json() {
            return JSON.parse(await response.text());
          }
        };
        resolveRequest(response);
        req.on('error', () => {
          try { res.destroy(); } catch { /* ignore */ }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('DoH request timeout'), { name: 'AbortError' })));
      req.on('error', rejectRequest);
      if (signal) {
        if (signal.aborted) {
          req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        } else {
          const onAbort = () => req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          signal.addEventListener('abort', onAbort, { once: true });
          req.on('close', () => signal.removeEventListener('abort', onAbort));
        }
      }
      req.end();
    });
  }

  async function fetchUrl(rawUrl, init = {}) {
    const { method = 'GET', headers = {}, timeoutMs = 10000, signal } = init;
    let current = new URL(rawUrl);
    let response = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      response = await requestOnce(current, { method, headers, timeoutMs, signal });
      const location = response.headers.get('location');
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location;
      if (!isRedirect || hop === maxRedirects) {
        response.redirected = current.toString() !== new URL(rawUrl).toString();
        return response;
      }
      try {
        for await (const _ of response.nodeStream) { /* drain */ }
      } catch { /* ignore */ }
      const previous = current;
      current = new URL(location, current);
      if (!['http:', 'https:'].includes(current.protocol)) {
        throw new Error('DoH redirect to unsupported protocol');
      }
      if (previous.toString() === current.toString()) throw new Error('DoH redirect loop');
    }
    throw new Error('DoH redirect limit reached');
  }

  function close() {
    closed = true;
    if (persistTimer) clearTimeout(persistTimer);
  }

  function health() {
    return {
      reachable: endpointHealthy(),
      failures: endpointFailures,
      lastOkAt: endpointLastOkAt,
      lastFailAt: endpointLastFailAt,
      everOk: endpointEverOk,
      endpoint
    };
  }

  // 启动探测：直接查一次海报域名，既判定端点在直连下是否可达，又顺带预热海报域名解析。
  async function ping() {
    try {
      await queryDoH('image.tmdb.org', 4);
    } catch {
      // 失败已由 queryDoH 记入健康度
    }
    return health();
  }

  loadPersisted();

  return {
    endpoint,
    resolve,
    lookup,
    fetchUrl,
    close,
    health,
    ping,
    stats() {
      return { entries: memory.size, endpoint, reachable: health().reachable };
    }
  };
}

module.exports = { createDohResolver };

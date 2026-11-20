'use strict';

/**
 * 直连兜底（新增文件，零侵入）：
 * 无代理时系统 DNS 常被污染（api.themoviedb.org 拿到 202.160.x / 173.255.x 这类死地址），
 * Chromium 只能等到超时。这里同时问三个 DoH、把候选 IP 逐个 TLS 探活，
 * 留下真能握手的那个再直连（SNI/Host 仍是原域名，证书链照旧校验）。
 * 配了代理时 route 不是 DIRECT，本模块完全不介入。
 */

const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DOH_ENDPOINTS = [
  'https://arkdo.ddd.oaifree.com/query-dns',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query',
  'https://dns.alidns.com/resolve'
];

const IP_TTL_MS = 8 * 60 * 1000;
const BAD_TTL_MS = 4 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1400;
const REQUEST_TIMEOUT_MS = Number(process.env.CINEFLOW_NET_RESCUE_TIMEOUT_MS || 7000);
const HEDGE_DELAY_MS = Number(process.env.CINEFLOW_NET_RESCUE_HEDGE_MS || 900);
const FAST_FAIL_GRACE_MS = Number(process.env.CINEFLOW_NET_RESCUE_GRACE_MS || 1200);
const ROUTE_TTL_MS = 60 * 1000;
const MAX_CANDIDATES = 6;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
let earlyDirectTimer = null;
const PROXY_PROBE_MS = Number(process.env.CINEFLOW_PROXY_PROBE_MS || 1200);
/* 代理"健康"判定预算：必须比单次 CONNECT 往返宽裕。
   实测 127.0.0.1:7897 → api.themoviedb.org CONNECT 需要 1269ms，→ image.tmdb.org 需要 3158ms。
   用 1200ms 去判，慢但在用的代理会被误判成"死代理"，于是 forceDirect → 60s 后 restore →
   再判死 → 循环。每次 setProxy 都会让 Chromium 重建连接池，用户感受到的就是周期性卡顿。
   所以健康判定单独给 4500ms，并且要求连续两次失败才真的降级。 */
const PROXY_HEALTH_MS = Number(process.env.CINEFLOW_PROXY_HEALTH_MS || 4500);
const PROXY_DEAD_TTL_MS = 60 * 1000;
const PROXY_ALIVE_TTL_MS = 60 * 1000;
const PROXY_REPROBE_INTERVAL_MS = 60 * 1000;
const MAP_MAX_TLS_MS = Number(process.env.CINEFLOW_MAP_MAX_TLS_MS || 400);

// TMDB 官方别名（tmdb-resilience 的 sticky 端点）也必须直连解析，否则 DNS 污染时返回假页面。
const TMDB_ALIAS_HOST = 'api.tmdb.org';

const SKIP_EXTENSION_RE = /\.(ts|m4s|mp4|m4a|aac|flv|webm|mkv|mp3|wav|vtt|jpg|jpeg|png|webp|gif)(?:$|[?#])/i;

// 媒体类 URL：走流式直连（不攒内存、Range 透传），保证播放器 seek/切集不卡。
const MEDIA_URL_RE = /\.(?:m3u8|mpd|ts|m4s|mp4|m4a|aac|flv|webm|mkv|mp3|wav|vtt|jpg|jpeg|png|webp|gif)(?:$|[?#])/i;

const AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 96, maxFreeSockets: 24, timeout: 45000 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 64, maxFreeSockets: 24, timeout: 45000 });

function toUrlString(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.url === 'string') return input.url;
    if (typeof input.href === 'string') return input.href;
  }
  return String(input || '');
}

function dohQuery(endpoint, host, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint);
      url.searchParams.set('name', host);
      url.searchParams.set('type', 'A');
    } catch {
      resolve([]);
      return;
    }
    const req = https.get(url.toString(), {
      agent: AGENT,
      headers: { accept: 'application/dns-json', 'user-agent': 'CineFlow-DoH/4.0.0' },
      timeout: timeoutMs
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 60000) req.destroy();
      });
      res.on('end', () => {
        try {
          const payload = JSON.parse(text);
          const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
          resolve(answers.filter((a) => Number(a.type) === 1 && a.data).map((a) => String(a.data)));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function tlsProbe(ip, host, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let done = false;
    let socket = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(ok ? Date.now() - startedAt : -1);
    };
    try {
      socket = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: true, timeout: timeoutMs }, () => finish(true));
    } catch {
      finish(false);
      return;
    }
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
    setTimeout(() => finish(false), timeoutMs + 120);
  });
}

function tcpProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let done = false;
    const socket = net.connect({ host: ip, port, timeout: timeoutMs });
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok ? Date.now() - startedAt : -1);
    };
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
    setTimeout(() => finish(false), timeoutMs + 120);
  });
}

function decodeBody(buffer, encoding) {
  const name = String(encoding || '').toLowerCase().trim();
  if (!name || name === 'identity') return buffer;
  try {
    if (name === 'gzip') return zlib.gunzipSync(buffer);
    if (name === 'deflate') return zlib.inflateSync(buffer);
    if (name === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

function createNetRescue(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const goodIp = new Map();
  const badIp = new Map();
  const resolving = new Map();
  const routeCache = new Map();
  const debug = process.env.CINEFLOW_NET_RESCUE_DEBUG === '1';
  const debugLog = (...args) => { if (debug) log('[rescue]', ...args); };
  const stats = { requests: 0, rescued: 0, fastPath: 0, fellBack: 0, probes: 0, skipped: 0, fastFail: 0 };
  const searchedHosts = new Set();

  function isBad(ip) {
    const until = badIp.get(ip) || 0;
    if (until > Date.now()) return true;
    badIp.delete(ip);
    return false;
  }

  function markBad(ip) {
    if (ip) badIp.set(ip, Date.now() + BAD_TTL_MS);
  }

  function cachedIp(host) {
    const entry = goodIp.get(host);
    if (!entry) return '';
    if (entry.expiresAt <= Date.now()) {
      goodIp.delete(host);
      return '';
    }
    return entry.ip;
  }

  function cachedLatency(host) {
    const entry = goodIp.get(host);
    return entry && entry.latency ? entry.latency : 0;
  }

  /* ---------- 真 IP 落盘缓存 ----------
     无代理时 TMDB 只能靠 DoH 找 CloudFront 边缘；找到一次就存盘，
     下次启动直接命中，不必再等 DoH + 多路探活（首次 0.6~2s → 之后 0ms）。 */
  const cacheFile = String(options.cacheFile || '');
  const RESTORED_TTL_MS = Number(process.env.CINEFLOW_RESTORED_IP_TTL_MS || 6 * 60 * 60 * 1000);
  let saveTimer = null;

  function loadIpCache() {
    if (!cacheFile) return 0;
    try {
      const raw = JSON.parse(require('node:fs').readFileSync(cacheFile, 'utf8'));
      const now = Date.now();
      let restored = 0;
      for (const [host, entry] of Object.entries(raw || {})) {
        if (!entry || !entry.ip) continue;
        if (!/^[0-9a-f.:]+$/i.test(String(entry.ip))) continue;
        goodIp.set(host, { ip: String(entry.ip), latency: Number(entry.latency) || 0, expiresAt: now + RESTORED_TTL_MS });
        restored += 1;
      }
      if (restored) debugLog('还原 ' + restored + ' 个真 IP 缓存');
      return restored;
    } catch { return 0; }
  }

  let lastCacheWrite = 0;

  function flushCache() {
    if (!cacheFile) return;
    try {
      const out = {};
      for (const [host, entry] of goodIp) {
        if (entry && entry.ip) out[host] = { ip: entry.ip, latency: entry.latency || 0, savedAt: Date.now() };
      }
      if (!Object.keys(out).length) return;
      const fsp = require('node:fs');
      const pathMod = require('node:path');
      fsp.mkdirSync(pathMod.dirname(cacheFile), { recursive: true });
      fsp.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
      lastCacheWrite = Date.now();
    } catch { /* ignore */ }
  }

  // 立即落盘（节流 500ms）：真 IP 是"下次启动秒进 TMDB 模式"的关键，不能等到进程退出。
  function saveIpCache() {
    if (!cacheFile) return;
    const now = Date.now();
    if (now - lastCacheWrite < 500) {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushCache();
      }, 500);
      if (typeof saveTimer.unref === 'function') saveTimer.unref();
      return;
    }
    flushCache();
  }

  const restoredIps = loadIpCache();

  async function candidates(host) {
    const lists = await Promise.all(DOH_ENDPOINTS.map((endpoint) => dohQuery(endpoint, host, 1800)));
    const merged = [];
    for (const list of lists) {
      for (const ip of list) {
        if (!merged.includes(ip)) merged.push(ip);
      }
    }
    return merged.slice(0, MAX_CANDIDATES);
  }

  // 并发探活所有候选，先到先用；再等 260ms 追赶窗口，拿到更快的那条就换成它。
  // 直连 TMDB 的各家边缘 IP 差别很大（实测 2.5s ~ 5.8s），选错一个整页都慢。
  const PICK_CHASE_MS = Number(process.env.CINEFLOW_PICK_CHASE_MS || 260);

  function pickFastest(host, ips, secure) {
    return new Promise((resolve) => {
      const usable = ips.filter((ip) => !isBad(ip));
      if (!usable.length) {
        resolve(null);
        return;
      }
      const seen = [];
      let pending = usable.length;
      let chosen = '';
      let chosenLatency = Infinity;
      let chaseTimer = 0;
      const finish = () => {
        if (chaseTimer) clearTimeout(chaseTimer);
        if (!chosen) return;
        resolve({ ip: chosen, latency: chosenLatency });
      };
      const consider = (ip, latency) => {
        if (latency < 0) {
          markBad(ip);
          return;
        }
        seen.push({ ip, latency });
        if (latency < chosenLatency) {
          chosen = ip;
          chosenLatency = latency;
          if (chaseTimer) clearTimeout(chaseTimer);
          chaseTimer = setTimeout(finish, PICK_CHASE_MS);
        }
      };
      for (const ip of usable) {
        stats.probes += 1;
        const probe = secure ? tlsProbe(ip, host, PROBE_TIMEOUT_MS) : tcpProbe(ip, 80, PROBE_TIMEOUT_MS);
        probe.then((latency) => {
          consider(ip, latency);
          pending -= 1;
          if (pending === 0) {
            if (!chosen) {
              resolve(null);
              return;
            }
            finish();
          }
        });
      }
    });
  }

  const MAX_RESOLVE_CONCURRENCY = 3;
  let resolveActive = 0;
  const resolvWaiters = [];

  function acquireResolveSlot() {
    if (resolveActive < MAX_RESOLVE_CONCURRENCY) {
      resolveActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      resolvWaiters.push(resolve);
    });
  }

  function releaseResolveSlot() {
    const next = resolvWaiters.shift();
    if (next) {
      next();
      return;
    }
    resolveActive = Math.max(0, resolveActive - 1);
  }

  /* TMDB 的官方别名与主域名是同一套 CloudFront 边缘（IP 可互换，SNI/Host 仍用原域名）。
     DoH 偶尔只解析出其中一个（实测 api.tmdb.org 常常能解析、api.themoviedb.org 解析失败），
     这时借用别名的真 IP 就能立刻连通——不需要再等一轮 DoH 超时。 */
  const HOST_ALIASES = {
    'api.themoviedb.org': ['api.tmdb.org'],
    'api.tmdb.org': ['api.themoviedb.org'],
    'www.themoviedb.org': ['api.themoviedb.org'],
    'image.tmdb.org': ['image.tmdb.org']
  };

  async function resolveViaAlias(host, secure) {
    const list = (HOST_ALIASES[host] || []).filter((alias) => alias !== host);
    for (const alias of list) {
      const aliasIp = await resolveIp(alias, secure).catch(() => '');
      if (!aliasIp) continue;
      goodIp.set(host, { ip: aliasIp, latency: cachedLatency(alias), expiresAt: Date.now() + IP_TTL_MS });
      debugLog('alias', host, '<-', alias, aliasIp);
      return aliasIp;
    }
    return '';
  }

  async function resolveIp(host, secure = true) {
    const sticky = cachedIp(host);
    if (sticky) return sticky;
    const key = host + (secure ? '|s' : '|p');
    if (resolving.has(key)) return resolving.get(key);
    const task = (async () => {
      await acquireResolveSlot();
      let ips = [];
      try {
        ips = await candidates(host);
      } finally {
        releaseResolveSlot();
      }
      if (!ips.length) {
        const viaAlias = await resolveViaAlias(host, secure);
        if (viaAlias) return viaAlias;
        return '';
      }
      searchedHosts.add(host);
      const best = await pickFastest(host, ips, secure);
      if (!best || !best.ip) {
        const viaAlias = await resolveViaAlias(host, secure);
        if (viaAlias) return viaAlias;
        return '';
      }
      goodIp.set(host, { ip: best.ip, latency: best.latency, expiresAt: Date.now() + IP_TTL_MS });
      saveIpCache();
      return best.ip;
    })().finally(() => resolving.delete(key));
    resolving.set(key, task);
    return task;
  }

  /* 预热连接：必须用"真 IP"去建连，否则 DNS 被污染时这一步等于白做。
     https.Agent 的连接池按 host:port:servername 复用，所以这里用 (ip, servername=host)
     建出来的 socket，正好会被后面 requestHost/streamHost 的请求复用 —— 首张海报、
     首个 m3u8 分片都不必再等一次冷 TLS 握手（实测冷启 7.2s → 复用后 0.1s）。 */
  function warmUp(hosts) {
    const list = (Array.isArray(hosts) ? hosts : []).filter(Boolean);
    for (const entry of list) {
      try {
        const secure = !String(entry).startsWith('http://');
        const host = String(entry).replace(/^https?:\/\//, '');
        const ip = cachedIp(host);
        const agent = secure ? AGENT : HTTP_AGENT;
        const req = (secure ? https : http).request({
          host: ip || host,
          port: secure ? 443 : 80,
          path: '/',
          method: 'HEAD',
          agent,
          servername: secure ? host : undefined,
          headers: { host, 'user-agent': 'CineFlow/4.0.0', connection: 'keep-alive' },
          timeout: 6000
        }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.end();
      } catch { /* ignore */ }
    }
  }

  function prefetchIps(hosts, budgetMs) {
    const list = (Array.isArray(hosts) ? hosts : []).filter(Boolean);
    if (!list.length) return Promise.resolve({});
    return new Promise((resolve) => {
      const found = {};
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(found);
      };
      setTimeout(done, budgetMs || 1800);
      Promise.all(list.map((entry) => {
        const secure = !String(entry).startsWith('http://');
        const host = String(entry).replace(/^https?:\/\//, '');
        return resolveIp(host, secure).then((ip) => { if (ip) found[host] = ip; }).catch(() => {});
      }))
        .then(done)
        .catch(done);
    });
  }

  function requestHost(host, ip, urlObj, init, hops) {
    const secure = urlObj.protocol !== 'http:';
    const lib = secure ? https : http;
    return new Promise((resolve, reject) => {
      const method = String((init && init.method) || 'GET').toUpperCase();
      const source = init && init.headers ? init.headers : {};
      const headers = {};
      const entries = source instanceof Map ? Array.from(source.entries()) : Object.entries(source);
      for (const [key, value] of entries) {
        if (/^(host|connection|content-length|accept-encoding)$/i.test(key)) continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      headers.host = host;
      if (secure) headers['accept-encoding'] = 'gzip, deflate, br';
      if (!headers['user-agent'] && !headers['User-Agent']) headers['user-agent'] = 'CineFlow/4.0.0';
      const body = init && init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD'
        ? (typeof init.body === 'string' || Buffer.isBuffer(init.body) ? init.body : String(init.body))
        : null;
      if (body !== null) headers['content-length'] = Buffer.byteLength(body);

      const requestOptions = {
        host: ip,
        port: urlObj.port || (secure ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
        agent: secure ? AGENT : HTTP_AGENT,
        timeout: REQUEST_TIMEOUT_MS
      };
      if (secure) requestOptions.servername = host;
      const req = lib.request(requestOptions, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && hops > 0) {
          res.resume();
          let next = null;
          try {
            next = new URL(location, urlObj.toString());
          } catch {
            next = null;
          }
          if (!next || (next.protocol !== 'https:' && next.protocol !== 'http:')) {
            resolve({ status, headers: res.headers, buffer: Buffer.alloc(0) });
            return;
          }
          resolveIp(next.hostname, next.protocol !== 'http:')
            .then((nextIp) => (nextIp
              ? requestHost(next.hostname, nextIp, next, init, hops - 1)
              : { status, headers: res.headers, buffer: Buffer.alloc(0) }))
            .then(resolve, reject);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BUFFER_BYTES) {
            req.destroy(new Error('rescue buffer overflow'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, res.headers['content-encoding']);
          if (init && init.__cfExpectJson && status >= 200 && status < 300 && !looksJson(decoded)) {
            reject(new Error('non-json body from ' + host));
            return;
          }
          resolve({ status, headers: res.headers, buffer: decoded });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      if (body !== null) req.write(body);
      req.end();
    });
  }

  /* 流式直连：视频分片、海报图这类大响应绝不能先攒进内存再吐给渲染层，
     否则播放器要么等、要么直接被 buffer overflow 掐断。这里把上游 socket 直接
     包成 ReadableStream，状态码/headers/Range 原样透传（206 partial content 可用）。 */
  function streamHost(host, ip, urlObj, init, hops) {
    const secure = urlObj.protocol !== 'http:';
    const lib = secure ? https : http;
    return new Promise((resolve, reject) => {
      const method = String((init && init.method) || 'GET').toUpperCase();
      const source = (init && init.headers) || {};
      const headers = {};
      const entries = source instanceof Map ? Array.from(source.entries()) : Object.entries(source);
      for (const [key, value] of entries) {
        if (/^(host|connection|accept-encoding)$/i.test(key)) continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      headers.host = host;
      headers['accept-encoding'] = 'identity';
      if (!headers['user-agent'] && !headers['User-Agent']) headers['user-agent'] = 'CineFlow/4.0.0';
      const requestOptions = {
        host: ip,
        port: urlObj.port || (secure ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
        agent: secure ? AGENT : HTTP_AGENT
      };
      if (secure) requestOptions.servername = host;
      const req = lib.request(requestOptions, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && hops > 0) {
          res.resume();
          let next = null;
          try { next = new URL(location, urlObj.toString()); } catch { next = null; }
          if (!next) {
            resolve(buildResponse({ status, headers: res.headers, buffer: Buffer.alloc(0) }));
            return;
          }
          resolveIp(next.hostname, next.protocol !== 'http:')
            .then((nextIp) => (nextIp
              ? streamHost(next.hostname, nextIp, next, init, hops - 1)
              : buildResponse({ status, headers: res.headers, buffer: Buffer.alloc(0) })))
            .then(resolve, reject);
          return;
        }
        const outHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers || {})) {
          if (value === undefined || value === null) continue;
          if (/^(content-encoding|transfer-encoding|connection|keep-alive)$/i.test(key)) continue;
          try { outHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value)); } catch { /* ignore */ }
        }
        let closed = false;
        const stream = new ReadableStream({
          start(controller) {
            res.on('data', (chunk) => {
              if (closed) return;
              try { controller.enqueue(new Uint8Array(chunk)); } catch { closed = true; }
            });
            res.on('end', () => {
              if (closed) return;
              closed = true;
              try { controller.close(); } catch { /* ignore */ }
            });
            res.on('error', () => {
              if (closed) return;
              closed = true;
              try { controller.close(); } catch { /* ignore */ }
            });
          },
          cancel() {
            closed = true;
            try { req.destroy(); } catch { /* ignore */ }
          }
        });
        resolve(new Response(status === 204 || status === 304 ? null : stream, { status: status || 200, headers: outHeaders }));
      });
      req.on('error', reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
      req.end();
    });
  }

  function buildResponse(result) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(result.headers || {})) {
      if (value === undefined || value === null) continue;
      if (/^(content-encoding|transfer-encoding|content-length|connection|keep-alive)$/i.test(key)) continue;
      try { headers.set(key, Array.isArray(value) ? value.join(', ') : String(value)); } catch { /* ignore */ }
    }
    const allowBody = !(result.status === 204 || result.status === 304);
    return new Response(allowBody ? result.buffer : null, { status: result.status || 200, headers });
  }

  const proxyState = { dead: false, checkedAt: 0, alive: true, overrode: false };

  function parseProxyAddress(resolved) {
    const text = String(resolved || '').trim();
    const match = text.match(/^(?:PROXY|HTTPS|SOCKS4|SOCKS5|SOCKS)\s+([^\s;]+)/i);
    if (!match) return null;
    const value = match[1];
    const cut = value.lastIndexOf(':');
    if (cut <= 0) return null;
    const hostPart = value.slice(0, cut).replace(/^\[|\]$/g, '');
    const portPart = Number(value.slice(cut + 1));
    if (!hostPart || !Number.isFinite(portPart)) return null;
    return { host: hostPart, port: portPart };
  }


  function connectProbe(proxyHost, proxyPort, targetHost, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(ok);
      };
      const sock = net.connect({ host: proxyHost, port: proxyPort, timeout: timeoutMs });
      let handshake = '';
      sock.on('connect', () => {
        sock.write('CONNECT ' + targetHost + ':443 HTTP/1.1' + String.fromCharCode(13, 10) + 'Host: ' + targetHost + ':443' + String.fromCharCode(13, 10, 13, 10));
      });
      sock.on('data', (chunk) => {
        handshake += chunk.toString('latin1');
        if (!handshake.includes(String.fromCharCode(13, 10))) return;
        if (!/^HTTP\/1\.[01] 200/i.test(handshake)) {
          finish(false);
          return;
        }
        sock.removeAllListeners('data');
        const secure = tls.connect({ socket: sock, servername: targetHost, rejectUnauthorized: false });
        secure.on('secureConnect', () => {
          try { secure.destroy(); } catch { /* ignore */ }
          finish(true);
        });
        secure.on('error', () => finish(false));
      });
      sock.on('error', () => finish(false));
      sock.on('timeout', () => finish(false));
      setTimeout(() => finish(false), timeoutMs + 200);
    });
  }

  /* 按主机测量"代理到这家主机"能不能连通、要多久。
     Clash 之类的代理经常是"端口活着、但某些域名连不上"（实测 CONNECT api.themoviedb.org 直接挂死），
     所以不能只看代理端口通不通，必须按目标主机分别判断。 */
  const PROXY_HOST_TTL_MS = 60 * 1000;
  const proxyHostState = new Map();

  function connectProbeTimed(proxyHost, proxyPort, targetHost, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      let settled = false;
      const finish = (ms) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(ms);
      };
      const sock = net.connect({ host: proxyHost, port: proxyPort, timeout: timeoutMs });
      let handshake = '';
      sock.on('connect', () => {
        sock.write('CONNECT ' + targetHost + ':443 HTTP/1.1' + String.fromCharCode(13, 10) + 'Host: ' + targetHost + ':443' + String.fromCharCode(13, 10, 13, 10));
      });
      sock.on('data', (chunk) => {
        handshake += chunk.toString('latin1');
        if (!handshake.includes(String.fromCharCode(13, 10))) return;
        if (!/^HTTP\/1\.[01] 200/i.test(handshake)) {
          finish(-1);
          return;
        }
        const handshakeMs = Date.now() - started;
        sock.removeAllListeners('data');
        const secure = tls.connect({ socket: sock, servername: targetHost, rejectUnauthorized: false });
        secure.on('secureConnect', () => {
          try { secure.destroy(); } catch { /* ignore */ }
          finish(Date.now() - started);
        });
        secure.on('error', () => finish(handshakeMs));
      });
      sock.on('error', () => finish(-1));
      sock.on('timeout', () => finish(-1));
      setTimeout(() => finish(-1), timeoutMs + 200);
    });
  }

  function proxyConnectLatency(ses, host) {
    const now = Date.now();
    const hit = proxyHostState.get(host);
    if (hit && now - hit.at < PROXY_HOST_TTL_MS) return Promise.resolve(hit.latency);
    return ses.resolveProxy('https://' + host + '/')
      .then((resolved) => {
        const addr = parseProxyAddress(resolved);
        if (!addr) {
          proxyHostState.set(host, { at: Date.now(), latency: 0 });
          return 0;
        }
        return connectProbeTimed(addr.host, addr.port, host, PROXY_PROBE_MS).then((ms) => {
          proxyHostState.set(host, { at: Date.now(), latency: ms });
          debugLog('proxy->' + host, ms);
          return ms;
        });
      })
      .catch(() => -1);
  }

  function probeProxyMode(ses) {
    if (proxyState.inflight) return proxyState.inflight;
    proxyState.inflight = ses.resolveProxy('https://api.themoviedb.org/3/configuration')
      .then((resolved) => {
        const addr = parseProxyAddress(resolved);
        debugLog('probe resolved', JSON.stringify(String(resolved || '')));
        if (!addr) {
          proxyState.probedAt = Date.now();
          proxyState.dead = false;
          return false;
        }
        return connectProbe(addr.host, addr.port, 'api.themoviedb.org', PROXY_HEALTH_MS)
          .then((ok) => {
            proxyState.probedAt = Date.now();
            proxyState.address = addr;
            debugLog('probe connect', addr.host + ':' + addr.port, ok);
            if (ok) {
              proxyState.dead = false;
              proxyState.failStreak = 0;
              return true;
            }
            // 连续两次判死才降级：单次慢探（Clash 切换节点、DNS 冷启）不会再引发全局切直连。
            proxyState.failStreak = (proxyState.failStreak || 0) + 1;
            if (proxyState.failStreak >= 2) {
              proxyState.dead = true;
              log('代理 ' + addr.host + ':' + addr.port + ' 连续 ' + proxyState.failStreak + ' 次连不通 TMDB，改走直连兜底');
            } else {
              debugLog('代理首次探测失败，保留代理待复检');
            }
            return !proxyState.dead;
          });
      })
      .catch(() => {
        proxyState.probedAt = Date.now();
        proxyState.dead = false;
        return true;
      })
      .finally(() => {
        proxyState.inflight = null;
      });
    return proxyState.inflight;
  }

  // 启动早期的"抢先直连"：代理端口是通的、但 CONNECT 到 TMDB 迟迟不返（实测 7897 会挂满 4s），
  // 这段时间里所有请求都要等代理超时，用户看到的就是"卡住/进不去"。这里给探测 900ms，
  // 到点还没结论就先切直连；真代理稍后确认可用的话，restoreProxyIfAlive 会在 60s 内切回去。
  // 阈值必须大于代理探测预算（默认 1200ms）：只兜住 TCP 通但 CONNECT 永不回这种真挂死，
  // 慢一点但可用的代理仍然走代理，不会被抢走。
  const EARLY_DIRECT_MS = Number(process.env.CINEFLOW_EARLY_DIRECT_MS || 6000);

  function scheduleEarlyDirect(ses) {
    if (earlyDirectTimer) return;
    earlyDirectTimer = setTimeout(() => {
      try {
        if (proxyState.probedAt) return;
        if (!proxyState.inflight) return;
        log('代理探测 ' + EARLY_DIRECT_MS + 'ms 未出结论，先切直连');
        forceDirect(ses);
      } catch { /* ignore */ }
    }, EARLY_DIRECT_MS);
    if (typeof earlyDirectTimer.unref === 'function') earlyDirectTimer.unref();
  }

  // 请求路径只读快照；探活放到后台，绝不阻塞任何一次 fetch
  function kickProxyProbe(ses) {
    const now = Date.now();
    if (proxyState.inflight) return;
    if (proxyState.probedAt && now - proxyState.probedAt < PROXY_REPROBE_INTERVAL_MS) return;
    scheduleEarlyDirect(ses);
    probeProxyMode(ses).then((ok) => {
      if (!ok) forceDirect(ses);
    }).catch(() => {});
  }

  function proxyAlive(ses, urlStr) {
    return ses.resolveProxy(urlStr).then((resolved) => {
      const addr = parseProxyAddress(resolved);
      debugLog('proxy resolved', JSON.stringify(String(resolved || '')), '->', JSON.stringify(addr));
      if (!addr) {
        proxyState.dead = false;
        proxyState.alive = true;
        return false;
      }
      const now = Date.now();
      const ttl = proxyState.dead ? PROXY_DEAD_TTL_MS : PROXY_ALIVE_TTL_MS;
      if (proxyState.checkedAt && now - proxyState.checkedAt < ttl) return proxyState.dead;
      return tcpProbe(addr.host, addr.port, PROXY_PROBE_MS).then((latency) => {
        debugLog('proxy tcp', addr.host + ':' + addr.port, latency);
        proxyState.checkedAt = Date.now();
        proxyState.dead = latency < 0;
        proxyState.alive = latency >= 0;
        proxyState.address = addr;
        if (proxyState.dead) log('代理 ' + addr.host + ':' + addr.port + ' 无响应，改走直连兜底');
        return proxyState.dead;
      });
    }).catch(() => proxyState.dead);
  }

  function readConfiguredProxy() {
    try {
      const file = options.settingsFile;
      if (!file) return '';
      const raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
      return String(raw.proxy || '');
    } catch {
      return '';
    }
  }

  function forceDirect(ses) {
    if (proxyState.overrode || proxyState.switching) return Promise.resolve();
    proxyState.switching = true;
    return ses.setProxy({ mode: 'direct' })
      .then(() => {
        proxyState.overrode = true;
        proxyState.switching = false;
        lastFlipAt = Date.now();
        log('已临时切到直连（代理不在线）');
      })
      .catch(() => {
        proxyState.switching = false;
      });
  }

  /* 反复切代理 = 反复丢弃 Chromium 的连接池。
     实测同一次启动里出现 4 次 "已临时切到直连 / 代理恢复可用"：每一次都会让所有在飞的
     海报、媒体分片重建 TCP+TLS，用户看到的就是"整体一顿一顿"。
     现在加两道闸：① 两次切换之间至少间隔 RESTORE_COOLDOWN_MS；
     ② 恢复代理必须连续两次探活成功（一次成功可能只是刚好赶上节点可用）。 */
  const RESTORE_COOLDOWN_MS = Number(process.env.CINEFLOW_PROXY_COOLDOWN_MS || 90000);
  let lastFlipAt = 0;
  let restoreVotes = 0;

  function restoreProxyIfAlive(ses) {
    if (!proxyState.overrode) return;
    if (Date.now() - lastFlipAt < RESTORE_COOLDOWN_MS) return;
    const configured = readConfiguredProxy();
    const target = configured && !/^(direct|system|auto_detect)$/i.test(configured)
      ? (() => {
        try {
          const parsed = new URL(configured);
          return { host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) };
        } catch {
          return null;
        }
      })()
      : null;
    const probe = target
      ? connectProbe(target.host, target.port, 'api.themoviedb.org', PROXY_HEALTH_MS)
      : ses.setProxy({ mode: 'system' })
        .then(() => ses.resolveProxy('https://api.themoviedb.org/3/configuration'))
        .then((resolved) => {
          const addr = parseProxyAddress(resolved);
          if (!addr) return false;
          return connectProbe(addr.host, addr.port, 'api.themoviedb.org', PROXY_HEALTH_MS);
        })
        .catch(() => false);
    probe.then((ok) => {
      if (!ok) {
        // 代理仍然连不通：立刻切回直连，别让 Chromium 的图片/媒体请求再吃超时
        restoreVotes = 0;
        proxyState.overrode = false;
        return forceDirect(ses).then(() => {
          proxyState.probedAt = 0;
        });
      }
      restoreVotes += 1;
      if (restoreVotes < 2) {
        debugLog('代理探活第 ' + restoreVotes + ' 次成功，等下一次确认再交回');
        return null;
      }
      restoreVotes = 0;
      lastFlipAt = Date.now();
      return reapplyConfigured(ses, configured);
    }).catch(() => {});
  }

  function reapplyConfigured(ses, configured) {
    const back = configured && !/^(direct|system|auto_detect)$/i.test(configured)
      ? (() => {
        try {
          const parsed = new URL(configured);
          const protocol = parsed.protocol.replace(':', '').toLowerCase();
          const rule = (protocol === 'socks' || protocol === 'socks4' || protocol === 'socks5')
            ? protocol + '=' + parsed.host
            : 'http=' + parsed.host + ';https=' + parsed.host;
          return { mode: 'fixed_servers', proxyRules: rule, proxyBypassRules: '<local>' };
        } catch {
          return { mode: 'system' };
        }
      })()
      : { mode: 'system' };
    return ses.setProxy(back).then(() => {
      proxyState.overrode = false;
      proxyState.probedAt = 0;
      lastFlipAt = Date.now();
      log('代理恢复可用，交回原设置');
    }).catch(() => {});
  }

  let routeDirect = null;
  let routeAt = 0;
  let routeInflight = null;

  function routeIsDirect(ses, urlStr) {
    const now = Date.now();
    if (routeDirect !== null && now - routeAt < ROUTE_TTL_MS) return Promise.resolve(routeDirect);
    if (routeInflight) return routeInflight;
    routeInflight = ses.resolveProxy(urlStr || 'https://api.themoviedb.org/3/configuration')
      .then((resolved) => {
        const text = String(resolved || '').trim();
        const raw = !text || /^\s*DIRECT/i.test(text);
        routeDirect = raw || proxyState.dead;
        routeAt = Date.now();
        return routeDirect;
      })
      .catch(() => {
        routeDirect = proxyState.dead;
        routeAt = Date.now();
        return routeDirect;
      })
      .finally(() => {
        routeInflight = null;
      });
    return routeInflight;
  }

  function wrapSetProxy(ses) {
    if (!ses || ses.__cfSetProxyWrapped) return;
    const originalSetProxy = ses.setProxy.bind(ses);
    ses.setProxy = (config) => {
      const mode = config && config.mode;
      if (mode && mode !== 'direct' && proxyState.dead) {
        proxyState.overrode = true;
        debugLog('setProxy(' + mode + ') 改写成 direct（代理连不通）');
        return Promise.resolve({ mode: 'direct' });
      }
      return originalSetProxy(config);
    };
    ses.__cfSetProxyWrapped = true;
  }

  // 这些主机在无代理环境下必须靠 DoH 真 IP 才能访问，也是"能不能进 TMDB 模式"的关键路径。
  const RESCUE_HOSTS = new Set([
    'api.themoviedb.org',
    'api.tmdb.org',
    'image.tmdb.org',
    'www.themoviedb.org'
  ]);

  /* JSON 体检：无代理时最常见的坏结局不是"连不上"，而是"连上了一个假地址"——
     返回 200 + HTML（运营商/污染页）。基线会把它当成功缓存 5 分钟，界面于是整片空白。
     这里在返回给上层之前就把它判成失败，换 IP 重试。 */
  function looksJson(buffer) {
    if (!buffer || !buffer.length) return false;
    for (let i = 0; i < Math.min(buffer.length, 64); i += 1) {
      const code = buffer[i];
      if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xef || code === 0xbb || code === 0xbf) continue;
      return code === 0x7b || code === 0x5b; // { 或 [
    }
    return false;
  }

  /* 智能选路：这家主机到底走直连还是走代理。
     ① 内存/落盘里已经有真 IP → 直接直连，零等待；
     ② 会话本来就是 DIRECT → 解析真 IP 后直连；
     ③ 会话走代理 → 分别量"代理到该主机"和"直连该主机"的成本，谁快走谁；
        代理到该主机根本不通（-1）→ 立即直连，绝不等代理超时。 */
  async function planFor(host, ses) {
    const cached = cachedIp(host);
    if (cached) return { direct: true, ip: cached, cached: true };
    const direct = await routeIsDirect(ses, 'https://' + host + '/');
    if (direct) {
      const ip = await resolveIp(host);
      if (ip) return { direct: true, ip, cached: false };
      const viaAlias = await resolveViaAlias(host, true);
      return viaAlias ? { direct: true, ip: viaAlias, cached: false, reason: 'alias' } : { direct: false };
    }
    const [ip, proxyMs] = await Promise.all([resolveIp(host), proxyConnectLatency(ses, host)]);
    if (!ip) return { direct: false };
    if (proxyMs < 0) return { direct: true, ip, cached: false, reason: 'proxy-cannot-reach-host' };
    if (proxyMs > 0) {
      const directMs = cachedLatency(host) || 0;
      if (directMs && proxyMs > directMs + 350) return { direct: true, ip, cached: false, reason: 'direct-faster' };
      /* 代理"能通但很慢"：实测 127.0.0.1:7897 → image.tmdb.org 的 CONNECT+TLS 要 3158ms，
         而同一台主机直连只要 1279ms。海报是首页最密集的请求，一次冷握手 3 秒等于
         "开代理就整体变慢"。既然已经拿到可用的真 IP，1.5 秒以上的代理握手直接让位给直连；
         正常代理（CONNECT 300ms 量级）仍然照走代理，不会被抢。 */
      if (proxyMs >= 1500 && ip) {
        proxyHostState.set(host, { at: Date.now(), latency: proxyMs });
        debugLog('代理到 ' + host + ' 需 ' + proxyMs + 'ms，改用直连');
        return { direct: true, ip, cached: false, reason: 'proxy-too-slow' };
      }
    }
    return { direct: false };
  }

  /* 安装顺序问题：meta-server / source-compat / tmdb-resilience 都会在同一 session 上
     再包一层 fetch，谁最后包谁在最外层。net-rescue 只有站在最外层才能真正接管 TMDB 请求，
     否则 meta-server 的 DoH 通道会先一步把 api.themoviedb.org 吃掉，本模块永远看不到它。
     reinstall() 就是"再包一次"，让本层重新回到最外层；已经是最外层时直接返回，不叠层。 */
  function wrapOnce(ses) {
    wrapSetProxy(ses);
    const original = ses.fetch.bind(ses);
    const patched = async (input, init) => {
      debugLog('ENTER', String(input && input.url ? input.url : input).slice(0, 70));
      let urlObj = null;
      try {
        urlObj = new URL(toUrlString(input));
      } catch {
        return original(input, init);
      }
      debugLog('see', urlObj.protocol, urlObj.hostname, urlObj.pathname);
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (!['https:', 'http:'].includes(urlObj.protocol) || !['GET', 'HEAD'].includes(method)) return original(input, init);

      const fullPath = urlObj.pathname + urlObj.search;
      const isMedia = MEDIA_URL_RE.test(fullPath);
      const headerKeys = init && init.headers ? (init.headers instanceof Map ? Array.from(init.headers.keys()) : Object.keys(init.headers)) : [];
      const hasRange = headerKeys.some((key) => /^range$/i.test(key));
      if (!isMedia && (SKIP_EXTENSION_RE.test(urlObj.pathname) || hasRange)) {
        stats.skipped += 1;
        return original(input, init);
      }

      stats.requests += 1;
      const host = urlObj.hostname;
      debugLog('hit', urlObj.protocol, host, isMedia ? 'media' : '');

      /* 直连优先（无代理也能用 TMDB + 播放器不断流的核心）：
         媒体请求一律先试真 IP 流式直连（Range / 206 原样透传，边下边播不攒内存）；
         其它请求在"已有真 IP / TMDB 关键主机"时也先试直连。
         只有确认代理比直连更快时，planFor 才会返回 direct=false 交回 Chromium 走代理。 */
      // 只对"已知真 IP / TMDB 关键主机"启用直连改道：任意视频 CDN 都做 DoH 反而会拖慢首帧。
      const needPlan = Boolean(cachedIp(host)) || RESCUE_HOSTS.has(host);
      if (needPlan) {
        const wantsJson = RESCUE_HOSTS.has(host) && urlObj.pathname.startsWith('/3/');
        const requestInit = wantsJson ? Object.assign({}, init, { __cfExpectJson: true }) : init;
        // 假 200（污染页 HTML）在无代理环境里很常见：换 IP 重试，绝不把垃圾交给上层缓存。
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const plan = await planFor(host, ses).catch(() => null);
          if (!plan || !plan.direct || !plan.ip || isBad(plan.ip)) break;
          stats.fastPath += 1;
          try {
            if (isMedia) {
              const streamed = await streamHost(host, plan.ip, urlObj, requestInit, 4);
              stats.rescued += 1;
              return streamed;
            }
            const result = await requestHost(host, plan.ip, urlObj, requestInit, 4);
            stats.rescued += 1;
            return buildResponse(result);
          } catch (error) {
            markBad(plan.ip);
            goodIp.delete(host);
            stats.fellBack += 1;
            debugLog('retry', host, plan.ip, String((error && error.message) || error).slice(0, 60));
          }
        }
      }

      // 媒体没拿到直连方案：交回 Chromium（走用户配置的代理或系统解析）
      if (isMedia) {
        stats.skipped += 1;
        return original(input, init);
      }

      return routeIsDirect(ses, urlObj.toString()).then((direct) => {
        if (!direct) {
          stats.skipped += 1;
          return original(input, init);
        }
        const sticky = cachedIp(host);
        if (sticky && !isBad(sticky)) {
          // 已知真 IP：直发，省掉 Chromium 的 DNS 等待
          stats.fastPath += 1;
          return requestHost(host, sticky, urlObj, init, 4)
            .then((result) => {
              stats.rescued += 1;
              return buildResponse(result);
            })
            .catch(() => {
              goodIp.delete(host);
              stats.fellBack += 1;
              return original(input, init);
            });
        }
        // 正常路径：只让 Chromium 跑，不再双发对冲（避免把网络和主线程压力翻倍）；
        // 只有在它真的失败之后才轮到 DoH 直连兜底。
        return original(input, init).catch((error) => {
          stats.fellBack += 1;
          return viaIp(urlObj, init)
            .then((hit) => {
              if (hit && hit.result) {
                stats.rescued += 1;
                return buildResponse(hit.result);
              }
              throw error;
            })
            .catch(() => {
              throw error;
            });
        });
      });
    };
    patched.__cfNetRescueLayer = true;
    ses.__cfNetRescueFetch = patched;
    ses.fetch = patched;
    ses.__cfNetRescuePatch = { installedAt: Date.now(), version: '4.0.0' };
    return ses;
  }

  function install(ses, force) {
    if (!ses) return ses;
    if (process.env.CINEFLOW_NET_RESCUE === '0') {
      if (!force) log('直连兜底已按环境变量关闭');
      return ses;
    }
    const current = ses.fetch;
    if (current && current.__cfNetRescueLayer) return ses;
    if (ses.__cfNetRescuePatch && !force) return ses;
    const out = wrapOnce(ses);
    try {
      kickProxyProbe(ses);
      scheduleEarlyDirect(ses);
      if (!ses.__cfNetRescueTimer) {
        ses.__cfNetRescueTimer = setInterval(() => restoreProxyIfAlive(ses), PROXY_REPROBE_INTERVAL_MS);
        if (typeof ses.__cfNetRescueTimer.unref === 'function') ses.__cfNetRescueTimer.unref();
      }
    } catch { /* ignore */ }
    if (!force || !ses.__cfNetRescueLogged) {
      ses.__cfNetRescueLogged = true;
      log('直连兜底已接管 session.fetch');
    }
    return out;
  }

  function snapshot() {
    const hosts = {};
    for (const [host, entry] of goodIp) hosts[host] = entry.ip;
    return { ...stats, hosts, bad: badIp.size };
  }

  function reinstall(ses) { return install(ses, true); }

  return { install, reinstall, resolveIp, prefetchIps, warmUp, flushCache, snapshot, proxyState, _internals: { dohQuery, tlsProbe, tcpProbe, requestHost, streamHost, planFor, parseProxyAddress } };
}

module.exports = { createNetRescue, _internals: { dohQuery, tlsProbe, tcpProbe } };

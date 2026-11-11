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
const PROXY_PROBE_MS = Number(process.env.CINEFLOW_PROXY_PROBE_MS || 600);
const PROXY_DEAD_TTL_MS = 60 * 1000;
const PROXY_ALIVE_TTL_MS = 60 * 1000;
const PROXY_REPROBE_INTERVAL_MS = 60 * 1000;
const MAP_MAX_TLS_MS = Number(process.env.CINEFLOW_MAP_MAX_TLS_MS || 400);

const SKIP_EXTENSION_RE = /\.(ts|m4s|mp4|m4a|aac|flv|webm|mkv|mp3|wav|vtt|jpg|jpeg|png|webp|gif)(?:$|[?#])/i;

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
      headers: { accept: 'application/dns-json', 'user-agent': 'CineFlow-DoH/3.4.9' },
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

  function pickFastest(host, ips, secure) {
    return new Promise((resolve) => {
      const usable = ips.filter((ip) => !isBad(ip));
      if (!usable.length) {
        resolve('');
        return;
      }
      let settled = false;
      let pending = usable.length;
      for (const ip of usable) {
        stats.probes += 1;
        const probe = secure ? tlsProbe(ip, host, PROBE_TIMEOUT_MS) : tcpProbe(ip, 80, PROBE_TIMEOUT_MS);
        probe.then((latency) => {
          if (settled) return;
          if (latency >= 0) {
            settled = true;
            resolve(ip);
            return;
          }
          markBad(ip);
          pending -= 1;
          if (pending === 0) {
            settled = true;
            resolve('');
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
      if (!ips.length) return '';
      searchedHosts.add(host);
      const best = await pickFastest(host, ips, secure);
      if (!best) return '';
      goodIp.set(host, { ip: best, expiresAt: Date.now() + IP_TTL_MS });
      return best;
    })().finally(() => resolving.delete(key));
    resolving.set(key, task);
    return task;
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
      if (!headers['user-agent'] && !headers['User-Agent']) headers['user-agent'] = 'CineFlow/3.4.9';
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
          resolve({
            status,
            headers: res.headers,
            buffer: decodeBody(raw, res.headers['content-encoding'])
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      if (body !== null) req.write(body);
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
        return connectProbe(addr.host, addr.port, 'api.themoviedb.org', PROXY_PROBE_MS)
          .then((ok) => {
            proxyState.probedAt = Date.now();
            proxyState.dead = !ok;
            proxyState.address = addr;
            debugLog('probe connect', addr.host + ':' + addr.port, ok);
            if (!ok) log('代理 ' + addr.host + ':' + addr.port + ' 连不通 TMDB，改走直连兜底');
            return ok;
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

  // 请求路径只读快照；探活放到后台，绝不阻塞任何一次 fetch
  function kickProxyProbe(ses) {
    const now = Date.now();
    if (proxyState.inflight) return;
    if (proxyState.probedAt && now - proxyState.probedAt < PROXY_REPROBE_INTERVAL_MS) return;
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
        log('已临时切到直连（代理不在线）');
      })
      .catch(() => {
        proxyState.switching = false;
      });
  }

  function restoreProxyIfAlive(ses) {
    if (!proxyState.overrode) return;
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
      ? connectProbe(target.host, target.port, 'api.themoviedb.org', PROXY_PROBE_MS + 900)
      : ses.setProxy({ mode: 'system' })
        .then(() => ses.resolveProxy('https://api.themoviedb.org/3/configuration'))
        .then((resolved) => {
          const addr = parseProxyAddress(resolved);
          if (!addr) return false;
          return connectProbe(addr.host, addr.port, 'api.themoviedb.org', PROXY_PROBE_MS + 900);
        })
        .catch(() => false);
    probe.then((ok) => {
      if (!ok) {
        // 代理仍然连不通：立刻切回直连，别让 Chromium 的图片/媒体请求再吃超时
        proxyState.overrode = false;
        return forceDirect(ses).then(() => {
          proxyState.probedAt = 0;
        });
      }
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

  function install(ses) {
    if (!ses || ses.__cfNetRescuePatch) return ses;
    if (process.env.CINEFLOW_NET_RESCUE === '0') {
      log('直连兜底已按环境变量关闭');
      return ses;
    }
    wrapSetProxy(ses);
    const original = ses.fetch.bind(ses);
    const patched = (input, init) => {
      let urlObj = null;
      try {
        urlObj = new URL(toUrlString(input));
      } catch {
        return original(input, init);
      }
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (!['https:', 'http:'].includes(urlObj.protocol) || !['GET', 'HEAD'].includes(method)) return original(input, init);
      if (SKIP_EXTENSION_RE.test(urlObj.pathname)) {
        stats.skipped += 1;
        return original(input, init);
      }
      const headerKeys = init && init.headers ? (init.headers instanceof Map ? Array.from(init.headers.keys()) : Object.keys(init.headers)) : [];
      if (headerKeys.some((key) => /^range$/i.test(key))) {
        stats.skipped += 1;
        return original(input, init);
      }

      stats.requests += 1;
      const host = urlObj.hostname;
      debugLog('hit', urlObj.protocol, host);
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
    ses.fetch = patched;
    ses.__cfNetRescuePatch = { installedAt: Date.now(), version: '3.4.9' };
    try {
      kickProxyProbe(ses);
      const timer = setInterval(() => restoreProxyIfAlive(ses), PROXY_REPROBE_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    } catch { /* ignore */ }
    log('直连兜底已接管 session.fetch');
    return ses;
  }

  function snapshot() {
    const hosts = {};
    for (const [host, entry] of goodIp) hosts[host] = entry.ip;
    return { ...stats, hosts, bad: badIp.size };
  }

  return { install, resolveIp, prefetchIps, snapshot, proxyState, _internals: { dohQuery, tlsProbe, tcpProbe, requestHost, parseProxyAddress } };
}

module.exports = { createNetRescue, _internals: { dohQuery, tlsProbe, tcpProbe } };

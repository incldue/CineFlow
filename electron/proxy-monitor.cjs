'use strict';

const net = require('node:net');

const PROBE_INTERVAL_MS = Number(process.env.CINEFLOW_PROXY_PROBE_INTERVAL_MS || 250);
const PROBE_CONNECT_TIMEOUT_MS = Number(process.env.CINEFLOW_PROXY_PROBE_TIMEOUT_MS || 180);
const DOWN_AFTER_FAILURES = 2;
const UP_AFTER_SUCCESSES = 3;
const DIRECT_UPSTREAM_TIMEOUT_MS = Number(process.env.CINEFLOW_PLAYBACK_DIRECT_TIMEOUT_MS || 8000);

const PLAYBACK_PROXY_MODES = {
  follow: {
    label: '跟随全局代理（推荐）',
    description: '配置了代理则播放走代理；代理断开时毫秒级自动切换为直连上行，播放不中断。'
  },
  proxy: {
    label: '播放走代理',
    description: '播放流量始终通过系统代理上行转发。'
  },
  direct: {
    label: '播放不走代理（DoH 直连）',
    description: '播放流量绕过代理，经 DoH 解析后由本机直连片源。'
  }
};

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PLAYBACK_PROXY_MODES[mode] ? mode : 'follow';
}

function parseProxyTarget(rawProxy) {
  const value = String(rawProxy || '').trim();
  const match = value.match(/^(?:https?|socks[45]?):\/\/(?:[^@/]*@)?([^\s:/?#]+):(\d{1,5})/i);
  if (!match) return null;
  return { host: match[1], port: Number(match[2]) };
}

function createPlaybackProxyGuard(deps) {
  const {
    session,
    doh,
    getProxySetting,
    readSettings,
    writeSettings,
    mediaHelpers,
    sendToRenderer
  } = deps;

  let link = 'none';
  let lastRttMs = 0;
  let lastProbeAt = 0;
  let failureStreak = 0;
  let successStreak = 0;
  let probing = false;
  let timer = null;
  let lastProbedProxyRaw = '';

  function getMode() {
    try {
      return normalizeMode(readSettings().playbackProxyMode);
    } catch {
      return 'follow';
    }
  }

  function setMode(rawMode) {
    const mode = normalizeMode(rawMode);
    try {
      const settings = readSettings();
      settings.playbackProxyMode = mode;
      writeSettings(settings);
    } catch {
      // keep runtime value even if persistence failed
    }
    resetStreaks();
    announce();
    return getStatus();
  }

  function resetStreaks() {
    failureStreak = 0;
    successStreak = 0;
  }

  function shouldUseDirectUpstream() {
    const mode = getMode();
    if (mode === 'direct') return true;
    if (mode === 'proxy') return false;
    return link === 'down';
  }

  function probeOnce(target) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const socket = net.connect({ host: target.host, port: target.port });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok ? Date.now() - startedAt : -1);
      };
      socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS, () => finish(false));
      socket.on('connect', () => finish(true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
    });
  }

  async function tick() {
    if (probing) return;
    probing = true;
    try {
      const raw = typeof getProxySetting === 'function' ? getProxySetting() : '';
      if (raw !== lastProbedProxyRaw) {
        lastProbedProxyRaw = raw;
        resetStreaks();
      }
      const target = parseProxyTarget(raw);
      if (!target) {
        if (link !== 'none') {
          link = 'none';
          announce();
        }
        return;
      }
      const rtt = await probeOnce(target);
      lastProbeAt = Date.now();
      if (rtt >= 0) {
        lastRttMs = rtt;
        failureStreak = 0;
        successStreak += 1;
        if (link === 'down') {
          if (successStreak >= UP_AFTER_SUCCESSES) {
            link = 'up';
            announce();
          }
        } else if (link !== 'up') {
          link = 'up';
          announce();
        }
      } else {
        successStreak = 0;
        failureStreak += 1;
        if (link !== 'down' && failureStreak >= DOWN_AFTER_FAILURES) {
          link = 'down';
          announce();
          dropHangingProxyConnections();
        }
      }
    } finally {
      probing = false;
    }
  }

  function dropHangingProxyConnections() {
    try {
      const pending = session.defaultSession.closeAllConnections();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // best-effort
    }
  }

  function announce() {
    if (typeof sendToRenderer === 'function') sendToRenderer('playback:proxy-state', { ...getStatus(), state: link });
  }

  function getStatus() {
    return {
      mode: getMode(),
      modes: Object.entries(PLAYBACK_PROXY_MODES).map(([value, meta]) => ({
        value,
        label: meta.label,
        description: meta.description
      })),
      link,
      lastRttMs,
      lastProbeAt,
      probeIntervalMs: PROBE_INTERVAL_MS,
      proxyConfigured: Boolean(parseProxyTarget(typeof getProxySetting === 'function' ? getProxySetting() : ''))
    };
  }

  async function handleDirectUpstream(req, res, targetUrl) {
    const {
      isLikelyM3u8Response,
      isLikelyMpdResponse,
      rewriteM3u8Manifest,
      rewriteMpdManifest,
      mediaProxyHeaders
    } = mediaHelpers;

    const headers = {
      accept: req.headers.accept || '*/*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/3.2.0',
      referer: `${targetUrl.origin}/`
    };
    if (req.headers.range) headers.range = req.headers.range;

    let upstream;
    try {
      upstream = await doh.fetchUrl(targetUrl.toString(), {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        timeoutMs: DIRECT_UPSTREAM_TIMEOUT_MS
      });
    } catch {
      return false;
    }

    try {
      const finalUrl = new URL(upstream.url || targetUrl.toString());
      if (req.method !== 'HEAD' && isLikelyM3u8Response(upstream, finalUrl)) {
        const manifest = rewriteM3u8Manifest(await upstream.text(), upstream.url || targetUrl.toString());
        const body = Buffer.from(manifest, 'utf8');
        res.writeHead(upstream.status, mediaProxyHeaders(upstream, {
          'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'content-length': String(body.length)
        }));
        res.end(body);
        return true;
      }
      if (req.method !== 'HEAD' && isLikelyMpdResponse(upstream, finalUrl)) {
        const manifest = rewriteMpdManifest(await upstream.text(), upstream.url || targetUrl.toString());
        const body = Buffer.from(manifest, 'utf8');
        res.writeHead(upstream.status, mediaProxyHeaders(upstream, {
          'content-type': 'application/dash+xml; charset=utf-8',
          'content-length': String(body.length)
        }));
        res.end(body);
        return true;
      }
      res.writeHead(upstream.status, mediaProxyHeaders(upstream));
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      const stream = upstream.nodeStream;
      stream.on('error', () => {
        if (!res.destroyed) res.destroy();
      });
      req.on('close', () => stream.destroy());
      stream.pipe(res);
      return true;
    } catch {
      if (!res.headersSent) return false;
      if (!res.destroyed) res.destroy();
      return true;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, PROBE_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, setMode, getMode, getStatus, shouldUseDirectUpstream, handleDirectUpstream };
}

module.exports = { createPlaybackProxyGuard };

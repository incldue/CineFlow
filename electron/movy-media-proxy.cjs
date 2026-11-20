'use strict';
// Movy 播放流本地代理：主进程起一个只监听 127.0.0.1 的 HTTP 服务，
// 由它带上 Referer/Origin 去取 m3u8 与分片，再回给渲染层（附 CORS 头）。
// 这样播放完全不依赖 webRequest 的全局注册位，也不会被后续模块抢走。

const http = require('node:http');
const { URL } = require('node:url');

const REFERER = 'https://www.movy.sx/';
const ORIGIN = 'https://www.movy.sx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PLAYLIST_TTL_MS = 2500;
const SEGMENT_CACHE_BYTES = 24 * 1024 * 1024;

function createMovyMediaProxy({ log = () => {} } = {}) {
  let server = null;
  let port = 0;
  const playlists = new Map();
  const segments = new Map();
  let segmentBytes = 0;

  function directSession() {
    try {
      const { session } = require('electron');
      if (!session || typeof session.fromPartition !== 'function') return null;
      const ses = session.fromPartition('persist:movy-direct', { cache: true });
      try { ses.setProxy({ mode: 'direct' }).catch(() => {}); } catch { /* ignore */ }
      return ses;
    } catch { return null; }
  }

  function sessionsForFetch() {
    const list = [];
    const direct = directSession();
    if (direct && typeof direct.fetch === 'function') list.push(direct);
    try {
      const electron = require('electron');
      const def = electron && electron.session && electron.session.defaultSession;
      if (def && typeof def.fetch === 'function' && def !== direct) list.push(def);
    } catch { /* ignore */ }
    return list;
  }

  async function fetchUpstream(target, range) {
    const headers = {
      'user-agent': UA,
      referer: REFERER,
      origin: ORIGIN,
      accept: '*/*',
    };
    if (range) headers.range = range;
    const list = sessionsForFetch();
    if (!list.length) throw new Error('no-fetch');
    let lastError = null;
    let lastResponse = null;
    for (const ses of list) {
      try {
        const response = await ses.fetch.call(ses, target, { method: 'GET', headers, redirect: 'follow' });
        if (response && (response.ok || response.status === 206)) return response;
        lastResponse = response;
      } catch (error) { lastError = error; }
    }
    if (lastResponse) return lastResponse;
    throw lastError || new Error('upstream-failed');
  }

  function enc(url) { return Buffer.from(String(url), 'utf8').toString('base64url'); }
  function dec(value) { try { return Buffer.from(String(value), 'base64url').toString('utf8'); } catch { return ''; } }

  function resolveUrl(ref, base) {
    try { return new URL(ref, base).toString(); } catch { return ''; }
  }

  function rewritePlaylist(text, base, prefix) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { out.push(line); continue; }
      if (trimmed.startsWith('#')) {
        out.push(line.replace(/URI="([^"]+)"/g, (whole, ref) => {
          const abs = resolveUrl(ref, base);
          if (!abs) return whole;
          return 'URI="' + prefix + enc(abs) + '"';
        }));
        continue;
      }
      const abs = resolveUrl(trimmed, base);
      out.push(abs ? prefix + enc(abs) : line);
    }
    return out.join('\n');
  }

  function corsHeaders(extra = {}) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,HEAD,OPTIONS',
      'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
      'cache-control': 'no-store',
      ...extra,
    };
  }

  function rememberSegment(key, buffer) {
    if (buffer.length > SEGMENT_CACHE_BYTES / 3) return;
    while (segmentBytes + buffer.length > SEGMENT_CACHE_BYTES && segments.size) {
      const oldest = segments.keys().next().value;
      const hit = segments.get(oldest);
      segments.delete(oldest);
      segmentBytes -= hit ? hit.length : 0;
    }
    segments.set(key, buffer);
    segmentBytes += buffer.length;
  }

  function prefix() { return 'http://127.0.0.1:' + port + '/p?u='; }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }
    const parsed = new URL(req.url, 'http://127.0.0.1');
    if (parsed.pathname !== '/p') { res.writeHead(404, corsHeaders()); res.end('not found'); return; }
    const target = dec(parsed.searchParams.get('u') || '');
    if (!/^https?:\/\//i.test(target)) { res.writeHead(400, corsHeaders()); res.end('bad target'); return; }

    const wantsPlaylist = /\.m3u8?(\?|$)/i.test(target);
    const cachedPlaylist = wantsPlaylist ? playlists.get(target) : null;
    if (cachedPlaylist && Date.now() - cachedPlaylist.at < PLAYLIST_TTL_MS) {
      const body = Buffer.from(rewritePlaylist(cachedPlaylist.text, target, prefix()), 'utf8');
      res.writeHead(200, corsHeaders({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length }));
      res.end(body);
      return;
    }
    const cachedSegment = wantsPlaylist ? null : segments.get(target);
    if (cachedSegment) {
      res.writeHead(200, corsHeaders({ 'content-type': 'video/mp2t', 'content-length': cachedSegment.length }));
      res.end(cachedSegment);
      return;
    }

    try {
      const response = await fetchUpstream(target, req.headers.range || '');
      if (!response.ok) {
        log('movy 代理上游 ' + response.status + ' · ' + target.slice(0, 90));
        res.writeHead(response.status, corsHeaders({ 'content-type': 'text/plain' }));
        res.end('upstream ' + response.status);
        return;
      }
      const type = String(response.headers.get('content-type') || '');
      const isPlaylist = /mpegurl/i.test(type) || wantsPlaylist;
      if (isPlaylist) {
        const text = await response.text();
        playlists.set(target, { at: Date.now(), text });
        if (playlists.size > 40) playlists.delete(playlists.keys().next().value);
        const body = Buffer.from(rewritePlaylist(text, target, prefix()), 'utf8');
        res.writeHead(200, corsHeaders({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length }));
        res.end(body);
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length && buffer.length < SEGMENT_CACHE_BYTES / 3) rememberSegment(target, buffer);
      const status = response.status === 206 ? 206 : 200;
      const headers = corsHeaders({ 'content-type': type || 'application/octet-stream', 'content-length': buffer.length, 'accept-ranges': 'bytes' });
      const contentRange = response.headers.get('content-range');
      if (contentRange) headers['content-range'] = contentRange;
      res.writeHead(status, headers);
      res.end(buffer);
    } catch (error) {
      log('movy 代理失败 · ' + String((error && error.message) || error));
      res.writeHead(502, corsHeaders({ 'content-type': 'text/plain' }));
      res.end('proxy failed');
    }
  }

  function start() {
    if (server) return Promise.resolve(port);
    return new Promise((resolve) => {
      try {
        server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } }); });
        server.on('error', (error) => { log('movy 代理启动失败 · ' + (error && error.message)); server = null; resolve(0); });
        server.listen(0, '127.0.0.1', () => {
          try { if (typeof server.unref === 'function') server.unref(); } catch { /* ignore */ }
          port = server.address().port;
          log('movy 代理就绪 127.0.0.1:' + port);
          resolve(port);
        });
      } catch (error) {
        log('movy 代理异常 · ' + (error && error.message));
        server = null;
        resolve(0);
      }
    });
  }

  function proxyUrl(url) {
    const text = String(url || '');
    if (!port || !/^https?:\/\//i.test(text)) return '';
    return prefix() + enc(text);
  }

  function stats() { return { port, playlists: playlists.size, segments: segments.size, bytes: segmentBytes }; }

  return { start, proxyUrl, stats, _handle: handle };
}

module.exports = { createMovyMediaProxy };

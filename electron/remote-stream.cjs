'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range,content-type',
  'access-control-expose-headers': 'content-length,content-range,accept-ranges'
};

function b64urlDecode(value) {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
  } catch { return ''; }
}

function b64urlEncode(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function createRemoteStream({ log = () => {}, resolveTarget, fetchUpstream } = {}) {
  let server = null;
  let port = 0;

  function respond(res, status, body, extra) {
    try {
      res.writeHead(status, { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(extra || {}) });
      res.end(body || '');
    } catch {  }
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }
    let parsed;
    try {
      parsed = new URL(req.url, 'http://127.0.0.1');
    } catch { respond(res, 400, 'bad request'); return; }
    const match = parsed.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,40})\/(.+)$/);
    if (!match) { respond(res, 404, 'not found'); return; }
    const libId = match[1];
    const remotePath = b64urlDecode(parsed.searchParams.get('p'));
    const name = decodeURIComponent(match[2]);
    if (!remotePath) { respond(res, 400, 'missing path'); return; }

    let target;
    try {
      target = await resolveTarget(libId, remotePath, name);
    } catch (error) {
      log('远端转接解析失败 · ' + String((error && error.message) || error));
      respond(res, 502, 'resolve failed');
      return;
    }
    if (!target || !target.url) { respond(res, 404, 'not available'); return; }

    if (/\.m3u8(?:$|[?#])/i.test(target.url)) {
      respond(res, 302, '', { location: target.url });
      return;
    }

    let upstream;
    try {
      upstream = await fetchUpstream(target.url, req.headers, target.headers);
    } catch (error) {
      respond(res, 502, 'upstream failed');
      return;
    }
    const status = upstream.status === 206 ? 206 : (upstream.ok ? 200 : upstream.status);
    const headers = {
      ...CORS,
      'cache-control': 'no-store',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes'
    };
    const type = upstream.headers.get('content-type');
    if (type) headers['content-type'] = type;
    const length = upstream.headers.get('content-length');
    if (length) headers['content-length'] = length;
    const range = upstream.headers.get('content-range');
    if (range) headers['content-range'] = range;
    try {
      res.writeHead(status, headers);
      if (!upstream.body) { res.end(); return; }
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', () => { try { res.destroy(); } catch {  } });
      res.on('close', () => { try { nodeStream.destroy(); } catch {  } });
      nodeStream.pipe(res);
    } catch { try { res.destroy(); } catch {  } }
  }

  function start() {
    if (server) return Promise.resolve(port);
    return new Promise((resolve) => {
      try {
        server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch {  } }); });
        server.on('error', (error) => {
          log('远端转接启动失败 · ' + (error && error.message));
          server = null;
          resolve(0);
        });
        server.listen(0, '127.0.0.1', () => {
          try { if (typeof server.unref === 'function') server.unref(); } catch {  }
          port = server.address().port;
          resolve(port);
        });
      } catch (error) {
        log('远端转接异常 · ' + (error && error.message));
        server = null;
        resolve(0);
      }
    });
  }

  function urlFor(libId, remotePath, name) {
    if (!port) return '';
    const safeName = String(name || 'file.mp4').replace(/[\\?#]/g, '_');
    return 'http://127.0.0.1:' + port + '/r/' + encodeURIComponent(libId) + '/' + encodeURIComponent(safeName) + '?p=' + b64urlEncode(remotePath);
  }

  function stats() { return { port }; }

  return { start, urlFor, stats, _handle: handle };
}

module.exports = { createRemoteStream, b64urlEncode, b64urlDecode };

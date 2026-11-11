'use strict';
/**
 * CineFlow Smart DoH 中继（新增文件，零触碰基线）。
 *
 * 背景（2026-10 实测）：
 *   - 3.4.4 基线 doh.cjs 是「单上游 JSON-DoH 客户端」，默认上游 arkdo.ddd.oaifree.com
 *     在无代理网络下不可达或返回污染答案 → 端点熔断 → meta-server 放弃接管 →
 *     api.themoviedb.org 走系统 DNS（污染）→ 渲染层软超时 → 会话永久跌落豆瓣兜底。
 *   - edge-smart-doh（https://github.com/1molchuan/edge-smart-doh，公开实例
 *     edge.1molchuan.top）：部署在 Cloudflare Workers 的 RFC8484 DoH，
 *     对 Cloudflare 托管域返回「按运营商实测的优选边缘 IP」，其余域原样返回
 *     （上游为境外干净递归）→ 对 TMDB 域给出的是无污染真实解析；
 *     实测无代理直连可达（200-290ms），api.themoviedb.org → CloudFront 108.138.246.x
 *     直连 TLS+SNI 成功拿到 TMDB 业务响应。但它只说 wireformat，不说 JSON。
 *
 * 方案：本文件在 127.0.0.1 起一个极小的 JSON-DoH 端点，doh.cjs（逐字节保持 3.4.4 原版，
 * 其 env CINEFLOW_DOH_ENDPOINT 在模块加载时读取）由 bootstrap 在 require('./main.cjs')
 * 之前指向这里。上游链（带健康轮换）：
 *   1. 用户自配（userData/doh-upstream.txt 单行 URL，协议自动探测）——可指向自部署实例
 *   2. edge-smart-doh 公开实例（wireformat，干净递归 + CF 优选改写）
 *   3. 阿里 DNS（dns.alidns.com/resolve，JSON；国内秒回，非封锁域干净）
 *   4. arkdo（3.4.4 原默认，JSON）
 * 任何一层成功即返回；连续 3 次失败熔断 20s。中继启动失败 → 不设 env →
 * 基线行为与 3.4.4 完全一致（默认 arkdo）。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const EDGE_SMART_DOH_URL = 'https://edge.1molchuan.top/dns-query';
const UPSTREAM_TIMEOUT_MS = 2500;
const UPSTREAM_FAIL_LIMIT = 3;
const UPSTREAM_BREAK_MS = 20000;
const CACHE_MIN_TTL_MS = 10000;
const CACHE_MAX_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const START_BUDGET_MS = 1500;

const KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 16,
  timeout: 30000
});

/* ============ DNS wireformat（RFC8484 查询构造 / 应答解析，A/AAAA） ============ */

function buildDnsQuery(name, type) {
  const labels = String(name || '').replace(/\.$/, '').split('.');
  const bodyLen = labels.reduce((sum, label) => sum + 1 + Buffer.byteLength(label), 0) + 1 + 4;
  const buf = Buffer.alloc(12 + bodyLen);
  buf.writeUInt16BE(0x1cf0, 0);
  buf.writeUInt16BE(0x0100, 2); // RD=1
  buf.writeUInt16BE(1, 4);       // QDCOUNT=1
  let off = 12;
  for (const label of labels) {
    const len = Buffer.byteLength(label);
    buf.writeUInt8(len, off++);
    buf.write(label, off);
    off += len;
  }
  buf.writeUInt8(0, off++);
  buf.writeUInt16BE(type, off); off += 2;
  buf.writeUInt16BE(1, off);    // IN
  return buf;
}

function skipDnsName(buf, off) {
  while (off < buf.length) {
    const len = buf.readUInt8(off);
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  return off;
}

function parseDnsMessage(buf) {
  if (!buf || buf.length < 12) return null;
  const rcode = buf.readUInt16BE(2) & 0x0f;
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < qdcount && off < buf.length; i += 1) {
    off = skipDnsName(buf, off);
    off += 4;
  }
  const answers = [];
  for (let i = 0; i < ancount && off < buf.length; i += 1) {
    off = skipDnsName(buf, off);
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off); off += 2;
    off += 2; // class
    const ttl = buf.readUInt32BE(off); off += 4;
    const rdlen = buf.readUInt16BE(off); off += 2;
    if (off + rdlen > buf.length) break;
    const rd = buf.subarray(off, off + rdlen); off += rdlen;
    if (type === 1 && rdlen === 4) {
      answers.push({ name: '', type: 1, TTL: ttl, data: Array.from(rd).join('.') });
    } else if (type === 28 && rdlen === 16) {
      const seg = [];
      for (let s = 0; s < 16; s += 2) seg.push(rd.readUInt16BE(s).toString(16));
      answers.push({ name: '', type: 28, TTL: ttl, data: seg.join(':') });
    } else if (type === 5) {
      answers.push({ name: '', type: 5, TTL: ttl, data: '' });
    }
  }
  return { rcode, answers };
}

/* ============ 上游 ============ */

function createUpstream({ url, mode, label }) {
  return {
    url: String(url || '').replace(/\/+$/, ''),
    mode,                         // 'json' | 'wire' | 'auto'
    resolvedMode: mode === 'auto' ? null : mode,
    label: label || String(url),
    ok: 0,
    fail: 0,
    consecutiveFails: 0,
    breakUntil: 0
  };
}

function defaultUpstreams() {
  return [
    createUpstream({ url: EDGE_SMART_DOH_URL, mode: 'wire', label: 'edge-smart-doh' }),
    createUpstream({ url: 'https://dns.alidns.com/resolve', mode: 'json', label: 'alidns' }),
    createUpstream({ url: 'https://arkdo.ddd.oaifree.com/query-dns', mode: 'json', label: 'arkdo(3.4.4默认)' })
  ];
}

function upstreamGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.get(target.toString(), {
      agent: target.protocol === 'http:' ? undefined : KEEP_ALIVE_AGENT,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > 65536) req.destroy(new Error('upstream response too large'));
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  });
}

async function queryUpstreamJson(upstream, name, typeLabel) {
  const url = new URL(upstream.url);
  url.searchParams.set('name', name);
  url.searchParams.set('type', typeLabel);
  const res = await upstreamGet(url.toString(), { accept: 'application/dns-json', 'user-agent': 'CineFlow-SmartDoH/3.4.8' }, UPSTREAM_TIMEOUT_MS);
  if (res.status !== 200) throw new Error(`upstream http ${res.status}`);
  const payload = JSON.parse(res.body.toString('utf8'));
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.Answer)) throw new Error('upstream json shape');
  const answers = payload.Answer
    .filter((item) => item && Number.isFinite(Number(item.type)) && item.data != null)
    .map((item) => ({ name: String(item.name || ''), type: Number(item.type), TTL: Math.max(30, Number(item.TTL) || 300), data: String(item.data) }));
  return { rcode: Number(payload.Status) || 0, answers };
}

async function queryUpstreamWire(upstream, name, type) {
  const url = new URL(upstream.url);
  url.searchParams.set('dns', buildDnsQuery(name, type).toString('base64url'));
  const res = await upstreamGet(url.toString(), { accept: 'application/dns-message', 'user-agent': 'CineFlow-SmartDoH/3.4.8' }, UPSTREAM_TIMEOUT_MS);
  if (res.status !== 200) throw new Error(`upstream http ${res.status}`);
  const parsed = parseDnsMessage(res.body);
  if (!parsed) throw new Error('upstream wire shape');
  return parsed;
}

async function queryUpstream(upstream, name, type, typeLabel) {
  if (upstream.resolvedMode === 'wire') return queryUpstreamWire(upstream, name, type);
  if (upstream.resolvedMode === 'json') return queryUpstreamJson(upstream, name, typeLabel);
  // auto：先 JSON 后 wireformat，命中即记住
  try {
    const result = await queryUpstreamJson(upstream, name, typeLabel);
    upstream.resolvedMode = 'json';
    return result;
  } catch {
    const result = await queryUpstreamWire(upstream, name, type);
    upstream.resolvedMode = 'wire';
    return result;
  }
}

/* ============ 中继 ============ */

function startSmartDoh(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const app = options.app || null;

  const upstreams = [];
  // 用户自配上游优先（协议自动探测），可指向自部署的 edge-smart-doh 实例
  if (app && typeof app.getPath === 'function') {
    try {
      const file = path.join(app.getPath('userData'), 'doh-upstream.txt');
      if (fs.existsSync(file)) {
        const custom = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))[0];
        if (custom && /^https?:\/\//i.test(custom)) {
          upstreams.push(createUpstream({ url: custom, mode: 'auto', label: '用户自配' }));
          log(`用户自配 DoH 上游: ${custom}`);
        }
      }
    } catch { /* best-effort */ }
  }
  if (Array.isArray(options.upstreams) && options.upstreams.length) {
    upstreams.push(...options.upstreams);
  } else {
    upstreams.push(...defaultUpstreams());
  }

  const cache = new Map();
  let queries = 0;
  let served = 0;
  const bootAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !req.url) {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        uptimeMs: Date.now() - bootAt,
        queries,
        served,
        upstreams: upstreams.map((u) => ({ label: u.label, url: u.url, mode: u.resolvedMode || u.mode, ok: u.ok, fail: u.fail, brokenUntil: u.breakUntil > Date.now() ? u.breakUntil - Date.now() : 0 }))
      }));
      return;
    }
    const name = String(url.searchParams.get('name') || '').trim();
    const typeParam = String(url.searchParams.get('type') || 'A').toUpperCase();
    if (!name || !/^[a-z0-9._*-]+$/i.test(name)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Status: 1, Answer: [] }));
      return;
    }
    const family = typeParam === 'AAAA' ? 6 : 4;
    const type = family === 6 ? 28 : 1;
    const typeLabel = family === 6 ? 'AAAA' : 'A';
    queries += 1;

    const cacheKey = `${name.toLowerCase()}|${typeLabel}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      served += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Status: 0, Answer: hit.answers }));
      return;
    }

    (async () => {
      let firstError = null;
      for (const upstream of upstreams) {
        if (upstream.breakUntil > Date.now()) continue;
        try {
          const result = await queryUpstream(upstream, name, type, typeLabel);
          upstream.ok += 1;
          upstream.consecutiveFails = 0;
          const minTtl = result.answers.length
            ? Math.min(...result.answers.map((a) => a.TTL || 300))
            : 30;
          const ttlMs = Math.min(Math.max(minTtl * 1000, CACHE_MIN_TTL_MS), CACHE_MAX_TTL_MS);
          if (result.rcode === 0 && result.answers.length) {
            if (cache.size >= CACHE_MAX_ENTRIES) {
              const oldest = cache.keys().next().value;
              cache.delete(oldest);
            }
            cache.set(cacheKey, { answers: result.answers, expiresAt: Date.now() + ttlMs });
          }
          served += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Status: result.rcode, Answer: result.answers }));
          return;
        } catch (error) {
          if (firstError === null) firstError = error;
          upstream.fail += 1;
          upstream.consecutiveFails += 1;
          if (upstream.consecutiveFails >= UPSTREAM_FAIL_LIMIT) {
            upstream.breakUntil = Date.now() + UPSTREAM_BREAK_MS;
            upstream.consecutiveFails = 0;
            log(`上游熔断 20s: ${upstream.label}（${error && error.message}）`);
          }
        }
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Status: 2, Answer: [] }));
    })().catch(() => {
      try { res.writeHead(500).end(); } catch { /* ignore */ }
    });
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };
    const guard = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      log('启动超时，放弃中继（回退 3.4.4 默认 DoH）');
      finish(null);
    }, START_BUDGET_MS);
    server.once('error', (error) => {
      log(`中继启动失败（回退 3.4.4 默认 DoH）: ${error && error.message}`);
      finish(null);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const endpoint = `http://127.0.0.1:${port}/resolve`;
      // unref：中继不独自维持进程生命周期（Electron 应用本身持有事件循环；测试进程可自然退出）
      if (typeof server.unref === 'function') server.unref();
      log(`中继就绪 ${endpoint} → 上游: ${upstreams.map((u) => u.label).join(' → ')}`);
      finish(endpoint);
    });
  });
}

module.exports = {
  startSmartDoh,
  _internals: {
    buildDnsQuery,
    parseDnsMessage,
    createUpstream,
    defaultUpstreams,
    queryUpstream,
    queryUpstreamJson,
    queryUpstreamWire,
    skipDnsName
  }
};

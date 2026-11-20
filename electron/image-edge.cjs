'use strict';

const dns = require('node:dns');
const https = require('node:https');

const HOST = 'image.tmdb.org';
const PROBE_PATH = '/t/p/w92/2LqaLgk4Z226KkgPJuiOQ58wvrm.jpg';
const BUDGET_MS = 1800;
const PROBE_TIMEOUT_MS = 1500;

function systemResolve(host, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (list) => {
      if (done) return;
      done = true;
      resolve(list);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      dns.resolve4(host, (error, addresses) => {
        clearTimeout(timer);
        finish(!error && Array.isArray(addresses) ? addresses : []);
      });
    } catch {
      clearTimeout(timer);
      finish([]);
    }
  });
}
function probe(ip, host) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req = null;
    try {
      req = https.request({
        host: ip,
        port: 443,
        servername: host,
        path: PROBE_PATH,
        method: 'GET',
        headers: { host, 'user-agent': 'CineFlow/4.0.0', 'accept-encoding': 'identity', connection: 'close' },
        timeout: PROBE_TIMEOUT_MS,
        rejectUnauthorized: true
      }, (res) => {
        const status = res.statusCode || 0;
        res.resume();
        finish(status > 0 && status < 500 ? Date.now() - started : -1);
      });
      req.on('error', () => finish(-1));
      req.on('timeout', () => {
        try { req.destroy(); } catch { /* ignore */ }
        finish(-1);
      });
      req.end();
    } catch {
      finish(-1);
    }
  });
}

async function pickImageEdge({ log, host, alsoTry } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const target = host || HOST;
  const started = Date.now();
  const resolved = await systemResolve(target, 1200);
  const extra = alsoTry ? [String(alsoTry)] : [];
  const candidates = [...new Set([...extra, ...resolved])].filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (!candidates.length) {
    say('image 边缘兜底：系统解析也没有结果');
    return '';
  }
  const remaining = Math.max(600, BUDGET_MS - (Date.now() - started));
  const limited = candidates.slice(0, 4);
  const results = await Promise.race([
    Promise.all(limited.map((ip) => probe(ip, target).then((ms) => ({ ip, ms })))),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), remaining);
      if (typeof timer.unref === 'function') timer.unref();
    })
  ]);
  if (!results) {
    say('image 边缘兜底：探测超时');
    return '';
  }
  const usable = results.filter((item) => item.ms > 0).sort((a, b) => a.ms - b.ms);
  if (!usable.length) {
    say('image 边缘兜底：候选 IP 全部未通过证书/连通校验');
    return '';
  }
  const best = usable[0];
  const incumbent = alsoTry ? usable.find((item) => item.ip === String(alsoTry)) : null;
  if (incumbent && best.ip === incumbent.ip) {
    say('image 边缘兜底：现有 IP 最快（' + incumbent.ms + 'ms），保持不动');
    return '';
  }
  if (incumbent && incumbent.ms - best.ms < 150) {
    say('image 边缘兜底：现有 IP ' + incumbent.ms + 'ms、候选 ' + best.ms + 'ms，差距不足 150ms，保持不动');
    return '';
  }
  say('image 边缘兜底：换到 ' + best.ip + '（真实请求 ' + best.ms + 'ms' + (incumbent ? '，原 ' + incumbent.ip + ' ' + incumbent.ms + 'ms' : '') + '）');
  return best.ip;
}

module.exports = { pickImageEdge };

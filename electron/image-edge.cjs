'use strict';

/* ---------------------------------------------------------------------------
 * image.tmdb.org 边缘 IP 兜底（第六十七轮）
 *
 * 背景：bootstrap 在 app ready 之前用多路 DoH 探真 IP，再写进
 * host-resolver-rules。实测 image.tmdb.org 这个名字的 DoH 解析**时好时坏**：
 * 好的一次拿到 79.127.134.x（b-cdn 边缘，单图 563ms），坏的一次直接解析不出来，
 * 于是没有 MAP 规则 → 图片退回 meta-server 的本机中继
 * （整张缓冲 + 单端口 HTTP/1.1，实测中位 11709ms、65 个请求 >3s）。
 *
 * 这里补一条"系统解析 + 真证书校验"的兜底：
 *   1. 先用系统解析器（Windows DNS）拿候选 IP —— 该域名在本机解析正常；
 *   2. 逐个子集用 SNI=image.tmdb.org 做一次真实 TLS 请求，只有**证书校验通过、
 *      且状态码 < 500** 的 IP 才算数（污染 IP 会在这一步被淘汰）；
 *   3. 取握手最快的那个交给 host-resolver-rules。
 * 全程有超时上限，失败就返回空串 —— 调用方保持基线行为（继续用中继）。
 * ------------------------------------------------------------------------- */

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

/* 用 SNI = 真域名 建 TLS：证书必须对 image.tmdb.org 有效，否则 reject。
   返回握手 + 首字节耗时；失败返回 -1。 */
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
  /* alsoTry：DoH 已经选出的那个 IP。它只按 TLS 握手挑，不看首字节 ——
     实测 b-cdn 边缘握手 172ms 但首字节 400ms+，而 CloudFront 握手 328ms、首字节更快。
     把两者放进同一个"真实请求耗时"的尺子里比，谁快用谁。 */
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

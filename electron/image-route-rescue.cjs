'use strict';

/* ---------------------------------------------------------------------------
 * 图片直连抢救（第六十七轮）
 *
 * 症状：**无代理** + TMDB 模式下整体比**开代理**慢一大截，鼠标与方向键发黏。
 * 定位过程（单实例 CDP 实测，1280×779）：
 *
 *   image.tmdb.org 的实际请求全部落到 127.0.0.1:<随机端口>，proto http/1.1，ssl 0
 *   → 全是 meta-server 的 /img 中继，不是 CDN。
 *
 *   meta-server.cjs::registerImageRedirect 在「直连可用」时把每一张 TMDB 海报
 *   重定向到 http://127.0.0.1:PORT/img?u=...，由主进程 fetchImageBytes 先把整张图
 *   读进内存再吐给渲染层。而「直连可用」恰好只在**没有代理**时成立 ——
 *   开代理时 directRouteAllowed 为 false，图片走 Chromium 原生加载，反而更快。
 *
 *   实测同一台机器同一张图：
 *     走代理（Chromium 原生）     367ms   中位
 *     走本机中继（无代理时）     1471ms  中位（等待），55 张图里 1 张 502
 *
 *   为什么慢：中继是「整张缓冲 + 单端口 HTTP/1.1」，Chromium 对同一 origin 只有
 *   6 条连接，55 张海报 ≈ 55/6 × 1.5s ≈ 14s（实测中位 11709ms，65 个请求 >3s）。
 *   而 Chromium 原生走 CDN 是 HTTP/2 多路复用 + keep-alive，几十张图共用一个连接。
 *
 * 修法（零改动基线）：meta-server 用 webRequest.onBeforeRequest 做重定向，而 Electron
 * 对同一 session 只保留**最后注册**的那个监听器。这里在它之后重新注册一个同样过滤
 * TMDB 图片域名的监听器，对图片一律 callback({}) —— 即"不重定向"，把图片交回
 * Chromium 原生加载。bootstrap 启动时已用 host-resolver-rules 把 image.tmdb.org
 * MAP 到 DoH 真 IP，所以无代理也不会有 DNS 污染问题。
 *
 * 安全网：
 *   · 只有在确实拿到了 image.tmdb.org 的真 IP（ip-cache.json / 本轮探测）时才接管；
 *     没拿到就原样保留中继，绝不把"能看"换成"看不见"。
 *   · CINEFLOW_IMAGE_RELAY=on 可随时恢复基线行为（中继模式）。
 *   · 全程 try/catch，失败只是少了这一层优化。
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_HOSTS = ['image.tmdb.org', 'static-1.themoviedb.org', 'media.themoviedb.org'];

/* 真 IP 的两个来源，谁有就用谁：
   ① bootstrap 启动时已经把 DoH 真 IP 写进 host-resolver-rules —— 这是最权威的，
      因为 Chromium 实际就是按它去连的（实测 ip-cache.json 有时并不落盘）；
   ② ip-cache.json（万一未来 bootstrap 改了落盘策略）。 */
function parseResolverRules(text) {
  const pinned = {};
  const raw = String(text || '');
  for (const part of raw.split(',')) {
    const match = /^\s*MAP\s+(\S+)\s+(\S+)\s*$/.exec(part);
    if (!match) continue;
    if (IMAGE_HOSTS.includes(match[1]) && /^\d+\.\d+\.\d+\.\d+$/.test(match[2])) pinned[match[1]] = match[2];
  }
  return pinned;
}

function readPinned(file, app) {
  const pinned = parseResolverRules(app && app.commandLine && app.commandLine.getSwitchValue('host-resolver-rules'));
  if (pinned[IMAGE_HOSTS[0]]) return pinned;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const table = raw && (raw.hosts || raw);
    for (const host of IMAGE_HOSTS) {
      const entry = table && table[host];
      const ip = entry && (typeof entry === 'string' ? entry : entry.ip);
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(String(ip))) pinned[host] = String(ip);
    }
  } catch {
    /* ignore */
  }
  return pinned;
}

function createImageRouteRescue({ log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let applied = 0;
  let installed = false;

  function apply(ses) {
    if (!ses) return false;
    try {
      ses.webRequest.onBeforeRequest({ urls: IMAGE_HOSTS.map((host) => `https://${host}/*`) }, (details, callback) => {
        /* 不重定向：让 Chromium 自己去 CDN 取。
           host-resolver-rules 已把这些域名钉在真 IP 上，HTTPS 证书照旧校验。 */
        callback({});
      });
      applied += 1;
      return true;
    } catch (error) {
      say('图片直连接管失败（保持基线中继）:', error && error.message);
      return false;
    }
  }

  function install({ app, session, userDataDir } = {}) {
    if (installed) return true;
    if (process.env.CINEFLOW_IMAGE_RELAY === 'on') {
      say('图片中继保持基线（CINEFLOW_IMAGE_RELAY=on）');
      return false;
    }
    const cacheFile = path.join(userDataDir || (app && app.getPath('userData')) || '', 'ip-cache.json');
    const pinned = readPinned(cacheFile, app);
    if (!pinned[IMAGE_HOSTS[0]]) {
      say('图片直连未接管：还没有 ' + IMAGE_HOSTS[0] + ' 的真 IP（沿用中继）');
      return false;
    }
    const ses = session || require('electron').session.defaultSession;
    if (!ses) return false;
    installed = apply(ses);
    if (!installed) return false;
    say('图片直连已接管:', Object.entries(pinned).map(([h, ip]) => h + '=' + ip).join(', '));
    /* meta-server 的 install() 是异步的（要先 listen 拿端口），可能比我们晚注册。
       Electron 只保留最后一个监听器，所以这里在几个时间点补注册，确保我们在最后。 */
    for (const delay of [900, 2200, 5000]) {
      const timer = setTimeout(() => {
        try { apply(ses); } catch { /* ignore */ }
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return true;
  }

  return { install, get applied() { return applied; } };
}

module.exports = { createImageRouteRescue };

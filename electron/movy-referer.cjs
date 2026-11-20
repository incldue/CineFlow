'use strict';
// Movy 流媒体 CDN 缺 Referer 会回 403。这里只对 movy-sources 真实解析出的域名补头，
// 并顺带补齐 CORS 响应头；未登记的域名不改。播放主路径已改走本地代理，此处是兜底。

function createMovyReferer({ log = () => {}, hosts = null } = {}) {
  const allow = hosts instanceof Set ? hosts : new Set();
  const REFERER = 'https://www.movy.sx/';
  const ORIGIN = 'https://www.movy.sx';
  const stats = { scanned: 0, injected: 0, lastAt: 0 };
  let installed = false;

  function handle(details, callback) {
    try {
      stats.scanned += 1;
      if (allow.size === 0) return callback({});
      let host = '';
      try { host = new URL(details.url).host; } catch { return callback({}); }
      if (!host || !allow.has(host)) return callback({});
      const headers = { ...(details.requestHeaders || {}) };
      headers.Referer = REFERER;
      headers.Origin = ORIGIN;
      stats.injected += 1;
      stats.lastAt = Date.now();
      return callback({ requestHeaders: headers });
    } catch (error) {
      try { log('movy referer 注入异常:', error && error.message); } catch { /* ignore */ }
      try { callback({}); } catch { /* ignore */ }
      return undefined;
    }
  }

  // hls.js 用 XHR 拉 m3u8 / 分片，跨域必须有 CORS 头。CDN 有时不给（或给得不全），
  // 浏览器就直接判失败、播放器黑屏 —— 这里按同一个域名白名单补上，非白名单域名不碰。
  function handleHeaders(details, callback) {
    try {
      if (allow.size === 0) return callback({});
      let host = '';
      try { host = new URL(details.url).host; } catch { return callback({}); }
      if (!host || !allow.has(host)) return callback({});
      const headers = { ...(details.responseHeaders || {}) };
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges, Date'];
      return callback({ responseHeaders: headers });
    } catch {
      try { callback({}); } catch { /* ignore */ }
      return undefined;
    }
  }

  function install({ session } = {}) {
    if (installed) return false;
    let ses = session;
    if (!ses) {
      try { ses = require('electron').session.defaultSession; } catch { ses = null; }
    }
    if (!ses || !ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== 'function') return false;
    try {
      ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, handle);
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, handleHeaders);
      installed = true;
      // 其他模块可能在我们之后注册同名监听（Electron 同一事件只有一个监听生效），
      // 启动后补挂两次，保证最终生效的是这一层。
      for (const delay of [1200, 4000, 9000]) {
        const timer = setTimeout(() => {
          try {
            ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, handle);
            ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, handleHeaders);
          } catch { /* ignore */ }
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
      }
      log('movy referer 注入已挂载');
      return true;
    } catch (error) {
      log('movy referer 注入挂载失败:', error && error.message);
      return false;
    }
  }

  return { install, handle, handleHeaders, stats, hosts: allow, isInstalled: () => installed };
}

module.exports = { createMovyReferer };

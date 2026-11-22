'use strict';

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
      try { log('movy referer 注入异常:', error && error.message); } catch {  }
      try { callback({}); } catch {  }
      return undefined;
    }
  }

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
      try { callback({}); } catch {  }
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

      for (const delay of [1200, 4000, 9000]) {
        const timer = setTimeout(() => {
          try {
            ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, handle);
            ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, handleHeaders);
          } catch {  }
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

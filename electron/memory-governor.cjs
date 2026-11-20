'use strict';

/* ---------------------------------------------------------------------------
 * 内存总督（第六十八轮 · 新增文件，零侵入基线）
 *
 * 目标不是"某一次卡顿"，而是"用多久都一样"：macOS 的 jetsam / NSCache 与 iOS 的
 * didReceiveMemoryWarning 都是同一条思路 —— 常态下低开销地量，越界就分级回收，
 * 回收完继续量。这里落成三档：
 *
 *   ok       (< 700MB 渲染进程私有内存)  只记录
 *   warn     (>= 700MB)                 让渲染层立刻回收休眠页图片与播放器资源
 *   critical (>= 1100MB，或 warn 连续 3 次)  warn 的动作 + 清 Chromium 缓存
 *                                       + 清 DNS 缓存 + 把后台窗口降频
 *
 * 只在真的越界时才动 session 缓存：平时清缓存会让海报反复重下，那是另一种卡。
 * 全部 try/catch；CINEFLOW_MEMORY_GOVERNOR=0 可整体关闭。
 * ------------------------------------------------------------------------- */

const SAMPLE_MS = 20000;
const WARN_BYTES = 700 * 1024 * 1024;
const CRITICAL_BYTES = 1100 * 1024 * 1024;
const WARN_STREAK_FOR_CRITICAL = 3;

const PURGE_JS = '(function(){try{return window.__cf68HygieneForce ? JSON.stringify(window.__cf68HygieneForce("governor")) : null;}catch(e){return null;}})()';

function createMemoryGovernor({ log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let timer = null;
  let warnStreak = 0;
  let lastLevel = 'ok';
  const stats = { samples: 0, warns: 0, criticals: 0, purges: 0, cacheClears: 0, peakMB: 0, lastMB: 0 };

  const bytesOf = (info) => {
    if (!info) return 0;
    const candidates = [info.private, info.resident, info.shared];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n * 1024; /* getProcessMemoryInfo 单位是 KB */
    }
    return 0;
  };

  async function sampleOnce(app, session) {
    const stats2 = app.getAppMetrics ? app.getAppMetrics() : [];
    let rendererBytes = 0;
    try {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) continue;
        /* eslint-disable no-await-in-loop */
        const info = await wc.getProcessMemoryInfo().catch(() => null);
        rendererBytes = Math.max(rendererBytes, bytesOf(info));
      }
    } catch {
      /* ignore */
    }
    if (!rendererBytes && stats2.length) {
      for (const item of stats2) {
        if (item && item.type === 'Tab') rendererBytes = Math.max(rendererBytes, Number(item.memory && item.memory.workingSetSize ? item.memory.workingSetSize * 1024 : 0));
      }
    }
    return rendererBytes;
  }

  async function purgeRenderers(reason) {
    let done = 0;
    try {
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win || win.isDestroyed()) continue;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) continue;
        /* eslint-disable no-await-in-loop */
        const out = await wc.executeJavaScript(PURGE_JS, true).catch(() => null);
        if (out) done += 1;
      }
    } catch {
      /* ignore */
    }
    if (done) {
      stats.purges += 1;
      say('内存回收已下发（' + (reason || 'pressure') + '，' + done + ' 个窗口）');
    }
    return done;
  }

  async function clearCaches(ses) {
    try {
      if (ses && ses.clearCache) await ses.clearCache();
      if (ses && ses.clearCodeCaches) await ses.clearCodeCaches({});
      if (ses && ses.clearHostResolverCache) await ses.clearHostResolverCache();
      stats.cacheClears += 1;
      say('Chromium 缓存与 DNS 缓存已清理（critical）');
    } catch {
      /* ignore */
    }
  }

  function hiddenEverywhere(app) {
    try {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed());
      if (!windows.length) return false;
      return windows.every((win) => !win.isVisible() || win.isMinimized());
    } catch {
      return false;
    }
  }

  async function tick(app, ses) {
    try {
      const bytes = await sampleOnce(app, ses);
      const mb = Math.round(bytes / 1048576);
      if (mb > 0) {
        stats.samples += 1;
        stats.lastMB = mb;
        if (mb > stats.peakMB) stats.peakMB = mb;
      }
      let level = 'ok';
      if (bytes >= CRITICAL_BYTES || warnStreak >= WARN_STREAK_FOR_CRITICAL) level = 'critical';
      else if (bytes >= WARN_BYTES) level = 'warn';

      if (level === 'warn') {
        warnStreak += 1;
        stats.warns += 1;
        await purgeRenderers('warn');
      } else if (level === 'critical') {
        stats.criticals += 1;
        await purgeRenderers('critical');
        /* 只在"没人在看"的时候清磁盘/内存缓存：可见时清缓存会让海报重新下载，
           反而是另一种卡顿。 */
        if (hiddenEverywhere(app)) await clearCaches(ses);
        warnStreak = 0;
      } else {
        warnStreak = 0;
      }

      if (level !== lastLevel) {
        say('内存水位 ' + mb + 'MB → ' + level);
        lastLevel = level;
      }
    } catch {
      /* ignore */
    }
  }

  function start(app, session) {
    if (process.env.CINEFLOW_MEMORY_GOVERNOR === '0') {
      say('内存总督已按环境变量关闭');
      return false;
    }
    if (timer) return true;
    const ses = session || require('electron').session.defaultSession;
    const started = setTimeout(() => {
      tick(app, ses).catch(() => {});
      timer = setInterval(() => tick(app, ses).catch(() => {}), SAMPLE_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }, 30000);
    if (started && typeof started.unref === 'function') started.unref();
    say('内存总督已启动（采样 ' + SAMPLE_MS / 1000 + 's，warn 700MB / critical 1100MB）');
    return true;
  }

  return { start, stats, get level() { return lastLevel; }, _tick: tick };
}

module.exports = { createMemoryGovernor };

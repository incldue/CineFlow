'use strict';
/**
 * TMDB 片名字标（logo）取图（新增文件，零触碰基线）
 *
 * 为什么单开通道：基线 tmdb:details 的 append_to_response 是
 * credits,recommendations,similar,videos —— 不含 images，所以拿不到字标。
 * 这里只做一件事：/{type}/{id}/images → 按上游同一套规则挑一张横向字标。
 *
 * 挑选规则（与 www.movy.sx 首页 hero 完全一致，逐条对齐）：
 *   · 只要 width > height 的横向图（竖版是堆叠片名，塞进横幅会变形）
 *   · 按 vote_average 降序
 *   · 优先当前语言 → 其次 en → 再次任意
 *
 * 结果落盘 7 天。失败一律返回 { ok:false }，渲染层据此保留文字标题（零回归）。
 */

const fsp = require('node:fs');
const path = require('node:path');

const API_HOST = 'https://api.themoviedb.org/3';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

function loadNet() {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return electron.net.fetch.bind(electron.net);
  } catch { /* 测试环境 */ }
  return typeof fetch === 'function' ? fetch : null;
}

function withTimeout(promise, ms, label) {
  let timer = 0;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readCredential(userDataDir) {
  try {
    const file = path.join(userDataDir, 'settings.json');
    const text = fsp.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    const raw = parsed && parsed.tmdbCredential;
    if (!raw) return '';
    const value = typeof raw === 'string' ? raw : String(raw.value || '');
    return String(value || '').trim();
  } catch { return ''; }
}

function pickLogo(logos = [], locale = 'zh') {
  const list = Array.isArray(logos) ? logos : [];
  const flat = list.filter((item) => item && item.file_path && Number(item.width) > Number(item.height));
  if (!flat.length) return null;
  const sorted = flat.slice().sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0));
  const wanted = String(locale || 'zh').toLowerCase().slice(0, 2);
  const hit = sorted.find((item) => String(item.iso_639_1 || '').toLowerCase() === wanted)
    || sorted.find((item) => String(item.iso_639_1 || '').toLowerCase() === 'en')
    || sorted[0];
  if (!hit) return null;
  return {
    logoPath: hit.file_path,
    width: Number(hit.width) || 0,
    height: Number(hit.height) || 0,
    lang: String(hit.iso_639_1 || ''),
    vote: Number(hit.vote_average || 0),
  };
}

function createTmdbLogos({ log = () => {}, userDataDir = '', ipcMain = null, channel = 'cf:m2:logos' } = {}) {
  const memory = new Map();
  let cacheDir = '';

  function diskFile(key) {
    if (!userDataDir) return '';
    try {
      if (!cacheDir) {
        cacheDir = path.join(userDataDir, 'logo-cache');
        fsp.mkdirSync(cacheDir, { recursive: true });
      }
      return path.join(cacheDir, String(key).replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 120) + '.json');
    } catch { return ''; }
  }

  async function fetchLogos({ id, mediaType = 'movie', locale = 'zh' } = {}) {
    const numericId = Number(id);
    if (!numericId) return { ok: false, error: 'INVALID_ID' };
    const type = String(mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const lang = String(locale || 'zh').toLowerCase().slice(0, 2);
    const key = 'logo-' + type + '-' + numericId + '-' + lang;

    const cached = memory.get(key);
    if (cached && Date.now() - cached.savedAt < TTL_MS) return cached.data;
    const file = diskFile(key);
    if (file) {
      try {
        const parsed = JSON.parse(fsp.readFileSync(file, 'utf8'));
        if (parsed && parsed.savedAt && Date.now() - parsed.savedAt < TTL_MS) {
          memory.set(key, parsed);
          return parsed.data;
        }
      } catch { /* 缓存损坏即重取 */ }
    }

    const credential = readCredential(userDataDir);
    if (!credential) return { ok: false, error: 'NO_CREDENTIAL' };

    const netFetch = loadNet();
    if (!netFetch) return { ok: false, error: 'NO_NETWORK' };

    const url = new URL(API_HOST + '/' + type + '/' + numericId + '/images');
    url.searchParams.set('include_image_language', lang + ',en,null');
    const headers = { accept: 'application/json' };
    if (/^ey[A-Za-z0-9._-]{10,}/.test(credential)) headers.authorization = 'Bearer ' + credential;
    else url.searchParams.set('api_key', credential);

    let data = null;
    try {
      const response = await withTimeout(netFetch(url.toString(), { method: 'GET', headers }), TIMEOUT_MS, 'logos');
      if (!response.ok) return { ok: false, error: 'HTTP_' + response.status };
      data = await response.json();
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }

    const picked = pickLogo(data && data.logos, lang);
    const result = picked
      ? { ok: true, ...picked, url: 'https://image.tmdb.org/t/p/w500' + picked.logoPath }
      : { ok: false, error: 'NO_LOGO' };

    try {
      const entry = { savedAt: Date.now(), data: result };
      memory.set(key, entry);
      if (file) {
        const tmp = file + '.tmp';
        fsp.writeFileSync(tmp, JSON.stringify(entry));
        fsp.renameSync(tmp, file);
      }
    } catch { /* 缓存写失败不影响首屏 */ }

    return result;
  }

  function registerIpc() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
    try { ipcMain.removeHandler(channel); } catch { /* 未注册 */ }
    ipcMain.handle(channel, async (_event, payload = {}) => {
      try { return await fetchLogos(payload); } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    return true;
  }

  return { fetchLogos, registerIpc, pickLogo };
}

module.exports = { createTmdbLogos, pickLogo };

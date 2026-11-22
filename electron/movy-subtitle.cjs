'use strict';

const fsp = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REFERER = 'https://www.movy.sx/';
const ORIGIN = 'https://www.movy.sx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 9000;
const TRANSLATE_TIMEOUT_MS = 3000;
const TRANSLATE_CONCURRENCY = 6;
const TRANSLATE_BATCH = 12;
const TRANSLATE_CACHE_MAX = 6000;

const LANG_TO_TRANSLATE = {
  eng: 'en', en: 'en', zho: 'zh-CN', chi: 'zh-CN', zh: 'zh-CN', cht: 'zh-TW', chs: 'zh-CN',
  jpn: 'ja', ja: 'ja', kor: 'ko', ko: 'ko', spa: 'es', es: 'es', fra: 'fr', fre: 'fr', fr: 'fr',
  deu: 'de', ger: 'de', de: 'de', rus: 'ru', ru: 'ru', ita: 'it', it: 'it', por: 'pt', pt: 'pt',
  ara: 'ar', ar: 'ar', hin: 'hi', hi: 'hi', tha: 'th', th: 'th', vie: 'vi', vi: 'vi',
  tur: 'tr', tr: 'tr', pol: 'pl', pl: 'pl', nld: 'nl', dut: 'nl', nl: 'nl', swe: 'sv', sv: 'sv',
  dan: 'da', da: 'da', nor: 'no', no: 'no', fin: 'fi', fi: 'fi', ces: 'cs', cze: 'cs', cs: 'cs',
  hun: 'hu', hu: 'hu', ron: 'ro', rum: 'ro', ro: 'ro', ukr: 'uk', uk: 'uk', ell: 'el', gre: 'el',
  el: 'el', heb: 'he', he: 'he', ind: 'id', id: 'id', msa: 'ms', may: 'ms', ms: 'ms',
  bul: 'bg', bg: 'bg', srp: 'sr', sr: 'sr', hrv: 'hr', hr: 'hr', slk: 'sk', slo: 'sk', sk: 'sk',
  slv: 'sl', sl: 'sl', lit: 'lt', lt: 'lt', lav: 'lv', lv: 'lv', est: 'et', et: 'et',
  cat: 'ca', ca: 'ca', fas: 'fa', per: 'fa', fa: 'fa', urd: 'ur', ur: 'ur', ben: 'bn', bn: 'bn',
  tam: 'ta', ta: 'ta', tel: 'te', te: 'te', mal: 'ml', ml: 'ml', kan: 'kn', kn: 'kn',
  mar: 'mr', mr: 'mr', guj: 'gu', gu: 'gu', pan: 'pa', pa: 'pa', nep: 'ne', ne: 'ne',
  sin: 'si', si: 'si', khm: 'km', km: 'km', lao: 'lo', lo: 'lo', mya: 'my', my: 'my',
  geo: 'ka', kat: 'ka', ka: 'ka', hye: 'hy', arm: 'hy', hy: 'hy', kaz: 'kk', kk: 'kk',
  uzb: 'uz', uz: 'uz', aze: 'az', az: 'az', bel: 'be', be: 'be', bos: 'bs', bs: 'bs',
  mkd: 'mk', mk: 'mk', alb: 'sq', sqi: 'sq', sq: 'sq', isl: 'is', ice: 'is', is: 'is',
  gle: 'ga', ga: 'ga', cym: 'cy', cy: 'cy', afr: 'af', af: 'af', swa: 'sw', sw: 'sw',
  amh: 'am', am: 'am', ceb: 'ceb', fil: 'tl', tgl: 'tl', tl: 'tl',
};

function baseLang(code) {
  return String(code || '').toLowerCase().replace(/\(.*$/, '').trim();
}

function translateCode(code) {
  const base = baseLang(code);
  return LANG_TO_TRANSLATE[base] || (/^[a-z]{2}$/.test(base) ? base : '');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (all, num) => { try { return String.fromCharCode(Number(num)); } catch { return all; } });
}

function cleanCueText(raw) {
  return decodeEntities(String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, ''))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseTimecode(value) {
  const text = String(value || '').trim().replace(',', '.');
  const hit = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!hit) return NaN;
  const hours = hit[1] ? Number(hit[1]) : 0;
  const minutes = Number(hit[2]);
  const seconds = Number(hit[3]);
  const ms = hit[4] ? Number((hit[4] + '00').slice(0, 3)) : 0;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function parseCues(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues = [];
  let buffer = [];
  let timing = null;
  const flush = () => {
    if (timing && buffer.length) {
      const content = cleanCueText(buffer.join('\n'));
      if (content && timing.end > timing.start) cues.push({ s: timing.start, e: timing.end, t: content });
    }
    buffer = [];
    timing = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/-->/.test(trimmed)) {
      flush();
      const parts = trimmed.split(/-->/);
      const start = parseTimecode(parts[0]);
      const end = parseTimecode(String(parts[1] || '').trim().split(/\s+/)[0]);
      timing = Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
      continue;
    }
    if (!trimmed) { flush(); continue; }
    if (/^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/i.test(trimmed)) continue;
    if (timing) buffer.push(trimmed);
  }
  flush();
  cues.sort((a, b) => a.s - b.s);
  return cues;
}

function decodeSubtitleBuffer(buffer) {
  const head = buffer.subarray(0, 3);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('gb18030').decode(buffer); }
    catch { return buffer.toString('latin1'); }
  }
}

async function readSubtitleFile(file) {
  const fs = require('node:fs/promises');
  const buffer = await fs.readFile(file);
  const cues = parseCues(decodeSubtitleBuffer(buffer));
  return { ok: cues.length > 0, cues, name: require('node:path').basename(file), error: cues.length ? '' : '没有解析出字幕' };
}

function createMovySubtitle({ log = () => {}, userDataDir = '', ipcMain = null, channels = {} } = {}) {
  const names = {
    cues: channels.cues || 'cf:m2:movy-sub-cues',
    translate: channels.translate || 'cf:m2:movy-sub-translate',
    discover: channels.discover || 'cf:m2:movy-sub-discover',
    pick: channels.pick || 'cf:m2:movy-sub-pick',
    parse: channels.parse || 'cf:m2:movy-sub-parse',
    online: channels.online || 'cf:m2:movy-sub-online',
    onlineLoad: channels.onlineLoad || 'cf:m2:movy-sub-online-load',
    stats: channels.stats || 'cf:m2:movy-sub-stats',
  };
  const dir = userDataDir ? path.join(userDataDir, 'movy-subs') : '';
  const online = require('./movy-subtitle-online.cjs').createOnlineSubtitles({ log });
  const cueCache = new Map();
  const translations = new Map();
  let translateInflight = 0;
  const translateQueue = [];
  let diskLoaded = false;

  function sha1(value) { return crypto.createHash('sha1').update(String(value)).digest('hex'); }

  function ensureDir() {
    if (!dir) return false;
    try { fsp.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
  }

  function sessionList() {
    const list = [];
    try {
      const { session } = require('electron');
      if (session && typeof session.fromPartition === 'function') {
        const direct = session.fromPartition('persist:movy-direct', { cache: true });
        try { direct.setProxy({ mode: 'direct' }).catch(() => {}); } catch {  }
        if (direct && typeof direct.fetch === 'function') list.push(direct);
        const def = session.defaultSession;
        if (def && typeof def.fetch === 'function' && def !== direct) list.push(def);
      }
    } catch {  }
    return list;
  }

  async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const list = sessionList();
    if (!list.length) throw new Error('no-fetch');
    const headers = { 'user-agent': UA, referer: REFERER, origin: ORIGIN, accept: '*/*' };
    let lastError = null;
    for (const ses of list) {
      const timer = setTimeout(() => { try { lastError = lastError || new Error('timeout'); } catch {  } }, timeoutMs);
      try {
        const response = await ses.fetch.call(ses, url, { method: 'GET', headers, redirect: 'follow' });
        if (response && response.ok) return await response.text();
        lastError = new Error('HTTP ' + (response && response.status));
      } catch (error) { lastError = error; } finally { clearTimeout(timer); }
    }
    throw lastError || new Error('fetch-failed');
  }

  function diskCuePath(url) { return dir ? path.join(dir, sha1(url) + '.json') : ''; }

  function readCueDisk(url) {
    const file = diskCuePath(url);
    if (!file) return null;
    try {
      const raw = fsp.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.cues) || !data.cues.length) return null;
      return data;
    } catch { return null; }
  }

  function writeCueDisk(url, payload) {
    const file = diskCuePath(url);
    if (!file || !ensureDir()) return;
    try { fsp.writeFileSync(file, JSON.stringify(payload), 'utf8'); } catch {  }
  }

  function translateDiskPath() { return dir ? path.join(dir, 'translate.json') : ''; }

  function loadTranslateDisk() {
    if (diskLoaded) return;
    diskLoaded = true;
    const file = translateDiskPath();
    if (!file) return;
    try {
      const data = JSON.parse(fsp.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          if (translations.size >= TRANSLATE_CACHE_MAX) break;
          if (typeof value === 'string' && value) translations.set(key, value);
        }
      }
    } catch {  }
  }

  let saveTimer = null;
  function saveTranslateDisk() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const file = translateDiskPath();
      if (!file || !ensureDir()) return;
      try {
        const out = {};
        let count = 0;
        for (const [key, value] of translations) {
          if (count >= TRANSLATE_CACHE_MAX) break;
          out[key] = value;
          count += 1;
        }
        fsp.writeFileSync(file, JSON.stringify(out), 'utf8');
      } catch {  }
    }, 2500);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  async function requestTranslate(text, from, to) {
    const source = encodeURIComponent(from || 'auto');
    const target = encodeURIComponent(to || 'zh-CN');
    const payload = encodeURIComponent(text);

    const endpoints = [
      'https://api.mymemory.translated.net/get?langpair=' + source + '%7C' + target + '&q=' + payload,
      'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + source + '&tl=' + target + '&q=' + payload,
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' + source + '&tl=' + target + '&q=' + payload,
    ];
    const list = sessionList();
    if (!list.length) throw new Error('no-fetch');
    for (const url of endpoints) {
      const value = await Promise.race([
        tryTranslateUrl(url, list),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(''), TRANSLATE_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      if (value) return value;
    }
    return '';
  }

  async function tryTranslateUrl(url, list) {
    for (const ses of list) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { controller && controller.abort(); } catch {  } }, TRANSLATE_TIMEOUT_MS);
      try {
        const response = await ses.fetch.call(ses, url, {
          method: 'GET',
          headers: { 'user-agent': UA },
          signal: controller ? controller.signal : undefined,
          redirect: 'follow',
        });
        if (!response || !response.ok) continue;
        const data = await response.json();
        if (data && data.responseData && typeof data.responseData.translatedText === 'string') {
          return data.responseData.translatedText;
        }
        if (Array.isArray(data) && typeof data[0] === 'string') return data.join('');
        const pieces = Array.isArray(data && data[0]) ? data[0] : [];
        const merged = pieces.map((item) => (Array.isArray(item) ? String(item[0] || '') : '')).join('');
        if (merged) return merged;
      } catch {  } finally { clearTimeout(timer); }
    }
    return '';
  }

  async function translateBatch(texts, from, to) {
    const source = encodeURIComponent(from || 'auto');
    const target = encodeURIComponent(to || 'zh-CN');
    const base = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + source + '&tl=' + target;
    const query = texts.map((text) => '&q=' + encodeURIComponent(text)).join('');
    const list = sessionList();
    if (!list.length) return [];
    for (const ses of list) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { controller && controller.abort(); } catch {  } }, TRANSLATE_TIMEOUT_MS);
      try {
        const response = await ses.fetch.call(ses, base + query, {
          method: 'GET',
          headers: { 'user-agent': UA },
          signal: controller ? controller.signal : undefined,
          redirect: 'follow',
        });
        if (!response || !response.ok) continue;
        const data = await response.json();
        if (!Array.isArray(data)) continue;
        const values = data.map((item) => (typeof item === 'string' ? item : (Array.isArray(item) ? String(item[0] || '') : '')));
        if (values.length === texts.length) return values;
      } catch {  } finally { clearTimeout(timer); }
    }

    const single = [];
    for (const text of texts) single.push(await requestTranslate(text, from, to));
    return single;
  }

  function pumpTranslate() {
    while (translateInflight < TRANSLATE_CONCURRENCY && translateQueue.length) {
      const job = translateQueue.shift();
      translateInflight += 1;
      translateBatch(job.texts, job.from, job.to)
        .then((values) => { job.resolve(values); })
        .catch(() => { job.resolve([]); })
        .finally(() => { translateInflight -= 1; pumpTranslate(); });
    }
  }

  function enqueueTranslate(texts, from, to) {
    return new Promise((resolve) => { translateQueue.push({ texts, from, to, resolve }); pumpTranslate(); });
  }

  const PROBE_LANGS = ['zho', 'chi', 'zh', 'chs', 'cht', 'zho-Hans', 'eng', 'en', 'jpn', 'kor', 'spa', 'fre'];

  function resolveUri(ref, base) {
    try { return new URL(ref, base).toString(); } catch { return ''; }
  }

  async function looksLikeSubtitle(url) {
    try {
      const text = await fetchText(url, 2000);
      const head = text.slice(0, 400);
      if (/^\uFEFF?WEBVTT/i.test(head)) return true;
      return /-->/.test(text.slice(0, 4000));
    } catch { return false; }
  }

  async function discover({ streamUrl = '', subtitles = [] } = {}) {
    const found = [];
    const seen = new Set();
    const push = (url, lang, source) => {
      const text = String(url || '');
      if (!/^https?:\/\//i.test(text) || seen.has(text)) return;
      seen.add(text);
      found.push({ url: text, lang: lang || '', language: lang || '', source });
    };
    for (const item of Array.isArray(subtitles) ? subtitles : []) {
      if (item && item.url) push(item.url, item.lang || item.language, 'payload');
    }
    if (found.length) return { ok: true, tracks: found, from: 'payload' };

    const stream = String(streamUrl || '');
    if (!/^https?:\/\//i.test(stream)) return { ok: false, tracks: [], error: '无播放地址' };

    try {
      const text = await fetchText(stream, 4200);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!/^#EXT-X-MEDIA:/i.test(line.trim())) continue;
        if (!/TYPE=SUBTITLES/i.test(line)) continue;
        const uri = (line.match(/URI="([^"]+)"/) || [])[1];
        if (!uri) continue;
        const lang = (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || '';
        const abs = resolveUri(uri, stream);
        if (abs) push(abs, lang, 'manifest');
      }
      if (found.length) return { ok: true, tracks: found, from: 'manifest' };

      const baseDir = stream.replace(/[^/]*$/, '');
      const candidates = [];
      for (const lang of PROBE_LANGS) {
        candidates.push(baseDir + 'subs/' + lang + '.vtt');
        candidates.push(baseDir + 'subs/' + lang + '.srt');
      }
      candidates.push(baseDir + 'eng.vtt', baseDir + 'zh.vtt', baseDir + 'subs/eng.sdh.vtt', baseDir + 'subs/zho.sdh.vtt');

      let cursor = 0;
      let stop = false;
      const worker = async () => {
        while (!stop && cursor < candidates.length) {
          const url = candidates[cursor];
          cursor += 1;
          const ok = await looksLikeSubtitle(url);
          if (!ok) continue;
          const lang = (url.match(/\/([A-Za-z-]{2,7})(?:\.sdh)?\.(?:vtt|srt)$/) || [])[1] || '';
          push(url, lang, 'probe');
          if (found.length >= 3) stop = true;
        }
      };
      await Promise.all(Array.from({ length: 8 }, () => worker()));
    } catch (error) {
      return { ok: false, tracks: [], error: String((error && error.message) || error) };
    }
    return { ok: found.length > 0, tracks: found, from: found.length ? 'probe' : 'none' };
  }

  async function fetchCues({ url, lang } = {}) {
    const started = Date.now();
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '地址无效', cues: [] };
    const mem = cueCache.get(target);
    if (mem && Array.isArray(mem.cues) && mem.cues.length) {
      return { ok: true, cues: mem.cues, cached: 'memory', lang: lang || mem.lang || '', ms: Date.now() - started };
    }
    const disk = readCueDisk(target);
    if (disk) {
      cueCache.set(target, { cues: disk.cues, lang: disk.lang });
      return { ok: true, cues: disk.cues, cached: 'disk', lang: lang || disk.lang || '', ms: Date.now() - started };
    }
    try {
      const text = await fetchText(target);
      const cues = parseCues(text);
      if (!cues.length) return { ok: false, error: '字幕为空', cues: [] };
      cueCache.set(target, { cues, lang: lang || '' });
      writeCueDisk(target, { lang: lang || '', savedAt: Date.now(), cues });
      log('movy 字幕 ' + cues.length + ' 条 · ' + (Date.now() - started) + 'ms');
      return { ok: true, cues, cached: 'network', lang: lang || '', ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), cues: [] };
    }
  }

  async function translate({ texts = [], from = '', to = 'zh-CN' } = {}) {
    loadTranslateDisk();
    const source = translateCode(from);
    const list = Array.isArray(texts) ? texts.filter((item) => typeof item === 'string' && item.trim()).slice(0, 200) : [];
    const result = {};
    const missing = [];
    for (const text of list) {
      const key = source + '|' + to + '|' + text;
      const hit = translations.get(key);
      if (hit) result[text] = hit;
      else missing.push(text);
    }
    if (!missing.length) return { ok: true, map: result, fetched: 0 };
    const chunks = [];
    for (let i = 0; i < missing.length; i += TRANSLATE_BATCH) chunks.push(missing.slice(i, i + TRANSLATE_BATCH));
    const settled = await Promise.all(chunks.map(async (chunk) => ({ chunk, values: await enqueueTranslate(chunk, source || 'auto', to) })));
    let fetched = 0;
    for (const item of settled) {
      item.chunk.forEach((text, index) => {
        const value = item.values && item.values[index];
        if (!value) return;
        result[text] = value;
        translations.set(source + '|' + to + '|' + text, value);
        fetched += 1;
      });
    }
    if (fetched) saveTranslateDisk();
    return { ok: fetched > 0, map: result, fetched };
  }

  function register() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
    try {
      ipcMain.handle(names.cues, async (_event, payload = {}) => fetchCues(payload || {}));
      ipcMain.handle(names.translate, async (_event, payload = {}) => {
        try { return await translate(payload || {}); } catch (error) { return { ok: false, map: {}, error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.pick, async () => {
        try {
          const { dialog } = require('electron');
          const picked = await dialog.showOpenDialog({
            title: '选择字幕文件',
            properties: ['openFile'],
            filters: [{ name: '字幕', extensions: ['srt', 'vtt', 'ass', 'ssa'] }, { name: '全部文件', extensions: ['*'] }],
          });
          if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
          return await readSubtitleFile(picked.filePaths[0]);
        } catch (error) { return { ok: false, cues: [], error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.parse, async (_event, payload = {}) => {
        try {
          const cues = parseCues(String((payload && payload.text) || ''));
          return { ok: cues.length > 0, cues, error: cues.length ? '' : '没有解析出字幕' };
        } catch (error) { return { ok: false, cues: [], error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.online, async (_event, payload = {}) => {
        try { return await online.search(payload || {}); } catch (error) { return { ok: false, tracks: [], error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.onlineLoad, async (_event, payload = {}) => {
        try {
          const loaded = await online.load((payload && payload.track) || {});
          if (!loaded.ok) return { ok: false, cues: [], error: loaded.error || '在线字幕加载失败' };
          if (Array.isArray(loaded.cues) && loaded.cues.length) return { ok: true, cues: loaded.cues };
          const parsed = parseCues(loaded.text || '');
          return { ok: parsed.length > 0, cues: parsed, error: parsed.length ? '' : '在线字幕为空' };
        } catch (error) { return { ok: false, cues: [], error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.discover, async (_event, payload = {}) => {
        try { return await discover(payload || {}); } catch (error) { return { ok: false, tracks: [], error: String((error && error.message) || error) }; }
      });
      ipcMain.handle(names.stats, async () => ({
        cueKeys: cueCache.size,
        translations: translations.size,
        queue: translateQueue.length,
        dir: dir || '',
      }));
      return true;
    } catch (error) {
      log('movy 字幕注册失败 · ' + String((error && error.message) || error));
      return false;
    }
  }

  return { register, fetchCues, translate, discover, online, parseCues, channels: names, cacheDir: dir };
}

module.exports = { createMovySubtitle, parseCues, translateCode };

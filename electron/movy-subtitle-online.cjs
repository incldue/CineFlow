'use strict';
// 在线字幕：CDN 没有字幕轨时按片名去字幕站找一条（subf2m 中文可直连下载，B 站作补充）。

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 9000;
const MAX_BYTES = 6 * 1024 * 1024;

const LANG_LABELS = {
  chinese: '中文', 'chinese-bg-code': '中文（简体）', 'chinese-simplified': '中文（简体）',
  'chinese-traditional': '中文（繁体）', english: '英文', japanese: '日文', korean: '韩文',
};

function decodeText(buffer) {
  const head = buffer.subarray(0, 4);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    for (const charset of ['gb18030', 'big5', 'shift_jis']) {
      try { return new TextDecoder(charset).decode(buffer); } catch { /* 下一个 */ }
    }
    return buffer.toString('latin1');
  }
}

// zip：只取第一个像字幕的条目，走中央目录，避开 data descriptor 的坑
function unzipFirst(buffer, want = /\.(srt|vtt|ass|ssa)$/i) {
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) return null;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  const pick = entries.find((item) => want.test(item.name)) || entries[0];
  if (!pick) return null;
  const local = pick.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const raw = buffer.subarray(start, start + pick.compSize);
  try {
    const data = pick.method === 8 ? zlib.inflateRawSync(raw) : raw;
    return { name: pick.name, text: decodeText(data) };
  } catch { return null; }
}

async function request(url, { headers = {}, timeout = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('文件过大');
    return { buffer, text: decodeText(buffer), contentType: response.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}

// subf2m 对连发请求敏感：排队 + 间隔 + 重试，宁可慢一点也别被限流
let subf2mQueue = Promise.resolve();
let subf2mLastAt = 0;
function subf2mFetch(url, options = {}) {
  const run = async () => {
    const wait = Math.max(0, 700 - (Date.now() - subf2mLastAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try { return await requestRetry(url, { timeout: 12000, ...options }, 3); }
    finally { subf2mLastAt = Date.now(); }
  };
  subf2mQueue = subf2mQueue.then(run, run);
  return subf2mQueue;
}

async function requestRetry(url, options = {}, tries = 2) {
  let lastError = null;
  for (let i = 0; i < tries; i += 1) {
    try { return await request(url, options); }
    catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1200 + i * 900));
    }
  }
  throw lastError || new Error('request failed');
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/[（(].*?[)）]/g, ' ')
    .replace(/[:：·\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text) {
  return cleanTitle(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function subf2mFindMovie({ title, year, mediaType, season, episode }) {
  const names = [];
  const base = cleanTitle(title);
  if (base) names.push(base);
  if (year) names.push(base + ' ' + year);
  const wanted = [];
  for (const name of names) {
    const query = encodeURIComponent(name);
    let page;
    try { page = await subf2mFetch('https://subf2m.co/subtitles/searchbytitle?query=' + query); } catch { continue; }
    const links = [...page.text.matchAll(/href=["']\/subtitles\/([a-z0-9-]+)["']/g)].map((m) => m[1]);
    for (const slug of links) {
      if (!slug || slug === 'searchbytitle') continue;
      if (mediaType === 'tv' && season) {
        const wanted2 = slug + '-season-' + season;
        if (slug.includes('season') && !slug.includes('season-' + season)) continue;
        wanted.push(wanted2, slug);
      } else wanted.push(slug);
    }
    if (wanted.length) break;
  }
  const pool = [...new Set(wanted)];
  if (!pool.length) return '';
  const baseSlug = slugify(title);
  const scored = pool.map((slug) => {
    let score = 0;
    if (slug === baseSlug) score += 6;
    if (slug.startsWith(baseSlug)) score += 4;
    if (year && slug.includes(String(year))) score += 3;
    if (mediaType === 'tv' && season && slug.includes('season-' + season)) score += 3;
    if (mediaType === 'movie' && slug.includes('season')) score -= 4;
    return { slug, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0].slug : pool[0];
}

async function subf2mLanguages(slug) {
  const page = await subf2mFetch('https://subf2m.co/subtitles/' + slug);
  const langs = [...new Set([...page.text.matchAll(/href=["']\/subtitles\/[a-z0-9-]+\/([a-z-]+)["']/g)].map((m) => m[1]))];
  return langs;
}

async function subf2mList(slug, lang) {
  const page = await subf2mFetch('https://subf2m.co/subtitles/' + slug + '/' + lang, { headers: { referer: 'https://subf2m.co/subtitles/' + slug } });
  return [...page.text.matchAll(/href=["'](\/subtitles\/[a-z0-9-]+\/[a-z-]+\/\d+)["']/g)].map((m) => m[1]);
}

async function subf2mDownload(path) {
  const item = 'https://subf2m.co' + path;
  const response = await subf2mFetch(item + '/download', { headers: { referer: item } });
  if (/application\/zip/i.test(response.contentType) || (response.buffer[0] === 0x50 && response.buffer[1] === 0x4b)) {
    const unzipped = unzipFirst(response.buffer);
    return unzipped ? unzipped.text : '';
  }
  return response.text;
}

async function searchSubf2m(context, log) {
  const slug = await subf2mFindMovie(context);
  if (!slug) return [];
  let langs = [];
  try { langs = await subf2mLanguages(slug); }
  catch (error) { log && log('在线字幕 subf2m 语言页失败: ' + ((error && error.message) || error)); return []; }
  const order = ['chinese-bg-code', 'chinese-simplified', 'chinese-traditional', 'chinese', 'english', 'japanese', 'korean'];
  // 按中文优先的顺序逐个试，拿到一条就收工（并行会触发限流，反而更慢）
  const usable = order.filter((code) => langs.includes(code)).slice(0, 4);
  const found = [];
  for (const lang of usable) {
    try {
      const items = await subf2mList(slug, lang);
      if (!items.length) continue;
      found.push({ source: 'subf2m', slug, lang, label: LANG_LABELS[lang] || lang, path: items[0] });
      break;
    } catch { /* 下一个语言 */ }
  }
  return found;
}

const WBI_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

async function biliCookie() {
  return 'buvid3=' + crypto.randomUUID().toUpperCase() + 'infoc';
}

async function biliMixinKey(cookie) {
  const nav = await request('https://api.bilibili.com/x/web-interface/nav', { headers: { referer: 'https://www.bilibili.com', cookie } });
  const json = JSON.parse(nav.text);
  const img = (json?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const sub = (json?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  return WBI_TABLE.map((i) => (img + sub)[i] || '').join('').slice(0, 32);
}

function wbiSign(params, mixinKey) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all).sort()
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(all[key]).replace(/[!'()*]/g, '')))
    .join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + mixinKey).digest('hex');
}

async function searchBilibili(context) {
  const cookie = await biliCookie();
  const mixin = await biliMixinKey(cookie);
  const keyword = cleanTitle(context.title) + (context.mediaType === 'tv' && context.season ? ' 第' + context.season + '季' : '');
  const query = wbiSign({ search_type: 'video', keyword, page: 1 }, mixin);
  const result = await request('https://api.bilibili.com/x/web-interface/wbi/search/type?' + query, { headers: { referer: 'https://www.bilibili.com', cookie } });
  const json = JSON.parse(result.text);
  const list = (json?.data?.result || []).slice(0, 6);
  const out = [];
  for (const item of list) {
    const bvid = item.bvid;
    if (!bvid) continue;
    try {
      const pl = await request('https://api.bilibili.com/x/player/pagelist?bvid=' + bvid, { headers: { referer: 'https://www.bilibili.com', cookie } });
      const cid = JSON.parse(pl.text)?.data?.[0]?.cid;
      if (!cid) continue;
      const pv = await request('https://api.bilibili.com/x/player/v2?bvid=' + bvid + '&cid=' + cid, { headers: { referer: 'https://www.bilibili.com/video/' + bvid, cookie } });
      const subs = JSON.parse(pv.text)?.data?.subtitle?.subtitles || [];
      for (const sub of subs.slice(0, 2)) {
        if (!sub.subtitle_url) continue;
        out.push({ source: 'bilibili', bvid, cid, lang: sub.lan || '', label: sub.lan_doc || sub.lan || 'B 站字幕', url: sub.subtitle_url });
      }
    } catch { /* 换下一个视频 */ }
    if (out.length >= 2) break;
  }
  return out;
}

async function fetchBilibiliJson(url) {
  const absolute = url.startsWith('//') ? 'https:' + url : url;
  const response = await request(absolute, { headers: { referer: 'https://www.bilibili.com' } });
  const json = JSON.parse(response.text);
  const body = Array.isArray(json?.body) ? json.body : [];
  return body.map((line) => ({ s: Number(line.from) || 0, e: Number(line.to) || 0, t: String(line.content || '').trim() }))
    .filter((line) => line.t && line.e > line.s);
}

function createOnlineSubtitles({ log } = {}) {
  const cache = new Map();

  async function search(context = {}) {
    const key = crypto.createHash('sha1').update(JSON.stringify(context)).digest('hex').slice(0, 16);
    if (cache.has(key)) return cache.get(key);
    const started = Date.now();
    let tracks = [];
    try { tracks = await searchSubf2m(context, log); } catch (error) { log && log('在线字幕 subf2m 失败: ' + ((error && error.message) || error)); }
    if (!tracks.length) {
      try { tracks = await searchBilibili(context); } catch (error) { log && log('在线字幕 B 站失败: ' + ((error && error.message) || error)); }
    }
    const result = { ok: tracks.length > 0, tracks, ms: Date.now() - started };
    cache.set(key, result);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    log && log('在线字幕：' + (tracks.length ? tracks.length + ' 条 · ' + result.ms + 'ms' : '无匹配'));
    return result;
  }

  async function load(track = {}) {
    if (track.source === 'bilibili' && track.url) {
      const cues = await fetchBilibiliJson(track.url);
      return { ok: cues.length > 0, cues, lang: track.lang || '' };
    }
    if (track.source === 'subf2m' && track.path) {
      const text = await subf2mDownload(track.path);
      if (!text || !/-->/.test(text)) return { ok: false, cues: [], error: '字幕内容为空' };
      return { ok: true, text, lang: track.lang || '' };
    }
    return { ok: false, cues: [], error: '未知来源' };
  }

  return { search, load };
}

module.exports = { createOnlineSubtitles, decodeText, unzipFirst, cleanTitle, slugify };

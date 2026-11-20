'use strict';


const telemetry = require('./telemetry.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 8000;
const MEDIA_RE = /https?(?::|%3A)(?:\/|%2F){2}[^\s"'<>()\\]+?\.(?:m3u8|mp4|mkv|avi|flv|mpd)(?:\?[^\s"'<>()\\]*)?/i;
const MEDIA_RE_G = new RegExp(MEDIA_RE.source, 'ig');

let registerMediaHost = null;   // 由 source-compat 注入
let getSession = null;

function injectDeps({ onMediaHost, sessionGetter }) {
  if (typeof onMediaHost === 'function') registerMediaHost = onMediaHost;
  if (typeof sessionGetter === 'function') getSession = sessionGetter;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\{/g, '{').replace(/\\}/g, '}')
    .replace(/%3A/gi, ':').replace(/%2F/gi, '/')
    .replace(/&quot;/g, '"').replace(/&#47;/g, '/')
    .replace(/\\\//g, '/');
}

function extractMediaUrls(text) {
  const haystacks = [text, decodeEntities(text)];
  const found = new Set();
  for (const haystack of haystacks) {
    for (const match of haystack.matchAll(new RegExp(MEDIA_RE.source, 'ig'))) {
      found.add(match[0].replace(/\\$/, ''));
    }
    // 内嵌 JSON 提取
    for (const jsonMatch of haystack.matchAll(/player_data\s*=\s*(\{[\s\S]{10,4000}?\});|__NEXT_DATA__\s*=\s*(\{[\s\S]{10,8000}?\});/g)) {
      try {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[2]);
        const stack = [parsed];
        while (stack.length) {
          const node = stack.pop();
          if (typeof node === 'string' && MEDIA_RE.test(node)) found.add((node.match(new RegExp(MEDIA_RE.source, 'i')))[0]);
          else if (node && typeof node === 'object') {
            for (const value of Object.values(node)) {
              if (typeof value === 'string' && MEDIA_RE.test(value)) found.add((value.match(new RegExp(MEDIA_RE.source, 'i')))[0]);
              else if (value && typeof value === 'object') stack.push(value);
            }
          }
        }
      } catch { /* JSON 损坏忽略 */ }
    }
    // escape 混淆解包
    for (const escMatch of haystack.matchAll(/unescape\(\s*(['"])([\s\S]{40,2000}?)\1\s*\)/g)) {
      try {
        const decoded = decodeURIComponent(escMatch[2]);
        const hit = decoded.match(MEDIA_RE);
        if (hit) found.add(hit[0]);
      } catch { /* ignore */ }
    }
  }
  return [...found].filter((url) => /^https?:\/\//i.test(url));
}

async function fetchPage(url, extraReferer) {
  if (!getSession) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await getSession().defaultSession.fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        referer: extraReferer || `${new URL(url).origin}/`,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      }
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveV2(pageUrl, depth = 0) {
  const html = await fetchPage(pageUrl);
  if (!html) return null;
  let urls = extractMediaUrls(html);
  if (!urls.length && depth < 1) {
    // 一级 iframe 跟随
    const iframeSrc = (/iframe[^>]+src=["']([^"']+)["']/i.exec(html) || [])[1];
    if (iframeSrc && /^https?:\/\//i.test(iframeSrc)) {
      urls = extractMediaUrls((await fetchPage(iframeSrc, `${new URL(pageUrl).origin}/`)) || '');
    }
  }
  return urls[0] || null;
}

function installResolverV2(ipcMain, { getPageTextFallback } = {}) {
  try {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('player:resolveMediaUrl');
    if (typeof original !== 'function') return { wrapped: false };
    handlers.set('player:resolveMediaUrl', async (event, url) => {
      const baseline = await original(event, url).catch(() => null);
      if (baseline) return baseline;
      // 基线失败 → v2 多策略提取
      try {
        const resolved = await resolveV2(String(url || ''));
        telemetry.record('resolver.v2', { url: String(url || '').slice(0, 80), hit: Boolean(resolved) });
        if (resolved) {
          try {
            // 防盗链：解析出的播放主机用「分享页 origin」作 Referer（CDN 认的是站点 Referer）
            registerMediaHost?.(resolved, new URL(String(url)).origin);
          } catch { /* 登记失败不影响解析结果 */ }
          return resolved;
        }
      } catch (error) {
        telemetry.record('resolver.v2.error', { url: String(url || '').slice(0, 80), error: String(error?.message || error).slice(0, 80) });
      }
      return baseline;
    });
    return { wrapped: true };
  } catch { return { wrapped: false }; }
}

module.exports = { installResolverV2, resolveV2, extractMediaUrls, injectDeps };

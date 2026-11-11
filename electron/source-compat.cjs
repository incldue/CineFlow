'use strict';
/**
 * CineFlow 播放源兼容层（新增文件，零触碰外挂）。
 * 由 bootstrap.cjs 在 main.cjs 加载完成后安装；基线任何文件不做改动。
 * 能力：
 *   1. TVBox 导入 v2（包装 app:importResourceSources）：
 *      base64 整包解码 / 多仓跟随 / sites 缺 type 补默认 / type 0(XML) 与 1(JSON) 全收 /
 *      raw.sources 变体 / csp_ 爬虫与 lives 直播跳过计数 / sites[].header 登记进主机头注册表
 *   2. fetch 响应兼容层（包装 session.defaultSession.fetch，保守介入、其余直通）：
 *      MacCMS XML→基线 JSON 形状翻译（按响应体嗅探，覆盖 at/xml、api/xml.php、sapi.php、
 *      cjapi…vod/xml、api.php?ac=list 等全部路径方言 + CDATA/实体/属性式变体）/
 *      GBK・GB2312・GB18030 重解码 / 相对播放 URL 按 origin 补全
 *   3. 证书宽容：仅对「用户导入过的源主机」放行自签证书；GitHub/更新域名绝不放行
 *   4. 启动闲时对已登记源主机暖 DNS+TLS
 * 任何环节异常都保持基线行为（导入回落原 handler、fetch 直通）。
 */

const fs = require('node:fs');
const path = require('node:path');
const cacheLayer = require('./cache-layer.cjs');
const telemetry = require('./telemetry.cjs');

const REGISTRY_FILE = 'cineflow-source-compat.json';
const SNIFF_MAX_BYTES = 12 * 1024 * 1024;
const IMPORT_FETCH_TIMEOUT_MS = 12000;
const WAREHOUSE_MAX = 8;
const SAFE_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|github\.io|electronjs\.org)$/i;

const state = {
  installed: false,
  app: null,
  session: null,
  fetchThis: null,         // session.fetch 的 this 必须是 defaultSession 实例
  registryPath: '',
  sourceHosts: new Set(),  // 已导入源主机（嗅探范围 + 证书宽容名单）
  hostHeaders: new Map(),  // host -> { ua?, referer? }
  warmUrls: new Set(),     // 完整 origin（含协议），闲时暖连接用
  originalFetch: null,
  // http-only 源站学习表：host → http 直连有效期（时间戳）
  httpPreferredHosts: new Map(),
  httpFallback: { retried: 0, ok: 0 },
  originalImport: null
};

const rawFetch = (input, init) => state.originalFetch.call(state.fetchThis, input, init);

const compatLog = (...args) => {
  try { console.log('[CineFlow:Compat]', ...args); } catch { /* ignore */ }
};

/* ============ 登记文件（userData 下，独立于基线 settings.json） ============ */

function registryFile() {
  if (!state.registryPath && state.app) {
    try { state.registryPath = path.join(state.app.getPath('userData'), REGISTRY_FILE); } catch { /* ignore */ }
  }
  return state.registryPath;
}

function loadRegistry() {
  const file = registryFile();
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const host of Array.isArray(raw.sourceHosts) ? raw.sourceHosts : []) {
      if (typeof host === 'string' && host) state.sourceHosts.add(host.toLowerCase());
    }
    for (const [host, headers] of Object.entries(raw.hostHeaders || {})) {
      if (headers && typeof headers === 'object') state.hostHeaders.set(String(host).toLowerCase(), headers);
    }
    for (const origin of Array.isArray(raw.warmUrls) ? raw.warmUrls : []) {
      if (typeof origin === 'string' && /^https?:\/\//i.test(origin)) state.warmUrls.add(origin);
    }
  } catch { /* 首次无文件或损坏 → 空注册表 */ }
}

function saveRegistry() {
  const file = registryFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      sourceHosts: [...state.sourceHosts].slice(0, 400),
      hostHeaders: Object.fromEntries([...state.hostHeaders].slice(0, 400)),
      warmUrls: [...state.warmUrls].slice(0, 400)
    }, null, 2));
  } catch { /* ignore */ }
}

function registerSourceEntry(api, headers) {
  let url;
  try { url = new URL(api); } catch { return; }
  const host = url.hostname.toLowerCase();
  if (!host) return;
  state.sourceHosts.add(host);
  state.warmUrls.add(`${url.protocol}//${url.host}`);
  if (headers && (headers.ua || headers.referer)) state.hostHeaders.set(host, headers);
}

/* ============ base64 / 文本工具 ============ */

function maybeBase64Decode(text) {
  const compact = String(text || '').replace(/^\uFEFF/, '').trim().replace(/\s+/g, '');
  if (compact.length < 64) return null;
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(compact)) return null;
  let decoded;
  try {
    decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const trimmed = decoded.replace(/^\uFEFF/, '').trim();
  return trimmed[0] === '{' || trimmed[0] === '[' ? trimmed : null;
}

function decodeEntity(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function stripCdata(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeSmart(buffer, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const declared = (/charset=([\w-]+)/.exec(ct) || [])[1] || '';
  if (declared && /gb/i.test(declared)) {
    for (const enc of [declared, 'gb18030']) {
      try { return new TextDecoder(enc).decode(buffer); } catch { /* 引擎缺该编码则继续 */ }
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (declared && !/^utf-?8$/i.test(declared)) return utf8;
  if (!utf8.includes('\uFFFD')) return utf8;
  // 服务器声明 utf-8 但实际是 GBK（乱码嗅探）：取替换符更少的一种
  try {
    const gbk = new TextDecoder('gb18030').decode(buffer);
    const badUtf8 = (utf8.match(/\uFFFD/g) || []).length;
    const badGbk = (gbk.match(/\uFFFD/g) || []).length;
    if (badGbk < badUtf8) return gbk;
  } catch { /* ignore */ }
  return utf8;
}

/* ============ MacCMS XML → 基线 JSON 形状 ============ */

function isMaccmsXmlText(text) {
  const body = String(text || '').trimStart();
  if (!body.startsWith('<')) return false;
  const probe = body.slice(0, 8000).toLowerCase();
  if (!(/<rss[\s>]/.test(probe) || probe.startsWith('<?xml') || /<list[\s>]/.test(probe))) return false;
  return /<video[\s>]/i.test(probe) || (/<list[\s>]/i.test(probe) && /<video[\s>]/i.test(body));
}

function parseTagAttrs(tagText) {
  const attrs = {};
  for (const match of String(tagText || '').matchAll(/([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1].toLowerCase()] = decodeEntity(match[2]);
  }
  return attrs;
}

function resolveUrl(raw, base) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(?:https?:)?\/\//i.test(value)) {
    if (value.startsWith('//') && base) return `${base.protocol}${value}`;
    return value;
  }
  if (!/^(?:https?:)/i.test(value) && base) {
    try { return new URL(value, base).toString(); } catch { return value; }
  }
  return value;
}

function completePlayUrls(playUrlText, base) {
  return String(playUrlText || '').split('$$$').map((group) => (
    String(group || '').split('#').map((segment) => {
      const clean = segment.trim();
      if (!clean) return clean;
      const dollar = clean.lastIndexOf('$');
      if (dollar <= 0) return resolveUrl(clean, base);
      return `${clean.slice(0, dollar)}$${resolveUrl(clean.slice(dollar + 1), base)}`;
    }).join('#')
  )).join('$$$');
}

function xmlVideoToItem(videoBody, videoAttrs, baseUrl) {
  const fields = {};
  const body = stripCdata(videoBody).replace(/<dl[\s\S]*?<\/dl>/gi, '');
  for (const match of body.matchAll(/<([a-zA-Z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    const key = match[1].toLowerCase();
    const value = decodeEntity(match[2]).trim();
    if (!(key in fields) || (value && !fields[key])) fields[key] = value;
  }
  for (const [key, value] of Object.entries(videoAttrs)) {
    if (!(key in fields) || !fields[key]) fields[key] = decodeEntity(value);
  }

  // 播放分组：dl > dd（flag=线路名，正文=集1$url#集2$url）
  const flags = [];
  const groups = [];
  for (const dlMatch of stripCdata(videoBody).matchAll(/<dl[^>]*>([\s\S]*?)<\/dl>/gi)) {
    for (const ddMatch of dlMatch[1].matchAll(/<dd([^>]*)>([\s\S]*?)<\/dd>/gi)) {
      const attrs = parseTagAttrs(ddMatch[1]);
      const flag = String(attrs.flag || '').split('$')[0].trim() || `线路 ${groups.length + 1}`;
      const text = decodeEntity(ddMatch[2]).trim();
      if (!text) continue;
      flags.push(flag);
      groups.push(text);
    }
  }

  const id = String(fields.id || fields.vod_id || '').trim();
  if (!id) return null;
  const playFrom = flags.join('$$$') || '默认线路';
  const playUrl = completePlayUrls(groups.join('$$$'), baseUrl);
  const item = {
    vod_id: id,
    vod_name: String(fields.name || fields.vod_name || '').trim(),
    type_name: String(fields.type || fields.vod_class || '').trim(),
    vod_class: String(fields.type || '').trim(),
    vod_year: String(fields.year || fields.vod_year || '').trim(),
    vod_remarks: String(fields.note || fields.state || fields.vod_remarks || '').trim(),
    vod_pic: resolveUrl(fields.pic || fields.vod_pic || '', baseUrl),
    vod_time: String(fields.last || fields.vod_time || '').trim(),
    vod_actor: String(fields.actor || fields.vod_actor || '').trim(),
    vod_director: String(fields.director || fields.vod_director || '').trim(),
    vod_content: String(fields.des || fields.content || fields.vod_content || '').trim(),
    vod_play_from: playFrom,
    vod_play_url: playUrl
  };
  return item.vod_name ? item : null;
}

function xmlToVodJson(xmlText, baseUrl) {
  const xml = String(xmlText || '').replace(/<!--[\s\S]*?-->/g, '');
  // 分页元数据在 <list page=".." recordcount=".."> 上（rss 标签上没有）
  const listAttrs = (/<list\b([^>]*)>/i.exec(xml) || /<rss\b([^>]*)>/i.exec(xml) || [])[1] || '';
  const listMeta = parseTagAttrs(listAttrs);
  const list = [];
  const videoRe = /<video\b([^>]*)>([\s\S]*?)<\/video>/gi;
  for (const match of xml.matchAll(videoRe)) {
    const attrs = parseTagAttrs(match[1]);
    const item = xmlVideoToItem(match[2], attrs, baseUrl);
    if (item) list.push(item);
    if (list.length >= 200) break;
  }
  return {
    code: 1,
    msg: '数据列表',
    page: Number(listMeta.page) || 1,
    pagecount: Number(listMeta.pagecount) || 1,
    limit: Number(listMeta.pagesize || listMeta.limit) || 20,
    total: Number(listMeta.recordcount || listMeta.total) || list.length,
    list
  };
}

/* ============ fetch 响应兼容层 ============ */

// http-only 源站兼容：部分 CMS 源站 443 被重置/证书不可用而 80 正常
// （实测内置如意 cj.rycjapi.com：https → ECONNRESET，http → 200）。
// 已知提示域直接回退；导入源主机遇到「重置类」传输错误时自适应学习，30 分钟内直走 http。
const HTTP_ONLY_HINT_HOSTS = new Set(['cj.rycjapi.com']);
const HTTP_FALLBACK_TTL_MS = 30 * 60 * 1000;
const RST_CLASS_ERROR_RE = /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|SSL_PROTOCOL_ERROR|EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)/i;

function buildHttpTwinTarget(input, urlText) {
  const twin = new URL(urlText);
  twin.protocol = 'http:';
  const twinText = twin.toString();
  if (typeof input === 'string' || input instanceof URL) return twinText;
  if (input && typeof input === 'object' && typeof input.method === 'string' && !input.body) {
    try { return new Request(twinText, { method: input.method, headers: input.headers }); } catch { return null; }
  }
  return null;
}

function hostOf(value) {
  try { return new URL(String(value)).hostname.toLowerCase(); } catch { return ''; }
}

function isRegisteredHost(host) {
  return state.sourceHosts.has(host) || state.sourceHosts.has(host.replace(/^www\./i, ''));
}

async function compatFetch(input, init) {
  if (!state.originalFetch) return rawFetch(input, init);

  const requestUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
  let url;
  try { url = new URL(requestUrl); } catch { return rawFetch(input, init); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return rawFetch(input, init);
  }
  const host = url.hostname.toLowerCase();

  // 主机头注册表：防盗链 UA/Referer 注入（分片请求与 API 请求同样生效）
  let finalInit = init;
  const headers = state.hostHeaders.get(host);
  if (headers && (headers.ua || headers.referer)) {
    try {
      const merged = new Headers((init && init.headers) || (input && input.headers) || undefined);
      if (headers.ua && !merged.has('user-agent')) merged.set('user-agent', headers.ua);
      if (headers.referer && !merged.has('referer')) merged.set('referer', headers.referer);
      finalInit = { ...(init || {}), headers: merged };
    } catch { /* 头合并失败按原样发出 */ }
  }

  // 注：segment-cache 分片磁盘缓存已按「完全对齐 3.4.4 网络行为」要求撤出（不再读写响应体）。
  // http-only 学习命中 / 已知提示域：直接用 http 双胞胎发起（省一次注定 RST 的 https 往返）
  const httpPreferred = (state.httpPreferredHosts.get(host) || 0) > Date.now();
  let requestTarget = input;
  if (url.protocol === 'https:' && (httpPreferred || HTTP_ONLY_HINT_HOSTS.has(host))) {
    const twin = buildHttpTwinTarget(input, url.toString());
    if (twin !== null) requestTarget = twin;
  }

  let response;
  try {
    response = await rawFetch(requestTarget, finalInit);
  } catch (error) {
    const rstLike = RST_CLASS_ERROR_RE.test(String((error && error.message) || error));
    const twinable = url.protocol === 'https:'
      && requestTarget === input
      && (HTTP_ONLY_HINT_HOSTS.has(host) || isRegisteredHost(host));
    if (!rstLike || !twinable) throw error;
    // https 被「重置类」传输错误终结 → http 双胞胎重试一次（如意类 http-only 源站）
    const retryTarget = buildHttpTwinTarget(input, url.toString());
    if (retryTarget === null) throw error;
    state.httpFallback.retried += 1;
    try {
      const retried = await rawFetch(retryTarget, finalInit);
      state.httpPreferredHosts.set(host, Date.now() + HTTP_FALLBACK_TTL_MS);
      state.httpFallback.ok += 1;
      compatLog(`http-only 回退命中: ${host}`);
      response = retried;
    } catch {
      throw error; // 双胞胎同样失败：保留原始错误语义（与基线一致）
    }
  }
  try {
    if (!response || !response.ok) return response;
    const contentType = String(response.headers.get('content-type') || '');
    const lower = contentType.toLowerCase();
    if (/^(?:video|audio)\//.test(lower) || /mpegurl|dash\+xml|mp2t|octet-stream/.test(lower)) return response;
    if (/json/.test(lower) && !/gb2312|gbk|gb18030/.test(lower)) return response;

    const xmlCt = /xml/.test(lower);
    const gbkCt = /gb2312|gbk|gb18030/.test(lower);
    const textCt = /text\/|javascript/.test(lower) || !contentType;
    const registered = isRegisteredHost(host);
    // 已登记源主机的 JSON 响应也嗅探：兜住「声明 json 实际给 XML」与「GBK 无 charset」两类坑
    if (!xmlCt && !gbkCt && !(registered && (textCt || /json/.test(lower)))) return response;

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > SNIFF_MAX_BYTES) return response;

    let buffer;
    try { buffer = await response.arrayBuffer(); } catch { return response; }
    if (buffer.byteLength > SNIFF_MAX_BYTES) return response;

    const text = decodeSmart(buffer, contentType);
    if (isMaccmsXmlText(text)) {
      const json = xmlToVodJson(text, url);
      const out = new Headers(response.headers);
      out.set('content-type', 'application/json; charset=utf-8');
      out.set('x-cineflow-compat', 'maccms-xml');
      return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: out });
    }
    // GBK 修正（无 XML 时原样返回修正后的文本）
    const out = new Headers(response.headers);
    if (/charset=/i.test(String(out.get('content-type') || ''))) {
      out.set('content-type', String(out.get('content-type')).replace(/charset=[\w-]+/i, 'charset=utf-8'));
    } else {
      out.set('content-type', `${contentType || 'text/plain'}; charset=utf-8`);
    }
    out.set('x-cineflow-compat', 'charset-fix');
    return new Response(text, { status: response.status, statusText: response.statusText, headers: out });
  } catch (error) {
    compatLog('响应兼容层异常（按原响应返回）:', error && error.message);
    return response;
  }
}

/* ============ TVBox 导入 v2 ============ */

function extractHeaders(entry) {
  const raw = entry && (entry.header || entry.headers);
  if (!raw || typeof raw !== 'object') return null;
  let ua = '';
  let referer = '';
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    if (/^user.?agent$/i.test(key)) ua = value;
    else if (/^ref(erer)?$/i.test(key)) referer = value;
  }
  return ua || referer ? { ua, referer } : null;
}

/* ---- AppYsV2 类爬虫源伪 JSON 化 ----
 * TVBox 生态里最大的一类 type=3 爬虫（csp_AppYsV2/AppYs）本质是 App 端点：
 * ext 字段持有 app 基址（直链 URL / base64 / JSON 配置三种形态），
 * 请求形如 {base}/api.php/app/vod?ac=videolist&wd=…、?ac=detail&ids=…，
 * 响应与 MacCMS JSON 同形 —— 解析出端点后即可当普通 JSON 源走现有管线。 */
function decodeExtJson(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9+/\-_]+={0,2}$/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
    return decoded.startsWith('{') ? decoded : null;
  } catch {
    return null;
  }
}

function resolveAppYsApi(entry) {
  const api = String(entry?.api || '').trim();
  const ext = String(entry?.ext ?? '').trim();
  let base = '';
  if (/^csp_AppYs/i.test(api)) {
    base = ext;
  } else if (/^https?:\/\//i.test(api) && /\/api\.php\/(?:app|v3)\/vod/i.test(api)) {
    return api;                                            // api 本身已是 AppV2 端点
  } else {
    return null;
  }
  if (!base) return null;
  const decoded = decodeExtJson(base);
  if (decoded) {
    try { const parsed = JSON.parse(decoded); base = String(parsed.api || parsed.url || ''); } catch { /* 保持原值 */ }
  } else if (base.startsWith('{')) {
    try { const parsed = JSON.parse(base); base = String(parsed.api || parsed.url || ''); } catch { /* 保持原值 */ }
  }
  if (!/^https?:\/\//i.test(base)) return null;
  base = base.replace(/\/+$/, '');
  if (/\/api\.php\/(?:app|v3)\/vod/i.test(base)) return base;
  return `${base}/api.php/app/vod`;
}

function convertSites(siteList) {
  const entries = [];
  const seen = new Set();
  let skippedSpider = 0;
  let skippedOther = 0;
  let convertedAppYs = 0;
  let sawTvBox = false;
  for (const entry of siteList) {
    if (!entry || typeof entry !== 'object') continue;
    const api = String(entry.api || entry.url || '').trim();
    const type = entry.type === undefined ? '' : String(entry.type).trim();
    if (api || type !== '') sawTvBox = true;
    const appYsApi = resolveAppYsApi(entry);
    if (appYsApi) {
      if (seen.has(appYsApi)) continue;
      seen.add(appYsApi);
      convertedAppYs += 1;
      entries.push({ name: String(entry.name || entry.key || '').trim(), api: appYsApi, headers: extractHeaders(entry) });
      continue;
    }
    if (/^csp_/i.test(api) || type === '3' || /^jar:/i.test(api)) { skippedSpider += 1; continue; }
    if (!/^https?:\/\//i.test(api)) { if (api) skippedOther += 1; continue; }
    if (type !== '' && type !== '0' && type !== '1') { skippedOther += 1; continue; }
    if (seen.has(api)) continue;
    seen.add(api);
    entries.push({ name: String(entry.name || entry.key || '').trim(), api, headers: extractHeaders(entry) });
  }
  return { entries, skippedSpider, skippedOther, sawTvBox, convertedAppYs };
}

function extractSiteArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.sites)) return parsed.sites;
    if (Array.isArray(parsed.sources)) return parsed.sources;
  }
  return null;
}

function extractWarehouses(parsed) {
  // 单仓优先：带 type 的 sites/sources 存在时按单仓处理，不当作多仓
  const siteList = extractSiteArray(parsed);
  if (siteList && siteListHasTypes(siteList)) return [];
  // 多仓形态：[{sourceName, sourceUrl}] / {storeHouse:[…]} / {urls:[…]} / ['url', …]
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.storeHouse)) list = parsed.storeHouse;
    else if (Array.isArray(parsed.urls)) list = parsed.urls;
  }
  if (!list || !list.length) return [];
  const urls = [];
  for (const entry of list) {
    if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) urls.push(entry);
    else if (entry && typeof entry === 'object') {
      const url = String(entry.sourceUrl || entry.url || '').trim();
      if (/^https?:\/\//i.test(url)) urls.push(url);
    }
  }
  return urls;
}

function siteListHasTypes(siteList) {
  return siteList.some((entry) => entry && typeof entry === 'object' && entry.type !== undefined);
}

async function fetchConfigText(url) {
  if (!state.session || !state.originalFetch) return null;
  // 首个请求可能吃满系统代理冷启动（实测可达 15s+，超过基线 10s 超时）——首试放宽到 25s，
  // 失败后重试一次，第二次走已预热的连接通常秒回
  const attempts = [25000, IMPORT_FETCH_TIMEOUT_MS];
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attempts[attempt]);
    try {
      const response = await rawFetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'application/json, text/plain, */*',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/3.4.8'
        }
      });
      if (!response.ok) {
        compatLog(`配置拉取 HTTP ${response.status}: ${url}`);
        if (attempt === 0) continue;
        return null;
      }
      const buffer = await response.arrayBuffer();
      return decodeSmart(buffer, response.headers.get('content-type') || '');
    } catch (error) {
      if (attempt === 0) continue;
      compatLog(`配置拉取失败（交基线处理）: ${url} · ${error && error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function mergeConvert(target, converted) {
  for (const entry of converted.entries) {
    if (target.seen.has(entry.api)) continue;
    target.seen.add(entry.api);
    target.entries.push(entry);
  }
  target.skippedSpider += converted.skippedSpider;
  target.skippedOther += converted.skippedOther;
}

async function translateImportPayload(raw, depth = 0) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text || text.length > 4 * 1024 * 1024) return { passthrough: true };

  // 配置地址：自己拉（不受基线内部 fetch 实现影响），拉不到则交基线走原路径报错
  if (depth < 3 && /^https?:\/\//i.test(text) && !/\s/.test(text)) {
    const fetched = await fetchConfigText(text);
    if (fetched == null) return { passthrough: true };
    return translateImportPayload(fetched, depth + 1);
  }

  let decoded = text;
  const b64 = maybeBase64Decode(text);
  if (b64) decoded = b64;

  let parsed = null;
  try { parsed = JSON.parse(decoded); } catch { return { passthrough: true }; }

  // 多仓：跟随拉取各仓配置后合并（深度限制防环）
  const warehouses = extractWarehouses(parsed);
  if (warehouses.length && depth < 3) {
    const merged = { entries: [], seen: new Set(), skippedSpider: 0, skippedOther: 0 };
    const results = await Promise.allSettled(
      warehouses.slice(0, WAREHOUSE_MAX).map((url) => translateImportPayload(url, depth + 1))
    );
    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value.passthrough) continue;
      mergeConvert(merged, result.value.converted);
    }
    if (!merged.entries.length) return { passthrough: true };
    return finishTranslate(merged);
  }

  const siteList = extractSiteArray(parsed);
  if (siteList) {
    const converted = convertSites(siteList);
    if (converted.entries.length) {
      return finishTranslate({
        entries: converted.entries,
        seen: new Set(),
        skippedSpider: converted.skippedSpider,
        skippedOther: converted.skippedOther
      });
    }
    if (converted.sawTvBox) {
      const error = new Error(
        `TVBox 配置里没有可直接播放的接口源（爬虫源 ${converted.skippedSpider} 条、不可识别 ${converted.skippedOther} 条已跳过；csp_/jar 类源需要 TVBox 爬虫引擎，暂不支持）。`
      );
      error.code = 'INVALID_RESOURCE_SOURCE_CONFIG';
      error.tvboxOnly = true;
      throw error;
    }
    // 无 type 字段的普通数组（如“名称|接口”来源的 JSON）→ 交基线
    return { passthrough: true };
  }

  // 单对象 {name, api} 之类：基线自己就认得
  return { passthrough: true };
}

function finishTranslate(merged) {
  const notes = [`已解析 ${merged.entries.length} 条接口源`];
  if (merged.convertedAppYs) notes.push(`AppYsV2 爬虫源转换 ${merged.convertedAppYs} 条`);
  if (merged.skippedSpider) notes.push(`跳过爬虫源 ${merged.skippedSpider} 条`);
  if (merged.skippedOther) notes.push(`跳过不可识别 ${merged.skippedOther} 条`);
  return {
    passthrough: false,
    entries: merged.entries.map(({ name, api, headers }) => ({ name, api, headers })),
    note: `${notes.join('，')}`
  };
}

/* ============ 播放主机防盗链登记（代理上游自动带对 Referer） ============
 * 解析器/聚合层发现「播放主机」时调用：host ← { referer: 页面/源站 origin }。
 * 仅内存登记（不落盘、不覆盖用户导入的显式头），代理上游清单/密钥/分片请求
 * 经 compatFetch 自动注入。 */
function registerMediaHost(url, referer) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    if (!host || !referer) return false;
    const existing = state.hostHeaders.get(host);
    if (existing?.referer) return false;                 // 已有显式 referer 不覆盖
    state.hostHeaders.set(host, { ...(existing || {}), referer: String(referer) });
    state.warmUrls.add(`${new URL(String(url)).protocol}//${host}`);
    return true;
  } catch {
    return false;
  }
}

/* ============ 证书宽容（仅已导入源主机） ============ */

function installCertificateTolerance(app) {
  app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    const host = hostOf(url);
    let allow = false;
    if (host && state.sourceHosts.has(host) && !SAFE_HOST_RE.test(host)) allow = true;
    try {
      event.preventDefault();
      callback(allow);
    } catch { /* 回调异常时保持默认拒绝 */ }
  });
}

/* ============ 启动闲时暖连接 ============ */

function scheduleWarmup(session) {
  const run = () => {
    const origins = [...state.warmUrls].slice(0, 12);
    if (!origins.length) return;
    compatLog(`闲时预热 ${origins.length} 个已导入源主机（DNS/TLS）`);
    const queue = origins.slice();
    const worker = async () => {
      while (queue.length) {
        const origin = queue.shift();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          await rawFetch(`${origin}/favicon.ico`, {
            method: 'GET',
            headers: { range: 'bytes=0-0' },
            cache: 'no-store',
            signal: controller.signal
          });
        } catch { /* 暖连接失败不影响任何功能 */ }
        finally { clearTimeout(timer); }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
  };
  setTimeout(run, 9000).unref?.();
}

/* ============ 片库豆瓣路径换血：browseHint + douban:hot 改写 + rexxar 年份元数据 ============
 * 根因：基线 fetchDoubanMovies 读错属性名导致 tag 恒为「热门」，渲染层接管重绘又会闪屏。
 * 方案：注入层在捕获阶段把片库筛选状态写入 hint（先于基线请求），本处改写 douban:hot 的
 * tag —— 基线自己渲染正确列表，双渲染/闪屏从根上消失。
 * 首页豆瓣轨道指纹：pageSize===18 && pageStart===0（全应用唯一，恒「热门」，绝不改写）。 */

const BROWSE_HINT_TTL_MS = 60 * 1000;
const META_TTL_MS = 10 * 60 * 1000;
const META_MAX = 60;
const META_GAP_MS = 320;
const META_TIMEOUT_MS = 8000;
const DOUBAN_UA_LOCAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const browseHintState = { data: null, at: 0 };
const doubanMetaCache = cacheLayer.createCache({ namespace: 'compat.douban', ttlMs: META_TTL_MS, max: META_MAX });
let doubanMetaLastAt = 0;

function setBrowseHint(payload) {
  const media = String(payload?.media || '');
  const genre = String(payload?.genre || '').slice(0, 20);
  if (!media && !genre) return { ok: false };
  browseHintState.data = {
    media,
    genre,
    sort: String(payload?.sort || ''),
    year: String(payload?.year || '')
  };
  browseHintState.at = Date.now();
  return { ok: true };
}

function isHomeRailHot(payload) {
  return Number(payload?.pageSize) === 18 && Number(payload?.pageStart || 0) === 0;
}

function rewriteHotPayload(payload = {}) {
  if (isHomeRailHot(payload)) return payload;
  const fresh = browseHintState.data && Date.now() - browseHintState.at < BROWSE_HINT_TTL_MS;
  const tag = String(payload.tag || '热门');
  if (!fresh || tag !== '热门') return payload;
  const genre = browseHintState.data.genre;
  if (!genre || genre === '全部') return payload;
  return { ...payload, tag: genre };
}

async function fetchDoubanMeta(type, tag) {
  const safeTag = String(tag || '热门').slice(0, 20);
  const cacheKey = `${type}:${safeTag}`;
  const hit = doubanMetaCache.get(cacheKey);
  if (hit) return hit.value;
  const wait = Math.max(0, doubanMetaLastAt + META_GAP_MS - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  doubanMetaLastAt = Date.now();
  const typeWord = type === 'tv' ? '剧集' : '电影';
  const target = `https://m.douban.com/rexxar/api/v2/subject/recommend?tags=${encodeURIComponent(`${safeTag},${typeWord}`)}&sort=T`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const response = await rawFetch(target, {
      signal: controller.signal,
      headers: {
        'user-agent': DOUBAN_UA_LOCAL,
        referer: 'https://m.douban.com/',
        origin: 'https://m.douban.com',
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    const items = Array.isArray(data?.items) ? data.items : [];
    const map = new Map();
    for (const item of items) {
      const id = String(item?.id ?? '') || (/\b(\d{5,})\b/.exec(String(item?.uri || '')) || [])[1] || '';
      const year = String(item?.year || '').slice(0, 4);
      if (id) map.set(id, year);
    }
    if (map.size) {
      doubanMetaCache.set(cacheKey, map);
    }
    return map;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function installDoubanHotRewrite(ipcMain) {
  try {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('douban:hot');
    if (typeof original !== 'function') {
      compatLog('未找到 douban:hot，片库 tag 改写未启用');
      return;
    }
    handlers.set('douban:hot', async (event, payload) => {
      let rewritten = payload;
      let tagChanged = false;
      try {
        const rewritten = rewriteHotPayload(payload);
        tagChanged = rewritten !== payload && rewritten.tag !== payload?.tag;
        if (tagChanged) {
          compatLog(`豆瓣片库 tag 改写: ${payload?.tag} → ${rewritten.tag}（type=${rewritten.type} size=${rewritten.pageSize}）`);
          telemetry.record('douban.hot.rewrite', { from: payload?.tag, to: rewritten.tag, type: rewritten.type });
        }
      } catch (error) {
        compatLog('douban:hot 改写异常，原参数直通:', error && error.message);
        return original(event, payload);
      }
      try {
        const result = await original(event, rewritten);
        // 稳定性兜底：改写后的 tag 在豆瓣没有结果（冷门标签/限流）时回落「热门」，
        // 保证基线永远拿得到列表——宁可靠近热门也不出现「加载失败」
        const empty = !result?.ok || !Array.isArray(result?.items) || !result.items.length;
        if (tagChanged && empty) {
          compatLog(`豆瓣 tag「${rewritten.tag}」无结果，回落「${payload?.tag}」`);
          telemetry.count('douban.hot.fallback');
          return await original(event, payload);
        }
        return result;
      } catch (error) {
        if (tagChanged) {
          try { return await original(event, payload); } catch { /* 两路都失败 → 抛第一路错误 */ }
        }
        throw error;
      }
    });
  } catch (error) {
    compatLog('douban:hot 包装失败:', error && error.message);
  }
}

/* ============ 内置播放源扩充（零触碰）============
 * 基线 RESOURCE_SOURCES 在 main.cjs 内不可改；此处包装 app:getResourceSettings，
 * 把新增源以 builtin 身份追加进 sources（片源管理面板、聚合引擎轮询、测速全部自然生效）。
 * 追加在列表尾部，不打乱「自定义源优先」的既有顺序；轮询/过滤预算维持基线不变。 */
const EXTRA_BUILTIN_SOURCES = [
  { key: '1080zyk', name: '1080', api: 'https://api.1080zyku.com/inc/apijson.php/', modes: ['stable', 'movie', 'full'] },
  { key: 'aqyzy', name: '爱奇艺', api: 'https://iqiyizyapi.com/api.php/provide/vod/', modes: ['stable', 'movie', 'full'] },
  { key: 'myzy', name: '猫眼', api: 'https://api.maoyanapi.top/api.php/provide/vod/', modes: ['stable', 'movie', 'full'] }
];

function withExtraBuiltinSources(settings) {
  if (!settings || !Array.isArray(settings.sources)) return settings;
  const existing = new Set(settings.sources.map((source) => source.api));
  const additions = [];
  for (const source of EXTRA_BUILTIN_SOURCES) {
    if (existing.has(source.api)) continue;
    additions.push({
      key: source.key,
      name: source.name,
      api: source.api,
      modes: [...source.modes],
      enabled: true,
      origin: 'builtin',
      note: ''
    });
  }
  if (!additions.length) return settings;
  return {
    ...settings,
    sources: [...settings.sources, ...additions],
    sourceCount: (Number(settings.sourceCount) || 0) + additions.length,
    builtInSourceCount: (Number(settings.builtInSourceCount) || 0) + additions.length
  };
}

function installExtraBuiltinSources(ipcMain) {
  try {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('app:getResourceSettings');
    if (typeof original !== 'function') {
      compatLog('未找到 app:getResourceSettings，内置源扩充未启用');
      return;
    }
    handlers.set('app:getResourceSettings', async (event) => {
      try {
        return withExtraBuiltinSources(await original(event));
      } catch (error) {
        return original(event);
      }
    });
    compatLog(`内置播放源扩充 +${EXTRA_BUILTIN_SOURCES.length}（${EXTRA_BUILTIN_SOURCES.map((s) => s.name).join('/')}）`);
  } catch (error) {
    compatLog('内置源扩充安装失败:', error && error.message);
  }
}

/* ============ 豆瓣原生分类（rexxar recent_hot，x1ao4/douban-api 同款底层） ============
 * 豆瓣移动端「最近热门」接口：recent_hot/{movie|tv}?start&limit&category&type
 *   movie: category ∈ 热门/最新/豆瓣高分/冷门佳片, type ∈ 全部/华语/欧美/韩国/日本
 *   tv:    category ∈ tv/show, type ∈ tv/tv_domestic/tv_american/tv_japanese/
 *          tv_korean/tv_animation/tv_documentary | show/show_domestic/show_foreign
 * 归一化为与 j/search_subjects items 同形状，供渲染层豆瓣分类直接消费。 */

const RECENT_HOT_TIMEOUT_MS = 8000;

async function fetchDoubanRecentHot(payload = {}) {
  const kind = payload?.kind === 'tv' ? 'tv' : 'movie';
  const start = Math.max(0, Number(payload?.start) || 0);
  const limit = Math.min(50, Math.max(1, Number(payload?.limit) || 50));
  const params = new URLSearchParams({ start: String(start), limit: String(limit) });
  if (payload?.category) params.set('category', String(payload.category).slice(0, 12));
  if (payload?.type && String(payload.type) !== '全部') params.set('type', String(payload.type).slice(0, 24));
  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?${params.toString()}`;
  const cacheKey = target;
  const hit = doubanMetaCache.get(cacheKey);
  if (hit) return hit.value;
  const wait = Math.max(0, doubanMetaLastAt + META_GAP_MS - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  doubanMetaLastAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECENT_HOT_TIMEOUT_MS);
  try {
    const response = await rawFetch(target, {
      signal: controller.signal,
      headers: {
        'user-agent': DOUBAN_UA_LOCAL,
        referer: 'https://m.douban.com/',
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    const rawItems = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.subjects) ? data.subjects : []);
    const items = rawItems.map((item) => {
      const id = String(item?.id ?? '') || (/\b(\d{5,})\b/.exec(String(item?.uri || '')) || [])[1] || '';
      const subtitle = String(item?.card_subtitle || '');
      return {
        id,
        title: String(item?.title || '').trim(),
        cover: String(item?.pic?.large || item?.pic?.normal || '').replace(/^http:\/\//i, 'https://'),
        rating: item?.rating?.value ? String(item.rating.value) : '',
        year: (/(19|20)\d{2}/.exec(subtitle) || [])[0] || '',
        mediaType: kind === 'tv' ? 'tv' : 'movie'
      };
    }).filter((item) => item.id && item.title);
    const result = { ok: true, items, total: Number(data?.total) || items.length };
    if (items.length) {
      doubanMetaCache.set(cacheKey, result);
    }
    telemetry.record('douban.recentHot', { kind, category: payload?.category || '', items: items.length });
    return result;
  } catch (error) {
    return { ok: false, error: error?.message || 'rexxar 请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

function installBrowseChannels(ipcMain) {
  try {
    if (typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('rec:browseHint')) {
      ipcMain.handle('rec:browseHint', (_event, payload) => setBrowseHint(payload));
    }
    if (!ipcMain._invokeHandlers.get('rec:doubanMeta')) {
      ipcMain.handle('rec:doubanMeta', (_event, payload = {}) => fetchDoubanMeta(payload?.type, payload?.tag));
    }
    if (!ipcMain._invokeHandlers.get('rec:doubanRecentHot')) {
      ipcMain.handle('rec:doubanRecentHot', (_event, payload = {}) => fetchDoubanRecentHot(payload));
    }
  } catch (error) {
    compatLog('browse 通道注册失败:', error && error.message);
  }
}

function installSourceCompat({ app, ipcMain, session }) {
  if (state.installed || !app || !ipcMain || !session) return false;
  state.installed = true;
  state.app = app;
  state.session = session;

  loadRegistry();

  // 1. 导入 v2（立即安装：不触碰 session，ready 前也可安全装载）
  try {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('app:importResourceSources');
    if (typeof original === 'function') {
      state.originalImport = original;
      handlers.set('app:importResourceSources', async (event, raw) => {
        if (typeof raw !== 'string') return original(event, raw);
        try {
          const translated = await translateImportPayload(raw);
          if (translated.passthrough) return original(event, raw);
          for (const entry of translated.entries) registerSourceEntry(entry.api, entry.headers);
          saveRegistry();
          const result = await original(event, JSON.stringify(
            translated.entries.map(({ name, api }) => ({ name, api }))
          ));
          compatLog('TVBox 导入 v2:', translated.note);
          return { ...(result || {}), compatNote: translated.note };
        } catch (error) {
          if (error && error.tvboxOnly) throw error;
          compatLog('导入翻译失败，回落基线导入:', error && error.message);
          return original(event, raw);
        }
      });
    } else {
      compatLog('未找到 app:importResourceSources，导入 v2 未启用');
    }
  } catch (error) {
    compatLog('导入 v2 安装失败:', error && error.message);
  }

  // 2. 证书宽容（立即安装）
  try { installCertificateTolerance(app); } catch (error) { compatLog('证书宽容安装失败:', error && error.message); }

  // 2.5 片库豆瓣路径换血：browse 通道 + douban:hot tag 改写
  try { installBrowseChannels(ipcMain); } catch (error) { compatLog('browse 通道安装失败:', error && error.message); }
  try { installDoubanHotRewrite(ipcMain); } catch (error) { compatLog('douban:hot 包装失败:', error && error.message); }
  try { installExtraBuiltinSources(ipcMain); } catch (error) { compatLog('内置源扩充失败:', error && error.message); }

  // 3. fetch 响应兼容层 + 暖连接：session.defaultSession 在 ready 前不可得（Electron 33），
  //    必须推迟到 ready；此时尚未轮到 meta-server 打补丁，链式顺序与基线一致
  try {
    (app.isReady() ? Promise.resolve() : app.whenReady()).then(() => {
      try {
        const defaultSession = session.defaultSession;
        state.fetchThis = defaultSession;
        state.originalFetch = defaultSession.fetch;
        defaultSession.fetch = function compatFetchEntry(input, init) {
          try {
            return compatFetch(input, init);
          } catch (error) {
            compatLog('fetch 兼容层异常（直通）:', error && error.message);
            return rawFetch(input, init);
          }
        };
        compatLog('fetch 响应兼容层已挂载（XML翻译/GBK/相对URL/防盗链头）');
      } catch (error) {
        compatLog('fetch 层安装失败（基线行为不受影响）:', error && error.message);
      }
      try { scheduleWarmup(session); } catch { /* ignore */ }
    }).catch(() => {});
  } catch { /* ignore */ }

  compatLog(`已安装（导入v2 + 证书宽容；已登记源主机 ${state.sourceHosts.size} 个，带防盗链头 ${state.hostHeaders.size} 个；fetch 层待 ready）`);
  return true;
}

module.exports = {
  installSourceCompat,
  // 测试导出
  _internals: {
    maybeBase64Decode,
    decodeSmart,
    isMaccmsXmlText,
    xmlToVodJson,
    completePlayUrls,
    resolveUrl,
    convertSites,
    extractWarehouses,
    translateImportPayload,
    resolveAppYsApi,
    rewriteHotPayload,
    isHomeRailHot,
    setBrowseHint,
    withExtraBuiltinSources,
    fetchDoubanRecentHot,
    registerMediaHost,
    compatFetch,
    state
  }
};

'use strict';
/**
 * CineFlow 搜索页片源中枢（新增文件，零侵入）。
 *
 * 与基线 / 聚合引擎的分工：
 *   - 基线 resources:findMovie / resources:findMovieFiltered：给定「一部已知片子」找它能播的线路，
 *     每源只交付**最佳一条**（source-engine.cjs 的 processTitle 返回首个 compact）。
 *   - 本模块：给定「一个关键词」横向扫全部源，每源返回**多条命中**，供搜索页按片名归并成
 *     「一部片子出现在 N 个片源」的分组视图。只做发现，不做线路水合（点击时才走基线取可播地址）。
 *
 * 复用而非复制：选源、标题归一化、候选打分全部用 source-engine.cjs 已导出的 _internals 纯函数；
 * 网络层用 session.defaultSession.fetch，自动继承 source-compat.cjs 的兼容层
 * （XML→JSON / GBK / base64 / 相对 URL / 防盗链 Referer）。
 * 基线任何文件不做改动；本模块安装失败时搜索页静默隐藏，基线搜索不受影响。
 */

const { _internals: engineInternals } = require('./source-engine.cjs');

/* ---- 预算 / 并发 ---- */
const HUB_POOL = 8;
// 与基线 source-engine 口径一致：单源 5s 预算、请求 6.5s 超时。
// 实测 3.2s 会让偏远源（暴风/量子/1080）成片超时，命中率明显下降。
const PER_SOURCE_BUDGET_MS = 5000;
const PER_REQUEST_TIMEOUT_MS = 6500;
const PER_SOURCE_HITS = 8;
const MAX_GROUPS = 80;

/* ---- 缓存 ---- */
const POSITIVE_TTL_MS = 4 * 60 * 1000;
const NEGATIVE_TTL_MS = 90 * 1000;
const CACHE_MAX = 40;

/* ---- 海报中转（渲染层跑在 file:// origin，源站图片拒热链，必须由主进程取字节） ---- */
const IMAGE_TTL_MS = 30 * 60 * 1000;
const IMAGE_CACHE_MAX = 240;
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const IMAGE_MAX_FETCH = 8;

const CHANNEL_START = 'cf:searchHub:start';
const CHANNEL_CANCEL = 'cf:searchHub:cancel';
const CHANNEL_STATUS = 'cf:searchHub:status';
const CHANNEL_IMAGE = 'cf:searchHub:image';
const CHANNEL_EVENT = 'cf:searchHub:progress';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/3.4.8';

const state = {
  installed: false,
  ipcMain: null,
  getSession: null,
  log: () => {},
  live: new Map(),
  cache: new Map(),
  imageCache: new Map(),
  imageInflight: new Map(),
  imageActive: 0,
  imageQueue: []
};

function log(...args) {
  try { state.log(...args); } catch { /* 日志自身异常不外泄 */ }
}

/* ============ 词条归一化（复用基线口径） ============ */

/**
 * 片名归一化：比基线 normalizeResourceTitle 多做三件搜索页才需要的事
 *   1. 剥掉括号里的年份 —— 「寄生虫 (2019)」与「寄生虫」必须归到同一组
 *   2. 剥掉短括号标记 —— 【中字】[国语]（第2季）这类区间式标注
 *   3. 剥掉结尾裸年份 —— 「寄生虫2019」
 * 兜底：若剥完为空（例如整条片名被【】包起来），退回基线口径，绝不丢条目。
 */
function normTitle(value) {
  const raw = String(value || '');
  try {
    let text = raw
      .replace(/[（(]\s*(?:19|20)\d{2}\s*[)）]/g, ' ')
      .replace(/[【\[]\s*(?:19|20)\d{2}\s*[】\]]/g, ' ')
      .replace(/[【\[][^】\]]{0,10}[】\]]/g, ' ')
      .replace(/(?:19|20)\d{2}\s*$/, ' ');
    const stripped = engineInternals.normalizeResourceTitle(text) || '';
    if (stripped) return stripped;
    return engineInternals.normalizeResourceTitle(raw) || '';
  } catch {
    return '';
  }
}

function scoreOf(item, query) {
  try { return engineInternals.resourceCandidateScore(item, [query], ''); } catch { return -999; }
}

/* ============ 单源拉取 ============ */

function buildSearchUrl(api, query) {
  const url = new URL(api);
  url.searchParams.set('ac', 'videolist');
  url.searchParams.set('wd', query);
  return url.toString();
}

async function fetchVideolist(source, query, timeoutMs) {
  const session = state.getSession && state.getSession();
  const target = session && session.defaultSession ? session.defaultSession : null;
  if (!target || typeof target.fetch !== 'function') throw new Error('会话不可用');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(600, timeoutMs));
  try {
    const response = await target.fetch(buildSearchUrl(source.api, query), {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': UA,
        ...(source.headers && typeof source.headers === 'object' ? source.headers : {})
      }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = await response.text();
    const text = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('返回非 JSON'); }
    const list = Array.isArray(parsed && parsed.list) ? parsed.list : [];
    return list;
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 命中抽取 ============ */

/**
 * 单源命中提取：宽松阈值（发现层不是精确检索口径）。
 * 打分复用基线 resourceCandidateScore（含「解说/预告/花絮 → -80」「体育 → -36」等既有惩罚），
 * 阈值 40 等价于「标题完全一致 / 前缀一致 / 长标题包含」，排除纯噪声。
 */
function pickHits(source, items, query, latencyMs) {
  const hits = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.vod_name || item.name || '').trim();
    if (!title) continue;
    const vodId = String(item.vod_id || item.id || '');
    const dedupeKey = vodId || title;
    if (seen.has(dedupeKey)) continue;
    const score = scoreOf(item, query);
    if (score < 40) continue;
    const norm = normTitle(title);
    if (!norm) continue;
    seen.add(dedupeKey);
    hits.push({
      sourceKey: String(source.key || ''),
      sourceName: String(source.name || source.key || '资源'),
      vodId,
      title,
      norm,
      year: String(item.vod_year || '').match(/\d{4}/)?.[0] || '',
      type: String(item.type_name || ''),
      remarks: String(item.vod_remarks || item.vod_pubdate || ''),
      poster: /^https?:\/\//i.test(String(item.vod_pic || '')) ? String(item.vod_pic) : '',
      score,
      latencyMs
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, PER_SOURCE_HITS);
}

/* ============ 单源执行 ============ */

async function runSource(source, query, budgetMs) {
  const startedAt = Date.now();
  const data = await fetchVideolist(source, query, budgetMs);
  const latencyMs = Date.now() - startedAt;
  const hits = pickHits(source, data, query, latencyMs);
  return { latencyMs, hits, scanned: data.length };
}

/* ============ 缓存 ============ */

function cacheKeyOf(revision, mode, query) {
  return [Number(revision || 0), String(mode || ''), String(query || '').toLowerCase()].join('|');
}

function readCache(key) {
  const entry = state.cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    state.cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key, value, ttlMs) {
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next();
    if (!oldest.done) state.cache.delete(oldest.value);
  }
  state.cache.set(key, { ...value, expireAt: Date.now() + ttlMs, at: Date.now() });
}

/* ============ 搜索主流程 ============ */

function emptySourceState(source) {
  return {
    sourceId: String(source.key || ''),
    name: String(source.name || source.key || '资源'),
    phase: 'waiting',
    latencyMs: null,
    count: 0,
    error: null
  };
}

async function runSearch(event, searchId, query, settings, sources) {
  const sender = event && event.sender;
  const send = (payload) => {
    if (!sender || sender.isDestroyed?.()) return;
    if (state.live.get(searchId) !== true) return;
    try { sender.send(CHANNEL_EVENT, payload); } catch { /* 渲染层已销毁 */ }
  };

  const cacheKey = cacheKeyOf(settings.revision, settings.mode, query);
  const cachedEntry = readCache(cacheKey);

  if (cachedEntry) {
    // 命中缓存：同帧回放，渲染层拿到即完成 —— 这是「毫秒级」的主路径
    for (const item of cachedEntry.results) {
      send({ searchId, phase: 'source', source: item.source, hits: item.hits, cached: true });
    }
    send({
      searchId,
      phase: 'done',
      sources: cachedEntry.results.map((item) => item.source),
      totalHits: cachedEntry.results.reduce((sum, item) => sum + item.hits.length, 0),
      cached: true
    });
    state.live.delete(searchId);
    return;
  }

  const collected = new Array(sources.length).fill(null);
  const queue = sources.map((source, rank) => ({ source, rank }));
  const aggStartedAt = Date.now();

  const worker = async () => {
    while (queue.length) {
      if (state.live.get(searchId) !== true) return;
      const job = queue.shift();
      if (!job) return;
      const { source, rank } = job;
      send({ searchId, phase: 'source', source: { ...emptySourceState(source), phase: 'loading' }, hits: [] });
      let record;
      try {
        const settled = await runSource(source, query, PER_SOURCE_BUDGET_MS);
        record = {
          source: {
            sourceId: String(source.key || ''),
            name: String(source.name || source.key || '资源'),
            phase: 'done',
            latencyMs: settled.latencyMs,
            count: settled.hits.length,
            error: null
          },
          hits: settled.hits
        };
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
        record = {
          source: {
            sourceId: String(source.key || ''),
            name: String(source.name || source.key || '资源'),
            phase: 'failed',
            latencyMs: PER_SOURCE_BUDGET_MS,
            count: 0,
            error: aborted ? '超时' : String((error && error.message) || '请求失败').slice(0, 60)
          },
          hits: []
        };
      }
      collected[rank] = record;
      send({ searchId, phase: 'source', source: record.source, hits: record.hits });
    }
  };

  const workers = Array.from({ length: Math.min(HUB_POOL, queue.length) }, () => worker());
  try { await Promise.all(workers); } catch { /* 单源异常不外泄 */ }

  if (state.live.get(searchId) !== true) return;

  const results = collected.filter(Boolean);
  const totalHits = results.reduce((sum, item) => sum + item.hits.length, 0);
  writeCache(cacheKey, { results }, totalHits > 0 ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);

  send({
    searchId,
    phase: 'done',
    sources: results.map((item) => item.source),
    totalHits,
    tookMs: Date.now() - aggStartedAt,
    cached: false
  });
  state.live.delete(searchId);
  log('搜索页片源扫描完成:', query, '源', sources.length, '命中', totalHits, '耗时', Date.now() - aggStartedAt, 'ms');
}

function readSettings(ipcMain) {
  try {
    const handlers = ipcMain && ipcMain._invokeHandlers;
    const getter = handlers && handlers.get('app:getResourceSettings');
    if (typeof getter !== 'function') return null;
    const value = getter({ sender: null });
    if (value && typeof value.then === 'function') return value;
    return Promise.resolve(value);
  } catch {
    return null;
  }
}

async function startHandler(event, payload = {}) {
  const searchId = Number(payload && payload.searchId) || 0;
  const query = String((payload && payload.query) || '').trim();
  if (!searchId || !query) return { ok: false, error: 'empty-query', searchId };

  const settings = await readSettings(state.ipcMain);
  if (!settings) return { ok: false, error: 'no-settings', searchId: 0 };
  if (settings.enabled === false) {
    return { ok: true, searchId: 0, total: 0, sources: [], reason: 'disabled' };
  }

  const sources = engineInternals.selectSources(settings);
  if (!sources.length) {
    return { ok: true, searchId: 0, total: 0, sources: [], reason: 'no-sources' };
  }

  // 单飞：新搜索接管，旧搜索的全部后续事件被 searchId 守卫丢弃
  state.live.clear();
  state.live.set(searchId, true);

  const initial = sources.map(emptySourceState);
  runSearch(event, searchId, query, settings, sources).catch((error) => {
    log('搜索页片源扫描异常:', error && error.message);
  });

  return {
    ok: true,
    searchId,
    total: sources.length,
    sources: initial,
    revision: Number(settings.revision || 0),
    mode: String(settings.mode || '')
  };
}

function cancelHandler(_event, payload = {}) {
  const searchId = Number(payload && payload.searchId) || 0;
  if (searchId) state.live.delete(searchId);
  else state.live.clear();
  return { ok: true, searchId };
}

async function statusHandler() {
  const settings = await readSettings(state.ipcMain);
  const sources = settings ? engineInternals.selectSources(settings) : [];
  return {
    installed: state.installed,
    enabled: Boolean(settings && settings.enabled !== false),
    mode: settings ? String(settings.mode || '') : '',
    revision: settings ? Number(settings.revision || 0) : 0,
    sources: sources.map((source) => ({ sourceId: String(source.key || ''), name: String(source.name || '') })),
    cached: state.cache.size,
    live: state.live.size,
    maxGroups: MAX_GROUPS
  };
}


/* ============ 海报中转 ============ */

/**
 * 渲染层跑在 file:// origin，源站海报（dytt-tupian / imgzy360 …）一律拒热链，
 * 直接在 <img src> 里引用必然 error。这里由主进程取字节转成 data URL 回传：
 *   - 走 session.defaultSession.fetch，自动继承 source-compat 的 Referer 表与证书宽容；
 *   - 显式带 Referer（优先调用方给的源站 origin，否则用图片自己的 origin），
 *     这是绕过绝大多数 CMS 图床防盗链的关键；
 *   - host 级并发限流 8，避免一次搜索打出几十个并发图请求；
 *   - 30min / 240 条缓存，重复搜索不再取字节。
 */
function imageCacheKey(url, referer) {
  return String(referer || '') + '|' + String(url || '');
}

function readImageCache(key) {
  const entry = state.imageCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    state.imageCache.delete(key);
    return null;
  }
  return entry;
}

function writeImageCache(key, value) {
  if (state.imageCache.size >= IMAGE_CACHE_MAX) {
    // 先清过期的，再不行淘汰最旧的
    const now = Date.now();
    for (const [k, v] of state.imageCache) {
      if (now > v.expireAt) state.imageCache.delete(k);
    }
    if (state.imageCache.size >= IMAGE_CACHE_MAX) {
      const oldest = state.imageCache.keys().next();
      if (!oldest.done) state.imageCache.delete(oldest.value);
    }
  }
  state.imageCache.set(key, { ...value, expireAt: Date.now() + IMAGE_TTL_MS });
}

function acquireImageSlot() {
  if (state.imageActive < IMAGE_MAX_FETCH) {
    state.imageActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.imageQueue.push(resolve));
}

function releaseImageSlot() {
  state.imageActive = Math.max(0, state.imageActive - 1);
  const next = state.imageQueue.shift();
  if (next) {
    state.imageActive += 1;
    next();
  }
}

function contentTypeOf(response, buffer) {
  const header = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  if (header.startsWith('image/')) return header.split(';')[0].trim();
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.length > 6 && buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer.length > 12 && buffer[8] === 0x57 && buffer[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}

async function fetchImageData(url, referer) {
  const session = state.getSession && state.getSession();
  const target = session && session.defaultSession ? session.defaultSession : null;
  if (!target || typeof target.fetch !== 'function') throw new Error('会话不可用');

  let refererValue = referer;
  if (!refererValue) {
    try { refererValue = new URL(url).origin + '/'; } catch { refererValue = ''; }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await target.fetch(url, {
      signal: controller.signal,
      cache: 'force-cache',
      headers: {
        'user-agent': UA,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...(refererValue ? { referer: refererValue } : {})
      }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('空图片');
    if (buffer.length > IMAGE_MAX_BYTES) throw new Error('图片过大');
    const contentType = contentTypeOf(response, buffer);
    if (!contentType.startsWith('image/')) throw new Error('非图片内容');
    return { dataUrl: 'data:' + contentType + ';base64,' + buffer.toString('base64'), bytes: buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

async function imageHandler(_event, payload = {}) {
  const url = String((payload && payload.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '无效地址' };
  const referer = String((payload && payload.referer) || '').trim();
  const key = imageCacheKey(url, referer);

  const cached = readImageCache(key);
  if (cached) return { ok: true, dataUrl: cached.dataUrl, bytes: cached.bytes, cached: true };

  const inflight = state.imageInflight.get(key);
  if (inflight) return inflight;

  const job = (async () => {
    await acquireImageSlot();
    try {
      const result = await fetchImageData(url, referer);
      writeImageCache(key, result);
      return { ok: true, dataUrl: result.dataUrl, bytes: result.bytes, cached: false };
    } catch (error) {
      const reason = error && error.name === 'AbortError' ? '超时' : String((error && error.message) || '取图失败');
      // 失败也短缓存，避免同一张坏图被反复重试打爆源站
      writeImageCache(key, { failed: true, error: reason });
      return { ok: false, error: reason };
    } finally {
      releaseImageSlot();
      state.imageInflight.delete(key);
    }
  })();

  state.imageInflight.set(key, job);
  return job;
}

/* ============ 安装 ============ */

function installSearchHub({ ipcMain, session, log: logger } = {}) {
  if (state.installed) return false;
  if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
  state.ipcMain = ipcMain;
  state.getSession = () => (session && session.defaultSession ? session : null);
  if (typeof logger === 'function') state.log = logger;

  try {
    ipcMain.handle(CHANNEL_START, startHandler);
    ipcMain.handle(CHANNEL_CANCEL, cancelHandler);
    ipcMain.handle(CHANNEL_STATUS, statusHandler);
    ipcMain.handle(CHANNEL_IMAGE, imageHandler);
  } catch (error) {
    log('搜索页片源中枢注册失败:', error && error.message);
    return false;
  }

  state.installed = true;
  log('搜索页片源中枢已安装（逐源并发发现 + 多命中归并 + 4min/90s 缓存）');
  return true;
}

module.exports = {
  installSearchHub,
  _internals: {
    normTitle,
    pickHits,
    buildSearchUrl,
    cacheKeyOf,
    emptySourceState,
    selectSources: (settings) => engineInternals.selectSources(settings),
    state,
    CHANNEL_START,
    CHANNEL_CANCEL,
    CHANNEL_STATUS,
    CHANNEL_EVENT,
    CHANNEL_IMAGE,
    imageHandler,
    imageCacheKey,
    PER_SOURCE_HITS,
    MAX_GROUPS
  }
};

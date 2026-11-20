// 详情页 Quality 弹层：Server（18 台内置服务器）+ Quality（该服务器真实档位）。
// 详情页一打开就预热并逐台推送结果，弹层首帧只读本地缓存，不等网络。
// 起播走基线出口 window.__cineflowOpenResourcePlayer，地址先换成主进程本地代理。

import './movy-quality.css';

const QUALITY_STORE_KEY = 'cineflow:movy-quality:v1';
const QUALITY_CACHE_KEY = 'cineflow:movy-qcache:v1';
const PROVIDERS_CACHE_KEY = 'cineflow:movy-providers:v1';
const TIERS_KEY = 'cineflow:movy-tiers:v1';
const QUALITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 片源地址 6 小时内基本有效，跨会话直接命中
const FILM_ID_KEY = 'cineflow:movy-filmid:v1';
const QTIERS_KEY = 'cineflow:movy-qtiers:v1';        // 每部片每台服务器「有哪些档位」的长记忆
const QTIERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROVIDERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEK_RETRY_MS = 240;

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function writeJson(key, value, limit) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    try {
      const keys = Object.keys(value).sort((a, b) => (value[b].at || 0) - (value[a].at || 0));
      const trimmed = {};
      for (const key2 of keys.slice(0, limit)) trimmed[key2] = value[key2];
      window.localStorage.setItem(key, JSON.stringify(trimmed));
    } catch { /* 隐私模式 */ }
  }
  return value;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
}

export function initMovyQualityMenu(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return () => {};
  const bridge = () => (typeof window !== 'undefined' ? window.cineflowMovy : null);
  // 常驻诊断：注入与渲染的每次动作都记一笔，出问题时（按钮不出现 / 面板空白）可直接查看
  const diag = (typeof window !== 'undefined' ? window : {}).__cfMq = (typeof window !== 'undefined' && window.__cfMq) || {
    inits: 0, injects: 0, removed: 0, errors: [], mutations: 0, panelOpens: 0, bridgeOk: false, hosts: [],
  };
  diag.bridgeOk = !!bridge();
  if (!bridge()) return () => {};

  const PLAYCTX_KEY = 'cineflow:movy-playctx:v1';
  let activeSubtitles = [];

  // 当前影片来源：卡片点击记录（捕获阶段）→ 详情页标题交叉校验 → 最近 TMDB 请求兜底。

  let current = null;
  let clickRecord = null;   // 最近一次点击的卡片 { id, mediaType, title, at }
  let providers = null;
  let activeProvider = '';
  let activeSources = [];
  let ghostSources = [];
  let warming = false;
  const probeState = new Map();
  const qualityCache = new Map();
  const inflight = new Map();
  let panel = null;
  let disposed = false;
  let requestSeq = 0;
  let prefetchTimer = 0;
  let coolingTimer = 0;
  const lastErrorByProvider = new Map();
  const warmSources = new Map();   // provider -> 已拿到的档位（用于自动兜底）
  let autoFallbackDone = false;
  let filmSig = '';
  let justSwitched = false;
  let detailHookOff = null;
  let idPending = null;

  // 有片源的服务器里，挑一台不是当前、也没失败过的
  function fallbackProvider() {
    if (!warmSources.size) return '';
    for (const [name, sources] of warmSources) {
      if (!sources || !sources.length) continue;
      if (name === activeProvider) continue;
      if (lastErrorByProvider.has(name)) continue;
      return name;
    }
    return '';
  }

  // 上游对这些服务器没有该片源时回 500/404：说人话，别吓用户
  function humanError(raw) {
    const text = String(raw || '');
    if (/HTTP 500|HTTP 404/.test(text)) return '该服务器无此片源';
    if (/RATE_LIMITED/.test(text)) return '上游限流，稍后自动重试';
    if (/timeout/i.test(text)) return '请求超时';
    return text || '取源失败';
  }

  try {
    doc.addEventListener('click', (event) => {
      const node = event && event.target;
      const card = node && node.closest ? node.closest('[data-movie-id]') : null;
      if (!card) return;
      const id = Number(card.dataset && card.dataset.movieId);
      if (!id) return;
      clickRecord = {
        id,
        mediaType: String((card.dataset && card.dataset.mediaType) || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie',
        at: Date.now(),
        title: String((card.querySelector('.movie-card-title') || card.querySelector('h3') || {}).textContent || '').trim().slice(0, 120),
      };
    }, true);
  } catch { /* ignore */ }

  // 最后一道兜底：详情页会去打 TMDB /movie/{id} 或 /tv/{id}，从最近的请求里反查 id。
  // 只在「没点到卡片」且详情页确实渲染出标题时才用，避免认错片。
  function idFromRecentRequest() {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const from = Math.max(0, entries.length - 80);
      for (let i = entries.length - 1; i >= from; i -= 1) {
        const entry = entries[i];
        const url = String(entry && entry.name || '');
        if (!/themoviedb|tmdb/i.test(url)) continue;
        if (now && entry.startTime && now - entry.startTime > 25000) continue;   // 只认详情刚打开那一下的请求
        const hit = url.match(/\/(movie|tv)\/(\d{2,8})(?:[/?]|$)/);
        if (hit) return { id: Number(hit[2]), mediaType: hit[1] === 'tv' ? 'tv' : 'movie' };
      }
    } catch { /* ignore */ }
    return null;
  }

  // 详情可能来自卡片/历史/搜索：包住渲染层入口拿权威 id
  function hookOpenDetails() {
    try {
      const original = window.__cineflowOpenDetails;
      if (typeof original !== 'function' || original.__cfMqHooked) return;
      const wrapped = function (movieId, movie) {
        try {
          const id = Number(movieId) || 0;
          const title = String((movie && (movie.title || movie.name)) || '').trim().slice(0, 120);
          const mediaType = String((movie && (movie.mediaType || movie.type)) || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
          if (id) clickRecord = { id, mediaType, title, at: Date.now() };
        } catch { /* 拿不到就当没点卡片 */ }
        return original.apply(this, arguments);
      };
      wrapped.__cfMqHooked = true;
      window.__cineflowOpenDetails = wrapped;
      detailHookOff = () => { if (window.__cineflowOpenDetails === wrapped) window.__cineflowOpenDetails = original; };
    } catch { /* ignore */ }
  }

  function normTitle(value) {
    return String(value || '').toLowerCase().replace(/[\s:：·\-–—_.,，。!！?？'"“”‘’()（）\[\]]/g, '');
  }

  function detailPosterPath() {
    try {
      const img = doc.querySelector('#detailContent img[src*="image.tmdb.org"]');
      const src = String((img && img.getAttribute('src')) || '');
      const hit = src.match(/\/t\/p\/[a-z0-9_]+\/(.+)$/i);
      return hit ? hit[1] : '';
    } catch { return ''; }
  }

  // 卡片记录只有和详情标题/海报对得上才算数，否则它是上一部
  function freshRecord(dom) {
    const rec = clickRecord;
    if (!rec || Date.now() - rec.at > 5 * 60 * 1000) return null;
    const b = normTitle(rec.title);
    if (!b) return rec;
    return [dom.title, dom.alt].map(normTitle).some((a) => a && (a.includes(b) || b.includes(a))) ? rec : null;
  }

  function filmSignature() {
    const dom = detailTitleFromDom();
    return [dom.title, dom.alt, dom.year].join('|');
  }

  // 换片：服务器/片源/字幕一律清空
  function resetFilmState() {
    activeProvider = '';
    activeSources = [];
    ghostSources = [];
    activeSubtitles = [];
    warmSources.clear();
    probeState.clear();
    lastErrorByProvider.clear();
    autoFallbackDone = false;
    requestSeq += 1;
    diag.filmReset = (diag.filmReset || 0) + 1;
  }

  function idCacheKey(dom) {
    return (detailPosterPath() || normTitle(dom.title) + '|' + dom.year).slice(0, 90);
  }

  function posterTail(value) {
    return String(value || '').toLowerCase().replace(/^\/+/, '').trim();
  }

  function detailsMatch(info, dom, poster) {
    if (!info) return false;
    const want = posterTail(poster);
    const got = posterTail(info.posterPath);
    if (want && got) return want === got;
    const names = [info.title, info.originalTitle].map(normTitle).filter(Boolean);
    const domNames = [dom.title, dom.alt].map(normTitle).filter(Boolean);
    return names.some((n) => domNames.some((d) => n === d || n.includes(d) || d.includes(n)));
  }

  const detailBridge = () => (typeof window !== 'undefined' ? window.cineflow : null) || {};

  async function safeDetails(id) {
    try { return await detailBridge().getMovieDetails(id); } catch { return null; }
  }

  async function safeSearch(term) {
    if (!term) return [];
    try {
      const result = await detailBridge().searchMovies(term);
      const list = Array.isArray(result) ? result : (result && (result.results || result.items)) || [];
      return Array.isArray(list) ? list.slice(0, 8) : [];
    } catch { return []; }
  }

  // 用候选 id 逐个核对海报/标题，对不上就换下一个；全错就返回 0（宁可不放也不放错片）
  async function resolveFilmId(sig) {
    const dom = detailTitleFromDom();
    const poster = detailPosterPath();
    const key = idCacheKey(dom);
    const seen = new Set();
    const candidates = [];
    const push = (id, mediaType) => { const n = Number(id) || 0; if (n && !seen.has(n)) { seen.add(n); candidates.push({ id: n, mediaType: mediaType || 'movie' }); } };
    const rec = freshRecord(dom);
    if (rec) push(rec.id, rec.mediaType);
    const cache = readJson(FILM_ID_KEY, {});
    const hit = cache[key];
    if (hit && Date.now() - (hit.at || 0) < 30 * 24 * 60 * 60 * 1000) push(hit.id, hit.mediaType);
    for (const term of [dom.title, dom.alt]) {
      const list = await safeSearch(term);
      for (const item of list) push(item && (item.id || item.tmdbId), (item && (item.mediaType || item.type)) || 'movie');
    }
    for (const cand of candidates) {
      const info = await safeDetails(cand.id);
      if (filmSignature() !== sig) return null;
      if (!detailsMatch(info, dom, poster)) continue;
      const mediaType = String((info && info.mediaType) || cand.mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
      const nextCache = readJson(FILM_ID_KEY, {});
      nextCache[key] = { id: cand.id, mediaType, title: (info && info.title) || dom.title, at: Date.now() };
      writeJson(FILM_ID_KEY, nextCache, 200);
      return { id: cand.id, mediaType, title: (info && info.title) || dom.title || dom.alt };
    }
    return { id: 0, mediaType: 'movie', title: dom.title || dom.alt };
  }

  function syncFilm() {
    const dom = detailTitleFromDom();
    if (!dom.title && !dom.alt) return false;
    const sig = filmSignature();
    if (sig === filmSig) return false;
    filmSig = sig;
    justSwitched = true;
    resetFilmState();
    current = { id: 0, mediaType: 'movie', title: dom.title || dom.alt, year: dom.year || '', imdbId: '', seasonId: 1, episodeId: 1, totalSeasons: 0 };
    diag.filmSig = sig;
    idPending = resolveFilmId(sig).then((found) => {
      idPending = null;
      if (!found || filmSignature() !== sig) return null;
      current.id = found.id;
      current.mediaType = found.mediaType;
      current.title = found.title || current.title;
      diag.filmId = current.id;
      if (panel && !panel.classList.contains('is-hidden')) loadPanelSources();
      scheduleWarm();
      return found;
    }).catch(() => { idPending = null; return null; });
    return true;
  }

  function ensureFilmId() {
    if (current && current.id) return Promise.resolve(current.id);
    if (idPending) return idPending.then(() => (current && current.id) || 0);
    return Promise.resolve(0);
  }

  function detailTitleFromDom() {
    try {
      const info = doc.querySelector('#detailContent .detail-info');
      if (!info) return { title: '', alt: '', year: '' };
      const h2 = info.querySelector('h2');
      const h3 = info.querySelector('h3');
      const meta = (info.querySelector('.meta-row') || {}).textContent || '';
      const yearHit = meta.match(/(?:19|20)\d{2}/g);
      return {
        title: String((h2 && h2.textContent) || '').trim().slice(0, 120),
        alt: String((h3 && h3.textContent) || '').trim().slice(0, 120),
        year: yearHit ? yearHit[yearHit.length - 1] : '',
      };
    } catch { return { title: '', alt: '', year: '' }; }
  }

  // 识别只走一条路：签名比对，避免「上一部的 id + 这一部的标题」这种混合身份
  function detectContext() {
    try { return syncFilm(); } catch { return false; }
  }

  const contextKey = () => {
    if (!current) return '';
    const idPart = current.id || ('t_' + normTitle(current.title).slice(0, 24));
    return 'movy:' + [current.mediaType, idPart, current.seasonId || 1, current.episodeId || 1].join(':');
  };

  function readChoice(key) {
    if (!key) return null;
    const map = readJson(QUALITY_STORE_KEY, {});
    const hit = map[key];
    return hit && typeof hit === 'object' ? hit : null;
  }

  const movieKeyOf = (payload) => [payload.mediaType || 'movie', payload.tmdbId || ('t_' + normTitle(payload.title).slice(0, 24)), payload.seasonId || 1, payload.episodeId || 1].join(':');
  const qualityKey = (provider) => {
    if (!current) return '';
    const idPart = current.id || ('t_' + normTitle(current.title).slice(0, 24));
    return [provider || 'Miami', current.mediaType, idPart, current.seasonId || 1, current.episodeId || 1].join(':');
  };

  // ── 缓存 ───────────────────────────────────────────────────────────────
  function cacheGet(key) {
    const mem = qualityCache.get(key);
    if (mem && Date.now() - mem.at < QUALITY_CACHE_TTL_MS) return mem;
    const all = readJson(QUALITY_CACHE_KEY, {});
    const disk = all[key];
    if (disk && Date.now() - disk.at < QUALITY_CACHE_TTL_MS) {
      qualityCache.set(key, disk);
      return disk;
    }
    return null;
  }

  function cachePut(key, entry, persist) {
    if (persist !== false) {
      qualityCache.set(key, entry);
      const all = readJson(QUALITY_CACHE_KEY, {});
      all[key] = entry;
      writeJson(QUALITY_CACHE_KEY, all, 60);
      return;
    }
    qualityCache.set(key, entry);
  }

  function qtiersRemember(provider, sources) {
    if (!provider || !sources || !sources.length) return;
    const all = readJson(QTIERS_KEY, {});
    all[provider + '|' + qualityKey(provider)] = {
      at: Date.now(),
      labels: sources.map((item) => item.quality),
      heights: sources.map((item) => item.height || 0),
    };
    writeJson(QTIERS_KEY, all, 120);
  }

  function qtiersOf(provider) {
    const hit = readJson(QTIERS_KEY, {})[provider + '|' + qualityKey(provider)];
    if (!hit || !Array.isArray(hit.labels) || !hit.labels.length) return [];
    if (Date.now() - (hit.at || 0) > QTIERS_TTL_MS) return [];
    return hit.labels.map((label, index) => ({ quality: label, height: (hit.heights && hit.heights[index]) || 0, url: '', fromMemory: true }));
  }

  function tiersRemember(provider, sources) {
    if (!provider || !sources || !sources.length) return;
    const all = readJson(TIERS_KEY, {});
    all[provider] = { at: Date.now(), heights: sources.map((item) => item.height || 0), labels: sources.map((item) => item.quality) };
    writeJson(TIERS_KEY, all, 40);
  }

  function tiersOf(provider) {
    const hit = readJson(TIERS_KEY, {})[provider];
    if (!hit || !Array.isArray(hit.labels) || !hit.labels.length) return [];
    if (Date.now() - (hit.at || 0) > TIERS_TTL_MS) return [];
    return hit.labels.map((label, index) => ({ quality: label, height: hit.heights[index] || 0, url: '', ghost: true }));
  }

  function providersFromCache() {
    const hit = readJson(PROVIDERS_CACHE_KEY, null);
    if (hit && Array.isArray(hit.list) && Date.now() - (hit.at || 0) < PROVIDERS_CACHE_TTL_MS) return hit.list;
    return null;
  }

  function providersToCache(list) {
    try { window.localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* ignore */ }
  }

  // ── 详情上下文 + 播放位置 ──────────────────────────────────────────────
  function hookDetails() {
    try {
      const original = window.__cineflowOpenDetails;
      if (typeof original !== 'function' || original.__cfMqHooked) return;
      const wrapped = function (movieId, movie) {
        try {
          const id = Number(movieId) || Number(movie && (movie.id || movie.tmdbId)) || 0;
          const mediaType = String((movie && (movie.mediaType || movie.type)) || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
          const next = id ? {
            id,
            mediaType,
            title: String((movie && (movie.title || movie.name)) || ''),
            year: String((movie && (movie.releaseDate || movie.release_date || movie.year)) || '').match(/\d{4}/)?.[0] || '',
            imdbId: String((movie && movie.imdbId) || ''),
            seasonId: Number((movie && movie.seasonId) || 1) || 1,
            episodeId: Number((movie && movie.episodeId) || 1) || 1,
            totalSeasons: Number((movie && movie.totalSeasons) || 0) || 0,
          } : null;
          const changed = next && (!current || current.id !== next.id || current.mediaType !== next.mediaType
            || current.seasonId !== next.seasonId || current.episodeId !== next.episodeId);
          if (next) current = next;
          if (changed) scheduleWarm();
        } catch { /* 上下文失败不影响基线详情 */ }
        return original.apply(this, arguments);
      };
      wrapped.__cfMqHooked = true;
      window.__cineflowOpenDetails = wrapped;
    } catch { /* ignore */ }
  }

  function hookPlayer() {
    try {
      const original = window.__cineflowOpenResourcePlayer;
      if (typeof original !== 'function' || original.__cfMqPlayer) return;
      const wrapped = function () { return original.apply(this, arguments); };
      wrapped.__cfMqPlayer = true;
      window.__cineflowOpenResourcePlayer = wrapped;
    } catch { /* ignore */ }
  }

  function videoElement() { return doc.querySelector('#resourcePlayer'); }

  function currentTimeOf() {
    const video = videoElement();
    const modal = doc.querySelector('#playerModal');
    if (modal && modal.classList.contains('is-open') && video && Number.isFinite(video.currentTime) && video.currentTime > 1) return video.currentTime;
    return 0;
  }

  function playSource(entry) {
    if (!entry || !entry.url) return false;
    if (entry.filmSig && entry.filmSig !== filmSignature()) { diag.playError = '影片已切换，放弃上一次播放'; return false; }
    const open = window.__cineflowOpenResourcePlayer;
    if (typeof open !== 'function') return false;
    try {
      window.localStorage.setItem(PLAYCTX_KEY, JSON.stringify({
        at: Date.now(),
        provider: entry.provider || activeProvider || '',
        quality: entry.quality || '',
        streamUrl: entry.originUrl || entry.url || '',
        mediaType: current && current.mediaType,
        tmdbId: current && current.id,
        title: (current && current.title) || '',
        year: (current && current.year) || '',
        seasonId: current && current.seasonId,
        episodeId: current && current.episodeId,
        subtitles: activeSubtitles.slice(0, 40),
      }));
    } catch { /* 写不进去就只是没有字幕 */ }
    const resume = currentTimeOf();
    try {
      open.call(window, {
        url: entry.url,
        kind: 'hls',
        title: (current && current.title) || '影视资源',
        sourceName: 'Movy · ' + (entry.provider || activeProvider || 'Miami'),
        lineName: entry.quality || 'Auto',
        label: '内置源',
        playbackMode: 'auto',
      });
    } catch { return false; }
    if (resume > 1) seekWhenReady(resume);
    return true;
  }

  function seekWhenReady(seconds, tries = 0) {
    const video = videoElement();
    if (!video || tries > 24) return;
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
      try { video.currentTime = Math.min(seconds, Math.max(0, video.duration - 2)); } catch { /* ignore */ }
      return;
    }
    window.setTimeout(() => seekWhenReady(seconds, tries + 1), SEEK_RETRY_MS);
  }

  // ── 预热 + 推送 ────────────────────────────────────────────────────────
  function buildPayload(providerName) {
    if (!current) return null;
    return {
      provider: providerName || 'Miami',
      mediaType: current.mediaType,
      title: current.title,
      year: current.year,
      tmdbId: current.id,
      imdbId: current.imdbId,
      seasonId: current.seasonId,
      episodeId: current.episodeId,
      totalSeasons: current.totalSeasons,
    };
  }

  // 自动切到有片源的那台：改高亮 + 换画质，不弹任何提示，用户只会觉得「刚好就有」
  function autoSwitch(provider, sources) {
    try {
      if (!provider || !sources || !sources.length) return;
      const seq = ++requestSeq;   // 作废还在飞的其他请求结果，避免来回跳
      activeProvider = provider;
      activeSources = sources;
      ghostSources = [];
      cachePut(qualityKey(provider), { at: Date.now(), sources, note: '', ms: 0 });
      tiersRemember(provider, sources);
      qtiersRemember(provider, sources);
      renderServers();
      renderQualities();
      return seq;
    } catch { return 0; }
  }

  function applyRow(row) {
    if (!current || !row || !row.provider) return;
    if (row.movieKey && row.movieKey !== movieKeyOf(buildPayload(row.provider))) return;
    const key = qualityKey(row.provider);
    const cooling = row.error === 'RATE_LIMITED' || row.cooling === true;
    if (!row.ok) lastErrorByProvider.set(row.provider, row.error || (cooling ? 'RATE_LIMITED' : '取源失败'));
    else {
      lastErrorByProvider.delete(row.provider);
      const got = Array.isArray(row.sources) ? row.sources.filter((item) => item && item.url) : [];
      if (got.length) { warmSources.set(row.provider, got); diag.warmCount = warmSources.size; diag.warmKeys = [...warmSources.keys()]; }
    }
    probeState.set(row.provider, { ok: !!row.ok, ms: row.ms, count: row.count || 0, pending: false, cooling });
    if (cooling) {
      // 上游限流：冷却结束后自动再来一轮，界面不用用户手动重试
      if (coolingTimer) window.clearTimeout(coolingTimer);
      coolingTimer = window.setTimeout(() => {
        coolingTimer = 0;
        if (!disposed && current) scheduleWarm(true);
      }, 9000);
    }
    if (row.ok && Array.isArray(row.sources) && row.sources.length) {
      cachePut(key, { at: Date.now(), sources: row.sources, note: row.note || '', ms: row.ms || 0 });
      tiersRemember(row.provider, row.sources);
      qtiersRemember(row.provider, row.sources);
      if (panel && !panel.classList.contains('is-hidden')) {
        if (row.provider === activeProvider) {
          activeSources = row.sources;
          ghostSources = [];
          renderServers();
          renderQualities();
          return;
        }
        // 当前这台还没片源？那就不等它了，直接飘到已经拿到片源的那台
        const usable = Array.isArray(row.sources) && row.sources.length
          && !(ghostSources.length && !ghostSources.some((item) => item.fromMemory));
        if (!activeSources.length && usable) {
          autoSwitch(row.provider, row.sources);
          return;
        }
      }
    }
    if (panel && !panel.classList.contains('is-hidden')) renderServers();
  }

  function scheduleWarm(force) {
    if (prefetchTimer) window.clearTimeout(prefetchTimer);
    prefetchTimer = window.setTimeout(() => {
      prefetchTimer = 0;
      if (disposed || !current) return;
      const payload = buildPayload(activeProvider || 'Miami');
      if (!payload) return;
      if (force) payload.force = true;
      warming = true;
      if (panel && !panel.classList.contains('is-hidden')) renderQualities();
      Promise.resolve()
        .then(() => bridge().warm(payload))
        .finally(() => { warming = false; });
    }, 40);
  }

  async function loadProviders() {
    const cached = providersFromCache();
    if (cached) { providers = cached; renderServers(); }
    try {
      const result = await bridge().list();
      if (result && result.ok && Array.isArray(result.providers) && result.providers.length) {
        providers = result.providers;
        providersToCache(providers);
      } else if (!providers) providers = [];
    } catch { if (!providers) providers = []; }
    renderServers();
  }

  // 单台补取（预热没赶上、或用户点了某台而它还没同步到）
  function fetchSources(providerName) {
    const key = qualityKey(providerName);
    const pending = inflight.get(key);
    if (pending) return pending;
    const payload = buildPayload(providerName);
    if (!payload) return Promise.resolve(null);
    const task = Promise.resolve()
      .then(() => bridge().sources(payload))
      .then((result) => {
        const sources = Array.isArray(result && result.sources) ? result.sources : [];
        if (result && result.ok && sources.length) {
          cachePut(key, { at: Date.now(), sources, note: result.note || '', ms: result.ms || 0 });
          tiersRemember(payload.provider, sources);
          qtiersRemember(payload.provider, sources);
        }
        probeState.set(payload.provider, { ok: !!(result && result.ok), ms: result && result.ms, count: sources.length, pending: false, cooling: !!(result && (result.cooling || result.error === 'RATE_LIMITED')) });
        if (result && result.ok && sources.length) lastErrorByProvider.delete(payload.provider);
        else lastErrorByProvider.set(payload.provider, (result && (result.error || (result.cooling ? 'RATE_LIMITED' : ''))) || '取源失败');
        return result;
      })
      .catch(() => null)
      .finally(() => { inflight.delete(key); });
    inflight.set(key, task);
    return task;
  }

  // ── 面板 ───────────────────────────────────────────────────────────────
  function buildPanel() {
    if (panel) return panel;
    panel = doc.createElement('div');
    panel.id = 'cfMovyQualityPanel';
    panel.className = 'cf-mq-panel is-hidden';
    panel.innerHTML = [
      '<button type="button" class="cf-mq-close" aria-label="关闭">×</button>',
      '<div class="cf-mq-section-label">Server<button type="button" class="cf-mq-probe">全部测活</button></div>',
      '<div class="cf-mq-servers" role="listbox"></div>',
      '<div class="cf-mq-section-label">Quality<span class="cf-mq-quality-hint"></span></div>',
      '<div class="cf-mq-qualities"></div>',
    ].join('');
    doc.body.appendChild(panel);
    panel.querySelector('.cf-mq-close').addEventListener('click', close);
    panel.querySelector('.cf-mq-probe').addEventListener('click', () => scheduleWarm(true));
    doc.addEventListener('pointerdown', onOutside, true);
    return panel;
  }

  function onOutside(event) {
    if (!panel || panel.classList.contains('is-hidden')) return;
    if (panel.contains(event.target)) return;
    const btn = doc.getElementById('cfMovyQualityBtn');
    if (btn && btn.contains(event.target)) return;
    close();
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && panel && !panel.classList.contains('is-hidden')) close();
  }

  function renderServers() {
    try { renderServersInner(); } catch (error) {
      try { console.warn('[cf-mq] renderServers failed:', error && error.message); } catch { /* ignore */ }
    }
  }

  function renderServersInner() {
    const host = panel && panel.querySelector('.cf-mq-servers');
    if (!host) return;
    host.textContent = '';
    const list = Array.isArray(providers) ? providers : [];
    if (!list.length) {
      const empty = doc.createElement('span');
      empty.className = 'cf-mq-empty';
      empty.textContent = '服务器清单加载中…';
      host.appendChild(empty);
      return;
    }
    const fragment = doc.createDocumentFragment();
    for (const item of list) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'cf-mq-server' + (item.name === activeProvider ? ' is-active' : '');
      row.dataset.provider = item.name;

      const dot = doc.createElement('span');
      const state = probeState.get(item.name);
      dot.className = 'cf-mq-dot' + (state ? (state.ok ? ' is-ok' : (state.cooling ? ' is-cool' : ' is-down')) : ' is-pending');
      row.appendChild(dot);

      const name = doc.createElement('span');
      name.className = 'cf-mq-server-name';
      name.textContent = item.name;
      row.appendChild(name);

      const note = doc.createElement('span');
      note.className = 'cf-mq-server-note';
      note.textContent = String(item.note || '').replace(/\.?\s*May have 4K/i, '');
      row.appendChild(note);

      const ms = doc.createElement('span');
      ms.className = 'cf-mq-server-ms';
      ms.textContent = state ? (state.ok ? (state.ms && state.ms > 3 ? formatMs(state.ms) : '就绪') : (state.cooling ? '限流' : '失败')) : '—';
      row.appendChild(ms);

      if (item.mayHave4k) {
        const badge = doc.createElement('span');
        badge.className = 'cf-mq-badge';
        badge.textContent = '4K';
        row.appendChild(badge);
      }

      row.addEventListener('click', () => selectProvider(item.name));
      fragment.appendChild(row);
    }
    host.appendChild(fragment);
  }

  function renderQualities() {
    try { renderQualitiesInner(); } catch (error) {
      try { console.warn('[cf-mq] renderQualities failed:', error && error.message, error && error.stack && error.stack.split('\n')[1]); } catch { /* ignore */ }
    }
  }

  function renderQualitiesInner() {
    const host = panel && panel.querySelector('.cf-mq-qualities');
    const hint = panel && panel.querySelector('.cf-mq-quality-hint');
    if (!host) return;
    host.textContent = '';
    const list = activeSources.length ? activeSources : ghostSources;
    if (!list.length) {
      // 绝不静默：要么说「正在取」，要么把失败原因和重试摆出来
      const reason = lastErrorByProvider.get(activeProvider);
      if (reason) {
        if (hint) hint.textContent = '未取到';
        const fail = doc.createElement('div');
        fail.className = 'cf-mq-fail';
        const text = doc.createElement('span');
        text.className = 'cf-mq-fail-text';
        text.textContent = /RATE_LIMITED/.test(reason) ? '上游限流，稍后自动重试' : '取源失败 · ' + reason;
        fail.appendChild(text);
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'cf-mq-retry';
        retry.textContent = '重试';
        retry.addEventListener('click', () => {
          lastErrorByProvider.delete(activeProvider);
          autoFallbackDone = false;
          renderQualities();
          fetchSources(activeProvider).then(() => renderQualities());
          scheduleWarm(true);
        });
        fail.appendChild(retry);
        host.appendChild(fail);
        return;
      }
      if (hint) hint.textContent = '同步中…';
      const empty = doc.createElement('span');
      empty.className = 'cf-mq-empty is-loading';
      empty.textContent = !current
        ? '没识别到当前影片 · 关掉详情页重开一次'
        : (activeProvider ? '正在取该服务器画质…' : '先选一台服务器');
      host.appendChild(empty);
      return;
    }
    const fromMemory = !activeSources.length && ghostSources.some((item) => item.fromMemory);
    const isGhost = !activeSources.length && !fromMemory;
    const chosen = current ? (readChoice(contextKey()) || {}) : {};
    const has4k = list.some((item) => (item.height || 0) >= 2160);
    if (hint) hint.textContent = fromMemory
      ? activeProvider + ' · 同步中'
      : (isGhost ? activeProvider + ' · 同步中' : (has4k ? activeProvider : activeProvider + ' · 无 4K'));
    // Auto 去重：上游有些服务器本身就回一档叫 Auto，别和合成的那颗重复
    const realAuto = list.find((item) => /^auto$/i.test(String(item.quality || '')));
    const rest = list.filter((item) => !/^auto$/i.test(String(item.quality || '')));
    const allChips = [{
      quality: 'Auto',
      height: (realAuto && realAuto.height) || 0,
      url: (realAuto && realAuto.url) || '',
      ghost: isGhost,
    }].concat(rest);
    const fragment = doc.createDocumentFragment();
    for (const item of allChips) {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'cf-mq-chip' + (isGhost || item.ghost ? ' is-ghost' : '') + (item.quality === chosen.quality && !isGhost ? ' is-active' : '');
      chip.textContent = item.quality;
      if (!isGhost && !item.ghost) chip.addEventListener('click', () => selectQuality(item));
      fragment.appendChild(chip);
    }
    host.appendChild(fragment);
  }

  function memorySources(provider) {
    return qtiersOf(provider);
  }

  function selectProvider(name) {
    activeProvider = name;
    const seq = ++requestSeq;
    const cached = cacheGet(qualityKey(name));
    activeSources = cached ? cached.sources : [];
    ghostSources = activeSources.length ? [] : (memorySources(name).length ? memorySources(name) : tiersOf(name));
    renderServers();
    renderQualities();
    if (cached) return;
    fetchSources(name).then((result) => {
      if (disposed || seq !== requestSeq || activeProvider !== name) return;
      const sources = result && Array.isArray(result.sources) ? result.sources : [];
      if (!sources.length && !autoFallbackDone) {
        autoFallbackDone = true;
        const warmAlt = fallbackProvider();
        if (warmAlt) {
          autoSwitch(warmAlt, warmSources.get(warmAlt));
          return;
        }
        const list = Array.isArray(providers) ? providers : [];
        const index = list.findIndex((item) => item.name === name);
        const next = index >= 0 ? list[index + 1] : null;
        if (next) {
          renderQualities();
          selectProvider(next.name);
          return;
        }
      }
      if (sources.length) {
        activeSources = sources;
        ghostSources = [];
      }
      renderServers();
      renderQualities();
    });
  }

  // 播放地址是有签名的（?s=…），缓存里的可能已经过期 —— 所以播放前一律先换一次新鲜地址。
  function pickQuality(pool, wanted) {
    const list = Array.isArray(pool) ? pool : [];
    if (!list.length) return null;
    if (wanted === 'Auto') return list.find((entry) => /^auto$/i.test(String(entry.quality || ''))) || list[0];
    return list.find((entry) => String(entry.quality) === String(wanted)) || null;
  }

  function kindOf(url) {
    const text = String(url || '');
    if (/\.m3u8(\?|$)/i.test(text)) return 'hls';
    if (/\.mp4(\?|$)/i.test(text)) return 'mp4';
    if (/\.flv(\?|$)/i.test(text)) return 'flv';
    if (/\.mpd(\?|$)/i.test(text)) return 'dash';
    return 'hls';
  }

  function setChipBusy(quality, busy) {
    if (!panel) return;
    const chips = panel.querySelectorAll('.cf-mq-chip');
    for (const chip of chips) {
      if (chip.textContent !== String(quality)) continue;
      chip.classList.toggle('is-busy', !!busy);
      if (busy) chip.dataset.label = chip.textContent;
    }
  }

  async function selectQuality(item) {
    if (!current || item.ghost) return;
    const wanted = item.quality;
    const sig = filmSignature();
    setChipBusy(wanted, true);
    await ensureFilmId();
    if (disposed || !current || !current.id || filmSignature() !== sig) { setChipBusy(wanted, false); diag.playError = '影片未识别'; return; }
    let sources = [];
    try {
      const result = await fetchSources(activeProvider);
      if (filmSignature() !== sig) { setChipBusy(wanted, false); diag.playError = '换片了，丢弃上一次结果'; return; }
      sources = result && Array.isArray(result.sources) ? result.sources : [];
      activeSubtitles = result && Array.isArray(result.subtitles) ? result.subtitles.slice(0, 40) : [];
    } catch { sources = []; }
    if (sources.length) {
      activeSources = sources;
      ghostSources = [];
      renderQualities();
    }
    const pick = pickQuality(sources.length ? sources : activeSources, wanted) || (item.url ? item : null);
    setChipBusy(wanted, false);
    if (!pick || !pick.url) {
      diag.playError = '没有可用地址 · ' + wanted;
      if (panel) renderQualities();
      return;
    }
    const map = readJson(QUALITY_STORE_KEY, {});
    const key = contextKey();
    map[key] = { ...(map[key] || {}), provider: activeProvider, quality: wanted, height: pick.height || 0, at: Date.now() };
    writeJson(QUALITY_STORE_KEY, map, 200);
    let playUrl = pick.url;
    try {
      const proxied = await bridge().mediaProxy(pick.url);
      if (proxied && proxied.ok && proxied.url) playUrl = proxied.url;
    } catch { /* 代理不可用就用原地址 */ }
    const entry = { ...pick, url: playUrl, originUrl: pick.url, quality: wanted, provider: activeProvider, kind: kindOf(playUrl), filmSig: sig };
    const opened = playSource(entry);
    diag.lastPlay = { provider: activeProvider, quality: wanted, ok: opened };
    close();
    updateButtonLabel();
    if (opened) watchPlayback(entry);
  }

  // 播放没起来（403 / 网络 / CORS）就自动改用应用的代理传输再试一次，别让用户对着黑屏。
  function watchPlayback(entry) {
    const started = Date.now();
    const tick = () => {
      if (disposed) return;
      const video = videoElement();
      const modal = doc.querySelector('#playerModal');
      const open = modal && modal.classList.contains('is-open');
      if (!open) return;
      if (video && (video.readyState >= 2 || (Number.isFinite(video.duration) && video.duration > 0))) return;
      if (Date.now() - started < 6000) { window.setTimeout(tick, 400); return; }
      const failed = video && video.error;
      diag.playError = failed ? 'player error ' + video.error.code : 'no data after 6s';
      try {
        window.__cineflowOpenResourcePlayer({
          url: entry.url,
          kind: entry.kind || 'hls',
          title: (current && current.title) || '影视资源',
          sourceName: 'Movy · ' + (entry.provider || activeProvider),
          lineName: entry.quality || 'Auto',
          label: '内置源',
          playbackMode: 'proxy',
        });
      } catch { /* ignore */ }
    };
    window.setTimeout(tick, 400);
  }

  function positionPanel() {
    const btn = doc.getElementById('cfMovyQualityBtn');
    if (!btn || !panel) return;
    const rect = btn.getBoundingClientRect();
    const width = 336;
    const left = Math.min(Math.max(12, rect.left - 30), Math.max(12, window.innerWidth - width - 12));
    panel.style.width = width + 'px';
    panel.style.left = Math.round(left) + 'px';
    const spaceBelow = window.innerHeight - rect.bottom;
    panel.style.top = Math.round(spaceBelow > 360 ? rect.bottom + 8 : Math.max(12, rect.top - 8 - 400)) + 'px';
    panel.style.maxHeight = Math.round(Math.min(400, spaceBelow > 360 ? spaceBelow - 16 : window.innerHeight - 24)) + 'px';
  }

  function open() {
    diag.panelOpens += 1;
    const switched = syncFilm() || detectContext();
    if (switched) scheduleWarm();
    buildPanel();
    positionPanel();
    panel.classList.remove('is-hidden');
    // 第一帧：清单（localStorage 24h）+ 画质（内存/localStorage 30min），零网络往返
    const cachedList = providers || providersFromCache();
    if (cachedList) { providers = cachedList; renderServers(); }
    if (!activeProvider) {
      const chosen = readChoice(contextKey());
      activeProvider = (chosen && chosen.provider) || (providers && providers[0] && providers[0].name) || 'Miami';
    }
    renderQualities();
    loadPanelSources();

    // 第二帧：清单还没拿到才走一次 IPC（通常 <5ms）；预热早已在详情打开时开始
    if (!providers) loadProviders().then(() => {
      if (!activeProvider && providers && providers.length) selectProvider(providers[0].name);
    });
  }

  // 面板的第一帧：先吃缓存，再补网络；id 没解析出来就等解析完再来
  async function loadPanelSources() {
    const sig = filmSignature();
    if (!current || !current.id) await ensureFilmId();
    if (disposed || !current || filmSignature() !== sig) return;
    const cached = cacheGet(qualityKey(activeProvider));
    activeSources = cached ? cached.sources : [];
    const remembered = activeSources.length || justSwitched ? [] : memorySources(activeProvider);
    ghostSources = activeSources.length || justSwitched ? [] : (remembered.length ? remembered : tiersOf(activeProvider));
    justSwitched = false;
    renderQualities();
    if (cached) { scheduleWarm(false); return; }
    const seq = ++requestSeq;
    const target = activeProvider;
    fetchSources(target).then((result) => {
      if (disposed || seq !== requestSeq || activeProvider !== target) return;
      const sources = result && Array.isArray(result.sources) ? result.sources : [];
      if (!sources.length) {
        const alt = fallbackProvider();
        diag.openFallback = { alt, keys: [...warmSources.keys()], err: result && result.error };
        if (alt) autoSwitch(alt, warmSources.get(alt));
        return;
      }
      activeSources = sources;
      ghostSources = [];
      renderQualities();
      renderServers();
    });
    scheduleWarm(false);
  }

  function close() {
    if (panel) panel.classList.add('is-hidden');
  }

  function ensureButton() {
    const actions = doc.querySelector('#detailContent .detail-actions')
      || doc.querySelector('#detailPanel.is-open .detail-actions')
      || doc.querySelector('.detail-panel.is-open .detail-actions')
      || doc.querySelector('#detailContent .detail-info')
      || doc.querySelector('#detailContent');
    if (!actions) return false;
    if (diag.hosts.length < 4 && !diag.hosts.includes(actions.className)) diag.hosts.push(String(actions.className || actions.id || actions.tagName));
    const likeBtn = actions.querySelector('#detailLikeBtn');
    let btn = actions.querySelector('#cfMovyQualityBtn');
    if (!btn) {
      btn = doc.createElement('button');
      btn.id = 'cfMovyQualityBtn';
      btn.type = 'button';
      btn.className = 'secondary-button cf-mq-trigger';
      btn.innerHTML = '<span class="cf-mq-trigger-label">Quality</span><span class="cf-mq-caret" aria-hidden="true">▾</span>';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (panel && !panel.classList.contains('is-hidden')) close();
        else open();
      });
      if (likeBtn && likeBtn.parentElement === actions) likeBtn.insertAdjacentElement('afterend', btn);
      else actions.insertBefore(btn, actions.firstChild);
      diag.injects += 1;
    }
    updateButtonLabel();
    return true;
  }

  function updateButtonLabel() {
    const label = doc.querySelector('#cfMovyQualityBtn .cf-mq-trigger-label');
    if (!label) return;
    const chosen = readChoice(contextKey());
    label.textContent = chosen && chosen.quality ? 'Quality · ' + chosen.quality : 'Quality';
  }

  function onMutations() {
    if (disposed) return;
    diag.mutations += 1;
    const had = !!doc.getElementById('cfMovyQualityBtn');
    try { ensureButton(); } catch (error) {
      if (diag.errors.length < 8) diag.errors.push('ensureButton: ' + String((error && error.message) || error));
    }
    if (had && !doc.getElementById('cfMovyQualityBtn')) diag.removed += 1;
    // 详情面板一出现就识别当前影片；识别到新的就立刻开始预热（不必等用户点 Quality）
    try { hookOpenDetails(); } catch { /* ignore */ }
    try {
      const panelEl = doc.getElementById('detailPanel');
      if (panelEl && panelEl.classList.contains('is-open') && (syncFilm() || detectContext())) scheduleWarm();
    } catch { /* ignore */ }
    try { hookDetails(); } catch { /* ignore */ }
    try { hookPlayer(); } catch { /* ignore */ }
  }

  let observer = null;
  try {
    observer = new doc.defaultView.MutationObserver(() => {
      if (disposed) return;
      try { onMutations(); } catch { /* ignore */ }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  } catch { /* ignore */ }

  const onResize = () => { if (panel && !panel.classList.contains('is-hidden')) positionPanel(); };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onResize, { capture: true, passive: true });
  doc.addEventListener('keydown', onKeydown, true);

  // 预热结果推送：一台一台落地，弹层开着就实时更新
  let offWarm = null;
  try { offWarm = bridge().onWarm ? bridge().onWarm((row) => { try { applyRow(row); } catch { /* ignore */ } }) : null; } catch { offWarm = null; }

  diag.inits += 1;
  onMutations();
  window.setTimeout(onMutations, 600);
  window.setTimeout(() => { if (!disposed && !providers) loadProviders(); }, 1200);

  return function dispose() {
    disposed = true;
    try { detailHookOff?.(); } catch { /* ignore */ }
    try { observer?.disconnect(); } catch { /* ignore */ }
    try { doc.removeEventListener('pointerdown', onOutside, true); } catch { /* ignore */ }
    try { doc.removeEventListener('keydown', onKeydown, true); } catch { /* ignore */ }
    try { window.removeEventListener('resize', onResize); } catch { /* ignore */ }
    try { offWarm?.(); } catch { /* ignore */ }
    try { panel?.remove(); } catch { /* ignore */ }
    panel = null;
  };
}

export default initMovyQualityMenu;

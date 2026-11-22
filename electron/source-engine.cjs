'use strict';

const { filterResources } = require('./resource-type-filter.cjs');
const cacheLayer = require('./cache-layer.cjs');
const telemetry = require('./telemetry.cjs');

const PER_SOURCE_BUDGET_MS = 5000;
const PER_REQUEST_TIMEOUT_MS = 6500;
const SOURCE_POOL = 8;
const TITLE_CONCURRENCY = 2;
const FIRST_DELIVERY_WAIT_MS = 1600;
const RELEASE_DEADLINE_MS = 2500;
const FULL_WAIT_MS = 20000;

const POSITIVE_TTL_MS = 4 * 60 * 1000;
const NEGATIVE_TTL_MS = 90 * 1000;
const AGG_CACHE_MAX = 24;
const RESPONSE_TTL_MS = 10 * 60 * 1000;
const RESPONSE_MAX = 420;
const TEST_TTL_MS = 2 * 60 * 1000;
const TEST_CACHE_MAX = 120;
const PLAYSOURCE_TTL_MS = 10 * 60 * 1000;
const PLAYSOURCE_CACHE_MAX = 60;
const PLAYSOURCE_BUDGET_MS = 5000;

const PLAYABLE_MEDIA_EXTENSION_RE = /\.(?:m3u8|mpd|mp4|m4v|webm|ogv|ogg|flv|ts|m2ts|mts|mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:$|[?#])/i;
const NATIVE_MEDIA_EXTENSION_RE = /\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:$|[?#])/i;
const MEDIA_PAGE_HINT_RE = /\/(?:share|play|player|embed|vodplay|video)\//i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/3.4.8';

const state = {
  installed: false,
  ipcMain: null,
  getSession: null,
  originalFindFiltered: null,
  originalGetSettings: null,
  originalTestSource: null,
  aggInflight: new Map(),
  remoteSearch: null,
  remoteTest: null,
  remoteSources: null
};

function setRemoteBridge(bridge = {}) {
  state.remoteSearch = typeof bridge.search === 'function' ? bridge.search : null;
  state.remoteTest = typeof bridge.test === 'function' ? bridge.test : null;
  state.remoteSources = typeof bridge.sources === 'function' ? bridge.sources : null;
  return true;
}

const engineResponseCache = cacheLayer.createCache({ namespace: 'engine.response', ttlMs: RESPONSE_TTL_MS, max: RESPONSE_MAX });
const engineAggCache = cacheLayer.createCache({ namespace: 'engine.agg', max: AGG_CACHE_MAX });
const engineTestCache = cacheLayer.createCache({ namespace: 'engine.test', ttlMs: TEST_TTL_MS, max: TEST_CACHE_MAX });
const enginePlaySourceCache = cacheLayer.createCache({ namespace: 'engine.playSource', ttlMs: PLAYSOURCE_TTL_MS, max: PLAYSOURCE_CACHE_MAX });

const engineLog = (...args) => {
  try { console.log('[CineFlow:Engine]', ...args); } catch {  }
};

function inferMediaKind(value = '', contentType = '') {
  const text = String(value || '').toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mpegurl') || type.includes('x-mpegurl') || type.includes('vnd.apple.mpegurl') || /\.m3u8(?:$|[?#])/i.test(text) || /m3u8/i.test(text)) {
    return 'hls';
  }
  if (type.includes('dash+xml') || type.includes('mpeg-dash') || /\.mpd(?:$|[?#])/i.test(text)) {
    return 'dash';
  }
  if (type.includes('x-flv') || type.includes('flv') || /\.flv(?:$|[?#])/i.test(text)) {
    return 'flv';
  }
  if (type.includes('mp2t') || type.includes('mpegts') || /\.(?:ts|m2ts|mts)(?:$|[?#])/i.test(text)) {
    return 'mpegts';
  }
  if (type.includes('mp4') || /\.m4v(?:$|[?#])/i.test(text) || /\.mp4(?:$|[?#])/i.test(text)) {
    return 'mp4';
  }
  if (type.includes('webm') || /\.webm(?:$|[?#])/i.test(text)) {
    return 'webm';
  }
  if (type.includes('ogg') || /\.(?:ogv|ogg)(?:$|[?#])/i.test(text)) {
    return 'ogg';
  }
  if (NATIVE_MEDIA_EXTENSION_RE.test(text) || type.startsWith('video/') || type.startsWith('audio/')) {
    return 'native';
  }
  if (MEDIA_PAGE_HINT_RE.test(text)) return 'page';
  return 'native';
}

function mediaFormatLabel(kind = 'native') {
  switch (kind) {
    case 'hls': return 'HLS';
    case 'dash': return 'DASH';
    case 'flv': return 'FLV';
    case 'mpegts': return 'MPEG-TS';
    case 'mp4': return 'MP4';
    case 'webm': return 'WebM';
    case 'ogg': return 'OGG';
    case 'page': return '网页解析';
    default: return '直连';
  }
}

function playbackMetaForUrl(value = '', lineName = '') {
  const url = String(value || '');
  const kind = inferMediaKind(url);
  const name = String(lineName || '').toLowerCase();
  const needsResolve = kind === 'page' || (!PLAYABLE_MEDIA_EXTENSION_RE.test(url) && MEDIA_PAGE_HINT_RE.test(url));
  let format = mediaFormatLabel(kind);
  if (needsResolve) {
    format = name.includes('m3u8') ? '网页解析·HLS' : '网页解析';
  }
  return { kind, format, needsResolve };
}

function normalizeResourceTitle(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\[[^\]]*?(解说|预告|花絮|短评)[^\]]*?\]/g, '')
    .replace(/【[^】]*?(解说|预告|花絮|短评)[^】]*?】/g, '')
    .replace(/\([^)]*?(解说|预告|花絮|短评|原声版|普通话|国语|粤语|英语|中字|字幕)[^)]*?\)/g, '')
    .replace(/（[^）]*?(解说|预告|花絮|短评|原声版|普通话|国语|粤语|英语|中字|字幕)[^）]*?）/g, '')
    .replace(/第[一二三四五六七八九十0-9]+季/g, '')
    .replace(/[\s·・:：,，.。!！?？'"“”‘’《》〈〉\-—_/\\|]+/g, '')
    .trim();
}

function releaseYearOf(payload = {}) {
  return String(payload.year || payload.releaseYear || payload.releaseDate || '')
    .match(/\d{4}/)?.[0] || '';
}

function resourceCandidateScore(item, titles, releaseYear) {
  const rawName = String(item?.vod_name || item?.name || '');
  const name = normalizeResourceTitle(rawName);
  if (!name) return -999;

  let best = -999;
  for (const title of titles) {
    const target = normalizeResourceTitle(title);
    if (!target) continue;
    let score = -999;
    if (name === target) {
      score = 110;
    } else if (name.startsWith(target)) {
      const suffix = name.slice(target.length);
      score = /^(19|20)\d{2}$/.test(suffix)
        ? 70
        : /^[0-9一二三四五六七八九十]/.test(suffix) && !/[0-9一二三四五六七八九十]$/.test(target)
          ? 22
          : 72 - Math.min(18, suffix.length * 2);
    } else if (target.startsWith(name) && target.length - name.length <= 4) {
      score = 58;
    } else if (name.includes(target) && target.length >= 4) {
      score = 52 - Math.min(12, name.length - target.length);
    }
    best = Math.max(best, score);
  }

  const haystack = `${rawName} ${item?.type_name || ''} ${item?.vod_remarks || ''}`;
  if (/(解说|预告|花絮|短评)/i.test(haystack)) best -= 80;
  if (/(体育|NBA|CBA|WTA|世界杯|比赛)/i.test(haystack)) best -= 36;
  const itemYear = String(item?.vod_year || item?.year || '').match(/\d{4}/)?.[0] || '';
  if (releaseYear && itemYear) best += itemYear === releaseYear ? 12 : -8;
  return best;
}

function uniqueResourceQueries(payload = {}) {
  const values = [
    payload.title,
    payload.originalTitle,
    String(payload.title || '').replace(/[：:].*$/, ''),
    String(payload.title || '').replace(/[（(].*?[）)]/g, '')
  ];
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function parsePlayGroups(item = {}) {
  const fromGroups = String(item.vod_play_from || item.play_from || '默认线路').split('$$$');
  const urlGroups = String(item.vod_play_url || item.play_url || '').split('$$$');
  return urlGroups
    .map((group, index) => {
      const episodes = String(group || '')
        .split('#')
        .map((segment, episodeIndex) => {
          const clean = segment.trim();
          if (!clean) return null;
          const dollarIndex = clean.lastIndexOf('$');
          const label = dollarIndex > 0 ? clean.slice(0, dollarIndex) : `播放 ${episodeIndex + 1}`;
          const url = dollarIndex > 0 ? clean.slice(dollarIndex + 1) : clean;
          if (!/^https?:\/\//i.test(url)) return null;
          const meta = playbackMetaForUrl(url, fromGroups[index] || fromGroups[0] || '');
          return {
            label: label.trim() || `播放 ${episodeIndex + 1}`,
            url,
            kind: meta.kind,
            format: meta.format,
            needsResolve: meta.needsResolve
          };
        })
        .filter(Boolean)
        .slice(0, 240);
      if (!episodes.length) return null;
      return {
        name: (fromGroups[index] || fromGroups[0] || `线路 ${index + 1}`).trim() || `线路 ${index + 1}`,
        episodes
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function compactResourceItem(source, item, payload) {
  const groups = parsePlayGroups(item);
  if (!groups.length) return null;
  const first = groups[0]?.episodes?.[0];
  const seasonEpisodeCount = groups.reduce((max, group) => Math.max(max, group.episodes.length), 0);
  const formats = Array.from(new Set(groups.flatMap((group) => group.episodes.map((episode) => episode.format).filter(Boolean)))).slice(0, 5);
  return {
    sourceKey: source.key,
    sourceName: source.name,
    title: String(item.vod_name || payload.title || '未命名资源'),
    year: String(item.vod_year || ''),
    type: String(item.type_name || ''),
    remarks: String(item.vod_remarks || item.vod_pubdate || ''),
    updatedAt: String(item.vod_time || item.vod_time_add || ''),
    poster: /^https?:\/\//i.test(String(item.vod_pic || '')) ? String(item.vod_pic) : '',
    firstUrl: first?.url || '',
    firstLabel: first?.label || '播放',
    formats,
    isSeries: seasonEpisodeCount > 1,
    seasonEpisodeCount,
    playGroupCount: groups.length,
    episodeCount: groups.reduce((total, group) => total + group.episodes.length, 0),
    lines: groups.map((group) => ({
      name: group.name,
      episodes: group.episodes
    }))
  };
}

function getCachedResponse(cacheKey) {
  const hit = engineResponseCache.get(cacheKey);
  return hit ? hit.value : null;
}

function setCachedResponse(cacheKey, payload) {
  engineResponseCache.set(cacheKey, payload);
}

async function engineFetchJson(source, params = {}, timeoutMs = PER_REQUEST_TIMEOUT_MS) {
  const url = new URL(source.api);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const cacheKey = `${source.key}|${url.searchParams.toString()}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) return cached;

  const session = state.getSession();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await session.defaultSession.fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain, */*', 'user-agent': UA }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`资源源请求失败：${response.status}`);
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed || trimmed[0] === '<') throw new Error('资源源返回格式不可用。');
    const payload = JSON.parse(trimmed);
    if (!payload || !Array.isArray(payload.list)) throw new Error('资源源返回格式不可用。');
    setCachedResponse(cacheKey, payload);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function hydrateDetail(source, item, deadline) {
  if (parsePlayGroups(item).length || !item?.vod_id) return item;
  const remaining = () => Math.max(600, Math.min(PER_REQUEST_TIMEOUT_MS, deadline - Date.now()));
  const attempts = ['detail', 'videolist'].map(async (ac) => {
    try {
      const detail = await engineFetchJson(source, { ac, ids: item.vod_id }, remaining());
      const detailItem = Array.isArray(detail?.list) ? detail.list[0] : null;
      if (detailItem) return detailItem;
    } catch {  }
    return null;
  });
  try {
    const detailItem = await Promise.any(attempts.map((attempt) => attempt.then((value) => {
      if (value) return value;
      throw new Error('empty');
    })));
    if (detailItem) return { ...item, ...detailItem };
  } catch {  }
  return item;
}

async function processTitle(source, payload, titles, releaseYear, deadline, data) {
  const list = Array.isArray(data?.list) ? data.list : [];
  const candidates = list
    .map((item) => ({ item, score: resourceCandidateScore(item, titles, releaseYear) }))
    .filter((entry) => entry.score >= 44)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  for (const { item } of candidates) {
    if (Date.now() >= deadline) return null;
    const hydrated = await hydrateDetail(source, item, deadline);
    const compact = compactResourceItem(source, hydrated, payload);
    if (compact) return compact;
  }
  return null;
}

async function searchSource(source, payload, deadline) {
  if (state.remoteSearch) {
    try {
      const bridged = await state.remoteSearch(source, payload, deadline);
      if (bridged !== undefined) return bridged;
    } catch (error) {
      engineLog('远程库查询异常，回落 CMS:', error && error.message);
    }
  }
  const titles = uniqueResourceQueries(payload);
  if (!titles.length) return null;
  const releaseYear = releaseYearOf(payload);

  const remaining = () => deadline - Date.now();
  const startFetch = (index) => {
    const timeout = Math.max(600, Math.min(PER_REQUEST_TIMEOUT_MS, remaining()));
    return engineFetchJson(source, { ac: 'videolist', wd: titles[index] }, timeout)
      .then((data) => ({ ok: true, data }))
      .catch(() => ({ ok: false }));
  };

  let launched = 0;
  const inflight = [];
  const launch = () => {
    if (launched < titles.length && inflight.length < TITLE_CONCURRENCY && remaining() > 300) {
      inflight.push({ index: launched, promise: startFetch(launched) });
      launched += 1;
    }
  };

  for (let i = 0; i < titles.length; i += 1) {
    launch();
    const job = inflight.shift();
    if (!job) break;
    const result = await job.promise;
    launch();
    if (result?.ok) {
      const compact = await processTitle(source, payload, titles, releaseYear, deadline, result.data);
      if (compact) return compact;
    }
    if (remaining() <= 0) return null;
  }
  return null;
}

function cacheKeyOf(revision, payload = {}) {
  return [
    Number(revision || 0),
    String(payload.mediaType || 'movie'),
    String(payload.title || '').trim(),
    String(payload.originalTitle || '').trim(),
    String(payload.year || payload.releaseDate || '').slice(0, 4)
  ].join('|');
}

function selectSources(settings) {
  const mode = String(settings?.mode || 'stable');
  const list = (Array.isArray(settings?.sources) ? settings.sources : [])
    .filter((source) => source && source.enabled !== false && Array.isArray(source.modes) && source.modes.includes(mode));
  if (typeof state.remoteSources === 'function') {
    try {
      const extra = state.remoteSources(mode) || [];
      const seen = new Set(list.map((source) => String(source && source.api || '')));
      const ahead = [];
      for (const item of extra) {
        const api = String(item && item.api || '');
        if (!api || seen.has(api)) continue;
        seen.add(api);
        ahead.push(item);
      }

      return ahead.concat(list);
    } catch (error) {
      engineLog('远程库注入失败，按原有源继续:', error && error.message);
    }
  }
  return list;
}

function wakeWaiters(agg) {
  const waiters = agg.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function pumpDelivery(agg) {

  if (!agg.firstDeliveredAt && agg.delivered.length) agg.firstDeliveredAt = Date.now();
  if (agg.released) {
    const ready = [];
    for (let i = 0; i < agg.slots.length; i += 1) {
      if (!agg.deliveredRanks.has(i) && agg.slots[i]) ready.push(i);
    }
    ready.sort((a, b) => a - b);
    for (const i of ready) deliverRank(agg, i);
  } else {
    for (let i = 0; i < agg.slots.length; i += 1) {
      if (agg.slots[i] === undefined) break;
      if (!agg.deliveredRanks.has(i)) deliverRank(agg, i);
    }
  }
  wakeWaiters(agg);
}

function deliverRank(agg, rank) {
  const resource = agg.slots[rank];
  agg.deliveredRanks.add(rank);
  if (!resource) return;
  const verdict = filterResources([resource], agg.payload);
  if (verdict.resources.length) agg.delivered.push(verdict.resources[0]);
  else agg.dropped.push(...verdict.dropped);
}

function startAggregation(key, payload, settings) {
  const sources = selectSources(settings);
  const agg = {
    key,
    payload,
    total: sources.length,
    completed: 0,
    done: false,
    released: false,
    slots: new Array(sources.length).fill(undefined),
    delivered: [],
    deliveredRanks: new Set(),
    dropped: [],
    startedAt: Date.now(),
    waiters: []
  };

  const queue = sources.map((source, rank) => ({ source, rank }));
  const aggDone = telemetry.timer('engine.agg');
  const workers = Array.from({ length: Math.min(SOURCE_POOL, queue.length) }, async () => {
    while (queue.length) {
      const { source, rank } = queue.shift();
      const deadline = Date.now() + PER_SOURCE_BUDGET_MS;
      let resource = null;
      try {
        resource = await searchSource(source, payload, deadline);
      } catch { resource = null; }
      if (agg.slots[rank] === undefined) agg.slots[rank] = resource;
      agg.completed += 1;
      pumpDelivery(agg);
    }
  });

  Promise.all(workers)
    .catch(() => {})
    .then(() => {
      agg.done = true;
      clearTimeout(agg.releaseTimer);
      aggDone({ total: agg.total, title: String(payload.title || '').slice(0, 40), hits: agg.slots.filter(Boolean).length, firstDeliveryMs: agg.firstDeliveredAt ? agg.firstDeliveredAt - agg.startedAt : null });

      for (let i = 0; i < agg.slots.length; i += 1) {
        if (agg.slots[i] === undefined) agg.slots[i] = null;
      }
      pumpDelivery(agg);
      finalizeCache(key, agg);
      if (state.aggInflight.get(key) === agg) state.aggInflight.delete(key);
    });

  agg.releaseTimer = setTimeout(() => {
    agg.released = true;
    pumpDelivery(agg);
  }, RELEASE_DEADLINE_MS);
  if (typeof agg.releaseTimer.unref === 'function') agg.releaseTimer.unref();

  engineLog(`开始聚合：${agg.total} 个源 · 「${String(payload.title || '').trim()}」`);
  return agg;
}

function finalizeCache(key, agg) {
  const resources = [];
  for (let i = 0; i < agg.slots.length; i += 1) {
    if (agg.slots[i]) resources.push(agg.slots[i]);
  }
  const verdict = filterResources(resources, agg.payload);
  const entry = {
    resources: verdict.resources,
    dropped: verdict.dropped,
    filteredOut: verdict.dropped.length,
    total: agg.total,
    nextCursor: verdict.resources.length
  };
  agg.dropped = verdict.dropped;
  engineAggCache.set(key, entry, verdict.resources.length ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);

  warmTopResources(verdict.resources.slice(0, 4));
}

function warmTopResources(resources) {
  const session = state.getSession?.();
  if (!session || !resources.length) return;
  const queue = resources.map((resource) => resource.firstUrl).filter((url) => /^https?:\/\//i.test(url) && !resourceNeedsResolve(url));
  if (!queue.length) return;
  telemetry.count('warm.queued', queue.length);
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await session.defaultSession.fetch(url, {
          method: 'GET',
          headers: { range: 'bytes=0-127', 'user-agent': UA },
          signal: controller.signal
        });

        try { require('./source-compat.cjs')._internals.registerMediaHost(url, new URL(url).origin); } catch {  }
        await response.arrayBuffer().catch(() => {});
        telemetry.count(response.ok ? 'warm.ok' : 'warm.fail');
      } catch {
        telemetry.count('warm.fail');
      } finally {
        clearTimeout(timer);
      }
    }
  };
  void Promise.all([worker(), worker(), worker(), worker()]);
}

function resourceNeedsResolve(url) {
  return !PLAYABLE_MEDIA_EXTENSION_RE.test(String(url || '')) && MEDIA_PAGE_HINT_RE.test(String(url || ''));
}

function waitOn(agg, check, timeoutMs) {
  if (check()) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const waiter = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      resolve();
    };
    timer = setTimeout(waiter, Math.max(0, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
    agg.waiters.push(waiter);
  });
}

function emptyResult(settings) {
  return {
    ...(settings || {}),
    checked: 0,
    total: 0,
    nextCursor: 0,
    done: true,
    batches: 1,
    resources: [],
    filteredOut: 0,
    dropped: []
  };
}

function cachedResult(settings, entry) {
  const cached = entry;
  return {
    ...settings,
    checked: cached.total,
    total: cached.total,
    nextCursor: cached.nextCursor,
    done: true,
    batches: 1,
    resources: cached.resources,
    filteredOut: cached.filteredOut,
    dropped: cached.dropped,
    prewarmed: true
  };
}

async function loadSettings() {
  const handler = state.originalGetSettings;
  if (typeof handler !== 'function') return null;
  return handler({});
}

async function findMovieFilteredHandler(event, payload = {}, options = {}) {
  const settings = await loadSettings();
  if (!settings || settings.enabled === false) return emptyResult(settings);

  const sources = selectSources(settings);
  if (!sources.length) return emptyResult(settings);

  const key = cacheKeyOf(settings.revision, payload);
  const cachedHit = engineAggCache.get(key);
  if (cachedHit) return cachedResult(settings, cachedHit.value);

  let agg = state.aggInflight.get(key);
  if (!agg) {
    agg = startAggregation(key, payload, settings);
    state.aggInflight.set(key, agg);
  }

  const cursor = Math.max(0, Number(options?.cursor || 0));
  const limit = Number(options?.limit || 0);

  if (!limit) {

    await waitOn(agg, () => agg.done, FULL_WAIT_MS);
    const resources = agg.delivered.slice();
    return {
      ...settings,
      checked: agg.completed,
      total: agg.total,
      nextCursor: resources.length,
      done: true,
      batches: 1,
      resources,
      filteredOut: agg.dropped.length,
      dropped: agg.dropped
    };
  }

  if (cursor === 0) {

    await waitOn(agg, () => agg.delivered.length >= Math.min(limit, 3) || agg.done, FIRST_DELIVERY_WAIT_MS);
  }
  pumpDelivery(agg);

  const slice = agg.delivered.slice(cursor, cursor + limit);
  const done = agg.done && cursor + slice.length >= agg.delivered.length;
  return {
    ...settings,
    checked: agg.completed,
    total: agg.total,
    nextCursor: cursor + slice.length,
    done,
    batches: 1,
    resources: slice,
    filteredOut: agg.done ? agg.dropped.length : 0,
    dropped: agg.done ? agg.dropped : []
  };
}

async function testSourceHandler(event, payload = {}) {
  const cacheId = `${String(payload?.key || '')}|${String(payload?.api || '')}`;
  const cachedHit = engineTestCache.get(cacheId);
  if (cachedHit) return cachedHit.value;

  const settings = await loadSettings().catch(() => null);
  const merged = Array.isArray(settings?.sources) ? settings.sources : [];
  const source = merged.find(
    (item) => (payload?.key && item.key === payload.key) || (payload?.api && item.api === payload.api)
  );
  if (!source) return { ok: false, error: '未找到该播放源' };

  if (state.remoteTest) {
    try {
      const remoteResult = await state.remoteTest(source);
      if (remoteResult !== undefined) {
        engineTestCache.set(cacheId, remoteResult);
        return remoteResult;
      }
    } catch (error) {
      engineLog('远程库测速异常，回落 CMS:', error && error.message);
    }
  }

  let url;
  try { url = new URL(source.api); } catch { return { ok: false, error: '源地址不合法' }; }
  url.searchParams.set('ac', 'list');

  const session = state.getSession();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await session.defaultSession.fetch(url.toString(), {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json, text/plain, */*', 'user-agent': UA }
    });

    const elapsedMs = Date.now() - startedAt;
    let text = '';
    try {
      text = await Promise.race([
        response.text(),
        new Promise((resolve) => setTimeout(() => resolve(''), 1500))
      ]);
    } catch { text = ''; }
    const head = text.trimStart().slice(0, 1);
    const kind = head === '<' ? 'xml' : (head === '{' || head === '[' ? 'json' : 'text');
    const result = response.ok
      ? { ok: true, elapsedMs, status: response.status, kind, bytes: text.length }
      : { ok: false, elapsedMs, status: response.status, error: `HTTP ${response.status}` };
    engineTestCache.set(cacheId, result);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    return {
      ok: false,
      elapsedMs,
      error: aborted ? `超时 ${Math.round(PER_REQUEST_TIMEOUT_MS / 1000)}s` : (error?.message || '请求失败')
    };
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleSourceWarmup() {
  const { app } = require('electron');
  const ready = app && app.isReady() ? Promise.resolve() : (app ? app.whenReady() : Promise.resolve());
  ready.then(() => setTimeout(run, 2500).unref?.()).catch(() => {});

  async function run() {
    try {
      const settings = await loadSettings();
      const sources = selectSources(settings).slice(0, 6);
      const session = state.getSession();
      const origins = [...new Set(sources.map((source) => {
        try { const url = new URL(source.api); return `${url.protocol}//${url.host}`; } catch { return ''; }
      }).filter(Boolean))];
      if (!origins.length) return;
      engineLog(`闲时预热 ${origins.length} 个源主机连接`);
      await Promise.allSettled(origins.map(async (origin) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          await session.defaultSession.fetch(`${origin}/favicon.ico`, {
            method: 'GET',
            headers: { range: 'bytes=0-0', 'user-agent': UA },
            cache: 'no-store',
            signal: controller.signal
          });
        } catch {  }
        finally { clearTimeout(timer); }
      }));
    } catch {  }
  }
}

function flipMediaType(mediaType) {
  return mediaType === 'tv' ? 'movie' : 'tv';
}

async function queryRuyiOnce(source, payload, mediaType, deadline) {
  const query = { ...payload, mediaType };
  const compact = await searchSource(source, query, deadline);
  if (!compact) return null;
  const verdict = filterResources([compact], query);
  return verdict.resources[0] || null;
}

async function playSourceHandler(event, payload = {}) {
  const settings = await loadSettings().catch(() => null);
  if (!settings) return state.originalPlaySource(event, payload);
  const ruyi = (settings.sources || []).find((source) => source.key === 'ruyi' || (source.name || '').includes('如意'));
  if (!ruyi) return state.originalPlaySource(event, payload);

  const mediaType = String(payload?.mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
  const cacheKey = [
    Number(settings.revision || 0),
    mediaType,
    String(payload?.title || '').trim(),
    String(payload?.originalTitle || '').trim(),
    String(payload?.year || '').slice(0, 4)
  ].join('|');
  const cachedHit = enginePlaySourceCache.get(cacheKey);
  if (cachedHit) return cachedHit.value;

  const deadline = Date.now() + PLAYSOURCE_BUDGET_MS;
  let resource = await queryRuyiOnce(ruyi, payload, mediaType, deadline).catch(() => null);
  let usedType = mediaType;
  if (!resource) {
    usedType = flipMediaType(mediaType);
    resource = await queryRuyiOnce(ruyi, payload, usedType, Date.now() + PLAYSOURCE_BUDGET_MS).catch(() => null);
  }

  if (!resource) {

    return state.originalPlaySource(event, payload);
  }

  if (usedType !== mediaType) {
    engineLog(`豆瓣兜底命中（类型纠偏 ${mediaType}→${usedType}）: ${resource.title} · ${resource.lines.length} 线路`);
    telemetry.record('playsource.flip', { title: resource.title, from: mediaType, to: usedType, lines: resource.lines.length });
  }
  const result = { ok: true, sourceKey: 'ruyi', sourceName: '如意资源', resource };
  enginePlaySourceCache.set(cacheKey, result);
  return result;
}

function installSourceEngine({ ipcMain, session }) {
  if (state.installed || !ipcMain) return false;
  const handlers = ipcMain._invokeHandlers;
  const originalFindFiltered = handlers.get('resources:findMovieFiltered');
  const originalGetSettings = handlers.get('app:getResourceSettings');
  const originalTestSource = handlers.get('resources:testSource');
  if (typeof originalFindFiltered !== 'function' || typeof originalGetSettings !== 'function') {
    engineLog('基线通道未就绪，聚合引擎未启用（基线行为不受影响）');
    return false;
  }

  state.installed = true;
  state.ipcMain = ipcMain;
  state.getSession = session ? () => session : () => require('electron').session.defaultSession;
  state.originalFindFiltered = originalFindFiltered;
  state.originalGetSettings = originalGetSettings;
  state.originalTestSource = typeof originalTestSource === 'function' ? originalTestSource : null;

  handlers.set('resources:findMovieFiltered', async (event, payload, options) => {
    try {
      return await findMovieFilteredHandler(event, payload, options);
    } catch (error) {
      engineLog('聚合引擎异常，回落基线:', error && error.message);
      return originalFindFiltered(event, payload, options);
    }
  });

  if (state.originalTestSource) {
    handlers.set('resources:testSource', async (event, payload) => {
      try {
        return await testSourceHandler(event, payload);
      } catch (error) {
        engineLog('测速引擎异常，回落基线:', error && error.message);
        return state.originalTestSource(event, payload);
      }
    });
  }

  engineLog('已安装（全源并发聚合 + 渐进分批 + 每源 5s 预算 + TTFB 测速）');
  try { scheduleSourceWarmup(); } catch {  }
  return true;
}

module.exports = {
  installSourceEngine,
  setRemoteBridge,
  _internals: {
    cacheKeyOf,
    selectSources,
    searchSource,
    startAggregation,
    pumpDelivery,
    cachedResult,
    resourceCandidateScore,
    uniqueResourceQueries,
    parsePlayGroups,
    compactResourceItem,
    normalizeResourceTitle,
    playSourceHandler,
    queryRuyiOnce,
    state
  }
};

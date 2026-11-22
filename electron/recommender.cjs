'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { genreNamesFromIds } = require('./rec-genres.cjs');

const USER_ID = 'cineflow-local';
const REBUILD_EVENT_THRESHOLD = 150;
const REBUILD_MIN_INTERVAL_MS = 30 * 60 * 1000;
const FINISHED_RATIO = 0.96;

const TRACK_TYPE_MAP = {
  click: 'click',
  play: 'play',
  finish: 'finish',
  like: 'like',
  imp: 'imp',
  rate: 'rate',
};

function contentKeyOf(mediaType, id) {
  return `${mediaType === 'tv' ? 'tv' : 'movie'}:${id}`;
}

function asarReal(p) {
  if (!p || !p.includes('app.asar') || p.includes('app.asar.unpacked')) return p;
  return p.replace('app.asar', 'app.asar.unpacked');
}

function mergeGenres(a = [], b = []) {
  const out = [];
  const seen = new Set();
  for (const name of [...a, ...b]) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function mergeItemMeta(prev, next) {
  if (!prev) return next;
  const merged = { ...prev, ...next };
  merged.genres = mergeGenres(prev.genres, next.genres);
  if (!next.overview && prev.overview) merged.overview = prev.overview;
  const prevActors = Array.isArray(prev.actors) ? prev.actors : [];
  const nextActors = Array.isArray(next.actors) ? next.actors : [];
  merged.actors = nextActors.length ? nextActors : prevActors;
  if (!next.overview && !merged.overview) delete merged.overview;
  if (!merged.actors || !merged.actors.length) delete merged.actors;
  if (!merged.releaseDate && prev.releaseDate) merged.releaseDate = prev.releaseDate;
  if (!merged.rating && prev.rating) merged.rating = prev.rating;
  if (!merged.title && prev.title) merged.title = prev.title;
  const prevExtra = prev.extra || {};
  const nextExtra = next.extra || {};
  merged.extra = { ...prevExtra, ...nextExtra };

  for (const [key, value] of Object.entries(merged.extra)) {
    if (value === undefined || value === null || value === '') {
      if (prevExtra[key] !== undefined) merged.extra[key] = prevExtra[key];
      else delete merged.extra[key];
    }
  }
  if (!Object.keys(merged.extra).length) delete merged.extra;
  if (!merged.genres.length) merged.genres = [];
  return merged;
}

function cardToItemMeta(card) {
  if (!card || card.id === undefined || card.id === null) return null;
  const isDouban = Boolean(card.cf8Douban);
  const mediaType = card.mediaType === 'tv' ? 'tv' : 'movie';
  const id = isDouban
    ? `douban:${card.id}`
    : contentKeyOf(mediaType, card.id);
  if (!String(id).trim()) return null;

  const rawGenres = Array.isArray(card.genres) ? card.genres.filter((g) => typeof g === 'string' && g) : [];
  const genres = mergeGenres(rawGenres, genreNamesFromIds(card.genreIds, mediaType));
  const extra = {};
  const poster = card.posterPath || card.cf8Cover;
  if (poster) extra.posterPath = String(poster);
  if (card.backdropPath) extra.backdropPath = String(card.backdropPath);
  if (card.voteCount !== undefined && card.voteCount !== null) extra.voteCount = Number(card.voteCount) || 0;
  if (Array.isArray(card.genreIds) && card.genreIds.length) extra.genreIds = card.genreIds.map(Number).filter(Number.isFinite).join(',');
  if (isDouban) extra.cf8 = true;

  let releaseDate = card.releaseDate ? String(card.releaseDate).slice(0, 10) : '';
  if (!releaseDate && card.year && /^\d{4}$/.test(String(card.year))) releaseDate = `${card.year}-01-01`;

  const rating = Number(card.voteAverage ?? card.cf8Rating ?? 0);
  return {
    id: String(id),
    title: String(card.title || '未命名'),
    genres,
    overview: card.overview ? String(card.overview) : undefined,
    actors: Array.isArray(card.actors) ? card.actors.map(String) : undefined,
    releaseDate: releaseDate || undefined,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    extra,
  };
}

function itemToCard(meta) {
  if (!meta || typeof meta.id !== 'string') return null;
  if (meta.id.startsWith('douban:')) return null;
  const sep = meta.id.indexOf(':');
  if (sep <= 0) return null;
  const mediaType = meta.id.slice(0, sep) === 'tv' ? 'tv' : 'movie';
  const id = Number(meta.id.slice(sep + 1));
  if (!Number.isFinite(id)) return null;
  const extra = meta.extra || {};
  let genreIds = [];
  if (typeof extra.genreIds === 'string' && extra.genreIds) {
    genreIds = extra.genreIds.split(',').map(Number).filter(Number.isFinite);
  }
  return {
    id,
    mediaType,
    title: meta.title,
    overview: meta.overview || '',
    posterPath: extra.posterPath || null,
    backdropPath: extra.backdropPath || null,
    voteAverage: Number(meta.rating || 0),
    voteCount: Number(extra.voteCount || 0),
    releaseDate: meta.releaseDate || '',
    genreIds,
    popularity: Number(extra.popularity || 0),
    adult: false,
  };
}

function initEngineResilient(engine, log) {
  try {
    return engine.init();
  } catch (err) {
    try {
      const store = engine.store;
      engine.buildState(store.loadItems(), store.loadEvents(), store.loadOnboarding(), {
        buildIfMissing: false,
      });
      engine.__cfDegraded = true;
      log('工件落盘不可用，已降级为纯内存模式继续运行:', err && err.message);
      return engine;
    } catch (err2) {
      log('引擎降级初始化亦失败:', err2 && err2.message);
      throw err;
    }
  }
}

async function createRecommenderCore({ dataDir, engineEntry, configPath, log = () => {} } = {}) {
  const entry = asarReal(engineEntry || path.join(__dirname, 'rec-engine', 'dist', 'engine.js'));

  const { RecEngine } = await import(pathToFileURL(entry).href);
  const engine = initEngineResilient(
    new RecEngine(dataDir, configPath ? asarReal(configPath) : undefined),
    log
  );
  const state = { eventsSinceRebuild: 0, lastRebuildAt: Date.now() };

  const CATALOG_SCHEMA_VERSION = 2;
  const schemaPath = path.join(dataDir, 'catalog-schema.json');

  function readSchemaVersion() {
    try {
      const raw = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const version = Number(raw && raw.version);
      return Number.isFinite(version) ? version : 0;
    } catch {
      return 0;
    }
  }

  function repairCatalogGenres() {
    let catalog = [];
    try {
      catalog = engine.catalog || [];
    } catch {
      return { items: 0, repaired: 0 };
    }
    if (!catalog.length) return { items: 0, repaired: 0 };
    let repaired = 0;
    const next = catalog.map((item) => {
      const current = Array.isArray(item.genres) ? item.genres : [];
      const extra = item.extra || {};
      const ids = typeof extra.genreIds === 'string' && extra.genreIds ? extra.genreIds : [];
      const fallback = genreNamesFromIds(ids, String(item.id).startsWith('tv:') ? 'tv' : 'movie');
      const merged = mergeGenres(current, fallback);
      if (merged.length === current.length) return item;
      repaired += 1;
      return { ...item, genres: merged };
    });
    if (repaired) engine.upsertItems(next);
    return { items: catalog.length, repaired };
  }

  function migrateCatalog() {
    const version = readSchemaVersion();
    if (version >= CATALOG_SCHEMA_VERSION) return { skipped: true, version };
    let stats = { items: 0, repaired: 0 };
    try {
      stats = repairCatalogGenres();

      engine.rebuild();
    } catch (err) {
      log('存量物料迁移失败(下次启动重试):', err && err.message);
      return { failed: true, items: stats.items, repaired: stats.repaired };
    }
    try {
      fs.writeFileSync(
        schemaPath,
        JSON.stringify({ version: CATALOG_SCHEMA_VERSION, at: Date.now(), ...stats }),
        'utf8'
      );
    } catch (err) {
      log('catalog-schema.json 写入失败:', err && err.message);
    }
    log(
      '存量物料迁移完成: 物料 ' + stats.items + ' 条，补全类型 ' + stats.repaired + ' 条，工件已重建'
    );
    return { items: stats.items, repaired: stats.repaired, version: CATALOG_SCHEMA_VERSION };
  }

  const migration = migrateCatalog();

  function upsertCards(cards) {
    const metas = (cards || []).map(cardToItemMeta).filter(Boolean);
    if (!metas.length) return 0;

    let existing = new Map();
    try {
      existing = new Map((engine.catalog || []).map((it) => [it.id, it]));
    } catch {  }
    const merged = metas.map((meta) => mergeItemMeta(existing.get(meta.id), meta));
    engine.upsertItems(merged);
    return merged.length;
  }

  function maybeRebuild() {
    if (state.eventsSinceRebuild < REBUILD_EVENT_THRESHOLD) return;
    if (Date.now() - state.lastRebuildAt < REBUILD_MIN_INTERVAL_MS) return;
    try {
      const stats = engine.rebuild();
      state.eventsSinceRebuild = 0;
      state.lastRebuildAt = Date.now();
      log(`rebuild 完成: ${JSON.stringify(stats)}`);
    } catch (err) {
      log('rebuild 失败(不影响推荐):', err && err.message);
    }
  }

  function metaOf(itemId) {
    return engine.catalog.find((c) => c.id === String(itemId)) || null;
  }

  return {
    engine,
    upsertCards,

    track(events = []) {
      upsertCards(events.filter((e) => e && e.card).map((e) => e.card));
      const mapped = (events || [])
        .filter((e) => e && e.key && TRACK_TYPE_MAP[e.type])
        .map((e) => ({
          userId: USER_ID,
          itemId: String(e.key),
          type: TRACK_TYPE_MAP[e.type],
          value: e.value,
          ts: Number(e.ts) || Date.now(),
        }));
      engine.track(mapped);
      state.eventsSinceRebuild += mapped.length;
      maybeRebuild();
      return { accepted: mapped.length };
    },

    seed({ prefs = {}, history = [], genreNames = {}, cards = [] } = {}) {
      const events = [];
      const now = Date.now();
      const seedCards = [...(cards || [])];
      const seenKey = new Set();

      const pushCard = (card) => {
        const meta = cardToItemMeta(card);
        if (meta && !seenKey.has(meta.id)) {
          seenKey.add(meta.id);
          seedCards.push(card);
        }
      };

      for (const fav of prefs.favorites || []) {
        if (!fav || fav.id === undefined) continue;
        pushCard({
          ...fav,

          genres: mergeGenres(
            (fav.genreIds || []).map((gid) => genreNames[gid] || genreNames[String(gid)]).filter(Boolean),
            genreNamesFromIds(fav.genreIds, fav.mediaType === 'tv' ? 'tv' : 'movie')
          ),
        });
        events.push({ key: `${fav.mediaType === 'tv' ? 'tv' : 'movie'}:${fav.id}`, type: 'like', ts: now });
      }
      for (const key of prefs.likedMovieIds || []) {
        if (typeof key === 'string' && key.includes(':')) events.push({ key, type: 'like', ts: now });
      }
      for (const key of prefs.clickedMovieIds || []) {
        if (typeof key === 'string' && key.includes(':')) events.push({ key, type: 'click', ts: now });
      }
      for (const item of history || []) {
        if (!item || item.id === undefined || !item.key) continue;
        const mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
        pushCard({
          id: item.id,
          mediaType,
          title: item.title,
          posterPath: item.posterPath,
          year: item.year,
          voteAverage: 0,

          genreIds: Array.isArray(item.genreIds) ? item.genreIds : [],
          genres: Array.isArray(item.genres) ? item.genres : [],
        });
        const ratio = item.duration > 0 ? (item.progress || 0) / item.duration : 0;
        events.push({
          key: item.key,
          type: ratio >= FINISHED_RATIO ? 'finish' : 'play',
          ts: Number(item.updatedAt) || now,
        });
      }

      upsertCards(seedCards);

      engine.track(events.map((e) => ({ userId: USER_ID, itemId: String(e.key), type: e.type, ts: e.ts })));
      state.eventsSinceRebuild += events.length;

      const genreWeights = prefs.genreWeights || {};
      const topGenres = Object.entries(genreWeights)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 3)
        .map(([id]) => genreNames[id] || genreNames[Number(id)])
        .filter(Boolean);
      if (topGenres.length) engine.setOnboarding(USER_ID, topGenres);

      try {
        engine.rebuild();
        state.eventsSinceRebuild = 0;
        state.lastRebuildAt = Date.now();
      } catch (err) {
        log('seed 后 rebuild 失败:', err && err.message);
      }
      return { events: events.length, items: seedCards.length, onboarding: topGenres };
    },

    async home({ size = 24, page = 1 } = {}) {
      const resp = await engine.recommend({ userId: USER_ID, scene: 'home', size, page });
      const cards = (resp.items || [])
        .map((it) => itemToCard(metaOf(it.itemId)))
        .filter(Boolean);
      return {
        cards,
        total: resp.total,
        coldTier: resp.coldTier,
        events: engine.metrics().events,
        tookMs: resp.tookMs,
      };
    },

    async similar(itemId, { size = 12 } = {}) {
      const items = await engine.similarItems(String(itemId), size);
      return {
        cards: items.map((it) => itemToCard(metaOf(it.itemId))).filter(Boolean),
      };
    },

    status() {
      return {
        items: engine.catalog.length,
        ...engine.metrics(),
        userId: USER_ID,
        migration,
        degraded: engine.__cfDegraded === true,
      };
    },

    rebuild() {
      const stats = engine.rebuild();
      state.eventsSinceRebuild = 0;
      state.lastRebuildAt = Date.now();
      return stats;
    },
  };
}

function registerRecIpc({ ipcMain, corePromise, log = () => {} }) {
  const wrap = (fn) => async (_event, ...args) => {
    const core = await corePromise;
    if (!core) return null;
    try {
      return await fn(core, ...args);
    } catch (err) {
      log('rec handler 异常(返回 null 走回退):', err && err.message);
      return null;
    }
  };
  ipcMain.handle('rec:getHome', wrap((core, opts) => core.home(opts || {})));
  ipcMain.handle('rec:getSimilar', wrap((core, payload) => core.similar(payload.itemId, payload || {})));
  ipcMain.handle('rec:track', wrap((core, payload) => core.track((payload && payload.events) || [])));
  ipcMain.handle('rec:upsert', wrap((core, payload) => ({ fed: core.upsertCards((payload && payload.cards) || []) })));
  ipcMain.handle('rec:seed', wrap((core, payload) => core.seed(payload || {})));
  ipcMain.handle('rec:status', wrap((core) => core.status()));
  ipcMain.handle('rec:rebuild', wrap((core) => core.rebuild()));
}

async function initRecommender({ app, ipcMain, log = console.log } = {}) {
  const corePromise = (async () => {
    if (!app || !ipcMain) return null;
    const dataDir = path.join(app.getPath('userData'), 'cineflow-rec');
    const engineEntry = path.join(__dirname, 'rec-engine', 'dist', 'engine.js');
    const configPath = path.join(__dirname, 'rec-engine', 'config', 'weights.json');
    if (!fs.existsSync(asarReal(configPath))) log('[CineFlow:Rec] 未找到 weights.json, 使用引擎默认配置');
    const core = await createRecommenderCore({
      dataDir,
      engineEntry,
      configPath: fs.existsSync(asarReal(configPath)) ? configPath : undefined,
      log,
    });
    log(`[CineFlow:Rec] 引擎就绪: ${JSON.stringify(core.status())}`);
    return core;
  })();
  registerRecIpc({ ipcMain, corePromise, log });
  return corePromise;
}

module.exports = {
  USER_ID,
  cardToItemMeta,
  itemToCard,
  mergeGenres,
  mergeItemMeta,
  __test__: { mergeGenres, mergeItemMeta },
  createRecommenderCore,
  registerRecIpc,
  initRecommender,
};

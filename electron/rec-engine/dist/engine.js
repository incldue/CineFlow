import { join } from 'node:path';
import { loadConfig, tierOf } from './config.js';
import { FileStore } from './store/file-store.js';
import { buildPopularity, computeItemCF, loadItemCF, saveItemCF } from './core/itemcf.js';
import { buildProfile, emptyProfile, eventWeight, sessionItems } from './core/profile.js';
import { buildTfidf, loadTfidf, saveTfidf } from './embedding/tfidf.js';
import { BruteForceIndex } from './embedding/vector-index.js';
import { buildChannels } from './recall/channels.js';
import { rrfFuse } from './rank/rrf.js';
import { rerank } from './rank/rerank.js';
import { SasRecChannel } from './recall/sasrec.js';
const PROFILE_LRU_MAX = 5000;
export class RecEngine {
    cfg;
    store;
    state;
    channels = [];
    sasrec = null;
    cache = new Map();
    userEvents = new Map();
    constructor(dataDir, configPath) {
        this.cfg = loadConfig(configPath ?? join(dataDir, '..', 'config', 'weights.json'));
        this.store = new FileStore(dataDir);
    }

    init() {
        const items = this.store.loadItems();
        const events = this.store.loadEvents();
        const onboarding = this.store.loadOnboarding();
        this.buildState(items, events, onboarding, { buildIfMissing: true });
        return this;
    }

    track(events) {
        const now = Date.now();
        for (const e of events) {
            if (!e.userId || !e.itemId || !e.type)
                continue;
            if (!e.ts)
                e.ts = now;
        }
        this.store.appendEvents(events);
        for (const e of events) {
            const ts = e.ts ?? now;
            e.ts = ts;
            this.state.events.push(e);
            let list = this.userEvents.get(e.userId);
            if (!list) {
                list = [];
                this.userEvents.set(e.userId, list);
            }
            list.push(e);
            if (e.type !== 'imp' && e.type !== 'dislike') {
                const p = this.state.popularity.get(e.itemId) ?? { count: 0, score: 0, lastTs: 0 };
                p.count += 1;
                p.score += Math.exp(-Math.max(0, now - ts) / 3_600_000 / this.cfg.trendingTauHours);
                p.lastTs = Math.max(p.lastTs, ts);
                this.state.popularity.set(e.itemId, p);
            }
            this.state.profiles.delete(e.userId);
        }
        this.cache.clear();
    }

    setOnboarding(userId, genres) {
        const map = this.store.loadOnboarding();
        map.set(userId, genres);
        this.store.saveOnboarding(map);
        this.state.onboarding = map;
        this.state.profiles.delete(userId);
        this.cache.clear();
    }

    upsertItems(items) {
        const byId = new Map(this.state.items.map((i) => [i.id, i]));
        for (const it of items)
            byId.set(it.id, it);
        const all = [...byId.values()];
        this.store.saveItems(all);
        this.state.items = all;
        this.state.itemIdToIdx = new Map(all.map((it, i) => [it.id, i]));
        this.cache.clear();
    }

    recommend(req) {
        return this.recommendInner(req);
    }
    async recommendInner(req) {
        const t0 = performance.now();
        const scene = req.scene ?? 'home';
        const page = Math.max(1, req.page ?? 1);
        const size = Math.min(50, Math.max(1, req.size ?? 20));
        const userId = req.userId;
        const profile = this.getProfile(userId);
        const tier = tierOf(profile.interactionCount);
        const cacheKey = `${userId}|${scene}|${req.anchorItemId ?? ''}|${req.excludeIds?.join(',') ?? ''}`;
        const cached = this.cache.get(cacheKey);
        let list;
        if (cached && cached.expiresAt > Date.now()) {
            list = cached.list;
        }
        else {
            list = await this.runPipeline(req, scene, profile, tier);
            this.cache.set(cacheKey, { list, expiresAt: Date.now() + this.cfg.cacheTtlMin * 60_000 });
            if (this.cache.size > 2000)
                this.cache.delete(this.cache.keys().next().value);
        }
        const start = (page - 1) * size;
        const pageItems = list.slice(start, start + size);
        const items = pageItems.map((f) => ({ itemId: f.itemId, score: +f.norm.toFixed(4), reasons: f.reasons }));
        return {
            userId,
            scene,
            page,
            size,
            total: list.length,
            coldTier: tier,
            items,
            tookMs: +(performance.now() - t0).toFixed(2),
        };
    }

    async similarItems(itemId, size = 12, excludeIds, userId) {
        const resp = await this.recommend({
            userId: userId ?? '__anchor__',
            scene: 'similar',
            anchorItemId: itemId,
            size,
            excludeIds,
        });
        return resp.items;
    }

    metrics() {
        const now = Date.now();
        const cutoff = now - 86_400_000;
        let imp = 0;
        let click = 0;
        let play = 0;
        let finish = 0;
        let like = 0;
        let dislike = 0;
        for (let i = this.state.events.length - 1; i >= 0; i--) {
            const e = this.state.events[i];
            if ((e.ts ?? 0) < cutoff)
                break;
            if (e.type === 'imp')
                imp++;
            else if (e.type === 'click')
                click++;
            else if (e.type === 'play')
                play++;
            else if (e.type === 'finish')
                finish++;
            else if (e.type === 'like')
                like++;
            else if (e.type === 'dislike')
                dislike++;
        }
        return {
            windowHours: 24,
            impressions: imp,
            clicks: click,
            ctr: imp > 0 ? +(click / imp).toFixed(4) : 0,
            plays: play,
            finishRate: play > 0 ? +(finish / play).toFixed(4) : 0,
            likes: like,
            likeRate: imp > 0 ? +(like / imp).toFixed(4) : 0,
            dislikes: dislike,
            items: this.state.items.length,
            users: this.userEvents.size,
            events: this.state.events.length,
        };
    }

    rebuild() {
        const t0 = performance.now();
        const onboarding = this.store.loadOnboarding();
        this.buildState(this.state.items, this.state.events, onboarding, { buildIfMissing: true, force: true });
        return {
            tookMs: +(performance.now() - t0).toFixed(1),
            items: this.state.items.length,
            events: this.state.events.length,
        };
    }
    get config() {
        return this.cfg;
    }

    get catalog() {
        return this.state.items;
    }

    clearCache() {
        this.cache.clear();
    }

    async runPipeline(req, scene, profile, tier) {
        const now = Date.now();
        const excludeIds = new Set(profile.itemWeights.keys());
        for (const d of profile.disliked)
            excludeIds.add(d);
        for (const id of req.excludeIds ?? [])
            excludeIds.add(id);
        if (scene === 'similar' && req.anchorItemId)
            excludeIds.add(req.anchorItemId);
        const session = sessionItems(this.state.events, req.userId, now, this.cfg.sessionWindowMin);
        const ctx = { userId: req.userId, scene, request: req, profile, tier, sessionItems: session, excludeIds };

        const results = await Promise.all(this.channels.map(async (ch) => {
            try {
                return await ch.recall(ctx);
            }
            catch (err) {
                console.error(`[rec-engine] channel ${ch.source} failed:`, err);
                return [];
            }
        }));
        const candidates = results.flat();
        const weights = this.weightsFor(scene, tier);
        const fused = rrfFuse(candidates, weights, this.cfg.rrfK);
        const itemsById = new Map(this.state.items.map((it) => [it.id, it]));
        return rerank(fused, itemsById, this.cfg, now, Math.min(50, req.size ?? 20));
    }
    weightsFor(scene, tier) {
        const sceneW = this.cfg.sceneWeights[scene];
        if (sceneW && scene !== 'home') {

            return {
                itemcf: Math.max(sceneW.itemcf, tier === 'new' ? 0 : 0.3),
                content: Math.max(sceneW.content, tier === 'new' ? 0 : 0.3),
                tag: sceneW.tag,
                trending: 0,
                realtime: 0,
                sasrec: sceneW.sasrec,
            };
        }
        return this.cfg.tierWeights[tier];
    }
    getProfile(userId) {
        const cached = this.state.profiles.get(userId);
        if (cached) {

            this.state.profiles.delete(userId);
            this.state.profiles.set(userId, cached);
            return cached;
        }
        const events = this.userEvents.get(userId) ?? [];
        const genreOf = (itemId) => this.state.items[this.state.itemIdToIdx.get(itemId)]?.genres ?? [];
        const p = events.length > 0 ? buildProfile(userId, events, genreOf, Date.now(), this.cfg) : emptyProfile(userId);
        if (this.state.profiles.size >= PROFILE_LRU_MAX) {
            this.state.profiles.delete(this.state.profiles.keys().next().value);
        }
        this.state.profiles.set(userId, p);
        return p;
    }
    buildState(items, events, onboarding, opts = {}) {
        const now = Date.now();
        const itemIdToIdx = new Map(items.map((it, i) => [it.id, i]));

        this.userEvents = new Map();
        for (const e of events) {
            let list = this.userEvents.get(e.userId);
            if (!list) {
                list = [];
                this.userEvents.set(e.userId, list);
            }
            list.push(e);
        }
        const popularity = buildPopularity(events, now, this.cfg.trendingTauHours);

        const icfPath = this.store.artifactPath('itemcf.bin');
        let itemcf = opts.force ? null : loadItemCF(icfPath);
        if (!itemcf && opts.buildIfMissing && items.length > 0) {
            itemcf = computeItemCF(events, items.map((i) => i.id), now, this.cfg);
            this.store.ensureArtifactDir();
            saveItemCF(itemcf, icfPath);
        }
        if (itemcf && itemcf.n !== items.length)
            itemcf = null;
        const tfPath = this.store.artifactPath('tfidf.bin');
        let tfidf = opts.force ? null : loadTfidf(tfPath);
        if (!tfidf && opts.buildIfMissing && items.length > 0) {
            tfidf = buildTfidf(items);
            this.store.ensureArtifactDir();
            saveTfidf(tfidf, tfPath);
        }
        if (tfidf && tfidf.n !== items.length)
            tfidf = null;
        const contentIndex = tfidf ? new BruteForceIndex(tfidf.vectors, tfidf.n, tfidf.dim) : null;
        this.state = {
            items,
            itemIdToIdx,
            events,
            profiles: new Map(),
            popularity,
            itemcf,
            tfidf,
            contentIndex,
            onboarding,
            builtAt: now,
        };
        this.channels = buildChannels(this.state, this.cfg);
        this.sasrec = new SasRecChannel(this.store.dataDir, this.state);
        if (this.sasrec.maybeInit())
            this.channels.push(this.sasrec);
        this.cache.clear();
    }
}

import { recencyDecay } from '../core/profile.js';
import { TfidfVectorizer } from '../embedding/tfidf.js';
function topN(map, n, exclude, source) {
    const arr = [...map.entries()]
        .filter(([id]) => !exclude.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
    return arr.map(([itemId, score]) => ({ itemId, score, source }));
}

export class ItemCFChannel {
    source = 'itemcf';
    state;
    cfg;
    constructor(state, cfg) {
        this.state = state;
        this.cfg = cfg;
    }
    recall(ctx) {
        const itemcf = this.state.itemcf;
        const itemIdToIdx = this.state.itemIdToIdx;
        if (!itemcf || itemcf.n === 0)
            return [];
        const idxToId = this.state.items;
        if (ctx.scene === 'similar') {
            const anchorIdx = ctx.request.anchorItemId ? itemIdToIdx.get(ctx.request.anchorItemId) : undefined;

            if (anchorIdx === undefined || anchorIdx >= itemcf.n)
                return [];
            const out = new Map();
            const base = anchorIdx * itemcf.k;
            for (let r = 0; r < itemcf.k; r++) {
                const nb = itemcf.nbIdx[base + r];
                if (nb < 0)
                    break;
                const id = idxToId[nb]?.id;
                if (!id || ctx.excludeIds.has(id))
                    continue;
                out.set(id, itemcf.nbSim[base + r]);
            }
            return topN(out, this.cfg.recallPerChannel, new Set(), this.source);
        }

        const seeds = [...ctx.profile.itemWeights.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.cfg.itemcfSeeds);
        if (seeds.length === 0)
            return [];
        const now = Date.now();
        const out = new Map();
        for (const [seedId, w] of seeds) {
            const si = itemIdToIdx.get(seedId);
            if (si === undefined || si >= itemcf.n)
                continue;
            const decay = recencyDecay(ctx.profile.itemLastTs.get(seedId) ?? now, now, this.cfg.recencyHalfLifeDays);
            const sw = w * decay;
            const base = si * itemcf.k;
            for (let r = 0; r < itemcf.k; r++) {
                const nb = itemcf.nbIdx[base + r];
                if (nb < 0)
                    break;
                const id = idxToId[nb]?.id;
                if (!id || ctx.excludeIds.has(id))
                    continue;
                out.set(id, (out.get(id) ?? 0) + itemcf.nbSim[base + r] * sw);
            }
        }
        return topN(out, this.cfg.recallPerChannel, new Set(), this.source);
    }
}

export class ContentChannel {
    source = 'content';
    state;
    cfg;
    vectorizer = null;
    constructor(state, cfg) {
        this.state = state;
        this.cfg = cfg;
    }
    getVectorizer() {
        if (!this.state.tfidf)
            return null;
        if (!this.vectorizer || this.vectorizer.artifact !== this.state.tfidf) {
            this.vectorizer = new TfidfVectorizer(this.state.tfidf);
        }
        return this.vectorizer;
    }
    recall(ctx) {
        const index = this.state.contentIndex;
        if (!index)
            return [];
        const { items, itemIdToIdx } = this.state;
        const excludeIdx = new Set();
        for (const id of ctx.excludeIds) {
            const i = itemIdToIdx.get(id);
            if (i !== undefined)
                excludeIdx.add(i);
        }
        let query = null;
        if (ctx.scene === 'similar' && ctx.request.anchorItemId) {
            const anchorIdx = itemIdToIdx.get(ctx.request.anchorItemId);
            if (anchorIdx === undefined || anchorIdx >= this.state.tfidf.n)
                return [];
            const vecOf = this.getVectorizer();
            if (!vecOf)
                return [];
            const d = this.state.tfidf.dim;
            query = this.state.tfidf.vectors.slice(anchorIdx * d, (anchorIdx + 1) * d);
        }
        else {

            const { tfidf } = this.state;
            if (!tfidf)
                return [];
            const d = tfidf.dim;
            query = new Float32Array(d);
            let wsum = 0;
            const now = Date.now();
            for (const [id, w] of ctx.profile.itemWeights) {
                const i = itemIdToIdx.get(id);
                if (i === undefined || i >= tfidf.n)
                    continue;
                const decay = recencyDecay(ctx.profile.itemLastTs.get(id) ?? now, now, this.cfg.recencyHalfLifeDays);
                const wi = w * decay;
                wsum += wi;
                const base = i * d;
                for (let dd = 0; dd < d; dd++)
                    query[dd] += wi * tfidf.vectors[base + dd];
            }
            if (wsum === 0) {

                const genres = this.state.onboarding.get(ctx.userId);
                if (!genres?.length)
                    return [];
                const vecOf = this.getVectorizer();
                if (!vecOf)
                    return [];
                query = vecOf.vectorize(genres.join(' '));
            }
            else {
                for (let dd = 0; dd < d; dd++)
                    query[dd] /= wsum;
            }
        }
        const hits = index.search(query, this.cfg.recallPerChannel, excludeIdx);
        return hits.map((h) => ({ itemId: items[h.idx].id, score: h.sim, source: 'content' }));
    }
}

export class TagChannel {
    source = 'tag';
    state;
    cfg;
    constructor(state, cfg) {
        this.state = state;
        this.cfg = cfg;
    }
    recall(ctx) {
        let genreWeights = ctx.profile.genreWeights;
        if (genreWeights.size === 0) {
            const genres = this.state.onboarding.get(ctx.userId);
            if (!genres?.length)
                return [];
            genreWeights = new Map(genres.map((g) => [g, 1]));
        }
        const maxGW = Math.max(...genreWeights.values());
        const now = Date.now();
        const out = [];
        for (const item of this.state.items) {
            if (ctx.excludeIds.has(item.id))
                continue;
            let gw = 0;
            for (const g of item.genres)
                gw = Math.max(gw, (genreWeights.get(g) ?? 0) / maxGW);
            if (gw <= 0)
                continue;
            out.push({ itemId: item.id, score: gw * this.quality(item, now), source: 'tag' });
            if (out.length >= this.cfg.recallPerChannel * 3)
                break;
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, this.cfg.recallPerChannel);
    }

    quality(item, now) {
        const v = item.rating ?? 0;
        const q = (v * 1 + 6.5 * 5) / 6;
        let score = q / 10;
        if (item.releaseDate) {
            const ageDays = (now - Date.parse(item.releaseDate)) / 86_400_000;
            if (ageDays >= 0 && ageDays < this.cfg.newItemAgeDays)
                score *= 1.2;
        }
        return score;
    }
}

export class TrendingChannel {
    source = 'trending';
    state;
    cfg;
    constructor(state, cfg) {
        this.state = state;
        this.cfg = cfg;
    }
    recall(ctx) {
        const now = Date.now();
        const out = [];
        if (this.state.popularity.size > 0) {
            let maxScore = 0;
            for (const p of this.state.popularity.values())
                maxScore = Math.max(maxScore, p.score);
            if (maxScore > 0) {
                for (const [itemId, p] of this.state.popularity) {
                    if (ctx.excludeIds.has(itemId))
                        continue;
                    let score = p.score / maxScore;
                    const item = this.state.items[this.state.itemIdToIdx.get(itemId)];
                    if (item?.releaseDate) {
                        const ageDays = (now - Date.parse(item.releaseDate)) / 86_400_000;
                        if (ageDays >= 0 && ageDays < this.cfg.newItemAgeDays)
                            score *= 1.5;
                    }
                    out.push({ itemId, score, source: 'trending' });
                }
                out.sort((a, b) => b.score - a.score);
                return out.slice(0, this.cfg.recallPerChannel);
            }
        }

        for (const item of this.state.items) {
            if (ctx.excludeIds.has(item.id))
                continue;
            out.push({ itemId: item.id, score: (item.rating ?? 5) / 10, source: 'trending' });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, this.cfg.recallPerChannel);
    }
}

export class RealtimeChannel {
    source = 'realtime';
    state;
    cfg;
    itemcfChannel;
    contentChannel;
    constructor(state, cfg, itemcfChannel, contentChannel) {
        this.state = state;
        this.cfg = cfg;
        this.itemcfChannel = itemcfChannel;
        this.contentChannel = contentChannel;
    }
    recall(ctx) {
        if (ctx.sessionItems.length === 0 || ctx.scene === 'similar')
            return [];

        const seeds = [];
        const seen = new Set();
        for (const s of ctx.sessionItems) {
            if (!seen.has(s.itemId)) {
                seen.add(s.itemId);
                seeds.push({ itemId: s.itemId, ts: s.ts });
            }
            if (seeds.length >= 5)
                break;
        }
        if (seeds.length === 0)
            return [];

        const out = new Map();
        seeds.forEach((seed, rank) => {
            const w = 1 / (rank + 1);
            const anchorIdx = this.state.itemIdToIdx.get(seed.itemId);
            if (anchorIdx !== undefined && this.state.itemcf && anchorIdx < this.state.itemcf.n) {
                const { itemcf, items } = this.state;
                const base = anchorIdx * itemcf.k;
                for (let r = 0; r < itemcf.k; r++) {
                    const nb = itemcf.nbIdx[base + r];
                    if (nb < 0)
                        break;
                    const id = items[nb]?.id;
                    if (!id || ctx.excludeIds.has(id))
                        continue;
                    out.set(id, (out.get(id) ?? 0) + itemcf.nbSim[base + r] * w);
                }
            }
            const subCtx = {
                ...ctx,
                scene: 'similar',
                request: { ...ctx.request, anchorItemId: seed.itemId },
            };
            for (const c of this.contentChannel.recall(subCtx)) {
                out.set(c.itemId, (out.get(c.itemId) ?? 0) + c.score * w * 0.8);
            }
        });
        return topN(out, this.cfg.recallPerChannel, new Set(), this.source);
    }
}

export function buildChannels(state, cfg) {
    const itemcf = new ItemCFChannel(state, cfg);
    const content = new ContentChannel(state, cfg);
    return [
        itemcf,
        content,
        new TagChannel(state, cfg),
        new TrendingChannel(state, cfg),
        new RealtimeChannel(state, cfg, itemcf, content),
    ];
}

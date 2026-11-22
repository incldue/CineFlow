import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function tierOf(interactionCount) {
    if (interactionCount <= 0)
        return 'new';
    if (interactionCount < 5)
        return 'light';
    if (interactionCount < 20)
        return 'warm';
    return 'deep';
}
export const DEFAULT_CONFIG = {

    eventWeights: {
        imp: 0.1,
        click: 1,
        play: 2,
        finish: 4,
        like: 5,
        dislike: -6,
        rate: { scale: 0.5, max: 5 },
    },
    tierWeights: {
        new: { itemcf: 0, content: 0, tag: 1.0, trending: 0.6, realtime: 0, sasrec: 0 },
        light: { itemcf: 0, content: 0.7, tag: 0.8, trending: 0.4, realtime: 0.9, sasrec: 0 },
        warm: { itemcf: 0.9, content: 0.8, tag: 0.5, trending: 0.3, realtime: 0.9, sasrec: 0.8 },
        deep: { itemcf: 1.0, content: 0.8, tag: 0.4, trending: 0.25, realtime: 0.9, sasrec: 0.9 },
    },
    sceneWeights: {
        similar: { itemcf: 1.0, content: 0.9, tag: 0, trending: 0, realtime: 0, sasrec: 0 },
        search: { itemcf: 0.3, content: 1.0, tag: 0.6, trending: 0, realtime: 0, sasrec: 0 },
    },
    rrfK: 60,
    mmrLambda: 0.7,
    maxConsecutiveSameGenre: 2,
    newItemQuotaPerPage: 2,
    newItemAgeDays: 60,
    recallPerChannel: 200,
    itemcfNeighbors: 100,
    itemcfSeeds: 50,
    contentSeeds: 50,
    recencyHalfLifeDays: 30,
    trendingTauHours: 72,
    sessionWindowMin: 30,
    cacheTtlMin: 5,
};
const TIER_KEYS = ['new', 'light', 'warm', 'deep'];
const SCENE_KEYS = ['home', 'similar', 'search'];
const WEIGHT_KEYS = ['itemcf', 'content', 'tag', 'trending', 'realtime', 'sasrec'];
function mergeWeights(base, patch) {
    const out = { ...base };
    if (patch && typeof patch === 'object') {
        for (const k of WEIGHT_KEYS) {
            const v = patch[k];
            if (typeof v === 'number')
                out[k] = v;
        }
    }
    return out;
}

export function loadConfig(configPath) {
    if (!configPath || !existsSync(configPath))
        return structuredClone(DEFAULT_CONFIG);
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const cfg = structuredClone(DEFAULT_CONFIG);
    if (raw.eventWeights && typeof raw.eventWeights === 'object') {
        Object.assign(cfg.eventWeights, raw.eventWeights);
    }
    const tw = raw.tierWeights;
    if (tw) {
        for (const t of TIER_KEYS)
            if (tw[t])
                cfg.tierWeights[t] = mergeWeights(cfg.tierWeights[t], tw[t]);
    }
    const sw = raw.sceneWeights;
    if (sw) {
        for (const s of SCENE_KEYS)
            if (sw[s])
                cfg.sceneWeights[s] = mergeWeights(DEFAULT_CONFIG.tierWeights.deep, sw[s]);
    }
    for (const [k, v] of Object.entries(raw)) {
        if (k === 'eventWeights' || k === 'tierWeights' || k === 'sceneWeights')
            continue;
        if (k in cfg && typeof v === typeof cfg[k]) {
            cfg[k] = v;
        }
    }
    return cfg;
}

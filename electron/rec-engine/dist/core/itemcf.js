import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { eventWeight } from './profile.js';
import { readHeader, readTyped, writeHeader, typedBuffer } from '../store/binary.js';

export function buildPopularity(events, now, tauHours) {
    const map = new Map();
    for (const e of events) {
        if (e.type === 'imp' || e.type === 'dislike')
            continue;
        let entry = map.get(e.itemId);
        if (!entry) {
            entry = { count: 0, score: 0, lastTs: 0 };
            map.set(e.itemId, entry);
        }
        entry.count += 1;
        const dtH = Math.max(0, (now - (e.ts ?? now)) / 3_600_000);
        entry.score += Math.exp(-dtH / tauHours);
        entry.lastTs = Math.max(entry.lastTs, e.ts ?? 0);
    }
    return map;
}

export function computeItemCF(events, itemIds, now, cfg) {
    const n = itemIds.length;
    const k = Math.min(cfg.itemcfNeighbors, Math.max(1, n - 1));
    const idxOf = new Map();
    for (let i = 0; i < n; i++)
        idxOf.set(itemIds[i], i);

    const userItems = new Map();
    for (const e of events) {
        if (e.type === 'imp' || !idxOf.has(e.itemId))
            continue;
        const w = eventWeight(e, cfg);
        if (w <= 0)
            continue;
        let m = userItems.get(e.userId);
        if (!m) {
            m = new Map();
            userItems.set(e.userId, m);
        }
        m.set(e.itemId, Math.max(m.get(e.itemId) ?? 0, w));
    }

    const pop = new Float64Array(n);
    for (const m of userItems.values())
        for (const id of m.keys())
            pop[idxOf.get(id)] += 1;

    const cap = 300;
    const co = new Map();
    for (const m of userItems.values()) {
        if (m.size < 2)
            continue;
        const items = [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, cap)
            .map(([id]) => idxOf.get(id));
        const iuf = 1 / Math.log(1 + items.length);
        for (let a = 0; a < items.length; a++) {
            for (let b = a + 1; b < items.length; b++) {
                const i = items[a];
                const j = items[b];
                if (i === j)
                    continue;
                const key = i * n + j;
                co.set(key, (co.get(key) ?? 0) + iuf);
            }
        }
    }

    const byItem = new Map();
    for (const [key, c] of co) {
        const i = Math.floor(key / n);
        const j = key % n;
        const denom = Math.sqrt(pop[i] * pop[j]);
        if (denom <= 0)
            continue;
        const sim = c / denom;
        (byItem.get(i) ?? byItem.set(i, []).get(i)).push([j, sim]);
        (byItem.get(j) ?? byItem.set(j, []).get(j)).push([i, sim]);
    }
    const nbIdx = new Int32Array(n * k).fill(-1);
    const nbSim = new Float32Array(n * k);
    const counts = new Int32Array(n);
    for (const [i, list] of byItem) {
        list.sort((a, b) => b[1] - a[1]);
        const top = list.slice(0, k);
        counts[i] = top.length;
        for (let r = 0; r < top.length; r++) {
            nbIdx[i * k + r] = top[r][0];
            nbSim[i * k + r] = top[r][1];
        }
    }
    return { n, k, nbIdx, nbSim, counts };
}
const MAGIC = 'ICF2';

export function saveItemCF(a, path) {
    writeFileSync(path, Buffer.concat([writeHeader(MAGIC, [a.n, a.k]), typedBuffer(a.counts), typedBuffer(a.nbIdx), typedBuffer(a.nbSim)]));
}
export function loadItemCF(path) {
    if (!existsSync(path))
        return null;
    const buf = readFileSync(path);
    if (buf.length < 12)
        return null;
    const { magic, fields } = readHeader(buf, 2);
    if (magic !== MAGIC)
        return null;
    const [n, k] = fields;
    const countsBytes = n * 4;
    const idxBytes = n * k * 4;
    const simBytes = n * k * 4;
    if (buf.length < 12 + countsBytes + idxBytes + simBytes)
        return null;
    let off = 12;
    const counts = readTyped(buf, Int32Array, off, n);
    off += countsBytes;
    const nbIdx = readTyped(buf, Int32Array, off, n * k);
    off += idxBytes;
    const nbSim = readTyped(buf, Float32Array, off, n * k);
    return { n, k, nbIdx, nbSim, counts };
}

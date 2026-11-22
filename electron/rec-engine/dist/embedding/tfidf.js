import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenize, itemText } from './tokenizer.js';
import { readHeader, readTyped, writeHeader, typedBuffer } from '../store/binary.js';
export function buildTfidf(items, maxVocab = 50_000) {
    const docs = items.map((it) => tokenize(itemText(it)));

    const df = new Map();
    for (const doc of docs) {
        const seen = new Set(doc);
        for (const t of seen)
            df.set(t, (df.get(t) ?? 0) + 1);
    }

    const vocabEntries = [...df.entries()]
        .filter(([, c]) => c >= 2 || docs.length < 50)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxVocab);
    const vocabIndex = new Map();
    vocabEntries.forEach(([t], i) => vocabIndex.set(t, i));
    const dim = vocabEntries.length;
    const idf = new Float64Array(dim);
    const N = docs.length;
    for (let i = 0; i < dim; i++)
        idf[i] = Math.log((N + 1) / (vocabEntries[i][1] + 1)) + 1;
    const vectors = new Float32Array(N * dim);
    for (let d = 0; d < N; d++) {
        const tf = new Map();
        for (const t of docs[d]) {
            const idx = vocabIndex.get(t);
            if (idx !== undefined)
                tf.set(idx, (tf.get(idx) ?? 0) + 1);
        }
        let norm = 0;
        for (const [idx, f] of tf) {
            const w = (1 + Math.log(f)) * idf[idx];
            vectors[d * dim + idx] = w;
            norm += w * w;
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (const idx of tf.keys())
                vectors[d * dim + idx] /= norm;
        }
    }
    return { n: N, dim, vectors, vocab: vocabEntries.map(([t]) => t), idf };
}

export class TfidfVectorizer {
    map;
    art;
    constructor(artifact) {
        this.art = artifact;
        this.map = new Map(artifact.vocab.map((t, i) => [t, i]));
    }
    get artifact() {
        return this.art;
    }
    vectorize(text) {
        const tf = new Map();
        for (const t of tokenize(text)) {
            const idx = this.map.get(t);
            if (idx !== undefined)
                tf.set(idx, (tf.get(idx) ?? 0) + 1);
        }
        const vec = new Float32Array(this.art.dim);
        let norm = 0;
        for (const [idx, f] of tf) {
            const w = (1 + Math.log(f)) * this.art.idf[idx];
            vec[idx] = w;
            norm += w * w;
        }
        norm = Math.sqrt(norm);
        if (norm > 0)
            for (const idx of tf.keys())
                vec[idx] /= norm;
        return vec;
    }
}
const MAGIC = 'TFV2';
export function saveTfidf(a, basePath) {
    const vocabBuf = Buffer.from(JSON.stringify(a.vocab), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(vocabBuf.length, 0);
    writeFileSync(basePath, Buffer.concat([writeHeader(MAGIC, [a.n, a.dim]), lenBuf, vocabBuf, typedBuffer(a.idf), typedBuffer(a.vectors)]));
}
export function loadTfidf(basePath) {
    if (!existsSync(basePath))
        return null;
    const buf = readFileSync(basePath);
    if (buf.length < 24)
        return null;
    const { magic, fields } = readHeader(buf, 2);
    if (magic !== MAGIC)
        return null;
    const [n, dim] = fields;
    const vocabLen = buf.readUInt32LE(12);
    let off = 16;
    const vocab = JSON.parse(buf.subarray(off, off + vocabLen).toString('utf8'));
    off += vocabLen;
    const idf = readTyped(buf, Float64Array, off, dim);
    off += dim * 8;
    const vectors = readTyped(buf, Float32Array, off, n * dim);
    return { n, dim, vectors, vocab, idf };
}

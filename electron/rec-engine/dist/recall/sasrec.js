var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTyped } from '../store/binary.js';
export class SasRecChannel {
    source = 'sasrec';
    bundle = null;
    dataDir;
    state;
    constructor(dataDir, state) {
        this.dataDir = dataDir;
        this.state = state;
    }

    maybeInit() {
        const dir = join(this.dataDir, 'sasrec');
        const modelPath = join(dir, 'model.onnx');
        const embPath = join(dir, 'items.bin');
        const vocabPath = join(dir, 'vocab.json');
        if (!existsSync(modelPath) || !existsSync(embPath) || !existsSync(vocabPath))
            return false;
        try {
            const meta = JSON.parse(readFileSync(vocabPath, 'utf8'));
            const embBuf = readFileSync(embPath);
            const n = Number(embBuf.readBigUInt64LE(0));
            const hidden = Number(embBuf.readBigUInt64LE(8));
            if (hidden !== meta.hidden)
                return false;
            const emb = readTyped(embBuf, Float32Array, 16, n * hidden);
            const vocabToLocal = new Map();
            const localToVocab = new Map();
            for (const [trainIdxStr, localIdx] of Object.entries(meta.vocab)) {
                const trainIdx = Number(trainIdxStr);
                vocabToLocal.set(trainIdx, localIdx);
                localToVocab.set(localIdx, trainIdx);
            }
            this.bundle = { emb, n, hidden, seqLen: meta.seqLen, vocabToLocal, localToVocab, modelPath, session: null, sessionPromise: null };
            return true;
        }
        catch (err) {
            console.error('[rec-engine] sasrec disabled:', err.message);
            return false;
        }
    }
    async ensureSession() {
        const b = this.bundle;
        if (!b)
            return null;
        if (b.session)
            return b.session;
        if (!b.sessionPromise) {
            b.sessionPromise = (async () => {
                try {

                    const pkg = 'onnxruntime-node';
                    const ort = await import(__rewriteRelativeImportExtension(pkg));
                    const session = new ort.InferenceSession(b.modelPath);
                    b.session = session;
                    return b.session;
                }
                catch (err) {
                    console.error('[rec-engine] sasrec session unavailable:', err.message);
                    b.sessionPromise = null;
                    return null;
                }
            })();
        }
        return b.sessionPromise;
    }
    async recall(ctx) {
        const b = this.bundle;
        if (!b)
            return [];
        const session = await this.ensureSession();
        if (!session)
            return [];
        const seq = [...ctx.profile.itemLastTs.entries()]
            .sort((a, b2) => b2[1] - a[1])
            .map(([id]) => this.state.itemIdToIdx.get(id))
            .filter((i) => i !== undefined && b.localToVocab.has(i))
            .slice(0, b.seqLen);
        if (seq.length < 2)
            return [];
        const input = new BigInt64Array(b.seqLen).fill(0n);
        for (let i = 0; i < seq.length; i++) {
            input[b.seqLen - seq.length + i] = BigInt(b.localToVocab.get(seq[i]));
        }
        const pkg = 'onnxruntime-node';
        const ort = await import(__rewriteRelativeImportExtension(pkg));
        const tensor = new ort.Tensor('int64', input, [1, b.seqLen]);
        const results = await session.run({ seq: tensor });
        const lastHidden = Object.values(results)[0].data.slice(-b.hidden);
        const excludeIdx = new Set();
        for (const id of ctx.excludeIds) {
            const i = this.state.itemIdToIdx.get(id);
            if (i !== undefined)
                excludeIdx.add(i);
        }
        const scores = [];
        for (let i = 0; i < b.n; i++) {
            if (excludeIdx.has(i))
                continue;
            let dot = 0;
            const base = i * b.hidden;
            for (let d = 0; d < b.hidden; d++)
                dot += lastHidden[d] * b.emb[base + d];
            if (dot > 0)
                scores.push({ idx: i, sim: dot });
        }
        scores.sort((a, b2) => b2.sim - a.sim);
        return scores
            .slice(0, 200)
            .map((s) => ({ itemId: this.state.items[s.idx].id, score: s.sim, source: this.source }));
    }
}

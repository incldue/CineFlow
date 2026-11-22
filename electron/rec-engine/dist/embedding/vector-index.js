export class BruteForceIndex {
    vecs;
    n;
    dim;
    constructor(vecs, n, dim) {
        this.vecs = vecs;
        this.n = n;
        this.dim = dim;
    }
    search(query, topN, exclude) {
        const scores = new Float32Array(this.n);
        let qnorm = 0;
        for (let d = 0; d < this.dim; d++)
            qnorm += query[d] * query[d];
        qnorm = Math.sqrt(qnorm);
        if (qnorm === 0)
            return [];
        for (let i = 0; i < this.n; i++) {
            let dot = 0;
            const base = i * this.dim;
            for (let d = 0; d < this.dim; d++)
                dot += query[d] * this.vecs[base + d];
            scores[i] = dot / qnorm;
        }

        const top = [];
        for (let i = 0; i < this.n; i++) {
            if (exclude?.has(i))
                continue;
            const s = scores[i];
            if (s <= 0)
                continue;
            if (top.length < topN) {
                let lo = 0;
                let hi = top.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (top[mid].sim < s)
                        lo = mid + 1;
                    else
                        hi = mid;
                }
                top.splice(lo, 0, { idx: i, sim: s });
            }
            else if (s > top[0].sim) {
                top.shift();
                let lo = 0;
                let hi = top.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (top[mid].sim < s)
                        lo = mid + 1;
                    else
                        hi = mid;
                }
                top.splice(lo, 0, { idx: i, sim: s });
            }
        }
        return top.reverse();
    }
}

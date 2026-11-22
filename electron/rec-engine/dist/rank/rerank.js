function genreSet(item) {
    return new Set(item.genres.length ? item.genres : ['unknown']);
}
function jaccard(a, b) {
    let inter = 0;
    for (const x of a)
        if (b.has(x))
            inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}
function isNewItem(item, now, cfg) {
    if (!item.releaseDate)
        return false;
    const ageDays = (now - Date.parse(item.releaseDate)) / 86_400_000;
    return ageDays >= 0 && ageDays < cfg.newItemAgeDays;
}

export function rerank(fused, itemsById, cfg, now, size) {
    const λ = cfg.mmrLambda;
    const pool = fused.slice(0, Math.max(size * 4, 60));
    const selected = [];
    const selectedGenres = [];
    const remaining = [...pool];
    const tooManySameGenre = (gs) => {
        if (selected.length === 0)
            return false;
        const tail = selectedGenres.slice(-cfg.maxConsecutiveSameGenre);
        return tail.every((t) => jaccard(t, gs) >= 0.5);
    };
    while (remaining.length > 0) {
        let bestPos = -1;
        let bestVal = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const item = itemsById.get(remaining[i].itemId);
            const gs = item ? genreSet(item) : new Set(['unknown']);
            let div = 1;
            if (selectedGenres.length > 0) {
                let maxJ = 0;
                for (const sg of selectedGenres)
                    maxJ = Math.max(maxJ, jaccard(sg, gs));
                div = 1 - maxJ;
            }
            let val = λ * remaining[i].norm + (1 - λ) * div;
            if (tooManySameGenre(gs))
                val -= 10;
            if (val > bestVal) {
                bestVal = val;
                bestPos = i;
            }
        }
        const [picked] = remaining.splice(bestPos, 1);
        selected.push(picked);
        const it = itemsById.get(picked.itemId);
        selectedGenres.push(it ? genreSet(it) : new Set(['unknown']));
    }

    const newInHead = selected.slice(0, size).filter((f) => {
        const it = itemsById.get(f.itemId);
        return it ? isNewItem(it, now, cfg) : false;
    }).length;
    if (newInHead < cfg.newItemQuotaPerPage) {
        const need = cfg.newItemQuotaPerPage - newInHead;
        const newCandidates = pool.filter((f) => {
            const it = itemsById.get(f.itemId);
            return it && isNewItem(it, now, cfg) && !selected.slice(0, size).includes(f);
        });
        for (let i = 0; i < need && i < newCandidates.length; i++) {

            const pos = Math.min(size - 1, 3 + i * 5);
            const victimPos = selected.findIndex((f, idx) => idx >= pos && !isNew(itemsById.get(f.itemId), now, cfg));
            if (victimPos >= 0) {
                const victim = selected[victimPos];
                selected[victimPos] = newCandidates[i];
                selected[selected.indexOf(newCandidates[i])] = victim;
            }
        }
    }
    return selected;
}
function isNew(item, now, cfg) {
    return item ? isNewItem(item, now, cfg) : false;
}

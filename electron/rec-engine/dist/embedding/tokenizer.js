const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
export function tokenize(text) {
    const tokens = [];
    for (const chunk of text.toLowerCase().split(SPLIT_RE)) {
        if (!chunk)
            continue;
        if (CJK_RE.test(chunk)) {

            for (let i = 0; i < chunk.length; i++) {
                if (chunk.length === 1) {
                    tokens.push(chunk[i]);
                }
                else if (i < chunk.length - 1) {
                    tokens.push(chunk.slice(i, i + 2));
                }
            }
        }
        else if (chunk.length > 1) {
            tokens.push(chunk);
        }
    }
    return tokens;
}

export function itemText(item) {
    const parts = [];
    parts.push(...item.genres, ...item.genres, ...item.genres);
    if (item.tags?.length)
        parts.push(...item.tags, ...item.tags);
    if (item.actors?.length)
        parts.push(...item.actors, ...item.actors);
    parts.push(item.title);
    if (item.overview)
        parts.push(item.overview);
    return parts.join(' ');
}

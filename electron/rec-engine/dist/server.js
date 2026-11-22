const VALID_TYPES = ['imp', 'click', 'play', 'finish', 'like', 'dislike', 'rate'];
export function createHandlers(engine) {
    return {
        health: () => ({ ok: true, ts: Date.now() }),
        recommend: async (q) => {
            const userId = q.get('userId');
            if (!userId)
                throw new Error('userId is required');
            const resp = await engine.recommend({
                userId,
                scene: q.get('scene') ?? 'home',
                anchorItemId: q.get('anchorItemId') ?? undefined,
                page: q.get('page') ? Number(q.get('page')) : undefined,
                size: q.get('size') ? Number(q.get('size')) : undefined,
                excludeIds: q.get('excludeIds') ? q.get('excludeIds').split(',').filter(Boolean) : undefined,
                sessionId: q.get('sessionId') ?? undefined,
            });
            return resp;
        },
        similar: async (q) => {
            const itemId = q.get('itemId');
            if (!itemId)
                throw new Error('itemId is required');
            return {
                items: await engine.similarItems(itemId, q.get('size') ? Number(q.get('size')) : 12, q.get('excludeIds') ? q.get('excludeIds').split(',').filter(Boolean) : undefined, q.get('userId') ?? undefined),
            };
        },
        track: async (body) => {
            const events = (body.events ?? []).filter((e) => e.userId && e.itemId && VALID_TYPES.includes(e.type));
            engine.track(events);
            return { accepted: events.length };
        },
        onboarding: async (body) => {
            if (!body.userId || !Array.isArray(body.genres) || body.genres.length === 0) {
                throw new Error('userId and genres are required');
            }
            engine.setOnboarding(body.userId, body.genres);
            return { ok: true };
        },
        metrics: () => engine.metrics(),
        rebuild: () => engine.rebuild(),
    };
}
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function startFastify(engine, port) {
    const fastify = (await import('fastify')).default;
    const h = createHandlers(engine);
    const app = fastify({ logger: false });
    app.addHook('onRequest', async (req, reply) => {
        for (const [k, v] of Object.entries(CORS))
            reply.header(k, v);
        if (req.method === 'OPTIONS')
            await reply.code(204).send();
    });
    app.get('/api/health', async () => h.health());
    app.get('/api/recommend', async (req) => h.recommend(new URL(req.url, 'http://x').searchParams));
    app.get('/api/similar', async (req) => h.similar(new URL(req.url, 'http://x').searchParams));
    app.post('/api/track', async (req) => h.track(req.body));
    app.post('/api/onboarding', async (req) => h.onboarding(req.body));
    app.get('/api/metrics', async () => h.metrics());
    app.post('/api/admin/rebuild', async () => h.rebuild());
    await app.listen({ port, host: '127.0.0.1' });
    return app;
}

export async function startHttpFallback(engine, port) {
    const http = await import('node:http');
    const h = createHandlers(engine);
    const server = http.createServer(async (req, res) => {
        for (const [k, v] of Object.entries(CORS))
            res.setHeader(k, v);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const readBody = async () => {
            const chunks = [];
            for await (const c of req)
                chunks.push(c);
            const text = Buffer.concat(chunks).toString('utf8');
            return text ? JSON.parse(text) : {};
        };
        try {
            let result;
            if (url.pathname === '/api/health')
                result = h.health();
            else if (url.pathname === '/api/recommend')
                result = await h.recommend(url.searchParams);
            else if (url.pathname === '/api/similar')
                result = await h.similar(url.searchParams);
            else if (url.pathname === '/api/track')
                result = await h.track((await readBody()));
            else if (url.pathname === '/api/onboarding')
                result = await h.onboarding((await readBody()));
            else if (url.pathname === '/api/metrics')
                result = h.metrics();
            else if (url.pathname === '/api/admin/rebuild')
                result = h.rebuild();
            else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        }
        catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}
export async function startServer(engine, port) {
    try {
        await startFastify(engine, port);
        return { kind: 'fastify' };
    }
    catch (err) {
        if (!err.message.includes("Cannot find package 'fastify'")) {
            console.error('[rec-engine] fastify failed, falling back to node:http:', err.message);
        }
        await startHttpFallback(engine, port);
        return { kind: 'http' };
    }
}

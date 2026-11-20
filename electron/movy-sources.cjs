'use strict';
// Movy 内置播放源：/seed → /{city}/sources?enc=2 → 解密出画质列表。
// 与原有资源体系隔离，不读写 resourceSettings / source-manager / source-engine。
// 播放地址的 Referer 由 movy-media-proxy.cjs 在本地代理里补，不依赖 webRequest 注册位。

const fsp = require('node:fs');
const path = require('node:path');

const RESULT_TTL_MS = 5 * 60 * 1000;            // 5 分钟内算「新鲜」，直接用
const RESULT_STALE_MS = 6 * 60 * 60 * 1000;      // 6 小时内仍可先给用户看，同时后台刷新
const SEED_TIMEOUT_MS = 4200;   // 直连实测 320–700ms；给到 4.2s 只为兜住劣质网络
const SOURCES_TIMEOUT_MS = 6500;
const PROBE_CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 传输层顺序：Movy 直连会话 → session.fetch（应用带 DoH 兜底）→ net.fetch → global fetch。
// 专用 direct 会话：应用启动前 6 秒处在代理探测窗口，默认 session 的请求会挂住。
let movyDirectSession = null;
function directSession() {
  try {
    const electron = require('electron');
    const session = electron && electron.session;
    if (!session || typeof session.fromPartition !== 'function') return null;
    if (!movyDirectSession) {
      movyDirectSession = session.fromPartition('persist:movy-direct', { cache: true });
      try { movyDirectSession.setProxy({ mode: 'direct' }).catch(() => {}); } catch { /* ignore */ }
    }
    return movyDirectSession;
  } catch { return null; }
}

function loadNetChain() {
  const chain = [];
  chain.warn = (name, pathname) => {
    try { if (typeof globalThis.__movyTransportWarn === 'function') globalThis.__movyTransportWarn(name, pathname); } catch { /* ignore */ }
  };
  const direct = directSession();
  if (direct && typeof direct.fetch === 'function') {
    chain.push({ name: 'direct-session', fn: (url, init) => direct.fetch.call(direct, url, init) });
  }
  try {
    const electron = require('electron');
    const ses = electron.session && electron.session.defaultSession;
    if (ses && typeof ses.fetch === 'function') {
      chain.push({ name: 'session', fn: (url, init) => ses.fetch.call(ses, url, init) });
    }
    if (electron.net && typeof electron.net.fetch === 'function') {
      chain.push({ name: 'net', fn: electron.net.fetch.bind(electron.net) });
    }
  } catch { /* 非 Electron 环境（测试） */ }
  if (typeof fetch === 'function') chain.push({ name: 'global', fn: fetch });
  return chain;
}

function loadNet() {
  const chain = loadNetChain();
  return chain.length ? chain[0].fn : null;
}

function withTimeout(promise, ms, label) {
  let timer = 0;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label + ' timeout'), { code: 'TIMEOUT' })), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 抓包开关：CINEFLOW_MOVY_CAPTURE=<文件路径> 时，把 /seed 与 /sources 的原始响应
 * 逐行追加进去。上游协议一旦换算法，用这份抓包可以直接离线复现（tests/fixtures）。
 */
function capture(kind, pathname, text, file) {
  const target = file || process.env.CINEFLOW_MOVY_CAPTURE;
  if (!target) return;
  try {
    fsp.appendFileSync(target, JSON.stringify({ kind, pathname, at: Date.now(), text: String(text).slice(0, 40000) }) + '\n');
  } catch { /* 抓包失败不影响请求 */ }
}

/** ofetch 的最小实现：params 序列化 + 超时 + retry + 带 response.status 的错误 */
function createOfetch(capturePath) {
  const netFetch = loadNet();
  // 上游的种子缓存是「拿到结果后才写」，所以并发起的第二次 /seed 并不会命中它。
  // 实测并发预热 4 台会对同一个 mediaId 连打 4 次种子（每次约 440ms，还容易 429）。
  // 这里按 URL 把「在飞」的种子请求合并成一个，命中缓存后仍由上游自己接管。
  const seedFlights = new Map();
  async function rawOfetch(url, options = {}) {
    if (!netFetch) throw new Error('no fetch available');
    const transports = loadNetChain();
    const target = new URL(String(url));
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined || value === null) continue;
        target.searchParams.set(key, String(value));
      }
    }
    // 至少给一次重试机会：只对 429/5xx/网络错误生效，正常路径零额外延迟
    const retries = Math.max(1, Number(options.retry) || 0);
    const timeout = /\/seed/.test(target.pathname) ? SEED_TIMEOUT_MS : SOURCES_TIMEOUT_MS;
    let lastError = null;
    let transportUsed = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        let response = null;
        let networkError = null;
        // 逐层试传输：session.fetch（DoH + 直连兜底）失败再退 net.fetch，最后才放弃
        for (const transport of transports) {
          try {
            response = await withTimeout(transport.fn(target.toString(), {
              method: 'GET',
              headers: {
                'user-agent': UA,
                accept: '*/*',
                referer: 'https://www.movy.sx/',
                origin: 'https://www.movy.sx',
              },
            }), timeout, 'movy');
            transportUsed = transport.name;
            break;
          } catch (error) {
            networkError = error;
            // 有 HTTP 状态说明链路通，别换传输层；只有网络层失败才继续往下试
            if (error && error.status) throw error;
          }
        }
        if (!response) throw networkError || new Error('no transport could complete the request');
        if (!response.ok) {
          const error = new Error('HTTP ' + response.status);
          error.status = response.status;
          error.response = { status: response.status };
          throw error;
        }
        const type = String(response.headers.get('content-type') || '');
        if (/json/i.test(type)) {
          const json = await response.json();
          capture('seed', target.pathname, JSON.stringify(json), capturePath);
          if (transportUsed && transportUsed !== 'direct-session') transports.warn(transportUsed, target.pathname);
          return json;
        }
        const text = await response.text();
        capture('body', target.pathname, text, capturePath);
        if (transportUsed && transportUsed !== 'direct-session') transports.warn(transportUsed, target.pathname);
        return text;
      } catch (error) {
        lastError = error;
        if (error && (error.status === 401 || error.status === 404)) throw error;
        // 预热并发时上游会 429/500：退避一次再试，避免把「限流」显示成「该服务器挂了」
        const status = error && error.status;
        const networkFailure = !status; // 超时 / ERR_CONNECTION_* / DNS 失败
        const retriable = status === 429 || (status >= 500 && status < 600) || networkFailure;
        if (retriable && attempt < Math.max(1, retries)) {
          // 网络层失败先用极短退避抢一次（代理探测窗口、瞬时丢包都能被这一次救回来）
          await new Promise((resolve) => setTimeout(resolve, networkFailure ? 120 : 380 + Math.round(Math.random() * 220)));
          continue;
        }
      }
    }
    throw lastError || new Error('request failed');
  }

  return function ofetch(url, options = {}) {
    if (!/\/seed(\?|$)/.test(String(url))) return rawOfetch(url, options);
    const key = String(url) + '|' + JSON.stringify(options && options.params ? options.params : {});
    const inflight = seedFlights.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      try { return await rawOfetch(url, options); } finally { seedFlights.delete(key); }
    })();
    seedFlights.set(key, task);
    return task;
  };
}

const QUALITY_RE = /(\d{3,4})\s*p?/i;

function qualityMeta(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  let height = 0;
  if (/\b(4k|uhd|2160p?|2160)\b/.test(lower) || lower === '4k') height = 2160;
  else {
    const hit = lower.match(QUALITY_RE);
    if (hit) height = Number(hit[1]) || 0;
  }
  const label = height >= 2160 ? '2160p' : (height ? height + 'p' : (text || 'Auto'));
  return { raw: text, height, label };
}

function createMovySources({ log = () => {}, userDataDir = '', ipcMain = null, ofetch = null } = {}) {
  // 播放走本地代理：Referer/Origin 由主进程补，绕开 webRequest 注册位被抢的问题。
  let mediaProxy = null;
  try {
    const { createMovyMediaProxy } = require('./movy-media-proxy.cjs');
    mediaProxy = createMovyMediaProxy({ log });
    if (ipcMain) mediaProxy.start();
  } catch (error) {
    log('movy 代理未启用 · ' + String((error && error.message) || error));
  }
  const streamHosts = new Set();
  globalThis.__movyTransportWarn = (name, pathname) => log('movy 传输回退到 ' + name + '（' + pathname + '）');
  const memory = new Map();          // key -> { savedAt, data }
  const pending = new Map();         // key -> Promise（同一部片同一台服务器并发只打一次）
  let upstreamPromise = null;
  let coolingUntil = 0;              // 上游 429 后的冷却截止时间
  const COOL_MS = 8000;
  let cacheDir = '';

  function noteStreamUrl(url) {
    try {
      const host = new URL(String(url)).host;
      if (host) streamHosts.add(host);
    } catch { /* 非法 URL 忽略 */ }
    return '';
  }

  function diskPath(key) {
    if (!userDataDir) return '';
    try {
      if (!cacheDir) {
        if (!userDataDir) return '';
        cacheDir = path.join(userDataDir, 'movy-sources');
        fsp.mkdirSync(cacheDir, { recursive: true });
        log('movy 磁盘缓存：' + cacheDir);
      }
      const safe = String(key).replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 120);
      return path.join(cacheDir, safe + '.json');
    } catch (error) {
      log('movy 磁盘缓存不可用 · ' + String((error && error.message) || error));
      return '';
    }
  }

  function readDisk(key) {
    const file = diskPath(key);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fsp.readFileSync(file, 'utf8'));
      if (!parsed || !parsed.savedAt) return null;
      return parsed;
    } catch { return null; }
  }

  function writeDisk(key, entry) {
    const file = diskPath(key);
    if (!file) return;
    try {
      const tmp = file + '.tmp';
      fsp.writeFileSync(tmp, JSON.stringify(entry));
      fsp.renameSync(tmp, file);
    } catch { /* 缓存写失败不影响播放 */ }
  }

  // 抓包开关：userData 下放一个 movy-capture.on 空文件即可，落地到 movy-capture.log
  function captureFile() {
    if (process.env.CINEFLOW_MOVY_CAPTURE) return process.env.CINEFLOW_MOVY_CAPTURE;
    if (!userDataDir) return '';
    try {
      const marker = path.join(userDataDir, 'movy-capture.on');
      if (!fsp.existsSync(marker)) return '';
      return path.join(userDataDir, 'movy-capture.log');
    } catch { return ''; }
  }

  async function getUpstream() {
    if (!upstreamPromise) {
      upstreamPromise = Promise.resolve().then(() => {
        const { createUpstream } = require('./movy-upstream.cjs');
        return createUpstream({ ofetch: ofetch || createOfetch(captureFile()) });
      }).catch((error) => {
        upstreamPromise = null;
        throw error;
      });
    }
    return upstreamPromise;
  }

  function providerMeta(providers) {
    return providers.map((item) => ({
      name: item.name,
      note: item.note || '',
      flag: item.flag || '',
      lang: /german/i.test(item.note || '') ? 'de'
        : /french/i.test(item.note || '') ? 'fr'
          : /hindi/i.test(item.note || '') ? 'hi'
            : /spanish/i.test(item.note || '') ? 'es' : 'en',
      mayHave4k: /4k/i.test(item.note || ''),
    }));
  }

  function normalizeSources(raw, provider) {
    const list = Array.isArray(raw && raw.sources) ? raw.sources : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const url = String(item && item.url || '').trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const meta = qualityMeta(item && item.quality);
      noteStreamUrl(url);
      out.push({ quality: meta.label, height: meta.height, raw: meta.raw, url, provider });
    }
    out.sort((a, b) => (b.height || 0) - (a.height || 0));
    return out;
  }

  function cacheKey({ provider, mediaType, tmdbId, seasonId, episodeId, title }) {
    const idPart = tmdbId || ('t-' + String(title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '').slice(0, 24));
    return ['movy', provider, mediaType || 'movie', idPart, seasonId || 1, episodeId || 1].join('-');
  }

  async function fetchSources(input = {}) {
    const started = Date.now();
    const { providers } = await getUpstream();
    const wanted = String(input.provider || 'Miami');
    const provider = providers.find((item) => item.name.toLowerCase() === wanted.toLowerCase()) || providers[0];
    if (!provider) return { ok: false, error: '服务器不可用', sources: [] };

    const key = cacheKey({ ...input, provider: provider.name });
    if (!input.force) {
      const mem = memory.get(key);
      if (mem && Date.now() - mem.savedAt < RESULT_TTL_MS) {
        for (const item of mem.data.sources) noteStreamUrl(item.url);
        return { ...mem.data, cached: true, ms: Date.now() - started };
      }
      const disk = readDisk(key);
      if (disk && Date.now() - disk.savedAt < RESULT_STALE_MS) {
        for (const item of disk.data.sources) noteStreamUrl(item.url);
        memory.set(key, disk);
        const age = Date.now() - disk.savedAt;
        const stale = age >= RESULT_TTL_MS;
        if (stale) {
          // 过期但可用：先把旧结果给界面（毫秒级），同时在后台静默换新
          const flightKey = key + '|revalidate';
          if (!pending.has(flightKey)) {
            pending.set(flightKey, runFetch({ ...input, provider: provider.name }, provider, key, Date.now())
              .catch(() => null)
              .finally(() => { pending.delete(flightKey); }));
          }
        }
        return { ...disk.data, cached: true, stale, ageMs: age, ms: Date.now() - started };
      }
    }

    const flightKey = key + (input.force ? '|force' : '');
    const running = pending.get(flightKey);
    if (running) return running;

    const task = runFetch({ ...input, provider: provider.name }, provider, key, started)
      .finally(() => { pending.delete(flightKey); });
    pending.set(flightKey, task);
    return task;
  }

  async function runFetch(input, provider, key, started) {
    if (Date.now() < coolingUntil) {
      return { ok: false, provider: provider.name, error: 'RATE_LIMITED', cooling: true, sources: [], subtitles: [], ms: Date.now() - started };
    }
    const mediaType = String(input.mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const payload = {
      title: String(input.title || ''),
      extraData: {
        mediaType,
        year: Number(input.year) || 0,
        totalSeasons: Number(input.totalSeasons) || 0,
        episodeId: Number(input.episodeId) || 1,
        seasonId: Number(input.seasonId) || 1,
        tmdbId: Number(input.tmdbId) || 0,
        imdbId: String(input.imdbId || ''),
      },
    };
    let raw = null;
    try {
      raw = await provider.get(payload);
    } catch (error) {
      const reason = String((error && (error.message || error)) || 'fetch failed');
      if (/429/.test(reason)) {
        coolingUntil = Date.now() + COOL_MS;
        log('movy 上游限流，冷却 ' + Math.round(COOL_MS / 1000) + 's（' + provider.name + '）');
        return { ok: false, provider: provider.name, error: 'RATE_LIMITED', cooling: true, sources: [], subtitles: [], ms: Date.now() - started };
      }
      log('movy 源失败：' + provider.name + ' · ' + reason);
      return { ok: false, provider: provider.name, error: reason, sources: [], subtitles: [], ms: Date.now() - started };
    }
    const sources = normalizeSources(raw, provider.name);
    const data = {
      ok: sources.length > 0,
      provider: provider.name,
      note: provider.note || '',
      sources,
      subtitles: Array.isArray(raw && raw.subtitles) ? raw.subtitles.slice(0, 40) : [],
      thumbnail: (raw && raw.thumbnail) || '',
      qualityOrder: sources.map((item) => item.quality),
    };
    if (sources.length) {
      const entry = { savedAt: Date.now(), data };
      memory.set(key, entry);
      writeDisk(key, entry);
      if (memory.size > 120) {
        const oldest = [...memory.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0];
        if (oldest) memory.delete(oldest[0]);
      }
    }
    log('movy 源：' + provider.name + ' ' + sources.length + ' 档 · ' + (Date.now() - started) + 'ms');
    return { ...data, cached: false, ms: Date.now() - started };
  }

  /**
   * 并行预热：把 18 台服务器一次性拉起来（并发 6），每完成一台立刻回调。
   * 这正是 Movy 播放页的做法 —— 你还在看简介，它已经把每台服务器的片源清单都存好了，
   * 所以点开画质菜单永远不会等网络。第一台含种子握手约 760ms，之后每台复用种子约 320ms，
   * 三波并发打完 18 台约 1s。
   */
  async function warm(input = {}, hooks = {}) {
    const { providers } = await getUpstream();
    const concurrency = Math.max(1, Math.min(4, Number(input.concurrency) || 2));
    // 只热身用户最先看到的那几台：并发打满会被上游 429（实测打完 18 台全变 429）
    const head = Math.max(1, Math.min(providers.length, Number(input.head) || 4));
    const wanted = Array.isArray(input.providers) && input.providers.length
      ? providers.filter((item) => input.providers.includes(item.name))
      : providers.slice(0, head);
    const targets = wanted.slice();
    const results = [];
    let cursor = 0;
    const worker = async () => {
      let launched = 0;
      while (cursor < targets.length) {
        const provider = targets[cursor++];
        // 第一台立刻开跑（它在最前面，用户最可能点它）；之后每台之间错峰，避免上游 429
        if (launched++ > 0) {
          await new Promise((resolve) => setTimeout(resolve, 320 + Math.round(Math.random() * 160)));
        }
        const started = Date.now();
        let payload = null;
        try {
          payload = await fetchSources({ ...input, provider: provider.name, retry: 1 });
        } catch (error) {
          payload = { ok: false, provider: provider.name, error: String((error && error.message) || error), sources: [] };
        }
        const row = {
          provider: provider.name,
          ok: !!(payload && payload.ok),
          ms: Date.now() - started,
          count: (payload && payload.sources && payload.sources.length) || 0,
          sources: (payload && payload.sources) || [],
          note: (payload && payload.note) || provider.note || '',
          error: (payload && payload.error) || '',
        };
        results.push(row);
        try { hooks.onResult?.(row); } catch { /* 回调异常不影响其余服务器 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return { results };
  }

  async function probe(input = {}) {
    const { providers } = await getUpstream();
    const targets = Array.isArray(input.providers) && input.providers.length
      ? providers.filter((item) => input.providers.includes(item.name))
      : providers;
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const provider = targets[cursor++];
        const started = Date.now();
        try {
          const r = await fetchSources({ ...input, provider: provider.name, force: false });
          results.push({ provider: provider.name, ok: r.ok, ms: Date.now() - started, count: r.sources.length, cached: !!r.cached });
        } catch (error) {
          results.push({ provider: provider.name, ok: false, ms: Date.now() - started, count: 0, error: String(error && error.message || error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
    results.sort((a, b) => providers.findIndex((p) => p.name === a.provider) - providers.findIndex((p) => p.name === b.provider));
    return { results };
  }

  /**
   * 启动即热身：
   *   ① 装配上游模块（18 台服务器 + 密码器），把首次请求的模块初始化成本挪走；
   *   ② 主动建连一次（DNS + TLS + HTTP/2 协商），用户第一次真正取源时少付一个 RTT。
   *      无代理直连时这一下能省 100~400ms，失败静默，不影响任何功能。
   */
  async function prewarm() {
    try {
      const { providers, streamOrigin } = await getUpstream();
      const netFetch = loadNet();
      if (netFetch) {
        const origin = String(streamOrigin || 'https://api.wecollege.net');
        const started = Date.now();
        try {
          await withTimeout(netFetch(origin + '/', {
            method: 'GET',
            headers: { 'user-agent': UA, accept: '*/*', referer: 'https://www.movy.sx/', origin: 'https://www.movy.sx' },
          }), 2500, 'movy-warm');
          log('movy 建连完成 ' + (Date.now() - started) + 'ms');
        } catch (error) {
          log('movy 建连跳过 · ' + String((error && error.message) || error));
        }
      }
      return { ok: true, providers: providers.length };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function registerIpc({ channels = {} } = {}) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
    const names = {
      list: channels.list || 'cf:m2:movy-list',
      sources: channels.sources || 'cf:m2:movy-sources',
      probe: channels.probe || 'cf:m2:movy-probe',
      warm: channels.warm || 'cf:m2:movy-warm',
      proxy: channels.proxy || 'cf:m2:movy-proxy',
    };
    const progressChannel = channels.progress || 'cf:m2:movy-warm:progress';
    const warmSeen = new Map();   // movieKey -> 最近一次预热时间（同一部片 60s 内不重复全量预热）
    for (const name of Object.values(names)) {
      try { ipcMain.removeHandler(name); } catch { /* 未注册过 */ }
    }
    ipcMain.handle(names.list, async () => {
      try {
        const { providers } = await getUpstream();
        return { ok: true, providers: providerMeta(providers) };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error), providers: [] };
      }
    });
    ipcMain.handle(names.sources, async (_event, payload = {}) => {
      try { return await fetchSources(payload); } catch (error) {
        return { ok: false, error: String(error && error.message || error), sources: [] };
      }
    });
    ipcMain.handle(names.proxy, async (_event, payload = {}) => {
      try {
        const url = mediaProxy ? mediaProxy.proxyUrl(payload && payload.url) : '';
        if (!url) return { ok: false, error: '代理未就绪', url: '' };
        return { ok: true, url };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error), url: '' };
      }
    });
    ipcMain.handle(names.probe, async (_event, payload = {}) => {
      try { return await probe(payload); } catch (error) {
        return { results: [], error: String(error && error.message || error) };
      }
    });
    // 预热：立刻返回，逐台结果用 webContents.send 推回渲染层（渲染层永不阻塞等网络）
    ipcMain.handle(names.warm, async (event, payload = {}) => {
      try {
        const movieKey = [payload.mediaType || 'movie', payload.tmdbId || 0, payload.seasonId || 1, payload.episodeId || 1].join(':');
        const now = Date.now();
        const last = warmSeen.get(movieKey) || 0;
        if (!payload.force && now - last < 60 * 1000) return { started: false, reason: 'recent' };
        warmSeen.set(movieKey, now);
        if (warmSeen.size > 40) {
          const oldest = [...warmSeen.entries()].sort((a, b) => a[1] - b[1])[0];
          if (oldest) warmSeen.delete(oldest[0]);
        }
        const sender = event && event.sender;
        const send = (row) => {
          try {
            if (!sender || sender.isDestroyed()) return;
            sender.send(progressChannel, { movieKey, provider: row.provider, ok: row.ok, ms: row.ms, count: row.count, sources: row.sources, note: row.note, error: row.error });
          } catch { /* 窗口已关，忽略 */ }
        };
        warm(payload, { onResult: send })
          .then(() => { try { if (sender && !sender.isDestroyed()) sender.send(progressChannel, { movieKey, done: true }); } catch { /* ignore */ } })
          .catch(() => { /* 预热失败静默 */ });
        return { started: true, movieKey };
      } catch (error) {
        return { started: false, error: String((error && error.message) || error) };
      }
    });
    return true;
  }

  return {
    streamHosts,
    mediaProxy,
    fetchSources,
    probe,
    warm,
    prewarm,
    registerIpc,
    providerMeta,
    qualityMeta,
    noteStreamUrl,
    getUpstream,
    _cacheDir: () => cacheDir,
  };
}

module.exports = { createMovySources, qualityMeta };

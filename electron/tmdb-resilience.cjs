'use strict';

const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('./telemetry.cjs');

const logFn = (...args) => { try { console.log('[CineFlow:Core]', ...args); } catch { /* ignore */ } };

const TMDB_API_HOST = 'api.themoviedb.org';
const OFFICIAL_ALIAS = 'https://api.tmdb.org';
const PROBE_PATH = '/3/configuration';
const PROBE_INTERVAL_MS = 90 * 1000;
const MIRROR_TIMEOUT_MS = 6000;

const state = {
  installed: false,
  session: null,
  downstream: null,          
  stickyOrigin: '',         
  unhealthyAt: 0,
  mirrors: [],       
  registryPath: '',
  active: false,      
  defaultFails: 0
};

const DEFAULT_FAIL_THRESHOLD = 2;

function loadUserMirrors(app) {
  const mirrors = new Set();
  for (const raw of String(process.env.CINEFLOW_TMDB_MIRRORS || '').split(',')) {
    const value = raw.trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(value)) mirrors.add(value);
  }
  try {
    const file = path.join(app.getPath('userData'), 'cineflow-source-compat.json');
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const raw of Array.isArray(parsed.tmdbMirrors) ? parsed.tmdbMirrors : []) {
        const value = String(raw || '').trim().replace(/\/+$/, '');
        if (/^https?:\/\//i.test(value)) mirrors.add(value);
      }
    }
  } catch { /* ignore */ }
  mirrors.add(OFFICIAL_ALIAS);
  state.mirrors = [...mirrors];
}

function isTmdbApiGet(input) {
  try {
    const url = typeof input === 'string' ? new URL(input) : (input instanceof URL ? input : new URL(input?.url || ''));
    if (url.hostname !== TMDB_API_HOST) return null;
    return url;
  } catch {
    return null;
  }
}

/** sticky 端点改写：api.themoviedb.org/3/x?y → {origin}/3/x?y */
function rewriteToOrigin(url, origin) {
  if (!origin) return url.toString();
  const out = new URL(url.toString());
  out.protocol = new URL(origin).protocol;
  out.host = new URL(origin).host;
  return out.toString();
}

async function probeOrigin(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);
  try {
    const probeUrl = rewriteToOrigin(`https://${TMDB_API_HOST}${PROBE_PATH}`, origin);
    const response = await state.downstream(probeUrl, { method: 'GET', cache: 'no-store' });
    // 有 HTTP 响应即视为端点可达（401 = 未带凭证但网络通）
    return response.status > 0 && response.status < 600 && response.status !== 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureHealthyOrigin(origin) {
  if (state.stickyOrigin === origin) return true;
  const ok = await probeOrigin(origin);
  if (ok) {
    state.stickyOrigin = origin;
    telemetry.record('tmdb.endpoint.win', { origin });
  }
  return ok;
}

/** TMDB GET 请求的韧性流程（含 sticky / 下层链路 / 镜像回退）——独立导出以便单测 */
async function tmdbFetchWithFailover(url, init) {
  // 被动模式：默认零干预（网络行为与 3.4.4 完全一致）
  if (!state.active) {
    try {
      const response = await state.downstream(url, init);
      state.defaultFails = 0;
      return response;
    } catch (error) {
      state.defaultFails += 1;
      telemetry.record('tmdb.passive.fail', { fails: state.defaultFails });
      throw error;
    }
  }

  // 已激活：sticky 直连记忆端点
  if (state.stickyOrigin) {
    try {
      const response = await state.downstream(rewriteToOrigin(url, state.stickyOrigin), init);
      if (response.ok) return response;
    } catch { /* 落入回退 */ }
  }

  // 下层既有链路（meta-server DoH 直连）
  try {
    const response = await state.downstream(url, init);
    if (response.ok) {
      if (state.stickyOrigin) telemetry.record('tmdb.failover.recover', { origin: 'default' });
      state.stickyOrigin = '';
      return response;
    }
    telemetry.record('tmdb.upstream.bad', { status: response.status });
    throw new Error(`upstream ${response.status}`);
  } catch (baselineError) {
    // 端点回退：官方别名 + 用户镜像（每个 6s 上限）
    for (const origin of state.mirrors) {
      const mirrorOrigin = new URL(origin).origin;
      if (mirrorOrigin === new URL(url instanceof URL ? url : String(url)).origin) continue;
      const ok = await ensureHealthyOrigin(mirrorOrigin);
      if (!ok) continue;
      try {
        const response = await state.downstream(rewriteToOrigin(url, state.stickyOrigin), init);
        if (response.ok) {
          telemetry.record('tmdb.mirror.served', { origin: state.stickyOrigin, path: url.pathname });
          return response;
        }
      } catch { /* 尝试下一个端点 */ }
    }
    // 镜像也全军覆没 → 回到被动（不做无谓开销）
    state.active = false;
    state.defaultFails = 0;
    telemetry.record('tmdb.resilience.deactivated', { reason: 'mirrors dead' });
    throw baselineError;
  }
}

function installTmdbResilience({ app, session }) {
  if (state.installed || !app || !session) return false;
  state.installed = true;
  state.session = session;
  loadUserMirrors(app);

  const installPatch = () => {
    try {
      state.downstream = session.defaultSession.fetch;   // 下层链（此时 meta-server 已包装完毕）
      session.defaultSession.fetch = async function tmdbResilientFetch(input, init) {
        const url = isTmdbApiGet(input);
        const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
        if (!url || method !== 'GET') return state.downstream(input, init);
        return tmdbFetchWithFailover(url, init);
      };
      telemetry.record('service.installed', { id: 'tmdb-resilience.patch', mirrors: state.mirrors.length });
      return true;
    } catch (error) {
      telemetry.record('tmdb.resilience.error', { error: String(error?.message || error).slice(0, 80) });
      return false;
    }
  };

  // ready+600ms 安装：确保落在 meta-server wrapper 之上（其 listen 回调在 ready 后数毫秒内完成）
  (app.isReady() ? Promise.resolve() : app.whenReady())
    .then(() => setTimeout(installPatch, 600))
    .catch(() => {});

  // 被动 watchdog：默认链路连续失败 ≥2 次 → 探测镜像 → 可用才激活
  setInterval(() => {
    if (!state.downstream) return;
    if (state.active) {
      if (state.stickyOrigin) {
        probeOrigin(state.stickyOrigin).then((ok) => {
          if (!ok) {
            state.stickyOrigin = '';
            telemetry.record('tmdb.sticky.lost', { at: Date.now() });
          }
        }).catch(() => {});
      }
      return;
    }
    probeOrigin(`https://${TMDB_API_HOST}`).then((defaultOk) => {
      if (defaultOk) { state.defaultFails = 0; return; }
      state.defaultFails += 1;
      if (state.defaultFails < DEFAULT_FAIL_THRESHOLD) return;
      // 默认链路确认死亡 → 找一个活镜像
      (async () => {
        for (const origin of state.mirrors) {
          const mirrorOrigin = new URL(origin).origin;
          if (mirrorOrigin === `https://${TMDB_API_HOST}`) continue;
          if (await ensureHealthyOrigin(mirrorOrigin)) {
            state.active = true;
            telemetry.record('tmdb.resilience.activated', { origin: state.stickyOrigin });
            logFn(`默认链路不可达，已激活镜像端点：${state.stickyOrigin}`);
            return;
          }
        }
        state.defaultFails = 0;   
      })().catch(() => {});
    }).catch(() => {});
  }, PROBE_INTERVAL_MS).unref?.();

  return true;
}

module.exports = {
  installTmdbResilience,
  _internals: { isTmdbApiGet, rewriteToOrigin, loadUserMirrors, tmdbFetchWithFailover, state, DEFAULT_FAIL_THRESHOLD }
};

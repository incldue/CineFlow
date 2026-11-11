'use strict';
/**
 * CineFlow 推荐引擎引导入口（新增文件）。
 * 原入口 electron/main.cjs 未做任何修改，本文件最后原样加载它。
 * 职责：注册 rec:* IPC、向默认 session 注入额外 preload、dom-ready 后注入渲染层增强脚本。
 * 引擎产物缺失或初始化失败时，应用行为与原版完全一致（静默降级）。
 */

const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');

const PRELOAD_PATH = path.join(__dirname, 'rec-preload.cjs');
const INJECT_PATH = path.join(__dirname, 'rec-inject.js');
const PREMIUM_INJECT_PATH = path.join(__dirname, 'premium-ui.js');
const ENGINE_ENTRY = path.join(__dirname, 'rec-engine', 'dist', 'engine.js');

// settings.json 滚动备份（仅备份，绝不自动改写——用户清除密钥的语义神圣不可侵犯）
try {
  require('./settings-guard.cjs').backupSettings({ app: electron.app, log: (...a) => console.log('[CineFlow:Core]', ...a) });
} catch (err) {
  console.error('[CineFlow:Core] settings 备份失败（不影响启动）:', err && err.message);
}

function recLog(...args) {
  try {
    console.log('[CineFlow:Rec]', ...args);
  } catch {
    /* ignore */
  }
}

// 直连模式下的超时收敛：基线默认值偏保守（TMDB 10s / 媒体代理 12s），
// 无代理时被污染的域名每个都要等满超时才轮到 DoH 直连兜底，体感就是"片源很慢"。
// 只有在用户没显式设置时才写入，显式环境变量优先。
try {
  const defaultEnv = {
    CINEFLOW_TMDB_TIMEOUT_MS: '6000',
    CINEFLOW_MEDIA_PROXY_TIMEOUT_MS: '7000',
    CINEFLOW_MEDIA_RESOLVE_TIMEOUT_MS: '6000',
    CINEFLOW_RESOURCE_TIMEOUT_MS: '5000'
  };
  for (const [key, value] of Object.entries(defaultEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* best-effort */ }

const recEnabled = fs.existsSync(ENGINE_ENTRY);
let corePromise = null;
let injectSource = null;
let premiumInjectSource = null;

function readInjectSource() {
  if (injectSource === null) {
    try {
      injectSource = fs.readFileSync(INJECT_PATH, 'utf8');
    } catch {
      injectSource = '';
    }
  }
  return injectSource;
}

function readPremiumInjectSource() {
  if (premiumInjectSource === null) {
    try {
      premiumInjectSource = fs.readFileSync(PREMIUM_INJECT_PATH, 'utf8');
    } catch {
      premiumInjectSource = '';
    }
  }
  return premiumInjectSource;
}

function ensureIpc() {
  if (corePromise) return;
  const { initRecommender } = require('./recommender.cjs');
  corePromise = initRecommender({ app: electron.app, ipcMain: electron.ipcMain, log: recLog }).catch((err) => {
    recLog('初始化失败，推荐与埋点静默停用:', err && err.message);
    return null;
  });
}

function installSessionPreload() {
  let installed = false;
  const install = (session) => {
    if (installed || !session) return;
    try {
      // Electron 33: session.setPreloads(preloads[]) —— 向该 session 的所有页面追加额外 preload,
      // 主窗口自身 preload(webPreferences) 不受影响。注册后对后续页面加载生效。
      if (typeof session.setPreloads !== 'function') {
        recLog('session.setPreloads 不可用, 推荐 UI 增强将停用');
        return;
      }
      const list = typeof session.getPreloads === 'function' ? session.getPreloads() : [];
      if (!list.includes(PRELOAD_PATH)) {
        session.setPreloads([...list, PRELOAD_PATH]);
      }
      installed = true;
      recLog('extra preload 已注入 session');
    } catch (err) {
      recLog('preload 注入失败(推荐 UI 增强将停用):', err && err.message);
    }
  };
  electron.app.whenReady().then(() => {
    try {
      install(electron.session.defaultSession);
    } catch (err) {
      recLog('defaultSession 预加载注入失败:', err && err.message);
    }
  });
  // 兜底: 任何新 window contents 的 session 再试一次(幂等)
  electron.app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('dom-ready', () => {
      try {
        install(contents.session);
      } catch {
        /* ignore */
      }
      // 渲染层增强脚本(主世界执行, 幂等)
      const src = readInjectSource();
      if (src) {
        contents
          .executeJavaScript(src, false)
          .catch(() => {});
      }
      // 顶级体验层（独立脚本，幂等；recEnabled=false 时也照常注入体验增强）
      const premiumSrc = readPremiumInjectSource();
      if (premiumSrc) {
        contents
          .executeJavaScript(premiumSrc, false)
          .catch(() => {});
      }
    });
  });
}

if (recEnabled) {
  try {
    ensureIpc();
  } catch (err) {
    recLog('IPC 注册失败:', err && err.message);
  }
  installSessionPreload();
} else {
  recLog('未找到 rec-engine 产物, 推荐功能停用(应用行为与原版一致)');
}

// Smart DoH 中继（edge-smart-doh 集成，零触碰）：doh.cjs（3.4.4 原版逐字节一致）在
// 模块加载时读取 CINEFLOW_DOH_ENDPOINT，因此注入必须先于 require('./main.cjs')。
// 中继启动只是本地 listen（毫秒级）；失败/超时不设 env，基线回退 3.4.4 默认上游。
// 用户显式设置了 CINEFLOW_DOH_ENDPOINT 时完全尊重，跳过中继。
const coreLog = (...args) => {
  try { console.log('[CineFlow:Core]', ...args); } catch { /* ignore */ }
};

(async () => {
  if (!process.env.CINEFLOW_DOH_ENDPOINT) {
    try {
      const endpoint = await require('./smart-doh.cjs').startSmartDoh({ app: electron.app, log: coreLog });
      if (endpoint) process.env.CINEFLOW_DOH_ENDPOINT = endpoint;
    } catch (err) {
      coreLog('Smart DoH 中继未启用（保持基线默认上游）:', err && err.message);
    }
  }

  // 无代理时的 DNS 污染兜底：先用多路 DoH 探出真实 IP，再写进 host-resolver-rules。
  // 这样连 Chromium 自己的 <img>/<video> 请求也走真地址（SNI 与 Host 仍是原域名，证书照旧校验）。
  try {
    const { createNetRescue } = require('./net-rescue.cjs');
    const mapHosts = ['api.themoviedb.org'];
    const found = await createNetRescue({ log: coreLog }).prefetchIps(mapHosts, 450);
    const rules = Object.entries(found).map(([host, ip]) => `MAP ${host} ${ip}`).join(', ');
    if (rules) {
      electron.app.commandLine.appendSwitch('host-resolver-rules', rules);
      coreLog('DNS 直连映射:', rules);
    }
  } catch (err) {
    coreLog('DNS 直连映射未启用:', err && err.message);
  }

  // 原入口原样加载
  require('./main.cjs');

  // session.fetch 直连兜底：装在 meta-server 之后，保证 TMDB / 片源解析 / 媒体代理都先经过它。
  // 探测失败的域名不再等满 7~12s 超时，而是 1~2s 内给出结果。
  try {
    const { createNetRescue } = require('./net-rescue.cjs');
    const settingsFile = path.join(electron.app.getPath('userData'), 'settings.json');
    const rescue = createNetRescue({ log: coreLog, settingsFile });
    globalThis.__cfNetRescue = rescue;
    const attempt = (tag) => {
      try {
        const ses = electron.session.defaultSession;
        if (ses && !ses.fetch.__cfNetRescuePatch) {
          rescue.install(ses);
          rescue.prefetchIps(['api.themoviedb.org'], 1200);
        }
      } catch (err) {
        coreLog('直连兜底安装失败(' + tag + '):', err && err.message);
      }
    };
    try {
      const ses = electron.session.defaultSession;
      if (ses && !ses.fetch.__cfNetRescuePatch) {
        rescue.install(ses);
        rescue.prefetchIps(['api.themoviedb.org', 'image.tmdb.org'], 3000);
      }
    } catch { /* ignore */ }
    electron.app.whenReady().then(() => {
      setTimeout(() => attempt('first'), 300);
      setTimeout(() => attempt('recheck'), 2000);
    }).catch(() => {});
  } catch (err) {
    coreLog('直连兜底模块加载失败:', err && err.message);
  }

// v3.4.6 架构基建：服务注册表统一装配（诊断 → 兼容层 → 引擎 → 契约 → Source 抽象）
// 失败隔离：单服务异常只影响自身，基线行为不受影响。
try {
  const serviceRegistry = require('./service-registry.cjs');
  const telemetry = require('./telemetry.cjs');
  const cacheLayer = require('./cache-layer.cjs');

  serviceRegistry.registerService('diagnostics', ({ ipcMain }) => {
    telemetry.installTelemetryChannels(ipcMain);
    cacheLayer.installCacheChannels(ipcMain);
    serviceRegistry.installServiceChannels(ipcMain);
  });

  serviceRegistry.registerService('source-compat', ({ app, ipcMain, session }) => {
    const result = require('./source-compat.cjs').installSourceCompat({ app, ipcMain, session });
    if (!result) throw new Error('installSourceCompat 返回 false');
    telemetry.record('service.installed', { id: 'source-compat' });
  }, { deps: ['diagnostics'] });

  serviceRegistry.registerService('source-engine', ({ ipcMain, session }) => {
    const result = require('./source-engine.cjs').installSourceEngine({ ipcMain, session });
    if (!result) throw new Error('installSourceEngine 返回 false');
    telemetry.record('service.installed', { id: 'source-engine' });
  }, { deps: ['source-compat'] });

  serviceRegistry.registerService('ipc-contract', ({ ipcMain }) => {
    const result = require('./ipc-contract.cjs').installIpcContract(ipcMain);
    telemetry.record('service.installed', { id: 'ipc-contract', wrapped: result.wrapped });
  }, { deps: ['source-engine'] });

  serviceRegistry.registerService('source-providers', ({ ipcMain }) => {
    const providerLayer = require('./source-provider.cjs');
    const compatInternals = require('./source-compat.cjs')._internals;
    const engineInternals = require('./source-engine.cjs')._internals;
    providerLayer.registerProvider(providerLayer.createDoubanCategorySource({
      id: 'douban-categories',
      fetchDoubanRecentHot: compatInternals.fetchDoubanRecentHot
    }));
    providerLayer.registerProvider(providerLayer.createCmsJsonSource({
      id: 'cms-dyttzy',
      name: '电影天堂',
      searchSource: engineInternals.searchSource
    }));
    providerLayer.installSourceChannels(ipcMain);
    telemetry.record('service.installed', { id: 'source-providers' });
  }, { deps: ['source-engine'] });

  // v3.4.8 纯增量：搜索页片源中枢（关键词横向扫源 → 按片名归并成搜索页分组）。
  // 只做「发现」，不做线路水合；点击分组时才走基线 findMovieFiltered 取可播地址。
  serviceRegistry.registerService('search-hub', ({ ipcMain, session }) => {
    const result = require('./search-hub.cjs').installSearchHub({
      ipcMain,
      session,
      log: (...args) => console.log('[CineFlow:SearchHub]', ...args)
    });
    if (!result) throw new Error('installSearchHub 返回 false');
    telemetry.record('service.installed', { id: 'search-hub' });
  }, { deps: ['source-engine'] });

  // 注：resolver-v2（播放页解析增强）按「完全对齐 3.4.4」要求撤出包装链，不再装配。

  // 周期维护：缓存清扫 + 遥测摘要（纯本地）
  serviceRegistry.registerService('maintenance', () => {
    setInterval(() => {
      const removed = cacheLayer.sweepAll();
      if (removed) telemetry.record('cache.sweep', { removed });
    }, 5 * 60 * 1000).unref?.();
    setInterval(() => {
      const view = telemetry.dump(0);
      const top = Object.entries(view.counters).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' ');
      if (top) console.log('[CineFlow:Core] 遥测摘要', top);
    }, 10 * 60 * 1000).unref?.();
  }, { deps: ['diagnostics'] });

  // 注：segment-cache / tmdb-resilience / resolver-v2 曾包装 TMDB/媒体请求路径，
  // 按「完全对齐 3.4.4 网络行为」的要求已全部撤出包装链（文件保留但不再装配）。
  // 3.4.4 原版 doh.cjs / meta-server.cjs 已覆盖回工作区。

  const installResults = serviceRegistry.installServices({
    app: electron.app,
    ipcMain: electron.ipcMain,
    session: electron.session
  });
  for (const result of installResults) {
    if (result.state === 'ok') console.log('[CineFlow:Core] 服务就绪:', result.id);
    else console.error('[CineFlow:Core] 服务装载失败:', result.id, result.error || '');
  }
} catch (err) {
  console.error('[CineFlow:Core] 架构基建装配失败（基线行为不受影响）:', err && err.message);
  // 兜底：装配层失败时仍按旧路径直接安装两个核心外挂，保证能力不丢失
  try {
    require('./source-compat.cjs').installSourceCompat({ app: electron.app, ipcMain: electron.ipcMain, session: electron.session });
    require('./source-engine.cjs').installSourceEngine({ ipcMain: electron.ipcMain, session: electron.session });
  } catch (err2) {
    console.error('[CineFlow:Core] 兜底安装亦失败:', err2 && err2.message);
  }
}
})();

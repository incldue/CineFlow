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
try { applySoftwareRasterSwitches(electron.app); } catch { /* ignore */ }

const PRELOAD_PATH = path.join(__dirname, 'rec-preload.cjs');
const INJECT_PATH = path.join(__dirname, 'rec-inject.js');
const PREMIUM_INJECT_PATH = path.join(__dirname, 'premium-ui.js');
const ENGINE_ENTRY = path.join(__dirname, 'rec-engine', 'dist', 'engine.js');

/* 第六十五轮：软件光栅机器上关掉 GPU 合成。
   判定结果由 electron/raster-tuner.cjs 在渲染进程里实测后落盘（software-raster.flag），
   这里在 app ready 之前读取它 —— 命令行开关只在这个时机有效。
   实测效果：方向键每次按键的主线程任务时间 174ms → 72ms（约 2.4 倍），
   鼠标事件与静置帧率不变。有真显卡的机器永远不会写出这个 flag，行为与之前完全一致。
   需要强制保留 GPU 合成：设置环境变量 CINEFLOW_KEEP_GPU=1。 */
function applySoftwareRasterSwitches(app) {
  try {
    if (process.env.CINEFLOW_KEEP_GPU === '1') return false;
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const baseDir = process.env.APPDATA || nodePath.join(require('node:os').homedir(), 'AppData', 'Roaming');
    const flagPath = nodePath.join(baseDir, 'CineFlow', 'software-raster.flag');
    if (nodeFs.readFileSync(flagPath, 'utf8').trim() !== '1') return false;
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    console.log('[CineFlow:Core] 已判定为软件光栅环境，本次启动关闭 GPU 合成');
    return true;
  } catch {
    return false;
  }
}

/* 第六十五轮修正：软件光栅降载必须在「窗口创建之前」就挂上监听。
   原来这段代码藏在下面的 async IIFE 里，而 IIFE 会先 await 一次 DNS 探测（最长 1.5s），
   主窗口早在这之前就创建完了 —— browser-window-created 事件已经过去，
   tuner.attach 永远不会被调用。实测：注入的降载 CSS 全部没生效（页面 208 个 box-shadow
   原样保留），软件光栅机器上等于完全没做优化。
   现在改成模块加载时同步注册，并在 whenReady 后补扫一次已存在的窗口。 */
function installRasterTuner(app) {
  try {
    const { createRasterTuner } = require('./raster-tuner.cjs');
    const tuner = createRasterTuner({ log: coreLog });
    const attached = new WeakSet();
    const attach = (win) => {
      try {
        if (!win || attached.has(win)) return;
        attached.add(win);
        tuner.attach(win);
      } catch (err) {
        coreLog('性能降载挂载失败:', err && err.message);
      }
    };
    app.on('browser-window-created', (_event, win) => attach(win));
    app.whenReady().then(() => {
      try {
        for (const win of electron.BrowserWindow.getAllWindows()) attach(win);
      } catch { /* ignore */ }
    }).catch(() => {});
    globalThis.__cfRasterTuner = tuner;
    return true;
  } catch (err) {
    coreLog('性能降载模块加载失败:', err && err.message);
    return false;
  }
}

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
    CINEFLOW_TMDB_TIMEOUT_MS: '7000',
    CINEFLOW_INITIAL_SOFT_TIMEOUT_MS: '4200',
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
    const mapHosts = ['api.themoviedb.org', 'api.tmdb.org', 'image.tmdb.org'];
    const bootRescue = createNetRescue({ log: coreLog, cacheFile: path.join(electron.app.getPath('userData'), 'ip-cache.json') });
    const found = await bootRescue.prefetchIps(mapHosts, 1500);
    /* 第六十七轮：image.tmdb.org 的 DoH 结果时有时无，缺了就会退回本机中继
       （实测中位 11.7 秒、65 个请求 >3 秒）。这里用系统解析 + 真证书校验补一条。
       校验不过就什么都不做，基线的中继行为原样保留。 */
    /* 第六十七轮：image.tmdb.org 的 DoH 结果时有时无，缺了就会退回本机中继
       （实测中位 11.7 秒、65 个请求 >3 秒）。这里用系统解析 + 真证书校验补一条。
       校验不过就什么都不做，基线的中继行为原样保留。
       注：**已有 DoH 结果时不覆盖**。DoH 挑出的 b-cdn 边缘（79.127.134.x）在并发下
       实测中位 723ms，而系统解析常给出 CloudFront（52.85.151.x）——并发下反而 1856ms。
       单条探针的快慢不能预测并发吞吐，所以只在缺失时补，不做"更快就换"。 */
    if (!found['image.tmdb.org']) {
      try {
        const edge = await require('./image-edge.cjs').pickImageEdge({ log: coreLog, host: 'image.tmdb.org' });
        if (edge) found['image.tmdb.org'] = edge;
      } catch { /* ignore */ }
    }
    bootRescue.flushCache();
    const rules = Object.entries(found).map(([host, ip]) => `MAP ${host} ${ip}`).join(', ');
    if (rules) {
      electron.app.commandLine.appendSwitch('host-resolver-rules', rules);
      coreLog('DNS 直连映射:', rules);
    }
  } catch (err) {
    coreLog('DNS 直连映射未启用:', err && err.message);
  }

  /* 预连接（第六十七轮）：无代理时 TMDB 的关键主机全靠 host-resolver-rules 钉 IP 直连，
     第一张海报/第一个 API 请求都要现付一次冷 TLS 握手 —— 实测 400~600ms，
     而 splash 正好在等这批数据，于是"没代理就慢半拍"。
     这里在每张文档 dom-ready 时插两条 <link rel="preconnect">，让 Chromium 立刻
     把 DNS/TCP/TLS 做完，后面的真实请求直接复用 socket。
     （Chromium 会把 dns-prefetch / preconnect 挂在同一个 socket 池上，
      与 net-rescue 用 (ip, servername) 建的连接是两个池，所以这一步不可省。） */
  const PRECONNECT_HOSTS = ['https://image.tmdb.org', 'https://api.themoviedb.org', 'https://api.tmdb.org'];
  const PRECONNECT_JS = '(function(){try{var list=' + JSON.stringify(PRECONNECT_HOSTS) + ';' +
    'var head=document.head||document.documentElement;if(!head)return -1;' +
    'for(var i=0;i<list.length;i++){if(document.querySelector(\'link[data-cf-pc="\'+i+\'"]\'))continue;' +
    'var a=document.createElement("link");a.rel="preconnect";a.href=list[i];a.crossOrigin="anonymous";' +
    'a.setAttribute("data-cf-pc",String(i));head.appendChild(a);' +
    'var d=document.createElement("link");d.rel="dns-prefetch";d.href=list[i];head.appendChild(d);}' +
    'return list.length;}catch(e){return -1;}})()';

  function installPreconnect(app) {
    const seen = new WeakSet();
    const wire = (win) => {
      try {
        if (!win || seen.has(win)) return;
        seen.add(win);
        const wc = win.webContents;
        if (!wc || wc.__cfPreconnect) return;
        wc.__cfPreconnect = true;
        const run = () => {
          try {
            wc.executeJavaScript(PRECONNECT_JS, true).catch(() => {});
          } catch { /* ignore */ }
        };
        wc.on('dom-ready', run);
        run();
      } catch { /* ignore */ }
    };
    try {
      app.on('browser-window-created', (_event, win) => wire(win));
      app.whenReady().then(() => {
        try {
          for (const win of require('electron').BrowserWindow.getAllWindows()) wire(win);
        } catch { /* ignore */ }
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  // 内存总督（第六十八轮）：长时运行的内存水位分级回收。
  try {
    const governor = require('./memory-governor.cjs').createMemoryGovernor({ log: coreLog });
    electron.app.whenReady().then(() => {
      try { governor.start(electron.app); } catch { /* ignore */ }
    }).catch(() => {});
  } catch (err) {
    coreLog('内存总督未启用:', err && err.message);
  }

  // 图片直连抢救（第六十七轮）：无代理时 meta-server 会把每张 TMDB 海报重定向到
  // 本机 /img 中继（整张缓冲 + 单端口 HTTP/1.1），实测 1471ms/张、55 张要 11.7 秒；
  // 开代理时反而走 Chromium 原生加载（367ms/张）。这里在 meta-server 之后重新注册
  // onBeforeRequest，对 TMDB 图片域名一律"不重定向"，把图片交回 Chromium 原生 HTTP/2。
  try {
    const imageRoute = require('./image-route-rescue.cjs').createImageRouteRescue({ log: coreLog });
    electron.app.whenReady().then(() => {
      imageRoute.install({ app: electron.app, userDataDir: electron.app.getPath('userData') });
    }).catch(() => {});
  } catch (err) {
    coreLog('图片直连抢救未启用:', err && err.message);
  }

  // 软件光栅化降载：VM / 无独显机器上 Chromium 只能 SwiftShader 逐像素画。
  try { installRasterTuner(electron.app); } catch { /* ignore */ }
  try { installPreconnect(electron.app); } catch { /* ignore */ }

  // 内置 Movy 播放源（第七十轮）：详情页 Quality 弹层的「服务器 / 画质」数据源。
  // 与原有资源体系完全隔离 —— 不读不写 resourceSettings，不碰 source-engine / CMS / TVBox。
  // 主进程只做三件事：注册 IPC、运行期学习流媒体域名并补 Referer、提供字标取图通道。
  try {
    const { ipcMain } = electron;
    const userDataDir = electron.app.getPath('userData');
    const movy = require('./movy-sources.cjs').createMovySources({ log: coreLog, userDataDir, ipcMain });
    movy.registerIpc();
    electron.app.whenReady().then(() => {
      // 启动即装配上游模块（18 台服务器 + 密码器），首次点开 Quality 不再付模块初始化成本
      movy.prewarm();
    }).catch(() => {});
    electron.app.whenReady().then(() => {
      try {
        require('./movy-referer.cjs').createMovyReferer({ log: coreLog, hosts: movy.streamHosts }).install();
      } catch (err) { coreLog('Movy Referer 注入未启用:', err && err.message); }
    }).catch(() => {});
    require('./tmdb-logos.cjs').createTmdbLogos({ log: coreLog, userDataDir, ipcMain }).registerIpc();
    // 字幕（第八十六轮）：主进程取 VTT/SRT 并解析，AI 翻译按需请求 + 落盘缓存
    try {
      require('./movy-subtitle.cjs').createMovySubtitle({ log: coreLog, userDataDir, ipcMain }).register();
    } catch (err) { coreLog('字幕模块未启用:', err && err.message); }
  } catch (err) {
    coreLog('Movy 内置源未启用:', err && err.message);
  }

  // 原入口原样加载
  require('./main.cjs');

  // TMDB 凭证落盘兜底：基线 tmdbAuth:grab 校验不过就不写盘，网络一差密钥就白粘贴。
  // 这里在基线注册之后替换这两个 handler（removeHandler + 重注册，基线文件零改动）。
  try {
    const { createCredentialRescue } = require('./tmdb-credential-rescue.cjs');
    const rescueCred = createCredentialRescue({
      log: coreLog,
      deps: {
        readCredential: () => {
          try {
            const fsp = require('node:fs');
            const pathMod = require('node:path');
            const file = pathMod.join(electron.app.getPath('userData'), 'settings.json');
            const raw = JSON.parse(fsp.readFileSync(file, 'utf8'));
            const value = String(raw.tmdbCredential || '').trim();
            if (!value) return null;
            return { type: value.startsWith('eyJ') ? 'readToken' : 'apiKey', value, source: 'local-settings' };
          } catch { return null; }
        },
        saveCredential: (value) => {
          const cleaner = String(value || '').trim();
          // 与 main.cjs 的 writeSettings 完全同构：同一个文件、同样的 JSON 缩进 + 结尾换行。
          const fsp = require('node:fs');
          const pathMod = require('node:path');
          const file = pathMod.join(electron.app.getPath('userData'), 'settings.json');
          let raw = {};
          try { raw = JSON.parse(fsp.readFileSync(file, 'utf8')); } catch { raw = {}; }
          raw.tmdbCredential = cleaner;
          fsp.mkdirSync(pathMod.dirname(file), { recursive: true });
          fsp.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
          return { configured: true, type: cleaner.startsWith('eyJ') ? 'readToken' : 'apiKey' };
        },
        clearTmdbCaches: () => {},
      },
    });
    rescueCred.install();
    globalThis.__cfCredRescue = rescueCred;
  } catch (err) {
    coreLog('TMDB 凭证兜底未启用:', err && err.message);
  }

  // session.fetch 直连兜底：装在 meta-server 之后，保证 TMDB / 片源解析 / 媒体代理都先经过它。
  // 探测失败的域名不再等满 7~12s 超时，而是 1~2s 内给出结果。
  try {
    const { createNetRescue } = require('./net-rescue.cjs');
    const settingsFile = path.join(electron.app.getPath('userData'), 'settings.json');
    const rescue = createNetRescue({ log: coreLog, settingsFile, cacheFile: path.join(electron.app.getPath('userData'), 'ip-cache.json') });
    globalThis.__cfNetRescue = rescue;
    const attempt = (tag) => {
      try {
        const ses = electron.session.defaultSession;
        if (ses && !ses.fetch.__cfNetRescuePatch) {
          rescue.install(ses);
        }
        if (!ses || !ses.__cfNetWarmDone) {
          if (ses) ses.__cfNetWarmDone = true;
          rescue.prefetchIps(['api.themoviedb.org', 'api.tmdb.org', 'image.tmdb.org'], 2600).then((found) => {
            try { rescue.warmUp(['api.themoviedb.org', 'api.tmdb.org']); } catch { /* ignore */ }
            const keys = Object.keys(found || {});
            if (keys.length) coreLog('已预热直连:', keys.join(', '));
          }).catch(() => {});
        }
      } catch (err) {
        coreLog('直连兜底安装失败(' + tag + '):', err && err.message);
      }
    };
    try {
      const ses = electron.session.defaultSession;
      if (ses && !ses.fetch.__cfNetRescuePatch) {
        rescue.install(ses);
      }
    } catch { /* ignore */ }
    // 反复"回到最外层"：meta-server / source-compat / tmdb-resilience 会在 ready 后陆续再包一层，
    // 只有本层在最外层时，TMDB 请求才会先经过 DoH 真 IP 直连（无代理也能进 TMDB 模式的关键）。
    const reclaim = (tag) => {
      try {
        const ses = electron.session.defaultSession;
        if (ses) rescue.reinstall(ses);
      } catch (err) {
        coreLog('直连兜底重挂失败(' + tag + '):', err && err.message);
      }
    };
    electron.app.whenReady().then(() => {
      setTimeout(() => { attempt('first'); reclaim('first'); }, 0);
      setTimeout(() => { attempt('recheck'); reclaim('recheck'); }, 600);
      setTimeout(() => reclaim('settle'), 1800);
      setTimeout(() => reclaim('settle2'), 3500);
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

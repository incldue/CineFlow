'use strict';

const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');
try { applySoftwareRasterSwitches(electron.app); } catch {  }

try {
  require('./linux-gpu-guard.cjs').install({
    app: electron.app,
    userDataDir: electron.app.getPath('userData'),
    log: (...args) => console.log('[CineFlow:Core]', ...args)
  });
} catch {  }

const PRELOAD_PATH = path.join(__dirname, 'rec-preload.cjs');
const INJECT_PATH = path.join(__dirname, 'rec-inject.js');
const PREMIUM_INJECT_PATH = path.join(__dirname, 'premium-ui.js');
const ENGINE_ENTRY = path.join(__dirname, 'rec-engine', 'dist', 'engine.js');

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
      } catch {  }
    }).catch(() => {});
    globalThis.__cfRasterTuner = tuner;
    return true;
  } catch (err) {
    coreLog('性能降载模块加载失败:', err && err.message);
    return false;
  }
}

try {
  require('./settings-guard.cjs').backupSettings({ app: electron.app, log: (...a) => console.log('[CineFlow:Core]', ...a) });
} catch (err) {
  console.error('[CineFlow:Core] settings 备份失败（不影响启动）:', err && err.message);
}

function recLog(...args) {
  try {
    console.log('[CineFlow:Rec]', ...args);
  } catch {

  }
}

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
} catch {  }

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

  electron.app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('dom-ready', () => {
      try {
        install(contents.session);
      } catch {

      }

      const src = readInjectSource();
      if (src) {
        contents
          .executeJavaScript(src, false)
          .catch(() => {});
      }

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

const coreLog = (...args) => {
  try { console.log('[CineFlow:Core]', ...args); } catch {  }
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

  try {
    const { createNetRescue } = require('./net-rescue.cjs');
    const mapHosts = ['api.themoviedb.org', 'api.tmdb.org', 'image.tmdb.org'];
    const bootRescue = createNetRescue({ log: coreLog, cacheFile: path.join(electron.app.getPath('userData'), 'ip-cache.json') });
    const found = await bootRescue.prefetchIps(mapHosts, 1500);

    if (!found['image.tmdb.org']) {
      try {
        const edge = await require('./image-edge.cjs').pickImageEdge({ log: coreLog, host: 'image.tmdb.org' });
        if (edge) found['image.tmdb.org'] = edge;
      } catch {  }
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
          } catch {  }
        };
        wc.on('dom-ready', run);
        run();
      } catch {  }
    };
    try {
      app.on('browser-window-created', (_event, win) => wire(win));
      app.whenReady().then(() => {
        try {
          for (const win of require('electron').BrowserWindow.getAllWindows()) wire(win);
        } catch {  }
      }).catch(() => {});
    } catch {  }
  }

  try {
    const governor = require('./memory-governor.cjs').createMemoryGovernor({ log: coreLog });
    electron.app.whenReady().then(() => {
      try { governor.start(electron.app); } catch {  }
    }).catch(() => {});
  } catch (err) {
    coreLog('内存总督未启用:', err && err.message);
  }

  try {
    const imageRoute = require('./image-route-rescue.cjs').createImageRouteRescue({ log: coreLog });
    electron.app.whenReady().then(() => {
      imageRoute.install({ app: electron.app, userDataDir: electron.app.getPath('userData') });
    }).catch(() => {});
  } catch (err) {
    coreLog('图片直连抢救未启用:', err && err.message);
  }

  try { installRasterTuner(electron.app); } catch {  }
  try { installPreconnect(electron.app); } catch {  }

  try {
    const { ipcMain } = electron;
    const userDataDir = electron.app.getPath('userData');
    const movy = require('./movy-sources.cjs').createMovySources({ log: coreLog, userDataDir, ipcMain });
    movy.registerIpc();
    electron.app.whenReady().then(() => {

      movy.prewarm();
    }).catch(() => {});
    electron.app.whenReady().then(() => {
      try {
        require('./movy-referer.cjs').createMovyReferer({ log: coreLog, hosts: movy.streamHosts }).install();
      } catch (err) { coreLog('Movy Referer 注入未启用:', err && err.message); }
    }).catch(() => {});
    require('./tmdb-logos.cjs').createTmdbLogos({ log: coreLog, userDataDir, ipcMain }).registerIpc();

    try {
      require('./movy-subtitle.cjs').createMovySubtitle({ log: coreLog, userDataDir, ipcMain }).register();
    } catch (err) { coreLog('字幕模块未启用:', err && err.message); }
  } catch (err) {
    coreLog('Movy 内置源未启用:', err && err.message);
  }

  require('./main.cjs');

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
            try { rescue.warmUp(['api.themoviedb.org', 'api.tmdb.org']); } catch {  }
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
    } catch {  }

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

  serviceRegistry.registerService('remote-library', ({ ipcMain, session }) => {
    const electron = require('electron');
    const engineModule = require('./source-engine.cjs');
    const remote = require('./remote-library.cjs').createRemoteLibrary({
      log: (...args) => console.log('[CineFlow:RemoteLib]', ...args),
      userDataDir: electron.app.getPath('userData'),
      ipcMain,
      session
    });
    remote.registerIpc();
    remote.attachEngine(engineModule._internals);
    engineModule.setRemoteBridge({
      search: (source, payload, deadline) => remote.searchSource(source, payload, deadline),
      test: (source) => remote.testRemote(source),
      sources: (mode) => remote.sourceList(mode)
    });
    telemetry.record('service.installed', { id: 'remote-library' });
  }, { deps: ['source-engine'] });

  serviceRegistry.registerService('linux-gpu', ({ ipcMain }) => {
    const electronModule = require('electron');
    require('./linux-gpu-guard.cjs').registerIpc({
      ipcMain,
      app: electronModule.app,
      userDataDir: electronModule.app.getPath('userData'),
      log: (...args) => console.log('[CineFlow:Core]', ...args)
    });
    telemetry.record('service.installed', { id: 'linux-gpu' });
  });

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

  serviceRegistry.registerService('search-hub', ({ ipcMain, session }) => {
    const result = require('./search-hub.cjs').installSearchHub({
      ipcMain,
      session,
      log: (...args) => console.log('[CineFlow:SearchHub]', ...args)
    });
    if (!result) throw new Error('installSearchHub 返回 false');
    telemetry.record('service.installed', { id: 'search-hub' });
  }, { deps: ['source-engine'] });

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

  try {
    require('./source-compat.cjs').installSourceCompat({ app: electron.app, ipcMain: electron.ipcMain, session: electron.session });
    require('./source-engine.cjs').installSourceEngine({ ipcMain: electron.ipcMain, session: electron.session });
  } catch (err2) {
    console.error('[CineFlow:Core] 兜底安装亦失败:', err2 && err2.message);
  }
}
})();

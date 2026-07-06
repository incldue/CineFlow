const { app, BrowserWindow, ipcMain, shell, session, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');

try {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
} catch {
  // Hardware acceleration hints are best-effort.
}

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'zh-CN';
const DEFAULT_REGION = 'CN';
const TMDB_TIMEOUT_MS = Number(process.env.CINEFLOW_TMDB_TIMEOUT_MS || 10000);
const TMDB_CACHE_TTL_MS = Number(process.env.CINEFLOW_TMDB_CACHE_TTL_MS || 5 * 60 * 1000);
const TMDB_CACHE_MAX = 220;
const SEARCH_ENRICH_TIMEOUT_MS = Number(process.env.CINEFLOW_SEARCH_ENRICH_TIMEOUT_MS || 1300);
const INITIAL_SOFT_TIMEOUT_MS = Number(process.env.CINEFLOW_INITIAL_SOFT_TIMEOUT_MS || 2600);
const NORMAL_WINDOW_RADIUS = 34;
const ENABLE_NATIVE_WINDOW_SHAPE = process.env.CINEFLOW_NATIVE_WINDOW_SHAPE === '1';
const RESOURCE_TIMEOUT_MS = Number(process.env.CINEFLOW_RESOURCE_TIMEOUT_MS || 6500);
const RESOURCE_CACHE_TTL_MS = Number(process.env.CINEFLOW_RESOURCE_CACHE_TTL_MS || 10 * 60 * 1000);
const RESOURCE_CACHE_MAX = 420;
const MEDIA_PROXY_TIMEOUT_MS = Number(process.env.CINEFLOW_MEDIA_PROXY_TIMEOUT_MS || 12000);
const MEDIA_RESOLVE_TIMEOUT_MS = Number(process.env.CINEFLOW_MEDIA_RESOLVE_TIMEOUT_MS || 8500);
const MEDIA_RESOLVE_CACHE_TTL_MS = Number(process.env.CINEFLOW_MEDIA_RESOLVE_CACHE_TTL_MS || 5 * 60 * 1000);
const MEDIA_PROXY_TOKEN = crypto.randomBytes(18).toString('hex');
const PLAYABLE_MEDIA_EXTENSION_RE = /\.(?:m3u8|mpd|mp4|m4v|webm|ogv|ogg|flv|ts|m2ts|mts|mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:$|[?#])/i;
const NATIVE_MEDIA_EXTENSION_RE = /\.(?:mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:$|[?#])/i;
const MEDIA_PAGE_HINT_RE = /\/(?:share|play|player|embed|vodplay|video)\//i;

const RESOURCE_MODES = {
  stable: { label: '稳定优先', description: '优先查询响应较快、结果较干净的资源源。' },
  movie: { label: '电影片库优先', description: '偏向电影片库，减少综艺/解说干扰。' },
  full: { label: '全部来源', description: '轮询更多来源，发现率更高但耗时稍长。' },
  off: { label: '关闭资源查找', description: '介绍页底部不自动查找播放资源。' }
};

const RESOURCE_SOURCES = [
  {
    key: 'dyttzy',
    name: '电影天堂',
    api: 'http://caiji.dyttzyapi.com/api.php/provide/vod',
    modes: ['stable', 'movie', 'full']
  },
  {
    key: 'ffzy',
    name: '非凡资源',
    api: 'http://ffzy5.tv/api.php/provide/vod',
    modes: ['stable', 'movie', 'full']
  },
  {
    key: 'zy360',
    name: '360资源',
    api: 'https://360zy.com/api.php/provide/vod',
    modes: ['stable', 'movie', 'full']
  },
  {
    key: 'zuid',
    name: '最大资源',
    api: 'https://api.zuidapi.com/api.php/provide/vod',
    modes: ['movie', 'full']
  },
  {
    key: 'wujin',
    name: '无尽资源',
    api: 'https://api.wujinapi.me/api.php/provide/vod',
    modes: ['stable', 'movie', 'full']
  },
  {
    key: 'bfzy',
    name: '暴风资源',
    api: 'https://bfzyapi.com/api.php/provide/vod',
    modes: ['full']
  },
  {
    key: 'lzi',
    name: '量子资源',
    api: 'https://cj.lziapi.com/api.php/provide/vod',
    modes: ['full']
  },
  {
    key: 'ruyi',
    name: '如意资源',
    api: 'https://cj.rycjapi.com/api.php/provide/vod',
    modes: ['stable', 'movie', 'full']
  }
];

let mainWindow;
let windowMode = 'normal';
let normalWindowBounds = null;
let windowAnimationTimer = null;
let islandDragOffset = null;
let currentIslandHeight = 72;
let dockedEdge = null;
let appliedProxyKey = null;
let appliedProxyResult = null;
let proxyApplyPromise = null;
let settingsCache = null;
let settingsCacheMtimeMs = -1;
let envFileCache = null;
let envFileCacheMtimeMs = -1;
let mediaProxyServer = null;
let mediaProxyPort = 0;
let mediaProxyStarting = null;
const tmdbResponseCache = new Map();
const tmdbInFlight = new Map();
const resourceResponseCache = new Map();
const mediaResolveCache = new Map();

function canUseNativeShape() {
  return Boolean(
    ENABLE_NATIVE_WINDOW_SHAPE
    &&
    mainWindow
    && typeof mainWindow.setShape === 'function'
    && ['win32', 'linux'].includes(process.platform)
  );
}

function roundedRectShape(x, y, width, height, radius, step = 1) {
  const rects = [];
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeRadius = Math.max(0, Math.min(Math.round(radius), Math.floor(safeWidth / 2), Math.floor(safeHeight / 2)));

  for (let row = 0; row < safeHeight; row += step) {
    const sliceHeight = Math.min(step, safeHeight - row);
    const cy = row + sliceHeight / 2;
    let inset = 0;

    if (safeRadius > 0 && cy < safeRadius) {
      const dy = safeRadius - cy;
      inset = safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy));
    } else if (safeRadius > 0 && cy > safeHeight - safeRadius) {
      const dy = cy - (safeHeight - safeRadius);
      inset = safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy));
    }

    const left = Math.round(x + inset);
    const rectWidth = Math.max(1, Math.round(safeWidth - inset * 2));
    rects.push({
      x: left,
      y: Math.round(y + row),
      width: rectWidth,
      height: sliceHeight
    });
  }

  return rects;
}

function applyWindowShape(mode = windowMode, bounds = null) {
  if (!canUseNativeShape()) return;
  const currentBounds = bounds || mainWindow.getBounds();

  try {
    if (mode === 'island') {
      mainWindow.setShape(roundedRectShape(14, 14, currentBounds.width - 28, currentBounds.height - 28, 28));
      return;
    }

    if (mode === 'island-expanded') {
      mainWindow.setShape(roundedRectShape(18, 18, currentBounds.width - 36, currentBounds.height - 36, 30));
      return;
    }


    if (mode === 'island-docked') {
      mainWindow.setShape(roundedRectShape(0, 0, currentBounds.width, currentBounds.height, 22));
      return;
    }

    mainWindow.setShape(roundedRectShape(0, 0, currentBounds.width, currentBounds.height, NORMAL_WINDOW_RADIUS));
  } catch {
    // setShape is experimental; if it is unavailable or rejected on a platform,
    // keep the transparent-window CSS fallback instead of interrupting the app.
  }
}

function getProjectRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..');
}

function animateWindowBounds(targetBounds, duration = 300) {
  if (!mainWindow) return;
  clearInterval(windowAnimationTimer);
  const startBounds = mainWindow.getBounds();
  const startedAt = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  windowAnimationTimer = setInterval(() => {
    if (!mainWindow) {
      clearInterval(windowAnimationTimer);
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = ease(progress);
    const nextBounds = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      nextBounds[key] = Math.round(startBounds[key] + (targetBounds[key] - startBounds[key]) * eased);
    }
    mainWindow.setBounds(nextBounds, false);
    applyWindowShape(windowMode, nextBounds);
    if (progress >= 1) {
      clearInterval(windowAnimationTimer);
      windowAnimationTimer = null;
      applyWindowShape(windowMode, targetBounds);
    }
  }, 16);
}

function stopWindowAnimation() {
  if (windowAnimationTimer) {
    clearInterval(windowAnimationTimer);
    windowAnimationTimer = null;
  }
}

function getIslandDragLockSize(bounds) {
  if (windowMode === 'island') {
    const target = getIslandBounds(currentIslandHeight || 72);
    return { width: target.width, height: target.height };
  }

  if (windowMode === 'island-expanded') {
    const target = getIslandBounds(currentIslandHeight || 320);
    return { width: target.width, height: target.height };
  }

  return { width: bounds.width, height: bounds.height };
}

function getIslandBounds(height = 72) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;
  const width = height <= 92 ? 460 : Math.min(640, Math.max(500, Math.round(work.width * 0.34)));
  const padding = height <= 92 ? 14 : 18;
  return {
    width: width + padding * 2,
    height: height + padding * 2,
    x: Math.round(work.x + (work.width - width) / 2) - padding,
    y: work.y + 18 - padding
  };
}

function clampWindowToWorkArea(x, y, width, height) {
  const cursor = screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(cursor).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, work.x), Math.max(work.x, work.x + work.width - width))),
    y: Math.round(Math.min(Math.max(y, work.y), Math.max(work.y, work.y + work.height - height)))
  };
}

function getNearestDockEdge(bounds) {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  const work = screen.getDisplayNearestPoint(center).workArea;
  const threshold = 34;
  const distances = [
    { edge: 'left', value: Math.abs(bounds.x - work.x) },
    { edge: 'right', value: Math.abs(work.x + work.width - (bounds.x + bounds.width)) },
    { edge: 'top', value: Math.abs(bounds.y - work.y) },
    { edge: 'bottom', value: Math.abs(work.y + work.height - (bounds.y + bounds.height)) }
  ].sort((a, b) => a.value - b.value);
  return distances[0].value <= threshold ? distances[0].edge : null;
}

function getDockedBounds(edge, sourceBounds = null) {
  const cursor = screen.getCursorScreenPoint();
  const sourceCenter = sourceBounds
    ? { x: sourceBounds.x + sourceBounds.width / 2, y: sourceBounds.y + sourceBounds.height / 2 }
    : cursor;
  const work = screen.getDisplayNearestPoint(sourceCenter).workArea;
  const isSide = edge === 'left' || edge === 'right';
  const width = isSide ? 46 : 154;
  const height = isSide ? 126 : 46;
  const x = edge === 'left'
    ? work.x
    : edge === 'right'
      ? work.x + work.width - width
      : Math.round(Math.min(Math.max(sourceCenter.x - width / 2, work.x + 10), work.x + work.width - width - 10));
  const y = edge === 'top'
    ? work.y
    : edge === 'bottom'
      ? work.y + work.height - height
      : Math.round(Math.min(Math.max(sourceCenter.y - height / 2, work.y + 10), work.y + work.height - height - 10));

  return { x, y, width, height };
}

function getUndockedIslandBounds(edge = dockedEdge || 'top', height = 72) {
  const dockBounds = mainWindow?.getBounds();
  const sourceCenter = dockBounds
    ? { x: dockBounds.x + dockBounds.width / 2, y: dockBounds.y + dockBounds.height / 2 }
    : screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(sourceCenter).workArea;
  const width = 460;
  const padding = 14;
  const fullWidth = width + padding * 2;
  const fullHeight = height + padding * 2;
  const xByCenter = Math.round(sourceCenter.x - fullWidth / 2);
  const yByCenter = Math.round(sourceCenter.y - fullHeight / 2);

  if (edge === 'left') {
    return {
      width: fullWidth,
      height: fullHeight,
      x: work.x + 18,
      y: Math.round(Math.min(Math.max(yByCenter, work.y + 18), work.y + work.height - fullHeight - 18))
    };
  }
  if (edge === 'right') {
    return {
      width: fullWidth,
      height: fullHeight,
      x: work.x + work.width - fullWidth - 18,
      y: Math.round(Math.min(Math.max(yByCenter, work.y + 18), work.y + work.height - fullHeight - 18))
    };
  }
  if (edge === 'bottom') {
    return {
      width: fullWidth,
      height: fullHeight,
      x: Math.round(Math.min(Math.max(xByCenter, work.x + 18), work.x + work.width - fullWidth - 18)),
      y: work.y + work.height - fullHeight - 18
    };
  }
  return {
    width: fullWidth,
    height: fullHeight,
    x: Math.round(Math.min(Math.max(xByCenter, work.x + 18), work.x + work.width - fullWidth - 18)),
    y: work.y + 18
  };
}

function enterIslandMode(height = 72) {
  if (!mainWindow) return false;
  if (windowMode === 'normal') {
    normalWindowBounds = mainWindow.getBounds();
  }
  currentIslandHeight = Number(height) || 72;
  const wasDocked = windowMode === 'island-docked';
  const edge = dockedEdge;
  windowMode = 'island';
  islandDragOffset = null;
  mainWindow.setMinimumSize(320, 64);
  mainWindow.setMaximumSize(10000, 10000);
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setHasShadow(false);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setResizable(false);
  mainWindow.webContents.send('window:mode', { mode: 'island', height });
  applyWindowShape('island');
  animateWindowBounds(wasDocked ? getUndockedIslandBounds(edge, height) : getIslandBounds(height), 360);
  dockedEdge = null;
  return true;
}

function expandIslandMode(height = 320) {
  if (!mainWindow) return false;
  if (windowMode === 'island-docked') enterIslandMode(72);
  if (windowMode !== 'island') enterIslandMode(72);
  currentIslandHeight = Number(height) || 320;
  windowMode = 'island-expanded';
  mainWindow.webContents.send('window:mode', { mode: 'island-expanded', height });
  applyWindowShape('island-expanded');
  animateWindowBounds(getIslandBounds(height), 320);
  return true;
}

function restoreNormalMode() {
  if (!mainWindow) return false;
  windowMode = 'normal';
  islandDragOffset = null;
  dockedEdge = null;
  const target = normalWindowBounds || { width: 1280, height: 820 };
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setHasShadow(true);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(1040, 680);
  mainWindow.setMaximumSize(10000, 10000);
  mainWindow.webContents.send('window:mode', { mode: 'normal' });
  applyWindowShape('normal');
  animateWindowBounds(target, 430);
  return true;
}

function enterIslandDockedMode(edge, sourceBounds = null) {
  if (!mainWindow || !edge) return false;
  if (windowMode === 'normal') normalWindowBounds = mainWindow.getBounds();
  dockedEdge = edge;
  windowMode = 'island-docked';
  islandDragOffset = null;
  mainWindow.setMinimumSize(36, 36);
  mainWindow.setMaximumSize(10000, 10000);
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setHasShadow(false);
  mainWindow.setResizable(false);
  mainWindow.webContents.send('window:mode', { mode: 'island-docked', edge });
  const bounds = getDockedBounds(edge, sourceBounds || mainWindow.getBounds());
  applyWindowShape('island-docked', bounds);
  animateWindowBounds(bounds, 260);
  return { mode: 'island-docked', edge };
}

function beginIslandDragMode(payload = {}) {
  if (!mainWindow) return false;
  if (!['island', 'island-expanded', 'island-docked'].includes(windowMode)) return false;

  stopWindowAnimation();

  const bounds = mainWindow.getBounds();
  const lockedSize = getIslandDragLockSize(bounds);
  const point = {
    x: Number(payload.screenX ?? payload.x ?? screen.getCursorScreenPoint().x),
    y: Number(payload.screenY ?? payload.y ?? screen.getCursorScreenPoint().y)
  };

  if ((bounds.width !== lockedSize.width || bounds.height !== lockedSize.height)
    && Number.isFinite(lockedSize.width)
    && Number.isFinite(lockedSize.height)) {
    const lockedPosition = clampWindowToWorkArea(bounds.x, bounds.y, lockedSize.width, lockedSize.height);
    mainWindow.setBounds({
      x: lockedPosition.x,
      y: lockedPosition.y,
      width: lockedSize.width,
      height: lockedSize.height
    }, false);
  }

  const lockedBounds = mainWindow.getBounds();
  islandDragOffset = {
    x: Math.round(Math.min(Math.max(point.x - lockedBounds.x, 18), Math.max(18, lockedBounds.width - 18))),
    y: Math.round(Math.min(Math.max(point.y - lockedBounds.y, 18), Math.max(18, lockedBounds.height - 18))),
    width: lockedBounds.width,
    height: lockedBounds.height
  };
  return true;
}

function moveIslandDragMode(payload = {}) {
  if (!mainWindow || !islandDragOffset) return false;

  const point = {
    x: Number(payload.screenX ?? payload.x ?? screen.getCursorScreenPoint().x),
    y: Number(payload.screenY ?? payload.y ?? screen.getCursorScreenPoint().y)
  };
  const bounds = mainWindow.getBounds();
  const lockedWidth = Math.max(1, Math.round(islandDragOffset.width || bounds.width));
  const lockedHeight = Math.max(1, Math.round(islandDragOffset.height || bounds.height));
  const display = screen.getDisplayNearestPoint(point).workArea;
  const maxX = Math.max(display.x, display.x + display.width - lockedWidth);
  const maxY = Math.max(display.y, display.y + display.height - lockedHeight);
  const nextX = Math.round(Math.min(Math.max(point.x - islandDragOffset.x, display.x), maxX));
  const nextY = Math.round(Math.min(Math.max(point.y - islandDragOffset.y, display.y), maxY));

  if (nextX === bounds.x && nextY === bounds.y && bounds.width === lockedWidth && bounds.height === lockedHeight) {
    return false;
  }
  mainWindow.setBounds({
    x: nextX,
    y: nextY,
    width: lockedWidth,
    height: lockedHeight
  }, false);
  return true;
}

function endIslandDragMode(shouldDock = true, payload = {}) {
  if (!mainWindow) return null;
  const hadDrag = Boolean(islandDragOffset);
  if (hadDrag && shouldDock) {
    moveIslandDragMode(payload);
  }
  islandDragOffset = null;

  if (!hadDrag) {
    return { mode: windowMode, edge: dockedEdge || null };
  }

  if (shouldDock) {
    const edge = getNearestDockEdge(mainWindow.getBounds());
    if (edge) {
      return enterIslandDockedMode(edge, mainWindow.getBounds());
    }
  }

  return {
    mode: windowMode,
    edge: dockedEdge || null,
    x: Number(payload.screenX ?? payload.x ?? 0),
    y: Number(payload.screenY ?? payload.y ?? 0)
  };
}

function readEnvFile() {
  const envPath = path.join(getProjectRoot(), '.env');
  try {
    const stat = fs.statSync(envPath);
    if (envFileCache && envFileCacheMtimeMs === stat.mtimeMs) {
      return envFileCache;
    }
    const env = {};
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) continue;
      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      if (key) env[key] = value;
    }
    envFileCache = env;
    envFileCacheMtimeMs = stat.mtimeMs;
    return envFileCache;
  } catch {
    envFileCache = {};
    envFileCacheMtimeMs = -1;
    return envFileCache;
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const file = settingsPath();
    const stat = fs.statSync(file);
    if (settingsCache && settingsCacheMtimeMs === stat.mtimeMs) {
      return { ...settingsCache };
    }
    settingsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
    settingsCacheMtimeMs = stat.mtimeMs;
    return { ...settingsCache };
  } catch {
    settingsCache = {};
    settingsCacheMtimeMs = -1;
    return {};
  }
}

function writeSettings(nextSettings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8');
  settingsCache = { ...nextSettings };
  try {
    settingsCacheMtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    settingsCacheMtimeMs = Date.now();
  }
}


function normalizeProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(direct|system|auto_detect)$/i.test(value)) return value.toLowerCase();
  if (/^(https?|socks4|socks5):\/\//i.test(value)) return value;
  if (/^(127\.0\.0\.1|localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}$/i.test(value)) {
    return `http://${value}`;
  }
  return value;
}

function getProxySetting() {
  const settings = readSettings();
  const envFile = readEnvFile();
  return normalizeProxy(
    settings.proxy ||
    process.env.CINEFLOW_PROXY ||
    envFile.CINEFLOW_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    envFile.HTTPS_PROXY ||
    envFile.HTTP_PROXY ||
    envFile.ALL_PROXY ||
    'system'
  );
}

function rememberAppliedProxy(proxy, result) {
  appliedProxyKey = proxy;
  appliedProxyResult = result;
  return result;
}

async function applyProxySettingNow(options = {}) {
  const { force = false } = options;
  const proxy = getProxySetting();
  const ses = session.defaultSession;
  if (!ses) return { proxy: '', mode: 'pending' };
  if (!force && appliedProxyKey === proxy && appliedProxyResult) {
    return appliedProxyResult;
  }

  if (!proxy || proxy === 'system') {
    await ses.setProxy({ mode: 'system' });
    await ses.closeAllConnections();
    return rememberAppliedProxy(proxy, { proxy: 'system', mode: 'system' });
  }
  if (proxy === 'direct') {
    await ses.setProxy({ mode: 'direct' });
    await ses.closeAllConnections();
    return rememberAppliedProxy(proxy, { proxy: 'direct', mode: 'direct' });
  }
  if (proxy === 'auto_detect') {
    await ses.setProxy({ mode: 'auto_detect' });
    await ses.closeAllConnections();
    return rememberAppliedProxy(proxy, { proxy: 'auto_detect', mode: 'auto_detect' });
  }

  let proxyRules = proxy;
  try {
    const parsed = new URL(proxy);
    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    const host = parsed.host;
    if (protocol === 'http' || protocol === 'https') {
      proxyRules = `http=${host};https=${host}`;
    } else if (protocol === 'socks' || protocol === 'socks4' || protocol === 'socks5') {
      proxyRules = `${protocol}=${host}`;
    } else {
      proxyRules = `${protocol}=${host}`;
    }
  } catch {
    proxyRules = proxy;
  }
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    proxyBypassRules: '<local>'
  });
  await ses.closeAllConnections();
  return rememberAppliedProxy(proxy, { proxy, mode: 'fixed_servers', proxyRules });
}

async function applyProxySetting(options = {}) {
  if (proxyApplyPromise) {
    if (!options.force) return proxyApplyPromise;
    await proxyApplyPromise.catch(() => {});
  }
  proxyApplyPromise = applyProxySettingNow(options)
    .finally(() => {
      proxyApplyPromise = null;
    });
  return proxyApplyPromise;
}

function publicProxyState() {
  const proxy = getProxySetting();
  if (!proxy || proxy === 'system') return { configured: true, mode: 'system', value: 'system' };
  if (proxy === 'direct') return { configured: true, mode: 'direct', value: 'direct' };
  if (proxy === 'auto_detect') return { configured: true, mode: 'auto_detect', value: 'auto_detect' };
  return { configured: true, mode: 'fixed_servers', value: proxy };
}

function normalizeResourceMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return RESOURCE_MODES[value] ? value : 'stable';
}

function publicResourceSettings() {
  const settings = readSettings();
  const mode = normalizeResourceMode(settings.resourceMode);
  return {
    mode,
    label: RESOURCE_MODES[mode].label,
    description: RESOURCE_MODES[mode].description,
    enabled: mode !== 'off',
    modes: Object.entries(RESOURCE_MODES).map(([value, meta]) => ({
      value,
      label: meta.label,
      description: meta.description
    }))
  };
}

function selectResourceSources(mode) {
  const normalizedMode = normalizeResourceMode(mode);
  if (normalizedMode === 'off') return [];
  return RESOURCE_SOURCES.filter((source) => source.modes.includes(normalizedMode));
}

function normalizeCredential(raw) {
  const credential = String(raw || '').trim();
  if (!credential) return null;
  if (credential.startsWith('eyJ')) {
    return { type: 'readToken', value: credential };
  }
  return { type: 'apiKey', value: credential };
}

function getCredential() {
  const settings = readSettings();
  const stored = normalizeCredential(settings.tmdbCredential);
  if (stored) return { ...stored, source: 'local-settings' };

  const envFile = readEnvFile();
  const readToken = normalizeCredential(process.env.TMDB_READ_TOKEN || envFile.TMDB_READ_TOKEN);
  if (readToken) return { ...readToken, source: '.env' };

  const apiKey = normalizeCredential(process.env.TMDB_API_KEY || envFile.TMDB_API_KEY);
  if (apiKey) return { ...apiKey, source: '.env' };

  return null;
}

function publicCredentialState() {
  const credential = getCredential();
  if (!credential) {
    return { configured: false, source: null, type: null, preview: '', proxy: publicProxyState(), resources: publicResourceSettings() };
  }
  return {
    configured: true,
    source: credential.source,
    type: credential.type,
    preview: credential.value.length > 10
      ? `${credential.value.slice(0, 4)}••••${credential.value.slice(-4)}`
      : '••••',
    proxy: publicProxyState(),
    resources: publicResourceSettings()
  };
}

function getCachedTmdbPayload(cacheKey) {
  const cached = tmdbResponseCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tmdbResponseCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedTmdbPayload(cacheKey, payload) {
  if (!TMDB_CACHE_TTL_MS) return;
  while (tmdbResponseCache.size >= TMDB_CACHE_MAX) {
    const firstKey = tmdbResponseCache.keys().next().value;
    if (!firstKey) break;
    tmdbResponseCache.delete(firstKey);
  }
  tmdbResponseCache.set(cacheKey, {
    expiresAt: Date.now() + TMDB_CACHE_TTL_MS,
    payload
  });
}

function clearTmdbCaches() {
  tmdbResponseCache.clear();
  tmdbInFlight.clear();
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
}

function withSoftTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    })
  ]);
}

function buildTmdbUrl(endpoint, params = {}) {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
  const credential = getCredential();
  if (!credential) {
    const error = new Error('TMDB credential is missing.');
    error.code = 'MISSING_TMDB_CREDENTIAL';
    throw error;
  }

  const merged = {
    language: DEFAULT_LANGUAGE,
    ...params
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  if (credential.type === 'apiKey') {
    url.searchParams.set('api_key', credential.value);
  }
  return { url, credential };
}

async function tmdbFetch(endpoint, params = {}) {
  const { url, credential } = buildTmdbUrl(endpoint, params);
  const cacheKey = `${credential.type}:${credential.value}|${url.pathname}?${url.searchParams.toString()}`;
  const cachedPayload = getCachedTmdbPayload(cacheKey);
  if (cachedPayload) return cachedPayload;
  if (tmdbInFlight.has(cacheKey)) return tmdbInFlight.get(cacheKey);

  const request = (async () => {
    await applyProxySetting();

    const headers = {
      accept: 'application/json'
    };
    if (credential.type === 'readToken') {
      headers.authorization = `Bearer ${credential.value}`;
    }

    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
    try {
      response = await session.defaultSession.fetch(url.toString(), { headers, signal: controller.signal });
    } catch (requestError) {
      const resolvedProxy = await session.defaultSession.resolveProxy('https://api.themoviedb.org/3/configuration')
        .catch(() => 'UNKNOWN');
      const isTimeout = requestError?.name === 'AbortError';
      const error = new Error(
        isTimeout
          ? `网络连接超时（${TMDB_TIMEOUT_MS}ms）：请检查代理地址；当前代理解析：${resolvedProxy}`
          : `网络连接失败：${requestError.message || requestError}；当前代理解析：${resolvedProxy}`
      );
      error.code = 'TMDB_NETWORK_FAILED';
      error.resolvedProxy = resolvedProxy;
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const error = new Error(payload.status_message || `TMDB request failed: ${response.status}`);
      error.code = response.status === 401 ? 'TMDB_AUTH_FAILED' : 'TMDB_REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
    setCachedTmdbPayload(cacheKey, payload);
    return payload;
  })().finally(() => tmdbInFlight.delete(cacheKey));

  tmdbInFlight.set(cacheKey, request);
  return request;
}

function getCachedResourcePayload(cacheKey) {
  const cached = resourceResponseCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resourceResponseCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedResourcePayload(cacheKey, payload) {
  if (!RESOURCE_CACHE_TTL_MS) return;
  while (resourceResponseCache.size >= RESOURCE_CACHE_MAX) {
    const firstKey = resourceResponseCache.keys().next().value;
    if (!firstKey) break;
    resourceResponseCache.delete(firstKey);
  }
  resourceResponseCache.set(cacheKey, {
    expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS,
    payload
  });
}

function buildResourceUrl(source, params = {}) {
  const url = new URL(source.api);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function parseMaybeJson(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed[0] === '<') return null;
  return JSON.parse(trimmed);
}

async function resourceFetchJson(source, params = {}) {
  const url = buildResourceUrl(source, params);
  const cacheKey = `${source.key}|${url.searchParams.toString()}`;
  const cachedPayload = getCachedResourcePayload(cacheKey);
  if (cachedPayload) return cachedPayload;

  await applyProxySetting().catch(() => {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/1.0'
      }
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`资源源请求失败：${response.status}`);
      error.code = 'RESOURCE_HTTP_FAILED';
      error.status = response.status;
      throw error;
    }
    const payload = parseMaybeJson(text);
    if (!payload || !Array.isArray(payload.list)) {
      const error = new Error('资源源返回格式不可用。');
      error.code = 'RESOURCE_BAD_PAYLOAD';
      throw error;
    }
    setCachedResourcePayload(cacheKey, payload);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMediaTargetUrl(value) {
  const target = String(value || '').trim();
  if (target.length < 8 || target.length > 4096) return null;
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function getMediaProxyUrl(target) {
  const url = normalizeMediaTargetUrl(target);
  if (!url || !mediaProxyPort) return '';
  const proxyUrl = new URL(`http://127.0.0.1:${mediaProxyPort}/media`);
  proxyUrl.searchParams.set('token', MEDIA_PROXY_TOKEN);
  proxyUrl.searchParams.set('url', url.toString());
  return proxyUrl.toString();
}

function inferMediaKind(value = '', contentType = '') {
  const text = String(value || '').toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mpegurl') || type.includes('x-mpegurl') || type.includes('vnd.apple.mpegurl') || /\.m3u8(?:$|[?#])/i.test(text) || /m3u8/i.test(text)) {
    return 'hls';
  }
  if (type.includes('dash+xml') || type.includes('mpeg-dash') || /\.mpd(?:$|[?#])/i.test(text)) {
    return 'dash';
  }
  if (type.includes('x-flv') || type.includes('flv') || /\.flv(?:$|[?#])/i.test(text)) {
    return 'flv';
  }
  if (type.includes('mp2t') || type.includes('mpegts') || /\.(?:ts|m2ts|mts)(?:$|[?#])/i.test(text)) {
    return 'mpegts';
  }
  if (type.includes('mp4') || /\.m4v(?:$|[?#])/i.test(text) || /\.mp4(?:$|[?#])/i.test(text)) {
    return 'mp4';
  }
  if (type.includes('webm') || /\.webm(?:$|[?#])/i.test(text)) {
    return 'webm';
  }
  if (type.includes('ogg') || /\.(?:ogv|ogg)(?:$|[?#])/i.test(text)) {
    return 'ogg';
  }
  if (NATIVE_MEDIA_EXTENSION_RE.test(text) || type.startsWith('video/') || type.startsWith('audio/')) {
    return 'native';
  }
  if (MEDIA_PAGE_HINT_RE.test(text)) return 'page';
  return 'native';
}

function mediaFormatLabel(kind = 'native') {
  switch (kind) {
    case 'hls':
      return 'HLS';
    case 'dash':
      return 'DASH';
    case 'flv':
      return 'FLV';
    case 'mpegts':
      return 'MPEG-TS';
    case 'mp4':
      return 'MP4';
    case 'webm':
      return 'WebM';
    case 'ogg':
      return 'OGG';
    case 'page':
      return '网页解析';
    default:
      return '直连';
  }
}

function playbackMetaForUrl(value = '', lineName = '') {
  const url = String(value || '');
  const kind = inferMediaKind(url);
  const name = String(lineName || '').toLowerCase();
  const needsResolve = kind === 'page' || (!PLAYABLE_MEDIA_EXTENSION_RE.test(url) && MEDIA_PAGE_HINT_RE.test(url));
  let format = mediaFormatLabel(kind);
  if (needsResolve) {
    format = name.includes('m3u8') ? '网页解析·HLS' : '网页解析';
  }
  return {
    kind,
    format,
    needsResolve
  };
}

function getCachedMediaResolve(target) {
  const cached = mediaResolveCache.get(target);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    mediaResolveCache.delete(target);
    return null;
  }
  return cached.payload;
}

function setCachedMediaResolve(target, payload) {
  if (!MEDIA_RESOLVE_CACHE_TTL_MS) return;
  while (mediaResolveCache.size >= 160) {
    const firstKey = mediaResolveCache.keys().next().value;
    if (!firstKey) break;
    mediaResolveCache.delete(firstKey);
  }
  mediaResolveCache.set(target, {
    expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
    payload
  });
}

function decodeMediaCandidate(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  try {
    text = JSON.parse(`"${text.replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`);
  } catch {
    text = text
      .replace(/\\\//g, '/')
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return text.trim();
}

function normalizeExtractedMediaUrl(candidate, baseUrl) {
  const decoded = decodeMediaCandidate(candidate);
  if (!decoded) return '';
  if (/^(?:javascript|data|blob):/i.test(decoded)) return '';
  if (/\.(?:jpg|jpeg|png|gif|webp|css|js|vtt|srt)(?:$|[?#])/i.test(decoded)) return '';
  if (!PLAYABLE_MEDIA_EXTENSION_RE.test(decoded)) return '';
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return '';
  }
}

function pushMediaCandidate(candidates, seen, value, baseUrl) {
  const url = normalizeExtractedMediaUrl(value, baseUrl);
  if (!url || seen.has(url)) return;
  seen.add(url);
  candidates.push(url);
}

function extractMediaUrlsFromHtml(text = '', baseUrl = '') {
  const html = String(text || '');
  const candidates = [];
  const seen = new Set();
  const variableRe = /(?:const|let|var)\s+(?:url|main|video|source|src|file|playurl|player_url|m3u8|mp4)\s*=\s*(['"`])([\s\S]*?)\1/gi;
  const propertyRe = /\b(?:url|src|file|video|source|playUrl|player_url)\s*:\s*(['"`])([\s\S]*?)\1/gi;
  const attrRe = /\b(?:src|data-src|data-url|data-player|href)=["']([^"']+)["']/gi;
  const quotedMediaRe = /["']([^"']+\.(?:m3u8|mpd|mp4|m4v|webm|ogv|ogg|flv|ts|m2ts|mts|mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:[?#][^"']*)?)["']/gi;

  for (const regex of [variableRe, propertyRe, attrRe, quotedMediaRe]) {
    for (const match of html.matchAll(regex)) {
      pushMediaCandidate(candidates, seen, match[2] || match[1], baseUrl);
    }
  }

  return candidates.sort((a, b) => {
    const score = (url) => {
      const kind = inferMediaKind(url);
      if (kind === 'hls') return 40;
      if (kind === 'dash') return 34;
      if (kind === 'mp4') return 30;
      if (kind === 'flv') return 24;
      if (kind === 'mpegts') return 20;
      return 10;
    };
    return score(b) - score(a);
  });
}

async function resolveMediaUrl(target) {
  const sourceUrl = normalizeMediaTargetUrl(target);
  if (!sourceUrl) {
    const error = new Error('Invalid media url.');
    error.code = 'INVALID_MEDIA_URL';
    throw error;
  }

  const original = sourceUrl.toString();
  const directKind = inferMediaKind(original);
  if (directKind !== 'page' && PLAYABLE_MEDIA_EXTENSION_RE.test(original)) {
    return {
      originalUrl: original,
      url: original,
      resolved: false,
      kind: directKind,
      format: mediaFormatLabel(directKind),
      contentType: ''
    };
  }

  const cached = getCachedMediaResolve(original);
  if (cached) return cached;

  await applyProxySetting().catch(() => {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_RESOLVE_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(original, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/1.0',
        referer: `${sourceUrl.origin}/`
      }
    });
    clearTimeout(timeout);

    const finalUrl = response.url || original;
    const contentType = String(response.headers.get('content-type') || '');
    const responseKind = inferMediaKind(finalUrl, contentType);
    if (responseKind !== 'page' && (PLAYABLE_MEDIA_EXTENSION_RE.test(finalUrl) || contentType.toLowerCase().startsWith('video/') || contentType.toLowerCase().startsWith('audio/') || contentType.toLowerCase().includes('mpegurl') || contentType.toLowerCase().includes('dash+xml'))) {
      const payload = {
        originalUrl: original,
        url: finalUrl,
        resolved: finalUrl !== original,
        kind: responseKind,
        format: mediaFormatLabel(responseKind),
        contentType
      };
      setCachedMediaResolve(original, payload);
      return payload;
    }

    const text = await response.text();
    const candidates = extractMediaUrlsFromHtml(text, finalUrl);
    const url = candidates[0] || finalUrl;
    const kind = inferMediaKind(url);
    const payload = {
      originalUrl: original,
      url,
      resolved: url !== original,
      kind,
      format: mediaFormatLabel(kind),
      contentType,
      candidates: candidates.slice(0, 6)
    };
    setCachedMediaResolve(original, payload);
    return payload;
  } catch (error) {
    clearTimeout(timeout);
    const payload = {
      originalUrl: original,
      url: original,
      resolved: false,
      kind: directKind,
      format: mediaFormatLabel(directKind),
      contentType: '',
      error: error?.name === 'AbortError' ? 'resolve-timeout' : 'resolve-failed'
    };
    setCachedMediaResolve(original, payload);
    return payload;
  }
}

function isLikelyM3u8Response(response, targetUrl) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || contentType.includes('vnd.apple.mpegurl')) {
    return true;
  }
  return /\.m3u8(?:$|[?#])/i.test(targetUrl.pathname + targetUrl.search);
}

function isLikelyMpdResponse(response, targetUrl) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('dash+xml') || contentType.includes('mpeg-dash')) return true;
  return /\.mpd(?:$|[?#])/i.test(targetUrl.pathname + targetUrl.search);
}

function mediaProxyHeaders(response, overrides = {}) {
  const headers = {};
  response.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'content-security-policy'
      || normalizedKey === 'content-security-policy-report-only'
      || normalizedKey === 'x-frame-options'
      || normalizedKey === 'transfer-encoding'
      || normalizedKey === 'content-encoding'
    ) {
      return;
    }
    headers[key] = value;
  });
  return {
    ...headers,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, origin, accept, content-type',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type',
    'cache-control': headers['cache-control'] || 'public, max-age=60',
    ...overrides
  };
}

function proxiedManifestUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return rawUrl;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    const proxyUrl = new URL('/media', `http://127.0.0.1:${mediaProxyPort}`);
    proxyUrl.searchParams.set('token', MEDIA_PROXY_TOKEN);
    proxyUrl.searchParams.set('url', resolved.toString());
    return proxyUrl.toString();
  } catch {
    return rawUrl;
  }
}

function rewriteM3u8AttributeUris(line, baseUrl) {
  return line.replace(/URI=(?:"([^"]+)"|([^,\s]+))/gi, (_match, quotedUri, bareUri) => {
    const cleanUri = String(quotedUri || bareUri || '').replace(/^['"]|['"]$/g, '');
    return `URI="${proxiedManifestUrl(cleanUri, baseUrl)}"`;
  });
}

function rewriteM3u8Manifest(text, baseUrl) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) return rewriteM3u8AttributeUris(line, baseUrl);
      return proxiedManifestUrl(trimmed, baseUrl);
    })
    .join('\n');
}

function escapeXmlText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function encodeDashTemplateUrl(value) {
  return encodeURIComponent(String(value || ''))
    .replace(/%24(RepresentationID|Number|Bandwidth|Time)(%25[0-9]+d)?%24/g, (_match, name, format = '') => {
      return `$${name}${format ? decodeURIComponent(format) : ''}$`;
    });
}

function proxiedDashManifestUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return rawUrl;
  try {
    const resolved = new URL(rawUrl, baseUrl).toString();
    return `http://127.0.0.1:${mediaProxyPort}/media?token=${encodeURIComponent(MEDIA_PROXY_TOKEN)}&url=${encodeDashTemplateUrl(resolved)}`;
  } catch {
    return rawUrl;
  }
}

function rewriteMpdManifest(text, baseUrl) {
  return String(text || '')
    .replace(/(<BaseURL\b[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi, (match, openTag, value, closeTag) => {
      const rawValue = String(value || '').trim();
      if (!rawValue) return match;
      return `${openTag}${escapeXmlText(proxiedDashManifestUrl(rawValue, baseUrl))}${closeTag}`;
    })
    .replace(/\b(media|initialization|sourceURL|index)="([^"]+)"/gi, (match, name, value) => {
      if (!value || value.startsWith('data:') || value.startsWith('blob:')) return match;
      return `${name}="${escapeXmlAttribute(proxiedDashManifestUrl(value, baseUrl))}"`;
    })
    .replace(/\b(media|initialization|sourceURL|index)='([^']+)'/gi, (match, name, value) => {
      if (!value || value.startsWith('data:') || value.startsWith('blob:')) return match;
      return `${name}='${escapeXmlAttribute(proxiedDashManifestUrl(value, baseUrl))}'`;
    });
}

async function proxyMediaRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'range, origin, accept, content-type'
    });
    res.end();
    return;
  }

  if (requestUrl.pathname !== '/media' || requestUrl.searchParams.get('token') !== MEDIA_PROXY_TOKEN) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const targetUrl = normalizeMediaTargetUrl(requestUrl.searchParams.get('url'));
  if (!targetUrl) {
    res.writeHead(400, { 'access-control-allow-origin': '*' });
    res.end('Invalid media url');
    return;
  }

  await applyProxySetting().catch(() => {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_PROXY_TIMEOUT_MS);

  try {
    const upstreamHeaders = {
      accept: req.headers.accept || '*/*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CineFlow/1.0',
      referer: `${targetUrl.origin}/`
    };
    if (req.headers.range) upstreamHeaders.range = req.headers.range;

    const upstream = await session.defaultSession.fetch(targetUrl.toString(), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);

    const finalUrl = upstream.url || targetUrl.toString();
    if (req.method !== 'HEAD' && isLikelyM3u8Response(upstream, new URL(finalUrl))) {
      const manifest = rewriteM3u8Manifest(await upstream.text(), finalUrl);
      const body = Buffer.from(manifest, 'utf8');
      res.writeHead(upstream.status, mediaProxyHeaders(upstream, {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'content-length': String(body.length)
      }));
      res.end(body);
      return;
    }

    if (req.method !== 'HEAD' && isLikelyMpdResponse(upstream, new URL(finalUrl))) {
      const manifest = rewriteMpdManifest(await upstream.text(), finalUrl);
      const body = Buffer.from(manifest, 'utf8');
      res.writeHead(upstream.status, mediaProxyHeaders(upstream, {
        'content-type': 'application/dash+xml; charset=utf-8',
        'content-length': String(body.length)
      }));
      res.end(body);
      return;
    }

    res.writeHead(upstream.status, mediaProxyHeaders(upstream));
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => {
      if (!res.destroyed) res.destroy();
    });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.writeHead(error?.name === 'AbortError' ? 504 : 502, {
        'access-control-allow-origin': '*',
        'content-type': 'text/plain; charset=utf-8'
      });
    }
    res.end(error?.name === 'AbortError' ? 'Media proxy timeout' : 'Media proxy failed');
  }
}

function startMediaProxyServer() {
  if (mediaProxyPort) return Promise.resolve(mediaProxyPort);
  if (mediaProxyStarting) return mediaProxyStarting;

  mediaProxyStarting = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      proxyMediaRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, {
            'access-control-allow-origin': '*',
            'content-type': 'text/plain; charset=utf-8'
          });
        }
        res.end(error?.message || 'Media proxy error');
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      mediaProxyServer = server;
      mediaProxyPort = server.address().port;
      resolve(mediaProxyPort);
    });
  }).finally(() => {
    mediaProxyStarting = null;
  });

  return mediaProxyStarting;
}

function normalizeResourceTitle(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\[[^\]]*?(解说|预告|花絮|短评)[^\]]*?\]/g, '')
    .replace(/【[^】]*?(解说|预告|花絮|短评)[^】]*?】/g, '')
    .replace(/\([^)]*?(解说|预告|花絮|短评|原声版|普通话|国语|粤语|英语|中字|字幕)[^)]*?\)/g, '')
    .replace(/（[^）]*?(解说|预告|花絮|短评|原声版|普通话|国语|粤语|英语|中字|字幕)[^）]*?）/g, '')
    .replace(/第[一二三四五六七八九十0-9]+季/g, '')
    .replace(/[\s·・:：,，.。!！?？'"“”‘’《》〈〉\-—_/\\|]+/g, '')
    .trim();
}

function releaseYearOf(payload = {}) {
  return String(payload.year || payload.releaseYear || payload.releaseDate || '')
    .match(/\d{4}/)?.[0] || '';
}

function resourceCandidateScore(item, titles, releaseYear) {
  const rawName = String(item?.vod_name || item?.name || '');
  const name = normalizeResourceTitle(rawName);
  if (!name) return -999;

  let best = -999;
  for (const title of titles) {
    const target = normalizeResourceTitle(title);
    if (!target) continue;
    let score = -999;
    if (name === target) {
      score = 110;
    } else if (name.startsWith(target)) {
      const suffix = name.slice(target.length);
      score = /^(19|20)\d{2}$/.test(suffix)
        ? 70
        : /^[0-9一二三四五六七八九十]/.test(suffix) && !/[0-9一二三四五六七八九十]$/.test(target)
          ? 22
          : 72 - Math.min(18, suffix.length * 2);
    } else if (target.startsWith(name) && target.length - name.length <= 4) {
      score = 58;
    } else if (name.includes(target) && target.length >= 4) {
      score = 52 - Math.min(12, name.length - target.length);
    }
    best = Math.max(best, score);
  }

  const haystack = `${rawName} ${item?.type_name || ''} ${item?.vod_remarks || ''}`;
  if (/(解说|预告|花絮|短评)/i.test(haystack)) best -= 80;
  if (/(体育|NBA|CBA|WTA|世界杯|比赛)/i.test(haystack)) best -= 36;
  const itemYear = String(item?.vod_year || item?.year || '').match(/\d{4}/)?.[0] || '';
  if (releaseYear && itemYear) best += itemYear === releaseYear ? 12 : -8;
  return best;
}

function uniqueResourceQueries(payload = {}) {
  const values = [
    payload.title,
    payload.originalTitle,
    String(payload.title || '').replace(/[：:].*$/, ''),
    String(payload.title || '').replace(/[（(].*?[）)]/g, '')
  ];
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function parsePlayGroups(item = {}) {
  const fromGroups = String(item.vod_play_from || item.play_from || '默认线路').split('$$$');
  const urlGroups = String(item.vod_play_url || item.play_url || '').split('$$$');
  return urlGroups
    .map((group, index) => {
      const episodes = String(group || '')
        .split('#')
        .map((segment, episodeIndex) => {
          const clean = segment.trim();
          if (!clean) return null;
          const dollarIndex = clean.lastIndexOf('$');
          const label = dollarIndex > 0 ? clean.slice(0, dollarIndex) : `播放 ${episodeIndex + 1}`;
          const url = dollarIndex > 0 ? clean.slice(dollarIndex + 1) : clean;
          if (!/^https?:\/\//i.test(url)) return null;
          const meta = playbackMetaForUrl(url, fromGroups[index] || fromGroups[0] || '');
          return {
            label: label.trim() || `播放 ${episodeIndex + 1}`,
            url,
            kind: meta.kind,
            format: meta.format,
            needsResolve: meta.needsResolve
          };
        })
        .filter(Boolean)
        .slice(0, 240);
      if (!episodes.length) return null;
      return {
        name: (fromGroups[index] || fromGroups[0] || `线路 ${index + 1}`).trim() || `线路 ${index + 1}`,
        episodes
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function compactResourceItem(source, item, payload) {
  const groups = parsePlayGroups(item);
  if (!groups.length) return null;
  const first = groups[0]?.episodes?.[0];
  const seasonEpisodeCount = groups.reduce((max, group) => Math.max(max, group.episodes.length), 0);
  const formats = Array.from(new Set(groups.flatMap((group) => group.episodes.map((episode) => episode.format).filter(Boolean)))).slice(0, 5);
  return {
    sourceKey: source.key,
    sourceName: source.name,
    title: String(item.vod_name || payload.title || '未命名资源'),
    year: String(item.vod_year || ''),
    type: String(item.type_name || ''),
    remarks: String(item.vod_remarks || item.vod_pubdate || ''),
    updatedAt: String(item.vod_time || item.vod_time_add || ''),
    poster: /^https?:\/\//i.test(String(item.vod_pic || '')) ? String(item.vod_pic) : '',
    firstUrl: first?.url || '',
    firstLabel: first?.label || '播放',
    formats,
    isSeries: seasonEpisodeCount > 1,
    seasonEpisodeCount,
    playGroupCount: groups.length,
    episodeCount: groups.reduce((total, group) => total + group.episodes.length, 0),
    lines: groups.map((group) => ({
      name: group.name,
      episodes: group.episodes
    }))
  };
}

async function hydrateResourceDetail(source, item) {
  if (parsePlayGroups(item).length || !item?.vod_id) return item;
  for (const ac of ['detail', 'videolist']) {
    try {
      const detail = await resourceFetchJson(source, { ac, ids: item.vod_id });
      const detailItem = Array.isArray(detail.list) ? detail.list[0] : null;
      if (detailItem) return { ...item, ...detailItem };
    } catch {
      // Ignore detail fallback failures and continue with the search item.
    }
  }
  return item;
}

async function searchResourceSource(source, payload = {}) {
  const titles = uniqueResourceQueries(payload);
  const releaseYear = releaseYearOf(payload);
  for (const query of titles) {
    try {
      const data = await resourceFetchJson(source, { ac: 'videolist', wd: query });
      const list = Array.isArray(data.list) ? data.list : [];
      const candidates = list
        .map((item) => ({ item, score: resourceCandidateScore(item, titles, releaseYear) }))
        .filter((entry) => entry.score >= 44)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      for (const { item } of candidates) {
        const hydrated = await hydrateResourceDetail(source, item);
        const compact = compactResourceItem(source, hydrated, payload);
        if (compact) return compact;
      }
    } catch {
      // Resource sources are optional and unstable; failed sources are skipped.
    }
  }
  return null;
}

async function findMovieResources(payload = {}, options = {}) {
  const settings = publicResourceSettings();
  const allSources = selectResourceSources(settings.mode);
  if (!settings.enabled || !allSources.length) {
    return { ...settings, checked: 0, total: 0, nextCursor: 0, done: true, resources: [] };
  }

  const cursor = Math.max(0, Number(options.cursor || 0));
  const limit = Math.min(4, Math.max(1, Number(options.limit || 2)));
  const batch = allSources.slice(cursor, cursor + limit);
  const settled = await Promise.allSettled(batch.map((source) => searchResourceSource(source, payload)));
  const resources = settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
  const nextCursor = Math.min(allSources.length, cursor + batch.length);
  return {
    ...settings,
    checked: nextCursor,
    total: allSources.length,
    nextCursor,
    done: nextCursor >= allSources.length,
    resources
  };
}

const MOVIE_TO_TV_GENRE_MAP = {
  12: [10759],
  14: [10765],
  16: [16],
  18: [18],
  27: [],
  28: [10759],
  35: [35],
  36: [],
  37: [37],
  53: [9648, 10759],
  80: [80],
  99: [99],
  878: [10765],
  9648: [9648],
  10402: [],
  10749: [18],
  10751: [10751],
  10752: [10768],
  10770: []
};

function normalizeTmdbMediaType(value, fallback = 'movie') {
  const type = String(value || fallback || 'movie').toLowerCase();
  return type === 'tv' ? 'tv' : 'movie';
}

function tmdbItemMediaType(item, fallback = 'movie') {
  if (item?.media_type && !['movie', 'tv'].includes(String(item.media_type).toLowerCase())) return '';
  return normalizeTmdbMediaType(item?.media_type || fallback);
}

function mapMovieGenreIdsToTv(value) {
  const ids = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[|,]/)
      .map((id) => Number(id))
      .filter(Boolean);
  const mapped = ids.flatMap((id) => MOVIE_TO_TV_GENRE_MAP[id] || [id]).filter(Boolean);
  return [...new Set(mapped)];
}

function mapGenreParamToTv(value) {
  if (!value) return undefined;
  const separator = String(value).includes('|') ? '|' : ',';
  const mapped = String(value)
    .split(/[|,]/)
    .map((id) => Number(id))
    .filter(Boolean)
    .flatMap((id) => MOVIE_TO_TV_GENRE_MAP[id] || [id])
    .filter(Boolean);
  return [...new Set(mapped)].join(separator) || undefined;
}

function compactMovie(movie, fallbackMediaType = 'movie') {
  if (!movie || !movie.id) return null;
  const mediaType = tmdbItemMediaType(movie, fallbackMediaType);
  if (!mediaType) return null;
  return {
    id: movie.id,
    mediaType,
    title: movie.title || movie.name || (mediaType === 'tv' ? '未命名节目' : '未命名电影'),
    originalTitle: movie.original_title || movie.original_name || '',
    overview: movie.overview || '',
    posterPath: movie.poster_path || null,
    backdropPath: movie.backdrop_path || null,
    voteAverage: Number(movie.vote_average || 0),
    voteCount: Number(movie.vote_count || 0),
    releaseDate: movie.release_date || movie.first_air_date || '',
    genreIds: Array.isArray(movie.genre_ids) ? movie.genre_ids : [],
    popularity: Number(movie.popularity || 0),
    adult: Boolean(movie.adult)
  };
}

function compactMovies(results = [], limit = 18, fallbackMediaType = 'movie') {
  const seen = new Set();
  return results
    .map((item) => compactMovie(item, fallbackMediaType))
    .filter(Boolean)
    .filter((movie) => {
      const key = `${movie.mediaType || 'movie'}:${movie.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((movie) => !movie.adult)
    .slice(0, limit);
}

async function getGenres() {
  const [movieResult, tvResult] = await Promise.all([
    settle(tmdbFetch('/genre/movie/list')),
    settle(tmdbFetch('/genre/tv/list'))
  ]);
  const byId = new Map();
  for (const genre of movieResult.status === 'fulfilled' && Array.isArray(movieResult.value.genres) ? movieResult.value.genres : []) {
    byId.set(genre.id, genre);
  }
  for (const genre of tvResult.status === 'fulfilled' && Array.isArray(tvResult.value.genres) ? tvResult.value.genres : []) {
    if (!byId.has(genre.id)) byId.set(genre.id, genre);
  }
  return [...byId.values()];
}

async function getTrending(limit = 20) {
  const data = await tmdbFetch('/trending/all/day', { page: 1 });
  return compactMovies(data.results, limit);
}

async function getPopular(limit = 20) {
  const [movieResult, tvResult] = await Promise.all([
    settle(tmdbFetch('/movie/popular', { page: 1, region: DEFAULT_REGION })),
    settle(tmdbFetch('/tv/popular', { page: 1 }))
  ]);
  return compactMovies([
    ...(movieResult.status === 'fulfilled' ? (movieResult.value.results || []) : []),
    ...(tvResult.status === 'fulfilled' ? (tvResult.value.results || []).map((item) => ({ ...item, media_type: 'tv' })) : [])
  ], limit);
}

function selectDailyMovie(movies) {
  if (!movies.length) return null;
  const now = new Date();
  const utcDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayNumber = Math.floor(utcDate / 86400000);
  return movies[dayNumber % movies.length];
}

async function getInitialData() {
  const [trendingResult, genresResult, popularResult] = await Promise.all([
    withSoftTimeout(settle(getTrending(20)), INITIAL_SOFT_TIMEOUT_MS, { status: 'timeout' }),
    withSoftTimeout(settle(getGenres()), INITIAL_SOFT_TIMEOUT_MS, { status: 'timeout' }),
    withSoftTimeout(settle(getPopular(20)), INITIAL_SOFT_TIMEOUT_MS, { status: 'timeout' })
  ]);
  const results = [genresResult, trendingResult, popularResult];
  if (trendingResult.status === 'rejected' && popularResult.status === 'rejected') throw trendingResult.reason;

  const genres = genresResult.status === 'fulfilled' ? genresResult.value : [];
  const trending = trendingResult.status === 'fulfilled' ? trendingResult.value : [];
  const popular = popularResult.status === 'fulfilled' ? popularResult.value : [];

  return {
    credential: publicCredentialState(),
    genres,
    daily: selectDailyMovie(trending.length ? trending : popular),
    trending,
    popular
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#00000000',
    frame: false,
    transparent: true,
    show: false,
    title: 'CineFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    applyWindowShape('normal');
    mainWindow.show();
  });

  mainWindow.on('resize', () => applyWindowShape(windowMode));
  mainWindow.on('maximize', () => applyWindowShape(windowMode));
  mainWindow.on('unmaximize', () => applyWindowShape(windowMode));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  startMediaProxyServer().catch(() => {});
  createWindow();
  applyProxySetting({ force: true }).catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (mediaProxyServer) {
    mediaProxyServer.close();
    mediaProxyServer = null;
    mediaProxyPort = 0;
  }
});

ipcMain.handle('app:getCredentialState', () => publicCredentialState());

ipcMain.handle('app:saveCredential', (_event, credential) => {
  const normalized = normalizeCredential(credential);
  if (!normalized) {
    const error = new Error('请输入有效的 TMDB API Key 或 Read Access Token。');
    error.code = 'INVALID_CREDENTIAL';
    throw error;
  }
  const settings = readSettings();
  settings.tmdbCredential = normalized.value;
  writeSettings(settings);
  clearTmdbCaches();
  return publicCredentialState();
});

ipcMain.handle('app:clearCredential', () => {
  const settings = readSettings();
  delete settings.tmdbCredential;
  writeSettings(settings);
  clearTmdbCaches();
  return publicCredentialState();
});


ipcMain.handle('app:saveProxy', async (_event, proxy) => {
  const settings = readSettings();
  const normalized = normalizeProxy(proxy);
  settings.proxy = normalized || 'system';
  writeSettings(settings);
  await applyProxySetting({ force: true });
  clearTmdbCaches();
  return publicCredentialState();
});

ipcMain.handle('app:getResourceSettings', () => publicResourceSettings());

ipcMain.handle('app:saveResourceMode', (_event, mode) => {
  const settings = readSettings();
  settings.resourceMode = normalizeResourceMode(mode);
  writeSettings(settings);
  resourceResponseCache.clear();
  return publicResourceSettings();
});

ipcMain.handle('app:testConnection', async () => {
  const proxy = await applyProxySetting({ force: true });
  const resolvedProxy = await session.defaultSession.resolveProxy('https://api.themoviedb.org/3/configuration')
    .catch(() => 'UNKNOWN');
  const startedAt = Date.now();
  const data = await tmdbFetch('/configuration');
  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    proxy,
    resolvedProxy,
    imagesBaseUrl: data?.images?.secure_base_url || ''
  };
});

ipcMain.handle('tmdb:initial', async () => getInitialData());

ipcMain.handle('tmdb:search', async (_event, query, options = {}) => {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];
  const page = Number(options.page || 1);
  const enrich = options.enrich !== false && page === 1;
  const moviePromise = tmdbFetch('/search/movie', {
    query: cleanQuery,
    include_adult: false,
    page,
    region: DEFAULT_REGION
  });
  const tvPromise = tmdbFetch('/search/tv', {
    query: cleanQuery,
    include_adult: false,
    page
  });
  if (!enrich) {
    const [movieResult, tvResult] = await Promise.all([settle(moviePromise), settle(tvPromise)]);
    if (movieResult.status === 'rejected' && tvResult.status === 'rejected') throw movieResult.reason;
    return compactMovies([
      ...(movieResult.status === 'fulfilled' ? (movieResult.value.results || []) : []),
      ...(tvResult.status === 'fulfilled' ? (tvResult.value.results || []).map((item) => ({ ...item, media_type: 'tv' })) : [])
    ], 24);
  }
  const personPromise = tmdbFetch('/search/person', {
    query: cleanQuery,
    include_adult: false,
    page: 1
  });
  const keywordPromise = tmdbFetch('/search/keyword', {
    query: cleanQuery,
    page: 1
  });
  const [movieResult, tvResult, personResult, keywordResult] = await Promise.all([
    settle(moviePromise),
    settle(tvPromise),
    withSoftTimeout(settle(personPromise), SEARCH_ENRICH_TIMEOUT_MS, { status: 'timeout' }),
    withSoftTimeout(settle(keywordPromise), SEARCH_ENRICH_TIMEOUT_MS, { status: 'timeout' })
  ]);
  if (![movieResult, tvResult, personResult, keywordResult].some((result) => result.status === 'fulfilled')) {
    throw movieResult.reason || tvResult.reason;
  }

  const personMovies = [];
  if (personResult.status === 'fulfilled') {
    const people = (personResult.value.results || []).slice(0, 2);
    const creditResults = await withSoftTimeout(
      Promise.allSettled(people.map((person) => tmdbFetch(`/person/${person.id}/combined_credits`))),
      SEARCH_ENRICH_TIMEOUT_MS,
      []
    );
    for (const result of creditResults) {
      if (result.status !== 'fulfilled') continue;
      const credits = [
        ...(result.value.cast || []),
        ...(result.value.crew || [])
      ].sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));
      personMovies.push(...credits.slice(0, 10));
    }
  }

  const keywordMovies = [];
  if (keywordResult.status === 'fulfilled') {
    const keywordIds = (keywordResult.value.results || [])
      .slice(0, 3)
      .map((item) => item.id)
      .filter(Boolean);
    if (keywordIds.length) {
      const discover = await withSoftTimeout(
        tmdbFetch('/discover/movie', {
          with_keywords: keywordIds.join('|'),
          sort_by: 'popularity.desc',
          include_adult: false,
          page: 1,
          region: DEFAULT_REGION
        }).catch(() => null),
        SEARCH_ENRICH_TIMEOUT_MS,
        null
      );
      keywordMovies.push(...(discover?.results || []));
      const tvDiscover = await withSoftTimeout(
        tmdbFetch('/discover/tv', {
          with_keywords: keywordIds.join('|'),
          sort_by: 'popularity.desc',
          include_adult: false,
          page: 1
        }).catch(() => null),
        SEARCH_ENRICH_TIMEOUT_MS,
        null
      );
      keywordMovies.push(...((tvDiscover?.results || []).map((item) => ({ ...item, media_type: 'tv' }))));
    }
  }

  return compactMovies([
    ...(movieResult.status === 'fulfilled' ? (movieResult.value.results || []) : []),
    ...(tvResult.status === 'fulfilled' ? (tvResult.value.results || []).map((item) => ({ ...item, media_type: 'tv' })) : []),
    ...personMovies,
    ...keywordMovies
  ], 24);
});

ipcMain.handle('tmdb:discover', async (_event, options = {}) => {
  const genreSeparator = String(options.genreMode || 'and').toLowerCase() === 'or' ? '|' : ',';
  const genreValue = Array.isArray(options.genreIds)
    ? options.genreIds.join(genreSeparator)
    : (options.genreId || options.genreIds || undefined);
  const mediaType = String(options.mediaType || 'all').toLowerCase();
  const movieParams = {
    sort_by: options.sortBy || 'popularity.desc',
    with_genres: genreValue,
    without_genres: options.withoutGenreIds || undefined,
    'vote_count.gte': options.minVotes || 80,
    'vote_average.gte': options.minRating || undefined,
    include_adult: false,
    page: options.page || 1,
    region: DEFAULT_REGION
  };
  const tvParams = {
    sort_by: options.sortBy || 'popularity.desc',
    with_genres: mapGenreParamToTv(genreValue),
    without_genres: mapGenreParamToTv(options.withoutGenreIds),
    'vote_count.gte': options.minVotes || 80,
    'vote_average.gte': options.minRating || undefined,
    include_adult: false,
    page: options.page || 1
  };
  const tasks = [];
  if (mediaType !== 'tv') tasks.push({ mediaType: 'movie', promise: settle(tmdbFetch('/discover/movie', movieParams)) });
  if (mediaType !== 'movie' && (!genreValue || tvParams.with_genres)) tasks.push({ mediaType: 'tv', promise: settle(tmdbFetch('/discover/tv', tvParams)) });
  const results = await Promise.all(tasks.map((task) => task.promise));
  if (results.length && results.every((result) => result.status === 'rejected')) throw results[0].reason;
  const merged = results.flatMap((result, index) => {
    if (result.status !== 'fulfilled') return [];
    const sourceMediaType = tasks[index]?.mediaType || 'movie';
    return (result.value.results || []).map((item) => ({ ...item, media_type: item.media_type || sourceMediaType }));
  });
  return compactMovies(merged, 24);
});

ipcMain.handle('tmdb:recommendByMovie', async (_event, movieId, options = {}) => {
  const id = Number(movieId);
  if (!id) return [];
  const mediaType = normalizeTmdbMediaType(options.mediaType);
  const data = await tmdbFetch(`/${mediaType}/${id}/recommendations`, { page: options.page || 1 });
  return compactMovies(data.results, 20, mediaType);
});

ipcMain.handle('tmdb:details', async (_event, movieId, options = {}) => {
  const id = Number(movieId);
  if (!id) {
    const error = new Error('Invalid TMDB id.');
    error.code = 'INVALID_MOVIE_ID';
    throw error;
  }
  const mediaType = normalizeTmdbMediaType(options.mediaType);
  const data = await tmdbFetch(`/${mediaType}/${id}`, {
    append_to_response: mediaType === 'tv'
      ? 'credits,aggregate_credits,recommendations,similar,videos'
      : 'credits,recommendations,similar,videos'
  });
  const tvRuntime = Array.isArray(data.episode_run_time) ? Number(data.episode_run_time[0] || 0) : 0;
  return {
    id: data.id,
    mediaType,
    title: data.title || data.name || (mediaType === 'tv' ? '未命名节目' : '未命名电影'),
    originalTitle: data.original_title || data.original_name || '',
    tagline: data.tagline || '',
    overview: data.overview || '',
    posterPath: data.poster_path || null,
    backdropPath: data.backdrop_path || null,
    releaseDate: data.release_date || data.first_air_date || '',
    runtime: data.runtime || tvRuntime || 0,
    numberOfSeasons: Number(data.number_of_seasons || 0),
    numberOfEpisodes: Number(data.number_of_episodes || 0),
    voteAverage: Number(data.vote_average || 0),
    voteCount: Number(data.vote_count || 0),
    popularity: Number(data.popularity || 0),
    status: data.status || '',
    homepage: data.homepage || '',
    genres: Array.isArray(data.genres) ? data.genres : [],
    productionCountries: Array.isArray(data.production_countries) ? data.production_countries : [],
    spokenLanguages: Array.isArray(data.spoken_languages) ? data.spoken_languages : [],
    cast: compactCast(mediaType === 'tv' ? (data.aggregate_credits?.cast || data.credits?.cast) : data.credits?.cast),
    crew: compactCrew(mediaType === 'tv' ? (data.aggregate_credits?.crew || data.credits?.crew) : data.credits?.crew),
    recommendations: compactMovies(data.recommendations?.results, 10, mediaType),
    similar: compactMovies(data.similar?.results, 10, mediaType),
    videos: compactVideos(data.videos?.results)
  };
});

ipcMain.handle('resources:findMovie', async (_event, payload = {}, options = {}) => findMovieResources(payload, options));

ipcMain.handle('player:getMediaProxyUrl', async (_event, url) => {
  const target = normalizeMediaTargetUrl(url);
  if (!target) {
    const error = new Error('Invalid media url.');
    error.code = 'INVALID_MEDIA_URL';
    throw error;
  }
  await startMediaProxyServer();
  return getMediaProxyUrl(target.toString());
});

ipcMain.handle('player:resolveMediaUrl', async (_event, url) => resolveMediaUrl(url));

ipcMain.handle('window:minimize', () => enterIslandMode());
ipcMain.handle('window:enterIsland', (_event, height) => enterIslandMode(Number(height) || 72));
ipcMain.handle('window:expandIsland', (_event, height) => expandIslandMode(Number(height) || 320));
ipcMain.handle('window:restoreNormal', () => restoreNormalMode());
ipcMain.on('window:islandDragBegin', (_event, payload) => beginIslandDragMode(payload));
ipcMain.on('window:islandDragMove', (_event, payload) => moveIslandDragMode(payload));
ipcMain.handle('window:islandDragEnd', (_event, shouldDock = true, payload = {}) => endIslandDragMode(shouldDock, payload));
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return false;
  if (windowMode !== 'normal') restoreNormalMode();
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('shell:openExternal', (_event, url) => {
  const target = String(url || '');
  if (/^https?:\/\//i.test(target)) shell.openExternal(target);
});

function compactCast(cast = []) {
  return cast
    .filter((person) => person && person.name)
    .slice(0, 8)
    .map((person) => ({
      id: person.id,
      name: person.name,
      character: person.character || person.roles?.[0]?.character || '',
      profilePath: person.profile_path || null
    }));
}

function compactCrew(crew = []) {
  const wantedJobs = new Set(['Director', 'Writer', 'Screenplay', 'Creator', 'Executive Producer']);
  return crew
    .filter((person) => person && person.name && (wantedJobs.has(person.job) || person.jobs?.some((job) => wantedJobs.has(job.job))))
    .slice(0, 6)
    .map((person) => ({
      id: person.id,
      name: person.name,
      job: person.job || person.jobs?.[0]?.job || ''
    }));
}

function compactVideos(videos = []) {
  return videos
    .filter((video) => video.site === 'YouTube' && video.key)
    .slice(0, 4)
    .map((video) => ({
      id: video.id,
      key: video.key,
      name: video.name,
      type: video.type
    }));
}


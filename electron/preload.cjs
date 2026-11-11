const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cineflow', {
  getCredentialState: () => ipcRenderer.invoke('app:getCredentialState'),
  saveCredential: (credential) => ipcRenderer.invoke('app:saveCredential', credential),
  clearCredential: () => ipcRenderer.invoke('app:clearCredential'),
  saveProxy: (proxy) => ipcRenderer.invoke('app:saveProxy', proxy),
  getResourceSettings: () => ipcRenderer.invoke('app:getResourceSettings'),
  saveResourceMode: (mode) => ipcRenderer.invoke('app:saveResourceMode', mode),
  saveResourcePlaybackMode: (mode) => ipcRenderer.invoke('app:saveResourcePlaybackMode', mode),
  importResourceSources: (payload) => ipcRenderer.invoke('app:importResourceSources', payload),
  clearResourceSources: () => ipcRenderer.invoke('app:clearResourceSources'),
  testConnection: () => ipcRenderer.invoke('app:testConnection'),
  getInitialData: () => ipcRenderer.invoke('tmdb:initial'),
  searchMovies: (query, options) => ipcRenderer.invoke('tmdb:search', query, options),
  discoverMovies: (options) => ipcRenderer.invoke('tmdb:discover', options),
  recommendByMovie: (movieId, options) => ipcRenderer.invoke('tmdb:recommendByMovie', movieId, options),
  getMovieDetails: (movieId, options) => ipcRenderer.invoke('tmdb:details', movieId, options),
  // v3.4.2：换到 resources:findMovieFiltered —— 基线 resources:findMovie 一字未改，
  // 新 handler 内部照样调它，只在返回值外面套一层媒体类型过滤。
  findMovieResources: (payload, options) => ipcRenderer.invoke('resources:findMovieFiltered', payload, options),
  resolveMediaUrl: (url) => ipcRenderer.invoke('player:resolveMediaUrl', url),
  getMediaProxyUrl: (url) => ipcRenderer.invoke('player:getMediaProxyUrl', url),
  getPlaybackProxyMode: () => ipcRenderer.invoke('player:getPlaybackProxyMode'),
  savePlaybackProxyMode: (mode) => ipcRenderer.invoke('player:setPlaybackProxyMode', mode),
  getMetadataStatus: () => ipcRenderer.invoke('meta:getStatus'),
  onPlaybackProxyState: (callback) => {
    ipcRenderer.on('playback:proxy-state', (_event, payload) => callback?.(payload));
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  enterIsland: (height) => ipcRenderer.invoke('window:enterIsland', height),
  expandIsland: (height) => ipcRenderer.invoke('window:expandIsland', height),
  restoreNormal: () => ipcRenderer.invoke('window:restoreNormal'),
  dockIsland: (edge) => ipcRenderer.invoke('window:dockIsland', edge),
  islandDragBegin: (payload) => ipcRenderer.send('window:islandDragBegin', payload),
  islandDragMove: (payload) => ipcRenderer.send('window:islandDragMove', payload),
  islandDragEnd: (shouldDock = true, payload) => ipcRenderer.invoke('window:islandDragEnd', shouldDock, payload),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onWindowMode: (callback) => {
    ipcRenderer.on('window:mode', (_event, payload) => callback?.(payload));
  },
  // v3.4.0 投屏（纯增量新增 API，全部走 cast:* 通道）
  castScan: () => ipcRenderer.invoke('cast:scan'),
  castList: () => ipcRenderer.invoke('cast:list'),
  castStopSearch: () => ipcRenderer.invoke('cast:stop-search'),
  castRefreshBluetooth: () => ipcRenderer.invoke('cast:refresh-bluetooth'),
  castOpenBluetoothSettings: () => ipcRenderer.invoke('cast:open-bluetooth-settings'),
  castTo: (payload) => ipcRenderer.invoke('cast:to', payload),
  castStop: (payload) => ipcRenderer.invoke('cast:stop', payload),
  onCastDevices: (callback) => {
    ipcRenderer.on('cast:devices', (_event, payload) => callback?.(payload));
  },
  // v3.4.0 海报兜底（纯增量）：直连失败时请主进程经 DoH 通道回传图片字节
  relayImage: (url) => ipcRenderer.invoke('image:relay', { url }),
  // v3.4.0 片源管理（纯增量）：单个播放源的手动测速
  testResourceSource: (payload) => ipcRenderer.invoke('resources:testSource', payload),
  // v3.4.1 TMDB 凭证向导（纯增量）：全部走 tmdbAuth:* 通道
  startTmdbAuth: () => ipcRenderer.invoke('tmdbAuth:start'),
  getTmdbAuthStatus: () => ipcRenderer.invoke('tmdbAuth:status'),
  cancelTmdbAuth: () => ipcRenderer.invoke('tmdbAuth:cancel'),
  takeTmdbCredentialFromClipboard: () => ipcRenderer.invoke('tmdbAuth:clipboard'),
  // v3.4.2 增补：先校验再落盘的那一版（上面那个原样保留，可随时切回）
  grabTmdbCredential: () => ipcRenderer.invoke('tmdbAuth:grab')
});

// v3.4.2 纯增量：播放首帧预热。单独再 expose 一个全局，不去动上面那个对象字面量。
// deepCount = 这条列表里允许做"深度预热"（清单+密钥+首分片）的条数，最贵，渲染端只给 1~2。
contextBridge.exposeInMainWorld('cineflowFast', {
  prewarmMedia: (urls, deepCount) => ipcRenderer.invoke('media:prewarm', {
    urls: Array.isArray(urls) ? urls.slice(0, 8) : [],
    deepCount: Number(deepCount) || 0
  })
});

// v3.4.2 纯增量：豆瓣元数据兜底。单独再 expose 一个全局，不动上面两个对象字面量。
contextBridge.exposeInMainWorld('cineflowDouban', {
  hot: (payload) => ipcRenderer.invoke('douban:hot', payload),
  suggest: (query) => ipcRenderer.invoke('douban:suggest', query),
  search: (payload) => ipcRenderer.invoke('douban:search', payload),
  subject: (payload) => ipcRenderer.invoke('douban:subject', payload),
  poster: (payload) => ipcRenderer.invoke('douban:poster', payload),
  image: (payload) => ipcRenderer.invoke('douban:image', payload)
});

// v3.4.3 纯增量：every.film 兜底。再单独 expose 一个全局，不动上面那几个对象字面量。
contextBridge.exposeInMainWorld('cineflowEveryfilm', {
  search: (payload) => ipcRenderer.invoke('everyfilm:search', payload),
  detail: (payload) => ipcRenderer.invoke('everyfilm:detail', payload),
  lookup: (payload) => ipcRenderer.invoke('everyfilm:lookup', payload),
  image: (payload) => ipcRenderer.invoke('everyfilm:image', payload)
});

// v3.4.3 第三十一轮纯增量：无凭证兜底摘要卡下面那一条可播线路（只读查询应用内置的如意资源）。
// 单独 expose 一个全局，不动上面那几个对象字面量；播放本身仍由基线的 #resourceResults 委托与播放器负责。
contextBridge.exposeInMainWorld('cineflowFallbackPlay', {
  playSource: (payload) => ipcRenderer.invoke('douban:playSource', payload)
});

// v3.4.4 纯增量：CF 图标上的更新检查 / 下载 / 一键安装。
// 再单独 expose 一个全局，不动上面那几个对象字面量；进度用事件回推，避免轮询。
contextBridge.exposeInMainWorld('cineflowUpdate', {
  check: (payload) => ipcRenderer.invoke('update:check', payload),
  download: (payload) => ipcRenderer.invoke('update:download', payload),
  install: (payload) => ipcRenderer.invoke('update:install', payload),
  reveal: (payload) => ipcRenderer.invoke('update:reveal', payload),
  onProgress: (callback) => {
    const listener = (_event, payload) => { try { callback?.(payload); } catch { /* 渲染层异常不影响主进程 */ } };
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  }
});

// v3.4.8 纯增量：搜索页片源中枢。再单独 expose 一个全局，不动上面任何既有对象字面量。
// start 立即返回（含逐源初始状态），逐源结果与终态全部走 cf:searchHub:progress 事件回推，
// 避免轮询。onProgress 返回退订函数，渲染层重建时先退订再订阅，防重复渲染。
contextBridge.exposeInMainWorld('cineflowSearchHub', {
  start: (payload) => ipcRenderer.invoke('cf:searchHub:start', payload),
  cancel: (payload) => ipcRenderer.invoke('cf:searchHub:cancel', payload),
  status: () => ipcRenderer.invoke('cf:searchHub:status'),
  // 海报中转：渲染层是 file:// origin，源站图床拒热链，必须由主进程取字节转 data URL
  image: (payload) => ipcRenderer.invoke('cf:searchHub:image', payload),
  onProgress: (callback) => {
    const listener = (_event, payload) => {
      try { callback?.(payload); } catch { /* 渲染层异常不影响主进程 */ }
    };
    ipcRenderer.on('cf:searchHub:progress', listener);
    return () => ipcRenderer.removeListener('cf:searchHub:progress', listener);
  }
});


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

  relayImage: (url) => ipcRenderer.invoke('image:relay', { url }),

  testResourceSource: (payload) => ipcRenderer.invoke('resources:testSource', payload),

  startTmdbAuth: () => ipcRenderer.invoke('tmdbAuth:start'),
  getTmdbAuthStatus: () => ipcRenderer.invoke('tmdbAuth:status'),
  cancelTmdbAuth: () => ipcRenderer.invoke('tmdbAuth:cancel'),
  takeTmdbCredentialFromClipboard: () => ipcRenderer.invoke('tmdbAuth:clipboard'),

  grabTmdbCredential: () => ipcRenderer.invoke('tmdbAuth:grab')
});

contextBridge.exposeInMainWorld('cineflowFast', {
  prewarmMedia: (urls, deepCount) => ipcRenderer.invoke('media:prewarm', {
    urls: Array.isArray(urls) ? urls.slice(0, 8) : [],
    deepCount: Number(deepCount) || 0
  })
});

contextBridge.exposeInMainWorld('cineflowDouban', {
  hot: (payload) => ipcRenderer.invoke('douban:hot', payload),
  suggest: (query) => ipcRenderer.invoke('douban:suggest', query),
  search: (payload) => ipcRenderer.invoke('douban:search', payload),
  subject: (payload) => ipcRenderer.invoke('douban:subject', payload),
  poster: (payload) => ipcRenderer.invoke('douban:poster', payload),
  image: (payload) => ipcRenderer.invoke('douban:image', payload)
});

contextBridge.exposeInMainWorld('cineflowEveryfilm', {
  search: (payload) => ipcRenderer.invoke('everyfilm:search', payload),
  detail: (payload) => ipcRenderer.invoke('everyfilm:detail', payload),
  lookup: (payload) => ipcRenderer.invoke('everyfilm:lookup', payload),
  image: (payload) => ipcRenderer.invoke('everyfilm:image', payload)
});

contextBridge.exposeInMainWorld('cineflowFallbackPlay', {
  playSource: (payload) => ipcRenderer.invoke('douban:playSource', payload)
});

contextBridge.exposeInMainWorld('cineflowUpdate', {
  check: (payload) => ipcRenderer.invoke('update:check', payload),
  download: (payload) => ipcRenderer.invoke('update:download', payload),
  install: (payload) => ipcRenderer.invoke('update:install', payload),
  reveal: (payload) => ipcRenderer.invoke('update:reveal', payload),
  onProgress: (callback) => {
    const listener = (_event, payload) => { try { callback?.(payload); } catch {  } };
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  }
});

contextBridge.exposeInMainWorld('cineflowSearchHub', {
  start: (payload) => ipcRenderer.invoke('cf:searchHub:start', payload),
  cancel: (payload) => ipcRenderer.invoke('cf:searchHub:cancel', payload),
  status: () => ipcRenderer.invoke('cf:searchHub:status'),

  image: (payload) => ipcRenderer.invoke('cf:searchHub:image', payload),
  onProgress: (callback) => {
    const listener = (_event, payload) => {
      try { callback?.(payload); } catch {  }
    };
    ipcRenderer.on('cf:searchHub:progress', listener);
    return () => ipcRenderer.removeListener('cf:searchHub:progress', listener);
  }
});

contextBridge.exposeInMainWorld('cineflowMovy', {
  list: () => ipcRenderer.invoke('cf:m2:movy-list'),
  sources: (payload) => ipcRenderer.invoke('cf:m2:movy-sources', payload || {}),
  probe: (payload) => ipcRenderer.invoke('cf:m2:movy-probe', payload || {}),

  warm: (payload) => ipcRenderer.invoke('cf:m2:movy-warm', payload || {}),
  onWarm: (callback) => {
    const listener = (_event, payload) => {
      try { callback?.(payload); } catch {  }
    };
    ipcRenderer.on('cf:m2:movy-warm:progress', listener);
    return () => ipcRenderer.removeListener('cf:m2:movy-warm:progress', listener);
  },

  mediaProxy: (url) => ipcRenderer.invoke('cf:m2:movy-proxy', { url }),

  subCues: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-cues', payload || {}),
  subTranslate: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-translate', payload || {}),
  subDiscover: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-discover', payload || {}),
  subPick: () => ipcRenderer.invoke('cf:m2:movy-sub-pick'),
  subParse: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-parse', payload || {}),
  subOnline: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-online', payload || {}),
  subOnlineLoad: (payload) => ipcRenderer.invoke('cf:m2:movy-sub-online-load', payload || {}),
  subStats: () => ipcRenderer.invoke('cf:m2:movy-sub-stats')
});

contextBridge.exposeInMainWorld('cineflowRemote', {
  list: () => ipcRenderer.invoke('cf:m2:remote-list'),
  save: (payload) => ipcRenderer.invoke('cf:m2:remote-save', payload || {}),
  remove: (id) => ipcRenderer.invoke('cf:m2:remote-remove', id),
  test: (payload) => ipcRenderer.invoke('cf:m2:remote-test', payload || {}),
  preview: (payload) => ipcRenderer.invoke('cf:m2:remote-preview', payload || {}),
  subtitle: (payload) => ipcRenderer.invoke('cf:m2:remote-subtitle', payload || {}),
  stats: () => ipcRenderer.invoke('cf:m2:remote-stats')
});

contextBridge.exposeInMainWorld('cineflowGpu', {
  get: () => ipcRenderer.invoke('cf:m2:gpu-get'),
  set: (payload) => ipcRenderer.invoke('cf:m2:gpu-set', payload || {})
});

contextBridge.exposeInMainWorld('cineflowLogos', {
  get: (payload) => ipcRenderer.invoke('cf:m2:logos', payload || {})
});


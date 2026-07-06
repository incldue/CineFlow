const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cineflow', {
  getCredentialState: () => ipcRenderer.invoke('app:getCredentialState'),
  saveCredential: (credential) => ipcRenderer.invoke('app:saveCredential', credential),
  clearCredential: () => ipcRenderer.invoke('app:clearCredential'),
  saveProxy: (proxy) => ipcRenderer.invoke('app:saveProxy', proxy),
  getResourceSettings: () => ipcRenderer.invoke('app:getResourceSettings'),
  saveResourceMode: (mode) => ipcRenderer.invoke('app:saveResourceMode', mode),
  testConnection: () => ipcRenderer.invoke('app:testConnection'),
  getInitialData: () => ipcRenderer.invoke('tmdb:initial'),
  searchMovies: (query, options) => ipcRenderer.invoke('tmdb:search', query, options),
  discoverMovies: (options) => ipcRenderer.invoke('tmdb:discover', options),
  recommendByMovie: (movieId, options) => ipcRenderer.invoke('tmdb:recommendByMovie', movieId, options),
  getMovieDetails: (movieId, options) => ipcRenderer.invoke('tmdb:details', movieId, options),
  findMovieResources: (payload, options) => ipcRenderer.invoke('resources:findMovie', payload, options),
  resolveMediaUrl: (url) => ipcRenderer.invoke('player:resolveMediaUrl', url),
  getMediaProxyUrl: (url) => ipcRenderer.invoke('player:getMediaProxyUrl', url),
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
  }
});

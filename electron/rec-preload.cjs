'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cineflowRec', {

  home: (opts) => ipcRenderer.invoke('rec:getHome', opts),

  similar: (itemId, opts) => ipcRenderer.invoke('rec:getSimilar', { itemId, ...(opts || {}) }),

  track: (events) => ipcRenderer.invoke('rec:track', { events }),

  upsert: (cards) => ipcRenderer.invoke('rec:upsert', { cards }),

  seed: (payload) => ipcRenderer.invoke('rec:seed', payload),
  status: () => ipcRenderer.invoke('rec:status'),
  rebuild: () => ipcRenderer.invoke('rec:rebuild'),

  setBrowseHint: (payload) => ipcRenderer.invoke('rec:browseHint', payload),
  doubanMeta: (payload) => ipcRenderer.invoke('rec:doubanMeta', payload),

  doubanRecentHot: (payload) => ipcRenderer.invoke('rec:doubanRecentHot', payload),
});

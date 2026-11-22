'use strict';

const telemetry = require('./telemetry.cjs');

const providers = new Map();

function registerProvider(provider) {
  if (!provider?.id || typeof provider.search !== 'function') return false;
  providers.set(String(provider.id), {
    id: String(provider.id),
    kind: String(provider.kind || 'vod'),
    description: String(provider.description || ''),
    capabilities: { search: true, ...provider.capabilities },
    search: provider.search,
    health: provider.health || (async () => ({ ok: true }))
  });
  return true;
}

function listProviders() {
  return [...providers.values()].map(({ id, kind, description, capabilities }) => ({ id, kind, description, capabilities }));
}

async function searchAll(payload, { limit = 3 } = {}) {
  const out = [];
  for (const provider of providers.values()) {
    if (out.length >= limit) break;
    try {
      const result = await provider.search(payload);
      if (result) out.push({ id: provider.id, kind: provider.kind, result });
    } catch (error) {
      out.push({ id: provider.id, kind: provider.kind, error: String(error?.message || error) });
    }
  }
  return out;
}

function createCmsJsonSource({ id, name, searchSource }) {
  return {
    id,
    kind: 'vod',
    description: `CMS JSON 源 · ${name}`,
    capabilities: { search: true, detail: true },
    async search(payload) {
      const done = telemetry.timer('source.cms.search');
      try {
        const deadline = Date.now() + 5000;
        const resource = await searchSource(payload.source, payload, deadline);
        telemetry.count('source.cms.hit', resource ? 1 : 0);
        return { ok: true, resource };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        done({ id });
      }
    }
  };
}

function createDoubanCategorySource({ id, fetchDoubanRecentHot }) {
  return {
    id,
    kind: 'browse',
    description: '豆瓣原生分类（rexxar recent_hot）',
    capabilities: { search: true, categories: true },
    async search(payload) {
      const done = telemetry.timer('source.douban.search');
      try {
        const result = await fetchDoubanRecentHot({ kind: payload.kind, category: payload.category, type: payload.type, limit: payload.limit || 20 });
        telemetry.count('source.douban.items', result?.items?.length || 0);
        return result;
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        done({ id });
      }
    }
  };
}

function installSourceChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:sources.list')) {
      ipcMain.handle('cf:sources.list', () => ({ providers: listProviders() }));
    }
    if (!ipcMain._invokeHandlers.get('cf:sources.search')) {
      ipcMain.handle('cf:sources.search', (_event, payload = {}) => searchAll(payload, { limit: payload?.limit || 3 }));
    }
  } catch {  }
}

module.exports = { registerProvider, listProviders, searchAll, createCmsJsonSource, createDoubanCategorySource, installSourceChannels };

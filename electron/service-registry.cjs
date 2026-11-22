'use strict';

const services = [];

function registerService(id, install, { deps = [] } = {}) {
  services.push({ id: String(id), deps: [...deps], install: install || (() => {}), state: 'pending', error: null, installedAt: 0 });
}

function installServices(context = {}) {
  const results = [];
  for (const service of services) {
    const missing = service.deps.filter((dep) => !services.some((s) => s.id === dep && s.state === 'ok'));
    if (missing.length) {
      service.state = 'failed';
      service.error = `依赖未就绪: ${missing.join(', ')}`;
      results.push({ id: service.id, state: service.state, error: service.error });
      continue;
    }
    try {
      service.install(context);
      service.state = 'ok';
      service.installedAt = Date.now();
      results.push({ id: service.id, state: 'ok' });
    } catch (error) {
      service.state = 'failed';
      service.error = String(error?.message || error);
      results.push({ id: service.id, state: 'failed', error: service.error });
    }
  }
  return results;
}

function listServices() {
  return services.map(({ id, deps, state, error, installedAt }) => ({ id, deps, state, error, installedAt }));
}

function isHealthy(id) {
  return services.some((service) => service.id === id && service.state === 'ok');
}

function installServiceChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:services.list')) {
      ipcMain.handle('cf:services.list', () => ({ services: listServices() }));
    }
  } catch {  }
}

module.exports = { registerService, installServices, listServices, isHealthy, installServiceChannels };

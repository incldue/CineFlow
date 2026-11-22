'use strict';

const EVENT_MAX = 300;
const events = [];
const counters = new Map();
let sequence = 0;

function record(name, data = null, ms = null) {
  try {
    sequence += 1;
    events.push({
      seq: sequence,
      at: Date.now(),
      name: String(name || '').slice(0, 80),
      ms: ms === null ? null : Math.max(0, Math.round(ms)),
      data: data === null ? null : JSON.parse(JSON.stringify(data))
    });
    if (events.length > EVENT_MAX) events.splice(0, events.length - EVENT_MAX);
    if (name) counters.set(name, (counters.get(name) || 0) + 1);
  } catch {  }
}

function timer(name) {
  const startedAt = Date.now();
  return (data = null) => {
    const ms = Date.now() - startedAt;
    record(name, data, ms);
    return ms;
  };
}

function count(name, delta = 1) {
  if (!name) return;
  counters.set(name, (counters.get(name) || 0) + delta);
}

function dump(limit = 60) {
  return {
    at: Date.now(),
    counters: Object.fromEntries([...counters.entries()].sort((a, b) => b[1] - a[1])),
    recent: events.slice(-Math.max(1, Math.min(300, limit))).reverse()
  };
}

function installTelemetryChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:telemetry.dump')) {
      ipcMain.handle('cf:telemetry.dump', (_event, payload = {}) => dump(payload?.limit));
    }
  } catch {  }
}

module.exports = { record, timer, count, dump, installTelemetryChannels };

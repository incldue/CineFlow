'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_HOSTS = ['image.tmdb.org', 'static-1.themoviedb.org', 'media.themoviedb.org'];

function parseResolverRules(text) {
  const pinned = {};
  const raw = String(text || '');
  for (const part of raw.split(',')) {
    const match = /^\s*MAP\s+(\S+)\s+(\S+)\s*$/.exec(part);
    if (!match) continue;
    if (IMAGE_HOSTS.includes(match[1]) && /^\d+\.\d+\.\d+\.\d+$/.test(match[2])) pinned[match[1]] = match[2];
  }
  return pinned;
}

function readPinned(file, app) {
  const pinned = parseResolverRules(app && app.commandLine && app.commandLine.getSwitchValue('host-resolver-rules'));
  if (pinned[IMAGE_HOSTS[0]]) return pinned;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const table = raw && (raw.hosts || raw);
    for (const host of IMAGE_HOSTS) {
      const entry = table && table[host];
      const ip = entry && (typeof entry === 'string' ? entry : entry.ip);
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(String(ip))) pinned[host] = String(ip);
    }
  } catch {

  }
  return pinned;
}

function createImageRouteRescue({ log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let applied = 0;
  let installed = false;

  function apply(ses) {
    if (!ses) return false;
    try {
      ses.webRequest.onBeforeRequest({ urls: IMAGE_HOSTS.map((host) => `https://${host}/*`) }, (details, callback) => {

        callback({});
      });
      applied += 1;
      return true;
    } catch (error) {
      say('图片直连接管失败（保持基线中继）:', error && error.message);
      return false;
    }
  }

  function install({ app, session, userDataDir } = {}) {
    if (installed) return true;
    if (process.env.CINEFLOW_IMAGE_RELAY === 'on') {
      say('图片中继保持基线（CINEFLOW_IMAGE_RELAY=on）');
      return false;
    }
    const cacheFile = path.join(userDataDir || (app && app.getPath('userData')) || '', 'ip-cache.json');
    const pinned = readPinned(cacheFile, app);
    if (!pinned[IMAGE_HOSTS[0]]) {
      say('图片直连未接管：还没有 ' + IMAGE_HOSTS[0] + ' 的真 IP（沿用中继）');
      return false;
    }
    const ses = session || require('electron').session.defaultSession;
    if (!ses) return false;
    installed = apply(ses);
    if (!installed) return false;
    say('图片直连已接管:', Object.entries(pinned).map(([h, ip]) => h + '=' + ip).join(', '));

    for (const delay of [900, 2200, 5000]) {
      const timer = setTimeout(() => {
        try { apply(ses); } catch {  }
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return true;
  }

  return { install, get applied() { return applied; } };
}

module.exports = { createImageRouteRescue };

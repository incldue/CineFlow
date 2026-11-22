'use strict';

const fsp = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOpenlistClient, parentOf } = require('./openlist-adapter.cjs');
const { createWebdavClient } = require('./webdav-adapter.cjs');
const { createRemoteStream } = require('./remote-stream.cjs');

const CONFIG_FILE = 'cineflow-remote-lib.json';
const POSITIVE_TTL_MS = 4 * 60 * 1000;
const NEGATIVE_TTL_MS = 90 * 1000;
const SCAN_MAX_DIRS = 400;
const SCAN_MAX_DEPTH = 3;
const SCORE_FLOOR = 44;

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'avi', 'ts', 'm2ts', 'mov', 'flv', 'mpg', 'mpeg', '3gp', 'm3u8', 'mpd', 'rmvb', 'wmv']);
const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub']);

function extOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : '';
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[\s:：·\-–—_.,，。!！?？'"“”‘’()（）\[\]{}]/g, '');
}

function parseMediaName(rawName) {
  const name = String(rawName || '');
  const ext = extOf(name);
  let base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  base = base.replace(/[\[\](){}]/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const yearHit = base.match(/(19\d{2}|20\d{2})/g);
  const year = yearHit ? yearHit[yearHit.length - 1] : '';
  let season = 0;
  let episode = 0;
  const se = base.match(/s(\d{1,2})[\s._-]*e(\d{1,4})/i) || base.match(/(\d{1,2})x(\d{1,4})/i);
  if (se) { season = Number(se[1]); episode = Number(se[2]); }
  if (!episode) {
    const cn = base.match(/第\s*(\d{1,4})\s*[集话話期]/);
    if (cn) episode = Number(cn[1]);
  }
  if (!episode) {
    const short = base.match(/(?:^|[\s._-])e(?:p)?\.?\s*(\d{1,4})(?:$|[\s._-])/i);
    if (short) episode = Number(short[1]);
  }
  const quality = ((base.match(/\b(2160p|1080p|720p|480p|4k|8k|web-?dl|webrip|bluray|bdrip|hdtv|remux)\b/i) || [''])[0] || '').toLowerCase();
  const title = base
    .replace(/(19\d{2}|20\d{2}).*$/, '')
    .replace(/s\d{1,2}[\s._-]*e\d{1,4}.*$/i, '')
    .replace(/第\s*\d{1,4}\s*[集话話期].*$/, '')
    .replace(/(?:^|[\s._-])e(?:p)?\.?\s*\d{1,4}.*$/i, '')
    .replace(/\b(2160p|1080p|720p|480p|4k|8k|web-?dl|webrip|bluray|bdrip|hdtv|remux|hevc|x265|x264|aac|dts|10bit)\b.*$/i, '')
    .trim();
  return { title: (title || base).trim(), year, season, episode, ext, quality };
}

function naturalSort(a, b) {
  const na = Number(a && a.episode) || 0;
  const nb = Number(b && b.episode) || 0;
  if (na !== nb) return na - nb;
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN', { numeric: true });
}

function fuzzyHit(name, titles) {
  const target = normalizeTitle(name);
  if (!target) return '';
  for (const title of titles) {
    const key = normalizeTitle(title);
    if (key && (target.includes(key) || key.includes(target))) return title;
  }
  return '';
}

function maskLib(lib) {
  return {
    id: lib.id,
    kind: lib.kind,
    name: lib.name,
    baseUrl: lib.baseUrl,
    root: lib.root,
    authType: lib.authType,
    username: lib.username || '',
    hasSecret: Boolean(lib.password || lib.token),
    depth: lib.depth,
    extAllow: lib.extAllow,
    subtitleMatch: lib.subtitleMatch !== false,
    enabled: lib.enabled !== false,
    api: lib.baseUrl,
    lastTest: lib.lastTest || null
  };
}

function createRemoteLibrary({ log = () => {}, userDataDir, ipcMain, session } = {}) {
  let configPath = '';
  let config = { version: 1, libs: [] };
  let engine = null;
  let stream = null;
  let openlist = null;
  let webdav = null;
  const positive = new Map();
  const negative = new Map();
  const installed = new Set();

  function sessionRef() {
    const candidates = [session];
    try { candidates.push(require('electron').session.defaultSession); } catch {  }
    for (const candidate of candidates) {
      if (candidate && typeof candidate.fetch === 'function') return candidate;
    }
    return null;
  }

  async function readJson(response) {
    let text = '';
    try { text = await response.text(); } catch { text = ''; }
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: response.ok, status: response.status, text, json, headers: response.headers };
  }

  async function httpJson(target, init = {}, timeoutMs = 4500) {

    if (typeof globalThis.fetch === 'function') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await globalThis.fetch(target, { ...init, signal: controller.signal });
        return await readJson(response);
      } catch {  } finally {
        clearTimeout(timer);
      }
    }
    const ses = sessionRef();
    if (!ses || typeof ses.fetch !== 'function') {
      const error = new Error('无可用网络会话');
      error.code = 'NO_SESSION';
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await ses.fetch(target, { ...init, signal: controller.signal, cache: 'no-store' });
      return await readJson(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchUpstream(target, headers = {}, extraHeaders = {}) {
    const ses = sessionRef();
    if (!ses || typeof ses.fetch !== 'function') throw new Error('no-session');
    const merged = { 'user-agent': 'Mozilla/5.0 CineFlow', accept: '*/*', ...(extraHeaders || {}) };
    if (headers.range) merged.range = headers.range;
    return ses.fetch(target, { method: 'GET', headers: merged, redirect: 'follow' });
  }

  function candidateFiles() {
    const list = [path.join(userDataDir || process.cwd(), CONFIG_FILE)];
    try { list.push(path.join(require('node:os').homedir(), '.cineflow', CONFIG_FILE)); } catch {  }
    try { list.push(path.join(require('node:os').tmpdir(), CONFIG_FILE)); } catch {  }
    return list;
  }

  function configFile() {
    if (configPath) return configPath;
    for (const candidate of candidateFiles()) {
      try {
        if (fsp.existsSync(candidate)) { configPath = candidate; return configPath; }
      } catch {  }
    }
    configPath = candidateFiles()[0];
    return configPath;
  }

  function load() {
    try {
      const raw = fsp.readFileSync(configFile(), 'utf8');
      const parsed = JSON.parse(raw);
      config = {
        version: 1,
        libs: Array.isArray(parsed && parsed.libs) ? parsed.libs.map(sanitizeLib).filter(Boolean) : []
      };
    } catch {
      config = { version: 1, libs: [] };
    }
    return config;
  }

  function save() {
    const payload = JSON.stringify(config, null, 2);
    const targets = [configPath || configFile(), ...candidateFiles()].filter((item, index, list) => item && list.indexOf(item) === index);
    for (const target of targets) {
      try {
        fsp.mkdirSync(path.dirname(target), { recursive: true });
        fsp.writeFileSync(target, payload, 'utf8');
        configPath = target;
        return true;
      } catch {  }
    }
    log('远程库配置写入失败，本次仅保存在内存');
    return false;
  }

  function sanitizeLib(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const baseUrl = String(entry.baseUrl || entry.api || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) return null;
    const kind = String(entry.kind || 'openlist').toLowerCase() === 'webdav' ? 'webdav' : 'openlist';
    const authType = ['none', 'password', 'token'].includes(String(entry.authType)) ? String(entry.authType) : 'none';
    return {
      id: String(entry.id || ('rl_' + crypto.randomBytes(4).toString('hex'))),
      kind,
      name: String(entry.name || '').trim().slice(0, 60) || (kind === 'webdav' ? 'WebDAV 媒体库' : 'OpenList 媒体库'),
      baseUrl,
      root: String(entry.root || '/').trim() || '/',
      authType: kind === 'webdav' && authType === 'token' ? 'password' : authType,
      username: String(entry.username || '').slice(0, 120),
      password: String(entry.password || '').slice(0, 200),
      token: String(entry.token || '').slice(0, 400),
      depth: Math.min(SCAN_MAX_DEPTH, Math.max(0, Number(entry.depth) || 2)),
      extAllow: Array.isArray(entry.extAllow) && entry.extAllow.length
        ? entry.extAllow.map((item) => String(item).toLowerCase().replace(/^\./, '')).filter((item) => VIDEO_EXT.has(item)).slice(0, 12)
        : [],
      subtitleMatch: entry.subtitleMatch !== false,
      enabled: entry.enabled !== false,
      lastTest: entry.lastTest && typeof entry.lastTest === 'object' ? entry.lastTest : null,
      createdAt: Number(entry.createdAt) || Date.now()
    };
  }

  function clientFor(lib) {
    if (lib.kind === 'webdav') {
      if (!webdav) webdav = createWebdavClient({ httpJson, log });
      return webdav;
    }
    if (!openlist) openlist = createOpenlistClient({ httpJson, log });
    return openlist;
  }

  function allowedExt(lib) {
    if (Array.isArray(lib.extAllow) && lib.extAllow.length) return new Set(lib.extAllow);
    return VIDEO_EXT;
  }

  function findLib(id) {
    return config.libs.find((lib) => lib.id === id) || null;
  }

  function resolveByApi(api) {
    const target = String(api || '').trim().replace(/\/+$/, '');
    if (!target) return null;
    for (const lib of config.libs) {
      if (lib.enabled === false) continue;
      if (target === lib.baseUrl || target.startsWith(lib.baseUrl + '/')) return lib;
    }
    return null;
  }

  async function listDir(lib, dir) {
    const client = clientFor(lib);
    return client.list(lib, dir || lib.root || '/');
  }

  async function collectFiles(lib, titles, deadline) {
    const client = clientFor(lib);
    const allowed = allowedExt(lib);
    const files = [];
    if (lib.kind === 'openlist' && lib.authType !== 'none') {
      try { await client.login(lib); } catch (error) { if (error && error.code === 'AUTH') throw error; }
    }
    const searches = await Promise.all(titles.slice(0, 3).map(async (title) => {
      try {
        return await client.search(lib, lib.root || '/', title);
      } catch (error) {
        if (error && error.code === 'AUTH') throw error;
        return [];
      }
    }));
    for (const hits of searches) {
      for (const hit of hits) {
        if (hit.isDir) continue;
        const ext = extOf(hit.name);
        if (!allowed.has(ext)) continue;
        const path_ = hit.path || (parentOf(hit.dir || lib.root) + '/' + hit.name);
        files.push({ name: hit.name, path: path_, dir: hit.dir || parentOf(path_), size: hit.size || 0 });
        if (files.length >= 60) break;
      }
      if (files.length >= 60) break;
    }
    if (files.length) return files;

    const queue = [{ dir: lib.root || '/', depth: 0 }];
    let visited = 0;
    while (queue.length && Date.now() < deadline - 400 && visited < SCAN_MAX_DIRS) {
      const node = queue.shift();
      visited += 1;
      let entries = [];
      try { entries = await listDir(lib, node.dir); } catch (error) { if (error && error.code === 'AUTH') throw error; }
      for (const entry of entries) {
        if (entry.isDir) {
          if (node.depth + 1 > Math.min(SCAN_MAX_DEPTH, lib.depth)) continue;
          const hit = fuzzyHit(entry.name, titles);
          if (hit || node.depth === 0) queue.push({ dir: entry.path, depth: node.depth + 1 });
          continue;
        }
        const ext = extOf(entry.name);
        if (!allowed.has(ext)) continue;
        files.push({ name: entry.name, path: entry.path, dir: node.dir, size: entry.size || 0 });
      }
      if (files.length >= 60) break;
    }
    return files;
  }

  function subtitleKey(rawName) {
    const ext = extOf(rawName);
    let base = String(rawName || '');
    if (ext) base = base.slice(0, base.length - ext.length - 1);
    return base
      .toLowerCase()
      .replace(/\.(zh|chs|cht|eng|chi|sc|tc|zh-cn|zh-tw)$/i, '')
      .replace(/[._\-\s]?(2160p|1080p|720p|480p|4k|8k|web-?dl|webrip|bluray|bdrip|hdtv|remux|hevc|x265|x264|h264|aac|dts|10bit|hdr)\b.*$/i, '')
      .replace(/[\s._-]+/g, '.')
      .replace(/\.+$/, '');
  }

  function subtitleCandidates(files) {
    const map = new Map();
    for (const file of files) {
      if (!SUB_EXT.has(extOf(file.name))) continue;
      const key = subtitleKey(file.name);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(file);
    }
    return map;
  }

  function groupFiles(lib, files, titles, releaseYear) {
    const buckets = new Map();
    for (const file of files) {
      const parsed = parseMediaName(file.name);
      const dirParsed = parseMediaName((file.dir || '').split('/').filter(Boolean).pop() || '');
      const key = parsed.episode > 0 ? file.dir : file.path;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          title: parsed.episode > 0 ? (dirParsed.title || parsed.title) : parsed.title,
          year: dirParsed.year || parsed.year,
          dir: file.dir,
          files: []
        });
      }
      buckets.get(key).files.push({ ...file, ...parsed });
    }
    const groups = [...buckets.values()].map((group) => {
      const files2 = group.files.slice().sort(naturalSort);
      const best = files2.find((item) => item.quality) || files2[0];
      return {
        ...group,
        title: group.title || best.title,
        year: group.year || best.year,
        files: files2
      };
    });
    const scored = groups.map((group) => ({
      group,
      score: typeof engine?.resourceCandidateScore === 'function'
        ? engine.resourceCandidateScore({ vod_name: group.title, vod_year: group.year }, titles, releaseYear)
        : 60
    })).sort((a, b) => b.score - a.score);
    return scored;
  }

  function buildVodItem(lib, group, allFiles) {
    const subs = lib.subtitleMatch === false ? new Map() : subtitleCandidates(allFiles);
    const episodes = group.files.map((file) => {
      const label = file.episode > 0 ? '第' + file.episode + '集' + (file.quality ? ' ' + file.quality.toUpperCase() : '') : (file.quality ? file.quality.toUpperCase() : '播放');
      return { label, url: (stream && stream.urlFor(lib.id, file.path, file.name)) || '', name: file.name, episode: file.episode };
    }).filter((entry) => entry.url);
    if (!episodes.length) return null;
    const subsList = [];
    if (subs.size) {
      const seen = new Set();
      for (const file of group.files) {
        const hit = subs.get(subtitleKey(file.name));
        if (!hit) continue;
        for (const sub of hit) {
          if (seen.has(sub.path)) continue;
          seen.add(sub.path);
          const url = stream ? stream.urlFor(lib.id, sub.path, sub.name) : '';
          if (url) subsList.push({ label: sub.name, url, path: sub.path });
        }
      }
    }
    return {
      vod_name: group.title,
      vod_year: group.year || '',
      vod_pic: '',
      vod_play_from: lib.name,
      vod_play_url: episodes.map((entry) => entry.label + '$' + entry.url).join('#'),
      subtitles: subsList
    };
  }

  function cacheKeyOf(lib, titles, year) {
    return lib.id + '|' + year + '|' + titles.join('|');
  }

  async function searchSource(source, payload = {}, deadline = Date.now() + 4500) {
    const budget = Math.max(1200, Math.min(12000, Number(deadline || 0) - Date.now() - 150));
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), budget);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([searchSourceInner(source, payload, deadline), guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function searchSourceInner(source, payload = {}, deadline = Date.now() + 4500) {
    const startedAt = Date.now();
    const lib = resolveByApi(source && source.api);
    if (!lib) return undefined;
    const titles = [payload.title, payload.originalTitle, payload.englishTitle]
      .map((item) => String(item || '').trim())
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 4);
    if (!titles.length) return null;
    const releaseYear = String(payload.year || payload.releaseDate || '').slice(0, 4);
    const key = cacheKeyOf(lib, titles, releaseYear);
    const hit = positive.get(key);
    if (hit && Date.now() - hit.at < POSITIVE_TTL_MS) return hit.value;
    const miss = negative.get(key);
    if (miss && Date.now() - miss.at < NEGATIVE_TTL_MS) return null;

    let files = [];
    try {
      files = await collectFiles(lib, titles, deadline);
      log('检索 ' + lib.name + ' · ' + titles[0] + ' · ' + files.length + ' 个文件 · ' + (Date.now() - startedAt) + 'ms');
    } catch (error) {
      log('远程库搜索失败 · ' + lib.name + ' · ' + String((error && error.message) || error));
      negative.set(key, { at: Date.now() });
      return null;
    }
    if (!files.length) { negative.set(key, { at: Date.now() }); return null; }

    const subFiles = lib.subtitleMatch === false ? [] : await (async () => {
      const inline = files.filter((file) => SUB_EXT.has(extOf(file.name)));
      if (inline.length) return inline;
      const dirs = [...new Set(files.map((file) => file.dir))].slice(0, 2);
      const batches = await Promise.all(dirs.map(async (dir) => {
        try { return await listDir(lib, dir); } catch { return []; }
      }));
      return batches.flat().filter((entry) => !entry.isDir && SUB_EXT.has(extOf(entry.name)));
    })();
    log('字幕 ' + subFiles.length + ' 条 · 待分组 ' + files.length + ' 个文件');
    const ranked = groupFiles(lib, files, titles, releaseYear);
    for (const candidate of ranked) {
      if (candidate.score < SCORE_FLOOR) continue;
      const item = buildVodItem(lib, candidate.group, files.concat(subFiles.map((sub) => ({ ...sub, dir: parentOf(sub.path) }))));
      if (!item) continue;
      const compact = typeof engine?.compactResourceItem === 'function'
        ? engine.compactResourceItem({ ...source, name: lib.name }, item, payload)
        : null;
      log('归一 ' + (compact ? '成功 · ' + item.vod_name + ' · ' + candidate.group.files.length + ' 集' : '为空') + ' · ' + (Date.now() - startedAt) + 'ms');
      if (compact) {
        compact.subtitles = item.subtitles || [];
        positive.set(key, { at: Date.now(), value: compact });
        return compact;
      }
    }
    log('未命中 ' + lib.name + ' · ' + titles[0] + ' · 候选 ' + ranked.length);
    negative.set(key, { at: Date.now() });
    return null;
  }

  async function testRemote(source) {
    const lib = resolveByApi(source && source.api);
    if (!lib) return undefined;
    const startedAt = Date.now();
    try {
      const result = await clientFor(lib).probe(lib);
      const elapsedMs = Date.now() - startedAt;
      const note = result.sample && result.sample.length ? result.sample.join(' / ') : '';
      lib.lastTest = { at: Date.now(), ok: true, ms: elapsedMs, note };
      save();
      return { ok: true, elapsedMs, status: 200, kind: 'remote', count: result.count, note, bytes: 0 };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const message = String((error && (error.code || error.message)) || error);
      lib.lastTest = { at: Date.now(), ok: false, ms: elapsedMs, note: message };
      save();
      return { ok: false, elapsedMs, error: message, kind: 'remote' };
    }
  }

  async function resolveTarget(libId, remotePath) {
    const lib = findLib(libId);
    if (!lib || lib.enabled === false) return null;
    const client = clientFor(lib);
    if (lib.kind === 'webdav') {
      const stat = await client.stat(lib, remotePath);
      if (!stat || !stat.rawUrl) return null;
      const headers = {};
      const auth = client.authHeader(lib);
      if (auth) headers.authorization = auth;
      return { url: stat.rawUrl, headers };
    }
    const stat = await client.stat(lib, remotePath);
    if (!stat || !stat.rawUrl) return null;
    let target = stat.rawUrl;
    if (stat.sign && !/[?&]sign=/.test(target)) target += (target.includes('?') ? '&' : '?') + 'sign=' + encodeURIComponent(stat.sign);
    return { url: target, headers: {} };
  }

  async function readSubtitle(libId, remotePath) {
    const target = await resolveTarget(libId, remotePath);
    if (!target) return { ok: false, error: '字幕不可用' };
    const ses = sessionRef();
    if (!ses || typeof ses.fetch !== 'function') return { ok: false, error: '无可用网络会话' };
    try {
      const response = await ses.fetch(target.url, { method: 'GET', headers: { accept: '*/*', ...(target.headers || {}) } });
      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      const buffer = Buffer.from(await response.arrayBuffer());
      return { ok: true, name: path.basename(remotePath), buffer };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function sourceList(mode) {
    return config.libs
      .filter((lib) => lib.enabled !== false)
      .map((lib) => ({
        key: 'remote:' + lib.id,
        name: lib.name,
        api: lib.baseUrl,
        modes: [String(mode || 'stable')],
        enabled: true,
        origin: 'remote',
        note: '远程媒体库 · ' + (lib.kind === 'webdav' ? 'WebDAV' : 'OpenList') + ' · ' + (lib.root || '/')
      }));
  }

  function attachEngine(internals) {
    engine = internals || null;
    load();
    if (stream) return;
    stream = createRemoteStream({
      log,
      resolveTarget: (libId, remotePath) => resolveTarget(libId, remotePath),
      fetchUpstream: (target, headers, extra) => fetchUpstream(target, headers, extra)
    });
    stream.start().catch(() => {});
  }

  function handle(channel, handler) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') return;
    try { ipcMain.removeHandler(channel); } catch {  }
    try { ipcMain.handle(channel, handler); installed.add(channel); } catch (error) { log('IPC 注册失败 ' + channel); }
  }

  function registerIpc() {
    load();
    handle('cf:m2:remote-list', async () => ({ ok: true, libs: config.libs.map(maskLib) }));
    handle('cf:m2:remote-save', async (_event, payload) => {
      const next = sanitizeLib(payload || {});
      if (!next) return { ok: false, error: '地址必须以 http:// 或 https:// 开头' };
      const index = config.libs.findIndex((lib) => lib.id === next.id);
      if (index >= 0) {
        const merged = { ...config.libs[index], ...next };
        if (!payload.password && config.libs[index].password) merged.password = config.libs[index].password;
        if (!payload.token && config.libs[index].token) merged.token = config.libs[index].token;
        config.libs[index] = merged;
      } else {
        config.libs.push(next);
      }
      save();
      return { ok: true, lib: maskLib(index >= 0 ? config.libs[index] : next), libs: config.libs.map(maskLib) };
    });
    handle('cf:m2:remote-remove', async (_event, id) => {
      config.libs = config.libs.filter((lib) => lib.id !== String(id || ''));
      save();
      return { ok: true, libs: config.libs.map(maskLib) };
    });
    handle('cf:m2:remote-test', async (_event, payload) => {
      const id = String((payload && payload.id) || '');
      const lib = findLib(id);
      if (!lib) return { ok: false, error: '库不存在' };
      const result = await testRemote({ api: lib.baseUrl });
      return { ...result, lib: maskLib(findLib(id) || lib) };
    });
    handle('cf:m2:remote-preview', async (_event, payload) => {
      const id = String((payload && payload.id) || '');
      const lib = findLib(id);
      if (!lib) return { ok: false, error: '库不存在' };
      const titles = [payload && payload.title].map((item) => String(item || '').trim()).filter(Boolean);
      if (!titles.length) return { ok: false, error: '请填写片名' };
      try {
        const files = await collectFiles(lib, titles, Date.now() + 4500);
        const groups = groupFiles(lib, files, titles, String((payload && payload.year) || '')).slice(0, 5);
        return {
          ok: true,
          count: files.length,
          groups: groups.map((entry) => ({
            title: entry.group.title,
            year: entry.group.year,
            score: entry.score,
            episodes: entry.group.files.length,
            sample: entry.group.files.slice(0, 3).map((file) => file.name)
          }))
        };
      } catch (error) {
        return { ok: false, error: String((error && (error.code || error.message)) || error) };
      }
    });
    handle('cf:m2:remote-subtitle', async (_event, payload) => {
      const libId = String((payload && payload.libId) || '');
      const remotePath = String((payload && payload.path) || '');
      if (!libId || !remotePath) return { ok: false, error: '参数不足' };
      const result = await readSubtitle(libId, remotePath);
      if (!result.ok) return result;
      return { ok: true, name: result.name, base64: result.buffer.toString('base64') };
    });
    handle('cf:m2:remote-stats', async () => ({
      ok: true,
      libs: config.libs.length,
      enabled: config.libs.filter((lib) => lib.enabled !== false).length,
      port: stream ? stream.stats().port : 0,
      positive: positive.size,
      negative: negative.size
    }));
    return true;
  }

  return {
    registerIpc,
    attachEngine,
    searchSource,
    testRemote,
    resolveByApi,
    sourceList,
    load,
    _internals: { parseMediaName, naturalSort, groupFiles, sanitizeLib, maskLib, config: () => config, positive, negative }
  };
}

module.exports = { createRemoteLibrary, parseMediaName, naturalSort, extOf, normalizeTitle };

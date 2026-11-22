'use strict';

const TIMEOUT_MS = 6000;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>';

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function textOf(block, tag) {
  const match = block.match(new RegExp('<(?:[a-z0-9]+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?' + tag + '>', 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function parseMultistatus(xml) {
  const text = String(xml || '');
  const blocks = text.split(/<\/(?:[a-z0-9]+:)?response>/i);
  const entries = [];
  for (const block of blocks) {
    const href = textOf(block, 'href');
    if (!href) continue;
    const isDir = /<(?:[a-z0-9]+:)?collection\s*\/?>/i.test(block);
    entries.push({
      href,
      isDir,
      size: Number(textOf(block, 'getcontentlength')) || 0,
      modified: textOf(block, 'getlastmodified'),
      contentType: textOf(block, 'getcontenttype')
    });
  }
  return entries;
}

function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

function resolveHref(base, href) {
  try {
    const absolute = new URL(href, base.endsWith('/') ? base : base + '/');
    const decoded = decodeURIComponent(absolute.pathname || '/');
    return decoded.replace(/\/+$/, '') || '/';
  } catch { return ''; }
}

function joinRemote(dir, name) {
  const base = String(dir || '/').replace(/\/+$/, '');
  const tail = String(name || '').replace(/^\/+/, '');
  return (base + '/' + tail).replace(/\/{2,}/g, '/');
}

function baseName(remotePath) {
  const clean = String(remotePath || '').replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? clean : clean.slice(index + 1);
}

function authHeader(lib) {
  if (lib.authType !== 'password' || !lib.username) return '';
  const raw = Buffer.from(lib.username + ':' + (lib.password || ''), 'utf8').toString('base64');
  return 'Basic ' + raw;
}

function createWebdavClient({ httpJson, log = () => {} } = {}) {
  async function propfind(lib, dir, depth = 1) {
    const base = normalizeBase(lib.baseUrl);
    if (!base) {
      const error = new Error('地址不合法');
      error.code = 'BAD_URL';
      throw error;
    }
    const target = (base + String(dir || '/')).replace(/\/{2,}/g, '/');
    const headers = {
      depth: String(depth),
      'content-type': 'application/xml; charset=utf-8',
      accept: 'application/xml, text/xml, */*'
    };
    const auth = authHeader(lib);
    if (auth) headers.authorization = auth;
    const result = await httpJson(target, { method: 'PROPFIND', headers, body: PROPFIND_BODY }, TIMEOUT_MS);
    if (result.status === 401) { const error = new Error('认证失败'); error.code = 'AUTH'; throw error; }
    if (result.status === 404) { const error = new Error('目录不存在'); error.code = 'NOT_FOUND'; throw error; }
    if (!result.ok) { const error = new Error('HTTP ' + result.status); error.code = 'UPSTREAM'; throw error; }
    const entries = parseMultistatus(result.text).map((entry) => {
      const path = resolveHref(base, entry.href);
      return { ...entry, path, name: baseName(path) };
    }).filter((entry) => entry.path && entry.path !== String(dir || '/').replace(/\/+$/, ''));
    return entries;
  }

  async function list(lib, dir) {
    const entries = await propfind(lib, dir, 1);
    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      size: entry.size,
      modified: entry.modified,
      thumb: ''
    }));
  }

  async function probe(lib) {
    const entries = await list(lib, lib.root || '/');
    return { ok: true, count: entries.length, sample: entries.slice(0, 3).map((entry) => entry.name) };
  }

  async function stat(lib, remotePath) {
    const base = normalizeBase(lib.baseUrl);
    if (!base) return null;
    return { name: baseName(remotePath), path: remotePath, isDir: false, size: 0, rawUrl: base + remotePath, sign: '' };
  }

  return { propfind, list, probe, stat, authHeader };
}

module.exports = { createWebdavClient, parseMultistatus, normalizeBase, joinRemote, baseName, resolveHref };

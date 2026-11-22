'use strict';

const TIMEOUT_MS = 6000;
const tokens = new Map();

function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

function joinRemote(dir, name) {
  const base = String(dir || '/').replace(/\/+$/, '');
  const tail = String(name || '').replace(/^\/+/, '');
  return (base + '/' + tail).replace(/\/{2,}/g, '/');
}

function parentOf(remotePath) {
  const clean = String(remotePath || '/').replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index <= 0 ? '/' : clean.slice(0, index);
}

function baseName(remotePath) {
  const clean = String(remotePath || '').replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? clean : clean.slice(index + 1);
}

function fail(message, code, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function statusCodeOf(status) {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM';
}

function createOpenlistClient({ httpJson, log = () => {} } = {}) {
  async function login(lib) {
    const cache = tokens.get(lib.id);
    if (cache && Date.now() - cache.at < 30 * 60 * 1000) return cache.token;
    if (lib.authType !== 'password' || !lib.username) return '';
    const base = normalizeBase(lib.baseUrl);
    const result = await httpJson(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: lib.username, password: lib.password || '' })
    }, TIMEOUT_MS);
    if (result.status === 401 || result.status === 403) throw fail('账号或密码不对', 'AUTH', result.status);
    if (!result.ok) throw fail('登录失败 HTTP ' + result.status, statusCodeOf(result.status), result.status);
    const data = result.json || {};
    const token = String((data.data && data.data.token) || '');
    if (String(data.code) !== '200' || !token) throw fail('登录返回异常', 'AUTH', result.status);
    tokens.set(lib.id, { token, at: Date.now() });
    return token;
  }

  async function post(lib, endpoint, body) {
    const base = normalizeBase(lib.baseUrl);
    if (!base) throw fail('地址不合法', 'BAD_URL');
    const token = lib.authType === 'token' ? String(lib.token || '') : await login(lib);
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (token) headers.authorization = token;
    const result = await httpJson(base + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    }, TIMEOUT_MS);
    if (!result.ok) throw fail('HTTP ' + result.status, statusCodeOf(result.status), result.status);
    const data = result.json || {};
    const code = String(data.code);
    if (code !== '200') throw fail(String(data.message || '接口返回 ' + code), code === '401' ? 'AUTH' : 'UPSTREAM', result.status);
    return data.data || {};
  }

  async function list(lib, dir) {
    const data = await post(lib, '/api/fs/list', {
      path: dir || '/',
      password: '',
      page: 1,
      per_page: 200,
      refresh: false,
      order_by: 'name',
      order_direction: 'asc'
    });
    const content = Array.isArray(data.content) ? data.content : [];
    return content.slice(0, 400).map((entry) => ({
      name: String(entry.name || ''),
      path: joinRemote(dir || '/', entry.name),
      isDir: entry.is_dir === true,
      size: Number(entry.size) || 0,
      modified: String(entry.modified || ''),
      thumb: String(entry.thumb || '')
    })).filter((entry) => entry.name);
  }

  async function search(lib, dir, keyword) {
    const data = await post(lib, '/api/fs/search', {
      parent: dir || '/',
      keywords: String(keyword || ''),
      scope: 0,
      page: 1,
      per_page: 100,
      password: ''
    });
    const content = Array.isArray(data.content) ? data.content : [];
    return content.slice(0, 200).map((entry) => {
      const parent = String(entry.parent || dir || '/');
      return {
        name: String(entry.name || ''),
        path: joinRemote(parent, entry.name),
        dir: parent,
        isDir: entry.is_dir === true,
        size: Number(entry.size) || 0
      };
    }).filter((entry) => entry.name);
  }

  async function stat(lib, remotePath) {
    const target = String(remotePath || '');
    if (!target) return null;
    const data = await post(lib, '/api/fs/get', { path: target, password: '' });
    return {
      name: String(data.name || baseName(target)),
      path: target,
      isDir: data.is_dir === true,
      size: Number(data.size) || 0,
      rawUrl: String(data.raw_url || ''),
      sign: String(data.sign || '')
    };
  }

  async function probe(lib) {
    const entries = await list(lib, lib.root || '/');
    return { ok: true, count: entries.length, sample: entries.slice(0, 3).map((entry) => entry.name) };
  }

  function resetTokens() { tokens.clear(); }

  return { login, list, search, stat, probe, resetTokens };
}

module.exports = { createOpenlistClient, normalizeBase, joinRemote, parentOf, baseName };

'use strict';
/**
 * TMDB 凭证落盘兜底（新增文件，零侵入基线）。
 *
 * 问题（实测）：应用内「粘贴密钥」走的是 tmdbAuth:grab —— 先拿剪贴板内容，
 * 再请求 https://api.themoviedb.org/3/configuration 校验，**校验不过就不写盘**。
 * 但在这台机器上代理连不到 TMDB（CONNECT 4s 超时）、系统 DNS 被污染（ECONNRESET），
 * 于是校验请求只会以"超时/连接被重置"结束 —— 用户的密钥明明是好的，却因为
 * 网络校验失败被丢弃，settings.json 里永远没有 tmdbCredential，自然进不了 TMDB 模式。
 *
 * 处理：在 bootstrap 里把这两个 handler 换成更稳的版本（removeHandler + 重注册，
 * 基线文件一行未改）：
 *   · 校验明确失败（TMDB 回 401/403）→ 仍然拒绝落盘（密钥真的无效，别骗用户）；
 *   · 校验没做完（超时/网络错误）→ **照样落盘**，只是标记 unverified，
 *     让用户至少能先存住密钥，等网络通了直接生效。
 *   · 拿到校验结果（有效）时顺带记下 images.secure_base_url，供图片域名兜底用。
 */

function loadElectron() {
  try {
    const mod = require('electron');
    return mod && typeof mod === 'object' && mod.ipcMain ? mod : null;
  } catch {
    return null;
  }
}


const CONFIG_URL = 'https://api.themoviedb.org/3/configuration';
const VERIFY_TIMEOUT_MS = Number(process.env.CINEFLOW_TMDB_VERIFY_TIMEOUT_MS || 9000);

function preview(value) {
  const text = String(value || '');
  if (text.length <= 10) return '••••';
  return text.slice(0, 4) + '••••' + text.slice(-4);
}

function createCredentialRescue({ log = () => {}, deps = {}, electron = loadElectron() } = {}) {
  const env = electron || {};
  const ipcMain = deps.ipcMain || env.ipcMain;
  const session = deps.session || env.session;
  const clipboard = deps.clipboard || env.clipboard;
  const { readCredential, saveCredential, clearTmdbCaches } = deps;

  const installedTargets = new WeakSet();
  let lastVerdict = { value: '', state: 'unknown', status: 0, error: '', at: 0 };

  function classify(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (raw.startsWith('eyJ')) return { type: 'readToken', value: raw };
    // v3 Key：32 位十六进制
    if (/^[0-9a-f]{32}$/i.test(raw)) return { type: 'apiKey', value: raw };
    return null;
  }

  async function verify(hit) {
    if (lastVerdict.value === hit.value && Date.now() - lastVerdict.at < 60 * 1000) return lastVerdict;
    const target = new URL(CONFIG_URL);
    const headers = { accept: 'application/json' };
    if (hit.type === 'apiKey') target.searchParams.set('api_key', hit.value);
    else headers.authorization = 'Bearer ' + hit.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const response = await session.defaultSession.fetch(target.toString(), {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (response.ok) {
        lastVerdict = { value: hit.value, state: 'valid', status: response.status, error: '', at: Date.now(), imagesBase: data?.images?.secure_base_url || '' };
        return lastVerdict;
      }
      const fatal = response.status === 401 || response.status === 403;
      lastVerdict = {
        value: hit.value,
        state: fatal ? 'invalid' : 'unverified',
        status: response.status,
        error: data?.status_message || 'HTTP ' + response.status,
        at: Date.now(),
      };
      return lastVerdict;
    } catch (error) {
      const aborted = error?.name === 'AbortError' || controller.signal.aborted;
      lastVerdict = {
        value: hit.value,
        state: 'unverified',
        status: 0,
        error: aborted ? '校验超时 ' + Math.round(VERIFY_TIMEOUT_MS / 1000) + 's' : (error?.message || '校验请求失败'),
        at: Date.now(),
      };
      return lastVerdict;
    } finally {
      clearTimeout(timer);
    }
  }

  function readClipboard() {
    try { return clipboard.readText() || ''; } catch { return ''; }
  }

  function install() {
    if (!ipcMain || !session) return false;
    if (installedTargets.has(ipcMain)) return true;

    const grab = async () => {
      const hit = classify(readClipboard());
      if (!hit) return { found: false };
      const verdict = await verify(hit);
      if (verdict.state === 'invalid') {
        return { found: true, type: hit.type, valid: false, error: verdict.error || 'TMDB 判定这把密钥无效', status: verdict.status };
      }
      const state = saveCredential(hit.value);
      clearTmdbCaches?.();
      log('TMDB 凭证已保存（' + hit.type + '，' + (verdict.state === 'valid' ? '已校验' : '网络未校验') + '）', preview(hit.value));
      return {
        found: true,
        type: hit.type,
        valid: true,
        unverified: verdict.state !== 'valid',
        warning: verdict.state === 'valid' ? '' : ('暂时连不上 TMDB，密钥已先保存：' + (verdict.error || '')),
        state,
      };
    };

    const status = () => {
      const current = readCredential?.() || null;
      return {
        configured: Boolean(current),
        type: current?.type || null,
        source: current?.source || null,
        preview: current ? preview(current.value) : '',
        verdict: lastVerdict.state,
        verdictError: lastVerdict.error,
      };
    };

    try { ipcMain.removeHandler('tmdbAuth:grab'); } catch { /* ignore */ }
    try { ipcMain.handle('tmdbAuth:grab', grab); } catch { /* ignore */ }
    try { ipcMain.removeHandler('tmdbAuth:credentialState'); } catch { /* ignore */ }
    try { ipcMain.handle('tmdbAuth:credentialState', status); } catch { /* ignore */ }

    installedTargets.add(ipcMain);
    return true;
  }

  return { install, verify, classify, _state: () => lastVerdict };
}

function classifyStandalone(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('eyJ')) return { type: 'readToken', value: raw };
  if (/^[0-9a-f]{32}$/i.test(raw)) return { type: 'apiKey', value: raw };
  return null;
}

module.exports = { createCredentialRescue, _internals: { classify: classifyStandalone, preview } };

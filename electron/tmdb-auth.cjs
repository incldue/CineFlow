'use strict';

const APPROVAL_BASE = 'https://www.themoviedb.org/auth/access';
const API3_HOSTS = ['https://api.themoviedb.org/3'];
const API4_HOSTS = ['https://api.tmdb.org/4', 'https://api.themoviedb.org/4'];

const ACCESS_TOKEN_PATHS = ['/auth/access_token', '/authentication/access_token'];
const POLL_INTERVAL_MS = 2500;
const APPROVAL_TIMEOUT_MS = 6 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function classifyCredential(raw) {
  const value = String(raw || '').replace(/\s+/g, '');
  if (!value) return null;
  if (/^eyJ[A-Za-z0-9_.\-]{40,}$/.test(value)) return { type: 'readToken', value, label: 'Read Access Token' };
  if (/^[a-f0-9]{32}$/i.test(value)) return { type: 'apiKey', value, label: 'API Key' };
  return null;
}

function pickAccessToken(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  const inner = payload.access_token && typeof payload.access_token === 'object'
    ? payload.access_token
    : payload;
  return String(inner.token || inner.access_token || (typeof payload.access_token === 'string' ? payload.access_token : '') || '').trim();
}

function createTmdbAuthFlow(deps) {
  const { fetchJson, openExternal, readCredential, saveCredential } = deps;
  let flow = null;

  const idle = () => ({ active: false, phase: 'idle', step: 0, message: '' });

  function snapshot() {
    if (!flow) return idle();
    return {
      active: !flow.done,
      phase: flow.phase,
      step: flow.step,
      message: flow.message,
      error: flow.error,
      approvalUrl: flow.approvalUrl,
      preview: flow.preview,
      waitedMs: flow.done ? 0 : now() - flow.startedAt,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  function setStep(phase, step, message) {
    if (!flow) return;
    flow.phase = phase;
    flow.step = step;
    flow.message = message;
  }

  function fail(error) {
    if (!flow) return;
    flow.done = true;
    flow.finishedAt = now();
    flow.error = String(error || '未知错误');
    setStep('failed', flow.step || 0, flow.error);
  }

  async function requestJson(hosts, pathname, options) {
    let lastError = 'TMDB 无响应';
    for (const host of hosts) {
      const result = await fetchJson(`${host}${pathname}`, options).catch((error) => ({ error: error?.message || error }));
      if (!result) continue;
      if (result.ok) return { ok: true, data: result.data };
      if (result.error) lastError = String(result.error);

      if (result.status && result.status !== 0) return { ok: false, status: result.status, error: lastError };
    }
    return { ok: false, error: lastError };
  }

  async function finish(value) {
    setStep('saving', 4, '正在写入本机配置');
    try {
      const state = await saveCredential(value);
      if (!flow) return;
      flow.done = true;
      flow.finishedAt = now();
      flow.preview = state?.preview || '';
      setStep('saved', 5, 'Read Access Token 已保存');
    } catch (error) {
      fail(`保存失败：${error?.message || error}`);
    }
  }

  async function pollForApproval() {
    while (flow && !flow.done && now() - flow.startedAt < APPROVAL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      if (!flow || flow.done) return;
      let result = { ok: false };
      for (const path of ACCESS_TOKEN_PATHS) {
        result = await requestJson(API4_HOSTS, path, {
          method: 'POST',
          body: { request_token: flow.requestToken },

          apiKey: flow.apiKey,
        });
        if (!flow || flow.done) return;
        if (result.ok) break;

        if (result.status && result.status !== 401 && result.status !== 404) break;
      }
      if (result.ok) {
        const value = pickAccessToken(result.data);
        if (value) return finish(value);
        fail('TMDB 返回的令牌是空的');
        return;
      }

      if (/invalid api key/i.test(String(result.error || ''))) {
        fail('这把 API Key 被 TMDB 判定无效，先回上一步换一把');
        return;
      }
      setStep('awaiting-approval', 3, '还在等你在 TMDB 页面点批准');
    }
    if (flow && !flow.done) fail('授权超时：6 分钟内没有完成批准');
  }

  async function start() {
    if (flow && !flow.done) return { ok: true, reused: true, state: snapshot() };

    const credential = readCredential();
    if (!credential || credential.type !== 'apiKey') {
      flow = { done: true, phase: credential ? 'has-read-token' : 'need-api-key', step: 0, startedAt: now(), finishedAt: now() };
      return { ok: false, code: credential ? 'HAS_READ_TOKEN' : 'NEED_API_KEY', state: snapshot() };
    }

    flow = {
      done: false,
      phase: 'requesting',
      step: 1,
      message: '正在申请 request token',
      startedAt: now(),
      approvalUrl: '',
      requestToken: '',
      apiKey: credential.value,
      preview: '',
      error: '',
    };

    const result = await requestJson(API3_HOSTS, '/authentication/token/new', { apiKey: credential.value });
    if (!flow || flow.done) return { ok: false, code: 'CANCELLED', state: snapshot() };
    if (!result.ok) {
      fail(`申请 request token 失败：${result.error || result.status}`);
      return { ok: false, code: 'REQUEST_TOKEN_FAILED', error: flow.error, state: snapshot() };
    }

    const token = String(result.data?.token || result.data?.request_token || '').trim();
    if (!token) {
      fail('TMDB 没有返回 request token');
      return { ok: false, code: 'NO_REQUEST_TOKEN', error: flow.error, state: snapshot() };
    }

    flow.requestToken = token;
    flow.approvalUrl = `${APPROVAL_BASE}?request_token=${encodeURIComponent(token)}`;
    setStep('opening', 2, '正在打开 TMDB 授权页');
    const opened = await openExternal(flow.approvalUrl).catch(() => false);
    if (!opened) {
      fail('打不开系统浏览器，请检查默认浏览器设置');
      return { ok: false, code: 'OPEN_FAILED', error: flow.error, state: snapshot() };
    }
    setStep('awaiting-approval', 3, '在 TMDB 页面点一下"批准"');
    pollForApproval();
    return { ok: true, state: snapshot() };
  }

  function cancel() {
    if (!flow || flow.done) return snapshot();
    flow.done = true;
    flow.finishedAt = now();
    setStep('cancelled', flow.step, '已取消');
    return snapshot();
  }

  return { start, snapshot, cancel, classifyCredential };
}

module.exports = { createTmdbAuthFlow, classifyCredential, pickAccessToken, APPROVAL_BASE };

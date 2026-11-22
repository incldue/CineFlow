const TICK_MS = 700;
const CLIPBOARD_TICK_MS = 800;
const BUBBLE_WIDTH = 292;
const TMDB_API_PAGE = 'https://www.themoviedb.org/settings/api';
const APPLY_STEPS = ['打开 TMDB 申请页', '登录并申请 API Key', '识别并校验密钥', '换取 Read Access Token', '写入本机配置'];
const AUTH_STEPS = ['申请 request token', '打开 TMDB 授权页', '等待你点批准', '换取 Read Access Token', '写入本机配置'];

const DRAFT_GROUPS = [
  {
    title: '开发者计划',
    rows: [
      { key: 'app_name', label: '应用名称', def: 'AAAA' },
      { key: 'app_url', label: '应用网址', def: 'http://127.0.0.1' },
      { key: 'use_type', label: '使用类型', def: 'Desktop Application' },
      { key: 'app_desc', label: '应用概述', wide: true, def: 'Meet personalized needs, enrich website interfaces and functions to give users a better experience' }
    ]
  },
  {

    title: '联系方式',
    copy: false,
    rows: [
      { key: 'first_name', label: '名字', ph: '张三' },
      { key: 'last_name', label: '姓氏', ph: 'Zhang' },
      { key: 'email', label: '邮箱', ph: '与账号一致可留空' },
      { key: 'phone', label: '电话号码', ph: '00000000000' },
      { key: 'addr1', label: '地址 1', ph: 'shenzhen' },
      { key: 'addr2', label: '地址 2', ph: '可选' },
      { key: 'city', label: '城市', ph: 'shenzhen' },
      { key: 'state', label: '省', ph: 'guangdong' },
      { key: 'zip', label: '邮政编码', ph: '518000' },
      { key: 'country', label: '国家或地区', def: '中国' }
    ]
  }
];
const DRAFT_STORE_KEY = 'cineflow:tmdb-apply-draft:v1';

const DRAFT_DEFAULT_MIGRATION = {
  app_name: { from: 'CineFlow', to: 'AAAA' },
  app_url: { from: 'https://github.com/incldue/CineFlow', to: 'http://127.0.0.1' },
};

function readDraftStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFT_STORE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    let changed = false;
    for (const [key, rule] of Object.entries(DRAFT_DEFAULT_MIGRATION)) {
      if (parsed[key] === rule.from) { parsed[key] = rule.to; changed = true; }
    }
    if (changed) writeDraftStore(parsed);
    return parsed;
  } catch (error) {
    return {};
  }
}

function writeDraftStore(values) {
  try {
    window.localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(values));
  } catch (error) {

  }
}

const SKELETON = `
  <div class="cf6-auth-main">
    <span class="cf6-auth-title">TMDB 凭证</span>
    <span class="cf6-auth-state" data-state="empty">未配置</span>
    <span class="cf6-auth-actions">
      <button type="button" class="cf6-auth-btn">一键获取</button>
    </span>
  </div>
`;

const BUBBLE = `
  <div class="cf12-head">
    <span class="cf12-title">TMDB 凭证</span>
    <button type="button" class="cf12-close" aria-label="关闭">×</button>
  </div>
  <div class="cf12-idle">
    <button type="button" class="cf6-auth-btn cf12-go">开始授权</button>
    <button type="button" class="cf6-auth-paste cf12-paste">我已复制密钥</button>
  </div>
  <div class="cf12-draft">
    <div class="cf12-draft-bar">
      <button type="button" class="cf12-draft-toggle" aria-expanded="false">申请草稿</button>
      <button type="button" class="cf12-draft-open">打开申请页</button>
    </div>
    <div class="cf12-draft-rows" hidden></div>
  </div>
  <div class="cf12-run" hidden>
    <span class="cf6-ring" aria-hidden="true"><i></i></span>
    <span class="cf6-rail" role="progressbar" aria-valuemin="1" aria-valuemax="5" aria-label="TMDB 授权进度"></span>
    <p class="cf6-auth-msg" role="status"></p>
    <button type="button" class="cf6-auth-cancel cf12-cancel">取消</button>
  </div>
`;

function mountTmdbWizard({ api, state } = {}) {
  const scroll = document.querySelector('.settings-scroll');
  const label = document.querySelector('label[for="apiCredentialInput"]');
  if (!scroll || !label || !api?.startTmdbAuth) return false;
  if (label.dataset.cf6Wizard === '1') return true;
  label.dataset.cf6Wizard = '1';

  const card = document.createElement('div');
  card.className = 'cf6-auth';
  card.innerHTML = SKELETON;
  scroll.insertBefore(card, label);

  const stateEl = card.querySelector('.cf6-auth-state');
  const btnEl = card.querySelector('.cf6-auth-btn');

  const appRoot = document.querySelector('#app') || document.body;
  const bubble = document.createElement('div');
  bubble.className = 'cf12-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-label', 'TMDB 凭证获取');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.innerHTML = BUBBLE;
  appRoot.append(bubble);

  const idleEl = bubble.querySelector('.cf12-idle');
  const runEl = bubble.querySelector('.cf12-run');
  const railEl = bubble.querySelector('.cf6-rail');
  const msgEl = bubble.querySelector('.cf6-auth-msg');
  const goEl = bubble.querySelector('.cf12-go');
  const pasteEl = bubble.querySelector('.cf12-paste');
  const cancelEl = bubble.querySelector('.cf12-cancel');
  const closeEl = bubble.querySelector('.cf12-close');
  const draftEl = bubble.querySelector('.cf12-draft');
  const draftToggleEl = bubble.querySelector('.cf12-draft-toggle');
  const draftOpenEl = bubble.querySelector('.cf12-draft-open');
  const draftRowsEl = bubble.querySelector('.cf12-draft-rows');

  let timer = 0;
  let busy = false;
  let mode = 'auth';
  let bubbleOpen = false;
  let chaining = false;

  function placeBubble() {
    const rootRect = appRoot.getBoundingClientRect();
    const anchor = btnEl.getBoundingClientRect();
    const wantLeft = Math.round(anchor.right - rootRect.left - BUBBLE_WIDTH + 6);
    const wantTop = Math.round(anchor.bottom - rootRect.top) + 11;
    bubble.style.left = `${wantLeft}px`;
    bubble.style.top = `${wantTop}px`;
    const dx = wantLeft - bubble.offsetLeft;
    const dy = wantTop - bubble.offsetTop;
    if (Math.abs(dx) > 0.5) bubble.style.left = `${wantLeft + dx}px`;
    if (Math.abs(dy) > 0.5) bubble.style.top = `${wantTop + dy}px`;
    const width = bubble.offsetWidth || BUBBLE_WIDTH;
    const caret = anchor.left + anchor.width / 2 - (rootRect.left + bubble.offsetLeft);
    bubble.style.setProperty('--cf12-caret-x', `${Math.round(Math.min(Math.max(caret, 18), width - 18))}px`);
  }

  function syncBubbleMode() {
    idleEl.hidden = busy;
    runEl.hidden = !busy;
    draftEl.hidden = busy;
  }

  function openBubble() {
    if (bubbleOpen) return;
    bubbleOpen = true;
    bubble.classList.add('is-open');
    bubble.setAttribute('aria-hidden', 'false');
    syncBubbleMode();
    placeBubble();
    goEl.focus?.({ preventScroll: true });
  }

  function closeBubble() {
    if (!bubbleOpen) return;
    bubbleOpen = false;
    bubble.classList.remove('is-open');
    bubble.setAttribute('aria-hidden', 'true');
  }

  function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderDraft() {
    if (draftRowsEl.childElementCount) return;
    const saved = readDraftStore();
    draftRowsEl.innerHTML = DRAFT_GROUPS.map((group) => `
      <div class="cf14-group">
        <div class="cf14-group-title">${escapeText(group.title)}</div>
        ${group.rows.map((row) => {
          const value = saved[row.key] === undefined ? (row.def || '') : saved[row.key];
          const field = row.wide
            ? `<textarea class="cf14-input cf14-area" rows="2" data-key="${row.key}" spellcheck="false" placeholder="${escapeText(row.ph || '')}">${escapeText(value)}</textarea>`
            : `<input class="cf14-input" type="text" data-key="${row.key}" spellcheck="false" value="${escapeText(value)}" placeholder="${escapeText(row.ph || '')}">`;
          const copyable = group.copy !== false;
          return `<div class="cf12-row${row.wide ? ' cf14-wide' : ''}${copyable ? '' : ' cf20-nocopy'}">
            <span class="cf12-row-label">${escapeText(row.label)}</span>
            ${field}
            ${copyable ? `<button type="button" class="cf12-copy" data-key="${row.key}">复制</button>` : ''}
          </div>`;
        }).join('')}
      </div>`).join('') + '<div class="cf14-foot">勾选条款与 Subscribe 由你本人点</div>';

    let saveTimer = 0;
    draftRowsEl.addEventListener('input', (event) => {
      const key = event.target instanceof Element ? event.target.dataset.key : '';
      if (!key) return;
      const next = readDraftStore();
      next[key] = event.target.value;
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { saveTimer = 0; writeDraftStore(next); }, 400);
    });
  }

  function draftValue(key) {
    const field = draftRowsEl.querySelector(`[data-key="${key}"]`);
    if (!field) return '';
    return String(field.value || '').trim();
  }

  function setDraftOpen(open) {
    renderDraft();
    draftRowsEl.hidden = !open;
    draftEl.classList.toggle('is-open', open);
    draftToggleEl.setAttribute('aria-expanded', String(open));
    if (bubbleOpen) placeBubble();
  }

  async function copyText(value) {
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.className = 'cf12-copy-shim';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (fallbackError) {
        return false;
      }
    }
  }

  draftToggleEl.addEventListener('click', (event) => {
    event.stopPropagation();
    setDraftOpen(draftRowsEl.hidden);
  });

  draftOpenEl.addEventListener('click', (event) => {
    event.stopPropagation();
    api.openExternal?.(TMDB_API_PAGE);
  });

  draftRowsEl.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('.cf12-copy') : null;
    if (!target) return;
    event.stopPropagation();
    const ok = await copyText(draftValue(target.dataset.key));
    const row = target.closest('.cf12-row');
    if (row) row.classList.toggle('is-copied', ok);
    target.textContent = ok ? '已复制' : '空';
    window.setTimeout(() => {
      target.textContent = '复制';
      if (row) row.classList.remove('is-copied');
    }, 1400);
  });

  function renderRail(names, current) {
    if (railEl.childElementCount !== names.length) {
      railEl.innerHTML = names.map((name) => `<i title="${name}"></i>`).join('');
    }
    Array.from(railEl.children).forEach((seg, i) => {
      seg.classList.toggle('is-done', i < current);
      seg.classList.toggle('is-active', i === current);
    });
    railEl.setAttribute('aria-valuenow', String(Math.min(names.length, current + 1)));
    railEl.setAttribute('aria-valuetext', names[current] || '');
  }

  function showRun(names, step, message) {
    busy = true;
    syncBubbleMode();
    renderRail(names, step);
    if (message !== undefined) msgEl.textContent = message;
  }

  function hideRun() {
    busy = false;
    syncBubbleMode();
    msgEl.textContent = '';
    bubble.classList.remove('is-error');
    card.classList.remove('is-error');
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = 0;
    busy = false;
    chaining = false;
  }

  function syncCredential() {
    const type = state?.credential?.type;
    const configured = Boolean(state?.credential?.configured);
    card.classList.toggle('is-ready', configured);
    stateEl.dataset.state = configured ? (type === 'readToken' ? 'token' : 'key') : 'empty';
    stateEl.textContent = configured ? (type === 'readToken' ? 'Read Access Token' : 'API Key') : '未配置';
    btnEl.textContent = configured && type === 'apiKey' ? '换 Token' : '一键获取';
    return configured;
  }

  async function refreshCredential() {
    if (busy || !api.getCredentialState) return;
    const next = await api.getCredentialState().catch(() => null);
    if (!next || !state) return;
    state.credential = next;
    syncCredential();
  }

  function finishAndRefresh() {
    stop();
    hideRun();
    closeBubble();
    syncCredential();
    window.setTimeout(() => {
      const save = document.querySelector('#saveSettingsBtn');
      if (save && !save.disabled) save.click();
    }, 900);
  }

  async function readClipboardOnce(announce) {

    const grab = api.grabTmdbCredential || api.takeTmdbCredentialFromClipboard;
    const result = grab ? await grab().catch(() => null) : null;
    if (!result?.found) return false;
    if (result.valid === false) {
      announce?.(`剪贴板里这把${result.type === 'readToken' ? ' Token ' : ' Key '}校验未通过：${result.error || '未知原因'}`);
      bubble.classList.add('is-error');
      card.classList.add('is-error');
      return 'invalid';
    }
    if (state) state.credential = result.state;
    bubble.classList.remove('is-error');
    card.classList.remove('is-error');

    if (result.type === 'apiKey' && (api.startTmdbAuth || api.getTmdbAuthStatus)) {
      announce?.('API Key 已保存，正在换取 Read Access Token');
      chaining = true;
      window.setTimeout(() => { if (chaining) begin(true); }, 320);
      return true;
    }
    announce?.('已识别剪贴板里的 Read Access Token');
    finishAndRefresh();
    return true;
  }

  function startGuide() {
    mode = 'guide';
    showRun(APPLY_STEPS, 0, '正在打开 TMDB 申请页');
    api.openExternal?.(TMDB_API_PAGE);
    window.setTimeout(() => {
      if (!busy) return;
      showRun(APPLY_STEPS, 1, '没有账号就先点页面上的 Join TMDB');
    }, 1200);
    window.setTimeout(() => {
      if (!busy || mode !== 'guide') return;
      showRun(APPLY_STEPS, 2, '复制 API Key 后回到这里，会自动校验并接续换 Token');
    }, 5200);
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => { readClipboardOnce(); }, CLIPBOARD_TICK_MS);
  }

  async function pollAuth() {
    const snap = await api.getTmdbAuthStatus?.().catch(() => null);
    if (!snap) return;
    if (snap.phase === 'saved') {
      if (state) {
        const next = await api.getCredentialState?.().catch(() => null);
        if (next) state.credential = next;
      }
      finishAndRefresh();
      return;
    }
    if (snap.phase === 'failed' || snap.phase === 'cancelled') {
      stop();
      busy = true;
      syncBubbleMode();
      renderRail(AUTH_STEPS, Math.max(0, (snap.step || 1) - 1));
      msgEl.textContent = snap.error || '已取消';
      bubble.classList.add('is-error');
      card.classList.add('is-error');
      return;
    }
    if (snap.phase === 'need-api-key' || snap.phase === 'has-read-token') {
      stop();
      if (snap.phase === 'has-read-token') {
        hideRun();
        syncCredential();
      } else {
        startGuide();
      }
      return;
    }
    bubble.classList.remove('is-error');
    card.classList.remove('is-error');
    showRun(AUTH_STEPS, Math.max(0, (snap.step || 1) - 1), snap.message);
  }

  async function begin(force = false) {
    if (busy && !force) return;

    if (force && timer) { window.clearInterval(timer); timer = 0; }
    busy = true;
    mode = 'auth';
    bubble.classList.remove('is-error');
    card.classList.remove('is-error');
    showRun(AUTH_STEPS, 0, '正在申请 request token');
    const result = await api.startTmdbAuth().catch((error) => ({ ok: false, code: 'IPC_FAILED', error: String(error?.message || error) }));
    chaining = false;
    if (result?.code === 'NEED_API_KEY') { startGuide(); return; }

    if (result?.code === 'HAS_READ_TOKEN') { hideRun(); await refreshCredential(); return; }
    if (!result?.ok) {
      stop();
      busy = true;
      syncBubbleMode();
      renderRail(AUTH_STEPS, 0);
      msgEl.textContent = result?.error || result?.state?.error || '没能连上 TMDB';
      bubble.classList.add('is-error');
      card.classList.add('is-error');
      return;
    }
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(pollAuth, TICK_MS);
    pollAuth();
  }

  function abort() {
    stop();
    hideRun();
    if (mode === 'auth') api.cancelTmdbAuth?.().catch(() => {});
  }

  btnEl.addEventListener('click', (event) => {
    event.stopPropagation();
    if (bubbleOpen && !busy) { closeBubble(); return; }
    if (bubbleOpen) return;
    openBubble();
  });

  goEl.addEventListener('click', (event) => {
    event.stopPropagation();
    begin();
  });

  pasteEl.addEventListener('click', (event) => {
    event.stopPropagation();
    bubble.classList.remove('is-error');
    card.classList.remove('is-error');
    busy = true;
    syncBubbleMode();
    renderRail(APPLY_STEPS, 2);
    msgEl.textContent = '正在识别剪贴板';
    readClipboardOnce((message) => {
      renderRail(APPLY_STEPS, 3);
      msgEl.textContent = message;
    }).then((found) => {
      if (found) return;

      busy = false;
      msgEl.textContent = '剪贴板里没有找到 TMDB 密钥';
      bubble.classList.add('is-error');
      card.classList.add('is-error');
    });
  });

  cancelEl.addEventListener('click', (event) => {
    event.stopPropagation();
    abort();
  });

  closeEl.addEventListener('click', (event) => {
    event.stopPropagation();
    if (busy) abort();
    closeBubble();
  });

  document.addEventListener('keydown', (event) => {
    if (!bubbleOpen) return;
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (busy) abort();
    closeBubble();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!bubbleOpen || busy) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest('.cf12-bubble') || target.closest('.cf6-auth'))) return;
    closeBubble();
  }, { passive: true });

  scroll.addEventListener('scroll', () => { if (bubbleOpen) placeBubble(); }, { passive: true });
  window.addEventListener('resize', () => { if (bubbleOpen) placeBubble(); });

  const modal = document.querySelector('#settingsModal');
  if (modal) {
    new MutationObserver(() => {
      if (!modal.classList.contains('is-hidden')) return;
      stop();
      hideRun();
      closeBubble();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  window.setInterval(() => {
    if (modal && modal.classList.contains('is-hidden')) return;
    refreshCredential();
  }, 1000);

  syncCredential();
  return true;
}

export function initTmdbWizard(deps = {}) {
  try {
    return mountTmdbWizard(deps);
  } catch (error) {
    console.warn('[CineFlow] TMDB 凭证向导装配失败，已跳过', error);
    return false;
  }
}

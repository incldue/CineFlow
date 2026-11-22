import './remote-library.css';

const KIND_LABEL = { openlist: 'OpenList', webdav: 'WebDAV' };
const AUTH_LABEL = { none: '匿名', password: '账号密码', token: 'Token' };

function api() {
  return typeof window !== 'undefined' ? window.cineflowRemote : null;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function notify(message) {
  const el = document.querySelector('#toast');
  if (!el || !message) return;
  el.textContent = message;
  el.classList.remove('is-hidden');
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => el.classList.add('is-hidden'), 2600);
}

export function initRemoteLibraryPanel() {
  const bridge = api();
  const card = document.querySelector('.settings-card');
  const scroll = document.querySelector('.settings-scroll');
  if (!card || !scroll || !bridge || typeof bridge.list !== 'function') return null;
  if (scroll.dataset.cfRemoteLib === '1') return null;
  scroll.dataset.cfRemoteLib = '1';

  const section = document.createElement('section');
  section.className = 'cf-remote';
  section.innerHTML = `
    <header class="cf-remote-head">
      <h3 class="cf-remote-title">远程媒体库</h3>
      <p class="cf-remote-count">OpenList / WebDAV · 0</p>
    </header>
    <div class="cf-remote-list" role="list"><p class="cf-remote-empty">还没有远程库。添加后，详情页会多出一条「远端媒体库」片源。</p></div>
    <div class="cf-remote-foot">
      <button class="secondary-button cf-remote-add" type="button">添加媒体库</button>
      <p class="cf-remote-msg" role="status" aria-live="polite"></p>
    </div>
    <form class="cf-remote-form is-hidden" autocomplete="off">
      <div class="cf-remote-grid">
        <label class="cf-remote-field"><span class="cf-remote-label">名称</span>
          <input class="cf-remote-input" name="name" type="text" maxlength="60" placeholder="我的网盘" />
        </label>
        <label class="cf-remote-field"><span class="cf-remote-label">类型</span>
          <select class="cf-remote-input" name="kind">
            <option value="openlist">OpenList / AList</option>
            <option value="webdav">WebDAV</option>
          </select>
        </label>
      </div>
      <label class="cf-remote-field"><span class="cf-remote-label">地址</span>
        <input class="cf-remote-input" name="baseUrl" type="text" spellcheck="false" placeholder="https://openlist.example.com 或 https://dav.example.com/dav" />
      </label>
      <div class="cf-remote-grid">
        <label class="cf-remote-field"><span class="cf-remote-label">根路径</span>
          <input class="cf-remote-input" name="root" type="text" spellcheck="false" placeholder="/Movies" />
        </label>
        <label class="cf-remote-field"><span class="cf-remote-label">扫描深度</span>
          <input class="cf-remote-input" name="depth" type="number" min="0" max="3" step="1" value="2" />
        </label>
      </div>
      <div class="cf-remote-grid">
        <label class="cf-remote-field"><span class="cf-remote-label">认证</span>
          <select class="cf-remote-input" name="authType">
            <option value="none">匿名</option>
            <option value="password">账号密码</option>
            <option value="token">Token</option>
          </select>
        </label>
        <label class="cf-remote-field cf-remote-extra is-hidden" data-extra="user"><span class="cf-remote-label">账号</span>
          <input class="cf-remote-input" name="username" type="text" spellcheck="false" autocomplete="off" />
        </label>
      </div>
      <label class="cf-remote-field cf-remote-extra is-hidden" data-extra="secret"><span class="cf-remote-label" data-secret-label>密码</span>
        <input class="cf-remote-input" name="secret" type="password" spellcheck="false" autocomplete="new-password" placeholder="留空表示不修改" />
      </label>
      <label class="cf-remote-check"><input type="checkbox" name="subtitleMatch" checked /> 自动匹配同名字幕（.srt / .ass / .vtt）</label>
      <label class="cf-remote-field"><span class="cf-remote-label">试搜片名（验证检索是否命中）</span>
        <input class="cf-remote-input" name="probeTitle" type="text" spellcheck="false" placeholder="留空则用库名" />
      </label>
      <div class="cf-remote-foot">
        <button class="primary-button cf-remote-save" type="submit">保存</button>
        <button class="secondary-button cf-remote-cancel" type="button">取消</button>
        <button class="secondary-button cf-remote-preview" type="button">试搜</button>
        <p class="cf-remote-msg" data-form-msg role="status" aria-live="polite"></p>
      </div>
    </form>
  `;
  const proxyInput = scroll.querySelector('#proxyInput');
  if (proxyInput && proxyInput.parentNode === scroll) proxyInput.after(section);
  else scroll.append(section);

  const listEl = section.querySelector('.cf-remote-list');
  const countEl = section.querySelector('.cf-remote-count');
  const msgEl = section.querySelector('.cf-remote-foot .cf-remote-msg');
  const form = section.querySelector('.cf-remote-form');
  const formMsg = form.querySelector('[data-form-msg]');
  const secretLabel = form.querySelector('[data-secret-label]');
  const secretInput = form.querySelector('[name="secret"]');
  const userField = form.querySelector('[data-extra="user"]');
  const secretField = form.querySelector('[data-extra="secret"]');
  const authSelect = form.querySelector('[name="authType"]');
  const kindSelect = form.querySelector('[name="kind"]');

  let libs = [];
  let editing = null;

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-ok', kind === 'ok');
  }

  function syncAuthFields() {
    const mode = authSelect.value;
    const kind = kindSelect.value;
    userField.classList.toggle('is-hidden', mode !== 'password' || kind === 'openlist' && false);
    secretField.classList.toggle('is-hidden', mode === 'none');
    secretLabel.textContent = mode === 'token' ? 'Token' : '密码';
    secretInput.placeholder = editing && editing.hasSecret ? '留空表示不修改' : (mode === 'token' ? '从 OpenList 后台获取' : '');
  }

  function renderList() {
    countEl.textContent = `OpenList / WebDAV · ${libs.length}`;
    if (!libs.length) {
      listEl.innerHTML = '<p class="cf-remote-empty">还没有远程库。添加后，详情页会多出一条「远端媒体库」片源。</p>';
      return;
    }
    listEl.innerHTML = libs.map((lib) => {
      const state = lib.lastTest
        ? (lib.lastTest.ok ? `可达 · ${lib.lastTest.ms || 0}ms` : `失败 · ${esc(lib.lastTest.note || '')}`.slice(0, 42))
        : '未测试';
      const failed = lib.lastTest && !lib.lastTest.ok;
      return `
        <div class="cf-remote-row" role="listitem" data-id="${esc(lib.id)}">
          <div class="cf-remote-meta">
            <span class="cf-remote-name"><span class="cf-remote-badge">${KIND_LABEL[lib.kind] || lib.kind}</span>${esc(lib.name)}${lib.enabled === false ? ' · 已停用' : ''}</span>
            <span class="cf-remote-url">${esc(lib.baseUrl)}${esc(lib.root && lib.root !== '/' ? lib.root : '')}</span>
            <span class="cf-remote-state${failed ? ' is-error' : ''}">${esc(state)} · ${AUTH_LABEL[lib.authType] || lib.authType}</span>
          </div>
          <div class="cf-remote-actions">
            <button class="cf-remote-btn" type="button" data-act="test">测试</button>
            <button class="cf-remote-btn" type="button" data-act="edit">编辑</button>
            <button class="cf-remote-btn is-danger" type="button" data-act="remove">删除</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function openForm(lib) {
    editing = lib || null;
    form.classList.toggle('is-hidden', false);
    form.querySelector('[name="name"]').value = lib ? lib.name : '';
    kindSelect.value = lib ? lib.kind : 'openlist';
    form.querySelector('[name="baseUrl"]').value = lib ? lib.baseUrl : '';
    form.querySelector('[name="root"]').value = lib ? (lib.root || '/') : '/';
    form.querySelector('[name="depth"]').value = lib ? String(lib.depth ?? 2) : '2';
    authSelect.value = lib ? lib.authType : 'none';
    form.querySelector('[name="username"]').value = lib ? (lib.username || '') : '';
    secretInput.value = '';
    form.querySelector('[name="subtitleMatch"]').checked = lib ? lib.subtitleMatch !== false : true;
    setMsg(formMsg, '');
    syncAuthFields();
    section.classList.add('is-active');
    form.querySelector('[name="name"]').focus();
  }

  function closeForm() {
    editing = null;
    form.classList.add('is-hidden');
    section.classList.remove('is-active');
    setMsg(formMsg, '');
  }

  function payloadOf() {
    const data = {
      name: form.querySelector('[name="name"]').value.trim(),
      kind: kindSelect.value,
      baseUrl: form.querySelector('[name="baseUrl"]').value.trim(),
      root: form.querySelector('[name="root"]').value.trim() || '/',
      depth: Number(form.querySelector('[name="depth"]').value) || 0,
      authType: authSelect.value,
      username: form.querySelector('[name="username"]').value.trim(),
      subtitleMatch: form.querySelector('[name="subtitleMatch"]').checked
    };
    const secret = secretInput.value;
    if (secret) {
      if (data.authType === 'token') data.token = secret;
      else data.password = secret;
    }
    if (editing) data.id = editing.id;
    return data;
  }

  async function refresh() {
    try {
      const result = await bridge.list();
      libs = Array.isArray(result && result.libs) ? result.libs : [];
      renderList();
    } catch {
      setMsg(msgEl, '读取远程库失败', 'error');
    }
  }

  async function submit(event) {
    event.preventDefault();
    const data = payloadOf();
    if (!data.name || !data.baseUrl) { setMsg(formMsg, '名称和地址必填', 'error'); return; }
    const saveBtn = form.querySelector('.cf-remote-save');
    saveBtn.classList.add('is-busy');
    try {
      const result = await bridge.save(data);
      if (!result || result.ok !== true) { setMsg(formMsg, (result && result.error) || '保存失败', 'error'); return; }
      libs = Array.isArray(result.libs) ? result.libs : libs;
      renderList();
      setMsg(msgEl, '已保存 · ' + (KIND_LABEL[data.kind] || data.kind) + ' · ' + data.name, 'ok');
      closeForm();
      notify('远程媒体库已保存');
    } catch (error) {
      setMsg(formMsg, String((error && error.message) || error), 'error');
    } finally {
      saveBtn.classList.remove('is-busy');
    }
  }

  async function testOne(id, button) {
    if (button) button.classList.add('is-busy');
    setMsg(msgEl, '测试中…');
    try {
      const result = await bridge.test({ id });
      libs = libs.map((lib) => (lib.id === id ? { ...lib, lastTest: { ok: !!result.ok, ms: result.elapsedMs || 0, note: result.note || result.error || '' } } : lib));
      renderList();
      setMsg(msgEl, result.ok ? `可达 · ${result.elapsedMs || 0}ms · 根目录 ${result.count || 0} 项` : `失败 · ${result.error || '无响应'}`, result.ok ? 'ok' : 'error');
    } catch (error) {
      setMsg(msgEl, String((error && error.message) || error), 'error');
    } finally {
      if (button) button.classList.remove('is-busy');
    }
  }

  async function removeOne(id) {
    try {
      const result = await bridge.remove(id);
      libs = Array.isArray(result && result.libs) ? result.libs : libs.filter((lib) => lib.id !== id);
      renderList();
      setMsg(msgEl, '已删除', 'ok');
    } catch (error) {
      setMsg(msgEl, String((error && error.message) || error), 'error');
    }
  }

  async function preview() {
    const data = payloadOf();
    const guess = String(form.querySelector('[name="probeTitle"]').value || '').trim() || data.name;
    if (!guess) { setMsg(formMsg, '先填片名再试搜', 'error'); return; }
    setMsg(formMsg, '检索中…');
    try {
      const id = editing ? editing.id : '';
      if (!id) {
        const saved = await bridge.save({ ...data, enabled: true });
        if (!saved || saved.ok !== true) { setMsg(formMsg, (saved && saved.error) || '先保存再试搜', 'error'); return; }
        libs = Array.isArray(saved.libs) ? saved.libs : libs;
        renderList();
        editing = saved.lib;
      }
      const result = await bridge.preview({ id: editing.id, title: guess });
      if (!result || result.ok !== true) { setMsg(formMsg, (result && result.error) || '检索失败', 'error'); return; }
      if (!result.groups || !result.groups.length) { setMsg(formMsg, `命中 ${result.count || 0} 个文件，但没组成合集`, 'error'); return; }
      const first = result.groups[0];
      setMsg(formMsg, `命中 ${result.count} 个文件 · 最佳「${first.title}」· ${first.episodes} 集 · 评分 ${first.score}`, 'ok');
    } catch (error) {
      setMsg(formMsg, String((error && error.message) || error), 'error');
    }
  }

  section.querySelector('.cf-remote-add').addEventListener('click', () => openForm(null));
  form.querySelector('.cf-remote-cancel').addEventListener('click', closeForm);
  form.querySelector('.cf-remote-preview').addEventListener('click', preview);
  form.addEventListener('submit', submit);
  authSelect.addEventListener('change', syncAuthFields);
  kindSelect.addEventListener('change', syncAuthFields);
  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const row = button.closest('.cf-remote-row');
    const id = row && row.dataset.id;
    const lib = libs.find((item) => item.id === id);
    if (!lib) return;
    if (button.dataset.act === 'test') testOne(id, button);
    if (button.dataset.act === 'edit') openForm(lib);
    if (button.dataset.act === 'remove') removeOne(id);
  });

  refresh();
  return { refresh };
}

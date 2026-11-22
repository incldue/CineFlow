const MODES = [
  { value: 'auto', label: '自动（Wayland + NVIDIA 时关闭）' },
  { value: 'off', label: '关闭硬件加速（软件渲染）' },
  { value: 'on', label: '强制开启硬件加速' }
];

function isLinux() {
  return typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent || '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function initGpuGuardCard() {
  if (!isLinux()) return null;
  const bridge = typeof window !== 'undefined' ? window.cineflowGpu : null;
  const scroll = document.querySelector('.settings-scroll');
  if (!bridge || !scroll || scroll.dataset.cfGpuCard === '1') return null;
  scroll.dataset.cfGpuCard = '1';

  const section = document.createElement('section');
  section.className = 'cf-remote cf-gpu';
  section.innerHTML = `
    <header class="cf-remote-head">
      <h3 class="cf-remote-title">图形加速</h3>
      <p class="cf-remote-count" data-gpu-env>仅 Linux</p>
    </header>
    <label class="cf-remote-field"><span class="cf-remote-label">GPU 加速方式</span>
      <select class="cf-remote-input" data-gpu-mode>
        ${MODES.map((item) => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}
      </select>
    </label>
    <p class="cf-remote-msg" data-gpu-msg role="status" aria-live="polite">改动在重启后生效</p>
  `;
  const anchor = scroll.querySelector('.cf-remote');
  if (anchor && anchor !== section) anchor.after(section);
  else scroll.append(section);

  const envEl = section.querySelector('[data-gpu-env]');
  const modeEl = section.querySelector('[data-gpu-mode]');
  const msgEl = section.querySelector('[data-gpu-msg]');

  async function load() {
    try {
      const state = await bridge.get();
      if (!state || state.supported !== true) { section.remove(); return; }
      modeEl.value = state.mode || 'auto';
      const parts = [];
      if (state.wayland) parts.push('Wayland');
      if (state.nvidia) parts.push('NVIDIA');
      envEl.textContent = parts.length ? parts.join(' + ') : 'X11';
      msgEl.textContent = state.disabled ? '当前已关闭硬件加速（软件渲染）' : '当前使用硬件加速';
      msgEl.classList.toggle('is-ok', !!state.disabled);
    } catch {
      msgEl.textContent = '读取图形加速状态失败';
      msgEl.classList.add('is-error');
    }
  }

  modeEl.addEventListener('change', async () => {
    const mode = modeEl.value;
    try {
      const result = await bridge.set({ mode });
      if (!result || result.ok !== true) {
        msgEl.textContent = (result && result.error) || '保存失败';
        msgEl.classList.add('is-error');
        return;
      }
      msgEl.classList.remove('is-error');
      msgEl.classList.add('is-ok');
      msgEl.textContent = '已保存，重启后按「' + (MODES.find((item) => item.value === mode) || {}).label + '」生效';
    } catch (error) {
      msgEl.textContent = String((error && error.message) || error);
      msgEl.classList.add('is-error');
    }
  });

  load();
  return { reload: load };
}

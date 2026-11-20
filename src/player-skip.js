/**
 * 播放器 10 秒快进 / 快退（新增文件，零侵入基线）
 *
 * 基线播放器用的是原生 controls，自带 ±5 秒级别的小步进，但没有「整 10 秒」的
 * 手感，也没有左右双击区域。这里只做一层轻量接管：
 *
 *   · 键位：←/→ 与 J/L 都是 ∓10 秒（播放器打开时才接管，且不抢输入框）
 *   · 双击：播放区左右各 30% 区域 = ∓10 秒，中间区域保持原生播放/暂停
 *   · 丝滑：优先 video.fastSeek（Chromium 支持，不打乱缓冲），没有才写 currentTime；
 *           200ms 窗口内的连按合并成一次 seek，避免连点十下触发十次 seek 卡顿；
 *           seek 后若原本在播放，保持播放，不会出现"接一下再停"的顿挫
 *   · 反馈：屏幕左侧/右侧闪一个「« 10s / 10s »」小提示，160ms 淡出
 *
 * 基线自己也在 #resourcePlayer 上挂了 pointerdown/up 做拖动进度，这里只处理
 * dblclick 与键盘，不拦单击、不拦拖动。
 */

import './player-skip.css';

const STEP_SECONDS = 10;
const MERGE_MS = 200;
const FLASH_MS = 620;

export function initPlayerSkip(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return () => {};

  const video = () => doc.querySelector('#resourcePlayer');
  const modal = () => doc.querySelector('#playerModal');
  const isOpen = () => {
    const m = modal();
    return !!m && m.classList.contains('is-open');
  };

  let pending = 0;
  let timer = 0;
  let flashEl = null;
  let flashTimer = 0;

  function flash(direction) {
    try {
      const stage = doc.querySelector('#playerStage');
      if (!stage) return;
      if (!flashEl) {
        flashEl = doc.createElement('div');
        flashEl.className = 'cf-skip-flash';
        doc.body.appendChild(flashEl);
      }
      flashEl.textContent = direction > 0 ? '10s »' : '« 10s';
      flashEl.dataset.dir = direction > 0 ? 'fwd' : 'back';
      const rect = stage.getBoundingClientRect();
      flashEl.style.top = Math.round(rect.top + rect.height / 2 - 20) + 'px';
      flashEl.style.left = Math.round(direction > 0 ? rect.left + rect.width * 0.66 : rect.left + rect.width * 0.2) + 'px';
      flashEl.classList.add('is-on');
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => flashEl && flashEl.classList.remove('is-on'), FLASH_MS);
    } catch { /* 提示失败不影响跳转 */ }
  }

  function apply(delta) {
    const el = video();
    if (!el) return;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const current = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    let target = current + delta;
    if (duration) target = Math.min(duration - 0.25, target);
    target = Math.max(0, target);
    if (Math.abs(target - current) < 0.05) return;
    const wasPlaying = !el.paused;
    try {
      el.classList.add('is-seeking');
      if (typeof el.fastSeek === 'function') el.fastSeek(target);
      else el.currentTime = target;
      if (wasPlaying && el.paused) {
        const playing = el.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      }
    } catch { /* 极端情况下退回原生行为 */ }
    window.setTimeout(() => {
      try { el.classList.remove('is-seeking'); } catch { /* ignore */ }
    }, 260);
  }

  function step(delta) {
    if (!isOpen()) return false;
    const el = video();
    if (!el) return false;
    pending += delta;
    if (timer) return true;
    timer = window.setTimeout(() => {
      const total = pending;
      pending = 0;
      timer = 0;
      if (!total) return;
      apply(total);
      flash(total > 0 ? 1 : -1);
    }, MERGE_MS);
    return true;
  }

  function onKey(event) {
    if (!isOpen()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName || ''))) return;
    const key = event.key;
    let delta = 0;
    if (key === 'ArrowLeft' || key === 'j' || key === 'J') delta = -STEP_SECONDS;
    else if (key === 'ArrowRight' || key === 'l' || key === 'L') delta = STEP_SECONDS;
    if (!delta) return;
    if (!step(delta)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onDoubleClick(event) {
    if (!isOpen()) return;
    const stage = doc.querySelector('#playerStage');
    if (!stage || !stage.contains(event.target)) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    let delta = 0;
    if (ratio <= 0.3) delta = -STEP_SECONDS;
    else if (ratio >= 0.7) delta = STEP_SECONDS;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    step(delta);
  }

  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('dblclick', onDoubleClick, true);

  return function dispose() {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('dblclick', onDoubleClick, true);
    window.clearTimeout(timer);
    window.clearTimeout(flashTimer);
    try { flashEl?.remove(); } catch { /* ignore */ }
  };
}

export default initPlayerSkip;

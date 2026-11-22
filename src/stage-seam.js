const STYLE_ID = 'cf-stage-seam';
const ATTR = 'data-cf-seam';
const VAR = '--cf3-seam-top';
const MAX_SANE_TOP = 140;
const MIN_GAP_PX = 0.05;

const CSS = [
  'html[' + ATTR + '="1"] .cf3-stage {',
  '  top: var(' + VAR + ') !important;',
  '}',
].join('\n');

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return true;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);
  return true;
}

export function initStageSeam() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf69StageSeam === '1') return false;
  window.__cf69StageSeam = '1';

  injectStyle();

  const diag = { applied: 0, skipped: 0, lastTarget: null, lastGap: null, mode: 'idle' };
  let raf = 0;

  function measure() {
    try {
      const root = document.documentElement;
      const stage = document.querySelector('.cf3-stage');
      const titlebar = document.querySelector('.titlebar');
      if (!stage || !titlebar) {
        diag.skipped += 1;
        diag.mode = 'no-node';
        return false;
      }

      const stageRect = stage.getBoundingClientRect();
      const barRect = titlebar.getBoundingClientRect();
      if (stageRect.height < 1 || barRect.height < 1) {
        root.removeAttribute(ATTR);
        diag.mode = 'hidden';
        return false;
      }

      const host = stage.offsetParent || stage.parentElement;
      if (!host) {
        diag.skipped += 1;
        diag.mode = 'no-host';
        return false;
      }
      const hostRect = host.getBoundingClientRect();
      const hostBorder = parseFloat(getComputedStyle(host).borderTopWidth) || 0;
      const hostScroll = host.scrollTop || 0;
      const hostTop = hostRect.top + hostBorder - hostScroll;

      const target = barRect.bottom - hostTop;
      if (!Number.isFinite(target) || target < 0 || target > MAX_SANE_TOP) {
        diag.skipped += 1;
        diag.mode = 'insane';
        return false;
      }

      const rounded = Math.round(target * 100) / 100;
      const current = parseFloat(root.style.getPropertyValue(VAR));
      diag.lastGap = Math.round((stageRect.top - barRect.bottom) * 100) / 100;

      if (root.getAttribute(ATTR) === '1' && Number.isFinite(current) && Math.abs(current - rounded) < 0.05) {
        diag.mode = 'seamless';
        return true;
      }

      root.style.setProperty(VAR, rounded + 'px');
      root.setAttribute(ATTR, '1');
      diag.lastTarget = rounded;
      diag.applied += 1;
      diag.mode = 'aligned';
      return true;
    } catch {
      diag.skipped += 1;
      diag.mode = 'error';
      return false;
    }
  }

  let lastRun = 0;
  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      const now = performance.now();

      if (now - lastRun < 120) {
        window.setTimeout(schedule, 130);
        return;
      }
      lastRun = now;
      measure();
    });
  };

  schedule();

  for (const delay of [120, 420, 1200, 2600]) {
    window.setTimeout(() => {
      schedule();
    }, delay);
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('DOMContentLoaded', schedule);

  try {
    const titlebar = document.querySelector('.titlebar');
    if (titlebar && typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(schedule);
      observer.observe(titlebar);
      const shell = document.querySelector('.app-shell');
      if (shell) observer.observe(shell);
    }
  } catch {

  }

  try {
    const observer = new MutationObserver(schedule);

    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch {

  }

  window.__cf69StageSeamState = diag;
  window.__cf69StageSeamSync = schedule;
  return true;
}

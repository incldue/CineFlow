
const SKELETON_SELECTOR = '.skeleton, .cf25-skeleton, .skeleton-detail, .cf25-skeleton-row';
const FAST_WINDOW_MS = 100;
const FAST_TTL_MS = 5 * 60 * 1000;

export function initProgressGate() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf34ProgressGate === '1') return false;
  if (typeof MutationObserver !== 'function') return false;
  window.__cf34ProgressGate = '1';

  const diag = { shown: 0, suppressed: 0, fastSites: 0 };
  window.__cf34 = window.__cf34 || {};
  window.__cf34.gate = diag;

  /** containerKey -> 过期时间戳。命中即跳过 100ms 延迟。 */
  const fastContainers = new Map();
  const pending = new WeakMap();

  function containerKeyOf(node) {
    const container = node.parentElement;
    if (!container) return '';
    const id = container.id || '';
    const cls = typeof container.className === 'string' ? container.className : '';
    if (!id && !cls) return '';
    return id + '|' + cls.split(/\s+/).filter(Boolean).sort().join('.');
  }

  function markFast(key) {
    if (!key || fastContainers.has(key)) return;
    fastContainers.set(key, Date.now() + FAST_TTL_MS);
    diag.fastSites += 1;
  }

  function isFast(key) {
    if (!key) return false;
    const until = fastContainers.get(key);
    if (!until) return false;
    if (Date.now() > until) {
      fastContainers.delete(key);
      return false;
    }
    return true;
  }

  function register(node) {
    if (!(node instanceof Element)) return;
    if (!node.matches(SKELETON_SELECTOR)) return;
    if (node.dataset.cf34Gate) return;
    const key = containerKeyOf(node);
    if (isFast(key)) {
      // 已知秒回的容器：直接按「已显示」处理，不再走延迟
      node.dataset.cf34Gate = 'fast';
      return;
    }
    node.dataset.cf34Gate = 'armed';
    diag.shown += 1;
    pending.set(node, {
      key,
      startedAt: Date.now(),
      timer: window.setTimeout(() => {
        // 100ms 后仍在文档里 → 这是一个真正慢的请求，记录为「非秒回」
        const entry = pending.get(node);
        if (!entry) return;
        pending.delete(node);
        if (node.isConnected) node.dataset.cf34Gate = 'shown';
      }, FAST_WINDOW_MS)
    });
  }

  function retire(node) {
    const entry = pending.get(node);
    if (!entry) return;
    pending.delete(node);
    if (entry.timer) window.clearTimeout(entry.timer);
    if (Date.now() - entry.startedAt < FAST_WINDOW_MS) {
      // 插入后 100ms 内就被移除 —— 这是个秒回容器，下次同容器不再等
      diag.suppressed += 1;
      markFast(entry.key);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          register(node);
          node.querySelectorAll?.(SKELETON_SELECTOR).forEach(register);
        });
        record.removedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          retire(node);
          node.querySelectorAll?.(SKELETON_SELECTOR).forEach(retire);
        });
      }
    }
  });

  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (error) {
    console.warn('[CineFlow] 骨架屏门控装配失败，已跳过', error);
    return false;
  }

  // 已在 DOM 里的骨架屏按「已显示」处理，不参与秒回判定
  document.querySelectorAll(SKELETON_SELECTOR).forEach((node) => {
    node.dataset.cf34Gate = 'shown';
  });

  return true;
}

export const __cf34ProgressGateInternals = { SKELETON_SELECTOR, FAST_WINDOW_MS };

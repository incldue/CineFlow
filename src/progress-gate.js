/**
 * CineFlow 骨架屏门控（新增文件，零侵入）
 *
 * 出处：animeko ui-foundation/widgets/FastLinearProgressIndicator.kt
 *
 *   fun setVisible(visible, delayMillis = 100L, minimumDurationMillis = 1500)
 *   注释原文：「延迟 delayMillis 毫秒后才开始显示进度条. 如果在这个时间内 visible
 *   变为 false, 则不会显示进度条.」—— 也就是「100ms 内做完的事，不闪骨架屏」。
 *
 * CineFlow 的问题：本地/热缓存命中时搜索往往 40~90ms 就回来了，骨架屏却照常
 * 插入再移除，屏幕上闪一下 —— 观感上比等待更难受。
 *
 * 这里只搬「延迟展示」那一半。animeko 的 minimumDurationMillis = 1500 是故意
 * 拖慢以保证动效可读，与「极致迅速」冲突，有意不搬（记录在 RELEASE_NOTES）。
 *
 * 实现方式：纯 CSS 负责「延迟 100ms 再淡入」这条时间线（见 styles.css cf34 块
 * 的第一节），保证即使本模块整个失败，骨架屏也只是延迟 100ms 出现，不会消失。
 * 本模块只做一件 CSS 做不到的事：认出「这个容器第一次就是秒回」的站点，
 * 后续同类容器直接取消延迟，避免每次都白等 100ms。
 */

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

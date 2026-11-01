/**
 * CineFlow 交互细节补丁（新增文件，零侵入）
 *
 * 一次性提示 —— 对应 ui-foundation/widgets/OneshotTip.kt：
 * localStorage 记 key，只出现一次，不重复打扰。
 *
 * ⚠️ 滚轮劫持已移除（第五十一轮）。
 *    上一版曾在 document 上以 { passive: false, capture: true } 拦截 wheel，
 *    把纵向滚轮折算成轨道的 scrollLeft。实测代价：
 *      · non-passive 监听器在捕获链上 ⇒ 合成器每次滚轮都必须先等主线程跑完；
 *      · handler 内读 scrollWidth/clientWidth/scrollLeft 再写 scrollLeft ⇒ 每格滚轮一次强制重排；
 *      · 被折算出的 scrollLeft 变更又会惊动既有的 rail scroll 监听器。
 *    实测：鼠标停在轨道上滚轮，输入→首帧 p95 达 177.8ms（顶栏处仅 28.3ms），
 *    并伴随 568 次 DOM 变更。横向轨道的滚轮便利性完全不值得这个代价，故删除。
 *    横向轨道仍可用 Shift + 滚轮、触控板横向滑动或拖拽滚动条。
 */

const TIP_STORAGE_PREFIX = 'cf34-tip-';
const TIP_DURATION_MS = 2600;

export function initInteractionExtras() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf34Interaction === '1') return false;
  window.__cf34Interaction = '1';

  window.__cf34 = window.__cf34 || {};
  // railWheel 恒为 false：滚轮路径保持浏览器原生，不留任何非 passive 监听器
  window.__cf34.interaction = { railWheel: false, oneshotTip: true };
  return true;
}

/* ------------------------------------------------------------------
 * 一次性提示
 * ------------------------------------------------------------------ */
export function showOneshotTip(key, message) {
  try {
    if (!key || !message) return false;
    const storageKey = TIP_STORAGE_PREFIX + key;
    if (window.localStorage && window.localStorage.getItem(storageKey) === '1') return false;

    const tip = document.createElement('div');
    tip.className = 'cf34-oneshot-tip';
    tip.setAttribute('role', 'status');
    tip.textContent = message;
    document.body.appendChild(tip);

    window.requestAnimationFrame(() => {
      tip.classList.add('is-visible');
    });

    window.setTimeout(() => {
      tip.classList.remove('is-visible');
      window.setTimeout(() => tip.remove(), 260);
    }, TIP_DURATION_MS);

    try {
      window.localStorage.setItem(storageKey, '1');
    } catch (error) {
      /* 隐私模式下写不进去就算了 */
    }
    return true;
  } catch (error) {
    return false;
  }
}

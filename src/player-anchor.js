/**
 * CineFlow 3.4.8 · cf24 播放器定位守护（新增文件，零侵入）
 *
 * 背景：#app 上的 transform: translateZ(0) 让它成为 fixed 后代的包含块，
 * 而 #app 又是可被程序化滚动的溢出容器。播放时若焦点/scrollIntoView 把
 * #app 横向滚动推走，整块播放器会跟着左移，左半部分跑到窗口外。
 * CSS 覆盖层已把 #app 改为 overflow: clip 从根上禁止滚动；
 * 本模块再加一层运行期兜底：播放器开关时把 #app 的滚动位置归零，
 * 并锁定播放期间的横向滚动，任何异常路径都不会再让播放器偏离原位。
 * 全流程 try/catch，失败静默降级，绝不打断播放。
 */

const PLAYER_SELECTOR = '#playerModal';
const WATCH_ATTRS = ['class', 'style'];

export function initPlayerAnchor(deps = {}) {
  try {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return false;

    const app = doc.getElementById('app');
    const modal = doc.querySelector(PLAYER_SELECTOR);
    if (!app || !modal) return false;
    if (app.dataset.cf24Anchor === '1') return true;
    app.dataset.cf24Anchor = '1';

    let locked = false;

    const resetAppScroll = () => {
      try {
        if (app.scrollLeft !== 0) app.scrollLeft = 0;
      } catch { /* noop */ }
    };

    const isPlayerOpen = () =>
      doc.body.classList.contains('player-open') || modal.classList.contains('is-open');

    const sync = () => {
      try {
        const open = isPlayerOpen();
        if (open) resetAppScroll();
        if (open === locked) return;
        locked = open;
        // 播放期间彻底断掉 #app 的滚动能力，关闭后交还给基线样式
        app.style.overflow = open ? 'clip' : '';
      } catch { /* noop */ }
    };

    sync();

    try {
      const observer = new MutationObserver(() => sync());
      observer.observe(modal, { attributes: true, attributeFilter: WATCH_ATTRS });
      observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    } catch { /* 观察器不可用时仅保留一次性同步 */ }

    // 捕捉一切可能把 #app 推走的滚动请求（含焦点滚动、scrollIntoView、滚轮）
    const guard = () => {
      if (!isPlayerOpen()) return;
      resetAppScroll();
    };
    app.addEventListener('scroll', guard, { passive: true });
    doc.addEventListener('focusin', guard, true);
    doc.addEventListener('wheel', guard, { passive: true });
    try {
      const shell = doc.querySelector('.player-shell');
      shell?.addEventListener('scroll', guard, { passive: true });
    } catch { /* noop */ }

    return true;
  } catch (error) {
    try {
      console.warn('[CineFlow] 播放器定位守护装配失败，已跳过', error);
    } catch { /* noop */ }
    return false;
  }
}

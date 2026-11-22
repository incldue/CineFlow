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
      } catch {  }
    };

    const isPlayerOpen = () =>
      doc.body.classList.contains('player-open') || modal.classList.contains('is-open');

    const sync = () => {
      try {
        const open = isPlayerOpen();
        if (open) resetAppScroll();
        if (open === locked) return;
        locked = open;

        app.style.overflow = open ? 'clip' : '';
      } catch {  }
    };

    sync();

    try {
      const observer = new MutationObserver(() => sync());
      observer.observe(modal, { attributes: true, attributeFilter: WATCH_ATTRS });
      observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    } catch {  }

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
    } catch {  }

    return true;
  } catch (error) {
    try {
      console.warn('[CineFlow] 播放器定位守护装配失败，已跳过', error);
    } catch {  }
    return false;
  }
}

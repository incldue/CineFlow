const TIP_STORAGE_PREFIX = 'cf34-tip-';
const TIP_DURATION_MS = 2600;

export function initInteractionExtras() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf34Interaction === '1') return false;
  window.__cf34Interaction = '1';

  window.__cf34 = window.__cf34 || {};

  window.__cf34.interaction = { railWheel: false, oneshotTip: true };
  return true;
}

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

    }
    return true;
  } catch (error) {
    return false;
  }
}

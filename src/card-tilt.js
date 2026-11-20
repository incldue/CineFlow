
const RAIL_CARD = '.movie-rail .movie-card';
const LIT_CLASS = 'cf37-tilt';
const READY_FLAG = 'cf37CardTilt';
const MAX_RX = 5;
const MAX_RY = 6;
const MAX_COPY = 3;

let current = null;
let frame = 0;
let snapshot = null;
let bound = false;

const rectCache = new WeakMap();
let cacheEpoch = 0;

function rectOf(card) {
  const hit = rectCache.get(card);
  if (hit && hit.epoch === cacheEpoch) return hit.rect;
  const rect = card.getBoundingClientRect();
  rectCache.set(card, { epoch: cacheEpoch, rect });
  return rect;
}

function invalidateRects() {
  cacheEpoch += 1;
}

function reduced() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

function blocked() {
  try {
    const body = document.body;
    if (!body) return true;
    if (body.classList.contains('is-island-dragging')) return true;
    if (document.querySelector('.player-modal.is-open')) return true;
  } catch (error) {
    return true;
  }
  return false;
}

function clear(card) {
  if (!card) return;
  try {
    card.classList.remove(LIT_CLASS);
    card.style.removeProperty('--cf37-rx');
    card.style.removeProperty('--cf37-ry');
    card.style.removeProperty('--cf37-cx');
    card.style.removeProperty('--cf37-cy');
  } catch (error) {
    /* 节点已被替换等情况 */
  }
}

function reset() {
  clear(current);
  current = null;
  snapshot = null;
  frame = 0;
}

function apply() {
  frame = 0;
  const card = current;
  const shot = snapshot;
  if (!card || !shot) return;
  try {
    if (card.isConnected === false) { reset(); return; }
    card.classList.add(LIT_CLASS);
    const rx = shot.rx.toFixed(2);
    const ry = shot.ry.toFixed(2);
    const cx = shot.cx.toFixed(2);
    const cy = shot.cy.toFixed(2);
    if (rx !== shot._rx) { shot._rx = rx; card.style.setProperty('--cf37-rx', rx + 'deg'); }
    if (ry !== shot._ry) { shot._ry = ry; card.style.setProperty('--cf37-ry', ry + 'deg'); }
    if (cx !== shot._cx) { shot._cx = cx; card.style.setProperty('--cf37-cx', cx + 'px'); }
    if (cy !== shot._cy) { shot._cy = cy; card.style.setProperty('--cf37-cy', cy + 'px'); }
  } catch (error) {
    /* 装饰层失败不影响点击 */
  }
}

function schedule() {
  if (frame) return;
  try {
    frame = window.requestAnimationFrame(apply);
  } catch (error) {
    frame = window.setTimeout(apply, 16);
  }
}

function onPointerMove(event) {
  try {
    if (event.pointerType === 'touch') return;
    const target = event.target;
    const card = target instanceof Element ? target.closest(RAIL_CARD) : null;
    if (!card) { if (current) reset(); return; }
    if (reduced() || blocked()) { if (current) reset(); return; }

    if (current && current !== card) clear(current);

    const rect = rectOf(card);
    if (!rect.width || !rect.height) return;

    // -1 ~ 1，0 为卡片正中
    const nx = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height) * 2 - 1));

    current = card;
    snapshot = {
      rx: ny * MAX_RX,
      ry: -nx * MAX_RY,
      cx: -nx * MAX_COPY,
      cy: -ny * MAX_COPY
    };
    schedule();
  } catch (error) {
  }
}

function onPointerOut(event) {
  try {
    const card = current;
    if (!card) return;
    const related = event.relatedTarget;
    if (related instanceof Node && card.contains(related)) return;
    const x = event.clientX;
    const y = event.clientY;
    if (typeof x === 'number' && typeof y === 'number' && (x || y)) {
      const under = document.elementFromPoint(x, y);
      if (under && card.contains(under)) return;
    }
    reset();
  } catch (error) {
    /* 忽略 */
  }
}

function bind() {
  if (bound) return true;
  if (document.documentElement.dataset[READY_FLAG] === '1') return true;
  try {
    document.addEventListener('pointerover', (event) => {
      const t = event.target;
      if (t instanceof Element && t.closest(RAIL_CARD)) invalidateRects();
    }, { passive: true, capture: true });
    document.addEventListener('scroll', invalidateRects, { passive: true, capture: true });
    window.addEventListener('resize', invalidateRects, { passive: true });
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, { passive: true });
    document.addEventListener('pointercancel', reset, { passive: true });
    window.addEventListener('blur', reset);
    document.documentElement.dataset[READY_FLAG] = '1';
    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 卡片 3D 悬停跟随装配失败，已跳过', error); } catch (e) { /* 忽略 */ }
    return false;
  }
}
export function initCardTilt() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf37TiltInternals = { MAX_RX, MAX_RY, MAX_COPY };

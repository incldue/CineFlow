const CARD_SELECTOR = '.movie-card';
const LIT_CLASS = 'is-focus-lit';
const READY_FLAG = 'cf29PosterFocus';
const MAX_PARALLAX_PX = 7;
const MAX_DEPTH = 1;

let currentCard = null;
let frame = 0;
let snapshot = null;
let bound = false;

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function motionBlocked() {
  try {
    const body = document.body;
    if (!body) return true;
    if (body.classList.contains('is-motion-throttled')) return true;
    if (body.classList.contains('is-island-dragging')) return true;
    if (body.classList.contains('is-window-restoring')) return true;
  } catch {
    return true;
  }
  return false;
}

function clearCard(card) {
  if (!card) return;
  try {
    card.classList.remove(LIT_CLASS);
    card.style.removeProperty('--cf-fx');
    card.style.removeProperty('--cf-fy');
    card.style.removeProperty('--cf-fpx');
    card.style.removeProperty('--cf-fpy');
    card.style.removeProperty('--cf-fz');
  } catch {

  }
}

function reset() {
  clearCard(currentCard);
  currentCard = null;
  snapshot = null;
  frame = 0;
}

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

let tick = 0;

function apply() {
  frame = 0;
  if (tick) { try { window.clearTimeout(tick); } catch {  } tick = 0; }
  const card = currentCard;
  const shot = snapshot;
  if (!card || !shot) return;
  try {
    if (card.isConnected === false) { reset(); return; }
    card.classList.add(LIT_CLASS);
    const fx = shot.fx.toFixed(4);
    const fy = shot.fy.toFixed(4);
    const fpx = shot.fpx.toFixed(2) + 'px';
    const fpy = shot.fpy.toFixed(2) + 'px';
    const fz = shot.fz.toFixed(3);
    if (fx !== shot._fx) { shot._fx = fx; card.style.setProperty('--cf-fx', fx); }
    if (fy !== shot._fy) { shot._fy = fy; card.style.setProperty('--cf-fy', fy); }
    if (fpx !== shot._fpx) { shot._fpx = fpx; card.style.setProperty('--cf-fpx', fpx); }
    if (fpy !== shot._fpy) { shot._fpy = fpy; card.style.setProperty('--cf-fpy', fpy); }
    if (fz !== shot._fz) { shot._fz = fz; card.style.setProperty('--cf-fz', fz); }
  } catch {

  }
}

function scheduleApply() {
  if (frame || tick) return;
  try {
    frame = window.requestAnimationFrame(apply);
  } catch {
    frame = 0;
  }
  tick = window.setTimeout(() => {
    tick = 0;
    if (frame) { try { window.cancelAnimationFrame(frame); } catch {  } frame = 0; }
    apply();
  }, 60);
}

function onPointerMove(event) {
  try {
    if (event.pointerType === 'touch') return;
    if (prefersReducedMotion() || motionBlocked()) { if (currentCard) reset(); return; }

    const target = event.target;
    const card = target instanceof Element ? target.closest(CARD_SELECTOR) : null;
    if (!card) { if (currentCard) reset(); return; }

    if (currentCard && currentCard !== card) clearCard(currentCard);

    const rect = rectOf(card);
    if (!rect.width || !rect.height) return;

    const nx = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height) * 2 - 1));

    const fz = MAX_DEPTH * (1 - Math.min(1, Math.sqrt(nx * nx + ny * ny) / 1.414));

    currentCard = card;
    snapshot = {
      fx: nx,
      fy: ny,

      fpx: -nx * MAX_PARALLAX_PX,
      fpy: -ny * MAX_PARALLAX_PX,
      fz
    };

    scheduleApply();
  } catch {

  }
}

function onPointerOut(event) {
  try {
    const card = currentCard;
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
  } catch {

  }
}

function bind() {
  if (bound) return true;
  if (document.documentElement.dataset[READY_FLAG] === '1') return true;
  try {

    document.addEventListener('pointerover', (event) => {
      const t = event.target;
      if (t instanceof Element && t.closest(CARD_SELECTOR)) invalidateRects();
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
    try { console.warn('[CineFlow] 海报焦点动效装配失败，已跳过', error); } catch {  }
    return false;
  }
}

export function initPosterFocus() {
  try {
    if (!bind()) return false;
    if (prefersReducedMotion()) return true;
    return true;
  } catch {
    return false;
  }
}

export { reset as resetPosterFocus };

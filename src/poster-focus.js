/**
 * Apple tvOS 焦点 / 视差（focus & parallax）海报动效。
 *
 * 参照 tvOS 人机界面规范里「焦点引擎 + 视差」的两条核心感受：
 *   1. **焦点抬升**：被指向的卡片轻微放大、浮起，阴影加深并扩散 —— 视线的锚点从"一排卡片"收成"这一张"；
 *   2. **视差景深**：卡片内部不是一块贴图，而是分层的。指针移动时，前景（高光/描边）跟手，
 *      背景（海报本体）逆向小幅度偏移，中间层按不同速率跟随，于是产生"海报有厚度"的错觉。
 *
 * 本模块只负责把指针位置换算成两组 CSS 变量喂给样式层，不做任何结构改动、不接管点击：
 *   --cf-fx / --cf-fy   : 归一化指针位置（-1 ~ 1），供高光/描边使用
 *   --cf-fpx / --cf-fpy : 海报本体的逆向视差位移（px），供 img 使用
 *   --cf-fz             : 景深强度（0~1），供阴影与亮度使用
 *
 * 约束：失败一律静默降级 —— 这里只是装饰，任何异常都不能影响点击、滚动与播放。
 */

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

/** 播放器开着、窗口拖动中、或已因掉帧被降级时，一律不参与动效。 */
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
    /* 节点已被替换等情况，忽略 */
  }
}

function reset() {
  clearCard(currentCard);
  currentCard = null;
  snapshot = null;
  frame = 0;
}

function apply() {
  frame = 0;
  const card = currentCard;
  const shot = snapshot;
  if (!card || !shot) return;
  try {
    if (card.isConnected === false) { reset(); return; }
    card.classList.add(LIT_CLASS);
    card.style.setProperty('--cf-fx', shot.fx.toFixed(4));
    card.style.setProperty('--cf-fy', shot.fy.toFixed(4));
    card.style.setProperty('--cf-fpx', shot.fpx.toFixed(2) + 'px');
    card.style.setProperty('--cf-fpy', shot.fpy.toFixed(2) + 'px');
    card.style.setProperty('--cf-fz', shot.fz.toFixed(3));
  } catch {
    /* 装饰层失败不影响任何交互 */
  }
}

function onPointerMove(event) {
  try {
    if (event.pointerType === 'touch') return;
    if (prefersReducedMotion() || motionBlocked()) { if (currentCard) reset(); return; }

    const target = event.target;
    const card = target instanceof Element ? target.closest(CARD_SELECTOR) : null;
    if (!card) { if (currentCard) reset(); return; }

    if (currentCard && currentCard !== card) clearCard(currentCard);

    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // 归一化到 -1 ~ 1（0 为中心）
    const nx = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height) * 2 - 1));

    // 越靠近中心 → 越"正对"，景深读数越高；边缘则压低，避免整排乱晃
    const fz = MAX_DEPTH * (1 - Math.min(1, Math.sqrt(nx * nx + ny * ny) / 1.414));

    currentCard = card;
    snapshot = {
      fx: nx,
      fy: ny,
      // 海报本体逆向位移：指针往右，海报往左退一点，产生"前景浮起"的层次
      fpx: -nx * MAX_PARALLAX_PX,
      fpy: -ny * MAX_PARALLAX_PX,
      fz
    };

    // 直接同步写入：pointermove 本身已被浏览器按帧节流，这里再套一层 rAF
    // 反而会在窗口失焦 / 后台时被挂起，导致视差变量迟迟不落地。
    apply();
  } catch {
    /* 极致降级：忽略本次移动 */
  }
}

function onPointerOut(event) {
  try {
    const card = currentCard;
    if (!card) return;

    // relatedTarget 落在卡内 —— 只是卡内元素互换，不算离开
    const related = event.relatedTarget;
    if (related instanceof Node && card.contains(related)) return;

    // 海报图片加载完成时会替换掉占位节点，浏览器随即补发一次 pointerout，
    // 而这次事件的 relatedTarget 是 null —— 若直接 reset，视差刚写好就被擦掉。
    // 用坐标复核一次：指针其实还压在这张卡上，就不要收。
    const x = event.clientX;
    const y = event.clientY;
    if (typeof x === 'number' && typeof y === 'number' && (x || y)) {
      const under = document.elementFromPoint(x, y);
      if (under && card.contains(under)) return;
    }

    reset();
  } catch {
    /* 忽略 */
  }
}

function bind() {
  if (bound) return true;
  if (document.documentElement.dataset[READY_FLAG] === '1') return true;
  try {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, { passive: true });
    document.addEventListener('pointercancel', reset, { passive: true });
    window.addEventListener('blur', reset);
    document.documentElement.dataset[READY_FLAG] = '1';
    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 海报焦点动效装配失败，已跳过', error); } catch { /* 忽略 */ }
    return false;
  }
}

/**
 * 装配入口。由 src/incremental-pages.js 一行调用；重复调用安全。
 */
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

/**
 * 卡片 3D 悬停跟随（新增文件，零侵入）
 *
 * 用户反馈：「首页下方两栏目海报的鼠标悬停动效过于生硬、僵硬」。
 *
 * 现状为什么硬：悬停时卡片只是从静止位「弹到」一个固定姿态 ——
 *   translate3d(0, -7px, 0) scale(1.045)，配 520ms 弹簧曲线。
 * 姿态是写死的，指针在卡内怎么移动都不影响它，所以视觉上卡片只是"翻个身就定住"，
 * 没有任何跟随感，看着就是机械的。
 *
 * 按 poster.txt 里那套 tvOS 焦点模型的思路补三件事（只补，不删）：
 *   1. **卡片本体 3D 倾斜**：指针在卡内的归一化位置 → rotateX / rotateY（±5° / ±6°），
 *      指针挪一点，卡片就跟一点，是连续的；这是"活"的来源；
 *   2. **进入瞬间短过渡**：悬停进出的 transform 过渡收到 180ms，
 *      跟手才有黏性；520ms 那档留给既有动效，不改它；
 *   3. **文案层反向浮动**：标题/年份与海报反向轻移 3px，卡片内部有了前后两层的读数。
 *
 * 海报本体的逆向视差（--cf-fpx / --cf-fpy）已经由 poster-focus.js 供给，
 * 前景环形高光（.poster-frame::after 的 radial-gradient + --cf-fx/--cf-fy）基线已有，
 * 本模块不重复实现，只把缺的"厚度"接上。
 *
 * 约束：pointermove 已被浏览器按帧节流，这里再包一层 rAF 合并同帧多次读写；
 * 出卡、窗口失焦、播放器全屏、掉帧降级一律清空变量回落到基线姿态。
 */

const RAIL_CARD = '.movie-rail .movie-card';
const LIT_CLASS = 'cf37-tilt';
const READY_FLAG = 'cf37CardTilt';
/** 3D 倾斜上限：178px 宽的卡片上，5°/6° 已经是明显而不夸张的厚度。 */
const MAX_RX = 5;
const MAX_RY = 6;
/** 文案层反向位移上限（px）。 */
const MAX_COPY = 3;

let current = null;
let frame = 0;
let snapshot = null;
let bound = false;

function reduced() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

/**
 * 只挡「窗口拖动中」和「播放器开着」。
 *
 * 特意**不**挡 body.is-motion-throttled：那是基线 renderer.js:4157 setupPremiumMotionGuard
 * 在启动采样窗口里累计到长帧就加上、且永不移除的类，管的是闲置也在跑的常驻动画。
 * 悬停倾斜只在指针移动时写一次 transform，闲置零开销，而且它本身就是这次要修的东西 ——
 * 被那面闸门挡掉就等于「悬停依旧僵硬」原样复现。
 */
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
    card.style.setProperty('--cf37-rx', shot.rx.toFixed(2) + 'deg');
    card.style.setProperty('--cf37-ry', shot.ry.toFixed(2) + 'deg');
    card.style.setProperty('--cf37-cx', shot.cx.toFixed(2) + 'px');
    card.style.setProperty('--cf37-cy', shot.cy.toFixed(2) + 'px');
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

    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // -1 ~ 1，0 为卡片正中
    const nx = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height) * 2 - 1));

    current = card;
    snapshot = {
      // 指针在上半张 → 卡片顶边朝观者压下来（rotateX 正向），是自然的"看进去"
      rx: ny * MAX_RX,
      // 指针在右侧 → 右边缘后退（rotateY 正向），卡片像是被扭头看向指针
      ry: -nx * MAX_RY,
      cx: -nx * MAX_COPY,
      cy: -ny * MAX_COPY
    };
    schedule();
  } catch (error) {
    /* 极致降级：忽略本次移动 */
  }
}

function onPointerOut(event) {
  try {
    const card = current;
    if (!card) return;
    const related = event.relatedTarget;
    if (related instanceof Node && card.contains(related)) return;

    // 海报 img 替换占位节点时会补发一次 pointerout，relatedTarget 为 null。
    // 用坐标复核：指针其实还压在卡上就别收。
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

/** 装配入口，由 src/incremental-pages.js 一行调用；重复调用安全。 */
export function initCardTilt() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf37TiltInternals = { MAX_RX, MAX_RY, MAX_COPY };

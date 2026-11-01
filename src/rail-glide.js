/**
 * 栏目指针感应滑动（新增文件，零侵入）
 *
 * 用户诉求（第七版）：
 *   · 首页下方两个栏目「根据你的喜好推荐 / 正在热映与高分片单」不要再出现横向滚动条；
 *   · 鼠标移到栏目左右边缘的海报上时，栏目自己丝滑地往中间滑；
 *   · 松手/移开后自动吸附到最近的一张海报。
 *
 * 做法：
 *   1. 给这两个轨道加 cf37-glide 类 —— CSS 里把 scrollbar 宽度归零（Chromium 的
 *      scrollbar-width: none + ::-webkit-scrollbar { display:none } 双保险），不再占 17px 高；
 *   2. 只在指针真的落在轨道矩形内、且落在左右 EDGE 带里才滑；
 *      速度按「贴边深度」二次曲线上升（深度²），中心是死区 —— 非线性才有"吸过去"的感觉，
 *      线性速度会像被人拖着走，那是生硬；
 *   3. 速度不是瞬间赋值，而是按 ACCEL_MS 爬升/衰减，停下时再用手感缓出吸附到最近一张：
 *      吸附目标 = round(scrollLeft / 卡片节距) × 卡片节距，节距取自前两张卡的 offsetLeft 差，
 *      所以 178px 卡 + 16px gap、或 mini 轨道的 138px 卡都能自动对上，不用写死尺寸；
 *   4. 滑行期间给轨道加 cf37-gliding，把 scroll-snap-type 临时置 none（原生 proximity 吸附会
 *      和我们的写入打架，导致一顿一顿），吸附结束再交还原生吸附；
 *   5. 滚轮 / 拖拽 / 展开网格（is-expanded）时立即让位，绝不抢用户的输入。
 *
 * 已经验证过不会被打破的东西：
 *   · 滚轮横向滚动（interaction-extras）—— wheel 事件里直接放行，还顺手把滑行停掉；
 *   · poster-focus 的卡片内视差 —— 我们只写 rail.scrollLeft，不碰卡片 transform；
 *   · motion-scheduler 的读写分离 —— 本模块自己的 rAF 只写 scrollLeft，不读样式。
 */

const RAIL_SELECTOR = '.content-section .movie-rail';
const GLIDE_CLASS = 'cf37-glide';
const GLIDING_CLASS = 'cf37-gliding';
const SCAN_LIMIT = 8;

/** 边缘感应带：轨道宽度的 16%，夹在 56~170px 之间（1280 宽下约 170px，正好两张卡）。 */
const EDGE_RATIO = 0.16;
const EDGE_MIN = 56;
const EDGE_MAX = 170;
/** 边缘带内侧再留 6px 松弛，指针刚好压在卡片边框上也认。 */
const EDGE_SLACK = 6;

const MIN_SPEED = 240;
const MAX_SPEED = 1750;
const ACCEL_MS = 130;
const SNAP_MS = 240;
const SNAP_MS_REDUCED = 1;

const states = new Set();
let raf = 0;
let lastTs = 0;
let bound = false;
let scanTimer = 0;
const diag = { rails: 0, glides: 0, snaps: 0, writes: 0 };

function now() {
  try {
    return window.performance.now();
  } catch (error) {
    return Date.now();
  }
}

function reduced() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

/**
 * 只挡「窗口正在被拖动」这一种。
 *
 * 特意**不**挡 body.is-motion-throttled：那个类是基线 renderer.js 的启动帧守卫
 * （setupPremiumMotionGuard，采样窗口内累计够长的长帧就加上，且永不移除），
 * 针对的是「闲置也在跑」的常驻装饰动画（英雄区视差、premium 光泽）。
 * 本模块只在指针停在边缘时才有写入，指针一走就停，闲置零开销 ——
 * 用那面闸门会把用户要的功能一起关掉（软件渲染 / 老显卡上尤其明显）。
 */
function blocked() {
  try {
    const body = document.body;
    if (!body) return true;
    if (body.classList.contains('is-island-dragging')) return true;
  } catch (error) {
    return true;
  }
  return false;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** 卡片节距：前两张卡的 offsetLeft 差。取不到就退化成第一张卡的宽度 + 16。 */
function pitchOf(rail) {
  try {
    const card = rail.querySelector('.movie-card');
    if (!card) return 0;
    const next = card.nextElementSibling;
    if (next) {
      const delta = next.offsetLeft - card.offsetLeft;
      if (delta > 8) return delta;
    }
    const width = card.offsetWidth;
    return width > 8 ? width + 16 : 0;
  } catch (error) {
    return 0;
  }
}

function schedule() {
  if (raf) return;
  try {
    raf = window.requestAnimationFrame(frame);
  } catch (error) {
    raf = window.setTimeout(() => frame(now()), 16);
  }
}

function stepSnap(state, ts) {
  const rail = state.rail;
  if (!rail.isConnected) return false;
  const total = reduced() ? SNAP_MS_REDUCED : SNAP_MS;
  if (!state.snapStart) state.snapStart = ts;
  const progress = total <= 0 ? 1 : Math.min(1, (ts - state.snapStart) / total);
  const eased = 1 - Math.pow(1 - progress, 3);
  const value = state.snapFrom + (state.snapTo - state.snapFrom) * eased;
  try {
    rail.scrollLeft = value;
    diag.writes += 1;
  } catch (error) {
    /* 忽略 */
  }
  if (progress >= 1) {
    state.snapping = false;
    state.snapStart = 0;
    try { rail.classList.remove(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
    return false;
  }
  return true;
}

function stepGlide(state, dt) {
  const rail = state.rail;
  if (!rail.isConnected) return false;

  const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
  const desired = state.desired;

  // 速度爬升/衰减：直接赋速度会"蹭"地一下起步，非常生硬
  const blend = Math.min(1, (dt * 1000) / ACCEL_MS);
  state.velocity += (desired - state.velocity) * blend;

  if (Math.abs(state.velocity) < 3 && Math.abs(desired) < 3) {
    state.velocity = 0;
    state.gliding = false;
    return false;
  }

  let next = rail.scrollLeft + state.velocity * dt;
  if (next <= 0) { next = 0; state.velocity = 0; state.desired = 0; state.gliding = false; }
  if (next >= max) { next = max; state.velocity = 0; state.desired = 0; state.gliding = false; }

  try {
    rail.scrollLeft = next;
    diag.writes += 1;
  } catch (error) {
    state.gliding = false;
    return false;
  }

  if (!state.gliding) return false;
  return true;
}

function frame(ts) {
  raf = 0;
  const at = Number.isFinite(ts) ? ts : now();
  const dt = lastTs ? Math.min(0.064, Math.max(0.004, (at - lastTs) / 1000)) : 0.0167;
  lastTs = at;

  let busy = false;
  for (const state of states) {
    if (state.snapping) {
      if (stepSnap(state, at)) busy = true;
      continue;
    }
    if (!state.gliding) continue;
    if (stepGlide(state, dt)) busy = true;
    else startSnap(state, false);
  }

  if (busy) {
    schedule();
  } else {
    lastTs = 0;
  }
}

function startSnap(state, force = true) {
  const rail = state.rail;
  if (!rail.isConnected) return;
  state.gliding = false;
  state.desired = 0;
  state.velocity = 0;
  if (state.snapping && !force) return;
  if (state.wheelUntil && now() < state.wheelUntil) return;    // 滚轮刚动过，交给原生吸附

  const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
  const pitch = pitchOf(rail);
  if (!pitch || max <= 1) return;

  const current = rail.scrollLeft;
  const target = clamp(Math.round(current / pitch) * pitch, 0, max);
  if (Math.abs(target - current) < 0.8) {
    try { rail.classList.remove(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
    return;
  }

  state.snapFrom = current;
  state.snapTo = target;
  state.snapStart = 0;
  state.snapping = true;
  diag.snaps += 1;
  try { rail.classList.add(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
  schedule();
}

function stopGlide(state, snap = true) {
  if (!state.gliding) {
    if (snap && state.velocity) startSnap(state, false);
    return;
  }
  state.gliding = false;
  state.desired = 0;
  if (snap) startSnap(state, false);
}

function evaluate(state, event) {
  const rail = state.rail;
  if (!rail.isConnected) { states.delete(state); return; }
  if (blocked()) { stopGlide(state, false); return; }
  if (rail.classList.contains('is-expanded')) { stopGlide(state, false); return; }
  if (state.dragUntil && now() < state.dragUntil) { stopGlide(state, false); return; }

  const rect = rail.getBoundingClientRect();
  const x = event.clientX;
  const y = event.clientY;
  const inside = x >= rect.left - EDGE_SLACK && x <= rect.right + EDGE_SLACK
    && y >= rect.top - EDGE_SLACK && y <= rect.bottom + EDGE_SLACK;

  if (!inside) {
    state.hovering = false;
    stopGlide(state, true);
    return;
  }

  state.hovering = true;

  if (state.wheelUntil && now() < state.wheelUntil) { stopGlide(state, false); return; }

  const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
  if (max <= 1) return;                                  // 不溢出，没什么可滑

  const edge = clamp(rect.width * EDGE_RATIO, EDGE_MIN, EDGE_MAX);
  const fromLeft = x - rect.left;
  const fromRight = rect.right - x;

  let dir = 0;
  let depth = 0;
  if (fromLeft < edge) {
    dir = -1;
    depth = 1 - Math.max(0, fromLeft) / edge;
  } else if (fromRight < edge) {
    dir = 1;
    depth = 1 - Math.max(0, fromRight) / edge;
  }

  if (!dir || depth <= 0) { stopGlide(state, true); return; }

  // 已经到头的方向不再滑，避免"贴着边空转"
  if (dir < 0 && rail.scrollLeft <= 0.5) { stopGlide(state, true); return; }
  if (dir > 0 && rail.scrollLeft >= max - 0.5) { stopGlide(state, true); return; }

  // 深度²：手停在边缘最外侧时快，往中间挪一点就明显变慢 —— 这是"吸附手感"的来源
  const eased = depth * depth;
  state.desired = dir * (MIN_SPEED + eased * (MAX_SPEED - MIN_SPEED));

  if (state.snapping) {
    state.snapping = false;
    state.snapStart = 0;
  }
  if (!state.gliding) {
    state.gliding = true;
    diag.glides += 1;
    try { rail.classList.add(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
  }
  schedule();
}

function onPointerMove(event) {
  try {
    if (event.pointerType === 'touch') return;
    for (const state of Array.from(states)) evaluate(state, event);
  } catch (error) {
    /* 装饰层失败不影响交互 */
  }
}

function onPointerLeave() {
  try {
    for (const state of states) {
      state.hovering = false;
      stopGlide(state, true);
    }
  } catch (error) {
    /* 忽略 */
  }
}

function arm(rail) {
  if (!(rail instanceof HTMLElement)) return;
  if (states.has(rail.__cf37State) && rail.__cf37State) return;

  const state = {
    rail,
    hovering: false,
    gliding: false,
    snapping: false,
    desired: 0,
    velocity: 0,
    snapFrom: 0,
    snapTo: 0,
    snapStart: 0,
    dragUntil: 0,
    wheelUntil: 0
  };

  rail.__cf37State = state;
  states.add(state);
  diag.rails += 1;

  try { rail.classList.add(GLIDE_CLASS); } catch (error) { /* 忽略 */ }

  // 滚轮：让位给已有的横向滚动，并且短时间内不要吸附（原生 proximity 自己在做）
  rail.addEventListener('wheel', () => {
    state.wheelUntil = now() + 700;
    state.gliding = false;
    state.desired = 0;
    try { rail.classList.remove(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
  }, { passive: true });

  // 按下（拖拽 / 点击海报）：立刻停，松手 600ms 内不接管
  rail.addEventListener('pointerdown', () => {
    state.dragUntil = now() + 600;
    state.gliding = false;
    state.desired = 0;
    state.velocity = 0;
    try { rail.classList.remove(GLIDING_CLASS); } catch (error) { /* 忽略 */ }
  }, { passive: true });

  // 键盘聚焦到卡片时也吸附一下，方向键浏览不至于停在半张卡上
  rail.addEventListener('focusin', () => startSnap(state, true), { passive: true });
}

function scan() {
  try {
    const rails = Array.from(document.querySelectorAll(RAIL_SELECTOR)).slice(0, SCAN_LIMIT);
    for (const rail of rails) {
      if (rail.classList.contains('is-expanded')) continue;
      if (rail.closest('.cf3-page')) continue;          // 片库是网格，不参与
      if (rail.scrollWidth - rail.clientWidth <= 1 && !rail.__cf37State) continue;
      arm(rail);
    }
  } catch (error) {
    /* 忽略 */
  }
}

function scheduleScan() {
  if (scanTimer) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = 0;
    scan();
  }, 400);
}

function bind() {
  if (bound) return true;
  try {
    scan();
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    window.addEventListener('blur', onPointerLeave);
    window.addEventListener('resize', () => {
      for (const state of states) startSnap(state, true);
    }, { passive: true });

    const app = document.getElementById('app');
    if (app) {
      new MutationObserver(scheduleScan).observe(app, { childList: true, subtree: true });
    }
    window.setTimeout(scan, 1500);
    window.setTimeout(scan, 4200);

    window.__cf37 = {
      get glide() { return { ...diag, live: states.size }; },
      rescan: scan
    };
    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 栏目指针感应滑动装配失败，已跳过', error); } catch (e) { /* 忽略 */ }
    return false;
  }
}

/** 装配入口，由 src/incremental-pages.js 一行调用；重复调用安全。 */
export function initRailGlide() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf37GlideInternals = { EDGE_RATIO, EDGE_MIN, EDGE_MAX, MIN_SPEED, MAX_SPEED, SNAP_MS, pitchOf };

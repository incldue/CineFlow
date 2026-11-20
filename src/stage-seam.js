/**
 * CineFlow · 舞台上沿对齐（第六十九轮 · 新增文件，零侵入基线）
 *
 * 现象：片库页 / 播放历史页与顶栏之间有一条细缝。
 *
 * 根因在基线 src/page-transition.js 的 syncLayerTop()：
 *     layer.style.top = Math.round(titlebar.offsetHeight) + 2 + 'px'
 * 两个问题叠在一起：
 *   1. offsetHeight 是取整过的整数（实测顶栏 71.38px 被取成 71）；
 *   2. 那个 +2 是给「舞台留出安全边」的旧余量。
 * 于是舞台实际顶边落在 73px，而顶栏真正的底边在 72.7px —— 中间 1.62px 什么都没有，
 * 露出的是下层页面底色，看起来就是一条缝。DPR 1.75 下这是将近 3 个物理像素。
 *
 * 修法：不去改基线（那是硬约束），而是让舞台的 top 由一条 CSS 变量决定，
 * 变量值每次布局变化后重新测量「顶栏底边」反推出来：
 *
 *     target = 当前 top - (舞台 rect.top - 顶栏 rect.bottom)
 *
 * 这个式子是自洽的不动点：一旦对齐，等号右边就不再变化，不会来回抖。
 * 用 !important 覆盖基线的内联 style.top（内联非 important 永远输给样式表 important）。
 *
 * 同时保留基线原意：只有当测量值合理（0 ~ 140px、舞台可见）时才接管，
 * 否则整条规则不生效，退回基线的 +2 行为。全程 try/catch。
 */

const STYLE_ID = 'cf-stage-seam';
const ATTR = 'data-cf-seam';
const VAR = '--cf3-seam-top';
const MAX_SANE_TOP = 140;
const MIN_GAP_PX = 0.05;

const CSS = [
  'html[' + ATTR + '="1"] .cf3-stage {',
  '  top: var(' + VAR + ') !important;',
  '}',
].join('\n');

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return true;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);
  return true;
}

export function initStageSeam() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf69StageSeam === '1') return false;
  window.__cf69StageSeam = '1';

  injectStyle();

  const diag = { applied: 0, skipped: 0, lastTarget: null, lastGap: null, mode: 'idle' };
  let raf = 0;

  function measure() {
    try {
      const root = document.documentElement;
      const stage = document.querySelector('.cf3-stage');
      const titlebar = document.querySelector('.titlebar');
      if (!stage || !titlebar) {
        diag.skipped += 1;
        diag.mode = 'no-node';
        return false;
      }

      const stageRect = stage.getBoundingClientRect();
      const barRect = titlebar.getBoundingClientRect();
      if (stageRect.height < 1 || barRect.height < 1) {
        root.removeAttribute(ATTR);
        diag.mode = 'hidden';
        return false;
      }

      /* 绝对量法：直接由「顶栏底边」减「舞台定位父级的内边盒顶边」算出目标 top。
         这样做的好处是不依赖舞台自己当前的 top —— 上一版用
         「当前 top - 实测缝隙」，一旦舞台的 top 带 CSS 过渡，量到的是过渡中途的
         值，写回去又触发下一帧重算，形成来回摆动（实测 top 在 71.26 / 73.12 之间
         翻面、缝隙 1.74px 反而变大）。绝对量法没有反馈回路，一次收敛。 */
      const host = stage.offsetParent || stage.parentElement;
      if (!host) {
        diag.skipped += 1;
        diag.mode = 'no-host';
        return false;
      }
      const hostRect = host.getBoundingClientRect();
      const hostBorder = parseFloat(getComputedStyle(host).borderTopWidth) || 0;
      const hostScroll = host.scrollTop || 0;
      const hostTop = hostRect.top + hostBorder - hostScroll;

      const target = barRect.bottom - hostTop;
      if (!Number.isFinite(target) || target < 0 || target > MAX_SANE_TOP) {
        diag.skipped += 1;
        diag.mode = 'insane';
        return false;
      }

      const rounded = Math.round(target * 100) / 100;
      const current = parseFloat(root.style.getPropertyValue(VAR));
      diag.lastGap = Math.round((stageRect.top - barRect.bottom) * 100) / 100;

      if (root.getAttribute(ATTR) === '1' && Number.isFinite(current) && Math.abs(current - rounded) < 0.05) {
        diag.mode = 'seamless';
        return true;
      }

      root.style.setProperty(VAR, rounded + 'px');
      root.setAttribute(ATTR, '1');
      diag.lastTarget = rounded;
      diag.applied += 1;
      diag.mode = 'aligned';
      return true;
    } catch {
      diag.skipped += 1;
      diag.mode = 'error';
      return false;
    }
  }

  let lastRun = 0;
  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      const now = performance.now();
      /* 120ms 去抖：滚动时 body 的 cf33-scroll 会反复翻转，
         每次翻转都重量一遍没必要，但也不能漏掉真正的布局变化。 */
      if (now - lastRun < 120) {
        window.setTimeout(schedule, 130);
        return;
      }
      lastRun = now;
      measure();
    });
  };

  schedule();
  /* 首屏布局有三段异步：splash 拆除、字体落位、首屏图片解码。
     跟进这几个时间点，保证最终值是量出来的而不是猜的。 */
  for (const delay of [120, 420, 1200, 2600]) {
    window.setTimeout(() => {
      schedule();
    }, delay);
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('DOMContentLoaded', schedule);

  try {
    const titlebar = document.querySelector('.titlebar');
    if (titlebar && typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(schedule);
      observer.observe(titlebar);
      const shell = document.querySelector('.app-shell');
      if (shell) observer.observe(shell);
    }
  } catch {
    /* ignore */
  }

  /* 基线在每次切页/滚动补偿时会重写 style.top，这里跟着它重测：
     只在切换类翻转时触发，不引入任何逐帧监听。 */
  try {
    const observer = new MutationObserver(schedule);
    /* 只盯 body 的 class（切页 / 滚动补偿会改它）。
       绝不能盯 documentElement 的 style —— 我们自己就是往那里写变量的，
       那会变成「写→观察→再写」的闭环（实测帧率直接掉到 2）。 */
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch {
    /* ignore */
  }

  window.__cf69StageSeamState = diag;
  window.__cf69StageSeamSync = schedule;
  return true;
}

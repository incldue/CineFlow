/**
 * CineFlow 定时器治理（新增文件，零侵入）
 *
 * 现状：stability-guard.js 已经 patch 过 window.setInterval，但只在 document.hidden
 * 时跳过那一个"空轨道轮询"。窗口可见但失焦、以及滚动/切页进行中，其余 8 个常驻
 * 轮询仍在跑：douban-fallback(1200) / motion-perf(400, 700) / tmdb-wizard(400, poll) /
 * cast-panel / update-bubble / dual-search(500) / renderer 搜索提示词轮换(3600)。
 *
 * 这里按 animeko ui-foundation/layout/CarouselAutoAdvanceEffect.kt 的三重门控思路
 * （repeatOnLifecycle(RESUMED) + snapshotFlow{ isScrollInProgress } + 状态翻转才重启）
 * 落成 DOM 版：维护一组 reason，任一成立时让被托管的回调直接返回。
 *
 * 关键约束：
 *   · 只 return 回调，绝不 clearInterval —— 定时器本身保留，恢复时不重建、不漂移；
 *   · 链式叠加，保存并调用上一层 setInterval，绝不替换别人的实现；
 *   · 整体 try/catch，任何一步失败都完全退回原行为。
 *
 * 复用已有信号，零新增高频监听：
 *   hidden    → document.visibilityState
 *   blurred   → window blur/focus + 1500ms 无交互延迟（看视频时不会误伤）
 *   scrolling → body.cf33-scroll（response-boost.js 已在维护）
 *   switching → body.cf3-switching（page-transition.js 已在维护）
 */

const BLUR_GRACE_MS = 1500;
const SWITCH_HARD_TIMEOUT_MS = 1200;

const SCROLL_CLASS = 'cf33-scroll';
const SWITCH_CLASS = 'cf3-switching';

export function initTimerGovernor() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf34TimerGovernor === '1') return false;
  window.__cf34TimerGovernor = '1';

  const diag = {
    hidden: false,
    blurred: false,
    scrolling: false,
    switching: false,
    skipped: 0,
    ran: 0
  };
  window.__cf34 = window.__cf34 || {};
  window.__cf34.governor = diag;

  try {
    patchSetInterval(diag);
    watchReasons(diag);
  } catch (error) {
    console.warn('[CineFlow] 定时器治理装配失败，已跳过', error);
    return false;
  }
  return true;
}

let switchingSince = 0;

/**
 * 每次 tick 现读，不缓存 —— 状态翻转本身就是事件，没必要再造一个采样定时器。
 * 两次 classList.contains 的成本可以忽略，而缓存会让「滚动已开始但采样还没跑」
 * 的那 250ms 漏掉。
 */
function anyReasonActive(diag) {
  try {
    diag.hidden = document.visibilityState === 'hidden';
    const body = document.body;
    const scrolling = Boolean(body && body.classList.contains(SCROLL_CLASS));
    let switching = Boolean(body && body.classList.contains(SWITCH_CLASS));
    if (switching) {
      if (!switchingSince) switchingSince = Date.now();
      else if (Date.now() - switchingSince > SWITCH_HARD_TIMEOUT_MS) {
        // 硬超时：cf3-switching 万一因异常残留，不让定时器永久停摆
        switching = false;
        switchingSince = 0;
      }
    } else {
      switchingSince = 0;
    }
    diag.scrolling = scrolling;
    diag.switching = switching;
  } catch (error) {
    /* 读状态失败按「无 reason」处理，宁可多跑 */
  }
  return diag.hidden || diag.blurred || diag.scrolling || diag.switching;
}

function patchSetInterval(diag) {
  const previousSetInterval = window.setInterval;
  const previousClearInterval = window.clearInterval;
  const hosted = new WeakSet();

  window.setInterval = function governedSetInterval(handler, delay, ...rest) {
    if (typeof handler !== 'function') {
      return previousSetInterval.call(window, handler, delay, ...rest);
    }
    if (hosted.has(handler)) {
      return previousSetInterval.call(window, handler, delay, ...rest);
    }

    const guarded = function governedTick(...args) {
      try {
        if (anyReasonActive(diag)) {
          diag.skipped += 1;
          return undefined;
        }
        diag.ran += 1;
      } catch (error) {
        /* 诊断失败也要照常跑 */
      }
      try {
        return handler.apply(this, args);
      } catch (error) {
        return undefined;
      }
    };

    // 让 clearInterval 能认出包装后的句柄与原始 handler
    try {
      Object.defineProperty(guarded, 'cf34Original', { value: handler, configurable: true });
    } catch (error) {
      /* 忽略 */
    }
    hosted.add(handler);
    hosted.add(guarded);

    return previousSetInterval.call(window, guarded, delay, ...rest);
  };

  window.clearInterval = function governedClearInterval(id) {
    return previousClearInterval.call(window, id);
  };
}

function watchReasons(diag) {
  const sample = () => {
    try {
      diag.hidden = document.visibilityState === 'hidden';
    } catch (error) {
      /* 忽略 */
    }
  };

  // hidden
  document.addEventListener(
    'visibilitychange',
    () => {
      sample();
    },
    { capture: true, passive: true }
  );

  // blurred：失焦后延迟 BLUR_GRACE_MS 才生效，期间任何交互立刻复位
  let blurTimer = 0;
  const clearBlurTimer = () => {
    if (blurTimer) {
      window.clearTimeout(blurTimer);
      blurTimer = 0;
    }
  };
  const armBlur = () => {
    clearBlurTimer();
    blurTimer = window.setTimeout(() => {
      blurTimer = 0;
      diag.blurred = true;
      sample();
    }, BLUR_GRACE_MS);
  };
  const releaseBlur = () => {
    clearBlurTimer();
    diag.blurred = false;
    sample();
  };

  window.addEventListener('blur', armBlur, { passive: true });
  window.addEventListener('focus', releaseBlur, { passive: true });
  document.addEventListener('pointerdown', releaseBlur, { capture: true, passive: true });
  document.addEventListener('keydown', releaseBlur, { capture: true, passive: true });
  document.addEventListener('focusin', releaseBlur, { capture: true, passive: true });

  // 首帧先采一次，避免启动期就带错状态
  sample();
  return true;
}
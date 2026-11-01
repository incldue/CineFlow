/**
 * CineFlow 滑动流畅度补丁（新增文件，零侵入）
 *
 * 三件事，全部是"减少每帧工作量"，不动任何既有动效的观感：
 *
 *   1) 顶栏高度同步
 *      搜索页 .cf25-hub 的 top 是硬编码 76px，而顶栏实际高 71.38px + #app 边框 1.32px
 *      = 72.7px，于是留下 4.6px 缝隙。这里把顶栏真实高度写进 --cf-titlebar-h，
 *      让搜索页贴着顶栏下沿。
 *
 *   2) 海报 blur-up 收尾
 *      上一轮 blur-up 的终点是 filter: blur(0)。blur(0) 依然是 filter —— 浏览器仍要走
 *      滤镜通道，图片无法进入普通光栅缓存，横向滑动时每帧都要重新合成。
 *      这里在淡入结束后补 .cf30-sharp，把 filter 彻底置为 none。
 *
 *   3) 滚动期减负
 *      轨道边缘的 mask-image 会把整个滚动容器并成一层带遮罩的图层，滚动时整条轨道
 *      每帧重新光栅化；卡片上的 transform/box-shadow/border 过渡与柔光动画也在抢主线程。
 *      滚动开始 → 挂 .cf30-scrolling（撤 mask、关过渡），静息 120ms 后摘掉还原。
 *      边缘渐隐在静止时出现、滑动时让位，是流媒体端一贯的做法。
 *
 * 所有逻辑都在模块内部 try/catch，任何一步失败都不影响滚动与点击。
 */

const RAIL_SCROLL_CLASS = 'cf30-scrolling';
const SHARP_CLASS = 'cf30-sharp';
/* 第五十一轮：轨道滚动的静息窗口从 120ms 拉到 320ms。
 * 滚轮是一格一格来的，格与格之间常常超过 120ms —— 类名被摘了又加，
 * 每一次都是整条轨道的样式重算 + 重新光栅化。320ms 足够跨过两格间隙，
 * 停下后照样恢复，静止观感一点没变。 */
const RAIL_IDLE_MS = 320;

/* ------------------------------------------------------------------
 * 1 · 顶栏高度 → --cf-titlebar-h
 * ------------------------------------------------------------------ */
/**
 * 找一个 position: fixed 元素的真实包含块。
 *
 * CSS 规定：祖先只要有 transform / filter / perspective 或相应的 will-change，
 * 就会成为 fixed 后代的包含块。本项目的 main.app-shell 在过渡期带 transform + filter，
 * 于是搜索页 .cf25-hub 的 top 会相对 app-shell 而不是视口 —— 这就是那条缝隙的根因。
 * 这里按同一套规则回溯，拿到当前真正生效的包含块。
 */
function findContainingBlock(el) {
  let node = el?.parentElement || null;
  while (node && node !== document.documentElement) {
    try {
      const style = window.getComputedStyle(node);
      if (style.transform && style.transform !== 'none') return node;
      if (style.filter && style.filter !== 'none') return node;
      if (style.perspective && style.perspective !== 'none') return node;
      if (style.backdropFilter && style.backdropFilter !== 'none') return node;
      if (style.willChange && /transform|perspective|filter/.test(style.willChange)) return node;
    } catch (error) {
      /* 忽略 */
    }
    node = node.parentElement;
  }
  return document.getElementById('app') || document.body;
}

function syncTitlebarHeight() {
  const bar = document.querySelector('.titlebar');
  if (!bar) {
    window.setTimeout(syncTitlebarHeight, 700);
    return;
  }

  const apply = () => {
    try {
      const barRect = bar.getBoundingClientRect();
      if (!Number.isFinite(barRect.bottom) || barRect.bottom <= 0) return;

      // 顶栏自身高度（不含误差）也要给一份，供别的规则用
      document.documentElement.style.setProperty('--cf-titlebar-raw', barRect.height.toFixed(2) + 'px');

      // 搜索页的 top 必须写成「顶栏下沿相对它自己包含块顶部的偏移」
      const hub = document.getElementById('cf25SearchHub');
      const anchor = hub || document.getElementById('app');
      const block = findContainingBlock(anchor);
      const blockRect = block.getBoundingClientRect();
      // 允许负值：包含块（过渡期的 app-shell）顶部偶尔比顶栏下沿更低，
      // 这时 top 必须是负数才能贴住，否则就留一条 1~2px 的缝。
      const offset = barRect.bottom - blockRect.top;
      if (!Number.isFinite(offset) || offset < -12 || offset > 400) return;
      document.documentElement.style.setProperty('--cf-titlebar-h', offset.toFixed(2) + 'px');
    } catch (error) {
      /* 忽略 */
    }
  };

  apply();

  try {
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    if (bar.firstElementChild) observer.observe(bar.firstElementChild);
  } catch (error) {
    /* 没有 ResizeObserver 就退化到 resize 事件 */
  }

  // 包含块会在过渡期变化（splash 退场、页面切换），这些时刻都要重算
  try {
    new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (error) {
    /* 忽略 */
  }

  window.addEventListener('resize', apply, { passive: true });
  document.addEventListener('transitionend', apply, { passive: true, capture: true });
  document.addEventListener('animationend', apply, { passive: true, capture: true });

  // 启动阶段异步内容多，短周期补算几次，之后交给上面的事件
  let ticks = 0;
  const timer = window.setInterval(() => {
    ticks += 1;
    apply();
    if (ticks >= 10) window.clearInterval(timer);
  }, 400);
}

/* ------------------------------------------------------------------
 * 2 · 海报 blur-up 收尾：filter 置 none
 * ------------------------------------------------------------------ */
function markSharp(img) {
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains(SHARP_CLASS)) return;
  try {
    img.classList.add(SHARP_CLASS);
  } catch (error) {
    /* 忽略 */
  }
}

function armPosterSharp() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armPosterSharp, 700);
    return;
  }

  const scan = () => {
    root.querySelectorAll('.poster-frame img').forEach((img) => {
      if (img.classList.contains(SHARP_CLASS)) return;
      if (img.complete && img.naturalWidth > 0) {
        // 已加载完的：留出 blur-up 收敛时间再摘 filter
        window.setTimeout(() => markSharp(img), 620);
      }
    });
  };

  document.addEventListener('load', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.closest || !img.closest('.poster-frame')) return;
    window.setTimeout(() => markSharp(img), 620);
  }, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (target instanceof HTMLImageElement && target.closest('.poster-frame')) {
          if (target.classList.contains('is-loaded') || target.classList.contains('cf8-poster-loaded')) {
            window.setTimeout(() => markSharp(target), 620);
          }
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('.poster-frame img')) {
          window.setTimeout(() => markSharp(node), 620);
          continue;
        }
        node.querySelectorAll?.('.poster-frame img').forEach((img) => {
          window.setTimeout(() => markSharp(img), 620);
        });
      }
    }
  });

  try {
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  } catch (error) {
    /* 忽略 */
  }

  scan();
  // 卡片是异步渲染的，初始化时可能一张都没有：短周期补扫几次，彻底兜住
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    try {
      scan();
    } catch (error) {
      /* 忽略 */
    }
    if (tries >= 12) window.clearInterval(timer);
  }, 900);
}

/* ------------------------------------------------------------------
 * 3 · 滚动期减负
 * ------------------------------------------------------------------ */
function armRailScrolling() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armRailScrolling, 700);
    return;
  }

  const states = new WeakMap();

  const decorate = (rail) => {
    if (!(rail instanceof HTMLElement)) return;
    if (states.has(rail)) return;
    const state = { idle: 0 };
    states.set(rail, state);

    rail.addEventListener('scroll', () => {
      try {
        if (!rail.classList.contains(RAIL_SCROLL_CLASS)) rail.classList.add(RAIL_SCROLL_CLASS);
        const wrap = rail.parentElement;
        if (wrap && wrap.classList.contains('cf9-rail-wrap')) wrap.classList.add(RAIL_SCROLL_CLASS);
        if (state.idle) window.clearTimeout(state.idle);
        state.idle = window.setTimeout(() => {
          try {
            rail.classList.remove(RAIL_SCROLL_CLASS);
            if (wrap && wrap.classList.contains('cf9-rail-wrap')) wrap.classList.remove(RAIL_SCROLL_CLASS);
          } catch (error) {
            /* 忽略 */
          }
        }, RAIL_IDLE_MS);
      } catch (error) {
        /* 忽略 */
      }
    }, { passive: true });
  };

  const scan = () => {
    root.querySelectorAll('.movie-rail, .style-rail').forEach(decorate);
  };
  scan();
  try {
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (error) {
    /* 忽略 */
  }
}

function armPageScrolling() {
  const shell = document.querySelector('main.app-shell');
  if (!shell) {
    window.setTimeout(armPageScrolling, 700);
    return;
  }

  /**
   * 第五十一轮：不再翻自己的 body 类名。
   *
   * 原来这里和 response-boost.js 各翻一个 body 类（cf3-scrolling / cf33-scroll），
   * 而两者监听的是同一批 scroll / wheel 事件 —— 滚动起止各触发两次整棵子树的
   * 样式重算。cf3-scrolling 的样式已经并进 cf33-scroll（见 styles.css 的 cf35 块），
   * 这里只负责把滚动活动"喂"给同一个探测器。
   */
  const engage = () => {
    try {
      if (typeof window.__cf33Engage === 'function') window.__cf33Engage();
    } catch (error) {
      /* 忽略 */
    }
  };

  // scroll 不冒泡，但捕获阶段会沿祖先链派发 —— 一次监听覆盖所有滚动容器
  document.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target === document || target === shell || (target instanceof Element && target.contains(shell))) {
      engage();
      return;
    }
    // 片库/详情面板这类内部滚动容器：只有纵向滚动才需要给网格减负
    if (target instanceof Element && target.scrollHeight > target.clientHeight + 4) engage();
  }, { passive: true, capture: true });
}

/* ------------------------------------------------------------------
 * 装配
 * ------------------------------------------------------------------ */
export function initMotionPerf() {
  const results = {};
  const run = (name, fn) => {
    try {
      fn();
      results[name] = true;
    } catch (error) {
      results[name] = false;
      try {
        console.warn('[CineFlow] 流畅度补丁装配失败，已跳过：' + name, error);
      } catch (inner) {
        /* 忽略 */
      }
    }
  };

  try {
    if (document.documentElement.dataset.cf31Perf === '1') return results;
    document.documentElement.dataset.cf31Perf = '1';
  } catch (error) {
    return results;
  }

  run('titlebar', syncTitlebarHeight);
  run('posterSharp', armPosterSharp);
  run('railScrolling', armRailScrolling);
  run('pageScrolling', armPageScrolling);

  return results;
}

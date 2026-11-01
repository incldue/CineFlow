
const SCROLL_IDLE_MS = 420;
const DORMANT_AFTER_MS = 900;
const SCROLL_CLASS = 'cf33-scroll';
const DORMANT_CLASS = 'cf33-dormant';

const PAGE_SELECTOR = '.cf3-page';

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

/**
 * 滚动活动探测器。
 *
 * 只认 scroll 事件（滚动条拖动同样会触发），加 wheel 兜底 —— 不去监听
 * pointermove，避免每次鼠标移动都跑一遍判定。
 * 用 capture 是因为 scroll 不冒泡，但捕获阶段能拿到所有内层滚动。
 */
function watchScrollActivity() {
  const body = document.body;
  if (!body) return false;
  let timer = 0;

  const engage = () => {
    /* 第五十二轮：启动闪屏期间一律不挂滚动减负类。
     * 布局在闪屏底下自己滚了一轮（滚动位置恢复 / 轨道首次填充）就会触发 engage，
     * 而 cf33-scroll 里的 animation-play-state: paused 会把一次性淡入定格在
     * from{opacity:0}，fill:both 于是整段停在 0 —— 实测 splash-active 期间
     * 海报 opacity 一直是 0.00、动画 currentTime 一直是 0ms。
     * 闪屏阶段本来就没有"用户在滚"，减负没有意义，直接让位。 */
    try {
      if (body.classList.contains('splash-active')) return;
    } catch (error) {
      /* 忽略 */
    }
    try {
      if (!body.classList.contains(SCROLL_CLASS)) body.classList.add(SCROLL_CLASS);
    } catch (error) {
      /* 忽略 */
    }
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      try {
        body.classList.remove(SCROLL_CLASS);
      } catch (error) {
        /* 忽略 */
      }
    }, SCROLL_IDLE_MS);
  };

  try {
    document.addEventListener('scroll', engage, { capture: true, passive: true });
    document.addEventListener('wheel', engage, { capture: true, passive: true });
    document.addEventListener('touchmove', engage, { capture: true, passive: true });
  } catch (error) {
    return false;
  }

  /* 第五十一轮：把 engage 暴露出去，让 motion-perf.js 也走同一个探测器。
   * 之前两边各翻一个 body 类名、监听同一批事件，滚动起止各重算两遍整棵子树。 */
  window.__cf33Engage = engage;
  return true;
}

/**
 * 隐藏页面移出渲染树。
 *
 * page-transition.js 里非当前页只是 opacity:0，仍然留在布局与绘制树里 ——
 * 片库 50 张卡、历史页整页都在参与布局，白白吃内存、也拖慢可见页的合成。
 *
 * 只在一页「已在 0 透明度上停稳 900ms」之后才休眠，并且在这一批事件到来时
 * **同步唤醒**（捕获阶段，早于切页逻辑），保证过渡动画不会从一张没渲染的
 * 页面上起跳：
 *   keydown / pointerdown —— 切页的两种入口
 *   style 变化 —— 任何别的地方改了透明度
 */
function armDormantPages() {
  const pages = Array.from(document.querySelectorAll(PAGE_SELECTOR));

  // 这个模块装在页面创建之前（越早装滚动探测越早生效），所以第一次进来
  // 很可能一个 .cf3-page 都还没有。等它们出现再接管，只等一次。
  if (!pages.length) {
    if (window.__cf33DormantWatch) return false;
    window.__cf33DormantWatch = true;
    try {
      const root = document.getElementById('app') || document.body;
      const observer = new MutationObserver(() => {
        if (!document.querySelector(PAGE_SELECTOR)) return;
        observer.disconnect();
        window.__cf33DormantWatch = false;
        try {
          armDormantPages();
        } catch (error) {
          /* 忽略 */
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    } catch (error) {
      /* 忽略 */
    }
    // 兜底：DOM 观察器在这里偶尔不触发，直接排几个定时重试
    [400, 1200, 2600].forEach((delay) => {
      window.setTimeout(() => {
        if (document.querySelector(PAGE_SELECTOR) && window.__cf33DormantWatch) {
          window.__cf33DormantWatch = false;
          try {
            armDormantPages();
          } catch (error) {
            /* 忽略 */
          }
        }
      }, delay);
    });
    return false;
  }

  if (window.__cf33DormantArmed) return true;
  window.__cf33DormantArmed = true;

  const timers = new WeakMap();

  const wake = (page) => {
    const pending = timers.get(page);
    if (pending) {
      window.clearTimeout(pending);
      timers.delete(page);
    }
    if (page.classList.contains(DORMANT_CLASS)) page.classList.remove(DORMANT_CLASS);
  };

  const wakeAll = () => pages.forEach(wake);

  pages.forEach((page) => {
    // 判定「这一页现在是隐藏的」：只要它没有把不透明度设成 1，就算隐藏。
    // 不用 === '0' 是因为未挂载过的页面 opacity 是空字符串，那样会永远不休眠。
    const isHidden = () => {
      const opacity = page.style.opacity;
      if (opacity === '1') return false;
      if (opacity === '0') return true;
      // 还没被 page-transition 摆弄过：看它是不是当前页
      return !page.classList.contains('is-current');
    };

    const evaluate = () => {
      try {
        if (!isHidden()) {
          wake(page);
          return;
        }
        if (page.classList.contains(DORMANT_CLASS) || timers.has(page)) return;
        const timer = window.setTimeout(() => {
          timers.delete(page);
          try {
            if (isHidden() && page.isConnected) page.classList.add(DORMANT_CLASS);
          } catch (error) {
            /* 忽略 */
          }
        }, DORMANT_AFTER_MS);
        timers.set(page, timer);
      } catch (error) {
        /* 忽略 */
      }
    };

    evaluate();

    try {
      new MutationObserver(evaluate).observe(page, { attributes: true, attributeFilter: ['style'] });
    } catch (error) {
      /* 忽略 */
    }
  });

  // 切页入口：捕获阶段抢先唤醒，早于 page-transition 的处理器
  try {
    document.addEventListener('keydown', wakeAll, { capture: true, passive: true });
    document.addEventListener('pointerdown', wakeAll, { capture: true, passive: true });
    document.addEventListener('focusin', wakeAll, { capture: true, passive: true });
  } catch (error) {
    /* 忽略 */
  }

  return true;
}

export function initResponseBoost() {
  const results = {};
  try {
    if (document.documentElement.dataset.cf33Boost === '1') return { cached: true };
    document.documentElement.dataset.cf33Boost = '1';
  } catch (error) {
    /* 忽略 */
  }

  // 系统要求减少动态效果时不接管滚动期的动画暂停（其余优化照旧）
  results.reducedMotion = prefersReducedMotion();
  if (!results.reducedMotion) {
    try {
      results.scroll = watchScrollActivity();
    } catch (error) {
      results.scroll = false;
    }
  } else {
    results.scroll = false;
  }

  try {
    results.dormant = armDormantPages();
  } catch (error) {
    results.dormant = false;
  }

  return results;
}

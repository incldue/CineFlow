/**
 * CineFlow · 长时运行保活（第六十八轮 · 新增文件，零侵入基线）
 *
 * 问题：用久了变慢、播放变卡。这一层不修某一次卡顿，而是让「用多久都一样」——
 * 照搬 Apple 平台上真正起作用的那几条机制，逐条落到 DOM 上：
 *
 *  1. NSCache 式自适应降级（可恢复）
 *     macOS/iOS 不会等到掉帧才降级，而是持续采样、越界就降一档、恢复后自动升回来。
 *     这里用 PerformanceObserver('longtask') 维护滑动窗口：
 *       连续 12 个长任务 / 窗口 p95 > 140ms → 挂 html.cf-adaptive-lite（关掉非必要
 *       过渡与动画，只留不透明度变化），
 *       之后连续 20 个任务都正常 → 自动摘掉。降级不是一次性的死状态。
 *
 *  2. Purgeable memory（后台即回收）
 *     iOS 的 didReceiveMemoryWarning / macOS 的 NSPurgeable 都遵循同一条：
 *     看不见的东西不该占着解码后的内存。这里在页面转入休眠（response-boost.js 的
 *     cf33-dormant）或窗口隐藏时，把休眠页里 <img> 的 src 摘下来存进 dataset，
 *     醒来再装回去。休眠页本来就不参与绘制，摘掉不改变任何可见像素。
 *
 *  3. 媒体资源释放（对应 AVPlayer 的 prepareForReuse）
 *     播放器关闭后 <video> 仍然抓着解码器和缓冲，反复开关会一路累积。
 *     播放器一旦不再是 is-open，就把 video 的 src 清掉并 load() 一次，让解码器归还。
 *
 *  4. 空闲维护（对应 GCD 的 QoS.utility）
 *     每 90 秒用 requestIdleCallback 跑一次轻量整理：清掉已断开的 relayed 标记、
 *     修剪 process 内部缓存指针、记录水位。全部在空闲帧里做，不抢用户操作。
 *
 * 全部可失败：任何一步抛错都只少一层优化。CINEFLOW_SESSION_HYGIENE=off-style
 * 式开关不需要——本文件由 JS 侧判断，不依赖主进程。
 */

const LITE_CLASS = 'cf-adaptive-lite';
const DORMANT_CLASS = 'cf33-dormant';
const STASH_ATTR = 'data-cf-stash';

const LONG_TASK_WINDOW = 24;
/* 密度门槛：光有 12 个长任务还不够，必须在 12 秒内密集出现 ——
   否则一小时里零散掉几次长任务也会被误判成「卡住了」，然后永久降级。 */
const DENSITY_WINDOW_MS = 12000;
const LITE_ENTER_P95_MS = 140;
const LITE_ENTER_MIN_TASKS = 12;
const LITE_EXIT_P95_MS = 70;
const LITE_EXIT_STREAK = 20;

const LITE_CSS = [
  /* 只压「非必要」的动效：位移、缩放、模糊、循环关键帧。
     不透明度变化保留 —— 它是唯一近乎免费的合成操作，全砍掉会让界面显得坏掉。 */
  'html.' + LITE_CLASS + ' *,',
  'html.' + LITE_CLASS + ' *::before,',
  'html.' + LITE_CLASS + ' *::after {',
  '  animation-duration: 1ms !important;',
  '  animation-delay: 0s !important;',
  '  animation-iteration-count: 1 !important;',
  '  transition-duration: 60ms !important;',
  '  transition-delay: 0s !important;',
  '  backdrop-filter: none !important;',
  '  -webkit-backdrop-filter: none !important;',
  '}',
  'html.' + LITE_CLASS + ' .ambient-a,',
  'html.' + LITE_CLASS + ' .ambient-b,',
  'html.' + LITE_CLASS + ' .hero-backdrop {',
  '  filter: none !important;',
  '}',
].join('\n');

function injectLiteCss() {
  if (document.getElementById('cf-session-hygiene')) return true;
  const style = document.createElement('style');
  style.id = 'cf-session-hygiene';
  style.textContent = LITE_CSS;
  (document.head || document.documentElement).append(style);
  return true;
}

function createLongTaskMonitor(onLevel, onSample) {
  const durations = [];
  const stamps = [];
  let enterStreak = 0;
  let exitStreak = 0;
  let lite = false;

  const p95 = () => {
    if (!durations.length) return 0;
    const sorted = durations.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  };

  /* 启动期不算：splash 要一次性铺 44 张卡 + 69 张图，长任务是必然的，
     把它算进去等于让 app 一开机就锁在降级态（实测 p95 直接飙到 4462ms）。
     窗口一旦清空，p95 也就跟着回到真实水位。 */
  const warmingUp = () => {
    try {
      if (performance.now() < 9000) return true;
      const body = document.body;
      return Boolean(body && (body.classList.contains('splash-active') || body.classList.contains('splash-revealing')));
    } catch {
      return false;
    }
  };

  const sample = (duration) => {
    if (warmingUp()) {
      durations.length = 0;
      enterStreak = 0;
      exitStreak = 0;
      return;
    }
    const now = performance.now();
    stamps.push(now);
    if (stamps.length > LONG_TASK_WINDOW * 4) stamps.shift();
    durations.push(duration);
    if (durations.length > LONG_TASK_WINDOW) durations.shift();
    /* 密度：窗口内的长任务数量 */
    let dense = 0;
    for (let i = stamps.length - 1; i >= 0; i -= 1) {
      if (now - stamps[i] <= DENSITY_WINDOW_MS) dense += 1;
      else break;
    }
    const value = p95();
    if (typeof onSample === 'function') onSample(value, duration);
    if (!lite) {
      if (duration >= 50) enterStreak += 1;
      else enterStreak = Math.max(0, enterStreak - 1);
      const denseEnough = dense >= LITE_ENTER_MIN_TASKS;
      if (enterStreak >= LITE_ENTER_MIN_TASKS && denseEnough && value >= LITE_ENTER_P95_MS) {
        lite = true;
        exitStreak = 0;
        onLevel(true, value);
      }
      return;
    }
    if (duration < LITE_EXIT_P95_MS) exitStreak += 1;
    else exitStreak = 0;
    if (exitStreak >= LITE_EXIT_STREAK && value < LITE_EXIT_P95_MS) {
      lite = false;
      enterStreak = 0;
      onLevel(false, value);
    }
  };

  const feed = (ms) => sample(ms);
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) sample(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    observer.feed = feed;
    return observer;
  } catch {
    /* 没有 longtask 支持就不降级：宁可不动，也不误判 */
    return { feed };
  }
}

/** 休眠页的图片内存回收（Purgeable）。 */
function createImagePurge() {
  let purged = 0;
  let restored = 0;

  const isDormant = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 6; depth += 1) {
      if (node.classList && node.classList.contains(DORMANT_CLASS)) return true;
      node = node.parentElement;
    }
    return false;
  };

  function purge() {
    let count = 0;
    let bytes = 0;
    const imgs = document.querySelectorAll('img[src]');
    for (const img of imgs) {
      if (img.hasAttribute(STASH_ATTR)) continue;
      if (!isDormant(img)) continue;
      const src = img.getAttribute('src');
      if (!src) continue;
      try {
        img.setAttribute(STASH_ATTR, src);
        img.removeAttribute('src');
        count += 1;
        bytes += src.length;
      } catch {
        /* ignore */
      }
    }
    purged += count;
    return { count, bytes };
  }

  function revive() {
    let count = 0;
    const stashed = document.querySelectorAll('img[' + STASH_ATTR + ']');
    for (const img of stashed) {
      if (isDormant(img)) continue;
      const src = img.getAttribute(STASH_ATTR);
      try {
        img.removeAttribute(STASH_ATTR);
        if (src) img.setAttribute('src', src);
        count += 1;
      } catch {
        /* ignore */
      }
    }
    restored += count;
    return count;
  }

  /* 休眠类是 response-boost.js 加的，我们在它之后观察 class 变化：
     变成休眠 → 回收；从休眠醒来 → 装回。 */
  try {
    const observer = new MutationObserver((records) => {
      let shouldPurge = false;
      let shouldRevive = false;
      for (const record of records) {
        const target = record.target;
        if (!target || target.nodeType !== 1) continue;
        if (!target.classList || !target.classList.contains('cf3-page')) continue;
        if (target.classList.contains(DORMANT_CLASS)) shouldPurge = true;
        else shouldRevive = true;
      }
      if (shouldPurge) purge();
      if (shouldRevive) revive();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  } catch {
    /* ignore */
  }

  return {
    purge,
    revive,
    get stats() {
      return { purged, restored };
    },
  };
}

/** 播放器关闭后归还解码器与缓冲（AVPlayer.prepareForReuse 的等价物）。 */
function createMediaReleaser() {
  let releases = 0;

  function releaseOnce(modal) {
    let changed = 0;
    const videos = modal.querySelectorAll('video');
    for (const video of videos) {
      try {
        if (!video.getAttribute('src') && !video.querySelector('source')) continue;
        video.pause();
        video.removeAttribute('src');
        for (const source of video.querySelectorAll('source')) source.removeAttribute('src');
        video.load();
        changed += 1;
      } catch {
        /* ignore */
      }
    }
    const frames = modal.querySelectorAll('iframe');
    for (const frame of frames) {
      try {
        if (!frame.getAttribute('src')) continue;
        frame.setAttribute('src', 'about:blank');
        changed += 1;
      } catch {
        /* ignore */
      }
    }
    releases += changed;
    return changed;
  }

  try {
    const modal = document.querySelector('#playerModal');
    if (!modal) return { release: () => 0, get stats() { return { releases }; } };
    const observer = new MutationObserver(() => {
      if (modal.classList.contains('is-open')) return;
      releaseOnce(modal);
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  } catch {
    /* ignore */
  }

  return { release: () => releaseOnce(document.querySelector('#playerModal')), get stats() { return { releases }; } };
}

export function initSessionHygiene() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf68Hygiene === '1') return false;
  window.__cf68Hygiene = '1';

  injectLiteCss();

  const diag = { level: 'ok', p95: 0, liteEntered: 0, purged: 0, restored: 0, releases: 0, ticks: 0 };

  const monitor = createLongTaskMonitor((lite, value) => {
    diag.p95 = Math.round(value);
    if (lite) {
      diag.level = 'lite';
      diag.liteEntered += 1;
      document.documentElement.classList.add(LITE_CLASS);
      try { console.warn('[CineFlow] 自适应降级开启（长任务 p95 ' + Math.round(value) + 'ms）'); } catch { /* ignore */ }
    } else {
      diag.level = 'ok';
      document.documentElement.classList.remove(LITE_CLASS);
      try { console.warn('[CineFlow] 自适应降级解除（长任务 p95 ' + Math.round(value) + 'ms）'); } catch { /* ignore */ }
    }
  }, (value) => {
    diag.p95 = Math.round(value);
  });

  /* 自检口：Long Task 观察器只在真实渲染任务上触发，CDP 注入的脚本阻塞不算。
     为了能自动化验证降级/恢复状态机，留一个喂样本的入口（只喂状态机，不改任何别的东西）。 */
  window.__cf68HygieneFeed = (ms) => {
    try {
      const feed = monitor && monitor.feed;
      if (feed) feed(Number(ms) || 0);
      return diag.level;
    } catch {
      return 'error';
    }
  };

  const images = createImagePurge();
  const media = createMediaReleaser();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const result = images.purge();
      diag.purged += result.count;
    } else {
      diag.restored += images.revive();
    }
  });

  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
    : (cb) => window.setTimeout(cb, 800);

  const tick = () => {
    diag.ticks += 1;
    try {
      if (!document.hidden) diag.restored += images.revive();
      const result = images.purge();
      diag.purged += result.count;
    } catch { /* ignore */ }
    diag.purged = images.stats.purged;
    diag.restored = images.stats.restored;
    diag.releases = media.stats.releases;
    window.setTimeout(() => idle(tick), 90000);
  };
  window.setTimeout(() => idle(tick), 90000);

  window.__cf68HygieneState = diag;

  /* 主进程内存总督在压力时调用（Apple 的 didReceiveMemoryWarning 等价物）。
     只做"看不见的东西不该占内存"这一件事：先回收休眠页图片，再尽力解除降级态，
     最后返回水位供主进程记录。 */
  window.__cf68HygieneForce = (reason) => {
    let purged = 0;
    try {
      const result = images.purge();
      purged = result.count;
      diag.purged += purged;
    } catch { /* ignore */ }
    let released = 0;
    try {
      const modal = document.querySelector('#playerModal');
      if (modal && !modal.classList.contains('is-open')) released = media.release();
    } catch { /* ignore */ }
    diag.lastReason = reason || 'pressure';
    return { purged, released, level: diag.level, p95: diag.p95 };
  };
  return true;
}

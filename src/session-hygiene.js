const LITE_CLASS = 'cf-adaptive-lite';
const DORMANT_CLASS = 'cf33-dormant';
const STASH_ATTR = 'data-cf-stash';

const LONG_TASK_WINDOW = 24;

const DENSITY_WINDOW_MS = 12000;
const LITE_ENTER_P95_MS = 140;
const LITE_ENTER_MIN_TASKS = 12;
const LITE_EXIT_P95_MS = 70;
const LITE_EXIT_STREAK = 20;

const LITE_CSS = [

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

    return { feed };
  }
}

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

      }
    }
    restored += count;
    return count;
  }

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

  }

  return {
    purge,
    revive,
    get stats() {
      return { purged, restored };
    },
  };
}

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

      }
    }
    const frames = modal.querySelectorAll('iframe');
    for (const frame of frames) {
      try {
        if (!frame.getAttribute('src')) continue;
        frame.setAttribute('src', 'about:blank');
        changed += 1;
      } catch {

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
      try { console.warn('[CineFlow] 自适应降级开启（长任务 p95 ' + Math.round(value) + 'ms）'); } catch {  }
    } else {
      diag.level = 'ok';
      document.documentElement.classList.remove(LITE_CLASS);
      try { console.warn('[CineFlow] 自适应降级解除（长任务 p95 ' + Math.round(value) + 'ms）'); } catch {  }
    }
  }, (value) => {
    diag.p95 = Math.round(value);
  });

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
    } catch {  }
    diag.purged = images.stats.purged;
    diag.restored = images.stats.restored;
    diag.releases = media.stats.releases;
    window.setTimeout(() => idle(tick), 90000);
  };
  window.setTimeout(() => idle(tick), 90000);

  window.__cf68HygieneState = diag;

  window.__cf68HygieneForce = (reason) => {
    let purged = 0;
    try {
      const result = images.purge();
      purged = result.count;
      diag.purged += purged;
    } catch {  }
    let released = 0;
    try {
      const modal = document.querySelector('#playerModal');
      if (modal && !modal.classList.contains('is-open')) released = media.release();
    } catch {  }
    diag.lastReason = reason || 'pressure';
    return { purged, released, level: diag.level, p95: diag.p95 };
  };
  return true;
}

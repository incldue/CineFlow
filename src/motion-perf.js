const RAIL_SCROLL_CLASS = 'cf30-scrolling';
const SHARP_CLASS = 'cf30-sharp';

const RAIL_IDLE_MS = 320;

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

  let lastRaw = '';
  let lastH = '';
  let pending = 0;

  const writeVars = () => {
    pending = 0;
    try {
      const barRect = bar.getBoundingClientRect();
      if (!Number.isFinite(barRect.bottom) || barRect.bottom <= 0) return;

      const raw = barRect.height.toFixed(2) + 'px';
      if (raw !== lastRaw) {
        lastRaw = raw;
        document.documentElement.style.setProperty('--cf-titlebar-raw', raw);
      }

      const hub = document.getElementById('cf25SearchHub');
      const anchor = hub || document.getElementById('app');
      const block = findContainingBlock(anchor);
      const blockRect = block.getBoundingClientRect();

      const offset = barRect.bottom - blockRect.top;
      if (!Number.isFinite(offset) || offset < -12 || offset > 400) return;
      const h = offset.toFixed(2) + 'px';
      if (h !== lastH) {
        lastH = h;
        document.documentElement.style.setProperty('--cf-titlebar-h', h);
      }
    } catch (error) {

    }
  };

  const apply = () => {
    if (pending) return;
    try {
      pending = window.requestAnimationFrame(writeVars) || 1;
    } catch (error) {
      pending = window.setTimeout(writeVars, 16);
    }
  };

  apply();

  try {
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    if (bar.firstElementChild) observer.observe(bar.firstElementChild);
  } catch (error) {

  }

  try {
    new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (error) {

  }

  window.addEventListener('resize', apply, { passive: true });
  document.addEventListener('transitionend', apply, { passive: true, capture: true });
  document.addEventListener('animationend', apply, { passive: true, capture: true });

  let ticks = 0;
  const timer = window.setInterval(() => {
    ticks += 1;
    apply();
    if (ticks >= 10) window.clearInterval(timer);
  }, 400);
}

function markSharp(img) {
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains(SHARP_CLASS)) return;
  try {
    img.classList.add(SHARP_CLASS);
  } catch (error) {

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

  }

  scan();

  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    try {
      scan();
    } catch (error) {

    }
    if (tries >= 12) window.clearInterval(timer);
  }, 900);
}

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

          }
        }, RAIL_IDLE_MS);
      } catch (error) {

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

  }
}

function armPageScrolling() {
  const shell = document.querySelector('main.app-shell');
  if (!shell) {
    window.setTimeout(armPageScrolling, 700);
    return;
  }

  const engage = () => {
    try {
      if (typeof window.__cf33Engage === 'function') window.__cf33Engage();
    } catch (error) {

    }
  };

  document.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target === document || target === shell || (target instanceof Element && target.contains(shell))) {
      engage();
      return;
    }

    if (target instanceof Element && target.scrollHeight > target.clientHeight + 4) engage();
  }, { passive: true, capture: true });
}

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

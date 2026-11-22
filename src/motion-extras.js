import {
  requestTick,
  subscribe,
  watchVisible,
  prefersReducedMotion,
  onScrollCapture
} from './motion-scheduler.js';

const RAIL_FLAG = 'cf30Rail';
const ENTER_CLASS = 'cf30-enter';
const IDLE_CLASS = 'cf30-idle';
const IDLE_MS = 2500;

const BASELINE_REVEAL_MAX = 14;

function decorateRail(rail) {
  if (!(rail instanceof HTMLElement) || rail.dataset[RAIL_FLAG] === '1') return;
  rail.dataset[RAIL_FLAG] = '1';

  const host = rail.parentElement;
  if (!host) return;

  if (!host.classList.contains('cf9-rail-wrap')) host.classList.add('cf9-rail-wrap');

  const sub = {
    active: false,
    read() {
      const max = rail.scrollWidth - rail.clientWidth;
      if (max <= 2) return null;
      return Math.min(1, Math.max(0, rail.scrollLeft / max));
    },
    write(value) {
      if (value === null) {
        host.style.removeProperty('--cf30-progress');
        return;
      }
      host.style.setProperty('--cf30-progress', value.toFixed(4));
    }
  };

  subscribe(sub);
  watchVisible(rail, {
    rootMargin: '160px',
    onEnter() {
      sub.active = true;
      requestTick();
    },
    onLeave() {
      sub.active = false;
    }
  });

  rail.addEventListener('scroll', requestTick, { passive: true });
  try {
    const observer = new ResizeObserver(() => requestTick());
    observer.observe(rail);
    if (rail.firstElementChild) observer.observe(rail.firstElementChild);
  } catch (error) {

  }
  requestTick();
}

function armRailProgress() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armRailProgress, 800);
    return;
  }
  const scan = () => {
    root.querySelectorAll('.movie-rail').forEach(decorateRail);
  };
  scan();
  try {
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (error) {

  }
}

function applyCardEnter(card) {
  if (!(card instanceof HTMLElement)) return;
  if (prefersReducedMotion()) return;

  if (card.dataset.cf30Played === '1') return;

  if (card.classList.contains('is-premium-revealing')) return;

  const parent = card.parentElement;
  const isRail = Boolean(parent && parent.classList.contains('movie-rail'));
  let index = 0;
  if (parent) index = Array.prototype.indexOf.call(parent.children, card);

  if (isRail && index < BASELINE_REVEAL_MAX) {
    const armedAt = Number(card.dataset.cf30ArmedAt || 0);
    if (armedAt && Date.now() - armedAt < 1600) return;
  }

  const slot = isRail ? Math.max(0, index - BASELINE_REVEAL_MAX) : index;
  const delay = Math.min(slot, 4) * 24;

  card.dataset.cf30Played = '1';
  card.style.setProperty('--cf30-enter-delay', delay + 'ms');
  card.classList.add(ENTER_CLASS);
  window.setTimeout(() => {
    try {
      card.classList.remove(ENTER_CLASS);
      card.style.removeProperty('--cf30-enter-delay');
    } catch (error) {

    }
  }, 620 + delay + 120);
}

function armCardEntrance() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armCardEntrance, 800);
    return;
  }
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      applyCardEnter(entry.target);
    }

  }, { rootMargin: '0px 0px -32px 0px', threshold: 0 });

  const flushVisible = () => {
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    if (!vh || !vw) return;
    root.querySelectorAll('.movie-card[data-cf30-armed]').forEach((card) => {
      if (card.classList.contains(ENTER_CLASS)) return;
      if (card.dataset.cf30Played === '1') return;
      try {
        const rect = card.getBoundingClientRect();
        if (rect.bottom > -40 && rect.top < vh + 40 && rect.right > 0 && rect.left < vw) {
          observer.unobserve(card);
          applyCardEnter(card);
        }
      } catch (error) {

      }
    });
  };

  let fallbackTimer = 0;
  const scan = () => {
    root.querySelectorAll('.movie-card:not([data-cf30-armed])').forEach((card) => {
      card.dataset.cf30Armed = '1';
      card.dataset.cf30ArmedAt = String(Date.now());
      observer.observe(card);
    });
  };
  scan();
  try {
    new MutationObserver(() => {
      scan();
      window.clearTimeout(fallbackTimer);
      fallbackTimer = window.setTimeout(flushVisible, 260);
    }).observe(root, { childList: true, subtree: true });
  } catch (error) {

  }
  fallbackTimer = window.setTimeout(flushVisible, 260);

  let scrollTimer = 0;
  onScrollCapture(() => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(flushVisible, 180);
  });
}

function findScroller(el) {
  let node = el?.parentElement || null;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function armHeroParallax() {
  const hero = document.getElementById('heroSection');
  if (!hero) {
    window.setTimeout(armHeroParallax, 900);
    return;
  }
  const scroller = findScroller(hero);

  const sub = {
    active: true,
    read() {
      const top = scroller ? scroller.scrollTop : window.scrollY;
      return Number.isFinite(top) ? Math.max(0, top) : 0;
    },
    write(top) {

      const backdropShift = Math.min(top * 0.16, 120);

      const copyShift = -Math.min(top * 0.06, 36);
      hero.style.setProperty('--cf30-hero-shift', backdropShift.toFixed(1) + 'px');
      hero.style.setProperty('--cf30-hero-copy-shift', copyShift.toFixed(1) + 'px');
    }
  };

  subscribe(sub);
  watchVisible(hero, {
    rootMargin: '200px',
    onEnter() {
      sub.active = true;
      requestTick();
    },
    onLeave() {
      sub.active = false;
    }
  });

  onScrollCapture(() => {
    if (sub.active) requestTick();
  });
  requestTick();
}

const RIPPLE_HOSTS = '.poster-frame';

function armRipple() {
  document.addEventListener('pointerdown', (event) => {
    try {
      if (event.button !== 0) return;
      if (prefersReducedMotion()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const host = target.closest(RIPPLE_HOSTS);
      if (!host) return;

      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const span = document.createElement('span');
      span.className = 'cf30-ripple';
      span.setAttribute('aria-hidden', 'true');
      span.style.setProperty('--cf30-ripple-x', Math.round(event.clientX - rect.left) + 'px');
      span.style.setProperty('--cf30-ripple-y', Math.round(event.clientY - rect.top) + 'px');
      span.style.setProperty('--cf30-ripple-size', Math.round(Math.hypot(rect.width, rect.height) * 0.55) + 'px');
      host.appendChild(span);
      window.setTimeout(() => {
        try {
          span.remove();
        } catch (error) {

        }
      }, 760);
    } catch (error) {

    }
  }, { passive: true });
}

function rollScore(pill) {
  if (!(pill instanceof HTMLElement) || pill.dataset.cf30Roll === '1') return;
  if (prefersReducedMotion()) return;

  const text = pill.textContent || '';
  const matched = text.match(/^(★\s*)(\d+(?:\.\d+)?)([\s\S]*)$/);
  if (!matched) return;

  const target = Number.parseFloat(matched[2]);
  if (!Number.isFinite(target) || target <= 0) return;

  const decimals = (matched[2].split('.')[1] || '').length;
  const prefix = matched[1];
  const suffix = matched[3];
  const startedAt = window.performance.now();
  const DURATION = 700;

  pill.dataset.cf30Roll = '1';

  let stop = () => {};
  const sub = {
    active: true,
    write(_ignored, now) {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / DURATION));

      const eased = 1 - Math.pow(1 - progress, 3);
      pill.textContent = prefix + (target * eased).toFixed(decimals) + suffix;
      if (progress >= 1) stop();
    }
  };
  stop = subscribe(sub);
}

function armScoreRoll() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armScoreRoll, 800);
    return;
  }
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      rollScore(entry.target);
    }
  }, { threshold: 0.4 });

  const scan = () => {
    root.querySelectorAll('.score-pill:not([data-cf30-roll-armed])').forEach((pill) => {
      pill.dataset.cf30RollArmed = '1';
      observer.observe(pill);
    });
  };
  scan();
  try {
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (error) {

  }
}

function armPlayerIdle() {
  let timer = 0;

  const shellOf = () => document.querySelector('.player-modal.is-open .player-shell');

  const wake = () => {
    const shell = shellOf();
    if (!shell) {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      return;
    }
    shell.classList.remove(IDLE_CLASS);
    if (timer) window.clearTimeout(timer);
    if (prefersReducedMotion()) return;
    timer = window.setTimeout(() => {
      const current = shellOf();
      if (!current) return;

      const active = document.activeElement;
      if (active && current.contains(active) && active !== document.body) return;
      current.classList.add(IDLE_CLASS);
    }, IDLE_MS);
  };

  document.addEventListener('pointermove', wake, { passive: true });
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('keydown', wake, { passive: true });
  document.addEventListener('wheel', wake, { passive: true });

  const attach = () => {
    const modal = document.querySelector('.player-modal');
    if (!modal) {
      window.setTimeout(attach, 900);
      return;
    }
    try {
      new MutationObserver(wake).observe(modal, { attributes: true, attributeFilter: ['class'] });
    } catch (error) {

    }
    wake();
  };
  attach();
}

function armPosterLoaded() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(armPosterLoaded, 800);
    return;
  }
  const mark = (scope) => {
    scope.querySelectorAll('.poster-frame img:not(.is-loaded)').forEach((img) => {
      if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded');
    });
  };
  mark(root);
  document.addEventListener('load', (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.closest('.poster-frame')) img.classList.add('is-loaded');
  }, true);
  try {
    new MutationObserver(() => mark(root)).observe(root, { childList: true, subtree: true });
  } catch (error) {

  }
}

export function initMotionExtras() {
  const results = {};
  const run = (name, fn) => {
    try {
      fn();
      results[name] = true;
    } catch (error) {
      results[name] = false;
      try {
        console.warn('[CineFlow] 动效模块装配失败，已跳过：' + name, error);
      } catch (inner) {

      }
    }
  };

  try {
    if (document.documentElement.dataset.cf30Motion === '1') return results;
    document.documentElement.dataset.cf30Motion = '1';
  } catch (error) {
    return results;
  }

  run('posterLoaded', armPosterLoaded);
  run('railProgress', armRailProgress);
  run('cardEntrance', armCardEntrance);
  run('heroParallax', armHeroParallax);
  run('ripple', armRipple);
  run('scoreRoll', armScoreRoll);
  run('playerIdle', armPlayerIdle);

  return results;
}

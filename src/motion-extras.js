/**
 * CineFlow 动效扩容包（新增文件，零侵入）
 *
 * 只做六件事，全部是「加」不是「改」：
 *   B2  轨道滚动进度细线        —— 写 --cf30-progress，纯 transform: scaleX
 *   B5  卡片入场 stagger 扩容    —— 只补基线没覆盖的那些（基线 PREMIUM_REVEAL_MAX = 14）
 *   C2  英雄区滚动视差          —— 写 --cf30-hero-shift / --cf30-hero-copy-shift，走 translate 属性
 *   D1  点击涟漪                —— 合成层 span，动画结束即摘除
 *   D2  评分数字翻滚            —— rAF 合帧内只写 textContent
 *   D3  播放器控制条智能隐现    —— 静止 2.5s 隐藏，一动即回
 *
 * 所有滚动相关计算都走 motion-scheduler 的读写分离 + 视口门控：
 * 屏外不订阅、不读布局、不写样式。这是「动效变多、帧率不掉」的前提。
 */

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
/** 基线 renderer.js 的 PREMIUM_REVEAL_MAX，前 N 张已有入场动画，本模块从 N 之后补起。 */
const BASELINE_REVEAL_MAX = 14;

/* ============================================================
 * B2 · 轨道滚动进度细线
 * ============================================================ */
function decorateRail(rail) {
  if (!(rail instanceof HTMLElement) || rail.dataset[RAIL_FLAG] === '1') return;
  rail.dataset[RAIL_FLAG] = '1';

  const host = rail.parentElement;
  if (!host) return;
  // 复用 premium-ui 已有的包裹态类；没有就补一个（只加类，不建节点、不影响布局）
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
    /* 没有 ResizeObserver 就只靠 scroll 更新 */
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
    /* 忽略 */
  }
}

/* ============================================================
 * B5 · 卡片入场 stagger（只补基线未覆盖的部分）
 * ============================================================ */
function applyCardEnter(card) {
  if (!(card instanceof HTMLElement)) return;
  if (prefersReducedMotion()) return;
  // 一张卡一辈子只播一次。没有这个闸门，任何一次 childList 变更都会让
  // 视口内所有已武装的卡重播入场 —— 那就是"片库一直在闪"的直接来源。
  if (card.dataset.cf30Played === '1') return;
  // 基线已经在跑入场动画的，本模块不介入，避免两条 animation 抢同一个 transform
  if (card.classList.contains('is-premium-revealing')) return;

  const parent = card.parentElement;
  const isRail = Boolean(parent && parent.classList.contains('movie-rail'));
  let index = 0;
  if (parent) index = Array.prototype.indexOf.call(parent.children, card);

  // 轨道里前 BASELINE_REVEAL_MAX 张由基线 renderer.js 播入场；这里让位，
  // 但只在「刚渲染出来的那一下」让位 —— 之后（滚动进来 / 兜底补播）照常播，
  // 否则那几张永远等不到动效。
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
      /* 节点已被替换，忽略 */
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
    // threshold 用 0 而不是 0.02：零面积或刚露头的卡片也能触发，且不会漏掉
  }, { rootMargin: '0px 0px -32px 0px', threshold: 0 });

  // IntersectionObserver 在软件渲染 / 后台窗口 / 无合成帧的环境里可能长时间不投递。
  // 卡片入场是「进入即播」的观感承诺，不能等 —— 兜底：观察后 260ms 内还没触发，
  // 就直接给视口内的卡片播，屏外的仍交给 IO。
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
        /* 忽略 */
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
    /* 忽略 */
  }
  fallbackTimer = window.setTimeout(flushVisible, 260);

  // 滚动进入新一排也要立刻播：IO 可靠时它先到，IO 失灵时这里兜住。
  let scrollTimer = 0;
  onScrollCapture(() => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(flushVisible, 180);
  });
}

/* ============================================================
 * C2 · 英雄区滚动视差
 * ============================================================ */
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
      // 背景跟着滚动"下移"一点 → 看起来比内容慢，产生纵深
      const backdropShift = Math.min(top * 0.16, 120);
      // 文案轻轻上浮，和背景反向，层次才立得住
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

/* ============================================================
 * D1 · 点击涟漪
 * ============================================================ */
// 只挂已知 position: relative 且 overflow: hidden 的宿主，涟漪才不会被裁或溢出
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
          /* 忽略 */
        }
      }, 760);
    } catch (error) {
      /* 涟漪失败不影响点击 */
    }
  }, { passive: true });
}

/* ============================================================
 * D2 · 评分数字翻滚
 * ============================================================ */
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
      // 三次缓出：数字先快后慢地停住，比线性更有"落定感"
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
    /* 忽略 */
  }
}

/* ============================================================
 * D3 · 播放器控制条智能隐现
 * ============================================================ */
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
      // 焦点还在控制条里（键盘操作）就不要藏
      const active = document.activeElement;
      if (active && current.contains(active) && active !== document.body) return;
      current.classList.add(IDLE_CLASS);
    }, IDLE_MS);
  };

  document.addEventListener('pointermove', wake, { passive: true });
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('keydown', wake, { passive: true });
  document.addEventListener('wheel', wake, { passive: true });

  // 播放器开合时立刻重新计时
  const attach = () => {
    const modal = document.querySelector('.player-modal');
    if (!modal) {
      window.setTimeout(attach, 900);
      return;
    }
    try {
      new MutationObserver(wake).observe(modal, { attributes: true, attributeFilter: ['class'] });
    } catch (error) {
      /* 忽略 */
    }
    wake();
  };
  attach();
}

/* ============================================================
 * A2 兜底 · 海报 blur-up 的 is-loaded 补标
 * premium-ui 已有 capture 监听与 MutationObserver，这里再兜一层：
 * 只要 img.complete 且 naturalWidth > 0 就补 is-loaded，避免任何时序空隙里
 * 海报永久停在 blur(14px) 的模糊态。
 * ============================================================ */
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
    /* 忽略 */
  }
}

/* ============================================================
 * 装配入口（由 src/incremental-pages.js 一行调用，重复调用安全）
 * ============================================================ */
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
        /* 忽略 */
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

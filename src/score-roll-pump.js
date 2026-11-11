/**
 * 评分数字"补帧"修复（新增文件，零侵入）
 *
 * 现象：分类片库里第一次滑到的海报，评分显示 ★ 0.0；必须上滑再下滑才会变成真实分数。
 *
 * 根因（不是评分数据错，是动效把文字写坏了）：
 *   motion-scheduler 的 flush() 自己**不排下一帧**，它只在有人调用 requestTick() 时才跑一次。
 *   motion-extras 的 D2「评分数字翻滚」注册了一个订阅者，靠每帧的 write(now) 推进 progress：
 *
 *     write(_i, now) {
 *       const progress = (now - startedAt) / 700;
 *       pill.textContent = prefix + (target * easeOut(progress)).toFixed(1) + suffix;
 *     }
 *
 *   但没有任何人在这 700ms 里持续 requestTick()。全项目 requestTick 的调用点只有：
 *   scroll 事件、resize、以及 subscribe/watchVisible 的一次性触发。
 *   于是这串翻滚**只执行了一帧**：progress ≈ 0 → easeOut(0) = 0 → 文字被写成 "★ 0.0"，
 *   然后 data-cf30-roll="1" 已置位，rollScore 不会再启动，0.0 就永久留在那儿。
 *
 *   之后每次滚轮/滚动事件顺带触发一次 requestTick，就再"补"一帧 ——
 *   这正是"上滑再下滑才能得到正确评分"的机制：滑几次补几帧，补满 700ms 才落到真值。
 *
 * 修法：给调度器加一个限时泵。只要有任何一张评分正在翻滚，就在接下来 1.1s 内每帧 requestTick()，
 * 让 D2 的 write 正常走完 —— 落的还是它原本算出来的那个真值，动效一秒没删、一个参数没改。
 *
 * 另外兜一层：万一某张卡在这套修复生效前就已经被写成 0.0（例如旧的 localStorage / 更早的渲染），
 * 用翻滚开始前抓到的原文把它还原。原文是在 data-cf30-roll-armed 被置位的同一轮微任务里抓的，
 * 那时 rollScore 还没写过 textContent，所以拿到的一定是真实评分。
 *
 * 约束：全部 try/catch 静默降级，任何异常都不影响滚动与点击。
 */

import { requestTick, subscribe } from './motion-scheduler.js';

const ROLL_FLAG = 'data-cf30-roll';
const ARMED_FLAG = 'data-cf30-roll-armed';
const PILL_SELECTOR = '.score-pill';
/** D2 的 DURATION 是 700ms；留 400ms 余量给慢机器上的首帧。 */
const PUMP_MS = 1100;
/** 还原兜底：翻滚结束后再看一眼，确认没有被冻在 0.0。 */
const VERIFY_DELAY_MS = 260;
const BASE_TEXT = new WeakMap();
const PENDING = new Set();

let pumpUntil = 0;
let pumping = false;
let verifyTimer = 0;
let bound = false;

function now() {
  try {
    return window.performance.now();
  } catch (error) {
    return Date.now();
  }
}

/** 泵：write 里发现还没到截止时间就再要一帧。 */
const pumpSub = {
  active: true,
  write(_result, timestamp) {
    const at = Number.isFinite(timestamp) ? timestamp : now();
    if (at < pumpUntil) {
      requestTick();
      return;
    }
    pumping = false;
  }
};

function startPump(ms = PUMP_MS) {
  const until = now() + ms;
  if (until > pumpUntil) pumpUntil = until;
  if (pumping) return;
  pumping = true;
  try {
    requestTick();
  } catch (error) {
    pumping = false;
  }
}

const RATING_RE = /^★\s*(\d+(?:\.\d+)?)\s*·?\s*([\s\S]*)$/;

/** 翻滚开始前抓一份原文（此时 textContent 还是真实评分）。 */
function remember(pill) {
  try {
    if (!(pill instanceof HTMLElement)) return;
    if (BASE_TEXT.has(pill)) return;
    const text = (pill.textContent || '').trim();
    const matched = text.match(RATING_RE);
    if (!matched) return;
    BASE_TEXT.set(pill, text);
  } catch (error) {
    /* 忽略 */
  }
}

function ratingOf(text) {
  const matched = String(text || '').trim().match(RATING_RE);
  if (!matched) return null;
  const value = Number.parseFloat(matched[1]);
  return Number.isFinite(value) ? value : null;
}

/** 真实评分：先看翻滚前抓到的原文，再看豆瓣条目的 rating。 */
function truthFor(pill) {
  const base = BASE_TEXT.get(pill);
  const fromBase = base ? ratingOf(base) : null;
  if (fromBase && fromBase > 0) return { value: fromBase, text: base };

  try {
    const card = pill.closest('.movie-card');
    const rating = Number(card?.__cf8Item?.rating);
    if (Number.isFinite(rating) && rating > 0) {
      const suffix = String(pill.textContent || '').replace(RATING_RE, '$2') || '';
      return { value: rating, text: '★ ' + rating.toFixed(1) + ' · ' + (suffix || '').trim() };
    }
  } catch (error) {
    /* 忽略 */
  }
  return null;
}

function restore(pill) {
  try {
    if (!(pill instanceof HTMLElement) || !pill.isConnected) return false;
    const shown = ratingOf(pill.textContent);
    const truth = truthFor(pill);
    if (!truth) return false;
    // 只有"被写成 0.0 而真值不为 0"才动它；已经翻到位的绝不覆盖
    if (shown !== null && shown > 0) return false;
    pill.textContent = truth.text;
    return true;
  } catch (error) {
    return false;
  }
}

function scheduleVerify() {
  if (verifyTimer) return;
  verifyTimer = window.setTimeout(() => {
    verifyTimer = 0;
    for (const pill of PENDING) {
      try {
        if (!pill.isConnected) { PENDING.delete(pill); continue; }
        if (pill.getAttribute(ROLL_FLAG) !== '1') continue;
        const shown = ratingOf(pill.textContent);
        if (shown !== null && shown > 0) { PENDING.delete(pill); continue; }
        restore(pill);
        PENDING.delete(pill);
      } catch (error) {
        PENDING.delete(pill);
      }
    }
  }, PUMP_MS + VERIFY_DELAY_MS);
}

function handle(pill) {
  if (!(pill instanceof HTMLElement)) return;
  if (pill.getAttribute(ROLL_FLAG) === '1') {
    PENDING.add(pill);
    startPump();
    scheduleVerify();
  }
}

function scan(root) {
  try {
    const host = root instanceof Element || root instanceof Document ? root : document;
    host.querySelectorAll?.(PILL_SELECTOR).forEach((pill) => {
      if (pill.getAttribute(ROLL_FLAG) === '1') handle(pill);
      else remember(pill);
    });
  } catch (error) {
    /* 忽略 */
  }
}

function onMutations(records) {
  try {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (!(target instanceof HTMLElement) || !target.classList.contains('score-pill')) continue;
        if (record.attributeName === ARMED_FLAG) {
          // rollScore 在 IntersectionObserver 回调里才会写 textContent，
          // 这里还在回调之前的微任务里，抓到的就是真实评分
          remember(target);
        } else if (record.attributeName === ROLL_FLAG) {
          handle(target);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('score-pill')) {
          if (node.getAttribute(ROLL_FLAG) === '1') handle(node);
          else remember(node);
        }
        scan(node);
        scanUnrated(node);
      }
    }
  } catch (error) {
    /* 忽略 */
  }
}

/* ---------- 无评分条目的显示 ---------- */
/**
 * 豆瓣返回的条目里有一部分 rating 为空（新片、冷门片），基线 renderDoubanCards 写的是
 *   const score = (Number(item.rating) || 0).toFixed(1)  →  "★ 0.0 · 节目"
 * 0.0 在豆瓣语义里不是"零分"，是"还没有分"。用户看到的"评分显示不对"也包括这一种：
 * 一张 8.9 分的片和一张没有分的片长得一样，都是 0.0。
 *
 * 这里只改可见文字，不动 dataset、不动结构，且严格只认 __cf8Item.rating 为空 ——
 * TMDB 卡片（有 voteAverage）与已有评分的卡片一律不碰。
 * 尾部 "· 电影/节目/剧集" 原样保留，rec-inject.js 的 syncCardMediaType 用
 * /\s*·\s*(电影|节目|剧集)\s*$/ 收尾匹配，替换后仍然对得上。
 */
const NO_RATING_TEXT = '暂无';
const ZERO_PILL_RE = /^★\s*0(?:\.0+)?\s*(·\s*(?:电影|节目|剧集))?$/;

function fixUnrated(pill) {
  try {
    if (!(pill instanceof HTMLElement) || !pill.isConnected) return false;
    const card = pill.closest('.movie-card');
    if (!card || !card.hasAttribute('data-cf8-douban')) return false;
    const item = card.__cf8Item;
    if (!item) return false;
    if (String(item.rating || '').trim()) return false;      // 有分，不动
    const text = (pill.textContent || '').trim();
    const matched = text.match(ZERO_PILL_RE);
    if (!matched) return false;
    pill.textContent = NO_RATING_TEXT + (matched[1] ? ' ' + matched[1] : '');
    return true;
  } catch (error) {
    return false;
  }
}

function scanUnrated(root) {
  try {
    const host = root instanceof Element || root instanceof Document ? root : document;
    host.querySelectorAll?.('.movie-card[data-cf8-douban] .score-pill').forEach(fixUnrated);
  } catch (error) {
    /* 忽略 */
  }
}

function bind() {
  if (bound) return true;
  try {
    subscribe(pumpSub);
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [ROLL_FLAG, ARMED_FLAG]
    });
    scan(document);
    scanUnrated(document);
    window.setTimeout(() => scanUnrated(document), 1200);
    window.setTimeout(() => scanUnrated(document), 3600);
    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 评分补帧装配失败，已跳过', error); } catch (e) { /* 忽略 */ }
    return false;
  }
}

/** 装配入口，由 src/incremental-pages.js 一行调用；重复调用安全。 */
export function initScoreRollPump() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf37PumpInternals = { PUMP_MS, VERIFY_DELAY_MS, restore };

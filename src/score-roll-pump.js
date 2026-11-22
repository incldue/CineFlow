import { requestTick, subscribe } from './motion-scheduler.js';

const ROLL_FLAG = 'data-cf30-roll';
const ARMED_FLAG = 'data-cf30-roll-armed';
const PILL_SELECTOR = '.score-pill';

const PUMP_MS = 1100;

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

function remember(pill) {
  try {
    if (!(pill instanceof HTMLElement)) return;
    if (BASE_TEXT.has(pill)) return;
    const text = (pill.textContent || '').trim();
    const matched = text.match(RATING_RE);
    if (!matched) return;
    BASE_TEXT.set(pill, text);
  } catch (error) {

  }
}

function ratingOf(text) {
  const matched = String(text || '').trim().match(RATING_RE);
  if (!matched) return null;
  const value = Number.parseFloat(matched[1]);
  return Number.isFinite(value) ? value : null;
}

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

  }
  return null;
}

function restore(pill) {
  try {
    if (!(pill instanceof HTMLElement) || !pill.isConnected) return false;
    const shown = ratingOf(pill.textContent);
    const truth = truthFor(pill);
    if (!truth) return false;

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

  }
}

function onMutations(records) {
  try {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (!(target instanceof HTMLElement) || !target.classList.contains('score-pill')) continue;
        if (record.attributeName === ARMED_FLAG) {

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

  }
}

const NO_RATING_TEXT = '暂无';
const ZERO_PILL_RE = /^★\s*0(?:\.0+)?\s*(·\s*(?:电影|节目|剧集))?$/;

function fixUnrated(pill) {
  try {
    if (!(pill instanceof HTMLElement) || !pill.isConnected) return false;
    const card = pill.closest('.movie-card');
    if (!card || !card.hasAttribute('data-cf8-douban')) return false;
    const item = card.__cf8Item;
    if (!item) return false;
    if (String(item.rating || '').trim()) return false;
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
    try { console.warn('[CineFlow] 评分补帧装配失败，已跳过', error); } catch (e) {  }
    return false;
  }
}

export function initScoreRollPump() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf37PumpInternals = { PUMP_MS, VERIFY_DELAY_MS, restore };

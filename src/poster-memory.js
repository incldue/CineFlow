const CACHE_ENTRIES = 600;
const CACHE_CHARS = 40 * 1024 * 1024;
const PREFETCH_CONCURRENCY = 6;
const DISK_KEY = 'cf35-poster-v1';
const DISK_BUDGET = 3800 * 1024;
const DISK_ENTRIES = 260;
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const DOUBAN_IMAGE_RE = /^https:\/\/[a-z0-9-]+\.doubanio\.com\//i;
const CARD_SELECTOR = '.movie-card';
const FRAME_SELECTOR = '.poster-frame';

export function initPosterMemory() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf35PosterMemory === '1') return false;
  window.__cf35PosterMemory = '1';

  const diag = { replay: 0, prefetch: 0, stored: 0, entries: 0, chars: 0, failed: 0, rescued: 0, diskEntries: 0, diskFailed: 0 };
  window.__cf35 = window.__cf35 || {};
  window.__cf35.poster = diag;

  const memory = new Map();
  let totalChars = 0;

  const inflight = new Map();
  let running = 0;
  const queue = [];

  loadFromDisk();

  function identityOf(card) {
    if (!(card instanceof Element)) return '';
    const title = (card.querySelector('h3')?.textContent || '').trim().replace(/\s+/g, ' ');
    if (!title) return '';
    const meta = (card.querySelector('p')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const kind = card.hasAttribute('data-cf8-douban') || card.querySelector('.cf8-ph') ? 'd' : 't';
    let year = '';
    const item = card.__cf8Item;
    if (item && item.releaseDate) year = String(item.releaseDate).slice(0, 4);
    if (!year) {
      const matched = /(19|20)\d{2}/.exec(meta);
      if (matched) year = matched[0];
    }
    return kind + '|' + title + '|' + year + '|' + meta;
  }

  function loadFromDisk() {
    try {
      const raw = window.localStorage.getItem(DISK_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        if (typeof value !== 'string' || !DATA_URL_RE.test(value)) continue;
        memory.set(key, value);
        totalChars += value.length;
      }
      diag.entries = memory.size;
      diag.chars = totalChars;
    } catch (error) {

    }
  }

  let saveTimer = 0;
  function saveToDisk() {

    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      try {
        const out = {};
        let budget = 0;
        let count = 0;

        const entries = Array.from(memory.entries());
        for (let i = entries.length - 1; i >= 0 && count < DISK_ENTRIES; i -= 1) {
          const [key, value] = entries[i];
          if (budget + value.length > DISK_BUDGET) continue;
          out[key] = value;
          budget += value.length;
          count += 1;
        }
        window.localStorage.setItem(DISK_KEY, JSON.stringify(out));
        diag.diskEntries = count;
      } catch (error) {
        diag.diskFailed += 1;
      }
    }, 1200);
  }

  function remember(key, dataUrl) {
    if (!key || !dataUrl) return;
    if (memory.has(key)) {
      memory.delete(key);
      memory.set(key, dataUrl);
      diag.entries = memory.size;
      diag.chars = totalChars;
      return;
    }
    memory.set(key, dataUrl);
    totalChars += dataUrl.length;
    diag.stored += 1;
    while (memory.size > CACHE_ENTRIES || totalChars > CACHE_CHARS) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
      totalChars -= oldest.value.length;
    }
    diag.entries = memory.size;
    diag.chars = totalChars;
    saveToDisk();
  }

  function recall(key) {
    if (!memory.has(key)) return '';
    const value = memory.get(key);
    memory.delete(key);
    memory.set(key, value);
    return value;
  }

  function paint(card, dataUrl) {
    const frame = card.querySelector(FRAME_SELECTOR);
    if (!frame) return false;
    const existing = frame.querySelector('img');
    if (existing) {

      try {

        if (
          existing.complete &&
          existing.naturalWidth > 0 &&
          !existing.classList.contains('cf36-instant') &&
          Number(getComputedStyle(existing).opacity) < 0.5
        ) {
          existing.classList.add('is-loaded', 'cf36-instant');
          diag.rescued += 1;
        }
      } catch (error) {

      }
      return false;
    }

    let img;
    try {
      img = document.createElement('img');
      img.alt = (card.querySelector('h3')?.textContent || '').trim() + ' 海报';
      img.decoding = 'async';
      img.loading = 'eager';
      img.dataset.cf35Mem = '1';

      img.className = 'is-loaded cf36-instant';
      img.src = dataUrl;
    } catch (error) {
      diag.failed += 1;
      return false;
    }

    try {
      frame.insertBefore(img, frame.firstChild);
      diag.replay += 1;
      return true;
    } catch (error) {
      diag.failed += 1;
      return false;
    }
  }

  function pump() {
    while (running < PREFETCH_CONCURRENCY && queue.length) {
      const job = queue.shift();
      running += 1;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  function prefetch(card, key) {
    if (inflight.has(key)) return;

    const bridge = window.cineflowDouban;
    if (!bridge || typeof bridge.poster !== 'function') return;

    const item = card.__cf8Item || {};
    const title = (card.querySelector('h3')?.textContent || '').trim();
    if (!title) return;
    const meta = (card.querySelector('p')?.textContent || '').trim();
    const yearMatch = /(19|20)\d{2}/.exec(item.releaseDate || meta);
    const payload = {
      title,
      year: yearMatch ? Number(yearMatch[0]) : 0,
      mediaType: item.mediaType || (/剧集|电视剧|综艺/.test(meta) ? 'tv' : 'movie'),
      cover: item.cover || item.cf8Cover || ''
    };

    inflight.set(key, true);
    queue.push(async () => {
      try {

        let url = DOUBAN_IMAGE_RE.test(String(payload.cover || '')) ? payload.cover : '';
        if (!url) {
          const found = await bridge.poster({ title: payload.title, year: payload.year, type: payload.mediaType });
          if (found && found.ok && found.url) url = found.url;
        }
        if (!url || typeof bridge.image !== 'function') return;
        const bytes = await bridge.image({ url });
        if (!bytes || !bytes.ok || !bytes.base64) return;
        const dataUrl = 'data:' + (bytes.contentType || 'image/jpeg') + ';base64,' + bytes.base64;
        if (!DATA_URL_RE.test(dataUrl)) return;
        remember(key, dataUrl);
        diag.prefetch += 1;
        applyToLive(key, dataUrl);
      } catch (error) {
        diag.failed += 1;
      } finally {
        inflight.delete(key);
      }
    });
    pump();
  }

  function applyToLive(key, dataUrl) {
    let cards;
    try {
      cards = document.querySelectorAll(CARD_SELECTOR);
    } catch (error) {
      return;
    }
    for (const card of cards) {
      if (identityOf(card) === key) paint(card, dataUrl);
    }
  }

  function consider(card) {
    if (!(card instanceof Element) || !card.matches?.(CARD_SELECTOR)) return;
    const key = identityOf(card);
    if (!key) return;
    const known = recall(key);
    if (known) {
      paint(card, known);
      return;
    }

    if (card.hasAttribute('data-cf8-douban') || card.querySelector('.cf8-ph')) prefetch(card, key);
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches?.(CARD_SELECTOR)) consider(root);
    root.querySelectorAll?.(CARD_SELECTOR).forEach(consider);
  }

  document.addEventListener(
    'load',
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (!img.closest || !img.closest(FRAME_SELECTOR)) return;
      const src = img.getAttribute('src') || '';
      if (!DATA_URL_RE.test(src)) return;
      const card = img.closest(CARD_SELECTOR);
      if (!card) return;
      try {
        img.classList.add('is-loaded');
      } catch (error) {

      }
      remember(identityOf(card), src);
    },
    true
  );

  if (typeof MutationObserver === 'function') {
    try {
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') continue;
          record.addedNodes.forEach(scan);
        }
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (error) {
      return false;
    }
  }

  try {
    window.addEventListener('pagehide', saveToDisk, { once: true });
    window.addEventListener('beforeunload', saveToDisk, { once: true });
  } catch (error) {

  }

  document.querySelectorAll(CARD_SELECTOR).forEach(consider);
  return true;
}

export const __cf35PosterMemoryInternals = { CACHE_ENTRIES, CACHE_CHARS, DATA_URL_RE, DOUBAN_IMAGE_RE };

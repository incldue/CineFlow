

const CACHE_ENTRIES = 400;
const CACHE_CHARS = 48 * 1024 * 1024;
const POSTER_SELECTOR = '.poster-frame img, .cf3-thumb img, .cf25-poster-img';
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const READY_CLASS = 'cf34-ready';

export function initPosterCache() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.__cf34PosterCacheVersion === '2') return false;
  window.__cf34PosterCacheVersion = '2';

  const diag = { readyHits: 0, skippedSrc: 0, remembered: 0, entries: 0, chars: 0 };
  window.__cf34 = window.__cf34 || {};
  window.__cf34.poster = diag;
  const good = new Map();
  let totalChars = 0;

  function remember(key) {
    if (good.has(key)) {
      good.delete(key);
      good.set(key, true);
      return;
    }
    good.set(key, true);
    totalChars += key.length;
    diag.remembered += 1;
    while (good.size > CACHE_ENTRIES || totalChars > CACHE_CHARS) {
      const oldest = good.keys().next();
      if (oldest.done) break;
      good.delete(oldest.value);
      totalChars -= oldest.value.length;
    }
    diag.entries = good.size;
    diag.chars = totalChars;
  }

  function isGood(key) {
    if (!good.has(key)) return false;
    good.delete(key);
    good.set(key, true);
    return true;
  }

  function settle(img) {
    try {
      if (!img.classList.contains('is-loaded')) img.classList.add('is-loaded');
      if (!img.classList.contains(READY_CLASS)) img.classList.add(READY_CLASS);
    } catch (error) {
      /* 忽略 */
    }
  }

  function upgrade(img) {
    if (!(img instanceof HTMLImageElement)) return;

    try {
      if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
    } catch (error) {
      /* 忽略 */
    }

    const raw = img.getAttribute('src') || '';
    if (!DATA_URL_RE.test(raw)) return;

    // 已经显示过一次：绘制前直接落到最终态，零淡入
    if (isGood(raw)) {
      diag.readyHits += 1;
      settle(img);
      return;
    }

    // 正在加载：等它 load 成功再登记，避免把坏图记成好图
    if (img.dataset.cf34Watched !== '1') {
      img.dataset.cf34Watched = '1';
      img.addEventListener(
        'load',
        () => {
          try {
            const key = img.getAttribute('src') || '';
            if (DATA_URL_RE.test(key)) {
              remember(key);
              settle(img);
            }
          } catch (error) {
            /* 忽略 */
          }
        },
        { once: true }
      );
    }
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.tagName === 'IMG') upgrade(root);
    root.querySelectorAll?.(POSTER_SELECTOR).forEach(upgrade);
  }

  function sameSrc(img, next) {
    return (img.getAttribute('src') || '') === next;
  }

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const target = record.target;
          if (target instanceof HTMLImageElement) upgrade(target);
          continue;
        }
        record.addedNodes.forEach(scan);
      }
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
    } catch (error) {
      return false;
    }
  }

  document.querySelectorAll(POSTER_SELECTOR).forEach(upgrade);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (descriptor && descriptor.set && !window.__cf34SrcGuard) {
      window.__cf34SrcGuard = '1';
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get: descriptor.get,
        set(value) {
          try {
            if (typeof value === 'string' && sameSrc(this, value) && this.complete && this.naturalWidth > 0) {
              diag.skippedSrc += 1;
              return undefined;
            }
          } catch (error) {
            /* 忽略 */
          }
          return descriptor.set.call(this, value);
        }
      });
    }
  } catch (error) {
    /* 装不上就退化：只是少省一次解码 */
  }

  return true;
}

export const __cf34PosterCacheInternals = { CACHE_ENTRIES, CACHE_CHARS, DATA_URL_RE, READY_CLASS };

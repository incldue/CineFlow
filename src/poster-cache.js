/**
 * CineFlow 海报缓存与首帧直出（新增文件，零侵入）
 *
 * ⚠️ 第五十二轮重写。上一版把 data: URL 转成 Blob URL 提速，但 index.html 的 CSP
 *    是 `img-src 'self' https://image.tmdb.org http://127.0.0.1:* data:` —— **不含 blob:**。
 *    结果每张海报都在 `blob:` 上触发 error，douban-fallback 的 error 监听再补一遍
 *    data: URL，再被转成 blob: 再报错 —— 实测 1.8 秒一轮的死循环。这就是
 *    「首页以及分类片库的海报显示有很大延迟」的真因。
 *
 *    本版彻底不用 blob:，也不碰 CSP 之外的任何协议。
 *
 * 真正带来「丝滑」的是另外两件事，都不需要换协议：
 *
 *   1) 首帧直出
 *      premium-ui 把 .poster-frame img 的基础态写成 opacity: 0，靠 .is-loaded 才显形；
 *      豆瓣兜底路径再加一条 cf8Fade .32s 的淡入。于是每次轨道重建、切页回来、
 *      滚动触发重挂，海报都要从 0 淡入 320ms —— 用户感觉到的就是「慢半拍」。
 *      这里记住「这个 data: URL 已经成功显示过」，再次挂载时在 MutationObserver
 *      回调里同步补 is-loaded（MO 回调在绘制前执行），首帧就是最终态，零淡入。
 *      首次出现仍然走原有的淡入，观感一点没改。
 *
 *   2) 同 URL 不重设
 *      img.src 写成与当前完全相同的数据时，Chromium 仍会重新走一遍解码路径。
 *      重挂载的卡片经常带着同一个 data: URL，跳过这次赋值能省掉一次全量解码。
 *
 * 缓存以 data: URL 字符串本身为键（不复制字节），上限按字符数折算，只记录
 * 「是否已成功解码过」，不持有位图 —— 位图由 Chromium 自己的图片缓存管理。
 */

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

  /** dataUrl -> true。Map 的插入顺序即 LRU 顺序。 */
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

  /**
   * 让这张海报立刻处于最终可见态。
   *
   * 只补 is-loaded，不补 cf8-poster-loaded —— 后者会带起 cf8Fade 动画，
   * 反而又淡入一次。is-loaded 在 premium-ui 里就是 opacity: 1。
   */
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

  /* 同 URL 不重设：拦在 HTMLImageElement.prototype.src 的 setter 上。
   * 只跳过「值完全没变」的情况，语义等价，省一次全量解码。 */
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

/**
 * 首页沉浸式大海报 + 片名字标（新增文件，零侵入基线）
 *
 * 基线首页是「左文案 + 右海报」的两栏，片名是纯文字 #dailyTitle。这里补两件事，
 * 都是照着 www.movy.sx 首页 hero 的做法来的，但只做增量：
 *
 *   1) 字标（logo）：取 TMDB images 里的横版片名字标，叠在 #dailyTitle 上方；
 *      拿到并解码成功后才让文字淡出（html.cf-hero-logo-on），失败/无字标则
 *      一字不动 —— 文字标题永远在无障碍树里，零回归。
 *      选图规则与上游一致：只要 width > height，按 vote_average 降序，
 *      当前语言 → en → 任意。
 *
 *   2) 沉浸：背景层（#heroBackdrop）在宽屏下铺满 + 竖向蒙版溶解 + 横向压暗，
 *      这些全在 hero-immersive.css 里，这里只负责"背景就绪后再取字标"的时序。
 *
 * 时序很关键：字标属于锦上添花，不能跟首屏背景抢带宽。所以这里等
 * #heroBackdrop 真正有图（或 1.2s 超时）之后才发请求 —— 上游也是这么做的。
 */

import './hero-immersive.css';

const GATE_TIMEOUT_MS = 1200;
const GATE_POLL_MS = 90;

function backdropReady(doc) {
  const backdrop = doc.querySelector('#heroBackdrop');
  if (!backdrop) return false;
  const style = backdrop.style && backdrop.style.backgroundImage;
  return typeof style === 'string' && style.length > 8 && style !== 'none';
}

export function initHeroBillboard(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const api = deps.api || (typeof window !== 'undefined' ? window.cineflow : null);
  if (!doc || !api) return () => {};

  const bridge = () => (typeof window !== 'undefined' ? window.cineflowLogos : null);
  if (!bridge || !bridge()) {
    // 没有 log o 通道时仍然保留沉浸层（纯 CSS），只是不出字标
  }

  let disposed = false;
  let generation = 0;
  let daily = null;
  let lastTitle = '';
  let observer = null;

  function locale() {
    try {
      const lang = String((navigator && (navigator.language || navigator.userLanguage)) || 'zh').toLowerCase();
      return lang.slice(0, 2) || 'zh';
    } catch { return 'zh'; }
  }

  function clearLogo() {
    try {
      doc.documentElement.classList.remove('cf-hero-logo-on');
      const old = doc.getElementById('cfHeroLogo');
      if (old) old.remove();
    } catch { /* ignore */ }
  }

  function applyLogo(result) {
    if (disposed || !result || !result.ok || !result.url) return;
    const copy = doc.querySelector('#heroSection .hero-copy');
    const title = doc.getElementById('dailyTitle');
    if (!copy || !title) return;
    let img = doc.getElementById('cfHeroLogo');
    if (!img) {
      img = doc.createElement('img');
      img.id = 'cfHeroLogo';
      img.className = 'cf-hero-logo';
      img.alt = title.textContent || '';
      img.decoding = 'async';
      img.loading = 'eager';
      img.addEventListener('load', () => {
        if (disposed) return;
        // 等解码完成再淡出文字，避免"字没了图还没出来"的空窗
        const done = () => { try { doc.documentElement.classList.add('cf-hero-logo-on'); } catch { /* ignore */ } };
        if (typeof img.decode === 'function') img.decode().then(done).catch(done);
        else done();
      }, { once: true });
      img.addEventListener('error', () => { try { img.remove(); } catch { /* ignore */ } }, { once: true });
      title.insertAdjacentElement('beforebegin', img);
    }
    if (img.getAttribute('src') !== result.url) img.src = result.url;
    img.dataset.lang = result.lang || '';
  }

  async function loadForCurrent() {
    const mine = ++generation;
    const titleEl = doc.getElementById('dailyTitle');
    const text = titleEl ? String(titleEl.textContent || '').trim() : '';
    if (!daily || !daily.id) return;
    if (!text || /正在整理/.test(text)) return;
    if (!bridge || !bridge()) return;
    try {
      const result = await bridge().get({
        id: daily.id,
        mediaType: daily.mediaType || 'movie',
        locale: locale(),
      });
      if (disposed || mine !== generation) return;
      if (result && result.ok) applyLogo(result);
      else clearLogo();
    } catch { /* 静默：保留文字标题 */ }
  }

  function watchTitle() {
    const titleEl = doc.getElementById('dailyTitle');
    if (!titleEl) return;
    observer = new (doc.defaultView.MutationObserver)(() => {
      const text = String(titleEl.textContent || '').trim();
      if (!text || text === lastTitle) return;
      lastTitle = text;
      clearLogo();
      loadForCurrent();
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    lastTitle = String(titleEl.textContent || '').trim();
  }

  async function boot() {
    try {
      const data = await api.getInitialData();
      const entry = data && data.daily;
      const looksTmdb = !!(entry && (entry.posterPath || entry.poster_path || entry.overview || entry.voteAverage || entry.vote_average));
      if (entry && entry.id && looksTmdb) {
        daily = {
          id: Number(entry.id),
          mediaType: String(entry.mediaType || (entry.title ? 'movie' : 'movie')).toLowerCase() === 'tv' ? 'tv' : 'movie',
        };
      }
    } catch { daily = null; }

    watchTitle();

    const started = Date.now();
    const waitBackdrop = () => {
      if (disposed) return;
      if (backdropReady(doc) || Date.now() - started > GATE_TIMEOUT_MS) {
        loadForCurrent();
        return;
      }
      window.setTimeout(waitBackdrop, GATE_POLL_MS);
    };
    waitBackdrop();
  }

  // 首屏还没起来就先等一下，别和首批请求抢带宽
  const bootTimer = window.setTimeout(boot, 700);

  return function dispose() {
    disposed = true;
    window.clearTimeout(bootTimer);
    try { observer?.disconnect(); } catch { /* ignore */ }
    clearLogo();
  };
}

export default initHeroBillboard;

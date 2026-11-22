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
    } catch {  }
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

        const done = () => { try { doc.documentElement.classList.add('cf-hero-logo-on'); } catch {  } };
        if (typeof img.decode === 'function') img.decode().then(done).catch(done);
        else done();
      }, { once: true });
      img.addEventListener('error', () => { try { img.remove(); } catch {  } }, { once: true });
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
    } catch {  }
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

  const bootTimer = window.setTimeout(boot, 700);

  return function dispose() {
    disposed = true;
    window.clearTimeout(bootTimer);
    try { observer?.disconnect(); } catch {  }
    clearLogo();
  };
}

export default initHeroBillboard;

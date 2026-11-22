(() => {
  if (window.__cfRecV1) return;
  window.__cfRecV1 = true;

  const TAG = '[CineFlow:Rec]';
  const api = window.cineflowRec || null;
  const cf = window.cineflow || null;
  const TMDB_IMG = 'https://image.tmdb.org/t/p';
  const SEED_FLAG = 'cineflow:rec:v1';
  const FINISHED_RATIO = 0.96;
  const HOME_PAGE_SIZE = 24;

  const log = (...a) => { try { console.debug(TAG, ...a); } catch {  } };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  try {
    const style = document.createElement('style');
    style.id = 'cf-rec-perf-style';
    style.textContent = `
      /* 动画期间提升合成层, 避免逐帧重排/重绘 */
      body.cf3-switching .cf3-page { will-change: opacity; }
    `;
    (document.head || document.documentElement).appendChild(style);
  } catch {  }

  {
    let last = performance.now();
    let longFrames = 0;
    let checkedAt = last;
    let added = false;
    const LONG_MS = 34;
    const WINDOW_MS = 5000;
    const LONG_RATIO = 0.3;
    const tick = (now) => {
      try {
        const dt = now - last;
        last = now;
        if (dt > 1 && dt < 1000 && now - checkedAt < WINDOW_MS) {
          if (dt >= LONG_MS) longFrames += 1;
        }
        if (now - checkedAt >= WINDOW_MS) {
          const total = Math.max(1, Math.round((now - checkedAt) / 16.7));
          const unstable = longFrames / total >= LONG_RATIO;
          checkedAt = now;
          longFrames = 0;
          if (unstable && !added && !document.body.classList.contains('is-motion-throttled')) {
            document.body.classList.add('is-motion-throttled');
            added = true;
            log('检测到持续掉帧, 已启用动效降级');
          }
        }
      } catch {  }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const idle = (cb, timeout) => {
    if (window.requestIdleCallback) window.requestIdleCallback(cb, { timeout: timeout || 4000 });
    else setTimeout(cb, timeout || 3000);
  };
  let prewarmed = false;
  function prewarm() {
    if (prewarmed || !cf) return;
    prewarmed = true;
    idle(() => {
      try {

        Promise.allSettled([
          cf.discoverMovies && cf.discoverMovies({ sortBy: 'popularity.desc', page: 1 }),
          cf.discoverMovies && cf.discoverMovies({ sortBy: 'popularity.desc', minVotes: 120, page: 1 }),
          window.cineflowDouban && window.cineflowDouban.hot && window.cineflowDouban.hot({}),
        ]).catch(() => {});
      } catch {  }
      try {
        document.querySelectorAll('.cf3-page img, .movie-rail img').forEach((img) => {
          if (!img.complete && img.getAttribute('src')) img.decode && img.decode().catch(() => {});
        });
      } catch {  }
    }, 4000);
  }

  function startSearchRescue() {
    const douban = window.cineflowDouban;
    if (!douban || typeof douban.search !== 'function') return;
    const attemptAt = new Map();
    const resultCache = new Map();
    const imageCache = new Map();
    let busy = false;
    let rescueTimer = 0;
    let pendingQuery = '';

    const imageDataUrl = async (url) => {
      if (!url) return '';
      if (imageCache.has(url)) return imageCache.get(url);
      const result = await Promise.resolve(douban.image && douban.image({ url })).catch(() => null);
      const data = result && result.ok ? `data:${result.contentType || 'image/jpeg'};base64${result.base64 ? ',' + result.base64 : ''}` : '';
      if (data) {
        imageCache.set(url, data);
        if (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value);
      }
      return data;
    };

    const makeCard = (item) => {
      const card = document.createElement('article');
      card.className = 'movie-card';
      card.tabIndex = 0;
      card.dataset.cf8Douban = '1';
      const score = item.rating ? `★ ${item.rating}` : '★—';
      card.innerHTML = `
        <div class="poster-frame">
          <div class="cf8-ph">豆瓣</div>
          <div class="score-pill">${esc(score)} · ${item.mediaType === 'tv' ? '剧集' : '电影'}</div>
        </div>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.year || '豆瓣条目')}</p>
      `;

      card.__cf8Item = {
        id: item.id,
        title: item.title,
        mediaType: item.mediaType === 'tv' ? 'tv' : 'movie',
        cover: item.cover || '',
        rating: item.rating || '',
      };
      Promise.resolve(imageDataUrl(item.cover))
        .then((data) => {
          if (!data || !card.isConnected) return;
          const frame = card.querySelector('.poster-frame');
          if (!frame) return;
          const img = document.createElement('img');
          img.src = data;
          img.alt = `${item.title} 海报`;
          img.decoding = 'async';
          const ph = frame.querySelector('.cf8-ph');
          if (ph) frame.replaceChild(img, ph);
          else frame.prepend(img);
        })
        .catch(() => {});
      return card;
    };

    let credConfiguredFlag = null;

    const renderResults = (rail, items) => {
      const frag = document.createDocumentFragment();
      for (const item of items) frag.appendChild(makeCard(item));
      rail.innerHTML = '';
      rail.appendChild(frag);
      const hint = document.getElementById('searchHint');
      if (!hint) return;
      hint.textContent = '';
      const unconfigured = credConfiguredFlag === false;
      hint.appendChild(document.createTextNode(unconfigured ? '未配置 TMDB 凭证，已展示豆瓣兜底结果 ' : 'TMDB 无结果，已展示豆瓣兜底结果 '));
      if (unconfigured) {
        const link = document.createElement('span');
        link.textContent = '去配置 →';
        link.style.cssText = 'cursor:pointer;text-decoration:underline;color:#7cc4ff;';
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          const btn = document.getElementById('settingsBtn');
          if (btn) btn.click();
        });
        hint.appendChild(link);
      }
    };

    async function rescue(query) {
      if (busy) return;
      busy = true;
      try {

        try {
          const state = await Promise.resolve(cf && cf.getCredentialState ? cf.getCredentialState() : null);
          credConfiguredFlag = Boolean(state && state.configured);
        } catch {
          credConfiguredFlag = null;
        }
        const [movies, shows] = await Promise.all([
          Promise.resolve(douban.search({ query, type: 'movie', count: 12 })).catch(() => null),
          Promise.resolve(douban.search({ query, type: 'tv', count: 12 })).catch(() => null),
        ]);
        const rail = document.getElementById('searchRail');
        if (!rail) return;
        if (rail.querySelector('.movie-card:not([data-cf8-douban])')) return;
        const mv = (movies && movies.ok && movies.items) || [];
        const tv = (shows && shows.ok && shows.items) || [];
        const mixed = [];
        for (let i = 0; i < Math.max(mv.length, tv.length); i++) {
          if (mv[i]) mixed.push(mv[i]);
          if (tv[i]) mixed.push(tv[i]);
        }
        if (!mixed.length) return;
        resultCache.set(query, mixed);
        if (resultCache.size > 50) resultCache.delete(resultCache.keys().next().value);
        renderResults(rail, mixed);
        log(`搜索救援: "${query}" → ${mixed.length} 条豆瓣结果`);
      } catch {  } finally {
        busy = false;
      }
    }

    function check() {
      try {
        const section = document.getElementById('searchSection');
        const input = document.getElementById('globalSearch');
        const rail = document.getElementById('searchRail');
        if (!section || !input || !rail) return;
        if (section.classList.contains('is-hidden')) return;
        const query = String(input.value || '').trim();
        if (!query) return;
        if (rail.querySelector('.movie-card')) return;
        if (!rail.querySelector('.empty-state')) return;
        const cached = resultCache.get(query);
        if (cached && cached.length) {
          renderResults(rail, cached);
          return;
        }
        const prev = attemptAt.get(query);
        if (prev && Date.now() - prev < 10 * 60 * 1000) return;
        attemptAt.set(query, Date.now());
        if (attemptAt.size > 50) attemptAt.delete(attemptAt.keys().next().value);

        clearTimeout(rescueTimer);
        pendingQuery = query;
        rescueTimer = setTimeout(() => {
          const q = pendingQuery;
          pendingQuery = '';
          if (q) rescue(q);
        }, 500);
      } catch {  }
    }

    setInterval(check, 600);
    const railEl = document.getElementById('searchRail');
    if (railEl) {
      new MutationObserver(() => check()).observe(railEl, { childList: true });
    }
    log('搜索救援(豆瓣兜底)已挂载');
  }
  startSearchRescue();

  if (!api) {
    log('cineflowRec 桥不可用, 仅启用切页性能优化');
    prewarm();
    return;
  }

  const readLS = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  let sendTimer = 0;
  const sendQueue = [];
  function send(type, info, ts) {
    info = info || {};

    if (!info.isDouban && !Number.isFinite(info.id) && /^(movie|tv):\d+$/.test(String(info.key || ''))) {
      const parts = String(info.key).split(':');
      info.mediaType = parts[0];
      info.id = Number(parts[1]);
    }
    if (!info.key) return;
    const card = info.isDouban
      ? { id: info.id, mediaType: info.mediaType, title: info.title || '', posterPath: info.posterPath || null, cf8Douban: true }
      : Number.isFinite(info.id)
        ? { id: info.id, mediaType: info.mediaType, title: info.title || '', posterPath: info.posterPath || null }
        : null;
    sendQueue.push({ key: info.key, type, value: info.value, ts: ts || Date.now(), card });
    if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = 0;
        const batch = sendQueue.splice(0, sendQueue.length);
        if (batch.length) {
          Promise.resolve(api.track(batch)).catch(() => {});
          log(`track ×${batch.length}`);
          scheduleRailRefresh(6000);
        }
      }, 800);
    }
  }

  const enriched = new Set();
  const enrichQueue = [];
  let enrichBusy = false;
  function enrich(info) {
    if (!cf || !cf.getMovieDetails || !Number.isFinite(info.id) || info.isDouban) return;
    if (enriched.has(info.key) || enrichQueue.length > 12) return;
    enriched.add(info.key);
    if (enriched.size > 400) enriched.clear();
    enrichQueue.push(info);
    pumpEnrich();
  }
  function pumpEnrich() {
    if (enrichBusy) return;
    const next = enrichQueue.shift();
    if (!next) return;
    enrichBusy = true;
    cf
      .getMovieDetails(next.id, { mediaType: next.mediaType })
      .then((details) => {
        if (details && details.id !== undefined) {
          Promise.resolve(
            api.upsert([{
              id: details.id,
              mediaType: next.mediaType,
              title: details.title || details.name || next.title,
              overview: details.overview || '',
              posterPath: details.posterPath || null,
              backdropPath: details.backdropPath || null,
              voteAverage: details.voteAverage || 0,
              voteCount: details.voteCount || 0,
              releaseDate: details.releaseDate || '',
              genreIds: (details.genres || []).map((g) => g.id).filter(Number.isFinite),
            }]),
          ).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        enrichBusy = false;
        setTimeout(pumpEnrich, 250);
      });
  }

  const recentClicks = new Set();
  let lastDetailKey = '';
  let lastDetailAt = 0;
  window.addEventListener(
    'click',
    (event) => {
      try {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest('.movie-card');
        if (!card) return;
        const isDouban = card.dataset.cf8Douban === '1';
        const cf8 = card.__cf8Item || null;
        const mediaType = card.dataset.mediaType === 'tv' ? 'tv' : 'movie';
        let id = Number(card.dataset.movieId);
        let key = card.dataset.contentKey || '';
        if (isDouban) {
          id = Number((cf8 && cf8.id) || card.dataset.movieId);
          key = `douban:${id}`;
        } else if (!key && Number.isFinite(id)) {
          key = `${mediaType}:${id}`;
        }
        if (!key) return;
        const title = (card.querySelector('h3') && card.querySelector('h3').textContent) || (cf8 && cf8.title) || '';
        let posterPath = '';
        const img = card.querySelector('.poster-frame img');
        if (img) {
          const m = String(img.getAttribute('src') || '').match(/\/t\/p\/[^/]+(\/.+)$/);
          posterPath = m ? m[1] : '';
        }
        if (cf8 && cf8.cover) posterPath = String(cf8.cover);
        const info = { key, id, mediaType, title, posterPath, isDouban };
        if (!recentClicks.has(key)) {
          recentClicks.add(key);
          if (recentClicks.size > 200) recentClicks.clear();
          setTimeout(() => recentClicks.delete(key), 3000);
          send('click', info);
          enrich(info);
        }
        if (!isDouban) {
          lastDetailKey = key;
          lastDetailAt = Date.now();
        }
      } catch {  }
    },
    true,
  );

  const LS_PREFS = 'cineflow:prefs';
  const LS_HISTORY = 'cineflow:history:v3';
  let lastPrefsRaw = localStorage.getItem(LS_PREFS) || '';
  let lastHistoryRaw = localStorage.getItem(LS_HISTORY) || '';

  function diffPrefs(prev, next) {
    const emitKeys = (prevList, nextList, type) => {
      const before = new Set(prevList || []);
      for (const key of nextList || []) {
        if (typeof key === 'string' && key.includes(':') && !before.has(key) && !recentClicks.has(key)) {
          send(type, { key });
        }
      }
    };
    emitKeys(prev && prev.likedMovieIds, next.likedMovieIds, 'like');
    emitKeys(prev && prev.clickedMovieIds, next.clickedMovieIds, 'click');
    const beforeFav = new Set((prev && prev.favorites || []).map((f) => `${f.mediaType === 'tv' ? 'tv' : 'movie'}:${f.id}`));
    for (const fav of next.favorites || []) {
      if (!fav || fav.id === undefined) continue;
      const mediaType = fav.mediaType === 'tv' ? 'tv' : 'movie';
      const key = `${mediaType}:${fav.id}`;
      if (!beforeFav.has(key)) {
        send('like', { key, id: fav.id, mediaType, title: fav.title, posterPath: fav.posterPath, value: fav.value });
      }
    }
  }

  function diffHistory(prev, next) {
    const before = new Map((prev || []).map((h) => [h.key, h]));
    for (const item of next || []) {
      if (!item || !item.key || !item.id) continue;
      const old = before.get(item.key);
      const ratio = item.duration > 0 ? (item.progress || 0) / item.duration : 0;
      const oldRatio = old && old.duration > 0 ? (old.progress || 0) / old.duration : 0;
      const wasFinished = oldRatio >= FINISHED_RATIO;
      const isFinished = ratio >= FINISHED_RATIO;
      if (!old || Math.abs(ratio - oldRatio) > 0.02) {
        if (isFinished && !wasFinished) {
          send('finish', { key: item.key, id: item.id, mediaType: item.mediaType, title: item.title, posterPath: item.posterPath, value: item.progress }, item.updatedAt);
        } else if (!old || (item.progress || 0) > (old.progress || 0)) {
          send('play', { key: item.key, id: item.id, mediaType: item.mediaType, title: item.title, posterPath: item.posterPath }, item.updatedAt);
        }
      }
    }
  }

  function watchStorage() {
    try {
      const prefsRaw = localStorage.getItem(LS_PREFS) || '';
      if (prefsRaw !== lastPrefsRaw) {
        const prev = lastPrefsRaw ? JSON.parse(lastPrefsRaw) : null;
        const next = prefsRaw ? JSON.parse(prefsRaw) : null;
        lastPrefsRaw = prefsRaw;
        if (prev && next) diffPrefs(prev, next);
      }
      const historyRaw = localStorage.getItem(LS_HISTORY) || '';
      if (historyRaw !== lastHistoryRaw) {
        const prev = lastHistoryRaw ? JSON.parse(lastHistoryRaw) : null;
        const next = historyRaw ? JSON.parse(historyRaw) : null;
        lastHistoryRaw = historyRaw;
        if (next) diffHistory(prev, next);
      }
    } catch {  }
  }
  setInterval(watchStorage, 2500);
  window.addEventListener('storage', watchStorage);

  function seedIfNeeded() {
    try {
      if (localStorage.getItem(SEED_FLAG)) return;
      const prefs = readLS(LS_PREFS) || {};
      const history = readLS(LS_HISTORY) || [];
      const keyList = [];
      const seenSeed = new Set();
      const collect = (key, mediaType, id) => {
        if (typeof key === 'string' && key.includes(':') && !seenSeed.has(key)) {
          seenSeed.add(key);
          keyList.push({ key, mediaType: key.split(':')[0] === 'tv' ? 'tv' : 'movie', id });
        }
      };
      for (const key of prefs.likedMovieIds || []) collect(key);
      for (const key of prefs.clickedMovieIds || []) collect(key);
      for (const item of history || []) collect(item.key, item.mediaType, item.id);
      const hasSignal = keyList.length || (prefs.favorites || []).length;
      if (!hasSignal) {
        localStorage.setItem(SEED_FLAG, String(Date.now()));
        return;
      }
      const genreNames = {};
      const cards = [];

      const enrichSeed = async () => {
        for (const entry of keyList.slice(0, 40)) {
          try {
            const details = await Promise.resolve(cf.getMovieDetails(entry.id, { mediaType: entry.mediaType }));
            if (details && details.id !== undefined) {
              cards.push({
                id: details.id,
                mediaType: entry.mediaType,
                title: details.title || details.name || '',
                overview: details.overview || '',
                posterPath: details.posterPath || null,
                backdropPath: details.backdropPath || null,
                voteAverage: details.voteAverage || 0,
                voteCount: details.voteCount || 0,
                releaseDate: details.releaseDate || '',
                genreIds: (details.genres || []).map((g) => g.id).filter(Number.isFinite),
                genres: (details.genres || []).map((g) => g.name).filter(Boolean),
              });
            }
          } catch {  }
        }
      };
      const run = Promise.resolve(cf && cf.getInitialData ? cf.getInitialData() : null)
        .then((init) => {
          for (const g of (init && init.genres) || []) {
            if (g && Number.isFinite(Number(g.id))) genreNames[g.id] = g.name;
          }
        })
        .then(enrichSeed)
        .then(() => api.seed({ prefs, history, genreNames, cards }))
        .then((result) => {
          localStorage.setItem(SEED_FLAG, String(Date.now()));
          log(`存量偏好迁移完成: ${JSON.stringify(result)}`);
          scheduleRailRefresh(1200);
        })
        .catch((err) => log('seed 失败(下次重试):', err && err.message));
      void run;
    } catch {  }
  }

  const recCardMap = new Map();
  window.__cineflowRecCard = (key) => recCardMap.get(String(key)) || null;

  function imageUrl(path, size) {
    return path ? `${TMDB_IMG}/${size || 'w342'}${path}` : '';
  }

  function makeCard(movie, compact) {
    const card = document.createElement('article');
    card.className = compact ? 'movie-card compact' : 'movie-card';
    card.tabIndex = 0;
    card.dataset.movieId = String(movie.id);
    card.dataset.mediaType = movie.mediaType === 'tv' ? 'tv' : 'movie';
    card.dataset.contentKey = `${card.dataset.mediaType}:${movie.id}`;
    recCardMap.set(card.dataset.contentKey, movie);
    if (recCardMap.size > 600) {
      recCardMap.delete(recCardMap.keys().next().value);
    }
    const poster = imageUrl(movie.posterPath);
    const year = String(movie.releaseDate || '').slice(0, 4);
    card.innerHTML = `
      <div class="poster-frame">
        ${poster ? `<img src="${poster}" alt="${esc(movie.title)} 海报" loading="lazy" decoding="async" />` : '<div class="poster-fallback">No Poster</div>'}
        <div class="score-pill">★ ${Number(movie.voteAverage || 0).toFixed(1)} · ${card.dataset.mediaType === 'tv' ? '节目' : '电影'}</div>
      </div>
      <h3>${esc(movie.title)}</h3>
      <p>${esc(year || '未知年份')}</p>
    `;
    return card;
  }

  let homePage = 1;
  let homeBusy = false;
  let homeHasMore = true;
  let lastSwapSig = '';
  let refreshTimer = 0;

  function railSig(rail) {
    return Array.from(rail.querySelectorAll('.movie-card'))
      .map((c) => c.dataset.contentKey)
      .join('|');
  }

  function scheduleRailRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshHomeRail(true), delay || 3000);
  }

  async function refreshHomeRail(force) {
    const rail = document.getElementById('personalizedRail');
    if (!rail || homeBusy) return;
    if (!force && rail.childElementCount === 0) return;
    homeBusy = true;
    try {
      homePage = 1;
      const resp = await api.home({ size: HOME_PAGE_SIZE, page: 1 });
      const cards = (resp && resp.cards) || [];
      if (cards.length < 4) return;
      const frag = document.createDocumentFragment();
      for (const m of cards) frag.appendChild(makeCard(m));
      rail.innerHTML = '';
      rail.appendChild(frag);
      lastSwapSig = railSig(rail);
      const hint = document.getElementById('profileHint');
      if (hint) hint.textContent = `本地推荐引擎 · 基于你的 ${resp.events || 0} 条观看/收藏行为实时生成`;
      homeHasMore = resp.total > cards.length;
      const moreBtn = document.getElementById('personalizedMoreBtn');
      if (moreBtn) {
        moreBtn.hidden = !homeHasMore;
        moreBtn.disabled = false;
        moreBtn.textContent = '加载更多';
        moreBtn.onclick = () => loadMoreHome(moreBtn, rail);
      }
      log(`为你推荐已更新(${cards.length} 条, tier=${resp.coldTier})`);
    } catch {  } finally {
      homeBusy = false;
    }
  }

  async function loadMoreHome(btn, rail) {
    if (homeBusy || !homeHasMore) return;
    homeBusy = true;
    try {
      btn.disabled = true;
      btn.textContent = '加载中...';
      const resp = await api.home({ size: HOME_PAGE_SIZE, page: homePage + 1 });
      const cards = (resp && resp.cards) || [];
      if (!cards.length) {
        homeHasMore = false;
        btn.hidden = true;
        return;
      }
      homePage += 1;
      const frag = document.createDocumentFragment();
      for (const m of cards) frag.appendChild(makeCard(m, true));
      rail.appendChild(frag);
      homeHasMore = resp.total > homePage * HOME_PAGE_SIZE;
      btn.hidden = !homeHasMore;
      btn.disabled = false;
      btn.textContent = '加载更多';
    } catch {  } finally {
      homeBusy = false;
    }
  }

  function observeHomeRail() {
    const rail = document.getElementById('personalizedRail');
    if (!rail) {
      setTimeout(observeHomeRail, 800);
      return;
    }
    let timer = 0;
    new MutationObserver(() => {
      if (homeBusy) return;

      if (rail.querySelectorAll('.movie-card').length > HOME_PAGE_SIZE) return;
      if (railSig(rail) === lastSwapSig) return;
      clearTimeout(timer);
      timer = setTimeout(() => refreshHomeRail(false), 1500);
    }).observe(rail, { childList: true });
    setTimeout(() => refreshHomeRail(false), 3000);
  }

  function observeDetailPanel() {
    const panel = document.getElementById('detailContent');
    if (!panel) {
      setTimeout(observeDetailPanel, 800);
      return;
    }
    let timer = 0;
    new MutationObserver(() => {
      const rail = document.getElementById('detailRecommendations');
      if (!rail || rail.dataset.cfRecDone === '1' || !rail.childElementCount) return;
      clearTimeout(timer);
      timer = setTimeout(() => enhanceDetailSimilar(rail), 700);
    }).observe(panel, { childList: true, subtree: true });
  }

  async function enhanceDetailSimilar(rail) {
    try {

      if (!lastDetailKey || Date.now() - lastDetailAt > 90000) return;
      const resp = await api.similar(lastDetailKey, { size: 12 });
      const cards = (resp && resp.cards) || [];
      if (cards.length < 3) return;
      const frag = document.createDocumentFragment();
      for (const m of cards) frag.appendChild(makeCard(m, true));
      rail.innerHTML = '';
      rail.appendChild(frag);
      rail.dataset.cfRecDone = '1';
      log(`详情相似已增强(${cards.length} 条, 锚点 ${lastDetailKey})`);
    } catch {  }
  }

  prewarm();
  seedIfNeeded();
  observeHomeRail();
  observeDetailPanel();
  log('渲染层增强已装载');
})();

(() => {
  if (window.__cfPrewarmV2) return;
  window.__cfPrewarmV2 = true;
  const bridge = window.cineflowFast;
  if (!bridge || typeof bridge.prewarmMedia !== 'function') return;
  const log = (...a) => { try { console.debug('[CineFlow:Prewarm]', ...a); } catch {  } };

  let sweepTimer = 0;
  let lastSig = '';
  const collectUrls = () => {
    const list = document.getElementById('resourceResults');
    if (!list) return [];
    const urls = [];
    const cards = Array.from(list.querySelectorAll('.resource-card')).slice(0, 3);
    for (const card of cards) {
      const lines = Array.from(card.querySelectorAll('.resource-line')).slice(0, 3);
      lines.forEach((line, lineIndex) => {
        const buttons = Array.from(line.querySelectorAll('.resource-episode[data-play-url]'));
        const take = lineIndex === 0 ? 4 : (lineIndex === 1 ? 2 : 1);
        for (const b of buttons.slice(0, take)) {
          const url = b.getAttribute('data-play-url') || '';
          if (/^https?:\/\//i.test(url)) urls.push(url);
        }
      });
    }
    return [...new Set(urls)].slice(0, 8);
  };
  const sweep = () => {
    const urls = collectUrls();
    if (!urls.length) return;
    const sig = urls.join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    bridge.prewarmMedia(urls, 1).catch(() => {});
    log('扩展预热', urls.length, '条');
  };
  const armSweep = () => {
    const list = document.getElementById('resourceResults');
    if (!list) { setTimeout(armSweep, 800); return; }
    new MutationObserver(() => {
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(sweep, 900);
    }).observe(list, { childList: true });
    setTimeout(sweep, 1200);
  };
  armSweep();

  let lastLineButtons = null;
  let lastLineAt = 0;
  const prewarmNext = (buttons, fromIndex) => {
    const next = [];
    for (const b of buttons.slice(fromIndex + 1, fromIndex + 3)) {
      const url = b.getAttribute('data-play-url') || '';
      if (/^https?:\/\//i.test(url)) next.push(url);
    }
    if (next.length) bridge.prewarmMedia(next, 0).catch(() => {});
  };
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const cardBtn = target.closest('.resource-episode[data-play-url], .resource-open[data-play-url]');
    if (cardBtn) {
      const line = cardBtn.closest('.resource-line');
      const card = cardBtn.closest('.resource-card');
      const lineEl = line || (card ? card.querySelector('.resource-line') : null);
      const buttons = lineEl ? Array.from(lineEl.querySelectorAll('.resource-episode[data-play-url]')) : [];
      if (buttons.length) {
        lastLineButtons = buttons;
        lastLineAt = Date.now();
        const idx = buttons.indexOf(cardBtn);
        prewarmNext(buttons, idx >= 0 ? idx : 0);
      }
      return;
    }

    const playerBtn = target.closest('.player-episode-button');
    if (playerBtn && lastLineButtons && Date.now() - lastLineAt < 10 * 60 * 1000) {
      const index = Number(playerBtn.getAttribute('data-player-episode-index')) || 0;
      prewarmNext(lastLineButtons, index);
    }
  }, true);
  log('起播预热扩展已装载');
})();

(() => {
  if (window.__cfSilkV3) return;
  window.__cfSilkV3 = true;
  const db = window.cineflowDouban || null;
  const rec = window.cineflowRec || null;
  const log = (...a) => { try { console.debug('[CineFlow:Silk]', ...a); } catch {  } };
  const httpRe = /^https?:\/\//i;

  const readLibFilters = () => {
    const grid = document.querySelector('.cf3-grid');
    if (!grid) return null;
    const view = grid.closest('.cf3-library');
    const onText = (row) => row?.querySelector('.cf3-chip.is-on')?.textContent?.trim() || '';
    return {
      grid,
      media: onText(view?.querySelector('.cf3-media')) || '全部',
      genre: onText(view?.querySelector('.cf3-styles')) || '全部',
      sort: view?.querySelector('.cf3-fab-text')?.textContent?.trim() || '热度',
      year: onText(view?.querySelector('.cf3-year-row')) || '不限'
    };
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest('.cf3-chip');
    if (!chip) return;
    const grid = document.querySelector('.cf3-grid');
    if (!grid || !grid.closest('.cf3-library')) return;

    const filters = readLibFilters();
    if (!filters) return;
    const text = chip.textContent.trim();
    if (chip.closest('.cf3-media')) filters.media = text;
    else if (chip.closest('.cf3-styles')) filters.genre = text;
    else if (chip.closest('.cf3-sort-row')) filters.sort = text;
    else if (chip.closest('.cf3-year-row')) filters.year = text;
    const media = filters.media === '节目' ? 'tv' : (filters.media === '电影' ? 'movie' : 'all');
    rec?.setBrowseHint?.({
      media,
      genre: filters.genre === '全部' ? '' : filters.genre,
      sort: filters.sort,
      year: filters.year
    }).catch(() => {});
    schedulePrune(900);
  }, true);

  const metaWaiters = new Map();
  async function getYearMap(type, tag) {
    if (!rec?.doubanMeta) return null;
    const key = `${type}:${tag}`;
    if (metaWaiters.has(key)) return metaWaiters.get(key);
    const task = rec.doubanMeta({ type, tag }).catch(() => null).finally(() => metaWaiters.delete(key));
    metaWaiters.set(key, task);
    return task;
  }

  const yearOfCard = (card) => Number(String(card.__cf8Item?.year || '').slice(0, 4)) || 0;

  function applyYearMeta(cards, map) {
    if (!map || !map.size) return;
    for (const card of cards) {
      const item = card.__cf8Item;
      if (!item || item.year) continue;
      const year = map.get(String(item.id ?? ''));
      if (!year) continue;
      item.year = year;
      const p = card.querySelector(':scope > p');
      if (p && (!p.textContent || p.textContent === '未知年份')) p.textContent = year;
    }
  }

  let pruneToken = 0;
  let pruneBusy = false;
  async function pruneLibrary() {
    const filters = readLibFilters();
    if (!filters) return;
    const { grid } = filters;
    const cards = Array.from(grid.querySelectorAll('.movie-card[data-cf8-douban]'));
    if (!cards.length) return;
    const token = ++pruneToken;

    const needYear = filters.sort === '最新' || filters.sort === '最早' || filters.year === '2000~' || /^\d{4}$/.test(filters.year);
    if (needYear) {
      const tag = filters.genre === '全部' ? '热门' : filters.genre;
      const type = filters.media === '节目' ? 'tv' : (filters.media === '电影' ? 'movie' : null);
      try {
        if (type) {
          const map = await getYearMap(type, tag);
          if (token !== pruneToken) return;
          applyYearMeta(cards, map);
        } else {
          const [m, t] = await Promise.all([getYearMap('movie', tag), getYearMap('tv', tag)]);
          if (token !== pruneToken) return;
          applyYearMeta(cards, m);
          applyYearMeta(cards, t);
        }
      } catch {  }
    }

    if (filters.year === '2000~' || /^\d{4}$/.test(filters.year)) {
      for (const card of cards) {
        const year = String(card.__cf8Item?.year || '');
        const hide = year ? (filters.year === '2000~' ? (Number(year) || 9999) >= 2000 : year !== filters.year) : false;
        card.style.display = hide ? 'none' : '';
      }
    } else {
      for (const card of cards) card.style.display = '';
    }

    if (filters.sort === '评分' || filters.sort === '最新' || filters.sort === '最早') {
      const sorted = cards.slice().sort((a, b) => {
        if (filters.sort === '评分') return (Number(b.__cf8Item?.rating) || 0) - (Number(a.__cf8Item?.rating) || 0);
        return filters.sort === '最新' ? yearOfCard(b) - yearOfCard(a) : yearOfCard(a) - yearOfCard(b);
      });
      for (const card of sorted) grid.appendChild(card);
    }
  }

  function schedulePrune(delay = 400) {
    if (pruneBusy) return;
    pruneBusy = true;
    setTimeout(async () => {
      try { await pruneLibrary(); }
      catch (error) { log('修剪异常（保持现状）:', error && error.message); }
      finally { pruneBusy = false; }
    }, delay);
  }

  const armPrune = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armPrune, 800); return; }
    new MutationObserver(() => schedulePrune(400)).observe(app, { childList: true, subtree: true });
    schedulePrune(1400);
  };
  armPrune();

  const DOUBAN_CATEGORIES = {
    movie: [
      { label: '热门', kind: 'movie', category: '热门', type: '全部' },
      { label: '最新', kind: 'movie', category: '最新', type: '全部' },
      { label: '豆瓣高分', kind: 'movie', category: '豆瓣高分', type: '全部' },
      { label: '冷门佳片', kind: 'movie', category: '冷门佳片', type: '全部' },
      { label: '华语', kind: 'movie', category: '热门', type: '华语' },
      { label: '欧美', kind: 'movie', category: '热门', type: '欧美' },
      { label: '韩国', kind: 'movie', category: '热门', type: '韩国' },
      { label: '日本', kind: 'movie', category: '热门', type: '日本' }
    ],
    tv: [
      { label: '综合', kind: 'tv', category: 'tv', type: 'tv' },
      { label: '国产剧', kind: 'tv', category: 'tv', type: 'tv_domestic' },
      { label: '欧美剧', kind: 'tv', category: 'tv', type: 'tv_american' },
      { label: '日剧', kind: 'tv', category: 'tv', type: 'tv_japanese' },
      { label: '韩剧', kind: 'tv', category: 'tv', type: 'tv_korean' },
      { label: '动画', kind: 'tv', category: 'tv', type: 'tv_animation' },
      { label: '纪录片', kind: 'tv', category: 'tv', type: 'tv_documentary' },
      { label: '综艺', kind: 'show', category: 'show', type: 'show' }
    ],
    all: [
      { label: '热门电影', kind: 'movie', category: '热门', type: '全部' },
      { label: '热门剧集', kind: 'tv', category: 'tv', type: 'tv' },
      { label: '豆瓣高分', kind: 'movie', category: '豆瓣高分', type: '全部' },
      { label: '冷门佳片', kind: 'movie', category: '冷门佳片', type: '全部' },
      { label: '热门综艺', kind: 'show', category: 'show', type: 'show' }
    ]
  };
  let doubanCategory = null;

  let posterQueue = [];
  let posterActive = 0;
  function loadDoubanPoster(card, url) {
    if (!httpRe.test(String(url || ''))) return;
    posterQueue.push({ card, url });
    pumpPoster();
  }
  async function pumpPoster() {
    if (posterActive >= 3 || !posterQueue.length) return;
    posterActive += 1;
    const job = posterQueue.shift();
    try {
      if (!job.card.isConnected) return;
      const result = await db?.image?.({ url: job.url }).catch(() => null);
      if (result?.ok && job.card.isConnected) {
        const ph = job.card.querySelector('.poster-frame .cf8-ph');
        if (ph) {
          const img = document.createElement('img');
          img.decoding = 'async';
          img.loading = 'lazy';
          img.alt = '海报';
          img.src = `data:${result.contentType || 'image/jpeg'};base64,${result.base64}`;
          ph.replaceWith(img);
        }
      }
    } catch {  }
    finally {
      posterActive -= 1;
      pumpPoster();
    }
  }

  function renderDoubanCards(grid, items, label) {
    grid.innerHTML = '';
    grid.dataset.cf9Cat = label;
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'movie-card';
      card.tabIndex = 0;
      card.dataset.cf9 = '1';
      card.dataset.cf8Douban = '1';
      card.dataset.movieId = String(item.id ?? '');
      card.dataset.mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
      card.dataset.contentKey = `douban:${item.id}`;
      card.__cf8Item = {
        id: item.id,
        title: item.title,
        mediaType: item.mediaType === 'tv' ? 'tv' : 'movie',
        cover: item.cover || '',
        rating: item.rating || '',
        year: String(item.year || '').slice(0, 4)
      };
      const score = (Number(item.rating) || 0).toFixed(1);
      card.innerHTML = `
        <div class="poster-frame">
          <div class="cf8-ph">豆瓣</div>
          <div class="score-pill">★ ${score} · ${card.dataset.mediaType === 'tv' ? '节目' : '电影'}</div>
        </div>
        <h3></h3>
        <p></p>
      `;
      card.querySelector('h3').textContent = item.title || '';
      card.querySelector('p').textContent = card.__cf8Item.year || '未知年份';
      frag.appendChild(card);
      loadDoubanPoster(card, item.cover);
    }
    grid.appendChild(frag);
    log('豆瓣分类渲染:', label, items.length, '条');
  }

  async function loadDoubanCategory(grid, entry) {
    if (!rec?.doubanRecentHot) return;
    try {
      const result = await rec.doubanRecentHot({ kind: entry.kind, category: entry.category, type: entry.type, start: 0, limit: 50 });
      if (!result?.ok || !result.items?.length) return;
      renderDoubanCards(grid, result.items, entry.label);
      schedulePrune(300);
    } catch (error) {
      log('豆瓣分类拉取失败（保持现状）:', error && error.message);
    }
  }

  function takeoverGenreRow() {
    const filters = readLibFilters();
    if (!filters) return;
    const { grid } = filters;
    if (!grid.querySelector('[data-cf8-douban]') && !grid.querySelector('.cf3-empty')) return;
    if (!rec?.doubanRecentHot) return;
    const styleRow = filters.grid.closest('.cf3-library')?.querySelector('.cf3-styles');
    if (!styleRow) return;
    const media = filters.media === '节目' ? 'tv' : (filters.media === '电影' ? 'movie' : 'all');
    const categories = DOUBAN_CATEGORIES[media] || DOUBAN_CATEGORIES.all;

    if (styleRow.dataset.cf9Genres === media && styleRow.querySelector('.cf3-chip[data-cf9]')) return;
    styleRow.dataset.cf9Genres = media;
    styleRow.innerHTML = '';

    if (!doubanCategory || !categories.some((entry) => entry.label === doubanCategory.label)) {
      doubanCategory = categories[0];
    }
    for (const entry of categories) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cf3-chip';
      chip.dataset.cf9 = '1';
      chip.textContent = entry.label;
      chip.classList.toggle('is-on', entry.label === doubanCategory.label);
      chip.addEventListener('click', () => {
        if (doubanCategory.label !== entry.label) {
          doubanCategory = entry;
          styleRow.querySelectorAll('.cf3-chip').forEach((c) => c.classList.remove('is-on'));
          chip.classList.add('is-on');
        }

        rec?.setBrowseHint?.({
          media: media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : 'all'),
          genre: entry.label === '综合' ? '' : entry.label,
          sort: filters.sort,
          year: filters.year
        }).catch(() => {});
        loadDoubanCategory(grid, entry);
      });
      styleRow.appendChild(chip);
    }

    if (!grid.querySelector('[data-cf9="1"]')) {
      loadDoubanCategory(grid, doubanCategory);
    }
  }

  const armGenreRow = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armGenreRow, 800); return; }
    let timer = 0;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(takeoverGenreRow, 500);
    }).observe(app, { childList: true, subtree: true });
    setTimeout(takeoverGenreRow, 1400);
  };
  armGenreRow();

  const syncCardMediaType = (root) => {
    root.querySelectorAll?.('.movie-card[data-cf8-douban]').forEach((card) => {
      const item = card.__cf8Item;
      if (!item?.mediaType) return;
      if (card.dataset.mediaType !== item.mediaType) card.dataset.mediaType = item.mediaType;
      const pill = card.querySelector('.score-pill');
      if (pill) {
        const want = ` · ${item.mediaType === 'tv' ? (pill.textContent.includes('剧集') ? '剧集' : '节目') : '电影'}`;
        if (!pill.textContent.endsWith(want)) {
          pill.textContent = pill.textContent.replace(/\s*·\s*(电影|节目|剧集)\s*$/, '') + want;
        }
      }
    });
  };
  const armCardSync = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armCardSync, 800); return; }
    syncCardMediaType(app);
    let cardTimer = 0;
    new MutationObserver(() => {
      clearTimeout(cardTimer);
      cardTimer = setTimeout(() => syncCardMediaType(app), 200);
    }).observe(app, { childList: true, subtree: true });
  };
  armCardSync();

  log('豆瓣兜底修剪模式已装载（tag 改写由主进程执行；无重绘零闪屏）');
})();

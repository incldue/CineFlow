(() => {
  if (window.__cfPremiumV1) return;
  window.__cfPremiumV1 = true;
  const log = (...a) => { try { console.debug('[CineFlow:Premium]', ...a); } catch {  } };
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('is-motion-throttled');

  try {
    const style = document.createElement('style');
    style.id = 'cf-premium-style';
    style.textContent = `
      /* ---- E. 海报加载淡入 ---- */
      .poster-frame img { opacity: 0; transform: scale(1.025); transition: opacity .45s var(--cf-motion-spring, ease), transform .45s var(--cf-motion-spring, ease); }
      .poster-frame img.is-loaded { opacity: 1; transform: none; }

      /* ---- B. 卡片进度叠加 ---- */
      .cf9-card-progress { position: absolute; left: 10px; right: 10px; bottom: 8px; height: 5px; border-radius: 999px;
        background: rgba(255,255,255,.22); overflow: hidden; z-index: 3; }
      .cf9-card-progress > i { display: block; height: 100%; border-radius: 999px;
        background: linear-gradient(90deg, var(--accent, #9e8eff), #fff); }

      /* ---- C. 英雄区沉浸化（叠加层，不改基线规则） ---- */
      .hero-section { overflow: hidden; }
      .hero-section::after { content: ''; position: absolute; inset: auto 0 0 0; height: 62%;
        background: linear-gradient(180deg, transparent, rgba(6,8,16,.82)); pointer-events: none; z-index: 1; }
      .hero-copy, .hero-section .meta-row, .hero-section .hero-actions { position: relative; z-index: 2; }
      .hero-section .hero-backdrop { opacity: .62 !important;
        mask-image: linear-gradient(90deg, transparent, black 26%) !important;
        -webkit-mask-image: linear-gradient(90deg, transparent, black 26%) !important; }
      .cf9-hero-crossfade { position: absolute; inset: -34px -34px -34px -180px; opacity: .62; z-index: -1;
        background-size: cover; background-position: center; pointer-events: none;
        mask-image: linear-gradient(90deg, transparent, black 26%); -webkit-mask-image: linear-gradient(90deg, transparent, black 26%);
        transition: opacity .6s var(--cf-motion-luxury, ease); }
      .cf9-hero-crossfade.is-fading { opacity: 0; }
      .cf9-word { display: inline-block; animation: cf9WordUp .62s var(--cf-motion-spring, ease) both; animation-delay: var(--cf9-word-delay, 0ms); }
      @keyframes cf9WordUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

      /* ---- D. 轨道翻页按钮 + 两端渐隐 ---- */
      .cf9-rail-wrap { position: relative; }
      .cf9-rail-fade { pointer-events: none; position: absolute; top: 0; bottom: 0; width: 34px; z-index: 5; opacity: 0;
        transition: opacity .25s var(--cf-motion-fast, ease); }
      .cf9-rail-fade.is-left { left: -4px; background: linear-gradient(90deg, rgba(6,8,16,.85), transparent); }
      .cf9-rail-fade.is-right { right: -4px; background: linear-gradient(270deg, rgba(6,8,16,.85), transparent); }
      .cf9-rail-wrap.is-scrollable-left .is-left, .cf9-rail-wrap.is-scrollable-right .is-right { opacity: 1; }
      .cf9-rail-arrow { position: absolute; top: 42%; transform: translateY(-50%); z-index: 6; width: 38px; height: 38px;
        border-radius: 50%; border: 1px solid var(--glass-border, rgba(255,255,255,.14)); background: rgba(14,16,26,.66);
        backdrop-filter: blur(12px); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center;
        font-size: 17px; opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s var(--cf-motion-spring, ease); }
      .cf9-rail-arrow.is-visible { opacity: .92; pointer-events: auto; }
      .cf9-rail-arrow:hover { transform: translateY(-50%) scale(1.08); }
      .cf9-rail-arrow.is-prev { left: 6px; } .cf9-rail-arrow.is-next { right: 6px; }

      /* ---- A. 继续观看轨道 ---- */
      .cf9-continue-card { position: relative; width: 190px; flex: 0 0 auto; scroll-snap-align: start; }
      .cf9-continue-card .poster-frame { position: relative; }
      .cf9-continue-meta { display: flex; flex-direction: column; gap: 2px; padding: 8px 2px 0; }
      .cf9-continue-meta strong { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cf9-continue-meta span { font-size: 11.5px; opacity: .6; }
      .cf9-continue-card .cf9-card-progress { left: 8px; right: 8px; bottom: 6px; height: 4px; }
      .cf9-continue-hover { position: absolute; inset: 0; border-radius: inherit; display: flex; align-items: center; justify-content: center;
        background: rgba(6,8,16,.5); opacity: 0; transition: opacity .2s ease; z-index: 4; }
      .cf9-continue-card:hover .cf9-continue-hover, .cf9-continue-card:focus-visible .cf9-continue-hover { opacity: 1; }
      .cf9-continue-hover > button { appearance: none; border: 1px solid rgba(255,255,255,.3); background: rgba(20,22,34,.8);
        color: inherit; border-radius: 999px; padding: 8px 18px; font-size: 13px; cursor: pointer; backdrop-filter: blur(10px); }

      /* ---- F. 播放器体验包 ---- */
      .cf9-ctl-speed em { font-style: normal; opacity: .75; margin-left: 4px; }
      /* 黑膜：插入为舞台第一个子元素（DOM 顺序在 loader/error 之前），无 z-index →
         错误面板与加载器永远在黑膜之上；且任何情况下 2.6s 内强制揭膜 */
      .cf9-switch-veil { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none;
        transition: opacity .28s var(--cf-motion-fast, ease); }
      .player-stage.cf9-switching .cf9-switch-veil { opacity: 1; }
      .cf9-next-up { position: absolute; left: 50%; bottom: 18%; transform: translateX(-50%) translateY(8px); z-index: 40;
        display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-radius: 16px;
        background: rgba(12,14,24,.82); border: 1px solid rgba(255,255,255,.12); backdrop-filter: blur(14px);
        opacity: 0; pointer-events: none; transition: opacity .24s ease, transform .24s var(--cf-motion-spring, ease); }
      .cf9-next-up.is-visible { opacity: 1; pointer-events: auto; transform: translateX(-50%); }
      .cf9-next-up strong { font-size: 13.5px; }
      .cf9-next-up .cf9-count { font-size: 13px; opacity: .7; min-width: 18px; text-align: center; }
      .cf9-next-up button { appearance: none; border-radius: 999px; padding: 7px 16px; font-size: 12.5px; cursor: pointer;
        border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; }
      .cf9-next-up button.is-primary { background: var(--accent, #9e8eff); border-color: transparent; color: #14151e; font-weight: 600; }
      .cf9-toast { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(6px); z-index: 50;
        padding: 10px 18px; border-radius: 999px; background: rgba(12,14,24,.86); border: 1px solid rgba(255,255,255,.14);
        backdrop-filter: blur(12px); color: inherit; font-size: 12.5px; opacity: 0; pointer-events: none;
        transition: opacity .22s ease, transform .22s var(--cf-motion-spring, ease); max-width: min(560px, 80vw); text-align: center; }
      .cf9-toast.is-visible { opacity: 1; transform: translateX(-50%); }
    `;
    (document.head || document.documentElement).appendChild(style);
  } catch {  }

  document.addEventListener('load', (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.closest('.poster-frame')) {
      img.classList.add('is-loaded');
    }
  }, true);
  const markLoaded = (root) => {
    root.querySelectorAll?.('.poster-frame img').forEach((img) => {
      if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
    });
  };
  const armPosterFade = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armPosterFade, 800); return; }
    markLoaded(app);
    new MutationObserver(() => markLoaded(app)).observe(app, { childList: true, subtree: true });
  };
  armPosterFade();

  const armHero = () => {
    const hero = document.getElementById('heroSection');
    const backdrop = document.getElementById('heroBackdrop');
    const title = document.getElementById('dailyTitle');
    if (!hero || !backdrop || !title) { setTimeout(armHero, 800); return; }

    let crossfade = hero.querySelector('.cf9-hero-crossfade');
    if (!crossfade) {
      crossfade = document.createElement('div');
      crossfade.className = 'cf9-hero-crossfade';
      backdrop.parentElement?.insertBefore(crossfade, backdrop);
    }
    let lastBackdropUrl = backdrop.style.backgroundImage || '';
    new MutationObserver(() => {
      const next = backdrop.style.backgroundImage || '';
      if (!next || next === lastBackdropUrl) return;
      if (!reducedMotion()) {
        crossfade.style.backgroundImage = lastBackdropUrl;
        crossfade.classList.remove('is-fading');
        crossfade.classList.add('is-fading');
      }
      lastBackdropUrl = next;
    }).observe(backdrop, { attributes: true, attributeFilter: ['style'] });

    let lastTitle = '';
    const animateTitle = () => {
      const text = title.textContent?.trim() || '';
      if (!text || text === lastTitle) return;
      lastTitle = text;
      if (reducedMotion()) return;
      const words = text.split(/(\s+)/).filter(Boolean);
      title.innerHTML = '';
      words.forEach((word, index) => {
        const span = document.createElement('span');
        if (/^\s+$/.test(word)) { title.appendChild(document.createTextNode(' ')); return; }
        span.className = 'cf9-word';
        span.style.setProperty('--cf9-word-delay', `${Math.min(index * 46, 420)}ms`);
        span.textContent = word;
        title.appendChild(span);
      });
    };
    animateTitle();
    new MutationObserver(animateTitle).observe(title, { childList: true, characterData: true, subtree: true });
    log('英雄区沉浸化已装配');
  };
  armHero();

  const decorateRail = (rail) => {
    if (!(rail instanceof HTMLElement) || rail.dataset.cf9Rail === '1') return;
    const host = rail.parentElement;
    if (!host) return;
    rail.dataset.cf9Rail = '1';
    host.classList.add('cf9-rail-wrap');
    const make = (direction) => {
      const fade = document.createElement('div');
      fade.className = `cf9-rail-fade ${direction === -1 ? 'is-left' : 'is-right'}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cf9-rail-arrow ${direction === -1 ? 'is-prev' : 'is-next'}`;
      button.setAttribute('aria-label', direction === -1 ? '向左滚动' : '向右滚动');
      button.textContent = direction === -1 ? '‹' : '›';
      button.addEventListener('click', () => {
        rail.scrollBy({ left: direction * rail.clientWidth * 0.82, behavior: reducedMotion() ? 'auto' : 'smooth' });
      });
      host.append(fade, button);
      return { fade, button };
    };
    const prev = make(-1);
    const next = make(1);
    const sync = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      host.classList.toggle('is-scrollable-left', rail.scrollLeft > 8);
      host.classList.toggle('is-scrollable-right', rail.scrollLeft < max - 8);
      prev.button.classList.toggle('is-visible', rail.scrollLeft > 8);
      next.button.classList.toggle('is-visible', rail.scrollLeft < max - 8);
    };
    rail.addEventListener('scroll', sync, { passive: true });
    new ResizeObserver(sync).observe(rail);
    sync();
  };
  const armRails = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armRails, 800); return; }
    const scan = () => app.querySelectorAll('.movie-rail:not([data-cf9-rail])').forEach(decorateRail);
    scan();
    new MutationObserver(scan).observe(app, { childList: true, subtree: true });
  };
  armRails();

  const HISTORY_KEY = 'cineflow:history:v3';
  const readHistory = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  };
  const ratioOf = (entry) => (Number(entry.duration) > 0 ? Math.min(1, Number(entry.progress) / Number(entry.duration)) : 0);
  const historyIndex = () => {
    const index = new Map();
    for (const entry of readHistory()) {
      if (entry.key) index.set(String(entry.key), entry);
    }
    return index;
  };
  const syncCardProgress = () => {
    const index = historyIndex();
    if (!index.size) return;
    document.querySelectorAll('.movie-card[data-content-key]').forEach((card) => {
      const entry = index.get(card.dataset.contentKey || '');
      const frame = card.querySelector('.poster-frame');
      if (!frame) return;
      const existing = frame.querySelector('.cf9-card-progress');
      if (!entry || ratioOf(entry) <= 0.01 || ratioOf(entry) >= 0.96) { existing?.remove(); return; }
      const percent = Math.round(ratioOf(entry) * 100);
      if (existing) { existing.querySelector('i').style.width = `${percent}%`; return; }
      const bar = document.createElement('div');
      bar.className = 'cf9-card-progress';
      bar.innerHTML = '<i></i>';
      bar.querySelector('i').style.width = `${percent}%`;
      frame.appendChild(bar);
    });
  };
  const armCardProgress = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armCardProgress, 800); return; }
    let timer = 0;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(syncCardProgress, 300);
    }).observe(app, { childList: true, subtree: true });
    syncCardProgress();
  };
  armCardProgress();

  window.addEventListener('storage', (event) => {
    if (event.key === HISTORY_KEY) syncCardProgress();
  });

  const SPEEDS = [1, 1.25, 1.5, 2, 3, 0.75];
  const getVideo = () => document.getElementById('resourcePlayer');
  const activeEpisodeButton = () => document.querySelector('#playerEpisodeList .player-episode-button.is-active');
  const nextEpisodeButton = () => {
    const active = activeEpisodeButton();
    return active ? active.nextElementSibling?.matches?.('.player-episode-button') ? active.nextElementSibling : null : null;
  };

  let veil = null;
  let veilTimer = 0;
  const ensureVeil = () => {
    const stage = document.getElementById('playerStage');
    if (!stage) return null;
    if (!veil || !stage.contains(veil)) {
      veil = document.createElement('div');
      veil.className = 'cf9-switch-veil';

      stage.insertBefore(veil, stage.firstChild);
    }
    return veil;
  };
  const liftVeil = () => {
    clearTimeout(veilTimer);
    document.getElementById('playerStage')?.classList.remove('cf9-switching');
  };
  const dropVeil = () => {

    clearTimeout(veilTimer);
    veilTimer = setTimeout(liftVeil, 2600);
  };

  let nextUp = null;
  let nextUpTimer = 0;
  const hideNextUp = () => {
    clearTimeout(nextUpTimer);
    nextUp?.classList.remove('is-visible');
  };
  const showNextUp = () => {
    const stage = document.getElementById('playerStage');
    const next = nextEpisodeButton();
    if (!stage || !next) return;
    if (!nextUp || !stage.contains(nextUp)) {
      nextUp = document.createElement('div');
      nextUp.className = 'cf9-next-up';
      nextUp.innerHTML = '<strong></strong><span class="cf9-count"></span><button type="button" class="is-primary">立即播放</button><button type="button">取消</button>';
      nextUp.querySelector('button.is-primary').addEventListener('click', () => { hideNextUp(); next.click(); });
      nextUp.querySelector('button:not(.is-primary)').addEventListener('click', hideNextUp);
      stage.appendChild(nextUp);
    }
    nextUp.querySelector('strong').textContent = `即将播放 · ${next.textContent.trim().slice(0, 24)}`;
    let remain = 5;
    const count = nextUp.querySelector('.cf9-count');
    count.textContent = `${remain}s`;
    nextUp.classList.add('is-visible');
    clearTimeout(nextUpTimer);
    nextUpTimer = setTimeout(() => { hideNextUp(); next.click(); }, 5200);
    const tick = setInterval(() => {
      remain -= 1;
      if (remain <= 0 || !nextUp?.classList.contains('is-visible')) { clearInterval(tick); return; }
      count.textContent = `${remain}s`;
    }, 1000);
  };

  const decoratePlayer = () => {
    const modal = document.getElementById('playerModal');
    const actions = document.querySelector('.player-actions');
    const video = getVideo();
    if (!modal || !actions || !video || actions.querySelector('.cf9-ctl-speed')) return;

    const speedButton = document.createElement('button');
    speedButton.type = 'button';
    speedButton.className = 'secondary-button cf9-ctl-speed';
    speedButton.innerHTML = '倍速<em>×1.0</em>';
    speedButton.addEventListener('click', () => {
      const current = video.playbackRate || 1;
      const next = SPEEDS[(SPEEDS.indexOf(current) + 1) % SPEEDS.length] ?? 1;
      video.playbackRate = next;
      speedButton.querySelector('em').textContent = `×${next === 1 ? '1.0' : next}`;
      log('倍速:', next);
    });

    const pipButton = document.createElement('button');
    pipButton.type = 'button';
    pipButton.className = 'secondary-button cf9-ctl-pip';
    pipButton.textContent = '画中画';
    if (!document.pictureInPictureEnabled) pipButton.disabled = true;
    pipButton.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (error) { log('画中画不可用:', error && error.message); }
    });

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'secondary-button cf9-ctl-next';
    nextButton.textContent = '下一集';
    nextButton.addEventListener('click', () => nextEpisodeButton()?.click());

    actions.prepend(nextButton, pipButton, speedButton);

    ensureVeil();

    video.addEventListener('loadstart', () => {
      document.getElementById('playerStage')?.classList.add('cf9-switching');
      dropVeil();
    });
    for (const eventName of ['playing', 'canplay', 'error', 'emptied', 'stalled', 'abort']) {
      video.addEventListener(eventName, liftVeil);
    }
    video.addEventListener('error', () => {
      liftVeil();

      setTimeout(() => {
        const message = document.querySelector('#playerError span')?.textContent?.trim();
        if (message && document.querySelector('.player-stage.has-error')) {
          showToast(`播放失败：${message.slice(0, 60)}（可换线路或播放源）`);
        }
      }, 250);
    });
    video.addEventListener('ended', () => {
      if (!reducedMotion()) showNextUp();
      else nextEpisodeButton()?.click();
    });

    document.getElementById('playerEpisodeList')?.addEventListener('click', hideNextUp);
    log('播放器体验包已装配（倍速/画中画/下一集/自动连播/黑场过渡）');
  };

  let toastNode = null;
  let toastTimer = 0;
  const showToast = (message) => {
    try {
      if (!toastNode || !toastNode.isConnected) {
        toastNode = document.createElement('div');
        toastNode.className = 'cf9-toast';
        (document.getElementById('app') || document.body).appendChild(toastNode);
      }
      toastNode.textContent = String(message || '').slice(0, 120);
      toastNode.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastNode?.classList.remove('is-visible'), 4200);
    } catch {  }
  };
  const armPlayer = () => {
    const app = document.getElementById('app');
    if (!app) { setTimeout(armPlayer, 800); return; }
    let timer = 0;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(decoratePlayer, 250);
    }).observe(app, { childList: true, subtree: true });
    decoratePlayer();
  };
  armPlayer();

  log('顶级体验层已装载（继续观看/英雄区/轨道翻页/海报淡入/播放器包）');
})();

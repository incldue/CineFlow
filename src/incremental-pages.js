import { createPageTransition } from './page-transition.js';
import { createLibraryPage } from './library-page.js';
import { createHistoryPage } from './history-page.js';
import { createHistoryResume } from './history-resume.js';
import { initHistoryStore } from './history-store.js';
import { initIncrementalSettings } from './incremental-settings.js';
import { initIncrementalSourceManager } from './source-manager.js';
import { initSearchHistory } from './search-history.js';
import { initResourcePrewarm } from './resource-prewarm.js';
import { initDetailPrewarm } from './detail-prewarm.js';
import { initDualSearch } from './dual-search.js';
import { initDoubanFallback } from './douban-fallback.js';
import { initUpdateBubble } from './update-bubble.js';
import { initTmdbWizard } from './tmdb-wizard.js';
import { initPlayerAnchor } from './player-anchor.js';
import { initSearchWorkbench } from './search-workbench.js';
import { initPosterFocus } from './poster-focus.js';
import { initMotionExtras } from './motion-extras.js';
import { initMotionPerf } from './motion-perf.js';
import { initStabilityGuard } from './stability-guard.js';
import { initResponseBoost } from './response-boost.js';
import { initTimerGovernor } from './timer-governor.js';
import { initProgressGate } from './progress-gate.js';
import { initPosterCache } from './poster-cache.js';
import { initPosterMemory } from './poster-memory.js';
import { initScoreRollPump } from './score-roll-pump.js';
import { initRailGlide } from './rail-glide.js';
import { initCardTilt } from './card-tilt.js';
import { initPlayerActionCleanup } from './player-actions-cleanup.js';
import { initInteractionExtras, showOneshotTip } from './interaction-extras.js';
import { initSessionHygiene } from './session-hygiene.js';
import { initStageSeam } from './stage-seam.js';
import { initMovyQualityMenu } from './movy-quality-menu.js';
import { initMovySubtitle } from './movy-subtitle-layer.js';
import { initPlayerSkip } from './player-skip.js';
import { initHeroBillboard } from './hero-billboard.js';
import { initRemoteLibraryPanel } from './remote-library-panel.js';
import { initSettingsLayout } from './settings-layout.js';
import { initGpuGuardCard } from './gpu-guard-card.js';

const ISLAND_CLASSES = ['island-mode', 'island-expanded-mode', 'island-docked-mode'];
const PRELOAD_DELAY_MS = 2200;

function mountPages(deps) {
  const root = document.getElementById('app');
  if (!root || root.dataset.cf3Pages === '1') return false;
  root.dataset.cf3Pages = '1';
  const { api, state, escapeHtml } = deps;

  const isIsland = () => ISLAND_CLASSES.some((name) => document.body.classList.contains(name));

  initStabilityGuard();

  initResponseBoost();

  initTimerGovernor();

  initProgressGate();

  initPosterCache();

  initPosterMemory();

  initScoreRollPump();

  initRailGlide();

  initCardTilt();

  initPlayerActionCleanup();

  if (initInteractionExtras()) {
    window.setTimeout(() => showOneshotTip('cf34-boost', '极速模式已启用'), 2600);
  }

  initHistoryStore({ state, api });
  initIncrementalSettings({ api, state });
  initIncrementalSourceManager({ api, state, escapeHtml });
  initSearchHistory({ api, state });
  initResourcePrewarm({ api, state });
  initDetailPrewarm({ api, state });
  initDualSearch({ api, state });
  initDoubanFallback({ api, state });
  initUpdateBubble({ api, state });
  initTmdbWizard({ api, state });
  initPlayerAnchor({ api, state });
  initSearchWorkbench({ api, state, escapeHtml });
  initPosterFocus();
  initMotionExtras();
  initMotionPerf();

  initSessionHygiene();

  initStageSeam();

  initMovyQualityMenu({ api, state });
  initMovySubtitle({ api, state });

  initPlayerSkip();

  initHeroBillboard({ api });

  initRemoteLibraryPanel();

  initSettingsLayout();

  initGpuGuardCard();

  const library = createLibraryPage({ api, state, escapeHtml });
  const history = createHistoryPage({ state, escapeHtml, resume: createHistoryResume({ state }) });

  const inflight = new WeakMap();
  function once(target, run) {
    const pending = inflight.get(target);
    if (pending) return pending;
    const promise = Promise.resolve()
      .then(() => run())
      .catch(() => {})
      .finally(() => { inflight.delete(target); });
    inflight.set(target, promise);
    return promise;
  }
  const libraryOnce = () => once(library, () => library.activate());
  const historyOnce = () => once(history, () => history.activate());

  const stage = createPageTransition({
    root,
    pages: [
      { id: 'home', el: null },
      {
        id: 'library',
        el: library.el,
        activate: libraryOnce,

        prepare: libraryOnce,
        settle: () => library.settle(),
      },
      {
        id: 'history',
        el: history.el,

        activate: historyOnce,
        prepare: historyOnce,
        settle: () => history.settle?.(),
      },
    ],
  });

  let preloaded = false;

  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
    : (cb) => window.setTimeout(cb, 400);
  window.setTimeout(() => {
    if (preloaded || isIsland() || stage.getCurrent() !== 0) return;
    preloaded = true;
    idle(() => {
      if (isIsland() || stage.getCurrent() !== 0) return;
      stage.preload(1);
      idle(() => {
        if (isIsland() || stage.getCurrent() !== 0) return;
        stage.preload(2);
      });
    });
  }, Math.max(PRELOAD_DELAY_MS, 4000));

  new MutationObserver(() => stage.setEnabled(!isIsland())).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  const settingsModal = document.querySelector('#settingsModal');
  if (settingsModal) {
    new MutationObserver(() => {
      if (settingsModal.classList.contains('is-hidden') && stage.getCurrent() === 1) libraryOnce();
    }).observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  }

  return true;
}

export function initIncrementalPages(deps = {}) {
  try {
    return mountPages(deps);
  } catch (error) {
    console.warn('[CineFlow] 分类片库 / 播放历史与三页切换装配失败，已跳过', error);
    return false;
  }
}

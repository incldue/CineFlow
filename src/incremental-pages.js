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
import { initInteractionExtras, showOneshotTip } from './interaction-extras.js';

const ISLAND_CLASSES = ['island-mode', 'island-expanded-mode', 'island-docked-mode'];
const PRELOAD_DELAY_MS = 2200;

function mountPages(deps) {
  const root = document.getElementById('app');
  if (!root || root.dataset.cf3Pages === '1') return false;
  root.dataset.cf3Pages = '1';
  const { api, state, escapeHtml } = deps;

  const isIsland = () => ISLAND_CLASSES.some((name) => document.body.classList.contains(name));

  // 先装稳定性守卫：douban-fallback 的 1200ms 空轨道轮询要在它之后才被接管
  initStabilityGuard();
  // 响应速度：滚动期让位 + 隐藏页休眠。要早装，越早第一帧越省。
  initResponseBoost();
  // 定时器治理：失焦/滚动/切页期间让常驻轮询空转，恢复时不重建、不漂移。
  // 必须排在其余 init 之前 —— 它们注册的 setInterval 才会被门控到。
  initTimerGovernor();
  // 骨架屏 100ms 门控：秒回的请求不再闪一下（animeko FastLinearProgressIndicator）。
  initProgressGate();
  // 海报兜底 data: URL 的"已解码"标记与同 URL 不重设（不换协议，见 poster-cache.js 头注释）。
  initPosterCache();
  // 轨道被基线重建 3~5 次导致海报管线每次重来 —— 记住字节，重建后第一帧直出。
  initPosterMemory();
  // 评分翻滚只跑了一帧就被冻在 0.0（motion-scheduler 不自排下一帧）—— 补一个限时泵。
  initScoreRollPump();
  // 首页两个轨道：隐藏滚动条 + 指针感应滑动 + 吸附最近海报。
  initRailGlide();
  // 悬停姿态跟手：卡片按指针位置做 3D 倾斜，不再是写死的固定动作。
  initCardTilt();
  // 横向轨道接受滚轮 + 一次性提示（animeko NestedScrollWorkaround / OneshotTip）。
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

  const library = createLibraryPage({ api, state, escapeHtml });
  const history = createHistoryPage({ state, escapeHtml, resume: createHistoryResume({ state }) });

  const stage = createPageTransition({
    root,
    pages: [
      { id: 'home', el: null },
      {
        id: 'library',
        el: library.el,
        activate: () => library.activate(),

        prepare: () => library.activate(),
        settle: () => library.settle(),
      },
      {
        id: 'history',
        el: history.el,

        activate: () => history.activate(),
        prepare: () => history.activate(),
        settle: () => history.settle?.(),
      },
    ],
  });

  let preloaded = false;
  window.setTimeout(() => {
    if (preloaded || isIsland() || stage.getCurrent() !== 0) return;
    preloaded = true;
    stage.preload(1);
    stage.preload(2);
  }, PRELOAD_DELAY_MS);

  new MutationObserver(() => stage.setEnabled(!isIsland())).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  const settingsModal = document.querySelector('#settingsModal');
  if (settingsModal) {
    new MutationObserver(() => {
      if (settingsModal.classList.contains('is-hidden') && stage.getCurrent() === 1) library.activate();
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

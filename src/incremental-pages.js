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
  // 播放器操作栏：去掉与「外部打开」同义的「复制链接」按钮。
  initPlayerActionCleanup();
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
  // 第六十八轮：长时运行保活（自适应降级 / 休眠页图片回收 / 播放器资源归还 / 空闲维护）。
  initSessionHygiene();
  // 第六十九轮：片库 / 历史页与顶栏上沿严格对齐（覆盖基线的 +2px 余量）。
  initStageSeam();
  // 第七十轮：内置 Movy 源（详情页 Quality 两层弹层：服务器测活 + 画质）。
  initMovyQualityMenu({ api, state });
  initMovySubtitle({ api, state });
  // 第七十轮：播放器 ±10 秒快进快退（键盘 + 左右双击，连按合并）。
  initPlayerSkip();
  // 第七十轮：首页沉浸式大海报 + 片名字标（无字标则原样保留文字标题）。
  initHeroBillboard({ api });

  const library = createLibraryPage({ api, state, escapeHtml });
  const history = createHistoryPage({ state, escapeHtml, resume: createHistoryResume({ state }) });

  /* 第六十六轮：切页时 page-transition 会连着调 prepare() 和 activate()，
     原来这两个都直接打给 library.activate() / history.activate()，也就是同一次切页
     把整页数据取一遍、渲染两遍（片库页 216 个节点）。这里合成一次在飞的调用：
     第二次进来时复用同一个 promise，落地后清空，下一次切页照常刷新。
     这是纯去重，不改任何一方的内部逻辑。 */
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
  /* 第六十六轮：预载从「固定 2200ms」改到「空闲时，且首页已经稳定 4 秒之后」。
     原来它正好落在用户第一次操作的时间窗里：片库页 activate 要建 216 个节点，
     和指针/按键抢同一个主线程，体感就是「刚打开就卡一下」。
     现在挑空闲帧跑，而且一次只预载一页，跑完再等下一段空闲。 */
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

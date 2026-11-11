/**
 * CineFlow 搜索页工作台（新增文件，零侵入）。
 *
 * 设计来源：C:\Users\debu8ger\Desktop\coding项目\search（Lumina Films / Compose）。
 *   SearchViewModel.kt  → 逐源状态机 SourceState{Waiting,Loading,Done,Failed} + latencyMs/count
 *   SearchScreen.kt     → SourceStrip 源健康条 / ResultRow 分组行 / 空态 + 主行动按钮 / 骨架
 *   SearchResultsScreen → 顶栏标题 + 副标题口径 + 「换个关键词」回退
 *
 * 与 CineFlow 基线的边界：
 *   - 只在 #searchSection 之后插入自己的 <section id="cf25SearchHub">，#searchSection 一字不动。
 *   - 只旁听 #globalSearch 的 Enter，不 dispatch 任何合成事件，不阻断基线行为。
 *   - 播放只走基线已暴露的 window.__cineflowOpenResourcePlayer。
 *   - 点「相关」不再退出搜索页：TMDB 命中 → 侧栏详情在搜索页之上滑出（复用基线 openDetails/closeDetails）；
 *     TMDB 未命中 → 复用豆瓣兜底详情卡（复用其 ×/背景点击收回逻辑）。
 *   - 任何异常都被 try/catch 吞掉并静默降级，基线搜索不受影响。
 */

import { openDoubanSheet } from './douban-fallback.js';

const PANEL_ID = 'cf25SearchHub';
const LIFT_CLASS = 'cf25-detail-lift';   // 临时把 #detailPanel 抬到搜索页之上
const HISTORY_KEY = 'cineflow:search-history:v2';
const ISLAND_CLASSES = ['island-mode', 'island-expanded-mode', 'island-docked-mode'];

const DEBOUNCE_MS = 320;          // 与基线 setupSearch / Lumina debounce(320) 同频
const FAST_LATENCY_MS = 900;      // Lumina：< 900ms 判 Ok
const MID_LATENCY_MS = 2000;
const MAX_CHIPS = 4;              // Lumina ResultRow: hits.take(4)
const HISTORY_LIMIT = 8;
const POSTER_CONCURRENCY = 4;     // 海报中转并发（主进程另有 8 路硬上限）
const POSTER_MAX_PER_TURN = 24;   // 一次搜索最多解析多少张，防止极端结果集打爆
const PLAY_WAIT_MS = 6000;        // 点击 chip → 等基线聚合吐出可播线路的总预算
const PLAY_POLL_MS = 240;         // 轮询间隔（基线是渐进分批，太快只会拿到同一份快照）

const els = {
  panel: null,
  head: null,
  headTitle: null,
  headSub: null,
  headCount: null,
  sources: null,
  groups: null,
  skeleton: null,
  empty: null,
  emptyText: null,
  emptyAction: null,
  history: null,
};

const hub = {
  searchId: 0,
  query: '',
  suppress: false,
  playlistSeq: 0,
  knownSources: [],
  posterSeq: 0,
  posterResolved: new Map(),
  posterPending: new Set(),   // 已在队列里/在飞的 URL，重渲染时不得重复入队
  posterWaiters: new Map(),   // URL -> 等这张图的 img 节点列表
  posterQueue: [],
  posterActive: 0,
  hideTimer: 0,
  detailWatcher: null,
  settleTimer: 0,
  sources: new Map(),     // sourceId -> SourceState
  groups: [],
  unsubscribe: null,
  visible: false,
};

let deps = {};

/* ============ 小工具 ============ */

function esc(value) {
  if (typeof deps.escapeHtml === 'function') {
    try { return deps.escapeHtml(value); } catch { /* 落到本地实现 */ }
  }
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isIsland() {
  try { return ISLAND_CLASSES.some((name) => document.body.classList.contains(name)); } catch { return false; }
}

function inputEl() {
  return document.querySelector('#globalSearch');
}

function queryNow() {
  const input = inputEl();
  return input ? String(input.value || '').trim() : '';
}

function dotClass(latencyMs, phase) {
  if (phase === 'failed') return 'is-slow';
  if (latencyMs == null) return 'is-idle';
  if (latencyMs < FAST_LATENCY_MS) return 'is-fast';
  if (latencyMs < MID_LATENCY_MS) return 'is-mid';
  return 'is-slow';
}

function latencyText(latencyMs) {
  if (latencyMs == null) return '';
  return latencyMs >= 1000 ? (latencyMs / 1000).toFixed(1) + 's' : Math.round(latencyMs) + 'ms';
}

/* ============ 面板构建 ============ */

/**
 * 面板挂到 #app 的直接子节点，而不是 #searchSection 之后。
 *
 * 原因（第五十九轮实测）：搜索页是 position:fixed，但 #searchSection 在 main.app-shell 里，
 * 而 .app-shell 是 position:relative + z-index:1 自成一层的层叠上下文 —— 子元素的
 * z-index:63 被整体钳进第 1 层，永远压在 .cf3-stage（z-index:28）之下。
 * 于是首页（stage 全透明）能看见磨砂搜索页，切到分类片库（stage 铺满不透明）就只剩
 * 搜索记录气泡（.cf7-history，z-index:31）。
 *
 * 挂到 #app 直接子节点后，与 .cf3-stage(28)、搜索记录气泡(31)、#detailPanel(30) 同层比较，
 * 层次由末尾那条 cf40 规则钉在 29：盖住片库/历史页，又不遮住搜索记录气泡 —— 与首页完全一致。
 */
function buildPanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;
  const anchor = document.getElementById('app') || document.body;
  if (!anchor) return null;

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = 'cf25-hub is-hidden';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = [
    '<div class="cf25-head">',
    '  <div class="cf25-head-text">',
    '    <h2 id="cf25HubTitle">片源搜索</h2>',
    '    <p id="cf25HubSub" class="cf25-sub"></p>',
    '  </div>',
    '  <span id="cf25HubCount" class="cf25-count"></span>',
    '</div>',
    '<div id="cf25HubSources" class="cf25-sources" aria-live="polite"></div>',
    '<div id="cf25HubGroups" class="cf25-groups"></div>',
    '<div id="cf25HubSkeleton" class="cf25-skeleton is-hidden"></div>',
    '<div id="cf25HubEmpty" class="cf25-empty is-hidden">',
    '  <p id="cf25HubEmptyText"></p>',
    '  <button id="cf25HubEmptyAction" class="cf25-action" type="button">换个关键词</button>',
    '</div>',
    '<div id="cf25HubHistory" class="cf25-history is-hidden"></div>'
  ].join('');

  anchor.appendChild(panel);

  els.panel = panel;
  els.head = panel.querySelector('.cf25-head');
  els.headTitle = panel.querySelector('#cf25HubTitle');
  els.headSub = panel.querySelector('#cf25HubSub');
  els.headCount = panel.querySelector('#cf25HubCount');
  els.sources = panel.querySelector('#cf25HubSources');
  els.groups = panel.querySelector('#cf25HubGroups');
  els.skeleton = panel.querySelector('#cf25HubSkeleton');
  els.empty = panel.querySelector('#cf25HubEmpty');
  els.emptyText = panel.querySelector('#cf25HubEmptyText');
  els.emptyAction = panel.querySelector('#cf25HubEmptyAction');
  els.history = panel.querySelector('#cf25HubHistory');

  els.panel.addEventListener('click', onClick);
  return panel;
}

/* ============ 显隐 ============ */

const FADE_OUT_MS = 170;

function keepOnTop() {
  // 页面切换/其它模块往 #app 里追加节点后，重新挂一次保持它是 #app 的最后一个直接子节点；
  // 真正决定层次的是 CSS 里 #app > .cf25-hub 的 z-index，不靠 DOM 顺序。
  try {
    const host = document.getElementById('app');
    if (host && els.panel && els.panel.parentElement !== host) host.appendChild(els.panel);
  } catch { /* ignore */ }
}

function show() {
  if (!els.panel) return;
  keepOnTop();
  // 正在淡出时又被唤起：掐掉收尾定时器，从当前透明度继续淡入，不重排
  if (hub.hideTimer) { window.clearTimeout(hub.hideTimer); hub.hideTimer = 0; }
  if (hub.visible) return;
  hub.visible = true;
  els.panel.classList.remove('is-hidden');
  els.panel.setAttribute('aria-hidden', 'false');
  // 下一帧再挂 is-open，让 CSS transition 有起点（毫秒级但不闪）。
  // 窗口被遮挡/最小化时 rAF 会被整体节流（不产生帧），那样 is-open 永远挂不上、
  // 面板会停在 opacity:0 —— 加一个 32ms 兜底定时器保证状态一定收口。
  let opened = false;
  const markOpen = () => {
    if (opened) return;
    opened = true;
    if (hub.visible) els.panel?.classList.add('is-open');
  };
  requestAnimationFrame(markOpen);
  window.setTimeout(markOpen, 32);
}

/**
 * 收起：先摘 is-open 走 0.17s 淡出，淡完再 display:none。
 * （若同时加 is-hidden，display:none 会直接掐掉 transition，观感是"啪一下没了"。）
 */
function hide({ keepState = false } = {}) {
  if (!els.panel) return;
  const wasVisible = hub.visible;
  hub.visible = false;
  els.panel.classList.remove('is-open');
  els.panel.setAttribute('aria-hidden', 'true');
  if (!keepState) clearPanelState();
  if (hub.hideTimer) window.clearTimeout(hub.hideTimer);
  if (!wasVisible) {
    els.panel.classList.add('is-hidden');
    hub.hideTimer = 0;
    return;
  }
  // 主路径：等 transition 真正结束（窗口被遮挡时定时器会被节流，靠它更稳）
  const finish = () => {
    if (hub.visible) return;
    els.panel?.classList.add('is-hidden');
  };
  if (typeof els.panel.addEventListener === 'function') {
    const onEnd = (event) => {
      if (event && event.propertyName && event.propertyName !== 'opacity') return;
      els.panel.removeEventListener('transitionend', onEnd);
      finish();
    };
    els.panel.addEventListener('transitionend', onEnd);
  }
  // 兜底：没有 transitionend（元素被隐藏 / 过渡被禁用）时也要收口
  hub.hideTimer = window.setTimeout(() => {
    hub.hideTimer = 0;
    finish();
  }, FADE_OUT_MS);
}

function clearPanelState() {
  hub.sources.clear();
  hub.groups = [];
  hub.viewGroups = [];
  hub.query = '';
  if (els.sources) els.sources.innerHTML = '';
  if (els.groups) els.groups.innerHTML = '';
  if (els.skeleton) els.skeleton.classList.add('is-hidden');
  if (els.empty) els.empty.classList.add('is-hidden');
  if (els.headCount) els.headCount.textContent = '';
}

/* ============ 逐源状态条 ============ */

function renderSources() {
  if (!els.sources) return;
  const rows = [...hub.sources.values()];
  if (!rows.length) { els.sources.innerHTML = ''; return; }
  els.sources.innerHTML = rows.map((item) => {
    const phase = item.phase;
    const countText = phase === 'done' ? esc(item.name) + ' ' + item.count + '部' : esc(item.name);
    const trail = phase === 'failed'
      ? '超时'
      : (phase === 'done' ? latencyText(item.latencyMs) : '');
    return [
      '<span class="cf25-source is-' + phase + '" title="' + esc(item.error || item.name) + '">',
      '  <i class="cf25-dot ' + dotClass(item.latencyMs, phase) + '"></i>',
      '  <b>' + countText + '</b>',
      trail ? '  <em>' + esc(trail) + '</em>' : '',
      '</span>'
    ].join('');
  }).join('');
}

/* ============ 分组列表 ============ */

function groupRowHtml(group) {
  const hits = Array.isArray(group.hits) ? group.hits : [];
  const chips = hits.slice(0, MAX_CHIPS).map((hit) => {
    const latency = latencyText(hit.latencyMs);
    return [
      '<button class="cf25-chip" type="button"',
      ' data-cf25-play="1"',
      ' data-cf25-key="' + esc(group.key) + '"',
      ' data-source-key="' + esc(hit.sourceKey) + '"',
      ' data-vod-id="' + esc(hit.vodId) + '"',
      ' title="' + esc(hit.title + ' · ' + hit.sourceName) + '">',
      '  <i class="cf25-dot ' + dotClass(hit.latencyMs, 'done') + '"></i>',
      '  <span>' + esc(hit.sourceName) + '</span>',
      latency ? '<em>' + esc(latency) + '</em>' : '',
      '</button>'
    ].join('');
  }).join('');
  const overflow = hits.length > MAX_CHIPS
    ? '<span class="cf25-chip is-more">+' + (hits.length - MAX_CHIPS) + '</span>'
    : '';
  const meta = [group.year, group.type, hits.length + ' 个片源'].filter(Boolean).join(' · ');
  // 注意：渲染层是 file:// origin，直接 <img src="https://源站/…"> 必被热链拦截，
  // 因此这里只放一个带 data-cf25-img 的空壳，由 enqueuePoster 走主进程中转填入 data URL。
  const poster = group.poster
    ? '<img class="cf25-poster-img is-pending" data-cf25-img="' + esc(group.poster) + '" alt="" decoding="async" />'
      + '<span class="cf25-ph">海报加载中</span>'
    : '<span class="cf25-ph">NO POSTER</span>';

  return [
    '<article class="cf25-group" data-cf25-key="' + esc(group.key) + '">',
    '  <div class="cf25-poster">' + poster + '</div>',
    '  <div class="cf25-body">',
    '    <h3>' + esc(group.title) + '</h3>',
    '    <p class="cf25-meta">' + esc(meta) + '</p>',
    '    <div class="cf25-chips">' + chips + overflow + '</div>',
    '  </div>',
    '  <button class="cf25-related" type="button" data-cf25-related="1" data-cf25-key="' + esc(group.key) + '">相关</button>',
    '</article>'
  ].join('');
}

function renderGroups() {
  if (!els.groups) return;
  if (!hub.viewGroups.length) { els.groups.innerHTML = ''; return; }
  els.groups.innerHTML = hub.viewGroups.map(groupRowHtml).join('');
  scanPosters();
}


/* ============ 海报中转加载 ============ */

/**
 * 渲染层 origin 是 file://，源站图床（dytt-tupian / imgzy360 …）一律拒热链，
 * 直接给 <img src> 赋远程地址必然 onerror。改为逐张请主进程取字节转 data URL：
 *   - 并发 4，避免一次搜索打出几十个占坑请求；
 *   - 一次搜索最多解析 POSTER_MAX_PER_TURN 张；
 *   - 同 URL 在本次会话内只解析一次（hub.posterResolved）；
 *   - 任何一张失败都只是把占位文案改成「暂无海报」，绝不影响分组卡本身。
 */
/**
 * 入队一张海报。
 *
 * 关键：renderGroups 每个进度事件都会整体重渲染，同一张图的 DOM 节点是新的。
 * 如果按"节点是否入过队"计数，一次搜索会被重复计数几十次、预算（24）瞬间烧光，
 * 后出现的分组永远排不到 —— 这就是「有的内容还是没海报」的根因。
 * 因此改成按 **URL** 去重与计数：已在飞/已在缓存里的直接跳过。
 */
function enqueuePoster(imgEl) {
  if (!imgEl) return;
  const url = imgEl.getAttribute('data-cf25-img') || '';
  if (!url) return;
  const cached = hub.posterResolved.get(url);
  if (cached !== undefined) { applyPoster(imgEl, cached); return; }
  if (hub.posterPending.has(url)) {
    // 已在飞：等它落地后由 resolvePoster 统一回填（这里先挂个观察者）
    hub.posterWaiters.set(url, (hub.posterWaiters.get(url) || []).concat(imgEl));
    return;
  }
  if (hub.posterSeq >= POSTER_MAX_PER_TURN) {
    // 超预算：等本轮收口后的补救扫描（flushPosters）
    return;
  }
  hub.posterSeq += 1;
  hub.posterPending.add(url);
  hub.posterQueue.push({ url, imgEl });
  pumpPosterQueue();
}

function applyPoster(imgEl, result) {
  if (!imgEl) return;
  // isConnected 在极少数宿主/测试桩里没有，缺省按"仍挂着"处理，避免白等
  if (imgEl.isConnected === false) return;
  const holder = imgEl.parentElement;
  if (result && result.dataUrl) {
    // 走 setAttribute：真实 DOM 与 img.src= 等价，但宿主/测试桩里更稳
    if (typeof imgEl.setAttribute === 'function') imgEl.setAttribute('src', result.dataUrl);
    else imgEl.src = result.dataUrl;
    imgEl.classList.remove('is-pending');
    imgEl.classList.add('is-loaded');
    const ph = holder && holder.querySelector('.cf25-ph');
    if (ph) ph.style.display = 'none';
  } else {
    imgEl.classList.remove('is-pending');
    imgEl.classList.add('is-failed');
    if (holder) {
      const ph = holder.querySelector('.cf25-ph');
      if (ph) ph.textContent = '暂无海报';
    }
  }
}

function pumpPosterQueue() {
  while (hub.posterActive < POSTER_CONCURRENCY && hub.posterQueue.length) {
    const job = hub.posterQueue.shift();
    hub.posterActive += 1;
    resolvePoster(job).finally(() => {
      hub.posterActive = Math.max(0, hub.posterActive - 1);
      if (hub.posterQueue.length) pumpPosterQueue();
    });
  }
}

async function resolvePoster(job) {
  const hubApi = window.cineflowSearchHub;
  if (!hubApi || typeof hubApi.image !== 'function') { applyPoster(job.imgEl, null); return; }
  let result = null;
  try {
    result = await hubApi.image({ url: job.url });
  } catch {
    result = null;
  }
  const normalized = result && result.ok && result.dataUrl ? result : null;
  hub.posterResolved.set(job.url, normalized);
  hub.posterPending.delete(job.url);
  applyPoster(job.imgEl, normalized);
  // 重渲染期间挂上来的同 URL 节点一并回填
  const waiters = hub.posterWaiters.get(job.url);
  if (waiters) {
    hub.posterWaiters.delete(job.url);
    for (const node of waiters) applyPoster(node, normalized);
  }
}

function scanPosters() {
  if (!els.groups) return;
  const nodes = els.groups.querySelectorAll('img[data-cf25-img]');
  for (const node of nodes) enqueuePoster(node);
  // 视口内的优先：先解析可见的分组，滚动下来的稍后补
  hub.posterQueue.sort((a, b) => {
    const av = a.imgEl.isConnected ? 1 : 0;
    const bv = b.imgEl.isConnected ? 1 : 0;
    return bv - av;
  });
}

/**
 * 搜索收口后的补救扫描。
 * 预算（POSTER_MAX_PER_TURN）是防打爆源站的上限，但收口后结果集就固定了，
 * 此时把预算放开再扫一遍，保证「只要源站有图就一定补上」。
 */
function flushPosters() {
  if (!els.groups) return;
  for (const node of els.groups.querySelectorAll('img[data-cf25-img]')) {
    const url = node.getAttribute('data-cf25-img') || '';
    if (!url) continue;
    if (hub.posterResolved.has(url)) continue;
    if (hub.posterPending.has(url)) continue;
    hub.posterPending.add(url);
    hub.posterQueue.push({ url, imgEl: node });
  }
  pumpPosterQueue();
}

/* ============ 骨架 / 空态 ============ */

function renderSkeleton(active) {
  if (!els.skeleton) return;
  if (!active) { els.skeleton.classList.add('is-hidden'); els.skeleton.innerHTML = ''; return; }
  if (els.skeleton.dataset.filled === '1') {
    els.skeleton.classList.remove('is-hidden');
    return;
  }
  els.skeleton.dataset.filled = '1';
  els.skeleton.innerHTML = Array.from({ length: 4 }, () => (
    '<div class="cf25-skeleton-row"><i></i><span><b></b><em></em></span></div>'
  )).join('');
  els.skeleton.classList.remove('is-hidden');
}

function renderEmpty(kind, query) {
  if (!els.empty) return;
  if (!kind) { els.empty.classList.add('is-hidden'); return; }
  if (kind === 'no-sources') {
    els.emptyText.textContent = '还没有配置在线片源，添加后才能搜索片源结果。';
    els.emptyAction.textContent = '去添加片源';
    els.emptyAction.dataset.cf25Action = 'settings';
  } else {
    els.emptyText.textContent = '没有找到「' + String(query || '') + '」的片源结果。';
    els.emptyAction.textContent = '换个关键词';
    els.emptyAction.dataset.cf25Action = 'refocus';
  }
  els.empty.classList.remove('is-hidden');
}

/* ============ 历史词行 ============ */

function readHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rows) ? parsed.rows : []);
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const term = String((row && (row.term || row.query)) || '').trim();
      if (!term || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      out.push(term);
      if (out.length >= HISTORY_LIMIT) break;
    }
    return out;
  } catch { return []; }
}

function renderHistory() {
  if (!els.history) return;
  const terms = readHistory();
  if (!terms.length) { els.history.classList.add('is-hidden'); els.history.innerHTML = ''; return; }
  els.history.innerHTML = '<span class="cf25-history-label">最近搜索</span>'
    + terms.map((term) => '<button class="cf25-history-chip" type="button" data-cf25-term="' + esc(term) + '">' + esc(term) + '</button>').join('');
  els.history.classList.remove('is-hidden');
}

/* ============ 搜索生命周期 ============ */

function bumpSearchId() {
  hub.searchId += 1;
  return hub.searchId;
}

function cancelRunning() {
  const api = deps.api;
  if (!api || !api.cf25Cancel) return;
  try { api.cf25Cancel({ searchId: hub.searchId }); } catch { /* 主进程已重启等 */ }
}

function resetForNewQuery(query) {
  hub.query = query;
  hub.groups = [];
  hub.viewGroups = [];
  hub.posterSeq = 0;
  hub.posterQueue.length = 0;
  hub.posterPending.clear();
  hub.posterWaiters.clear();
  hub.sources.clear();
  if (els.groups) els.groups.innerHTML = '';
  if (els.headTitle) els.headTitle.textContent = '片源搜索';
  if (els.headSub) els.headSub.textContent = '按「' + query + '」扫描全部在线片源';
  if (els.headCount) els.headCount.textContent = '';
  renderEmpty(null);
  renderSkeleton(true);
  renderSources();
}

async function startSearch(query) {
  const api = deps.api;
  if (!api || typeof api.cf25Start !== 'function') return;

  // 代次：先作废上一次（含其主进程单飞槽），再取新号；后续所有事件按 searchId 守卫
  const previous = hub.searchId;
  hub.searchId = previous + 1;
  const mine = hub.searchId;
  try { api.cf25Cancel({ searchId: previous }); } catch { /* 主进程未就绪 */ }

  resetForNewQuery(query);
  show();
  // 先用上一次已知的片源清单铺等待态（0ms，不等 IPC 往返），
  // 等 cf25Start 返回真实清单后再覆盖一次。
  if (hub.knownSources.length) {
    for (const source of hub.knownSources) {
      hub.sources.set(source.sourceId, {
        sourceId: source.sourceId, name: source.name, phase: 'waiting', latencyMs: null, count: 0, error: null
      });
    }
    renderSources();
  }

  let response;
  try {
    response = await api.cf25Start({ searchId: mine, query });
  } catch {
    renderSkeleton(false);
    renderEmpty('no-hits', query);
    return;
  }

  if (mine !== hub.searchId) return;

  if (!response || response.ok === false) {
    renderSkeleton(false);
    renderEmpty('no-hits', query);
    return;
  }

  if (response.reason === 'disabled' || response.reason === 'no-sources' || !response.total) {
    renderSkeleton(false);
    renderEmpty('no-sources', query);
    if (els.headCount) els.headCount.textContent = '暂无片源';
    return;
  }

  // 记住片源清单：下一次搜索可以 0ms 铺出等待态，不用等 IPC 往返
  if (Array.isArray(response.sources) && response.sources.length) {
    hub.knownSources = response.sources.map((source) => ({
      sourceId: source.sourceId,
      name: source.name
    }));
  }
  // 立即铺出逐源等待态：这是「毫秒级响应」的观感来源
  for (const source of response.sources || []) {
    hub.sources.set(source.sourceId, {
      sourceId: source.sourceId,
      name: source.name,
      phase: 'waiting',
      latencyMs: null,
      count: 0,
      error: null
    });
  }
  renderSources();
}

function applyProgress(payload) {
  if (!payload || payload.searchId !== hub.searchId) return;
  if (!hub.visible) show();

  if (payload.phase === 'source' && payload.source) {
    hub.sources.set(payload.source.sourceId, payload.source);
    renderSources();
    if (Array.isArray(payload.hits) && payload.hits.length) {
      mergeHits(payload.hits);
      renderSkeleton(false);
      renderGroups();
    }
    if (els.headCount) {
      const total = hub.groups.reduce((sum, group) => sum + (group.hits?.length || 0), 0);
      els.headCount.textContent = total ? total + ' 个片源命中' : '';
    }
    return;
  }

  if (payload.phase === 'done') {
    for (const source of payload.sources || []) hub.sources.set(source.sourceId, source);
    renderSources();
    renderSkeleton(false);
    // 结果集已固定：放开预算补扫一遍，保证源站有图就一定有封面
    flushPosters();
    if (!hub.viewGroups.length) renderEmpty('no-hits', hub.query);
    else renderEmpty(null);
    if (els.headCount) {
      const total = payload.totalHits || 0;
      els.headCount.textContent = total ? total + ' 个片源命中' : '';
    }
    if (els.headSub) {
      const done = (payload.sources || []).filter((item) => item.phase === 'done').length;
      els.headSub.textContent = '按「' + hub.query + '」扫描 ' + (payload.sources || []).length + ' 个片源 · 成功 ' + done;
    }
  }
}

/* ---- 归并：复刻 Lumina buildGroups（归一化已在主进程算好） ---- */

function mergeHits(hits) {
  const index = new Map(hub.groups.map((group) => [group.key, group]));
  for (const hit of hits) {
    const key = hit.norm + '|' + (hit.year || '');
    let group = index.get(key);
    if (!group) {
      group = { key, title: hit.title, year: hit.year || '', type: hit.type || '', poster: hit.poster || '', hits: [] };
      index.set(key, group);
      hub.groups.push(group);
    }
    if (!group.poster && hit.poster) group.poster = hit.poster;
    if (!group.year && hit.year) group.year = hit.year;
    if (!group.type && hit.type) group.type = hit.type;
    if (group.hits.some((row) => row.sourceKey === hit.sourceKey && row.vodId === hit.vodId)) continue;
    group.hits.push(hit);
  }
  hub.groups.sort((a, b) => (b.hits.length - a.hits.length) || String(a.title).localeCompare(String(b.title)));
  rebuildViewGroups();
}

/* ============ 展示层：影视口径 ============ */

/**
 * 片源口径 vs 展示口径 —— 为什么必须分开
 *
 *   片源检索那套（主进程 pickHits / resourceCandidateScore）是为「一部影片挑唯一可播资源」设计的：
 *   40 分阈值、每源一条、按 vod_id 去重、按「同名同类型」归并。
 *   直接拿它当搜索页的展示列表，屏幕上就会出现三类毛病：
 *
 *     1. 同一部影视被拆成多行 —— 「寄生虫 / 寄生虫国语 / 寄生虫 기생충」各占一行，
 *        因为版本后缀进了归一化键，片源数被摊薄；
 *     2. 类型串味就分裂 —— 「寄生虫保姆 2025·短剧」与「寄生虫保姆 ·爽文短剧」两行，
 *        只因为其中一个源没填年份；
 *     3. 源站脏数据直接上屏 —— 多片名拼接（「A$B」）原样显示成一整行。
 *
 *   展示层只做「归并 + 排序 + 清洗」，**不重新打分、不丢片源**：
 *   归一化口径继续复用基线的 normalizeResourceTitle（主进程已经把 group.key 算好），
 *   这里只在它之上补版本后缀归并与影视级合并，任何一条命中都不会因为展示层而消失。
 */

/** 版本/语言后缀：只剥「同一部片的不同版本」，不剥续集与番外 */
const VERSION_SUFFIX = /(国语|粤语|英语|原声|中字|中文字幕|双字|国粤双语|双语|高清|超清|蓝光|完整版|未删减版?|加长版|抢先版|枪版|特别版|特别篇|纪念版|周年纪念版|导演剪辑版|hd|bd|4k|1080p|2160p)+$/i;

/** 结尾短括号限定：流浪地球(特别版) / 三体（网飞版） → 归到正主 */
const TRAILING_PAREN = /[（(]\s*([^（）()]{1,8})\s*[)）]\s*$/;

/** 中英/中日双名：寄生虫 기생충 → 寄生虫（只在后段完全无中文时才剥离） */
const FOREIGN_ALIAS = /^(.*[\u4e00-\u9fff])\s+([^\u4e00-\u9fff]{2,})$/;

/** 源站脏数据：多片名拼接（A$B、A|B）与换行 */
function cleanDisplayTitle(title) {
  const raw = String(title || '');
  const head = raw.split(/[$|\n\r]/)[0] || '';
  return head.trim() || raw.trim();
}

function baseDisplayTitle(title) {
  let text = cleanDisplayTitle(title);
  for (let i = 0; i < 4; i += 1) {
    // 括号限定 → 版本后缀 → 外语别名，三步都可能互相暴露，故循环到稳定
    const before = text;
    text = text.replace(TRAILING_PAREN, '').trim() || text;
    text = text.replace(VERSION_SUFFIX, '').trim() || text;
    text = text.replace(FOREIGN_ALIAS, '$1').trim() || text;
    if (text === before) break;
  }
  return text;
}

/** 相关度档位：0 完全同名 / 1 前缀命中（更可能是正主）/ 2 其它 */
function relevanceRank(base, queryNorm) {
  if (!queryNorm) return 1;
  if (base === queryNorm) return 0;
  if (base.startsWith(queryNorm)) return 1;
  return 2;
}

/**
 * 把片源口径的分组重建成影视口径。
 * 合并规则：同 base 标题 → 年份相同或一方缺失时并成一行；年份都不同则各自成行（续集不能混）。
 */
function rebuildViewGroups() {
  const clusters = new Map();
  for (const group of hub.groups) {
    const rawTitle = cleanDisplayTitle(group.title);
    const base = baseDisplayTitle(rawTitle);
    if (!base) continue;
    if (!clusters.has(base)) clusters.set(base, []);
    clusters.get(base).push(group);
  }

  const view = [];
  for (const [base, members] of clusters) {
    // 先按年份分桶：有年份的各成一桶，没年份的归到「已存在的唯一桶」或「无年份桶」
    const byYear = new Map();
    const loose = [];
    for (const member of members) {
      const year = String(member.year || '');
      if (year) { if (!byYear.has(year)) byYear.set(year, []); byYear.get(year).push(member); }
      else loose.push(member);
    }
    if (byYear.size === 1) {
      const only = byYear.values().next().value;
      for (const member of loose) only.push(member);
      loose.length = 0;
    }
    const buckets = [...byYear.entries()].map(([year, list]) => ({ year, list }));
    if (loose.length) buckets.push({ year: '', list: loose });

    for (const bucket of buckets) {
      const hits = [];
      const seen = new Set();
      let poster = '';
      let type = '';
      for (const member of bucket.list) {
        if (!poster && member.poster) poster = member.poster;
        if (!type && member.type) type = member.type;
        for (const hit of member.hits || []) {
          const tag = hit.sourceKey + '#' + hit.vodId;
          if (seen.has(tag)) continue;
          seen.add(tag);
          hits.push(hit);
        }
      }
      hits.sort((a, b) => (b.score || 0) - (a.score || 0) || (a.latencyMs || 0) - (b.latencyMs || 0));
      view.push({
        key: 'v:' + base + '|' + (bucket.year || ''),
        base,
        title: rawTitleOf(bucket.list, base),
        year: bucket.year,
        type,
        poster,
        hits
      });
    }
  }

  const queryNorm = baseDisplayTitle(hub.query || '');
  for (const group of view) {
    group.rank = relevanceRank(group.base, queryNorm);
    // 越小越靠前：相关度档位 > 标题贴近查询词（短）> 片源多
    group.weight = group.rank * 1000
      + Math.min(group.base.length, 40) * 4
      - Math.min(group.hits.length, 20) * 5;
  }
  view.sort((a, b) => a.weight - b.weight || String(a.title).localeCompare(String(b.title)));
  hub.viewGroups = view;
}

/** 取本桶里最短的干净标题当行标题（最短的那个最可能是正主，而不是「XX国语版」） */
function rawTitleOf(members, fallback) {
  let best = '';
  for (const member of members) {
    const title = cleanDisplayTitle(member.title);
    if (!title) continue;
    if (!best || title.length < best.length) best = title;
  }
  return best || fallback;
}

/** 展示口径的 key 只在展示列表里有效，找不到再回落到片源口径 */
function findGroup(key) {
  if (!key) return null;
  return hub.viewGroups.find((item) => item.key === key)
    || hub.groups.find((item) => item.key === key)
    || null;
}

/* ============ 「相关」：在搜索页之上打开详情 ============ */

/**
 * 「相关」：**不再退出搜索页**。
 *
 *   - 影片在 TMDB 元数据里 → 侧栏详情在搜索页之上从右侧滑出（复用基线 openDetails，
 *     收回复用基线 closeDetails：拉手 / 关闭按钮 / Escape 都是基线自己的逻辑）；
 *   - 影片不在 TMDB 里（含未配置凭证）→ 复用豆瓣兜底详情卡（含它自己的 ×/背景点击收回）。
 *
 * 两条路都不改基线：只加一个 body 类把 #detailPanel 的层级临时抬到搜索页之上，
 * 面板一收（基线自己摘 is-open）就立刻把类摘掉。
 */
function exitToRelated(group) {
  cancelRunning();
  bumpSearchId();
  // 只关掉逐源计时，不收起搜索页

  let settled = false;
  const settle = (movie) => {
    if (settled) return;
    settled = true;
    if (movie) openDetailAbove(movie, group);
    else openDoubanAbove(group);
  };

  // TMDB 请求悬挂时也不能让用户干等：900ms 后直接走豆瓣卡
  window.setTimeout(() => settle(null), 900);
  resolveMovie(group).then(settle).catch(() => settle(null));
}

/** TMDB 命中：侧栏详情滑出，并临时抬到搜索页之上 */
function openDetailAbove(movie, group) {
  const open = window.__cineflowOpenDetails;
  if (typeof open !== 'function') { openDoubanAbove(group); return; }
  document.body.classList.add(LIFT_CLASS);
  try {
    open(movie.id, movie);
  } catch {
    document.body.classList.remove(LIFT_CLASS);
    openDoubanAbove(group);
  }
  watchDetailClose();
}

/** TMDB 未命中：复用豆瓣兜底详情卡 */
function openDoubanAbove(group) {
  const isTv = /tv|剧|综艺|动漫|纪录/.test(String(group.type || ''));
  const firstHit = (group.hits && group.hits[0]) || {};
  try {
    openDoubanSheet({
      id: firstHit.vodId || group.key,
      cf8Id: '',
      title: group.title,
      mediaType: isTv ? 'tv' : 'movie',
      cover: '',
      year: group.year || '',
      releaseDate: group.year ? group.year + '-01-01' : ''
    });
  } catch { /* 卡片打不开也不阻塞搜索页 */ }
  paintSheetPoster(group);
}

/**
 * 豆瓣卡自己的封面走 doubanImageDataUrl，只认真人豆瓣/EveryFilm 域名，
 * 源站图床一律被拒。这里用我们自己的中转把它补上。
 */
function paintSheetPoster(group) {
  const url = group && group.poster;
  if (!url) return;
  const apply = (dataUrl) => {
    if (!dataUrl) return;
    const sheet = document.querySelector('.cf8-sheet.is-open');
    if (!sheet) return;
    const box = sheet.querySelector('.cf8-sheet-poster');
    if (!box) return;
    const title = (sheet.querySelector('.cf8-sheet-title') || {}).textContent || '';
    if (String(title).trim() !== String(group.title || '').trim()) return;
    if (box.querySelector('img')) return;
    const img = document.createElement('img');
    img.alt = (group.title || '') + ' 海报';
    img.src = dataUrl;
    box.appendChild(img);
  };
  const cached = hub.posterResolved.get(url);
  if (cached !== undefined) { apply(cached && cached.dataUrl); return; }
  window.setTimeout(() => {
    const later = hub.posterResolved.get(url);
    if (later) apply(later.dataUrl);
  }, 400);
  window.setTimeout(() => {
    const later = hub.posterResolved.get(url);
    if (later) apply(later.dataUrl);
  }, 1200);
}

/** 侧栏详情一收（基线自己摘 is-open）就撤掉层级抬升，避免影响其它页面 */
function watchDetailClose() {
  if (hub.detailWatcher) return;
  const panel = document.querySelector('#detailPanel');
  if (!panel) {
    // 面板还没进 DOM：稍后补挂一次
    window.setTimeout(() => { if (!hub.detailWatcher) watchDetailClose(); }, 800);
    return;
  }
  hub.detailWatcher = new MutationObserver(() => {
    if (!panel.classList.contains('is-open')) {
      document.body.classList.remove(LIFT_CLASS);
    }
  });
  hub.detailWatcher.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

/** 搜索页上是否正压着一层详情（侧栏 or 豆瓣卡） */
function overlayDetailOpen() {
  try {
    if (document.querySelector('#detailPanel.is-open')) return true;
    if (document.querySelector('.cf8-sheet.is-open')) return true;
  } catch { /* 查询失败按未打开处理 */ }
  return false;
}

/** 用基线 searchMovies 找到最匹配的一部，标题归一化 + 年份加权 */
async function resolveMovie(group) {
  const api = deps.api;
  if (!api || typeof api.searchMovies !== 'function') return null;
  const want = normalizeForMatch(group.title);
  if (!want) return null;
  const results = await api.searchMovies(String(group.title || ''), { enrich: false });
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return null;
  let best = null;
  let bestScore = -1;
  for (const movie of rows) {
    const got = normalizeForMatch(movie && (movie.title || movie.name));
    if (!got) continue;
    let score = 0;
    if (got === want) score = 100;
    else if (got.startsWith(want) || want.startsWith(got)) score = 74;
    else if (got.includes(want) || want.includes(got)) score = 52;
    else continue;
    const year = String((movie && (movie.releaseDate || movie.firstAirDate || '')) || '').match(/\d{4}/)?.[0] || '';
    if (group.year && year) score += year === String(group.year) ? 26 : -14;
    const isTv = String(movie.mediaType || movie.media_type || 'movie').toLowerCase() === 'tv';
    if (isTv === /tv|剧|综艺|动漫|纪录/.test(String(group.type || ''))) score += 6;
    if (score > bestScore) { bestScore = score; best = movie; }
  }
  return bestScore > 0 ? best : (rows.length === 1 ? rows[0] : null);
}

/**
 * 降级路径：派发一次基线搜索，等卡片出现后点它。
 * 若 1.4s 内既没解析到 TMDB 条目、也没等到卡片（典型场景：未配置 TMDB 凭证），
 * 仍然把侧栏详情面板展开 —— 面板内容由基线自己决定（它会渲染自己的错误/占位），
 * 但「退出搜索页 + 展开侧栏」这个动作必须完成，否则用户会卡在空搜索页上。
 */
function fallbackToRail(group) {
  const input = inputEl();
  if (input) {
    const restore = input.value;
    hub.suppress = true;
    try {
      input.value = group.title;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    } finally {
      hub.suppress = false;
      input.value = restore;
      input.blur();
    }
  }
  openRelatedCard(group.title, group.year, Date.now() + 6000);
}

function cardTitleOf(card) {
  try { return String(card.querySelector('h3')?.textContent || '').trim(); } catch { return ''; }
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000·・:：,，.。!！?？'"“”‘’《》〈〉\-—_/\\|（）()\[\]【】]/g, '');
}

function openRelatedCard(title, year, deadline) {
  const want = normalizeForMatch(title);
  const tick = () => {
    if (Date.now() > deadline) return;
    const cards = Array.from(document.querySelectorAll('#searchRail .movie-card:not(.skeleton)'));
    if (cards.length) {
      let best = null;
      let bestScore = -1;
      for (const card of cards) {
        const got = normalizeForMatch(cardTitleOf(card));
        if (!got || !want) continue;
        let score = 0;
        if (got === want) score = 100;
        else if (got.includes(want) || want.includes(got)) score = 60 + Math.min(20, Math.min(got.length, want.length));
        if (score > bestScore) { bestScore = score; best = card; }
      }
      if (best && bestScore > 0) {
        best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return;
      }
      if (cards.length === 1) {
        cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return;
      }
    }
    window.setTimeout(tick, 90);
  };
  window.setTimeout(tick, 60);
}

/* ============ 点击处理 ============ */

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const term = target.closest('[data-cf25-term]');
  if (term) {
    const value = term.getAttribute('data-cf25-term') || '';
    const input = inputEl();
    if (input) {
      input.value = value;
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
    return;
  }

  const historyChipAction = target.closest('#cf25HubEmptyAction');
  if (historyChipAction) {
    const action = historyChipAction.dataset.cf25Action || 'refocus';
    if (action === 'settings') {
      document.querySelector('#settingsBtn')?.click();
      return;
    }
    const input = inputEl();
    if (input) { input.focus(); input.select(); }
    return;
  }

  const related = target.closest('[data-cf25-related]');
  if (related) {
    // 分组键直接挂在按钮上：不依赖 article 的 DOM 嵌套，重渲染/结构微调都不会失配
    const key = related.getAttribute('data-cf25-key')
      || related.closest('.cf25-group')?.getAttribute('data-cf25-key')
      || '';
    const group = findGroup(key);
    if (group) exitToRelated(group);
    return;
  }

  const play = target.closest('[data-cf25-play]');
  if (play) {
    playChip(play);
    return;
  }

  // 无输入时点搜索页任意位置 → 退出模糊层回到原页面（详情压在上面时不收）
  if (!String(queryNow()).trim() && !overlayDetailOpen()) dismissSearchPage();
}

/**
 * 取可播地址：基线 findMovieResources 是渐进分批的（cursor + done），
 * 首包通常 resources 为空、checked 才 1/total —— 必须按 cursor 轮询到命中或 done。
 * 上限 6 轮（≈ 基线详情页同款节奏），任意一轮命中就立刻用。
 */
async function fetchPlayable(payload, preferredSourceKey) {
  const api = deps.api;
  const startedAt = Date.now();
  const deadline = startedAt + PLAY_WAIT_MS;
  let cursor = 0;
  let fallback = null;
  while (Date.now() < deadline) {
    let response = null;
    try {
      response = await api.findMovieResources(payload, { cursor, limit: 3 });
    } catch {
      response = null;
    }
    const resources = Array.isArray(response?.resources) ? response.resources : [];
    if (resources.length) {
      const exact = preferredSourceKey
        ? resources.find((row) => String(row && row.sourceKey) === String(preferredSourceKey))
        : null;
      const picked = exact || resources[0];
      // 首选源还没出现但已有别的可播源：给首选源再一轮机会，仍无则用兜底
      if (exact) return exact;
      fallback = picked;
    }
    if (response && response.done) return fallback;
    const next = Number(response?.nextCursor);
    if (Number.isFinite(next) && next > cursor) cursor = next;
    else if (!resources.length) cursor += 3;
    // 聚合是渐进推送的：必须留出时间让后续批次产生，否则一直拿到同一批快照
    await new Promise((resolve) => window.setTimeout(resolve, PLAY_POLL_MS));
  }
  return fallback;
}

async function playChip(button) {
  // 分组键优先取按钮自身的 data 属性（chip 由 data-cf25-play 的 key 传递）
  const key = button.getAttribute('data-cf25-key')
    || button.closest('.cf25-group')?.getAttribute('data-cf25-key')
    || '';
  const group = findGroup(key);
  if (!group) return;
  const sourceKey = button.getAttribute('data-source-key') || '';
  const hit = group.hits.find((row) => row.sourceKey === sourceKey) || group.hits[0];
  if (!hit) return;

  button.classList.add('is-busy');
  try {
    const isTv = /tv|剧|综艺|动漫|纪录/.test(String(hit.type || ''));
    const resource = await fetchPlayable(
      { title: group.title, year: group.year, mediaType: isTv ? 'tv' : 'movie' },
      hit.sourceKey
    );
    const episodes = (resource?.lines || []).flatMap((line) => line.episodes || []);
    const episode = episodes.find((row) => row && row.url);
    if (!episode) {
      flash(button, '暂时取不到可播地址');
      return;
    }
    const lines = Array.isArray(resource.lines) ? resource.lines : [];
    const firstLine = lines.find((line) => Array.isArray(line.episodes) && line.episodes.length) || {};
    const firstLineEpisodes = Array.isArray(firstLine.episodes) ? firstLine.episodes : [];
    const open = window.__cineflowOpenResourcePlayer;
    if (typeof open !== 'function') { flash(button, '播放器入口不可用'); return; }

    // 有播放列表就注册进基线 state.resourcePlaylists，播放器内可切集；
    // 注册失败（极端降级）也不影响首条起播。
    const payload = {
      url: episode.url,
      kind: episode.kind || '',
      format: episode.format || '',
      needsResolve: Boolean(episode.needsResolve),
      title: resource.title || group.title,
      sourceName: resource.sourceName || hit.sourceName,
      lineName: firstLine.name || '默认线路',
      label: episode.label || '播放'
    };
    if (firstLineEpisodes.length > 1) {
      const playlistId = 'cf25-playlist-' + (hub.playlistSeq += 1);
      const store = deps.state && deps.state.resourcePlaylists;
      let stored = false;
      if (store && typeof store.set === 'function') {
        try {
          store.set(playlistId, firstLineEpisodes.map((row, index) => ({
            url: row.url,
            kind: row.kind || '',
            format: row.format || '',
            needsResolve: Boolean(row.needsResolve),
            title: resource.title || group.title,
            sourceName: resource.sourceName || hit.sourceName,
            lineName: firstLine.name || '默认线路',
            label: row.label || ('播放 ' + (index + 1)),
            episodeIndex: index
          })));
          stored = true;
        } catch { stored = false; }
      }
      if (stored) {
        payload.playlistId = playlistId;
        payload.episodeIndex = Math.max(0, firstLineEpisodes.findIndex((row) => row && row.url === episode.url));
      }
    }
    open(payload);
  } catch {
    flash(button, '播放失败');
  } finally {
    button.classList.remove('is-busy');
  }
}

function flash(button, text) {
  if (!button) return;
  button.classList.add('is-blocked');
  button.setAttribute('data-cf25-flash', text);
  window.setTimeout(() => button.classList.remove('is-blocked'), 1400);
}

/* ============ 事件旁听 ============ */

function scheduleSearch(query) {
  window.clearTimeout(hub.settleTimer);
  if (!query) {
    cancelRunning();
    bumpSearchId();
    hide();
    return;
  }
  hub.settleTimer = window.setTimeout(() => {
    if (isIsland()) return;
    if (queryNow() !== query) return;
    startSearch(query);
  }, DEBOUNCE_MS);
}

/**
 * 监听挂在 window 捕获阶段：捕获顺序 window → document → … → target，
 * 因此本监听一定早于 dual-search.js 注册在 document 上的捕获监听执行。
 * dual-search 在自然语言场景会 stopImmediatePropagation，那样 document 级监听全被掐断，
 * 挂 window 才能保证 Enter 一定被我们看到。仍然不 preventDefault / 不 stopPropagation。
 */
function bindInput() {
  window.addEventListener('input', (event) => {
    const input = inputEl();
    if (!input || event.target !== input) return;
    const query = String(input.value || '').trim();
    if (!query) {
      if (overlayDetailOpen()) return;
      cancelRunning();
      bumpSearchId();
      hide();
    }
  }, true);

  window.addEventListener('focusin', (event) => {
    const input = inputEl();
    if (!input || event.target !== input) return;
    if (isIsland()) return;
    openSearchPage();
  }, true);

  // 点搜索框（含已经聚焦时再次点击）也要展开：focusin 只在第一次聚焦时触发
  window.addEventListener('pointerdown', (event) => {
    const input = inputEl();
    if (!input || event.target !== input) return;
    if (isIsland()) return;
    openSearchPage();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (hub.suppress) return;
    const input = inputEl();
    if (!input || event.target !== input) return;
    if (event.key !== 'Enter') return;
    const query = String(input.value || '').trim();
    if (!query) return;
    scheduleSearchNow(query);
  }, true);
}

/**
 * 打开搜索页。
 * - 已有查询词且已有对应分组：保留现状，只把面板展开（不打断结果）；
 * - 其余情况：走空查询态（历史词 chip），等用户输入。
 */
function openSearchPage() {
  if (!els.panel) return;
  const query = String(queryNow()).trim();
  if (query && hub.groups.length && hub.query === query) {
    show();
    return;
  }
  showEmptyQueryState();
}

/** 退出搜索页：收起面板 + 让搜索框失焦，回到原页面 */
function dismissSearchPage() {
  cancelRunning();
  bumpSearchId();
  hide();
  const input = inputEl();
  if (input) {
    try { input.blur(); } catch { /* 失焦失败不影响收起 */ }
  }
}

/** 空查询态：只出历史词，不出逐源条 / 分组 / 骨架 */
function showEmptyQueryState() {
  if (!els.panel) return;
  hub.query = '';
  hub.sources.clear();
  hub.groups = [];
  if (els.sources) els.sources.innerHTML = '';
  if (els.groups) els.groups.innerHTML = '';
  if (els.headTitle) els.headTitle.textContent = '片源搜索';
  if (els.headSub) els.headSub.textContent = '输入片名后回车，横向扫描全部在线片源 · 点空白处退出';
  if (els.headCount) els.headCount.textContent = '';
  renderSkeleton(false);
  renderEmpty(null);
  renderHistory();
  show();
}

/**
 * Enter 立即响应：先把面板 + 逐源等待态铺出来（0ms，纯 DOM），再发 IPC。
 * 用户按 Enter 的下一帧就能看到「搜索页已打开、8 个源正在转圈」，
 * 真正的网络结果靠 cf:searchHub:progress 事件流式填进来 —— 体感上就是毫秒级。
 */
function scheduleSearchNow(query) {
  window.clearTimeout(hub.settleTimer);
  hub.settleTimer = window.setTimeout(() => {
    if (isIsland()) return;
    if (queryNow() !== query) return;
    startSearch(query);
  }, 0);
}

function bindEscape() {
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!hub.visible) return;
    // 详情卡/侧栏开着时，Escape 归它们自己的收回逻辑，搜索页不动
    if (overlayDetailOpen()) return;
    cancelRunning();
    bumpSearchId();
    hide();
  }, true);
}

function bindSectionObserver() {
  const section = document.querySelector('#searchSection');
  if (!section) return;
  new MutationObserver(() => {
    // 基线 resetSearchResults 会隐藏 #searchSection：此时搜索页也应整体收起
    if (section.classList.contains('is-hidden') && hub.visible) {
      cancelRunning();
      bumpSearchId();
      hide();
    }
  }).observe(section, { attributes: true, attributeFilter: ['class'] });
}

function bindIslandObserver() {
  new MutationObserver(() => {
    if (isIsland() && hub.visible) {
      cancelRunning();
      bumpSearchId();
      hide();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/* ============ 装配 ============ */

function adaptApi(api) {
  if (!api) return null;
  const hubApi = window.cineflowSearchHub;
  if (!hubApi) return null;
  return {
    ...api,
    cf25Start: (payload) => hubApi.start(payload),
    cf25Cancel: (payload) => hubApi.cancel(payload)
  };
}

/**
 * 只读自省：给测试与诊断用的一个窗口，不参与任何渲染逻辑。
 * 用于断言「展示口径」到底把片源归并成了什么，避免测试去解析 DOM 文本。
 */
export function inspectSearchWorkbench() {
  return {
    query: hub.query,
    groups: hub.groups.map((group) => ({ key: group.key, title: group.title, year: group.year, hits: (group.hits || []).length })),
    viewGroups: hub.viewGroups.map((group) => ({
      key: group.key, title: group.title, base: group.base, year: group.year,
      type: group.type, hits: (group.hits || []).length, rank: group.rank
    }))
  };
}

export function initSearchWorkbench(injected = {}) {
  try {
    if (document.documentElement.dataset.cf25Workbench === '1') return true;
    const adapted = adaptApi(injected.api || window.cineflow);
    if (!adapted) return false;
    deps = { ...injected, api: adapted };
    if (!buildPanel()) return false;
    document.documentElement.dataset.cf25Workbench = '1';

    hub.unsubscribe = window.cineflowSearchHub?.onProgress?.(applyProgress) || null;
    // 预热片源清单：让第一次 Enter 也能 0ms 铺出逐源等待态
    try {
      const statusApi = window.cineflowSearchHub;
      if (statusApi && typeof statusApi.status === 'function') {
        statusApi.status().then((info) => {
          if (info && Array.isArray(info.sources) && info.sources.length) {
            hub.knownSources = info.sources.map((source) => ({ sourceId: source.sourceId, name: source.name }));
          }
        }).catch(() => {});
      }
    } catch { /* 预热失败不影响主流程 */ }
    bindInput();
    bindEscape();
    bindSectionObserver();
    bindIslandObserver();
    // 预先挂详情面板观察器：详情一收就撤掉层级抬升，不依赖「相关」先被点过
    watchDetailClose();
    return true;
  } catch (error) {
    console.warn('[CineFlow] 搜索页工作台装配失败，已跳过', error);
    return false;
  }
}

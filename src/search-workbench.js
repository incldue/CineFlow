import { openDoubanSheet } from './douban-fallback.js';

const PANEL_ID = 'cf25SearchHub';
const LIFT_CLASS = 'cf25-detail-lift';
const HISTORY_KEY = 'cineflow:search-history:v2';
const ISLAND_CLASSES = ['island-mode', 'island-expanded-mode', 'island-docked-mode'];

const DEBOUNCE_MS = 320;
const FAST_LATENCY_MS = 900;
const MID_LATENCY_MS = 2000;
const MAX_CHIPS = 4;
const HISTORY_LIMIT = 8;
const POSTER_CONCURRENCY = 4;
const POSTER_MAX_PER_TURN = 24;
const PLAY_WAIT_MS = 6000;
const PLAY_POLL_MS = 240;

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
  posterPending: new Set(),
  posterWaiters: new Map(),
  posterQueue: [],
  posterActive: 0,
  hideTimer: 0,
  detailWatcher: null,
  settleTimer: 0,
  sources: new Map(),
  groups: [],
  unsubscribe: null,
  visible: false,
};

let deps = {};

function esc(value) {
  if (typeof deps.escapeHtml === 'function') {
    try { return deps.escapeHtml(value); } catch {  }
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

const FADE_OUT_MS = 170;

function keepOnTop() {

  try {
    const host = document.getElementById('app');
    if (host && els.panel && els.panel.parentElement !== host) host.appendChild(els.panel);
  } catch {  }
}

function show() {
  if (!els.panel) return;
  keepOnTop();

  if (hub.hideTimer) { window.clearTimeout(hub.hideTimer); hub.hideTimer = 0; }
  if (hub.visible) return;
  hub.visible = true;
  els.panel.classList.remove('is-hidden');
  els.panel.setAttribute('aria-hidden', 'false');

  let opened = false;
  const markOpen = () => {
    if (opened) return;
    opened = true;
    if (hub.visible) els.panel?.classList.add('is-open');
  };
  requestAnimationFrame(markOpen);
  window.setTimeout(markOpen, 32);
}

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

function enqueuePoster(imgEl) {
  if (!imgEl) return;
  const url = imgEl.getAttribute('data-cf25-img') || '';
  if (!url) return;
  const cached = hub.posterResolved.get(url);
  if (cached !== undefined) { applyPoster(imgEl, cached); return; }
  if (hub.posterPending.has(url)) {

    hub.posterWaiters.set(url, (hub.posterWaiters.get(url) || []).concat(imgEl));
    return;
  }
  if (hub.posterSeq >= POSTER_MAX_PER_TURN) {

    return;
  }
  hub.posterSeq += 1;
  hub.posterPending.add(url);
  hub.posterQueue.push({ url, imgEl });
  pumpPosterQueue();
}

function applyPoster(imgEl, result) {
  if (!imgEl) return;

  if (imgEl.isConnected === false) return;
  const holder = imgEl.parentElement;
  if (result && result.dataUrl) {

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

  hub.posterQueue.sort((a, b) => {
    const av = a.imgEl.isConnected ? 1 : 0;
    const bv = b.imgEl.isConnected ? 1 : 0;
    return bv - av;
  });
}

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

function bumpSearchId() {
  hub.searchId += 1;
  return hub.searchId;
}

function cancelRunning() {
  const api = deps.api;
  if (!api || !api.cf25Cancel) return;
  try { api.cf25Cancel({ searchId: hub.searchId }); } catch {  }
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

  const previous = hub.searchId;
  hub.searchId = previous + 1;
  const mine = hub.searchId;
  try { api.cf25Cancel({ searchId: previous }); } catch {  }

  resetForNewQuery(query);
  show();

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

  if (Array.isArray(response.sources) && response.sources.length) {
    hub.knownSources = response.sources.map((source) => ({
      sourceId: source.sourceId,
      name: source.name
    }));
  }

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

const VERSION_SUFFIX = /(国语|粤语|英语|原声|中字|中文字幕|双字|国粤双语|双语|高清|超清|蓝光|完整版|未删减版?|加长版|抢先版|枪版|特别版|特别篇|纪念版|周年纪念版|导演剪辑版|hd|bd|4k|1080p|2160p)+$/i;

const TRAILING_PAREN = /[（(]\s*([^（）()]{1,8})\s*[)）]\s*$/;

const FOREIGN_ALIAS = /^(.*[\u4e00-\u9fff])\s+([^\u4e00-\u9fff]{2,})$/;

function cleanDisplayTitle(title) {
  const raw = String(title || '');
  const head = raw.split(/[$|\n\r]/)[0] || '';
  return head.trim() || raw.trim();
}

function baseDisplayTitle(title) {
  let text = cleanDisplayTitle(title);
  for (let i = 0; i < 4; i += 1) {

    const before = text;
    text = text.replace(TRAILING_PAREN, '').trim() || text;
    text = text.replace(VERSION_SUFFIX, '').trim() || text;
    text = text.replace(FOREIGN_ALIAS, '$1').trim() || text;
    if (text === before) break;
  }
  return text;
}

function relevanceRank(base, queryNorm) {
  if (!queryNorm) return 1;
  if (base === queryNorm) return 0;
  if (base.startsWith(queryNorm)) return 1;
  return 2;
}

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

    group.weight = group.rank * 1000
      + Math.min(group.base.length, 40) * 4
      - Math.min(group.hits.length, 20) * 5;
  }
  view.sort((a, b) => a.weight - b.weight || String(a.title).localeCompare(String(b.title)));
  hub.viewGroups = view;
}

function rawTitleOf(members, fallback) {
  let best = '';
  for (const member of members) {
    const title = cleanDisplayTitle(member.title);
    if (!title) continue;
    if (!best || title.length < best.length) best = title;
  }
  return best || fallback;
}

function findGroup(key) {
  if (!key) return null;
  return hub.viewGroups.find((item) => item.key === key)
    || hub.groups.find((item) => item.key === key)
    || null;
}

function exitToRelated(group) {
  cancelRunning();
  bumpSearchId();

  let settled = false;
  const settle = (movie) => {
    if (settled) return;
    settled = true;
    if (movie) openDetailAbove(movie, group);
    else openDoubanAbove(group);
  };

  window.setTimeout(() => settle(null), 900);
  resolveMovie(group).then(settle).catch(() => settle(null));
}

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
  } catch {  }
  paintSheetPoster(group);
}

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

function watchDetailClose() {
  if (hub.detailWatcher) return;
  const panel = document.querySelector('#detailPanel');
  if (!panel) {

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

function overlayDetailOpen() {
  try {
    if (document.querySelector('#detailPanel.is-open')) return true;
    if (document.querySelector('.cf8-sheet.is-open')) return true;
  } catch {  }
  return false;
}

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

  if (!String(queryNow()).trim() && !overlayDetailOpen()) dismissSearchPage();
}

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

      if (exact) return exact;
      fallback = picked;
    }
    if (response && response.done) return fallback;
    const next = Number(response?.nextCursor);
    if (Number.isFinite(next) && next > cursor) cursor = next;
    else if (!resources.length) cursor += 3;

    await new Promise((resolve) => window.setTimeout(resolve, PLAY_POLL_MS));
  }
  return fallback;
}

async function playChip(button) {

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

function openSearchPage() {
  if (!els.panel) return;
  const query = String(queryNow()).trim();
  if (query && hub.groups.length && hub.query === query) {
    show();
    return;
  }
  showEmptyQueryState();
}

function dismissSearchPage() {
  cancelRunning();
  bumpSearchId();
  hide();
  const input = inputEl();
  if (input) {
    try { input.blur(); } catch {  }
  }
}

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

    try {
      const statusApi = window.cineflowSearchHub;
      if (statusApi && typeof statusApi.status === 'function') {
        statusApi.status().then((info) => {
          if (info && Array.isArray(info.sources) && info.sources.length) {
            hub.knownSources = info.sources.map((source) => ({ sourceId: source.sourceId, name: source.name }));
          }
        }).catch(() => {});
      }
    } catch {  }
    bindInput();
    bindEscape();
    bindSectionObserver();
    bindIslandObserver();

    watchDetailClose();
    return true;
  } catch (error) {
    console.warn('[CineFlow] 搜索页工作台装配失败，已跳过', error);
    return false;
  }
}

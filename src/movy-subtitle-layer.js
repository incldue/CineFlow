import './movy-subtitle.css';

const SETTINGS_KEY = 'cineflow:movy-sub:v1';
const PLAYCTX_KEY = 'cineflow:movy-playctx:v1';
const TRANS_KEY = 'cineflow:movy-sub-trans:v1';
const CUE_WINDOW = 40;
const TICK_MS = 220;

const LANG_NAMES = {
  zho: '中文', chi: '中文', zh: '中文', chs: '简体中文', cht: '繁體中文',
  eng: 'English', en: 'English', jpn: '日本語', ja: '日本語', kor: '한국어', ko: '한국어',
  spa: 'Español', es: 'Español', fra: 'Français', fre: 'Français', fr: 'Français',
  deu: 'Deutsch', ger: 'Deutsch', de: 'Deutsch', rus: 'Русский', ru: 'Русский',
  ita: 'Italiano', it: 'Italiano', por: 'Português', pt: 'Português', ara: 'العربية', ar: 'العربية',
  hin: 'हिन्दी', hi: 'हिन्दी', tha: 'ไทย', th: 'ไทย', vie: 'Tiếng Việt', vi: 'Tiếng Việt',
  tur: 'Türkçe', tr: 'Türkçe', pol: 'Polski', pl: 'Polski', nld: 'Nederlands', dut: 'Nederlands',
  nl: 'Nederlands', swe: 'Svenska', sv: 'Svenska', dan: 'Dansk', da: 'Dansk', nor: 'Norsk', no: 'Norsk',
  fin: 'Suomi', fi: 'Suomi', ces: 'Čeština', cze: 'Čeština', cs: 'Čeština', hun: 'Magyar', hu: 'Magyar',
  ron: 'Română', rum: 'Română', ro: 'Română', ukr: 'Українська', uk: 'Українська',
  ell: 'Ελληνικά', gre: 'Ελληνικά', el: 'Ελληνικά', heb: 'עברית', he: 'עברית',
  ind: 'Bahasa Indonesia', id: 'Bahasa Indonesia', msa: 'Bahasa Melayu', may: 'Bahasa Melayu',
  bul: 'Български', bg: 'Български', srp: 'Српски', hrv: 'Hrvatski', slk: 'Slovenčina',
  slv: 'Slovenščina', lit: 'Lietuvių', lav: 'Latviešu', est: 'Eesti', cat: 'Català',
  fas: 'فارسی', per: 'فارسی', fa: 'فارسی', urd: 'اردو', ben: 'বাংলা', tam: 'தமிழ்',
  tel: 'తెలుగు', mal: 'മലയാളം', kan: 'ಕನ್ನಡ', mar: 'मराठी', guj: 'ગુજરાતી', pan: 'ਪੰਜਾਬੀ',
  nep: 'नेपाली', sin: 'සිංහල', khm: 'ខ្មែរ', lao: 'ລາວ', mya: 'မြန်မာ', geo: 'ქართული',
  kat: 'ქართული', hye: 'Հայերեն', arm: 'Հայերեն', kaz: 'Қазақша', uzb: 'Oʻzbekcha',
  aze: 'Azərbaycan', bel: 'Беларуская', bos: 'Bosanski', mkd: 'Македонски', alb: 'Shqip',
  sqi: 'Shqip', isl: 'Íslenska', gle: 'Gaeilge', cym: 'Cymraeg', afr: 'Afrikaans',
  swa: 'Kiswahili', amh: 'አማርኛ', ceb: 'Cebuano', fil: 'Filipino', tgl: 'Filipino',
};

function baseLang(code) {
  return String(code || '').toLowerCase().replace(/\(.*$/, '').trim();
}

function langLabel(code, label) {
  if (label) return String(label);
  const raw = String(code || '');
  const base = baseLang(raw);
  const name = LANG_NAMES[base];
  const suffix = /\(sdh\)|sdh|cc/i.test(raw) ? ' · SDH' : '';
  if (name) return name + suffix;
  return (base || raw || '未知') + suffix;
}

function isChinese(code, label) {
  if (/中文|chinese/i.test(String(code || '') + ' ' + String(label || ''))) return true;
  return ['zho', 'chi', 'zh', 'chs', 'cht', 'cmn'].includes(baseLang(code));
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {  }
}

export function initMovySubtitle(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  if (!doc || window.__cfSubReady) return () => {};
  window.__cfSubReady = true;

  const diag = window.__cfSub = { opens: 0, fetches: 0, cues: 0, translates: 0, renders: 0, discover: 0, discovered: 0, online: 0, errors: [] };
  const bridge = () => (window.cineflowMovy && typeof window.cineflowMovy.subCues === 'function' ? window.cineflowMovy : null);

  let overlay = null; let primary = null; let secondary = null;
  let panel = null; let button = null;
  let video = null;
  let tracks = []; let activeTrack = null;
  let onlineTracks = []; let onlineBusy = false; let onlineTried = false;
  let cues = []; let translations = new Map(); let translating = new Set();
  let cueIndex = -1; let shownKey = '';
  let tickTimer = 0; let loadToken = 0;
  let currentKey = ''; let currentSrc = '';

  const settings = { ...readJson(SETTINGS_KEY, {}), size: 1, offset: 0, bottom: 9, ai: false, aiTouched: false, trackUrl: '' };

  function persist() { writeJson(SETTINGS_KEY, settings); }

  function modalOpen() {
    const modal = doc.querySelector('#playerModal');
    return !!modal && modal.classList.contains('is-open');
  }

  function playContext() {
    const data = readJson(PLAYCTX_KEY, null);
    if (!data || !data.title) return null;
    if (Date.now() - Number(data.at || 0) > 6 * 60 * 60 * 1000) return null;
    if (!Array.isArray(data.subtitles)) data.subtitles = [];
    return data;
  }

  function buildOverlay() {
    if (overlay && doc.body.contains(overlay)) return overlay;
    const stage = doc.querySelector('#playerStage');
    if (!stage) return null;
    overlay = doc.createElement('div');
    overlay.className = 'cf-sub-overlay';
    overlay.innerHTML = '<div class="cf-sub-grip"></div><div class="cf-sub-line cf-sub-primary"></div><div class="cf-sub-line cf-sub-secondary"></div>';
    primary = overlay.querySelector('.cf-sub-primary');
    secondary = overlay.querySelector('.cf-sub-secondary');
    stage.appendChild(overlay);
    applyGeometry();
    return overlay;
  }

  function applyGeometry() {
    if (!overlay) return;
    overlay.style.setProperty('--cf-sub-size', String(settings.size));
    overlay.style.setProperty('--cf-sub-bottom', String(settings.bottom) + '%');
  }

  function buildButton() {
    const actions = doc.querySelector('#playerModal .player-actions');
    if (!actions) return false;
    if (button && actions.contains(button)) return true;
    button = doc.createElement('button');
    button.type = 'button';
    button.id = 'cfSubBtn';
    button.className = 'secondary-button cf-sub-btn';
    button.textContent = '字幕';
    actions.insertBefore(button, actions.firstChild);
    button.addEventListener('click', () => togglePanel());
    return true;
  }

  function buildPanel() {
    if (panel) return panel;
    panel = doc.createElement('div');
    panel.id = 'cfSubPanel';
    panel.className = 'cf-sub-panel is-hidden';
    doc.body.appendChild(panel);
    panel.addEventListener('click', (event) => {
      const row = event.target && event.target.closest ? event.target.closest('[data-sub-track]') : null;
      if (row) { chooseTrack(row.dataset.subTrack); return; }
      const onlineRow = event.target && event.target.closest ? event.target.closest('[data-sub-online]') : null;
      if (onlineRow) { chooseOnline(Number(onlineRow.dataset.subOnline)); return; }
      const act = event.target && event.target.closest ? event.target.closest('[data-sub-act]') : null;
      if (!act) return;
      const kind = act.dataset.subAct;
      if (kind === 'ai') { settings.ai = !settings.ai; settings.aiTouched = true; persist(); renderPanel(); primeTranslate(); }
      if (kind === 'size+') { settings.size = Math.min(1.7, Number((settings.size + 0.1).toFixed(2))); persist(); applyGeometry(); renderPanel(); }
      if (kind === 'size-') { settings.size = Math.max(0.6, Number((settings.size - 0.1).toFixed(2))); persist(); applyGeometry(); renderPanel(); }
      if (kind === 'offset-') { settings.offset = Number((settings.offset - 0.2).toFixed(1)); persist(); renderPanel(); tick(true); }
      if (kind === 'offset+') { settings.offset = Number((settings.offset + 0.2).toFixed(1)); persist(); renderPanel(); tick(true); }
      if (kind === 'reset') { settings.offset = 0; settings.bottom = 9; settings.size = 1; persist(); applyGeometry(); renderPanel(); tick(true); }
      if (kind === 'off') { chooseTrack(''); }
      if (kind === 'load') { loadLocalFile(); }
      if (kind === 'search') { onlineTried = false; searchOnline(playContext()); }
    });
    return panel;
  }

  function positionPanel() {
    if (!panel || !button) return;
    const rect = button.getBoundingClientRect();
    const width = 300;
    const left = Math.min(Math.max(12, rect.left - width + 70), Math.max(12, window.innerWidth - width - 12));
    panel.style.width = width + 'px';
    panel.style.left = Math.round(left) + 'px';
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 320) {
      panel.style.top = 'auto';
      panel.style.bottom = Math.round(window.innerHeight - rect.top + 8) + 'px';
    } else {
      panel.style.bottom = 'auto';
      panel.style.top = Math.round(rect.bottom + 8) + 'px';
    }
  }

  function togglePanel() {
    buildPanel();
    const host = fullscreenHost();
    const mount = host && host !== 'video' ? host : doc.body;
    if (panel && panel.parentElement !== mount) mount.appendChild(panel);
    const hidden = panel.classList.contains('is-hidden');
    if (hidden) { renderPanel(); positionPanel(); panel.classList.remove('is-hidden'); }
    else panel.classList.add('is-hidden');
  }

  function renderPanel() {
    if (!panel) return;
    const rows = (list, prefix) => list.map((track, index) => {
      const active = activeTrack && activeTrack.url === track.url;
      const label = langLabel(track.language || track.lang, track.label);
      return '<button type="button" class="cf-sub-track' + (active ? ' is-active' : '') + '" data-sub-track="' + encodeURIComponent(track.url || '') + '"'
        + (track.online ? ' data-sub-online="' + index + '"' : '') + '>'
        + '<span>' + label + '</span><em>' + (track.online ? '在线' : String(track.lang || track.language || '').toUpperCase()) + '</em></button>';
    }).join('');
    const list = tracks.length || onlineTracks.length
      ? rows(tracks) + (onlineTracks.length ? '<p class="cf-sub-hint">在线字幕（来自字幕站）</p>' + rows(onlineTracks, 'online') : '')
      : (onlineBusy ? '<p class="cf-sub-hint">正在找在线字幕…</p>' : '<p class="cf-sub-hint">该片源没有字幕轨</p>');
    const aiDisabled = !activeTrack || isChinese(activeTrack.language || activeTrack.lang, activeTrack.label);
    panel.innerHTML = [
      '<div class="cf-sub-head"><strong>字幕</strong><em>' + (activeTrack ? langLabel(activeTrack.language || activeTrack.lang) : '关闭') + '</em></div>',
      '<div class="cf-sub-list">',
      '<button type="button" class="cf-sub-track' + (!activeTrack ? ' is-active' : '') + '" data-sub-track=""><span>关闭字幕</span><em>OFF</em></button>',
      list,
      '</div>',
      '<div class="cf-sub-tools">',
      '<button type="button" class="cf-sub-tool' + (settings.ai ? ' is-on' : '') + '" data-sub-act="ai"' + (aiDisabled ? ' disabled title="选中非中文字幕轨后可用"' : '') + '>AI 双语</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="size-">A-</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="size+">A+</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="offset-">-' + Math.abs(settings.offset).toFixed(1) + 's</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="offset+">+' + Math.abs(settings.offset).toFixed(1) + 's</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="load">载入字幕</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="search">搜在线</button>',
      '<button type="button" class="cf-sub-tool" data-sub-act="reset">复位</button>',
      '</div>',
      '<p class="cf-sub-note">拖字幕可调高度 · V 开关 · , . 调延迟</p>',
    ].join('');
  }

  function pickDefaultTrack(list) {
    if (!list.length) return null;
    const zh = list.find((item) => isChinese(item.language || item.lang, item.label) && !/sdh/i.test(String(item.language || '')))
      || list.find((item) => isChinese(item.language || item.lang, item.label));
    if (zh) return zh;
    const eng = list.find((item) => baseLang(item.language || item.lang) === 'eng');
    return eng || list[0];
  }

  async function chooseTrack(url) {
    const wanted = decodeURIComponent(String(url || ''));
    if (!wanted) {
      activeTrack = null; cues = []; cueIndex = -1; shownKey = '';
      if (primary) primary.textContent = '';
      if (secondary) secondary.textContent = '';
      settings.trackUrl = ''; persist(); renderPanel(); updateButton();
      return;
    }
    const track = tracks.find((item) => item.url === wanted) || null;
    if (!track) return;
    activeTrack = track;
    settings.trackUrl = track.url;
    persist();
    renderPanel();
    updateButton();
    await loadCues(track);
  }

  async function applyLocalCues(list, name) {
    if (!Array.isArray(list) || !list.length) return;
    const entry = { url: 'local:' + (name || 'file'), lang: 'local', language: 'local', label: name || '本地字幕', online: true };
    activeTrack = entry;
    tracks = [entry];
    cueIndex = -1; shownKey = '';
    nativeLastIndex = -2;
    if (nativeTrack) nativeTrack.mode = 'hidden';
    clearNative();
    settings.trackUrl = entry.url;
    persist();
    renderPanel();
    updateButton();
    cues = list.slice().sort((a, b) => a.s - b.s);
    diag.cues = cues.length;
    primeTranslate();
    tick(true);
  }

  async function loadLocalFile() {
    const api = bridge();
    if (!api || typeof api.subPick !== 'function') return;
    try {
      const result = await api.subPick();
      if (!result || result.canceled) return;
      if (!result.ok) { diag.errors.push(result.error || '本地字幕解析失败'); renderPanel(); return; }
      await applyLocalCues(result.cues, result.name);
    } catch (error) { diag.errors.push('load: ' + String((error && error.message) || error)); }
  }

  async function chooseOnline(index) {
    const track = onlineTracks[index];
    if (!track) return;
    activeTrack = track;
    settings.trackUrl = track.url;
    persist();
    renderPanel();
    updateButton();
    await loadCues(track);
  }

  async function loadCues(track) {
    const api = bridge();
    if (!api || !track) return;
    const token = ++loadToken;
    cues = []; translating = new Set(); cueIndex = -1; shownKey = '';
    nativeLastIndex = -2;
    if (nativeTrack) nativeTrack.mode = 'hidden';
    clearNative();
    hydrateTranslations();
    if (primary) primary.textContent = '';
    if (secondary) secondary.textContent = '';
    diag.fetches += 1;
    try {
      const result = track.online
        ? await api.subOnlineLoad({ track: track.payload })
        : await api.subCues({ url: track.url, lang: track.lang || track.language || '' });
      if (token !== loadToken) return;
      if (result && result.ok && Array.isArray(result.cues)) {
        cues = result.cues;
        diag.cues = cues.length;
        primeTranslate();
        tick(true);
      } else {
        diag.errors.push((result && result.error) || '字幕解析失败');
        renderPanel();
      }
    } catch (error) {
      diag.errors.push(String((error && error.message) || error));
    }
  }

  function findCueIndex(time) {
    if (!cues.length) return -1;
    let lo = 0; let hi = cues.length - 1; let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= time) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (hit < 0) return -1;
    return time < cues[hit].e ? hit : -1;
  }

  const translateQueue = [];
  let translateActive = 0;

  function hydrateTranslations() {
    const saved = readJson(TRANS_KEY, {});
    for (const [text, value] of Object.entries(saved)) {
      if (typeof value === 'string' && value) translations.set(text, value);
    }
  }

  let saveTimer = 0;
  function persistTranslations() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      const out = {};
      let count = 0;
      for (const [text, value] of translations) {
        if (count >= 4000) break;
        out[text] = value;
        count += 1;
      }
      writeJson(TRANS_KEY, out);
    }, 4000);
  }

  async function translateOne(text, from) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl='
      + encodeURIComponent(from || 'auto') + '&tl=zh-CN&q=' + encodeURIComponent(text);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = window.setTimeout(() => { try { controller && controller.abort(); } catch {  } }, 2500);
    try {
      const response = await window.fetch(url, { mode: 'cors', signal: controller ? controller.signal : undefined });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const pieces = Array.isArray(data && data[0]) ? data[0] : [];
      return pieces.map((part) => (Array.isArray(part) ? String(part[0] || '') : '')).join('');
    } finally { window.clearTimeout(timer); }
  }

  async function translateViaMain(texts, from) {
    const api = bridge();
    if (!api || typeof api.subTranslate !== 'function') return {};
    const result = await api.subTranslate({ texts, from, to: 'zh-CN' });
    return (result && result.map) || {};
  }

  function pumpTranslate() {
    while (translateActive < 5 && translateQueue.length) {
      const job = translateQueue.shift();
      translateActive += 1;
      const from = (activeTrack && (activeTrack.lang || activeTrack.language)) || '';
      translateOne(job.text, from)
        .then((value) => { if (value) translations.set(job.text, value); })
        .catch(async () => {
          try {
            const map = await translateViaMain([job.text], from);
            if (map && map[job.text]) translations.set(job.text, map[job.text]);
          } catch { diag.errors.push('translate-fallback'); }
        })
        .finally(() => {
          translateActive -= 1;
          translating.delete(job.text);
          if (translations.size && translations.size % 12 === 0) persistTranslations();
          pumpTranslate();
          tick(true);
        });
    }
  }

  function primeTranslate() {
    if (!settings.ai || !activeTrack || !cues.length) return;
    if (isChinese(activeTrack.language || activeTrack.lang, activeTrack.label)) return;
    const center = cueIndex >= 0 ? cueIndex : 0;
    const from = Math.max(0, center - 2);
    const to = Math.min(cues.length, center + CUE_WINDOW);
    let queued = 0;
    for (let i = from; i < to; i += 1) {
      const text = cues[i].t;
      if (translations.has(text) || translating.has(text)) continue;
      translating.add(text);
      translateQueue.push({ text });
      queued += 1;
    }
    if (!queued) return;
    diag.translates += 1;
    diag.ai = !!settings.ai;
    pumpTranslate();
  }

  function renderCue(index) {
    if (!primary || !secondary) return;
    if (index < 0) {
      if (primary.textContent) primary.textContent = '';
      if (secondary.textContent) secondary.textContent = '';
      shownKey = '';
      return;
    }
    const cue = cues[index];
    const translated = settings.ai ? translations.get(cue.t) || '' : '';
    const key = cue.t + '|' + translated;
    if (key === shownKey) return;
    shownKey = key;
    diag.renders += 1;
    primary.textContent = cue.t;
    secondary.textContent = translated;
    secondary.classList.toggle('is-on', !!translated);
    if (settings.ai && !translated && !translating.has(cue.t)) primeTranslate();
  }

  function tick(force) {
    if (!force && watchSwitch()) return;
    const el = doc.querySelector('#resourcePlayer') || video;
    if (el && nativeTrack && nativeTrack.mode === 'showing') {
      const now = Math.max(0, (Number(el.currentTime) || 0) + (Number(settings.offset) || 0));
      if (findCueIndex(now) !== nativeLastIndex) syncNativeTrack(true);
    }
    if (!el) return;
    if (el !== video) { video = el; cueIndex = -1; shownKey = ''; }
    if (!activeTrack) return;
    const time = Math.max(0, (Number(el.currentTime) || 0) + (Number(settings.offset) || 0));
    const index = findCueIndex(time);
    if (index !== cueIndex || force) {
      cueIndex = index;
      renderCue(index);
      if (settings.ai && index >= 0) primeTranslate();
      if (nativeTrack && nativeTrack.mode === 'showing') syncNativeTrack(true);
    }
  }

  function updateButton() {
    if (!button) return;
    const label = activeTrack ? langLabel(activeTrack.language || activeTrack.lang, activeTrack.label) : '字幕';
    button.textContent = activeTrack ? '字幕 · ' + label : '字幕';
    button.classList.toggle('is-on', !!activeTrack);
  }

  function attach() {
    const el = doc.querySelector('#resourcePlayer');
    buildOverlay();
    buildButton();
    if (el && el !== video) {
      if (video && video.__cfSubBound) {  }
      video = el;
      video.__cfSubBound = true;
    }
    if (el && !el.__cfSubWatched) {
      el.__cfSubWatched = true;
      el.addEventListener('emptied', () => { if (modalOpen()) watchSwitch(); });
      el.addEventListener('loadedmetadata', () => { if (modalOpen()) watchSwitch(); });
    }
    if (!tickTimer) tickTimer = window.setInterval(() => { if (modalOpen()) tick(false); }, TICK_MS);
    updateButton();
    renderPanel();
  }

  function normalizeTracks(list) {
    return (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
      .slice(0, 40)
      .map((item) => ({ url: item.url, lang: item.lang || item.language || '', language: item.language || item.lang || '' }));
  }

  function discoverTracks(context) {
    const api = bridge();
    if (!api) return;
    if (!context || !context.streamUrl || typeof api.subDiscover !== 'function') { huntOtherProviders(context); return; }
    diag.discover += 1;
    api.subDiscover({ streamUrl: context.streamUrl, subtitles: [] })
      .then((result) => {
        const found = normalizeTracks(result && result.tracks);
        diag.discovered = found.length;
        if (!found.length) { huntOtherProviders(context); return; }
        applyTracks(found);
      })
      .catch((error) => { diag.errors.push('discover: ' + String((error && error.message) || error)); huntOtherProviders(context); });
  }

  function applyTracks(found) {
    tracks = found;
    renderPanel();
    const target = pickDefaultTrack(found);
    if (target) chooseTrack(encodeURIComponent(target.url));
  }

  async function huntOtherProviders(context) {
    const api = bridge();
    if (!api || typeof api.sources !== 'function' || !context) { searchOnline(context); return; }
    const tried = new Set([String(context.provider || '')]);
    let all = [];
    try {
      const cached = JSON.parse(window.localStorage.getItem('cineflow:movy-providers:v1') || 'null');
      if (cached && Array.isArray(cached.list)) all = cached.list;
    } catch {  }
    if (!all.length) all = ['Miami', 'Boise', 'Nashville', 'Chicago', 'Vegas', 'Tokyo', 'Berlin', 'Paris'];
    const pool = all.map((item) => (typeof item === 'string' ? item : (item && (item.name || item.id)) || ''))
      .filter((name) => name && !tried.has(name));
    for (const provider of pool) {
      try {
        diag.hunt = (diag.hunt || 0) + 1;
        const result = await api.sources({
          provider,
          mediaType: context.mediaType,
          title: context.title,
          year: context.year,
          tmdbId: context.tmdbId,
          seasonId: context.seasonId,
          episodeId: context.episodeId,
        });
        const found = normalizeTracks(result && result.subtitles);
        if (found.length) { diag.huntHit = provider; applyTracks(found); return; }
      } catch {  }
    }
    renderPanel();
    searchOnline(context);
  }

  async function searchOnline(context) {
    const api = bridge();
    if (onlineTried || !api || typeof api.subOnline !== 'function' || !context) return;
    onlineTried = true;
    onlineBusy = true;
    renderPanel();
    try {
      const result = await api.subOnline({
        title: context.title,
        year: context.year,
        mediaType: context.mediaType,
        season: context.seasonId,
        episode: context.episodeId,
      });
      const list = (result && Array.isArray(result.tracks) ? result.tracks : []).map((item, index) => ({
        url: 'online:' + index + ':' + (item.source || '') + ':' + (item.lang || ''),
        lang: item.lang || '',
        language: item.lang || '',
        label: item.label || '',
        online: true,
        payload: item,
      }));
      onlineTracks = list;
      diag.online = list.length;
      if (list.length && !activeTrack) {
        const best = list.find((item) => isChinese(item.lang, item.label)) || list[0];
        await chooseOnline(list.indexOf(best));
      }
    } catch (error) {
      diag.errors.push('online: ' + String((error && error.message) || error));
    }
    onlineBusy = false;
    renderPanel();
  }

  function contextKey(context) {
    if (!context) return '';
    return [context.tmdbId || '', context.seasonId || '', context.episodeId || '', context.streamUrl || '', context.title || ''].join('|');
  }

  function videoSrc() {
    const el = doc.querySelector('#resourcePlayer');
    return el ? String(el.currentSrc || el.src || '') : '';
  }

  function resetForSwitch() {
    loadToken += 1;
    tracks = []; activeTrack = null; cues = []; cueIndex = -1; shownKey = ''; diag.cues = 0;
    onlineTracks = []; onlineBusy = false; onlineTried = false;
    nativeLastIndex = -2;
    clearNative();
    nativeTrack = null; nativeVideo = null;
    if (primary && primary.textContent) primary.textContent = '';
    if (secondary) { secondary.textContent = ''; secondary.classList.remove('is-on'); }
    renderPanel();
    updateButton();
  }

  function watchSwitch() {
    const raw = window.localStorage.getItem(PLAYCTX_KEY) || '';
    const context = playContext();
    const key = contextKey(context);
    const src = videoSrc();
    const rotated = (key && currentKey && key !== currentKey) || (src && currentSrc && src !== currentSrc);
    if (key) currentKey = key;
    if (src) currentSrc = src;
    if (!rotated) return false;
    resetForSwitch();
    if (context) openFor(context);
    else if (raw) openFor(playContext());
    return true;
  }

  function openFor(context) {
    diag.opens += 1;
    openFor.lastAt = Number((context && context.at) || 0);
    currentKey = contextKey(context);
    currentSrc = videoSrc();
    tracks = normalizeTracks(context && context.subtitles);
    onlineTracks = []; onlineTried = false; onlineBusy = false;
    const remembered = tracks.find((item) => item.url === settings.trackUrl);
    const target = remembered || pickDefaultTrack(tracks);
    if (!settings.aiTouched && target && !isChinese(target.language || target.lang)) {
      settings.ai = true;
    }
    attach();
    if (!tracks.length) {
      activeTrack = null; cues = [];
      if (primary) primary.textContent = '';
      if (secondary) secondary.textContent = '';
      renderPanel();
      updateButton();
      discoverTracks(context);
      return;
    }
    if (target) chooseTrack(encodeURIComponent(target.url));
  }

  doc.addEventListener('pointerdown', (event) => {
    const grip = event.target && event.target.closest ? event.target.closest('.cf-sub-grip') : null;
    if (!grip || !modalOpen()) return;
    overlay && overlay.classList.add('is-dragging');
    const stage = doc.querySelector('#playerStage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const startY = event.clientY;
    const startBottom = Number(settings.bottom) || 9;
    const move = (ev) => {
      const delta = (startY - ev.clientY) / Math.max(1, rect.height) * 100;
      settings.bottom = Math.min(45, Math.max(2, Number((startBottom + delta).toFixed(1))));
      applyGeometry();
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      overlay && overlay.classList.remove('is-dragging');
      persist();
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }, true);

  doc.addEventListener('keydown', (event) => {
    if (!modalOpen()) return;
    const tag = (event.target && event.target.tagName) || '';
    if (/input|textarea|select/i.test(tag) || (event.target && event.target.isContentEditable)) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'v') {
      event.preventDefault();
      if (activeTrack) chooseTrack('');
      else { const target = pickDefaultTrack(tracks); if (target) chooseTrack(encodeURIComponent(target.url)); }
      return;
    }
    if (key === ',') { event.preventDefault(); settings.offset = Number((settings.offset - 0.1).toFixed(1)); persist(); tick(true); }
    if (key === '.') { event.preventDefault(); settings.offset = Number((settings.offset + 0.1).toFixed(1)); persist(); tick(true); }
  });

  function fullscreenHost() {
    const element = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (!element) return null;
    if (element.tagName === 'VIDEO') return 'video';
    return element;
  }

  let nativeTrack = null;
  let nativeVideo = null;
  let nativeLastIndex = -2;

  function ensureNativeTrack(video) {
    if (!video || typeof video.addTextTrack !== 'function') return null;
    if (nativeTrack && nativeVideo === video) return nativeTrack;
    nativeVideo = video;
    nativeLastIndex = -2;
    try {
      nativeTrack = video.addTextTrack('subtitles', 'CineFlow', 'zh');
      nativeTrack.mode = 'hidden';
    } catch { nativeTrack = null; }
    return nativeTrack;
  }

  function clearNative() {
    if (!nativeTrack) return;
    try { while (nativeTrack.cues && nativeTrack.cues.length) nativeTrack.removeCue(nativeTrack.cues[0]); } catch {  }
  }

  function textFor(cue) {
    const base = String((cue && cue.t) || '').trim();
    const zh = settings.ai ? translations.get(cue.t) || '' : '';
    return zh && zh !== base ? base + '\n' + zh : base;
  }

  function syncNativeTrack(enabled) {
    const video = doc.querySelector('#resourcePlayer');
    if (!video) return;
    if (!enabled) {
      if (nativeTrack) { nativeTrack.mode = 'hidden'; clearNative(); }
      nativeLastIndex = -2;
      return;
    }
    const track = ensureNativeTrack(video);
    if (!track) return;
    const time = Math.max(0, (Number(video.currentTime) || 0) + (Number(settings.offset) || 0));
    const index = findCueIndex(time);
    if (index === nativeLastIndex) return;
    nativeLastIndex = index;
    clearNative();
    if (index < 0) return;
    const from = Math.max(0, index - 1);
    const to = Math.min(cues.length - 1, index + 6);
    for (let i = from; i <= to; i += 1) {
      const cue = cues[i];
      const text = textFor(cue);
      if (!text) continue;
      try {
        const vtt = new window.VTTCue(Math.max(0, cue.s), Math.max(cue.s + 0.05, cue.e), text.replace(/\n/g, '\u000a'));
        track.addCue(vtt);
      } catch {  }
    }
    try { track.mode = 'showing'; } catch {  }
  }

  function placeOverlay() {
    if (!overlay) return;
    const host = fullscreenHost();
    if (host === 'video') {
      overlay.style.display = 'none';
      syncNativeTrack(true);
      return;
    }
    overlay.style.display = '';
    syncNativeTrack(false);
    const target = host || doc.querySelector('#playerStage');
    if (target && overlay.parentElement !== target) target.appendChild(overlay);
    positionPanel();
  }

  function decodeFileBytes(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch {
      try { return new TextDecoder('gb18030').decode(buffer); } catch { return ''; }
    }
  }

  doc.addEventListener('dragover', (event) => {
    if (!modalOpen()) return;
    const stage = event.target && event.target.closest ? event.target.closest('#playerStage') : null;
    if (!stage) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, true);

  doc.addEventListener('drop', async (event) => {
    if (!modalOpen()) return;
    const stage = event.target && event.target.closest ? event.target.closest('#playerStage') : null;
    if (!stage) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    event.preventDefault();
    const api = bridge();
    if (!api || typeof api.subParse !== 'function') return;
    try {
      const text = decodeFileBytes(await file.arrayBuffer());
      const result = await api.subParse({ text });
      if (result && result.ok) await applyLocalCues(result.cues, file.name);
      else diag.errors.push('拖入字幕解析失败');
    } catch (error) { diag.errors.push('drop: ' + String((error && error.message) || error)); }
  }, true);

  doc.addEventListener('fullscreenchange', placeOverlay, true);
  doc.addEventListener('webkitfullscreenchange', placeOverlay, true);

  const observer = new MutationObserver(() => {
    if (!modalOpen()) {
      if (panel && !panel.classList.contains('is-hidden')) panel.classList.add('is-hidden');
      if (cues.length || activeTrack || tracks.length) { resetForSwitch(); currentKey = ''; currentSrc = ''; }
      return;
    }
    if (modalOpen() && watchSwitch()) return;
    const context = playContext();
    const sameContext = overlay && doc.body.contains(overlay) && cues.length && activeTrack;
    if (!overlay || !doc.body.contains(overlay)) { openFor(context); return; }
    buildButton();
    if (!sameContext && context && context.at && Number(context.at) !== Number(openFor.lastAt || 0)) {
      openFor.lastAt = Number(context.at);
      openFor(context);
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  return () => { observer.disconnect(); window.clearInterval(tickTimer); };
}

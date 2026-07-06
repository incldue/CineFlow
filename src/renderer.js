import './styles.css';

const api = window.cineflow;
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w500';
const CARD_POSTER_SIZE = 'w342';
const COMPACT_POSTER_SIZE = 'w185';
const BACKDROP_SIZE = 'w780';
const PROFILE_SIZE = 'w185';
const DETAIL_CACHE_MAX = 72;
const RAIL_CACHE_MAX = 96;
const CARD_MOVIE_CACHE_MAX = 2000;
const PREF_SAVE_DEBOUNCE_MS = 240;

const FALLBACK_GENRES = [
  { id: 28, name: '动作' },
  { id: 878, name: '科幻' },
  { id: 10749, name: '爱情' },
  { id: 9648, name: '悬疑' },
  { id: 16, name: '动画' },
  { id: 27, name: '恐怖' },
  { id: 35, name: '喜剧' },
  { id: 18, name: '剧情' },
  { id: 80, name: '犯罪' },
  { id: 14, name: '奇幻' }
];

const MOVIE_TV_GENRE_ALIASES = {
  12: [10759],
  14: [10765],
  28: [10759],
  53: [9648, 10759],
  878: [10765],
  10749: [18],
  10752: [10768],
  10759: [12, 28],
  10765: [14, 878],
  10768: [10752]
};

const SEARCH_PROMPTS = [
  '想找放松身心的电影或节目？',
  '适合一个人独处看的？',
  '适合晚上/下雨天看的？',
  '想看治愈一点的？',
  '想找节奏快一点的？',
  '适合周末窝在家看的？'
];

const PROMPT_INTENTS = [
  {
    label: '放松治愈',
    patterns: ['放松', '轻松', '解压', '开心', '治愈', '暖心', '舒服', '周末', '窝在家', '下饭', '吃饭', '快乐', '无脑', '舒服点', '喜剧', '搞笑', '幽默'],
    genreIds: [35, 16, 10751, 10749],
    genreGroups: [[35], [16, 10751], [35, 10749]],
    withoutGenreIds: [27, 53],
    sortBy: 'popularity.desc'
  },
  {
    label: '独处氛围',
    patterns: ['一个人', '独处', '孤独', '安静', '自我', '内心', '人生', 'emo', '低落', '失落', '发呆', '文艺', '剧情'],
    genreIds: [18, 10749, 16],
    genreGroups: [[18], [18, 10749], [16]],
    withoutGenreIds: [27],
    sortBy: 'vote_average.desc',
    minRating: 6.5
  },
  {
    label: '夜晚雨天',
    patterns: ['晚上', '夜晚', '深夜', '下雨', '雨天', '阴天', '失眠', '雨夜', '睡前', '夜里', '氛围'],
    genreIds: [18, 10749, 9648, 16],
    genreGroups: [[18, 10749], [18, 9648], [18], [16]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '刺激高能',
    patterns: ['刺激', '高能', '燃', '爽', '紧张', '动作', '冒险', '打斗', '速度', '爆米花', '热血'],
    genreIds: [28, 53, 12, 80],
    genreGroups: [[28], [28, 12], [28, 53]],
    sortBy: 'popularity.desc'
  },
  {
    label: '烧脑悬疑',
    patterns: ['烧脑', '悬疑', '推理', '反转', '犯罪', '谜团', '破案', '侦探', '谜案', '真相'],
    genreIds: [9648, 80, 53],
    genreGroups: [[9648], [9648, 80], [9648, 53]],
    sortBy: 'vote_average.desc',
    minRating: 6.6
  },
  {
    label: '未来想象',
    patterns: ['科幻', '未来', '赛博', '太空', '机器人', '末日', '外星', '宇宙', 'AI', '人工智能'],
    genreIds: [878, 12, 28],
    genreGroups: [[878], [878, 12], [878, 28]],
    sortBy: 'popularity.desc'
  },
  {
    label: '恐怖惊悚',
    patterns: ['恐怖', '惊悚', '吓人', '鬼', '怪物', '灵异', '胆小勿入'],
    genreIds: [27, 53, 9648],
    genreGroups: [[27], [27, 53], [27, 9648]],
    sortBy: 'popularity.desc'
  },
  {
    label: '恋爱约会',
    patterns: ['恋爱', '爱情', '浪漫', '约会', '暧昧', '心动', '情侣', '甜', '告白'],
    genreIds: [10749, 35, 18],
    genreGroups: [[10749], [10749, 35], [10749, 18]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '家庭陪伴',
    patterns: ['家庭', '亲子', '孩子', '小朋友', '全家', '温馨', '陪伴', '父母'],
    genreIds: [10751, 16, 12, 35],
    genreGroups: [[10751], [16, 10751], [10751, 12]],
    withoutGenreIds: [27, 53, 80],
    sortBy: 'popularity.desc'
  },
  {
    label: '催泪感动',
    patterns: ['催泪', '感动', '哭', '想哭', '泪点', '悲伤', '遗憾', '温柔'],
    genreIds: [18, 10749, 10751],
    genreGroups: [[18], [18, 10749], [18, 10751]],
    withoutGenreIds: [27],
    sortBy: 'vote_average.desc',
    minRating: 6.8
  },
  {
    label: '高分经典',
    patterns: ['高分', '经典', '口碑', '神作', '必看', '影史', '豆瓣'],
    genreIds: [18, 80, 9648, 878],
    genreGroups: [[18], [18, 80], [9648, 80], [878]],
    sortBy: 'vote_average.desc',
    minRating: 7.2
  }
];

const NEGATIVE_GENRE_HINTS = [
  { patterns: ['不要恐怖', '不恐怖', '别恐怖', '不吓人', '别吓人', '不要惊悚', '别惊悚'], genreIds: [27, 53] },
  { patterns: ['不要血腥', '不血腥', '别血腥', '不要暴力', '不暴力'], genreIds: [27, 53, 80] },
  { patterns: ['不要爱情', '不想看爱情', '别爱情'], genreIds: [10749] }
];

const dom = {
  appShell: document.querySelector('.app-shell'),
  statusBanner: document.querySelector('#statusBanner'),
  dailyTitle: document.querySelector('#dailyTitle'),
  dailyOverview: document.querySelector('#dailyOverview'),
  dailyMeta: document.querySelector('#dailyMeta'),
  dailyPoster: document.querySelector('#dailyPoster'),
  heroBackdrop: document.querySelector('#heroBackdrop'),
  dailyDetailBtn: document.querySelector('#dailyDetailBtn'),
  dailyLikeBtn: document.querySelector('#dailyLikeBtn'),
  searchBox: document.querySelector('.search-box'),
  globalSearch: document.querySelector('#globalSearch'),
  clearSearchBtn: document.querySelector('#clearSearchBtn'),
  islandRestoreBtn: document.querySelector('#islandRestoreBtn'),
  islandRestoreLabel: document.querySelector('#islandRestoreBtn .restore-label'),
  refreshBtn: document.querySelector('#refreshBtn'),
  settingsBtn: document.querySelector('#settingsBtn'),
  minBtn: document.querySelector('#minBtn'),
  maxBtn: document.querySelector('#maxBtn'),
  closeBtn: document.querySelector('#closeBtn'),
  islandDockHandle: document.querySelector('#islandDockHandle'),
  searchSection: document.querySelector('#searchSection'),
  searchTitle: document.querySelector('#searchTitle'),
  searchHint: document.querySelector('#searchHint'),
  searchMoreBtn: document.querySelector('#searchMoreBtn'),
  searchRail: document.querySelector('#searchRail'),
  styleRail: document.querySelector('#styleRail'),
  personalizedRail: document.querySelector('#personalizedRail'),
  personalizedMoreBtn: document.querySelector('#personalizedMoreBtn'),
  trendingRail: document.querySelector('#trendingRail'),
  trendingMoreBtn: document.querySelector('#trendingMoreBtn'),
  profileHint: document.querySelector('#profileHint'),
  detailPanel: document.querySelector('#detailPanel'),
  detailContent: document.querySelector('#detailContent'),
  detailCloseBtn: document.querySelector('#detailCloseBtn'),
  settingsModal: document.querySelector('#settingsModal'),
  settingsCloseBtn: document.querySelector('#settingsCloseBtn'),
  settingsState: document.querySelector('#settingsState'),
  apiCredentialInput: document.querySelector('#apiCredentialInput'),
  proxyInput: document.querySelector('#proxyInput'),
  resourceModeSelect: document.querySelector('#resourceModeSelect'),
  saveSettingsBtn: document.querySelector('#saveSettingsBtn'),
  testConnectionBtn: document.querySelector('#testConnectionBtn'),
  clearSettingsBtn: document.querySelector('#clearSettingsBtn'),
  closeChoiceModal: document.querySelector('#closeChoiceModal'),
  closeToIslandBtn: document.querySelector('#closeToIslandBtn'),
  exitAppBtn: document.querySelector('#exitAppBtn'),
  cancelCloseBtn: document.querySelector('#cancelCloseBtn'),
  toast: document.querySelector('#toast'),
  splash: document.querySelector('#splash'),
  splashCanvas: document.querySelector('#splashCanvas'),
  splashStatus: document.querySelector('#splashStatus'),
  playerModal: document.querySelector('#playerModal'),
  playerShell: document.querySelector('.player-shell'),
  playerTitle: document.querySelector('#playerTitle'),
  playerSource: document.querySelector('#playerSource'),
  playerMeta: document.querySelector('#playerMeta'),
  playerStage: document.querySelector('#playerStage'),
  resourcePlayer: document.querySelector('#resourcePlayer'),
  playerEpisodes: document.querySelector('#playerEpisodes'),
  playerEpisodesMeta: document.querySelector('#playerEpisodesMeta'),
  playerEpisodeList: document.querySelector('#playerEpisodeList'),
  playerLoader: document.querySelector('#playerLoader'),
  playerError: document.querySelector('#playerError'),
  playerStatus: document.querySelector('#playerStatus'),
  playerCloseBtn: document.querySelector('#playerCloseBtn'),
  playerCopyBtn: document.querySelector('#playerCopyBtn'),
  playerExternalBtn: document.querySelector('#playerExternalBtn'),
  playerStopBtn: document.querySelector('#playerStopBtn')
};

const SPLASH_MIN_DURATION = 2360;

const state = {
  genres: FALLBACK_GENRES,
  genreMap: new Map(FALLBACK_GENRES.map((genre) => [genre.id, genre.name])),
  daily: null,
  trending: [],
  popular: [],
  credential: null,
  proxy: null,
  resourceSettings: { mode: 'stable', label: '稳定优先', enabled: true },
  player: {
    open: false,
    url: '',
    originalUrl: '',
    resolvedUrl: '',
    proxiedUrl: '',
    kind: 'native',
    title: '',
    sourceName: '',
    lineName: '',
    label: '',
    format: '',
    playlistId: '',
    playlist: [],
    episodeIndex: 0,
    recoveries: 0,
    loadId: 0,
    seeking: false
  },
  searchTimer: null,
  activeSearchId: 0,
  initialRetryCount: 0,
  windowMode: 'normal',
  detailsCache: new Map(),
  detailRequests: new Map(),
  railCache: new Map(),
  railCachePending: new Map(),
  railStates: new Map(),
  cardMovies: new Map(),
  resourcePlaylists: new Map(),
  lastDetailMovieId: null,
  lastDetailMediaType: 'movie',
  lastDetailFallback: null,
  activeResourceSearchId: 0,
  islandPointer: {
    down: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    source: null,
    fromInput: false
  },
  dockEdge: null,
  islandAutoRestoreFrame: 0,
  islandDragMoveFrame: 0,
  splashStartedAt: performance.now(),
  splashHidden: false,
  prefs: loadPrefs()
};

let splashCanvasCleanup = null;
let prefsSaveTimer = 0;
let detailRippleTimer = 0;
let HlsClass = null;
let hlsLoadPromise = null;
let DashClass = null;
let dashLoadPromise = null;
let FlvClass = null;
let flvLoadPromise = null;
let playerHls = null;
let playerDash = null;
let playerFlv = null;
let playerCloseTimer = 0;
let playerPrewarmTimer = 0;
let fullscreenQualityTimer = 0;
let fullscreenQualityRampTimer = 0;
let playerSeekTimer = 0;
let playerLastSeekAt = 0;
let resourcePlaylistSeq = 0;

function imageUrl(path, size) {
  return path ? `${IMAGE_BASE}/${size}${path}` : '';
}

function yearOf(movie) {
  return (movie?.releaseDate || '').slice(0, 4) || '未知年份';
}

function mediaTypeOf(item, fallback = 'movie') {
  return String(item?.mediaType || item?.media_type || fallback || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
}

function mediaLabelOf(item) {
  return mediaTypeOf(item) === 'tv' ? '节目' : '电影';
}

function mediaDetailLabelOf(item) {
  return mediaTypeOf(item) === 'tv' ? '节目详情' : '电影详情';
}

function mediaSearchLabelOf(item) {
  return mediaTypeOf(item) === 'tv' ? '节目资源' : '电影资源';
}

function contentKeyOf(itemOrId, fallbackMediaType = 'movie') {
  if (typeof itemOrId === 'object' && itemOrId) {
    return `${mediaTypeOf(itemOrId, fallbackMediaType)}:${itemOrId.id || ''}`;
  }
  return `${mediaTypeOf({ mediaType: fallbackMediaType })}:${itemOrId || ''}`;
}

function scoreOf(movie) {
  const score = Number(movie?.voteAverage || 0);
  return score ? score.toFixed(1) : '暂无';
}

function movieGenres(movie, limit = 3) {
  const ids = movie?.genreIds || [];
  return ids
    .map((id) => state.genreMap.get(id))
    .filter(Boolean)
    .slice(0, limit);
}

function safeText(value, fallback = '') {
  return String(value || fallback);
}

function rememberMapValue(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  map.set(key, value);
  return value;
}

function detailCacheKey(movieId, mediaType = 'movie') {
  return contentKeyOf(movieId, mediaType);
}

function cacheMovieDetails(movieId, mediaType, details) {
  return rememberMapValue(state.detailsCache, detailCacheKey(movieId, mediaType), details, DETAIL_CACHE_MAX);
}

function rememberCardMovie(movie) {
  if (!movie?.id) return;
  rememberMapValue(state.cardMovies, contentKeyOf(movie), movie, CARD_MOVIE_CACHE_MAX);
}

function loadPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem('cineflow:prefs') || '{}');
    return {
      genreWeights: parsed.genreWeights || {},
      likedMovieIds: parsed.likedMovieIds || [],
      recentSearches: parsed.recentSearches || [],
      clickedMovieIds: parsed.clickedMovieIds || []
    };
  } catch {
    return {
      genreWeights: {},
      likedMovieIds: [],
      recentSearches: [],
      clickedMovieIds: []
    };
  }
}

function savePrefs(options = {}) {
  clearTimeout(prefsSaveTimer);
  if (options.immediate) {
    localStorage.setItem('cineflow:prefs', JSON.stringify(state.prefs));
    return;
  }
  prefsSaveTimer = setTimeout(() => {
    localStorage.setItem('cineflow:prefs', JSON.stringify(state.prefs));
    prefsSaveTimer = 0;
  }, PREF_SAVE_DEBOUNCE_MS);
}

function addGenreWeight(genreIds = [], weight = 1) {
  for (const id of genreIds) {
    state.prefs.genreWeights[id] = (state.prefs.genreWeights[id] || 0) + weight;
  }
  savePrefs();
}

function addRecentSearch(query) {
  const clean = String(query || '').trim();
  if (!clean) return;
  state.prefs.recentSearches = [
    clean,
    ...state.prefs.recentSearches.filter((item) => item !== clean)
  ].slice(0, 8);
  savePrefs();
}

function addClickedMovie(movie) {
  if (!movie?.id) return;
  const key = contentKeyOf(movie);
  state.prefs.clickedMovieIds = [
    key,
    ...state.prefs.clickedMovieIds.filter((id) => id !== key)
  ].slice(0, 20);
  addGenreWeight(movie.genreIds, 0.8);
}

function likeMovie(movie) {
  if (!movie?.id) return;
  const key = contentKeyOf(movie);
  state.prefs.likedMovieIds = [
    key,
    ...state.prefs.likedMovieIds.filter((id) => id !== key)
  ].slice(0, 50);
  addGenreWeight(movie.genreIds, 2.5);
  toast('已加入你的偏好');
  renderPersonalized();
}

function preloadDetails(movieId, mediaType = 'movie') {
  const key = detailCacheKey(movieId, mediaType);
  if (!key || state.detailsCache.has(key) || state.detailRequests.has(key)) return;
  if (state.detailRequests.size >= 2) return;

  const schedule = window.requestIdleCallback
    ? (callback) => window.requestIdleCallback(callback, { timeout: 900 })
    : (callback) => window.setTimeout(callback, 120);

  schedule(() => {
    if (state.detailsCache.has(key) || state.detailRequests.has(key)) return;
    getMovieDetails(movieId, mediaType).catch(() => {});
  });
}

async function getMovieDetails(movieId, mediaType = 'movie') {
  const normalizedMediaType = mediaTypeOf({ mediaType });
  const key = detailCacheKey(movieId, normalizedMediaType);
  if (!key) return null;
  if (state.detailsCache.has(key)) return state.detailsCache.get(key);
  if (state.detailRequests.has(key)) return state.detailRequests.get(key);

  const request = api.getMovieDetails(movieId, { mediaType: normalizedMediaType })
    .then((details) => cacheMovieDetails(movieId, normalizedMediaType, details))
    .finally(() => state.detailRequests.delete(key));

  state.detailRequests.set(key, request);
  return request;
}

function topGenreIds(limit = 3) {
  return Object.entries(state.prefs.genreWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => Number(id))
    .filter(Boolean)
    .slice(0, limit);
}

function setBanner(message, type = 'info') {
  if (!message) {
    dom.statusBanner.classList.add('is-hidden');
    dom.statusBanner.textContent = '';
    return;
  }
  dom.statusBanner.textContent = message;
  dom.statusBanner.dataset.type = type;
  dom.statusBanner.classList.remove('is-hidden');
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.remove('is-hidden');
  toastTimer = setTimeout(() => dom.toast.classList.add('is-hidden'), 2400);
}

function setSplashStatus(message) {
  if (!dom.splashStatus || !message) return;
  dom.splashStatus.textContent = message;
}

function splashClamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function splashEaseOutCubic(value) {
  const t = splashClamp01(value);
  return 1 - Math.pow(1 - t, 3);
}

function splashSmoothstep(edge0, edge1, value) {
  const t = splashClamp01((value - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

function initStartupSplashCanvas() {
  if (!dom.splash || !dom.splashCanvas) return;

  if (splashCanvasCleanup) {
    splashCanvasCleanup();
    splashCanvasCleanup = null;
  }

  const canvas = dom.splashCanvas;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const streakColors = [
    'rgba(218,226,255,',
    'rgba(158,142,255,',
    'rgba(78,150,255,',
    'rgba(112,92,190,'
  ];

  let disposed = false;
  let frameId = 0;
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let dust = [];
  let streaks = [];
  let shards = [];

  const resize = () => {
    if (disposed || !dom.splash) return;

    const rect = dom.splash.getBoundingClientRect();
    width = Math.max(1, rect.width || window.innerWidth || 1);
    height = Math.max(1, rect.height || window.innerHeight || 1);
    pixelRatio = Math.min(reducedMotion ? 1.05 : 1.35, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    dust = Array.from({ length: reducedMotion ? 18 : 52 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.11,
      r: Math.random() * 1.25 + 0.24,
      a: Math.random() * 0.095 + 0.018,
      phase: Math.random() * Math.PI * 2
    }));

    streaks = Array.from({ length: reducedMotion ? 4 : 14 }, (_, index) => ({
      x: Math.random() * width,
      y: height * (0.20 + Math.random() * 0.62),
      len: width * (0.12 + Math.random() * 0.25),
      width: 0.65 + Math.random() * 2.05,
      speed: width * (0.00030 + Math.random() * 0.00046),
      angle: (-10 + Math.random() * 20) * Math.PI / 180,
      phase: Math.random() * Math.PI * 2,
      color: streakColors[index % streakColors.length],
      delay: Math.random() * 0.52,
      alpha: 0.15 + Math.random() * 0.31
    }));

    shards = Array.from({ length: reducedMotion ? 6 : 22 }, (_, index) => ({
      ox: (Math.random() - 0.5) * width * 0.90,
      oy: (Math.random() - 0.5) * height * 0.22,
      w: 16 + Math.random() * 78,
      h: 1 + Math.random() * 4.5,
      skew: (Math.random() - 0.5) * 18,
      phase: Math.random() * Math.PI * 2,
      color: streakColors[index % streakColors.length],
      alpha: 0.07 + Math.random() * 0.20
    }));
  };

  const draw = (now) => {
    if (disposed || !canvas.isConnected) return;

    const elapsed = (now - state.splashStartedAt) / 1000;
    ctx.clearRect(0, 0, width, height);

    const base = ctx.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, 'rgba(3,4,12,0.72)');
    base.addColorStop(0.46, 'rgba(10,10,22,0.74)');
    base.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.17;
    ctx.fillStyle = 'rgba(218,226,255,0.027)';
    const scanOffset = (elapsed * 28) % 36;
    for (let y = -scanOffset; y < height; y += 36) {
      ctx.fillRect(0, y, width, 1);
    }
    ctx.restore();

    for (const particle of dust) {
      if (!reducedMotion) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.phase += 0.018;
      }
      if (particle.x < -10) particle.x = width + 10;
      if (particle.x > width + 10) particle.x = -10;
      if (particle.y < -10) particle.y = height + 10;
      if (particle.y > height + 10) particle.y = -10;
      const alpha = particle.a * (0.58 + Math.sin(particle.phase + elapsed * 0.8) * 0.34);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, alpha).toFixed(3)})`;
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const streak of streaks) {
      const travel = (elapsed * streak.speed * 240 + streak.x + Math.sin(elapsed * 0.8 + streak.phase) * 28)
        % (width + streak.len + 180);
      const x = travel - streak.len - 90;
      const y = streak.y + Math.sin(elapsed * 0.75 + streak.phase) * 18;
      const fade = splashSmoothstep(streak.delay * 0.55, streak.delay * 0.55 + 0.48, elapsed)
        * (1 - splashSmoothstep(2.20, 2.70, elapsed));
      if (fade <= 0) continue;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(streak.angle);
      const streakGradient = ctx.createLinearGradient(-streak.len * 0.5, 0, streak.len * 0.5, 0);
      streakGradient.addColorStop(0, `${streak.color}0)`);
      streakGradient.addColorStop(0.52, `${streak.color}${(streak.alpha * fade).toFixed(3)})`);
      streakGradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = streakGradient;
      ctx.lineWidth = streak.width;
      ctx.shadowColor = `${streak.color}${(0.32 * fade).toFixed(3)})`;
      ctx.shadowBlur = 17;
      ctx.beginPath();
      ctx.moveTo(-streak.len * 0.5, 0);
      ctx.lineTo(streak.len * 0.5, 0);
      ctx.stroke();
      ctx.restore();
    }

    const lineT = splashEaseOutCubic((elapsed - 0.08) / 0.92);
    const exitFade = 1 - splashSmoothstep(2.10, 2.70, elapsed);
    if (lineT > 0 && exitFade > 0) {
      const centerY = height * 0.5 + Math.sin(elapsed * 1.4) * 1.6;
      const slitW = width * (0.16 + lineT * 0.72);
      const left = width * 0.5 - slitW * 0.5;
      const right = width * 0.5 + slitW * 0.5;
      const coreAlpha = (0.32 + lineT * 0.54) * exitFade;
      const slitGradient = ctx.createLinearGradient(left, centerY, right, centerY);
      slitGradient.addColorStop(0, 'rgba(78,150,255,0)');
      slitGradient.addColorStop(0.18, `rgba(78,150,255,${(0.17 * exitFade).toFixed(3)})`);
      slitGradient.addColorStop(0.50, `rgba(255,255,255,${coreAlpha.toFixed(3)})`);
      slitGradient.addColorStop(0.68, `rgba(218,226,255,${(0.36 * exitFade).toFixed(3)})`);
      slitGradient.addColorStop(0.84, `rgba(158,142,255,${(0.18 * exitFade).toFixed(3)})`);
      slitGradient.addColorStop(1, 'rgba(158,142,255,0)');

      ctx.shadowColor = `rgba(218,226,255,${(0.45 * exitFade).toFixed(3)})`;
      ctx.shadowBlur = 38 + lineT * 38;
      ctx.lineCap = 'round';
      ctx.strokeStyle = slitGradient;
      ctx.lineWidth = 1.4 + lineT * 2.2;
      ctx.beginPath();
      ctx.moveTo(left, centerY);
      ctx.lineTo(right, centerY);
      ctx.stroke();

      const ignition = Math.exp(-Math.pow((elapsed - 0.58) / 0.24, 2));
      if (ignition > 0.018) {
        const ignitionGradient = ctx.createLinearGradient(0, centerY, width, centerY);
        ignitionGradient.addColorStop(0, 'rgba(158,142,255,0)');
        ignitionGradient.addColorStop(0.46, `rgba(158,142,255,${(0.064 * ignition).toFixed(3)})`);
        ignitionGradient.addColorStop(0.50, `rgba(255,255,255,${(0.15 * ignition).toFixed(3)})`);
        ignitionGradient.addColorStop(0.54, `rgba(78,150,255,${(0.074 * ignition).toFixed(3)})`);
        ignitionGradient.addColorStop(1, 'rgba(218,226,255,0)');
        ctx.fillStyle = ignitionGradient;
        ctx.fillRect(0, centerY - 48 * ignition, width, 96 * ignition);
      }

      const waveAlpha = splashSmoothstep(0.45, 1.55, elapsed) * exitFade;
      if (waveAlpha > 0) {
        ctx.shadowBlur = 18;
        ctx.strokeStyle = `rgba(218,226,255,${(0.20 * waveAlpha).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const steps = 76;
        for (let i = 0; i <= steps; i += 1) {
          const u = i / steps;
          const x = left + slitW * u;
          const edge = 1 - Math.abs(u - 0.5) * 2;
          const amp = (4 + 18 * lineT) * Math.pow(Math.max(0, edge), 1.4) * waveAlpha;
          const y = centerY + Math.sin(u * 34 + elapsed * 8.2) * amp + Math.sin(u * 87 - elapsed * 5.1) * amp * 0.18;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      const shardT = splashSmoothstep(0.42, 1.75, elapsed) * exitFade;
      for (const shard of shards) {
        const drift = Math.sin(elapsed * 1.7 + shard.phase) * 22;
        const x = width * 0.5 + shard.ox * (0.18 + shardT * 0.82) + drift;
        const y = centerY + shard.oy * (0.20 + shardT * 0.92);
        const localAlpha = shard.alpha * shardT * (0.62 + Math.sin(elapsed * 5 + shard.phase) * 0.38);
        if (localAlpha <= 0) continue;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((-6 + shard.skew * 0.10) * Math.PI / 180);
        ctx.fillStyle = `${shard.color}${Math.max(0, localAlpha).toFixed(3)})`;
        ctx.shadowColor = `${shard.color}${Math.min(0.36, localAlpha * 1.12).toFixed(3)})`;
        ctx.shadowBlur = 13;
        ctx.beginPath();
        ctx.moveTo(-shard.w * 0.5, -shard.h * 0.5);
        ctx.lineTo(shard.w * 0.5, -shard.h * 0.5);
        ctx.lineTo(shard.w * 0.5 + shard.skew, shard.h * 0.5);
        ctx.lineTo(-shard.w * 0.5 + shard.skew, shard.h * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      const flash = Math.exp(-Math.pow((elapsed - 1.08) / 0.32, 2));
      if (flash > 0.015) {
        const flashGradient = ctx.createLinearGradient(0, centerY, width, centerY);
        flashGradient.addColorStop(0, 'rgba(78,150,255,0)');
        flashGradient.addColorStop(0.48, `rgba(255,255,255,${(0.17 * flash).toFixed(3)})`);
        flashGradient.addColorStop(0.52, `rgba(218,226,255,${(0.20 * flash).toFixed(3)})`);
        flashGradient.addColorStop(1, 'rgba(158,142,255,0)');
        ctx.fillStyle = flashGradient;
        ctx.fillRect(0, centerY - 42 * flash, width, 84 * flash);
      }
    }

    ctx.restore();

    if (!reducedMotion || elapsed < 0.9 || dom.splash?.classList.contains('exiting')) {
      frameId = window.requestAnimationFrame(draw);
    }
  };

  resize();
  window.addEventListener('resize', resize);
  frameId = window.requestAnimationFrame(draw);

  splashCanvasCleanup = () => {
    disposed = true;
    window.removeEventListener('resize', resize);
    if (frameId) window.cancelAnimationFrame(frameId);
    ctx.clearRect(0, 0, width, height);
  };
}

function disposeStartupSplashCanvas() {
  if (!splashCanvasCleanup) return;
  splashCanvasCleanup();
  splashCanvasCleanup = null;
}

function hideStartupSplash() {
  if (!dom.splash || state.splashHidden) return;
  state.splashHidden = true;
  setSplashStatus('正在进入 CineFlow');
  dom.splash.classList.add('ready');

  const elapsed = performance.now() - state.splashStartedAt;
  const delay = Math.max(0, SPLASH_MIN_DURATION - elapsed);

  window.setTimeout(() => {
    document.body.classList.add('splash-revealing');
    dom.splash.classList.add('exiting');

    window.setTimeout(() => {
      disposeStartupSplashCanvas();
      dom.splash?.remove();
      document.body.classList.remove('splash-active', 'splash-revealing');
    }, 980);
  }, delay);
}

function showRailLoading(rail, count = 8) {
  hideMoreButtonForRail(rail);
  rail.innerHTML = Array.from({ length: count })
    .map(() => '<article class="movie-card skeleton"><div></div><span></span><small></small></article>')
    .join('');
}

function showRailEmpty(rail, message) {
  hideMoreButtonForRail(rail);
  rail.innerHTML = `<div class="empty-state">${message}</div>`;
}

function hideMoreButtonForRail(rail) {
  const button = rail === dom.searchRail
    ? dom.searchMoreBtn
    : rail === dom.personalizedRail
      ? dom.personalizedMoreBtn
      : rail === dom.trendingRail
        ? dom.trendingMoreBtn
        : null;
  if (button) button.hidden = true;
}

function appendMoviesToRail(rail, movies, options = {}) {
  const fragment = document.createDocumentFragment();
  for (const movie of movies) {
    fragment.appendChild(createMovieCard(movie, options));
  }
  rail.appendChild(fragment);
}

function createMovieCard(movie, { compact = false } = {}) {
  const card = document.createElement('article');
  card.className = compact ? 'movie-card compact' : 'movie-card';
  card.tabIndex = 0;
  card.dataset.movieId = movie.id;
  card.dataset.mediaType = mediaTypeOf(movie);
  card.dataset.contentKey = contentKeyOf(movie);
  rememberCardMovie(movie);

  const poster = imageUrl(movie.posterPath, compact ? COMPACT_POSTER_SIZE : CARD_POSTER_SIZE);
  const genreLabel = movieGenres(movie).join(' · ');
  card.innerHTML = `
    <div class="poster-frame">
      ${poster ? `<img src="${poster}" alt="${escapeHtml(movie.title)} 海报" loading="lazy" decoding="async" />` : '<div class="poster-fallback">No Poster</div>'}
      <div class="score-pill">★ ${scoreOf(movie)} · ${mediaLabelOf(movie)}</div>
    </div>
    <h3>${escapeHtml(movie.title)}</h3>
    <p>${escapeHtml([yearOf(movie), genreLabel].filter(Boolean).join(' · '))}</p>
  `;
  return card;
}

function renderMovieRail(rail, movies, options = {}) {
  rail.innerHTML = '';
  rail.classList.remove('is-expanded');
  if (options.stateKey) {
    if (String(options.stateKey).startsWith('search:')) {
      for (const key of state.railStates.keys()) {
        if (String(key).startsWith('search:') && key !== options.stateKey) {
          state.railStates.delete(key);
        }
      }
    }
    state.railStates.set(options.stateKey, {
      rail,
      movies: uniqueMovies(movies || []),
      options: { ...options },
      loadMore: options.loadMore,
      page: options.initialPage || 1,
      hasMore: options.hasMore !== false,
      loading: false,
      autoBound: false
    });
  }
  if (!movies?.length) {
    showRailEmpty(rail, options.empty || '暂时没有找到合适的电影或节目。');
    setupRailMore(options.moreButton, rail, 0, options.stateKey);
    return;
  }
  appendMoviesToRail(rail, movies, options);
  setupRailMore(options.moreButton, rail, movies.length, options.stateKey);
}

function setupRailMore(button, rail, itemCount, stateKey) {
  if (!button) return;
  const railState = stateKey ? state.railStates.get(stateKey) : null;
  const canExpand = itemCount > 0 && (itemCount > 6 || Boolean(railState?.loadMore));
  button.hidden = !canExpand;
  button.disabled = false;
  button.classList.remove('is-expanded');
  button.textContent = '加载更多';
  button.onclick = () => toggleRailMore(button, rail, stateKey);
  button.title = '展开后向下滚动会自动加载更多电影/节目';
}

async function toggleRailMore(button, rail, stateKey) {
  const isExpanded = rail.classList.contains('is-expanded');
  if (isExpanded) {
    collapseRail(button, rail);
    return;
  }
  expandRail(button, rail, stateKey);
  await loadMoreRail(stateKey, button);
}

function expandRail(button, rail, stateKey) {
  rail.classList.add('is-expanded');
  button.classList.add('is-expanded');
  button.textContent = '收起';
  button.title = '点击收起，向下滚动自动加载更多';
  const railState = stateKey ? state.railStates.get(stateKey) : null;
  if (railState && !railState.autoBound) {
    railState.autoBound = true;
    rail.addEventListener('scroll', () => maybeAutoLoadMore(stateKey, button), { passive: true });
    rail.addEventListener('wheel', () => setTimeout(() => maybeAutoLoadMore(stateKey, button), 80), { passive: true });
  }
}

function collapseRail(button, rail) {
  rail.classList.remove('is-expanded');
  button.classList.remove('is-expanded');
  button.disabled = false;
  button.textContent = '加载更多';
  button.title = '展开后向下滚动会自动加载更多电影/节目';
  rail.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  rail.closest('.content-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function scheduleScrollToInputRecommendations() {
  if (!dom.searchSection || dom.searchSection.classList.contains('is-hidden')) return;

  const scrollOnce = (behavior = 'auto') => {
    if (!dom.searchSection || dom.searchSection.classList.contains('is-hidden')) return;
    const top = Math.max(0, dom.searchSection.offsetTop - 18);
    if (dom.appShell) {
      dom.appShell.scrollTo({ top, behavior });
      return;
    }
    dom.searchSection.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
  };

  requestAnimationFrame(() => scrollOnce('auto'));
  window.setTimeout(() => scrollOnce('smooth'), 160);
  window.setTimeout(() => scrollOnce('smooth'), 420);
}

function restoreNormalAndFocusInputRecommendations() {
  restoreNormalFromIsland({ focusInputRecommendations: true });
}

function isIslandLikeMode(mode = state.windowMode) {
  return mode === 'island' || mode === 'island-expanded' || mode === 'island-docked';
}

function setWindowRestoringState(active) {
  for (const target of [document.documentElement, document.body]) {
    target.classList.toggle('is-window-restoring', active);
  }
}

function syncIslandRestoreButtonState(options = {}) {
  if (!dom.islandRestoreBtn) return;
  const mode = options.mode || state.windowMode;
  const isVisibleIsland = mode === 'island' || mode === 'island-expanded';
  const hasQuery = Boolean(dom.globalSearch?.value.trim());
  const compact = mode === 'island-expanded' && hasQuery;
  const label = mode === 'island-expanded' ? '回主窗' : '展开';
  const title = mode === 'island-expanded'
    ? '恢复主窗口并定位到当前推荐'
    : '展开回 CineFlow 主窗口';

  dom.islandRestoreBtn.dataset.mode = mode;
  dom.islandRestoreBtn.classList.toggle('is-visible', isVisibleIsland);
  dom.islandRestoreBtn.classList.toggle('is-compact', compact);
  dom.islandRestoreBtn.classList.toggle('is-restoring', Boolean(options.restoring));
  if (dom.islandRestoreLabel) {
    dom.islandRestoreLabel.textContent = options.restoring ? '展开中' : label;
  }
  dom.islandRestoreBtn.title = title;
  dom.islandRestoreBtn.setAttribute('aria-label', title);
}

function restoreNormalFromIsland(options = {}) {
  if (!isIslandLikeMode()) return;
  const shouldFocusInputRecommendations = Boolean(options.focusInputRecommendations);

  setWindowRestoringState(true);
  syncIslandRestoreButtonState({ restoring: true });
  window.setTimeout(() => {
    setWindowRestoringState(false);
    syncIslandRestoreButtonState();
  }, 620);

  api.restoreNormal();
  applyWindowMode({ mode: 'normal' });
  if (shouldFocusInputRecommendations) {
    scheduleScrollToInputRecommendations();
  }
}

function maybeAutoLoadMore(stateKey, button) {
  const railState = stateKey ? state.railStates.get(stateKey) : null;
  if (!railState || !railState.rail.classList.contains('is-expanded')) return;
  if (railState.loading || railState.hasMore === false) return;
  const remaining = railState.rail.scrollHeight - railState.rail.scrollTop - railState.rail.clientHeight;
  if (remaining < 420) {
    if (state.windowMode === 'island-expanded') {
      restoreNormalAndFocusInputRecommendations();
    }
    loadMoreRail(stateKey, button);
  }
}

async function loadMoreRail(stateKey, button) {
  const railState = stateKey ? state.railStates.get(stateKey) : null;
  if (!railState?.loadMore || railState.loading || railState.hasMore === false) {
    if (button && railState?.hasMore === false) {
      button.textContent = railState.rail?.classList.contains('is-expanded') ? '收起' : '加载更多';
      button.disabled = false;
    }
    return;
  }
  railState.loading = true;
  const oldText = button?.textContent;
  if (button) {
    button.disabled = false;
    button.textContent = '加载中...';
  }
  try {
    const nextPage = railState.page + 1;
    const nextMovies = await railState.loadMore(nextPage, railState);
    const merged = uniqueMovies([...(railState.movies || []), ...(nextMovies || [])]);
    const newMovies = merged.slice(railState.movies.length);
    railState.movies = merged;
    railState.page = nextPage;
    if (newMovies.length) appendMoviesToRail(railState.rail, newMovies, railState.options);
    if (!newMovies.length || nextMovies?.length < 18) {
      railState.hasMore = false;
      if (!newMovies.length) toast('已全部显示');
    }
    if (button) {
      button.textContent = railState.rail.classList.contains('is-expanded') ? '收起' : '加载更多';
    }
  } catch (error) {
    toast(readableError(error));
    if (button) {
      button.textContent = railState.rail.classList.contains('is-expanded') ? (oldText || '收起') : '加载更多';
    }
  } finally {
    railState.loading = false;
    if (button) button.disabled = false;
  }
}

function renderHero(movie) {
  state.daily = movie;
  if (!movie) {
    dom.dailyTitle.textContent = '还没有拿到今日推荐';
    dom.dailyOverview.textContent = '请检查 TMDB 密钥或网络连接。';
    dom.dailyMeta.innerHTML = '';
    dom.dailyPoster.textContent = 'CineFlow';
    dom.dailyPoster.className = 'hero-poster poster-placeholder';
    dom.heroBackdrop.style.backgroundImage = '';
    return;
  }

  dom.dailyTitle.textContent = movie.title;
  dom.dailyOverview.textContent = movie.overview || `这部${mediaLabelOf(movie)}暂时没有中文简介，但它已经进入今天的推荐片单。`;
  dom.dailyMeta.innerHTML = `
    <span>★ ${scoreOf(movie)}</span>
    <span>${yearOf(movie)}</span>
    ${movieGenres(movie).map((genre) => `<span>${escapeHtml(genre)}</span>`).join('')}
  `;

  const poster = imageUrl(movie.posterPath, POSTER_SIZE);
  const backdrop = imageUrl(movie.backdropPath, BACKDROP_SIZE);
  dom.dailyPoster.className = poster ? 'hero-poster' : 'hero-poster poster-placeholder';
  dom.dailyPoster.innerHTML = poster ? `<img src="${poster}" alt="${escapeHtml(movie.title)} 海报" decoding="async" fetchpriority="high" />` : 'CineFlow';
  dom.heroBackdrop.style.backgroundImage = backdrop ? `url("${backdrop}")` : '';
}

function renderStyles() {
  const picked = [...state.genres]
    .sort((a, b) => styleOrder(a.name) - styleOrder(b.name))
    .slice(0, 14);

  dom.styleRail.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const genre of picked) {
    const item = document.createElement('button');
    item.className = 'style-chip';
    item.type = 'button';
    item.innerHTML = `
      <span>${escapeHtml(genre.name)}</span>
      <small>${styleSubtitle(genre.name)}</small>
    `;
    item.addEventListener('click', async () => {
      addGenreWeight([genre.id], 1.2);
      await showGenreSearch(genre);
      renderPersonalized();
    });
    fragment.appendChild(item);
  }
  dom.styleRail.appendChild(fragment);
}

function styleOrder(name) {
  const order = ['动作', '科幻', '爱情', '悬疑', '动画', '恐怖', '喜剧', '剧情', '犯罪', '奇幻', '冒险', '纪录'];
  const index = order.findIndex((item) => name.includes(item));
  return index === -1 ? 99 : index;
}

function styleSubtitle(name) {
  if (name.includes('动作')) return '高能节奏';
  if (name.includes('科幻')) return '未来想象';
  if (name.includes('爱情')) return '温柔心动';
  if (name.includes('悬疑')) return '反转推理';
  if (name.includes('动画')) return '治愈幻想';
  if (name.includes('恐怖')) return '暗夜惊悚';
  if (name.includes('喜剧')) return '轻松解压';
  if (name.includes('剧情')) return '人物故事';
  if (name.includes('犯罪')) return '灰色边界';
  if (name.includes('奇幻')) return '异世界';
  return '探索更多';
}

async function showGenreSearch(genre) {
  dom.searchSection.classList.remove('is-hidden');
  dom.searchTitle.textContent = `${genre.name}电影/节目推荐`;
  dom.searchHint.textContent = '来自 TMDB Discover';
  showRailLoading(dom.searchRail, 8);
  try {
    const cacheKey = `genre:${genre.id}`;
    const movies = await cachedRail(cacheKey, () => api.discoverMovies({ genreId: genre.id, sortBy: 'popularity.desc', page: 1 }));
    renderMovieRail(dom.searchRail, movies, {
      empty: `暂时没有找到 ${genre.name} 类型电影或节目。`,
      moreButton: dom.searchMoreBtn,
      stateKey: `search:genre:${genre.id}`,
      loadMore: (page) => api.discoverMovies({ genreId: genre.id, sortBy: 'popularity.desc', page })
    });
  } catch (error) {
    showRailEmpty(dom.searchRail, readableError(error));
  }
}

async function renderPersonalized() {
  showRailLoading(dom.personalizedRail, 8);
  const genreIds = topGenreIds(3);
  try {
    let movies = [];
    let stateKey = 'personal:popular';
    let loadMore = (page) => api.discoverMovies({ sortBy: 'popularity.desc', minVotes: 120, page });
    if (genreIds.length) {
      dom.profileHint.textContent = `偏好：${genreIds.map((id) => state.genreMap.get(id)).filter(Boolean).join(' · ')}`;
      stateKey = `personal:${genreIds.join(',')}`;
      const groups = await Promise.all(
        genreIds.map((genreId) => cachedRail(`personal:${genreId}`, () => api.discoverMovies({
          genreId,
          sortBy: 'vote_average.desc',
          minVotes: 200
        })))
      );
      movies = uniqueMovies(groups.flat()).slice(0, 24);
      loadMore = async (page) => {
        const nextGroups = await Promise.all(
          genreIds.map((genreId) => api.discoverMovies({
          genreId,
          sortBy: 'vote_average.desc',
          minVotes: 200,
          page
        }).catch(() => []))
      );
      return uniqueMovies(nextGroups.flat());
      };
    } else if (state.daily?.id) {
      dom.profileHint.textContent = '还没有偏好记录，先从今日推荐延展';
      const dailyMediaType = mediaTypeOf(state.daily);
      stateKey = `personal:recommend:${dailyMediaType}:${state.daily.id}`;
      movies = await cachedRail(`recommend:${dailyMediaType}:${state.daily.id}`, () => api.recommendByMovie(state.daily.id, { mediaType: dailyMediaType }));
      if (!movies.length) movies = state.popular;
      loadMore = async (page) => {
        const recommended = await api.recommendByMovie(state.daily.id, { mediaType: dailyMediaType, page }).catch(() => []);
        if (recommended.length) return recommended;
        return api.discoverMovies({ sortBy: 'popularity.desc', minVotes: 120, page });
      };
    } else {
      dom.profileHint.textContent = '还没有偏好记录，先展示热门电影/节目';
      movies = state.popular;
    }
    renderMovieRail(dom.personalizedRail, movies, {
      empty: '多点击或收藏几部电影/节目后，这里会更懂你。',
      moreButton: dom.personalizedMoreBtn,
      stateKey,
      loadMore
    });
  } catch (error) {
    renderMovieRail(dom.personalizedRail, state.popular, {
      empty: readableError(error),
      moreButton: dom.personalizedMoreBtn,
      stateKey: 'personal:fallback',
      loadMore: (page) => api.discoverMovies({ sortBy: 'popularity.desc', minVotes: 120, page })
    });
  }
}

function renderTrending() {
  renderMovieRail(dom.trendingRail, uniqueMovies([...state.trending, ...state.popular]).slice(0, 24), {
    moreButton: dom.trendingMoreBtn,
    stateKey: 'trending',
    loadMore: async (page) => {
      const [popular, rated] = await Promise.all([
        api.discoverMovies({ sortBy: 'popularity.desc', minVotes: 120, page }).catch(() => []),
        api.discoverMovies({ sortBy: 'vote_average.desc', minVotes: 300, page }).catch(() => [])
      ]);
      return uniqueMovies([...popular, ...rated]);
    }
  });
}

async function cachedRail(key, loader) {
  if (state.railCache.has(key)) return state.railCache.get(key);
  if (state.railCachePending.has(key)) return state.railCachePending.get(key);

  const request = Promise.resolve()
    .then(loader)
    .then((movies) => {
      const value = Array.isArray(movies) ? movies : [];
      rememberMapValue(state.railCache, key, value, RAIL_CACHE_MAX);
      return value;
    })
    .finally(() => state.railCachePending.delete(key));

  state.railCachePending.set(key, request);
  return request;
}

function uniqueMovies(movies = []) {
  const seen = new Set();
  return movies.filter((movie) => {
    const key = contentKeyOf(movie);
    if (!movie?.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadInitial() {
  if (state.initialRetryCount === 0) {
    setSplashStatus('正在装载今日片单');
    setBanner('');
    showRailLoading(dom.personalizedRail, 8);
    showRailLoading(dom.trendingRail, 8);
  }
  renderStyles();

  try {
    const data = await api.getInitialData();
    setSplashStatus('正在点亮推荐流');
    state.credential = data.credential;
    state.resourceSettings = data.credential?.resources || state.resourceSettings;
    state.genres = data.genres?.length ? data.genres : FALLBACK_GENRES;
    state.genreMap = new Map(state.genres.map((genre) => [genre.id, genre.name]));
    state.trending = data.trending || [];
    state.popular = data.popular || [];
    renderHero(data.daily);
    renderStyles();
    renderTrending();
    renderPersonalized();
    state.proxy = data.credential?.proxy || null;
    updateSettingsState(data.credential);
    if (!state.trending.length && !state.popular.length && state.initialRetryCount < 2) {
      state.initialRetryCount += 1;
      setBanner('正在后台继续加载 TMDB 推荐，界面已先启动。', 'info');
      setTimeout(() => loadInitial(), 1800);
    } else {
      state.initialRetryCount = 0;
    }
  } catch (error) {
    setSplashStatus('进入本机配置模式');
    renderHero(null);
    showRailEmpty(dom.personalizedRail, readableError(error));
    showRailEmpty(dom.trendingRail, '配置 TMDB 后即可加载热门电影/节目。');
    if (error?.code === 'MISSING_TMDB_CREDENTIAL' || readableError(error).includes('credential')) {
      setBanner('请先配置 TMDB API Key 或 Read Access Token，配置后会自动加载每日推荐。', 'warn');
      openSettings();
    } else {
      setBanner(readableError(error), 'error');
    }
  } finally {
    hideStartupSplash();
  }
}

function updateSettingsState(credential) {
  const current = credential || state.credential;
  const proxy = current?.proxy || state.proxy || { mode: 'system', value: 'system' };
  state.proxy = proxy;
  if (dom.proxyInput) dom.proxyInput.value = proxy.value || 'system';
  const resources = current?.resources || state.resourceSettings || { mode: 'stable', label: '稳定优先', enabled: true };
  state.resourceSettings = resources;
  renderResourceModeOptions(resources);
  if (dom.resourceModeSelect) dom.resourceModeSelect.value = resources.mode || 'stable';
  const proxyLabel = proxy.mode === 'system'
    ? '系统代理'
    : proxy.mode === 'direct'
      ? '直连'
      : proxy.mode === 'auto_detect'
        ? '自动检测'
        : proxy.value;
  if (current?.configured) {
    dom.settingsState.innerHTML = `当前已配置：<strong>${current.type === 'readToken' ? 'Read Access Token' : 'API Key'}</strong> <span>${escapeHtml(current.preview || '')}</span> <em>${escapeHtml(current.source || '')}</em><br/>代理：<strong>${escapeHtml(proxyLabel || 'system')}</strong><br/>介绍页资源：<strong>${escapeHtml(resources.label || '稳定优先')}</strong>`;
  } else {
    dom.settingsState.innerHTML = `当前未配置 TMDB 密钥。<br/>代理：<strong>${escapeHtml(proxyLabel || 'system')}</strong><br/>介绍页资源：<strong>${escapeHtml(resources.label || '稳定优先')}</strong>`;
  }
}

function renderResourceModeOptions(resources = state.resourceSettings) {
  if (!dom.resourceModeSelect || dom.resourceModeSelect.dataset.synced === '1') return;
  const modes = Array.isArray(resources?.modes) ? resources.modes : [];
  if (!modes.length) return;
  const selected = resources?.mode || dom.resourceModeSelect.value || 'stable';
  dom.resourceModeSelect.innerHTML = modes
    .map((mode) => {
      const suffix = mode.value === 'stable' ? '（推荐）' : '';
      return `<option value="${escapeHtml(mode.value)}" title="${escapeHtml(mode.description || '')}">${escapeHtml(mode.label)}${suffix}</option>`;
    })
    .join('');
  dom.resourceModeSelect.value = modes.some((mode) => mode.value === selected) ? selected : 'stable';
  dom.resourceModeSelect.dataset.synced = '1';
}

function openSettings() {
  updateSettingsState(state.credential);
  dom.settingsModal.classList.remove('is-hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => dom.apiCredentialInput.focus(), 50);
}

function closeSettings() {
  dom.settingsModal.classList.add('is-hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'true');
}

async function syncResourceSettings() {
  try {
    const resources = await api.getResourceSettings?.();
    if (!resources) return;
    state.resourceSettings = resources;
    if (state.credential) state.credential.resources = resources;
    updateSettingsState(state.credential);
  } catch {
    // Resource settings are optional; keep the local default if loading fails.
  }
}

function openCloseChoice() {
  dom.closeChoiceModal.classList.remove('is-hidden');
  dom.closeChoiceModal.setAttribute('aria-hidden', 'false');
}

function closeCloseChoice() {
  dom.closeChoiceModal.classList.add('is-hidden');
  dom.closeChoiceModal.setAttribute('aria-hidden', 'true');
}

async function saveSettings() {
  const credentialValue = dom.apiCredentialInput.value.trim();
  const proxyValue = dom.proxyInput?.value.trim() || 'system';
  const resourceMode = dom.resourceModeSelect?.value || state.resourceSettings?.mode || 'stable';
  dom.saveSettingsBtn.disabled = true;
  dom.saveSettingsBtn.textContent = '保存中...';
  try {
    if (credentialValue) {
      state.credential = await api.saveCredential(credentialValue);
      dom.apiCredentialInput.value = '';
    }
    const savedState = await api.saveProxy(proxyValue);
    state.credential = savedState;
    state.proxy = savedState.proxy;
    state.resourceSettings = await api.saveResourceMode?.(resourceMode) || state.resourceSettings;
    if (state.credential) state.credential.resources = state.resourceSettings;
    updateSettingsState(state.credential);
    closeSettings();
    toast('设置已保存');
    await loadInitial();
  } catch (error) {
    toast(readableError(error));
  } finally {
    dom.saveSettingsBtn.disabled = false;
    dom.saveSettingsBtn.textContent = '保存并刷新';
  }
}

async function clearSettings() {
  try {
    state.credential = await api.clearCredential();
    updateSettingsState(state.credential);
    toast('已清除本机密钥');
  } catch (error) {
    toast(readableError(error));
  }
}

async function testConnection() {
  const proxyValue = dom.proxyInput?.value.trim() || 'system';
  dom.testConnectionBtn.disabled = true;
  dom.testConnectionBtn.textContent = '测试中...';
  try {
    const savedState = await api.saveProxy(proxyValue);
    state.credential = savedState;
    state.proxy = savedState.proxy;
    updateSettingsState(savedState);
    const result = await api.testConnection();
    toast(`TMDB 连接成功（${result.elapsedMs}ms，${result.resolvedProxy || 'proxy ok'}）`);
  } catch (error) {
    toast(readableError(error));
  } finally {
    dom.testConnectionBtn.disabled = false;
    dom.testConnectionBtn.textContent = '测试连接';
  }
}

function setupSearch() {
  startSearchPromptRotation();
  dom.globalSearch.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    const query = dom.globalSearch.value.trim();
    dom.clearSearchBtn.classList.toggle('is-visible', Boolean(query));
    syncIslandRestoreButtonState();

    if (!query) {
      resetSearchResults({ collapseIsland: true });
      return;
    }

    if (state.windowMode === 'island' || state.windowMode === 'island-docked') {
      api.expandIsland(330);
      applyWindowMode({ mode: 'island-expanded' });
    }

    state.searchTimer = setTimeout(() => search(query), 320);
  });

  dom.globalSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      clearTimeout(state.searchTimer);
      const query = dom.globalSearch.value.trim();
      if (query) search(query);
    }
  });

  dom.clearSearchBtn.addEventListener('click', () => {
    dom.globalSearch.value = '';
    dom.clearSearchBtn.classList.remove('is-visible');
    resetSearchResults({ collapseIsland: true });
    syncIslandRestoreButtonState();
    dom.globalSearch.focus();
  });
}

function resetSearchResults(options = {}) {
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.activeSearchId += 1;
  dom.searchSection.classList.add('is-hidden');
  dom.searchRail.innerHTML = '';
  dom.searchRail.classList.remove('is-expanded');
  for (const key of state.railStates.keys()) {
    if (String(key).startsWith('search:')) state.railStates.delete(key);
  }
  hideMoreButtonForRail(dom.searchRail);
  if (dom.searchMoreBtn) {
    dom.searchMoreBtn.classList.remove('is-expanded');
    dom.searchMoreBtn.disabled = false;
    dom.searchMoreBtn.textContent = '加载更多';
    dom.searchMoreBtn.title = '';
  }

  if (options.collapseIsland && state.windowMode === 'island-expanded') {
    api.enterIsland?.(72)?.catch?.(() => {});
    applyWindowMode({ mode: 'island' });
  }
}

function startSearchPromptRotation() {
  if (!dom.globalSearch || dom.globalSearch.dataset.rotating === 'true') return;
  dom.globalSearch.dataset.rotating = 'true';
  let index = 0;
  dom.globalSearch.placeholder = `${SEARCH_PROMPTS[index]} 例如：下雨天 / 独处 / 放松`;
  setInterval(() => {
    if (document.activeElement === dom.globalSearch || dom.globalSearch.value.trim()) return;
    index = (index + 1) % SEARCH_PROMPTS.length;
    dom.globalSearch.placeholder = `${SEARCH_PROMPTS[index]} 试试自然语言描述`;
  }, 3600);
}

function extractPromptIntent(query) {
  const normalized = String(query || '').toLowerCase();
  const matched = [];
  for (const intent of PROMPT_INTENTS) {
    const matchedPatterns = [];
    const score = intent.patterns.reduce((total, pattern) => {
      const cleanPattern = pattern.toLowerCase();
      if (!normalized.includes(cleanPattern) || isNegatedPattern(normalized, cleanPattern)) return total;
      matchedPatterns.push(pattern);
      return total + (cleanPattern.length >= 2 ? 2 : 1);
    }, 0);
    if (score > 0) matched.push({ ...intent, score, matchedPatterns });
  }
  if (!matched.length) return null;
  matched.sort((a, b) => b.score - a.score);
  const topScore = matched[0].score;
  const selected = matched.filter((item) => item.score === topScore).slice(0, 2);
  const negativeGenreIds = NEGATIVE_GENRE_HINTS
    .filter((hint) => hint.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())))
    .flatMap((hint) => hint.genreIds);
  const blocked = new Set(negativeGenreIds);
  const genreIds = [...new Set(selected.flatMap((item) => item.genreIds))]
    .filter((id) => !blocked.has(id))
    .slice(0, 6);
  const genreGroups = selected
    .flatMap((item) => item.genreGroups || [item.genreIds])
    .map((group) => group.filter((id) => genreIds.includes(id) && !blocked.has(id)))
    .filter((group) => group.length)
    .slice(0, 4);
  const withoutGenreIds = [...new Set([
    ...selected.flatMap((item) => item.withoutGenreIds || []),
    ...negativeGenreIds
  ])].filter((id) => !genreIds.includes(id) || negativeGenreIds.includes(id));
  const minRating = Math.max(0, ...selected.map((item) => Number(item.minRating || 0)));
  return {
    label: selected.map((item) => item.label).join(' · '),
    genreIds,
    genreGroups,
    sortBy: matched[0].sortBy || 'popularity.desc',
    withoutGenreIds,
    minRating: minRating || undefined,
    matchedPatterns: [...new Set(selected.flatMap((item) => item.matchedPatterns))]
  };
}

function isNegatedPattern(text, pattern) {
  const index = text.indexOf(pattern);
  if (index <= 0) return false;
  const prefix = text.slice(Math.max(0, index - 5), index);
  return /(不要|别|不想看|不想|不看|不喜欢|拒绝|不要太|不太|不|非|无|没)$/.test(prefix);
}

function genreNamesFromIds(ids = []) {
  return ids.map((id) => state.genreMap.get(id)).filter(Boolean).slice(0, 4).join(' · ');
}

function expandGenreAliases(ids = []) {
  const expanded = new Set();
  for (const id of ids || []) {
    const numeric = Number(id);
    if (!numeric) continue;
    expanded.add(numeric);
    for (const alias of MOVIE_TV_GENRE_ALIASES[numeric] || []) expanded.add(alias);
  }
  return [...expanded];
}

function shouldSearchTextAlongsideIntent(query, intent) {
  if (!intent) return true;
  let leftover = String(query || '').toLowerCase().replace(/\s+/g, '');
  for (const pattern of intent.matchedPatterns || []) {
    leftover = leftover.replaceAll(pattern.toLowerCase(), '');
  }
  leftover = leftover.replace(/想找|想看|找|看|适合|推荐|电影|电视剧|剧集|节目|片子|片|剧|一部|一些|一点|可以|比较|身心|时候|的|吗|呢|吧|呀|？|\?/g, '');
  return leftover.length >= 2;
}

function rankMoviesForIntent(movies = [], intent) {
  if (!intent) return movies;
  const preferred = new Set(expandGenreAliases(intent.genreIds || []));
  const groupSets = (intent.genreGroups || []).map((group) => new Set(expandGenreAliases(group)));
  const avoided = new Set(expandGenreAliases(intent.withoutGenreIds || []));
  return uniqueMovies(movies)
    .map((movie, index) => {
      const genres = expandGenreAliases(movie.genreIds || []);
      const preferredHits = genres.filter((id) => preferred.has(id)).length;
      const groupHits = groupSets.reduce((total, group) => {
        if (!group.size) return total;
        return total + [...group].every((id) => genres.includes(id));
      }, 0);
      const avoidedHits = genres.filter((id) => avoided.has(id)).length;
      const voteScore = Math.min(Number(movie.voteAverage || 0), 10);
      const voteCountScore = Math.min(Math.log10(Number(movie.voteCount || 0) + 1), 4);
      const popularityScore = Math.min(Math.log10(Number(movie.popularity || 0) + 1), 3);
      const score = groupHits * 18 + preferredHits * 10 + voteScore * 1.5 + voteCountScore + popularityScore - avoidedHits * 30 - index * 0.03;
      return { movie, score, preferredHits, groupHits, avoidedHits };
    })
    .filter((item) => item.preferredHits > 0 || !(intent.genreIds || []).length)
    .filter((item) => item.avoidedHits === 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.movie);
}

function quickLocalIntentMovies(intent) {
  if (!intent) return [];
  return rankMoviesForIntent([...state.trending, ...state.popular], intent).slice(0, 12);
}

async function discoverIntentMovies(intent, page = 1) {
  if (!intent?.genreIds?.length) return [];
  const without = intent.withoutGenreIds || [];
  const groups = intent.genreGroups?.length ? intent.genreGroups : [intent.genreIds];
  const tasks = groups.slice(0, 3).map((group) => {
    const key = [
      'mood',
      group.join(','),
      without.join(','),
      intent.sortBy,
      intent.minRating || '',
      page
    ].join(':');
    return cachedRail(key, () => api.discoverMovies({
      genreIds: group.join(','),
      withoutGenreIds: without.join(','),
      sortBy: intent.sortBy,
      minVotes: 60,
      minRating: intent.minRating,
      page
    })).catch(() => []);
  });
  const groupsResult = await Promise.all(tasks);
  return rankMoviesForIntent(groupsResult.flat(), intent);
}

function buildSearchRailOptions(query, intent, shouldSearchText) {
  const intentPart = intent ? `${intent.label}:${intent.genreIds.join(',')}` : 'text';
  return {
    moreButton: dom.searchMoreBtn,
    stateKey: `search:${intentPart}:${query}`,
    loadMore: async (page) => {
      const [moodMovies, textMovies] = await Promise.all([
        intent ? discoverIntentMovies(intent, page) : Promise.resolve([]),
        shouldSearchText ? api.searchMovies(query, { page, enrich: false }).catch(() => []) : Promise.resolve([])
      ]);
      return rankMoviesForIntent(uniqueMovies([...moodMovies, ...textMovies]), intent);
    }
  };
}

async function search(query) {
  const searchId = ++state.activeSearchId;
  const intent = extractPromptIntent(query);
  const shouldSearchText = shouldSearchTextAlongsideIntent(query, intent);
  const railOptions = buildSearchRailOptions(query, intent, shouldSearchText);
  dom.searchSection.classList.remove('is-hidden');
  dom.searchTitle.textContent = intent ? `“${query}” 的氛围推荐` : `“${query}” 的相关推荐`;
  dom.searchHint.textContent = intent
    ? `正在匹配：${intent.label}`
    : '搜索中...';
  showRailLoading(dom.searchRail, 8);
  try {
    addRecentSearch(query);
    let moodMovies = [];
    if (intent) {
      const localMovies = quickLocalIntentMovies(intent);
      if (localMovies.length) {
        dom.searchHint.textContent = `${intent.label} · 先显示本地缓存，正在更新`;
        renderMovieRail(dom.searchRail, localMovies, { empty: '正在继续搜索更多相关电影/节目...', ...railOptions });
      }
    }
    const textSearchPromise = shouldSearchText
      ? cachedRail(`text:${query}`, () => api.searchMovies(query)).catch(() => [])
      : Promise.resolve([]);

    if (intent?.genreIds?.length) {
      addGenreWeight(intent.genreIds, 0.7);
      moodMovies = await discoverIntentMovies(intent);
      if (searchId !== state.activeSearchId) return;
      if (moodMovies.length) {
        dom.searchHint.textContent = `${intent.label} · ${genreNamesFromIds(intent.genreIds)}`;
        renderMovieRail(dom.searchRail, moodMovies, { empty: '正在继续搜索更多相关电影/节目...', ...railOptions });
      }
    }

    let textMovies = await textSearchPromise;
    if (!textMovies.length && intent && !shouldSearchText && !moodMovies.length) {
      textMovies = await cachedRail(`text:${query}`, () => api.searchMovies(query)).catch(() => []);
    }
    if (searchId !== state.activeSearchId) return;
    const movies = rankMoviesForIntent(uniqueMovies([...moodMovies, ...textMovies]), intent).slice(0, 24);
    dom.searchHint.textContent = `${movies.length} 个结果`;
    renderMovieRail(dom.searchRail, movies, { empty: '没有找到相关电影/节目，试试换一个关键词。', ...railOptions });
    const relatedGenres = uniqueMovies(movies).flatMap((movie) => movie.genreIds || []);
    addGenreWeight(relatedGenres.slice(0, 6), 0.15);
  } catch (error) {
    if (searchId !== state.activeSearchId) return;
    dom.searchHint.textContent = '';
    showRailEmpty(dom.searchRail, readableError(error));
  }
}

async function openDetails(movieId, fallbackMovie) {
  const mediaType = mediaTypeOf(fallbackMovie);
  const openingMovieId = movieId;
  const openingMediaType = mediaType;
  state.lastDetailMovieId = movieId;
  state.lastDetailMediaType = mediaType;
  state.lastDetailFallback = fallbackMovie || state.lastDetailFallback;
  syncDetailWaveMetrics();
  startDetailRipple('open', { metricsSynced: true });
  dom.detailPanel.classList.add('is-open');
  dom.detailPanel.setAttribute('aria-hidden', 'false');
  setDetailHandleState(true);
  dom.detailContent.innerHTML = detailSkeleton(fallbackMovie);
  resetDetailScroll();

  try {
    const details = await getMovieDetails(movieId, mediaType);
    if (detailCacheKey(state.lastDetailMovieId, state.lastDetailMediaType) !== detailCacheKey(openingMovieId, openingMediaType)) return;
    renderDetails(details);
    resetDetailScroll();
  } catch (error) {
    if (detailCacheKey(state.lastDetailMovieId, state.lastDetailMediaType) !== detailCacheKey(openingMovieId, openingMediaType)) return;
    dom.detailContent.innerHTML = `<div class="empty-state">${escapeHtml(readableError(error))}</div>`;
    resetDetailScroll();
  }
}

function closeDetails() {
  const wasOpen = dom.detailPanel.classList.contains('is-open');
  state.activeResourceSearchId += 1;
  syncDetailWaveMetrics();
  if (wasOpen) {
    startDetailRipple('close', { metricsSynced: true });
  } else {
    dom.detailPanel.classList.remove('is-rippling-open', 'is-rippling-close');
  }
  dom.detailPanel.classList.remove('is-open');
  dom.detailPanel.setAttribute('aria-hidden', 'true');
  setDetailHandleState(false);
}

function startDetailRipple(direction = 'open', options = {}) {
  if (!dom.detailPanel) return;
  if (!options.metricsSynced) {
    syncDetailWaveMetrics();
  }
  window.clearTimeout(detailRippleTimer);
  dom.detailPanel.classList.remove('is-rippling-open', 'is-rippling-close');
  void dom.detailPanel.offsetWidth;
  dom.detailPanel.classList.add(direction === 'close' ? 'is-rippling-close' : 'is-rippling-open');
  const rippleCleanupDelay = direction === 'close' ? 640 : 780;
  detailRippleTimer = window.setTimeout(() => {
    dom.detailPanel?.classList.remove('is-rippling-open', 'is-rippling-close');
  }, rippleCleanupDelay);
}

function syncDetailWaveMetrics() {
  if (!dom.detailPanel) return;
  const rect = dom.detailPanel.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1200;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 760;
  const fallbackWidth = Math.min(760, viewportWidth * (viewportWidth <= 1120 ? 0.72 : 0.62));
  const width = Math.max(320, Math.round(rect.width || fallbackWidth));
  const height = Math.max(420, Math.round(rect.height || viewportHeight));
  const radius = Math.ceil(Math.hypot(width, height / 2) + Math.min(92, Math.max(48, width * 0.09)));
  const feather = Math.round(Math.min(56, Math.max(30, width * 0.065)));
  const crestWidth = Math.round(Math.min(116, Math.max(62, width * 0.135)));
  const waveTravel = width + crestWidth * 2;
  const set = (name, value) => dom.detailPanel.style.setProperty(name, `${Math.round(value)}px`);
  set('--detail-panel-width-px', width);
  set('--detail-panel-height-px', height);
  set('--detail-wave-radius', radius);
  set('--detail-wave-radius-24', radius * 0.24);
  set('--detail-wave-radius-48', radius * 0.48);
  set('--detail-wave-radius-76', radius * 0.76);
  set('--detail-edge-feather', feather);
  set('--detail-crest-width', crestWidth);
  set('--detail-ripple-bg-width', width + crestWidth * 2);
  set('--detail-ripple-bg-height', height + crestWidth * 2);
  set('--detail-wave-travel', waveTravel);
  set('--detail-wave-travel-neg', -waveTravel);
}

function resetDetailScroll() {
  if (!dom.detailContent) return;
  dom.detailContent.scrollTop = 0;
  dom.detailContent.scrollLeft = 0;
  dom.detailContent.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    dom.detailContent.scrollTop = 0;
    dom.detailContent.scrollLeft = 0;
  });
}

function setDetailHandleState(isOpen) {
  if (!dom.detailCloseBtn) return;
  const label = isOpen ? '收回' : '拉出';
  const icon = isOpen ? '›' : '‹';
  const iconEl = dom.detailCloseBtn.querySelector('span');
  const textEl = dom.detailCloseBtn.querySelector('em');
  if (iconEl) iconEl.textContent = icon;
  if (textEl) textEl.textContent = label;
  dom.detailCloseBtn.setAttribute('aria-label', `${label}${state.lastDetailMediaType === 'tv' ? '节目' : '电影'}介绍页`);
}

function toggleDetailPanel() {
  if (dom.detailPanel.classList.contains('is-open')) {
    closeDetails();
    return;
  }
  if (state.lastDetailMovieId && state.detailsCache.has(detailCacheKey(state.lastDetailMovieId, state.lastDetailMediaType))) {
    openDetails(state.lastDetailMovieId, state.lastDetailFallback || { id: state.lastDetailMovieId, mediaType: state.lastDetailMediaType });
  } else {
    toast('先选择一部电影或节目查看介绍');
  }
}

function closeDetailsFromBlankArea(event) {
  if (!dom.detailPanel.classList.contains('is-open')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (state.player.open || target.closest('.player-modal, .player-shell')) return;
  if (dom.detailPanel.contains(target)) return;
  if (target.closest('button, a, input, textarea, .movie-card, .style-chip, .settings-card, .search-box, .window-controls')) {
    return;
  }
  closeDetails();
}

function detailSkeleton(movie) {
  const label = mediaDetailLabelOf(movie);
  return `
    <div class="detail-hero skeleton-detail">
      <div class="detail-poster"></div>
      <div class="detail-info">
        <p class="eyebrow">${escapeHtml(label)}</p>
        <h2>${escapeHtml(movie?.title || `加载${label}中...`)}</h2>
        <p></p>
        <p></p>
      </div>
    </div>
  `;
}

function renderDetails(details) {
  const isTv = mediaTypeOf(details) === 'tv';
  const poster = imageUrl(details.posterPath, POSTER_SIZE);
  const backdrop = imageUrl(details.backdropPath, BACKDROP_SIZE);
  const countries = details.productionCountries?.map((item) => item.name).filter(Boolean).slice(0, 2).join(' · ');
  const languages = details.spokenLanguages?.map((item) => item.name).filter(Boolean).slice(0, 2).join(' · ');
  const directors = details.crew?.filter((person) => isTv ? ['Creator', 'Executive Producer', 'Director'].includes(person.job) : person.job === 'Director').map((person) => person.name).join(' / ');
  const meta = [
    details.releaseDate || (isTv ? '未知首播日期' : '未知上映日期'),
    details.runtime ? `${isTv ? '单集约 ' : ''}${details.runtime} 分钟` : '',
    isTv && details.numberOfSeasons ? `${details.numberOfSeasons} 季` : '',
    isTv && details.numberOfEpisodes ? `${details.numberOfEpisodes} 集` : '',
    countries,
    languages
  ].filter(Boolean);

  dom.detailContent.innerHTML = `
    <div class="detail-backdrop" style="${backdrop ? `background-image:url('${backdrop}')` : ''}"></div>
    <div class="detail-hero">
      <div class="detail-poster">
        ${poster ? `<img src="${poster}" alt="${escapeHtml(details.title)} 海报" decoding="async" />` : '<div class="poster-fallback">No Poster</div>'}
      </div>
      <div class="detail-info">
        <p class="eyebrow">${escapeHtml(mediaDetailLabelOf(details))}</p>
        <h2>${escapeHtml(details.title)}</h2>
        ${details.originalTitle && details.originalTitle !== details.title ? `<h3>${escapeHtml(details.originalTitle)}</h3>` : ''}
        ${details.tagline ? `<p class="tagline">${escapeHtml(details.tagline)}</p>` : ''}
        <div class="meta-row">
          <span>★ ${scoreOf(details)}</span>
          ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
        </div>
        <div class="genre-row">
          ${(details.genres || []).map((genre) => `<span>${escapeHtml(genre.name)}</span>`).join('')}
        </div>
        <p class="overview">${escapeHtml(details.overview || '暂无简介。')}</p>
        <div class="detail-actions">
          <button id="detailLikeBtn" class="primary-button" type="button">加入偏好</button>
          ${details.homepage ? '<button id="homepageBtn" class="secondary-button" type="button">打开官网</button>' : ''}
          ${details.videos?.[0] ? '<button id="trailerBtn" class="secondary-button" type="button">预告片</button>' : ''}
        </div>
      </div>
    </div>
    <div class="detail-grid">
      <section>
        <h4>主创</h4>
        <p>${escapeHtml(directors ? `${isTv ? '主创' : '导演'}：${directors}` : `${isTv ? '主创' : '导演'}信息暂无`)}</p>
        <p>${escapeHtml((details.crew || []).filter((person) => person.job !== 'Director').map((person) => `${person.job}：${person.name}`).join(' · ') || '')}</p>
      </section>
      <section>
        <h4>主演</h4>
        <div class="cast-row">
          ${(details.cast || []).map((person) => castCard(person)).join('') || '<p>演员信息暂无</p>'}
        </div>
      </section>
    </div>
    <section class="detail-recommendations">
      <h4>更多相似推荐</h4>
      <div id="detailRecommendations" class="movie-rail mini"></div>
    </section>
    <section id="detailResources" class="detail-resources">
      <div class="resource-header">
        <div>
          <h4>可用资源</h4>
          <p id="resourceStatus">准备轮询资源源...</p>
        </div>
        <span id="resourceModeBadge">${escapeHtml(state.resourceSettings?.label || '稳定优先')}</span>
      </div>
      <div id="resourceResults" class="resource-results"></div>
    </section>
  `;

  dom.detailContent.querySelector('#detailLikeBtn')?.addEventListener('click', () => {
    likeMovie({
      id: details.id,
      title: details.title,
      mediaType: mediaTypeOf(details),
      genreIds: (details.genres || []).map((genre) => genre.id)
    });
  });
  dom.detailContent.querySelector('#homepageBtn')?.addEventListener('click', () => api.openExternal(details.homepage));
  dom.detailContent.querySelector('#trailerBtn')?.addEventListener('click', () => api.openExternal(`https://www.youtube.com/watch?v=${details.videos[0].key}`));

  renderMovieRail(
    dom.detailContent.querySelector('#detailRecommendations'),
    uniqueMovies([...(details.recommendations || []), ...(details.similar || [])]).slice(0, 10),
    { compact: true, empty: '暂无相似推荐。' }
  );
  loadDetailResources(details);
}

function resourceSearchPayload(details = {}) {
  return {
    id: details.id,
    mediaType: mediaTypeOf(details),
    title: details.title,
    originalTitle: details.originalTitle,
    releaseDate: details.releaseDate,
    year: (details.releaseDate || '').slice(0, 4)
  };
}

function episodeNumberFromLabel(label = '', fallback = 1) {
  const text = String(label || '');
  const numeric = text.match(/(?:第\s*)?(\d{1,4})\s*(?:集|话|話|期)?/);
  if (numeric) return Number(numeric[1]);
  const cn = text.match(/第([一二三四五六七八九十百千万两]+)[集话話期]/);
  if (!cn) return fallback;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const value = cn[1];
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tenPart, onePart] = value.split('十');
    return (tenPart ? digits[tenPart] || 1 : 1) * 10 + (onePart ? digits[onePart] || 0 : 0);
  }
  return digits[value] || fallback;
}

function compactEpisodeLabel(label = '', index = 0) {
  const episodeNo = episodeNumberFromLabel(label, index + 1);
  if (/第.+[集话話期]/.test(String(label || ''))) return String(label || '').trim();
  return `第 ${episodeNo} 集`;
}

function registerResourceLinePlaylist(resource, line, lineIndex, sourceName, resourceTitle) {
  const episodes = Array.isArray(line?.episodes) ? line.episodes : [];
  const playlistId = `playlist-${++resourcePlaylistSeq}`;
  const playlist = episodes.map((episode, episodeIndex) => {
    const label = episode.label || compactEpisodeLabel('', episodeIndex);
    const format = episode.format || mediaKindLabel(mediaKindOf(episode.url));
    return {
      url: episode.url,
      kind: episode.kind || mediaKindOf(episode.url),
      format,
      needsResolve: Boolean(episode.needsResolve),
      title: resourceTitle,
      sourceName,
      lineName: line?.name || `线路 ${lineIndex + 1}`,
      label,
      displayLabel: compactEpisodeLabel(label, episodeIndex),
      episodeIndex,
      episodeNo: episodeNumberFromLabel(label, episodeIndex + 1),
      total: episodes.length
    };
  });
  state.resourcePlaylists.set(playlistId, playlist);
  return { playlistId, playlist };
}

function renderResourceCard(resource) {
  const sourceName = resource.sourceName || '资源源';
  const resourceTitle = resource.title || '未命名资源';
  const visibleLineLimit = 3;
  const lines = (resource.lines || [])
    .slice(0, visibleLineLimit)
    .map((line, lineIndex) => {
      const lineName = line.name || '默认线路';
      const { playlistId, playlist } = registerResourceLinePlaylist(resource, { ...line, name: lineName }, lineIndex, sourceName, resourceTitle);
      const visibleEpisodes = playlist.slice(0, resource.isSeries ? 12 : 4);
      const episodes = visibleEpisodes
        .map((episode) => {
          const label = episode.label || '播放';
          const format = episode.format || mediaKindLabel(mediaKindOf(episode.url));
          return `
            <button
              class="resource-episode"
              type="button"
              data-play-url="${escapeHtml(episode.url)}"
              data-player-kind="${escapeHtml(episode.kind || mediaKindOf(episode.url))}"
              data-player-format="${escapeHtml(format)}"
              data-player-resolve="${episode.needsResolve ? '1' : '0'}"
              data-player-playlist="${escapeHtml(playlistId)}"
              data-player-episode-index="${episode.episodeIndex}"
              data-player-title="${escapeHtml(resourceTitle)}"
              data-player-source="${escapeHtml(sourceName)}"
              data-player-line="${escapeHtml(lineName)}"
              data-player-label="${escapeHtml(label)}"
            ><span class="resource-episode-label">${escapeHtml(resource.isSeries ? episode.displayLabel : label)}</span><span class="resource-format">${escapeHtml(format)}</span></button>
          `;
        })
        .join('');
      const moreHint = playlist.length > visibleEpisodes.length
        ? `<span class="resource-line-more">播放器内显示全部 ${playlist.length} 集</span>`
        : '';
      return `
        <div class="resource-line">
          <span>${escapeHtml(lineName)}${playlist.length > 1 ? ` · ${playlist.length} 集` : ''}</span>
          <div>${episodes}${moreHint}</div>
        </div>
      `;
    })
    .join('');
  const firstLine = (resource.lines || []).find((line) => Array.isArray(line.episodes) && line.episodes.length) || {};
  const firstEpisode = firstLine.episodes?.[0] || {};
  const firstLineIndex = Math.max(0, (resource.lines || []).findIndex((line) => line === firstLine));
  const { playlistId: firstPlaylistId } = registerResourceLinePlaylist(resource, { ...firstLine, name: firstLine.name || '默认线路' }, firstLineIndex, sourceName, resourceTitle);
  const firstLabel = firstEpisode.label || '首个播放项';
  const firstLineName = firstLine.name || '默认线路';
  const firstFormat = firstEpisode.format || mediaKindLabel(mediaKindOf(resource.firstUrl));
  const formatSummary = Array.isArray(resource.formats) && resource.formats.length ? resource.formats.join(' / ') : '';
  const resourceBadge = resource.isSeries
    ? `电视剧集 · ${resource.seasonEpisodeCount || resource.episodeCount || 1} 集`
    : (resource.remarks || resource.type || resource.year || '可播放');

  return `
    <article class="resource-card" data-source="${escapeHtml(resource.sourceKey)}">
      <div class="resource-card-head">
        <div>
          <strong>${escapeHtml(sourceName)}</strong>
          <h5>${escapeHtml(resourceTitle)}</h5>
        </div>
        <span>${escapeHtml(resourceBadge)}</span>
      </div>
      <p>${escapeHtml([resource.year, resource.type, formatSummary, `${resource.playGroupCount || 1} 条线路`, resource.isSeries ? `${resource.seasonEpisodeCount || resource.episodeCount || 1} 集/季` : `${resource.episodeCount || 1} 个播放项`].filter(Boolean).join(' · '))}</p>
      <div class="resource-lines">${lines}</div>
      ${resource.firstUrl ? `
        <div class="resource-card-actions">
          <button
            class="primary-button resource-open"
            type="button"
            data-play-url="${escapeHtml(resource.firstUrl)}"
            data-player-kind="${escapeHtml(firstEpisode.kind || mediaKindOf(resource.firstUrl))}"
            data-player-format="${escapeHtml(firstFormat)}"
            data-player-resolve="${firstEpisode.needsResolve ? '1' : '0'}"
            data-player-playlist="${escapeHtml(firstPlaylistId)}"
            data-player-episode-index="0"
            data-player-title="${escapeHtml(resourceTitle)}"
            data-player-source="${escapeHtml(sourceName)}"
            data-player-line="${escapeHtml(firstLineName)}"
            data-player-label="${escapeHtml(firstLabel)}"
          >${resource.isSeries ? `播放第 1 集 · 共 ${resource.seasonEpisodeCount || 1} 集` : `应用内播放 · ${escapeHtml(firstFormat)}`}</button>
          <button class="secondary-button resource-external" type="button" data-external-url="${escapeHtml(resource.firstUrl)}">外部打开</button>
        </div>
      ` : ''}
    </article>
  `;
}

function bindResourceActions(container) {
  if (!container || container.dataset.bound === '1') return;
  container.dataset.bound = '1';
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const externalButton = target?.closest('[data-external-url]');
    const externalUrl = externalButton?.getAttribute('data-external-url');
    if (externalUrl) {
      api.openExternal(externalUrl);
      return;
    }

    const playButton = target?.closest('[data-play-url]');
    const url = playButton?.getAttribute('data-play-url');
    if (!url) return;
    openResourcePlayer({
      url,
      kind: playButton.getAttribute('data-player-kind') || '',
      format: playButton.getAttribute('data-player-format') || '',
      needsResolve: playButton.getAttribute('data-player-resolve') === '1',
      playlistId: playButton.getAttribute('data-player-playlist') || '',
      episodeIndex: Number(playButton.getAttribute('data-player-episode-index') || 0),
      title: playButton.getAttribute('data-player-title') || '',
      sourceName: playButton.getAttribute('data-player-source') || '',
      lineName: playButton.getAttribute('data-player-line') || '',
      label: playButton.getAttribute('data-player-label') || ''
    });
  });
}

function normalizePlayableUrl(value) {
  const url = String(value || '').trim();
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function isHlsMediaUrl(value) {
  return /\.m3u8(?:$|[?#])/i.test(String(value || '')) || /m3u8/i.test(String(value || ''));
}

function isDashMediaUrl(value) {
  const text = String(value || '').toLowerCase();
  return /\.mpd(?:$|[?#])/i.test(text) || /(?:^|[?&#=/])(mpd|mpeg-dash|dash\+xml)(?:$|[?&#=/])/i.test(text);
}

function isFlvMediaUrl(value) {
  return /\.flv(?:$|[?#])/i.test(String(value || ''));
}

function isMpegTsMediaUrl(value) {
  return /\.(?:ts|m2ts|mts)(?:$|[?#])/i.test(String(value || ''));
}

function isMp4MediaUrl(value) {
  return /\.(?:mp4|m4v)(?:$|[?#])/i.test(String(value || ''));
}

function isWebmMediaUrl(value) {
  return /\.webm(?:$|[?#])/i.test(String(value || ''));
}

function isOggMediaUrl(value) {
  return /\.(?:ogv|ogg)(?:$|[?#])/i.test(String(value || ''));
}

function isNativeVideoMediaUrl(value) {
  return /\.(?:mov|mkv|avi|mpeg|mpg|3gp|f4v)(?:$|[?#])/i.test(String(value || ''));
}

function isResolvableMediaPageUrl(value) {
  return /\/(?:share|play|player|embed|vodplay|video)\//i.test(String(value || ''));
}

function mediaKindOf(value) {
  if (isHlsMediaUrl(value)) return 'hls';
  if (isDashMediaUrl(value)) return 'dash';
  if (isFlvMediaUrl(value)) return 'flv';
  if (isMpegTsMediaUrl(value)) return 'mpegts';
  if (isMp4MediaUrl(value)) return 'mp4';
  if (isWebmMediaUrl(value)) return 'webm';
  if (isOggMediaUrl(value)) return 'ogg';
  if (isNativeVideoMediaUrl(value)) return 'native-video';
  if (isResolvableMediaPageUrl(value)) return 'page';
  return 'native';
}

function mediaKindLabel(kind = 'native') {
  switch (kind) {
    case 'hls':
      return 'HLS';
    case 'dash':
      return 'DASH';
    case 'flv':
      return 'FLV';
    case 'mpegts':
      return 'MPEG-TS';
    case 'mp4':
      return 'MP4';
    case 'webm':
      return 'WebM';
    case 'ogg':
      return 'OGG';
    case 'page':
      return '网页解析';
    case 'native-video':
      return '视频直连';
    default:
      return '原生媒体';
  }
}

function playableUrlFromResolveResult(result, fallbackUrl) {
  const resolvedUrl = normalizePlayableUrl(result?.url);
  return resolvedUrl || fallbackUrl;
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function runWhenIdle(callback, timeout = 900) {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, { timeout });
  }
  return window.setTimeout(callback, Math.min(timeout, 180));
}

function cancelIdleTask(id) {
  if (!id) return;
  if ('cancelIdleCallback' in window) {
    window.cancelIdleCallback(id);
  } else {
    window.clearTimeout(id);
  }
}

function setPlayerStatus(message, options = {}) {
  if (!dom.playerStatus) return;
  const text = message || '';
  const muted = Boolean(options.muted);
  if (dom.playerStatus.textContent !== text) dom.playerStatus.textContent = text;
  if (dom.playerStatus.classList.contains('is-muted') !== muted) {
    dom.playerStatus.classList.toggle('is-muted', muted);
  }
}

function setPlayerLoading(isLoading, title = '正在加载', subtitle = '高清优先 · 全屏优化') {
  const loading = Boolean(isLoading) && !isPlayerRecentlySeeking(2400);
  if (dom.playerStage?.classList.contains('is-loading') !== loading) {
    dom.playerStage?.classList.toggle('is-loading', loading);
  }
  if (dom.playerLoader) {
    const strong = dom.playerLoader.querySelector('strong');
    const em = dom.playerLoader.querySelector('em');
    if (strong && strong.textContent !== title) strong.textContent = title;
    if (em && em.textContent !== subtitle) em.textContent = subtitle;
  }
}

function setPlayerError(message) {
  dom.playerStage?.classList.add('has-error');
  dom.playerError?.classList.remove('is-hidden');
  const span = dom.playerError?.querySelector('span');
  if (span) span.textContent = message || '可尝试外部打开，或切换其它线路。';
  setPlayerLoading(false);
  setPlayerStatus('应用内播放失败 · 可外部打开或切换线路', { muted: true });
}

function resetPlayerError() {
  dom.playerStage?.classList.remove('has-error');
  dom.playerError?.classList.add('is-hidden');
}

async function loadHlsEngine() {
  if (HlsClass) return HlsClass;
  if (!hlsLoadPromise) {
    hlsLoadPromise = import('hls.js/light')
      .then((module) => {
        HlsClass = module.default || module;
        return HlsClass;
      })
      .finally(() => {
        hlsLoadPromise = null;
      });
  }
  return hlsLoadPromise;
}

async function loadDashEngine() {
  if (DashClass) return DashClass;
  if (!dashLoadPromise) {
    dashLoadPromise = import('dashjs')
      .then((module) => {
        DashClass = module.default || module;
        return DashClass;
      })
      .finally(() => {
        dashLoadPromise = null;
      });
  }
  return dashLoadPromise;
}

async function loadFlvEngine() {
  if (FlvClass) return FlvClass;
  if (!flvLoadPromise) {
    flvLoadPromise = import('flv.js')
      .then((module) => {
        FlvClass = module.default || module;
        return FlvClass;
      })
      .finally(() => {
        flvLoadPromise = null;
      });
  }
  return flvLoadPromise;
}

function destroyPlayerHls() {
  if (!playerHls) return;
  try {
    playerHls.destroy();
  } catch {
    // ignore destroy errors
  }
  playerHls = null;
}

function destroyPlayerDash() {
  if (!playerDash) return;
  try {
    playerDash.reset();
  } catch {
    // ignore destroy errors
  }
  playerDash = null;
}

function destroyPlayerFlv() {
  if (!playerFlv) return;
  try {
    playerFlv.pause?.();
    playerFlv.unload?.();
    playerFlv.detachMediaElement?.();
    playerFlv.destroy?.();
  } catch {
    // ignore destroy errors
  }
  playerFlv = null;
}

function cleanupResourcePlayer() {
  window.clearTimeout(fullscreenQualityTimer);
  window.clearTimeout(fullscreenQualityRampTimer);
  window.clearTimeout(playerSeekTimer);
  fullscreenQualityTimer = 0;
  fullscreenQualityRampTimer = 0;
  playerSeekTimer = 0;
  playerLastSeekAt = 0;
  if (state.player) state.player.seeking = false;
  dom.playerStage?.classList.remove('is-seeking');
  dom.playerShell?.classList.remove('has-episodes');
  dom.playerEpisodes?.classList.add('is-hidden');
  if (dom.playerEpisodeList) dom.playerEpisodeList.innerHTML = '';
  if (dom.playerEpisodesMeta) dom.playerEpisodesMeta.textContent = '';
  destroyPlayerHls();
  destroyPlayerDash();
  destroyPlayerFlv();
  const video = dom.resourcePlayer;
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // Some invalid media states can throw during cleanup; the next load will reset the element.
  }
}

function showResourcePlayerModal() {
  if (!dom.playerModal) return;
  window.clearTimeout(playerCloseTimer);
  dom.playerModal.classList.remove('is-hidden', 'is-closing');
  document.body.classList.add('player-open');
  requestAnimationFrame(() => dom.playerModal?.classList.add('is-open'));
}

function closeResourcePlayer() {
  if (!dom.playerModal || dom.playerModal.classList.contains('is-hidden')) return;
  state.player.open = false;
  state.player.loadId += 1;
  cleanupResourcePlayer();
  setPlayerLoading(false);
  resetPlayerError();
  dom.playerModal.classList.remove('is-open');
  dom.playerModal.classList.add('is-closing');
  document.body.classList.remove('player-open');
  window.clearTimeout(playerCloseTimer);
  playerCloseTimer = window.setTimeout(() => {
    dom.playerModal?.classList.add('is-hidden');
    dom.playerModal?.classList.remove('is-closing');
  }, 220);
}

async function beginPlayerPlayback(loadId) {
  const video = dom.resourcePlayer;
  if (!video || loadId !== state.player.loadId || !state.player.open) return;
  try {
    await video.play();
    setPlayerLoading(false);
    setPlayerStatus('正在播放');
  } catch {
    setPlayerLoading(false);
    setPlayerStatus('已就绪 · 点击播放');
  }
}

function setPlayerSeeking(active) {
  if (!state.player.open) return;
  window.clearTimeout(playerSeekTimer);
  state.player.seeking = Boolean(active);
  dom.playerStage?.classList.toggle('is-seeking', Boolean(active));
  if (active) {
    playerLastSeekAt = Date.now();
    setPlayerLoading(false);
    setPlayerStatus('定位中...', { muted: true });
  }
}

function endPlayerSeekingSoon(delay = 1200) {
  window.clearTimeout(playerSeekTimer);
  playerSeekTimer = window.setTimeout(() => {
    if (!state.player.open) return;
    state.player.seeking = false;
    dom.playerStage?.classList.remove('is-seeking');
  }, delay);
}

function isPlayerRecentlySeeking(windowMs = 2400) {
  return Boolean(state.player.seeking || (playerLastSeekAt && Date.now() - playerLastSeekAt < windowMs));
}

function handlePlayerScrubStart() {
  if (!state.player.open) return;
  setPlayerSeeking(true);
}

function handlePlayerScrubEnd() {
  if (!state.player.open || !state.player.seeking) return;
  endPlayerSeekingSoon(1800);
}

function isPlayerFullscreen() {
  const video = dom.resourcePlayer;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  return Boolean(
    fullscreenElement
    && (
      fullscreenElement === video
      || fullscreenElement === dom.playerStage
      || fullscreenElement?.contains?.(video)
    )
  );
}

function targetPlaybackHeight() {
  const video = dom.resourcePlayer;
  if (isPlayerFullscreen()) {
    return 2160;
  }
  const rect = video?.getBoundingClientRect();
  const stageHeight = rect?.height || 540;
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  return Math.min(1080, Math.max(720, Math.round(stageHeight * dpr * 1.18)));
}

function tuneHlsBufferForFullscreen() {
  if (!playerHls?.config) return;
  try {
    playerHls.config.maxBufferLength = 96;
    playerHls.config.maxMaxBufferLength = 260;
    playerHls.config.maxBufferSize = 340 * 1000 * 1000;
    playerHls.config.abrEwmaDefaultEstimate = Math.max(playerHls.config.abrEwmaDefaultEstimate || 0, 18000000);
  } catch {
    // HLS runtime config tuning is best-effort.
  }
}

function tuneDashBufferForFullscreen() {
  if (!playerDash) return;
  try {
    playerDash.updateSettings?.({
      streaming: {
        bufferTimeAtTopQuality: 54,
        bufferTimeAtTopQualityLongForm: 96,
        limitBitrateByPortal: false,
        usePixelRatioInLimitBitrateByPortal: true,
        abr: {
          initialBitrate: { video: 12000 },
          maxBitrate: { video: -1 }
        }
      }
    });
  } catch {
    // DASH runtime config tuning is best-effort.
  }
}

function scheduleFullscreenPlaybackQuality() {
  window.clearTimeout(fullscreenQualityTimer);
  window.clearTimeout(fullscreenQualityRampTimer);
  fullscreenQualityTimer = 0;
  fullscreenQualityRampTimer = 0;
  if (!state.player.open || !isPlayerFullscreen()) return;

  requestAnimationFrame(() => {
    if (state.player.open && isPlayerFullscreen()) setPlayerStatus('全屏就绪');
  });

  fullscreenQualityTimer = window.setTimeout(() => {
    applyFullscreenPlaybackQuality({ aggressive: false });
  }, 420);

  fullscreenQualityRampTimer = window.setTimeout(() => {
    applyFullscreenPlaybackQuality({ aggressive: true });
  }, 1180);
}

function chooseBestQualityLevel(levels = []) {
  const targetHeight = targetPlaybackHeight();
  const ranked = levels
    .map((level, index) => ({
      index: Number.isFinite(Number(level?.qualityIndex)) ? Number(level.qualityIndex) : index,
      height: Number(level?.height || 0),
      width: Number(level?.width || 0),
      bitrate: Number(level?.bitrate || level?.maxBitrate || 0)
    }))
    .filter((level) => level.height > 0 || level.bitrate > 0)
    .sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));

  if (!ranked.length) return null;
  return ranked.find((level) => level.height && level.height <= targetHeight) || ranked[0];
}

function applyHlsQualityPreference(loadId, options = {}) {
  if (loadId !== state.player.loadId || !state.player.open || !playerHls) return;
  const best = chooseBestQualityLevel(playerHls.levels || []);
  if (!best) return;
  const prefers4k = Boolean(options.fullscreen) || isPlayerFullscreen() || targetPlaybackHeight() >= 2160;
  try {
    if (prefers4k) tuneHlsBufferForFullscreen();
    playerHls.autoLevelCapping = best.index;
    if (options.aggressive) {
      playerHls.nextLevel = best.index;
      playerHls.nextLoadLevel = best.index;
    } else if (!prefers4k) {
      playerHls.nextLevel = best.index;
    }
  } catch {
    // Keep ABR default if a source does not allow level hinting.
  }
  const label = best.height ? `${best.height}P` : '高清';
  if (!options.silent) setPlayerStatus(prefers4k && best.height >= 2000 ? '4K 优先 · 就绪' : `高清就绪 · ${label}`);
}

function applyFullscreenPlaybackQuality(options = {}) {
  if (!state.player.open || !isPlayerFullscreen()) return;
  const loadId = state.player.loadId;
  if (playerHls) {
    applyHlsQualityPreference(loadId, { silent: true, fullscreen: true, aggressive: Boolean(options.aggressive) });
    const best = chooseBestQualityLevel(playerHls.levels || []);
    if (options.aggressive) setPlayerStatus(best?.height >= 2000 ? '全屏 4K 优先' : '全屏高清已优化');
    return;
  }
  if (playerDash) {
    try {
      tuneDashBufferForFullscreen();
      const levels = playerDash.getBitrateInfoListFor?.('video') || [];
      const best = chooseBestQualityLevel(levels);
      const qualityIndex = Number.isFinite(Number(best?.index)) ? Number(best.index) : -1;
      if (options.aggressive && qualityIndex >= 0) playerDash.setQualityFor?.('video', qualityIndex, false);
      if (options.aggressive) setPlayerStatus(best?.height >= 2000 ? '全屏 4K 优先' : '全屏高清已优化');
    } catch {
      // DASH fullscreen tuning is best-effort.
    }
  }
}

function handlePlayerHlsError(loadId, data = {}) {
  if (loadId !== state.player.loadId || !state.player.open || !playerHls) return;
  if (!data.fatal) {
    setPlayerStatus('片源轻微波动，正在继续缓冲...', { muted: true });
    return;
  }

  state.player.recoveries += 1;
  const errorTypes = HlsClass?.ErrorTypes || {};
  if (state.player.recoveries <= 2 && data.type === errorTypes.NETWORK_ERROR) {
    setPlayerStatus('网络片段波动，正在快速重连...', { muted: true });
    playerHls.startLoad();
    return;
  }
  if (state.player.recoveries <= 2 && data.type === errorTypes.MEDIA_ERROR) {
    setPlayerStatus('媒体流解码波动，正在恢复播放...', { muted: true });
    playerHls.recoverMediaError();
    return;
  }

  setPlayerError('该线路的媒体流暂时不可用，建议切换其它播放项或外部打开。');
}

function renderPlayerEpisodes() {
  const playlist = Array.isArray(state.player.playlist) ? state.player.playlist : [];
  const hasEpisodes = playlist.length > 1;
  dom.playerEpisodes?.classList.toggle('is-hidden', !hasEpisodes);
  dom.playerShell?.classList.toggle('has-episodes', hasEpisodes);
  if (!hasEpisodes) {
    if (dom.playerEpisodeList) dom.playerEpisodeList.innerHTML = '';
    if (dom.playerEpisodesMeta) dom.playerEpisodesMeta.textContent = '';
    return;
  }

  const currentIndex = Math.max(0, Number(state.player.episodeIndex || 0));
  if (dom.playerEpisodesMeta) {
    dom.playerEpisodesMeta.textContent = `${currentIndex + 1} / ${playlist.length} 集 · ${state.player.lineName || '默认线路'}`;
  }
  if (dom.playerEpisodeList) {
    dom.playerEpisodeList.innerHTML = playlist
      .map((episode, index) => {
        const label = episode.displayLabel || compactEpisodeLabel(episode.label, index);
        const format = episode.format || mediaKindLabel(mediaKindOf(episode.url));
        return `
          <button
            class="player-episode-button${index === currentIndex ? ' is-active' : ''}"
            type="button"
            data-player-episode-index="${index}"
            title="${escapeHtml(episode.label || label)}"
          >
            <span>${escapeHtml(label)}</span>
            <em>${escapeHtml(format)}</em>
          </button>
        `;
      })
      .join('');
    requestAnimationFrame(() => {
      dom.playerEpisodeList
        ?.querySelector('.player-episode-button.is-active')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  }
}

function playPlayerEpisode(index) {
  const playlist = Array.isArray(state.player.playlist) ? state.player.playlist : [];
  const episodeIndex = Math.max(0, Math.min(playlist.length - 1, Number(index || 0)));
  const episode = playlist[episodeIndex];
  if (!episode?.url) return;
  openResourcePlayer({
    url: episode.url,
    kind: episode.kind,
    format: episode.format,
    needsResolve: episode.needsResolve,
    title: episode.title || state.player.title,
    sourceName: episode.sourceName || state.player.sourceName,
    lineName: episode.lineName || state.player.lineName,
    label: episode.label || `第 ${episodeIndex + 1} 集`,
    playlistId: state.player.playlistId,
    playlist,
    episodeIndex
  });
}

async function openResourcePlayer(payload = {}) {
  const playlistId = payload.playlistId || '';
  const playlist = Array.isArray(payload.playlist)
    ? payload.playlist
    : (playlistId ? state.resourcePlaylists.get(playlistId) || [] : []);
  const episodeIndex = Math.max(0, Math.min(Math.max(playlist.length - 1, 0), Number(payload.episodeIndex || 0)));
  const playlistEpisode = playlist[episodeIndex] || null;
  const selectedUrl = playlistEpisode?.url || payload.url;
  const rawUrl = normalizePlayableUrl(selectedUrl);
  if (!rawUrl) {
    toast('播放地址不可用');
    return;
  }

  const loadId = state.player.loadId + 1;
  const hintedKind = playlistEpisode?.kind || payload.kind || mediaKindOf(rawUrl);
  const selectedFormat = playlistEpisode?.format || payload.format || mediaKindLabel(hintedKind);
  const needsResolve =
    playlistEpisode?.needsResolve === true
    || playlistEpisode?.needsResolve === '1'
    || payload.needsResolve === true
    || payload.needsResolve === '1'
    || hintedKind === 'page';
  cleanupResourcePlayer();
  state.player = {
    open: true,
    url: rawUrl,
    originalUrl: rawUrl,
    resolvedUrl: '',
    proxiedUrl: '',
    kind: hintedKind,
    format: selectedFormat,
    title: playlistEpisode?.title || payload.title || '影视资源',
    sourceName: playlistEpisode?.sourceName || payload.sourceName || '资源源',
    lineName: playlistEpisode?.lineName || payload.lineName || '默认线路',
    label: playlistEpisode?.label || payload.label || '播放项',
    playlistId,
    playlist,
    episodeIndex,
    recoveries: 0,
    loadId,
    seeking: false
  };

  resetPlayerError();
  showResourcePlayerModal();

  if (dom.playerTitle) dom.playerTitle.textContent = state.player.title || '影视资源';
  if (dom.playerSource) dom.playerSource.textContent = state.player.sourceName || 'CineFlow Player';
  if (dom.playerMeta) {
    dom.playerMeta.textContent = [state.player.lineName, state.player.label, selectedFormat].filter(Boolean).join(' · ') || '应用内极速播放';
  }
  renderPlayerEpisodes();
  setPlayerLoading(true, '正在加载', '高清优先 · 全屏优化');
  setPlayerStatus(needsResolve ? '解析播放页...' : '准备播放...');

  await nextAnimationFrame();
  await nextAnimationFrame();
  if (loadId !== state.player.loadId || !state.player.open) return;

  let mediaKind = hintedKind;
  let mediaUrl = rawUrl;
  let resolved = null;
  if (needsResolve) {
    try {
      resolved = await api.resolveMediaUrl?.(rawUrl);
      if (loadId !== state.player.loadId || !state.player.open) return;
      mediaUrl = playableUrlFromResolveResult(resolved, rawUrl);
      mediaKind = resolved?.kind || mediaKindOf(mediaUrl);
      if (dom.playerMeta) {
        const resolvedLabel = resolved?.resolved
          ? `${selectedFormat} → ${resolved.format || mediaKindLabel(mediaKind)}`
          : (resolved?.format || selectedFormat || mediaKindLabel(mediaKind));
        dom.playerMeta.textContent = [state.player.lineName, state.player.label, resolvedLabel].filter(Boolean).join(' · ');
      }
      setPlayerStatus(resolved?.resolved ? `${resolved.format || mediaKindLabel(mediaKind)} · 已解析` : '解析完成');
    } catch {
      mediaUrl = rawUrl;
      mediaKind = mediaKindOf(rawUrl);
      setPlayerStatus('尝试直连...', { muted: true });
    }
  }

  if (mediaKind === 'page') {
    setPlayerError('该网页播放页暂时没有提取到真实视频地址，可外部打开或切换同资源下的 m3u8 / MP4 线路。');
    return;
  }

  state.player.url = mediaUrl;
  state.player.resolvedUrl = resolved?.resolved ? mediaUrl : '';
  state.player.kind = mediaKind;

  let engineWarmPromise = null;
  if (mediaKind === 'hls') engineWarmPromise = loadHlsEngine().catch(() => null);
  if (mediaKind === 'dash') engineWarmPromise = loadDashEngine().catch(() => null);
  if (mediaKind === 'flv') engineWarmPromise = loadFlvEngine().catch(() => null);

  let playableUrl = mediaUrl;
  try {
    playableUrl = await api.getMediaProxyUrl?.(mediaUrl) || mediaUrl;
  } catch {
    playableUrl = mediaUrl;
  }

  if (loadId !== state.player.loadId || !state.player.open) return;
  state.player.proxiedUrl = playableUrl;

  const video = dom.resourcePlayer;
  if (!video) return;
  video.preload = mediaKind === 'hls' || mediaKind === 'dash' ? 'metadata' : 'auto';
  video.crossOrigin = 'anonymous';
  video.disableRemotePlayback = true;
  video.playsInline = true;

  try {
    if (mediaKind === 'hls') {
      setPlayerStatus('HLS 加载中...');
      const HlsEngine = await (engineWarmPromise || loadHlsEngine());
      if (loadId !== state.player.loadId || !state.player.open) return;
      if (HlsEngine?.isSupported()) {
        setPlayerStatus('HLS 解析中...');
        playerHls = new HlsEngine({
          enableWorker: true,
          lowLatencyMode: false,
          capLevelToPlayerSize: false,
          ignoreDevicePixelRatio: false,
          backBufferLength: 30,
          maxBufferLength: 36,
          maxMaxBufferLength: 96,
          maxBufferSize: 128 * 1000 * 1000,
          startFragPrefetch: true,
          abrEwmaFastVoD: 3,
          abrEwmaSlowVoD: 9,
          abrEwmaDefaultEstimate: 12000000,
          abrBandWidthFactor: 0.90,
          abrBandWidthUpFactor: 0.86,
          maxStarvationDelay: 4,
          maxLoadingDelay: 4,
          maxBufferHole: 0.35,
          maxFragLookUpTolerance: 0.25,
          nudgeOffset: 0.08,
          highBufferWatchdogPeriod: 2,
          nudgeMaxRetry: 4,
          manifestLoadingTimeOut: 10000,
          levelLoadingTimeOut: 10000,
          fragLoadingTimeOut: 22000
        });
        playerHls.on(HlsEngine.Events.ERROR, (_event, data) => handlePlayerHlsError(loadId, data));
        playerHls.on(HlsEngine.Events.MANIFEST_PARSED, () => {
          applyHlsQualityPreference(loadId);
          beginPlayerPlayback(loadId);
        });
        playerHls.attachMedia(video);
        playerHls.loadSource(playableUrl);
        return;
      }
    }

    if (mediaKind === 'dash') {
      setPlayerStatus('DASH 加载中...');
      const DashEngine = await (engineWarmPromise || loadDashEngine());
      if (loadId !== state.player.loadId || !state.player.open) return;
      const factory = DashEngine?.MediaPlayer;
      if (typeof factory === 'function') {
        setPlayerStatus('DASH 解析中...');
        playerDash = factory().create();
        try {
          playerDash.updateSettings?.({
            streaming: {
              lowLatencyEnabled: false,
              stableBufferTime: 10,
              stableBufferTimeFastSwitch: 6,
              bufferTimeAtTopQuality: 18,
              bufferTimeAtTopQualityLongForm: 30,
              jumpGaps: true,
              fastSwitchEnabled: true,
              limitBitrateByPortal: false,
              usePixelRatioInLimitBitrateByPortal: true,
              abr: {
                useDefaultABRRules: true,
                ABRStrategy: 'abrDynamic',
                initialBitrate: { video: 8000 },
                maxBitrate: { video: -1 }
              }
            }
          });
        } catch {
          // DASH settings are best-effort; keep the engine default if a version rejects a key.
        }
        playerDash.on?.('manifestLoaded', () => setPlayerStatus('DASH 已加载'));
        playerDash.on?.('streamInitialized', () => setPlayerStatus('DASH 就绪'));
        playerDash.on?.('playbackPlaying', () => {
          setPlayerLoading(false);
          setPlayerStatus('正在播放 · DASH');
        });
        playerDash.on?.('playbackWaiting', () => {
          if (isPlayerRecentlySeeking()) {
            setPlayerLoading(false);
            setPlayerStatus('定位中...', { muted: true });
            return;
          }
          setPlayerLoading(true, '缓冲中', '网络波动');
          setPlayerStatus('缓冲中...', { muted: true });
        });
        playerDash.on?.('error', () => setPlayerError('DASH 资源暂时无法解析，可切换其它线路或外部打开。'));
        playerDash.initialize(video, playableUrl, true);
        return;
      }
    }

    if (mediaKind === 'flv') {
      setPlayerStatus('FLV 加载中...');
      const FlvEngine = await (engineWarmPromise || loadFlvEngine());
      if (loadId !== state.player.loadId || !state.player.open) return;
      if (FlvEngine?.isSupported?.()) {
        setPlayerStatus('FLV 解析中...');
        playerFlv = FlvEngine.createPlayer({
          type: 'flv',
          isLive: false,
          hasAudio: true,
          hasVideo: true,
          url: playableUrl
        }, {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 1024 * 512,
          lazyLoad: true,
          lazyLoadMaxDuration: 180,
          reuseRedirectedURL: true,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 120,
          autoCleanupMinBackwardDuration: 30
        });
        playerFlv.on?.(FlvEngine.Events?.ERROR || 'error', () => {
          setPlayerError('FLV 资源暂时无法解析，可切换其它线路或外部打开。');
        });
        playerFlv.attachMediaElement(video);
        playerFlv.load();
        await beginPlayerPlayback(loadId);
        return;
      }
    }

    video.src = playableUrl;
    video.load();
    setPlayerStatus(mediaKind === 'mpegts' ? 'MPEG-TS 加载中...' : `${mediaKindLabel(mediaKind)} 加载中...`);
    await beginPlayerPlayback(loadId);
  } catch {
    setPlayerError('该播放地址暂时无法被播放器识别，可尝试外部打开或切换线路。');
  }
}

async function copyPlayerUrl() {
  const text = state.player.url;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  toast('播放链接已复制');
}

function setupPlayerEvents() {
  dom.playerModal?.addEventListener('click', (event) => {
    if (event.target === dom.playerModal) closeResourcePlayer();
  });
  dom.playerCloseBtn?.addEventListener('click', closeResourcePlayer);
  dom.playerStopBtn?.addEventListener('click', closeResourcePlayer);
  dom.playerExternalBtn?.addEventListener('click', () => {
    const target = state.player.originalUrl || state.player.url;
    if (target) api.openExternal(target);
  });
  dom.playerCopyBtn?.addEventListener('click', copyPlayerUrl);
  dom.playerEpisodeList?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-player-episode-index]');
    if (!button) return;
    const index = Number(button.getAttribute('data-player-episode-index') || 0);
    if (Number(state.player.episodeIndex || 0) === index) return;
    playPlayerEpisode(index);
  });

  dom.resourcePlayer?.addEventListener('pointerdown', handlePlayerScrubStart, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('mousedown', handlePlayerScrubStart, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('touchstart', handlePlayerScrubStart, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('pointerup', handlePlayerScrubEnd, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('pointercancel', handlePlayerScrubEnd, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('mouseup', handlePlayerScrubEnd, { capture: true, passive: true });
  dom.resourcePlayer?.addEventListener('touchend', handlePlayerScrubEnd, { capture: true, passive: true });
  document.addEventListener('pointerup', handlePlayerScrubEnd, { passive: true });
  document.addEventListener('mouseup', handlePlayerScrubEnd, { passive: true });

  dom.resourcePlayer?.addEventListener('loadstart', () => {
    if (!state.player.open) return;
    if (isPlayerRecentlySeeking()) return;
    setPlayerLoading(true, '正在加载', '高清优先');
  });
  dom.resourcePlayer?.addEventListener('loadedmetadata', () => {
    if (!state.player.open) return;
    setPlayerStatus('媒体就绪');
  });
  dom.resourcePlayer?.addEventListener('playing', () => {
    if (!state.player.open) return;
    endPlayerSeekingSoon(420);
    setPlayerLoading(false);
    setPlayerStatus('正在播放');
  });
  dom.resourcePlayer?.addEventListener('waiting', () => {
    if (!state.player.open) return;
    if (isPlayerRecentlySeeking()) {
      setPlayerLoading(false);
      setPlayerStatus('定位中...', { muted: true });
      return;
    }
    setPlayerLoading(true, '缓冲中', '网络波动');
    setPlayerStatus('缓冲中...', { muted: true });
  });
  dom.resourcePlayer?.addEventListener('seeking', () => {
    if (!state.player.open) return;
    setPlayerSeeking(true);
  });
  dom.resourcePlayer?.addEventListener('seeked', () => {
    if (!state.player.open) return;
    setPlayerLoading(false);
    setPlayerStatus('定位完成', { muted: true });
    endPlayerSeekingSoon(1600);
  });
  dom.resourcePlayer?.addEventListener('canplay', () => {
    if (!state.player.open) return;
    if (isPlayerRecentlySeeking()) endPlayerSeekingSoon(900);
  });
  dom.resourcePlayer?.addEventListener('error', () => {
    if (!state.player.open) return;
    setPlayerError('视频元素无法读取该资源，建议外部打开或切换其它线路。');
  });

  const handleFullscreenQuality = () => {
    if (!state.player.open) return;
    scheduleFullscreenPlaybackQuality();
  };
  document.addEventListener('fullscreenchange', handleFullscreenQuality);
  document.addEventListener('webkitfullscreenchange', handleFullscreenQuality);
  window.addEventListener('resize', handleFullscreenQuality, { passive: true });
}

function schedulePlayerEnginePrewarm(resources = []) {
  const kinds = new Set();
  for (const resource of resources || []) {
    for (const line of resource.lines || []) {
      for (const episode of line.episodes || []) {
        const kind = mediaKindOf(episode.url);
        if (kind === 'hls' || kind === 'dash' || kind === 'flv') {
          kinds.add(kind);
        }
      }
    }
    const firstKind = mediaKindOf(resource.firstUrl);
    if (firstKind === 'hls' || firstKind === 'dash' || firstKind === 'flv') {
      kinds.add(firstKind);
    }
  }
  if (!kinds.size) return;

  cancelIdleTask(playerPrewarmTimer);
  playerPrewarmTimer = runWhenIdle(() => {
    playerPrewarmTimer = 0;
    if (kinds.has('hls')) loadHlsEngine().catch(() => {});
    if (kinds.has('dash')) loadDashEngine().catch(() => {});
    if (kinds.has('flv')) loadFlvEngine().catch(() => {});
  }, 1600);
}

function setResourceStatus(section, message, options = {}) {
  const status = section?.querySelector('#resourceStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-muted', Boolean(options.muted));
}

async function loadDetailResources(details) {
  const section = dom.detailContent.querySelector('#detailResources');
  const list = dom.detailContent.querySelector('#resourceResults');
  if (!section || !list) return;
  const searchId = ++state.activeResourceSearchId;
  state.resourcePlaylists.clear();
  resourcePlaylistSeq = 0;
  const mode = state.resourceSettings || { enabled: true, label: '稳定优先' };
  section.querySelector('#resourceModeBadge').textContent = mode.label || '稳定优先';
  bindResourceActions(list);

  if (!mode.enabled) {
    setResourceStatus(section, '资源查找已在设置中关闭。', { muted: true });
    list.innerHTML = '';
    return;
  }

  list.innerHTML = '<div class="resource-pulse">正在轮询资源源，只会显示已找到的可用资源...</div>';
  setResourceStatus(section, '正在轮询资源源...');

  const seen = new Set();
  let cursor = 0;
  let found = 0;
  let total = 0;
  let checked = 0;
  const payload = resourceSearchPayload(details);

  try {
    while (searchId === state.activeResourceSearchId) {
      const result = await api.findMovieResources?.(payload, { cursor, limit: 2 });
      if (searchId !== state.activeResourceSearchId || !result) return;

      total = result.total || total;
      checked = result.checked || checked;
      state.resourceSettings = {
        mode: result.mode,
        label: result.label,
        description: result.description,
        enabled: result.enabled
      };
      section.querySelector('#resourceModeBadge').textContent = result.label || mode.label || '稳定优先';

      const cards = [];
      for (const resource of result.resources || []) {
        const key = `${resource.sourceKey}:${resource.title}:${resource.firstUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found += 1;
        cards.push(renderResourceCard(resource));
      }
      if (cards.length) {
        if (found === cards.length) list.innerHTML = '';
        list.insertAdjacentHTML('beforeend', cards.join(''));
        schedulePlayerEnginePrewarm(result.resources || []);
      }

      setResourceStatus(
        section,
        result.done
          ? `轮询完成 · 已检查 ${checked}/${total} 个来源 · 找到 ${found} 个可用资源`
          : `正在轮询 · 已检查 ${checked}/${total || '?'} 个来源 · 找到 ${found} 个可用资源`
      );

      if (result.done || found >= 8) break;
      cursor = result.nextCursor || checked;
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    }

    if (searchId !== state.activeResourceSearchId) return;
    if (!found) {
      list.innerHTML = '<div class="resource-empty">暂未发现可用资源，可在设置中切换资源查找范围。</div>';
      setResourceStatus(section, total ? `轮询完成 · 已检查 ${checked}/${total} 个来源` : '暂无可轮询的资源来源', { muted: true });
    }
  } catch (error) {
    if (searchId !== state.activeResourceSearchId) return;
    list.innerHTML = '<div class="resource-empty">资源轮询暂时不可用，稍后可重新打开介绍页再试。</div>';
    setResourceStatus(section, readableError(error), { muted: true });
  }
}

function castCard(person) {
  const avatar = imageUrl(person.profilePath, PROFILE_SIZE);
  return `
    <article class="cast-card">
      ${avatar ? `<img src="${avatar}" alt="${escapeHtml(person.name)}" loading="lazy" decoding="async" />` : '<div class="avatar-fallback">★</div>'}
      <strong>${escapeHtml(person.name)}</strong>
      <span>${escapeHtml(person.character || '')}</span>
    </article>
  `;
}

function readableError(error) {
  const message = error?.message || String(error || '未知错误');
  if (error?.code === 'MISSING_TMDB_CREDENTIAL' || message.includes('credential')) {
    return '缺少 TMDB 密钥，请点击右上角设置后粘贴 API Key 或 Read Access Token。';
  }
  if (error?.code === 'TMDB_AUTH_FAILED' || /401|Invalid API key|auth/i.test(message)) {
    return 'TMDB 密钥验证失败，请检查 API Key 或 Read Access Token。';
  }
  if (/fetch failed|network|ENOTFOUND|ECONN/i.test(message)) {
    return '网络连接失败，请稍后重试。';
  }
  if (/ERR_CONNECTION_TIMED_OUT|ERR_PROXY|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return message;
  }
  return message;
}

function applyWindowMode(payload = {}) {
  const mode = payload.mode || 'normal';
  const previousMode = state.windowMode;
  state.windowMode = mode;
  for (const target of [document.documentElement, document.body]) {
    target.classList.toggle('island-mode', mode === 'island');
    target.classList.toggle('island-expanded-mode', mode === 'island-expanded');
    target.classList.toggle('island-docked-mode', mode === 'island-docked');
    target.classList.toggle('normal-mode', mode === 'normal');
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      target.classList.toggle(`dock-edge-${edge}`, mode === 'island-docked' && payload.edge === edge);
    }
  }
  state.dockEdge = mode === 'island-docked' ? payload.edge : null;
  if (dom.islandDockHandle && mode === 'island-docked') {
    dom.islandDockHandle.setAttribute('aria-label', `${payload.edge || ''}边缘拉出灵动岛`);
  }
  if (mode === 'normal') {
    dom.globalSearch.blur();
  }
  if (mode === 'island-expanded' && previousMode !== 'island-expanded') {
    dom.searchSection.classList.remove('is-hidden');
    if (!dom.globalSearch.value.trim()) {
      dom.searchTitle.textContent = '灵动搜索';
      dom.searchHint.textContent = '输入片名 / 节目名、演员或心情';
      showRailEmpty(dom.searchRail, '输入想看的电影/节目氛围后，这里会下拉推荐。');
    }
  }
  if (mode === 'island' || mode === 'island-expanded' || mode === 'island-docked') {
    closeDetails();
    closeSettings();
    closeCloseChoice();
    if (mode !== 'island-docked') {
      setTimeout(() => dom.globalSearch.focus(), 180);
    }
  }
  if (mode !== 'island' && mode !== 'island-expanded' && mode !== 'island-docked') {
    cancelIslandDrag();
  }
  syncIslandRestoreButtonState({ mode });
}

function setupIslandAutoRestore() {
  dom.appShell?.addEventListener('scroll', () => {
    if (state.windowMode !== 'island-expanded' || state.islandAutoRestoreFrame) return;
    state.islandAutoRestoreFrame = requestAnimationFrame(() => {
      state.islandAutoRestoreFrame = 0;
      if (state.windowMode !== 'island-expanded') return;
      const remaining = dom.appShell.scrollHeight - dom.appShell.scrollTop - dom.appShell.clientHeight;
      if (remaining < 80) {
        restoreNormalAndFocusInputRecommendations();
      }
    });
  }, { passive: true });
}

function isPrimaryPointer(event) {
  return event.button === 0 || event.button === undefined;
}

function islandPointerPayload(event) {
  const screenX = Number(event?.screenX ?? state.islandPointer.lastX ?? state.islandPointer.startX ?? 0);
  const screenY = Number(event?.screenY ?? state.islandPointer.lastY ?? state.islandPointer.startY ?? 0);
  return {
    screenX: Math.round(Number.isFinite(screenX) ? screenX : 0),
    screenY: Math.round(Number.isFinite(screenY) ? screenY : 0)
  };
}


function canStartIslandDrag(event) {
  if (!['island', 'island-expanded', 'island-docked'].includes(state.windowMode)) return false;
  if (!isPrimaryPointer(event)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (state.windowMode === 'island-docked') return Boolean(target.closest('#islandDockHandle'));
  if (target.closest('button')) return false;
  return Boolean(target.closest('.titlebar, .search-box'));
}

function beginIslandDrag(event) {
  if (!canStartIslandDrag(event)) return;
  state.islandPointer.down = true;
  state.islandPointer.moved = false;
  state.islandPointer.startX = event.screenX;
  state.islandPointer.startY = event.screenY;
  state.islandPointer.lastX = event.screenX;
  state.islandPointer.lastY = event.screenY;
  state.islandPointer.source = state.windowMode;
  state.islandPointer.fromInput = Boolean(event.target instanceof Element && event.target.closest('input'));
  event.target?.setPointerCapture?.(event.pointerId);
  document.body.classList.add('is-island-dragging');
  api.islandDragBegin?.(islandPointerPayload(event));
  if (!state.islandPointer.fromInput) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function moveIslandDrag(event) {
  if (!state.islandPointer.down || !['island', 'island-expanded', 'island-docked'].includes(state.windowMode)) return;
  state.islandPointer.lastX = event.screenX;
  state.islandPointer.lastY = event.screenY;
  const dx = event.screenX - state.islandPointer.startX;
  const dy = event.screenY - state.islandPointer.startY;
  if (Math.hypot(dx, dy) > 4) {
    state.islandPointer.moved = true;
  }
  if (!state.islandPointer.moved) {
    if (!state.islandPointer.fromInput) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (!state.islandDragMoveFrame) {
    state.islandDragMoveFrame = requestAnimationFrame(() => {
      state.islandDragMoveFrame = 0;
      api.islandDragMove?.(islandPointerPayload());
    });
  }
  event.preventDefault();
  event.stopPropagation();
}

async function endIslandDrag(event) {
  if (!state.islandPointer.down) return;
  const payload = islandPointerPayload(event);
  const wasDrag = state.islandPointer.moved;
  const sourceMode = state.islandPointer.source;
  const fromInput = state.islandPointer.fromInput;
  let finalMoveSent = false;
  if (state.islandDragMoveFrame) {
    cancelAnimationFrame(state.islandDragMoveFrame);
    state.islandDragMoveFrame = 0;
    api.islandDragMove?.(payload);
    finalMoveSent = true;
  }
  event.target?.releasePointerCapture?.(event.pointerId);
  state.islandPointer.down = false;
  state.islandPointer.moved = false;
  state.islandPointer.lastX = payload.screenX;
  state.islandPointer.lastY = payload.screenY;
  state.islandPointer.source = null;
  state.islandPointer.fromInput = false;
  document.body.classList.remove('is-island-dragging');
  if (wasDrag || !fromInput) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!wasDrag && sourceMode === 'island-docked') {
    await api.enterIsland(72);
    applyWindowMode({ mode: 'island' });
    return;
  }

  if (!wasDrag) {
    await api.islandDragEnd?.(false, payload);
    return;
  }

  if (!finalMoveSent) {
    api.islandDragMove?.(payload);
  }
  const result = await api.islandDragEnd?.(true, payload);
  if (result?.mode === 'island-docked') {
    applyWindowMode({ mode: 'island-docked', edge: result.edge });
  }
}

function cancelIslandDrag() {
  if (!state.islandPointer.down) return;
  if (state.islandDragMoveFrame) {
    cancelAnimationFrame(state.islandDragMoveFrame);
    state.islandDragMoveFrame = 0;
  }
  state.islandPointer.down = false;
  state.islandPointer.moved = false;
  state.islandPointer.source = null;
  state.islandPointer.fromInput = false;
  document.body.classList.remove('is-island-dragging');
  api.islandDragEnd?.(false, islandPointerPayload()).then((result) => {
    if (result?.mode === 'island-docked') {
      applyWindowMode({ mode: 'island-docked', edge: result.edge });
    }
  }).catch(() => {});
}

function setupIslandInteraction() {
  document.addEventListener('pointerdown', beginIslandDrag, { capture: true });
  document.addEventListener('pointermove', moveIslandDrag, { capture: true });
  document.addEventListener('pointerup', endIslandDrag, { capture: true });
  document.addEventListener('pointercancel', cancelIslandDrag, { capture: true });
}

function shouldScrollSearchAfterIslandRestore() {
  return state.windowMode === 'island-expanded'
    && dom.searchSection
    && !dom.searchSection.classList.contains('is-hidden');
}

function setupIslandRestoreInteraction() {
  dom.islandRestoreBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    restoreNormalFromIsland({
      focusInputRecommendations: shouldScrollSearchAfterIslandRestore()
    });
  });

  dom.searchBox?.addEventListener('dblclick', (event) => {
    if (!isIslandLikeMode()) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, input')) return;
    restoreNormalFromIsland({
      focusInputRecommendations: shouldScrollSearchAfterIslandRestore()
    });
  });

  dom.islandDockHandle?.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    restoreNormalFromIsland({
      focusInputRecommendations: shouldScrollSearchAfterIslandRestore()
    });
  });
}

function escapeHtml(value) {
  return safeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function findMovieCard(target) {
  if (!(target instanceof Element)) return null;
  return target.closest('.movie-card');
}

function movieFromCard(card) {
  const contentKey = card?.dataset?.contentKey || (card?.dataset?.movieId ? contentKeyOf(card.dataset.movieId, card.dataset.mediaType || 'movie') : '');
  return contentKey ? state.cardMovies.get(String(contentKey)) : null;
}

function setupMovieCardDelegation() {
  if (document.documentElement.dataset.movieCardDelegation === 'true') return;
  document.documentElement.dataset.movieCardDelegation = 'true';

  document.addEventListener('click', (event) => {
    const card = findMovieCard(event.target);
    if (!card) return;
    const movie = movieFromCard(card);
    if (!movie) return;
    addClickedMovie(movie);
    openDetails(movie.id, movie);
  });

  document.addEventListener('mouseover', (event) => {
    const card = findMovieCard(event.target);
    const related = event.relatedTarget;
    if (!card || (related instanceof Node && card.contains(related))) return;
    const movie = movieFromCard(card);
    if (movie) preloadDetails(movie.id, mediaTypeOf(movie));
  }, { passive: true });

  document.addEventListener('focusin', (event) => {
    const card = findMovieCard(event.target);
    const movie = movieFromCard(card);
    if (movie) preloadDetails(movie.id, mediaTypeOf(movie));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = findMovieCard(event.target);
    const movie = movieFromCard(card);
    if (!movie) return;
    event.preventDefault();
    addClickedMovie(movie);
    openDetails(movie.id, movie);
  });
}

function bindEvents() {
  setupSearch();
  setupMovieCardDelegation();
  setupIslandAutoRestore();
  setupIslandInteraction();
  setupIslandRestoreInteraction();
  setupPlayerEvents();
  window.addEventListener('beforeunload', () => savePrefs({ immediate: true }));
  window.addEventListener('resize', syncDetailWaveMetrics, { passive: true });
  api.onWindowMode?.((payload) => applyWindowMode(payload));
  dom.dailyDetailBtn.addEventListener('click', () => state.daily && openDetails(state.daily.id, state.daily));
  dom.dailyLikeBtn.addEventListener('click', () => state.daily && likeMovie(state.daily));
  dom.detailCloseBtn.addEventListener('click', toggleDetailPanel);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.settingsCloseBtn.addEventListener('click', closeSettings);
  dom.saveSettingsBtn.addEventListener('click', saveSettings);
  dom.testConnectionBtn.addEventListener('click', testConnection);
  dom.clearSettingsBtn.addEventListener('click', clearSettings);
  dom.refreshBtn.addEventListener('click', async () => {
    state.railCache.clear();
    state.railCachePending.clear();
    toast('正在刷新推荐');
    await loadInitial();
  });

  dom.settingsModal.addEventListener('click', (event) => {
    if (event.target === dom.settingsModal) closeSettings();
  });

  document.addEventListener('pointerdown', closeDetailsFromBlankArea);

  document.addEventListener('keydown', (event) => {
    if (isIslandLikeMode() && (event.key === 'Escape' || (event.altKey && event.key === 'Enter'))) {
      event.preventDefault();
      restoreNormalFromIsland({
        focusInputRecommendations: shouldScrollSearchAfterIslandRestore()
      });
      return;
    }
    if (event.key === 'Escape') {
      if (state.player.open) {
        closeResourcePlayer();
        return;
      }
      closeDetails();
      closeSettings();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dom.globalSearch.focus();
    }
  });

  dom.closeChoiceModal.addEventListener('click', (event) => {
    if (event.target === dom.closeChoiceModal) closeCloseChoice();
  });
  dom.closeToIslandBtn.addEventListener('click', async () => {
    closeCloseChoice();
    applyWindowMode({ mode: 'island' });
    await api.enterIsland(72);
  });
  dom.exitAppBtn.addEventListener('click', () => api.close());
  dom.cancelCloseBtn.addEventListener('click', closeCloseChoice);

  dom.minBtn.addEventListener('click', async () => {
    applyWindowMode({ mode: 'island' });
    await api.minimize();
  });
  dom.maxBtn.addEventListener('click', () => api.maximize());
  dom.closeBtn.addEventListener('click', openCloseChoice);
}

initStartupSplashCanvas();
bindEvents();
syncResourceSettings();
loadInitial();





'use strict';

const MOVIE_GENRES = {
  28: '动作',
  12: '冒险',
  16: '动画',
  35: '喜剧',
  80: '犯罪',
  99: '纪录',
  18: '剧情',
  10751: '家庭',
  14: '奇幻',
  36: '历史',
  27: '恐怖',
  10402: '音乐',
  9648: '悬疑',
  10749: '爱情',
  878: '科幻',
  10770: '电视电影',
  53: '惊悚',
  10752: '战争',
  37: '西部'
};

const TV_GENRES = {
  10759: '动作冒险',
  16: '动画',
  35: '喜剧',
  80: '犯罪',
  99: '纪录',
  18: '剧情',
  10751: '家庭',
  10762: '儿童',
  9648: '悬疑',
  10763: '新闻',
  10764: '真人秀',
  10765: '科幻奇幻',
  10766: '肥皂剧',
  10767: '脱口秀',
  10768: '战争政治',
  37: '西部'
};

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

function toIdList(ids) {
  if (!Array.isArray(ids)) {
    if (typeof ids === 'string' && ids.trim()) return ids.split(',').map(Number).filter(Number.isFinite);
    return [];
  }
  return ids.map(Number).filter(Number.isFinite);
}

function genreNameOf(id, mediaType = 'movie') {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return '';
  const primary = mediaType === 'tv' ? TV_GENRES : MOVIE_GENRES;
  const secondary = mediaType === 'tv' ? MOVIE_GENRES : TV_GENRES;
  if (primary[numeric]) return primary[numeric];
  if (secondary[numeric]) return secondary[numeric];
  for (const alias of MOVIE_TV_GENRE_ALIASES[numeric] || []) {
    if (primary[alias]) return primary[alias];
    if (secondary[alias]) return secondary[alias];
  }
  return '';
}

function genreNamesFromIds(ids, mediaType = 'movie') {
  const out = [];
  const seen = new Set();
  for (const numeric of toIdList(ids)) {
    const name = genreNameOf(numeric, mediaType);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

module.exports = {
  MOVIE_GENRES,
  TV_GENRES,
  MOVIE_TV_GENRE_ALIASES,
  genreNameOf,
  genreNamesFromIds
};

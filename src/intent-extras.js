export const EXTRA_SEARCH_PROMPTS = [
  '适合大雪天窝着看的？',
  '心情有点烦躁，想被治愈的？',
  '出差路上 / 飞机上打发时间的？',
  '周末大扫除当背景音的？',
  '朋友聚会想热闹一下的？',
  '一个人小酌配点什么的？'
];

export const EXTRA_PROMPT_INTENTS = [
  {
    label: '晴日清爽',
    patterns: ['晴天', '大晴天', '阳光', '好天气', '阳光明媚', '晒太阳', '春游', '踏青', '野餐', '郊游', '户外', '散步', '遛弯', '春日', '风和日丽'],
    genreIds: [35, 16, 10751, 10749, 12],
    genreGroups: [[35], [16, 10751], [10749], [12]],
    withoutGenreIds: [27, 53],
    sortBy: 'popularity.desc'
  },
  {
    label: '阴天絮语',
    patterns: ['阴天', '多云', '灰蒙', '起雾', '大雾', '迷雾天', '潮湿', '回南天', '梅雨', '湿冷', '惆怅', '寡淡'],
    genreIds: [18, 9648, 10749],
    genreGroups: [[18], [9648], [18, 10749]],
    withoutGenreIds: [27],
    sortBy: 'vote_average.desc',
    minRating: 6.5
  },
  {
    label: '雪夜寒冬',
    patterns: ['下雪', '雪天', '初雪', '冬天', '冬日', '寒冷', '严寒', '雪地', '滑雪', '暴风雪', '圣诞', '飘雪'],
    genreIds: [18, 10751, 14, 10749],
    genreGroups: [[18], [10751], [14], [10749, 18]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '风雨风暴',
    patterns: ['大风', '台风', '暴风雨', '风暴', '雷阵雨', '打雷', '闪电', '电闪雷鸣', '暴雨'],
    genreIds: [12, 28, 9648, 53],
    genreGroups: [[12], [28], [12, 9648], [28, 53]],
    sortBy: 'popularity.desc'
  },
  {
    label: '炎炎夏日',
    patterns: ['夏天', '炎热', '酷暑', '高温', '消暑', '纳凉', '暑假', '泳池', '海边', '海滩', '冲浪', '海岛', '烈日'],
    genreIds: [12, 14, 10749, 35],
    genreGroups: [[12], [10749], [35], [14]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '焦躁求治愈',
    patterns: ['焦虑', '烦躁', '心烦', '压力大', '内耗', '自闭', 'emo了', '难过', '郁闷', '不开心', '想被治愈', '疗愈', '平静', '静心', '心累'],
    genreIds: [16, 35, 10751, 10402],
    genreGroups: [[16], [35], [10751], [10402]],
    withoutGenreIds: [27, 53, 80],
    sortBy: 'popularity.desc'
  },
  {
    label: '无聊杀时间',
    patterns: ['无聊', '打发时间', '杀时间', '摸鱼', '划水', '放空', '随便看看', '都行', '剧荒', '不知道看什么'],
    genreIds: [35, 16, 12, 9648],
    genreGroups: [[35], [16], [12], [9648]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '打起精神',
    patterns: ['励志', '打鸡血', '鸡血', '干劲', '冲刺', '逆袭', '奋斗', '拼搏', '振作', '燃一下', '打起精神', '重新开始'],
    genreIds: [18, 28, 36],
    genreGroups: [[18], [28], [18, 36], [18, 28]],
    sortBy: 'vote_average.desc',
    minRating: 6.8
  },
  {
    label: '愤怒发泄',
    patterns: ['生气', '愤怒', '火大', '暴躁', '窝火', '出气', '发泄', '气死我了'],
    genreIds: [28, 53, 80],
    genreGroups: [[28], [53], [80], [28, 53]],
    sortBy: 'popularity.desc'
  },
  {
    label: '心碎碎片',
    patterns: ['失恋', '分手', '心碎', '白月光', '意难平', '放不下', '舔狗', '复合'],
    genreIds: [18, 10749],
    genreGroups: [[18], [10749], [18, 10749]],
    withoutGenreIds: [27],
    sortBy: 'vote_average.desc',
    minRating: 6.8
  },
  {
    label: '怀旧青春',
    patterns: ['怀旧', '复古', '童年', '小时候', '青春', '校园', '年代感', '旧时光', '80年代', '90年代', '千禧', '学生时代'],
    genreIds: [18, 10749, 35, 16],
    genreGroups: [[18], [10749], [16], [35]],
    sortBy: 'vote_average.desc',
    minRating: 6.8
  },
  {
    label: '好奇探索',
    patterns: ['好奇', '揭秘', '未知', '探索', '冷知识', '涨知识', '真实事件', '大开眼界', '长见识'],
    genreIds: [99, 9648, 12],
    genreGroups: [[99], [9648], [99, 12]],
    sortBy: 'popularity.desc'
  },
  {
    label: '出差远行',
    patterns: ['出差', '酒店', '宾馆', '民宿', '候机', '飞机上', '高铁', '火车', '大巴', '长途', '倒时差', '绿皮车', '候车'],
    genreIds: [35, 12, 16, 14],
    genreGroups: [[35], [12], [14], [16]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '通勤路上',
    patterns: ['通勤', '地铁', '公交', '上下班', '坐车', '堵车', '挤地铁', '班车'],
    genreIds: [35, 16, 12],
    genreGroups: [[35], [16], [12]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '公路露营',
    patterns: ['自驾', '公路旅行', '公路', '露营', '徒步', '登山', '爬山', '旅行', '旅游', '度假', '国家公园', '野餐旅行'],
    genreIds: [12, 14, 99],
    genreGroups: [[12], [99], [14], [12, 99]],
    withoutGenreIds: [27],
    sortBy: 'popularity.desc'
  },
  {
    label: '小酌夜宵',
    patterns: ['喝酒', '小酌', '独酌', '下酒', '酒吧', '夜宵', '烧烤', '大排档', '配酒', '微醺'],
    genreIds: [80, 53, 35, 18],
    genreGroups: [[80], [53], [35], [18]],
    sortBy: 'popularity.desc'
  },
  {
    label: '朋友聚会',
    patterns: ['聚会', '团建', '派对', '轰趴', '闺蜜', '兄弟', '几个朋友', '多人一起', '一起看', '热闹'],
    genreIds: [35, 28, 14, 12],
    genreGroups: [[35], [28], [14], [12]],
    sortBy: 'popularity.desc'
  },
  {
    label: '家务背景音',
    patterns: ['打扫', '做家务', '收拾', '整理', '洗衣服', '做饭', '烹饪', '边做边看', '当背景音', '大扫除', '拖地'],
    genreIds: [99, 35, 10402, 10764],
    genreGroups: [[99], [35], [10402], [10764]],
    withoutGenreIds: [27, 53],
    sortBy: 'popularity.desc'
  }
];

export const EXTRA_NEGATIVE_HINTS = [
  { patterns: ['不要爱情', '不想看爱情', '别爱情', '不谈情说爱', '没有爱情'], genreIds: [10749] },
  { patterns: ['不要纪录片', '别纪录片', '不想看纪录片'], genreIds: [99] },
  { patterns: ['不要动画', '别动画', '不想看动画'], genreIds: [16] },
  { patterns: ['不要战争', '别战争', '不想看战争'], genreIds: [10752, 36] },
  { patterns: ['不要悲伤', '不想伤感', '别虐'], genreIds: [18] }
];

export function applyIntentExtras(intents, prompts, negatives) {
  if (Array.isArray(intents)) intents.push(...EXTRA_PROMPT_INTENTS);
  if (Array.isArray(prompts)) prompts.push(...EXTRA_SEARCH_PROMPTS);
  if (Array.isArray(negatives)) negatives.push(...EXTRA_NEGATIVE_HINTS);
}

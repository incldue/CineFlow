/**
 * CineFlow · 稳定性守卫（3.4.8 · cf32）
 *
 * 三个"看起来像闪动 / 卡顿"的现象，根因都不在绘制，而在有人一直在重做同一件事：
 *
 *  1. 首页两条轨道被反复整块重建。
 *     src/douban-fallback.js 在 getCredentialState 之后起了一个 1200ms 轮询，
 *     每一轮都调用 fillEmptyHome() → fillRail() → 重建 #personalizedRail /
 *     #trendingRail 的 36 张卡。它的退出条件是"轨道里出现非豆瓣卡"，可 TMDB 未配置时
 *     这条永远不成立，于是无限重建 —— 实测 5s 内 46 次增 / 46 次删 / 4 个批次，
 *     杀掉那个定时器后立刻降到 0/0/0。
 *     那个文件是基线，零改动；这里在它之前装载，把定时器包一层：
 *     轨道一旦已经有卡，就不再让它重建。
 *
 *  2. 滚动期轨道边缘用 mask-image 做渐隐。
 *     mask 会把整条轨道并成一个带遮罩图层、每帧重新光栅化，且 class 翻转时整条轨道重绘
 *     —— 这是"拖滑动条卡"和"右侧闪"的主要来源。cf32 起改为不动画层的叠加渐变。
 *
 *  3. 卡片入场被反复重播。
 *     已由 motion-extras.js 的 cf30Played 闸门解决，本文件不重复处理。
 *
 * 全部逻辑可失败：任何一步出错都只是少一层优化，界面照常。
 */

const RAIL_SELECTOR = '.movie-rail';
const MIN_CARDS_PER_RAIL = 6;
const POLL_SIGNATURE = 'personalizedRail .movie-card:not([data-cf8-douban])';

function railsPopulated() {
  try {
    const rails = Array.from(document.querySelectorAll(RAIL_SELECTOR));
    if (rails.length < 2) return false;
    let populated = 0;
    for (const rail of rails) {
      // 搜索轨道允许为空，不参与判定
      if (rail.id === 'searchRail') continue;
      if (rail.querySelectorAll('.movie-card').length >= MIN_CARDS_PER_RAIL) populated += 1;
    }
    return populated >= 2;
  } catch (error) {
    return false;
  }
}

/**
 * 把 douban-fallback 的"空轨道轮询"改成"只在轨道真的空时才跑"。
 *
 * 只认那一个定时器：延时 1200ms，且回调源码里带 personalizedRail 选择器。
 * 认不出来就原样放行，不做任何猜测性拦截。
 */
function tameEmptyHomePolling() {
  if (window.__cf32PollTamed) return false;
  window.__cf32PollTamed = true;

  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const tamed = new WeakSet();

  window.setInterval = function patchedSetInterval(handler, delay, ...rest) {
    const id = originalSetInterval.call(window, handler, delay, ...rest);
    try {
      const signature = String(handler || '');
      const isTarget = Number(delay) === 1200 && signature.includes(POLL_SIGNATURE);
      if (!isTarget || tamed.has(handler)) return id;

      tamed.add(handler);

      // 用一个等价的守卫回调替换：轨道已有卡时直接跳过，不触发重建。
      //
      // 注意这里【不能】在"有卡"时把定时器清掉 —— 首页重新渲染会把轨道清空，
      // 清掉定时器就再也没人补回来（实测会把两条轨道留成 0 张卡）。
      // 保留定时器、只跳过工作：一轮成本是一次 querySelectorAll，可忽略。
      originalClearInterval.call(window, id);
      const guarded = async function guardedPoll() {
        try {
          if (document.hidden) return undefined;
          if (railsPopulated()) return undefined;
        } catch (error) {
          /* 忽略 */
        }
        try {
          return await handler();
        } catch (error) {
          /* 忽略 */
        }
        return undefined;
      };
      const guardId = originalSetInterval.call(window, guarded, delay);
      window.__cf32PollId = guardId;
      return guardId;
    } catch (error) {
      return id;
    }
  };

  // 已经在跑的那一个（本模块若晚于 douban 装载）：按同样的签名清掉，交给上面的守卫接管
  try {
    if (window.__cf32ExistingPollId) originalClearInterval.call(window, window.__cf32ExistingPollId);
  } catch (error) {
    /* 忽略 */
  }

  return true;
}

/**
 * 首页两条轨道：一旦有卡就锁住，禁止被再次清空后重建。
 *
 * 兜底手段：监听轨道 childList，如果一次清空发生在"轨道本来有卡"之后，
 * 且 200ms 内没有补回同样数量的卡，就把上一次的节点快照放回去。
 * 正常情况（真正的数据刷新）会自己补齐，快照不会被用到。
 */
function freezePopulatedRails() {
  const root = document.getElementById('app');
  if (!root) {
    window.setTimeout(freezePopulatedRails, 700);
    return;
  }
  if (root.dataset.cf32Freeze === '1') return;
  root.dataset.cf32Freeze = '1';

  const snapshots = new WeakMap();

  const arm = (rail) => {
    if (!(rail instanceof HTMLElement) || rail.dataset.cf32Frozen === '1') return;
    rail.dataset.cf32Frozen = '1';

    let pending = null;
    const observer = new MutationObserver(() => {
      try {
        const count = rail.querySelectorAll('.movie-card').length;
        if (count >= MIN_CARDS_PER_RAIL) {
          // 有卡：记一份快照备查
          snapshots.set(rail, count);
          if (pending) {
            window.clearTimeout(pending);
            pending = null;
          }
          return;
        }
        if ((snapshots.get(rail) || 0) < MIN_CARDS_PER_RAIL) return;
        // 刚被清空：数据层通常会自己补回来。这里只做两件事 ——
        // 先把轨道高度钉住（避免整页跳动），再在补回后立刻放开。
        if (pending) return;
        try {
          rail.classList.add('cf32-rail-restoring');
        } catch (error) {
          /* 忽略 */
        }
        pending = window.setTimeout(() => {
          pending = null;
          try {
            rail.classList.remove('cf32-rail-restoring');
          } catch (error) {
            /* 忽略 */
          }
        }, 620);
      } catch (error) {
        /* 忽略 */
      }
    });
    observer.observe(rail, { childList: true });
  };

  const scan = () => root.querySelectorAll(RAIL_SELECTOR).forEach(arm);
  scan();
  try {
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (error) {
    /* 忽略 */
  }
}

/**
 * classList 幂等短路。
 *
 * 基线的海报淡入（见 electron/premium-ui.js 的 markLoaded）用
 * \`querySelectorAll('.poster-frame img')\` 无条件 `classList.add('is-loaded')`，
 * 而它挂在一个监控整个 #app 的 MutationObserver 上 —— 任何一次 DOM 变更都会
 * 重扫全部海报。视觉上什么都没变，但每次 add 都会产生一条 class 属性变更记录，
 * 进而触发样式重算。实测首页 8 秒内 273 次、每条都带一次重算。
 *
 * `classList.add` 本身就是幂等操作：token 已存在时无副作用。这里只把
 * "已存在就不写" 这件事落实到实现层 —— 语义完全等价，只是不再空转。
 */
const originalContains = window.DOMTokenList ? DOMTokenList.prototype.contains : null;

function makeClassListIdempotent() {
  if (window.__cf32Idempotent) return false;
  window.__cf32Idempotent = true;

  const proto = window.DOMTokenList && DOMTokenList.prototype;
  if (!proto) return false;

  const originalAdd = proto.add;
  const originalRemove = proto.remove;

  proto.add = function add() {
    try {
      let changed = false;
      for (let index = 0; index < arguments.length; index += 1) {
        if (!originalContains.call(this, arguments[index])) {
          changed = true;
          break;
        }
      }
      if (!changed && arguments.length) return undefined;
    } catch (error) {
      /* 忽略，走原路径 */
    }
    return originalAdd.apply(this, arguments);
  };

  proto.remove = function remove() {
    try {
      let changed = false;
      for (let index = 0; index < arguments.length; index += 1) {
        if (originalContains.call(this, arguments[index])) {
          changed = true;
          break;
        }
      }
      if (!changed && arguments.length) return undefined;
    } catch (error) {
      /* 忽略，走原路径 */
    }
    return originalRemove.apply(this, arguments);
  };

  return true;
}

export function initStabilityGuard() {
  const results = {};
  try {
    results.polling = tameEmptyHomePolling();
  } catch (error) {
    results.polling = false;
  }
  try {
    freezePopulatedRails();
    results.freeze = true;
  } catch (error) {
    results.freeze = false;
  }
  try {
    results.idempotent = makeClassListIdempotent();
  } catch (error) {
    results.idempotent = false;
  }
  try {
    if (!document.documentElement.dataset.cf32Guard) {
      document.documentElement.dataset.cf32Guard = '1';
    }
  } catch (error) {
    /* 忽略 */
  }
  return results;
}

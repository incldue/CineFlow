
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
      originalClearInterval.call(window, id);
      const guarded = async function guardedPoll() {
        try {
          if (document.hidden) return undefined;
          if (railsPopulated()) return undefined;
        } catch (error) {
        }
        try {
          return await handler();
        } catch (error) {
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

  try {
    if (window.__cf32ExistingPollId) originalClearInterval.call(window, window.__cf32ExistingPollId);
  } catch (error) {
    /* 忽略 */
  }

  return true;
}

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
          }
        }, 620);
      } catch (error) {
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

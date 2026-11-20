
const subscribers = new Set();
let frameHandle = 0;
let started = false;

function flush(now) {
  frameHandle = 0;
  if (!subscribers.size) return;
  const list = [];
  for (const sub of subscribers) {
    if (sub.active !== false) list.push(sub);
  }
  if (!list.length) return;

  // ---- 读相位：所有布局读取先做完 ----
  const results = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const sub = list[i];
    if (typeof sub.read !== 'function') continue;
    try {
      results[i] = sub.read(now);
    } catch (error) {
      results[i] = undefined;
    }
  }

  // ---- 写相位：只写样式，绝不读布局 ----
  for (let i = 0; i < list.length; i += 1) {
    const sub = list[i];
    if (typeof sub.write !== 'function') continue;
    try {
      sub.write(results[i], now);
    } catch (error) {
      /* 装饰层失败不影响任何交互 */
    }
  }
}

/** 请求下一帧执行一次。同一帧内多次调用只排一次。 */
export function requestTick() {
  if (frameHandle) return;
  try {
    frameHandle = window.requestAnimationFrame(flush);
  } catch (error) {
    frameHandle = window.setTimeout(() => flush(Date.now()), 16);
  }
}

/**
 * 注册一个订阅者。sub = { read?(now), write?(result, now), active? }
 * 返回取消函数。
 */
export function subscribe(sub) {
  if (!sub || typeof sub !== 'object') return () => {};
  subscribers.add(sub);
  requestTick();
  return () => {
    subscribers.delete(sub);
  };
}

export function startScheduler() {
  if (started) return;
  started = true;
}

export function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

/** 递归收集 root 下所有 shadow root 之外的元素（本项目无 shadow DOM，占位以便扩展）。 */
export function supportsIntersectionObserver() {
  return typeof window.IntersectionObserver === 'function';
}

/**
 * 视口门控包装。回调只在进入/离开视口时触发，不产生每帧开销。
 * options: { rootMargin, threshold, onEnter(el), onLeave(el), willChange }
 */
export function watchVisible(el, options = {}) {
  if (!el) return () => {};
  const {
    rootMargin = '0px',
    threshold = 0,
    onEnter,
    onLeave,
    willChange = ''
  } = options;

  if (!supportsIntersectionObserver()) {
    // 没有 IntersectionObserver 就退化为「一直可见」，动效照跑
    try {
      if (willChange) el.style.setProperty('will-change', willChange);
      onEnter?.(el);
    } catch (error) {
      /* 忽略 */
    }
    return () => {
      try {
        if (willChange) el.style.removeProperty('will-change');
        onLeave?.(el);
      } catch (error) {
        /* 忽略 */
      }
    };
  }

  let visible = false;
  let observer = null;

  const enter = () => {
    if (visible) return;
    visible = true;
    try {
      if (willChange) el.style.setProperty('will-change', willChange);
      onEnter?.(el);
    } catch (error) {
      /* 忽略 */
    }
  };

  const leave = () => {
    if (!visible) return;
    visible = false;
    try {
      if (willChange) el.style.removeProperty('will-change');
      onLeave?.(el);
    } catch (error) {
      /* 忽略 */
    }
  };

  try {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enter();
        else leave();
      }
    }, { rootMargin, threshold });
    observer.observe(el);
  } catch (error) {
    enter();
  }

  return () => {
    try {
      observer?.disconnect();
    } catch (error) {
      /* 忽略 */
    }
    leave();
  };
}

/** 监听任意滚动容器（含不冒泡的元素滚动），统一走调度器合帧。 */
export function onScrollCapture(handler) {
  const listener = (event) => {
    try {
      handler(event);
    } catch (error) {
      /* 忽略 */
    }
  };
  // scroll 不冒泡，但捕获阶段仍然沿祖先链派发 → 用 capture 一网打尽
  document.addEventListener('scroll', listener, { passive: true, capture: true });
  return () => document.removeEventListener('scroll', listener, { capture: true });
}

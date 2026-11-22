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

  for (let i = 0; i < list.length; i += 1) {
    const sub = list[i];
    if (typeof sub.write !== 'function') continue;
    try {
      sub.write(results[i], now);
    } catch (error) {

    }
  }
}

export function requestTick() {
  if (frameHandle) return;
  try {
    frameHandle = window.requestAnimationFrame(flush);
  } catch (error) {
    frameHandle = window.setTimeout(() => flush(Date.now()), 16);
  }
}

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

export function supportsIntersectionObserver() {
  return typeof window.IntersectionObserver === 'function';
}

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

    try {
      if (willChange) el.style.setProperty('will-change', willChange);
      onEnter?.(el);
    } catch (error) {

    }
    return () => {
      try {
        if (willChange) el.style.removeProperty('will-change');
        onLeave?.(el);
      } catch (error) {

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

    }
  };

  const leave = () => {
    if (!visible) return;
    visible = false;
    try {
      if (willChange) el.style.removeProperty('will-change');
      onLeave?.(el);
    } catch (error) {

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

    }
    leave();
  };
}

export function onScrollCapture(handler) {
  const listener = (event) => {
    try {
      handler(event);
    } catch (error) {

    }
  };

  document.addEventListener('scroll', listener, { passive: true, capture: true });
  return () => document.removeEventListener('scroll', listener, { capture: true });
}

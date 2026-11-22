const SCROLL_IDLE_MS = 420;
const DORMANT_AFTER_MS = 900;
const SCROLL_CLASS = 'cf33-scroll';
const DORMANT_CLASS = 'cf33-dormant';

const PAGE_SELECTOR = '.cf3-page';

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) {
    return false;
  }
}

function watchScrollActivity() {
  const body = document.body;
  if (!body) return false;
  let timer = 0;

  const engage = () => {

    try {
      if (body.classList.contains('splash-active')) return;
    } catch (error) {

    }
    try {
      if (!body.classList.contains(SCROLL_CLASS)) body.classList.add(SCROLL_CLASS);
    } catch (error) {

    }
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      try {
        body.classList.remove(SCROLL_CLASS);
      } catch (error) {

      }
    }, SCROLL_IDLE_MS);
  };

  try {
    document.addEventListener('scroll', engage, { capture: true, passive: true });
    document.addEventListener('wheel', engage, { capture: true, passive: true });
    document.addEventListener('touchmove', engage, { capture: true, passive: true });
  } catch (error) {
    return false;
  }

  window.__cf33Engage = engage;
  return true;
}

function armDormantPages() {
  const pages = Array.from(document.querySelectorAll(PAGE_SELECTOR));

  if (!pages.length) {
    if (window.__cf33DormantWatch) return false;
    window.__cf33DormantWatch = true;
    try {
      const root = document.getElementById('app') || document.body;
      const observer = new MutationObserver(() => {
        if (!document.querySelector(PAGE_SELECTOR)) return;
        observer.disconnect();
        window.__cf33DormantWatch = false;
        try {
          armDormantPages();
        } catch (error) {

        }
      });
      observer.observe(root, { childList: true, subtree: true });
    } catch (error) {

    }

    [400, 1200, 2600].forEach((delay) => {
      window.setTimeout(() => {
        if (document.querySelector(PAGE_SELECTOR) && window.__cf33DormantWatch) {
          window.__cf33DormantWatch = false;
          try {
            armDormantPages();
          } catch (error) {

          }
        }
      }, delay);
    });
    return false;
  }

  if (window.__cf33DormantArmed) return true;
  window.__cf33DormantArmed = true;

  const timers = new WeakMap();

  const wake = (page) => {
    const pending = timers.get(page);
    if (pending) {
      window.clearTimeout(pending);
      timers.delete(page);
    }
    if (page.classList.contains(DORMANT_CLASS)) page.classList.remove(DORMANT_CLASS);
  };

  const wakeAll = () => pages.forEach(wake);

  pages.forEach((page) => {

    const isHidden = () => {
      const opacity = page.style.opacity;
      if (opacity === '1') return false;
      if (opacity === '0') return true;

      return !page.classList.contains('is-current');
    };

    const evaluate = () => {
      try {
        if (!isHidden()) {
          wake(page);
          return;
        }
        if (page.classList.contains(DORMANT_CLASS) || timers.has(page)) return;
        const timer = window.setTimeout(() => {
          timers.delete(page);
          try {
            if (isHidden() && page.isConnected) page.classList.add(DORMANT_CLASS);
          } catch (error) {

          }
        }, DORMANT_AFTER_MS);
        timers.set(page, timer);
      } catch (error) {

      }
    };

    evaluate();

    try {
      new MutationObserver(evaluate).observe(page, { attributes: true, attributeFilter: ['style'] });
    } catch (error) {

    }
  });

  try {
    document.addEventListener('keydown', wakeAll, { capture: true, passive: true });
    document.addEventListener('pointerdown', wakeAll, { capture: true, passive: true });
    document.addEventListener('focusin', wakeAll, { capture: true, passive: true });
  } catch (error) {

  }

  return true;
}

export function initResponseBoost() {
  const results = {};
  try {
    if (document.documentElement.dataset.cf33Boost === '1') return { cached: true };
    document.documentElement.dataset.cf33Boost = '1';
  } catch (error) {

  }

  results.reducedMotion = prefersReducedMotion();
  if (!results.reducedMotion) {
    try {
      results.scroll = watchScrollActivity();
    } catch (error) {
      results.scroll = false;
    }
  } else {
    results.scroll = false;
  }

  try {
    results.dormant = armDormantPages();
  } catch (error) {
    results.dormant = false;
  }

  return results;
}

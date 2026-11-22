const COPY_BTN_SELECTOR = '#playerCopyBtn';
const WATCH_FLAG = 'cf38PlayerActions';

let bound = false;
const diag = { removed: 0 };

function strip(root) {
  try {
    const host = root instanceof Element || root instanceof Document ? root : document;
    const buttons = host.querySelectorAll?.(COPY_BTN_SELECTOR);
    if (!buttons || !buttons.length) return;
    for (const button of buttons) {
      try {

        button.replaceWith?.();
        button.remove();
        diag.removed += 1;
      } catch (error) {

        try { button.hidden = true; } catch (e) {  }
      }
    }
  } catch (error) {

  }
}

function bind() {
  if (bound) return true;
  if (document.documentElement.dataset[WATCH_FLAG] === '1') return true;
  try {
    document.documentElement.dataset[WATCH_FLAG] = '1';

    strip(document);

    try {
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.id === 'playerCopyBtn' || node.querySelector?.(COPY_BTN_SELECTOR)) {
              strip(document);
              return;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (error) {

    }

    window.setTimeout(() => strip(document), 1200);
    window.setTimeout(() => strip(document), 3600);

    Object.defineProperty(window, '__cf38', {
      configurable: true,
      value: { playerActions: diag, strip: () => strip(document) }
    });

    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 播放器操作栏清理装配失败，已跳过', error); } catch (e) {  }
    return false;
  }
}

export function initPlayerActionCleanup() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf38PlayerActionsInternals = { COPY_BTN_SELECTOR };

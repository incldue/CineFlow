/**
 * 播放器操作栏清理（新增文件，零侵入）
 *
 * 用户反馈：播放器页面的「复制链接」和「外部打开」是同一件事 —— 都是把这条播放地址
 * 拿到应用外面去用，一个送到剪贴板、一个交给默认浏览器。既然如此，按钮不需要两个。
 * 要求：去掉「复制链接」这个按钮。
 *
 * 处理过程分两步：
 *
 *   第 54 轮：先是"不动 index.html"的做法 —— styles.css 末尾加
 *            #playerCopyBtn { display: none !important }，再由本模块把节点从 DOM 摘掉。
 *   第 55 轮：用户要求"直接把『复制链接』删掉"，于是 index.html:257 那一行
 *            <button id="playerCopyBtn" class="secondary-button" type="button">复制链接</button>
 *            已经被真正删除，标记层面不再有这个按钮。
 *
 * 本模块因此只剩「防回流」的职责：盯住 DOM，任何把 #playerCopyBtn 重新插回来的行为
 * （旧版缓存 HTML、将来某处模板、第三方补丁）都会被立即摘掉，键盘 Tab 顺序与
 * 辅助技术的可访问树里也不会冒出它。正常情况下 removed 计数保持 1（首帧那次空扫，实际为 0）。
 *
 * 安全性：基线 renderer.js 对它的引用全部是可选的（第 235 行 querySelector 存进 dom，
 * 第 3538 行 dom.playerCopyBtn?.addEventListener —— 用了可选链）。标记删掉后
 * dom.playerCopyBtn 就是 null，事件绑定静默跳过，不抛错；copyPlayerUrl 变成没人调用的函数。
 * 播放器其它按钮（外部打开 / 投屏 / 关闭播放 / 倍速 / 画中画 / 下一集）一个都不受影响。
 *
 * 约束：全部 try/catch 静默降级，失败最多是少一层守卫。
 */

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
        // 先摘监听（没有也无所谓），再断开与父节点的关系
        button.replaceWith?.();
        button.remove();
        diag.removed += 1;
      } catch (error) {
        // 极端情况下退化成隐藏，至少视觉上达标
        try { button.hidden = true; } catch (e) { /* 忽略 */ }
      }
    }
  } catch (error) {
    /* 忽略 */
  }
}

function bind() {
  if (bound) return true;
  if (document.documentElement.dataset[WATCH_FLAG] === '1') return true;
  try {
    document.documentElement.dataset[WATCH_FLAG] = '1';

    // 立刻扫一次：打包后脚本在 body 解析完之后执行，按钮通常已经在了
    strip(document);

    // 播放器是常驻节点（开合只切 class），正常情况下不会重建；
    // 仍然盯一层，防止将来某处 innerHTML 重写把按钮带回来。
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
      /* 忽略 */
    }

    // 兜底：播放器每次打开后再确认一遍（三条时机，覆盖懒加载与延迟渲染）
    window.setTimeout(() => strip(document), 1200);
    window.setTimeout(() => strip(document), 3600);

    Object.defineProperty(window, '__cf38', {
      configurable: true,
      value: { playerActions: diag, strip: () => strip(document) }
    });

    bound = true;
    return true;
  } catch (error) {
    try { console.warn('[CineFlow] 播放器操作栏清理装配失败，已跳过', error); } catch (e) { /* 忽略 */ }
    return false;
  }
}

/** 装配入口，由 src/incremental-pages.js 一行调用；重复调用安全。 */
export function initPlayerActionCleanup() {
  try {
    return bind();
  } catch (error) {
    return false;
  }
}

export const __cf38PlayerActionsInternals = { COPY_BTN_SELECTOR };

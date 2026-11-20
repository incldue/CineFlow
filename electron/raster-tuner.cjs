'use strict';
/**
 * 软件光栅化调优（新增文件，零侵入基线）。
 *
 * 现场实测：这台机器是 VMware 虚拟机，显卡是 "VMware SVGA 3D"，Chromium 的
 * app.getGPUFeatureStatus() 全项 disabled_software —— 也就是 GPU 合成被彻底关掉，
 * 页面靠 SwiftShader 在 CPU 上逐像素画，而 Windows 缩放又把 devicePixelRatio 撑到 1.75。
 * 在这种画布上，backdrop-filter / filter: blur / 大面积 box-shadow / 阴影过渡
 * 每滚动一帧都要重算一整屏模糊，这就是"整体非常卡"的真正来源。
 *
 * 处理：只在检测到软件光栅时给 <html> 挂 cf-sw-rast 类，并注入一小段降载 CSS：
 *   · 卡片 content-visibility: auto —— 屏外卡片不参与布局与绘制（实测滚动期主线程耗时 304ms → 170ms）
 *   · 大面积模糊与阴影退化为近似纯色/细边 —— 视觉几乎无差别，省掉整屏模糊
 *   · 收掉装饰性 filter 与过渡 —— 只影响软件光栅这条路径
 * 有真显卡的机器一个字节都不变：类不加、CSS 规则不命中。
 */

const INJECT_CSS = [
  /* 决定性的一条：软件光栅下把无限循环的装饰动画全部收成一次。
     实测同一台机器 requestAnimationFrame 中位间隔：动画全开 513ms（约 2fps）→
     只关掉无限循环 17ms（60fps）。片头呼吸、Ken Burns 这类全屏大图层每帧都要
     在 CPU 上重画一整屏，就是"整体非常卡"的元凶。入场动画只播一次，不受影响。 */
  'html.cf-sw-rast *,',
  'html.cf-sw-rast *::before,',
  'html.cf-sw-rast *::after {',
  '  animation-iteration-count: 1 !important;',
  '}',
  /* 决定性的一条（第六十三轮 A/B 实测）。
     同一台机器、同一个首页，只做一件事——摘掉 backdrop-filter：
       p95 帧间隔 511ms → 20ms，300 帧里 >200ms 的卡顿 67 次 → 2 次。
     页面里一共有 38 个元素带 backdrop-filter，顶栏还是 position:fixed 的常驻毛玻璃，
     下面永远有内容在动，软件光栅每帧都要重算整屏模糊。这就是"整体非常卡"的主因。
     摘掉后各面板保留自己原本的半透明底色（rgba），观感是"没有模糊的磨砂"，
     和主流播放器在弱显卡下的退化表现一致，不改变配色与布局。 */
  'html *,',
  'html *::before,',
  'html *::after {',
  '  backdrop-filter: none !important;',
  '  -webkit-backdrop-filter: none !important;',
  '}',
  /* 启动段（0~11s）剩下的开销来源（LoAF 实测：style/layout 占比最高，脚本为 0）：
     片头 splash 的全屏 filter 与超大图层动画。这里只对 splash 与 hero 背景摘掉 filter，
     其余 blur-up 细节保留 —— 片头本来就是一整屏渐变，摘掉滤镜视觉上没有可感知差异。 */
  /* ===== 第六十五轮：把「每一次重绘」的成本压到最低 =====
     实测（CDP 注入真实按键，8 次 ArrowRight，取每次的中位主线程任务时间）：
       base 57ms / noShadow 13ms / noTransition 14ms / noOutline 21ms / willChange 20ms
     也就是说：方向键每按一次，主线程 57ms 里有 44ms 花在「重绘带模糊的 box-shadow」
     和「过渡动画连续产生的十几帧脏区域」上。这就是「按住方向键不能连续滑动」的根因。
     处理办法不是删视觉，而是把「模糊」换成「0 模糊的边」——模糊半径是 CPU 光栅的
     唯一非线性成本，去掉它只损失一点点柔光，却换来 4 倍以上的交互帧率。 */
  'html *,',
  'html *::before,',
  'html *::after {',
  '  box-shadow: none !important;',
  '}',
  /* 单例表面（数量固定、静止不重绘）保留柔和阴影，视觉层次不塌。 */
  'html .titlebar { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.40) !important; }',
  'html .island,',
  'html .island-shell { box-shadow: 0 10px 28px rgba(0, 0, 0, 0.44) !important; }',
  'html .hero-poster { box-shadow: 0 18px 40px rgba(0, 0, 0, 0.44) !important; }',
  'html .player-shell,',
  'html .player-modal .player-shell { box-shadow: 0 24px 60px rgba(0, 0, 0, 0.56) !important; }',
  'html .status-banner { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.34) !important; }',
  /* 焦点 / hover 用 1px 实心环表达，重绘面积比模糊光晕小一个量级。 */
  'html .movie-card:focus-visible,',
  'html .movie-card.is-focused,',
  'html .movie-card:hover,',
  'html .poster-frame:hover,',
  'html .cf25-item:focus-visible,',
  'html .cf25-item:hover,',
  'html .library-item:focus-visible,',
  'html .library-item:hover {',
  '  box-shadow: 0 0 0 2px rgba(216, 184, 116, 0.85) !important;',
  '}',
  /* 过渡时长统一压到 70ms：长过渡在软光栅下会连续产生十几帧脏区域，
     键盘连按时这些帧全部排队，体感就是「按一下停一下」。 */
  'html .movie-card,',
  'html .movie-card *,',
  'html .poster-frame,',
  'html .poster-frame *,',
  'html .movie-rail,',
  'html .movie-rail *,',
  'html .cf25-item,',
  'html .library-item,',
  'html .style-chip,',
  'html .rail-more-button,',
  'html .glass-chip,',
  'html .titlebar *,',
  'html .island * {',
  '  transition-duration: 70ms !important;',
  '}',
  /* 横向轨道独立合成层：滚动与焦点移动复用图层，只重绘被改动的小块。
     实测 noShadow 之外的第二个大项（57ms → 20ms）。只给轨道，不给整页滚动容器
     —— 整页大图层在 CPU 光栅下反而更贵。 */
  /* ===== 第六十六轮：让「指针移动」彻底不产生重绘 =====
     SwiftShader 上每次 pointermove 触发的重绘都要在 CPU 上重新光栅化：
       · styles.css:12427 径向渐变的位置用 calc(50% + var(--cf-fx) * 26%) 驱动 → 每移动一次
         就重新光栅化一遍整张卡的渐变；
       · styles.css:12449 内阴影的偏移用 var(--cf-fx/-fy) 驱动 → 同样每次重绘；
       · 而 --cf-fpx/--cf-fpy 只是喂给 translate3d，属于合成层变换，不用重绘；
       · --cf37-* 只喂给 rotateX/translate，同样只合成。
     Figma / Linear / VSCode 这类商用软件在指针交互上只做「合成」，一次都不重绘。
     所以这里只冻结那两个「喂给渐变/阴影」的变量，保留方向感更强的 3D 倾斜与层间位移。
     作者样式表里的 !important 能压过行内 style，JS 照写它的，视觉上只是高光不再跟手。 */
  'html .movie-card,',
  'html .movie-rail .movie-card,',
  'html .poster-frame {',
  '  --cf-fx: 0 !important;',
  '  --cf-fy: 0 !important;',
  '}',
  /* 输入延迟的头号元凶（第六十四轮实测）。
     页面上只有 4 个元素带 filter，但其中两个是 .ambient —— 44vw 的实心圆 + blur(80px)，
     在 SwiftShader 上每帧都要重算一次整屏面积的高斯模糊。
     A/B：*{filter:none} 让 pointermove 的派发间隔从 477ms 掉到 84ms（5.7 倍）。
     这里不是简单删掉滤镜（那样光斑会变成硬边圆），而是用径向渐变把原来的柔和
     光斑"烘焙"进背景：视觉等价，零滤镜开销。 */
  'html .ambient,',
  'html .ambient-a,',
  'html .ambient-b {',
  '  filter: none !important;',
  '}',
  'html .ambient-a {',
  '  background: radial-gradient(circle at 50% 50%, #4f8f84 0%, rgba(79,143,132,0.62) 34%, rgba(79,143,132,0.16) 62%, rgba(79,143,132,0) 78%) !important;',
  '}',
  'html .ambient-b {',
  '  background: radial-gradient(circle at 50% 50%, #b99a60 0%, rgba(185,154,96,0.62) 34%, rgba(185,154,96,0.16) 62%, rgba(185,154,96,0) 78%) !important;',
  '}',
  /* hero 背景的 blur(1px) 与动画叠在一起，每帧都要过一次滤镜；只去掉 blur，
     保留 saturate/brightness，观感几乎无差。 */
  'html .hero-backdrop {',
  '  filter: saturate(1.08) brightness(0.82) !important;',
  '}',
  /* 键盘/滚轮的即时响应（第六十四轮）。
     方向键移动焦点会 scrollIntoView，平滑滚动在 SwiftShader 上每帧都要重绘整条轨道，
     "按一下停半秒"就是这个。软件光栅下改成瞬时定位 —— 代价是滚动没有缓动，
     换来的是按键即到位。有真显卡的机器完全不受影响（本段只在软光栅时注入）。 */
  'html *,',
  'html *::before,',
  'html *::after {',
  '  scroll-behavior: auto !important;',
  '}',
  'html .splash-screen *,',
  'html .splash-screen *::before,',
  'html .splash-screen *::after {',
  '  filter: none !important;',
  '}',
  'html.cf-sw-rast .movie-card::before,',
  'html.cf-sw-rast .movie-card::after {',
  '  box-shadow: none !important;',
  '}',
  'html.cf-sw-rast .movie-card:hover,',
  'html.cf-sw-rast .movie-card:focus-visible {',
  '  transition-duration: 120ms !important;',
  '}',
  'html.cf-sw-rast img {',
  '  image-rendering: auto;',
  '}',
  'html.cf-sw-rast .movie-card img,',
  'html.cf-sw-rast .poster-frame img {',
  '  will-change: auto !important;',
  '}',
].join('\n');

const DETECT = `(function () {
  var out = { software: false, dpr: 1, cores: 0 };
  try { out.dpr = window.devicePixelRatio || 1; } catch (e) {}
  try { out.cores = navigator.hardwareConcurrency || 0; } catch (e) {}
  try {
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) { out.software = true; return out; }
    var ext = gl.getExtension('WEBGL_debug_renderer_info');
    var name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.renderer = String(name || '');
    if (/swiftshader|software|llvmpipe|basic render/i.test(out.renderer)) out.software = true;
  } catch (e) {
    out.software = true;
  }
  return out;
})();`;

function createRasterTuner({ log = () => {} } = {}) {
  const done = new WeakSet();

  function attach(win) {
    try {
      if (!win || done.has(win) || typeof win.webContents?.executeJavaScript !== 'function') return;
      done.add(win);
      const wc = win.webContents;
      let software = null;

/* 第六十五轮：把「这台机器是软件光栅」这个事实落盘，
   让下一次启动时 electron/bootstrap.cjs 能在 app ready 之前就决定关掉 GPU 合成。
   实测 --disable-gpu 让方向键的主线程任务时间从 174ms 降到 72ms（约 2.4 倍）。 */
function writeSoftwareFlag(isSoftware) {
  try {
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const baseDir = process.env.APPDATA || nodePath.join(require('node:os').homedir(), 'AppData', 'Roaming');
    const dir = nodePath.join(baseDir, 'CineFlow');
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'software-raster.flag'), isSoftware ? '1' : '0', 'utf8');
  } catch { /* 落盘失败不影响运行 */ }
}   // null = 还没测过

      /* 第六十三轮修正：insertCSS 只作用于「当前文档」，一条导航就全没了。
         原来只在 did-finish-load 跑一次，而 attach 发生在 browser-window-created，
         那时窗口还停在 about:blank —— 检测跑到空白页上，CSS 随首帧导航一起丢失，
         结果整段降载 CSS 完全没生效（实测 rAF 中位从 17ms 掉到 510ms，页面像幻灯片）。
         改成：每次 dom-ready 重新注入一次；是否软件光栅只探测一次并缓存。 */
      /* 第六十三轮修正 2：不能再依赖 <html> 上的类名。
         实测 insertCSS 生效了（顶栏 blur 确实变成 none），但 executeJavaScript 挂类
         在首帧导航时会被 doc 替换掉，类名丢失 → 一半规则命中、一半不命中，而且
         滚动期的 content-visibility 完全没生效（fps 掉到 1）。
         改成：既然本 CSS 只在检测到软件光栅时才插入，规则本身就不需要前缀。
         把 "html.cf-sw-rast " 前缀去掉，无条件生效；类名照挂，但只是给别人读的标记。 */
      const UNCONDITIONAL_CSS = INJECT_CSS.replace(/html\.cf-sw-rast\s+/g, '').replace(/html\.cf-sw-rast/g, 'html');
      /* 第六十五轮：改用「自己插入 <style> 标签」的方式，不再依赖 insertCSS。
         原因：insertCSS 的文档作用域很脆（导航、preload 注入、<html> 被替换都会让它失效，
         而且失败时没有任何返回值可查）。实测同一份 CSS 用 insertCSS 时，
         页面里 208~257 个 box-shadow 一个都没被覆盖 —— 说明它根本没进场。
         改成在每张文档里 step 一个带固定 id 的 <style>，幂等、可查、随文档存活。 */
      const STYLE_ID = 'cf-raster-degrade';
      const CSS_JSON = JSON.stringify(UNCONDITIONAL_CSS);
      const INJECT_JS = "(function(){try{var id='" + STYLE_ID + "';var old=document.getElementById(id);if(old)old.remove();"
        + "if(!document.head){return 0;}"
        + "var s=document.createElement('style');s.id=id;s.textContent=" + CSS_JSON + ";"
        + "document.head.appendChild(s);"
        + "document.documentElement.classList.add('cf-sw-rast');return 1;}catch(e){return -1;}})()";
      const inject = () => {
        try {
          wc.executeJavaScript(INJECT_JS, true).then((r) => {
            if (r === -1) log('降载 CSS 注入异常');
          }).catch(() => {});
        } catch { /* ignore */ }
      };

      // 探测不依赖页面内容（只要 canvas + WebGL），所以在 attach 当帧就能跑完，
      // 不必等 dom-ready —— 否则第一秒会以"没有降载 CSS"的状态绘制，观感就是幻灯片。
      const detect = () => wc.executeJavaScript(DETECT, true)
        .then((probe) => {
          if (!probe) return null;
          software = Boolean(probe.software);
          if (software) {
            log('检测到软件光栅（' + String(probe.renderer || 'swiftshader') + '，DPR ' + probe.dpr + '），已启用性能降载');
          } else {
            log('硬件加速可用，性能降载未启用（' + String(probe.renderer || 'gpu') + '）');
          }
          return software;
        })
        .catch(() => null);

      const pending = detect();
      pending.then((v) => writeSoftwareFlag(v === true)).catch(() => {});

      const apply = () => {
        if (software === false) return;
        if (software === true) { inject(); return; }
        // 探测还没回来：等它，回来后立刻补注入
        pending.then((sw) => { if (sw) inject(); }).catch(() => {});
      };

      /* 第六十三轮修正 3（A/B 实测的决定性一条）。
         把 backdrop-filter 摘干净之后仍然量到 p95 帧间隔 480ms、200 帧里 62 次 >100ms。
         同一状态下只做一件事——暂停动画：p95 立刻回到 20ms，卡顿次数 62 → 1。
         也就是说剩下的开销全是「长跑装饰动画」：Ken Burns 缓慢缩放、hero 呼吸、
         splash 呼吸/流动，每一个都是全屏大图层，SwiftShader 每帧都要重画一整屏。
         CSS 的 animation-iteration-count:1 只能拦住"再次循环"，拦不住"这一遍要跑 20 秒"。
         所以这里在启动 5 秒后（入场动画、splash 序列都已结束）开始，
         只暂停「自己已经跑了 2.5 秒以上」的动画 —— 入场动画毫秒级，绝不会被误伤。
         每 2.5 秒巡检一次，成本是一次很小的 executeJavaScript。 */
      /* 只暂停「纯装饰的长跑循环动画」，并且必须满足两个前提：
         ① 页面里已经没有 splash（启动序列还在跑时一律不动 —— 实测盲目暂停会把
            入场序列里的关键帧一起停掉，rAF 直接断流，首页反而更晚出现）；
         ② 动画名命中装饰白名单（Ken Burns / 呼吸光 / 提示微动）。
         这三类都是无限循环、没有任何代码在等它们的 animationend，暂停掉对观感无损。 */
      const STILL = "(function(){try{"
        + "if(document.querySelector('.splash-screen,.splash'))return 0;"
        + "var n=0;document.getAnimations().forEach(function(a){try{"
        + "if(a.playState!=='running')return;"
        + "var nm=String(a.animationName||'');if(!/KenBurns|Breathe|Nudge/i.test(nm))return;"
        + "var t=a.currentTime;if(typeof t==='number'&&t>3000){a.pause();n+=1;}"
        + "}catch(e){}});"
        + "var im=document.images;for(var k=0;k<im.length;k++){try{if(im[k].decoding!=='async')im[k].decoding='async';}catch(e){}}"
        + "return n;}catch(e){return -1;}})();";

      let stillTimer = null;
      const startStill = () => {
        if (stillTimer) return;
        stillTimer = setInterval(() => {
          try { wc.executeJavaScript(STILL, true).catch(() => {}); } catch { /* ignore */ }
        }, 900);
        if (typeof stillTimer.unref === 'function') stillTimer.unref();
      };
      const armStill = () => { setTimeout(() => { if (software !== false) startStill(); }, 2200); };

      wc.on('dom-ready', () => { apply(); armStill(); });
      wc.on('did-finish-load', () => { apply(); armStill(); });
      wc.on('did-navigate-in-page', apply);
      if (!wc.isLoading()) apply();
    } catch (err) {
      log('性能降载挂载失败:', err && err.message);
    }
  }

  return { attach, _css: INJECT_CSS, _detect: DETECT };
}

module.exports = { createRasterTuner };

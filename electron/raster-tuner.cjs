'use strict';

const INJECT_CSS = [

  'html.cf-sw-rast *,',
  'html.cf-sw-rast *::before,',
  'html.cf-sw-rast *::after {',
  '  animation-iteration-count: 1 !important;',
  '}',

  'html *,',
  'html *::before,',
  'html *::after {',
  '  backdrop-filter: none !important;',
  '  -webkit-backdrop-filter: none !important;',
  '}',

  'html *,',
  'html *::before,',
  'html *::after {',
  '  box-shadow: none !important;',
  '}',

  'html .titlebar { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.40) !important; }',
  'html .island,',
  'html .island-shell { box-shadow: 0 10px 28px rgba(0, 0, 0, 0.44) !important; }',
  'html .hero-poster { box-shadow: 0 18px 40px rgba(0, 0, 0, 0.44) !important; }',
  'html .player-shell,',
  'html .player-modal .player-shell { box-shadow: 0 24px 60px rgba(0, 0, 0, 0.56) !important; }',
  'html .status-banner { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.34) !important; }',

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

  'html .movie-card,',
  'html .movie-rail .movie-card,',
  'html .poster-frame {',
  '  --cf-fx: 0 !important;',
  '  --cf-fy: 0 !important;',
  '}',

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

  'html .hero-backdrop {',
  '  filter: saturate(1.08) brightness(0.82) !important;',
  '}',

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

function writeSoftwareFlag(isSoftware) {
  try {
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const baseDir = process.env.APPDATA || nodePath.join(require('node:os').homedir(), 'AppData', 'Roaming');
    const dir = nodePath.join(baseDir, 'CineFlow');
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'software-raster.flag'), isSoftware ? '1' : '0', 'utf8');
  } catch {  }
}

      const UNCONDITIONAL_CSS = INJECT_CSS.replace(/html\.cf-sw-rast\s+/g, '').replace(/html\.cf-sw-rast/g, 'html');

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
        } catch {  }
      };

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

        pending.then((sw) => { if (sw) inject(); }).catch(() => {});
      };

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
          try { wc.executeJavaScript(STILL, true).catch(() => {}); } catch {  }
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

// Vivimusic Web+ additions to upstream's fluid background (kawarp.js, kawarp-bg.js)
// and audio graph (equalizer.js). Content script, loaded right after kawarp.js and
// before kawarp-bg.js and equalizer.js. Kept out of upstream's files so merges stay
// clean; kawarp-bg.js and equalizer.js call in through `// vivi+ hook` lines.
(() => {
  'use strict';

  // ── kawarp.js: Firefox render targets ──
  // Firefox requires EXT_color_buffer_half_float to be enabled before a half-float
  // texture can be used as a render target (Chrome enables it implicitly). Without
  // it the FBO is incomplete and the whole animation renders black. Enabled on the
  // context's first framebuffer, before any half-float target is made.
  const Kawarp = window.Kawarp;
  if (typeof Kawarp === 'function') {
    const createFramebuffer = Kawarp.prototype.createFramebuffer;
    Kawarp.prototype.createFramebuffer = function (width, height, useHighPrecision = false) {
      const gl = this.gl;
      if (!this.__viviColorBufferExt) {
        this.__viviColorBufferExt = true;
        gl.getExtension('EXT_color_buffer_half_float');
        gl.getExtension('WEBGL_color_buffer_float');
      }
      const canUseHalfFloat = useHighPrecision && this.halfFloatExt && this.halfFloatLinearExt;
      const fbo = createFramebuffer.call(this, width, height, useHighPrecision);
      // Safety net: if this driver can't render to half-float, redo it as
      // 8-bit instead of silently drawing nothing. (fbo is still bound here.)
      if (canUseHalfFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbo.texture, 0);
        this.halfFloatExt = null; // later FBOs go straight to 8-bit
      }
      return fbo;
    };
  }

  // ── kawarp-bg.js: animate only in the full player ──
  // Firefox: every backdrop-filter surface (nav bar, tabs, cards...) has to be
  // re-blurred on EVERY frame while the canvas animates behind it, and
  // WebRender then drops tiles/text (sidebar streaks, stray lines, text-less
  // chips). So animate only while the full player is open (the theme already
  // turns those blurs off there) and hold a still frame on Home/Search/etc.
  // Set to true to animate everywhere again (glitches may return in Firefox).
  const ANIMATE_OUTSIDE_PLAYER = false;
  function playerPageOpen() {
    return !!document.querySelector('ytmusic-app-layout[player-page-open], #layout[player-page-open]');
  }
  // Start/stop the loop to match the current state. When stopping, make sure a
  // frame is on the canvas so the still background is not blank.
  // allowed = kawarp-bg's own rule: enabled, and not paused for a hidden tab.
  function sync(kawarp, allowed) {
    if (!kawarp) return;
    if (allowed && (ANIMATE_OUTSIDE_PLAYER || playerPageOpen())) {
      if (!kawarp.isPlaying) kawarp.start();
    } else if (kawarp.isPlaying) {
      kawarp.stop();
    }
    try { if (!kawarp.isPlaying && kawarp.hasImage) kawarp.renderFrame(kawarp.accumulatedTime); } catch (_) {}
  }

  // Firefox blocks the CORS image request from the page context for some
  // YouTube thumbnail hosts, so fetch the bytes through the background page
  // (host permissions, no CORS) and load them from a same-origin blob: URL —
  // which also keeps the WebGL texture untainted. Falls back to upstream's loader.
  function relayLoad(loadImgDirect) {
    return async function loadImg(src) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'VIVI_FETCH', url: src });
        if (resp?.ok && resp.status >= 200 && resp.status < 300 && resp.body) {
          const bin = atob(resp.body);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const type = (resp.headers && resp.headers['content-type']) || 'image/jpeg';
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          try {
            return await new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('blob decode failed'));
              img.src = url;
            });
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          }
        }
      } catch (e) { /* fall through to direct load */ }
      return loadImgDirect(src);
    };
  }

  window.__viviKawarpPlus = {
    relayLoad,
    // state() -> [kawarp instance, allowed]. Returns the sync function kawarp-bg calls
    // after each of its own start() calls, and follows the full player opening/closing.
    follow(state) {
      const run = () => { const [kawarp, allowed] = state(); sync(kawarp, allowed); };
      new MutationObserver(run).observe(document.documentElement, {
        attributes: true, subtree: true, attributeFilter: ['player-page-open']
      });
      return run;
    },
  };

  // ── equalizer.js: Automix filters between the crossfade gate and the EQ ──
  let xf = null;
  window.__viviEqPlus = {
    // Builds gate → bass → high → high-pass → low-pass and returns the last node,
    // which equalizer.js connects to the EQ's entry in place of the gate.
    chain(audioCtx, xfGate) {
      const xfBassFilter = audioCtx.createBiquadFilter();
      xfBassFilter.type = 'lowshelf';
      xfBassFilter.frequency.value = 250;
      xfBassFilter.gain.value = 0;
      // Automix (BitChord's deck): high-shelf cross, and the filter mix's
      // high- and low-pass. All flat / open unless a blend is running.
      const xfHighFilter = new BiquadFilterNode(audioCtx, { type: 'highshelf', frequency: 4000, gain: 0 });
      // at rest exactly transparent: Web Audio's high-pass at 0 Hz and low-pass at Nyquist pass the
      // samples through unchanged (20 Hz / 20 kHz were still filters, on every song)
      const xfHighpass = new BiquadFilterNode(audioCtx, { type: 'highpass', frequency: 0, Q: 0.7 });
      const xfLowpass = new BiquadFilterNode(audioCtx, { type: 'lowpass', frequency: audioCtx.sampleRate / 2, Q: 0.7 });
      xfGate.connect(xfBassFilter);
      xfBassFilter.connect(xfHighFilter);
      xfHighFilter.connect(xfHighpass);
      xfHighpass.connect(xfLowpass);
      xf = { bassFilter: xfBassFilter, highFilter: xfHighFilter, highpass: xfHighpass, lowpass: xfLowpass };
      return xfLowpass;
    },
    // Adds those nodes to window.__viviAudioGraph, plus mix (before the safety
    // compressor) and out (what the graph plays; for tests).
    // Same object shape as before: the filters sit just before `entry`.
    publish(graph, masterGain, compressor) {
      const out = {};
      for (const [key, value] of Object.entries(graph)) {
        if (key === 'entry') Object.assign(out, xf);
        out[key] = value;
      }
      window.__viviAudioGraph = Object.assign(out, { mix: masterGain, out: compressor });
    },
  };
})();

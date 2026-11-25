// Vivimusic Web+ additions to upstream's audio graph (equalizer.js). Content script,
// loaded before equalizer.js. Kept out of upstream's file so merges stay clean;
// equalizer.js calls in through `// vivi+ hook` lines.
(() => {
  'use strict';

  // ── equalizer.js: Automix filters between the crossfade gate and the EQ ──
  let xf = null;
  window.__viviEqPlus = {
    // Builds gate → bass → mid → high → high-pass → low-pass and returns the last node,
    // which equalizer.js connects to the EQ's entry in place of the gate.
    chain(audioCtx, xfGate) {
      const xfBassFilter = audioCtx.createBiquadFilter();
      xfBassFilter.type = 'lowshelf';
      xfBassFilter.frequency.value = 250;
      xfBassFilter.gain.value = 0;
      // Automix (BitChord's deck): high-shelf cross, and the filter mix's
      // high- and low-pass. All flat / open unless a blend is running.
      const xfHighFilter = new BiquadFilterNode(audioCtx, { type: 'highshelf', frequency: 4000, gain: 0 });
      // a drawn mid band (editor.md §12): a peaking filter at 0 dB passes the samples through unchanged
      const xfMidFilter = new BiquadFilterNode(audioCtx, { type: 'peaking', frequency: 1000, Q: 0.7, gain: 0 });
      // at rest exactly transparent: Web Audio's high-pass at 0 Hz and low-pass at Nyquist pass the
      // samples through unchanged (20 Hz / 20 kHz were still filters, on every song)
      const xfHighpass = new BiquadFilterNode(audioCtx, { type: 'highpass', frequency: 0, Q: 0.7 });
      const xfLowpass = new BiquadFilterNode(audioCtx, { type: 'lowpass', frequency: audioCtx.sampleRate / 2, Q: 0.7 });
      xfGate.connect(xfBassFilter);
      xfBassFilter.connect(xfMidFilter);
      xfMidFilter.connect(xfHighFilter);
      xfHighFilter.connect(xfHighpass);
      xfHighpass.connect(xfLowpass);
      xf = { bassFilter: xfBassFilter, midFilter: xfMidFilter, highFilter: xfHighFilter, highpass: xfHighpass, lowpass: xfLowpass };
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
      out.limit = limitFor(graph.ctx, compressor, out);
    },
  };

  // versions.md "The mix's ceiling": a look-ahead limiter (src/automix/limiter-worklet.js) after the safety
  // compressor, the last node before the speakers. Engaged only while a mix runs; otherwise it passes every
  // sample as it is. Until its module loads (a moment after the graph is built) the compressor plays directly;
  // once it is in, graph.out is the limiter (what the speakers get). If anything fails, the compressor keeps
  // playing directly. One limiter per audio context.
  // limit(true | false); limit.report = (minGainDb) => {} is told the most it took off, when it lets go.
  const limits = new WeakMap();
  function limitFor(ctx, compressor, graph) {
    if (limits.has(ctx)) return limits.get(ctx);
    let node = null, want = false, splice = null;
    const limit = (on) => {
      want = !!on;
      // a mix starting before the limiter could go in unheard: it goes in now, blended (see below)
      if (want && splice) splice(true);
      node?.port.postMessage({ engaged: want });
    };
    limits.set(ctx, limit);
    const fail = (e) => { limit.failed = e?.message || String(e); console.debug('[ViVi] limiter not loaded:', limit.failed); };
    if (!ctx.audioWorklet?.addModule || typeof AudioWorkletNode !== 'function') { fail('no AudioWorklet'); return limit; }
    Promise.resolve().then(() => ctx.audioWorklet.addModule(chrome.runtime.getURL('src/automix/limiter-worklet.js'))).then(() => {
      const n = new AudioWorkletNode(ctx, 'vivi-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      n.port.onmessage = (e) => { if (e.data?.minGainDb != null) limit.report?.(e.data.minGainDb); };
      // The limiter delays the sound by its 5 ms look-ahead, so putting it in while a song plays would skip
      // 5 ms. It goes in while nothing is heard: at once when the context is not running yet or the song is
      // paused (the usual case: the graph is built before the first play), else at the next pause, song
      // change or context stop. If a mix starts first, it goes in under a 30 ms blend of the two paths
      // (a short comb, no skip or click).
      const video = graph.video;
      const quiet = () => ctx.state !== 'running' || !video || video.paused || video.ended || !(video.readyState >= 2);
      const EVENTS = ['pause', 'emptied', 'loadstart', 'ended'];
      const unhook = () => {
        for (const ev of EVENTS) video?.removeEventListener(ev, onQuiet);
        ctx.removeEventListener?.('statechange', onQuiet);
      };
      function onQuiet() { if (splice && quiet()) splice(false); }
      splice = (blend) => {
        splice = null; unhook();
        if (ctx.state === 'closed') return;
        try {
          if (blend && ctx.state === 'running') {
            const t = ctx.currentTime, T = 0.03;
            const direct = new GainNode(ctx, { gain: 1 }), wet = new GainNode(ctx, { gain: 0 });
            // (connects and disconnects in one task take effect in the same render quantum)
            compressor.connect(direct).connect(ctx.destination);
            compressor.disconnect(ctx.destination);
            compressor.connect(n).connect(wet).connect(ctx.destination);
            direct.gain.setValueAtTime(1, t); direct.gain.linearRampToValueAtTime(0, t + T);
            wet.gain.setValueAtTime(0, t); wet.gain.linearRampToValueAtTime(1, t + T);
            // then the plain path: limiter straight to the speakers
            setTimeout(() => {
              try {
                n.connect(ctx.destination);
                n.disconnect(wet); wet.disconnect();
                compressor.disconnect(direct); direct.disconnect();
              } catch { /* the context went away */ }
            }, 200);
          } else {
            compressor.connect(n).connect(ctx.destination);
            compressor.disconnect(ctx.destination);
          }
        } catch (e) {
          // back to the compressor alone, so the page never plays twice or goes silent
          try { compressor.disconnect(); } catch { /* not connected */ }
          try { n.disconnect(); } catch { /* not connected */ }
          compressor.connect(ctx.destination);
          fail(e);
          return;
        }
        node = n;
        node.port.postMessage({ engaged: want });
        graph.out = node;
        limit.ready = true;
        limit.splicedBy = blend ? 'blend' : 'quiet';
        console.info(`[ViVi] limiter in the graph (${blend ? 'blended in at a mix start' : 'while nothing played'})`);
      };
      if (quiet()) splice(false);
      else if (want) splice(true);
      else {
        for (const ev of EVENTS) video?.addEventListener(ev, onQuiet);
        ctx.addEventListener?.('statechange', onQuiet);
      }
    }).catch(fail);
    return limit;
  }
})();

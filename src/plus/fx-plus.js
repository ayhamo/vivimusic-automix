// Vivimusic Web+ additions to upstream's audio graph (equalizer.js). Content script,
// loaded before equalizer.js. Kept out of upstream's file so merges stay clean;
// equalizer.js calls in through `// vivi+ hook` lines.
(() => {
  'use strict';

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

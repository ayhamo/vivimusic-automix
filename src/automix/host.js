/* VIVIMUSIC WEB — automix/host.js  (hidden extension iframe inside YouTube Music)
 *
 * A content script cannot start a Worker from an extension URL in Firefox
 * (the worker would belong to music.youtube.com and be refused), so the
 * analysis worker lives here, in an extension-origin frame.
 *
 * For a whole song this frame does BitChord's analyzer.ts work itself
 * (decode at 44.1 kHz, mono mix, the Beat This! windows at 22.05 kHz, the
 * vocal-mask windows), off YouTube Music's main thread, and keeps every
 * result in IndexedDB under its video id, as BitChord does: a song is
 * analysed once, whatever browser session it comes back in.
 */
(() => {
  'use strict';
  const PARENT_ORIGIN = 'https://music.youtube.com';
  const ANALYSIS_SR = 44100;          // RhythmExtractor2013 assumes 44.1 kHz
  const BEAT_SR = 22050;              // Beat This! input
  const BEAT_WINDOW_SEC = 59;         // two model chunks: the opening and the end
  const VOCAL_WINDOW_SEC = (958 * 1024) / 44100;   // open-unmix's fixed input, ~22.2 s
  // BitChord's ANALYSIS_VERSION (8), plus ours: a change to either redoes the cache.
  const ANALYSIS_VERSION = 'bc8.v1';
  let worker = null, fitWorker = null;
  const jobs = new Map();   // fileKey -> resolve, for songs analysed here

  const reply = (msg, transfer) => parent.postMessage({ ch: 'vivi-automix', ...msg }, PARENT_ORIGIN, transfer || []);

  function start() {
    worker = new Worker(chrome.runtime.getURL('src/vendor/automix/analysis.worker.js'), { type: 'module' });
    worker.onmessage = (e) => {
      const job = jobs.get(e.data?.fileKey);
      if (job) { jobs.delete(e.data.fileKey); job(e.data); return; }
      reply(e.data);
    };
    worker.onerror = (e) => reply({ type: 'fatal', message: String(e?.message || 'worker error') });
    worker.postMessage({
      type: 'init',
      wasmUrl: chrome.runtime.getURL('src/vendor/automix/ort-wasm-simd-threaded.wasm'),
      modelUrl: chrome.runtime.getURL('src/vendor/automix/beat_this_final0_q8.onnx'),
      vocalModelUrl: chrome.runtime.getURL('src/vendor/automix/vocals_umxhq_int8.onnx'),
    });
  }

  // ───────── cache (BitChord db.ts: getAnalysis / putAnalysis) ─────────
  let dbp = null;
  function db() {
    dbp ??= new Promise((resolve) => {
      try {
        const open = indexedDB.open('vivi-automix', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('analysis', { keyPath: 'fileKey' });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);   // private window: no cache, analysis still works
      } catch { resolve(null); }
    });
    return dbp;
  }
  async function getCached(id) {
    const d = await db();
    if (!d) return null;
    return new Promise((resolve) => {
      try {
        const r = d.transaction('analysis').objectStore('analysis').get(id);
        r.onsuccess = () => resolve(r.result && r.result.analysisVersion === ANALYSIS_VERSION ? r.result : null);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function putCached(a) {
    const d = await db();
    if (!d) return;
    try { d.transaction('analysis', 'readwrite').objectStore('analysis').put(a); } catch { /* full or gone: no cache */ }
  }

  // The popup's "Clear" for saved analyses.
  try {
    chrome.storage.onChanged.addListener(async (ch, area) => {
      if (area !== 'local' || !ch.automixCacheClearedAt?.newValue) return;
      const d = await db();
      if (!d) return;
      try { d.transaction('analysis', 'readwrite').objectStore('analysis').clear(); } catch { /* gone */ }
    });
  } catch { /* no storage API here */ }

  function downmixToMono(buffer) {
    const channels = buffer.numberOfChannels;
    if (channels === 1) return buffer.getChannelData(0).slice();
    const out = new Float32Array(buffer.length);
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
    }
    return out;
  }

  // Where the music ends (BitChord phone, audio_analysis.cpp contentEnd): RMS
  // in 0.25 s windows; a trailing run under the silence level of 0.35 s or
  // more ends it where that run starts; otherwise it is the end of the last
  // 1.5 s block that is still mostly playing. Used by Automix version 2, so
  // a blend isn't laid over a song's trailing silence. null: unmeasurable.
  function contentEnd(mono, sr) {
    const win = Math.round(0.25 * sr);
    const n = Math.floor(mono.length / win);
    if (n < 12) return null;
    const env = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      let ss = 0, c = 0;
      for (let i = w * win, e = i + win; i < e; i += 4) { ss += mono[i] * mono[i]; c++; }
      env[w] = Math.sqrt(ss / c);
    }
    const sorted = Float32Array.from(env).sort();
    const ref = sorted[Math.floor(n * 0.85)], noise = sorted[Math.floor(n * 0.05)];
    if (!(ref > 0)) return null;
    const thr = Math.max(0.0025, Math.min(noise * 2.6, ref * 0.28), ref * 0.1);
    const silence = Math.max(0.0015, Math.min(thr * 0.25, ref * 0.04));
    let w = n;
    while (w > 0 && env[w - 1] < silence) w--;
    if ((n - w) * 0.25 >= 0.35) return w * 0.25;
    for (let b = n - 6; b >= 0; b--) {
      let on = 0, sum = 0;
      for (let k = b; k < b + 6; k++) { if (env[k] >= thr) on++; sum += env[k]; }
      if (on >= 3 && sum / 6 >= 0.85 * thr) return (b + 6) * 0.25;
    }
    return null;
  }

  // Automix v2's low-end evidence (Orchard evidence.rs), from one 250 Hz-and-under copy of the song.
  function biquad(x, type, f, sr) {
    const w = 2 * Math.PI * f / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    const b1 = type === 'lp' ? 1 - cw : -(1 + cw), b0 = Math.abs(b1) / 2, a0 = 1 + al;
    const B0 = b0 / a0, B1 = b1 / a0, B2 = b0 / a0, A1 = -2 * cw / a0, A2 = (1 - al) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = B0 * x[i] + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  // A band (two high-passes, two low-passes, as Orchard's band()).
  const band = (x, lo, hi, r) => biquad(biquad(biquad(biquad(x, 'hp', lo, r), 'hp', lo, r), 'lp', hi, r), 'lp', hi, r);
  // The song low-passed under 400 Hz, then every 16th sample (2756 Hz at 44.1 kHz).
  function lowCopy(mono, sr) {
    const pre = biquad(biquad(mono, 'lp', 400, sr), 'lp', 400, sr);
    const step = 16, low = new Float32Array(Math.floor(pre.length / step));
    for (let i = 0; i < low.length; i++) low[i] = pre[i * step];
    return { low, r: sr / step };
  }
  // Production style (sub_bass_ratio): log10 of the energy at 25-60 Hz over
  // 60-250 Hz in the song's middle 60%. Automix v2 never overlaps two songs
  // 0.9 or more apart (an 808 song and a bass-guitar one). null: silent.
  function subBassRatio({ low, r }) {
    const body = low.subarray(Math.floor(low.length / 5), Math.floor(low.length * 4 / 5));
    const energy = (x) => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e; };
    const sub = energy(band(body, 25, 60, r)), bass = energy(band(body, 60, 250, r));
    return sub > 0 && bass > 0 ? Math.log10(sub / bass) : null;
  }
  // Kick and bass level (bass_curve): 35-140 Hz RMS every 0.25 s, where 1 is
  // the song's usual level (the 75th percentile of its per-second means).
  // Beatless intros and outros read near 0: Automix v2's beatless bridge and
  // fallback ladder read where a song has a beat from it. null: silent.
  const BASS_STEP = 0.25;
  function bassCurve({ low, r }) {
    const f = band(low, 35, 140, r);
    const edge = (i) => Math.round(i * BASS_STEP * r);
    const levels = [];
    for (let i = 0; edge(i + 1) <= f.length; i++) {
      let ss = 0;
      for (let k = edge(i); k < edge(i + 1); k++) ss += f[k] * f[k];
      levels.push(Math.sqrt(ss / Math.max(1, edge(i + 1) - edge(i))));
    }
    const perSec = Math.round(1 / BASS_STEP), seconds = [];
    for (let i = 0; i < levels.length; i += perSec) {
      const c = levels.slice(i, i + perSec);
      seconds.push(c.reduce((a, b) => a + b, 0) / c.length);
    }
    if (!seconds.length) return null;
    const sorted = seconds.slice().sort((a, b) => a - b);
    const ref = Math.max(sorted[Math.round((sorted.length - 1) * 0.75)], 1e-6);
    return { start: 0, step: BASS_STEP, values: levels.map((v) => Math.round((v / ref) * 1000) / 1000) };
  }
  // Pitch classes (Orchard earmark chroma.rs): every 0.5 s a 16384-point
  // spectrum (2.7 Hz bins); each peak from 65 Hz to 2.1 kHz over twice the
  // frame's median, parabolic on log magnitude, adds its square root to its
  // two nearest pitch classes. chromaCurve (evidence.rs chroma_curve): each
  // frame summed to 1, with its weight against the song's median frame (drum
  // frames weigh little). chroma: the whole song's profile, summed to 1.
  // Automix v2's key checks read them. null: silent or too short.
  const CHROMA_STEP = 0.5, CHROMA_LOW = 65, CHROMA_HIGH = 2100;
  function fftMagnitudes(size) {
    const bits = Math.log2(size), rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); }
    const re = new Float64Array(size), im = new Float64Array(size), mag = new Float64Array(size / 2 + 1);
    return (frame) => {
      for (let i = 0; i < size; i++) { re[rev[i]] = frame[i]; im[rev[i]] = 0; }
      for (let len = 2; len <= size; len <<= 1) {
        const half = len >> 1, step = size / len;
        for (let i = 0; i < size; i += len) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      for (let i = 0; i <= size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      return mag;
    };
  }
  function chromaEvidence(mono, sr) {
    const size = 2 ** Math.ceil(Math.log2(Math.max(512, sr / 2.7)));
    const hop = Math.max(1, Math.round(CHROMA_STEP * sr));
    if (mono.length < size) return { chroma: null, chromaCurve: null };
    const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    const low = Math.max(2, Math.ceil(CHROMA_LOW * size / sr));
    const high = Math.min(size / 2 - 2, Math.floor(Math.min(CHROMA_HIGH, sr * 0.45) * size / sr));
    const spectrum = fftMagnitudes(size), frame = new Float64Array(size), band = new Float64Array(high - low + 1);
    const binHz = sr / size, frames = [];
    for (let begin = 0; begin + size <= mono.length; begin += hop) {
      for (let i = 0; i < size; i++) frame[i] = mono[begin + i] * win[i];
      const m = spectrum(frame);
      band.set(m.subarray(low, high + 1));
      band.sort();
      const floor = band[band.length >> 1] * 2;
      const c = new Float64Array(12);
      for (let bin = low; bin <= high; bin++) {
        const l = m[bin - 1], mid = m[bin], r = m[bin + 1];
        if (mid <= floor || mid <= l || mid < r) continue;
        const a = Math.log(l + 1e-12), b = Math.log(mid + 1e-12), cc = Math.log(r + 1e-12);
        const curv = a - 2 * b + cc;
        const off = curv < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - cc) / curv)) : 0;
        const pitch = 69 + 12 * Math.log2(((bin + off) * binHz) / 440);
        const lower = Math.floor(pitch), near = Math.cos((pitch - lower) * Math.PI / 2) ** 2, w = Math.sqrt(mid);
        c[((lower % 12) + 12) % 12] += w * near;
        c[(((lower + 1) % 12) + 12) % 12] += w * (1 - near);
      }
      frames.push(c);
    }
    const totals = frames.map((f) => f.reduce((s, v) => s + v, 0));
    const sorted = totals.slice().sort((a, b) => a - b);
    const typical = Math.max(sorted[Math.floor(sorted.length / 2)] ?? 0, 1e-9);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const sum = new Float64Array(12);
    for (const f of frames) for (let k = 0; k < 12; k++) sum[k] += f[k];
    const all = sum.reduce((s, v) => s + v, 0);
    if (!(all > 0)) return { chroma: null, chromaCurve: null };
    return {
      chroma: Array.from(sum, (v) => Math.round((v / all) * 1e4) / 1e4),
      chromaCurve: {
        start: r3(size / 2 / sr), step: hop / sr,
        values: frames.map((f, i) => Array.from(f, (v) => r3(v / Math.max(totals[i], 1e-12)))),
        weights: totals.map((t) => r3(Math.min(t / typical, 4))),
      },
    };
  }
  // Loudness every 100 ms (ITU BS.1770, which EBU R128 uses): the song
  // K-weighted (a high shelf, then a high-pass), its mean square in dB.
  // Automix v2 reads a region's gated loudness from it (Orchard's loudness trim).
  const LOUDNESS_STEP = 0.1;
  function kStage(x, b0, b1, b2, a1, a2) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function loudnessCurve(mono, sr) {
    let K = Math.tan(Math.PI * 1681.974450955533 / sr);
    const Q1 = 0.7071752369554196, Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416;
    let a0 = 1 + K / Q1 + K * K;
    const shelf = kStage(mono, (Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0);
    K = Math.tan(Math.PI * 38.13547087602444 / sr);
    const Q2 = 0.5003270373238773;
    a0 = 1 + K / Q2 + K * K;
    const z = kStage(shelf, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0);
    const n = Math.round(LOUDNESS_STEP * sr), values = [];
    for (let i = 0; i + n <= z.length; i += n) {
      let ss = 0;
      for (let k = i; k < i + n; k++) ss += z[k] * z[k];
      values.push(Math.max(-120, Math.round(10 * Math.log10(ss / n + 1e-30) * 10) / 10));
    }
    return values.length ? { start: 0, step: LOUDNESS_STEP, values } : null;
  }
  // Automix v2's evidence from the mono song (before it goes to the worker).
  function lowEnd(mono, sr) {
    const c = lowCopy(mono, sr);
    return { subBassRatio: subBassRatio(c), bassCurve: bassCurve(c), ...chromaEvidence(mono, sr), loudnessCurve: loudnessCurve(mono, sr) };
  }

  const ANALYSIS_MAX_SEC = 480;
  // BitChord analyzer.ts analyzeOne, from the song's compressed bytes.
  async function analyzeSong(id, fileKey, bytes, musicVideo) {
    const decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: ANALYSIS_SR });
    const buffer = await decodeCtx.decodeAudioData(bytes.slice(0));
    // over 8 minutes: not analysed, and not saved (automix.js ANALYSIS_MAX_SEC; versions.md "Analysis length")
    if (buffer.duration > ANALYSIS_MAX_SEC) return { tooLong: true, durationSec: buffer.duration };
    const mono = downmixToMono(buffer);
    const durationSec = buffer.duration;
    reply({ type: 'progress', fileKey, stage: 'lowEnd' });   // the page's progress row (editor.md §11)
    const contentEndSec = contentEnd(mono, ANALYSIS_SR);   // (before mono goes to the worker)
    const low = lowEnd(mono, ANALYSIS_SR);
    // Beat This! wants mono at 22,050 Hz: the browser's resampler, not decimation.
    const beatCtx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: BEAT_SR });
    const mono22 = downmixToMono(await beatCtx.decodeAudioData(bytes));
    const beatWindows = [{ offsetSec: 0, pcm: mono22.slice(0, Math.round(Math.min(durationSec, BEAT_WINDOW_SEC) * BEAT_SR)) }];
    if (durationSec > BEAT_WINDOW_SEC) {
      const from = durationSec - BEAT_WINDOW_SEC;
      beatWindows.push({ offsetSec: from, pcm: mono22.slice(Math.round(from * BEAT_SR)) });
    }
    // The vocal mask over the opening the incoming loop is looked for in (two
    // windows) and the end the outgoing one is (up to three).
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const vocalStarts = [0, VOCAL_WINDOW_SEC].filter((s) => s + VOCAL_WINDOW_SEC <= durationSec);
    for (let k = 1; k <= 3; k++) {
      const s = durationSec - k * VOCAL_WINDOW_SEC;
      if (s >= 2 * VOCAL_WINDOW_SEC) vocalStarts.push(s);
    }
    const vocalWindows = vocalStarts.map((s) => {
      const a = Math.round(s * ANALYSIS_SR);
      const b = Math.min(left.length, a + Math.floor(VOCAL_WINDOW_SEC * ANALYSIS_SR));
      return { offsetSec: s, left: left.slice(a, b), right: right.slice(a, b) };
    });

    reply({ type: 'progress', fileKey, stage: 'models' });
    const res = await new Promise((resolve) => {
      jobs.set(fileKey, resolve);
      worker.postMessage(
        { fileKey, samples: mono, sampleRate: ANALYSIS_SR, beatWindows, vocalWindows },
        [mono.buffer, ...beatWindows.map((w) => w.pcm.buffer), ...vocalWindows.flatMap((w) => [w.left.buffer, w.right.buffer])],
      );
    });
    if (res.type !== 'result' || !res.result) throw new Error(res.message || 'analysis failed');
    const analysis = { fileKey: id, durationSec, contentEndSec, ...low, ...res.result, musicVideo: !!musicVideo, analysisVersion: ANALYSIS_VERSION };
    reply({ type: 'progress', fileKey, stage: 'saving' });
    await putCached(analysis);
    return analysis;
  }

  window.addEventListener('message', async (e) => {
    if (e.origin !== PARENT_ORIGIN || !e.data || e.data.ch !== 'vivi-automix') return;
    const d = e.data;
    if (d.type === 'cached') {
      reply({ type: 'result', fileKey: d.fileKey, result: await getCached(d.id) });
    } else if (d.type === 'analyzeSong') {
      try {
        reply({ type: 'result', fileKey: d.fileKey, result: await analyzeSong(d.id, d.fileKey, d.bytes, d.musicVideo) });
      } catch (err) {
        reply({ type: 'error', fileKey: d.fileKey, message: String(err?.message || err) });
      }
    } else if (d.type === 'contentEnd') {
      // A song saved before contentEndSec or the low-end evidence existed: those, from its bytes, saved with it.
      try {
        const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: ANALYSIS_SR });
        const mono = downmixToMono(await ctx.decodeAudioData(d.bytes));
        const measured = { contentEndSec: contentEnd(mono, ANALYSIS_SR), ...lowEnd(mono, ANALYSIS_SR) };
        const saved = await getCached(d.id);
        if (saved) await putCached({ ...saved, ...measured });
        reply({ type: 'result', fileKey: d.fileKey, result: measured });
      } catch (err) {
        reply({ type: 'error', fileKey: d.fileKey, message: String(err?.message || err) });
      }
    } else if (d.type === 'addonWork') {
      // the addon copy's fit and level (addons/fit.worker.js), off the page's main thread
      // A worker that fails to load or dies answers every job it holds with an error (the page then
      // fits on its own thread), and the next job starts a new one.
      if (!fitWorker) {
        const w = new Worker(chrome.runtime.getURL('src/addons/fit.worker.js'));
        const jobs = w.jobs = new Set();
        fitWorker = w;
        w.addEventListener('message', (m) => {
          const id = m.data?.id;
          if (!jobs.delete(id)) return;
          reply(m.data.ok ? { type: 'result', fileKey: id, result: m.data.result } : { type: 'error', fileKey: id, message: m.data.error });
        });
        const fail = (why) => () => {
          if (fitWorker === w) fitWorker = null;
          try { w.terminate(); } catch { /* gone */ }
          for (const id of jobs) reply({ type: 'error', fileKey: id, message: why });
          jobs.clear();
        };
        w.addEventListener('error', fail('the fit worker failed'));
        w.addEventListener('messageerror', fail('the fit worker could not read a job'));
      }
      const w = fitWorker;
      w.jobs.add(d.fileKey);
      try { w.postMessage({ id: d.fileKey, ...d.job }, d.transfer || []); } catch (err) {
        w.jobs.delete(d.fileKey);
        reply({ type: 'error', fileKey: d.fileKey, message: String(err?.message || err) });
      }
    } else if (d.type === 'analyze') {
      // a bare clip (the model warm-up): its own Beat This! window
      const { fileKey, samples, sampleRate, offsetSec } = d;
      worker.postMessage({ fileKey, samples, sampleRate, beatWindows: [{ offsetSec, pcm: samples }], vocalWindows: [] }, [samples.buffer]);
    }
  });

  try { start(); } catch (err) {
    reply({ type: 'fatal', message: String(err?.message || err) });
  }
})();

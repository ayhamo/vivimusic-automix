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
  let worker = null;
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

  // BitChord analyzer.ts analyzeOne, from the song's compressed bytes.
  async function analyzeSong(id, fileKey, bytes, musicVideo) {
    const decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: ANALYSIS_SR });
    const buffer = await decodeCtx.decodeAudioData(bytes.slice(0));
    const mono = downmixToMono(buffer);
    const durationSec = buffer.duration;
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

    const res = await new Promise((resolve) => {
      jobs.set(fileKey, resolve);
      worker.postMessage(
        { fileKey, samples: mono, sampleRate: ANALYSIS_SR, beatWindows, vocalWindows },
        [mono.buffer, ...beatWindows.map((w) => w.pcm.buffer), ...vocalWindows.flatMap((w) => [w.left.buffer, w.right.buffer])],
      );
    });
    if (res.type !== 'result' || !res.result) throw new Error(res.message || 'analysis failed');
    const analysis = { fileKey: id, durationSec, ...res.result, musicVideo: !!musicVideo, analysisVersion: ANALYSIS_VERSION };
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

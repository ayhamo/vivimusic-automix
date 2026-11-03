/* VIVIMUSIC WEB — automix/host.js  (hidden extension iframe inside YouTube Music)
 *
 * A content script cannot start a Worker from an extension URL in Firefox
 * (the worker would belong to music.youtube.com and be refused), so the beat
 * analysis worker lives here, in an extension-origin frame. automix.js posts
 * PCM in, this page hands it to the worker and posts the result back.
 */
(() => {
  'use strict';
  const PARENT_ORIGIN = 'https://music.youtube.com';
  let worker = null;

  function start() {
    worker = new Worker(chrome.runtime.getURL('src/vendor/automix/analysis.worker.js'), { type: 'module' });
    worker.onmessage = (e) => parent.postMessage({ ch: 'vivi-automix', ...e.data }, PARENT_ORIGIN);
    worker.onerror = (e) => parent.postMessage({ ch: 'vivi-automix', type: 'fatal', message: String(e?.message || 'worker error') }, PARENT_ORIGIN);
    worker.postMessage({
      type: 'init',
      wasmUrl: chrome.runtime.getURL('src/vendor/automix/ort-wasm-simd-threaded.wasm'),
      modelUrl: chrome.runtime.getURL('src/vendor/automix/beat_this_final0_q8.onnx'),
    });
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== PARENT_ORIGIN || !e.data || e.data.ch !== 'vivi-automix' || e.data.type !== 'analyze') return;
    const { fileKey, samples, sampleRate, offsetSec } = e.data;
    worker.postMessage({
      fileKey, samples, sampleRate,
      beatWindows: [{ offsetSec, pcm: samples }],
      vocalWindows: [],
    });
  });

  try { start(); } catch (err) {
    parent.postMessage({ ch: 'vivi-automix', type: 'fatal', message: String(err?.message || err) }, PARENT_ORIGIN);
  }
})();

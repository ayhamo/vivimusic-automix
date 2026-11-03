/**
 * VIVIMUSIC WEB — automix.js  (content script, isolated world)
 *
 * Beat-aware transitions for crossfade.js. When a song is about to end
 * naturally, crossfade.js hands us the buffered outro as PCM. We run the
 * Beat This model (ONNX, on-device) over it to find tempo and downbeats, then
 * plan a blend that is a whole number of bars long (4 / 8 / 16) and starts
 * exactly on a downbeat of the outgoing song. crossfade.js does the audio.
 *
 * The next song's audio is not available before it starts playing (YouTube
 * only serves signed stream URLs to its own player), so the incoming song is
 * not tempo-matched; the bar-aligned start and the bass swap are what make
 * the blend sound mixed rather than faded.
 *
 * The model runs in a Worker inside a hidden extension frame (host.html):
 * Firefox refuses Workers started from a content script with an extension URL.
 */
(() => {
  'use strict';
  if (window.__viviAutomix) return;

  const log = (...a) => console.log('%c[ViVi automix]', 'color:#ff4b8b', ...a);
  const ANALYSIS_RATE = 22050;
  const HOST_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const MAX_MIX_SEC = 30;

  let enabled = true;
  let barsSetting = 'auto';
  try {
    chrome.storage.local.get({ automixEnabled: true, automixBars: 'auto' }, (s) => {
      enabled = s.automixEnabled !== false;
      barsSetting = s.automixBars === 'auto' ? 'auto' : (Number(s.automixBars) || 8);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('automixEnabled' in ch) enabled = ch.automixEnabled.newValue !== false;
      if ('automixBars' in ch) barsSetting = ch.automixBars.newValue === 'auto' ? 'auto' : (Number(ch.automixBars.newValue) || 8);
    });
  } catch { /* extension context gone */ }

  const live = { status: 'idle', bpm: null, conf: null, mix: null, updatedAt: 0 };
  const setStatus = (status, extra = {}) => Object.assign(live, { status, updatedAt: Date.now() }, extra);

  // ───────── analysis host frame ─────────
  let frame = null, frameReady = null, frameDead = false;
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (e) => {
    if (e.origin !== HOST_ORIGIN || !e.data || e.data.ch !== 'vivi-automix') return;
    const d = e.data;
    if (d.type === 'ready') { frameReady?.resolve(); return; }
    if (d.type === 'fatal') {
      log('analysis host failed:', d.message);
      frameDead = true;
      frameReady?.reject(new Error(d.message));
      for (const p of pending.values()) p.reject(new Error(d.message));
      pending.clear();
      return;
    }
    const p = pending.get(d.fileKey);
    if (!p) return;
    pending.delete(d.fileKey);
    if (d.type === 'result') p.resolve(d.result);
    else p.reject(new Error(d.message || 'analysis failed'));
  });

  function ensureFrame() {
    if (frameDead) return Promise.reject(new Error('analysis host unavailable'));
    if (frame && frame.isConnected) return frameReady.promise;
    frameReady = {};
    frameReady.promise = new Promise((resolve, reject) => { frameReady.resolve = resolve; frameReady.reject = reject; });
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/automix/host.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0';
    (document.body || document.documentElement).appendChild(frame);
    setTimeout(() => frameReady.reject(new Error('analysis host timed out')), 15000);
    return frameReady.promise;
  }

  // Mono, resampled to the model's 22.05 kHz.
  async function toModelPcm(channels, sampleRate) {
    const len = channels[0].length;
    const mono = new Float32Array(len);
    for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
    if (sampleRate === ANALYSIS_RATE) return mono;
    const outLen = Math.max(1, Math.round(len * ANALYSIS_RATE / sampleRate));
    const off = new OfflineAudioContext(1, outLen, ANALYSIS_RATE);
    const buf = off.createBuffer(1, len, sampleRate);
    buf.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  }

  // channels: Float32Array[] of the outro, starting at song time offsetSec.
  async function analyzeTail(id, channels, sampleRate, offsetSec) {
    setStatus('analyzing', { bpm: null, conf: null, mix: null });
    await ensureFrame();
    const samples = await toModelPcm(channels, sampleRate);
    const fileKey = id + ':' + (++seq);
    const result = await new Promise((resolve, reject) => {
      pending.set(fileKey, { resolve, reject });
      setTimeout(() => { if (pending.delete(fileKey)) reject(new Error('analysis timed out')); }, 30000);
      frame.contentWindow.postMessage({ ch: 'vivi-automix', type: 'analyze', fileKey, samples, sampleRate: ANALYSIS_RATE, offsetSec }, HOST_ORIGIN, [samples.buffer]);
    });
    const grid = result?.headBeats;
    const bpm = Number(grid?.bpm || result?.bpm) || 0;
    const conf = Number(result?.gridConfidence) || 0;
    setStatus('analyzed', { bpm: bpm || null, conf });
    return { bpm, conf, downbeats: Array.isArray(grid?.downbeats) ? grid.downbeats : [] };
  }

  /**
   * Pick bar count and the downbeat the blend starts on.
   * songEnd: song duration (s). earliest: first song time we could still start at.
   * Returns { bars, mixSec, startAt, bpm, conf } or null (use a plain crossfade).
   */
  function planMix(analysis, songEnd, earliest) {
    const { bpm, conf, downbeats } = analysis || {};
    if (!bpm || bpm < 60 || bpm > 200 || conf < 0.2 || !downbeats.length) {
      setStatus('fallback', { mix: null, reason: 'weak beat grid' });
      return null;
    }
    const barSec = 240 / bpm;
    let bars = barsSetting === 'auto' ? (conf >= 0.7 ? 16 : conf >= 0.45 ? 8 : 4) : barsSetting;
    if (conf < 0.45) bars = Math.min(bars, 4);
    else if (conf < 0.6) bars = Math.min(bars, 8);
    while (bars > 4 && bars * barSec > MAX_MIX_SEC) bars /= 2;
    const mixSec = bars * barSec;

    // Detected downbeats, continued on the bar grid to the end of the song.
    const grid = [...downbeats];
    for (let t = grid[grid.length - 1] + barSec; t < songEnd; t += barSec) grid.push(t);
    const latest = songEnd - mixSec - 0.3;
    const startAt = grid.filter((t) => t >= earliest && t <= latest).pop();
    if (startAt == null) {
      setStatus('fallback', { mix: null, reason: 'no downbeat fits' });
      return null;
    }
    const mix = { bars, mixSec, startAt, bpm, conf };
    setStatus('ready', { mix });
    log(`planned ${bars} bars (${mixSec.toFixed(1)} s) at ${bpm.toFixed(1)} BPM, starting on the downbeat at ${startAt.toFixed(2)} s (grid confidence ${conf.toFixed(2)})`);
    return mix;
  }

  window.__viviAutomix = {
    isEnabled: () => enabled,
    getBars: () => barsSetting,
    analyzeTail,
    planMix,
    setStatus,
    getLiveState: () => ({ ...live }),
    MAX_MIX_SEC,
  };
})();

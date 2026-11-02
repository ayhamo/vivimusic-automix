/**
 * VIVIMUSIC WEB — automix.js
 *
 * Professional on-device Automix (Auto-DJ) engine for YouTube Music desktop.
 * Uses ONNX Runtime Web (WASM SIMD) + Sony/CPJKU's 'Beat This' neural network
 * for precise BPM, beat grid, and downbeat phrase tracking.
 *
 * Rules:
 *   1. Triggered exclusively on Auto-Advance (when Track A ends naturally).
 *   2. Starts preloading and analysis 60 seconds before Track A ends.
 *   3. If tempo difference <= 12% across octave equivalents and confidence >= 0.2:
 *      executes beatmatched phrase transition (8 or 16 bars) with downbeat alignment.
 *   4. If tempo difference > 12% or confidence is low:
 *      falls back cleanly to standard 5-second equal-power crossfade.
 *   5. Manual skip (Next button / Shift+N) always uses standard 5-second crossfade.
 */

(() => {
  'use strict';
  if (window.__viviAutomix) return;

  const log = (...a) => console.log('%c[ViVi Automix]', 'color:#ff4b8b;font-weight:bold;', ...a);
  const warn = (...a) => console.warn('[ViVi Automix]', ...a);

  let automixEnabled = true;
  let automixBars = 'auto';       // 'auto', 4, 8, or 16 bars
  let automixMaxTempoDiff = 0.12; // 12% max tempo adjustment

  // Read initial settings
  try {
    chrome.storage.local.get({
      automixEnabled: true,
      automixBars: 'auto',
      automixMaxTempoDiff: 0.12,
    }, (s) => {
      automixEnabled = s.automixEnabled !== false;
      automixBars = s.automixBars === 'auto' ? 'auto' : (Number(s.automixBars) || 8);
      automixMaxTempoDiff = Number(s.automixMaxTempoDiff) || 0.12;
    });

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('automixEnabled' in ch) automixEnabled = ch.automixEnabled.newValue !== false;
      if ('automixBars' in ch) automixBars = ch.automixBars.newValue === 'auto' ? 'auto' : (Number(ch.automixBars.newValue) || 8);
      if ('automixMaxTempoDiff' in ch) automixMaxTempoDiff = Number(ch.automixMaxTempoDiff.newValue) || 0.12;
    });
  } catch { /* context gone */ }

  // ───────────────────────── Worker Management ─────────────────────────
  let worker = null;
  let workerReady = false;
  let pendingRequests = new Map();
  let nextRequestId = 1;

  async function ensureWorker() {
    if (worker && workerReady) return worker;
    const workerUrl = chrome.runtime.getURL('src/vendor/automix/analysis.worker.js');
    const wasmUrl = chrome.runtime.getURL('src/vendor/automix/ort-wasm-simd-threaded.wasm');
    const modelUrl = chrome.runtime.getURL('src/vendor/automix/beat_this_final0_q8.onnx');

    let w = null;
    try {
      w = new Worker(workerUrl, { type: 'module' });
    } catch {
      // Fallback: Blob URL instantiation if page CSP restricts extension URL worker-src
      const res = await fetch(workerUrl);
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/javascript' });
      w = new Worker(URL.createObjectURL(blob), { type: 'module' });
    }

    w.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'ready') {
        workerReady = true;
        log('Worker initialized and ready with Beat This ONNX model.');
        return;
      }
      if (d.type === 'result' || d.type === 'error') {
        const p = pendingRequests.get(d.fileKey);
        if (p) {
          pendingRequests.delete(d.fileKey);
          if (d.type === 'error') p.reject(new Error(d.message || 'Worker analysis failed'));
          else p.resolve(d.result);
        }
      }
    };

    w.onerror = (e) => {
      warn('Worker error:', e?.message || e);
    };

    // Initialize worker with paths
    w.postMessage({
      type: 'init',
      wasmUrl,
      modelUrl,
    });

    worker = w;
    return w;
  }

  // ───────────────────────── Audio Analysis Call ─────────────────────────
  async function analyzeAudio(fileKey, audioBuffer, offsetSec = 0) {
    const w = await ensureWorker();
    const reqKey = String(fileKey || 'slice_' + (nextRequestId++));

    // Downsample or extract mono 22050 Hz samples for Beat This model
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);

    for (let c = 0; c < channels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i] / channels;
    }

    // Downsample to 22050 Hz if needed
    let pcm22k = mono;
    const targetRate = 22050;
    if (audioBuffer.sampleRate !== targetRate) {
      const ratio = targetRate / audioBuffer.sampleRate;
      const newLen = Math.round(length * ratio);
      pcm22k = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const srcIdx = Math.min(length - 1, Math.round(i / ratio));
        pcm22k[i] = mono[srcIdx];
      }
    }

    const beatWindows = [{
      offsetSec,
      pcm: pcm22k,
    }];

    return new Promise((resolve, reject) => {
      pendingRequests.set(reqKey, { resolve, reject });
      try {
        w.postMessage({
          fileKey: reqKey,
          samples: pcm22k,
          sampleRate: targetRate,
          beatWindows,
          vocalWindows: [],
        }, [pcm22k.buffer]);
      } catch (err) {
        pendingRequests.delete(reqKey);
        reject(err);
      }
    });
  }

  // ───────────────────────── Live State & Scaling ─────────────────────────
  const automixLiveState = {
    currentBpm: null,
    currentConfidence: null,
    nextBpm: null,
    nextConfidence: null,
    lastPlan: null,
    statusText: 'idle',
    updatedAt: Date.now(),
  };

  /**
   * BitChord confidence-scaled blend length (effectiveBlendBars):
   * Long overlaps require high confidence; weaker grids get clamped
   * to 8 or 4 bars, or cleanly fall back below 0.20.
   */
  function effectiveBlendBars(requestedBars, confA, confB) {
    const minConf = Math.min(confA, confB);
    if (minConf >= 0.60) return requestedBars;
    if (minConf >= 0.45) return Math.min(requestedBars, 8);
    return Math.min(requestedBars, 4);
  }

  // ───────────────────────── Transition Planner ─────────────────────────
  function planTransition(fromAnalysis, toAnalysis, requestedBars = automixBars) {
    if (!fromAnalysis || !toAnalysis) {
      return { canMix: false, reason: 'missing_analysis' };
    }

    const confA = fromAnalysis.gridConfidence || 0;
    const confB = toAnalysis.gridConfidence || 0;
    if (confA < 0.2 || confB < 0.2) {
      return { canMix: false, reason: 'low_confidence', confA, confB };
    }

    const bpmA = fromAnalysis.bpm;
    const bpmB = toAnalysis.bpm;
    if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) {
      return { canMix: false, reason: 'invalid_bpm' };
    }

    // Tempo ratio check: direct, half-time, double-time
    const ratio = bpmA / bpmB;
    const candidates = [ratio, ratio * 0.5, ratio * 2.0];
    candidates.sort((x, y) => Math.abs(x - 1.0) - Math.abs(y - 1.0));
    const bestRatio = candidates[0];
    const tempoDiff = Math.abs(bestRatio - 1.0);

    if (tempoDiff > automixMaxTempoDiff) {
      log(`Tempo difference ${(tempoDiff * 100).toFixed(1)}% exceeds limit of ${(automixMaxTempoDiff * 100).toFixed(0)}% (${bpmA.toFixed(1)} -> ${bpmB.toFixed(1)} BPM). Falling back to 5s crossfade.`);
      return { canMix: false, reason: 'tempo_mismatch', tempoDiff, bpmA, bpmB };
    }

    // Scale bars: 4, 8, or 16 bars with Smart Adaptive logic
    let targetBars = requestedBars;
    if (targetBars === 'auto' || !targetBars || targetBars === 0) {
      const minConf = Math.min(confA, confB);
      if (tempoDiff > 0.05 || minConf < 0.45) {
        targetBars = 4; // Fast / punchy blend for tempo drift or looser beat grids
      } else if (tempoDiff < 0.02 && minConf >= 0.70) {
        targetBars = 16; // Silky extended club blend for closely matched tempos
      } else {
        targetBars = 8; // Standard 8-bar musical phrase
      }
      log(`Auto adaptive blend selected: ${targetBars} bars (tempoDiff: ${(tempoDiff * 100).toFixed(1)}%, conf: ${minConf.toFixed(2)})`);
    }
    const bars = Math.max(4, Math.min(16, effectiveBlendBars(Number(targetBars) || 8, confA, confB)));
    const beatSecA = 60 / bpmA;
    const barSecA = beatSecA * 4;
    const transitionDurationSec = bars * barSecA;

    log(`Automix transition planned: ${bars} bars (${transitionDurationSec.toFixed(1)}s), Tempo scaling ${bestRatio.toFixed(3)}x (${bpmA.toFixed(1)} -> ${bpmB.toFixed(1)} BPM).`);

    return {
      canMix: true,
      rateB: bestRatio,
      bars,
      bpmA,
      bpmB,
      transitionDurationSec,
      beatSecA,
      barSecA,
      firstDownbeatA: fromAnalysis.firstDownbeatSec || 0,
      firstDownbeatB: toAnalysis.firstDownbeatSec || 0,
    };
  }

  // ───────────────────────── Next Track Queue Inspector ─────────────────────────
  function getNextTrackInfo() {
    try {
      const p = document.getElementById('movie_player');
      const mp = (p && p.wrappedJSObject) || p;
      if (mp && typeof mp.getPlaylist === 'function' && typeof mp.getPlaylistIndex === 'function') {
        const list = mp.getPlaylist();
        const idx = mp.getPlaylistIndex();
        if (Array.isArray(list) && idx >= 0 && idx + 1 < list.length) {
          log('Next track found via movie_player playlist: index ' + (idx + 1) + ' of ' + list.length + ' (' + list[idx + 1] + ')');
          return { videoId: list[idx + 1] };
        }
      }

      // DOM fallback: ytmusic-player-queue items
      const items = [...document.querySelectorAll('ytmusic-player-queue-item')];
      let selectedIdx = items.findIndex((it) =>
        it.hasAttribute('selected') ||
        it.classList.contains('selected') ||
        Boolean(it.querySelector?.('ytmusic-play-button-renderer[state="playing"]')) ||
        Boolean(it.querySelector?.('.play-button[aria-label*="Pause"]'))
      );
      if (selectedIdx < 0) {
        const currentUrl = location.href;
        selectedIdx = items.findIndex((it) => {
          const a = it.querySelector('a');
          return a && a.href && currentUrl.includes(a.href);
        });
      }
      if (selectedIdx >= 0 && selectedIdx + 1 < items.length) {
        const nextItem = items[selectedIdx + 1];
        const link = nextItem.querySelector('a');
        const match = link?.href?.match(/[?&]v=([^&]+)/);
        const videoId = (nextItem.data && nextItem.data.videoId) ||
          (match && match[1]) || null;
        if (videoId) {
          log('Next track found via DOM queue item: ' + videoId);
          return { videoId };
        }
      }
    } catch (e) {
      warn('Failed to inspect queue:', e?.message || e);
    }
    return null;
  }

  // ───────────────────────── Preload & Range Fetch Bridge ─────────────────────────
  const introResolvers = new Map();

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== 'vivi-xfade' || d.dir !== 'out') return;
    if (d.type === 'intro') {
      const res = introResolvers.get(d.id);
      if (res) {
        introResolvers.delete(d.id);
        res(d);
      }
    }
  });

  async function fetchTrackBIntroAudio(videoId) {
    if (!videoId) return null;
    log('Preloading Track B intro audio via main-world player bridge for:', videoId);

    return new Promise((resolve) => {
      introResolvers.set(videoId, (data) => {
        if (!data || !data.ok || !data.channels || !data.channels.length) {
          warn('Track B intro fetch failed in page world:', data?.why);
          resolve(null);
          return;
        }
        try {
          const offlineCtx = new OfflineAudioContext(data.channels.length, data.channels[0].length, data.sampleRate);
          const buf = offlineCtx.createBuffer(data.channels.length, data.channels[0].length, data.sampleRate);
          data.channels.forEach((c, idx) => buf.copyToChannel(c, idx));
          log('Successfully decoded Track B intro audio buffer (' + (buf.duration).toFixed(1) + 's).');
          resolve(buf);
        } catch (e) {
          warn('Failed to rebuild AudioBuffer for intro:', e);
          resolve(null);
        }
      });

      window.postMessage({
        ch: 'vivi-xfade',
        dir: 'in',
        type: 'fetch-intro',
        videoId,
      }, window.location.origin);

      setTimeout(() => {
        if (introResolvers.has(videoId)) {
          introResolvers.delete(videoId);
          warn('Track B intro fetch timed out (10s)');
          resolve(null);
        }
      }, 10000);
    });
  }

  window.__viviAutomix = {
    isEnabled: () => automixEnabled,
    getBars: () => automixBars,
    getMaxTempoDiff: () => automixMaxTempoDiff,
    analyzeAudio,
    planTransition,
    getNextTrackInfo,
    fetchTrackBIntroAudio,
    getLiveState: () => ({ ...automixLiveState, updatedAt: Date.now() }),
    setLiveStatus: (txt) => { automixLiveState.statusText = txt; automixLiveState.updatedAt = Date.now(); },
    effectiveBlendBars,
  };

  log('Automix module loaded.');
})();

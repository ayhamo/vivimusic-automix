/* Vivimusic Web+ — addons/offset-fit.js (page or background; node for tests)
 *
 * Fits an addon's file of a song to YouTube's audio of it, and levels it
 * (spec/addons/offset-map.md). Pure functions on Float32Array samples.
 *
 *   fit(yt, addon, { slackSec })   -> { offsetSec, score, checkSec, checkScore } or { none, ... }
 *        yt, addon: Float32Array, mono at 22 050 Hz (FIT_RATE), from the same
 *        decode path that plays them (decoder delay removed, or kept, alike)
 *   integratedLufs(mono, rate)     -> EBU R128 integrated loudness (BS.1770-4), or -Infinity
 *   truePeakDb(channels, rate, above) -> 4x oversampled peak in dBTP (only around samples over `above` dBFS)
 *   sourceGainDb({ ytLufs, addonLufs, addonChannels, rate }) -> { gainDb, wantDb, capped: null | 'boost' | 'peak' }
 *   resample(x, fromRate, toRate, cutoffHz, start, count)   band-limited, any ratio
 *
 * window.__viviOffsetFit
 */
(() => {
  'use strict';
  const FIT_RATE = 22050;
  const ENV_WIN_SEC = 0.01;            // coarse envelope: RMS of 10 ms windows
  const SILENT_RMS = 0.001;            // -60 dBFS: a silent window
  const COARSE_SEC = 60, COARSE_LAG_SEC = 15, MIN_SCORE = 0.8, MIN_OVERLAP = 0.5;
  const FINE_RATE = 4000, FINE_CUTOFF = 1000, FINE_SEC = 20, FINE_LAG_SEC = 0.02;
  const CHECK_LAG_SEC = 0.5, CHECK_AGREE_SEC = 0.03, CHECK_BEFORE_END = 30, SHORT_SONG = 90;
  const MAX_BOOST_DB = 6, CEILING_DBTP = -1;

  // ── band-limited resampling: a Hann-windowed sinc low-pass, evaluated at each output time ──
  // y[n] = sum_k x[k] h(t_n - k), t_n = (start + n) * from / to (input samples; start may be
  // fractional or negative: samples outside x are 0),
  // h(u) = (2 fc / fs) sinc(2 fc u / fs) w(u), w a Hann window of half-width W = 4 fs / fc.
  function resample(x, fromRate, toRate, cutoffHz, start = 0, count = Math.floor((x.length * toRate) / fromRate) - start) {
    const fc = Math.min(cutoffHz, 0.5 * Math.min(fromRate, toRate));
    const W = Math.ceil((4 * fromRate) / fc);
    const g = (2 * fc) / fromRate;
    const out = new Float32Array(Math.max(0, count));
    const step = fromRate / toRate;
    for (let n = 0; n < out.length; n++) {
      const t = (start + n) * step;
      const k0 = Math.max(0, Math.ceil(t - W)), k1 = Math.min(x.length - 1, Math.floor(t + W));
      let s = 0;
      for (let k = k0; k <= k1; k++) {
        const u = t - k;
        const a = Math.PI * g * u;
        const sinc = u === 0 ? 1 : Math.sin(a) / a;
        s += x[k] * g * sinc * (0.5 + 0.5 * Math.cos((Math.PI * u) / W));
      }
      out[n] = s;
    }
    return out;
  }

  // ── coarse envelope: window i covers samples [round(i * 220.5), round((i + 1) * 220.5)) ──
  function rmsWindows(x, rate) {
    const w = rate * ENV_WIN_SEC, n = Math.floor(x.length / w);
    const rms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.round(i * w), b = Math.round((i + 1) * w);
      let s = 0;
      for (let k = a; k < b; k++) s += x[k] * x[k];
      rms[i] = Math.sqrt(s / (b - a));
    }
    return rms;
  }
  const logEnv = (rms) => rms.map((r) => Math.log1p(r * 100));

  // Pearson correlation of y[0..n) against a[lag..lag+n), over the part inside a (partial
  // overlap at the edges); null when under MIN_OVERLAP of y is covered.
  function pearsonAt(y, a, lag, minOverlap = MIN_OVERLAP) {
    const i0 = Math.max(0, -lag), i1 = Math.min(y.length, a.length - lag);
    const n = i1 - i0;
    if (n < Math.max(2, minOverlap * y.length)) return null;
    let sy = 0, sa = 0, syy = 0, saa = 0, sya = 0;
    for (let i = i0; i < i1; i++) {
      const p = y[i], q = a[i + lag];
      sy += p; sa += q; syy += p * p; saa += q * q; sya += p * q;
    }
    const cov = sya - (sy * sa) / n, vy = syy - (sy * sy) / n, va = saa - (sa * sa) / n;
    return vy > 1e-12 && va > 1e-12 ? cov / Math.sqrt(vy * va) : 0;
  }
  function bestLag(y, a, lo, hi, minOverlap) {
    let best = null;
    const scores = new Map();
    for (let lag = lo; lag <= hi; lag++) {
      const c = pearsonAt(y, a, lag, minOverlap);
      if (c == null) continue;
      scores.set(lag, c);
      if (!best || c > best.score) best = { lag, score: c };
    }
    if (!best) return null;
    // parabolic refinement on the neighbours
    const l = scores.get(best.lag - 1), r = scores.get(best.lag + 1);
    let frac = 0;
    if (l != null && r != null) { const d = l - 2 * best.score + r; if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))); }
    return { ...best, at: best.lag + frac };
  }

  // coarse over [startSec, startSec + spanSec) of YouTube, lags around `aroundSec` within ±lagSec
  function coarse(ytEnv, adEnv, startSec, spanSec, aroundSec, lagSec) {
    const i0 = Math.round(startSec / ENV_WIN_SEC);
    const y = ytEnv.subarray(i0, Math.min(ytEnv.length, i0 + Math.round(spanSec / ENV_WIN_SEC)));
    const c = Math.round(aroundSec / ENV_WIN_SEC), L = Math.round(lagSec / ENV_WIN_SEC);
    const b = bestLag(y, adEnv, i0 + c - L, i0 + c + L);   // (a's index = y's index + i0 + lag)
    return b && { offsetSec: (b.lag - i0) * ENV_WIN_SEC, score: b.score };
  }

  // fine: both sides band-limited to 1 kHz at 4 kHz, ±20 ms around the coarse offset
  function fine(yt, ad, startSec, spanSec, aroundSec) {
    const M = Math.round(FINE_LAG_SEC * FINE_RATE), PAD = M + 4;
    const N = Math.round(spanSec * FINE_RATE);
    const y = resample(yt, FIT_RATE, FINE_RATE, FINE_CUTOFF, Math.round(startSec * FINE_RATE), N);
    // the addon on a 4 kHz grid starting at YouTube's start + the coarse offset - PAD samples
    const aStart = (startSec + aroundSec) * FINE_RATE - PAD;
    const a = resample(ad, FIT_RATE, FINE_RATE, FINE_CUTOFF, aStart, N + 2 * PAD);   // outside the file: silence
    const b = bestLag(y, a, PAD - M, PAD + M, 1);
    return b && { offsetSec: aroundSec + (b.at - PAD) / FINE_RATE, score: b.score };
  }
  function fit(yt, ad, { slackSec = 5 } = {}) {
    const ytDur = yt.length / FIT_RATE, adDur = ad.length / FIT_RATE;
    const ytRms = rmsWindows(yt, FIT_RATE), adRms = rmsWindows(ad, FIT_RATE);
    const ytEnv = logEnv(ytRms), adEnv = logEnv(adRms);
    // start: 0, or the first whole second holding a non-silent window
    const first = ytRms.findIndex((r) => r >= SILENT_RMS);
    if (first < 0 || !adRms.some((r) => r >= SILENT_RMS)) return { none: 'silent' };
    const start = Math.floor(first * ENV_WIN_SEC);
    const span = Math.min(COARSE_SEC, ytDur - start);
    const read = ytRms.subarray(Math.round(start / ENV_WIN_SEC), Math.round((start + span) / ENV_WIN_SEC));
    if (read.filter((r) => r >= SILENT_RMS).length < 0.5 * read.length) return { none: 'silent' };

    const c = coarse(ytEnv, adEnv, start, span, 0, COARSE_LAG_SEC);
    if (!c || c.score < MIN_SCORE) return { none: 'no match', score: c?.score ?? null };
    // the fine span, moved inside both files
    const inside = (s, len, off) => Math.max(s, -off + 0.05, 0.05) <= Math.min(ytDur, adDur - off) - len - 0.05
      ? Math.max(s, -off + 0.05, 0.05) : Math.max(0.05, Math.min(ytDur, adDur - off) - len - 0.05);
    const fLen = Math.min(FINE_SEC, ytDur - 0.2);
    const f = fine(yt, ad, inside(start, fLen, c.offsetSec), fLen, c.offsetSec);
    // the waveforms must agree too: songs on the same beat grid can share an envelope
    if (!f || f.score < MIN_SCORE) return { none: 'no match', score: c.score, fineScore: f?.score ?? null };

    // the check, near the end (a short song: its middle 20 s)
    let checkSec = ytDur < SHORT_SONG ? (ytDur - FINE_SEC) / 2 : ytDur - CHECK_BEFORE_END - FINE_SEC;
    checkSec = inside(Math.max(0, checkSec), fLen, f.offsetSec);
    const cc = coarse(ytEnv, adEnv, checkSec, fLen, f.offsetSec, CHECK_LAG_SEC);
    const cf = cc && cc.score >= MIN_SCORE ? fine(yt, ad, inside(checkSec, fLen, cc.offsetSec), fLen, cc.offsetSec) : null;
    if (!cf || Math.abs(cf.offsetSec - f.offsetSec) > CHECK_AGREE_SEC) {
      return { none: 'different edit', offsetSec: f.offsetSec, checkOffsetSec: cf?.offsetSec ?? cc?.offsetSec ?? null, checkScore: cc?.score ?? null };
    }
    if (Math.abs(adDur - f.offsetSec - ytDur) > slackSec) return { none: 'length', offsetSec: f.offsetSec, extraSec: adDur - f.offsetSec - ytDur };
    return { offsetSec: f.offsetSec, score: f.score, coarseScore: c.score, checkSec, checkScore: cf.score };
  }

  // ── level: BS.1770-4 K-weighting at any rate (libebur128's design: it reproduces the
  // standard's 48 kHz coefficients exactly) ──
  function kWeight(x, rate) {
    const shelf = (() => {
      const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
      const K = Math.tan((Math.PI * f0) / rate), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
      const a0 = 1 + K / Q + K * K;
      return [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
    })();
    const high = (() => {
      const f0 = 38.13547087602444, Q = 0.5003270373238773;
      const K = Math.tan((Math.PI * f0) / rate), d = 1 + K / Q + K * K;
      return [1, -2, 1, 1, (2 * (K * K - 1)) / d, (1 - K / Q + K * K) / d];
    })();
    const run = (inp, [b0, b1, b2, a0, a1, a2]) => {
      const out = new Float32Array(inp.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < inp.length; i++) {
        const v = inp[i], y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = v; y2 = y1; y1 = y; out[i] = y;
      }
      return out;
    };
    return run(run(x, shelf), high);
  }
  // integrated loudness: 400 ms blocks every 100 ms, absolute gate -70 LUFS, relative gate -10 LU
  function integratedLufs(mono, rate) {
    const k = kWeight(mono, rate);
    const blk = Math.round(0.4 * rate), hop = Math.round(0.1 * rate);
    const z = [];
    for (let s = 0; s + blk <= k.length; s += hop) {
      let e = 0;
      for (let i = s; i < s + blk; i++) e += k[i] * k[i];
      z.push(e / blk);
    }
    const L = (v) => -0.691 + 10 * Math.log10(v);
    const abs = z.filter((v) => L(v) > -70);
    if (!abs.length) return -Infinity;
    const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((v) => L(v) > rel);
    return L(g.reduce((a, b) => a + b, 0) / g.length);
  }

  // true peak: 4x oversampling (Hann-windowed sinc, 8 input samples each side), per channel,
  // only around samples over `aboveDb` dBFS (an oversampled peak is at most ~3 dB over its samples)
  function truePeakDb(channels, rate, aboveDb = -Infinity) {
    const th = 10 ** (aboveDb / 20), H = 8;
    // the three in-between points of an interval (j + 1/4, 2/4, 3/4): Hann-windowed sinc over
    // the 16 samples j-7 .. j+8, computed once (no trig per sample: a song took minutes)
    const kern = [1, 2, 3].map((p) => Float64Array.from({ length: 2 * H }, (_, m) => {
      const a = Math.PI * (p / 4 + H - 1 - m);   // u = t - k for k = j-7+m
      return (Math.sin(a) / a) * (0.5 + 0.5 * Math.cos(a / H));
    }));
    let peak = 0;
    for (const x of channels) {
      const n = x.length;
      for (let i = 0; i < n; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
      // each interval once, when either end is loud
      for (let j = 0; j < n - 1; j++) {
        if (Math.abs(x[j]) < th && Math.abs(x[j + 1]) < th) continue;
        const k0 = j - H + 1;
        for (const w of kern) {
          let s = 0;
          for (let m = 0; m < 2 * H; m++) { const k = k0 + m; if (k >= 0 && k < n) s += x[k] * w[m]; }
          if (Math.abs(s) > peak) peak = Math.abs(s);
        }
      }
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  // the deck's source gain: YouTube's loudness minus the file's, a boost capped at +6 dB and
  // kept under -1 dBTP (the true peak is measured only when boosting, near the loud samples)
  function sourceGainDb({ ytLufs, addonLufs, addonChannels, rate }) {
    if (!Number.isFinite(ytLufs) || !Number.isFinite(addonLufs)) return { gainDb: 0, wantDb: null, capped: null };
    const want = ytLufs - addonLufs;
    if (want <= 0) return { gainDb: want, wantDb: want, capped: null };
    let gain = Math.min(want, MAX_BOOST_DB), capped = want > MAX_BOOST_DB ? 'boost' : null;
    const tp = truePeakDb(addonChannels, rate, CEILING_DBTP - gain - 3.5);
    if (tp + gain > CEILING_DBTP) { gain = Math.max(0, CEILING_DBTP - tp); capped = 'peak'; }
    return { gainDb: gain, wantDb: want, capped, truePeakDb: tp };
  }

  const api = { fit, resample, rmsWindows, integratedLufs, truePeakDb, sourceGainDb, kWeight, FIT_RATE, MAX_BOOST_DB, CEILING_DBTP };
  // on window like the other modules: in a Firefox content script globalThis is the sandbox, not window
  if (typeof window === 'object') window.__viviOffsetFit = api; else globalThis.__viviOffsetFit = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

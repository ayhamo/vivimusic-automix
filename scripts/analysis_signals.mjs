// The synthetic songs of spec/automix/analysis-cases.md: each rendered once, sample by sample, at
// 44100 Hz (render), and the beat model's 22050 Hz input made from that render by a fixed resampler
// (half), so both sides analyse the very same samples at both rates.
// Everything here is spelled out in that file so another language renders the same samples.

// mulberry32: the noise generator (spec/addons/offset-map.md uses the same one)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// one drum hit added into x at time t (seconds)
function hit(x, sr, t, kind, rnd) {
  const i0 = Math.round(t * sr);
  if (kind === 'click' || kind === 'accent') {
    // a 30 ms sine blip, 1000 Hz (1500 Hz accented), 8 ms decay, peak 0.5
    const f = kind === 'accent' ? 1500 : 1000;
    for (let i = 0; i < 0.03 * sr && i0 + i < x.length; i++) x[i0 + i] += 0.5 * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (0.008 * sr));
  } else if (kind === 'kick') {
    // 150 ms, the pitch falling 150 -> 50 Hz (40 ms time constant), 60 ms decay, peak 0.9
    let ph = 0;
    for (let i = 0; i < 0.15 * sr && i0 + i < x.length; i++) {
      const s = i / sr, f = 50 + 100 * Math.exp(-s / 0.04);
      ph += 2 * Math.PI * f / sr;
      x[i0 + i] += 0.9 * Math.sin(ph) * Math.exp(-s / 0.06);
    }
  } else if (kind === 'snare') {
    // 120 ms of noise (uniform -1..1) plus 190 Hz, 40 ms decay, peak 0.5
    for (let i = 0; i < 0.12 * sr && i0 + i < x.length; i++) {
      const s = i / sr;
      x[i0 + i] += 0.5 * Math.exp(-s / 0.04) * (0.7 * (rnd() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * s));
    }
  } else if (kind === 'crash') {
    // the bar marker: 600 ms of first-difference noise, 150 ms decay, peak 0.3
    let prev = 0;
    for (let i = 0; i < 0.6 * sr && i0 + i < x.length; i++) {
      const n = rnd() * 2 - 1;
      x[i0 + i] += 0.3 * Math.exp(-i / sr / 0.15) * (n - prev) / 2;
      prev = n;
    }
  } else if (kind === 'hat') {
    // 30 ms of noise, first-difference high-passed, 8 ms decay, peak 0.15
    let prev = 0;
    for (let i = 0; i < 0.03 * sr && i0 + i < x.length; i++) {
      const n = rnd() * 2 - 1;
      x[i0 + i] += 0.15 * Math.exp(-i / sr / 0.008) * (n - prev) / 2;
      prev = n;
    }
  }
}

// the beat times of a song: [{ from, bpm }] parts, each running until the next (or the end)
export function beatTimes(song) {
  const out = [];
  song.parts.forEach((p, k) => {
    const end = k + 1 < song.parts.length ? song.parts[k + 1].from : song.sec;
    const period = 60 / p.bpm;
    for (let n = 0; ; n++) { const t = p.from + n * period; if (t >= end - 1e-9) break; out.push({ t, beatInBar: n % 4, bpm: p.bpm }); }
  });
  return out;
}

// a voice-like tone: 220 Hz with 8 harmonics (amplitude 1/h), 5.5 Hz vibrato of +-2%, a 4 Hz
// syllable envelope (0.3 + 0.7 * max(0, sin)), peak about 0.25
function voice(x, sr, from, to) {
  let ph = 0;
  for (let i = Math.round(from * sr); i < Math.min(x.length, Math.round(to * sr)); i++) {
    const s = i / sr, f = 220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * s));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * ph) / h;
    x[i] += 0.1 * v * (0.3 + 0.7 * Math.max(0, Math.sin(2 * Math.PI * 4 * s)));
  }
}

// a song (spec/automix/analysis-cases.json "song") at sample rate sr: mono Float32Array
export function render(song, sr) {
  const x = new Float32Array(Math.round(song.sec * sr));
  const rnd = mulberry32(song.seed ?? 1);
  for (const b of beatTimes(song)) {
    if (song.kit === 'click') hit(x, sr, b.t, b.beatInBar === 0 ? 'accent' : 'click', rnd);
    else {
      // kick and a crash on 1, a kick on the half beat after 3 (kicks on 1 and 3 alone leave the
      // bar's start ambiguous: the beat model put it half a bar off), snare on 2 and 4, hats on every half beat
      const half = 30 / b.bpm;
      if (b.beatInBar === 0) { hit(x, sr, b.t, 'kick', rnd); hit(x, sr, b.t, 'crash', rnd); }
      if (b.beatInBar === 2) hit(x, sr, b.t + half, 'kick', rnd);
      if (b.beatInBar === 1 || b.beatInBar === 3) hit(x, sr, b.t, 'snare', rnd);
      hit(x, sr, b.t, 'hat', rnd);
      hit(x, sr, b.t + half, 'hat', rnd);
    }
  }
  for (const [from, to] of song.voice || []) voice(x, sr, from, to);
  if (song.pad) pad(x, sr, song.pad);
  return x;
}

// The 22050 Hz version of a 44100 Hz render: a 129-tap low-pass, then every second sample.
// h[n] = 2fc·sinc(2fc·n)·w[n] for n = -64..64, fc = 0.23 (cycles per input sample, 10143 Hz),
// sinc(x) = sin(πx)/(πx) (1 at 0), w = Blackman: 0.42 + 0.5·cos(πn/64) + 0.08·cos(2πn/64),
// the taps then scaled to sum to 1. y[k] = Σ h[n]·x[2k + n] (x is 0 outside the song), summed in
// doubles, stored as float32; y has floor(x.length / 2) samples.
export function half(x) {
  const N = 64, fc = 0.23, h = new Float64Array(2 * N + 1);
  let sum = 0;
  for (let n = -N; n <= N; n++) {
    const a = 2 * fc * n, sinc = n === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
    const w = 0.42 + 0.5 * Math.cos(Math.PI * n / N) + 0.08 * Math.cos(2 * Math.PI * n / N);
    h[n + N] = 2 * fc * sinc * w;
    sum += h[n + N];
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  const y = new Float32Array(Math.floor(x.length / 2));
  for (let k = 0; k < y.length; k++) {
    let v = 0;
    const c = 2 * k;
    for (let n = -N; n <= N; n++) { const i = c + n; if (i >= 0 && i < x.length) v += h[n + N] * x[i]; }
    y[k] = v;
  }
  return y;
}

// a sustained chord over the whole song: equal-tempered notes (MIDI numbers, A4 = 69 = 440 Hz),
// each a sine at 0.06 with its octave at 0.03
function pad(x, sr, notes) {
  const fs = notes.map((n) => 440 * 2 ** ((n - 69) / 12));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (const f of fs) v += 0.06 * Math.sin(2 * Math.PI * f * i / sr) + 0.03 * Math.sin(4 * Math.PI * f * i / sr);
    x[i] += v;
  }
  return x;
}

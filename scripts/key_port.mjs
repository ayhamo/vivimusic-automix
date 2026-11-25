// The key, step by step (analysis-cases.md "The key"): a plain-JS port of Essentia's KeyExtractor
// with its defaults, the PC's analyser. Checked against the PC's analyses of the Spotify benchmark:
//   node scripts/key_port.mjs [songs] [v]   (default 30 songs; v prints every song)
// 2026-11-25: 323/323 songs the same key, confidence within 0.00005.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
const B = 'D:/Programs/Projects/YT Clients/research/spotify-mixes/bench';
const SR = 44100, N = 4096, HOP = 4096, FMIN = 25, FMAX = 3500, MAXPEAKS = 60, THR = 1e-4;
const decode = (f) => { const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 });
  const st = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2); const m = new Float32Array(st.length >> 1);
  for (let i = 0; i < m.length; i++) m[i] = (st[2 * i] + st[2 * i + 1]) / 2; return m; };

// FFT (radix 2, in place)
function fft(re, im) { const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], xr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, xi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
      re[i + k] = ur + xr; im[i + k] = ui + xi; re[i + k + len / 2] = ur - xr; im[i + k + len / 2] = ui - xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }

const win = new Float64Array(N); { let s = 0; for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); s += win[i]; } for (let i = 0; i < N; i++) win[i] *= 2 / s; }
const lin2db = (x) => (x < 1e-10 ? -100 : 10 * Math.log10(x)), db2lin = (x) => Math.pow(10, x / 10);

function peaks(mag) { // PeakDetection, interpolate, range SR/2, scale SR/N
  const scale = SR / N, size = mag.length, out = []; let i = Math.max(0, Math.ceil(FMIN / scale));
  if (i + 1 < size && mag[i] > mag[i + 1] && mag[i] > THR) out.push([i * scale, mag[i]]);
  while (true) {
    while (i + 1 < size - 1 && mag[i] >= mag[i + 1]) i++;
    while (i + 1 < size - 1 && mag[i] < mag[i + 1]) i++;
    let j = i; while (j + 1 < size - 1 && mag[j] === mag[j + 1]) j++;
    if (j + 1 < size - 1 && mag[j + 1] < mag[j] && mag[j] > THR) {
      let pos, val;
      if (j !== i) { pos = (i + j) * 0.5; val = mag[i]; }
      else { const L = mag[j - 1], M = mag[j], R = mag[j + 1], d = 0.5 * ((L - R) / (L - 2 * M + R)); pos = j + d; val = M - 0.25 * (L - R) * d; }
      if (pos * scale > FMAX) break; out.push([pos * scale, val]);
    }
    i = j; if (i + 1 >= size - 1) { break; }
  }
  out.sort((a, b) => b[1] - a[1] || a[0] - b[0]); return out.slice(0, MAXPEAKS);
}

function whiten(spec, pk) { // SpectralWhitening
  const maxFreq = FMAX * 1.2, range = SR / 2, S = spec.length, xs = [], ys = [];
  for (let f = 0; f <= maxFreq && f <= range; f += 100) {
    const bf = f - Math.max(50, f * 0.34), ef = f + Math.max(50, f * 0.58);
    let b = Math.trunc(bf / range * (S - 1) + 0.5); b = Math.min(S - 1, Math.max(0, b));
    let e = Math.trunc(ef / range * (S - 1) + 0.5); e = Math.min(S, Math.max(e, b + 1));
    const c = b / 2 + e / 2, hw = e - c; let wavg = 0, n = 0;
    for (let i = b; i < e; i++) { let w = 1 - Math.abs(i - c) / hw; w *= w; w *= w; const en = spec[i] * spec[i]; w *= en; wavg += en * w; n += w; }
    if (n !== 0) wavg /= n; xs.push(f); ys.push(wavg);
  }
  ys[ys.length - 1] = ys[ys.length - 2];
  for (let k = 0; k < ys.length; k++) ys[k] = 2 * lin2db(Math.sqrt(ys[k]));
  const env = (f) => { const k = Math.min(xs.length - 2, Math.floor(f / 100)); const t = (f - xs[k]) / (xs[k + 1] - xs[k]); return ys[k] + t * (ys[k + 1] - ys[k]); };
  return pk.map(([f, m]) => { const amp = 2 * lin2db(m); let w;
    if (f > maxFreq - 100) w = amp; else { const ae = env(f); w = amp > ae ? 0 : amp > ae - 30 ? amp - ae : -200; w -= 20 * f / 4000; }
    return [f, db2lin(w / 2)]; });
}

const HARM = [[0, 3], [12 * Math.log2(3) - 12, 1], [12 * Math.log2(5) - 24, 1 / Math.max(1, 12 * Math.log2(5) / 12 * 0.5)]];
function hpcp(pk) { const h = new Float64Array(12);
  for (const [f0, m] of pk) { if (f0 < FMIN || f0 > FMAX) continue;
    for (const [s, w] of HARM) { const f = f0 * Math.pow(2, -s / 12), bin = Math.log2(f / 440) * 12;
      for (let i = Math.ceil(bin - 0.5); i <= Math.floor(bin + 0.5); i++) { const d = Math.abs(bin - i); h[((i % 12) + 12) % 12] += Math.cos(Math.PI * d) * m * m * w * w; } } }
  return h; }

const MAJ = [1, 0, 0.42, 0, 0.53, 0.37, 0, 0.77, 0, 0.38, 0.21, 0.30], MIN = [1, 0, 0.36, 0.39, 0, 0.38, 0, 0.74, 0.27, 0, 0.42, 0.23];
const KEYS = ['A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab'];
const ms = (v) => { const m = v.reduce((a, b) => a + b) / 12; return [m, Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0))]; };
function key(p) {
  const [pm, ps] = ms(p); const best = (P) => { const [m, s] = ms(P); let mx = -1, at = 0;
    for (let sh = 0; sh < 12; sh++) { let r = 0; if (ps && s) { for (let i = 0; i < 12; i++) r += (p[i] - pm) * (P[((i - sh) % 12 + 12) % 12] - m); r /= ps * s; } if (r > mx) { mx = r; at = sh; } } return [mx, at]; };
  const [a, ai] = best(MAJ), [b, bi] = best(MIN);
  return a > b ? { key: KEYS[ai], scale: 'major', strength: a } : { key: KEYS[bi], scale: 'minor', strength: b };
}

export function keyOf(x) {
  const acc = new Float64Array(12); let frames = 0; const re = new Float64Array(N), im = new Float64Array(N);
  for (let start = -N / 2; ; start += HOP) {
    for (let k = 0; k < N; k++) { const j = (k + N / 2) % N, s = start + j; re[k] = (s >= 0 && s < x.length ? x[s] : 0) * win[j]; im[k] = 0; }
    fft(re, im); const mag = new Float64Array(N / 2 + 1); for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    const h = hpcp(whiten(mag, peaks(mag))); for (let k = 0; k < 12; k++) acc[k] += h[k]; frames++;
    if (start + N / 2 >= x.length) break;
  }
  const p = Array.from(acc, (v) => v / frames); const mx = Math.max(...p); for (let k = 0; k < 12; k++) { p[k] = mx > 0 ? p[k] / mx : 0; if (p[k] < 0.2) p[k] = 0; }
  return key(p);
}

const norm = (s) => s.replace('♭', 'b').replace('♯', '#');
const ids = Object.keys(JSON.parse(readFileSync(B + '/key.json')).songs).slice(0, +process.argv[2] || 30);
const files = readdirSync(B + '/audio'); let same = 0, n = 0, dstr = 0;
for (const id of ids) {
  const f = files.find((x) => x.startsWith(id + '.')); if (!f) continue;
  const pc = JSON.parse(readFileSync(`${B}/pc/${id}.json`)); const k = keyOf(decode(`${B}/audio/${f}`));
  const mine = `${k.key} ${k.scale}`, ok = mine === norm(pc.keyName); same += ok; n++; dstr += Math.abs(k.strength - pc.keyConfidence);
  if (!ok || process.argv[3]) console.log(id, 'port', mine, k.strength.toFixed(3), '| essentia', pc.keyName, (+pc.keyConfidence).toFixed(3));
}
console.log(`same key ${same}/${n}, mean |strength diff| ${(dstr / n).toFixed(4)}`);

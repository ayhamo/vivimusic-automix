// Fixtures for the offset fit and the level (spec/addons/offset-map.md, Fixtures):
// synthetic songs from a fixed seed, checked against src/addons/offset-fit.js.
// The PRNG and the generator are spelled out in the spec so a port builds the
// same signals.
//
//   node scripts/addon_offset_fixtures.mjs        (exit 1 on a failure)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../src/addons/offset-fit.js');
const R = F.FIT_RATE;   // 22 050 Hz

// mulberry32: the spec's PRNG (uniform in [0, 1))
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// the spec's song: 120 BPM; per beat (0.5 s) a kick (a 60 Hz sine, gain 0.3-1.0, decay 8/s)
// and per bar (2 s) a chord of 3 sines (110-880 Hz, gain 0.05-0.15 each) and a hi-hat of
// noise (gain 0-0.1, decay 30/s) on every off-beat; then scaled to the peak asked for.
function song(seed, seconds, peakDb = -12) {
  const rnd = mulberry32(seed);
  const x = new Float32Array(Math.round(seconds * R));
  const beats = Math.ceil(seconds * 2);
  for (let b = 0; b < beats; b++) {
    const kick = 0.3 + 0.7 * rnd(), hat = 0.1 * rnd();
    const s0 = Math.round(b * 0.5 * R);
    let chord = null;
    if (b % 4 === 0) chord = [0, 1, 2].map(() => ({ f: 110 + 770 * rnd(), g: 0.05 + 0.1 * rnd() }));
    for (let i = 0; i < 0.5 * R && s0 + i < x.length; i++) {
      const t = i / R;
      x[s0 + i] += kick * Math.exp(-8 * t) * Math.sin(2 * Math.PI * 60 * t);
      if (t >= 0.25) x[s0 + i] += hat * Math.exp(-30 * (t - 0.25)) * (2 * rnd() - 1);
    }
    if (chord) for (let i = 0; i < 2 * R && s0 + i < x.length; i++) {
      const t = (s0 + i) / R;
      for (const c of chord) x[s0 + i] += c.g * Math.sin(2 * Math.PI * c.f * t);
    }
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = 10 ** (peakDb / 20) / peak;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
const cat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const silence = (sec) => new Float32Array(Math.round(sec * R));
const scale = (x, db) => x.map((v) => v * 10 ** (db / 20));
const cut = (x, fromSec, toSec) => x.subarray(Math.round(fromSec * R), toSec == null ? x.length : Math.round(toSec * R));

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', name, detail ?? ''); };
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

const SEC = 120;
const yt = song(1, SEC);
const t0 = Date.now();

// the same audio shifted: more lead-in (+), less lead-in (-)
for (const off of [0.7, -2.3, 11]) {
  const ad = off > 0 ? cat(silence(off), yt) : cut(yt, -off);
  const r = F.fit(yt, ad);
  check(`shift ${off > 0 ? '+' : ''}${off} s: offset within 1 ms`, near(r.offsetSec, off, 0.001), JSON.stringify(r));
}
// YouTube's audio opens with 1.5 s of silence, the addon's with 0.4 s
{
  const y = cat(silence(1.5), yt), ad = cat(silence(0.4), yt);
  const r = F.fit(y, ad);
  check('silent openings: read from the first sound, offset -1.1 s', near(r.offsetSec, -1.1, 0.001), JSON.stringify(r));
}
// an edit: 8 s cut from the middle
{
  const r = F.fit(yt, cat(cut(yt, 0, 50), cut(yt, 58)));
  check('8 s cut from the middle: different edit', r.none === 'different edit', JSON.stringify(r));
}
// 12 s more at the end
{
  const r = F.fit(yt, cat(yt, song(7, 12)));
  check('12 s longer at the end: length', r.none === 'length' && near(r.extraSec, 12, 0.05), JSON.stringify(r));
}
// another song
{
  const r = F.fit(yt, song(2, SEC));
  check('unrelated audio on the same beat grid: no match (the waveforms disagree)', r.none === 'no match', JSON.stringify(r));
}
// another recording with the same shape: YouTube's 10 ms loudness on noise (seed 5)
{
  const rnd = mulberry32(5), w = R * 0.01, ad = new Float32Array(yt.length);
  for (let i = 0; (i + 1) * w <= yt.length; i++) {
    const a = Math.round(i * w), b = Math.round((i + 1) * w);
    let s = 0;
    for (let k = a; k < b; k++) s += yt[k] * yt[k];
    const rms = Math.sqrt(s / (b - a)) * Math.sqrt(3);   // uniform noise in [-1, 1) has RMS 1/sqrt(3)
    for (let k = a; k < b; k++) ad[k] = rms * (2 * rnd() - 1);
  }
  const r = F.fit(yt, ad);
  check('same loudness shape, other audio: the envelope agrees, the waveform does not: no match', r.none === 'no match' && r.score >= 0.8 && r.fineScore < 0.8, JSON.stringify(r));
}
// silent YouTube audio
{
  const r = F.fit(silence(SEC), yt);
  check('silent YouTube audio: silent', r.none === 'silent', JSON.stringify(r));
}
// a short song (60 s): the check reads its middle
{
  const s = song(3, 60), r = F.fit(s, cat(silence(0.25), s));
  check('a 60 s song: offset +0.25 s, checked in the middle', near(r.offsetSec, 0.25, 0.001) && near(r.checkSec, 20, 0.5), JSON.stringify(r));
}

// level: gainDb = ytLufs - addonLufs, a boost at most +6 dB, the true peak at most -1 dBTP
const lufs = (x) => F.integratedLufs(x, R);
const gain = (y, ad) => F.sourceGainDb({ ytLufs: lufs(y), addonLufs: lufs(ad), addonChannels: [ad], rate: R });
{
  const g = gain(yt, scale(yt, -4));
  check('4 dB quieter (peaks allow it): +4 dB', near(g.gainDb, 4, 0.05) && g.capped === null, JSON.stringify(g));
}
{
  const g = gain(yt, scale(yt, -9));
  check('9 dB quieter: capped at +6 dB', near(g.gainDb, 6, 0.001) && g.capped === 'boost' && near(g.wantDb, 9, 0.05), JSON.stringify(g));
}
{
  const loud = song(1, SEC, -0.5);   // YouTube's copy peaks at -0.5 dBFS
  const g = gain(loud, scale(loud, -3));   // the file is 3 dB quieter: peaks at -3.5 dBFS, +3 dB would reach -0.5
  check('3 dB quieter, peaks near full scale: held at -1 dBTP', g.capped === 'peak' && g.gainDb < 3 && near(g.truePeakDb + g.gainDb, -1, 0.001), JSON.stringify(g));
}
{
  const g = gain(yt, scale(yt, 3));
  check('3 dB louder: -3 dB, no peak check', near(g.gainDb, -3, 0.05) && g.truePeakDb === undefined, JSON.stringify(g));
}
{
  // a sine at a quarter of the rate, 45° off the samples: every sample is at 0.707 of the
  // amplitude (-9.03 dBFS for 0.5), the true peak between them is the amplitude (-6.02);
  // the 16-tap interpolator reads up to ~0.15 dB high this close to Nyquist (the safe side)
  const x = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin(Math.PI / 2 * i + Math.PI / 4));
  const tp = F.truePeakDb([x], 48000, -12);
  check('true peak between the samples: -6.02 dBTP where the samples reach -9.03', tp >= -6.03 && tp <= -5.85, tp.toFixed(3));
  check('true peak skips quiet samples: nothing above -6 dBFS reads the sample peak', near(F.truePeakDb([x], 48000, -6), -9.03, 0.01), F.truePeakDb([x], 48000, -6).toFixed(3));
}
for (const [rate, tol] of [[48000, 0.005], [22050, 0.05]]) {
  // BS.1770: a 997 Hz sine at 0 dBFS in one channel reads -3.01 LUFS; at -20 dBFS, -23.01
  const s = new Float32Array(10 * rate).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 997 * i) / rate));
  const l = F.integratedLufs(s, rate);
  check(`K-weighting at ${rate} Hz: a 997 Hz sine at -20 dBFS reads -23.01 LUFS (±${tol})`, near(l, -23.01, tol), l.toFixed(3));
}

console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

// Unit tests for the Automix planner (src/automix/automix.js): where a blend
// starts, how long it is, and the Auto blend length.
// Run: node --test scripts/test_automix_plan.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// automix.js is a content script: run it with just enough of the extension world.
function loadAutomix(bars, settings = {}) {
  const listeners = [];
  const window = { addEventListener() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = {
    runtime: { getURL: (p) => 'chrome-extension://test' + p },
    storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, automixBars: bars, ...settings }) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const ctx = vm.createContext({ window, chrome, document: {}, console: { log() {} }, performance, setTimeout, clearTimeout, URL });
  vm.runInContext(readFileSync(new URL('../src/automix/automix.js', import.meta.url), 'utf8'), ctx);
  return window.__viviAutomix;
}

// An analysed song: a steady grid, an energy curve in 4-bar windows.
function song(bpm, durationSec, { conf = 1, down = 0.4, energy = () => 1, sub = null } = {}) {
  const beat = 60 / bpm, win = beat * 16;
  const curve = Array.from({ length: Math.ceil(durationSec / win) }, (_, i) => energy(i * win));
  return {
    bpm, beatIntervalSec: beat, firstDownbeatSec: down, gridConfidence: conf, durationSec,
    energyCurve: curve, energy: curve.reduce((a, b) => a + b, 0) / curve.length,
    introEndSec: 0, outroStartSec: durationSec - 20,
    ...(sub != null ? { subBassRatio: sub } : {}),
  };
}

const planOf = (A, cur, next, pos = 20) =>
  A.plan({ fromId: 'a', toId: 'b', from: cur, to: next, durationSec: cur.durationSec, pos, earliest: pos + 4.5 });
const barSec = (bpm) => 240 / bpm;
const isDownbeat = (t, s) => Math.abs(((t - s.firstDownbeatSec) / barSec(s.bpm)) % 1) < 1e-6 || Math.abs(((t - s.firstDownbeatSec) / barSec(s.bpm)) % 1 - 1) < 1e-6;

test('Up to 16 bars (BitChord web default): a 16-bar blend that ends a bar before the song', () => {
  const A = loadAutomix(16);
  const cur = song(92, 104), p = planOf(A, cur, song(92, 180));
  assert.equal(p.style, 'blend');
  assert.equal(p.bars, 16);
  assert.ok(Math.abs(p.durationSec - 16 * barSec(92)) < 1e-9);
  const end = p.mixOutTrackTime + p.durationSec;
  assert.ok(end <= cur.durationSec - barSec(92) + 1e-6, 'ends at least a bar before the song');
  assert.ok(end > cur.durationSec - 2 * barSec(92), 'and within two bars of it');
  assert.ok(isDownbeat(p.mixOutTrackTime, cur), 'starts on a downbeat');
});

test('Up to N bars keeps BitChord web: 8 bars, and 16 shortened to 8 on a weak grid', () => {
  assert.equal(planOf(loadAutomix(8), song(120, 200), song(120, 200)).bars, 8);
  assert.equal(planOf(loadAutomix(16), song(120, 200, { conf: 0.5 }), song(120, 200)).bars, 8);
  assert.equal(planOf(loadAutomix(16), song(120, 200, { conf: 0.3 }), song(120, 200)).bars, 4);
});

test('Auto: 4 bars at an ordinary tempo (16 beats, under 12 s)', () => {
  const p = planOf(loadAutomix('auto'), song(92, 104), song(92, 180));
  assert.equal(p.bars, 4);
  assert.ok(p.durationSec <= 12);
});

test('Auto: 8 bars only when both sides of the join are calm and it fits in 16 s', () => {
  const A = loadAutomix('auto');
  const calmEnd = (d) => (t) => (t > d - 30 ? 0.3 : 1);
  const calmStart = (t) => (t < 30 ? 0.3 : 1);
  assert.equal(planOf(A, song(128, 200, { energy: calmEnd(200) }), song(128, 200, { energy: calmStart })).bars, 8);
  assert.equal(planOf(A, song(128, 200, { energy: calmEnd(200) }), song(128, 200)).bars, 4, 'only one side calm');
  assert.equal(planOf(A, song(100, 200, { energy: calmEnd(200) }), song(100, 200, { energy: calmStart })).bars, 4, '8 bars at 100 BPM is over 16 s');
});

test('Auto: never more than 40% of a short next song', () => {
  const p = planOf(loadAutomix('auto'), song(140, 200), song(140, 15));
  assert.equal(p.bars, 4);   // the smallest choice; the phone floor is one bar
});

test('Tempos too far apart: a filter mix that ends with the song', () => {
  const cur = song(120, 200), p = planOf(loadAutomix('auto'), cur, song(80, 200));
  assert.equal(p.style, 'filter');
  const end = p.mixOutTrackTime + p.durationSec;
  assert.ok(end <= cur.durationSec - 0.3 && end > cur.durationSec - 2 * barSec(120) - 1e-6);
});

test('No grid: the 12 s crossfade ends with the song', () => {
  const p = planOf(loadAutomix(16), song(120, 200, { conf: 0 }), song(120, 200));
  assert.equal(p.style, 'crossfade');
  assert.ok(Math.abs(p.mixOutTrackTime + p.durationSec - (200 - 0.3)) < 1e-6);
});

test('No analysis yet: the placeholder crossfade sits at the end too', () => {
  const A = loadAutomix('auto');
  const p = A.plan({ fromId: 'a', toId: 'b', from: null, to: null, durationSec: 150, pos: 10, earliest: 14.5 });
  assert.equal(p.style, 'crossfade');
  assert.ok(Math.abs(p.mixOutTrackTime - (150 - 0.3 - 12)) < 1e-6);
});

test('Never more than 12 s of music skipped after a blend (60-200 BPM, every setting)', () => {
  for (const bars of ['auto', 4, 8, 16, 32]) {
    const A = loadAutomix(bars);
    for (let bpm = 60; bpm <= 200; bpm += 7) {
      const cur = song(bpm, 240), p = planOf(A, cur, song(bpm, 240));
      const left = cur.durationSec - (p.mixOutTrackTime + p.durationSec);
      assert.ok(left >= 0 && left <= 12, `${bars} bars at ${bpm} BPM leaves ${left.toFixed(1)} s`);
    }
  }
});

test('Seeked past the natural point: the next phrase after the earliest start (unchanged)', () => {
  const cur = song(120, 200), A = loadAutomix(8);
  const natural = planOf(A, cur, song(120, 200)).mixOutTrackTime;
  const p = planOf(A, cur, song(120, 200), natural + 1);
  assert.ok(p.mixOutTrackTime >= natural + 1 + 4.5 - 1e-6);
});

// The Automix overview's pick for a pair: { style, bars }
const pickOf = (A, cur, next, pick, pos = 20) =>
  A.plan({ fromId: 'a', toId: 'b', from: cur, to: next, durationSec: cur.durationSec, pos, earliest: pos + 4.5, pick });

test('Overview pick: a length overrides the setting, and only for that plan', () => {
  const A = loadAutomix('auto');
  assert.equal(pickOf(A, song(120, 200), song(120, 200), { style: null, bars: 16 }).bars, 16);
  assert.equal(planOf(A, song(120, 200), song(120, 200)).bars, 4, 'the next plan without a pick is Auto again');
  assert.equal(pickOf(A, song(120, 200), song(120, 200), { style: 'blend', bars: 32 }).bars, 32);
});

test('Overview pick: filter mix and fade on a pair that would blend', () => {
  const A = loadAutomix('auto');
  const f = pickOf(A, song(120, 200), song(120, 200), { style: 'filter', bars: 16 });
  assert.equal(f.style, 'filter');
  assert.equal(f.bars, 8, 'a filter mix is at most 8 bars');
  const x = pickOf(A, song(120, 200), song(120, 200), { style: 'crossfade', bars: null });
  assert.equal(x.style, 'crossfade');
  assert.ok(x.mixOutTrackTime + x.durationSec <= 200, 'ends with the song');
});

test('Overview pick: a picked length still fits the song (a weak grid shortens it)', () => {
  const A = loadAutomix('auto');
  assert.equal(pickOf(A, song(120, 200, { conf: 0.3 }), song(120, 200), { style: 'blend', bars: 16 }).bars, 4);
});

test('Overview pick: a picked length beats the key-aware short blend', () => {
  const A = loadAutomix('auto', { automixVersion: 2, automixKeyAware: true });
  const keyed = (num, letter) => ({ ...song(120, 200), camelot: { num, letter }, keyConfidence: 1 });
  const cur = keyed(1, 'A'), next = keyed(6, 'B');   // far apart on the wheel: a clash
  assert.equal(planOf(A, cur, next).bars, 2, 'clashing keys get the short blend');
  assert.equal(pickOf(A, cur, next, { style: 'blend', bars: 16 }).bars, 16, 'unless a length was picked');
  assert.equal(planOf(A, cur, next).bars, 2, 'and only for the plan it was picked for');
});

// ───────── the transition editor's overrides (spec/automix/editor.md §9) ─────────
const planPick = (A, cur, next, pick, pos = 20) =>
  A.plan({ fromId: 'a', toId: 'b', from: cur, to: next, durationSec: cur.durationSec, pos, earliest: pos + 4.5, pick });

test('Editor: old picks migrate ({style, bars} → override)', () => {
  const A = loadAutomix('auto');
  assert.deepEqual({ ...A.migratePick({ style: 'loop', bars: null }) }, { preset: 'loop' });
  assert.deepEqual({ ...A.migratePick({ style: 'filter', bars: 8 }) }, { preset: 'auto', family: 'filter', bars: 8 });
  assert.deepEqual({ ...A.migratePick({ style: 'crossfade', bars: null }) }, { preset: 'auto', beatMatch: 'off' });
  assert.equal(A.migratePick({ style: null, bars: null }), null);
  const ov = { v: 1, preset: 'rise' };
  assert.equal(A.migratePick(ov), ov);
});

test('Editor: a preset keeps the planner\'s blend and replaces its curves', () => {
  for (const v of [2, 3]) {
    const A = loadAutomix('auto', { automixVersion: v });
    const cur = song(120, 200), next = song(120, 200);
    const auto = planPick(A, cur, next, null);
    const p = planPick(A, cur, next, { preset: 'melt', bars: 8 });
    assert.equal(p.style, 'blend');
    assert.equal(p.bars, 8);
    assert.equal(p.preset, 'melt');
    assert.deepEqual(p.curves.out.highpassHz, A.presetCurves({ preset: 'melt' }, p.durationSec, p.beatSec).out.highpassHz);
    assert.equal(auto.preset, undefined);
  }
});

test('Editor: Slam is 2 bars unless a length is asked for', () => {
  const A = loadAutomix('auto');
  assert.equal(planPick(A, song(120, 200), song(120, 200), { preset: 'slam' }).bars, 2);
  assert.equal(planPick(A, song(120, 200), song(120, 200), { preset: 'slam', bars: 4 }).bars, 4);
});

test('Editor: beat match Off overlaps at the length asked for, songs at their own speed', () => {
  const A = loadAutomix('auto');
  const p = planPick(A, song(120, 200), song(126, 200), { beatMatch: 'off', bars: 8 });
  assert.equal(p.style, 'crossfade');
  assert.equal(p.rate, 1);
  assert.ok(Math.abs(p.durationSec - 8 * barSec(120)) < 1e-9);
  // with neither length nor window: the plain crossfade, as a "Fade" pick was
  const q = planPick(A, song(120, 200), song(126, 200), { style: 'crossfade', bars: null });
  assert.equal(q.style, 'crossfade');
  assert.equal(q.fallback, true);
});

test('Editor: Sync out of range (tempos 11% apart) plays Off and says why', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const p = planPick(A, song(100, 200), song(111, 200), { preset: 'smooth', beatMatch: 'sync', bars: 8 });
  assert.equal(p.style, 'crossfade');
  assert.match(p.warnings.join(' '), /11% apart: Sync stretches at most 8%/);
  assert.equal(p.preset, 'smooth');
});

test('Editor: Glide in range glides; Sync holds one rate', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const g = planPick(A, song(120, 200), song(124, 200), { preset: 'smooth', beatMatch: 'glide', bars: 8 });
  assert.ok(g.glide, 'a glide');
  assert.ok(g.curves.in.rate, 'the planner\'s rate curve stays');
  const s = planPick(A, song(120, 200), song(124, 200), { preset: 'smooth', beatMatch: 'sync', bars: 8 });
  assert.equal(s.glide, null);
});

test('Editor: the window lands where saved, clamped when out of reach', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const cur = song(120, 200), next = song(120, 200), bar = barSec(120);
  const out = { bar: 80, sec: 0.4 + 80 * bar }, inn = { bar: 8, sec: 0.4 + 8 * bar };
  const p = planPick(A, cur, next, { preset: 'blend', bars: 8, window: { out, in: inn } });
  assert.ok(Math.abs(p.mixOutTrackTime - out.sec) < 1e-6);
  assert.ok(Math.abs(p.mixInTrackTime - inn.sec) < 1e-6);
  assert.equal(p.warnings, undefined);
  // a mix-out already played: the planner's own mix-out, with the reason
  const q = planPick(A, cur, next, { preset: 'blend', bars: 8, window: { out: { bar: 2, sec: 0.4 + 2 * bar } } }, 60);
  assert.equal(q.mixOutTrackTime, planPick(A, cur, next, { preset: 'blend', bars: 8 }, 60).mixOutTrackTime);
  assert.match(q.warnings.join(' '), /mix-out at 4\.4 s has already played: Auto's mix-out instead/);
  // too close to the end: moved back onto a downbeat that fits
  const r = planPick(A, cur, next, { preset: 'blend', bars: 8, window: { out: { bar: 95, sec: 0.4 + 95 * bar } } });
  assert.ok(r.mixOutTrackTime < 0.4 + 95 * bar && isDownbeat(r.mixOutTrackTime, cur), `${r.mixOutTrackTime} on a downbeat`);
  assert.ok(r.mixOutTrackTime + r.durationSec <= cur.durationSec - 0.3);
  assert.match(r.warnings.join(' '), /mix-out moved to .*too close to the end/);
});

test('Editor: beat match Off with a window: clamped onto a downbeat, songs at their own speed', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const cur = song(120, 200), bar = barSec(120);
  const p = planPick(A, cur, song(126, 200), { beatMatch: 'off', bars: 8, window: { out: { bar: 95, sec: 0.4 + 95 * bar } } });
  assert.equal(p.style, 'crossfade');
  assert.equal(p.rate, 1);
  assert.ok(isDownbeat(p.mixOutTrackTime, cur) && p.mixOutTrackTime + p.durationSec <= cur.durationSec - 0.3);
  assert.match(p.warnings.join(' '), /too close to the end/);
  // more bars than the song has left: the room there is, said
  const q = planPick(A, cur, song(126, 200), { beatMatch: 'off', bars: 32 }, 160);
  assert.ok(q.durationSec < 32 * bar);
  assert.match(q.warnings.join(' '), /32 bars don't fit before the end/);
});

test('Editor: Slam with beat match Off is still 2 bars', () => {
  const A = loadAutomix('auto');
  const p = planPick(A, song(120, 200), song(126, 200), { preset: 'slam', beatMatch: 'off' });
  assert.equal(p.style, 'crossfade');
  assert.ok(Math.abs(p.durationSec - 2 * barSec(120)) < 1e-9);
});

test('Editor: Glide on Classic glides too (the plan carries it)', () => {
  const A = loadAutomix('auto', { automixVersion: 2 });
  const g = planPick(A, song(120, 200), song(124, 200), { preset: 'smooth', beatMatch: 'glide', bars: 8 });
  assert.ok(g.glide, 'a glide');
  assert.ok(Math.abs(g.durationSec - A.glideSteps(g.glide.q, g.glide.beats, g.glide.beatOutSec).total) < 1e-9);
});

test('Editor: a preset on a pair too far apart in tempo keeps its length and says why', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const auto = planPick(A, song(100, 200), song(111, 200), null);
  assert.match(auto.reason, /hand-over/, 'Auto hands over');
  const p = planPick(A, song(100, 200), song(111, 200), { preset: 'wave', bars: 8 });
  assert.equal(p.style, 'crossfade');
  assert.ok(Math.abs(p.durationSec - 8 * barSec(100)) < 1e-9);
  assert.match(p.warnings.join(' '), /11% apart.*plays without beat match/);
});

test('Editor: an override keeps only the schema\'s values', () => {
  const A = loadAutomix('auto');
  assert.equal(A.normalizeOverride({ preset: 'bogus' }), null);
  assert.equal(A.normalizeOverride({ preset: 'custom', lanes: { volume: 'loud', eq: 'none', effect: 'none' } }), null);
  const o = A.normalizeOverride({ preset: 'rise', window: { out: { bar: 3, beat: 7, sec: 10 } } });
  assert.deepEqual({ ...o.window.out }, { bar: 3, sec: 10 });
});

test('Editor: a style gate warns instead of refusing (sub-bass veto)', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const cur = song(120, 200, { sub: 0 }), next = song(120, 200, { sub: 1 });
  const auto = planPick(A, cur, next, null);
  assert.match(auto.reason, /sub-bass/, 'Auto refuses');
  const p = planPick(A, cur, next, { preset: 'wave', bars: 8 });
  assert.equal(p.style, 'blend');
  assert.match(p.warnings.join(' '), /sub-bass 1\.00 apart/);
});

test('Editor: a length alone on a vetoed pair says why it is not used', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const p = planPick(A, song(120, 200, { sub: 0 }), song(120, 200, { sub: 1 }), { bars: 16 });
  assert.ok(p.handoff, 'still the hand-over: a length alone is not forced');
  assert.match(p.warnings.join(' '), /^16 bars not used: different sub-bass/);
});

test('Editor: Loop drops beat match, and a nudge that rounds to 0 is not saved', () => {
  const A = loadAutomix('auto');
  assert.deepEqual({ ...A.normalizeOverride({ preset: 'loop', beatMatch: 'sync' }) }, { v: 1, preset: 'loop' });
  const o = A.normalizeOverride({ preset: 'rise', window: { in: { bar: 2, nudgeMs: 4, sec: 4.4 } } });
  assert.deepEqual({ ...o.window.in }, { bar: 2, sec: 4.4 });
});

test('Editor: windowLimits are where the planner clamps the window', () => {
  const A = loadAutomix('auto');
  const cur = song(120, 200), next = song(120, 180);
  const m = planOf(A, cur, next);
  const lim = A.windowLimits(m, cur, next, 24.5);
  const span = m.bars * barSec(120);
  assert.deepEqual([...lim.out], [24.5 + (m.rampSongSec || 0), 200 - 0.3 - span]);
  assert.deepEqual([...lim.in], [0, 180 - 10 - span]);
  // a saved mix-out past the end lands inside them
  const p = planPick(A, cur, next, { preset: 'blend', bars: m.bars, window: { out: { bar: 99, sec: 0.4 + 99 * barSec(120) } } });
  assert.ok(p.mixOutTrackTime <= lim.out[1] + 1e-6 && p.mixOutTrackTime >= lim.out[0]);
});

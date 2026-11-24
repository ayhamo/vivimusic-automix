// Unit tests for the Automix planner (src/automix/automix.js): where a blend
// starts, how long it is, and the Auto blend length.
// Run: node --test scripts/test_automix_plan.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// automix.js is a content script: run it with just enough of the extension world.
function loadAutomix(bars, settings = {}, hooks = {}) {
  const listeners = [];
  const window = { addEventListener: (type, fn) => { if (type === 'message') { const prev = hooks.post; hooks.post = (data) => { prev?.(data); fn({ origin: new URL('chrome-extension://test/').origin, data: { ch: 'vivi-automix', ...data } }); }; } }, location: { origin: 'https://music.youtube.com' } };
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

test('The plain crossfade takes the user crossfade length (fadeSec 1-12 s), 12 s without one', () => {
  const A = loadAutomix('auto');
  const at = (fadeSec) => A.plan({ fromId: 'a', toId: 'b', from: null, to: null, durationSec: 150, pos: 10, earliest: 14.5, fadeSec });
  for (const [ask, want] of [[5, 5], [1, 1], [12, 12], [30, 12], [0, 12], [null, 12]]) {
    const p = at(ask);
    assert.ok(p.fallback && Math.abs(p.durationSec - want) < 1e-6, `fadeSec ${ask}: ${p.durationSec} s`);
    assert.ok(Math.abs(p.mixOutTrackTime - (150 - 0.3 - want)) < 1e-6);
  }
  assert.equal(at(null).durationSec, 12, 'a later plan without fadeSec is back at 12 s');
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
  // versions.md "Tempo too far apart": Auto plays a filter mix there (no beat match), not a hand-over
  assert.equal(auto.style, 'filter', 'Auto plays a filter mix');
  assert.match(auto.reason, /11% apart.*a filter mix \(no beat match\)/);
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

// ───────── group 3 (2026-11-24): versions.md "Adlib outro", "No effect three times in a row",
// "Analysis length"; editor.md §6 shortened and retired preset

test('Adlib outro: a voice that never pauses over a beatless end sings out; a 2 s pause or a beat ends it', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const curve = (f) => ({ start: 0, step: 0.25, values: Array.from({ length: 200 * 4 }, (_, i) => f(i / 4)) });
  const voice = (f) => [{ startSec: 150, fps: 20, curve: Array.from({ length: 50 * 20 }, (_, i) => f(150 + i / 20)) }];
  const s = (bass, sing) => ({ ...song(120, 200), bassCurve: curve(bass), vocals: voice(sing) });
  const beatGoneAt190 = (t) => (t < 190 ? 0.5 : 0.05);
  assert.equal(A.singsOut(s(beatGoneAt190, () => 0.9), 185), true);
  assert.equal(A.singsOut(s(beatGoneAt190, (t) => (t >= 192 && t < 194.5 ? 0 : 0.9)), 185), false, 'a 2 s pause');
  assert.equal(A.singsOut(s(() => 0.5, () => 0.9), 185), false, 'the beat still plays');
  assert.equal(A.singsOut(s(beatGoneAt190, () => 0.9), 197), false, 'under 4 s left');
  assert.equal(A.singsOut(song(120, 200), 185), false, 'unmeasured');
});

test('No effect three times in a row: two filter mixes heard, the third pair gets no filter mix', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const p = planOf(A, song(120, 200), song(133, 200));
  assert.equal(p.style, 'filter');
  A.heard(p);
  assert.equal(planOf(A, song(120, 200), song(133, 200)).style, 'filter', 'once is fine');
  A.heard(p);
  const q = planOf(A, song(120, 200), song(133, 200));
  assert.notEqual(q.style, 'filter');
  assert.match(q.reason, /a filter mix the last two times/);
  A.heard({ style: 'blend', bars: 8 });
  assert.equal(planOf(A, song(120, 200), song(133, 200)).style, 'filter', 'a blend in between resets it');
  assert.deepEqual([...A.recentMoves()], ['filter', 'filter', 'blend']);
});

test('Editor: a length over a third of either song is shortened, and says so', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const p = planPick(A, song(120, 60), song(120, 200), { preset: 'blend', bars: 16 });
  assert.equal(p.bars, 10);
  assert.match(p.warnings.join(' '), /shortened to 10 bars \(20\.0 s\): an overlap can't be longer than a third of either song/);
  const q = planPick(A, song(120, 200), song(120, 40), { preset: 'blend', bars: 16 });
  assert.match(q.warnings.join(' '), /shortened to 6 bars/);
  assert.doesNotMatch((planPick(A, song(120, 200), song(120, 200), { preset: 'blend', bars: 16 }).warnings || []).join(' '), /shortened/);
});

test('Editor: a retired preset plays as Automatic, and says so', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const p = planPick(A, song(120, 200), song(120, 200), { preset: 'gone' });
  assert.match(p.warnings.join(' '), /the preset "gone" is no longer offered: Automatic plays/);
  assert.equal(p.style, planOf(A, song(120, 200), song(120, 200)).style);
});

test('Analysis length: a song over 8 minutes is "too long", not a failure, and never retried', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  A.request('long', true, 481);
  assert.equal(A.statusOf('long'), 'tooLong');
  A.request('long', true);
  assert.equal(A.statusOf('long'), 'tooLong');
});

// editor.md §11 (the progress row)
test('Progress row: waiting, the frame stages at their fixed %, a failure with its reason, too long apart', async () => {
  const hooks = {};
  const A = loadAutomix('auto', { automixVersion: 3 }, hooks);
  assert.deepEqual({ ...A.progressOf('x') }, { status: null });
  A.request('a'); A.request('b');
  assert.deepEqual({ ...A.progressOf('a') }, { status: 'analyzing', stage: 'getting the audio', pct: 0 });
  assert.deepEqual({ ...A.progressOf('b') }, { status: 'pending', stage: 'waiting its turn', pct: 0 });
  hooks.post({ type: 'progress', fileKey: 'a:1', stage: 'models' });
  assert.deepEqual({ ...A.progressOf('a') }, { status: 'analyzing', stage: 'finding the beats, the key and the vocals', pct: 25 });
  hooks.post({ type: 'progress', fileKey: 'b:2', stage: 'models' });
  assert.equal(A.progressOf('b').stage, 'waiting its turn', 'a song not analysing ignores a stage');
  hooks.post({ type: 'progress', fileKey: 'a:1', stage: 'nonsense' });
  assert.equal(A.progressOf('a').pct, 25, 'an unknown stage changes nothing');
  await new Promise((r) => setTimeout(r, 20));
  const f = A.progressOf('a');
  assert.equal(f.status, 'error');
  assert.ok(f.why && f.why !== 'unknown', 'the reason is kept: ' + f.why);
  A.request('long', true, 481);
  assert.deepEqual({ ...A.progressOf('long') }, { status: 'tooLong' });
});

// versions.md "Where a song is sung" (2026-11-24)
test('Sung spans: a plain line ends at its words x 0.35 s + 0.5 s, the next line, its own end or 10 s', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const sp = A.sungSpansFromLines([
    { start: 10, end: null, words: 4, wordTimes: null },     // 10 + 4 x 0.35 + 0.5 = 11.9
    { start: 20, end: null, words: 40, wordTimes: null },    // capped at 10 s: 30
    { start: 31, end: null, words: 10, wordTimes: null },    // the next line comes first: 33
    { start: 33, end: 33.8, words: 6, wordTimes: null },     // its own end: 33.8
    { start: 40, end: 45, words: 3, wordTimes: [[40.2, 40.6], [40.6, 41], [41.1, 41.5]] },   // words: 40.2 .. 41.5 + 0.3
  ]);
  const r = sp.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [[10, 11.9], [20, 30], [31, 33], [33, 33.8], [40.2, 41.8]]);
});

test('Sung spans: the vocal mask cuts a gap of a beat or more out of a lyric span, not a shorter one', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const a = { ...song(120, 60), vocals: [{ startSec: 0, fps: 50, curve: Array.from({ length: 60 * 50 }, (_, i) => (i >= 500 && i < 550 ? 0.05 : i >= 700 && i < 715 ? 0.05 : 0.9)) }] };
  // 10-11 s instrumental (1 s, over a 0.5 s beat): cut; 14-14.3 s (0.3 s): kept
  const got = A.carveSung([[8, 16]], a).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [[8, 10], [11, 16]]);
  assert.deepEqual(JSON.parse(JSON.stringify(A.carveSung([[8, 16]], song(120, 60)))), [[8, 16]], 'no mask: as the lyrics say');
});

test('Sung spans: word times run back to back over a silent beat; only the mask carve frees it', () => {
  // Enhanced LRC times word starts only: each word ends where the next starts, the last at the
  // next line's start (lyrics.js repairTimings), so the words cover a breath. Poker Face's case, 2026-11-24.
  const A = loadAutomix('auto', { automixVersion: 3 });
  const sp = A.sungSpansFromLines([
    { start: 20, end: 22, words: 4, wordTimes: [[20, 20.4], [20.4, 21], [21, 21.6], [21.6, 22]] },
    { start: 22, end: 24, words: 3, wordTimes: [[22, 22.5], [22.5, 23.2], [23.2, 24]] },
  ]);
  // the voice is silent 21.5-22.3 s (over a 0.5 s beat), the words say sung throughout
  const covers = (spans, t) => spans.some(([x, y]) => t >= x && t < y);
  assert.ok(covers(sp, 21.75) && covers(sp, 22.1), 'the words cover the breath');
  const a = { ...song(120, 60), vocals: [{ startSec: 0, fps: 50, curve: Array.from({ length: 60 * 50 }, (_, i) => (i >= 1075 && i < 1115 ? 0.03 : 0.9)) }] };
  const carved = A.carveSung(sp, a);
  assert.ok(!covers(carved, 21.75) && !covers(carved, 22.1), 'the carve frees it');
  assert.ok(covers(carved, 21) && covers(carved, 23), 'the words around it stay sung');
});

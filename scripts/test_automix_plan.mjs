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

test("Editor: Slam has the pair's own length, as Spotify's presets (editor.md §2), unless a length is asked for", () => {
  const A = loadAutomix('auto');
  assert.equal(planPick(A, song(120, 200), song(120, 200), { preset: 'slam' }).bars, planOf(A, song(120, 200), song(120, 200)).bars);
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

test('Editor: Slam with beat match Off and a length: that length, songs at their own speed', () => {
  const A = loadAutomix('auto');
  const p = planPick(A, song(120, 200), song(126, 200), { preset: 'slam', beatMatch: 'off', bars: 2 });
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

// versions.md "The mix's ceiling": src/automix/limiter-worklet.js, run in node with the worklet globals faked
function limiterRun(engaged, f, secs = 2) {
  let Proc;
  const port = { postMessage: (m) => { port.last = m; }, onmessage: null };
  const ctx = vm.createContext({ sampleRate: 48000, Math, Float32Array, Float64Array,
    AudioWorkletProcessor: class { constructor() { this.port = port; } }, registerProcessor: (n, c) => { Proc = c; } });
  vm.runInContext(readFileSync(new URL('../src/automix/limiter-worklet.js', import.meta.url), 'utf8'), ctx);
  const p = new Proc();
  port.onmessage({ data: { engaged } });
  const N = 128, ins = [];
  let peak = 0, diff = 0;
  for (let k = 0; k < secs * 48000; k += N) {
    const a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) { a[i] = f((k + i) / 48000); b[i] = -a[i]; ins.push(a[i]); }
    const o = [new Float32Array(N), new Float32Array(N)];
    p.process([[a, b]], [o]);
    for (let i = 0; i < N; i++) {
      peak = Math.max(peak, Math.abs(o[0][i]), Math.abs(o[1][i]));
      const j = k + i - p.L;
      if (j >= 0) diff = Math.max(diff, Math.abs(o[0][i] - ins[j]));
    }
  }
  port.onmessage({ data: { engaged: false } });
  return { peakDb: 20 * Math.log10(peak), diff, minGainDb: port.last?.minGainDb };
}

test('The mix\'s ceiling: engaged, a +5.4 dB sum stays at -1 dBFS; a quieter sum and a single song pass untouched (5 ms late)', () => {
  const P = Math.pow(10, 5.4 / 20);
  const hit = (t) => (t > 1 && t < 1.15 ? P * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-(t - 1) * 20) : 0) + 0.3 * Math.sin(2 * Math.PI * 330 * t);
  const a = limiterRun(true, hit);
  assert.ok(a.peakDb <= -1 + 1e-4 && a.peakDb > -1.2, 'held at the ceiling: ' + a.peakDb);
  assert.ok(a.minGainDb < -5, 'and says how much it took off: ' + a.minGainDb);
  const steady = limiterRun(true, (t) => P * Math.sin(2 * Math.PI * 220 * t));
  assert.ok(steady.peakDb <= -1 + 1e-4, 'a steady sum too: ' + steady.peakDb);
  const quiet = limiterRun(true, (t) => 0.7 * Math.sin(2 * Math.PI * 220 * t));
  assert.equal(quiet.diff, 0, 'under the ceiling: every sample as it was');
  const off = limiterRun(false, hit);
  assert.equal(off.diff, 0, 'not engaged (one song): every sample as it was, peaks too');
  assert.ok(off.peakDb > 5);
});

test('The mix\'s ceiling: no input, no output, or a sample that is not a finite number never stops the limiter or makes NaN', () => {
  // the input itself: a non-finite sample is played as silence, the rest as it was
  const bad = (t) => { const k = Math.round(t * 48000); return k === 48000 ? Infinity : k === 48001 ? NaN : k === 48002 ? -Infinity : 0.5; };
  for (const engaged of [true, false]) {
    const r = limiterRun(engaged, bad);
    assert.ok(Number.isFinite(r.peakDb) && r.peakDb <= 20 * Math.log10(0.5) + 1e-6, 'finite, nothing above the input: ' + r.peakDb);
    if (engaged) assert.ok(Number.isFinite(r.minGainDb), 'its report stays a number: ' + r.minGainDb);
  }
  let Proc;
  const port = { postMessage: (m) => { port.last = m; }, onmessage: null };
  const ctx = vm.createContext({ sampleRate: 48000, Math, Float32Array, Float64Array,
    AudioWorkletProcessor: class { constructor() { this.port = port; } }, registerProcessor: (n, c) => { Proc = c; } });
  vm.runInContext(readFileSync(new URL('../src/automix/limiter-worklet.js', import.meta.url), 'utf8'), ctx);
  const p = new Proc();
  port.onmessage({ data: { engaged: true } });
  assert.equal(p.process([], []), true, 'no output: kept alive');
  assert.equal(p.process([[]], [[]]), true, 'an output with no channels: kept alive');
  const o = [new Float32Array(128), new Float32Array(128)];
  assert.equal(p.process([[]], [o]), true, 'nothing connected: kept alive');
  assert.ok(o[0].every((x) => x === 0) && o[1].every((x) => x === 0), 'and silent');
  port.onmessage({ data: { engaged: false } });
  assert.equal(port.last?.minGainDb, 0, 'silence took nothing off');
});

// fx-plus.js limitFor: the limiter's 5 ms delay never goes in while a song is heard
function loadLimit({ state = 'suspended', paused = true } = {}) {
  const log = [];
  const mk = (name) => {
    const n = { name, outs: new Set(), gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, port: { msgs: [], postMessage(m) { this.msgs.push(m); } } };
    n.connect = (d) => { n.outs.add(d); log.push(`${name}->${d.name}`); return d; };
    n.disconnect = (d) => { if (d) n.outs.delete(d); else n.outs.clear(); };
    return n;
  };
  const evs = {};
  const video = { paused, ended: false, readyState: 4, addEventListener: (e, f) => { evs[e] = f; }, removeEventListener: (e) => { delete evs[e]; } };
  const ctx = { state, currentTime: 1, destination: { name: 'dest' }, audioWorklet: { addModule: async () => {} }, addEventListener: (e, f) => { evs['ctx:' + e] = f; }, removeEventListener: (e) => { delete evs['ctx:' + e]; } };
  const comp = mk('comp'); comp.outs.add(ctx.destination);
  const window = {};
  const sb = vm.createContext({ window, chrome: { runtime: { getURL: (p) => p } }, console: { debug() {}, info() {} }, setTimeout: (f) => f(), Promise,
    AudioWorkletNode: function () { return mk('lim'); }, GainNode: function (_c, o) { return mk('g' + o.gain); } });
  vm.runInContext(readFileSync(new URL('../src/plus/fx-plus.js', import.meta.url), 'utf8'), sb);
  const graph = { ctx, video, entry: {} };
  window.__viviEqPlus.publish(graph, {}, comp);
  return { limit: window.__viviAudioGraph.limit, comp, ctx, video, evs, dest: ctx.destination };
}
const settle = () => new Promise((r) => setImmediate(r));

test('Limiter: goes in at once while the context is not running yet', async () => {
  const t = loadLimit({ state: 'suspended', paused: false });
  await settle();
  assert.equal(t.limit.splicedBy, 'quiet');
  assert.ok(!t.comp.outs.has(t.dest) && [...t.comp.outs][0].name === 'lim');
});

test('Limiter: a playing song keeps the direct path until it pauses', async () => {
  const t = loadLimit({ state: 'running', paused: false });
  await settle();
  assert.equal(t.limit.ready, undefined);
  assert.ok(t.comp.outs.has(t.dest));
  t.video.paused = true; t.evs.pause();
  assert.equal(t.limit.splicedBy, 'quiet');
  assert.ok(!t.comp.outs.has(t.dest));
  assert.equal(Object.keys(t.evs).length, 0);   // the listeners are gone
});

test('Limiter: a mix starting mid-song puts it in under a blend, then engages it', async () => {
  const t = loadLimit({ state: 'running', paused: false });
  await settle();
  t.limit(true);
  assert.equal(t.limit.splicedBy, 'blend');
  assert.ok(!t.comp.outs.has(t.dest));
  const lim = [...t.comp.outs].find((n) => n.name === 'lim');
  assert.ok(lim && lim.outs.has(t.dest));        // after the blend: limiter straight to the speakers
  assert.equal(lim.port.msgs.at(-1).engaged, true);
});

// ───────── the Android audit's patterns, checked on the PC (2026-11-24) ─────────
// A function's source out of a script that isn't loadable whole here: from `function name(` up to the next marker.
const srcOf = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const between = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `${from} .. ${to}`); return src.slice(a, b); };

test('Vocal mask: a value that is not a number is unknown, never sung (NaN gets past Math.min/Math.max)', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const curve = (f) => ({ start: 0, step: 0.25, values: Array.from({ length: 200 * 4 }, (_, i) => f(i / 4)) });
  const voice = (f) => [{ startSec: 150, fps: 20, curve: Array.from({ length: 50 * 20 }, (_, i) => f(150 + i / 20)) }];
  const s = (sing) => ({ ...song(120, 200), bassCurve: curve((t) => (t < 190 ? 0.5 : 0.05)), vocals: voice(sing) });
  // all NaN: no vocal data, so it doesn't sing out (it did: NaN never read as a pause)
  assert.equal(A.singsOut(s(() => NaN), 185), false);
  assert.equal(A.singsOut(s(() => 0.9), 185), true, 'a real voice still does');
  // the worker's own mask clamp: a NaN ratio adds 0
  assert.match(srcOf('src/vendor/automix/analysis.worker.js'), /t\+=Math\.max\(0,Math\.min\(1,l\[o\]\/s\)\)\|\|0/);
});

test('Analysis worker: the tempo fold ends on 0, NaN and Infinity, and still folds into 70-180 BPM', () => {
  const li = vm.runInNewContext('(' + between(srcOf('src/vendor/automix/analysis.worker.js'), 'function li(', 'function ui(') + ')');
  for (const bpm of [0, NaN, Infinity, -5]) assert.equal(li({ bpm, beatIntervalSec: 60 / bpm }).bpm, bpm);
  assert.equal(li({ bpm: 120, beatIntervalSec: 0 }).beatIntervalSec, 0, 'a zero beat is left alone too');
  const lo = li({ bpm: 35, beatIntervalSec: 60 / 35 }), hi = li({ bpm: 400, beatIntervalSec: 0.15 });
  assert.equal(lo.bpm, 70); assert.ok(Math.abs(lo.beatIntervalSec - 60 / 70) < 1e-12);
  assert.equal(hi.bpm, 100); assert.ok(Math.abs(hi.beatIntervalSec - 0.6) < 1e-12);
});

test('No effect three times: a mix counts at its real end (finishLive), not at the hand-over', () => {
  const xf = srcOf('src/automix/crossfade.js');
  assert.doesNotMatch(between(xf, 'function handOver(', 'function askNext('), /\.heard\b/);
  const finish = between(xf, 'function finishLive()', 'function abortLive(');
  const run = (L) => {
    const heard = [];
    const ctx = vm.createContext({ live: L, graph: () => null, stopLoopDecks() {}, stopInDeck() {}, window: { __viviAutomix: { heard: (m) => heard.push(m.style) } } });
    vm.runInContext(finish + '\nfinishLive();', ctx);
    assert.equal(ctx.live, null);
    return heard;
  };
  assert.deepEqual(run({ phase: 'mixing', mix: { style: 'filter' } }), ['filter'], 'played to its end');
  assert.deepEqual(run({ phase: 'asked', mix: { style: 'filter' } }), [], 'ended before it played (no time left)');
  assert.deepEqual(run({ phase: 'mixing', mix: null }), [], 'a plain crossfade has no move');
  assert.doesNotMatch(between(xf, 'function abortLive(', 'const BY_LISTENER'), /\.heard\b/, 'a mix called off never counts');
});

test("The listener's pause during a mix (playback.md rule 5): any phase, called off at once, the player paused, never played", () => {
  const xf = srcOf('src/automix/crossfade.js');
  const fn = between(xf, 'function onPlayPauseDuringHold(', "document.addEventListener('click'");
  const run = (live, deck) => {
    const calls = [];
    const e = { preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') };
    const ctx = vm.createContext({ live, deck, post: (m) => calls.push('post ' + m.type), abortLive: (why) => calls.push('abort ' + why + ' ' + (ctx.live?.gateDelay ?? '-')) });
    vm.runInContext(fn + '\nonPlayPauseDuringHold(e);', Object.assign(ctx, { e }));
    return { calls, deck };
  };
  const want = ['prevent', 'stop', 'post pause', 'abort paused by you 0.4'];
  for (const phase of ['asked', 'mixing']) {
    assert.deepEqual(run({ phase, mix: { style: 'blend' } }, null).calls, want, phase);
    assert.deepEqual(run({ phase, mix: null }, null).calls, want, phase + ', a plain crossfade');
  }
  // a hold before the incoming song's start is dropped, so cancelling it doesn't press play
  const held = run({ phase: 'mixing', mix: { style: 'loop' } }, { held: true });
  assert.equal(held.deck.held, false);
  assert.deepEqual(held.calls, want);
  // no mix: YouTube's own play/pause
  assert.deepEqual(run(null, null).calls, []);
  // the player's gate comes back after that delay
  assert.match(between(xf, 'function cleanup(', 'function stopLoopDecks') , /const at = now \+ \(L\.gateDelay \|\| 0\)/);
});

test('Audio clock watchdog: a mix whose audio clock stands still 3 s on the wall clock is called off', () => {
  const xf = srcOf('src/automix/crossfade.js');
  const ctx = vm.createContext({});
  vm.runInContext(between(xf, 'const CLOCK_STALL_MS', 'function driveLive(') + '\nthis.clockStalled = clockStalled; this.CLOCK_STOPPED = CLOCK_STOPPED;', ctx);
  const L = {};
  assert.equal(ctx.clockStalled(L, 10, 0), false);
  assert.equal(ctx.clockStalled(L, 10.15, 150), false, 'running');
  assert.equal(ctx.clockStalled(L, 10.15, 3000), false, 'still within 3 s');
  assert.equal(ctx.clockStalled(L, 10.15, 3200), true, 'stood still over 3 s');
  assert.equal(ctx.clockStalled(L, 10.2, 3350), false, 'moving again');
  assert.match(between(xf, 'function driveLive(', 'if (live.phase'), /clockStalled\(live, now, performance\.now\(\)\)\) \{ abortLive\(CLOCK_STOPPED\)/);
  assert.match(between(xf, 'const BY_LISTENER', ']);'), new RegExp(`'${ctx.CLOCK_STOPPED}'`), 'not marked as the song failing');
});

test('Editor: a nudge stops at windowLimits, as a drag does; back towards them it moves', () => {
  const A = loadAutomix('auto');
  const ok = A.nudgeWindow({ bar: 4, sec: 50 }, 1, [24.5, 60]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { pos: { bar: 4, sec: 50.01, nudgeMs: 10 } });
  assert.equal(A.nudgeWindow({ bar: 4, sec: 60, nudgeMs: 10 }, 1, [24.5, 60]).refused, 'hi');
  assert.equal(A.nudgeWindow({ bar: 0, sec: 24.5 }, -1, [24.5, 60]).refused, 'lo');
  const back = A.nudgeWindow({ bar: 9, sec: 61, nudgeMs: 20 }, -1, [24.5, 60]);
  assert.deepEqual(JSON.parse(JSON.stringify(back.pos)), { bar: 9, sec: 60.99, nudgeMs: 10 }, 'outside: back towards them is allowed');
  assert.equal(A.nudgeWindow({ bar: 4, sec: 50, nudgeMs: 2000 }, 1, [0, 100]).refused, 'max');
  assert.deepEqual(JSON.parse(JSON.stringify(A.nudgeWindow({ bar: 4, sec: 50.01, nudgeMs: 10 }, -1, [0, 100]).pos)), { bar: 4, sec: 50 }, 'a nudge back to 0 is not stored');
  assert.match(srcOf('src/automix-overview.js'), /A\(\)\.nudgeWindow\(now, dir, limitsOf\(s, side\)\)/);
});

test('Sung spans: a line with no words (0 or no count) and no word times is a gap, never a NaN span', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const sp = A.sungSpansFromLines([
    { start: 10, end: null, words: 0, wordTimes: null },
    { start: 12, end: null, words: undefined, wordTimes: null },
    { start: 14, end: null, words: NaN, wordTimes: [] },
    { start: 20, end: null, words: 2, wordTimes: null },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(sp.map(([a, b]) => [a, Math.round(b * 1000) / 1000]))), [[20, 21.2]]);
});

test('Loop mix: the baseline (d26dc16) on Vaina Loca -> SI NO ES CONTIGO, planned by itself (versions.md "The loop mix\'s baseline")', () => {
  const A = loadAutomix(16);
  assert.equal(A.LOOP.TRIM, undefined);
  const g = JSON.parse(readFileSync(new URL('../spec/automix/golden/1-vaina-loca__si-no-es-contigo.json', import.meta.url), 'utf8'));
  for (const k of ['v2', 'v3', 'v3lyrics', 'v3lrc']) {
    const p = g[k].loop;
    assert.equal(g[k].plays, 'loop', k);
    assert.deepEqual([p.out.bars, p.in.bars, p.rampBars, p.totalBars], [4, 4, 3, 12], k);
    assert.ok(Math.abs(p.out.loop[0] - 153.31) < 0.02 && Math.abs(p.in.loop[0] - 9.6) < 0.02, `${k}: A at ${p.out.loop[0]}, B at ${p.in.loop[0]}`);
    assert.equal(Math.round(p.out.bpm), 94); assert.equal(Math.round(p.in.bpm), 100);
    const x = A.loopSchedule(p, 0);
    assert.ok(Math.abs(x.elementAt - 34.4) < 0.1, `${k}: ${x.elementAt} s`);
    // the gains: A 1 through the entry, 0.6 at the ramp's end, 0 at the release; B 0.55 at the entry's end, 1 at the ramp's end
    assert.deepEqual(p.curves.out.gain.map(([, v]) => v), [1, 1, 0.6, 0], k);
    assert.deepEqual(p.curves.in.gain.map(([, v]) => v), [0, 0.55, 1], k);
  }
});

test('Loop mix: every deck change carries on where the last one got to (no jump in the audio, so no click on the tempo ramp)', () => {
  const A = loadAutomix(16);
  const g = JSON.parse(readFileSync(new URL('../spec/automix/golden/1-vaina-loca__si-no-es-contigo.json', import.meta.url), 'utf8'));
  // (the golden file rounds to 0.1 ms: each loop's beat and tempo rebuilt from its length, as planLoopMix makes them)
  const side = (l) => { const beatSec = (l.loop[1] - l.loop[0]) / (l.bars * 4); return { ...l, beatSec, bpm: 60 / beatSec }; };
  const x = A.loopSchedule({ ...g.v3.loop, out: side(g.v3.loop.out), in: side(g.v3.loop.in) }, 0);
  for (const changes of [x.outChanges, x.inChanges]) {
    for (let k = 1; k < changes.length; k++) {
      const a = changes[k - 1], b = changes[k];
      if (!a.active || !b.active) continue;
      let at = a.input + (b.output - a.output) * a.rate;
      if (a.loop && at >= a.loop[1] - 1e-6) at -= a.loop[1] - a.loop[0];
      const want = b.input;
      // the release lets the loop go at its end: the end and the loop's start are the same sound
      const same = Math.abs(at - want) < 1e-6 || (a.loop && !b.loop && Math.abs(at + (a.loop[1] - a.loop[0]) - want) < 1e-6);
      assert.ok(same, `change ${k}: the deck is at ${at.toFixed(6)} s, the change says ${want.toFixed(6)} s`);
    }
  }
});

test('Loop mix: credit, title and symbol lines are not sung (versions.md "The loop mix\'s baseline" rule 6); Vaina Loca\'s plan is unchanged', () => {
  const A = loadAutomix(16);
  const meta = { song: 'SI NO ES CONTIGO', artist: 'Cris Mj' };
  const notSung = ['作曲: Cristopher Andrés Álvarez Garcia', '作词：X', '编曲 : Y', 'Letra: Cris Mj', 'Música: Cris Mj', 'Lyrics by Someone', 'Written by A & B', 'Prod. by Y', 'Produced by Z', 'Mixed by W',
    'SI NO ES CONTIGO', 'Cris Mj', 'Cris Mj - Si No Es Contigo', '♪ ♪', '...'];
  const sung = ['Si no es contigo no es con nadie', 'Written in the stars', 'Music is my life', 'Lyrics of my heart', 'Words don\'t come easy', 'Cris Mj está aquí'];
  const shapes = A.lineShapes([...notSung, ...sung].map((text, i) => ({ text, start: 1000 * i })), meta);
  assert.equal(JSON.stringify(shapes.map((l) => !!l.notSung)), JSON.stringify([...notSung.map(() => true), ...sung.map(() => false)]));
  assert.equal(A.lineShapes([{ text: 'hola', start: -500 }], meta)[0].notSung, true);
  // NetEase's credit at 0.00 with no end: read the baseline way it blocked SI NO ES CONTIGO's first 10 s
  const pair = JSON.parse(readFileSync(new URL('../spec/automix/pairs/1-vaina-loca__si-no-es-contigo.json', import.meta.url), 'utf8'));
  const [a, b] = pair.songs;
  const credit = A.lineShapes([{ text: '作曲: Cristopher Andrés Álvarez Garcia', start: 0 }], meta);
  const withCredit = A.loopSpansFromLines([...credit, ...b.lines]), without = A.loopSpansFromLines(b.lines);
  assert.equal(JSON.stringify(withCredit), JSON.stringify(without));
  assert.ok(withCredit[0][0] > 20, `first span from ${withCredit[0][0]} s`);
  // and the plan: the same loops with or without the credit line
  const bufferOf = (song) => { const n = song.loudness20Hz.length * 16, data = new Float32Array(n); song.loudness20Hz.forEach((v, w) => data.fill(v, w * 16, w * 16 + 16));
    return { duration: song.decodedSec, sampleRate: 320, numberOfChannels: 1, length: n, getChannelData: () => data }; };
  const pos = Math.max(30, a.analysis.durationSec - 95) + A.LOOP.LOOP_SETUP_SEC, out = A.asOutgoing(a.analysis);
  const plan = (inLines) => A.planLoopMix(out, bufferOf(a), b.analysis, bufferOf(b), pos, { out: A.loopSpansFromLines(a.lines), in: A.loopSpansFromLines(inLines) });
  const p1 = plan(b.lines), p2 = plan([...credit, ...b.lines]);
  assert.equal(JSON.stringify([p2.out.loop, p2.in.loop, p2.totalBars]), JSON.stringify([p1.out.loop, p1.in.loop, p1.totalBars]));
  assert.ok(Math.abs(p2.out.loop[0] - 153.31) < 0.02 && Math.abs(p2.in.loop[0] - 9.6) < 0.02 && p2.totalBars === 12);
});

test('Drop-in: the playing song is trimmed at least -1.5 dB, a larger loudness trim stands (versions.md "The mix\'s ceiling" rule 6)', () => {
  const A = loadAutomix(16);
  assert.equal(A.DROP_IN_OUT_DB, -1.5);
  assert.equal(A.dropInTrim(null).outDb, -1.5);
  const kept = { diffDb: 0.4, outDb: 0, inDb: 0 }, floored = A.dropInTrim(kept);
  assert.equal(floored.outDb, -1.5); assert.equal(floored.inDb, 0); assert.equal(kept.outDb, 0);
  assert.equal(A.dropInTrim({ diffDb: -4, outDb: 0, inDb: -4 }).inDb, -4);
  assert.equal(A.dropInTrim({ diffDb: 5, outDb: -5, inDb: 0 }).outDb, -5);
  // the fader: A ends at x0.841 of its plain fall
  const [, gOut] = A.trimmed({ trim: A.dropInTrim(null) }, Float32Array.of(0, 1), Float32Array.of(1, 1));
  assert.ok(Math.abs(20 * Math.log10(gOut[1]) + 1.5) < 1e-4);
});

test('Filter aims: bad plan values (NaN clash, tempo, swap, length) still give finite filter and fader curves', () => {
  const A = loadAutomix(16);
  for (const style of ['filter', 'blend']) {
    const s = A.djShape({ clash: NaN, bpm: NaN, swapAt: NaN }, style, NaN, 64);
    for (const k of ['inHp', 'outHp', 'outLp', 'gIn', 'gOut']) assert.ok([...s[k]].every(Number.isFinite), `${style} ${k}`);
  }
});

// Mix files (spec/automix/mix-file.md): the two ready-made mixes round-trip, and the reading rules
const MIX_FILES = ['cinderella-drowning', 'yquefue-iliketomoveit'].map((n) => readFileSync(new URL(`../spec/automix/mixes/${n}.vivimix.json`, import.meta.url), 'utf8'));
const js = (v) => JSON.stringify(v);
test('Mix files: both ready-made mixes read back whole and write out the same file (mix-file.md rules 2, 4, 8)', () => {
  const A = loadAutomix(0);
  for (const text of MIX_FILES) {
    const r = A.readMixFile(text);
    assert.equal(r.refused, undefined);
    assert.deepEqual(js(r.skipped), '[]');
    assert.equal(r.mixes.length, 1);
    const file = JSON.parse(text);
    // the file holds the override exactly as the editor saves it: nothing is dropped or rounded
    assert.equal(js(r.mixes[0].override), js(file.mixes[0].override));
    assert.equal(r.mixes[0].key, file.mixes[0].from.videoId + '>' + file.mixes[0].to.videoId);
    assert.equal(js(A.writeMixFile(r.mixes)), js(file));
    // saved as the editor saves it (engine, savedAt) and exported again: the same file
    const saved = { ...A.normalizeOverride(r.mixes[0].override), engine: 3, savedAt: 1764000000000 };
    assert.equal(js(A.writeMixFile([{ from: file.mixes[0].from, to: file.mixes[0].to, override: saved }])), js(file));
    assert.equal(r.mixes[0].override.preset, 'custom');
    assert.equal(typeof r.mixes[0].override.lanes.volume, 'object');
  }
});
test('Mix files: the drawings play: the gate and the jump reach plan curves (editor.md §10 rule 4)', () => {
  const A = loadAutomix(0);
  const yq = A.readMixFile(MIX_FILES[1]).mixes[0].override;
  const beatSec = 60 / 133, D = 64 * beatSec;
  const pc = A.pointCurves(yq.lanes, D, beatSec);
  const g = pc.out.gain;
  // the gates: on at beat 1.5, off at 3, on again at 4.5 (8 ms ramps), A out at the window's end
  const at = (t) => { let v = g[0][1]; for (let i = 0; i < g.length; i++) { if (g[i][0] <= t) v = g[i][1]; } return v; };
  assert.equal(at(1 * beatSec), 0);
  assert.equal(at(2 * beatSec), 1);
  assert.equal(at(3.75 * beatSec), 0);
  assert.equal(at(5 * beatSec), 1);
  // the drawn filter: a high-pass up to 1 kHz at beat 18, zigzags down at 19.5, open again (20 Hz) at 27.5
  assert.ok(pc.out.highpassHz.some(([t, v]) => Math.abs(t - 18 * beatSec) < 1e-3 && v === 1000));
  assert.ok(pc.out.highpassHz.some(([t, v]) => Math.abs(t - 19.5 * beatSec) < 1e-3 && v === 30));
  assert.ok(pc.out.highpassHz.some(([t, v]) => Math.abs(t - 27.5 * beatSec) < 1e-3 && v === 20));
  // the white Effects line: reverb flat to beat 40, rising to 0.25 by beat 48 (about 62-75% of the window)
  assert.equal(JSON.stringify(pc.out.reverbSend), JSON.stringify([[0, 0], [40 * beatSec, 0], [48 * beatSec, 0.25]].map(([t, v]) => [Math.round(t * 1e6) / 1e6, v])));
  assert.ok(Math.abs(g[g.length - 1][0] - D) < 1e-6 && g[g.length - 1][1] === 0);
  const ci = A.readMixFile(MIX_FILES[0]).mixes[0].override;
  // drawn on the PC's grid for Cinderella (130 BPM: Spotify's 8 bars at 65 are 16 here, 29.5 s)
  const cb = 60 / 130;
  assert.equal(ci.bars, 16);
  const c = A.pointCurves(ci.lanes, 64 * cb, cb);
  assert.ok(c.out.gain.some(([t, v]) => Math.abs(t - 11.8 * cb) < 1e-3 && v === 1), 'the bump at 5.4 s');
  assert.ok(Math.abs(64 * cb - 29.54) < 0.01);
  assert.ok(c.in.bassDb.some(([, v]) => v === -18));
});
test('Mix files: a file is refused whole for its format, version or size (mix-file.md rule 3)', () => {
  const A = loadAutomix(0);
  const ok = JSON.parse(MIX_FILES[1]);
  assert.match(A.readMixFile('{nope').refused, /not JSON/);
  assert.match(A.readMixFile(js({ ...ok, format: 'other' })).refused, /^not a Vivimusic mix file$/);
  assert.match(A.readMixFile(js({ ...ok, version: 2 })).refused, /version 2, newer than this app reads \(1\): update the app/);
  assert.match(A.readMixFile(js({ ...ok, version: '1' })).refused, /no valid version/);
  assert.match(A.readMixFile(js({ ...ok, mixes: [] })).refused, /no mixes/);
  assert.match(A.readMixFile(js({ ...ok, mixes: Array(301).fill(ok.mixes[0]) })).refused, /301 mixes: 300 is the most/);
  // a BOM and unknown fields at every level are fine
  const extra = { ...ok, app: 'x', mixes: [{ ...ok.mixes[0], note: 'hi', from: { ...ok.mixes[0].from, album: 'y' }, override: { ...ok.mixes[0].override, future: 1 } }] };
  const r = A.readMixFile('\uFEFF' + js(extra));
  assert.equal(r.mixes.length, 1);
  assert.equal(js(r.mixes[0].override), js(ok.mixes[0].override));
});
test('Mix files: bad mixes are skipped with a reason, the rest imported; the same pair twice keeps the later (rule 4)', () => {
  const A = loadAutomix(0);
  const m = JSON.parse(MIX_FILES[0]).mixes[0];
  const other = { from: { videoId: 'aaaaaaaaaaa' }, to: { videoId: 'bbbbbbbbbbb' }, override: { v: 1, bars: 4 } };
  const r = A.readMixFile(js({ format: 'vivi-mix', version: 1, mixes: [
    m,
    { ...m, from: { videoId: 'short' } },
    { ...m, to: m.from },
    { ...other, override: { v: 1, preset: 'auto' } },
    { ...other, override: { v: 1, preset: 'echoOut' } },
    { ...other, override: { v: 1, preset: 'custom', lanes: { volume: { unit: 'bar', out: [[0, 1]], in: [[0, 0]] }, eq: 'none', effect: 'none' } } },
    other,
    { ...other, override: { v: 1, bars: 16 } },
  ] }));
  assert.equal(js(r.skipped.map((x) => [x.n, x.why])), js([
    [2, 'a song has no valid videoId'],
    [3, 'the same song on both sides'],
    [4, 'nothing but Auto in it'],
    [5, 'the preset "echoOut" is unknown here'],
    [6, 'its lanes are not valid'],
    [7, 'the same pair again in mix 8: the later one is used'],
  ]));
  assert.equal(js(r.mixes.map((x) => [x.key, x.override.bars ?? null])), js([['rCwSRV7P6hY>0X3Y2m9wj5c', 16], ['aaaaaaaaaaa>bbbbbbbbbbb', 16]]));
});
test('Mix files: an import sorts new, replacing (with its changes) and the same as saved (rule 5)', () => {
  const A = loadAutomix(0);
  const [ci] = A.readMixFile(MIX_FILES[0]).mixes, [yq] = A.readMixFile(MIX_FILES[1]).mixes;
  const saved = {
    [ci.key]: { ...ci.override, engine: 2, savedAt: 1 },           // the same, saved by an app
    [yq.key]: { style: 'crossfade', bars: 8 },                        // a pick from before the editor
  };
  const p = A.importPlan([ci, yq, { key: 'x>y', override: { v: 1, bars: 4 } }], saved);
  assert.equal(js(p.add.map((m) => m.key)), js(['x>y']));
  assert.equal(js(p.same.map((m) => m.key)), js([ci.key]));
  assert.equal(js(p.replace.map((m) => [m.key, m.changes])), js([[yq.key, [
    'preset: auto → custom', 'volume: auto → drawn', 'eq: auto → none', 'effect: auto → drawn', 'effects: auto → drawn', 'length: 8 bars → 16 bars', 'beat match: off → sync',
  ]]]));
  // two drawings that differ
  const moved = JSON.parse(js(yq.override)); moved.lanes.volume.in = [[0, 0.5]];
  assert.equal(js(A.mixChanges(yq.override, moved)), js(['volume: drawn → another drawing']));
  assert.equal(js(A.mixChanges(yq.override, yq.override)), '[]');
});
test('Mix files: gridBpm folds half and double time, so Cinderella plays 29.5 s at 130 or 65 BPM (mix-file.md rule 4)', () => {
  const A = loadAutomix(0);
  const ov = A.readMixFile(MIX_FILES[0]).mixes[0].override;
  assert.equal(ov.gridBpm, 130);
  const drowning = song(129, 209, { down: 0.3 });
  const planWith = (bpm) => {
    const cin = song(bpm, 170, { down: 0.2 });
    return A.plan({ fromId: 'rCwSRV7P6hY', toId: '0X3Y2m9wj5c', from: cin, to: drowning, durationSec: 170, pos: 20, earliest: 24.5, pick: ov });
  };
  const at130 = planWith(130), at65 = planWith(65);
  assert.equal(at130.bars, 16);
  assert.equal(at65.bars, 8);
  // (the mix's seconds: Spotify's 29.5 s, give or take the glide's tempo steps; the same in both)
  assert.ok(Math.abs(at130.durationSec - at65.durationSec) < 0.01, `${at130.durationSec} vs ${at65.durationSec}`);
  for (const p of [at130, at65]) {
    assert.ok(Math.abs(p.durationSec - 29.5) < 0.3, `the mix ${p.durationSec} s`);
    assert.equal(p.preset, 'custom');
    assert.ok(!(p.warnings || []).some((w) => /taken as they are/.test(w)));
  }
  // the bump lands at the same second in both
  const bump = (p) => p.curves.out.gain.find(([, v], i, g) => v === 1 && i > 0 && g[i - 1][1] < 1)[0];
  assert.ok(Math.abs(bump(at130) - bump(at65)) < 0.02, `${bump(at130)} vs ${bump(at65)}`);
  // the fold itself: x2 and x1/2, gridBpm with it; within 4% only
  const f = A.foldOverride(ov, 64.2);
  assert.equal(f.k, 0.5);
  assert.equal(f.ov.bars, 8);
  assert.equal(f.ov.gridBpm, 65);
  assert.equal(js(f.ov.lanes.volume.out.slice(0, 3)), js([[0, 0.83], [4.9, 0.84], [5.9, 1]]));
  assert.equal(A.foldOverride(f.ov, 131).k, 2);
  assert.equal(A.foldOverride(ov, 128).k, 1);
  assert.equal(A.foldOverride(ov, 100).k, null);
  assert.match(A.foldOverride(ov, 100).note, /drawn at 130 BPM, this song reads 100 BPM: its beats are taken as they are/);
  assert.match(planWith(100).warnings.join(';'), /drawn at 130 BPM, this song reads 100 BPM/);
  // the import summary's note: no tempo, or one that doesn't fold; none when it folds or A isn't analysed yet
  const { gridBpm, ...old } = ov;
  assert.equal(A.foldNote(old, 65), 'no gridBpm: its beats are taken as they are');
  assert.match(A.foldNote(ov, 100), /taken as they are/);
  assert.equal(A.foldNote(ov, 65), null);
  assert.equal(A.foldNote(ov, undefined), null);
  // gridBpm alone is not a change: a saved copy without it counts as the same
  assert.equal(js(A.importPlan([{ key: 'k', override: ov }], { k: old }).same.map((m) => m.key)), js(['k']));
});

test('Mix files: Play these mixes queues the songs in the file\'s order, a song already next in line once (mix-file.md rule 7)', () => {
  const A = loadAutomix(0);
  const js = JSON.stringify;
  const mix = (a, b) => ({ from: { videoId: a }, to: { videoId: b } });
  const [A1, B1, C1, D1] = ['rCwSRV7P6hY', '0X3Y2m9wj5c', 'CNDYWba7YDY', 'PLEQRIisP_Q'];
  // the two ready-made files one after the other: four songs
  const both = [...A.readMixFile(MIX_FILES[0]).mixes, ...A.readMixFile(MIX_FILES[1]).mixes];
  assert.equal(js(A.mixQueue(both)), js([A1, B1, C1, D1]));
  // a chain: A→B, B→C plays A, B, C
  assert.equal(js(A.mixQueue([mix(A1, B1), mix(B1, C1)])), js([A1, B1, C1]));
  // a song again later (not next in line) is queued again; bad ids are left out
  assert.equal(js(A.mixQueue([mix(A1, B1), mix(C1, A1), mix('bad', D1)])), js([A1, B1, C1, A1, D1]));
  assert.equal(js(A.mixQueue([])), js([]));
});

test('Window in seconds only (editor.md §6 "Seconds only"): kept by normalizing, played at the nearest beat, never moved', () => {
  const A = loadAutomix(0);
  const js = JSON.stringify;
  const ov = A.normalizeOverride({ v: 1, bars: 8, window: { out: { sec: 218.1424 }, in: { sec: 10.28, beat: 2 } } });
  // no bar: no beat either; seconds rounded to 1 ms
  assert.equal(js(ov.window), js({ out: { sec: 218.142 }, in: { sec: 10.28 } }));
  const grid = { downbeatSec: 0.3, beatSec: 0.5 };
  // 218.142 → the nearest beat 218.3 (0.3 + 436 × 0.5); not moved
  assert.equal(js(A.resolveWindow({ sec: 218.142 }, grid)), js({ sec: 218.3, moved: false, snapped: true }));
  // a nudge on top stays on top of the snapped beat
  assert.equal(A.resolveWindow({ sec: 218.162, nudgeMs: 20 }, grid).sec, 218.32);
  // with no grid: the seconds as they are
  assert.equal(A.resolveWindow({ sec: 218.142 }, null).sec, 218.142);
  // a position with its bar still resolves as before
  assert.equal(A.resolveWindow({ bar: 10, sec: 20.3 }, grid).sec, 20.3);
  // a mix file with seconds-only windows reads back unchanged
  const file = JSON.stringify(A.writeMixFile([{ from: { videoId: 'rCwSRV7P6hY' }, to: { videoId: '0X3Y2m9wj5c' }, override: ov }]));
  assert.equal(js(A.readMixFile(file).mixes[0].override.window), js(ov.window));
});

test('Spotify mix exports import directly (spotify-mixes.md): mixes, skips, the playlist queue, version 3 only', () => {
  const A = loadAutomix(0);
  const t = (id, title, yt) => ({ uri: 'spotify:track:' + id, ...(yt ? { youtubeVideoId: yt } : {}), title, artists: ['X', 'Y'], durationMs: 400000 });
  const S1 = t('a', 'All The Stars', 'rCwSRV7P6hY'), S2 = t('b', 'Wild Thoughts', '0X3Y2m9wj5c'), S3 = t('c', 'Interlude', 'JGwWNGJdvx8'), S4 = t('d', 'Gone', null);
  const exp = {
    format: 'spotify-mix-export', version: 3,
    playlist: { name: 'Test', tracks: [S1, S2, S3] },
    mixes: [
      // BUDGET's first mix: 4 bars from 218.142 s, a drawn eq on A (low knob to 0 at the end)
      { index: 1, from: S1, to: S2, fromStartMs: 218142, durationMs: 9919, bars: 4, fromBpm: 98, style: { volume: 7, eq: 4, filter: 0 },
        curves: { eq: { from: { low: [{ start: 0, end: 0.5, points: [[0, 0.5], [1, 0.5]] }, { start: 0.5, end: 1, points: [[0, 0.5], [1, 0]] }] } } } },
      // a straight cut in Spotify (1 ms, no start)
      { index: 2, from: S2, to: S3, durationMs: 1, style: {} },
      // a song with no YouTube id
      { index: 3, from: S3, to: S4, fromStartMs: 1000, durationMs: 8000, bars: 0, style: { volume: 10, eq: 11, filter: 9, fx: 2 } },
    ],
  };
  const r = A.readMixFile(JSON.stringify(exp));
  assert.equal(r.refused, undefined);
  assert.equal(r.mixes.length, 2);
  // the straight cut: Spotify's No transition (spotify-mixes.md rule 3)
  assert.equal(JSON.stringify(r.mixes[1].override), JSON.stringify({ v: 1, preset: 'none' }));
  const ov = r.mixes[0].override;
  assert.equal(r.mixes[0].key, 'rCwSRV7P6hY>0X3Y2m9wj5c');
  assert.equal(r.mixes[0].from.artist, 'X, Y');
  assert.equal(ov.preset, 'custom');
  assert.equal(ov.bars, 4);
  assert.equal(ov.gridBpm, 98);
  // seconds-only windows (editor.md §6): A out at 218.142 s, B in at 0
  assert.equal(JSON.stringify(ov.window), JSON.stringify({ out: { sec: 218.142 }, in: { sec: 0 } }));
  assert.equal(ov.lanes.volume, 'overlap');
  // eq knob 0.5 → 0 dB, 0 → -18 dB, in beats over the 16 beats
  assert.equal(ov.lanes.eq.unit, 'beat');
  assert.equal(JSON.stringify(ov.lanes.eq.out.bass.slice(-2)), JSON.stringify([[8, 0], [16, -18]]));
  // B's deck keeps the center bass swap's own shape
  assert.ok(Array.isArray(ov.lanes.eq.in.bass));
  assert.equal(JSON.stringify(r.skipped.map((s) => s.n)), '[3]');
  assert.equal(r.skipped[0].why, 'no YouTube id for Gone');
  // the queue: the playlist's tracks in order, a song in no mix too
  assert.equal(JSON.stringify(r.queue), JSON.stringify(['rCwSRV7P6hY', '0X3Y2m9wj5c', 'JGwWNGJdvx8']));
  assert.equal(r.name, 'Test');
  // version 2 has no ids: refused, with why; a newer one too
  assert.match(A.readMixFile(JSON.stringify({ ...exp, version: 2 })).refused, /no YouTube ids/);
  assert.match(A.readMixFile(JSON.stringify({ ...exp, version: 4 })).refused, /newer than this app reads/);
  // a mix with no bars: drawn in seconds, beat match off; Start bass swap and LP in drawn here
  const r2 = A.readMixFile(JSON.stringify({ ...exp, mixes: [{ ...exp.mixes[2], to: S1 }] }));
  const o2 = r2.mixes[0].override;
  assert.equal(o2.beatMatch, 'off');
  assert.equal(o2.lanes.volume, 'cutInFadeOut');
  // Start bass swap and Low pass filter in: shapes of their own now
  assert.equal(o2.lanes.eq, 'startBassSwap');
  assert.equal(o2.lanes.effect, 'lpIn');
  assert.equal(JSON.stringify(A.presetCurves(o2, 8, null).in.lowpassHz), JSON.stringify([[0, 400], [8, 20000]]));
  // Effects style 2 (Reverb cut end) is named: the shape, nothing left out
  assert.equal(o2.lanes.fx, 'reverbCutEnd');
  assert.ok(!/not carried/.test(r2.notes.join(' | ')), r2.notes.join(' | '));
  // a negative B start (B's 0:00 comes in 1.972 s and 14.486 s after the mix starts): B from 0, that
  // long into the mix (mix-file.md rule 2, B's late entry), no note
  const late = (v) => JSON.stringify({ ...exp, mixes: [{ ...exp.mixes[0], toStartMs: v }, { ...exp.mixes[0], index: 4, from: S2, to: S3, toStartMs: -14486 }] });
  const rl = A.readMixFile(late(-1972));
  assert.equal(JSON.stringify(rl.mixes[0].override.window), JSON.stringify({ out: { sec: 218.142 }, in: { sec: 0, delaySec: 1.972 } }));
  assert.equal(JSON.stringify(rl.mixes[1].override.window.in), JSON.stringify({ sec: 0, delaySec: 14.486 }));
  assert.ok(!rl.notes.some((n) => /late/.test(n)), rl.notes.join(' | '));
  // an older export's unsigned 2^64 − x can't be read back: B with the mix, and the summary says so
  const wrapped = A.readMixFile(late(0).replace('"toStartMs":0', '"toStartMs":18446744073709549644'));
  assert.equal(JSON.stringify(wrapped.mixes[0].override.window.in), JSON.stringify({ sec: 0 }));
  assert.ok(wrapped.notes.includes("1 mix brings B in late in an older export's unsigned time: here B starts with the mix"), wrapped.notes.join(' | '));
});

test("B's late entry (mix-file.md rule 2): normalized, a mix file round trip, the plan, the changes list", () => {
  const A = loadAutomix('auto');
  const js = JSON.stringify;
  // on the mix-in only, 1 ms to 60 s, to 1 ms; on the mix-out ignored
  const ov = A.normalizeOverride({ v: 1, bars: 8, window: { out: { sec: 50, delaySec: 2 }, in: { sec: 0, delaySec: 3.21749 } } });
  assert.equal(js(ov.window), js({ out: { sec: 50 }, in: { sec: 0, delaySec: 3.217 } }));
  assert.equal(A.normalizeOverride({ v: 1, window: { in: { sec: 0, delaySec: 0 } } }).window.in.delaySec, undefined);
  assert.equal(A.normalizeOverride({ v: 1, window: { in: { sec: 0, delaySec: 99 } } }).window.in.delaySec, 60);
  // written and read back: the same override
  const file = js(A.writeMixFile([{ from: { videoId: 'rCwSRV7P6hY' }, to: { videoId: '0X3Y2m9wj5c' }, override: ov }]));
  assert.match(file, /"delaySec":3.217/);
  assert.equal(js(A.readMixFile(file).mixes[0].override), js(ov));
  // a changed delay is a change in the mix-in row
  const ch = A.mixChanges({ v: 1, bars: 8, window: { in: { sec: 0 } } }, ov);
  assert.ok(ch.includes('mix-in: 0 s → 0 s, 3.217 s into the mix'), js(ch));
  // the plan carries it as inDelaySec on a plain blend or crossfade; the curves stay from the mix start
  const go = (pick) => A.plan({ fromId: 'a', toId: 'b', from: song(120, 200), to: song(120, 200), durationSec: 200, pos: 20, earliest: 24.5, pick });
  const lanes = { volume: 'overlap', eq: 'none', effect: 'none' };
  const base = go({ preset: 'custom', bars: 8, lanes, window: { out: { sec: 150 }, in: { sec: 0 } } });
  const p = go({ preset: 'custom', bars: 8, lanes, window: { out: { sec: 150 }, in: { sec: 0, delaySec: 3.2 } } });
  assert.ok(['blend', 'crossfade'].includes(p.style), p.style);
  assert.equal(p.inDelaySec, 3.2);
  assert.equal(base.inDelaySec, undefined);
  assert.equal(p.mixInTrackTime, base.mixInTrackTime);
  assert.equal(js(p.curves), js(base.curves));
  // past the mix's end: held at its length − 0.5 s, with a warning
  const far = go({ preset: 'custom', bars: 8, lanes, window: { out: { sec: 150 }, in: { sec: 0, delaySec: 40 } } });
  assert.equal(far.inDelaySec, Math.round((far.durationSec - 0.5) * 1e3) / 1e3);
  assert.ok(far.warnings.some((w) => /past the mix's end/.test(w)), js(far.warnings));
  // a loop mix never plays it
  assert.equal(A.normalizeOverride({ v: 1, preset: 'loop', window: { in: { sec: 0, delaySec: 3 } } }).window, undefined);
});

test("B's late entry plays (mix-file.md rule 2): B silent and unstarted until the offset, the curves from the mix start", () => {
  const xf = srcOf('src/automix/crossfade.js');
  const helpers = between(xf, 'const inStartOf', '// The next song') + between(xf, 'function inTrackAt(', '// True once');
  const param = (log) => ({ cancelScheduledValues() {}, setValueAtTime() {}, log });
  // the deck path (scheduleDeckBlend); the shapes it fades: B's (ig) first, A's second
  const run = (inDelaySec, mixInTrackTime = 0, preset = false) => {
    const sched = [], fades = [], events = [];
    const m = { style: 'blend', rate: 1, mixInTrackTime, mixOutTrackTime: 150, nextId: 'b', durationSec: 16, ...(inDelaySec ? { inDelaySec } : {}) };
    const ramp = Array.from({ length: 161 }, (_, i) => i / 160);   // B's curve: up over the 16 s, 0.1 s a sample
    const ctx = vm.createContext({
      live: { mix: m, t0: 100, D: 16, fade: { gain: param() }, src: {}, inBase: 1, k: 1, askAt: 101 },
      deck: null, inBus: { gain: param() }, inDeck: { gain: { gain: param() }, schedule: (c) => sched.push(...c) }, inPrep: { addon: false, end: 300 },
      PREROLL_SEC: 0.5, glideOf: () => null, deckGlideBack: () => null, presetOn: () => preset,
      presetGains: () => [[[0, 0, false], [8, 0.5, false], [16, 1, false]], [[0, 1, false], [16, 0, false]]],
      playEvents: (p, ev, t0) => events.push([t0, ev]),
      gainCurves: () => [ramp, ramp.map((v) => 1 - v)], fadeCurve: (p, c, t0, D) => fades.push([t0, D, c]), blendShape() {}, addonEvent() {}, djNote: () => '', log() {},
    });
    vm.runInContext(helpers + between(xf, 'function scheduleDeckBlend(', "// Automix v2's kick lock") + '\nscheduleDeckBlend({ ctx: { currentTime: 99 } });', ctx);
    return { sched, fades, events, at: (t) => vm.runInContext(`inTrackAt(live.mix, 100, ${t})`, ctx) };
  };
  const now = run(0), late = run(3.2);
  // with the mix: the deck starts at the mix start (B's 0:00 has no pre-roll), the curve as it is
  assert.equal(now.sched[0].output, 100);
  assert.equal(now.fades[0][2][5], 5 / 160);
  // late, from B's 0:00: nothing is scheduled before 103.2, and then B starts at its mix-in
  assert.equal(late.sched.length, 1);
  assert.equal(late.sched[0].output, 103.2);
  assert.equal(late.sched[0].input, 0);
  // the fades still run from the mix start, over the whole mix; B's is 0 until it comes in
  assert.deepEqual(late.fades.map(([t0, D]) => [t0, D]), [[100, 16], [100, 16]]);
  const gIn = late.fades[0][2];
  assert.ok(gIn.slice(0, 33).every((v) => v === 0), 'B silent to 3.2 s');
  assert.equal(gIn[33], 33 / 160, 'then the curve, part way up');
  assert.equal(late.fades[1][2][10], 1 - 10 / 160, "A's curve untouched");
  // B's place: at its mix-in until it comes in, then counted from there
  assert.equal(late.at(102), 0);
  assert.ok(Math.abs(late.at(110) - 6.8) < 1e-9);
  // a mix-in past 0 (30 s, B in after 4 s): the pre-roll warms the deck from 29.5 s at 103.5 s, but
  // B's gain is 0 until 104 s, so nothing before 30 s is heard; a skip during the wait lands at 30 s
  const mid = run(4, 30);
  assert.equal(mid.sched[0].output, 103.5);
  assert.equal(mid.sched[0].input, 29.5);
  assert.ok(mid.fades[0][2].slice(0, 41).every((v) => v === 0));
  assert.ok(mid.fades[0][2][41] > 0);
  assert.equal(mid.at(101), 30);
  assert.equal(mid.at(103.99), 30);
  assert.ok(Math.abs(mid.at(110) - 36) < 1e-9);
  // a preset's events: 0 to 4 s, then up to the curve's value 10 ms later, the rest as it was
  const ev = run(4, 30, true).events[0][1];
  assert.equal(JSON.stringify(ev.slice(0, 2)), JSON.stringify([[0, 0, false], [4, 0, false]]));
  assert.ok(Math.abs(ev[2][0] - 4.01) < 1e-9 && Math.abs(ev[2][1] - 0.250625) < 1e-9, JSON.stringify(ev[2]));
  assert.equal(JSON.stringify(ev.slice(3)), JSON.stringify([[8, 0.5, false], [16, 1, false]]));
  // YouTube's player (beginAutomix): its gate gets the same mask, the late seconds still to come
  const begin = between(xf, 'function beginAutomix(', 'blendShape(g, style');
  assert.match(begin, /const late = matched \? \(m\.inDelaySec \|\| 0\) - skip : 0;/);
  assert.match(begin, /playEvents\(inn, lateEvents\(eIn, late\)/);
  assert.match(begin, /fadeCurve\(inn, lateShape\(cIn, D, late\)/);
  assert.match(between(xf, 'function blendTakeOver(', 'deck?.cancel();'), /inStartOf\(m\) \+ \(t - L\.t0\) \* rate/, 'the take-over counts B from its late start');
});

test('Effects lane, mid band and noise (editor.md §12, spotify-mixes.md rules 4-6)', () => {
  const A = loadAutomix(0);
  // a named shape: the outgoing deck's send, and the echo time in the plan's beats
  const pc = A.presetCurves({ preset: 'custom', lanes: { volume: 'overlap', eq: 'none', effect: 'none', fx: 'echo34CutEnd' } }, 16, 0.5);
  assert.equal(JSON.stringify(pc.out.echoSend), JSON.stringify([[12, 0], [16, 0.5]]));
  assert.equal(JSON.stringify(pc.fxTime), JSON.stringify({ echoSec: 0.375, delaySec: 0.25 }));
  // no Effects lane: no sends, no fxTime; an override without fx reads as it did, a none is not stored
  const plain = A.presetCurves({ preset: 'custom', lanes: { volume: 'overlap', eq: 'none', effect: 'none' } }, 16, 0.5);
  assert.equal(plain.fxTime, undefined);
  assert.equal(plain.out.echoSend, undefined);
  const n1 = A.normalizeOverride({ preset: 'custom', lanes: { volume: 'overlap', eq: 'none', effect: 'none', fx: 'none' } });
  assert.equal(JSON.stringify(n1.lanes), JSON.stringify({ volume: 'overlap', eq: 'none', effect: 'none' }));
  assert.equal(A.normalizeOverride({ preset: 'custom', lanes: { volume: 'overlap', eq: 'none', effect: 'none', fx: 'bogus' } }), null);
  // a drawing: sends, mid and noise reach the plan; echoBeats kept
  const lanes = {
    volume: 'overlap',
    eq: { unit: 'beat', out: { mid: [[0, 0], [8, -18]] }, in: {} },
    effect: { unit: 'beat', out: { noise: [[8, 0], [16, 1]] }, in: {} },
    fx: { unit: 'beat', out: { reverb: [[10, 0], [12, 0.25]] }, in: {}, echoBeats: 1 },
  };
  const n2 = A.normalizeOverride({ preset: 'custom', lanes });
  assert.equal(n2.lanes.fx.echoBeats, 1);
  const d = A.presetCurves(n2, 8, 0.5);
  assert.equal(JSON.stringify(d.out.midDb), JSON.stringify([[0, 0], [4, -18]]));
  assert.equal(JSON.stringify(d.out.noise), JSON.stringify([[4, 0], [8, 1]]));
  assert.equal(JSON.stringify(d.out.reverbSend), JSON.stringify([[5, 0], [6, 0.25]]));
  assert.equal(d.fxTime.echoSec, 0.5);
  // Draw from a shape keeps its time
  const sd = A.shapeDrawing('fx', 'delayHalfCutEnd', 8, 0.5, null, 'beat');
  assert.equal(sd.delayBeats, 0.5);
  assert.equal(JSON.stringify(sd.out.delay), JSON.stringify([[12, 0], [16, 0.5]]));
  // the import changes list names the Effects lane only when a side has one
  assert.ok(!A.mixChanges({ v: 1, bars: 8 }, n1).some((l) => l.startsWith('effects')));
  assert.ok(A.mixChanges(n1, n2).includes('effects: none → drawn'), A.mixChanges(n1, n2).join('\n'));
  // Spotify: fx reverb curve (style 3, no name), eq mid, filter noiseColor
  const t = (id, yt) => ({ uri: 'spotify:track:' + id, youtubeVideoId: yt, title: id, artists: ['X'], durationMs: 300000 });
  const seg = (a, b, y0, y1) => ({ start: a, end: b, points: [[0, y0], [1, y1]] });
  const exp = { format: 'spotify-mix-export', version: 3, playlist: { name: 'T', tracks: [] }, mixes: [{
    index: 1, from: t('a', 'rCwSRV7P6hY'), to: t('b', '0X3Y2m9wj5c'), fromStartMs: 100000, durationMs: 16000, bars: 8, fromBpm: 120,
    style: { volume: 7, eq: 0, filter: 15, fx: 3 },
    curves: {
      fx: { from: { reverb: [seg(0, 0.6875, 0, 0), seg(0.6875, 1, 0, 0.305755)] } },
      eq: { from: { mid: [seg(0, 0.5, 0.5, 0.5), seg(0.5, 1, 0.5, 0)] } },
      filter: { from: { noiseColor: [seg(0, 0.5, 0.5, 0.5), seg(0.5, 1, 0.5, 1)], resonance: [seg(0, 1, 0.5, 0.8)] } },
    },
  }] };
  const r = A.readMixFile(JSON.stringify(exp));
  const o = r.mixes[0].override;
  assert.equal(JSON.stringify(o.lanes.fx.out.reverb), JSON.stringify([[0, 0], [22, 0], [32, 0.306]]));
  assert.equal(o.lanes.fx.echoBeats, undefined);
  assert.equal(JSON.stringify(o.lanes.eq.out.mid.slice(-1)), JSON.stringify([[32, -18]]));
  assert.equal(JSON.stringify(o.lanes.effect.out.noise.slice(-1)), JSON.stringify([[32, 1]]));
  const notes = r.notes.join(' | ');
  assert.match(notes, /not carried: filter resonance/);
  // (filter 15 is Noise out end; fx 3 has no name but a drawing: neither counts as unmatched)
  assert.ok(!/no match/.test(notes), notes);
  assert.ok(!/effects|mid band/.test(notes), notes);
});

test('Song speed (spotify-mixes.md rule 10): f18/f19 saved as speed, a song keeps it from mix to mix', () => {
  const A = loadAutomix(0);
  const t = (id, yt) => ({ uri: 'spotify:track:' + id, youtubeVideoId: yt, title: id, artists: ['X'], durationMs: 300000 });
  const a = t('a', 'rCwSRV7P6hY'), b = t('b', '0X3Y2m9wj5c'), c = t('c', 'JGwWNGJdvx8');
  const mix = (index, from, to, f18, f19) => ({ index, from, to, fromStartMs: 100000, durationMs: 16000, bars: 8, fromBpm: 120, f18, f19, style: { volume: 7 } });
  // BUDGET #4/#5: Stay comes in at x0.970569 and goes out at x0.97057; missing is 1
  const r = A.readMixFile(JSON.stringify({ format: 'spotify-mix-export', version: 3, playlist: { name: 'T', tracks: [a, b, c] },
    mixes: [mix(4, a, b, 1, 0.970569), mix(5, b, c, 0.97057, 1.03228), mix(6, c, a)] }));
  const ov = Object.fromEntries(r.mixes.map((m) => [m.key, m.override]));
  assert.equal(JSON.stringify(ov['rCwSRV7P6hY>0X3Y2m9wj5c'].speed), JSON.stringify({ in: 0.97057 }));
  assert.equal(JSON.stringify(ov['0X3Y2m9wj5c>JGwWNGJdvx8'].speed), JSON.stringify({ out: 0.97057, in: 1.03228 }));
  assert.equal(ov['JGwWNGJdvx8>rCwSRV7P6hY'].speed, undefined);
  assert.ok(!/speed/.test(r.notes.join(' | ')), 'the speeds play: no note');
  // a song's speed: from the mix that brought it in, else the one taking it out, else 1
  const of = (k) => ov[k] || null;
  assert.equal(A.songSpeed('0X3Y2m9wj5c', 'rCwSRV7P6hY', 'JGwWNGJdvx8', of), 0.97057);
  assert.equal(A.songSpeed('JGwWNGJdvx8', null, 'rCwSRV7P6hY', of), 1);
  assert.equal(A.songSpeed('0X3Y2m9wj5c', null, 'JGwWNGJdvx8', of), 0.97057);
  assert.equal(A.songSpeed('JGwWNGJdvx8', '0X3Y2m9wj5c', null, of), 1.03228);
  // saved and read back; out of range or 1: dropped; the changes list names it
  assert.equal(A.normalizeOverride({ bars: 8, speed: { out: 3, in: 1 } }).speed, undefined);
  assert.equal(JSON.stringify(A.normalizeOverride({ speed: { in: 1.032622 } })), JSON.stringify({ v: 1, speed: { in: 1.03262 } }));
  assert.ok(A.mixChanges({ v: 1, bars: 8 }, { v: 1, bars: 8, speed: { in: 0.97 } }).includes('speed: x1 → A x1 B x0.97'));
});

test('Song speed plays (spotify-mixes.md rule 10): the plan runs A and B at their speeds, no ramp or glide, no loop mix', () => {
  const A = loadAutomix('auto');
  const sp = (speed, pick = null) => A.plan({ fromId: 'a', toId: 'b', from: song(100, 200), to: song(103, 200), durationSec: 200, pos: 20, earliest: 24.5, pick, speed });
  const plain = sp(null);
  assert.equal(plain.speedOut, undefined);
  const p = sp({ out: 0.97, in: 1 });
  assert.equal(p.speedOut, 0.97);
  assert.equal(p.speedIn, 1);
  // a blend: A at its speed, B at A's played tempo (97 BPM: 97 / 103), gliding back to its speed after
  if (p.style === 'blend') { assert.equal(p.outRate, 0.97); assert.ok(Math.abs(p.rate - 97 / 103) < 1e-9, String(p.rate)); assert.ok(!p.glide && !p.rampBeats); }
  else assert.equal(p.rate, 1);
  const q = sp({ out: 1, in: 1.03 });
  assert.ok(Math.abs(q.rate - (q.style === 'blend' ? 100 / 103 : 1.03)) < 1e-9, String(q.rate));
  assert.equal(q.speedIn, 1.03);
  // the same as no speed when both are 1
  assert.equal(sp({ out: 1, in: 1 }).speedOut, undefined);
  // a picked shape still plans with its speed
  const s = sp({ out: 0.97, in: 0.97 }, { preset: 'custom', lanes: { volume: 'overlap', eq: 'none', effect: 'none' } });
  assert.equal(s.preset, 'custom');
  assert.equal(s.speedIn, 0.97);
});

test('Song speed: the v2 tempo gate compares the played tempos (BitChord, BUDGET #5 Stay x0.97057 -> Cold Water x1.03228)', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  // BitChord's readings: 102.3 and 93.0 BPM, 10% apart raw; as they play 99.29 and 96.0, 3.4% apart
  const go = (speed) => A.plan({ fromId: 'a', toId: 'b', from: song(102.3, 220), to: song(93, 210), durationSec: 220, pos: 30, earliest: 34.5,
    pick: { preset: 'custom', bars: 2, lanes: { volume: 'fadeInFadeOut', eq: 'none', effect: 'none' } }, speed });
  const raw = go(null);
  assert.ok(raw.style !== 'blend' && (raw.warnings || []).some((w) => /10% apart/.test(w)), JSON.stringify([raw.style, raw.warnings]));
  const p = go({ out: 0.97057, in: 1.03228 });
  assert.equal(p.style, 'blend', JSON.stringify([p.style, p.reason, p.warnings]));
  assert.equal(p.bars, 2);
  assert.ok(!(p.warnings || []).some((w) => /apart/.test(w)), JSON.stringify(p.warnings));
  assert.equal(p.outRate, 0.97057);
  assert.ok(Math.abs(p.rate - (0.97057 * 102.3) / 93) < 1e-9, String(p.rate));   // B at A's played tempo
  assert.equal(p.speedIn, 1.03228);                                             // and back to its own after
  assert.ok(!p.glide && !p.rampBeats);
  // played tempos still over 8% apart: no beat match
  const far = go({ out: 1.03, in: 0.97 });
  assert.ok(far.style !== 'blend', far.style);
});

test('Looping lane (editor.md §13): loopN beats of A, from the Spotify style numbers; none is not stored', () => {
  const A = loadAutomix('auto');
  const lanes = (looping) => ({ volume: 'overlap', eq: 'none', effect: 'none', ...(looping ? { looping } : {}) });
  assert.equal(A.presetCurves({ preset: 'custom', lanes: lanes('loop4') }, 16, 0.5).loopBeats, 4);
  assert.equal(A.presetCurves({ preset: 'custom', lanes: lanes(null) }, 16, 0.5).loopBeats, undefined);
  assert.equal(A.normalizeOverride({ preset: 'custom', lanes: lanes('none') }).lanes.looping, undefined);
  assert.equal(A.normalizeOverride({ preset: 'custom', lanes: lanes('loop3') }), null);
  // in a plan: loopSec is N of A's beats (100 BPM: 0.6 s)
  const p = A.plan({ fromId: 'a', toId: 'b', from: song(100, 200), to: song(100, 200), durationSec: 200, pos: 20, earliest: 24.5,
    pick: { preset: 'custom', bars: 8, lanes: lanes('loop2') } });
  assert.ok(Math.abs(p.loopSec - 1.2) < 1e-9, String(p.loopSec));
  // Spotify looping 1..4 and 8: loop2, loop4, loop8, loop16, loop1; no "not carried: looping"
  const t = (id, yt) => ({ uri: 'spotify:track:' + id, youtubeVideoId: yt, title: id, artists: ['X'], durationMs: 300000 });
  const mix = (index, looping) => ({ index, from: t('a' + index, 'rCwSRV7P6h' + index), to: t('b' + index, '0X3Y2m9wj5' + index), fromStartMs: 100000, durationMs: 16000, bars: 8, fromBpm: 120, style: { volume: 7, looping } });
  const r = A.readMixFile(JSON.stringify({ format: 'spotify-mix-export', version: 3, playlist: { name: 'T', tracks: [] },
    mixes: [mix(1, 1), mix(2, 2), mix(3, 3), mix(4, 4), mix(5, 8), mix(6, 0)] }));
  assert.equal(JSON.stringify(r.mixes.map((m) => m.override.lanes.looping ?? 'none')), JSON.stringify(['loop2', 'loop4', 'loop8', 'loop16', 'loop1', 'none']));
  assert.ok(!/looping/.test(r.notes.join(' | ')), r.notes.join(' | '));
  assert.ok(A.mixChanges({ v: 1, preset: 'custom', lanes: lanes(null) }, { v: 1, preset: 'custom', lanes: lanes('loop2') }).includes('looping: none → loop2'));
});

test("Spotify import: a lane left unset plays its base preset's (spotify-mixes.md rule 4)", () => {
  const A = loadAutomix(0);
  const t = (id, yt) => ({ uri: 'spotify:track:' + id, youtubeVideoId: yt, title: id, artists: ['X'], durationMs: 300000 });
  const ids = ['rCwSRV7P6h', '0X3Y2m9wj5', 'JGwWNGJdvx', 'ju4KQT0wL0', 'G8-3EX34Qv', 'qPRNIHxLhm', 'r7zTKRonHX', 'I6etAHfECX', 'Ako1RLZ2za'];
  const mix = (i, style) => ({ index: i, from: t('a' + i, ids[i] + 'A'), to: t('b' + i, ids[i] + 'B'), fromStartMs: 100000, durationMs: 16000, bars: 8, fromBpm: 120, style });
  const r = A.readMixFile(JSON.stringify({ format: 'spotify-mix-export', version: 3, playlist: { name: 'T', tracks: [] }, mixes: [
    mix(0, { basePresetId: 4, eq: 4, filter: 0 }),             // Melt: volume unset
    mix(1, { basePresetId: 21 }),                              // Surge: all unset, its Effects too
    mix(2, { basePresetId: 3, volume: 6 }),                     // Rise: eq and filter unset
    mix(3, { basePresetId: 10 }),                              // an older preset (FilterFadeInOut): its EQ and filter, then the default
    mix(4, { basePresetId: 99, volume: 3 }),                    // an unknown id and an unnamed volume: the default
  ] }));
  const L = r.mixes.map((m) => m.override.lanes);
  assert.equal(L[0].volume, 'fadeInFadeOut');
  assert.equal(JSON.stringify(L[1]), JSON.stringify({ volume: 'fadeInCutOut', eq: 'endBassSwap', effect: 'hpHalfOut', fx: 'reverbOutEnd' }));
  assert.equal(JSON.stringify(L[2]), JSON.stringify({ volume: 'smooth', eq: 'endBassSwap', effect: 'lpInHpOut' }));
  assert.equal(JSON.stringify(L[3]), JSON.stringify({ volume: 'overlap', eq: 'centerBassSwap', effect: 'hpBoth' }));
  assert.equal(JSON.stringify(L[4]), JSON.stringify({ volume: 'overlap', eq: 'centerBassSwap', effect: 'none' }));
});

test("Spotify's presets (editor.md §2): Afterglow, Surge and Dissolve carry effects, Melt fades in and out, No transition is kept", () => {
  const A = loadAutomix('auto');
  assert.equal(JSON.stringify(A.PRESET_LANES.melt), JSON.stringify({ volume: 'fadeInFadeOut', eq: 'centerBassSwap', effect: 'hpBoth' }));
  assert.equal(A.PRESET_LANES.afterglow.fx, 'reverbOutCenter');
  assert.equal(A.PRESET_LANES.surge.fx, 'reverbOutEnd');
  assert.equal(A.PRESET_LANES.dissolve.fx, 'echoHalfOutEnd');
  const ag = A.presetCurves({ preset: 'afterglow' }, 16, 0.5);
  assert.equal(JSON.stringify(ag.out.reverbSend), JSON.stringify([[4, 0], [8, 0.5], [12, 0]]));
  const ds = A.presetCurves({ preset: 'dissolve' }, 16, 0.5);
  assert.equal(ds.fxTime.echoSec, 0.25);
  for (const p of ['afterglow', 'surge', 'dissolve', 'none']) assert.equal(A.normalizeOverride({ preset: p }).preset, p);
  assert.equal(A.presetCurves({ preset: 'none' }, 16, 0.5), null);
});

test("Spotify's 1-bar cut outs and Bass fade out (editor.md §3, from its editor's screenshots)", () => {
  const A = loadAutomix('auto');
  const lanes = (volume, eq = 'none') => ({ preset: 'custom', lanes: { volume, eq, effect: 'none' } });
  // 8 bars of 0.5 s beats (16 s): A cut one bar before the end (14 s), B fades in over the first half
  const f = A.presetCurves(lanes('fadeIn1BarCutOut'), 16, 0.5);
  assert.equal(JSON.stringify(f.out.gain.slice(0, 2)), JSON.stringify([[0, 1], [14, 1]]));
  assert.equal(f.out.gain[2][1], 0);
  assert.ok(f.out.gain[2][0] > 14 && f.out.gain[2][0] < 14.1, String(f.out.gain[2]));
  assert.equal(JSON.stringify(f.in.gain), JSON.stringify([[0, 0], [8, 1]]));
  const o = A.presetCurves(lanes('overlap1BarCutOut'), 16, 0.5);
  assert.equal(JSON.stringify(o.out.gain), JSON.stringify(f.out.gain));
  assert.equal(o.in.gain[1][1], 1);
  assert.ok(o.in.gain[1][0] < 0.1, String(o.in.gain));
  // 6 s: one bar is 2 s, cut at 4 s; 3 s: never before the middle; beat match Off: 7/8
  assert.equal(A.presetCurves(lanes('overlap1BarCutOut'), 6, 0.5).out.gain[1][0], 4);
  assert.equal(A.presetCurves(lanes('overlap1BarCutOut'), 3, 0.5).out.gain[1][0], 1.5);
  assert.equal(A.presetCurves(lanes('overlap1BarCutOut'), 16, 0).out.gain[1][0], 14);
  // A's bass: an S-curve from 0 dB to the cut over the first half, then held; B's untouched
  const b = A.presetCurves(lanes('crossfade', 'bassFadeOut'), 16, 0.5);
  const C = b.out.bassDb.at(-1)[1];
  assert.ok(C < -10, String(C));
  assert.equal(b.out.bassDb.length, 17);
  assert.equal(JSON.stringify(b.out.bassDb[0]), JSON.stringify([0, 0]));
  assert.equal(b.out.bassDb.at(-1)[0], 8);
  assert.ok(Math.abs(b.out.bassDb[8][1] - C / 2) < 1e-6 && b.out.bassDb[8][0] === 4);
  assert.ok(Math.abs(b.out.bassDb[1][1]) < Math.abs(C) / 50, 'eases out');
  assert.equal(b.in.bassDb, undefined);
  // the Spotify numbers: volume 12 and 13, EQ 15
  const t = (id, yt) => ({ uri: 'spotify:track:' + id, youtubeVideoId: yt, title: id, artists: ['X'], durationMs: 300000 });
  const mix = (i, style) => ({ index: i, from: t('a' + i, 'rCwSRV7P6' + i + 'A'), to: t('b' + i, '0X3Y2m9wj' + i + 'B'), fromStartMs: 100000, durationMs: 16000, bars: 8, fromBpm: 120, style });
  const r = A.readMixFile(JSON.stringify({ format: 'spotify-mix-export', version: 3, playlist: { name: 'T', tracks: [] },
    mixes: [mix(1, { volume: 12, eq: 15, filter: 0 }), mix(2, { volume: 13, eq: 4, filter: 0 })] }));
  assert.equal(JSON.stringify(r.mixes.map((m) => [m.override.lanes.volume, m.override.lanes.eq])),
    JSON.stringify([['fadeIn1BarCutOut', 'bassFadeOut'], ['overlap1BarCutOut', 'centerBassSwap']]));
  for (const v of ['fadeIn1BarCutOut', 'overlap1BarCutOut']) assert.equal(A.normalizeOverride(lanes(v, 'bassFadeOut')).lanes.volume, v);
});

test('Import confirm: a seconds-only position reads as its time, not "bar undefined" (mix-file.md rule 5)', () => {
  const A = loadAutomix(0);
  const was = { v: 1, bars: 8, window: { out: { bar: 40, beat: 2, sec: 200.5 } } };
  const now = { v: 1, bars: 8, window: { out: { sec: 218.142, nudgeMs: 20 }, in: { sec: 0 } } };
  const lines = A.mixChanges(was, now);
  assert.ok(lines.includes('mix-out: bar 40.3 → 218.142 s +20 ms'), lines.join('\n'));
  assert.ok(lines.includes('mix-in: auto → 0 s'), lines.join('\n'));
  assert.ok(!lines.join('\n').includes('undefined'));
});

test('Bar phase (analysis-cases.md "The bar"): the bars start where most model downbeats fall, not at a lone first one', () => {
  const A = loadAutomix('auto');
  // SI NO ES CONTIGO's opening as analysed: downbeats 5.999, a pickup at 7.172, then a bar apart from 9.600
  const ib = 0.6, downs = [5.999, 7.172, 9.6, 12.0, 14.4, 16.8, 19.2];
  const a = { bpm: 100, beatIntervalSec: ib, firstDownbeatSec: 5.999, headBeats: { downbeats: downs }, durationSec: 200 };
  const p = A.withBarPhase(a);
  assert.ok(Math.abs(p.firstDownbeatSec - (5.999 + 2 * ib)) < 1e-9, `first downbeat ${p.firstDownbeatSec}`);
  assert.deepEqual(p.headBeats, a.headBeats);
  assert.equal(A.withBarPhase(p), p, 'phasing again changes nothing');
  // a tie keeps the first downbeat's place; a song already on its bars comes back as it was
  const tie = { ...a, headBeats: { downbeats: [6, 7.2, 8.4, 9.6] } };   // places 0, 2, 0, 2
  assert.equal(A.withBarPhase(tie), tie);
  // the tail grid votes with the tail model's downbeats, on its own
  const t = { ...a, headBeats: { downbeats: [6, 8.4] }, tailGrid: { bpm: 100, beatIntervalSec: ib, firstDownbeatSec: 150, gridConfidence: 1 }, tailBeats: { downbeats: [150, 150.6, 153, 155.4] } };
  const tp = A.withBarPhase(t);
  assert.equal(tp.firstDownbeatSec, 5.999);
  assert.ok(Math.abs(tp.tailGrid.firstDownbeatSec - 150.6) < 1e-9, `tail ${tp.tailGrid.firstDownbeatSec}`);
  // a downbeat more than a quarter beat off the grid doesn't vote; no downbeats, no change
  const off = { ...a, headBeats: { downbeats: [5.999, 6.9, 7.5, 8.1] } };
  assert.equal(A.withBarPhase(off), off);
  assert.equal(A.withBarPhase({ ...a, headBeats: null }).firstDownbeatSec, 5.999);
});

test('The curator blend: Auto\'s blend on Automix v2 sits 8 bars on the downbeat nearest 31 s before the end; key, length and asked-for fallbacks', () => {
  const A = loadAutomix('auto', { automixVersion: 3 });
  const keyed = (s, keyName, keyConfidence = 0.9) => ({ ...s, keyName, keyConfidence });
  const cur = keyed(song(120, 200), 'C major'), next = keyed({ ...song(120, 200), introEndSec: 40 }, 'C major');
  const ask = (c, n, extra = {}) => A.plan({ fromId: 'a', toId: 'b', from: c, to: n, durationSec: c.durationSec, pos: 20, earliest: 24.5, ...extra });
  const p = ask(cur, next, { curator: true });
  assert.equal(p.curator, true);
  assert.equal(p.style, 'blend');
  assert.equal(p.bars, 8);
  assert.ok(Math.abs(p.mixOutTrackTime - 168.4) < 1e-6, `mix-out ${p.mixOutTrackTime}`);   // 169 s, nearest downbeat (0.4 + 2 s bars)
  assert.ok(Math.abs(p.mixInTrackTime - 32.4) < 1e-6, `mix-in ${p.mixInTrackTime}`);       // the phrase at 48.4 s less 16 s
  // not asked for (the loop mix won, or Classic): the usual blend, no flag
  assert.equal(ask(cur, next).curator, undefined);
  // fallbacks: keys untrusted, keys clashing, a song under 2 min, no intro in the next song
  assert.equal(ask(cur, keyed(next, 'C major', 0.3), { curator: true }).curator, undefined);
  assert.equal(ask(cur, keyed(next, 'F# major'), { curator: true }).curator, undefined);
  assert.equal(ask(keyed(song(120, 110), 'C major'), next, { curator: true }).curator, undefined);
  assert.equal(ask(cur, keyed(song(120, 200), 'C major'), { curator: true }).curator, undefined);
  // a length asked for wins
  assert.equal(A.plan({ fromId: 'a', toId: 'b', from: cur, to: next, durationSec: 200, pos: 20, earliest: 24.5, curator: true, pick: { v: 1, bars: 4 } }).curator, undefined);
  // the fallback is the usual blend exactly
  assert.deepEqual(JSON.stringify(ask(cur, keyed(next, 'F# major'), { curator: true })), JSON.stringify(ask(cur, keyed(next, 'F# major'))));
});

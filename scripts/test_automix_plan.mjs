// Unit tests for the Automix planner (src/automix/automix.js): where a blend
// starts, how long it is, and the Auto blend length.
// Run: node --test scripts/test_automix_plan.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// automix.js is a content script: run it with just enough of the extension world.
function loadAutomix(bars) {
  const listeners = [];
  const window = { addEventListener() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = {
    runtime: { getURL: (p) => 'chrome-extension://test' + p },
    storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, automixBars: bars }) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const ctx = vm.createContext({ window, chrome, document: {}, console: { log() {} }, performance, setTimeout, clearTimeout, URL });
  vm.runInContext(readFileSync(new URL('../src/automix/automix.js', import.meta.url), 'utf8'), ctx);
  return window.__viviAutomix;
}

// An analysed song: a steady grid, an energy curve in 4-bar windows.
function song(bpm, durationSec, { conf = 1, down = 0.4, energy = () => 1 } = {}) {
  const beat = 60 / bpm, win = beat * 16;
  const curve = Array.from({ length: Math.ceil(durationSec / win) }, (_, i) => energy(i * win));
  return {
    bpm, beatIntervalSec: beat, firstDownbeatSec: down, gridConfidence: conf, durationSec,
    energyCurve: curve, energy: curve.reduce((a, b) => a + b, 0) / curve.length,
    introEndSec: 0, outroStartSec: durationSec - 20,
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

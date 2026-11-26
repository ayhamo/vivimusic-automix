// The phone's and BitChord's Automix engine findings (cross-app audit, 2026-11-26), checked on the PC:
// functions of src/automix/crossfade.js run alone with just enough of their world.
// Run: node scripts/automix_engine_audit_tests.mjs (exits 1 on a failure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const xf = readFileSync(new URL('../src/automix/crossfade.js', import.meta.url), 'utf8');
const between = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `${from} .. ${to}`); return src.slice(a, b); };

test('B2-6: the lyrics stay on the playing song until a late entry brings the next one in', () => {
  // the hold, as crossfade.js exports it on window.__viviCrossfade
  const hold = (live, now) => {
    const ctx = vm.createContext({ live, graph: () => ({ ctx: { currentTime: now } }) });
    return vm.runInContext('({' + between(xf, 'lyricsHold: () =>', 'status: () =>') + '}).lyricsHold()', ctx);
  };
  const base = { phase: 'mixing', oldId: 'a', aPos: 100, T: 10, t0: 20, mixStart: 20, mixEnd: 28, handoffAt: 24 };
  // no late entry: up to the blend's middle
  assert.equal(hold({ ...base, mix: { style: 'blend' } }, 23.9)?.id, 'a');
  assert.equal(hold({ ...base, mix: { style: 'blend' } }, 24), null);
  // B comes in 6 s into the mix: its lyrics wait for that, not the middle (the player plays its pre-roll before)
  const late = { ...base, mix: { style: 'blend', inDelaySec: 6 } };
  assert.deepEqual({ ...hold(late, 25) }, { id: 'a', timeSec: 115 });
  assert.equal(hold(late, 25.99)?.id, 'a');
  assert.equal(hold(late, 26), null);
  // a short late entry, before the middle: the middle still decides
  assert.equal(hold({ ...base, mix: { style: 'blend', inDelaySec: 1 } }, 23.9)?.id, 'a');
  assert.equal(hold({ ...base, mix: { style: 'blend', inDelaySec: 1 } }, 24), null);
  // no mix: nothing held
  assert.equal(hold(null, 25), null);
});

// driveLive in the 'asked' phase before Next, with a fake world around it
function drive(live, { now = 15, enabled = true } = {}) {
  const calls = [];
  const v = { paused: false, currentTime: 100 + (now - 10), volume: 1, muted: false };
  const ctx = vm.createContext({
    live, st: { id: 'a', off: 0, rep: false, next: live.mix?.nextId || 'b' },
    seconds: () => 6, clockStalled: () => false, CLOCK_STOPPED: 'the audio clock stopped', AD_GRACE: 2,
    abortLive: (why) => calls.push('abort ' + why), askNext: () => calls.push('next'),
    performance: { now: () => 0 }, window: { __viviAutomix: { isEnabled: () => enabled } },
  });
  vm.runInContext(between(xf, 'function driveLive(', 'const remaining0') + '\ndriveLive(g, v);', Object.assign(ctx, { g: { ctx: { currentTime: now }, video: v }, v }));
  return calls;
}

test('B2-7: Automix switched off while its mix is armed and not yet heard calls the mix off, unmarked', () => {
  const armed = () => ({ phase: 'asked', askedAt: 0, oldId: 'a', T: 10, aPos: 100, askAt: 30, t0: 20, mix: { style: 'blend', nextId: 'b' }, k: 1, volRef: 1, muted: false });
  assert.deepEqual(drive(armed(), { enabled: false }), ['abort automix switched off']);
  assert.deepEqual(drive(armed(), { enabled: true }), [], 'on: the mix waits for its Next');
  // already heard (the incoming deck's blend starts at t0, before Next): it plays to its end
  assert.deepEqual(drive(armed(), { now: 21, enabled: false }), []);
  // a plain crossfade is not Automix's
  assert.deepEqual(drive({ ...armed(), mix: null, t0: undefined }, { enabled: false }), []);
  assert.match(between(xf, 'const BY_LISTENER', ']);'), /'automix switched off'/, 'not marked as the song failing');
});

test("BitChord loop flags: a soft stop's late stop never lands on the loop decks a new loop mix has taken", () => {
  const run = (liveAfter) => {
    const stops = [], timers = [];
    const loopDecks = [{ stop: () => stops.push(0) }, { stop: () => stops.push(1) }];
    const p = { cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
    const ctx = vm.createContext({ loopDecks, deckOut: { context: { currentTime: 5 }, gain: p }, live: null, setTimeout: (f) => timers.push(f) });
    vm.runInContext(between(xf, 'function stopLoopDecks(', 'function finishLive(') + '\nstopLoopDecks(true);', ctx);
    assert.deepEqual(stops, [], 'not at once: it fades first');
    ctx.live = liveAfter;
    timers.forEach((f) => f());
    return stops;
  };
  assert.deepEqual(run(null), [0, 1], 'no new mix: both decks stop');
  assert.deepEqual(run({ mix: { style: 'blend' } }), [0, 1], 'a blend does not use them');
  assert.deepEqual(run({ mix: { style: 'loop' } }), [], 'a new loop mix keeps them');
});

test("BitChord 1b #4: a playlist speed's rate, once off the player, never takes the user's own speed back to x1", () => {
  // the speed block of the tick, with the player, the song's want and the rate last set
  const body = between(xf, 'const want = window.__viviAutomix', 'const eligible');
  const tickOnce = (ctx) => vm.runInContext('{' + body + '}', ctx);
  const ctx = vm.createContext({ live: null, gliding: false, st: { id: 'a' }, speedSet: 0, log() {},
    off1: (s) => Math.abs(s - 1) >= 1e-4, window: { __viviAutomix: { isEnabled: () => true } } });
  ctx.v = { playbackRate: 1 };
  ctx.speedOf = () => 1.08;
  tickOnce(ctx);
  assert.equal(ctx.v.playbackRate, 1.08, 'the song plays at its playlist speed');
  // the next song has none: back to x1
  ctx.speedOf = () => 1;
  tickOnce(ctx);
  assert.equal(ctx.v.playbackRate, 1);
  // a song at x1.08, the user then sets x1.25, then x1.08 on a song with no playlist speed: theirs stays
  ctx.speedOf = () => 1.08; tickOnce(ctx);
  ctx.v.playbackRate = 1.25; ctx.speedOf = () => 1; tickOnce(ctx);
  assert.equal(ctx.v.playbackRate, 1.25);
  ctx.v.playbackRate = 1.08; tickOnce(ctx);
  assert.equal(ctx.v.playbackRate, 1.08, "the user's x1.08 is not the rate this code set");
  // and a song with a playlist speed doesn't take it over either
  ctx.speedOf = () => 0.97; tickOnce(ctx);
  assert.equal(ctx.v.playbackRate, 1.08);
});

const ov = readFileSync(new URL('../src/automix-overview.js', import.meta.url), 'utf8');
test('BitChord 3a #8, #10: Reset to Auto drops a Draw waiting on a loop mix; an emptied "B in after" saves nothing', () => {
  assert.match(between(ov, "reset.addEventListener('click'", '\n'), /pendingDraw = null/);
  const change = between(ov, "lateIn.addEventListener('change'", '\n');
  const asked = [];
  for (const value of ['', '  ', '2.5', '0']) {
    vm.runInContext(change.replace("lateIn.addEventListener('change', ", '(').replace(/\);\s*$/, ')()'), vm.createContext({ lateIn: { value }, setLate: (x) => asked.push(x), Number }));
  }
  assert.deepEqual(asked.map((x) => (Number.isNaN(x) ? 'NaN' : x)), ['NaN', 'NaN', 2.5, 0]);
});

// The transition editor's fixtures (spec/automix/editor-cases.json, rules in editor.md): every
// preset and every lane shape → its curves, and saved window positions → song seconds, on the
// planner's presetCurves / resolveWindow (src/automix/automix.js); plans: an override on two steady songs
// → the window the planner plays and whether the kick lock may move it (plan, kickLockAllowed).
//
//   node scripts/editor_cases.mjs            compare (exit 1 on a difference)
//   node scripts/editor_cases.mjs --update   write the expected values (review the diff: it's the spec)
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const FILE = new URL('spec/automix/editor-cases.json', ROOT);

function load(engine) {
  const window = { addEventListener() {}, postMessage() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = { runtime: { getURL: (p) => 'moz-extension://test/' + p }, storage: { local: { get: (d, cb) => cb(engine ? { ...d, automixVersion: engine } : d) }, onChanged: { addListener() {} } } };
  vm.runInContext(readFileSync(new URL('src/automix/automix.js', ROOT), 'utf8'), vm.createContext({ window, chrome, document: {}, console: { log() {}, warn() {} }, performance, setTimeout, clearTimeout, URL }));
  return window.__viviAutomix;
}
const A = load(null);
// a steady song as the cases give it: { bpm, sec, downbeatSec }, every beat sure, flat energy
function song({ bpm, sec, downbeatSec }) {
  const beat = 60 / bpm, curve = Array.from({ length: Math.ceil(sec / (beat * 16)) }, () => 1);
  return { bpm, beatIntervalSec: beat, firstDownbeatSec: downbeatSec, gridConfidence: 1, durationSec: sec, energyCurve: curve, energy: 1, introEndSec: 0, outroStartSec: sec - 20 };
}
const r6 = (x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x);

const spec = JSON.parse(readFileSync(FILE, 'utf8'));
const update = process.argv.includes('--update');
let failed = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const c of spec.curves) {
  const got = A.presetCurves(c.override, c.D, c.beatSec);
  if (update) { c.expect = got; continue; }
  const ok = same(got, c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} curves ${c.name}`);
}
for (const c of spec.windows) {
  const got = A.resolveWindow(c.pos, c.grid);
  if (update) { c.expect = got; continue; }
  const ok = same(got, c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} window ${c.name}${ok ? '' : ': got ' + JSON.stringify(got)}`);
}
for (const c of spec.plans) {
  const P = load(c.engine), from = song(c.out), to = song(c.in);
  const p = P.plan({ fromId: 'a', toId: 'b', from, to, durationSec: from.durationSec, pos: c.pos, earliest: c.pos + 4.5, pick: c.override, speed: c.override?.speed || null });
  const got = { style: p.style, bars: p.bars, durationSec: r6(p.durationSec), mixOutTrackTime: r6(p.mixOutTrackTime), mixInTrackTime: r6(p.mixInTrackTime), glide: !!p.glide, kickLock: c.engine === 3 && P.kickLockAllowed(p), warnings: p.warnings || [] };
  // songs at a speed (the override's speed, spotify-mixes.md rule 10): the decks' rates too
  if (c.override?.speed) Object.assign(got, { outRate: r6(p.outRate || 1), rate: r6(p.rate), speedOut: p.speedOut ?? 1, speedIn: p.speedIn ?? 1 });
  if (update) { c.expect = got; continue; }
  const ok = same(got, c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} plan ${c.name}${ok ? '' : ': got ' + JSON.stringify(got)}`);
}
// editor.md §10, drawn curves
const counted = (o) => o && { ...o, lanes: Object.fromEntries(Object.entries(o.lanes || {}).map(([k, v]) => [k, typeof v === 'string' ? v : { out: v.out.length ?? Object.keys(v.out).length, in: v.in.length ?? Object.keys(v.in).length }])) };
const draws = spec.draw.filter((c) => c.name);
for (const c of draws) {
  let got;
  if (c.fn === 'pointCurves') {
    const D = c.D ?? A.glideSteps(c.glide.q, c.glide.beats, c.glide.beatOutSec).total;
    got = A.pointCurves(c.lanes, D, c.beatSec, c.glide || null);
  } else if (c.fn === 'presetCurves') got = A.presetCurves(c.override, c.D, c.beatSec, { beatSec: c.beatSec, glide: null });
  else if (c.fn === 'normalizeOverride') { got = A.normalizeOverride(c.override); if (c.count) got = counted(got); }
  else if (c.fn === 'shapeDrawing') got = A.shapeDrawing(c.lane, c.shape, c.D, c.beatSec, null, c.unit);
  else if (c.fn === 'plan') {
    const P = load(null), from = song(c.out), to = song(c.in);
    const p = P.plan({ fromId: 'a', toId: 'b', from, to, durationSec: from.durationSec, pos: c.pos, earliest: c.pos + 4.5, pick: c.override });
    got = { style: p.style, bars: p.bars, durationSec: r6(p.durationSec), outRate: r6(p.outRate || 1), rate: r6(p.rate), gainOut: p.curves.out.gain, gainIn: p.curves.in.gain };
  }
  if (update) { c.expect = got ?? null; continue; }
  const ok = same(got ?? null, c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} draw ${c.name}${ok ? '' : ': got ' + JSON.stringify(got)}`);
}
const n = spec.curves.length + spec.windows.length + spec.plans.length + draws.length;
if (update) { writeFileSync(FILE, JSON.stringify(spec, null, 1) + '\n'); console.log('wrote', n, 'cases'); }
else console.log(failed ? `${failed} case(s) differ` : `all ${n} editor cases pass`);
process.exit(failed ? 1 : 0);

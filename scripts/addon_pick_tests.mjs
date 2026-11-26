// Tests for src/addons/pick.js and the client's readings (src/addons/client.js), from
// the shared cases in spec/addons/pick-cases.json (the phone's tests read the same
// file). The matcher itself is checked by scripts/addon_matcher_fixtures.mjs.
//
//   node scripts/addon_pick_tests.mjs        (exit 1 on a failure)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/addons/pick.js');
const C = require('../src/addons/client.js');
const cases = JSON.parse(fs.readFileSync(new URL('../spec/addons/pick-cases.json', import.meta.url), 'utf8'));

let failed = 0, n = 0;
const check = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

for (const c of cases.rowsToOpen) {
  const r = P.rowsToOpen(c.rows, c.target, c.opt);
  check('rowsToOpen: ' + c.name, { open: r.open.map((x) => x.id), refused: r.refused }, c.expect);
}
for (const [t, want] of cases.tierOf) check(`tierOf "${t}"`, P.tierOf(t), want);
for (const [raw, want] of cases.kbps) check(`kbps ${JSON.stringify(raw)}`, P.rowOf({ id: 'a', title: 't', ...raw }).kbps, want);
for (const c of cases.probeVerdict) {
  const v = P.probeVerdict(c.head, c.row, c.songSec, c.slackSec);
  check('probe: ' + c.name, { ok: v.ok, ...(v.why ? { why: v.why } : {}) }, c.expect);
}
for (const c of cases.paramsFor) check('paramsFor: ' + c.name, C.paramsFor(c.manifest, c.tier, c.picked), c.expect);
const client = C.create({});
for (const c of cases.readStream) {
  const s = client.readStream(c.answer);
  check('readStream: ' + c.name, Object.fromEntries(Object.keys(c.expect).map((k) => [k, s[k]])), c.expect);
}
for (const c of cases.loudnessGain) check('loudnessGain: ' + c.name, P.loudnessGainDb(c.audioConfig), c.expectDb);
// offset-map.md, Level [phone only]: a reference of the phone's OffsetFit.windowGainDb, built from the group's _about
function windowLevelDb(c) {
  const N = 4000, kYt = 10 ** (c.ytDb / 20), kRel = 10 ** ((c.fileDb - c.ytDb) / 20);
  const yt = Float64Array.from({ length: N }, (_, i) => kYt * (0.05 + 0.04 * Math.sin(i / 37)));
  const file = Float64Array.from({ length: N }, (_, i) => {
    const j = Math.round(i - c.offsetSec / 0.01);
    return j < 0 || j >= N || i * 0.01 < (c.fileSilentSec || 0) ? 0 : yt[j] * kRel;
  });
  let a = 0, b = 0, n = 0;
  for (let i = Math.max(0, Math.ceil(c.fromSec / 0.01)); i < Math.min(N, Math.floor(c.untilSec / 0.01)); i++) {
    const j = Math.round(i - c.offsetSec / 0.01);
    if (j < 0 || j >= N || yt[j] < 1e-3 || file[i] < 1e-3) continue;
    a += yt[j] ** 2; b += file[i] ** 2; n++;
  }
  const g = n * 0.01 < 2 ? 0 : 10 * Math.log10(a / b);
  return Math.round(Math.min(g, 6) * 1e4) / 1e4 + 0;
}
for (const c of cases.windowLevel.filter((x) => x.name)) check('windowLevel: ' + c.name, windowLevelDb(c.input), c.expectDb);
for (const c of cases.qualityRank) check('qualityRank: ' + c.name, P.qualityRank(c.stream), c.expect);
for (const c of cases.floorVerdict) check('floor: ' + c.name, P.floorVerdict(c.stream, c.ytKbps), c.expect);
for (const c of cases.upgradeWanted) check('upgrade: ' + c.name, P.upgradeWanted(c.stream, c.tier, c.cached), c.expect);
for (const [u, want] of cases.baseOf) check(`baseOf "${u}"`, C.baseOf(u), want);
for (const [a, b, want] of cases.sameAddon) check(`sameAddon ${a} ~ ${b}`, C.sameAddon(a, b), want);

// a group the cases add that this file doesn't read fails, not passes unchecked
const READ = ['_about', 'rowsToOpen', 'tierOf', 'kbps', 'probeVerdict', 'paramsFor', 'readStream', 'baseOf', 'sameAddon', 'loudnessGain', 'windowLevel', 'qualityRank', 'floorVerdict', 'upgradeWanted'];
for (const g of Object.keys(cases).filter((k) => !READ.includes(k))) check(`the cases' group ${g} is read here`, false, true);
console.log(failed ? `${failed} of ${n} failed` : `all ${n} passed`);
process.exit(failed ? 1 : 0);

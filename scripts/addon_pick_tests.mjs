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
for (const [u, want] of cases.baseOf) check(`baseOf "${u}"`, C.baseOf(u), want);
for (const [a, b, want] of cases.sameAddon) check(`sameAddon ${a} ~ ${b}`, C.sameAddon(a, b), want);

console.log(failed ? `${failed} of ${n} failed` : `all ${n} passed`);
process.exit(failed ? 1 : 0);

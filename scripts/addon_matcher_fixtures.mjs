// Fixtures for addon track matching (spec/addons/matcher-cases.json).
//
// Runs a TrackMatcher on each case (a YouTube Music song against an addon's
// search rows) and compares it with the case's expect block.
//
//   node scripts/addon_matcher_fixtures.mjs --matcher <trackMatcher.ts|.js>            compare (exit 1 on a difference)
//   node scripts/addon_matcher_fixtures.mjs --matcher <trackMatcher.ts|.js> --update   write the expect blocks
//
// The matcher module must export score(candidate, target) and ranked(candidates, target)
// with BitChord's types (web/app/src/data/match/trackMatcher.ts). Node 23.6+ runs
// the .ts file as is. The expect blocks were made with BitChord's own port; the
// extension's port must reproduce them.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--matcher');
if (at < 0 || !args[at + 1]) {
  console.error('usage: node scripts/addon_matcher_fixtures.mjs --matcher <path to trackMatcher.ts|.js> [--update]');
  process.exit(2);
}
const loaded = await import(pathToFileURL(resolve(args[at + 1])).href);
// (an ES module's exports, or a classic script's module.exports: src/addons/track-matcher.js)
const M = typeof loaded.score === 'function' ? loaded : loaded.default;
const update = args.includes('--update');
const FILE = new URL('../spec/addons/matcher-cases.json', import.meta.url);
const doc = JSON.parse(readFileSync(FILE, 'utf8'));

let failed = 0;
for (const c of doc.cases) {
  const scores = {};
  for (const row of c.candidates) {
    const s = M.score(row, c.target);
    if (s !== null) scores[row.id] = s;
  }
  const ranked = M.ranked(c.candidates, c.target).map((r) => r.id);
  const got = {
    pick: ranked[0] ?? null,
    ranked,
    scores,
    rejected: c.candidates.map((r) => r.id).filter((id) => !(id in scores)),
  };
  if (update) { c.expect = got; console.log('wrote', c.name, '→', got.pick); continue; }
  const same = JSON.stringify(got) === JSON.stringify(c.expect);
  if (!same) failed++;
  console.log(same ? 'ok  ' : 'DIFF', c.name, same ? '→ ' + got.pick : '| want ' + JSON.stringify(c.expect) + ' got ' + JSON.stringify(got));
}
// queries(target): the search queries, in the order they are tried
for (const q of doc.queries || []) {
  const got = M.queries(q.target);
  if (update) { q.expect = got; console.log('wrote queries', q.name, '→', JSON.stringify(got)); continue; }
  const same = JSON.stringify(got) === JSON.stringify(q.expect);
  if (!same) failed++;
  console.log(same ? 'ok  ' : 'DIFF', 'queries:', q.name, same ? '→ ' + JSON.stringify(got) : '| want ' + JSON.stringify(q.expect) + ' got ' + JSON.stringify(got));
}
if (update) writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
process.exit(failed ? 1 : 0);

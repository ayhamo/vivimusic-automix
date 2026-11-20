// The window check on real songs (spec/addons/window-cases.json, offset-map.md "Window check"):
// each measured window again, on the local copies in .cache/addons (git-ignored; how to rebuild them
// is in the cases' notes). A song without both copies is skipped. Exit 1 on a verdict or offset
// that differs from the measured one.
//
//   node scripts/addon_window_cases.mjs [--cache DIR]
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const F = createRequire(import.meta.url)('../src/addons/offset-fit.js');
const args = process.argv.slice(2);
const CACHE = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : new URL('../.cache/addons/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cases = JSON.parse(readFileSync(new URL('../spec/addons/window-cases.json', import.meta.url), 'utf8'));
const read = (f) => { const b = readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const R = F.FIT_RATE, WIN = 12;

let ok = 0, diff = 0, skipped = 0;
for (const s of cases.songs) {
  const y = `${CACHE}/${s.id}.yt.f32`, a = `${CACHE}/${s.id}.ad.f32`;
  if (!existsSync(y) || !existsSync(a)) { skipped += s.windows.length; console.log(`skip ${s.id} (${s.title}): no local copies`); continue; }
  const yt = read(y), ad = read(a);
  for (const w of s.windows) {
    const r = F.fitWindow(yt, ad.subarray(Math.round(w.posSec * R), Math.min(ad.length, Math.round((w.posSec + WIN) * R))), w.posSec);
    const got = r.none ? 'refuse' : 'match';
    const good = got === w.expect && (got === 'refuse' || Math.abs(r.offsetSec * 1000 - w.offsetMs) <= 1);
    if (good) ok++; else diff++;
    console.log(`${good ? 'ok  ' : 'DIFF'} ${s.id} at ${w.posSec} s: ${got}${r.none ? '' : ` ${(r.offsetSec * 1000).toFixed(2)} ms`} (coarse ${r.coarseScore?.toFixed(3) ?? '-'}, fine ${r.score?.toFixed(3) ?? '-'}; measured ${w.expect}${w.offsetMs != null ? ' ' + w.offsetMs + ' ms' : ''})`);
  }
}
console.log(`\nwindow cases: ${ok} ok, ${diff} DIFF, ${skipped} skipped (of ${cases.windowCount})`);
process.exit(diff ? 1 : 0);

// Golden fixtures for the Automix planner (spec/automix).
//
// Each spec/automix/pairs/*.json holds two real songs as the extension saw them
// (analysis, sung spans from synced lyrics, loudness at 20 Hz). This runs
// today's planner (src/automix/automix.js) on them, for the two engines,
// Classic (version 2) and Automix v2 (version 3), and compares the plans with
// spec/automix/golden/*.json.
//
//   node scripts/automix_fixtures.mjs            compare (exit 1 on a difference)
//   node scripts/automix_fixtures.mjs --update   write the golden files
//
// Planning position: the playing song's second max(30, duration - 95), the
// same point the in-browser pair test plans from; earliest mix-out 4.5 s later.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const PAIRS = new URL('spec/automix/pairs/', ROOT);
const GOLDEN = new URL('spec/automix/golden/', ROOT);
const HAND_LEAD = 4;   // crossfade.js: the old song moves to its decoded copy this long before the blend

function loadAutomix(version) {
  const window = { addEventListener() {}, postMessage() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = {
    runtime: { getURL: (p) => 'moz-extension://test/' + p },
    storage: {
      local: { get: (defaults, cb) => cb({ ...defaults, automixBars: 'auto', automixVersion: version, automixKeyAware: false }) },
      onChanged: { addListener() {} },
    },
  };
  const ctx = vm.createContext({ window, chrome, document: {}, console: { log() {}, warn() {} }, performance, setTimeout, clearTimeout, URL });
  vm.runInContext(readFileSync(new URL('src/automix/automix.js', ROOT), 'utf8'), ctx);
  return window.__viviAutomix;
}

// The decoded song as the loop planner reads it: rms() takes every 16th sample
// of channel 0, so 16 samples per 50 ms window, each the window's loudness.
function bufferOf(song) {
  const sampleRate = 320, n = song.loudness20Hz.length * 16;
  const data = new Float32Array(n);
  song.loudness20Hz.forEach((v, w) => data.fill(v, w * 16, w * 16 + 16));
  return { duration: song.decodedSec, sampleRate, numberOfChannels: 1, length: n, getChannelData: () => data };
}

// Rounded so the golden files don't churn on float noise.
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);

function planPair(pair, version) {
  const A = loadAutomix(version);
  const [a, b] = pair.songs;
  const pos = Math.max(30, a.analysis.durationSec - 95), earliest = pos + HAND_LEAD + 0.5;
  const blend = A.plan({ fromId: a.id, toId: b.id, from: a.analysis, to: b.analysis, durationSec: a.analysis.durationSec, pos, earliest });
  const cur = A.asOutgoing(a.analysis), nxt = b.analysis;
  const loop = A.gridOk(cur) && A.gridOk(nxt)
    ? A.planLoopMix(cur, bufferOf(a), nxt, bufferOf(b), pos + A.LOOP.LOOP_SETUP_SEC, { out: a.sung, in: b.sung })
    : { none: 'beat grid too weak' };
  // what the extension plays: the loop mix when it found bars (Automix v2: and it
  // scores over the blend, automix.js loopOrBlend), else the blend plan
  const pick = A.loopOrBlend(blend, loop);
  return round({ pos, earliest, plays: pick.loop ? 'loop' : blend.style, ...(pick.why ? { choice: pick.why } : {}), loop, blend });
}

const update = process.argv.includes('--update');
mkdirSync(GOLDEN, { recursive: true });
let failed = 0;
for (const f of readdirSync(PAIRS).filter((x) => x.endsWith('.json')).sort()) {
  const pair = JSON.parse(readFileSync(new URL(f, PAIRS), 'utf8'));
  const got = { pair: pair.name, v2: planPair(pair, 2), v3: planPair(pair, 3) };
  const file = new URL(f, GOLDEN);
  const text = JSON.stringify(got, null, 2) + '\n';
  if (update) { writeFileSync(file, text); console.log('wrote', f, '| Classic plays', got.v2.plays, '| v2 plays', got.v3.plays); continue; }
  let want = null;
  try { want = readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (want === text) console.log('ok  ', f, '| Classic', got.v2.plays, '| v2', got.v3.plays);
  else { failed++; console.log('DIFF', f, want === null ? '(no golden file: run with --update)' : '| Classic plays ' + got.v2.plays + ', v2 plays ' + got.v3.plays); }
}
// Hard rules (PLAN.md): Vaina Loca → SI NO ES CONTIGO keeps Web's loop under
// Automix v2; Stereo Love → Midnight Sun (11% apart) is never a loop.
const MUST = { '1-': 'loop', '2-': '!loop' };
for (const f of readdirSync(GOLDEN).filter((x) => x.endsWith('.json')).sort()) {
  const want = MUST[f.slice(0, 2)];
  if (!want) continue;
  const plays = JSON.parse(readFileSync(new URL(f, GOLDEN), 'utf8')).v3.plays;
  const ok = want.startsWith('!') ? plays !== want.slice(1) : plays === want;
  if (!ok) { failed++; console.log('RULE', f, '| v3 plays', plays, '| must', want === '!loop' ? 'never be a loop' : 'be a ' + want); }
}
process.exit(failed ? 1 : 0);

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

// lyrics: null plans as captured (the blend without lyrics, the loop with the captured
// spans); 'lines' plans both with the pair's lyric line shapes (versions.md "Where a
// song is sung"); 'lrc' with the same lines cut to plain LRC (a start only), as most
// synced lyrics are (the phone's hand-overs, 2026-11-24). mixed: the playing song on
// its lyrics, the next song on its vocal mask (as live when only A has synced lyrics):
// 'old' A's captured spans (the rule before "Where a song is sung"), 'lines' and 'lrc'
// A's line shapes under the current rule.
function planPair(pair, version, lyrics = null, mixed = false) {
  const A = loadAutomix(version);
  const [a, b] = pair.songs;
  const pos = Math.max(30, a.analysis.durationSec - 95), earliest = pos + HAND_LEAD + 0.5;
  const spans = (s) => {
    if (!lyrics) return s.sung;
    if (!s.lines) return null;
    const shapes = lyrics === 'lrc' ? s.lines.map((l) => ({ start: l.start, end: null, words: l.words, wordTimes: null })) : s.lines;
    const sp = A.sungSpansFromLines(shapes);
    return sp.length ? sp : null;
  };
  const sung = mixed ? { out: lyrics === 'old' ? a.sung ?? null : spans(a), in: null } : { out: spans(a), in: spans(b) };
  if (lyrics) { A.primeSung(a.id, sung.out); A.primeSung(b.id, sung.in); }
  const blend = A.plan({ fromId: a.id, toId: b.id, from: a.analysis, to: b.analysis, durationSec: a.analysis.durationSec, pos, earliest });
  const cur = A.asOutgoing(a.analysis), nxt = b.analysis;
  const loop = A.gridOk(cur) && A.gridOk(nxt)
    ? A.planLoopMix(cur, bufferOf(a), nxt, bufferOf(b), pos + A.LOOP.LOOP_SETUP_SEC, sung)
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
  const got = { pair: pair.name, v2: planPair(pair, 2), v3: planPair(pair, 3), v3lyrics: planPair(pair, 3, 'lines'), v3lrc: planPair(pair, 3, 'lrc'),
    v3mixedOld: planPair(pair, 3, 'old', true), v3mixed: planPair(pair, 3, 'lines', true), v3mixedLrc: planPair(pair, 3, 'lrc', true) };
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
// versions.md "Tempo too far apart": pairs over 8% apart get a filter mix or an echo out, not the hand-over
for (const [f, want] of [['2-', 'filter'], ['3-', 'echo'], ['5-', 'echo']]) {
  const name = readdirSync(GOLDEN).find((x) => x.startsWith(f));
  const b = JSON.parse(readFileSync(new URL(name, GOLDEN), 'utf8')).v3.blend;
  const got = b.shape === 'echo' ? 'echo' : b.style;
  if (got !== want) { failed++; console.log('RULE', name, '| v3 blend', got, '| must be', want === 'echo' ? 'an echo out' : 'a filter mix'); }
}
// versions.md "Where a song is sung": with lyrics (as captured, and cut to plain LRC) Unethical → Escapism
// and Poker Face → Let Me Love You don't fall to the hand-over (both have an unsung catch or blend)
for (const f of ['3-', '5-']) {
  const name = readdirSync(GOLDEN).find((x) => x.startsWith(f));
  const g = JSON.parse(readFileSync(new URL(name, GOLDEN), 'utf8'));
  for (const v of ['v3lyrics', 'v3lrc']) {
    const b = g[v].blend;
    if (g[v].plays !== 'loop' && b.handoff) { failed++; console.log('RULE', name, v, '| plays a hand-over:', b.reason, '| must not, with lyrics'); }
  }
}
// The same with only the playing song's lyrics, the next song on its mask (the phone's
// live case, 2026-11-24): Poker Face -> Let Me Love You is an echo out, never the hand-over
{
  const name = readdirSync(GOLDEN).find((x) => x.startsWith('5-'));
  const g = JSON.parse(readFileSync(new URL(name, GOLDEN), 'utf8'));
  for (const v of ['v3mixed', 'v3mixedLrc']) {
    const b = g[v].blend;
    if (b.handoff || b.shape !== 'echo') { failed++; console.log('RULE', name, v, '| plays', b.handoff ? 'a hand-over' : b.shape || b.style, '|', b.reason, '| must be an echo out'); }
  }
}
// versions.md "Loop on the blend's bars": each loop starts a whole number of bars on the grids the blend uses
{
  const PAIRS = new URL('../spec/automix/pairs/', import.meta.url);
  const onBars = (t, g) => { const k = (t - g.down) / (4 * g.beat); return Math.abs(k - Math.round(k)) * 4 <= 0.25; };
  for (const f of readdirSync(GOLDEN).filter((x) => x.endsWith('.json')).sort()) {
    const [a, b] = JSON.parse(readFileSync(new URL(f, PAIRS), 'utf8')).songs.map((s) => s.analysis);
    const ga = a.tailGrid ? { down: a.tailGrid.firstDownbeatSec, beat: a.tailGrid.beatIntervalSec } : { down: a.firstDownbeatSec, beat: a.beatIntervalSec };
    const gb = { down: b.firstDownbeatSec, beat: b.beatIntervalSec };
    const g = JSON.parse(readFileSync(new URL(f, GOLDEN), 'utf8'));
    for (const v of ['v2', 'v3']) {
      const l = g[v].loop;
      if (!l?.out) continue;
      if (!onBars(l.out.loop[0], ga) || !onBars(l.in.loop[0], gb)) { failed++; console.log('RULE', f, v, '| loop at', l.out.loop[0], '/', l.in.loop[0], '| must start on the bar lines the blend uses'); }
    }
  }
}
// versions.md "Where the blend sits": Vaina Loca's v2 blend ends where its outro begins (163.5 s), starting before Classic's 160.98 s
{
  const b = JSON.parse(readFileSync(new URL('1-vaina-loca__si-no-es-contigo.json', GOLDEN), 'utf8')).v3.blend;
  if (b.anchor?.kind !== 'outro' || !(Math.abs(b.anchor.sec - 163.53) < 0.1) || !(b.mixOutTrackTime < 160.98)) {
    failed++; console.log('RULE 1-vaina-loca | v3 blend at', b.mixOutTrackTime, b.anchor?.kind, '| must end on the outro (163.5 s), starting before 160.98 s');
  }
}
process.exit(failed ? 1 : 0);

// The shared canvas cases (spec/canvas/canvas-cases.json) against the PC's code:
//   src/plus/video-canvas-page.js  (its pure core, globalThis.__viviVideoCanvasCore)
//   src/plus/canvas-settings.js    (parseOrder, parseEnabled, pickVariant)
//   src/plus/bg-canvas.js          (viviSpotifyCanvas: totp, matches, trusted)
//   src/apple-canvas.js + the Apple block of src/plus/bg-plus.js (search, scoring, motion URLs)
// Prints ok or DIFF per case, "skip" for a group the PC has no pure function for, then a summary.
//
//   node scripts/canvas_cases_tests.mjs        (exit 1 on any DIFF)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('spec/canvas/canvas-cases.json', root), 'utf8'));

// ── the PC's code ──
createRequire(import.meta.url)('../src/plus/video-canvas-page.js');
const V = globalThis.__viviVideoCanvasCore;
const CS = createRequire(import.meta.url)('../src/plus/canvas-settings.js');

const spCtx = {
  chrome: { storage: { local: { get: async () => ({ viviCanvasOrderSet: true }), set: async () => {} } } },
  crypto: webcrypto, TextEncoder, URL, console: { info() {}, warn() {} }, setTimeout, clearTimeout, AbortController,
};
vm.createContext(spCtx);
vm.runInContext(readFileSync(new URL('src/plus/bg-canvas.js', root), 'utf8') + '\nthis.c = viviSpotifyCanvas;', spCtx);
const SP = spCtx.c;

// apple-canvas.js, then bg-plus.js's Apple block (the port of BitChord's token and motion URLs), no network
const apCtx = {
  chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } },
  TextEncoder, TextDecoder, URL, atob, btoa, Intl, navigator: { language: 'en-US' },
  console: { log() {}, info() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {},
  fetch: async () => { throw new Error('no network in tests'); },
};
vm.createContext(apCtx);
vm.runInContext(readFileSync(new URL('src/apple-canvas.js', root), 'utf8'), apCtx, { filename: 'src/apple-canvas.js' });
{
  const lines = readFileSync(new URL('src/plus/bg-plus.js', root), 'utf8').split(/\r?\n/);
  const a = lines.findIndex((l) => l.startsWith('// ── apple-canvas.js (ported'));
  let b = a;
  while (b >= 0 && b < lines.length && lines[b] !== '}') b++;
  if (a < 0 || b >= lines.length) throw new Error("bg-plus.js: the Apple block's markers moved");
  vm.runInContext(lines.slice(a, b + 1).join('\n'), apCtx, { filename: 'src/plus/bg-plus.js (Apple block)', lineOffset: a });
}
apCtx.__setSearch = (data) => { apCtx.__search = data; };
vm.runInContext('ampGet = async (path) => (path.endsWith("/search") ? __search : null);', apCtx);

// ── reporting ──
let ok = 0, diff = 0, skipped = 0;
const near = (a, b, tol = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const same = (a, b, tol) => {
  if (typeof a === 'number' && typeof b === 'number') return near(a, b, tol);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const k = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...k].every((x) => same(a[x], b[x], tol));
  }
  return a === b;
};
const show = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
function report(group, name, got, want, tol) {
  if (same(got, want, tol)) { ok++; console.log(`ok    ${group}: ${name}`); }
  else { diff++; console.log(`DIFF  ${group}: ${name}\n        PC ${show(got)}  expected ${show(want)}`); }
}
function skip(group, why) {
  skipped += cases[group].length;
  console.log(`skip  ${group} (${cases[group].length} cases; no PC function: ${why})`);
}
async function run(group, fn, tol) {
  for (const c of cases[group]) {
    let got;
    try { got = await fn(c); } catch (e) { got = 'threw ' + (e && e.message); }
    report(group, c.name, got, c.expect, tol);
  }
}

// ── frames ──
const { W, H } = V;
function frameOf(s) {
  if ('flat' in s) return new Array(W * H).fill(s.flat);
  if ('cols' in s) { const f = new Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = s.cols[x]; return f; }
  const [l, t, r, b] = s.bars || [0, 0, 0, 0], f = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bar = y < t || y >= H - b || x < l || x >= W - r;
    f[y * W + x] = bar ? s.barValue : 60 + (x * 37 + y * 11 + s.texture * 53) % 120;
  }
  return f;
}
function timed(spec) {
  const frames = [], times = [];
  for (const [n, fr] of spec.runs) for (let k = 0; k < n; k++) {
    const i = frames.length;
    frames.push(frameOf(fr));
    times.push(spec.fps30 ? Math.trunc(i * 1000 / 30) : i * spec.everyMs);
  }
  return { frames, times };
}

// ── groups ──
skip('sourceOrder', 'the order is an async loop in content.js handleTrackChange (VP.canvasOrder, tried strictly in turn); needs a pure pick(sources, order, enabled, pending, failed) like Metrolist selectAnimatedCoverUrl');
skip('cache', 'video-canvas-page.js lookup() reads IndexedDB and bg-canvas.js keeps misses inline in find(); needs a pure lookup(value, fileExists, now) and keyOf(source, song)');

// Apple scoring: one hit with inline motion art and an album id; taken = what searchAndFetchMotion returns
await run('appleScore', async (c) => {
  apCtx.__setSearch({ results: { songs: { data: [{
    id: 'h', type: 'songs', attributes: { ...c.hit, editorialVideo: { motionDetailSquare: { video: 'https://example.invalid/sq.m3u8' } } },
    relationships: { albums: { data: [{ id: '1' }] } },
  }] } } });
  const m = await apCtx.searchAndFetchMotion(c.want.title, c.want.artist, c.want.album, 'us', 'songs');
  return { score: c.expect.score, taken: !!m };   // the PC keeps its scores inside; only "taken" is compared
});
await run('appleRank', async (c) => {
  apCtx.__setSearch({ results: { songs: { data: c.hits.map((h) => ({
    id: h.id, type: 'songs',
    attributes: { name: h.name, artistName: h.artistName, albumName: h.albumName, ...(h.motion ? { editorialVideo: { motionDetailSquare: { video: 'https://example.invalid/' + h.id + '.m3u8' } } } : {}) },
    ...(h.albumId ? { relationships: { albums: { data: [{ id: h.albumId }] } } } : {}),
  })) } } });
  const m = await apCtx.searchAndFetchMotion(c.want.title, c.want.artist, c.want.album, 'us', 'songs');
  return m ? m.animated.replace('https://example.invalid/', '').replace('.m3u8', '') : null;
});
skip('appleToken', "bg-plus.js scrapeAmpToken() fetches the bundles itself and isWebPlayerToken() is block-scoped; needs a pure pickToken(jwts, now, rejected)");
await run('appleMotion', async (c) => {
  const primary = apCtx.extractEditorialVideoUrl(c.video, false);
  if (!primary) return null;
  const tall = apCtx.extractEditorialVideoUrl(c.video, true);
  // the alternate rides along to resolveAppleCanvasDirect's answer (fallbackUrl)
  apCtx.__setSearch({ results: { songs: { data: [{ id: 'h', type: 'songs', attributes: { name: c.name, artistName: 'Artist', albumName: 'Album', editorialVideo: c.video }, relationships: { albums: { data: [{ id: '1' }] } } }] } } });
  const r = await apCtx.resolveAppleCanvasDirect({ song: c.name, artist: 'Artist', album: 'Album' }, 'us')   // one cache key per case;
  return { primary, alternate: (r && r.fallbackUrl) || null, tall: tall || null };
});

// Spotify: bg-canvas.js matches(title, artist, album, duration, foundTitle, foundArtist, foundAlbum, foundDuration, primary, foundPrimary)
await run('spotifyMatch', (c) => {
  const i = c.input;
  return SP.matches(i.title, i.artist, i.album, i.durationMs, i.foundTitle, i.foundArtist, i.foundAlbum, i.foundDurationMs, i.primary, i.foundPrimary);
});
await run('spotifyMedia', (c) => SP.trusted(c.url));
await run('spotifyTotp', (c) => SP.totp(c.nowMs));

// music video: findVideo takes what pick() takes from the search results [id, title, channel, durationSec]
await run('videoMatch', (c) => {
  const names = V.artists(c.song.artists.map((a) => a.name).join(' & '));
  const v = V.pick(c.song.title, names, c.song.durationSec, c.videos.map((x) => [x.id, x.title, x.artists[0].name, x.durationSec]));
  return v ? v[0] : null;
});

// the part: partStart(heat [start s, length s, intensity] per marker, duration s or 0) in seconds, or null
await run('bestPart', (c) => {
  const heat = [];
  c.intensity.forEach((v, i) => heat.push(i * c.segmentMs / 1000, c.segmentMs / 1000, v));
  const s = V.partStart(heat, c.durationMs / 1000);
  return s == null ? null : Math.round(s * 1000);
}, 0.5);
// no frames: noFrames(lengthMs) gives the loop's [start, end] (the curve is not used)
await run('noFrames', (c) => V.noFrames(c.lengthMs));

// ClipJudge
await run('bars', (c) => V.bars(c.frames.map(frameOf)).map((x) => Math.round(x * 1e6) / 1e6));
await run('still', (c) => V.still(c.frames.map(frameOf), c.bars));
await run('windows', (c) => V.windows(c.frames.map(frameOf), c.intervalMs, c.lengthMs, [0, 0, 0, 0]), 1e-9);
await run('choose', (c) => {
  const w = V.choose(c.windows, c.lengthMs, c.peakMs, c.chorusMs);
  return w ? w[0] : null;
});
await run('cropX', (c) => V.cropX(c.frames.map(frameOf), [0, 0, 0, 0]), 1e-6);
await run('loopEnd', (c) => {
  const { frames, times } = timed(c.frames);
  const e = V.end(frames, times, c.framesEndMs);
  return e < 0 ? { flashing: true } : { endMs: e, flashing: false };
});
// the whole first look, as clip() runs it: judge() (bars, still, windows, choose, crop); null is a still upload
await run('judge', (c) => {
  const j = V.judge(c.frames.map(frameOf), c.intervalMs, c.lengthMs, c.peakMs, c.chorusMs);
  return j ? { startMs: j.startMs, endMs: j.endMs } : 'still';
});

skip('display', 'video-canvas.js zoomBars() is inside its IIFE and there is no tall-clip test or clip fade; needs pure tallClip(w, h), letterboxZoom(px, w, h), clipFade(hero, bottom)');
skip('backdrop', 'the PC has neither backdrop (no Metrolist bleed, no BitChord mesh); needs blurRadiusAt(row), bleedRows(width, artHeight), coverZoom(...), stripRows(h), meshLift(rgb)');
// §5 rules 7-11: the title gate, and the find order on a fake network (Prism's ClipFinderTest FakeNet)
await run('titleGate', (c) => V.titleSays(c.input.songTitle, c.input.videoTitle));
await run('clipFind', async (c) => {
  const { song, first, videos, others } = c.input;
  let otherSearches = 0;
  const net = {
    findVideo: async () => first,
    otherVideos: async () => { otherSearches++; return others; },
    tryVideo: async (id, own) => {
      const v = videos[id];
      if (!own && v.type !== 'MUSIC_VIDEO_TYPE_OMV') return { why: 'NOT_OFFICIAL' };
      if (!own && V.titleSays(song.title, v.title)) return { why: 'TITLE' };
      if (v.status !== 'OK') return { why: 'RESTRICTED' };
      if (v.still) return { why: 'STILL' };
      return { ok: true, id };
    },
  };
  const r = await V.findOn(net, song);
  return { videoId: r.ok ? r.id : null, why: r.ok ? null : r.why, otherSearches };
});
// §14: the best part's snap and its button
await run('snap', (c) => V.snap(c.input.targetMs, c.input.lineStarts, c.input.tempo));
await run('bestPartButton', (c) => V.bestPartShows(c.input.atMs, c.input.startMs, c.input.knownAtMs));
// the chorus from synced lyrics (§6 rule 11)
await run('chorus', (c) => V.chorusMs(c.input.lines, c.input.durationMs));
// the stored source order and sources on, and Apple's variant pick (src/plus/canvas-settings.js)
await run('settings', (c) => c.kind === 'settingsOrder' ? CS.parseOrder(c.input.stored)
  : c.kind === 'settingsEnabled' ? CS.parseEnabled(c.input.stored)
  : CS.pickVariant(c.input.variants, c.input.cap));
skip('badge', 'the shimmer is CSS only (plus.css:467-482); needs bandCentre(progress, width) and chromeWhite(alpha) if the PC adopts the chrome');

console.log(`\ncanvas cases: ${ok} ok, ${diff} DIFF, ${skipped} skipped`);
process.exit(diff ? 1 : 0);

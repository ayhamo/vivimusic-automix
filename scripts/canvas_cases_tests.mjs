// The shared canvas cases (spec/canvas/canvas-cases.json) against the PC's code:
//   src/plus/video-canvas-page.js  (its pure core, globalThis.__viviVideoCanvasCore)
//   src/plus/canvas-settings.js    (parseOrder, parseEnabled, pickVariant)
//   src/plus/bg-canvas.js          (viviSpotifyCanvas: totp, matches, trusted, canvasOf)
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
// (bg-plus.js's time-limited fetch, defined above the Apple block: the context's fetch as the cases set it)
apCtx.plusFetch = (u, i) => apCtx.fetch(u, i);
// bg-plus.js's capped body read, as written (the cases' stand-in answers have no stream: read plainly)
const plusReadSrc = (() => {
  const s = readFileSync(new URL('src/plus/bg-plus.js', root), 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('const PLUS_JSON_MAX'), b = s.indexOf('\n}\n', s.indexOf('async function plusRead('));
  if (a < 0 || b < 0) throw new Error("bg-plus.js: plusRead's markers moved");
  return s.slice(a, b + 2);
})();
vm.createContext(apCtx);
vm.runInContext(plusReadSrc, apCtx);
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
const seen = new Set();   // the groups run or skipped: one the cases add and this file doesn't know fails
function skip(group, why) {
  seen.add(group);
  skipped += cases[group].length;
  console.log(`skip  ${group} (${cases[group].length} cases; no PC function: ${why})`);
}
async function run(group, fn, tol) {
  seen.add(group);
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
// The token pick through bg-plus.js's real scrape, on a fake music.apple.com: each token in its own
// bundle, so a web player token in a later bundle than an unlabelled one must still win (audit
// 2026-11-24). A fresh context per case (the 30 min wait and the rejected set are block state).
// Made-up JWTs with a fake signature; a "rejected" token gets a 401 from the catalog API.
function appleTokenCtx(nowMs, bundles, rejectedJwts = []) {
  const ctx = {
    chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } },
    TextEncoder, TextDecoder, URL, atob, btoa, Intl, navigator: { language: 'en-US' },
    console: { log() {}, info() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {},
    fetchLog: [],
    fetch: async (url, opts) => {
      const u = String(url);
      ctx.fetchLog.push(u);
      if (u.endsWith('/us/browse')) return { text: async () => bundles.map((_, i) => `<script src="/assets/index-b${i}.js">`).join('') };
      const m = u.match(/\/assets\/index-b(\d+)\.js$/);
      if (m) { const b = bundles[+m[1]]; if (b === null) throw new Error('bundle read failed'); return { text: async () => `var t="${b}";` }; }
      const auth = (opts && opts.headers && opts.headers.Authorization) || '';
      const bad = rejectedJwts.some((j) => auth === 'Bearer ' + j);
      return { status: bad ? 401 : 200, ok: !bad, json: async () => ({}) };
    },
  };
  ctx.plusFetch = (u, i) => ctx.fetch(u, i);   // (bg-plus.js's time-limited fetch)
  vm.createContext(ctx);
  vm.runInContext(plusReadSrc, ctx);
  vm.runInContext(readFileSync(new URL('src/apple-canvas.js', root), 'utf8'), ctx);
  const lines = readFileSync(new URL('src/plus/bg-plus.js', root), 'utf8').split(/\r?\n/);
  const a = lines.findIndex((l) => l.startsWith('// ── apple-canvas.js (ported'));
  let b = a;
  while (lines[b] !== '}') b++;
  vm.runInContext(lines.slice(a, b + 1).join('\n'), ctx);
  vm.runInContext(`Date.now = () => ${nowMs};`, ctx);
  return ctx;
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
await run('appleToken', async (c) => {
  const jwts = c.tokens.map((t, i) => `${b64u(t.header)}.${b64u(t.payload)}.fakeSig${i}`);
  const rejected = (c.rejected || []).map((i) => jwts[i]);
  const ctx = appleTokenCtx(c.now, jwts, rejected);
  let got;
  if (rejected.length) { await ctx.ampGet('/v1/test', {}); got = vm.runInContext('cachedAmpToken', ctx); }
  else got = await ctx.getOrFetchAmpToken();
  return got ? jwts.indexOf(got) : null;
});
{
  // a bundle that fails to read is passed over, the next one is still read, and no 30 min wait is set
  const now = 1763400000000;
  const own = `${b64u({ alg: 'ES256', kid: 'WebPlayKid' })}.${b64u({ iss: 'AMPWebPlay', exp: 1863400000 })}.fakeSigOwn`;
  const ctx = appleTokenCtx(now, [null, own]);
  const got = await ctx.getOrFetchAmpToken();
  vm.runInContext('cachedAmpToken = null; ampTokenExpiryMs = 0;', ctx);
  ctx.fetchLog.length = 0;
  await ctx.getOrFetchAmpToken();
  report('appleToken', 'a failed bundle read: the next bundle is read, and no 30 min wait', { got: got === own, rescraped: ctx.fetchLog.length > 0 }, { got: true, rescraped: true });
}
await run('appleMotion', async (c) => {
  const primary = apCtx.extractEditorialVideoUrl(c.video, false);
  if (!primary) return null;
  const tall = apCtx.extractEditorialVideoUrl(c.video, true);
  // the alternate rides along to resolveAppleCanvasDirect's answer (fallbackUrl); it takes only Apple's
  // own https hosts, so the cases' file names are put on one there and taken off again
  const CDN = 'https://mvod.itunes.apple.com/itunes-assets/';
  const onCdn = JSON.parse(JSON.stringify(c.video, (k, v) => (typeof v === 'string' && /\.m3u8$/.test(v) ? CDN + v : v)));
  apCtx.__setSearch({ results: { songs: { data: [{ id: 'h', type: 'songs', attributes: { name: c.name, artistName: 'Artist', albumName: 'Album', editorialVideo: onCdn }, relationships: { albums: { data: [{ id: '1' }] } } }] } } });
  const r = await apCtx.resolveAppleCanvasDirect({ song: c.name, artist: 'Artist', album: 'Album' }, 'us')   // one cache key per case;
  return { primary, alternate: (r && r.fallbackUrl && r.fallbackUrl.replace(CDN, '')) || null, tall: tall || null };
});
{
  // (phone F5-3) a motion link off Apple's https hosts is not played: the trusted alternate instead, else none
  const ask = async (name, video) => {
    apCtx.__setSearch({ results: { songs: { data: [{ id: 'h', type: 'songs', attributes: { name, artistName: 'Artist', albumName: 'Album', editorialVideo: video } }] } } });
    return apCtx.resolveAppleCanvasDirect({ song: name, artist: 'Artist', album: 'Album' }, 'us');
  };
  const good = 'https://mvod.itunes.apple.com/a/raw.m3u8';
  const r1 = await ask('Untrusted square', { motionDetailSquare: { video: 'https://evil.example/sq.m3u8' }, motionDetailRaw: { video: good } });
  const r2 = await ask('Plain http square', { motionDetailSquare: { video: 'http://mvod.itunes.apple.com/sq.m3u8' } });
  report('appleMotion', 'an untrusted primary: the trusted alternate is played, an http one is none',
    { v1: r1 && r1.videoUrl, f1: r1 && r1.fallbackUrl, r2 }, { v1: good, f1: null, r2: null });
}

// Spotify: bg-canvas.js matches(title, artist, album, duration, foundTitle, foundArtist, foundAlbum, foundDuration, primary, foundPrimary)
await run('spotifyMatch', (c) => {
  const i = c.input;
  return SP.matches(i.title, i.artist, i.album, i.durationMs, i.foundTitle, i.foundArtist, i.foundAlbum, i.foundDurationMs, i.primary, i.foundPrimary);
});
await run('spotifyMedia', (c) => SP.trusted(c.url));
await run('spotifyTotp', (c) => SP.totp(c.nowMs));
await run('spotifyCanvas', (c) => SP.canvasOf(c.answer));

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
  const { song, first, videos, others, lyricFirst } = c.input;
  let otherSearches = 0;
  const net = {
    findVideo: async () => (lyricFirst ? Object.assign([first, ''], { lyric: true }) : first),
    otherVideos: async () => { otherSearches++; return others; },
    tryVideo: async (video, own) => {
      const id = Array.isArray(video) ? video[0] : video;
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
// §15: the song's canvas menu
await run('songMenu', (c) => CS.songMenu(c.input));
await run('songReset', (c) => CS.hasChoice(c.input.choice));
await run('pickPart', (c) => CS.pickPart(c.input.startMs, c.input.others, c.input.pickMs));
await run('videoArtists', (c) => V.artists(c.input.artist));
await run('videoChoices', (c) => V.videoChoices(c.input.pairing, c.input.found, c.input.rejected));
skip('badge', 'the shimmer is CSS only (plus.css:467-482); needs bandCentre(progress, width) and chromeWhite(alpha) if the PC adopts the chrome');

for (const g of Object.keys(cases).filter((k) => k !== 'notes' && !seen.has(k))) { diff++; console.log(`DIFF  ${g}: a group of the cases this file neither runs nor skips`); }
console.log(`\ncanvas cases: ${ok} ok, ${diff} DIFF, ${skipped} skipped`);
process.exit(diff ? 1 : 0);

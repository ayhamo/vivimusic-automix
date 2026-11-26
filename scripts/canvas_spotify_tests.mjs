// Tests for src/plus/bg-canvas.js (the phone's SpotifyCanvasTest cases): node scripts/canvas_spotify_tests.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, webcrypto } from 'node:crypto';

const chrome = { storage: { local: { get: async () => ({ viviCanvasOrderSet: true }), set: async () => {} } } };
const ctx = { chrome, crypto: webcrypto, TextEncoder, TextDecoder, URL, console: { info() {}, warn() {} }, setTimeout, clearTimeout, AbortController };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../src/plus/bg-canvas.js', import.meta.url), 'utf8') + '\nthis.c = viviSpotifyCanvas;', ctx);
const c = ctx.c;
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('FAIL', name); } };

// TOTP: six digits, the same within a 30 s step, against an independent HOTP
const t = 1_763_400_000_000;
const a = await c.totp(t);
ok(/^\d{6}$/.test(a), 'totp six digits');
ok(a === await c.totp(t - t % 30000 + 29999), 'totp same step');
const secret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
// the xor'd values joined as decimal digits, as spotlib Totp.kt (Spotify refuses the characters: HTTP 400)
const key = Buffer.from([...secret].map((ch, i) => ch.charCodeAt(0) ^ (i % 33 + 9)).join(''), 'utf8');
const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
const d = createHmac('sha1', key).update(msg).digest(); const o = d[19] & 15;
ok(a === String((d.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'), 'totp equals node HOTP');

ok(c.matches('Poker Face', 'Lady Gaga', null, 0, 'Poker Face', 'Lady Gaga', null, null, 'Lady Gaga', 'Lady Gaga'), 'match');
ok(c.matches('Midnight Sun', 'Zara Larsson & Muni Long', null, 0, 'Midnight Sun', 'Zara Larsson, Muni Long', null, null, 'Zara Larsson', 'Zara Larsson'), 'primary artist');
ok(!c.matches('Midnight Sun', 'Zara Larsson', null, 0, 'Midnight Sun', 'Nils Frahm', null, null, 'Zara Larsson', 'Nils Frahm'), 'other artist');
ok(!c.matches('Poker Face', 'Lady Gaga', null, 0, 'Poker Face - Live at the Arena', 'Lady Gaga', null, null, 'Lady Gaga', 'Lady Gaga'), 'title under 75%');
ok(c.matches('Poker Face (Official Video)', 'Lady Gaga', null, 0, 'Poker Face', 'Lady Gaga', null, null, null, null), 'noise words');
ok(!c.matches('Song', 'Artist', 'Album', 200000, 'Song', 'Artist', 'Album', 250000), 'lengths 50 s apart');
ok(c.matches('Song', 'Artist', 'One Two Three', 0, 'Song', 'Artist', null, null), 'no album on one side');

ok(c.trusted('https://canvaz.scdn.co/upload/artist/x/video/y.cnvs.mp4'), 'trusted');
ok(!c.trusted('http://canvaz.scdn.co/a.mp4'), 'http');
ok(!c.trusted('https://scdn.co.evil.com/a.mp4'), 'evil host');
ok(!c.trusted('https://user@canvaz.scdn.co/a.mp4'), 'user info');
ok(!c.trusted('https://canvaz.scdn.co:8443/a.mp4'), 'port');
ok(!c.trusted(null), 'null');

// rule 7: an answer is read up to 256 KB
const answer = (text, len) => ({ headers: { get: (h) => (h === 'content-length' && len != null ? String(len) : null) }, text: async () => text });
ok((await c.readJson(answer('{"a":1}'))).a === 1, 'small answer read');
ok(await c.readJson(answer('"' + 'x'.repeat(300 * 1024) + '"')).then(() => false, () => true), 'answer over 256 KB refused');
ok(await c.readJson(answer('{}', 300 * 1024)).then(() => false, () => true), 'Content-Length over 256 KB refused');
const streamed = (bytes) => ({ headers: { get: () => null }, body: new Response(bytes).body });
ok((await c.readJson(streamed(new TextEncoder().encode('{"b":2}')))).b === 2, 'streamed answer read');
ok(await c.readJson(streamed(new Uint8Array(300 * 1024).fill(32))).then(() => false, () => true), 'streamed answer over 256 KB refused');

// rule 6 holds for a saved canvas URL too: an untrusted one is dropped, not returned
{
  const store = { 'spotify_canvas_A—S': { videoUrl: 'https://evil.example/a.mp4' } };
  const removed = [];
  const chrome2 = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async () => {}, remove: async (k) => { removed.push(k); } } } };
  const ctx2 = { chrome: chrome2, crypto: webcrypto, TextEncoder, TextDecoder, URL, console: { info() {}, warn() {} }, setTimeout, clearTimeout, AbortController,
    fetch: async () => { throw new Error('offline'); }, getSpDc: async () => null, spotifyCanvasForTrack: async () => null };
  vm.createContext(ctx2);
  vm.runInContext(readFileSync(new URL('../src/plus/bg-canvas.js', import.meta.url), 'utf8'), ctx2);
  ok(await ctx2.spotifyCanvasForTrack({ artist: 'A', song: 'S' }) === null, 'untrusted saved canvas not returned');
  ok(removed.includes('spotify_canvas_A—S'), 'untrusted saved canvas dropped');
  store['spotify_canvas_A—S'] = { videoUrl: 'https://canvaz.scdn.co/a.mp4' };
  ok(await ctx2.spotifyCanvasForTrack({ artist: 'A', song: 'S' }) === 'https://canvaz.scdn.co/a.mp4', 'trusted saved canvas returned');
}

// the signed-in token (bg-plus.js's Sign out block): a request in flight at Sign out is neither stored nor used
{
  const lines = readFileSync(new URL('../src/plus/bg-plus.js', import.meta.url), 'utf8').split(/\r?\n/);
  const a = lines.findIndex((l) => l.startsWith('// ── Sign out and the signed-in token'));
  let b = a;
  while (b >= 0 && b < lines.length && lines[b] !== '}') b++;
  ok(a >= 0 && b < lines.length, "bg-plus.js: the Sign out block's markers");
  const ctx3 = { chrome: { storage: { local: { remove: async () => {}, set: async () => {} } } } };
  vm.createContext(ctx3);
  // upstream's getSpotifyToken, faked: stores its answer when the (held) request lands
  vm.runInContext(`var spotifyTokenCache = null, spotifyClientTokenCache = null, release;
    var getSpotifyToken = async function (spDc) {
      await new Promise((r) => { release = r; });
      spotifyTokenCache = { spDc, token: 'fake-access', expiresAt: 1 };
      return spotifyTokenCache;
    };
    var clearSpotify = null;`, ctx3);
  vm.runInContext(lines.slice(a, b + 1).join('\n'), ctx3);
  const inFlight = ctx3.getSpotifyToken('fake-sp-dc');
  await ctx3.clearSpotify();
  ctx3.release();
  ok(await inFlight.then(() => false, () => true), 'sign-out race: the in-flight token request fails');
  ok(vm.runInContext('spotifyTokenCache', ctx3) === null, 'sign-out race: the in-flight token is not stored');
  const after = ctx3.getSpotifyToken('fake-sp-dc');
  await new Promise((r) => setImmediate(r));
  ctx3.release();
  ok((await after).token === 'fake-access', 'a request begun after Sign out is kept');
}

// (audit 2026-11-26) only Spotify's sp_dc is read (§4 rule 0); every bg-plus.js request has a time limit;
// the relays cap their answers, and a request redirected onto Spotify never gets the cookie
{
  const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const plus = src('src/plus/bg-plus.js');
  const fn = plus.slice(plus.indexOf('getSpDc = async function getSpDc()'), plus.indexOf('\n};\n', plus.indexOf('getSpDc = async function getSpDc()')) + 3);
  const asked = [];
  const ctx4 = { SPOTIFY_HOME: 'https://open.spotify.com/', getSpDc: null, chrome: {
    storage: { local: { get: async () => ({}) } },
    cookies: { get: async () => null, getAll: async (q) => { asked.push(q); return [{ name: 'sp_dc', value: 'other-site', domain: 'evil.example' }, { name: 'sp_dc', value: 'spotify', domain: '.spotify.com' }]; } } } };
  vm.createContext(ctx4);
  vm.runInContext(fn, ctx4);
  ok(await ctx4.getSpDc() === 'spotify', "getSpDc: another site's sp_dc is passed over");
  ok(asked.length > 0 && asked.every((q) => q.domain === 'spotify.com'), 'getSpDc: every cookie query names Spotify\'s domain');
  ok(!/(?<![\w.])fetch\(/.test(plus.replace(/^\s*\/\/.*$/gm, '').replace('return fetch(url, { ...init, signal:', '')), 'bg-plus.js: every request through plusFetch');
  ok(/plusFetch\(SPOTIFY_SECRET_URL, \{ cache: 'no-store' \}, 8000\)/.test(plus), 'getSecretDict: 8 s');
  const fx = src('src/fx-headers.js'), bg = src('src/background.js');
  const ctx5 = { Uint8Array, Number };
  vm.createContext(ctx5);
  vm.runInContext(fx.slice(fx.indexOf('async function viviReadCapped('), fx.indexOf('\nchrome.runtime.onMessage.addListener((msg, _sender')), ctx5);
  const body = (n) => ({ headers: { get: () => null }, body: { getReader: () => { let left = 3; return { read: async () => (left-- > 0 ? { done: false, value: new Uint8Array(n) } : { done: true }), cancel: async () => {} }; } } });
  ok((await ctx5.viviReadCapped(body(4), 12)).byteLength === 12 && await ctx5.viviReadCapped(body(5), 12) === null, 'relays: an answer past the cap is refused');
  ok(/const buf = await viviReadCapped\(res, VIVI_FETCH_MAX\);/.test(fx) && /const buf = await viviReadCapped\(res, VIVI_NET_FETCH_MAX\);/.test(bg) && /const VIVI_FETCH_MAX = 10e6;/.test(fx) && /const VIVI_NET_FETCH_MAX = 64e6;/.test(fx), 'relays: 10 MB and 64 MB');
  ok(/chrome\.webRequest\.onBeforeRedirect\.addListener/.test(fx) && /\|\| viviRedirectedIn\.has\(details\.requestId\);\n\s+if \(host === 'open\.spotify\.com' && !anonymous\)/.test(fx), 'no sp_dc on a request redirected onto Spotify');
}

console.log(`canvas spotify: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

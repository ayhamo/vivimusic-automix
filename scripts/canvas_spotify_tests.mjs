// Tests for src/plus/bg-canvas.js (the phone's SpotifyCanvasTest cases): node scripts/canvas_spotify_tests.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, webcrypto } from 'node:crypto';

const chrome = { storage: { local: { get: async () => ({ viviCanvasOrderSet: true }), set: async () => {} } } };
const ctx = { chrome, crypto: webcrypto, TextEncoder, URL, console: { info() {}, warn() {} }, setTimeout, clearTimeout, AbortController };
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
const key = Buffer.from([...secret].map((ch, i) => ch.charCodeAt(0) ^ (i % 33 + 9)));
const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
const d = createHmac('sha1', key).update(msg).digest(); const o = d[19] & 15;
ok(a === String((d.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'), 'totp equals node HOTP');

ok(c.matches('Poker Face', 'Lady Gaga', 'Poker Face', 'Lady Gaga', 'Lady Gaga', 'Lady Gaga'), 'match');
ok(c.matches('Midnight Sun', 'Zara Larsson & Muni Long', 'Midnight Sun', 'Zara Larsson, Muni Long', 'Zara Larsson', 'Zara Larsson'), 'primary artist');
ok(!c.matches('Midnight Sun', 'Zara Larsson', 'Midnight Sun', 'Nils Frahm', 'Zara Larsson', 'Nils Frahm'), 'other artist');
ok(!c.matches('Poker Face', 'Lady Gaga', 'Poker Face - Live at the Arena', 'Lady Gaga', 'Lady Gaga', 'Lady Gaga'), 'title under 75%');
ok(c.matches('Poker Face (Official Video)', 'Lady Gaga', 'Poker Face', 'Lady Gaga', null, null), 'noise words');

ok(c.trusted('https://canvaz.scdn.co/upload/artist/x/video/y.cnvs.mp4'), 'trusted');
ok(!c.trusted('http://canvaz.scdn.co/a.mp4'), 'http');
ok(!c.trusted('https://scdn.co.evil.com/a.mp4'), 'evil host');
ok(!c.trusted('https://user@canvaz.scdn.co/a.mp4'), 'user info');
ok(!c.trusted('https://canvaz.scdn.co:8443/a.mp4'), 'port');
ok(!c.trusted(null), 'null');

console.log(`canvas spotify: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

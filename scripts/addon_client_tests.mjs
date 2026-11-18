// Tests for src/addons/client.js against a local mock addon server
// (spec/addons/protocol.md §1-§7). No network beyond 127.0.0.1.
//
//   node scripts/addon_client_tests.mjs        (exit 1 on a failure)
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/addons/client.js');

// ---- the mock: addons under /<name>/<token>/..., each with its own behaviour ----
const hits = [];
const behaviour = {};
const song = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200, album: 'After Hours' };
const row = (id, extra = {}) => ({ id, title: 'Blinding Lights', artist: 'The Weeknd', duration: 200, album: 'After Hours', ...extra });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, name, token, kind, id] = u.pathname.split('/');
  hits.push({ name, token, kind, id, query: u.search, ua: req.headers['user-agent'], accept: req.headers.accept, range: req.headers.range, xtoken: req.headers['x-token'], ae: req.headers['accept-encoding'] });
  const b = behaviour[name] || {};
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (kind === 'file') {   // the audio file: answers the range probe
    const size = b.fileBytes?.[id] ?? 30_000_000;
    res.writeHead(206, { 'content-range': `bytes 0-0/${size}`, 'content-length': '1' });
    return res.end('x');
  }
  const h = b[kind];
  if (typeof h === 'function') return h(u, send, id);
  if (kind === 'manifest.json') return send(200, b.manifest ?? { id: 'mock.' + name, name: 'Mock ' + name, version: '1', resources: ['search', 'stream'], settings: [] });
  return send(404, { detail: 'nope' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ROOT = `http://127.0.0.1:${server.address().port}`;
const base = (name) => `${ROOT}/${name}/tok3n-${name}`;
const fileUrl = (name, id) => `${ROOT}/${name}/tok3n-${name}/file/${id}`;

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const fresh = () => C.create({});
const hitsOf = (name, kind) => hits.filter((h) => h.name === name && (!kind || h.kind === kind));

// ---- base URL and discovery (§2) ----
check('base: final *.json dropped, token kept', C.baseOf(' https://h.example/TOKEN/manifest.json/ '), 'https://h.example/TOKEN');
check('same addon: host case-insensitive, path exact', [C.sameAddon('https://H.example/a', 'https://h.example/a/manifest.json'), C.sameAddon('https://h.example/A', 'https://h.example/a')], [true, false]);

behaviour.plain = {};
{
  const d = await fresh().discover(base('plain') + '/manifest.json');
  check('discover: a pasted manifest URL', [d.base, d.manifest.name], [base('plain'), 'Mock plain']);
  const d2 = await fresh().discover(base('plain'));
  check('discover: a bare base gets /manifest.json', d2.manifest.id, 'mock.plain');
}
behaviour.nomanifest = { 'manifest.json': (u, send) => send(404, {}), search: (u, send) => send(200, { tracks: [] }) };
check('discover: no manifest, a search answers: a stand-in manifest', (await fresh().discover(base('nomanifest'))).manifest.resources, ['search', 'stream']);
behaviour.refuses = { 'manifest.json': (u, send) => send(403, { detail: 'This app is not supported by Mock.' }) };
check('discover: a 403 says why', await fresh().discover(base('refuses')).then(() => 'found', (e) => e.message), 'refused (403): This app is not supported by Mock.');

// ---- request shape (§1) ----
behaviour.params = {
  manifest: { id: 'p', name: 'P', resources: ['search', 'stream'], settings: [
    { key: 'region', default: 'eu' }, { key: 'atmos', default: true },
    { key: 'quality', default: 'hires', options: [{ value: 'max', label: 'MAX' }, { value: 'hires', label: 'HiRes' }, { value: 'high', label: 'AAC (320kbps)' }] },
  ] },
  search: (u, send) => send(200, { tracks: [row('a')] }),
};
{
  const c = fresh();
  const man = await c.manifest(base('params'));
  await c.search({ base: base('params'), tier: 'LOSSLESS' }, song, 'Blinding Lights The Weeknd', man);
  const h = hitsOf('params', 'search').at(-1);
  check('search: settings in order, atmos=false, quality = first option, then title, artist, q', h.query, '?region=eu&atmos=false&quality=max&title=Blinding%20Lights&artist=The%20Weeknd&q=Blinding%20Lights%20The%20Weeknd');
  check("headers: no User-Agent of ours (node's own), JSON", [h.ua, h.accept], ['node', 'application/json']);
  check('quality: the user\'s lossless pick when listed', C.paramsFor(man, 'LOSSLESS', 'hires').at(-1), ['quality', 'hires']);
  check('quality: HIGH tier by label', C.paramsFor(man, 'HIGH').at(-1), ['quality', 'high']);
  check('quality: no setting: the tier name', C.paramsFor({ settings: [] }, 'LOW'), [['quality', 'LOW']]);
  const kbps = { settings: [{ key: 'quality', options: [{ value: 'LOSSLESS', label: 'FLAC' }, { value: 'HIGH', label: 'AAC 320 kbps' }, { value: 'LOW', label: 'AAC 96 kbps' }] }] };
  check('quality: Hi-Res never takes "96 kbps"', C.paramsFor(kbps, 'HIRES').at(-1), ['quality', 'LOSSLESS']);
  const tidal = { settings: [{ key: 'quality', options: [{ value: 'LOSSLESS', label: 'Lossless' }, { value: 'HI_RES_LOSSLESS', label: 'Max' }] }] };
  check('quality: Hi-Res finds HI_RES_LOSSLESS', C.paramsFor(tidal, 'HIRES').at(-1), ['quality', 'HI_RES_LOSSLESS']);
  const rate = { settings: [{ key: 'quality', options: [{ value: 'a', label: 'FLAC 44.1 kHz' }, { value: 'b', label: 'FLAC 96 kHz' }] }] };
  check('quality: Hi-Res by sample rate with its unit', C.paramsFor(rate, 'HIRES').at(-1), ['quality', 'b']);
  check('quality: CD by 44.1 kHz', C.paramsFor(rate, 'CD').at(-1), ['quality', 'a']);
}

// ---- caching and sharing (§6) ----
{
  const c = fresh();
  const man = await c.manifest(base('params'));
  const n0 = hitsOf('params', 'search').length;
  await Promise.all([1, 2, 3].map(() => c.search({ base: base('params') }, song, 'shared query', man)));
  await c.search({ base: base('params') }, song, 'shared query', man);
  check('identical searches: one request in flight, then the cache', hitsOf('params', 'search').length - n0, 1);
  const m0 = hitsOf('params', 'manifest.json').length;
  await c.manifest(base('params'));
  check('manifest: cached', hitsOf('params', 'manifest.json').length - m0, 0);
}

// ---- statuses (§5) ----
let n429 = 0;
behaviour.busy = { search: (u, send) => (++n429 <= 1 ? send(429, {}, { 'retry-after': '0.5' }) : send(200, { tracks: [row('a')] })) };
{
  const c = fresh(), man = await c.manifest(base('busy'));
  const t = Date.now();
  const rows = await c.search({ base: base('busy') }, song, 'q', man);
  check('429: waits Retry-After, then answers', [rows.length, Date.now() - t >= 450], [1, true]);
}
behaviour.flooded = { search: (u, send) => send(429, {}, { 'retry-after': '0.5' }) };
{
  const c = fresh(), man = await c.manifest(base('flooded'));
  const err = await c.search({ base: base('flooded') }, song, 'q', man).then(() => null, (e) => [e.kind, e.message]);
  check('429 three times: down', err, ['down', 'rate limited (429)']);
  check('429: two retries, three requests', hitsOf('flooded', 'search').length, 3);
}
behaviour.e404 = { search: (u, send) => send(404, {}) };
behaviour.e500 = { search: (u, send) => send(503, {}) };
behaviour.e401 = { search: (u, send) => send(401, {}) };
behaviour.blank = { search: (u, send) => send(200, '  ') };
behaviour.errfield = { search: (u, send) => send(200, { error: 'quota' }) };
for (const [name, want] of [['e404', 'miss'], ['e500', 'down'], ['e401', 'error'], ['blank', 'error'], ['errfield', 'miss']]) {
  const c = fresh(), man = await c.manifest(base(name));
  check(`search ${name}: ${want}`, await c.search({ base: base(name) }, song, 'q', man).then(() => 'ok', (e) => e.kind), want);
}

// ---- stream answers (§4) ----
{
  const c = fresh();
  const s = c.readStream({ url: 'https://cdn/x.flac', format: 'flac', quality: 'Hi-Res', codec: 'flac', container: 'flac', sampleRate: 96, bitDepth: 24 });
  check('stream: FLAC, kHz read as Hz', [s.codec, s.transport, s.tier, s.sampleRate, s.bitDepth], ['flac', 'file', 'LOSSLESS', 96000, 24]);
  check('stream: Atmos answer refused', c.readStream({ url: 'https://cdn/x.m4a', codec: 'eac3_joc', audioMode: 'DOLBY_ATMOS' }).miss, 'atmos');
  check('stream: encrypted refused', c.readStream({ url: 'https://cdn/x', encrypted: 'widevine' }).miss, 'encrypted');
  check('stream: HLS seen', c.readStream({ url: 'https://cdn/x.m3u8', format: 'aac' }).transport, 'hls');
  check('stream: bitrate in bit/s', c.readStream({ url: 'https://cdn/x.mp3', bitrate: 320000 }).bitrate, 320);
  check('stream: no url is a miss', c.readStream({ error: 'gone' }).miss, 'gone');
}

// ---- resolve: the whole path ----
behaviour.down = { 'manifest.json': (u, send) => send(500, {}) };
behaviour.good = {
  search: (u, send) => send(200, { tracks: [row('atmos', { isAtmosOnly: true }), row('cut'), row('hls'), row('atmosstream'), row('fine')] }),
  stream: (u, send, id) => {
    if (id === 'hls') return send(200, { url: 'https://cdn/x.m3u8', format: 'aac' });
    if (id === 'atmosstream') return send(200, { url: fileUrl('good', id), codec: 'eac3_joc' });
    return send(200, { url: fileUrl('good', id), format: 'flac', quality: 'Hi-Res', codec: 'flac' });
  },
  fileBytes: { cut: 700_000 },
};
{
  const c = fresh();
  const got = await c.resolve(song, [{ base: base('down') }, { base: base('good') }]);
  check('resolve: a down addon is passed over', got.tried[0].why, 'server error (500)');
  check('resolve: rows opened in order, at most 3 (atmos row skipped); the cut file refused by the probe, then HLS skipped', got.tried.slice(1).map((t) => [t.row, t.why]), [['cut', 'file holds at most 28 s'], ['hls', 'hls (not played yet)'], ['atmosstream', 'atmos']]);
  check('resolve: nothing playable in its 3 rows: none', got.none, 'no addon has it');
}
behaviour.good2 = { ...behaviour.good, search: (u, send) => send(200, { tracks: [row('atmos', { isAtmos: true }), row('fine')] }) };
{
  const logs = [];
  const c = C.create({ log: (...a) => logs.push(a.join(' ')) });
  const got = await c.resolve(song, [{ base: base('down') }, { base: base('good2') }]);
  check('resolve: the next addon has it', [got.addon?.host, got.row?.id, got.stream?.codec], [new URL(ROOT).host, 'fine', 'flac']);
  check('logs, tried and health show the host, never the token', [logs.length > 0, /tok3n/.test(logs.join() + JSON.stringify(got.tried) + JSON.stringify(c.health()))], [true, false]);
  check('scrub: a URL in an error message becomes its host', [C.scrub('fetch failed: https://h.example/tok3n-x/stream/1?q=2'), new C.AddonError('down', 'at http://127.0.0.1:9/tok3n-y/a').message], ['fetch failed: h.example', 'at 127.0.0.1:9']);
  const probe = hitsOf('good', 'file').at(-1);   // (good2's streams point at good's files)
  check('probe: Range bytes=0-0', probe.range, 'bytes=0-0');
}
{
  // health: three failures in a row put the addon to rest; the next resolve skips it
  const c = fresh();
  for (let i = 0; i < 3; i++) await c.resolve(song, [{ base: base('down') }]);
  const n = hitsOf('down').length;
  const got = await c.resolve(song, [{ base: base('down') }, { base: base('good2') }]);
  check('health: resting after 3 failures, not asked', [got.tried[0].why, hitsOf('down').length - n], ['resting after failures', 0]);
  check('health: a miss is not a failure', (() => { const h = c.health(); return Object.keys(h).length > 0; })(), true);
}
behaviour.withfallback = {
  search: (u, send) => send(200, { tracks: [row('a', { streamURL: fileUrl('withfallback', 'a') })] }),
  stream: (u, send) => send(404, {}),
};
{
  const got = await fresh().resolve(song, [{ base: base('withfallback') }]);
  check('stream 404: the row\'s streamURL', got.stream?.url, fileUrl('withfallback', 'a'));
}

// ---- §4a stream limits, the look-ahead, the stream's own headers ----
behaviour.limited = {
  search: (u, send) => send(200, { tracks: [row('a')] }),
  stream: (u, send, id) => send(200, { url: fileUrl('limited', id), format: 'flac', codec: 'flac', headers: { 'X-Token': 'abc', 'bad header': 'x', obj: {} } }),
};
{
  let T = 1_000_000;
  const c = C.create({ now: () => T });
  const man = await c.manifest(base('limited'));
  const s0 = hitsOf('limited', 'stream').length;
  const f = await c.find(song, [{ base: base('limited') }]);
  check('find: search only, no /stream call', [f.found.map((x) => x.rows.map((r) => r.id)), hitsOf('limited', 'stream').length - s0], [[['a']], 0]);
  check('find: the link stays inside (base kept for open), host shown', f.found[0].addon.host, new URL(ROOT).host);
  const got = await c.open(f.found, song);
  check('open: /stream then the probe', [got.row?.id, hitsOf('limited', 'stream').length - s0], ['a', 1]);
  check('stream headers: strings with valid names only', got.stream.headers, { 'X-Token': 'abc' });
  const probe = hitsOf('limited', 'file').at(-1);
  check('probe: the stream\'s headers, Range and Accept-Encoding: identity', [probe.range, probe.xtoken, probe.ae], ['bytes=0-0', 'abc', 'identity']);
  // 5 calls a minute by default (the first one above counts)
  const ids = ['b', 'c', 'd', 'e', 'f'];
  const out = [];
  for (const id of ids) out.push(await c.stream({ base: base('limited') }, { id }, man).then(() => 'ok', (e) => e.kind));
  check('limit: 5 /stream calls a minute, the 6th waits (kind limit)', out, ['ok', 'ok', 'ok', 'ok', 'limit']);
  check('limit: a cached answer costs nothing', await c.stream({ base: base('limited') }, { id: 'b' }, man).then(() => 'ok', (e) => e.kind), 'ok');
  check('limit: waits are reported', c.streamWait({ base: base('limited') }, man) > 0, true);
  T += 61_000;
  check('limit: a minute later, free again', await c.stream({ base: base('limited') }, { id: 'g' }, man).then(() => 'ok', (e) => e.kind), 'ok');
  check('limit: no failure noted', c.health()[new URL(ROOT).host].fails, 0);
}
let n429s = 0;
behaviour.streams429 = {
  search: (u, send) => send(200, { tracks: [row('a')] }),
  stream: (u, send, id) => (++n429s >= 3 ? send(429, {}, { 'retry-after': '30' }) : send(200, { url: fileUrl('streams429', id), codec: 'flac' })),
};
{
  let T = 2_000_000;
  const c = C.create({ now: () => T });
  const man = await c.manifest(base('streams429'));
  const r = [];
  for (const id of ['a', 'b', 'c']) r.push(await c.stream({ base: base('streams429') }, { id }, man).then(() => 'ok', (e) => e.message));
  check('429 on /stream: not retried, learnt as 2 a minute', r, ['ok', 'ok', 'stream limit (429), 2/min from now on']);
  check('429 on /stream: one request only', hitsOf('streams429', 'stream').length, 3);
  T += 31_000;
  await c.stream({ base: base('streams429') }, { id: 'd' }, man).catch(() => {});
  check('after Retry-After: the learnt 2 a minute holds', await c.stream({ base: base('streams429') }, { id: 'e' }, man).then(() => 'ok', (e) => e.kind), 'limit');
}
behaviour.ownlimits = {
  manifest: { id: 'o', name: 'O', resources: ['search', 'stream'], limits: { streamsPerMinute: 30, uncachedPerHour: 2, cachedMarker: 'fromCache' } },
  stream: (u, send, id) => send(200, { url: fileUrl('ownlimits', id), codec: 'flac', fromCache: id.startsWith('c') }),
};
{
  const c = fresh(), man = await c.manifest(base('ownlimits'));
  check('manifest limits read', man.limits, { streamsPerMinute: 30, uncachedPerHour: 2, cachedMarker: 'fromCache' });
  const r = [];
  for (const id of ['u1', 'c1', 'c2', 'u2', 'u3']) r.push(await c.stream({ base: base('ownlimits') }, { id }, man).then(() => 'ok', (e) => e.kind));
  check('uncached per hour: cached answers (the marker) don\'t count', r, ['ok', 'ok', 'ok', 'ok', 'limit']);
}
behaviour.official = { manifest: { id: 'x', name: 'X', resources: ['search', 'stream'], bitchordAuth: true } };
check('bitchordAuth: needs official BitChord, said once', await fresh().discover(base('official')).then(() => 'found', (e) => e.message), 'needs official BitChord');
{
  const c = fresh();
  const n0 = hitsOf('official').length;
  await c.resolve(song, [{ base: base('official') }]);
  const got = await c.resolve(song, [{ base: base('official') }]);
  check('bitchordAuth in resolve: skipped, not a failure, manifest cached', [got.tried[0].why, hitsOf('official').length - n0, c.health()[new URL(ROOT).host]], ['needs official BitChord', 1, undefined]);
}

server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

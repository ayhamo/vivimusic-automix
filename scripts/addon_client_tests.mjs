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
    if (b.fileFail?.[id] > 0) { b.fileFail[id]--; res.writeHead(503); return res.end(); }   // a passing server fault
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
  check('resolve: rows opened in order (atmos row skipped); the cut file refused by the probe, then the HLS row opens', [got.tried.slice(1).map((t) => [t.row, t.why]), got.row?.id, got.stream?.transport], [[['cut', 'file holds at most 28 s']], 'hls', 'hls']);
  check('resolve: an HLS row gets no range probe (a playlist\'s size says nothing of the song\'s length, §8.1.5)', hitsOf('good', 'file').map((h) => h.id), ['cut']);
}
behaviour.good3 = { ...behaviour.good, search: (u, send) => send(200, { tracks: [row('atmos', { isAtmosOnly: true }), row('cut'), row('atmosstream'), row('cut2'), row('fine')] }) };
behaviour.good.fileBytes.cut2 = 700_000;   // (good3's streams point at good's files)
{
  const c = fresh();
  const got = await c.resolve(song, [{ base: base('good3') }]);
  check('resolve: rows opened in order, at most 3: the cut files refused by the probe, the Atmos answer refused', got.tried.map((t) => [t.row, t.why]), [['cut', 'file holds at most 28 s'], ['atmosstream', 'atmos'], ['cut2', 'file holds at most 28 s']]);
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
// (audit 2026-11-24) §4: a 200 whose answer has an `error` or a blank url falls back the same way
behaviour.errfallback = {
  search: (u, send) => send(200, { tracks: [row('e', { streamURL: fileUrl('errfallback', 'e') }), row('b', { streamURL: fileUrl('errfallback', 'b') })] }),
  stream: (u, send, id) => send(200, id === 'e' ? { error: 'not on this service' } : { url: '  ' }),
};
{
  const c = fresh(), man = await c.manifest(base('errfallback'));
  const e = await c.stream({ base: base('errfallback') }, { id: 'e', streamURL: fileUrl('errfallback', 'e') }, man);
  const b = await c.stream({ base: base('errfallback') }, { id: 'b', streamURL: fileUrl('errfallback', 'b') }, man);
  check('stream 200 with an error field or a blank url: the row\'s streamURL', [e.url, b.url], [fileUrl('errfallback', 'e'), fileUrl('errfallback', 'b')]);
  const bad = await c.stream({ base: base('errfallback') }, { id: 'x', streamURL: 'http://evil.example/f.flac' }, man);
  check('stream fallback: the streamURL still answers to the https rule', bad.miss, 'not https');
}
// (audit 2026-11-24) §6: a /stream miss (an error answer, no streamURL) is not cached: asked again
behaviour.misscache = { stream: (u, send) => send(200, { error: 'not yet' }) };
{
  const c = fresh(), man = await c.manifest(base('misscache'));
  const n0 = hitsOf('misscache', 'stream').length;
  const a = await c.stream({ base: base('misscache') }, { id: 'm' }, man);
  const b = await c.stream({ base: base('misscache') }, { id: 'm' }, man);
  check('stream miss: not cached, the second ask goes to the addon', [a.miss, b.miss, hitsOf('misscache', 'stream').length - n0], ['not yet', 'not yet', 2]);
}

// ---- §8.1.4 the race: every addon at once, the first playable answer wins ----
// a server fault on the probe is read once more before the row counts as refused (BitChord: retry a failed window read once)
behaviour.flaky = { fileFail: { once: 1, twice: 2 } };
{
  const c = fresh();
  const once = await c.probe(fileUrl('flaky', 'once'), row('once'), 200, 5);
  check('probe: one 503, then the file: not refused, read twice', [once.ok, hitsOf('flaky', 'file').filter((h) => h.id === 'once').length], [true, 2]);
  const twice = await c.probe(fileUrl('flaky', 'twice'), row('twice'), 200, 5);
  check('probe: 503 twice: refused, read twice (no third ask)', [twice.ok, twice.why, hitsOf('flaky', 'file').filter((h) => h.id === 'twice').length], [false, 'stream answered 503', 2]);
}

const later = (ms, f) => (...a) => setTimeout(() => f(...a), ms);
const raceAddon = (name, { searchMs = 0, streamMs = 0, rows = [row('r1')] } = {}) => {
  behaviour[name] = {
    search: later(searchMs, (u, send) => send(200, { tracks: rows })),
    stream: later(streamMs, (u, send, id) => send(200, { url: fileUrl(name, id), format: 'flac', codec: 'flac' })),
  };
  return { base: base(name) };
};
{
  const slow = raceAddon('raceslow', { streamMs: 900 }), fast = raceAddon('racefast');
  const t = Date.now();
  const got = await fresh().resolve(song, [slow, fast]);
  check('race: a slow first addon loses to a fast second one, without waiting for it', [got.stream?.url, Date.now() - t < 800], [fileUrl('racefast', 'r1'), true]);
}
{
  // ready together: a tie window long enough for both local answers
  const a = raceAddon('racetieA', { streamMs: 30 }), b = raceAddon('racetieB');
  const c = C.create({ sleep: (ms) => new Promise((r) => setTimeout(r, ms || 300)) });
  const got = await c.resolve(song, [a, b]);
  check('race: answers ready together go to the higher-ranked addon', got.stream?.url, fileUrl('racetieA', 'r1'));
}
{
  const a = raceAddon('raceparA', { searchMs: 400 }), b = raceAddon('raceparB', { searchMs: 400 });
  const t = Date.now();
  const f = await fresh().find(song, [a, b]);
  check('race: the searches run at once (two 400 ms searches in under 750 ms)', [f.found.length, Date.now() - t < 750], [2, true]);
}
{
  const a = raceAddon('raceordA', { searchMs: 300 }), b = raceAddon('raceordB');
  const f = await fresh().find(song, [a, b]);
  check('race: find lists the addons in priority order, the first answering last', f.found.map((x) => x.addon.base), [base('raceordA'), base('raceordB')]);
}
{
  // once one addon wins, a loser still searching never sends its /stream (it would add the song to the debrid account)
  const slow = raceAddon('racelateA', { searchMs: 300 }), fast = raceAddon('racelateB');
  let calls = 0;
  const st = behaviour.racelateA.stream;
  behaviour.racelateA.stream = (...a) => { calls++; return st(...a); };
  const got = await fresh().resolve(song, [slow, fast]);
  await new Promise((r) => setTimeout(r, 500));
  check('race: the losers stop: no /stream from an addon still searching when one won', [got.stream?.url, calls], [fileUrl('racelateB', 'r1'), 0]);
}
{
  const none1 = raceAddon('racenoneA', { searchMs: 200, rows: [] }), none2 = raceAddon('racenoneB', { rows: [row('x', { title: 'Something Else', artist: 'Nobody' })] });
  const got = await fresh().resolve(song, [none1, none2]);
  check('race: no addon has it: every miss, in rank order', [got.none, got.tried.map((x) => x.why)], ['no addon has it', ['no match', 'no match']]);
}

{
  // an addon at its per-minute limit: its lane asks nothing, the other addon plays (§4a, §8.1.4)
  const full = raceAddon('racefull', { rows: [row('g1')] }), other = raceAddon('raceother', { streamMs: 50 });
  const c = fresh();
  const man = await c.manifest(full.base);
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) await c.stream(full, { id }, man);
  const n0 = hitsOf('racefull', 'stream').length;
  const got = await c.resolve(song, [full, other]);
  check('race: an addon at its limit makes no /stream call, the other one plays', [hitsOf('racefull', 'stream').length - n0, got.stream?.url, got.tried[0].why.startsWith('stream limit')], [0, fileUrl('raceother', 'r1'), true]);
}
{
  // 8.2.1 in the race: a lossy answer under the floor doesn't win; the next row, or another addon, does
  const P = require('../src/addons/pick.js');
  behaviour.floorlossy = {
    search: (u, send) => send(200, { tracks: [row('mp3'), row('flac')] }),
    stream: (u, send, id) => send(200, id === 'mp3' ? { url: fileUrl('floorlossy', id), codec: 'mp3', bitrate: 192000 } : { url: fileUrl('floorlossy', id), codec: 'flac', format: 'flac' }),
  };
  const got = await fresh().resolve(song, [{ base: base('floorlossy') }], { accept: (s) => P.floorVerdict(s, 160) });
  check('floor: a 192 kbps row refused, the FLAC row after it opens', [got.row?.id, got.tried.map((t) => [t.row, t.why])], ['flac', [['mp3', "lossy 192 kbps, not 96 kbps over YouTube's 160"]]]);
  const top = raceAddon('floortop', { rows: [row('t1')] });
  behaviour.floortop.stream = (u, send, id) => send(200, { url: fileUrl('floortop', id), codec: 'aac', bitrate: 128000 });
  const second = raceAddon('floorsecond', { streamMs: 40 });
  const g2 = await fresh().resolve(song, [top, second], { accept: (s) => P.floorVerdict(s, 160) });
  check('floor in the race: a fast lossy top addon loses to a lossless second one', g2.stream?.url, fileUrl('floorsecond', 'r1'));
}
{
  // 8.1.7 "Upgrade quality": the song's search and /stream answers forgotten, others kept
  const a = raceAddon('forgetme');
  const c = fresh();
  const other = { ...song, title: 'Other Song' };
  const f1 = await c.find(song, [a]); await c.open(f1.found, song);
  await c.find(other, [a]);
  const s0 = hitsOf('forgetme', 'search').length, t0 = hitsOf('forgetme', 'stream').length;
  const n = c.forget(song, f1.found);
  const f2 = await c.find(song, [a]); await c.open(f2.found, song);
  await c.find(other, [a]);
  check('forget: the song asked again (search and /stream), another song still cached', [n >= 2, hitsOf('forgetme', 'search').length - s0, hitsOf('forgetme', 'stream').length - t0], [true, 1, 1]);
}
{
  // (audit 2026-11-24) forget matches whole parameters: forgetting "Blinding" keeps "Blinding Lights"
  const a = raceAddon('forgetword');
  const c = fresh();
  await c.find(song, [a]);
  const s0 = hitsOf('forgetword', 'search').length;
  c.forget({ ...song, title: 'Blinding' });
  await c.find(song, [a]);
  check('forget: a title that only starts the same is kept', hitsOf('forgetword', 'search').length - s0, 0);
}
{
  // §3: title and artist sent trimmed; the opened addon keeps its quality pick (the cache key, 8.1.6)
  const a = { ...raceAddon('trimq'), quality: 'HI_RES' };
  const c = fresh();
  const f = await c.find({ ...song, title: '  Blinding Lights ', artist: ' The Weeknd ' }, [a]);
  const q = new URLSearchParams(hitsOf('trimq', 'search').at(-1)?.query || '');
  const got = await c.open(f.found, song);
  check('search: title and artist trimmed; open keeps the addon\'s quality', [q.get('title'), q.get('artist'), got.addon?.quality], ['Blinding Lights', 'The Weeknd', 'HI_RES']);
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
// (audit 2026-11-24) §4a: the budget is the addon's, on baseOf(link): a trailing '/' is the same addon
behaviour.slashlimit = { manifest: { id: 's', name: 'S', resources: ['search', 'stream'], limits: { streamsPerMinute: 1 } }, stream: (u, send, id) => send(200, { url: fileUrl('slashlimit', id), codec: 'flac' }) };
{
  const c = fresh(), man = await c.manifest(base('slashlimit'));
  const first = await c.stream({ base: base('slashlimit') + '/' }, { id: 'a' }, man).then(() => 'ok', (e) => e.kind);
  const second = await c.stream({ base: base('slashlimit') }, { id: 'b' }, man).then(() => 'ok', (e) => e.kind);
  check('limit: counted on the addon\'s base, a trailing / is the same addon', [first, second, c.streamWait({ base: base('slashlimit') }, man) > 0], ['ok', 'limit', true]);
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

{
  // (audit 2026-11-26) a remote addon may not send the background off https or to this machine, by a link
  // or by a redirect (checked on the answer's final URL: an extension's fetch can't read a redirect's Location)
  check('offLimits: http, this machine over https too, and a local addon\'s own http', [C.offLimits('https://a.example/t', 'http://a.example/f'), C.offLimits('https://a.example/t', 'https://127.0.0.1/f'), C.offLimits('https://a.example/t', 'https://[::1]:8080/f'),
    C.offLimits('https://a.example/t', 'https://cdn.example/f'), C.offLimits('http://127.0.0.1:9/m/t', 'http://127.0.0.1:9/m/t/file/1')], ['not https', 'points at this machine', 'points at this machine', null, null]);
  // (audit 2026-11-26 step 2, the phone's F5-2 untrusted hosts) every other spelling of this machine too
  const spellings = ['https://127.0.0.2/f', 'https://127.1/f', 'https://2130706433/f', 'https://0x7f.1/f', 'https://0.0.0.0/f', 'https://LOCALHOST./f', 'https://a.localhost/f', 'https://[::]/f', 'https://[::ffff:127.0.0.1]/f', 'https://[0:0:0:0:0:0:0:1]/f'];
  check('offLimits: every spelling of this machine; a host that only starts like one is not', [...spellings.map((u) => C.offLimits('https://a.example/t', u)), C.offLimits('https://a.example/t', 'https://127.0.0.1.cdn.example/f'), C.offLimits('https://a.example/t', 'https://localhost.example/f')],
    [...spellings.map(() => 'points at this machine'), null, null]);
  const answer = (url, status = 200, body = '{"id":"m","name":"M","version":"1","resources":["search","stream"]}') => ({ url, status, headers: { get: () => null }, body: null, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
  const to = (final) => C.create({ fetch: async () => answer(final) });
  check('a manifest redirected to this machine or off https: refused, nothing of it read', [await to('http://127.0.0.1:8080/admin').discover('https://a.example/tok').then(() => 'found', (e) => e.message),
    await to('http://a.example/tok/manifest.json').discover('https://a.example/tok').then(() => 'found', (e) => e.message),
    await to('https://a.example/tok/manifest.json').discover('https://a.example/tok').then(() => 'found', (e) => e.message)], ['redirected: not https', 'redirected: not https', 'found']);
  const pc = C.create({ fetch: async () => ({ ...answer('https://localhost/x', 206), headers: { get: (h) => ({ 'content-range': 'bytes 0-0/30000000' })[h] ?? null } }) });
  check('the range probe redirected to this machine: refused', await pc.probe('https://cdn.example/f', { id: 'r', duration: 200 }, 200, 5, {}, 'https://a.example/tok'), { ok: false, why: 'stream redirected: points at this machine' });
  // a refusal's detail: read capped while the timeout runs (it was read after, uncapped)
  const four = C.create({ fetch: async (u) => answer(u, 403, JSON.stringify({ detail: 'x'.repeat(30000) })) });
  check('a 403 with a body past 16 KB: refused, no detail', await four.discover('https://a.example/tok').then(() => 'found', (e) => e.message), 'refused (403)');
  // two addons on one host: each its own health (§2)
  const hc = fresh();
  behaviour.hA = { search: (u, send) => send(500, {}) };
  await hc.find(song, [{ base: base('hA'), id: 'x' }, { base: base('hB'), id: 'y' }]).catch(() => null);
  check('healthFor: by the addon\'s base, two on one host apart', [hc.healthFor(base('hA'))?.fails > 0, hc.healthFor(base('hB'))?.fails], [true, 0]);
}

{
  // a transport other than a file, HLS or DASH is passed over before any probe or fetch (§8.1.5)
  const src = (await import('node:fs')).readFileSync(new URL('../src/addons/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  check('an unknown transport: passed over, named', /if \(!\['file', 'hls', 'dash'\]\.includes\(s\.transport\)\) \{ tried\.push\([^\n]*not played here[^\n]*continue; \}/.test(src), true);
}

{
  // the phone's B2-04 (cross-check 2026-11-27): in Firefox each redirect hop of an addon request is checked
  // before it is sent (fx-headers.js, blocking webRequest); a hop off https or to this machine is cancelled
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const L = {};
  const on = (name) => ({ addListener: (f, filter, opts) => { (L[name] ||= []).push({ f, filter, opts }); } });
  const ctx = vm.createContext({ chrome: { runtime: { getURL: () => 'moz-extension://abc/', onMessage: on('msg'), getPlatformInfo: () => Promise.resolve({}) }, storage: { local: { get: async () => ({}) } }, cookies: { get: async () => null }, webRequest: { onBeforeRedirect: on('redirect'), onCompleted: on('done'), onErrorOccurred: on('err'), onBeforeSendHeaders: on('send'), onBeforeRequest: on('req'), onHeadersReceived: on('hdr') } }, console: { debug() {} }, URL });
  vm.runInContext(readFileSync(new URL('../src/fx-headers.js', import.meta.url), 'utf8'), ctx);
  const guard = L.send.find((l) => l.opts?.includes('blocking') && l.filter.urls.includes('<all_urls>'));
  const base = 'https://addon.example/TOKEN', ours = { originUrl: 'moz-extension://abc/background.html' };
  const hop = (requestId, url, first) => { L.req[0].f({ ...ours, requestId, url: first }); return [guard.f({ ...ours, requestId, url: first }), guard.f({ ...ours, requestId, url })]; };
  const release = ctx.__viviHopWatch.add('https://cdn.example/a.flac', base, C.offLimits);
  check('a hop to plain http is cancelled before it is sent', hop('1', 'http://cdn2.example/a.flac', 'https://cdn.example/a.flac'), [{}, { cancel: true }]);
  check('a hop to this machine is cancelled', hop('2', 'https://127.0.0.1/x', 'https://cdn.example/a.flac'), [{}, { cancel: true }]);
  check('a hop to another https host goes on (with the addon\'s headers)', hop('3', 'https://cdn2.example/a.flac', 'https://cdn.example/a.flac'), [{}, {}]);
  release();
  check('a request not registered is never touched', hop('4', 'http://x.example/', 'https://other.example/'), [{}, {}]);
  // guarded(): registers the URL for the fetch's length only
  const seen = [];
  ctx.__viviHopWatch.add = (url, b) => { seen.push(['add', url, b]); return () => seen.push(['release', url]); };
  globalThis.__viviHopWatch = ctx.__viviHopWatch;
  await C.guarded(async () => ({ ok: true }), base)('https://cdn.example/b.flac', {});
  delete globalThis.__viviHopWatch;
  check('guarded(): the URL registered with its base, released after the answer', seen, [['add', 'https://cdn.example/b.flac', base], ['release', 'https://cdn.example/b.flac']]);
}

server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

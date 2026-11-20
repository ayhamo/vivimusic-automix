// Tests for src/addons/file-cache.js and its use in bg-addons.js: the persistent addon cache
// (spec/addons/protocol.md §8.1.6). A fake Cache API store and storage; no network.
//
//   node scripts/addon_file_cache_tests.mjs        (exit 1 on a failure)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FC = require('../src/addons/file-cache.js');
const A = require('../src/addons/bg-addons.js');

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
function fakeStorage(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  return { data, get: async (d) => ({ ...d, ...JSON.parse(JSON.stringify(data)) }), set: async (p) => { Object.assign(data, JSON.parse(JSON.stringify(p))); } };
}
function fakeCache() {
  const m = new Map();
  return { m, match: async (u) => (m.has(u) ? new Response(m.get(u)) : undefined), put: async (u, r) => { m.set(u, await r.arrayBuffer()); }, delete: async (u) => m.delete(u) };
}
const bytes = (n, v = 1) => new Uint8Array(n).fill(v).buffer;
let T = 1000;
const cacheWith = (maxBytes, st = fakeStorage(), c = fakeCache()) => ({ st, c, F: FC.create({ open: () => c, storage: st, maxBytes: async () => maxBytes, now: () => ++T }) });

{
  const { F } = cacheWith(3000);
  const k = F.keyOf('addonA', 'tidal:track:1', 'LOSSLESS');
  check('key: addon id, row and quality', k, 'addonA|tidal:track:1|LOSSLESS');
  check('put then get: the bytes and the meta back', [await F.put(k, bytes(1000, 7), { mime: 'audio/flac' }), new Uint8Array((await F.get(k)).bytes)[999], (await F.get(k)).meta.mime], [true, 7, 'audio/flac']);
  check('has: the meta without a file read', (await F.has(k)).mime, 'audio/flac');
  check('has: another quality is another file', await F.has(F.keyOf('addonA', 'tidal:track:1', 'HIGH')), null);
}
{
  const { F, c } = cacheWith(3000);
  for (const k of ['a', 'b', 'c']) await F.put(k, bytes(1000));
  await F.get('a');   // played again: now the newest
  await F.put('d', bytes(1000));
  check('least recently played dropped first', [await F.has('a') !== null, await F.has('b'), await F.has('c') !== null, await F.has('d') !== null, c.m.size], [true, null, true, true, 3]);
  check('stats', await F.stats(), { files: 3, bytes: 3000 });
}
{
  const { F } = cacheWith(3000);
  check('a file over the size is not kept', [await F.put('big', bytes(3001)), await F.has('big')], [false, null]);
  const off = cacheWith(0).F;
  check('size 0: nothing kept, nothing found', [await off.put('x', bytes(10)), await off.has('x'), await off.get('x')], [false, null, null]);
}
{
  const { F, c, st } = cacheWith(3000);
  await F.put('gone', bytes(100), { mime: 'audio/flac' });
  c.m.clear();   // the browser cleared its storage
  check('a file the browser let go: none, and out of the index', [await F.get('gone'), Object.keys(st.data[FC.INDEX])], [null, []]);
}
{
  let max = 3000;
  const st = fakeStorage(), c = fakeCache();
  const F = FC.create({ open: () => c, storage: st, maxBytes: async () => max, now: () => ++T });
  for (const k of ['a', 'b', 'c']) await F.put(k, bytes(1000));
  max = 1500; await F.trim();
  check('trim: a smaller size drops the oldest', [await F.has('a'), await F.has('b'), await F.has('c') !== null, c.m.size], [null, null, true, 1]);
  await F.clear();
  check('clear', [await F.stats(), c.m.size], [{ files: 0, bytes: 0 }, 0]);
}

// ---- in the store: OPEN reads the cache before any /stream call, FETCH fills it ----
{
  const st = fakeStorage({ addonsEnabled: true, addonsList: [{ id: 'idA', base: 'https://a.example/SECRET-A', name: 'A', host: 'a.example' }, { id: 'idB', base: 'https://b.example/SECRET-B', name: 'B', host: 'b.example' }] });
  const c = fakeCache();
  const files = FC.create({ open: () => c, storage: st, maxBytes: async () => (await st.get({ addonsCacheMB: 512 })).addonsCacheMB * 1e6, now: () => ++T });
  let opens = 0, fetched = 0, rowsOf = { idA: [{ id: 'a1' }], idB: [{ id: 'b1' }] };
  const client = {
    health: () => ({}),
    find: async (song, addons) => ({ found: addons.map((a) => ({ addon: { ...a, name: a.id, host: a.id + '.example' }, rows: rowsOf[a.id] })), tried: [] }),
    open: async (found) => { opens++; const f = found[0]; return { addon: { base: f.addon.base, name: f.addon.name, host: f.addon.host, id: f.addon.id }, row: f.rows[0], stream: { url: f.addon.base + '/file/SECRET-URL', headers: { t: 'SECRET-H' }, codec: 'flac', sampleRate: 44100, transport: 'file' }, tried: [] }; },
  };
  const fetch = async () => { fetched++; return { ok: true, status: 200, headers: { get: (h) => ({ 'content-type': 'audio/flac', 'content-length': '500' })[h.toLowerCase()] ?? null }, arrayBuffer: async () => bytes(500, 9) }; };
  const S = A.create({ storage: st, client, fetch, files });
  const song = { title: 'Song', artist: 'X', durationSec: 200 };
  const play = async () => {
    const f = await S.handle({ type: 'VIVI_ADDONS_FIND', song });
    const o = await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket });
    const file = await S.handle({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket });
    await new Promise((r) => setTimeout(r, 10));   // (the cache write runs after the answer)
    return { o, file };
  };
  const first = await play();
  check('first play: OPEN and the download, then kept', [opens, fetched, first.o.cached, (await files.stats()).files], [1, 1, undefined, 1]);
  const again = await play();
  check('a replay: no /stream call, no download, the cached bytes', [opens, fetched, again.o.cached, again.file.cached, new Uint8Array(again.file.bytes)[0], again.file.mime], [1, 1, true, true, 9, 'audio/flac']);
  check('a replay: the same addon, row and stream facts', [again.o.addon.host, again.o.row.id, again.o.stream.codec, again.o.stream.sampleRate], ['idA.example', 'a1', 'flac', 44100]);
  check('the index and the cache hold no link, token or file URL', /SECRET/.test(JSON.stringify(st.data[FC.INDEX]) + [...c.m.keys()].join()), false);
  await S.handle({ type: 'VIVI_ADDONS_SETTINGS', tier: 'HIGH' });
  await play();
  check('another quality: opened and downloaded again', [opens, fetched], [2, 2]);
  await S.handle({ type: 'VIVI_ADDONS_SETTINGS', tier: 'LOSSLESS' });
  rowsOf = { idA: [{ id: 'a2' }], idB: [{ id: 'b1' }] };
  await files.put(files.keyOf('idB', 'b1', 'LOSSLESS'), bytes(300, 4), { mime: 'audio/flac', stream: { codec: 'flac', transport: 'file' } });
  const lower = await play();
  check('a cached file of a lower addon is played at once (it is ready first, §8.1.4)', [opens, lower.o.addon.host, lower.o.cached, new Uint8Array(lower.file.bytes)[0]], [2, 'idB.example', true, 4]);
  check('settings: the cache size from the list of sizes only', [(await S.handle({ type: 'VIVI_ADDONS_SETTINGS', cacheMB: 300 }), st.data.addonsCacheMB), (await S.handle({ type: 'VIVI_ADDONS_SETTINGS', cacheMB: 1024 }), st.data.addonsCacheMB)], [undefined, 1024]);
  const L = await S.handle({ type: 'VIVI_ADDONS_LIST' });
  check('list: the size and what the cache holds', [L.cacheMB, L.cache.files], [1024, 3]);
  await S.handle({ type: 'VIVI_ADDONS_SETTINGS', cacheMB: 0 });
  const off = await play();
  check('size 0: OPEN again, nothing read or kept', [opens, off.o.cached, (await files.stats()).files], [3, undefined, 0]);
}

// ---- 8.2.1: the floor in OPEN and the pass after a copy plays (UPGRADE) ----
{
  const st = fakeStorage({ addonsEnabled: true, addonsTier: 'LOSSLESS', addonsList: [{ id: 'idA', base: 'https://a.example/SECRET-A', name: 'A', host: 'a.example' }, { id: 'idB', base: 'https://b.example/SECRET-B', name: 'B', host: 'b.example' }] });
  const c = fakeCache();
  const files = FC.create({ open: () => c, storage: st, maxBytes: async () => 512e6, now: () => ++T });
  const calls = [];
  let answer = null;
  const client = {
    health: () => ({}),
    find: async (song, addons) => ({ found: addons.map((a) => ({ addon: { ...a, name: a.id, host: a.id + '.example' }, rows: [{ id: a.id + '-1' }, { id: a.id + '-2' }] })), tried: [] }),
    open: async (found, song, opt) => { calls.push({ found: found.map((f) => [f.addon.id, f.rows.map((r) => r.id)]), accept: opt.accept }); return answer(found); },
  };
  const S = A.create({ storage: st, client, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes(100) }), files });
  const song = { title: 'Up', artist: 'X', durationSec: 200 };
  const ans = (f, row, stream) => ({ addon: { base: f.addon.base, name: f.addon.name, host: f.addon.host, id: f.addon.id }, row: { id: row }, stream: { transport: 'file', url: 'https://cdn/SECRET', ...stream }, tried: [] });
  // a lossy copy from B (A had nothing that passed): the pass asks every addon, B's other row too
  answer = (found) => ans(found.at(-1), 'idB-1', { codec: 'mp3', bitrate: 320 });
  let f = await S.handle({ type: 'VIVI_ADDONS_FIND', song });
  const o = await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket, ytKbps: 160 });
  check("OPEN: the floor goes into the race with YouTube's bitrate", [o.stream.codec, calls[0].accept({ codec: 'mp3', bitrate: 200 }), calls[0].accept({ codec: 'flac' })], ['mp3', "lossy 200 kbps, not 96 kbps over YouTube's 160", true]);
  answer = (found) => ans(found[0], 'idA-2', { codec: 'flac', bitDepth: 16, sampleRate: 44100 });
  const up = await S.handle({ type: 'VIVI_ADDONS_UPGRADE', ticket: f.ticket });
  check('UPGRADE after a lossy copy: every addon, less the row that plays; lossless or better only', [calls[1].found, calls[1].accept({ codec: 'mp3', bitrate: 320 }), calls[1].accept({ codec: 'flac' }), up.row.id, up.stream.codec], [[['idA', ['idA-1', 'idA-2']], ['idB', ['idB-2']]], 'not better', true, 'idA-2', 'flac']);
  check("UPGRADE: the better copy is the ticket's now (FETCH gets it)", S.ticketOf(f.ticket).got.row.id, 'idA-2');
  check('UPGRADE again on a lossless copy: no pass', await S.handle({ type: 'VIVI_ADDONS_UPGRADE', ticket: f.ticket }), { none: 'no pass needed' });
  // a cached 16-bit copy of B, Best asked: only A (ranked above) is asked, for Hi-Res
  await files.put(files.keyOf('idB', 'idB-1', 'LOSSLESS'), bytes(100), { mime: 'audio/flac', stream: { codec: 'flac', bitDepth: 16, sampleRate: 44100, transport: 'file' } });
  const n = calls.length;
  f = await S.handle({ type: 'VIVI_ADDONS_FIND', song: { ...song, title: 'Cached' } });
  const oc = await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket, ytKbps: 160 });
  check('a cached 16-bit copy wins OPEN with no /stream call', [oc.cached, calls.length - n], [true, 0]);
  answer = () => ({ none: 'no addon has it', tried: [{ addon: 'idA.example', why: 'not better' }] });
  const uc = await S.handle({ type: 'VIVI_ADDONS_UPGRADE', ticket: f.ticket });
  check('UPGRADE after it: only the addon ranked above, Hi-Res only; nothing better: it stays', [calls.at(-1).found, calls.at(-1).accept({ codec: 'flac', bitDepth: 16, sampleRate: 44100 }), calls.at(-1).accept({ codec: 'flac', bitDepth: 24, sampleRate: 48000 }), uc.none, S.ticketOf(f.ticket).got.row.id], [[['idA', ['idA-1', 'idA-2']]], 'not better', true, 'no addon has it', 'idB-1']);
  // a cached lossy copy under the floor is not played from the cache
  await files.clear();
  await files.put(files.keyOf('idA', 'idA-1', 'LOSSLESS'), bytes(100), { mime: 'audio/mpeg', stream: { codec: 'mp3', bitrate: 192, transport: 'file' } });
  answer = (found) => ans(found[0], 'idA-2', { codec: 'flac' });
  f = await S.handle({ type: 'VIVI_ADDONS_FIND', song: { ...song, title: 'Weak' } });
  const ow = await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket, ytKbps: 160 });
  check('a cached copy under the floor is passed over; the race runs', [ow.cached, ow.row.id], [undefined, 'idA-2']);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

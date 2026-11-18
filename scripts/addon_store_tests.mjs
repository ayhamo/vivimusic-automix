// Tests for src/addons/bg-addons.js: the user's addon list and the message
// API the popup and the page use. A fake storage and a fake client; no network.
//
//   node scripts/addon_store_tests.mjs        (exit 1 on a failure)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/addons/bg-addons.js');

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

function fakeStorage() {
  const data = {};
  return {
    data,
    get: async (defaults) => ({ ...defaults, ...JSON.parse(JSON.stringify(data)) }),
    set: async (patch) => { Object.assign(data, JSON.parse(JSON.stringify(patch))); },
  };
}
const resolveCalls = [], findCalls = [], openCalls = [];
let openAnswer = (found) => ({ addon: found[0].addon, row: { id: 'r1', title: 'x', durationSec: 200, raw: { secret: 1 } }, stream: { url: 'https://cdn.example/SECRET-FILE.flac', headers: { a: 'SECRET-H' }, codec: 'flac', tier: 'LOSSLESS', transport: 'file' }, tried: [] });
const client = {
  discover: async (url) => {
    if (/refuses/.test(url)) throw new Error('refused (403): no');
    const base = url.replace(/\/manifest\.json$/, '');
    return { base, manifest: { name: /nosearch/.test(url) ? 'Catalog' : 'Addon ' + new URL(base).host.split('.')[0], resources: /nosearch/.test(url) ? ['catalog'] : ['search', 'stream'] } };
  },
  health: () => ({ 'b.example': { fails: 0, coolUntil: 0, last: 'ok', ms: 1200 } }),
  find: async (song, addons, opt) => { findCalls.push({ addons, opt }); return song.title === 'none' ? { found: [], tried: [{ addon: 'b.example', why: 'no match', refused: [{ id: 'q', why: 'length' }] }] } : { found: [{ addon: { base: addons[0].base, name: 'Addon b', host: 'b.example' }, rows: [{ id: 'r1' }, { id: 'r2' }] }], tried: [] }; },
  open: async (found, song, opt, tried) => { openCalls.push(found); return openAnswer(found); },
  resolve: async (song, addons, opt) => { resolveCalls.push({ addons, opt }); return { addon: { base: addons[0].base, name: 'Addon b', host: 'b.example' }, row: { id: 'r' }, stream: { url: 'https://cdn/x.flac' }, tried: [] }; },
};
let n = 0;
const storage = fakeStorage();
const fetches = [];
let fileAnswer = { status: 200, type: 'audio/flac', size: 1000 };
const fakeFetch = async (url, init) => {
  fetches.push({ url, headers: init.headers, credentials: init.credentials });
  const { status, type, size, declared = size } = fileAnswer;
  return { ok: status < 300, status, headers: { get: (h) => ({ 'content-type': type, 'content-length': String(declared) })[h.toLowerCase()] ?? null }, arrayBuffer: async () => new ArrayBuffer(size), body: { cancel: async () => {} } };
};
const S = A.create({ storage, client, newId: () => 'id' + ++n, fetch: fakeFetch });
const msg = (m) => S.handle(m);

check('starts empty and off', await msg({ type: 'VIVI_ADDONS_LIST' }), { enabled: false, tier: 'LOSSLESS', slackSec: 5, addons: [] });
const added = await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://a.example/SECRET-A/manifest.json' });
check('add: the name and host come back, never the link', added, { ok: true, addon: { id: 'id1', name: 'Addon a', host: 'a.example', enabled: true, health: { state: 'unused' } } });
await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://b.example/SECRET-B/manifest.json' });
await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://c.example/SECRET-C' });
check('add: the same addon twice is refused', (await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://A.example/SECRET-A' })).error, 'That addon is already in the list.');
check('add: http is refused', (await msg({ type: 'VIVI_ADDONS_ADD', url: 'http://d.example/T' })).error, 'Addon links must start with https://.');
check('add: not a link', (await msg({ type: 'VIVI_ADDONS_ADD', url: 'hello' })).error, 'That is not an addon link.');
check('add: a refusing addon says why, by host', (await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://refuses.example/SECRET-R' })).error, 'refuses.example: refused (403): no');
check('add: an addon without search', (await msg({ type: 'VIVI_ADDONS_ADD', url: 'https://nosearch.example/SECRET-N' })).error, 'nosearch.example has no search: it can\'t find songs.');
check('storage keeps the links', storage.data.addonsList.map((a) => a.base), ['https://a.example/SECRET-A', 'https://b.example/SECRET-B', 'https://c.example/SECRET-C']);

await msg({ type: 'VIVI_ADDONS_MOVE', id: 'id2', by: -1 });
await msg({ type: 'VIVI_ADDONS_MOVE', id: 'id3', by: 1 });   // already last: stays
let l = await msg({ type: 'VIVI_ADDONS_LIST' });
check('move: b first, c stays last', l.addons.map((a) => a.host), ['b.example', 'a.example', 'c.example']);
check('list: health by host', l.addons.map((a) => a.health.state), ['ok', 'unused', 'unused']);
check('list: no link anywhere', /SECRET/.test(JSON.stringify(l)), false);

await msg({ type: 'VIVI_ADDONS_TOGGLE', id: 'id1', enabled: false });
await msg({ type: 'VIVI_ADDONS_REMOVE', id: 'id3' });
l = await msg({ type: 'VIVI_ADDONS_LIST' });
check('toggle and remove', l.addons.map((a) => [a.host, a.enabled]), [['b.example', true], ['a.example', false]]);
check('an unknown id', await msg({ type: 'VIVI_ADDONS_REMOVE', id: 'nope' }), { ok: false, error: 'No such addon.' });

check('resolve: nothing while addons are off', await msg({ type: 'VIVI_ADDONS_RESOLVE', song: { title: 'x' } }), { none: 'addons off' });
await msg({ type: 'VIVI_ADDONS_SETTINGS', enabled: true, tier: 'HIGH', slackSec: 42 });
await msg({ type: 'VIVI_ADDONS_SETTINGS', tier: 'ULTRA' });
l = await msg({ type: 'VIVI_ADDONS_LIST' });
check('settings: slack clamped to 10, an unknown tier ignored', [l.enabled, l.tier, l.slackSec], [true, 'HIGH', 10]);
const got = await msg({ type: 'VIVI_ADDONS_RESOLVE', song: { title: 'x' } });
check('resolve: only the on addons, in order, with the settings', resolveCalls.at(-1), { addons: [{ base: 'https://b.example/SECRET-B' }], opt: { slackSec: 10, tier: 'HIGH' } });
check('resolve: the answer leaves the link out', [got.addon, /SECRET/.test(JSON.stringify(got))], [{ name: 'Addon b', host: 'b.example' }, false]);
const f = await msg({ type: 'VIVI_ADDONS_FIND', song: { title: 'x' } });
check('find: a ticket, the candidates by host', [typeof f.ticket, f.candidates], ['string', [{ addon: 'b.example', rows: 2 }]]);
check('find: no link in the answer', /SECRET/.test(JSON.stringify(f)), false);
check('find: nothing found: no ticket, why by host', await msg({ type: 'VIVI_ADDONS_FIND', song: { title: 'none' } }), { none: 'no addon has it', tried: [{ addon: 'b.example', why: 'no match' }] });
const o = await msg({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket });
check('open: row and stream facts, no link, no file URL, no headers', [o.row.id, o.stream.codec, /SECRET/.test(JSON.stringify(o))], ['r1', 'flac', false]);
check('open: the file URL stays in the background', S.ticketOf(f.ticket).got.stream.url, 'https://cdn.example/SECRET-FILE.flac');
await msg({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket });
check('open twice: one /stream round', openCalls.length, 1);
openAnswer = () => ({ none: 'no addon has it', tried: [{ addon: 'b.example', why: 'stream limit, free in 20 s' }] });
const f2 = await msg({ type: 'VIVI_ADDONS_FIND', song: { title: 'y' } });
check('open: a limit says so', (await msg({ type: 'VIVI_ADDONS_OPEN', ticket: f2.ticket })).tried[0].why, 'stream limit, free in 20 s');
await msg({ type: 'VIVI_ADDONS_OPEN', ticket: f2.ticket });
check('open after nothing: may ask again', openCalls.length, 3);
check('open: an unknown ticket', await msg({ type: 'VIVI_ADDONS_OPEN', ticket: 'zz' }), { none: 'ticket expired' });
// FETCH: the opened file, with only the stream answer's headers
check('fetch: not opened yet', await msg({ type: 'VIVI_ADDONS_FETCH', ticket: f2.ticket }), { none: 'not opened' });
const file = await msg({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket });
check('fetch: the bytes and their type', [file.bytes instanceof ArrayBuffer, file.bytes.byteLength, file.mime], [true, 1000, 'audio/flac']);
check('fetch: only the stream answer\'s headers, no cookies', [fetches.at(-1).headers, fetches.at(-1).credentials], [{ a: 'SECRET-H' }, 'omit']);
fileAnswer = { status: 200, type: 'application/octet-stream', size: 10 };
check('fetch: not an audio type: the codec\'s', (await msg({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket })).mime, 'audio/flac');
fileAnswer = { status: 200, type: 'audio/flac', size: 10, declared: 400e6 };
check('fetch: a file over 300 MB is refused before reading', await msg({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket }), { none: 'the file is too big (400 MB)' });
fileAnswer = { status: 403, type: 'text/html', size: 10 };
check('fetch: an error status', await msg({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket }), { none: 'the file answered 403' });
check('other message types are not ours', await S.handle({ type: 'VIVI_LISTENBRAINZ_STATUS' }), undefined);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

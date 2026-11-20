// Tests for src/addons/page-addons.js (step 4: per-song resolve). A fake page
// (window messages, the queue's 'meta' answers) and a fake background that
// answers FIND and OPEN. The playing song is opened at once; the next song is
// only searched (no /stream call) until something asks for it.
//
//   node scripts/addon_page_tests.mjs        (exit 1 on a failure)
import fs from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const listeners = [], storageListeners = [], sent = [];
const meta = { s1: { song: 'Poker Face', artist: 'Lady Gaga', album: 'The Fame', duration: 237 }, s2: { song: 'Vaina Loca', artist: 'Ozuna', album: '', duration: 0 }, s3: null };
const win = {
  location: { origin: 'https://music.youtube.com' },
  addEventListener: (t, f) => t === 'message' && listeners.push(f),
  postMessage(d) {   // the page answers 'meta' like crossfade-page.js
    if (d.type === 'meta') setTimeout(() => deliver({ ch: 'vivi-xfade', dir: 'out', type: 'meta', id: d.id, meta: meta[d.id] ?? null }), 1);
  },
};
const deliver = (data) => listeners.forEach((f) => f({ source: win, data }));
let store = { addonsEnabled: false };
const chrome = {
  storage: {
    local: { get: (d, cb) => cb({ ...d, ...store }) },
    onChanged: { addListener: (f) => storageListeners.push(f) },
  },
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sent.push(msg);
      setTimeout(() => {
        if (msg.type === 'VIVI_ADDONS_FIND') cb(msg.song.title === 'Vaina Loca' || msg.song.title === 'Poker Face' ? { ticket: 't-' + msg.song.title, candidates: [{ addon: 'nullbeat.example', rows: 1 }], tried: [] } : { none: 'no addon has it', tried: [] });
        else if (msg.type === 'VIVI_ADDONS_REFRESH') cb({ ok: true, cleared: 2, files: 1 });
        else if (msg.type === 'VIVI_ADDONS_OPEN') cb({ addon: { name: 'NullBeat', host: 'nullbeat.example' }, row: { id: 'r-' + msg.ticket }, stream: { codec: 'flac', sampleRate: 44100, bitDepth: 16 }, tried: [] });
      }, 1);
    },
  },
};
const ctx = vm.createContext({ window: win, chrome, console: { info: () => {} }, setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 2)), Promise });   // fast timers: the details retries take ms, not s
vm.runInContext(fs.readFileSync(new URL('../src/addons/page-addons.js', import.meta.url), 'utf8'), ctx);
const P = win.__viviAddonsPage;
const state = (id, next, dur = 237) => deliver({ ch: 'vivi-xfade', dir: 'out', type: 'state', id, next, dur });
const types = () => sent.map((m) => m.type + (m.song ? ':' + m.song.title : '') + (m.ticket ? ':' + m.ticket : ''));

state('s1', 's2');
await tick(); await tick();
check('addons off: nothing asked', [sent.length, P.statusOf('s1').state], [0, 'off']);

store = { addonsEnabled: true };
storageListeners.forEach((f) => f({ addonsEnabled: { newValue: true } }, 'local'));
state('s1', 's2');
for (let i = 0; i < 6; i++) await tick();
check('the playing song: found and opened; the next: searched only', types(), ['VIVI_ADDONS_FIND:Poker Face', 'VIVI_ADDONS_FIND:Vaina Loca', 'VIVI_ADDONS_OPEN:t-Poker Face']);
check('the playing song is ready', [P.statusOf('s1').state, P.statusOf('s1').row.id], ['ready', 'r-t-Poker Face']);
check('the next song is found, not opened', P.statusOf('s2').state, 'found');
check('a song without length in the queue gets none (no fallback for the look-ahead)', sent[1].song.durationSec, null);
state('s1', 's2');
for (let i = 0; i < 3; i++) await tick();
check('the same state again: nothing new', sent.length, 3);
const opened = await P.openFor('s2');
check('openFor the next song: one OPEN, just then', [opened.state, types().at(-1)], ['ready', 'VIVI_ADDONS_OPEN:t-Vaina Loca']);
await P.openFor('s2');
check('openFor again: no second OPEN', sent.length, 4);
state('s3', '');
for (let i = 0; i < 20; i++) await tick();
check('a song without details: none, nothing asked', [P.statusOf('s3').state, P.statusOf('s3').why, sent.length], ['none', 'no song details', 4]);
// 8.1.7 "Upgrade quality", and YouTube's bitrate going with OPEN (the lossy floor, 8.2.1)
deliver({ ch: 'vivi-xfade', dir: 'out', type: 'ytAudio', id: 's1', itag: 251, kbps: 150, codec: 'opus' });
const refreshed = [];
win.dispatchEvent = (e) => refreshed.push(e.detail.id);
ctx.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
const up = await P.upgradeQuality('s1');
check('upgradeQuality: REFRESH with the ticket, the song forgotten, crossfade told', [up, sent.at(-1), P.statusOf('s1').state, refreshed], [true, { type: 'VIVI_ADDONS_REFRESH', ticket: 't-Poker Face' }, 'none', ['s1']]);
const again = await P.openFor('s1');
check("then FIND and OPEN again, with YouTube's bitrate", [again.state, types().slice(-2), sent.at(-1).ytKbps], ['ready', ['VIVI_ADDONS_FIND:Poker Face', 'VIVI_ADDONS_OPEN:t-Poker Face'], 150]);
storageListeners.forEach((f) => f({ addonsEnabled: { newValue: false } }, 'local'));
check('turned off: off, forgotten', P.statusOf('s1').state, 'off');

// protocol.md 8.1.3: the next song is opened only from 25 s before the transition
check('read-ahead: 26 s before the mix-out: not yet; 25 s: now; past it: still', [P.openDue(174, 200), P.openDue(175, 200), P.openDue(199, 200)], [false, true, true]);
check('read-ahead: a song shorter than 25 s: from its start', P.openDue(0, 20), true);
check('read-ahead: no transition known: never', [P.openDue(100, NaN), P.openDue(100, 0), P.openDue(NaN, 200)], [false, false, false]);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

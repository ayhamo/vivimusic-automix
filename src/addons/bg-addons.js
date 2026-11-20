/* Vivimusic Web+ — addons/bg-addons.js (background script; node for tests)
 *
 * The user's addon list and the background message API for the popup and the
 * page (spec/addons/protocol.md). Loaded after track-matcher.js, pick.js and
 * client.js. Addon URLs hold their owner's token: they stay in storage.local
 * and in this script; the popup and the logs only ever see the host.
 *
 *   storage.local:
 *     addonsEnabled   false        the master switch
 *     addonsList      []           [{ id, base, name, host, enabled }] in priority order
 *     addonsTier      'LOSSLESS'   'LOSSLESS' (the best) | 'HIRES' | 'CD' | 'HIGH' | 'LOW'
 *     addonsSlackSec  5            length slack, 0-10 s
 *
 *   messages (type, then fields):
 *     VIVI_ADDONS_LIST                     -> { enabled, tier, slackSec, addons: [{ id, name, host, enabled, health }] }
 *     VIVI_ADDONS_ADD      { url }         -> { ok, addon } or { ok: false, error }
 *     VIVI_ADDONS_REMOVE   { id }
 *     VIVI_ADDONS_MOVE     { id, by }      by -1 up, +1 down
 *     VIVI_ADDONS_TOGGLE   { id, enabled }
 *     VIVI_ADDONS_SETTINGS { enabled?, tier?, slackSec? }
 *     VIVI_ADDONS_RESOLVE  { song }        -> client.resolve's answer, the addon's URL left out
 *     VIVI_ADDONS_FIND     { song }        -> { ticket, candidates, tried } search only (the look-ahead)
 *     VIVI_ADDONS_ISRC     { videoId, isrc } -> { ok }: the ISRC the lyrics lookup learned (protocol.md §7, ISRC first)
 *     VIVI_ADDONS_OPEN     { ticket }      -> { addon, row, stream, tried } or { none, tried }: /stream + probe
 *     VIVI_ADDONS_FETCH    { ticket }      -> { bytes (ArrayBuffer), mime } or { none }: the opened file (Firefox passes ArrayBuffers)
 *
 * globalThis.__viviAddons
 */
(() => {
  'use strict';
  const C = globalThis.__viviAddonClient || (typeof require === 'function' ? require('./client.js') : null);
  const Pick = globalThis.__viviAddonPick || (typeof require === 'function' ? require('./pick.js') : null);

  const TIERS = ['LOSSLESS', 'HIRES', 'CD', 'HIGH', 'LOW'];   // (LOSSLESS: the addon's best)
  const DEFAULTS = { addonsEnabled: false, addonsList: [], addonsTier: 'LOSSLESS', addonsSlackSec: 5 };
  const MAX_ADDONS = 12;

  function create({ storage, client = C.create({ log: (...a) => console.info('[vivi addons]', ...a) }), newId = () => Math.random().toString(36).slice(2, 10), fetch: doFetch = globalThis.fetch?.bind(globalThis) } = {}) {
    const get = () => storage.get(DEFAULTS);
    const setList = (addonsList) => storage.set({ addonsList });
    // what leaves the background: never the base URL
    const shown = (a, health) => ({ id: a.id, name: a.name, host: a.host, enabled: a.enabled !== false, health: healthOf(health[a.host]) });
    function healthOf(h) {
      if (!h) return { state: 'unused' };
      if (h.coolUntil && h.coolUntil > Date.now()) return { state: 'resting', until: h.coolUntil, last: h.last || null };
      if (h.fails > 0) return { state: 'failing', fails: h.fails, last: h.last || null };
      return { state: 'ok', ms: h.ms ?? null };
    }

    async function list() {
      const s = await get();
      const health = client.health();
      return { enabled: s.addonsEnabled === true, tier: s.addonsTier, slackSec: s.addonsSlackSec, addons: s.addonsList.map((a) => shown(a, health)) };
    }

    // list edits one at a time: each reads the list and writes it back, and two at once lost one
    // (two toggles sent together left the first addon as it was)
    let edits = Promise.resolve();
    const inTurn = (f) => (...a) => { const p = edits.then(() => f(...a)); edits = p.catch(() => {}); return p; };

    // (the addon's own manifest is fetched outside the turn: a slow host must not hold up toggles
    // and removals; the list is read again in the turn before it is written)
    const add = async (url) => {
      let base;
      try { base = C.baseOf(url); new URL(base); } catch { return { ok: false, error: 'That is not an addon link.' }; }
      if (!/^https:/i.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(base)) return { ok: false, error: 'Addon links must start with https://.' };
      const refused = (list) => list.some((a) => C.sameAddon(a.base, base)) ? 'That addon is already in the list.'
        : list.length >= MAX_ADDONS ? `At most ${MAX_ADDONS} addons.` : null;
      const early = refused((await get()).addonsList);
      if (early) return { ok: false, error: early };
      let found;
      try { found = await client.discover(url); } catch (e) { return { ok: false, error: `${C.redact(base)}: ${e.message}` }; }
      const res = found.manifest?.resources;
      if (Array.isArray(res) && res.length && !res.includes('search')) return { ok: false, error: `${C.redact(base)} has no search: it can't find songs.` };
      return inTurn(async () => {
        const s = await get();
        const why = refused(s.addonsList);
        if (why) return { ok: false, error: why };
        const addon = { id: newId(), base: found.base, name: String(found.manifest?.name || C.redact(found.base)).slice(0, 60), host: C.redact(found.base), enabled: true };
        await setList([...s.addonsList, addon]);
        return { ok: true, addon: shown(addon, client.health()) };
      })();
    };

    const edit = inTurn(async (id, fn) => {
      const s = await get();
      const i = s.addonsList.findIndex((a) => a.id === id);
      if (i < 0) return { ok: false, error: 'No such addon.' };
      const next = fn([...s.addonsList], i);
      await setList(next);
      return { ok: true };
    });
    const remove = (id) => edit(id, (l, i) => (l.splice(i, 1), l));
    const move = (id, by) => edit(id, (l, i) => {
      const j = Math.max(0, Math.min(l.length - 1, i + Math.sign(by)));
      const [a] = l.splice(i, 1); l.splice(j, 0, a); return l;
    });
    const toggle = (id, enabled) => edit(id, (l, i) => (l[i] = { ...l[i], enabled: enabled !== false }, l));

    async function settings({ enabled, tier, slackSec } = {}) {
      const patch = {};
      if (typeof enabled === 'boolean') patch.addonsEnabled = enabled;
      if (TIERS.includes(tier)) patch.addonsTier = tier;
      const n = Number(slackSec);
      if (slackSec != null && Number.isFinite(n)) patch.addonsSlackSec = Math.max(0, Math.min(10, Math.round(n)));
      if (Object.keys(patch).length) await storage.set(patch);
      return { ok: true };
    }

    // the page asks for the song it is about to play; nothing when addons are off
    async function resolve(song) {
      song = withIsrc(song);
      const s = await get();
      const on = s.addonsList.filter((a) => a.enabled !== false);
      if (!s.addonsEnabled || !on.length) return { none: 'addons off' };
      const got = await client.resolve(song, on.map((a) => ({ base: a.base })), { slackSec: s.addonsSlackSec, tier: s.addonsTier });
      return outward(got);
    }
    // what the page gets of an answer: names, hosts, row and stream facts; no link, no file URL
    // what leaves the background: no links (an addon's text may hold one), reasons kept short
    const plain = (t) => (t == null ? t : String(t).replace(/https?:\/\/[^\s'"<>)]+/gi, '[link]').slice(0, 160));
    function outward(got) {
      const tried = (got.tried || []).map(({ addon, row, why }) => ({ addon, row, why: plain(why) }));
      if (!got.addon) return { none: plain(got.none), tried };
      const { row: r, stream: st } = got;
      return {
        addon: { name: got.addon.name, host: got.addon.host },
        row: { id: r.id, title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec, isrc: r.isrc },
        stream: { codec: st.codec, tier: st.tier, sampleRate: st.sampleRate, bitDepth: st.bitDepth, bitrate: st.bitrate, transport: st.transport, mimeType: st.mimeType },
        tried,
      };
    }

    // Look-ahead (spec/addons/protocol.md §8): FIND searches only (no /stream: the TorBox
    // limits), OPEN spends the /stream call just before the song is needed. The page holds a
    // ticket; the links and the file URL stay here.
    const tickets = new Map();   // ticket -> { at, song, opt, found, tried, opened }
    const TICKET_MS = 15 * 60e3, TICKETS_MAX = 24;
    const keepTicket = (t) => {
      const cut = Date.now() - TICKET_MS;
      for (const [k, v] of tickets) if (v.at < cut) tickets.delete(k);
      while (tickets.size >= TICKETS_MAX) tickets.delete(tickets.keys().next().value);
      const id = 't' + newId();
      tickets.set(id, t);
      return id;
    };
    // The song's ISRC, learned by the lyrics lookup (lrc.red, BiniLyrics) per video id: YouTube
    // Music gives none, and none is asked for just for this (protocol.md §7, ISRC first).
    const songIsrc = new Map(), ISRC_SONGS = 200;
    function noteIsrc(videoId, isrc) {
      const id = String(videoId || ''), v = Pick.isrcOf(isrc);
      if (!id || !v) return { ok: false };
      songIsrc.delete(id);
      songIsrc.set(id, v);
      while (songIsrc.size > ISRC_SONGS) songIsrc.delete(songIsrc.keys().next().value);
      return { ok: true };
    }
    const withIsrc = (song) => (song?.isrc || !songIsrc.has(song?.videoId) ? song : { ...song, isrc: songIsrc.get(song.videoId) });

    async function find(song) {
      song = withIsrc(song);
      const s = await get();
      const on = s.addonsList.filter((a) => a.enabled !== false);
      if (!s.addonsEnabled || !on.length) return { none: 'addons off' };
      const opt = { slackSec: s.addonsSlackSec, tier: s.addonsTier };
      const { found, tried } = await client.find(song, on.map((a) => ({ base: a.base })), opt);
      const shownTried = tried.map(({ addon, why }) => ({ addon, why }));
      if (!found.length) return { none: 'no addon has it', tried: shownTried };
      const ticket = keepTicket({ at: Date.now(), song, opt, found, tried });
      return { ticket, candidates: found.map((f) => ({ addon: f.addon.host, rows: f.rows.length })), tried: shownTried };
    }
    async function open(ticket) {
      const t = tickets.get(ticket);
      if (!t) return { none: 'ticket expired' };
      // the ISRC came in after the search (the lyrics lookup ran later): search again with it
      // (the search answers are cached, so no addon is asked twice and no /stream is spent)
      const known = withIsrc(t.song);
      if (!t.opened && known !== t.song) {
        t.song = known;
        const again = await client.find(known, t.found.map((f) => ({ base: f.addon.base })), t.opt).catch(() => null);
        if (again?.found?.length) { t.found = again.found; t.tried = again.tried; }
      }
      if (!t.opened) t.opened = client.open(t.found, t.song, t.opt, [...t.tried]).catch((e) => ({ none: C.scrub(e?.message || e), tried: [] }));
      const got = await t.opened;
      if (!got.addon) t.opened = null;   // nothing (a limit, say): may be asked again later
      t.got = got.addon ? got : null;
      return outward(got);
    }

    // FETCH (protocol.md §8, PC step 2): the opened file's bytes, for the page to fit and play.
    // Here because the background holds the host permission (TorBox's files send no CORS
    // headers) and the file URL. Only the stream answer's headers go with it (§1).
    const FILE_MAX_BYTES = 300e6;
    const FILE_TIMEOUT_MS = 120e3;
    // a response body read up to `max` bytes (more: cancelled, null); into one array sized by
    // Content-Length when there is one, else gathered. Without a stream body (tests' mocks): read whole.
    async function readCapped(r, max) {
      if (!r.body?.getReader) { const b = r.arrayBuffer ? await r.arrayBuffer() : new TextEncoder().encode(await r.text()).buffer; return b.byteLength > max ? null : b; }
      const rd = r.body.getReader(), len = Number(r.headers?.get?.('content-length')) || 0;
      let one = len > 0 && len <= max ? new Uint8Array(len) : null, parts = [], n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (n + value.byteLength > max) { try { await rd.cancel(); } catch { /* gone */ } return null; }
        if (one && n + value.byteLength <= one.length) one.set(value, n); else { if (one) { parts.push(one.subarray(0, n)); one = null; } parts.push(value); }
        n += value.byteLength;
      }
      if (one) return n === one.length ? one.buffer : one.slice(0, n).buffer;
      const out = new Uint8Array(n); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return out.buffer;
    }
    async function fetchFile(ticket) {
      const t = tickets.get(ticket);
      const s = t?.got?.stream;
      if (!s) return { none: t ? 'not opened' : 'ticket expired' };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FILE_TIMEOUT_MS);
      try {
        const r = await doFetch(s.url, { headers: { ...(s.headers || {}) }, signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
        if (!r.ok) return { none: `the file answered ${r.status}` };
        const size = Number(r.headers.get('content-length'));
        if (size > FILE_MAX_BYTES) { try { await r.body?.cancel(); } catch { /* gone */ } return { none: `the file is too big (${Math.round(size / 1e6)} MB)` }; }
        const bytes = await readCapped(r, FILE_MAX_BYTES);   // (no Content-Length: counted as it comes)
        if (!bytes) return { none: `the file is too big (over ${Math.round(FILE_MAX_BYTES / 1e6)} MB)` };
        const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
        return { bytes, mime: /^audio\//.test(mime) ? mime : s.mimeType || mimeOf(s.codec) };
      } catch (e) {
        return { none: ctl.signal.aborted ? 'the file took too long' : C.scrub(`the file failed: ${e?.message || e}`) };
      } finally { clearTimeout(timer); }
    }
    const mimeOf = (codec) => ({ flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/mp4', m4a: 'audio/mp4', alac: 'audio/mp4', opus: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav' })[codec] || 'audio/mpeg';

    async function handle(msg) {
      switch (msg?.type) {
        case 'VIVI_ADDONS_LIST': return list();
        case 'VIVI_ADDONS_ADD': return add(String(msg.url || '').trim());
        case 'VIVI_ADDONS_REMOVE': return remove(msg.id);
        case 'VIVI_ADDONS_MOVE': return move(msg.id, msg.by);
        case 'VIVI_ADDONS_TOGGLE': return toggle(msg.id, msg.enabled);
        case 'VIVI_ADDONS_SETTINGS': return settings(msg);
        case 'VIVI_ADDONS_RESOLVE': return resolve(msg.song || {});
        case 'VIVI_ADDONS_FIND': return find(msg.song || {});
        case 'VIVI_ADDONS_ISRC': return noteIsrc(msg.videoId, msg.isrc);
        case 'VIVI_ADDONS_OPEN': return open(String(msg.ticket || ''));
        case 'VIVI_ADDONS_FETCH': return fetchFile(String(msg.ticket || ''));
        default: return undefined;
      }
    }
    return { list, add, remove, move, toggle, settings, resolve, find, open, fetchFile, noteIsrc, handle, ticketOf: (t) => tickets.get(t) };
  }

  const api = { create, DEFAULTS, TIERS };
  globalThis.__viviAddons = api;
  if (typeof module === 'object' && module.exports) module.exports = api;

  // the extension's background: one store, one listener for our message types only
  if (typeof chrome === 'object' && chrome?.runtime?.onMessage && chrome?.storage?.local) {
    const store = create({ storage: chrome.storage.local });
    // content scripts (YouTube Music's tab) may only FIND, OPEN and FETCH; the list and its
    // settings change only from the extension's own pages (the popup)
    const PAGE_TYPES = new Set(['VIVI_ADDONS_FIND', 'VIVI_ADDONS_OPEN', 'VIVI_ADDONS_FETCH']);
    const ours = (sender) => typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (typeof msg?.type !== 'string' || !msg.type.startsWith('VIVI_ADDONS_')) return undefined;
      if (!PAGE_TYPES.has(msg.type) && !ours(sender)) { sendResponse({ ok: false, error: 'Only the add-on settings can do that.' }); return undefined; }
      store.handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: C.scrub(e?.message || e) }));
      return true;
    });
  }
})();

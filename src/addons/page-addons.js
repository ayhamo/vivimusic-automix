/* Vivimusic Web+ — addons/page-addons.js (content script, music.youtube.com)
 *
 * Step 4 of the addon plan: which addon has the playing song and the next one
 * (spec/addons/protocol.md §8). Follows crossfade-page.js's state messages:
 *   - the playing song: FIND, then OPEN at once (it is needed now);
 *   - the next song: FIND only, the look-ahead. Its OPEN (a /stream call, which
 *     TorBox-backed addons limit to a few a minute) waits until it is needed:
 *     openFor(id) from the mix or the deck.
 * Nothing happens while addons are off. The background keeps the links and
 * file URLs; this script holds tickets and what the page may show.
 *
 *   window.__viviAddonsPage = { statusOf(id), openFor(id), lookAhead(id), fetchFor(id), note(id, patch), isOn() }
 *     statusOf: { state: 'off'|'looking'|'found'|'none'|'opening'|'ready', addon?, row?, stream?, why?, tried? }
 */
(() => {
  'use strict';
  const CHANNEL = 'vivi-xfade';
  const log = (...a) => console.info('[vivi addons]', ...a);
  let enabled = false;
  const songs = new Map();   // id -> { state, meta, ticket, find (promise), open (promise), ... }
  const SONGS_MAX = 40;

  try {
    chrome.storage.local.get({ addonsEnabled: false }, (s) => { enabled = s.addonsEnabled === true; });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.addonsEnabled) return;
      enabled = ch.addonsEnabled.newValue === true;
      if (!enabled) songs.clear();
    });
  } catch { /* no extension context */ }

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { none: chrome.runtime.lastError.message } : r || { none: 'no answer' }));
    } catch (e) { resolve({ none: String(e?.message || e) }); }
  });

  // the queue's details for a song (crossfade-page.js answers 'meta')
  const metaWaits = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'out') return;
    if (d.type === 'meta') { const w = metaWaits.get(d.id); if (w) { metaWaits.delete(d.id); w(d.meta || null); } }
    else if (d.type === 'state') onState(d);
  });
  function metaOf(id) {
    return new Promise((resolve) => {
      const prev = metaWaits.get(id);
      metaWaits.set(id, (m) => { prev?.(m); resolve(m); });
      window.postMessage({ ch: CHANNEL, dir: 'in', type: 'meta', id }, window.location.origin);
      setTimeout(() => { if (metaWaits.has(id)) { metaWaits.delete(id); resolve(null); } }, 3000);
    });
  }

  function entry(id) {
    let s = songs.get(id);
    if (!s) {
      s = { state: 'looking' };
      songs.set(id, s);
      while (songs.size > SONGS_MAX) songs.delete(songs.keys().next().value);
    }
    return s;
  }

  // FIND: search only
  function lookAhead(id, fallbackSec) {
    if (!enabled || !id) return Promise.resolve(null);
    const s = entry(id);
    if (s.find) return s.find;
    s.find = (async () => {
      // right after a page load the queue may not have the song's details yet: ask again for a while
      let m = await metaOf(id);
      for (let i = 0; i < 6 && !m?.song && enabled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        m = await metaOf(id);
      }
      if (!m?.song) { Object.assign(s, { state: 'none', why: 'no song details' }); return s; }
      s.meta = m;
      const song = { title: m.song, artist: m.artist, album: m.album || null, durationSec: m.duration || fallbackSec || null };
      const r = await ask({ type: 'VIVI_ADDONS_FIND', song });
      if (r.ticket) Object.assign(s, { state: 'found', ticket: r.ticket, candidates: r.candidates, tried: r.tried });
      else Object.assign(s, { state: 'none', why: r.none, tried: r.tried });
      show();
      log(`${m.artist} - ${m.song}: ${r.ticket ? 'found at ' + r.candidates.map((c) => c.addon).join(', ') : r.none}`, r.tried?.length ? r.tried : '');
      return s;
    })();
    return s.find;
  }

  // OPEN: the /stream call and the probe, when the song is needed
  async function openFor(id, fallbackSec) {
    if (!enabled || !id) return null;
    const s = await lookAhead(id, fallbackSec);
    if (!s?.ticket) return s;
    if (s.state === 'ready') return s;
    if (s.open) return s.open;
    s.state = 'opening';
    s.open = (async () => {
      let r = await ask({ type: 'VIVI_ADDONS_OPEN', ticket: s.ticket });
      // Firefox suspends an idle background after ~30 s, and its tickets go with it:
      // the search again (no /stream call, so no limit spent), then the OPEN once more
      if (r.none === 'ticket expired') {
        s.find = null;
        const again = await lookAhead(id, fallbackSec);
        if (again?.ticket) r = await ask({ type: 'VIVI_ADDONS_OPEN', ticket: again.ticket });
      }
      if (r.addon) Object.assign(s, { state: 'ready', addon: r.addon, row: r.row, stream: r.stream, tried: r.tried, why: null });
      else Object.assign(s, { state: 'found', why: r.none, tried: r.tried });   // a limit or a miss: may be opened again later
      const st = r.stream;
      show();
      log(`${s.meta?.artist} - ${s.meta?.song}: ${r.addon ? `${r.addon.name} (${r.addon.host}) row ${r.row.id}, ${st.codec || '?'}${st.sampleRate ? ' ' + st.sampleRate / 1000 + ' kHz' : ''}${st.bitDepth ? '/' + st.bitDepth : ''}` : 'nothing to play: ' + r.none}`, r.tried?.length ? r.tried : '');
      s.open = null;
      return s;
    })();
    return s.open;
  }

  // FETCH: the opened file's bytes (the background fetches it: host permission, file URL)
  async function fetchFor(id) {
    const s = songs.get(id);
    if (!enabled || s?.state !== 'ready') return { none: 'not opened' };
    const r = await ask({ type: 'VIVI_ADDONS_FETCH', ticket: s.ticket });
    if (!(r.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(r.bytes)) return { none: r.none || 'no bytes' };
    return { bytes: r.bytes, mime: r.mime };
  }
  // what happened to the song after OPEN: 'fitting', 'playing' (with offset and gain), or why not
  function note(id, patch) { const s = songs.get(id); if (s) Object.assign(s, patch); show(); }
  // the playing song's addon state on <html data-vivi-addons> (names and hosts only), for the HUD and tests
  function show() {
    try {
      const st = statusOf(curId);
      document.documentElement.dataset.viviAddons = JSON.stringify({ id: curId, state: st.state, addon: st.addon?.host, row: st.row?.id, codec: st.stream?.codec, why: st.why, play: st.play, tried: st.tried?.slice(0, 6) });
    } catch { /* no document */ }
    badge();
  }
  // the player bar's quality badge ("FLAC 16/44.1") while an addon's copy is what plays;
  // YT Music redraws the bar now and then, so it is put back each check
  const BADGE_ID = 'vivi-addon-badge';
  function badge() {
    try {
      const st = statusOf(curId);
      let b = document.getElementById(BADGE_ID);
      if (st.play?.state !== 'playing' || !st.stream) { if (b) b.hidden = true; return; }
      const host = document.querySelector('ytmusic-player-bar .right-controls-buttons');
      if (!host) return;
      if (!b) { b = document.createElement('span'); b.id = BADGE_ID; b.className = 'vivi-addon-badge'; }
      if (b.parentElement !== host || b !== host.firstElementChild) host.prepend(b);
      const { codec, sampleRate, bitDepth } = st.stream;
      const spec = bitDepth && sampleRate ? ` ${bitDepth}/${+(sampleRate / 1000).toFixed(1)}` : '';
      const text = (codec || 'addon').toUpperCase() + spec;
      if (b.textContent !== text) b.textContent = text;
      const title = `Playing ${st.addon?.name || st.addon?.host || 'an addon'}'s copy: ${(codec || '?').toUpperCase()}${bitDepth ? `, ${bitDepth}-bit` : ''}${sampleRate ? `, ${sampleRate / 1000} kHz` : ''}`;
      if (b.title !== title) b.title = title;
      b.hidden = false;
    } catch { /* no player bar */ }
  }
  if (typeof setInterval === 'function') setInterval(badge, 1000);

  let curId = '', nextId = '';
  function onState(d) {
    if (!enabled) return;
    if (d.id && d.id !== curId) { curId = d.id; openFor(d.id, d.dur); }
    if (d.next && d.next !== nextId && d.next !== d.id) { nextId = d.next; lookAhead(d.next); }
  }

  function statusOf(id) {
    if (!enabled) return { state: 'off' };
    const s = songs.get(id);
    if (!s) return { state: 'none', why: 'not asked yet' };
    const { state, addon, row, stream, why, tried, candidates, play } = s;
    return { state, addon, row, stream, why, tried, candidates, play };
  }

  window.__viviAddonsPage = { statusOf, openFor, lookAhead, fetchFor, note, isOn: () => enabled };
})();

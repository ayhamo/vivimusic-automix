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
    else if (d.type === 'ytAudio') ytAudio = { id: String(d.id || ''), itag: Number(d.itag) || 0, kbps: Number(d.kbps) || 0, codec: String(d.codec || ''), at: Date.now() };
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

  const RESEARCH_MS = 5 * 60e3;
  // FIND: search only
  function lookAhead(id, fallbackSec) {
    if (!enabled || !id) return Promise.resolve(null);
    const s = entry(id);
    // a search that found nothing (a timeout or a resting addon may be why) is asked again after a while
    if (s.find && !(s.state === 'none' && Date.now() - s.findAt > RESEARCH_MS)) return s.find;
    s.findAt = Date.now();
    s.find = (async () => {
      // right after a page load the queue may not have the song's details yet: ask again for a while
      let m = await metaOf(id);
      for (let i = 0; i < 6 && !m?.song && enabled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        m = await metaOf(id);
      }
      if (!m?.song) { Object.assign(s, { state: 'none', why: 'no song details' }); return s; }
      s.meta = m;
      const song = { videoId: id, title: m.song, artist: m.artist, album: m.album || null, durationSec: m.duration || fallbackSec || null };
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
    let r = await ask({ type: 'VIVI_ADDONS_FETCH', ticket: s.ticket });
    // the background was suspended since OPEN and its tickets went with it: search and open again, once
    if (r.none === 'ticket expired' || r.none === 'not opened') {
      Object.assign(s, { state: 'looking', find: null, open: null, ticket: null });
      const again = await openFor(id);
      if (again?.state === 'ready') r = await ask({ type: 'VIVI_ADDONS_FETCH', ticket: again.ticket });
    }
    if (!(r.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(r.bytes)) return { none: r.none || 'no bytes' };
    return { bytes: r.bytes, mime: r.mime };
  }
  // what happened to the song after OPEN: 'fitting', 'playing' (with offset and gain), or why not
  function note(id, patch) { const s = songs.get(id); if (s) Object.assign(s, patch); show(); }
  // the playing song's addon state on <html data-vivi-addons> (names and hosts only), for the tests:
  // only where storage.local viviDebug is set (the test Firefox), as YouTube's page can read it
  let debug = false;
  try {
    chrome.storage.local.get({ viviDebug: false }, (r) => { debug = r.viviDebug === true; });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.viviDebug) debug = ch.viviDebug.newValue === true; });
  } catch { /* no storage (tests) */ }
  function show() {
    if (debug) try {
      const st = statusOf(curId);
      document.documentElement.dataset.viviAddons = JSON.stringify({ id: curId, state: st.state, addon: st.addon?.host, row: st.row?.id, codec: st.stream?.codec, why: st.why, play: st.play, tried: st.tried?.slice(0, 6) });
    } catch { /* no document */ }
    badge();
  }
  // the player bar's quality badge, BitChord's labels: "Upgrading Quality" while the song's
  // addon copy is still being looked for or readied, then "Lossless" / "Hi-Res Lossless"
  // (lossless and more than 16 bits or 48 kHz) or "High Quality" (lossy, 256 kbps or more)
  // while that copy is what plays; nothing for YouTube's own audio. The exact format is the
  // tooltip. YT Music redraws its parts now and then, so they are put back each check.
  const BADGE_ID = 'vivi-addon-badge';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    // BitChord's lossless wave (ic_lossless.xml)
    wave: { box: '0 0 100 53.36', w: 15, h: 8, d: 'M34.91,0.02 L35.64,0.00 L36.64,0.08 L37.74,0.28 L39.04,0.69 L40.34,1.30 L41.75,2.18 L42.90,3.12 L44.25,4.46 L45.37,5.82 L47.37,8.92 L48.16,10.32 L49.47,13.02 L50.67,15.82 L51.97,19.22 L53.27,22.93 L56.51,32.83 L58.03,37.23 L59.63,41.33 L60.93,44.03 L62.02,45.83 L62.63,46.63 L63.05,47.10 L63.55,47.57 L64.05,47.95 L64.65,48.27 L65.25,48.47 L65.85,48.53 L66.45,48.48 L67.35,48.18 L68.35,47.56 L69.15,46.86 L69.86,46.10 L69.96,46.15 L71.22,48.13 L72.32,49.63 L72.29,49.73 L71.36,50.68 L70.26,51.57 L69.45,52.07 L68.25,52.66 L67.35,52.96 L66.45,53.18 L65.05,53.34 L64.15,53.35 L63.05,53.26 L61.75,52.98 L60.85,52.67 L59.75,52.16 L58.75,51.56 L57.55,50.65 L56.66,49.83 L55.71,48.83 L54.81,47.73 L54.01,46.63 L52.62,44.43 L51.54,42.43 L50.42,40.13 L49.22,37.33 L48.02,34.23 L46.92,31.13 L43.07,19.32 L41.58,15.02 L40.08,11.32 L39.37,9.82 L38.47,8.22 L37.46,6.82 L36.54,5.89 L35.64,5.29 L34.74,4.98 L34.24,4.94 L33.64,4.98 L33.14,5.09 L32.64,5.28 L31.64,5.88 L31.04,6.37 L30.14,7.28 L30.04,7.25 L28.98,5.52 L27.71,3.82 L27.67,3.72 L27.83,3.52 L28.44,2.89 L29.14,2.29 L29.94,1.70 L30.94,1.11 L31.84,0.69 L32.74,0.38 L34.04,0.10 Z M54.04,0.02 L54.85,0.00 L55.85,0.08 L57.05,0.31 L58.45,0.78 L59.15,1.10 L60.05,1.60 L61.55,2.69 L62.76,3.82 L64.17,5.42 L65.48,7.22 L66.59,9.02 L67.89,11.42 L68.88,13.52 L70.19,16.62 L71.18,19.22 L72.48,22.93 L75.56,32.47 L75.69,32.23 L76.27,29.53 L76.77,26.73 L77.32,23.13 L77.64,22.03 L77.93,21.62 L78.26,21.41 L78.66,21.31 L79.16,21.29 L79.66,21.38 L79.96,21.50 L80.39,21.82 L80.68,22.23 L80.84,22.83 L80.80,23.53 L80.09,27.93 L78.89,33.93 L78.18,36.93 L77.71,38.63 L78.33,40.23 L79.12,42.03 L79.93,43.63 L80.63,44.83 L81.44,46.03 L82.26,46.99 L82.96,47.65 L83.86,48.25 L84.76,48.56 L85.46,48.60 L86.26,48.47 L86.96,48.15 L87.66,47.67 L88.46,46.89 L89.09,46.13 L89.89,44.93 L90.87,43.13 L91.90,40.83 L92.90,38.13 L93.79,35.33 L94.59,32.43 L95.40,29.03 L96.01,26.03 L96.52,22.73 L96.63,22.33 L96.86,21.92 L97.17,21.62 L97.56,21.40 L98.07,21.29 L98.47,21.30 L99.07,21.47 L99.45,21.72 L99.79,22.13 L99.99,22.63 L100.00,23.33 L99.11,28.73 L98.50,32.03 L97.80,35.23 L97.29,37.23 L96.69,39.33 L96.00,41.43 L95.39,43.03 L94.59,44.83 L93.98,46.03 L93.10,47.53 L92.18,48.83 L91.42,49.73 L90.26,50.87 L89.36,51.57 L88.26,52.24 L87.36,52.66 L86.46,52.97 L85.16,53.25 L84.06,53.35 L83.16,53.35 L82.06,53.25 L80.66,52.95 L79.76,52.66 L78.86,52.26 L77.96,51.76 L76.96,51.06 L75.89,50.13 L75.01,49.23 L74.33,48.43 L73.44,47.23 L72.23,45.33 L71.03,43.13 L69.72,40.43 L68.52,37.63 L67.43,34.83 L66.22,31.43 L62.49,20.02 L60.98,15.62 L59.98,13.02 L59.29,11.42 L58.47,9.72 L57.67,8.32 L56.67,6.92 L55.65,5.88 L54.75,5.29 L54.25,5.09 L53.75,4.98 L52.85,4.98 L52.35,5.09 L51.65,5.37 L50.65,6.00 L49.35,7.26 L49.25,7.27 L48.08,5.42 L46.84,3.72 L47.65,2.87 L48.45,2.18 L49.25,1.61 L50.15,1.09 L51.25,0.60 L52.25,0.29 L53.25,0.09 Z M15.00,0.12 L16.64,0.03 L17.54,0.09 L18.24,0.20 L19.04,0.38 L19.94,0.68 L21.44,1.40 L22.64,2.19 L24.14,3.48 L25.47,4.92 L26.76,6.62 L27.98,8.52 L29.19,10.72 L30.26,12.92 L31.67,16.22 L32.67,18.82 L33.78,21.92 L37.41,33.13 L39.01,37.83 L40.21,40.93 L40.92,42.53 L41.63,43.93 L42.72,45.73 L43.70,46.93 L44.25,47.45 L44.95,47.96 L45.35,48.16 L45.95,48.37 L46.45,48.46 L47.05,48.46 L47.65,48.35 L48.15,48.16 L48.85,47.78 L49.45,47.33 L50.75,46.10 L51.91,47.93 L53.17,49.63 L52.45,50.44 L51.25,51.45 L50.65,51.86 L49.55,52.46 L48.55,52.85 L47.75,53.08 L46.75,53.26 L45.55,53.36 L44.75,53.34 L43.45,53.18 L42.55,52.97 L41.65,52.66 L40.74,52.26 L39.84,51.75 L39.14,51.27 L38.24,50.56 L37.36,49.73 L36.42,48.73 L35.01,46.93 L33.41,44.43 L32.12,42.03 L30.82,39.23 L29.71,36.53 L28.41,33.03 L26.92,28.63 L24.44,20.90 L24.34,21.07 L24.20,21.62 L23.62,24.43 L23.01,27.93 L22.67,30.53 L22.45,31.23 L22.15,31.63 L21.84,31.87 L21.34,32.06 L21.04,32.09 L20.54,32.06 L20.04,31.88 L19.74,31.68 L19.41,31.33 L19.20,30.83 L19.15,30.33 L19.80,26.03 L20.41,22.73 L21.10,19.42 L22.29,14.72 L20.87,11.22 L20.15,9.72 L19.37,8.32 L18.46,7.02 L17.84,6.32 L17.14,5.70 L16.24,5.19 L15.54,4.98 L14.44,4.98 L13.64,5.18 L12.93,5.50 L11.93,6.20 L11.29,6.82 L10.52,7.72 L9.70,8.92 L8.70,10.72 L7.72,12.92 L6.90,15.12 L6.02,17.92 L5.30,20.62 L4.60,23.73 L3.99,27.03 L3.48,30.63 L3.37,31.03 L3.16,31.43 L2.83,31.76 L2.53,31.94 L2.13,32.07 L1.53,32.08 L1.03,31.96 L0.63,31.73 L0.32,31.43 L0.09,31.03 L0.00,30.73 L0.00,30.03 L0.89,24.33 L1.70,20.12 L2.41,17.12 L3.32,13.92 L4.11,11.62 L5.19,9.02 L6.10,7.22 L7.22,5.42 L8.20,4.12 L9.56,2.72 L10.83,1.71 L12.03,1.01 L13.34,0.48 L14.04,0.29 Z' },
    headphones: { box: '0 0 24 24', w: 13, h: 13, d: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-1a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z' },
  };
  const LOSSLESS = /flac|alac|wav|pcm|aiff?/i, LOSSY = /mp3|mpeg|aac|mp4a|opus|vorbis|ogg/i;
  let deckAt = 0;   // when crossfade.js's addon tick last ran
  const known = new Map();   // song id -> its quality once its copy played: no "Upgrading" again after that
  function quality(st) {
    const { codec = '', tier, sampleRate: sr, bitDepth: bits, bitrate, channels: ch } = st.stream || {};
    const lossless = LOSSLESS.test(codec || '') || (tier === 'LOSSLESS' && !LOSSY.test(codec || ''));
    const kbps = lossless ? (sr && bits ? Math.round(sr * bits * (ch || 2) / 1000) : null) : bitrate;
    const detail = [(codec || 'addon').toUpperCase(), bits && `${bits}-bit`, sr && `${(sr / 1000).toFixed(1)} kHz`, kbps && `${kbps} kbps`, ch && (ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : `${ch} channels`)].filter(Boolean).join(' \u00b7 ');
    const title = `${detail}, ${st.addon?.name || st.addon?.host || 'an addon'}'s copy`;
    if (lossless) return { kind: 'lossless', label: (bits > 16 || sr > 48000) ? 'Hi-Res Lossless' : 'Lossless', glyph: 'wave', title };
    if (bitrate >= 256) return { kind: 'high', label: 'High Quality', glyph: 'headphones', title };
    return null;
  }
  function badgeOf(id, st) {
    if (st.play?.state === 'playing' && st.stream) {
      const q = quality(st);
      known.delete(id); known.set(id, q);
      if (known.size > 200) known.delete(known.keys().next().value);
      return q;
    }
    if (known.has(id)) return youTubeQuality(id);   // its copy played and was handed back: YouTube's own audio again
    if (!(Date.now() - deckAt < 2000)) return youTubeQuality(id);   // the addon deck isn't running (no audio graph): nothing will upgrade
    const pending = st.state === 'looking' || st.state === 'opening' || (st.state === 'found' && !st.why)
      || (st.state === 'ready' && (!st.play || st.play.state === 'fetching' || st.play.state === 'fitting'));
    return pending ? { kind: 'upgrading', label: 'Upgrading Quality', glyph: 'wave', title: 'Looking for a better copy of this song in your addons' } : youTubeQuality(id);
  }
  // YouTube's own audio, by what its player decodes now (crossfade-page.js 'ytAudio'): "High Quality"
  // at 256 kbps or more (Premium's Opus itag 774, AAC 141), nothing for the usual ~130-160 kbps (251, 140)
  let ytAudio = null;
  function youTubeQuality(id) {
    const y = ytAudio;
    if (!y || Date.now() - y.at > 3000 || (id && y.id !== id) || !(y.kbps >= 256)) return null;
    const codec = /^mp4a/i.test(y.codec) ? 'AAC' : (y.codec || 'audio').toUpperCase();
    return { kind: 'high', label: 'High Quality', glyph: 'headphones', title: `${codec} · ${y.kbps} kbps, YouTube's own audio (itag ${y.itag})` };
  }
  // Two places, neither in the bar's row (the label's length changes with the state and moved the
  // bar's parts): a round icon on the corner of the song art in the player bar (in the pill too;
  // the label and the exact format are its tooltip), and the glyph with the label under the big art
  // on the player page.
  const ART_BADGE_ID = 'vivi-addon-art-badge';
  function glyph(el, q) {
    if (el.dataset.kind === q.kind) return;
    const g = GLYPHS[q.glyph], svg = el.querySelector('svg');
    svg.setAttribute('viewBox', g.box); svg.setAttribute('width', g.w); svg.setAttribute('height', g.h);
    svg.firstElementChild.setAttribute('d', g.d);
    el.dataset.kind = q.kind;
  }
  function newSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(document.createElementNS(SVG_NS, 'path'));
    return svg;
  }
  function artBadge(q) {
    let a = document.getElementById(ART_BADGE_ID);
    const wrap = document.querySelector('ytmusic-player-bar .thumbnail-image-wrapper');
    if (!q || !wrap) { if (a) a.hidden = true; return; }
    if (!a) { a = document.createElement('span'); a.id = ART_BADGE_ID; a.className = 'vivi-addon-art-badge'; a.append(newSvg()); }
    if (a.parentElement !== wrap) wrap.append(a);
    glyph(a, q);
    const tip = q.label + ': ' + q.title;
    if (a.title !== tip) a.title = tip;
    a.hidden = false;
  }
  function pageLabel(q) {
    let b = document.getElementById(BADGE_ID);
    const open = document.querySelector('ytmusic-app-layout[player-page-open]');
    const player = open && document.querySelector('ytmusic-player-page #player');
    const panel = player?.parentElement;
    if (!q || !player || !panel || !player.offsetHeight) { if (b) b.hidden = true; return; }
    if (!b) {
      b = document.createElement('span'); b.id = BADGE_ID; b.className = 'vivi-addon-badge';
      const label = document.createElement('span'); label.className = 'vivi-addon-badge-label';
      b.append(newSvg(), label);
    }
    if (b.parentElement !== panel) panel.append(b);
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    // under the art, centred on it (the art's place in its panel is read each check)
    const top = player.offsetTop + player.offsetHeight + 14 + 'px', left = player.offsetLeft + 'px', width = player.offsetWidth + 'px';
    if (b.style.top !== top) b.style.top = top;
    if (b.style.left !== left) b.style.left = left;
    if (b.style.width !== width) b.style.width = width;
    glyph(b, q);
    const label = b.lastElementChild;
    if (label.textContent !== q.label) label.textContent = q.label;
    if (b.title !== q.title) b.title = q.title;
    b.hidden = false;
  }
  function badge() {
    let q = null;
    try { q = badgeOf(curId, statusOf(curId)); } catch { /* no state yet */ }
    try { artBadge(q); } catch { /* no player bar */ }
    try { pageLabel(q); } catch { /* no player page */ }
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

  window.__viviAddonsPage = { statusOf, openFor, lookAhead, fetchFor, note, isOn: () => enabled, deckAlive: () => { deckAt = Date.now(); } };
})();

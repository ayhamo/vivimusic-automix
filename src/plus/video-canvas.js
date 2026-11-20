// Vivimusic Web+: the song's music video as its canvas, first in the phone's source order
// (music video, then Spotify, then Apple). Content-script side of video-canvas-page.js (the page's
// MAIN world, channel 'vivi-vcanvas'), which finds the video and makes the looping clip.
//
// The clip is shown by upstream's own canvas code, in the places it already has (the cover, behind
// the lyrics, the side panel): two thin hooks in content.js (fetchSpotifyCanvas, fetchLyricsCanvas)
// ask window.__viviVideoCanvas(track) first and use its clip like a Spotify Canvas URL.

'use strict';

(() => {
  if (window.__viviVideoCanvas) return;
  const CHANNEL = 'vivi-vcanvas';
  const WAIT_MS = 30000;
  const waiting = new Map();
  let n = 0;
  let enabled = true;

  const ask = (msg, ms = WAIT_MS) => new Promise((resolve) => {
    const reqId = 'vcq' + (++n);
    const t = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, why: `no answer in ${ms / 1000} s` }); }, ms);
    waiting.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    window.postMessage({ ch: CHANNEL, dir: 'in', reqId, ...msg }, window.location.origin);
  });

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'out') return;
    if (d.type === 'fetch') {
      // bytes the page may not fetch itself (CORS): only YouTube's image and media hosts
      let host = '';
      try { host = new URL(d.url).hostname; } catch { /* bad URL */ }
      const reply = (m, transfer) => window.postMessage({ ch: CHANNEL, dir: 'in', op: 'fetch', rid: d.rid, ...m }, window.location.origin, transfer);
      if (!/(^|\.)(ytimg\.com|googlevideo\.com)$/.test(host)) { reply({ ok: false, why: 'host not allowed' }); return; }
      fetch(d.url, { credentials: 'omit' })
        .then(async (r) => { const bytes = await r.arrayBuffer(); reply({ ok: r.ok, status: r.status, bytes }, [bytes]); })
        .catch((err) => reply({ ok: false, why: String(err?.message || err) }));
      return;
    }
    const done = waiting.get(d.reqId);
    if (done) { waiting.delete(d.reqId); done(d); }
  });

  const none = new Set();   // songs with no music video (the page keeps the clips themselves)

  // on while 'video' is among the sources on (canvas.md §13, src/plus/canvas-settings.js); a change
  // to the sources, the order, the quality or the mode forgets the "no video" marks (rule 10)
  const CS = globalThis.__viviCanvasSettings;
  let quality = CS?.KEYS.videoCanvasQuality || '480', mode = 'clips';   // rules 6-7, sent with each lookup
  const SET_KEYS = ['canvasSourceOrder', 'canvasSourcesOn', 'videoCanvasQuality', 'videoCanvasMode', 'spotifyCanvasEnabled'];
  chrome.storage.local.get({ canvasSourcesOn: '', videoCanvasQuality: quality, videoCanvasMode: mode }).then((s) => {
    if (CS) { const r = CS.read(s); enabled = r.on.includes('video'); quality = r.videoQuality; mode = r.mode; }
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !SET_KEYS.some((k) => k in ch)) return;
    if (ch.canvasSourcesOn && CS) enabled = CS.parseEnabled(ch.canvasSourcesOn.newValue).includes('video');
    if (ch.videoCanvasQuality && CS) quality = CS.read({ videoCanvasQuality: ch.videoCanvasQuality.newValue }).videoQuality;
    if (ch.videoCanvasMode) mode = ch.videoCanvasMode.newValue === 'full' ? 'full' : 'clips';
    none.clear();
  });

  // The video's own black bars (letterbox, measured on the storyboard) are zoomed out of the frame,
  // wherever upstream shows the clip: one CSS rule per clip, matched by its blob URL.
  const zooms = new Map();
  const isOwnBlob = (u) => typeof u === 'string' && u.startsWith('blob:' + window.location.origin + '/');
  let zoomStyle = null;
  function zoomBars(url, bars) {
    if (!Array.isArray(bars) || bars.length !== 4 || !isOwnBlob(url)) return;
    const keep = Math.min(1 - bars[0] - bars[2], 1 - bars[1] - bars[3]);
    if (!(keep > 0.5 && keep < 0.98)) return;
    zooms.set(url, (1 / keep).toFixed(3));
    if (zooms.size > 8) zooms.delete(zooms.keys().next().value);
    if (!zoomStyle) { zoomStyle = document.createElement('style'); zoomStyle.id = 'vivi-video-canvas-zoom'; (document.head || document.documentElement).append(zoomStyle); }
    zoomStyle.textContent = [...zooms].map(([u, k]) => `video[src="${CSS.escape(u)}"] { transform: scale(${k}) !important; }`).join('\n');
  }

  // The song's synced lyrics, as upstream's lyrics view fetched them (lyrics.js fetchBestLyrics), go to the
  // page for the chorus (canvas.md §6 rule 11). Wrapped, not fetched again: the canvas never fetches lyrics.
  const lyrics = window.__viviLyrics;
  if (lyrics?.fetchBestLyrics && !lyrics.viviChorusWrapped) {
    const fetchBest = lyrics.fetchBestLyrics;
    lyrics.fetchBestLyrics = async (track, opts) => {
      const r = await fetchBest(track, opts);
      try {
        if (track?.videoId && r && r.mode !== 'plain' && Array.isArray(r.lines)) {
          const lines = r.lines.map((l) => ({ start: l.start, text: l.text || '' }));
          window.postMessage({ ch: CHANNEL, dir: 'in', op: 'chorus', id: track.videoId, durationSec: track.duration || 0, lines }, window.location.origin);
        }
      } catch { /* the lyrics view still gets its answer */ }
      return r;
    };
    lyrics.viviChorusWrapped = true;
  }

  // the clip's blob URL for the playing song, or null (no music video, or turned off).
  // which = 'spotify': only the song's length, for the Spotify match (the video comes later in the order)
  window.__viviVideoCanvas = async (track, which) => {
    if (!track?.videoId || !track.song) return null;
    if (!enabled || which === 'spotify' || none.has(track.videoId)) {
      // no lookup, but the Spotify match still gets the song's length (the player's, by id)
      const r = await ask({ op: 'length', id: track.videoId }, 2000);   // (a read, never a download)
      if (r?.songSec > 0) track.lengthSec = r.songSec;
      return null;
    }
    const r = await ask({ op: 'find', id: track.videoId, title: track.song, artist: track.artist || '', album: track.album || '', quality, mode });
    // the song's length by its id (the player's, not a <video> that may still hold the last song): for the Spotify match
    if (r?.songSec > 0) track.lengthSec = r.songSec;
    const url = r?.ok && isOwnBlob(r.blobUrl) ? r.blobUrl : null;
    if (url) zoomBars(url, r.bars);
    console.info('[ViVi video canvas]', `'${track.song}':`, url ? `the music video ${r.videoId} from ${Math.round(r.startSec)} s (${r.from})` : `none (${r?.why || 'no answer'})`);
    if (!url && r?.none === true) {   // only a real 'no music video', never a network error
      none.add(track.videoId);
      if (none.size > 200) none.delete(none.values().next().value);
    }
    return url;
  };
})();

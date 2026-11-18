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

  const ask = (msg) => new Promise((resolve) => {
    const reqId = 'vcq' + (++n);
    const t = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, why: 'no answer in 30 s' }); }, WAIT_MS);
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

  chrome.storage.local.get({ videoCanvasEnabled: true }).then((s) => { enabled = s.videoCanvasEnabled !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.videoCanvasEnabled) enabled = ch.videoCanvasEnabled.newValue !== false;
  });

  const none = new Set();   // songs with no music video (the page keeps the clips themselves)

  // The video's own black bars (letterbox, measured on the storyboard) are zoomed out of the frame,
  // wherever upstream shows the clip: one CSS rule per clip, matched by its blob URL.
  const zooms = new Map();
  let zoomStyle = null;
  function zoomBars(url, bars) {
    if (!Array.isArray(bars) || bars.length !== 4) return;
    const keep = Math.min(1 - bars[0] - bars[2], 1 - bars[1] - bars[3]);
    if (!(keep > 0.5 && keep < 0.98)) return;
    zooms.set(url, (1 / keep).toFixed(3));
    if (zooms.size > 8) zooms.delete(zooms.keys().next().value);
    if (!zoomStyle) { zoomStyle = document.createElement('style'); zoomStyle.id = 'vivi-video-canvas-zoom'; (document.head || document.documentElement).append(zoomStyle); }
    zoomStyle.textContent = [...zooms].map(([u, k]) => `video[src="${u}"] { transform: scale(${k}) !important; }`).join('\n');
  }

  // the clip's blob URL for the playing song, or null (no music video, or turned off)
  window.__viviVideoCanvas = async (track) => {
    if (!enabled || !track?.videoId || !track.song) return null;
    if (none.has(track.videoId)) return null;
    const r = await ask({ op: 'find', id: track.videoId, title: track.song, artist: track.artist || '' });
    const url = r?.ok && r.blobUrl ? r.blobUrl : null;
    if (url) zoomBars(url, r.bars);
    console.info('[ViVi video canvas]', `'${track.song}':`, url ? `the music video ${r.videoId} from ${Math.round(r.startSec)} s (${r.from})` : `none (${r?.why || 'no answer'})`);
    if (!url && !/no answer|not this time/.test(r?.why || '')) {
      none.add(track.videoId);
      if (none.size > 200) none.delete(none.values().next().value);
    }
    return url;
  };
})();

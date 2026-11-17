/**
 * VIVIMUSIC XTEN — seek-page.js (runs in the page's own JS world)
 *
 * Lets the isolated-world content script ask YouTube Music's player to seek
 * through its own API (movie_player.seekTo), which keeps the player, progress
 * bar and state in sync, instead of only poking <video>.currentTime.
 *
 * Talks to lyrics-ui.js over window.postMessage (the same mechanism the
 * crossfade bridge uses), which works the same in Chromium and Firefox —
 * unlike custom-event payloads, which Firefox hides across the content-script /
 * page boundary:
 *   window.postMessage({ ch: 'vivi-seek', t: <seconds> }, location.origin)
 */
(() => {
  'use strict';
  if (window.__VIVI_SEEK_BRIDGE__) return;
  window.__VIVI_SEEK_BRIDGE__ = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.ch !== 'vivi-seek') return;
    const t = Number(e.data.t);
    if (!Number.isFinite(t) || t < 0) return;
    try {
      const p = document.getElementById('movie_player');
      if (p && typeof p.seekTo === 'function') p.seekTo(t, true);
    } catch (_) { /* the caller also sets <video>.currentTime as a fallback */ }
  });
})();

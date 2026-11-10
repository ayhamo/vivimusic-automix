/**
 * VIVIMUSIC XTEN — layout-compat.js
 *
 * Support for YouTube Music's layout A/B test: some accounts get no
 * <ytmusic-player-bar> and a <ytmusic-miniplayer> instead. Nothing here does
 * anything unless "Layout compatibility mode" is switched on in the popup
 * (Appearance) AND the page really has that layout. Otherwise every function
 * below answers "no opinion" and the main code behaves exactly as usual.
 */
(() => {
  'use strict';

  const CLASS = 'vivi-layout-compat';

  const state = { on: false };
  function setOn(v) {
    state.on = v === true;
    syncClass();
  }
  try { chrome.storage.local.get({ layoutCompatEnabled: false }, (r) => setOn(r.layoutCompatEnabled)); } catch { /* no-op */ }

  const hasClassicBar = () => !!document.querySelector('ytmusic-player-bar');
  // true only when the setting is on AND this account really has the new layout
  const active = () => state.on && !hasClassicBar();

  // Keeps the styling class on <html> in step with the detected layout.
  function syncClass() {
    document.documentElement.classList.toggle(CLASS, active());
  }

  // ── Hooks used by content.js / kawarp-bg.js ──────────────────────────────

  function getMiniplayer() {
    return active() ? document.querySelector('ytmusic-miniplayer') : null;
  }

  // navigator.mediaSession is filled in by YouTube Music on both layouts.
  function mediaSessionTrack() {
    if (!active()) return null;
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.title || !md.artist) return null;
      return {
        song: String(md.title).trim(),
        artist: String(md.artist).split(' • ')[0].trim(),
        album: md.album ? String(md.album).trim() : null,
      };
    } catch { return null; }
  }

  function mediaSessionArt() {
    try {
      const list = Array.from((navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork) || []);
      list.sort((a, b) => (parseInt(b.sizes, 10) || 0) - (parseInt(a.sizes, 10) || 0));
      return list[0] ? (list[0].src || '') : '';
    } catch { return ''; }
  }

  // Cover URL for the page background when there is no classic bar thumbnail.
  function fallbackArtworkUrl() {
    if (!active()) return null;
    const big = document.querySelector('ytmusic-player #song-image img');
    const src = (big && (big.currentSrc || big.src)) || '';
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) return src;
    return mediaSessionArt() || null;
  }

  // Full-player detection.
  //  • returns undefined  → "no opinion": main code uses its normal checks.
  //    This is the case whenever YouTube still exposes its usual state
  //    attributes (true on the layout test seen so far).
  //  • returns true/false → only when ALL those attributes are gone.
  // It measures ONLY <ytmusic-player-page>. It must never measure the artwork
  // or #song-media-window: a Spotify Canvas hides the native artwork, which
  // collapses that area, and that made the player look "closed" in a loop.
  let lastActiveAt = 0;
  function playerPageActive() {
    if (!active()) return undefined;
    const hasFlags = document.querySelector(
      'ytmusic-player[player-ui-state], ytmusic-app-layout[player-ui-state], ' +
      'ytmusic-player-page[player-page-ui-state], ytmusic-player-page[player-page-open], ' +
      'ytmusic-app-layout[player-page-open]'
    );
    if (hasFlags) return undefined;
    const page = document.querySelector('ytmusic-player-page');
    if (!page) return false;
    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    const r = page.getBoundingClientRect();
    const covers = r.width > vw * 0.5 && r.height > vh * 0.5 && r.top < vh * 0.5 && r.bottom > vh * 0.5;
    if (covers) { lastActiveAt = Date.now(); return true; }
    return Date.now() - lastActiveAt < 400; // brief hold so a transition can't flicker
  }

  // Kawarp: React only when YouTube's own cover really changed.
  let lastCoverKey = null;
  function shouldApplyCover(key) {
    if (!active()) return true;
    if (key === lastCoverKey) return false;
    lastCoverKey = key;
    return true;
  }
  function coverImg() {
    return active() ? (document.querySelector('ytmusic-player #song-image img') || document.querySelector('ytmusic-miniplayer img')) : null;
  }
  function coverWatchEl() {
    return active() ? document.querySelector('ytmusic-player #song-image') : null;
  }


  // ── Time label ───────────────────────────────────────────────────────────
  // In the new miniplayer YouTube's own time display can be hidden or empty
  // (seen inside the floating pill). When that happens, show elapsed / total
  // time ourselves, read straight from the <video>. Removed again whenever
  // YouTube's own time display is visible.
  const fmt = (t) => {
    if (!isFinite(t) || t < 0) return '0:00';
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  function removeTimeLabel() {
    document.querySelectorAll('.vivi-compat-time').forEach((el) => el.remove());
  }
  function tickTime() {
    syncClass();
    if (!active()) { removeTimeLabel(); return; }
    const mini = document.querySelector('ytmusic-miniplayer');
    const right = mini && mini.querySelector('.ytMusicMiniPlayerRightSection');
    if (!right) { removeTimeLabel(); return; }
    const own = right.querySelector('.ytMusicMiniPlayerTimeInfo');
    const ownVisible = !!own && own.getBoundingClientRect().width > 20 && /\d/.test(own.textContent || '');
    if (ownVisible) { removeTimeLabel(); return; }
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!video) { removeTimeLabel(); return; }
    let label = right.querySelector('.vivi-compat-time');
    if (!label) {
      label = document.createElement('span');
      label.className = 'vivi-compat-time';
      const anchor = right.querySelector('yt-video-action-bar-view-model');
      if (anchor) right.insertBefore(label, anchor); else right.appendChild(label);
    }
    const text = fmt(video.currentTime) + ' / ' + fmt(video.duration);
    if (label.textContent !== text) label.textContent = text;
  }
  setInterval(tickTime, 500);

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'VIVI_SETTINGS' && 'layoutCompatEnabled' in msg) setOn(msg.layoutCompatEnabled);
      return false;
    });
  } catch { /* no-op */ }

  syncClass();

  window.__viviLayoutCompat = { getMiniplayer, mediaSessionTrack, fallbackArtworkUrl, playerPageActive, shouldApplyCover, coverImg, coverWatchEl };
})();

/**
 * VIVIMUSIC XTEN — layout-compat.js
 *
 * Support for YouTube Music's layout A/B test: some accounts get no
 * <ytmusic-player-bar> and a <ytmusic-miniplayer> instead. Nothing here does
 * anything unless "Layout compatibility mode" is on in the popup
 * (Appearance, on by default) AND the page really has that layout. Otherwise every function
 * below answers "no opinion" and the main code behaves exactly as usual.
 * The setting is ON by default: on the classic layout (a <ytmusic-player-bar>
 * exists) active() is always false, so nothing changes for those accounts.
 */
(() => {
  'use strict';

  const CLASS = 'vivi-layout-compat';

  const state = { on: true }; // default ON: harmless on the classic layout (active() needs no classic bar)
  function setOn(v) {
    state.on = v !== false;
    syncClass();
  }
  try { chrome.storage.local.get({ layoutCompatEnabled: true }, (r) => setOn(r.layoutCompatEnabled !== false)); } catch { /* no-op */ }

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

  // ── Fullscreen: minimize button + click safety ───────────────────────────
  // The new miniplayer has no way to leave Vivi's fullscreen view, so add one
  // while fullscreen is active. It is removed again as soon as fullscreen ends.
  const isFs = () => !!document.fullscreenElement ||
    !!document.querySelector('ytmusic-app-layout[player-fullscreened], ytmusic-player-page[player-fullscreened]');

  function exitFullscreen() {
    try { if (document.fullscreenElement) { document.exitFullscreen(); return; } } catch { /* fall through */ }
    // Not real DOM fullscreen: use YouTube's own control if one exists.
    const native = Array.from(document.querySelectorAll('button, yt-icon-button, tp-yt-paper-icon-button'))
      .find((b) => !b.closest('.vivi-compat-minimize') &&
        /exit\s*full\s*-?\s*screen|minimi[sz]e|collapse/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''));
    if (native) { native.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  const MIN_ICON =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
    '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';

  function removeMinimizeBtn() {
    document.querySelectorAll('.vivi-compat-minimize').forEach((el) => el.remove());
  }
  function syncMinimizeBtn(mini) {
    if (!isFs() || !mini) { removeMinimizeBtn(); return; }
    const right = mini.querySelector('.ytMusicMiniPlayerRightSection') || mini;
    if (right.querySelector('.vivi-compat-minimize')) return;
    removeMinimizeBtn();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vivi-compat-minimize';
    btn.title = 'Minimize (exit fullscreen)';
    btn.setAttribute('aria-label', 'Minimize (exit fullscreen)');
    btn.innerHTML = MIN_ICON;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exitFullscreen(); });
    right.appendChild(btn); // last, so it sits at the far right
  }

  // The theme makes the full-player layer ([slot=player-page]) a fixed,
  // full-viewport box. In the new layout that box covers the whole bottom bar,
  // and raising only <ytmusic-miniplayer>'s own z-index cannot beat it because
  // the miniplayer lives inside a lower stacking context. So raise the whole
  // chain of containers from the miniplayer up to the app layout. Then the real
  // buttons get hover + clicks, and a click on empty space reaches YouTube's own
  // "collapse the full player" handler again.
  const Z = '100000';
  function ensureClickable(mini) {
    if (!mini) return;
    const host = document.querySelector('ytmusic-app-layout') || document.getElementById('layout');
    let top = mini;
    for (let n = mini; n && n !== host && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      top = n;
      const cs = getComputedStyle(n);
      if (cs.position !== 'static' || n === mini) {
        if (n.style.getPropertyValue('z-index') !== Z) n.style.setProperty('z-index', Z, 'important');
      }
    }
    // The container that is a direct child of the app layout is what competes
    // with the player-page slot: make sure it takes part in stacking.
    if (top !== document.body && top !== host && getComputedStyle(top).position === 'static') {
      top.style.setProperty('position', 'relative', 'important');
      top.style.setProperty('z-index', Z, 'important');
    }
    if (mini.style.getPropertyValue('pointer-events') !== 'auto') mini.style.setProperty('pointer-events', 'auto', 'important');
    passThroughOverlays(mini);
  }

  // Generic safety net for the same problem: any EMPTY <div> (no children, no
  // text) that sits above the miniplayer at a few points along the bar is a
  // decorative background layer, so make it click-through.
  function passThroughOverlays(mini) {
    if (mini.hidden) return;
    const r = mini.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) return;
    const y = r.top + r.height / 2;
    for (const fx of [0.08, 0.5, 0.92]) {
      let stack;
      try { stack = document.elementsFromPoint(r.left + r.width * fx, y); } catch { continue; }
      for (const el of stack) {
        if (mini.contains(el)) break;                 // reached the miniplayer: done
        if (el.contains(mini)) continue;              // an ancestor of it: fine
        if (el.tagName === 'DIV' && el.childElementCount === 0 && !(el.textContent || '').trim() &&
            el.style.getPropertyValue('pointer-events') !== 'none') {
          el.style.setProperty('pointer-events', 'none', 'important');
          el.setAttribute('data-vivi-passthru', '1');
        }
      }
    }
  }

  function tickTime() {
    syncClass();
    if (!active()) { removeTimeLabel(); removeMinimizeBtn(); return; }
    const mini = document.querySelector('ytmusic-miniplayer');
    syncMinimizeBtn(mini);
    ensureClickable(mini);
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

  // ── Click forwarding (stock miniplayer) ──────────────────────────────────
  // If a transparent layer inside/over the miniplayer (e.g. its "click anywhere
  // to open/close the player" surface) receives the click instead of the button
  // drawn under the pointer, the button seems dead while a click on the body
  // still toggles the full player. Hit-test the buttons by screen position in
  // the capture phase and click the right one ourselves. Normal clicks (target
  // already inside a button) and the body click are left completely alone.
  const BTN_SEL = 'button, [role="button"], yt-icon-button, tp-yt-paper-icon-button, a[href]';
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || e.button !== 0 || !active()) return;
    const mini = document.querySelector('ytmusic-miniplayer');
    if (!mini || mini.hidden) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest(BTN_SEL) && mini.contains(t.closest(BTN_SEL))) return; // works already
    const mr = mini.getBoundingClientRect();
    if (e.clientX < mr.left || e.clientX > mr.right || e.clientY < mr.top || e.clientY > mr.bottom) return;
    let best = null, bestArea = Infinity;
    mini.querySelectorAll(BTN_SEL).forEach((b) => {
      if (b.closest('.vivi-compat-minimize') || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > mr.width * 0.6) return; // skip full-size tap surfaces
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const cs = getComputedStyle(b);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const area = r.width * r.height;
      if (area < bestArea) { best = b; bestArea = area; }
    });
    if (!best) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    best.click();
  }, true);

  setInterval(tickTime, 500);
  document.addEventListener('fullscreenchange', tickTime);

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'VIVI_SETTINGS' && 'layoutCompatEnabled' in msg) setOn(msg.layoutCompatEnabled);
      return false;
    });
  } catch { /* no-op */ }

  syncClass();

  window.__viviLayoutCompat = { getMiniplayer, mediaSessionTrack, fallbackArtworkUrl, playerPageActive, shouldApplyCover, coverImg, coverWatchEl };
})();

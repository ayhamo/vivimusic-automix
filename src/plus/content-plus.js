/* Vivimusic Web+ — content-P.js  (content script, isolated world)
 *
 * Our additions to upstream's content.js, kept out of that file so upstream
 * merges stay small. Loads BEFORE src/content.js (same content_scripts
 * group) and fills window.__viviPlus.content, which content.js reads once
 * as VP; content.js calls in through its `// vivi+ hook` lines:
 *
 *   bind(ctx)                 content.js's private helpers (placed right
 *        before handleTrackChange, where these features used to live);
 *        starts the timers and the Shift+D listener below
 *   themeCss(on, existing)    theme.css through the background's insertCSS
 *   purgeNotFound(all, prefix) one-time drop of saved "no Canvas" results
 *   adIsShowing()             an ad is playing (says nothing about the song)
 *   fetchCanvasData(track, artworkFn)  Apple lookup that tells "failed"
 *        apart from "no Canvas" and carries Apple's second rendition
 *   appleRadiusFor / applyAppleRadius / appleRadius / appleRadiusWatch /
 *   appleFrame                rounded corners on the Apple overlays
 *   syncCanvasWithSong(playing)  Canvas media pause/resume with the song
 *   lyricsCanvas / setLyricsCanvas / canvasSettings  Spotify Canvas behind
 *        the lyrics or the side panel, plus the blur settings
 *   newTrack / settings / storageDefaults / applyStored  wheel volume,
 *        Apple artist art, nerd stats
 *   listenbrainz.{resourceSaver, reset, tick, settings}  ListenBrainz
 */
(() => {
  'use strict';

  const plus = (window.__viviPlus = window.__viviPlus || {});
  const P = (plus.content = {});

  // content.js helpers, from bind(). Every hook that needs them runs after
  // bind() (they are async callbacks, timers or track changes).
  let C = {
    log: () => {}, warn: () => {}, getVideoEl: () => null, getCurrentTrack: () => null,
    isMainPlayerPageActive: () => false, trackKey: () => null, lastfm: () => ({}), lastfmStartedAt: () => 0,
  };
  const log = (...a) => C.log(...a);
  const warn = (...a) => C.warn(...a);

  // ───────────────────────── Theme CSS via the background ─────────────────────────
  let themeCssInjected = false;
  function requestThemeCss(on, attempt) {
    try {
      chrome.runtime.sendMessage({ type: 'VIVI_THEME_CSS', on }, (res) => {
        void chrome.runtime.lastError;
        // Retry a couple of times (e.g. background still starting up).
        if (on && !res?.ok && attempt < 2 && themeCssInjected) {
          setTimeout(() => { if (themeCssInjected) requestThemeCss(true, attempt + 1); }, 800 * (attempt + 1));
        }
      });
    } catch { /* extension context gone */ }
  }

  // theme.css is injected by the background script (scripting.insertCSS)
  // instead of a <link> to a chrome-extension:// URL. The browser refuses
  // that kind of page-side load in some situations ("Unsafe attempt to
  // load URL … Domains, protocols and ports must match"), which was logged
  // as an error on the extensions page. insertCSS has no such check.
  // on: returns true when applyTheme must stop here (already injected).
  P.themeCss = (on, existing) => {
    if (on) {
      if (existing) existing.remove(); // leftover <link> from an older version
      if (themeCssInjected) return true;
      themeCssInjected = true;
      requestThemeCss(true, 0);
      return false;
    }
    if (themeCssInjected) { themeCssInjected = false; requestThemeCss(false, 0); }
    return false;
  };

  // ───────────────────────── Saved "no Canvas" cleanup ─────────────────────────
  // One-time cleanup: older builds saved failed lookups (for example while
  // the background page was broken) as "no Canvas", which hid the Canvas
  // of those songs forever. Drop every saved "no Canvas" once so they are
  // looked up again. Returns the entries content.js should load.
  P.purgeNotFound = (all, prefix) => {
    if (!all) return {};
    const purge = !all.viviCanvasNotFoundPurgedV1;
    if (!purge) return all;
    const kept = {};
    const stale = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(prefix) && v && v.notFound) { stale.push(k); continue; }
      kept[k] = v;
    }
    chrome.storage.local.remove(stale, () => {
      chrome.storage.local.set({ viviCanvasNotFoundPurgedV1: true });
      if (stale.length) log('cleared', stale.length, 'saved "no Canvas" results so they are looked up again');
    });
    return kept;
  };

  // ───────────────────────── Ads are not music videos ─────────────────────────
  // A YouTube ad playing before the song is a 16:9 video too; judging the
  // track then marked songs as music videos ("Lyrics are off for video
  // songs", no Canvas). While an ad shows, nothing is known about the song.
  function adIsShowing() {
    return !!document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
  }
  P.adIsShowing = adIsShowing;

  // ───────────────────────── Apple Canvas lookup ─────────────────────────
  // Resolves { videoUrl } (null = this song has no Canvas) or { failed: true }
  // when the lookup itself broke, which must not be cached as "no Canvas".
  async function fetchAppleCanvasDirect(track) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VIVI_APPLE_CANVAS_DIRECT',
        track: { song: track.song, artist: track.artist, album: track.album || null },
      });
      if (!res || res.error) {
        warn('Apple Canvas lookup failed:', res?.error || 'no reply');
        return { failed: true };
      }
      return { videoUrl: res.videoUrl || null, fallbackUrl: res.fallbackUrl || null };
    } catch (err) {
      warn('Apple Canvas (direct) message failed:', err.message);
      return { failed: true };
    }
  }

  // Replaces the body of content.js's fetchCanvasData. artworkFn starts the
  // iTunes artwork fetch (after the Apple request, as before).
  P.fetchCanvasData = async (track, artworkFn) => {
    const [canvas, artworkResult] = await Promise.all([
      fetchAppleCanvasDirect(track),
      artworkFn(),
    ]);
    if (canvas.failed) return null;   // try again next time instead of caching "no Canvas"
    const videoUrl = canvas.videoUrl;
    if (!videoUrl) return { videoUrl: null, imageUrl: null, notFound: true };
    const imageUrl = artworkResult?.imageUrl || null;
    return { videoUrl, fallbackVideoUrl: canvas.fallbackUrl || null, imageUrl, notFound: false };
  };

  // ───────────────────────── Apple overlay corner radius ─────────────────────────
  let appleStateObserver = null;
  let appleRadiusTimer = null;

  // Corner radius (px) the artwork is clipped to: the nearest ancestor with a
  // rounded corner. Firefox clips a cross-process <iframe> to a rounded box
  // without anti-aliasing (jagged corners), so the radius is handed to the
  // iframe page, which rounds its own <video> — that is ordinary, smoothly
  // anti-aliased content.
  function appleCornerRadius(el, fallback) {
    // What the eye sees is the LARGEST curve among the image itself and any
    // ancestor that really clips it (overflow != visible) — e.g. an 8px image
    // inside a 20px-rounded, overflow:hidden player shows a 20px corner.
    let best = 0, n = el, hops = 0;
    while (n && n !== document.documentElement && hops++ < 7) {
      const cs = getComputedStyle(n);
      const v = cs.borderTopLeftRadius || '';
      const r = v.endsWith('%') ? 0 : (parseFloat(v) || 0);
      const clips = n === el || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (clips && r > best) best = r;
      n = n.parentElement;
    }
    return best > 0 ? Math.min(best, 48) : fallback;
  }

  // The theme's own artwork radii (theme.css :root). These never change, unlike
  // the computed radius above, which can read 0 for a moment while YT Music is
  // still switching between the mini and full player.
  function appleThemeRadius(imgEl) {
    if (!document.documentElement.classList.contains('vivi-theme-on')) return 0;
    const bar = !!imgEl.closest('ytmusic-player-bar');
    const v = getComputedStyle(document.documentElement).getPropertyValue(bar ? '--radius-art' : '--radius-art-lg');
    return parseFloat(v) || (bar ? 8 : 20);
  }

  function appleRadiusFor(imgEl) {
    // "Full screen mode": the artwork is full-bleed against the screen edge, so
    // the overlay must not get the thumbnail's rounded corners (they would
    // show as dark wedges in the screen corners).
    if (document.documentElement.classList.contains('vivi-fs-mode') &&
        !imgEl.closest('ytmusic-player-bar') &&
        document.querySelector('ytmusic-player-page[player-fullscreened]:not([video-mode])')) {
      return 0;
    }
    return Math.max(appleCornerRadius(imgEl, 0), appleThemeRadius(imgEl));
  }

  // Re-check every overlay's radius. Called on a timer and after player-state
  // changes, because a radius read while the player is mid-transition (or
  // before YT Music has applied its classes) can be stale.
  function resyncAppleRadii() {
    document.querySelectorAll('.vivi-canvas-media[data-vivi-apple-overlay="1"]').forEach((el) => {
      const img = el.parentElement && el.parentElement.querySelector('img:not(.vivi-canvas-media)');
      if (img) applyAppleRadius(el, appleRadiusFor(img));
    });
  }

  // Give an Apple overlay the SAME rounded corners as the native thumbnail it
  // sits on. In Firefox the overlay's CSS `border-radius: inherit` picks up the
  // wrapper's radius (often 0 — YT Music rounds the <img> itself, not its
  // wrapper), so the artwork came out square. Copy the thumbnail's own radius
  // instead. +3px because the overlay overshoots its box by 1px on every side,
  // which would otherwise leave the corner arc ~1px outside the thumbnail's.
  // Rounded-rectangle alpha mask built from four corner gradients plus two
  // overlapping bars, so it scales with the element and needs no JS on resize.
  function appleCornerMask(R) {
    if (!(R > 0)) return 'none';
    const tile = `${R}px ${R}px`;
    const stops = `#000 ${R - 0.5}px, transparent ${R + 0.5}px`;
    const bar = `${R - 1}px`, cut = `${2 * R - 2}px`;
    return [
      `radial-gradient(circle at 100% 100%, ${stops}) 0 0 / ${tile} no-repeat`,
      `radial-gradient(circle at 0 100%, ${stops}) 100% 0 / ${tile} no-repeat`,
      `radial-gradient(circle at 100% 0, ${stops}) 0 100% / ${tile} no-repeat`,
      `radial-gradient(circle at 0 0, ${stops}) 100% 100% / ${tile} no-repeat`,
      `linear-gradient(#000, #000) 0 ${bar} / 100% calc(100% - ${cut}) no-repeat`,
      `linear-gradient(#000, #000) ${bar} 0 / calc(100% - ${cut}) 100% no-repeat`
    ].join(', ');
  }

  function applyAppleRadius(el, r) {
    r = Math.max(0, Math.round(r || 0));
    if (el.dataset.viviAppleRadius === String(r)) return;
    el.dataset.viviAppleRadius = String(r);
    if (el.tagName === 'IFRAME') {
      // Firefox clips an out-of-process <iframe> to a rounded box without
      // anti-aliasing (jagged) or not at all, and ignores rounding applied to
      // the <video> inside it. An alpha MASK is composited like any image, so
      // its edge is smooth. The iframe is 1px bigger than the thumbnail on every
      // side, so the arc is r+4: that keeps it just inside the thumbnail's own
      // corner instead of poking out of it.
      el.style.setProperty('border-radius', '0', 'important');
      el.style.setProperty('clip-path', 'none', 'important');
      const m = appleCornerMask(r > 0 ? r + 4 : 0);
      el.style.setProperty('-webkit-mask', m, 'important');
      el.style.setProperty('mask', m, 'important');
    } else {
      const px = (r > 0 ? r + 3 : 0) + 'px';
      el.style.setProperty('border-radius', px, 'important');
      el.style.setProperty('clip-path', r > 0 ? `inset(0 round ${px})` : 'none', 'important');
    }
    console.debug('[Vivi] Apple artwork corner radius →', r + 'px', el.dataset.viviAppleSlot || '');
    if (el.tagName === 'IFRAME') {
      const send = () => {
        try { el.contentWindow?.postMessage({ __viviAppleRadius: Number(el.dataset.viviAppleRadius) || 0 }, '*'); } catch (_) {}
      };
      send();
      el.addEventListener('load', send, { once: true });
    }
  }

  P.appleRadiusFor = appleRadiusFor;
  P.applyAppleRadius = applyAppleRadius;
  P.appleRadius = (el, imgEl) => applyAppleRadius(el, appleRadiusFor(imgEl));

  // Started/stopped with content.js's Apple overlay observer.
  P.appleRadiusWatch = (on) => {
    if (on) {
      // The overlay sync only runs when DOM nodes are added/removed. Minimising
      // or re-opening the player mostly flips attributes, so watch those too and
      // re-check the corner radius while the layout settles.
      appleStateObserver = new MutationObserver(() => {
        [0, 250, 700, 1500].forEach((ms) => setTimeout(resyncAppleRadii, ms));
      });
      appleStateObserver.observe(document.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['player-ui-state', 'player-page-open', 'player-page-ui-state', 'player-fullscreened']
      });
      appleRadiusTimer = setInterval(resyncAppleRadii, 800);
    } else {
      appleStateObserver?.disconnect();
      appleStateObserver = null;
      if (appleRadiusTimer) clearInterval(appleRadiusTimer);
      appleRadiusTimer = null;
    }
  };

  // A fresh (not yet inserted) Apple HLS iframe from makeAppleHlsIframe: hand
  // the corner radius to the player page (&r=, before the #fragment) and set
  // the colour scheme. Same colour scheme on the frame and its document keeps
  // the frame's own background genuinely transparent (a mismatch makes
  // browsers paint it opaque).
  P.appleFrame = (frame, options, wrapper, isMain) => {
    const radius = options.radius !== undefined ? options.radius : appleCornerRadius(wrapper, isMain ? 18 : 8);
    const r = Math.max(0, Math.round(radius || 0));
    frame.src = frame.getAttribute('src').replace('#', `&r=${r}#`);
    frame.style.colorScheme = 'light';
  };

  // ───────────────────────── Canvas pauses with the song ─────────────────────────
  // Canvas videos (Apple animated art, Spotify Canvas) and the lyrics dancer
  // pause with the song and resume with it. While the tab is hidden,
  // updateBackgroundTabMode owns their playback instead.
  let canvasSongPlaying = true;
  function syncCanvasWithSong(playing) {
    if (document.hidden) return;
    const changed = playing !== canvasSongPlaying;
    canvasSongPlaying = playing;
    document.querySelectorAll('.vivi-canvas-media, .vivi-canvas-player-media, .vivi-lyrics-dancer').forEach((media) => {
      if (media.tagName === 'IFRAME') {
        // Pause is re-sent while paused so a frame created meanwhile stops too.
        if (!playing || changed) {
          try { media.contentWindow?.postMessage({ __viviAppleCanvasControl: playing ? 'resume' : 'pause' }, '*'); } catch (_) {}
        }
        return;
      }
      if (!playing) {
        if (!media.paused && !media.dataset.viviDeferredSrc) {
          media.dataset.viviPausedForSong = '1';
          try { media.pause(); } catch (_) {}
        }
      } else if (media.dataset.viviPausedForSong === '1') {
        delete media.dataset.viviPausedForSong;
        media.play?.().catch(() => {});
      }
    });
  }
  P.syncCanvasWithSong = syncCanvasWithSong;

  // ───────────────────────── Spotify Canvas behind the lyrics ─────────────────────────
  // Where the Spotify Canvas plays: 'cover' (on the artwork, the original),
  // 'lyrics' (blurred behind the lyrics) or 'side' (behind the whole side
  // panel). Behind the panel the cover keeps Apple's animated art (or the
  // still cover). Kept apart from content.js's currentSpotifyCanvasUrl,
  // which drives the cover overlay.
  let canvasPlacement = 'cover';
  let lyricsCanvasUrl = null;
  const LYRICS_CANVAS_ID = 'vivi-lyrics-canvas';

  async function fetchLyricsCanvas(track, key) {
    try {
      const mv = await window.__viviVideoCanvas?.(track); // vivi+ hook: the song's music video first
      if (mv) { if (key === C.trackKey() && canvasPlacement !== 'cover') setLyricsCanvas(mv); return; }
      const r = await chrome.runtime.sendMessage({
        type: 'VIVI_SPOTIFY_CANVAS',
        track: { song: track.song, artist: track.artist, videoId: track.videoId },
      });
      if (key !== C.trackKey() || canvasPlacement === 'cover') return;
      if (!r?.ok) { log('No Spotify Canvas for the lyrics background:', r?.error || 'none'); return; }
      setLyricsCanvas(r.videoUrl);
    } catch (e) {
      warn('Spotify Canvas (lyrics background):', e?.message || e);
    }
  }

  function setLyricsCanvas(url) {
    lyricsCanvasUrl = url || null;
    if (!lyricsCanvasUrl) {
      const old = document.getElementById(LYRICS_CANVAS_ID);
      if (old) {
        try { old.pause(); old.removeAttribute('src'); old.load(); } catch (_) {}
        old.remove();
      }
      document.documentElement.classList.remove('vivi-lyrics-canvas-visible');
      return;
    }
    placeLyricsCanvas();
  }
  P.setLyricsCanvas = setLyricsCanvas;

  // YT Music re-renders the side panel freely, so the video is (re)attached
  // and shown only while the full player's Lyrics tab is open.
  function placeLyricsCanvas() {
    if (!lyricsCanvasUrl) return;
    const host = document.querySelector('ytmusic-player-page #side-panel');
    let vid = document.getElementById(LYRICS_CANVAS_ID);
    if (host && (!vid || vid.parentElement !== host)) {
      if (!vid) {
        vid = document.createElement('video');
        vid.id = LYRICS_CANVAS_ID;
        vid.className = 'vivi-lyrics-canvas-media';
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.autoplay = true;
        vid.setAttribute('aria-hidden', 'true');
      }
      host.insertBefore(vid, host.firstChild);
    }
    if (!vid) return;
    if (vid.dataset.src !== lyricsCanvasUrl) {
      vid.dataset.src = lyricsCanvasUrl;
      vid.src = lyricsCanvasUrl;
    }
    const lyricsPanel = document.getElementById('vivi-lyrics-panel');
    const show = C.isMainPlayerPageActive() && (canvasPlacement === 'side'
      ? vid.parentElement?.offsetParent !== null
      : !!lyricsPanel && lyricsPanel.offsetParent !== null);
    document.documentElement.classList.toggle('vivi-lyrics-canvas-visible', show);
    // Plays only while it is visible and the song plays; pauses with the song.
    const shouldPlay = show && !document.hidden && C.getVideoEl()?.paused === false;
    if (shouldPlay && vid.paused) vid.play().catch(() => {});
    else if (!shouldPlay && !vid.paused) vid.pause();
  }

  // handleTrackChange: true = the Spotify Canvas goes behind the lyrics (its
  // lookup started here) and the cover only gets Apple's animated art.
  P.lyricsCanvas = (track, key, spotifyAllowed) => {
    if (!(canvasPlacement !== 'cover' && spotifyAllowed)) return false;
    fetchLyricsCanvas(track, key);
    return true;
  };

  // Blur of the lyric lines around the active one (off / low / normal) and of
  // the Canvas behind the panel (px). Either may be undefined: keep the old.
  const LINE_BLUR = { off: 0, low: 0.4, normal: 1 };
  function applyBlurSettings(lineBlur, canvasBlurPx) {
    const root = document.documentElement.style;
    if (lineBlur in LINE_BLUR) root.setProperty('--vivi-line-blur', String(LINE_BLUR[lineBlur]));
    const px = Number(canvasBlurPx);
    if (canvasBlurPx != null && Number.isFinite(px)) root.setProperty('--vivi-canvas-blur', Math.max(0, Math.min(30, px)) + 'px');
  }

  // Settings message: returns true when the Canvas must be re-checked.
  P.canvasSettings = (msg) => {
    if ('lyricsLineBlur' in msg || 'canvasBlurPx' in msg) applyBlurSettings(msg.lyricsLineBlur, msg.canvasBlurPx);
    if ('spotifyCanvasPlacement' in msg) {
      canvasPlacement = ['lyrics', 'side'].includes(msg.spotifyCanvasPlacement) ? msg.spotifyCanvasPlacement : 'cover';
      setLyricsCanvas(null);
      return true;
    }
    return false;
  };

  // ───────────────────────── Empty player tab strip ─────────────────────────
  // Seen in Firefox (a song started from a library playlist): YT Music's tab
  // strip keeps its 4 tabs in data, but the repeater that draws them has drawn
  // none, so the row above "Playing from" is empty until a page refresh.
  // Asking that repeater to render again brings the tabs back. Its data and
  // render() live in the page's JS world (wrappedJSObject in Firefox); where
  // the content script can't reach them, this does nothing.
  function repairEmptyPlayerTabs() {
    if (document.hidden) return;
    const content = document.querySelector('ytmusic-player-page .tab-header-container #tabsContent');
    const repeat = content?.querySelector(':scope > dom-repeat');
    if (!repeat || content.querySelector('tp-yt-paper-tab')) return;
    try {
      const raw = repeat.wrappedJSObject || repeat;
      if (!(raw.items?.length > 0) || typeof raw.render !== 'function') return;
      raw.render();
      log('player tabs were empty; redrew', content.querySelectorAll('tp-yt-paper-tab').length, 'tabs');
    } catch (_) { /* page objects unavailable */ }
  }

  // ───────────────────────── ListenBrainz ─────────────────────────
  const LISTENBRAINZ_DEFAULTS = {
    listenbrainzEnabled: false,
    listenbrainzSendNowPlaying: true,
  };
  let listenbrainzSettings = { ...LISTENBRAINZ_DEFAULTS };
  let listenbrainzUserEnabled = false;
  let listenbrainzScrobbled = false;
  let listenbrainzSentNowPlaying = false;

  function resetListenbrainzForNewTrack() {
    listenbrainzScrobbled = false;
    listenbrainzSentNowPlaying = false;
  }

  function sendListenbrainzNowPlaying(track) {
    if (!listenbrainzSettings.listenbrainzEnabled || !listenbrainzSettings.listenbrainzSendNowPlaying) return;
    if (listenbrainzSentNowPlaying) return;
    listenbrainzSentNowPlaying = true;
    const video = C.getVideoEl();
    chrome.runtime.sendMessage({
      type: 'VIVI_LISTENBRAINZ_NOWPLAYING',
      track: { artist: track.artist, song: track.song, duration: video?.duration || undefined },
    }).catch(() => {});
  }

  function maybeScrobbleListenbrainz(track) {
    if (!listenbrainzSettings.listenbrainzEnabled || listenbrainzScrobbled) return;
    const video = C.getVideoEl();
    if (!video || !video.duration || Number.isNaN(video.duration)) return;

    const lastfmSettings = C.lastfm();
    const duration = video.duration;
    const elapsed = video.currentTime || 0;
    if (duration < (lastfmSettings.lastfmMinDurationSec || 30)) return;

    const percentThreshold = duration * ((lastfmSettings.lastfmDelayPercent || 50) / 100);
    const minutesThreshold = (lastfmSettings.lastfmDelayMinutes || 3) * 60;
    const threshold = Math.min(percentThreshold, minutesThreshold);

    if (elapsed >= threshold) {
      listenbrainzScrobbled = true;
      chrome.runtime.sendMessage({
        type: 'VIVI_LISTENBRAINZ_SCROBBLE',
        track: { artist: track.artist, song: track.song },
        timestamp: C.lastfmStartedAt(),
      }).catch(() => {});
    }
  }

  P.listenbrainz = {
    // From applyResourceSaverState.
    resourceSaver(resourceSaver) {
      listenbrainzSettings.listenbrainzEnabled = listenbrainzUserEnabled && !resourceSaver;
    },
    reset: resetListenbrainzForNewTrack,
    // From the polling tick, after Last.fm.
    tick(track) {
      if (!listenbrainzSettings.listenbrainzEnabled) return;
      sendListenbrainzNowPlaying(track);
      maybeScrobbleListenbrainz(track);
    },
    // Settings message, before the Last.fm keys.
    settings(msg, resourceSaver) {
      Object.keys(LISTENBRAINZ_DEFAULTS).forEach((k) => {
        if (k in msg) listenbrainzSettings[k] = msg[k];
      });
      if ('listenbrainzEnabled' in msg) {
        listenbrainzUserEnabled = msg.listenbrainzEnabled === true;
        listenbrainzSettings.listenbrainzEnabled = listenbrainzUserEnabled && !resourceSaver;
      }
    },
  };

  // ───────────────────────── Mouse Wheel Volume (from BitChord) ─────────────────────────
  let wheelVolumeEnabled = true;
  const WHEEL_VOLUME_STEP = 0.05;

  function initWheelVolume() {
    window.addEventListener('wheel', (e) => {
      if (!wheelVolumeEnabled) return;
      const target = e.target;
      const playerBar = target?.closest?.('ytmusic-player-bar');
      const playerArt = target?.closest?.('#player, #song-image, ytmusic-player, .song-media-window');
      const volSlider = target?.closest?.('.volume-slider, #sliderBar');

      if (!playerBar && !playerArt && !volSlider) return;

      if (!playerBar && !volSlider && target?.closest?.('#queue, #contents, #lyrics, .ytmusic-player-page-lyrics')) {
        if (!e.altKey && !e.ctrlKey) return;
      }

      const video = document.querySelector('video');
      if (!video) return;

      e.preventDefault();
      const delta = e.deltaY;
      if (delta === 0) return;

      const curVol = video.volume;
      const next = curVol + (delta < 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP);
      const clamped = Math.round(Math.min(1, Math.max(0, next)) * 100) / 100;
      video.volume = clamped;

      window.postMessage({
        ch: 'vivi-xfade',
        dir: 'in',
        type: 'set-volume',
        volume: clamped,
      }, window.location.origin);
    }, { passive: false });
  }

  // ───────────────────────── Apple Artist Hero Art & Palette (from BitChord) ─────────────────────────
  let appleArtistArtEnabled = true;
  let currentAppleArtistArt = null;
  const appleArtistArtCache = new Map();   // artist -> pending/finished lookup

  async function applyAppleArtistArtForTrack(track) {
    if (!appleArtistArtEnabled || !track?.artist) return;
    const cleanArtist = window.__viviLyrics?.cleanArtistForLyrics?.(track.artist) || track.artist;
    try {
      if (!appleArtistArtCache.has(cleanArtist)) {
        appleArtistArtCache.set(cleanArtist, chrome.runtime.sendMessage({ type: 'VIVI_APPLE_ARTIST_ART', artist: cleanArtist }).catch(() => null));
      }
      const res = await appleArtistArtCache.get(cleanArtist);
      if (!res?.ok || !res.art) return;
      currentAppleArtistArt = res.art;

      const root = document.documentElement;
      if (res.art.background) root.style.setProperty('--vivi-apple-bg', res.art.background);
      if (res.art.accent) root.style.setProperty('--vivi-apple-accent', res.art.accent);
      if (res.art.keyColor) root.style.setProperty('--vivi-apple-key', res.art.keyColor);

      const playerBg = document.querySelector('ytmusic-player#player, #main-panel');
      if (playerBg && res.art.background) {
        playerBg.style.setProperty('--ytmusic-player-background-color', res.art.background);
      }
    } catch { /* context gone */ }
  }

  // handleTrackChange, new song (with the lyrics and SponsorBlock work).
  P.newTrack = (track) => { applyAppleArtistArtForTrack(track); };

  // ───────────────────────── Automix "Stats for Nerds" Overlay (from BitChord) ─────────────────────────
  let nerdStatsEnabled = false;
  let nerdStatsEl = null;

  function createNerdStatsOverlay() {
    if (nerdStatsEl) return nerdStatsEl;
    const el = document.createElement('div');
    el.id = 'vivi-nerd-stats';
    el.style.cssText = `
      position: fixed;
      bottom: 84px;
      left: 16px;
      z-index: 999999;
      background: rgba(18, 18, 18, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 11px;
      line-height: 15px;
      color: rgba(255, 255, 255, 0.85);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      display: none;
      max-width: 440px;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    `;

    el.innerHTML = `
      <div id="vivi-nerd-stream" style="font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Stream: Measuring...</div>
      <div id="vivi-nerd-automix" style="margin-top: 2px; color: #ff6599; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Automix: Initializing...</div>
    `;

    document.body.appendChild(el);
    nerdStatsEl = el;
    return el;
  }

  function updateNerdStatsHUD() {
    if (!nerdStatsEnabled) {
      if (nerdStatsEl) nerdStatsEl.style.display = 'none';
      return;
    }

    const hud = createNerdStatsOverlay();
    hud.style.display = 'block';

    const streamEl = hud.querySelector('#vivi-nerd-stream');
    const automixEl = hud.querySelector('#vivi-nerd-automix');

    const video = document.querySelector('video');
    const track = C.getCurrentTrack();
    const g = window.__viviAudioGraph;
    const fmt = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '–');
    const parts = [track ? `${track.song || 'Unknown'} · ${track.artist || ''}` : 'No track'];
    if (video) parts.push(`${fmt(video.currentTime)} / ${fmt(video.duration)}`);
    parts.push(g?.ctx ? `Web Audio ${(g.ctx.sampleRate / 1000).toFixed(1)} kHz (${g.ctx.state})` : 'Web Audio off');
    if (streamEl) streamEl.textContent = parts.join(' | ');

    if (automixEl) {
      const xf = window.__viviCrossfade?.status?.();
      const automix = window.__viviAutomix;
      const engine = automix?.getLiveState?.() || {};
      if (!xf || !xf.seconds) {
        automixEl.textContent = 'Crossfade off (Audio playback → Crossfade)';
        automixEl.style.color = '#888';
      } else if (!automix?.isEnabled()) {
        automixEl.textContent = `Crossfade ${xf.seconds} s · Automix off${xf.live ? ' · mixing' : ''}`;
        automixEl.style.color = '#90caf9';
      } else {
        const m = xf.automix?.mix;
        const state = xf.automix?.state === 'idle' && m ? 'planned' : xf.automix?.state || 'idle';
        let text = `Automix · ${state}`;
        if (engine.bpm) text += ` · ${engine.bpm.toFixed(1)} BPM (grid ${(engine.conf || 0).toFixed(2)})`;
        if (m) text += ` · ${m.style || 'blend'}${m.bars ? ` ${m.bars} bars` : ''} / ${m.mixSec.toFixed(1)} s from ${fmt(m.startAt)}${m.rate && Math.abs(m.rate - 1) > 0.002 ? ` · next ×${m.rate.toFixed(3)}` : ''}`;
        if (m?.reason) text += ` · ${m.reason}`;
        if (state === 'fallback' && engine.reason) text += ` · ${engine.reason}`;
        if (xf.live) text += ' · mixing';
        automixEl.textContent = text;
        automixEl.style.color = xf.live ? '#00e676' : m ? '#ff6599' : state === 'fallback' ? '#ffb300' : '#90caf9';
      }
    }
  }

  // Settings message, after the Canvas re-check.
  P.settings = (msg) => {
    if ('wheelVolumeEnabled' in msg) wheelVolumeEnabled = msg.wheelVolumeEnabled !== false;
    if ('appleArtistArtEnabled' in msg) {
      appleArtistArtEnabled = msg.appleArtistArtEnabled !== false;
      const track = C.getCurrentTrack();
      if (track && appleArtistArtEnabled) applyAppleArtistArtForTrack(track);
    }
    if ('nerdStatsEnabled' in msg) {
      nerdStatsEnabled = msg.nerdStatsEnabled === true;
      updateNerdStatsHUD();
    }
  };

  // ───────────────────────── Stored settings ─────────────────────────
  // Merged into content.js's main settings read; applyStored() gets these
  // keys back right after applyTheme(), before applyResourceSaverState().
  P.storageDefaults = {
    wheelVolumeEnabled: true, appleArtistArtEnabled: true, nerdStatsEnabled: false,
    spotifyCanvasPlacement: 'cover', lyricsLineBlur: 'low', canvasBlurPx: 3,
    ...LISTENBRAINZ_DEFAULTS,
  };

  P.applyStored = (stored) => {
    initWheelVolume();
    canvasPlacement = ['lyrics', 'side'].includes(stored.spotifyCanvasPlacement) ? stored.spotifyCanvasPlacement : 'cover';
    applyBlurSettings(stored.lyricsLineBlur, stored.canvasBlurPx);
    wheelVolumeEnabled = stored.wheelVolumeEnabled !== false;
    appleArtistArtEnabled = stored.appleArtistArtEnabled !== false;
    nerdStatsEnabled = stored.nerdStatsEnabled === true;
    updateNerdStatsHUD();
    // applyResourceSaverState() runs later in the same callback.
    listenbrainzSettings = { ...LISTENBRAINZ_DEFAULTS };
    Object.keys(LISTENBRAINZ_DEFAULTS).forEach((k) => { if (k in stored) listenbrainzSettings[k] = stored[k]; });
    listenbrainzUserEnabled = listenbrainzSettings.listenbrainzEnabled === true;
  };

  // ───────────────────────── bind ─────────────────────────
  P.bind = (ctx) => {
    C = { ...C, ...ctx };
    if (window.__viviTrackInfo) window.__viviTrackInfo.adIsShowing = adIsShowing;

    setInterval(placeLyricsCanvas, 500);
    setInterval(repairEmptyPlayerTabs, 1000);
    // Catches Canvas media that appear while the song is already paused.
    setInterval(() => {
      const video = C.getVideoEl();
      if (video && video.paused && !document.hidden) syncCanvasWithSong(false);
    }, 1000);

    document.addEventListener('keydown', (e) => {
      if (e.shiftKey && (e.key === 'D' || e.key === 'd') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        nerdStatsEnabled = !nerdStatsEnabled;
        chrome.storage.local.set({ nerdStatsEnabled });
        updateNerdStatsHUD();
      }
    }, true);

    setInterval(() => {
      if (nerdStatsEnabled) updateNerdStatsHUD();
    }, 1000);
  };
})();

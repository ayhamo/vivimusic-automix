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
 *   purgeNotFound(all, prefix) one-time drop of saved "no Canvas" results
 *   adIsShowing()             an ad is playing (says nothing about the song)
 *   fetchCanvasData(track, artworkFn)  Apple lookup that tells "failed"
 *        apart from "no Canvas" and carries Apple's second rendition
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

  // ───────────────────────── Canvas pauses with the song ─────────────────────────
  // Canvas videos (Apple animated art, Spotify Canvas) and the lyrics dancer
  // pause with the song and resume with it. While the tab is hidden,
  // updateBackgroundTabMode owns their playback instead.
  let canvasSongPlaying = true;
  // The frames are our apple-canvas-player.html; a frame that went elsewhere does not get the message.
  const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  function syncCanvasWithSong(playing) {
    if (document.hidden) return;
    const changed = playing !== canvasSongPlaying;
    canvasSongPlaying = playing;
    document.querySelectorAll('.vivi-canvas-media, .vivi-canvas-player-media, .vivi-lyrics-dancer').forEach((media) => {
      if (media.tagName === 'IFRAME') {
        // Pause is re-sent while paused so a frame created meanwhile stops too.
        if (!playing || changed) {
          try { media.contentWindow?.postMessage({ __viviAppleCanvasControl: playing ? 'resume' : 'pause' }, EXT_ORIGIN); } catch (_) {}
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

  // each look-up's number: a song's Canvas choice changed while one was out (§15, VP.reCheckCanvas on the
  // same song) starts another, and the older reply, the same song's, must not show over the newer
  let lyricsCanvasGen = 0;
  async function fetchLyricsCanvas(track, key) {
    const gen = ++lyricsCanvasGen;
    const still = () => gen === lyricsCanvasGen && key === C.trackKey() && canvasPlacement !== 'cover';
    try {
      // the Canvas sources (music video, Spotify) in the listener's order, the ones on only (§13), with
      // the song's own choices (§15 rules 2 and 7): its Use first, its switched-off sources left out
      const want = songOrder(track?.videoId).filter((n) => n !== 'apple' && canvasSet.on.includes(n) && !songOff(track?.videoId)[n]);
      if (!want.includes('spotify')) {
        const mv = want.includes('video') ? await window.__viviVideoCanvas?.(track, 'video') : null;
        if (mv && still()) setLyricsCanvas(mv);
        return;
      }
      if (want[0] === 'video') {
        const mv = await window.__viviVideoCanvas?.(track, 'video');
        if (mv) { if (still()) setLyricsCanvas(mv); return; }
      } else await window.__viviVideoCanvas?.(track, 'spotify');   // the song's length for the Spotify match
      const r = await chrome.runtime.sendMessage({
        type: 'VIVI_SPOTIFY_CANVAS',
        track: { song: track.song, artist: track.artist, videoId: track.videoId, album: track.album || null, duration: track.lengthSec || null },
      });
      if (!still()) return;
      if (r?.ok && r.videoUrl) { setLyricsCanvas(r.videoUrl); return; }
      log('No Spotify Canvas for the lyrics background:', r?.error || 'none');
      if (want[1] === 'video') {
        const mv = await window.__viviVideoCanvas?.(track, 'video');
        if (mv && still()) setLyricsCanvas(mv);
      }
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

  // ───────────────────────── Source order (canvas.md §13) ─────────────────────────
  // The listener's order and sources on (src/plus/canvas-settings.js). content.js's
  // handleTrackChange takes the order from here: [name, on, attempt] per source, tried
  // strictly in turn (§1 rule 2: a source still loading holds the ones after it).
  const CS = globalThis.__viviCanvasSettings;
  let canvasSet = CS ? CS.read({}) : { order: ['video', 'spotify', 'apple'], on: ['video', 'spotify', 'apple'] };
  // one song's canvas choices (canvas.md §15), by its id: the track's, else ?v=, else the player's own song
  // (a song started from Home, a playlist or Search has no ?v=; canvas-menu.js saves under the player's id)
  const songChoice = (id) => window.__viviCanvasSongs?.choice(id || new URLSearchParams(location.search).get('v') || C.getCurrentTrack()?.videoId || '') || {};
  const songOff = (id) => { const s = songChoice(id); return { video: !!s.loopOff, spotify: !!s.spotifyOff, apple: !!s.appleOff }; };
  const songOrder = (id) => { const u = songChoice(id).use; return u && canvasSet.order.includes(u) ? [u, ...canvasSet.order.filter((n) => n !== u)] : canvasSet.order; };
  // (with a song: its own switch too, §15 rule 2)
  P.sourceOn = (n, id) => canvasSet.on.includes(n) && !(id !== undefined && songOff(id)[n]);
  P.canvasOrder = CS && ((attempts, canvasOn, appleOn, id) => {
    // one song's canvas (canvas.md §15): its Spotify / Animated cover switches and its Use come first
    const off = songOff(id);
    return songOrder(id).map((n) => [n, (n === 'apple' ? appleOn : canvasOn) && canvasSet.on.includes(n) && !off[n], attempts[n]]);
  });

  // Settings message: returns true when the Canvas must be re-checked.
  P.canvasSettings = (msg) => {
    if (CS && ('canvasSourceOrder' in msg || 'canvasSourcesOn' in msg)) {
      canvasSet = CS.read({ canvasSourceOrder: msg.canvasSourceOrder ?? canvasSet.order.join(','), canvasSourcesOn: msg.canvasSourcesOn ?? CS.storeEnabled(canvasSet.on) });
      setLyricsCanvas(null);
      return true;
    }
    // a new quality or mode: look the song up again (rule 10; the Apple player reads its quality itself)
    if (['appleCoverQuality', 'videoCanvasQuality', 'videoCanvasMode'].some((k) => k in msg)) return true;
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
  const appleArtistArtCache = new Map();   // artist -> pending/finished lookup, the newest 200 artists

  async function applyAppleArtistArtForTrack(track) {
    if (!appleArtistArtEnabled || !track?.artist) return;
    const cleanArtist = window.__viviLyrics?.cleanArtistForLyrics?.(track.artist) || track.artist;
    try {
      if (!appleArtistArtCache.has(cleanArtist)) {
        appleArtistArtCache.set(cleanArtist, chrome.runtime.sendMessage({ type: 'VIVI_APPLE_ARTIST_ART', artist: cleanArtist }).catch(() => null));
        if (appleArtistArtCache.size > 200) appleArtistArtCache.delete(appleArtistArtCache.keys().next().value);
      }
      const key = C.trackKey(), asked = appleArtistArtCache.get(cleanArtist);
      const res = await asked;
      // (a failed lookup isn't kept: the artist is asked again on a later play)
      if (!res?.ok && appleArtistArtCache.get(cleanArtist) === asked) appleArtistArtCache.delete(cleanArtist);
      // (the song moved on while it was asked: a slower answer must not paint over the next artist's)
      if (C.trackKey() !== key) return;
      if (!res?.ok || !res.art || !appleArtistArtEnabled) return;
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
        // the editor's preset (the overview's chip) beside the style the engine plays it as
        const preset = m?.preset && m.preset !== 'auto' ? (m.preset === 'none' ? 'No transition' : m.preset[0].toUpperCase() + m.preset.slice(1)) + ': ' : '';
        if (m) text += ` · ${preset}${m.style || 'blend'}${m.bars ? ` ${m.bars} bars` : ''} / ${m.mixSec.toFixed(1)} s from ${fmt(m.startAt)}${m.rate && Math.abs(m.rate - 1) > 0.002 ? ` · next ×${m.rate.toFixed(3)}` : ''}`;
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
      if (!appleArtistArtEnabled) {   // switched off from the popup: drop the colours already set
        currentAppleArtistArt = null;
        for (const v of ['--vivi-apple-bg', '--vivi-apple-accent', '--vivi-apple-key']) document.documentElement.style.removeProperty(v);
        document.querySelector('ytmusic-player#player, #main-panel')?.style.removeProperty('--ytmusic-player-background-color');
      }
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
    canvasSourceOrder: '', canvasSourcesOn: '',
    ...LISTENBRAINZ_DEFAULTS,
  };

  P.applyStored = (stored) => {
    initWheelVolume();
    canvasPlacement = ['lyrics', 'side'].includes(stored.spotifyCanvasPlacement) ? stored.spotifyCanvasPlacement : 'cover';
    if (CS) canvasSet = CS.read(stored);
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

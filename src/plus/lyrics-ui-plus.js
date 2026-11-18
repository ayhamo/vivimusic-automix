/* Vivimusic Web+ — lyrics-ui-plus.js  (content script, isolated world)
 *
 * Our additions to upstream's lyrics-ui.js, kept out of that file so upstream
 * merges stay small. Loads right BEFORE src/lyrics-ui.js, which reads
 * `window.__viviPlus.lyricsUi` once (as VP) and calls in through its
 * `// vivi+ hook` lines:
 *
 *   tabByPosition(label, tabs)   Lyrics tab by position while all labels are empty
 *   onUserTabClick(cancel)       the user picking a tab ends the Lyrics-tab wait
 *   makeRefreshIcon()            circular-arrow icon
 *   makeRefetchTabButton(refetch) / syncRefetchTabButton(wrap, busy)
 *                                the refresh button above the "i" in the tab bar
 *   recheckDuration(track)       re-reads the song's length before a refetch
 *   fillPos(w, sung)             karaoke fill position, mirrored on RTL lines
 *   markRtl(lineEl, romanOnly, romanText, line, hasWords)
 *   songSec(video)               the song's time, held during a crossfade
 *   holdTrack(track, same, handleTrack)   true when handleTrack must stop
 *   takeDuration(newTrack, oldTrack) / fillDuration(track, key, previous)
 *                                the song's length, once it can be trusted
 *   bind(ctx)                    lyrics-ui.js's private state (end of lyrics-ui.js)
 */
(() => {
  'use strict';

  const plus = (window.__viviPlus = window.__viviPlus || {});
  let U = null; // lyrics-ui.js helpers, from bind()

  const TAB_SELECTOR = 'ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape';

  // YT Music's tab order is fixed: Up next, Lyrics, (Comments), Related.
  const TAB_POSITION = { lyrics: 1 };
  // Starting the first song from a playlist, YT Music can draw the tab bar
  // with every label still empty and fill the names in only later (seen in
  // Firefox). Fall back to the tab's position while all labels are empty.
  function tabByPosition(label, tabList) {
    const tabs = [...tabList];
    if (label in TAB_POSITION && tabs.length >= 3 && tabs.every((t) => !(t.textContent || '').trim())) {
      return tabs[TAB_POSITION[label]] || null;
    }
    return null;
  }

  // The user picking a tab themselves ends the wait for the Lyrics tab.
  // `cancel` clears lyrics-ui.js's retry timer (a no-op when none runs).
  function onUserTabClick(cancel) {
    document.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      if (e.target?.closest?.(TAB_SELECTOR)) cancel();
    }, true);
  }

  // Circular-arrow "refresh" icon, used on the tab-bar button and on the
  // "Refetch from other providers" button in the info panel.
  function makeRefreshIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'vivi-refresh-icon');
    ['M20 12a8 8 0 1 1-2.34-5.66L20 8', 'M20 3v5h-5'].forEach((d) => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  // Refresh: same as "Refetch from other providers" in the info panel,
  // one click away without opening it. `refetch` resolves true when other
  // lyrics were shown, false when no other provider had any.
  function makeRefetchTabButton(refetchFromOtherProviders) {
    const refetch = document.createElement('button');
    refetch.type = 'button';
    refetch.className = 'vivi-lyrics-refetch-tab-btn';
    refetch.setAttribute('aria-label', 'Refetch lyrics from other providers');
    refetch.title = 'Refetch lyrics from other providers';
    refetch.appendChild(makeRefreshIcon());
    refetch.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const found = await refetchFromOtherProviders();
      if (found === false) {
        // Nothing else had lyrics for this song: a short red flash.
        refetch.classList.add('vivi-lyrics-refetch-none');
        setTimeout(() => refetch.classList.remove('vivi-lyrics-refetch-none'), 1500);
      }
    });
    return refetch;
  }

  function syncRefetchTabButton(wrap, isRefetchingLyrics) {
    const refetchEl = wrap.querySelector('.vivi-lyrics-refetch-tab-btn');
    if (refetchEl) {
      refetchEl.disabled = isRefetchingLyrics;
      refetchEl.classList.toggle('vivi-lyrics-refetch-spinning', isRefetchingLyrics);
    }
  }

  // Right-to-left lines (Arabic, Hebrew …): decided by the first letter, the
  // way the browser's dir="auto" does it. Their fill runs right to left, so the
  // sung/unsung background positions are swapped (see .vivi-lyrics-rtl in CSS).
  const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
  const isRtlText = (t) => { const m = String(t || '').match(/\p{L}/u); return !!m && RTL_SCRIPT.test(m[0]); };
  const fillPos = (w, sung) => ((w.closest('.vivi-lyrics-rtl') ? !sung : sung) ? '0% 0' : '100% 0');

  function markRtl(lineEl, romanOnly, romanText, line, hasWords) {
    const shownText = romanOnly ? romanText : (line.text || (hasWords ? line.words.map((w) => w.text).join(' ') : ''));
    const rtl = isRtlText(shownText);
    lineEl.classList.toggle('vivi-lyrics-rtl', rtl);
    if (rtl) lineEl.dir = 'rtl'; else lineEl.removeAttribute('dir');
  }

  // During a crossfade the next song's title arrives while the old song is
  // still the louder one: keep the old lyrics until crossfade.js says the
  // blend is past its middle, then switch.
  let heldTrack = null;
  let holdTimer = null;
  const crossfadeHold = () => {
    const currentTrack = U.currentTrack();
    const h = window.__viviCrossfade?.lyricsHold?.();
    return h && currentTrack && h.id === currentTrack.videoId ? h : null;
  };

  function songSec(video) {
    const hold = crossfadeHold();
    return hold ? hold.timeSec : video.currentTime;
  }

  // Start of handleTrack(): true when it must return here.
  function holdTrack(track, sameTrack, handleTrack) {
    if (sameTrack) { heldTrack = null; return true; }
    if (crossfadeHold()) {
      heldTrack = track;
      if (!holdTimer) {
        holdTimer = setInterval(() => {
          if (crossfadeHold()) return;
          clearInterval(holdTimer);
          holdTimer = null;
          const next = heldTrack;
          heldTrack = null;
          if (next) handleTrack(next);
        }, 150);
      }
      return true;
    }
    return false;
  }

  // The song's length, for the lyrics timing check. Reading <video>.duration
  // the moment the title changes is not safe: during an ad it is the ad's
  // length, and right after a song change it can still be the previous
  // song's. A wrong length makes every correctly synced result look
  // "implausible", so only weaker (plain) lyrics got through. Wait until no
  // ad is showing and the video agrees with the player bar's own length
  // (taken from the song's metadata). null if the track changes meanwhile.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function readDurationSources() {
    const v = U.getVideoEl();
    const vd = v && Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null;
    const pb = Number(document.querySelector('ytmusic-player-bar #progress-bar')?.getAttribute('aria-valuemax')) || null;
    const ad = !!window.__viviTrackInfo?.adIsShowing?.();
    return { vd, pb, ad };
  }
  async function resolveSongDuration(key, previousDuration) {
    const started = Date.now();
    while (Date.now() - started < 120000) { // ads can run long; the song is not playing meanwhile
      if (key !== U.currentTrackKey()) return null;
      const { vd, pb, ad } = readDurationSources();
      const waited = Date.now() - started;
      if (!ad && vd) {
        const agrees = pb ? Math.abs(vd - pb) <= 2 : waited > 3000;
        // Same length as the song before, just after the change: maybe stale.
        const maybeStale = previousDuration && vd === previousDuration && waited < 2000;
        if (agrees && !maybeStale) return vd;
        if (waited > 8000) return pb || vd; // never agreed: trust the player bar
      }
      await sleep(250);
    }
    const { vd, pb } = readDurationSources();
    return pb || vd;
  }

  // handleTrack(): the new track starts without a length (filled in below,
  // once the song's real length is known); returns the previous song's.
  function takeDuration(newTrack, oldTrack) {
    const previousDuration = oldTrack?.duration || null;
    newTrack.duration = null;
    return previousDuration;
  }

  // handleTrack(), before the fetch: false when the track changed while waiting.
  async function fillDuration(trackWithDuration, key, previousDuration) {
    const duration = await resolveSongDuration(key, previousDuration);
    if (key !== U.currentTrackKey()) return false; // track changed while waiting
    trackWithDuration.duration = duration;
    return true;
  }

  // Refetch: re-read the song's length in case the first lookup got a wrong one.
  function recheckDuration(currentTrack) {
    const { vd, pb, ad } = readDurationSources();
    if (!ad && (pb || vd)) currentTrack.duration = (vd && (!pb || Math.abs(vd - pb) <= 2)) ? vd : (pb || vd);
  }

  function bind(ctx) {
    U = ctx;
    // automix.js reads the listener's excluded providers through this.
    if (window.__viviLyricsUI) window.__viviLyricsUI.loadExcludedProviders = ctx.loadExcludedProviders;
  }

  plus.lyricsUi = {
    tabByPosition, onUserTabClick, makeRefreshIcon, makeRefetchTabButton, syncRefetchTabButton,
    fillPos, markRtl, songSec, holdTrack, takeDuration, fillDuration, recheckDuration, bind,
  };
})();

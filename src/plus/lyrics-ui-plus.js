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
 *   activeLine(lineEls, nowMs, mode)   the line to treat as active (spec/lyrics/lyrics.md §2: 660 ms early,
 *                                a duet's second voice active beside it), src/plus/lyrics-rules.js
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

  // ── lyrics.md §2: lines change 660 ms ahead of the voice; a duet's second voice is active beside the first ──
  const RULES = globalThis.__viviLyricsRules;
  let realTiming = false;   // "lyrics by real timing" (§2.6): no lead
  try {
    chrome.storage.local.get({ lyricsRealTiming: false }).then((s) => { realTiming = s.lyricsRealTiming === true; }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lyricsRealTiming) realTiming = ch.lyricsRealTiming.newValue === true; });
  } catch { /* no storage: the lead stays on */ }
  let duetEls = [];
  function activeLine(lineEls, nowMs, mode) {
    const els = [...lineEls].filter((el) => Number.isFinite(Number(el.dataset.start)) && Number.isFinite(Number(el.dataset.end)));
    const idx = RULES ? RULES.activeLines(els.map((el) => ({ start: Number(el.dataset.start), end: Number(el.dataset.end) })), nowMs,
      { wordSynced: mode === 'word' || mode === 'syllable', leadMs: realTiming ? 0 : RULES.LEAD_MS }) : [];
    const actives = idx.map((i) => els[i]);
    // lines beyond the first (a duet's other voice) are lit here; lyrics-ui.js lights and settles the first
    const extra = actives.slice(1);
    for (const el of duetEls) if (!extra.includes(el) && el !== actives[0]) el.classList.remove('vivi-lyrics-active');
    for (const el of extra) el.classList.add('vivi-lyrics-active');
    duetEls = extra;
    updateGaps(nowMs);
    return actives[0] || null;
  }

  // ── lyrics.md §3: offsets. A global one plus one per song by video id, added; kept as they change (no Save);
  // steps of 50, a slider over ±3000, a field, a reset. Storage: viviLyricsOffsetGlobal, viviLyricsOffsetById. ──
  const OFFSET_RANGE = 3000, OFFSET_MAX_SONGS = 3000;
  let globalOffsetMs = 0, byId = {}, saveTimer = null;
  try {
    chrome.storage.local.get({ viviLyricsOffsetGlobal: 0, viviLyricsOffsetById: {} }).then((s) => {
      globalOffsetMs = Number(s.viviLyricsOffsetGlobal) || 0; byId = s.viviLyricsOffsetById || {};
    }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.viviLyricsOffsetGlobal) globalOffsetMs = Number(ch.viviLyricsOffsetGlobal.newValue) || 0;
      if (ch.viviLyricsOffsetById) byId = ch.viviLyricsOffsetById.newValue || {};
    });
  } catch { /* no storage: offsets stay 0 */ }
  const videoId = () => new URLSearchParams(location.search).get('v') || '';
  const globalOffset = () => globalOffsetMs;
  /** The playing song's own offset, or null when none was set for its video id (the older per-provider one then). */
  const songOffset = () => { const v = byId[videoId()]; return Number.isFinite(v) ? v : null; };
  function offsetChanged(ms) {
    const id = videoId();
    if (!id) return;
    const next = { ...byId };
    delete next[id];
    if (ms) next[id] = ms;
    const keys = Object.keys(next);
    if (keys.length > OFFSET_MAX_SONGS) keys.slice(0, keys.length - OFFSET_MAX_SONGS).forEach((k) => delete next[k]);
    byId = next;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { chrome.storage.local.set({ viviLyricsOffsetById: byId }); } catch { /* kept for this page */ } }, 400);
  }
  function offsetRow(label, get, set) {
    const row = document.createElement('div');
    row.className = 'vivi-offset-plus-row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'min-width:62px;opacity:.75;';
    const range = document.createElement('input');
    range.type = 'range'; range.min = String(-OFFSET_RANGE); range.max = String(OFFSET_RANGE); range.step = '50';
    range.style.cssText = 'flex:1;min-width:0;';
    const val = document.createElement('span');
    val.style.cssText = 'min-width:58px;text-align:right;font-variant-numeric:tabular-nums;';
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'vivi-offset-btn'; reset.textContent = 'Reset';
    reset.style.cssText = 'width:auto;padding:0 8px;';
    const show = () => { const v = get(); range.value = String(Math.max(-OFFSET_RANGE, Math.min(OFFSET_RANGE, v))); val.textContent = (v > 0 ? '+' : '') + v + ' ms'; };
    range.addEventListener('input', (e) => { e.stopPropagation(); set(Number(range.value)); show(); });
    range.addEventListener('click', (e) => e.stopPropagation());
    reset.addEventListener('click', (e) => { e.stopPropagation(); set(0); show(); });
    row.append(name, range, val, reset);
    show();
    return { row, show };
  }
  function extendOffsetPanel(wrap, saveBtn, getSong, setSong) {
    if (saveBtn) saveBtn.style.display = 'none';   // applied and kept as it changes
    const song = offsetRow('This song', getSong, setSong);
    const all = offsetRow('All songs', globalOffset, (ms) => {
      globalOffsetMs = ms;
      try { chrome.storage.local.set({ viviLyricsOffsetGlobal: ms }); } catch { /* this page only */ }
    });
    // the song's row follows the − / + buttons and the field
    wrap.addEventListener('click', () => setTimeout(song.show, 0), true);
    wrap.addEventListener('change', () => setTimeout(song.show, 0));
    wrap.append(song.row, all.row);
  }

  // ── lyrics.md §4: auto-scroll (setting lyricsAutoScroll, on by default). A drag, a wheel or a trackpad scroll over
  // the lyrics stops following; it comes back on the "Follow lyrics" button, a click on a line, or new lyrics. ──
  let autoScroll = true, paused = false, pausedPanel = null, lastActive = null, scrollFn = null, followBtn = null;
  try {
    chrome.storage.local.get({ lyricsAutoScroll: true }).then((s) => { autoScroll = s.lyricsAutoScroll !== false; }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lyricsAutoScroll) autoScroll = ch.lyricsAutoScroll.newValue !== false; });
  } catch { /* following stays on */ }
  const lyricsPanel = () => document.getElementById('vivi-lyrics-panel');
  const inLyrics = (target) => { const p = lyricsPanel(); return !!(p && target instanceof Node && (p.contains(target) || target.contains?.(p))); };
  function setFollowButton(show) {
    if (!show) { followBtn?.remove(); followBtn = null; return; }
    const p = lyricsPanel();
    if (!p || followBtn?.isConnected) return;
    followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.className = 'vivi-lyrics-follow-btn';
    followBtn.textContent = 'Follow lyrics';
    followBtn.style.cssText = 'position:sticky;bottom:12px;display:block;margin:8px auto 0;z-index:5;padding:6px 14px;border-radius:999px;'
      + 'border:1px solid rgba(255,255,255,.3);background:rgba(20,20,20,.85);color:#fff;font:500 13px Roboto,Arial,sans-serif;cursor:pointer;';
    followBtn.addEventListener('click', (e) => { e.stopPropagation(); follow(true); });
    p.append(followBtn);
  }
  function pause() {
    if (paused || !lyricsPanel()) return;
    paused = true; pausedPanel = lyricsPanel();
    setFollowButton(true);
  }
  function follow(scrollNow) {
    paused = false; pausedPanel = null;
    setFollowButton(false);
    if (scrollNow && lastActive?.isConnected && scrollFn) scrollFn(lastActive);
  }
  /** True while following is off: lyrics-ui.js then leaves the view where the listener put it. */
  function followPaused(active, scroll) {
    lastActive = active; scrollFn = scroll;
    if (paused && pausedPanel !== lyricsPanel()) follow(false);   // the lyrics were shown again
    if (paused && followBtn && !followBtn.isConnected) setFollowButton(true);
    return !autoScroll || paused;
  }
  let down = null;
  document.addEventListener('wheel', (e) => { if (inLyrics(e.target) && Math.abs(e.deltaY) + Math.abs(e.deltaX) > 0.5) pause(); }, { capture: true, passive: true });
  document.addEventListener('pointerdown', (e) => { down = inLyrics(e.target) ? { x: e.clientX, y: e.clientY } : null; }, true);
  document.addEventListener('pointermove', (e) => { if (down && e.buttons && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 0.5 && e.pointerType !== 'mouse') pause(); }, { capture: true, passive: true });
  document.addEventListener('touchmove', (e) => { if (inLyrics(e.target)) pause(); }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => { down = null; }, true);
  // a click on a line seeks there (lyrics-ui.js) and follows again
  document.addEventListener('click', (e) => { if (paused && e.target instanceof Element && e.target.closest('.vivi-lyrics-line')) follow(false); }, true);
  // the scrollbar dragged with the mouse
  document.addEventListener('scroll', (e) => { if (down && inLyrics(e.target)) pause(); }, { capture: true, passive: true });

  // ── lyrics.md §5.2: a duet's singers on their sides (setting lyricsDuetSides, on by default) ──
  let duetSides = true, sidesFor = null, sidesOf = [];
  try {
    chrome.storage.local.get({ lyricsDuetSides: true }).then((s) => { duetSides = s.lyricsDuetSides !== false; }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lyricsDuetSides) { duetSides = ch.lyricsDuetSides.newValue !== false; sidesFor = null; } });
  } catch { /* sides stay on */ }
  const sideCss = document.createElement('style');
  sideCss.textContent = '.vivi-lyrics-line.vivi-lyrics-side-left{text-align:left!important;margin-right:auto;transform-origin:left center}'
    + '.vivi-lyrics-line.vivi-lyrics-side-right{text-align:right!important;margin-left:auto;transform-origin:right center}'
    + '.vivi-lyrics-line.vivi-lyrics-side-center{text-align:center!important;transform-origin:center}';
  (document.head || document.documentElement).append(sideCss);
  function side(lineEl, i, result) {
    const lines = result && result.lines;
    if (!RULES || !Array.isArray(lines) || !lines.some((l) => l && l.agent)) return;   // no singers named: the view's own alignment
    if (sidesFor !== lines) {
      const types = {};
      for (const l of lines) if (l && l.agent && l.agentType) types[l.agent] = l.agentType;
      sidesOf = RULES.sides(lines.map((l) => (l && l.agent) || null), types, duetSides);
      sidesFor = lines;
    }
    const a = sidesOf[i];
    if (a) lineEl.classList.add('vivi-lyrics-side-' + a);
  }

  // ── lyrics.md §6: instrumental gaps. A mark sits before the line after each gap (and before the first line for an
  // intro): three dots that fill with the gap's progress while the position + 190 ms is inside it, appearing 300 ms
  // in and fading over 200 ms, leaving over 800 ms (BitChord's dots; Metrolist draws a ring). ──
  const gapCss = document.createElement('style');
  gapCss.textContent = '.vivi-lyrics-gap{display:block;padding:6px 0;line-height:0;opacity:0;transform:scale(.85);transition:opacity .8s ease,transform .8s ease;pointer-events:none}'
    + '.vivi-lyrics-gap.vivi-lyrics-side-left{text-align:left}.vivi-lyrics-gap.vivi-lyrics-side-right{text-align:right}'
    + '.vivi-lyrics-gap.on{opacity:1;transform:scale(1);transition:opacity .2s ease .3s,transform .2s ease .3s}'
    + '.vivi-lyrics-gap i{display:inline-block;width:10px;height:10px;margin:0 4px;border-radius:50%;background:currentColor;opacity:.25;transition:opacity .15s}'
    + '.vivi-lyrics-gap i.f{opacity:.95}';
  (document.head || document.documentElement).append(gapCss);
  let gapEls = [];
  function addGaps(list, result) {
    gapEls = [];
    translate(list, result);
    if (!RULES || !result || result.mode === 'plain' || !Array.isArray(result.lines)) return;
    const lineEls = list.querySelectorAll('.vivi-lyrics-line');
    for (const [start, end, before] of RULES.gaps(result.lines)) {
      const el = document.createElement('div');
      el.className = 'vivi-lyrics-gap';
      el.dataset.start = String(start); el.dataset.end = String(end);
      el.innerHTML = '<i></i><i></i><i></i>';
      const next = lineEls[before];
      const sideOf = next && [...next.classList].find((c) => c.startsWith('vivi-lyrics-side-'));
      if (sideOf) el.classList.add(sideOf);   // with the line after it (a duet's side)
      if (next) list.insertBefore(el, next); else list.append(el);
      gapEls.push(el);
    }
  }
  function updateGaps(nowMs) {
    for (const el of gapEls) {
      const s = Number(el.dataset.start), e = Number(el.dataset.end), at = nowMs + RULES.GAP_AHEAD_MS;
      const on = at >= s && at < e;
      el.classList.toggle('on', on);
      if (on) {
        const filled = Math.floor(((at - s) / Math.max(1, e - s)) * 3 + 1);
        el.querySelectorAll('i').forEach((d, k) => d.classList.toggle('f', k < filled));
      }
    }
  }

  // ── lyrics.md §8: text size (10 to 40) and line spacing (1.0 to 2.5 times); 0 keeps the style's own ──
  const sizeCss = document.createElement('style');
  sizeCss.id = 'vivi-lyrics-size';
  (document.head || document.documentElement).append(sizeCss);
  function applySize(size, spacing) {
    const px = Number(size), lh = Number(spacing);
    sizeCss.textContent = (px >= 10 && px <= 40 ? `#vivi-lyrics-panel .vivi-lyrics-line{font-size:${px}px!important}` : '')
      + (lh >= 1 && lh <= 2.5 ? `#vivi-lyrics-panel .vivi-lyrics-line{line-height:${lh}!important}` : '');
  }
  try {
    const read = () => chrome.storage.local.get({ lyricsTextSize: 0, lyricsLineSpacing: 0 }).then((s) => applySize(s.lyricsTextSize, s.lyricsLineSpacing)).catch(() => {});
    read();
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.lyricsTextSize || ch.lyricsLineSpacing)) read(); });
  } catch { /* the style's sizes */ }

  // ── lyrics.md §10: translation (setting lyricsTranslate, off by default). Google's keyless endpoint, into the
  // browser's language; the lines go in batches of up to 3500 characters joined by private-use markers (BitChord's
  // LyricsTranslation). Each translation sits under its line at 0.64 of its size, 0.7 opaque on the active line and
  // 0.3 on the others. A song already in that language shows nothing. ──
  let translateOn = false, lastList = null, lastResult = null;
  const transCache = new Map();
  try {
    chrome.storage.local.get({ lyricsTranslate: false }).then((s) => { translateOn = s.lyricsTranslate === true; if (translateOn && lastList) translate(lastList, lastResult); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.lyricsTranslate) return;
      translateOn = ch.lyricsTranslate.newValue === true;
      if (lastList) translate(lastList, lastResult);
    });
  } catch { /* stays off */ }
  const transCss = document.createElement('style');
  transCss.textContent = '.vivi-lyrics-trans{display:block;margin-top:.12em;font-size:.64em;font-weight:500;line-height:1.3;opacity:.3;-webkit-text-fill-color:currentColor;pointer-events:none}'
    + '.vivi-lyrics-line.vivi-lyrics-active .vivi-lyrics-trans{opacity:.7}';
  (document.head || document.documentElement).append(transCss);
  const MARK = (i) => '\uE000' + String(i).padStart(4, '0') + '\uE001';
  async function translateBatch(texts, tl) {
    const body = new URLSearchParams({ client: 'dict-chrome-ex', sl: 'auto', tl, dt: 't', q: texts.map((x, i) => (i ? '\n' + MARK(i) + '\n' : '') + x).join('') });
    // through the background: a content script's own request to Google doesn't get through in Firefox
    const res = await chrome.runtime.sendMessage({ type: 'VIVI_TRANSLATE', body: body.toString() });
    if (!res?.ok || !res.body) return null;
    const root = JSON.parse(res.body);
    const out = (root[0] || []).map((seg) => (seg && seg[0]) || '').join('').split(/\uE000[^\uE001]*\uE001/).map((x) => x.trim());
    return out.length === texts.length && out.every(Boolean) ? { out, src: String(root[2] || '') } : null;
  }
  async function translate(list, result) {
    lastList = list; lastResult = result;
    list.querySelectorAll('.vivi-lyrics-trans').forEach((el) => el.remove());
    if (!translateOn || !result || !Array.isArray(result.lines)) return;
    const tl = String(navigator.language || 'en');
    const slots = [];
    result.lines.forEach((l, i) => { const x = String((l && l.text) || '').trim(); if (x) slots.push({ i, x }); });
    if (!slots.length) return;
    const key = tl + '\n' + slots.map((s) => s.x).join('\n');
    let got = transCache.get(key);
    if (!got) {
      const batches = [];
      let cur = [], len = 0;
      for (const s of slots) {
        const add = s.x.length + (cur.length ? 8 : 0);
        if (cur.length && len + add > 3500) { batches.push(cur); cur = []; len = 0; }
        cur.push(s); len += add;
      }
      if (cur.length) batches.push(cur);
      try {
        const answers = [];
        for (let k = 0; k < batches.length; k += 2) answers.push(...await Promise.all(batches.slice(k, k + 2).map((b) => translateBatch(b.map((s) => s.x), tl))));
        if (answers.some((a) => !a)) return;
        got = { texts: answers.flatMap((a) => a.out), src: answers[0].src };
      } catch { return; }
      transCache.set(key, got);
      if (transCache.size > 20) transCache.delete(transCache.keys().next().value);
    }
    if (lastResult !== result || !list.isConnected || !translateOn) return;
    if (got.src.split('-')[0].toLowerCase() === tl.split('-')[0].toLowerCase()) return;   // already in that language
    const lineEls = list.querySelectorAll('.vivi-lyrics-line');
    slots.forEach((s, k) => {
      const el = lineEls[s.i];
      if (!el || got.texts[k] === s.x) return;
      const sub = document.createElement('span');
      sub.className = 'vivi-lyrics-trans';
      sub.textContent = got.texts[k];
      el.appendChild(sub);
    });
  }

  plus.lyricsUi = {
    tabByPosition, onUserTabClick, makeRefreshIcon, makeRefetchTabButton, syncRefetchTabButton,
    fillPos, markRtl, songSec, holdTrack, takeDuration, fillDuration, recheckDuration, bind, activeLine,
    globalOffset, songOffset, offsetChanged, extendOffsetPanel, followPaused, side, addGaps,
  };
})();

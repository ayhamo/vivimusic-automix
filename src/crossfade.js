/* VIVIMUSIC XTEN — crossfade.js  (content script, isolated world)
 *
 * Overlaps the end of one song with the start of the next.
 *
 * How it works, in plain terms:
 *   • A few seconds before a song ends, crossfade-page.js (MAIN world) hands
 *     us the already-buffered tail of that song as decoded PCM.
 *   • At the hand-over moment we line that PCM up with what is currently
 *     coming out of the <video> (a short cross-correlation), start playing
 *     it from a private buffer source, and silence the live element.
 *   • We then press "next". The moment the new song is audible we fade it in
 *     while the buffered tail of the old song fades out (equal-power curves).
 *
 * Both paths feed the equalizer chain, so EQ / reverb apply to the blend.
 * If anything looks off (no buffer, poor alignment, ads, repeat-one, pause,
 * user skip) we simply do nothing or back out and let YouTube Music behave
 * as usual — crossfade never has to succeed for playback to be correct.
 */
(() => {
  'use strict';
  if (window.__viviCrossfade) return;

  const CHANNEL = 'vivi-xfade';
  const PREP_LEAD = 14;        // seconds before the fade window to ask for the tail
  const SWITCH = 0.03;         // live → buffered tail swap ramp (s)
  const MAX_SECONDS = 12;
  const TICK_MS = 150;
  const AD_GRACE = 2;          // seconds an ad flag may show mid-mix before it counts as a real ad

  const curve = (fn) => Float32Array.from({ length: 64 }, (_, i) => fn((i / 63) * Math.PI / 2));
  const FADE_IN = curve(Math.sin);
  const FADE_OUT = curve(Math.cos);

  const log = (...a) => console.log('%c[ViVi crossfade]', 'color:#ff805c', ...a);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Freeze an AudioParam at its current value from time t. Firefox has no
  // cancelAndHoldAtTime, so there the value is read first and pinned by hand
  // (cancelScheduledValues alone would snap it back to its pre-automation value).
  const hold = (param, t) => {
    if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(t); return; }
    const v = param.value;
    param.cancelScheduledValues(t);
    // a curve already running at t isn't cancelled, and nothing may be set inside it: clear it all
    try { param.setValueAtTime(v, t); } catch { param.cancelScheduledValues(0); param.setValueAtTime(v, t); }
  };
  // Held where it is now, then to `v` (at once, or over `sec`). Safe inside a running curve.
  const settle = (param, v, t, sec = 0) => {
    hold(param, t);
    if (sec > 0) param.linearRampToValueAtTime(v, t + sec); else param.setValueAtTime(v, t);
  };
  // A fade along `shape` from t for d seconds. Firefox can't cancel or change a
  // running setValueCurveAtTime at all (every later event throws until it ends),
  // so there the shape is laid out as short linear ramps, which hold() can stop.
  const fadeCurve = (param, shape, t, d) => {
    if (param.cancelAndHoldAtTime) { param.setValueCurveAtTime(shape, t, d); return; }
    param.setValueAtTime(shape[0], t);
    for (let i = 1; i < shape.length; i++) param.linearRampToValueAtTime(shape[i], t + d * i / (shape.length - 1));
  };

  // ───────── settings (read straight from storage, no relay needed) ─────────
  let userOn = false, userSecs = 6, userManualSkip = true, userAutoAdvance = true, saver = false;
  const seconds = () => (userOn && !saver ? clamp(Math.round(userSecs) || 0, 1, MAX_SECONDS) : 0);

  function post(msg) {
    window.postMessage({ ch: CHANNEL, dir: 'in', ...msg }, window.location.origin);
  }

  function applyConfig() {
    log('config: seconds =', seconds(), '| enabled:', userOn, '| manualSkip:', userManualSkip, '| autoAdvance:', userAutoAdvance, '| resource saver:', saver);
    post({ type: 'config', enabled: seconds() > 0 });
    if (seconds() === 0) { if (live) abortLive(); dropPlan(); }
    else if (navigator.userActivation?.hasBeenActive) wake();
  }

  try {
    chrome.storage.local.get({
      crossfadeEnabled: false,
      crossfadeSeconds: 6,
      crossfadeManualSkip: true,
      crossfadeAutoAdvance: true,
      resourceSaverEnabled: false
    }, (r) => {
      userOn = r.crossfadeEnabled === true;
      userSecs = Number(r.crossfadeSeconds) || 6;
      userManualSkip = r.crossfadeManualSkip !== false;
      userAutoAdvance = r.crossfadeAutoAdvance !== false;
      saver = r.resourceSaverEnabled === true;
      applyConfig();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('crossfadeEnabled' in ch) userOn = ch.crossfadeEnabled.newValue === true;
      if ('crossfadeSeconds' in ch) userSecs = Number(ch.crossfadeSeconds.newValue) || 6;
      if ('crossfadeManualSkip' in ch) userManualSkip = ch.crossfadeManualSkip.newValue !== false;
      if ('crossfadeAutoAdvance' in ch) userAutoAdvance = ch.crossfadeAutoAdvance.newValue !== false;
      if ('resourceSaverEnabled' in ch) saver = ch.resourceSaverEnabled.newValue === true;
      applyConfig();
    });
  } catch { /* extension context gone */ }

  // ───────── shared audio graph ─────────
  const graph = () => {
    const g = window.__viviAudioGraph;
    return g && g.ctx && g.gate && g.entry ? g : null;
  };

  // Web Audio may only start from a user gesture, and a *suspended* context
  // would mute the page, so the graph is created (and resumed) only here.
  function wake() {
    if (seconds() === 0) return;
    const g = graph() || window.__viviEqualizer?.ensureAudioGraph?.();
    if (!g) log('could not create audio graph (video not found or already bound)');
    else if (!wake.said) { wake.said = true; log('audio graph ready, context state:', g.ctx.state); }
    if (g?.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
    if (g) watchVideo(g.video);
  }
  for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, wake, true);

  let watched = null;
  function watchVideo(v) {
    if (!v || watched === v) return;
    watched = v;
    v.addEventListener('playing', () => { if (live && graph()) live.playedAt = graph().ctx.currentTime; });
  }

  // ───────── state from the page world ─────────
  let st = null, stAt = 0, seenId = '';
  let plan = null, reqId = '', failedId = '', retryAt = 0, tries = 0, planSeq = 0;
  const MAX_TRIES = 4;
  let tap = null;
  let live = null;
  let startDelay = 0.5;   // learned: seconds between pressing next and hearing it

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'out') return;
    if (d.type === 'state') {
      st = d; stAt = performance.now();
      if (d.id !== seenId) {
        seenId = d.id;
        if (!live) { dropPlan(); reqId = ''; failedId = ''; tries = 0; }
        if (jumpTo && d.id !== jumpTo.id) jumpTo = null;
      }
    } else if (d.type === 'tail') {
      acceptTail(d);
    } else if (d.type === 'media-key') {
      // a media key during a mix (crossfade-page.js); the mix may have ended meanwhile
      if (!skipDuringMix(null, d.dir)) post({ type: d.dir === 'next' ? 'next' : 'previous' });
    } else if (d.type === 'prefetch') {
      // dropped by the page before it finished: forgotten here, so it is asked for again when wanted
      if (d.state === 'dropped') { if (songs.get(d.id)?.state === 'loading') songs.delete(d.id); return; }
      const f = songs.get(d.id) || { retried: false };
      songs.set(d.id, { ...f, state: d.state, why: d.why || '', client: d.client || '', at: performance.now() });
    } else if (d.type === 'range') {
      // a song file the page may not fetch itself (CORS after redirects): fetched
      // here, where fetch goes through the background worker (net.js). Only YouTube's media servers.
      let host = '';
      try { host = new URL(d.url).hostname; } catch { /* bad URL */ }
      const reply = (m, transfer) => window.postMessage({ ch: CHANNEL, dir: 'in', type: 'range', rid: d.rid, ...m }, window.location.origin, transfer);
      if (!host.endsWith('.googlevideo.com')) { reply({ ok: false, why: 'host not allowed' }); return; }
      fetch(d.url, { credentials: 'omit' })
        .then(async (r) => { const bytes = await r.arrayBuffer(); reply({ ok: true, status: r.status, bytes }, [bytes]); })
        .catch((e) => reply({ ok: false, why: String(e?.message || e) }));
    } else if (d.type === 'vivi-dev-test') {
      chrome.runtime.sendMessage({ type: 'VIVI_NET_FETCH', url: d.testUrl }, (reply) => {
        if (chrome.runtime.lastError || !reply?.ok) {
          console.error('%c[ViVi Test FAILED]', 'color:#ff4b4b;font-weight:bold;', reply?.error || chrome.runtime.lastError);
        } else {
          console.log('%c[ViVi Test SUCCESS]', 'color:#10b981;font-weight:bold;', `HTTP ${reply.status} for ${d.testUrl}`);
        }
      });
    } else if (d.type === 'vivi-automix-status') {
      const a = window.__viviAutomix;
      console.log('%c[ViVi Automix Status]', 'color:#ff4b8b;font-weight:bold;', JSON.stringify({
        enabled: a?.isEnabled(),
        bars: a?.getBars(),
        engine: a?.getLiveState(),
        crossfade: window.__viviCrossfade?.status(),
      }));
    }
  });

  // A failed attempt (decode, alignment, ...) is retried with fresh data a few
  // times while there is still time left, instead of giving up on the song.
  function retryOrGiveUp(why) {
    tries++;
    if (tries >= MAX_TRIES) { failedId = st?.id || ''; log('giving up on this song:', why); return; }
    log('retrying (' + tries + '/' + MAX_TRIES + '):', why);
    plan = null; reqId = ''; retryAt = performance.now() + 700;
  }

  function dropPlan() {
    plan = null;
    const g = graph();
    if (tap && g) { try { g.source.disconnect(tap); } catch { /* already detached */ } }
    tap = null;
  }

  // Manual skip: the click on Next is held back until the tail is decoded,
  // then the normal hand-over runs and presses Next itself.
  let skip = null;              // { id, timer } while a manual skip is waiting
  // Automix for the current song (BitChord web's AutoDJ, see automix.js):
  // idle (planning) → waiting (outro asked) → ready → done | fallback | off
  let amx = { id: '', state: 'idle', plan: null };
  // The Automix overview's choices, per pair of songs ("a>b" → { style, bars };
  // style: loop | blend | filter | crossfade, null for Auto; bars: 4..32, null for Auto)
  const PICKS_KEY = 'automixPairPicks', MAX_PICKS = 300;
  let pairPicks = {};
  try {
    chrome.storage.local.get({ [PICKS_KEY]: {} }, (r) => { pairPicks = r[PICKS_KEY] || {}; });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !(PICKS_KEY in ch)) return;
      const was = pairPicks;
      pairPicks = ch[PICKS_KEY].newValue || {};
      // picked in another tab: the pair playing here is planned again too
      if (st) { const key = st.id + '>' + (st.next || ''); if (JSON.stringify(was[key]) !== JSON.stringify(pairPicks[key])) replanPair(key); }
    });
  } catch { /* extension context gone */ }
  // planned afresh with a new pick (once the mix has begun, it is for next time)
  function replanPair(key) {
    if (!live && st && key === st.id + '>' + (st.next || '') && ['waiting', 'ready', 'fallback'].includes(amx.state)) { amx.state = 'idle'; reqId = ''; }
  }
  function setPairPick(key, pick) {
    const next = { ...pairPicks };
    delete next[key];
    if (pick && (pick.style || pick.bars)) next[key] = { style: pick.style || null, bars: pick.bars || null };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete next[k];
    pairPicks = next;
    try { chrome.storage.local.set({ [PICKS_KEY]: next }); } catch { /* extension context gone */ }
    replanPair(key);
  }
  // Whole-song downloads (crossfade-page.js) of the playing and next song:
  // id → { state: loading|ready|failed, at, retried, why, client }
  const songs = new Map();
  const MAX_MIX = 30;           // longest plain crossfade (s)
  const HAND_LEAD = 4;          // the old song moves to its decoded copy this long before the blend (s)
  const TAIL_LEAD = 14;         // and that copy is asked for this long before the move (s)

  function acceptTail(d) {
    log('tail reply:', d.ok ? 'ok, ' + (d.channels[0].length / d.sampleRate).toFixed(1) + 's of audio' : 'failed (' + d.why + ')');
    if (d.manualSkip) {
      if (!skip || skip.id !== d.id || !st || st.id !== d.id) return;   // too late: Next was already pressed
      clearTimeout(skip.timer);
      const tapAt = skip.tapAt;
      skip = null;
      const g = graph();
      const go = () => {
        if (d.ok && g && !live && seconds() > 0 && st && st.id === d.id && tap) {
          setPlan(g, d);
          handOver(g, g.video, seconds());
        }
        if (!live) { dropPlan(); post({ type: 'next' }); }   // could not blend: just skip
      };
      // The analyser was attached at the click; alignment needs it to hold
      // real audio (its 0.34 s window) before matching against the tail.
      const wait = tapAt + 400 - performance.now();
      if (wait > 0) { skip = { id: d.id, timer: setTimeout(() => { skip = null; go(); }, wait), tapAt }; }
      else go();
      return;
    }
    if (!st || d.id !== st.id) return;
    if (!d.ok) {
      if (d.automix) {
        // Without the downloaded copy, YouTube Music's buffer is the source,
        // and it is only ~50 s ahead: keep asking (the plan moves later if it must).
        reqId = ''; retryAt = performance.now() + 1500;
        if (d.why !== 'not-buffered' && d.why !== 'no-data' && d.why !== 'no-group') amxGiveUp('outro not available (' + d.why + ')');
        else if (amx.state === 'waiting') amx.state = 'idle';
        return;
      }
      if (d.why === 'not-buffered' || d.why === 'no-data' || d.why === 'no-group' || d.why === 'short') {
        reqId = ''; retryAt = performance.now() + 1500;   // may become available shortly
      } else {
        retryOrGiveUp(d.why);                              // decode hiccup / song changed mid-way
      }
      return;
    }
    const g = graph();
    if (!g || !d.channels.length) return;
    setPlan(g, d);
    if (d.automix && amx.id === d.id && amx.state === 'waiting') amx.state = 'ready';
    if (d.automix && amx.plan?.style === 'blend') outgoingDeckReady(g, amx.plan);   // a speed-up: the stretch deck loads the copy now
  }

  function setPlan(g, d) {
    const len = d.channels[0].length;
    const buf = g.ctx.createBuffer(d.channels.length, len, d.sampleRate);
    d.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const L = d.channels[0], R = d.channels[1] || L;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    plan = { id: d.id, key: d.id + ':' + (++planSeq), buf, mono, rate: d.sampleRate, start: d.start };
  }

  function amxGiveUp(why) {
    if (amx.state !== 'fallback') log('automix: using a plain crossfade for this song —', why);
    amx.state = 'fallback';
    amx.plan = null;
    // The plain crossfade needs a tail that covers where playback is now.
    const v = graph()?.video;
    if (plan && v && (v.currentTime < plan.start || v.currentTime > plan.start + plan.buf.duration - 2)) { dropPlan(); reqId = ''; }
    window.__viviAutomix?.setStatus('fallback', { mix: null, reason: why });
  }

  // A whole-song download for automix: asked once, retried 20 s later if it
  // failed, then every 2 minutes while it is still wanted (a failed fetch or a
  // 403 is often gone by then), up to 4 tries; analysed (BitChord's analyzer)
  // once it is in.
  function wantSong(id) {
    const now = performance.now();
    let f = songs.get(id);
    if (!f) {
      songs.set(id, { state: 'loading', at: now, retried: false, tries: 1, why: '' });
      while (songs.size > 6) songs.delete(songs.keys().next().value);
      post({ type: 'prefetch', id });
      return;
    }
    const tries = f.tries || 1;
    if (f.state === 'failed' && tries < 4 && now - f.at > (tries === 1 ? 20000 : 120000)) {
      songs.set(id, { ...f, state: 'loading', retried: true, tries: tries + 1, at: now });
      log('automix: download of', id, 'failed (' + f.why + '), trying again (' + (tries + 1) + ' of 4)');
      post({ type: 'prefetch', id, retry: true });
      return;
    }
    if (f.state === 'ready') window.__viviAutomix?.request(id, true);
  }

  // Next or Previous during an automix mix. The mix holds YouTube's player
  // (silent on the old song, or paused on the new one until its take-over),
  // so the player's own Next/Previous did nothing the listener could hear.
  //   Next: the mix ends now and the new song plays on from where the mix had
  //   brought it (a loop mix: its take-over point).
  //   Previous: the mix ends; on the old song YouTube's Previous runs as
  //   usual, on the new one (the player already moved on) it starts over.
  // [e]: the click or key press; null for a media key (crossfade-page.js).
  let jumpTo = null;   // { id, t, at }: the song Next is waiting for, and where it goes on
  let mixSent = false; // what crossfade-page.js was last told: a mix holds the player
  function skipDuringMix(e, dir) {
    const L = live, g = graph();
    if (!L?.mix || !g) return false;
    const m = L.mix, now = g.ctx.currentTime;
    const onNew = !!st && st.id === m.nextId && st.id !== L.oldId;
    if (dir === 'prev') {
      abortLive('previous pressed');
      if (onNew) {
        e?.preventDefault();
        e?.stopImmediatePropagation();
        post({ type: 'seek', t: 0 });
        post({ type: 'play' });
      } else if (!e) post({ type: 'previous' });   // a media key: YouTube's own Previous, pressed for it
      return true;
    }
    e?.preventDefault();
    e?.stopImmediatePropagation();
    const started = L.t0 != null && now >= L.t0;
    const at = !started ? null
      : m.style === 'loop' ? (L.loopX?.elementTrackTime ?? m.mixInTrackTime)
        : m.mixInTrackTime + (now - L.t0) * (m.rate || 1);
    abortLive('skipped by you');
    if (onNew) {
      if (at != null) post({ type: 'seek', t: at });
      post({ type: 'play' });
    } else {
      jumpTo = at != null && m.nextId ? { id: m.nextId, t: at, at: performance.now() } : null;
      post({ type: 'next' });
    }
    return true;
  }

  function onManualSkipRequested(e) {
    if (live?.mix && skipDuringMix(e, 'next')) return;
    if (!userManualSkip || seconds() === 0 || skip || live) return;
    const g = graph();
    const v = g?.video;
    if (!g || !v || !st || st.ad || v.paused || st.id === failedId || g.ctx.state !== 'running') return;
    if (performance.now() - stAt > 1500) return;
    if (st.dur - (v.currentTime - st.off) < seconds() + 2) return;   // the song is ending anyway

    e.preventDefault();
    e.stopImmediatePropagation();
    dropPlan();
    // still gliding back from the last blend: the song goes to its own speed now,
    // so the hand-over matches it against its copy (and the next song isn't left at the glide's rate)
    if (deck && deck.id === st.id) deck.cancel();
    if (tap) { try { g.source.disconnect(tap); } catch { /* not connected */ } }
    tap = g.ctx.createAnalyser();
    tap.fftSize = 16384;
    tap.smoothingTimeConstant = 0;
    try { g.source.connect(tap); } catch { /* ignore */ }

    const id = st.id;
    log('manual skip: asking for the tail from', (v.currentTime - st.off).toFixed(1), 's');
    skip = {
      id,
      tapAt: performance.now(),
      // Never hold the click hostage: if decoding is slow, skip normally.
      timer: setTimeout(() => {
        if (!skip || skip.id !== id) return;
        skip = null;
        log('manual skip: tail not ready in time, skipping without a blend');
        post({ type: 'next' });
      }, 1500),
    };
    post({
      type: 'prepare', id, sampleRate: g.ctx.sampleRate,
      needFrom: v.currentTime - 0.5,   // element timeline
      cover: seconds() + 2,
      manualSkip: true,
    });
  }

  // The player bar's buttons. The `ytmusic-miniplayer` selectors are for
  // YouTube Music's new-layout test (upstream's layout-compat.js), guessed and
  // untested: no account here has that layout yet. Remove them if that layout
  // never ships.
  const NEXT_BUTTONS = 'ytmusic-player-bar .next-button, ytmusic-miniplayer .next-button, ytmusic-miniplayer [class*="NextButton"]';
  const PLAY_PAUSE_BUTTONS = 'ytmusic-player-bar .play-pause-button, ytmusic-miniplayer .play-pause-button, ytmusic-miniplayer [class*="PlayPauseButton"]';

  // Only real user input: our own hand-over presses Next with a synthetic click.
  const PREV_BUTTONS = 'ytmusic-player-bar .previous-button, ytmusic-miniplayer .previous-button, ytmusic-miniplayer [class*="PreviousButton"]';
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest?.(NEXT_BUTTONS)) onManualSkipRequested(e);
    else if (live?.mix && e.target.closest?.(PREV_BUTTONS)) skipDuringMix(e, 'prev');
  }, true);

  document.addEventListener('keydown', (e) => {
    const k = e.key?.toLowerCase();
    if (!e.isTrusted || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || (k !== 'n' && k !== 'p')) return;
    const active = e.composedPath?.()[0] || document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    if (k === 'n') onManualSkipRequested(e);
    else if (live?.mix) skipDuringMix(e, 'prev');   // YouTube Music's Shift+P
  }, true);

  // While a mix holds YouTube's player paused (a loop mix waits on it for
  // ~20 s), the player shows "paused" and a press of play/pause would start
  // it instead. That press means "pause": the mix stops and stays paused.
  function onPlayPauseDuringHold(e) {
    if (!live?.mix || live.phase !== 'mixing' || !deck?.holding) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    abortLive('paused by you');
    post({ type: 'pause' });
  }
  document.addEventListener('click', (e) => {
    // .play-pause-button: the wide bar's #play-pause-button and the narrow layout's #play-pause-button-mweb
    if (e.isTrusted && e.target.closest?.(PLAY_PAUSE_BUTTONS)) onPlayPauseDuringHold(e);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.ctrlKey || e.altKey || e.metaKey || (e.key !== ' ' && e.key !== 'k' && e.key !== 'K')) return;
    const active = e.composedPath?.()[0] || document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    onPlayPauseDuringHold(e);
  }, true);

  // ───────── alignment: where in the decoded tail are we right now? ─────────
  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };

  // Normalised cross-correlation of `tmpl` against `buf`, searching start
  // positions in [lo, hi]. Both are box-averaged by `D` first (cheap coarse
  // pass); D = 1 is the exact pass.
  function scan(tmpl, buf, lo, hi, D) {
    const L = tmpl.length;
    const n = Math.floor(L / D);
    if (hi < lo || n < 32) return null;
    const a = new Float32Array(n);
    let ea = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < D; k++) s += tmpl[i * D + k];
      a[i] = s; ea += s * s;
    }
    const m = Math.floor((hi - lo) / D) + 1;
    const b = new Float32Array(m + n);
    for (let i = 0; i < b.length; i++) {
      let s = 0;
      const base = lo + i * D;
      for (let k = 0; k < D; k++) s += buf[base + k] || 0;
      b[i] = s;
    }
    const pre = new Float64Array(b.length + 1);
    for (let i = 0; i < b.length; i++) pre[i + 1] = pre[i] + b[i] * b[i];
    let bestJ = 0, bestC = -2;
    for (let j = 0; j < m; j++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += a[i] * b[j + i];
      const c = dot / Math.sqrt(ea * (pre[j + n] - pre[j]) + 1e-12);
      if (c > bestC) { bestC = c; bestJ = j; }
    }
    return { index: lo + bestJ * D, score: bestC };
  }

  // Coarse (÷16) → medium (÷4) → exact, so a wide search stays cheap.
  function locate(tmpl, buf, guess, radius) {
    const L = tmpl.length;
    const lo = Math.max(0, guess - radius);
    const hi = Math.min(buf.length - L, guess + radius);
    if (hi < lo) return null;
    let c = (hi - lo > 4000) ? scan(tmpl, buf, lo, hi, 16) : { index: lo };
    if (!c) return null;
    const mid = scan(tmpl, buf, Math.max(0, c.index - 40), Math.min(buf.length - L, c.index + 40), 4);
    if (mid) c = mid;
    return scan(tmpl, buf, Math.max(0, c.index - 8), Math.min(buf.length - L, c.index + 8), 1);
  }

  // ───────── hand-over: live element → buffered tail ─────────
  // ───────── automix: the playing song brought up to the next one's tempo ─────────
  // BitChord's Advanced Automix (CrossfadeController.rampOutgoing): when the
  // next song is the faster one, the playing song is sped up one 0.75% step
  // per beat over its last beats before the blend, so it arrives at the next
  // song's tempo and that song plays at its own speed. Here the speed-up runs
  // on a stretch deck (the loop mix's engine, pitch kept) loaded with the same
  // decoded copy, which takes over from the copy in 25 ms at the ramp's start,
  // into the same outgoing EQ and fades; YouTube's player is never touched.
  let blendDeck = null, blendDeckMaking = null, blendBus = null;
  function ensureBlendDeck(g) {
    // a new player brings a new audio context: the deck is rebuilt in it
    if (blendDeck && g && blendDeck.ctx !== g.ctx && !live?.deckRamp) {
      blendDeck.stop();
      try { blendBus.disconnect(); } catch { /* gone */ }
      blendDeck = null;
    }
    if (blendDeck || blendDeckMaking || !g || typeof SignalsmithStretch !== 'function') return;
    blendBus = g.ctx.createGain();
    blendDeckMaking = LoopDeck.create(g.ctx, blendBus)
      .then((d) => { blendDeck = d; })
      .catch((e) => log('automix: stretch deck failed:', e?.message || e))
      .finally(() => { blendDeckMaking = null; });
  }
  // True once the deck holds this decoded copy (starts loading it otherwise).
  function outgoingDeckReady(g, m) {
    if (!(m?.outRate > 1.0001)) return true;
    ensureBlendDeck(g);
    if (!blendDeck) return false;
    if (!plan) return false;
    if (blendDeck.loadedKey === plan.key) return true;
    if (plan.deckLoading || live?.deckRamp) return false;   // loading, or the deck still plays the last blend
    const me = plan;
    me.deckLoading = true;
    blendDeck.load(me.key, me.buf, 0, me.buf.duration)
      .catch((e) => log('automix: loading the stretch deck failed:', e?.message || e))
      .finally(() => { me.deckLoading = false; });
    return false;
  }
  // Schedules the ramp for the hand-over `L` (its copy starts at L.T at song
  // second L.aPos); moves L.t0 to where the sped-up song reaches the mix-out.
  function rampOutgoing(L, m, p, off) {
    const R = m.outRate, n = m.rampBeats, b = m.beatSec;
    const rampStart = m.mixOutTrackTime - n * b;
    if (!blendDeck || blendDeck.loadedKey !== p.key || rampStart < L.aPos + 0.5) return false;
    const H = 0.025;
    const bufAt = (songT) => songT + off - p.start;
    const Tr = L.T + (rampStart - L.aPos);
    // The deck starts PREROLL_SEC early, silent, so it is warm and playing when
    // the copy crosses onto it (the worklet keeps one future change: a start
    // only 25 ms before the first step would be dropped by it).
    const changes = [{ output: Tr - PREROLL_SEC, input: bufAt(rampStart) - PREROLL_SEC, rate: 1, active: true, loop: null }];
    let t = Tr;
    for (let k = 1; k <= n; k++) {
      const r = 1 + ((R - 1) * k) / n;
      changes.push({ output: t, input: bufAt(rampStart + (k - 1) * b), rate: r, active: true, loop: null });
      t += b / r;
    }
    L.t0 = t;
    L.tailEnd = t + (p.buf.duration - bufAt(m.mixOutTrackTime)) / R;
    changes.push({ output: L.tailEnd, input: p.buf.duration, rate: 1, active: false, loop: null });
    blendDeck.stop();
    try { blendBus.disconnect(); } catch { /* not connected */ }
    blendBus.connect(L.fade);
    blendDeck.schedule(changes);
    const dg = blendDeck.gain.gain, sg = L.srcGain.gain;
    dg.cancelScheduledValues(0); dg.setValueAtTime(0, Tr - H); dg.linearRampToValueAtTime(1, Tr);
    sg.setValueAtTime(1, Tr - H); sg.linearRampToValueAtTime(0, Tr);
    L.src.onended = null;   // the copy stops at the ramp; the deck plays the rest
    try { L.src.stop(Tr + 0.05); } catch { /* not started */ }
    L.deckRamp = true;
    log(`automix: the playing song speeds up to x${R.toFixed(3)} over ${n} beats from ${rampStart.toFixed(2)} s (in ${(Tr - L.T).toFixed(2)} s)`);
    return true;
  }

  function handOver(g, v, N, mix = null) {
    const ctx = g.ctx, p = plan, sr = p.rate;
    const frame = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(frame);
    const tRead = ctx.currentTime;
    const L = Math.round(0.25 * sr);
    const tmpl = frame.subarray(frame.length - L);
    const loud = rms(tmpl);

    let startIdx = Math.round((v.currentTime - p.start) * sr) - L;
    if (loud > 0.001) {
      // Search close to the estimate first. Songs repeat themselves bar after
      // bar (a bar is ~1.5-2.5 s), so a wide search can match an earlier copy
      // of the same bar a hair better than the real spot: the blend then
      // started ~2 s back and that part was heard twice. ±0.75 s is shorter
      // than a bar even at 160 BPM.
      let hit = locate(tmpl, p.mono, startIdx, Math.round(0.75 * sr));
      if (!hit || hit.score < 0.9) hit = locate(tmpl, p.mono, startIdx, Math.round(3 * sr));
      if (!hit || hit.score < 0.9) {
        // my position estimate was off: look through the whole tail instead
        hit = locate(tmpl, p.mono, Math.round(p.mono.length / 2), p.mono.length);
      }
      log('alignment score:', hit && hit.score.toFixed(3), '| estimate was off by', hit ? Math.round((hit.index - startIdx) / sr * 1000) + ' ms' : 'n/a');
      if (!hit || hit.score < 0.9) { retryOrGiveUp('alignment score too low'); return; }
      startIdx = hit.index;
    }
    const T = ctx.currentTime + 0.1;
    const idxT = startIdx + L + (T - tRead) * sr;
    if (idxT < 0 || p.mono.length - idxT < sr * 0.8) { retryOrGiveUp('tail too short'); return; }

    // The element's own volume/normalisation is already baked into what we
    // measured, so the tail is scaled to match it rather than guessed.
    const ref = rms(p.mono.subarray(startIdx, startIdx + L));
    // (unmeasurable, muted or silent: the volume setting; a mute itself is applied by driveLive, on top)
    const base = loud > 0.001 && ref > 1e-4 ? clamp(loud / ref, 0, 4) : (v.volume || 1);

    const src = ctx.createBufferSource();
    const fade = ctx.createGain();
    // Automix's outgoing deck (BitChord): bass swap, high-shelf cross and the
    // filter mix's high-pass. Flat / open for a plain crossfade.
    const bass = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250, gain: 0 });
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000, gain: 0 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 });
    // AutoDJ (version 2): the outgoing song's highs close through a low-pass
    const lp = mix?.v2 && (mix.style === 'blend' || mix.style === 'filter') ? new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 }) : null;
    const vol = ctx.createGain();
    const srcGain = ctx.createGain();
    src.buffer = p.buf;
    src.connect(srcGain); srcGain.connect(fade); fade.connect(bass); bass.connect(high); high.connect(hp);
    if (lp) { hp.connect(lp); lp.connect(vol); } else hp.connect(vol);
    vol.connect(g.entry);
    vol.gain.setValueAtTime(0, T);
    vol.gain.linearRampToValueAtTime(base, T + SWITCH);
    hold(g.gate.gain, ctx.currentTime);
    g.gate.gain.setValueAtTime(1, T);
    g.gate.gain.linearRampToValueAtTime(0, T + SWITCH);
    src.start(T, idxT / sr);

    const me = {
      phase: 'asked', oldId: st.id, N, mix, src, srcGain, fade, bass, high, hp, lp, vol, base, muted: false,
      // the player's volume `base` was measured at, and the level since (the slider moved: k = volume / volRef)
      volRef: v.volume || 1, k: 1, deckBase: base, inBase: base,
      aPos: p.start + idxT / sr - st.off,   // old song's position (s) at T, for the lyrics
      T, askedAt: 0, playedAt: 0, newId: '', newAt: 0, mixEnd: 0,
      tailEnd: T + (p.buf.duration - idxT / sr),
    };
    // Automix: the blend starts on the audio clock where the old song reaches its mix-out point.
    if (mix) me.t0 = T + (mix.mixOutTrackTime - me.aPos);
    if (mix?.style === 'blend' && mix.outRate > 1.0001 && !rampOutgoing(me, mix, p, st.off)) {
      try { src.stop(); } catch { /* not started */ }
      vol.disconnect();
      hold(g.gate.gain, ctx.currentTime);
      g.gate.gain.setValueAtTime(1, ctx.currentTime);
      retryOrGiveUp('too late to bring the song up to tempo');
      return;
    }
    // Automix: YouTube's player stays on the old song (silent) and shows it
    // until NEXT_LEAD before the mix, then moves on to hold the new song ready
    // (it is ready ~0.8 s after Next). A plain crossfade moves on at once.
    me.askAt = mix ? Math.max(T + SWITCH, me.t0 - NEXT_LEAD) : T + SWITCH;
    if (mix?.style === 'loop') {
      // the loop mix: the player moves on at the mix's midpoint (BitChord web's handoff),
      // in time to be held before it takes over, and before the old song's video runs out
      me.loopX = window.__viviAutomix.loopSchedule(mix.loop, me.t0);
      const oldEnd = T + (st.dur - me.aPos);
      me.askAt = Math.max(T + SWITCH, Math.min(me.loopX.handoffAt, me.loopX.elementAt - 1.5 - NEXT_LEAD, oldEnd - 1.5));
    } else if (mix && !mix.fallback) {
      // a blend with the next song on the incoming deck: the player moves on at its midpoint
      // (BitChord web's handoff), in time to be held before it takes over at the blend's end
      const D = Math.min(mix.durationSec, me.tailEnd - 0.05 - me.t0);
      // (a start already due, from a late hand-over, stays with the player: the deck's curves can't start in the past)
      if (D >= 0.5 && me.t0 > T + 0.3 && inDeckFits(g, mix, D)) {
        me.inDeck = true;
        me.D = D;
        const oldEnd = T + (st.dur - me.aPos);
        me.askAt = Math.max(T + SWITCH, Math.min(me.t0 + D / 2, me.t0 + D - 1.5 - NEXT_LEAD, oldEnd - 1.5));
      }
    }
    live = me;
    plan = null;
    log('handover done, tail gain', base.toFixed(2), mix ? `, blend in ${(me.t0 - ctx.currentTime).toFixed(2)} s, pressing next in ${(me.askAt - ctx.currentTime).toFixed(2)} s` : ', pressing next');
    // (a speed-up stops the copy at its start on purpose: the stretch deck plays on, so the mix goes on)
    if (!me.deckRamp) src.onended = () => { if (live === me) finishLive(); };
    // the loop mix: scheduled now, after the line above (it stops the copy at the loop start on purpose)
    if (mix?.style === 'loop') scheduleLoopMix(g);
    else if (me.inDeck) scheduleDeckBlend(g);
    // (the main tick asks too, in case this timer is held back in a background tab)
    setTimeout(() => askNext(me), Math.max(0, (me.askAt - ctx.currentTime) * 1000) + 10);
  }
  const NEXT_LEAD = 2.5;
  function askNext(me) {
    const g = graph();
    if (live !== me || me.askedAt || !g) return;
    me.askedAt = g.ctx.currentTime || 0;
    post({ type: 'next' });
  }

  function beginMix(g) {
    const ctx = g.ctx, now = ctx.currentTime;
    const room = live.tailEnd - now;
    if (room < 0.25) { finishLive(); return; }
    const M = clamp(Math.min(live.N, room), 0.3, MAX_MIX);
    startDelay = clamp(startDelay * 0.7 + (now - live.askedAt) * 0.3, 0.1, 2.5);
    // Both params are at rest here (gate at 0, fade at 1). Only clear what is
    // scheduled from now on: a value *event* at `now` would collide with the
    // curve below, which Firefox rejects.
    g.gate.gain.cancelScheduledValues(now);
    fadeCurve(g.gate.gain, FADE_IN, now, M);
    live.fade.gain.cancelScheduledValues(now);
    fadeCurve(live.fade.gain, FADE_OUT, now, M);
    log('mixing for', M.toFixed(1), 's, startDelay', startDelay.toFixed(2));
    live.phase = 'mixing';
    live.mixId = st.id;
    live.mixStart = now;
    live.mixEnd = now + M;
  }

  // Flat / open again: the player path's automix EQ and filters.
  function resetPlayerFilters(g) {
    const now = g.ctx.currentTime;
    for (const [param, v] of [[g.bassFilter?.gain, 0], [g.highFilter?.gain, 0], [g.highpass?.frequency, 20], [g.lowpass?.frequency, 20000]]) {
      if (!param) continue;
      param.cancelScheduledValues(now);
      param.setValueAtTime(v, now);
    }
  }

  function cleanup(L, g, rampGate) {
    const ctx = g.ctx, now = ctx.currentTime;
    if (L.deckRamp && blendDeck) {
      L.deckRamp = false;
      const dg = blendDeck.gain.gain;
      hold(dg, now);
      dg.setValueAtTime(dg.value, now);
      dg.linearRampToValueAtTime(0, now + 0.12);
      setTimeout(() => { if (!live?.deckRamp) { blendDeck.stop(); try { blendBus.disconnect(); } catch { /* gone */ } } }, 200);
    }
    resetPlayerFilters(g);
    hold(g.gate.gain, now);
    if (rampGate) {
      g.gate.gain.setValueAtTime(g.gate.gain.value, now);
      g.gate.gain.linearRampToValueAtTime(1, now + 0.06);
      hold(L.vol.gain, now);
      L.vol.gain.setValueAtTime(L.vol.gain.value, now);
      L.vol.gain.linearRampToValueAtTime(0, now + 0.12);
      try { L.src.stop(now + 0.15); } catch { /* not started / already stopped */ }
    } else {
      g.gate.gain.setValueAtTime(1, now);
      try { L.src.stop(); } catch { /* already ended */ }
    }
    setTimeout(() => { try { L.vol.disconnect(); } catch { /* gone */ } }, 300);
  }

  // The loop mix's decks fall silent (softly when cut short).
  function stopLoopDecks(soft) {
    if (!loopDecks || !deckOut) return;
    const now = deckOut.context.currentTime;
    if (!soft) { loopDecks.forEach((d) => d.stop()); return; }
    deckOut.gain.cancelScheduledValues(now);
    deckOut.gain.setValueAtTime(deckOut.gain.value, now);
    deckOut.gain.linearRampToValueAtTime(0, now + 0.12);
    setTimeout(() => loopDecks.forEach((d) => d.stop()), 150);
  }

  function finishLive() {
    const g = graph(), L = live;
    live = null;
    if (L?.mix?.style === 'loop') stopLoopDecks(false);
    if (L?.inDeck) stopInDeck(false);
    if (!g || !L) return;
    cleanup(L, g, false);
    dropPlan();
    reqId = ''; failedId = ''; tries = 0;
  }

  function abortLive(why = '') {
    log('aborted crossfade', why);
    const g = graph(), L = live;
    live = null;
    // (the decks are stopped first; whatever happens there, the player's own sound comes back below)
    if (L?.mix) {
      try {
        deck?.cancel();
        if (L.mix.style === 'loop') stopLoopDecks(true);
        if (L.inDeck) {
          stopInDeck(true);
          // the deck already played the new song this far: the player goes on from there, not from its start
          const now = g?.ctx.currentTime ?? 0;
          if (g && L.askedAt && st?.id === L.mix.nextId && now > L.t0 && why !== 'seeked' && why !== 'ad') {   // (an ad: the song starts after it)
            post({ type: 'seek', t: L.mix.mixInTrackTime + (now - L.t0) * (L.mix.rate || 1) });
          }
        }
        for (const t of L.toastTimers || []) clearTimeout(t);
        hideAutomixNotification();
      } catch (e) { log('stopping the mix failed:', e?.message || e); }
    }
    if (!g || !L) return;
    cleanup(L, g, true);
    dropPlan();
    // Only the song that couldn't hand over is skipped by the next tries; once
    // the next song plays (an ad, a pause or a seek cut the mix short), it is
    // a new song with its own mix ahead of it. A mix called off before Next
    // (the queue changed, a seek, a pause) is planned again from where the song is.
    failedId = st && st.id === L.oldId && !(L.mix && !L.askedAt) ? st.id : '';
  }

  // ───────── automix: the incoming song on YouTube's player (BitChord engine/deck.ts) ─────────
  // BitChord plays the incoming song on an <audio> element held to a
  // timeline by nudging its pitch-preserving playbackRate (a seek when far
  // off). Here that element is YouTube's own <video>: the old song is already
  // on its decoded copy, which runs exactly on the audio clock, so the clock
  // is what the new song follows.

  // AutoMix's Timeline: trackTime <-> AudioContext time for scheduled changes.
  class Timeline {
    constructor() { this.points = []; }
    add(p) { this.points = this.points.filter((q) => q.output < p.output); this.points.push(p); }
    segmentAt(t) { let seg = null; for (const p of this.points) { if (p.output <= t) seg = p; else break; } return seg; }
    trackTimeAt(t) { const s = this.segmentAt(t); if (!s) return null; return s.active ? s.input + (t - s.output) * s.rate : s.input; }
    rateAt(t) { const s = this.segmentAt(t); return s && s.active ? s.rate : 0; }
    get last() { return this.points[this.points.length - 1] || null; }
  }

  // The element's rate is only ever set to the timeline's planned rate, never
  // nudged: every playbackRate change with preservesPitch restarts Chrome's
  // time-stretch, which is heard as a stutter. Its offset is corrected with
  // seeks instead, while the deck is still too quiet to hear them.
  const SEEK_ERROR_SEC = 0.25;   // off by more than this, a seek even when audible
  const QUIET_ERROR_SEC = 0.03;  // off by more than this while quiet, a silent seek
  const QUIET_GAIN = 0.3;        // the deck's gain under which a seek isn't heard
  const SERVO_MS = 40;
  let startLatency = 0.05;       // play() -> sound, learned across mixes
  // How far ahead of the wanted spot a seek of the *playing* element has to
  // aim, learned from where seeks land: a playing element resumes at once, so
  // this is near 0 (aiming startLatency ahead left it 50 ms early every time).
  let seekLead = 0;
  let deck = null;               // the incoming song's deck, while it is held or still gliding

  class PlayerDeck {
    constructor(g, v, id) {
      Object.assign(this, {
        g, v, id, timeline: new Timeline(), latency: startLatency, errors: [], seekingUntil: 0, ownSeekUntil: 0,
        held: false, startAt: 0, startAsked: 0, foreign: false, done: false, seeks: 0, quietUntil: Infinity,
      });
      v.preservesPitch = true;
      // a seek that isn't ours and lands well away from where the song should be: the user's
      this.onSeeking = () => {
        if (performance.now() <= this.ownSeekUntil) return;
        const want = this.timeline.trackTimeAt(this.g.ctx.currentTime), p = this.pos();
        if (want !== null && p !== null && Math.abs(p - want) > 2) this.foreign = true;
      };
      this.onPlaying = () => {
        if (!this.startAsked) return;
        const took = this.g.ctx.currentTime - this.startAsked;
        this.startAsked = 0;
        if (took > 0 && took < 1.5) startLatency = this.latency = this.latency * 0.5 + took * 0.5;
      };
      v.addEventListener('seeking', this.onSeeking);
      v.addEventListener('playing', this.onPlaying);
      this.timer = setInterval(() => this.tick(), SERVO_MS);
    }
    // where the element is, in song seconds
    pos() { return st && st.id === this.id ? this.v.currentTime - st.off : null; }
    seek(t) {
      this.ownSeekUntil = performance.now() + 2000;
      this.seekingUntil = this.g.ctx.currentTime + 0.5;
      this.errors = [];
      this.seeks++;
      post({ type: 'seek', t: Math.max(0, t) });
    }
    // trackTime plays at ctxTime, at `rate`: BitChord's Deck.playAt from paused.
    playAt(ctxTime, trackTime, rate) {
      const now = this.g.ctx.currentTime;
      const target = trackTime - (ctxTime - now) * rate;
      if (target >= 0.5) {
        // far enough in: put it there now, unheard, and let the servo hold it
        this.timeline.add({ output: now, input: target, rate, active: true });
        this.seek(target + 0.3 * rate);
        this.v.playbackRate = rate;
      } else {
        // the start is (nearly) the song's opening: hold it there, start it on time
        this.held = true;
        this.startAt = ctxTime;
        this.ownSeekUntil = performance.now() + 2000;
        post({ type: 'pause' });
        this.seek(trackTime);
      }
      this.timeline.add({ output: ctxTime, input: trackTime, rate, active: true });
    }
    // A song the plan wasn't for: it plays where it is, at rate 1.
    follow() { this.release(); }
    setRate(rate, at) {
      const input = this.timeline.trackTimeAt(at);
      if (input === null) return;
      this.timeline.add({ output: at, input, rate, active: true });
    }
    // Step the rate back to 1.0 in inaudible ~0.8% increments (AutoMix glideRateToUnity).
    glideToUnity(fromRate, start) {
      if (Math.abs(fromRate - 1) < 0.002) { this.setRate(1, start + 0.5); return; }
      for (let i = 1; i <= 8; i++) this.setRate(fromRate + (1 - fromRate) * (i / 8), start + i * 3);
    }
    tick() {
      const now = this.g.ctx.currentTime, v = this.v;
      if (this.foreign) { this.release(); return; }   // the user seeked: the song is theirs again
      if (this.held) {
        if (now < this.startAt - this.latency) return;
        this.held = false;
        this.startAsked = now;
        this.ownSeekUntil = performance.now() + 1500;
        v.playbackRate = this.timeline.rateAt(this.startAt) || 1;
        post({ type: 'play' });
        return;
      }
      const last = this.timeline.last;
      if (!last || now > last.output + 0.5) { this.release(); return; }   // the glide is played out
      // After the mix (its glide back to the song's own speed): a pause or a
      // stall is the user's or the network's, and the timeline would run on
      // without the song. Let it go rather than seek it ahead afterwards.
      const mixDone = !live || live.mixId !== this.id;
      if (mixDone && v.paused) { this.release(); return; }
      const expected = this.timeline.trackTimeAt(now), rate = this.timeline.rateAt(now), p = this.pos();
      if (expected === null || !rate || p === null || v.paused || v.seeking || now < this.seekingUntil) return;
      const error = p - expected;
      if (Math.abs(error) > SEEK_ERROR_SEC) {
        if (mixDone) { this.release(); return; }
        this.seek(expected + seekLead * rate); this.measureSeek = false; return;
      }
      // currentTime moves in audio-callback steps: a short median keeps the nudge off that jitter
      this.errors.push(error);
      if (this.errors.length > 5) this.errors.shift();
      const smoothed = [...this.errors].sort((a, b) => a - b)[this.errors.length >> 1];
      this.lastError = smoothed;
      // the first settled reading after a quiet seek says where seeks land: aim that much less ahead
      if (this.measureSeek && this.errors.length >= 3) { this.measureSeek = false; seekLead = clamp(seekLead - smoothed, -0.1, 0.3); }
      // still quiet: a seek isn't heard, so the offset is put right with one
      if (this.errors.length >= 3 && Math.abs(smoothed) > QUIET_ERROR_SEC && this.g.gate.gain.value < QUIET_GAIN && now < this.quietUntil) {
        this.seek(expected + seekLead * rate);
        this.measureSeek = true;
        return;
      }
      // the planned rate only, changed when the plan changes it (the glide's steps)
      if (Math.abs(v.playbackRate - rate) > 0.0005) v.playbackRate = rate;
    }
    // The element runs free again at rate 1.
    release() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.v.removeEventListener('seeking', this.onSeeking);
      this.v.removeEventListener('playing', this.onPlaying);
      if (this.v.playbackRate !== 1) this.v.playbackRate = 1;
      this.done = true;
      if (deck === this) deck = null;
    }
    // Dropped mid-way (pause, seek, skip): rate 1, and playing if we held it.
    cancel() {
      if (this.held) { this.held = false; post({ type: 'play' }); }
      this.release();
    }
    // Ours, not the user's: the hold before the start and the start itself.
    get holding() { return this.held || (!!this.startAsked && this.g.ctx.currentTime - this.startAsked < 2); }
  }

  // ───────── automix: the loop mix's stretch decks (BitChord engine/loopDeck.ts) ─────────
  // AutoMix's own deck: signalsmith-stretch (src/vendor/signalsmith-stretch.js,
  // MIT) over a decoded region of a song, so it can loop whole bars
  // sample-accurately and change tempo with the pitch kept, at any ratio.
  const POST_AHEAD_SEC = 0.25;   // the worklet keeps one pending change: each goes out just before it's due
  const LOAD_PIECE_SEC = 4;       // a deck's audio goes to its worklet this much at a time
  const LOAD_PIECE_GAP_MS = 40;
  const PREROLL_SEC = 0.5;       // a deck starts this early, silent, ahead of its first change that is heard
  const DISPATCH_MS = 20;
  let loopDecks = null;          // [outgoing, incoming], built on first use
  let loopDecksMaking = null;    // the one creation in flight
  let deckLoads = Promise.resolve();   // loads one after another: a deck's buffers are replaced, never mixed
  let deckOut = null;            // both decks -> the player's level -> the EQ chain

  class LoopDeck {
    static async create(ctx, destination) {
      // The worklet is the same file, loaded from the extension (YouTube Music's
      // page would refuse the blob: URL the library makes by default).
      SignalsmithStretch.moduleUrl = chrome.runtime.getURL('src/vendor/signalsmith-stretch.js');
      const stretch = await SignalsmithStretch(ctx);
      const deck = new LoopDeck(ctx, stretch, destination);
      deck.latencySec = await stretch.latency();
      return deck;
    }
    constructor(ctx, stretch, destination) {
      Object.assign(this, { ctx, stretch, pending: [], timer: null, regionStart: 0, loadedKey: '' });
      this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250, gain: 0 });
      this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.6, gain: 0 });
      this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000, gain: 0 });
      this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 });
      this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 });
      this.gain = new GainNode(ctx, { gain: 0 });
      stretch.connect(this.low);
      this.low.connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.gain).connect(destination);
      stretch.setUpdateInterval(0.05);   // AutoMix: keeps inputTime current
    }
    // Loads [startSec, endSec) of a decoded song. Loads run one after another:
    // the worklet appends buffers, so two at once would leave both songs in it.
    load(key, buffer, startSec, endSec) {
      const run = () => this.loadNow(key, buffer, startSec, endSec);
      this.loading = (this.loading || Promise.resolve()).then(run, run);
      return this.loading;
    }
    async loadNow(key, buffer, startSec, endSec) {
      this.loadedKey = '';
      this.stop();
      await this.stretch.dropBuffers();
      const from = Math.max(0, Math.floor(startSec * buffer.sampleRate));
      const to = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
      // In pieces, each handed over (not copied), a moment apart: the whole
      // region in one message (25-45 MB) cost Firefox's audio thread 30-40 ms,
      // heard as a stutter in the song playing meanwhile.
      const piece = Math.round(LOAD_PIECE_SEC * buffer.sampleRate);
      const mono = buffer.numberOfChannels < 2;
      for (let a = from; a < to; a += piece) {
        const b = Math.min(to, a + piece);
        const channels = [buffer.getChannelData(0).slice(a, b), buffer.getChannelData(mono ? 0 : 1).slice(a, b)];
        await this.stretch.addBuffers(channels, channels.map((c) => c.buffer));
        if (b < to) await new Promise((r) => setTimeout(r, LOAD_PIECE_GAP_MS));
      }
      this.regionStart = from / buffer.sampleRate;
      this.loadedKey = key;
    }
    // Queues changes (track seconds); each is posted just before it's due.
    schedule(changes) {
      this.pending.push(...changes);
      this.pending.sort((a, b) => a.output - b.output);
      this.timer ??= setInterval(() => this.dispatch(), DISPATCH_MS);
      this.dispatch();
    }
    dispatch() {
      const now = this.ctx.currentTime, r = this.regionStart;
      while (this.pending.length && this.pending[0].output - now < POST_AHEAD_SEC) {
        const c = this.pending.shift();
        this.stretch.schedule({ output: c.output, input: c.input - r, rate: c.rate, active: c.active,
          loopStart: c.loop ? c.loop[0] - r : 0, loopEnd: c.loop ? c.loop[1] - r : 0 });
      }
      if (!this.pending.length && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    }
    // Stops now, forgets everything queued; filters, EQ and gain back to rest.
    stop() {
      this.pending = [];
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.stretch.schedule({ active: false });
      const now = this.ctx.currentTime;
      for (const [param, v] of [[this.gain.gain, 0], [this.low.gain, 0], [this.mid.gain, 0], [this.high.gain, 0], [this.hp.frequency, 20], [this.lp.frequency, 20000]]) {
        settle(param, v, now);   // (the gain may be mid-curve: a blend's fade)
      }
    }
  }

  // BitChord AutoDJ.prepareLoopMix: picks the bars to loop and loads both
  // decks in the background while the song plays (from 100 s before its end).
  // Each song is decoded once from its downloaded copy; the decks keep only
  // the stretch they play, and the outgoing song's tail for the hand-over is
  // cut from the same samples, so the switch onto its deck is seamless.
  let loopPrep = { key: '', state: 'idle' };
  const loopRefetched = new Set();   // pairs whose songs were downloaded again for the loop mix
  // A whole song decoded at the graph's rate on a context of its own: decoded
  // on the playing context, Firefox's audio loses ~40 ms as it lands.
  const decodeAside = (g, bytes) => new OfflineAudioContext(2, 1, g.ctx.sampleRate).decodeAudioData(bytes);

  // The loop decks, made once per audio graph (normally at its start: see warmDecks)
  async function ensureLoopDecks(g) {
    // a new player brings a new audio context: the decks are rebuilt in it
    if (deckOut && deckOut.context !== g.ctx && live?.mix?.style !== 'loop') {
      loopDecks?.forEach((d) => d.stop());
      try { deckOut.disconnect(); } catch { /* gone */ }
      deckOut = null; loopDecks = null;
    }
    if (!deckOut) { deckOut = g.ctx.createGain(); deckOut.connect(g.entry); }
    if (!loopDecks) {
      loopDecksMaking ??= Promise.all([LoopDeck.create(g.ctx, deckOut), LoopDeck.create(g.ctx, deckOut)])
        .finally(() => { loopDecksMaking = null; });
      loopDecks ??= await loopDecksMaking;
    }
  }

  async function prepareLoopMix(g, curId, nextId, pos) {
    const key = curId + '>' + nextId;
    if (loopPrep.key === key) return;
    const me = { key, state: 'loading', why: '' };
    loopPrep = me;
    const still = () => loopPrep === me && st && st.id === curId && st.next === nextId;
    const A = window.__viviAutomix;
    const none = (why) => { me.state = 'none'; me.why = why; log('automix: no loop mix for this pair:', why); };
    try {
      const cur = A.asOutgoing(A.get(curId)), nxt = A.get(nextId);
      if (!A.gridOk(cur) || !A.gridOk(nxt)) return none('beat grid too weak');
      if (cur.musicVideo || nxt.musicVideo) return none('a music video');
      if (typeof SignalsmithStretch !== 'function') return none('stretch engine missing');
      // where each song is sung: its synced lyrics (looked up meanwhile), else the vocal mask
      const lyrics = Promise.all([A.sungSpans(curId), A.sungSpans(nextId)]);
      const [ob, ib] = await Promise.all([A.audioBytes(curId), A.audioBytes(nextId)]);
      const [outBuffer, inBuffer] = await Promise.all([decodeAside(g, ob), decodeAside(g, ib)]);
      const [sungOut, sungIn] = await lyrics;
      if (!still()) return;
      const plan = A.planLoopMix(cur, outBuffer, nxt, inBuffer, pos + A.LOOP.LOOP_SETUP_SEC, { out: sungOut, in: sungIn });
      log(`automix: sung parts from ${sungOut ? 'synced lyrics' : 'the vocal mask'} (playing song) and ${sungIn ? 'synced lyrics' : 'the vocal mask'} (next song)`);
      if (!plan || plan.none) return none(plan?.none || 'no beat grid to loop on');
      await ensureLoopDecks(g);
      if (!still()) return;
      if (live?.mix?.style === 'loop') return none('a loop mix is still playing');
      const load = deckLoads.then(async () => {
        if (!still()) return false;
        await loopDecks[0].load(curId, outBuffer, Math.max(0, cur.durationSec - A.LOOP.OUT_REGION_SEC), cur.durationSec);
        await loopDecks[1].load(nextId, inBuffer, 0, Math.min(nxt.durationSec, A.LOOP.IN_REGION_SEC));
        return true;
      });
      deckLoads = load.catch(() => false);
      if (!(await load)) return;
      const from = Math.max(0, plan.out.loop[0] - HAND_LEAD - 4);
      const a = Math.floor(from * outBuffer.sampleRate);
      const channels = [];
      for (let c = 0; c < Math.min(2, outBuffer.numberOfChannels); c++) channels.push(outBuffer.getChannelData(c).slice(a));
      if (!still()) return;
      Object.assign(me, { state: 'ready', plan, tail: { channels, sampleRate: outBuffer.sampleRate, start: a / outBuffer.sampleRate } });
      log(`automix: loop mix ready: ${plan.out.bars}-bar loop at ${plan.out.loop[0].toFixed(2)} s (${plan.out.bpm.toFixed(1)} BPM, ${plan.out.checkedBy === 'lyrics' ? 'no lyric line' : 'sung ' + ((plan.out.vocal ?? 0) * 100).toFixed(1) + '%'}) into a ${plan.in.bars}-bar loop at ${plan.in.loop[0].toFixed(2)} s (${plan.in.bpm.toFixed(1)} BPM, ${plan.in.checkedBy === 'lyrics' ? 'no lyric line' : 'sung ' + ((plan.in.vocal ?? 0) * 100).toFixed(1) + '%'}), ramp ${plan.rampBars} bars, ${plan.totalBars} bars in all`);
    } catch (e) {
      if (loopPrep !== me) return;
      // The page keeps only its last few downloads, so a song analysed long ago
      // (or answered from the saved analyses) may be gone from it: download
      // it again, once per pair, and let the next tick prepare the mix anew.
      if (/not downloaded/.test(e?.message || '') && !loopRefetched.has(key)) {
        loopRefetched.add(key);
        if (loopRefetched.size > 20) loopRefetched.delete(loopRefetched.values().next().value);
        log('automix: the loop mix needs a song the page no longer has; downloading it again');
        for (const id of [curId, nextId]) { songs.delete(id); wantSong(id); }
        loopPrep = { key: '', state: 'idle' };
        return;
      }
      none(String(e?.message || e));
    }
  }

  // The loop mix on the clock (BitChord scheduleLoopMix + AutoDJ.scheduleLoop).
  // The old song is on its decoded copy (cut from the deck's own samples), so
  // at its loop start it crosses onto the outgoing deck in 25 ms. YouTube's
  // player waits on the new song, silent and held to the clock, and takes
  // over from the incoming deck two bars after that deck's loop lets go.
  // The decks play the whole mix from decoded audio, so it is scheduled at the
  // hand-over (scheduleLoopMix) and needs nothing from YouTube's player, which
  // shows the old song until the mix's midpoint, as BitChord web's app does,
  // and only then moves on to wait for its take-over (loopTakeOver).
  function scheduleLoopMix(g) {
    const ctx = g.ctx, now = ctx.currentTime, m = live.mix;
    const [od, idk] = loopDecks;
    const x = live.loopX, H = x.HANDOVER_SEC, t0 = x.t0;
    deckOut.gain.cancelScheduledValues(now);
    deckOut.gain.setValueAtTime(live.muted ? 0 : live.deckBase * live.k, now);
    // (started PREROLL_SEC early on the song before the loop, silent: warm and playing at the switch)
    const f = x.outChanges[0];
    od.schedule([{ output: t0 - PREROLL_SEC, input: f.input - PREROLL_SEC, rate: 1, active: true, loop: null }, ...x.outChanges]);
    idk.schedule(x.inChanges);
    const og = od.gain.gain, ig = idk.gain.gain;
    og.cancelScheduledValues(0); ig.cancelScheduledValues(0);
    og.setValueAtTime(0, t0 - H); og.linearRampToValueAtTime(1, t0);
    ig.setValueAtTime(0, t0); ig.linearRampToValueAtTime(0.55, x.enterEnd);
    og.setValueAtTime(1, x.enterEnd); og.linearRampToValueAtTime(0.6, x.rampEnd);
    ig.linearRampToValueAtTime(1, x.rampEnd);
    og.linearRampToValueAtTime(0, x.releaseAt);
    ig.setValueAtTime(1, x.elementAt); ig.linearRampToValueAtTime(0, x.elementAt + H);
    // bass: the incoming loop comes in without it; they swap over one bar mid-ramp
    idk.low.gain.setValueAtTime(x.BASS_CUT_DB, t0);
    od.low.gain.setValueAtTime(0, x.mid - x.bar / 2); od.low.gain.linearRampToValueAtTime(x.BASS_CUT_DB, x.mid + x.bar / 2);
    idk.low.gain.setValueAtTime(x.BASS_CUT_DB, x.mid - x.bar / 2); idk.low.gain.linearRampToValueAtTime(0, x.mid + x.bar / 2);
    // the outgoing loop drains away through a rising high-pass once the tempo has arrived
    od.hp.frequency.setValueAtTime(20, x.rampEnd); od.hp.frequency.exponentialRampToValueAtTime(1500, x.releaseAt);

    // the old song's copy hands its sound to the outgoing deck at the loop start
    const out = live.fade.gain;
    out.cancelScheduledValues(now); out.setValueAtTime(1, now); out.setValueAtTime(1, t0 - H); out.linearRampToValueAtTime(0, t0);
    live.src.onended = null;   // the copy ends with the song; the mix goes on past that on the decks
    try { live.src.stop(t0 + 0.05); } catch { /* already stopped */ }
    deck?.cancel();   // (a glide left from the last mix: the old song is silent on the player now)

    const D = x.elementAt - t0;
    live.toastTimers = [
      setTimeout(() => showAutomixNotification('Automix · loop mix', `${m.loop.out.bars}-bar loop · ${Math.round(m.loop.out.bpm)}→${Math.round(m.loop.in.bpm)} BPM · ${D.toFixed(1)} s`), Math.max(0, (t0 - ctx.currentTime) * 1000)),
      setTimeout(finishAutomixNotification, Math.max(0, (x.elementAt - ctx.currentTime) * 1000)),
    ];
    log(`automix: loop mix, ${m.loop.totalBars} bars (${D.toFixed(1)} s), starting in ${(t0 - now).toFixed(2)} s; the player moves on in ${(live.askAt - now).toFixed(2)} s and takes over at ${x.elementTrackTime.toFixed(2)} s of the new song`);
    live.mixStart = t0;
    live.mixEnd = x.elementAt + 0.15;
    live.beatTimes = x.beatTimes;
    live.handoffAt = x.handoffAt;
  }
  // The new song is on YouTube's player: silent, held to the clock, it takes over at elementAt.
  function loopTakeOver(g, v) {
    const now = g.ctx.currentTime, x = live.loopX, H = x.HANDOVER_SEC, L = live;
    const idk = loopDecks[1];
    // The player came late (slow start, far seek): the incoming deck plays on
    // past elementAt (at rate 1, past its loop) until the player is held in
    // time. Its stop is still queued here until just before it is due.
    let tk = x.elementAt;
    if (now + 1.6 > x.elementAt) {
      tk = now + 1.6;
      const regionEnd = idk.regionStart + window.__viviAutomix.LOOP.IN_REGION_SEC;
      const queued = idk.pending.some((c) => c.output > x.elementAt && !c.active);
      if (!queued || x.elementTrackTime + (tk - x.elementAt) + 0.6 > regionEnd) { abortLive('the player came too late for the loop mix'); return; }
      idk.pending = idk.pending.filter((c) => c.output <= x.elementAt);
      idk.schedule([{ output: tk + 0.1, input: x.elementTrackTime + (tk - x.elementAt) + 0.1, rate: 1, active: false, loop: null }]);
      const ig = idk.gain.gain;
      ig.cancelScheduledValues(now); ig.setValueAtTime(1, now); ig.setValueAtTime(1, tk); ig.linearRampToValueAtTime(0, tk + H);
      L.mixEnd = tk + 0.15;
      log(`automix: the player came late; the incoming deck plays on, the player takes over ${(tk - x.elementAt).toFixed(2)} s later`);
    }
    const trackAt = (t) => x.elementTrackTime + (t - x.elementAt);
    resetPlayerFilters(g);
    const inn = g.gate.gain;
    inn.cancelScheduledValues(now); inn.setValueAtTime(0, now); inn.setValueAtTime(0, tk); inn.linearRampToValueAtTime(1, tk + H);
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    deck.playAt(tk - 1.5, trackAt(tk - 1.5), 1);
    deck.setRate(1, tk + 3);   // held to the clock until well after it takes over
    deck.quietUntil = tk - 0.35;   // no silent seek right before the gate opens
    // the deck's level is matched to the player's (YouTube's normalisation of the new song) before it takes over
    deckTapOf(idk, g.ctx);
    setTimeout(() => matchInLevel(L, tk - 0.05, 'loop'), Math.max(0, (tk - 0.45 - now) * 1000));
    log(`automix: the new song waits on the player, taking over in ${(tk - now).toFixed(2)} s`);
    L.phase = 'mixing';
    L.mixId = st.id;
  }

  // The blend, on the audio clock (BitChord scheduleTransition): equal-power
  // cross; a blend swaps the bass in one bar at the midpoint and crosses the
  // highs over the window, the incoming song stretched to the outgoing tempo
  // and gliding back to its own over 24 s; a filter mix brings the incoming
  // song in through an opening low-pass while the outgoing one drains through
  // a rising high-pass; a crossfade is gains only.
  const EP = 65;
  const EP_OUT = Float32Array.from({ length: EP }, (_, i) => Math.cos((i / (EP - 1)) * Math.PI / 2));
  const EP_IN = Float32Array.from({ length: EP }, (_, i) => Math.sin((i / (EP - 1)) * Math.PI / 2));

  // ───────── AutoDJ (Automix version 2): the BitChord phone's blend shapes ─────────
  // CrossfadeController.kt (Advanced Automix), p = blend progress 0..1:
  //   blend: the bass changes hands over half a beat at the midpoint, on
  //   high-pass corners (20 Hz open, 200 Hz bass gone); the next song comes
  //   in through a high-pass that opens; the playing song's highs close
  //   through a low-pass. Fader: the next song is full by the swap, the
  //   playing one falls after it, both trimmed by 1/sqrt(in+out).
  //   filter mix (SWEEP): the playing song's low-pass closes 7 kHz → 300 Hz,
  //   the next song's high-pass opens from 1.2 kHz; the same bass swap.
  // clash (the share both sing, from the plan) deepens the filters and
  // moves the fader towards a vocal-safe pair.
  const glide = (a, b, x) => a * Math.pow(b / a, clamp(x, 0, 1));
  const bassCut = (x) => glide(20, 200, x);
  const entryHp = (p, top, openBy) => (p >= openBy ? 20 : glide(20, top, Math.pow(1 - p / openBy, 0.35)));
  const djShapes = new WeakMap();   // plan -> its shapes, made once per blend length
  function djShape(m, style, D) {
    const hit = djShapes.get(m);
    if (hit && hit.D === D && hit.style === style) return hit;
    const clash = clamp(m.clash || 0, 0, 1);
    const beat = m.bpm > 0 ? 60 / m.bpm : 0;
    const grid = beat ? D / beat : 0;   // beats in the blend
    const onBar = (f) => (grid >= 8 ? clamp(Math.round((f * grid) / 4) * 4 / grid, 4 / grid, 1 - 4 / grid) : f);
    const w = grid >= 2 ? 0.5 / grid : 0.2;
    const swapAt = onBar(0.5);
    const h = (p) => clamp((p - (swapAt - w)) / w, 0, 1);
    const S = Math.PI / 2;
    let inHp, outHp, outLp, rise, fall;
    if (style === 'filter') {
      const top = glide(1200, 2400, clash), openBy = onBar(0.6 + 0.18 * clash);
      outLp = (p) => glide(7000, 300, Math.pow(p, 0.75));
      outHp = (p) => bassCut(h(p));
      inHp = (p) => Math.max(entryHp(p, top, openBy), bassCut(1 - h(p)));
      rise = (p) => Math.sin(Math.pow(p, 0.8) * S);
      fall = (p) => Math.cos(Math.pow(p, 1.6) * S);
    } else {
      const top = glide(520, 950, clash), openBy = onBar(0.45 + 0.25 * clash);
      const from = onBar(0.3 - 0.18 * clash), floor = glide(2200, 1100, clash);
      const fallFrom = Math.max(0, Math.min(swapAt, 0.5, grid ? 1 - 4 / grid : 0.5));
      outLp = (p) => glide(20000, floor, (p - from) / (1 - from));
      outHp = (p) => bassCut(h(p));
      inHp = (p) => Math.max(bassCut(1 - h(p)), entryHp(p, top, openBy));
      const held = (plain, dj) => plain + (dj - plain) * (1 - clash);
      rise = (p) => held(Math.sin(p * S), Math.sin(clamp(p / swapAt, 0, 1) * S));
      fall = (p) => held(Math.cos(p * S), p <= fallFrom ? 1 : Math.cos(((p - fallFrom) / (1 - fallFrom)) * S));
    }
    // ~25 ms steps, so half a beat of bass swap is drawn. Firefox draws a
    // curve as one ramp per step (fadeCurve), five params at once: fewer there.
    const most = typeof AudioParam !== 'undefined' && AudioParam.prototype.cancelAndHoldAtTime ? 4000 : 1200;
    const n = Math.max(EP, Math.min(most, Math.ceil(D * 40)));
    const mk = (f) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
    const gIn = new Float32Array(n), gOut = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i / (n - 1);
      let r = rise(p), f = fall(p);
      r += (Math.sin(Math.pow(p, 1.65) * S) - r) * clash;
      f += (Math.cos(Math.pow(p, 0.65) * S) - f) * clash;
      const trim = r + f <= 1 ? 1 : Math.max(0.5, 1 / Math.sqrt(r + f));
      gIn[i] = r * trim; gOut[i] = f * trim;
    }
    const shape = { D, style, gIn, gOut, inHp: mk(inHp), outHp: mk(outHp), outLp: mk(outLp) };
    djShapes.set(m, shape);
    return shape;
  }
  const djNote = (m, style) => (m.v2 && style !== 'crossfade'
    ? ` [AutoDJ: both sing ${Math.round((m.clash || 0) * 100)}%${m.vocalsBy ? ' (' + m.vocalsBy + ')' : ''}${m.rerouted ? '; ' + m.rerouted : ''}${m.keyClash ? '; keys clash (' + m.keyClash + '), short blend' : ''}]`
    : '');
  // The fader for this mix: AutoDJ's for a version 2 blend or filter mix, else equal power.
  const gainCurves = (m, style, D) => (m.v2 && style !== 'crossfade' ? (({ gIn, gOut }) => [gIn, gOut])(djShape(m, style, D)) : [EP_IN, EP_OUT]);
  // AutoDJ's filters: the next song's (the player's high-pass, which the
  // incoming deck feeds too) from `pre`, where it is still silent; the
  // playing song's from t0, eased in over 30 ms (a 20 kHz → 7 kHz step clicks).
  function djFilters(g, style, t0, D, pre) {
    const s = djShape(live.mix, style, D);
    if (g.highpass) {
      const f = g.highpass.frequency;
      f.setValueAtTime(s.inHp[0], pre);
      if (t0 > pre + 0.002) f.setValueAtTime(s.inHp[0], t0 - 0.001);
      fadeCurve(f, s.inHp, t0, D);
    }
    for (const [node, curve, open] of [[live.lp, s.outLp, 20000], [live.hp, s.outHp, 20]]) {
      if (!node) continue;
      const f = node.frequency, ease = Math.max(live.T + SWITCH + 0.01, t0 - 0.03);
      f.cancelScheduledValues(ease);
      f.setValueAtTime(open, ease);
      f.linearRampToValueAtTime(curve[0], t0 - 0.001);
      fadeCurve(f, curve, t0, D);
    }
  }

  function beginAutomix(g, v) {
    const ctx = g.ctx, now = ctx.currentTime, m = live.mix;
    const t0 = Math.max(live.t0, now + 0.05);
    const D = Math.min(live.t0 + m.durationSec, live.tailEnd - 0.05) - t0;
    if (D < 0.5) { log('automix: no time left for the blend'); finishLive(); return; }
    const matched = st.id === m.nextId;
    const rate = matched ? m.rate : 1;
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    if (matched) {
      deck.playAt(t0, m.mixInTrackTime + (t0 - live.t0) * rate, rate);
      deck.glideToUnity(rate, t0 + D);
    } else {
      log('automix: the queue played', st.id, 'instead of', m.nextId || '(nothing)', '- crossfading into it as it is');
      deck.follow();
    }

    // gains: equal-power cross (AutoDJ: its own fader)
    const style = matched ? m.style : 'crossfade';
    const [cIn, cOut] = gainCurves(m, style, D);
    const inn = g.gate.gain, out = live.fade.gain;
    inn.cancelScheduledValues(now); inn.setValueAtTime(0, now); fadeCurve(inn, cIn, t0, D);
    out.cancelScheduledValues(now); out.setValueAtTime(1, now); fadeCurve(out, cOut, t0, D);

    blendShape(g, style, t0, D, rate);
    log(`automix: ${style}${style !== 'crossfade' ? ' of ' + m.bars + ' bars' : ''}, ${D.toFixed(1)} s, starting in ${(t0 - now).toFixed(2)} s; next song from ${m.mixInTrackTime.toFixed(2)} s at x${rate.toFixed(3)}${m.reason ? ' (' + m.reason + ')' : ''}${djNote(m, style)}`);
    live.phase = 'mixing';
    live.mixId = st.id;
  }

  // The blend's EQ and filters on both songs, its toasts and its stretch of the
  // bar (mixStart..mixEnd). The incoming song's are the player's own filters,
  // which the incoming deck feeds too.
  function blendShape(g, style, t0, D, rate) {
    const ctx = g.ctx, now = ctx.currentTime, m = live.mix;
    resetPlayerFilters(g);
    // The player's filters shape the incoming song, but at the hand-over the
    // player still carries the old song until its switch onto the copy is done:
    // the incoming settings wait for that, or the old song's last moments on
    // the player would play through them (its bass cut, its highs low).
    const pre = Math.max(now + 0.01, live.T + SWITCH + 0.02);
    const mid = t0 + D / 2, bar = Math.min(m.barSec || 0, D / 2);
    const swap = (to, from) => {
      // incoming low end cut until the midpoint, then the two hand over within one bar
      to.setValueAtTime(m.swapDb, pre); to.setValueAtTime(m.swapDb, mid - bar / 2); to.linearRampToValueAtTime(0, mid + bar / 2);
      from.setValueAtTime(0, mid - bar / 2); from.linearRampToValueAtTime(m.swapDb, mid + bar / 2);
    };
    if (m.v2 && style !== 'crossfade') {
      djFilters(g, style, t0, D, pre);
    } else if (style === 'blend') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.high.gain.setValueAtTime(0, t0); live.high.gain.linearRampToValueAtTime(-8, t0 + D);
      if (g.highFilter) { const h = g.highFilter.gain; h.setValueAtTime(-8, pre); h.setValueAtTime(-8, t0); h.linearRampToValueAtTime(0, t0 + D); }
    } else if (style === 'filter') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.hp.frequency.setValueAtTime(20, t0); live.hp.frequency.exponentialRampToValueAtTime(1800, t0 + D);
      if (g.lowpass) { const lp = g.lowpass.frequency; lp.setValueAtTime(350, pre); lp.setValueAtTime(350, t0); lp.exponentialRampToValueAtTime(20000, t0 + D); }
    }

    const name = m.v2 && style !== 'crossfade' ? 'Advanced AutoDJ' : 'Automix';
    const title = style === 'blend' ? name : style === 'filter' ? name + ' · filter mix' : 'Automix · crossfade';
    const sub = style === 'crossfade'
      ? `${D.toFixed(1)} s${m.reason ? ' · ' + m.reason : ''}`
      : `${m.bars} bars · ${D.toFixed(1)} s · ${Math.round(m.bpm)} BPM${style === 'blend' && Math.abs(rate - 1) > 0.002 ? ` · ×${rate.toFixed(3)}` : ''}`;
    live.toastTimers = [
      setTimeout(() => showAutomixNotification(title, sub), Math.max(0, (t0 - ctx.currentTime) * 1000)),
      setTimeout(finishAutomixNotification, Math.max(0, (t0 + D - ctx.currentTime) * 1000)),
    ];
    live.mixStart = t0;
    live.mixEnd = t0 + D;
    live.beatSec = style !== 'crossfade' && m.bpm > 0 ? 60 / m.bpm : 0;
  }

  // ───────── automix: the next song's part of a blend on a stretch deck ─────────
  // BitChord web's app shows the playing song until the blend's midpoint, and
  // YouTube's player can only show what it plays. So the next song's part of
  // the blend plays from its decoded download on a stretch deck that feeds the
  // player's mix filters (after its gate). Next is pressed at the midpoint; the
  // player, silent behind its gate and held to the clock, takes over from the
  // deck in 25 ms at the blend's end, at the deck's level. Without the deck
  // (not loaded in time) the player moves on before the blend, as before.
  let inDeck = null, inDeckMaking = null, inBus = null, inTap = null, inDeckGraph = null;
  let inPrep = { key: '', state: 'idle', end: 0, want: 0, why: '', retryAt: 0 };
  // The incoming deck, made once per audio graph (normally at its start: see warmDecks)
  async function ensureInDeck(g) {
    if (inDeck && inDeckGraph === g) return;
    inDeckMaking ??= (async () => {
      // the audio graph was rebuilt (a new player): the old deck goes with it
      if (inDeck) { inDeck.stop(); try { inBus.disconnect(); inDeck.gain.disconnect(); } catch { /* gone */ } }
      inDeck = null;
      const bus = g.ctx.createGain();
      bus.connect(g.bassFilter);
      const d = await LoopDeck.create(g.ctx, bus);
      const t = g.ctx.createAnalyser();
      t.fftSize = 16384; t.smoothingTimeConstant = 0;
      d.lp.connect(t);   // read before the deck's own gain (the blend's curve): its plain level
      inBus = bus; inTap = t; inDeck = d; inDeckGraph = g;
    })().finally(() => { inDeckMaking = null; });
    await inDeckMaking;
  }

  // Starting a deck's stretch engine holds up Firefox's audio for ~50 ms, so
  // all three are made as the audio graph starts (it glitches then anyway),
  // not in the middle of the first song with Automix (heard as a stutter
  // once per browser session).
  let warmedFor = null;
  function warmDecks(g) {
    if (warmedFor === g || typeof SignalsmithStretch !== 'function' || !g.bassFilter) return;
    warmedFor = g;
    Promise.all([ensureLoopDecks(g), ensureInDeck(g)]).catch((e) => log('automix: decks not made ahead:', e?.message || e));
  }

  async function prepareInDeck(g, p) {
    const A = window.__viviAutomix, id = p.nextId;
    if (!id || !g.bassFilter || typeof SignalsmithStretch !== 'function') return;
    // the start of the song, past where a late take-over could still need it
    const want = Math.min(A.get(id)?.durationSec || Infinity, Math.max(120, p.mixInTrackTime + (p.durationSec + 45) * (p.rate || 1)));
    if (inPrep.key === id) {
      if (inPrep.state === 'loading' || (inPrep.state === 'ready' && inPrep.want >= want - 1)) return;
      if (inPrep.state === 'none' && performance.now() < inPrep.retryAt) return;   // failed: tried again later
    }
    if (live?.inDeck) return;   // the deck still plays the last blend
    const me = { key: id, state: 'loading', end: 0, want, why: '', retryAt: 0 };
    inPrep = me;
    try {
      await ensureInDeck(g);
      const buf = await decodeAside(g, await A.audioBytes(id));
      if (inPrep !== me) return;
      if (live?.inDeck) { inPrep = { key: '', state: 'idle', end: 0, want: 0, why: '', retryAt: 0 }; return; }
      const end = Math.min(buf.duration, want);
      await inDeck.load(id, buf, 0, end);
      if (inPrep !== me) return;
      me.end = end;
      me.state = 'ready';
      log(`automix: the next song's first ${end.toFixed(0)} s are on the incoming deck`);
    } catch (e) {
      if (inPrep !== me) return;
      me.state = 'none'; me.why = String(e?.message || e);
      me.retryAt = performance.now() + 20000;
      // the page keeps only its last few downloads: fetch it again for the next try
      if (/not downloaded/.test(me.why)) { songs.delete(id); wantSong(id); }
      log('automix: no incoming deck for this blend (for now):', me.why);
    }
  }
  // The deck holds the next song far enough for this blend (and a late take-over).
  function inDeckFits(g, m, D) {
    return !!inDeck && inDeckGraph === g && inPrep.state === 'ready' && inPrep.key === m.nextId && inDeck.loadedKey === m.nextId
      && m.mixInTrackTime + (D + 8) * (m.rate || 1) <= inPrep.end;
  }
  function stopInDeck(soft) {
    if (!inDeck) return;
    const now = inDeck.ctx.currentTime, ig = inDeck.gain.gain;
    if (!soft) { inDeck.stop(); return; }
    settle(ig, 0, now, 0.12);   // (mid-blend it is inside the fade curve)
    setTimeout(() => { if (!live?.inDeck) inDeck.stop(); }, 150);
  }
  // At the hand-over: the deck plays the next song's part of the blend.
  function scheduleDeckBlend(g) {
    const now = g.ctx.currentTime, m = live.mix, t0 = live.t0, D = live.D, rate = m.rate || 1;
    deck?.cancel();   // (a glide left from the last mix: the old song is silent on the player now)
    inBus.gain.cancelScheduledValues(now); inBus.gain.setValueAtTime(live.muted ? 0 : live.inBase * live.k, now);
    // (started PREROLL_SEC early, silent, so it is warm when the blend brings it in)
    const pre = Math.min(PREROLL_SEC, m.mixInTrackTime / rate);
    inDeck.schedule([{ output: t0 - pre, input: m.mixInTrackTime - pre * rate, rate, active: true, loop: null }]);
    const ig = inDeck.gain.gain, out = live.fade.gain;
    const [cIn, cOut] = gainCurves(m, m.style, D);
    ig.cancelScheduledValues(0); ig.setValueAtTime(0, now); fadeCurve(ig, cIn, t0, D);
    out.cancelScheduledValues(now); out.setValueAtTime(1, now); fadeCurve(out, cOut, t0, D);
    blendShape(g, m.style, t0, D, rate);
    live.handoffAt = t0 + D / 2;
    live.src.onended = null;   // the mix may run on the deck past the old song's end (a late take-over)
    log(`automix: ${m.style}, ${D.toFixed(1)} s, starting in ${(t0 - now).toFixed(2)} s on the incoming deck (next song from ${m.mixInTrackTime.toFixed(2)} s at x${rate.toFixed(3)}); the player moves on in ${(live.askAt - now).toFixed(2)} s${djNote(m, m.style)}`);
  }
  // The new song is on YouTube's player: silent, held to the clock, it takes over at the blend's end.
  function blendTakeOver(g, v) {
    const now = g.ctx.currentTime, m = live.mix, rate = m.rate || 1, H = 0.025, L = live;
    if (st.id !== m.nextId) { abortLive('the queue played another song than the blend was for'); return; }
    // just after the curves end (an event inside one is refused), or later if the player came late
    const tk = Math.max(L.t0 + L.D + 0.02, now + 1.6);
    const trackAt = (t) => m.mixInTrackTime + (t - L.t0) * rate;
    if (trackAt(tk + 0.5) > inPrep.end) { abortLive('the player came too late for the incoming deck'); return; }
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    // held to the clock from now on (silent behind the gate), so its level can be read early
    const from = Math.min(now + 0.5, tk - 1.5);
    deck.playAt(from, trackAt(from), rate);
    if (Math.abs(rate - 1) < 0.002) deck.setRate(1, tk + 3); else deck.glideToUnity(rate, tk);
    deck.quietUntil = tk - 0.35;   // no silent seek right before the gate opens
    const gate = g.gate.gain, ig = inDeck.gain.gain;
    gate.cancelScheduledValues(now); gate.setValueAtTime(0, now); gate.setValueAtTime(0, tk); gate.linearRampToValueAtTime(1, tk + H);
    ig.setValueAtTime(1, tk); ig.linearRampToValueAtTime(0, tk + H);
    // the deck's level is matched to the player's: once the player has settled, and checked again before it takes over
    const early = now + 2;
    if (early < tk - 1.2) setTimeout(() => matchInLevel(L, early + 0.8), (early - now) * 1000);
    setTimeout(() => matchInLevel(L, tk - 0.05), Math.max(0, (tk - 0.45 - now) * 1000));
    log(`automix: the new song waits on the player, taking over from the incoming deck in ${(tk - now).toFixed(2)} s`);
    L.mixEnd = tk;
    L.phase = 'mixing';
    L.mixId = st.id;
  }
  // The player's level for this song (YouTube's own volume and normalisation)
  // against the deck's, both playing the same moment: the deck is brought to it.
  // `by`: when the new level is reached. The blend's incoming deck (inBus), or
  // the loop mix's (deckOut: by then the outgoing loop has drained away).
  function matchInLevel(L, by, which = 'in') {
    const g = graph();
    const deckTap = which === 'loop' ? loopDecks?.[1]?.tap : inTap;
    const p = which === 'loop' ? deckOut?.gain : inBus?.gain;
    const key = which === 'loop' ? 'deckBase' : 'inBase';
    if (live !== L || !g || !tap || !deckTap || !p || st?.ad) return;   // (an ad on the player isn't the song's level)
    const now = g.ctx.currentTime;
    if (now > by - 0.1 || L.muted || g.video.seeking || g.video.paused) return;
    const n = Math.round(0.25 * g.ctx.sampleRate);
    const a = new Float32Array(tap.fftSize), b = new Float32Array(deckTap.fftSize);
    tap.getFloatTimeDomainData(a); deckTap.getFloatTimeDomainData(b);
    const e = rms(a.subarray(a.length - n)), d = rms(b.subarray(b.length - n));
    if (e < 1e-3 || d < 1e-3) return;
    const want = clamp(e / d, 0.05, 4);   // the gain that plays the deck at the player's level now
    const was = L[key] * L.k;
    if (Math.abs(want / (was || 1e-6) - 1) < 0.03) return;   // already there
    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(want, by);
    log(`automix: ${which === 'loop' ? 'loop' : 'incoming'} deck level ${was.toFixed(2)} -> ${want.toFixed(2)} to match the player`);
    L[key] = want / (L.k || 1);
  }
  // A tap on a deck's plain output (before its own gain, the mix's curve), for matchInLevel.
  function deckTapOf(d, ctx) {
    if (!d.tap) {
      d.tap = ctx.createAnalyser();
      d.tap.fftSize = 16384; d.tap.smoothingTimeConstant = 0;
      d.lp.connect(d.tap);
    }
    return d.tap;
  }

  // ───────── per-tick logic while a crossfade is in progress ─────────
  function driveLive(g, v) {
    const now = g.ctx.currentTime;
    if (seconds() === 0 || !v || g.video !== v) { abortLive('crossfade off or player changed'); return; }

    // Honour a mute, and the volume slider, while the copy and the decks play.
    // Until Next the player still holds the old song, so its volume is the
    // user's; after Next YouTube may set the new song's own level on it, so
    // only a mute is followed from then on.
    const muted = v.muted || v.volume === 0;
    const k = !live.askedAt && v.volume > 0 ? v.volume / live.volRef : live.k;
    if ((muted !== live.muted || Math.abs(k - live.k) > 0.005) && now > live.T + 0.1) {
      live.muted = muted;
      live.k = k;
      const f = muted ? 0 : k;
      live.vol.gain.cancelScheduledValues(now);
      live.vol.gain.setTargetAtTime(live.base * f, now, 0.03);
      if (deckOut && live.mix?.style === 'loop') { deckOut.gain.cancelScheduledValues(now); deckOut.gain.setTargetAtTime(live.deckBase * f, now, 0.03); }
      if (inBus && live.inDeck) { inBus.gain.cancelScheduledValues(now); inBus.gain.setTargetAtTime(live.inBase * f, now, 0.03); }
    }

    // An ad flag that clears within AD_GRACE is an ad slot a blocker emptied
    // (Firefox with uBlock shows one for a moment as the next song starts):
    // the mix waits it out. One that stays is a real ad and ends the mix.
    if (st?.ad) live.adAt ??= now; else live.adAt = undefined;
    const adLong = st?.ad && now - live.adAt > AD_GRACE;

    if (live.phase === 'asked') {
      if (!live.askedAt) {
        // the old song still on the player, silent, until Next is pressed
        if (st && st.id && st.id !== live.oldId) {
          // YouTube moved on to the mix's next song by itself: as if we had pressed Next
          if (live.mix && st.id === live.mix.nextId) { live.askedAt = now; return; }
          abortLive('skipped before the mix');
          return;
        }
        if (v.paused && now > live.T + 0.5) { abortLive('paused'); return; }
        // the user's changes meanwhile (the player shows the old song until the mix's midpoint)
        if (st.rep) { abortLive('repeat one turned on'); return; }
        if (live.mix && st.next && st.next !== live.mix.nextId) { abortLive('the queue changed before the mix'); return; }
        if (Math.abs(v.currentTime - (st.off || 0) - (live.aPos + (now - live.T))) > 3) { abortLive('seeked before the mix'); return; }
        if (now >= live.askAt) askNext(live);
        return;
      }
      const sinceAsk = now - live.askedAt;
      const changed = st && st.id && st.id !== live.oldId;
      if (!changed) {
        if (sinceAsk > 1 && v.paused) abortLive('paused');   // user paused, or next did nothing
        else if (sinceAsk > 8) abortLive('next song never started');
        return;
      }
      if (!live.newId) { live.newId = st.id; live.newAt = now; }
      else if (st.id !== live.newId) { abortLive('skipped again'); return; }
      if (st.ad) { if (adLong) abortLive('ad'); return; }
      // YouTube can switch the title before the <video> really plays the new
      // song. Fading the player back in then replays the old song's last
      // moments over the tail. Only bring it in once its position looks like
      // the start of the new song.
      const newPos = v.currentTime - (st.off || 0);
      const fresh = newPos >= 0 && newPos < (now - live.askedAt) + 2;
      const audible = fresh && !v.paused && (live.playedAt >= live.askedAt || now - live.newAt > 1.2);
      if (audible) {
        if (live.mix?.style === 'loop') {
          // the loop already plays on its decks; late, the player is seeked to where it should be
          if (st.id === live.mix.nextId) loopTakeOver(g, v);
          else abortLive('the queue played another song than the loop mix was for');
        } else if (live.inDeck) blendTakeOver(g, v);
        else if (live.mix) beginAutomix(g, v);
        else beginMix(g);
      }
      else if (now - live.newAt > 5) abortLive('next song silent');
    } else if (live.phase === 'mixing') {
      const ours = live.mix && deck && deck.id === live.mixId && deck.holding;   // our own hold before the start
      if (st.ad) { if (adLong) abortLive('ad'); }   // an ad mid-blend: stop steering the player (its rate would go to the ad)
      else if ((v.paused && !ours) || st.id !== live.mixId) abortLive(st.id !== live.mixId ? 'song changed' : 'paused');
      else if (live.mix && deck?.foreign) abortLive('seeked');
      else if (now > live.mixEnd + 0.25) finishLive();   // old tail is silent now; free the next skip
    }
  }

  const remaining0 = (v) => st.dur - (v.currentTime - st.off);
  const tick = {};
  // ───────── Visual Automix HUD Notification ─────────
  // Slides up when the blend starts, turns into "Blend finished" when it ends
  // (old content fades up and out, the pill resizes, the new content fades
  // in), then slides back down. Animation lives in canvas.css.
  const toastEl = () => document.getElementById('vivi-automix-toast');
  const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; if (text != null) s.textContent = text; return s; };
  const toastBody = (icon, title, subtitle, wave) => {
    const content = span('vivi-automix-content');
    content.append(span('vivi-automix-title', title), span('vivi-automix-subtitle', subtitle));
    const parts = [span('vivi-automix-icon', icon)];
    if (wave) { const w = span('vivi-automix-wave'); for (let i = 0; i < 4; i++) w.appendChild(span('')); parts.push(w); }
    parts.push(content);
    return parts;
  };
  let toastTimers = [];
  const clearToastTimers = () => { toastTimers.forEach(clearTimeout); toastTimers = []; };

  // "Automix in 4 s" for the last COUNTDOWN_SEC before a planned mix. Each
  // tick refreshes it; when the ticks stop (pause, seek away, skip, the mix
  // starting and taking the toast over) it slides away by itself.
  const COUNTDOWN_SEC = 5;
  let cdMix = null;   // the mix being counted down to
  function countdown(left, m) {
    if (!(left > 0 && left <= COUNTDOWN_SEC)) return;
    cdMix = m;
    try {
      const what = m.style === 'loop' ? `loop mix · ${m.bars} bars`
        : m.style === 'crossfade' ? `crossfade${m.reason ? ' · ' + m.reason : ''}`
        : `${m.style === 'filter' ? 'filter mix' : 'blend'} · ${m.bars} bars · ${Math.round(m.bpm)} BPM`;
      const title = `Automix in ${Math.ceil(left)} s`;
      const toast = toastEl();
      if (toast?.dataset.countdown === '1' && toast.classList.contains('vivi-automix-visible')) {
        toast.querySelector('.vivi-automix-title').textContent = title;
        toast.querySelector('.vivi-automix-subtitle').textContent = what;
        clearToastTimers();
      } else {
        showAutomixNotification(title, what);
        toastEl().dataset.countdown = '1';
      }
      toastEl().dataset.at = String(performance.now());
      toastTimers.push(setTimeout(hideAutomixNotification, TICK_MS * 4));
    } catch { /* cosmetic */ }
  }

  function showAutomixNotification(title, subtitle) {
    try {
      clearToastTimers();
      let toast = toastEl();
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'vivi-automix-toast';
        document.body.appendChild(toast);
      }
      delete toast.dataset.countdown;
      toast.dataset.at = String(performance.now());
      toast.classList.remove('vivi-automix-done', 'vivi-automix-swap');
      toast.style.width = '';
      toast.replaceChildren(...toastBody('🎧', title, subtitle, true));
      // Let the hidden state render first, or a toast made just now would
      // appear in place instead of sliding up. A background tab runs no
      // animation frames: there it is shown at once (a frame queued then
      // would only run when the tab is back, after the mix it announces).
      void toast.offsetWidth;
      if (document.hidden) toast.classList.add('vivi-automix-visible');
      else requestAnimationFrame(() => toast.classList.add('vivi-automix-visible'));
    } catch (e) {
      console.warn('[Vivi Crossfade] Toast error:', e);
    }
  }

  function finishAutomixNotification() {
    try {
      const toast = toastEl();
      if (!toast || !toast.classList.contains('vivi-automix-visible')) return;
      clearToastTimers();
      toast.dataset.at = String(performance.now());
      const from = toast.getBoundingClientRect().width;
      toast.style.width = from + 'px';
      toast.classList.add('vivi-automix-swap');   // old content fades up and out
      toastTimers.push(setTimeout(() => {
        const parts = toastBody('✨', 'Automix', 'Blend finished', false);
        parts.forEach((p) => p.classList.add('vivi-automix-enter'));
        toast.replaceChildren(...parts);
        toast.classList.remove('vivi-automix-swap');
        // the pill resizes to the new content
        toast.style.width = '';
        const to = toast.getBoundingClientRect().width;
        toast.style.width = from + 'px';
        void toast.offsetWidth;
        toast.style.width = to + 'px';
        toast.classList.add('vivi-automix-done');
        requestAnimationFrame(() => requestAnimationFrame(() => parts.forEach((p) => p.classList.remove('vivi-automix-enter'))));
      }, 200));
      toastTimers.push(setTimeout(hideAutomixNotification, 2700));
    } catch { /* cosmetic */ }
  }

  // The toast's timers can be lost (a background tab, a timer cleared by the
  // next toast), so the main tick also checks it against what is playing and
  // takes away one that outlived its mix: a countdown not refreshed for 1.5 s,
  // "Blend finished" after 3.5 s, a mix toast 2 s after the mix ended.
  let lastLiveAt = 0;
  function toastWatch() {
    const now = performance.now();
    if (live) { lastLiveAt = now; return; }
    const t = toastEl();
    if (!t || !t.classList.contains('vivi-automix-visible')) return;
    const age = now - (Number(t.dataset.at) || 0);
    const stale = t.dataset.countdown === '1' ? age > 1500
      : t.classList.contains('vivi-automix-done') || t.classList.contains('vivi-automix-swap') ? age > 3500
      : now - lastLiveAt > 2000 && age > 2000;
    if (stale) hideAutomixNotification();
  }

  function hideAutomixNotification() {
    const toast = toastEl();
    if (!toast) return;
    clearToastTimers();
    toast.classList.remove('vivi-automix-visible', 'vivi-automix-swap');
    toastTimers.push(setTimeout(() => { if (!toast.classList.contains('vivi-automix-visible')) toast.style.width = ''; }, 400));
  }

  // ───────── the player bar during a mix (BitChord web's useScrubber pulse) ─────────
  // Before a mix, its stretch of the seek bar is softly lit. While it runs, the
  // fill glides out to the whole bar and breathes on the mix's beat, the times
  // fade into "Mixing", and a player held paused under a loop mix still shows
  // its pause button: the music plays on.
  const COVER_SEC = 0.7;        // the fill's glide out to full width, and back
  const PULSE_FADE_SEC = 0.9;   // the beat pulse swelling in and settling
  const PULSE_REST = 0.1;       // brightness between beats, as a share of the fill's
  const PHASE_PULL = 0.06;      // share of the phase error corrected per frame
  const BREATH_SEC = 1.8;       // breathing period when the mix has no tempo (a plain crossfade)
  const smooth = (x) => x * x * (3 - 2 * x);
  const beatShape = (ph) => { const c = 0.5 + 0.5 * Math.cos(2 * Math.PI * ph); return c * c; };
  const pulse = { cover: 0, depth: 0, phase: 0, locked: false, last: performance.now() };
  let mixUiFrame = 0, mixUiShown = false;

  // The running mix's beat: null between mixes, { phase: null } when its tempo is unknown.
  function mixBeat() {
    const g = graph();
    // (a loop mix runs before its phase turns to 'mixing': the player shows the old song until its midpoint)
    if (!live || !live.mixEnd || !g) return null;
    const now = g.ctx.currentTime;
    if (now < live.mixStart || now > live.mixEnd) return null;
    const bt = live.beatTimes;
    if (bt?.length > 1) {
      let k = 0;
      while (k < bt.length - 2 && bt[k + 1] <= now) k++;
      return { phase: Math.max(0, (now - bt[k]) / (bt[k + 1] - bt[k])) % 1 };
    }
    if (live.beatSec > 0) return { phase: ((((now - live.mixStart) / live.beatSec) % 1) + 1) % 1 };
    return { phase: null };
  }

  function stepPulse(now, beat, paused) {
    const p = pulse, dt = Math.min(0.1, Math.max(0, (now - p.last) / 1000));
    p.last = now;
    p.cover = clamp(p.cover + (beat ? dt : -dt) / COVER_SEC, 0, 1);
    p.depth = clamp(p.depth + (beat && !paused ? dt : -dt) / PULSE_FADE_SEC, 0, 1);
    if (beat?.phase != null) {
      const error = ((((beat.phase - p.phase) % 1) + 1.5) % 1) - 0.5;
      p.phase += p.locked ? error * PHASE_PULL : error;
      p.locked = true;
    } else {
      p.phase += dt / BREATH_SEC;
      if (beat) p.locked = false;
    }
    p.phase -= Math.floor(p.phase);
    const depth = smooth(p.depth), pulsed = PULSE_REST + (1 - PULSE_REST) * beatShape(p.phase);
    return { cover: smooth(p.cover), alpha: 1 + (pulsed - 1) * depth, active: p.cover > 0 || p.depth > 0 };
  }

  function mixUiEls() {
    const bar = document.querySelector('ytmusic-player-bar');
    const track = bar?.querySelector('#progress-bar #progressContainer');
    if (!bar || !track) return null;
    const make = (cls, parent, tag = 'div') => {
      let el = parent.querySelector(':scope > .' + cls);
      if (!el) { el = document.createElement(tag); el.className = cls; el.setAttribute('aria-hidden', 'true'); parent.appendChild(el); }
      return el;
    };
    const time = bar.querySelector('.time-info');
    const label = time?.parentElement ? make('vivi-mix-label', time.parentElement, 'span') : null;
    if (label && !label.textContent) label.textContent = 'Mixing';
    return { bar, track, fill: make('vivi-mix-fill', track), win: make('vivi-mix-window', track), time, label, primary: track.querySelector('#primaryProgress') };
  }

  function drawMixUi() {
    mixUiFrame = 0;
    const els = mixUiEls();
    if (!els) return;
    const v = graph()?.video;
    const held = !!(live?.mix && deck?.holding);   // ours (held, or just asked to start): the mix plays on
    const beat = mixBeat();
    const m = pulse.cover > 0 || beat ? stepPulse(performance.now(), beat, !!v?.paused && !held) : (pulse.last = performance.now(), null);
    const { bar, track, fill, win, time, label, primary } = els;
    bar.classList.toggle('vivi-mix-hold', held);
    // while a mix runs the bar only flashes: the song position (fill, knob) isn't what plays
    bar.classList.toggle('vivi-mixing', !!beat);

    // the coming mix's stretch of the bar, lit until the mix starts
    const p = amx.plan, dur = st?.dur || 0;
    const planned = !beat && !live && p && amx.id === st?.id && dur > 0 && ['idle', 'waiting', 'ready'].includes(amx.state);
    if (planned) {
      const a = clamp(p.mixOutTrackTime / dur, 0, 1), b = clamp((p.mixOutTrackTime + p.durationSec) / dur, a, 1);
      win.style.left = (a * 100).toFixed(3) + '%';
      win.style.width = ((b - a) * 100).toFixed(3) + '%';
    }
    win.classList.toggle('vivi-on', !!planned);

    if (m?.active) {
      const tw = track.getBoundingClientRect().width || 1;
      const base = clamp((primary?.getBoundingClientRect().width || 0) / tw, 0, 1);
      if (primary) fill.style.background = getComputedStyle(primary).backgroundColor;
      fill.style.width = ((base + (1 - base) * m.cover) * 100).toFixed(2) + '%';
      fill.style.opacity = String(m.alpha);
      if (time) time.style.opacity = String(1 - m.cover);
      if (label && time) {
        label.style.left = time.offsetLeft + 'px';
        label.style.top = time.offsetTop + 'px';
        label.style.width = time.offsetWidth + 'px';
        label.style.opacity = String(m.cover * (0.35 + 0.65 * m.alpha));
      }
      mixUiShown = true;
    } else if (mixUiShown) {
      fill.style.opacity = '0';
      if (time) time.style.opacity = '';
      if (label) label.style.opacity = '0';
      mixUiShown = false;
    }
    if (m?.active || beat) mixUiFrame = requestAnimationFrame(() => { mixUiFrame = 0; kickMixUi(); });
  }
  // (never in Automix's way: a broken player bar only loses the animation)
  let mixUiError = '';
  function kickMixUi() {
    if (mixUiFrame) return;
    try { drawMixUi(); } catch (e) {
      mixUiFrame = 0;
      if (mixUiError !== String(e)) { mixUiError = String(e); log('mix animation:', e?.stack || e); }
    }
  }

  // ───────── main tick ─────────
  setInterval(() => {
    const g = graph();
    const v = g?.video;
    toastWatch();
    kickMixUi();
    // the page sends media keys here while a mix holds the player
    if (!!live?.mix !== mixSent) { mixSent = !!live?.mix; post({ type: 'mixing', on: mixSent }); }
    // Next pressed during a mix, before the player had moved on: the new song
    // goes on from where the mix had brought it, once it really plays (a seek
    // while YouTube still loads it is lost)
    if (jumpTo && (performance.now() - jumpTo.at > 10000 || live)) jumpTo = null;
    if (jumpTo && v && st?.id === jumpTo.id && !v.paused && v.readyState >= 3) {
      const pos = v.currentTime - (st.off || 0);
      if (pos < jumpTo.t - 1) post({ type: 'seek', t: jumpTo.t });
      jumpTo = null;
    }
    if (live) {
      if (g) driveLive(g, v); else live = null;
      // the hand-over runs a few seconds ahead of the mix (more before a speed-up,
      // so the countdown may not have begun): count down to it on the audio clock
      // the mix starts by, never over another toast that is showing
      const tst = toastEl();
      const otherToast = tst?.classList.contains('vivi-automix-visible') && tst.dataset.countdown !== '1';
      if (g && live?.mix && live.t0 != null && g.ctx.currentTime < live.t0 - 0.1 && !otherToast) countdown(live.t0 - g.ctx.currentTime, live.mix);
      return;
    }
    if (skip) return;   // a manual skip is being prepared

    const N = seconds();
    if (!N || !g || !v || !st || performance.now() - stAt > 1500) return;
    if (g.ctx.state !== 'running' || g.video !== document.querySelector('#movie_player video, ytmusic-player video, video')) return;
    watchVideo(v);
    if (window.__viviAutomix?.isEnabled()) warmDecks(g);
    // The last blend's incoming song gliding back to its own tempo: its rate is ours, not the user's.
    if (deck && deck.id !== st.id) deck.cancel();
    const gliding = !!deck && deck.id === st.id;

    const eligible = !v.paused && (v.playbackRate === 1 || gliding) && !st.ad && !st.rep
      && st.dur >= Math.max(30, N * 2 + 8) && st.id && st.id !== failedId;
    if (!eligible) { if (remaining0(v) < N + PREP_LEAD && !tick[st.id]) { tick[st.id] = 1; log('not eligible:', { paused: v.paused, rate: v.playbackRate, ad: st.ad, repeatOne: st.rep, dur: st.dur, id: st.id, failed: st.id === failedId }); } return; }

    if (!userAutoAdvance) return;
    const pos = v.currentTime - st.off;
    const remaining = st.dur - pos;
    const ensureTap = () => {
      if (tap) return;
      tap = g.ctx.createAnalyser();
      tap.fftSize = 16384;
      tap.smoothingTimeConstant = 0;
      g.source.connect(tap);
    };

    // Automix (BitChord web's AutoDJ tick): download and analyse the playing
    // song and the one the queue plays next, plan the blend between them,
    // move the old song onto its decoded copy just before the blend, and mix.
    const A = window.__viviAutomix;
    const amxOn = !!A?.isEnabled();
    if (amx.id !== st.id) amx = { id: st.id, state: amxOn ? 'idle' : 'off', plan: null };
    else if (amxOn && amx.state === 'off') amx.state = 'idle';   // turned on during this song
    if (amxOn) {
      wantSong(st.id);
      if (st.next && st.next !== st.id) wantSong(st.next);
      if (songs.get(st.id)?.state === 'ready') A.request(st.id, true);   // the playing song's mix-out comes first
    } else if (amx.state !== 'fallback' && amx.state !== 'done') amx.state = 'off';

    if (amx.state === 'idle' || amx.state === 'waiting' || amx.state === 'ready') {
      if (amx.state === 'idle') {
        // Planned afresh each tick until the outro is asked for: it follows
        // seeks, a queue change and analyses as they land.
        const from = A.get(st.id), to = st.next ? A.get(st.next) : null;
        const pairKey = st.id + '>' + (st.next || '');
        const pick = pairPicks[pairKey] || null;
        const noLoop = !!pick && (['blend', 'filter', 'crossfade'].includes(pick.style) || (!pick.style && !!pick.bars));
        let p = A.plan({ fromId: st.id, toId: st.next, from, to, durationSec: st.dur, pos, earliest: pos + HAND_LEAD + 0.5, pick: noLoop ? pick : null });
        p.nextId = st.next || '';
        // The loop mix (BitChord AutoDJ): prepared in the background as soon as
        // both songs are analysed, so the status shows it from the start; when
        // it found bars to loop, it is the mix. (Its bars are searched in the
        // song's last OUT_SEARCH_SEC, so preparing early picks the same loop.)
        // (a blend, filter mix or fade picked in the overview: no loop mix for this pair)
        if (st.next && from && to && loopPrep.key !== pairKey && !noLoop) prepareLoopMix(g, st.id, st.next, pos);
        const loopPending = !noLoop && loopPrep.key === pairKey && loopPrep.state === 'loading';
        const lp = !noLoop && loopPrep.key === pairKey && loopPrep.state === 'ready' ? loopPrep : null;
        if (lp && lp.plan.out.loop[0] > pos + HAND_LEAD + 1) {
          const x = A.loopSchedule(lp.plan, 0);
          // (the loop decks do the tempo: none of the blend's speed-up of the playing song)
          p = { ...p, style: 'loop', loop: lp.plan, fallback: false, reason: '', outRate: 1, rampBeats: 0, rampSongSec: 0,
            mixOutTrackTime: lp.plan.out.loop[0], durationSec: x.elementAt,
            mixInTrackTime: x.elementTrackTime, rate: 1, bars: lp.plan.totalBars, bpm: lp.plan.out.bpm, inBpm: lp.plan.in.bpm, nextId: st.next };
        }
        amx.plan = p;
        // a blend: the next song's part of it is put on the incoming deck meanwhile
        if (p.style !== 'loop' && !p.fallback && !loopPending && to) prepareInDeck(g, p);
        // the old song moves to its decoded copy this long before the blend: before its speed-up, if it has one
        const lead = HAND_LEAD + (p.style === 'blend' ? p.rampSongSec || 0 : 0);
        if (p.outRate > 1.0001) ensureBlendDeck(g);
        if (!(p.durationSec >= 1)) { amxGiveUp('no room left for a blend'); }
        else if (pos >= p.mixOutTrackTime - lead - TAIL_LEAD && !(loopPending && pos < p.mixOutTrackTime - lead - 8)) {
          const needFrom = st.off + Math.max(0, p.mixOutTrackTime - lead - 3);
          ensureTap();
          if (p.style === 'loop' && !(plan && plan.id === st.id && plan.loop)) {
            // the outgoing song's copy is cut from the loop deck's own samples
            setPlan(g, { id: st.id, channels: lp.tail.channels, sampleRate: lp.tail.sampleRate, start: st.off + lp.tail.start });
            plan.loop = true;
            log(`automix: loop mix planned from ${p.mixOutTrackTime.toFixed(2)} s for ${p.durationSec.toFixed(1)} s (${p.bars} bars), next song takes over at ${p.mixInTrackTime.toFixed(2)} s`);
          }
          if (plan && plan.id === st.id && plan.start <= needFrom && plan.start + plan.buf.duration >= st.off + st.dur - 1) {
            amx.state = 'ready';   // the decoded copy already covers it
          } else if (reqId !== st.id && performance.now() >= retryAt) {
            reqId = st.id;
            amx.state = 'waiting';
            log(`automix: ${p.style} planned from ${p.mixOutTrackTime.toFixed(2)} s for ${p.durationSec.toFixed(1)} s` +
              (p.style === 'crossfade' ? '' : `, ${p.bars} bars at ${p.bpm.toFixed(1)} BPM`) +
              `, next song ${p.nextId || '(none)'} from ${p.mixInTrackTime.toFixed(2)} s at x${p.rate.toFixed(3)}` +
              (p.reason ? ` (${p.reason})` : '') + '; asking for the outro');
            post({ type: 'prepare', id: st.id, sampleRate: g.ctx.sampleRate, needFrom, cover: p.durationSec * (p.outRate || 1) + lead + 3, automix: true });
          }
        }
        // Still downloading or analysing: the plain crossfade is only a placeholder
        // until the analyses land (it is replanned every tick), not a verdict.
        const busy = (id) => songs.get(id)?.state === 'loading' || ['pending', 'analyzing'].includes(A.statusOf(id));
        const analysing = !from && busy(st.id) ? 'this song' : st.next && !to && busy(st.next) ? 'the next song' : '';
        const shown = amx.state === 'idle' && p.fallback && analysing ? { ...p, reason: `analysing ${analysing}…` } : p;
        if (amx.state === 'idle') amx.plan = shown;
        A.setStatus(amx.state === 'fallback' ? 'fallback' : 'planned', { bpm: p.bpm, conf: from ? (from.tailGrid?.gridConfidence ?? from.gridConfidence) : null, mix: shown });
      }
      // (amxGiveUp just above may have dropped the plan: the plain crossfade has no countdown)
      if (amx.plan && amx.state !== 'fallback') countdown(amx.plan.mixOutTrackTime - pos, amx.plan);
      if (amx.state === 'ready' && plan && plan.id === st.id && tap) {
        const handAt = amx.plan.mixOutTrackTime - HAND_LEAD - (amx.plan.style === 'blend' ? amx.plan.rampSongSec || 0 : 0);
        if (pos > handAt + 1) { amx.state = 'idle'; return; }   // seeked past it: plan again from here
        // a speed-up waits for the stretch deck to hold the copy (seeked past meanwhile: planned again above)
        if (pos >= handAt - TICK_MS / 2000 && (amx.plan.style !== 'blend' || outgoingDeckReady(g, amx.plan))) {
          amx.state = 'done';
          A.setStatus('mixing', { mix: amx.plan });
          handOver(g, v, amx.plan.durationSec, amx.plan);
        }
        return;
      }
      if (amx.state === 'ready') amx.state = 'idle';   // its decoded copy was dropped: ask again
      if (amx.state === 'waiting' && pos > amx.plan.mixOutTrackTime - 1) amxGiveUp('outro not ready in time');
      if (amx.state !== 'fallback') return;   // automix has this song; the plain crossfade below is its last resort
    }
    if (amx.state === 'done') { amx.state = 'idle'; return; }   // the hand-over didn't happen (alignment): plan again

    if (remaining > N + PREP_LEAD + 1 || remaining < 0.8) return;

    if (reqId !== st.id && performance.now() >= retryAt) {
      reqId = st.id;
      ensureTap();
      log('requesting tail, remaining', remaining.toFixed(1), 's');
      post({
        type: 'prepare', id: st.id, sampleRate: g.ctx.sampleRate,
        needFrom: st.off + st.dur - (N + PREP_LEAD + 3), cover: N + 3,
      });
    }

    if (plan && plan.id === st.id && tap && remaining <= N + startDelay && remaining >= 1) {
      handOver(g, v, N);
    }
  }, TICK_MS);

  // ───────── the Automix overview's view of the mix (automix-overview.js) ─────────
  // The coming mix (or the one playing) on its own clock, 0 at its start:
  // what each song plays and how loud, as the mix will play it.
  let ovShape = { m: null, src: null };
  function overviewSnapshot() {
    const g = graph(), A = window.__viviAutomix;
    if (!A?.isEnabled()) return { why: 'Automix is off' };
    if (!st?.id) return { why: 'Nothing is playing' };
    const m = live?.mix || (amx.id === st.id && amx.state !== 'off' ? amx.plan : null);
    if (!m) {
      const why = live ? 'A plain crossfade is playing' : amx.state === 'fallback' ? 'This song ends with a plain crossfade' : st.next ? 'Planning the mix…' : 'Nothing queued after this song';
      // a pick for this pair stays undoable while there is no mix to show
      const pairKey = !live && st.next ? st.id + '>' + st.next : '';
      return pairKey && pairPicks[pairKey] ? { why, pairKey, toId: st.next, pick: pairPicks[pairKey] } : { why };
    }
    const fromId = live ? live.oldId : st.id;
    const toId = m.nextId || (live ? '' : st.next) || '';
    const pairKey = fromId + '>' + toId;
    // the mix's shape, worked out once per plan (the overview asks every frame)
    const src = m.style === 'loop' ? live?.loopX || null : null;
    if (ovShape.m !== m || ovShape.src !== src) {
      let x = null;
      if (m.style === 'loop') {
        const s = src || A.loopSchedule(m.loop, 0), z = s.t0;
        const rel = (c) => ({ ...c, output: c.output - z });
        x = { beatTimes: s.beatTimes.map((t) => t - z), outChanges: s.outChanges.map(rel), inChanges: s.inChanges.map(rel),
          enterEnd: s.enterEnd - z, rampEnd: s.rampEnd - z, releaseAt: s.releaseAt - z, elementAt: s.elementAt - z,
          mid: s.mid - z, bar: s.bar, elementTrackTime: s.elementTrackTime };
      }
      const D = x ? x.elementAt : m.durationSec;
      const [gIn, gOut] = x ? [null, null] : gainCurves(m, m.style, D);
      ovShape = { m, src, x, D, gIn, gOut };
    }
    const { x, D, gIn, gOut } = ovShape;
    // where the music is on the mix's clock
    let at = null;
    if (g && live?.t0 != null) at = g.ctx.currentTime - live.t0;
    else if (g && !live) at = (g.video.currentTime - (st.off || 0)) - m.mixOutTrackTime;
    const lp = loopPrep.key === pairKey ? loopPrep : null;
    return {
      fromId, toId, pairKey, mix: m, x, D, at, gIn, gOut,
      phase: live ? live.phase : amx.state,
      paused: !live && !!g?.video?.paused,
      fromDur: live ? null : st.dur,
      pick: pairPicks[pairKey] || null,
      loop: lp ? { state: lp.state, why: lp.why || '' } : null,
      // before the hand-over a pick can still change this mix, and a preview can jump to it
      editable: !live && st.id === fromId,
      previewAt: m.mixOutTrackTime - HAND_LEAD - (m.style === 'loop' ? 8 : TAIL_LEAD + 3 + (m.rampSongSec || 0)),
    };
  }

  window.__viviCrossfade = {
    active: () => !!live,
    overview: overviewSnapshot,
    setPairPick,
    // the preview: the playing song jumps to just before its mix
    seekTo: (t) => { if (!live && st) post({ type: 'seek', t: Math.max(0, t) }); },
    // While a blend is running the <video> already plays the next song, but
    // the old one is what you mostly hear until the middle of the blend.
    // Returns that song and its current position so the lyrics can stay on it.
    lyricsHold: () => {
      const g = graph();
      if (!live || !g) return null;
      const now = g.ctx.currentTime;
      if (live.phase === 'mixing' && now >= (live.handoffAt ?? (live.mixStart + live.mixEnd) / 2)) return null;
      const t = live.aPos + (now - live.T);
      // a loop mix: the old song repeats its loop, so its lyrics wait at the loop start
      return { id: live.oldId, timeSec: live.mix?.style === 'loop' ? Math.min(t, live.mix.loop.out.loop[0]) : t };
    },
    status: () => ({
      seconds: seconds(), graph: !!graph(), ctx: graph()?.ctx.state, state: st,
      remaining: st && graph() ? st.dur - (graph().video.currentTime - st.off) : null,
      plan: !!plan, reqId, failedId, live: live && live.phase,
      automix: {
        state: amx.state,
        mix: amx.plan && { ...amx.plan, mixSec: amx.plan.durationSec, startAt: amx.plan.mixOutTrackTime },
        next: st?.next || '',
        songs: Object.fromEntries([...songs].map(([id, f]) => [id, f.state + (f.client ? ' via ' + f.client : '') + (f.why ? ' (' + f.why + ')' : '')])),
        analysis: st ? { current: window.__viviAutomix?.statusOf(st.id), next: st.next ? window.__viviAutomix?.statusOf(st.next) : null } : null,
        loop: { pair: loopPrep.key, state: loopPrep.state, why: loopPrep.why || '', decks: !!loopDecks },
        inDeck: { song: inPrep.key, state: inPrep.state, end: inPrep.end, why: inPrep.why || '', live: !!live?.inDeck },
        deck: deck && { id: deck.id, rate: deck.v.playbackRate, error: deck.lastError ?? null, seeks: deck.seeks, held: deck.held },
      },
    }),
  };
})();

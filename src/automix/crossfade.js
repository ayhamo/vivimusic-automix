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
  let userOn = false, userSecs = 6, userManualSkip = true, userAutoAdvance = true, saver = false, userStreamDeck = false;
  const seconds = () => (userOn && !saver ? clamp(Math.round(userSecs) || 0, 1, MAX_SECONDS) : 0);

  function post(msg) {
    window.postMessage({ ch: CHANNEL, dir: 'in', ...msg }, window.location.origin);
  }

  function applyConfig() {
    log('config: seconds =', seconds(), '| enabled:', userOn, '| manualSkip:', userManualSkip, '| autoAdvance:', userAutoAdvance, '| resource saver:', saver);
    post({ type: 'config', enabled: seconds() > 0 });
    if (seconds() === 0 || (!userStreamDeck && !sdeck?.addon)) streamDeckBack('turned off');
    if (seconds() === 0) { if (live) abortLive(); dropPlan(); }
    else if (navigator.userActivation?.hasBeenActive) wake();
  }

  try {
    chrome.storage.local.get({
      crossfadeEnabled: false,
      crossfadeSeconds: 6,
      crossfadeManualSkip: true,
      crossfadeAutoAdvance: true,
      resourceSaverEnabled: false,
      automixStreamDeck: false
    }, (r) => {
      userOn = r.crossfadeEnabled === true;
      userSecs = Number(r.crossfadeSeconds) || 6;
      userManualSkip = r.crossfadeManualSkip !== false;
      userAutoAdvance = r.crossfadeAutoAdvance !== false;
      saver = r.resourceSaverEnabled === true;
      userStreamDeck = r.automixStreamDeck === true;
      applyConfig();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('crossfadeEnabled' in ch) userOn = ch.crossfadeEnabled.newValue === true;
      if ('crossfadeSeconds' in ch) userSecs = Number(ch.crossfadeSeconds.newValue) || 6;
      if ('crossfadeManualSkip' in ch) userManualSkip = ch.crossfadeManualSkip.newValue !== false;
      if ('crossfadeAutoAdvance' in ch) userAutoAdvance = ch.crossfadeAutoAdvance.newValue !== false;
      if ('resourceSaverEnabled' in ch) saver = ch.resourceSaverEnabled.newValue === true;
      if ('automixStreamDeck' in ch) userStreamDeck = ch.automixStreamDeck.newValue === true;
      if ('addonsEnabled' in ch && ch.addonsEnabled.newValue !== true) { if (sdeck?.addon) streamDeckBack('addons turned off'); adeck = null; prepared.clear(); }
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

  // ───────── debug: the full-stream deck on the playing song (src/plus/stream-deck.js) ─────────
  // postMessage({ ch: 'vivi-xfade', dir: 'out', type: 'vivi-stream-deck-test', reqId, sec, fail, trim, takeIn, release })
  // Plays the playing song on the deck from our copy of its audio, YouTube
  // muted, for `sec` seconds; every second: the deck's drift and the level of
  // YouTube's element against the deck's (both before their gains). With
  // `fail`, the deck's audio is then broken to check the handback. `takeIn`: the
  // deck takes over that many seconds in (a scheduled takeover, as after a mix);
  // `release`: it ends with a release (as at the next mix), the gate then reopened here.
  async function streamDeckTest(d) {
    const reply = (m) => window.postMessage({ ch: CHANNEL, dir: 'deck-test', reqId: d.reqId, ...m }, window.location.origin);
    const g = graph(), A = window.__viviAutomix, SD = window.__viviStreamDeck;
    if (!g || !st?.id || !A || !SD) { reply({ ok: false, error: 'not ready (audio graph, song or deck missing)' }); return; }
    const id = st.id, v = g.video, sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    let deck = null;
    try {
      const bytes = await A.audioBytes(id);
      deck = SD.create(g.ctx, g.bassFilter);
      await deck.load(bytes, 'audio/webm');
      const ytTap = g.ctx.createAnalyser(), dTap = g.ctx.createAnalyser();
      ytTap.fftSize = dTap.fftSize = 8192;
      g.source.connect(ytTap); deck.src.connect(dTap);
      const a = new Float32Array(8192), b = new Float32Array(8192);
      let handedBack = null, released = null;
      deck.follow({
        // (buffering or seeking, YouTube's time stands still: the deck waits with it)
        clock: () => (st && st.id === id ? { pos: v.currentTime - st.off, playing: !v.paused && !v.seeking && v.readyState >= 3 } : null),
        level: () => v.volume,
        gate: g.gate.gain,
        onHandback: (why) => { handedBack = why; },
        trim: d.trim !== false,
        takeAt: d.takeIn ? g.ctx.currentTime + d.takeIn : 0,
      });
      const samples = [];
      for (let s = 0; s < (d.sec || 20) && !handedBack; s++) {
        await sleepMs(1000);
        ytTap.getFloatTimeDomainData(a); dTap.getFloatTimeDomainData(b);
        const ry = rms(a), rd = rms(b);
        samples.push({ s: s + 1, pos: +(v.currentTime - st.off).toFixed(2), vol: +v.volume.toFixed(4), gate: +g.gate.gain.value.toFixed(3),
          ytOverDeck: rd > 1e-4 ? +(ry / rd).toFixed(4) : null, ...deck.stats() });
      }
      if (d.fail && !handedBack) {
        deck.el.src = 'blob:broken';   // the deck's audio fails mid-song
        await sleepMs(1500);
      } else if (!handedBack && d.release) {
        deck.release(g.ctx.currentTime + 0.2, 0.4);
        await sleepMs(900);
        released = { gate: +g.gate.gain.value.toFixed(3), deckGain: +deck.gain.gain.value.toFixed(3), state: deck.state };
        const now = g.ctx.currentTime, y = g.gate.gain;
        y.cancelScheduledValues(now); y.setValueAtTime(y.value, now); y.linearRampToValueAtTime(1, now + 0.05);
        await sleepMs(100);
      } else if (!handedBack) {
        deck.handBack('test over');
        await sleepMs(300);
      }
      try { g.source.disconnect(ytTap); deck.src.disconnect(dTap); } catch { /* gone */ }
      const after = { gate: +g.gate.gain.value.toFixed(3), deckGain: +deck.gain.gain.value.toFixed(3), playing: !v.paused, handedBack, released };
      deck.dispose();
      reply({ ok: true, id, samples, after });
    } catch (e) {
      deck?.dispose();
      reply({ ok: false, error: String(e?.message || e) });
    }
  }

  // ───────── state from the page world ─────────
  let st = null, stAt = 0, seenId = '';
  let plan = null, reqId = '', failedId = '', retryAt = 0, tries = 0, planSeq = 0;
  const MAX_TRIES = 4;
  let tap = null;
  let live = null;
  let startDelay = 0.5;   // learned: seconds between pressing next and hearing it

  // the test hooks (recordings, the deck test, fixtures, the net test) answer only where
  // storage.local viviDebug is set (the test Firefox's profile): any page script could post them
  let debugHooks = false;
  const DEBUG_TYPES = new Set(['vivi-dev-test', 'vivi-addon-rec', 'vivi-stream-deck-test', 'vivi-automix-fixture']);
  try {
    chrome.storage.local.get({ viviDebug: false }, (r) => { debugHooks = r.viviDebug === true; });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.viviDebug) debugHooks = ch.viviDebug.newValue === true; });
  } catch { /* no storage */ }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'out') return;
    if (DEBUG_TYPES.has(d.type) && !debugHooks) return;
    if (d.type === 'state') {
      st = d; stAt = performance.now();
      if (d.id !== seenId) {
        seenId = d.id;
        if (!live) { dropPlan(); reqId = ''; failedId = ''; tries = 0; }
        if (jumpTo && d.id !== jumpTo.id) jumpTo = null;
      }
    } else if (d.type === 'tail') {
      acceptTail(d);
    } else if (d.type === 'queued') {
      const w = queueWait.get(d.rid);
      if (w) { queueWait.delete(d.rid); clearTimeout(w.timer); w.resolve(d.ok ? { ok: true, n: d.n } : { ok: false, why: d.why || 'not queued' }); }
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
    } else if (d.type === 'vivi-addon-rec') {
      addonRecTest(d);
    } else if (d.type === 'vivi-stream-deck-test') {
      streamDeckTest(d);
    } else if (d.type === 'vivi-automix-fixture') {
      // Debug helper for spec/automix/pairs (the test Firefox's capture scenario): both songs'
      // analysis, where they are sung (synced lyrics), and their loudness at
      // 20 Hz, the way the planner reads it (rms() on channel 0, every 16th sample).
      const A = window.__viviAutomix, ids = Array.isArray(d.ids) ? d.ids.slice(0, 2) : [];
      const reply = (data) => window.postMessage({ ch: CHANNEL, dir: 'fixture', reqId: d.reqId, ...data }, window.location.origin);
      (async () => {
        const songsOut = [];
        // linesOnly: each song's lyric line shapes alone (the song must be in the queue for its title)
        if (d.linesOnly) {
          for (const id of (Array.isArray(d.ids) ? d.ids.slice(0, 12) : [])) songsOut.push({ id, lines: await A.lyricLines(id) });
          return reply({ ok: true, songs: songsOut });
        }
        for (const id of ids) {
          const analysis = A?.get(id);
          if (!analysis) throw new Error('not analysed yet: ' + id);
          const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await A.audioBytes(id));
          const data = buf.getChannelData(0), per = Math.round(buf.sampleRate / 20), loud = [];
          for (let w = 0; w * per < data.length; w++) {
            let ss = 0, n = 0;
            for (let i = w * per; i < Math.min(data.length, (w + 1) * per); i += 16) { ss += data[i] * data[i]; n++; }
            loud.push(n ? Math.round(Math.sqrt(ss / n) * 1e4) / 1e4 : 0);
          }
          // lines: their shapes only (times, word counts), never their text (versions.md "Where a song is sung")
          songsOut.push({ id, analysis, sung: await A.sungSpans(id), lines: await A.lyricLines(id), loudness20Hz: loud, decodedSec: buf.duration });
        }
        reply({ ok: true, songs: songsOut });
      })().catch((e) => reply({ ok: false, error: String(e?.message || e) }));
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
  // spotify-mixes.md rule 10: each song's speed in the playlist its mixes came from (the picks' `speed`).
  // cameFrom: the song the last mix brought in and the one it came from; speedSet: a rate this code put
  // on the player for a song's speed (0: none), so the user's own speed setting is left alone.
  let cameFrom = { id: '', from: '' }, speedSet = 0;
  const off1 = (s) => Math.abs(s - 1) >= 1e-4;
  function speedOf(id, nextId = st?.id === id ? st.next : null) {
    const A = window.__viviAutomix;
    if (!id || !A?.songSpeed) return 1;
    return A.songSpeed(id, cameFrom.id === id ? cameFrom.from : null, nextId || null, (k) => pairPicks[k] || null);
  }
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
  // An override (spec/automix/editor.md §1): Auto-only clears it; at most MAX_PICKS unlocked (the
  // oldest saved go first; picks from before the editor have no savedAt and go before them), and
  // locked ones are never evicted, with a cap of their own. Returns { refused } for a lock past it.
  function setPairPick(key, pick) {
    const A = window.__viviAutomix;
    const ov = A.normalizeOverride(pick);
    const next = { ...pairPicks };
    delete next[key];
    if (ov) next[key] = { ...ov, engine: A.getVersion?.() || undefined, savedAt: Date.now() };
    const locked = Object.keys(next).filter((k) => next[k]?.lock);
    if (ov?.lock && locked.length > MAX_PICKS) return { refused: `${MAX_PICKS} pairs are locked already: unlock one first` };
    const loose = Object.keys(next).filter((k) => !next[k]?.lock).sort((a, b) => (next[a].savedAt || 0) - (next[b].savedAt || 0));
    for (const k of loose.slice(0, Math.max(0, loose.length - MAX_PICKS))) delete next[k];
    pairPicks = next;
    try { chrome.storage.local.set({ [PICKS_KEY]: next }); } catch { /* extension context gone */ }
    replanPair(key);
    return { saved: next[key] || null };
  }
  // A mix file's overrides (spec/automix/mix-file.md rule 6), saved in one write as the editor saves
  // each: savedAt now, the cap as setPairPick's. list: [{ key, override }]. Returns { saved, refused }:
  // a lock past the locked cap is refused for that pair, with setPairPick's message.
  function importPairPicks(list) {
    const A = window.__viviAutomix;
    const next = { ...pairPicks }, saved = [], refused = [];
    const now = Date.now();
    for (const { key, override } of list || []) {
      const ov = A.normalizeOverride(override);
      if (!ov || !/^[^>]+>[^>]+$/.test(key || '')) continue;
      if (ov.lock && !next[key]?.lock && Object.keys(next).filter((k) => next[k]?.lock).length >= MAX_PICKS) {
        refused.push({ key, why: `${MAX_PICKS} pairs are locked already: unlock one first` });
        continue;
      }
      next[key] = { ...ov, engine: A.getVersion?.() || undefined, savedAt: now };
      saved.push(key);
    }
    const loose = Object.keys(next).filter((k) => !next[k]?.lock).sort((a, b) => (next[a].savedAt || 0) - (next[b].savedAt || 0));
    for (const k of loose.slice(0, Math.max(0, loose.length - MAX_PICKS))) delete next[k];
    pairPicks = next;
    try { chrome.storage.local.set({ [PICKS_KEY]: next }); } catch { /* extension context gone */ }
    if (st && saved.includes(st.id + '>' + (st.next || ''))) replanPair(st.id + '>' + (st.next || ''));
    return { saved, refused };
  }
  // "Play these mixes" (mix-file.md rule 7): a fresh queue of the songs, made by the page
  // (crossfade-page.js queueSongs), the first of them played. Resolves { ok, n } or { ok: false, why }.
  const queueWait = new Map();   // rid -> { resolve, timer }
  function queueSongs(ids) {
    return new Promise((resolve) => {
      const rid = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { queueWait.delete(rid); resolve({ ok: false, why: 'YouTube Music did not answer' }); }, 15000);
      queueWait.set(rid, { resolve, timer });
      post({ type: 'queue-songs', ids, rid });
    });
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
    if (d.automix && amx.plan && amx.plan.style !== 'loop') outgoingDeckReady(g, amx.plan);   // a speed-up or a song's speed: the stretch deck loads the copy now
  }

  function setPlan(g, d) {
    const len = d.channels[0].length;
    const buf = g.ctx.createBuffer(d.channels.length, len, d.sampleRate);
    d.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const L = d.channels[0], R = d.channels[1] || L;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    plan = { id: d.id, key: d.id + ':' + (++planSeq), buf, mono, rate: d.sampleRate, start: d.start };
    // the addon deck plays this song: the tail is cut from its file instead (the same place, its
    // sound), so the mix goes on in its quality; YouTube's copy (mono) still finds the place
    const rec = readyRec(d.id);
    if (rec && sdeck?.addon && sdeck.addonId === d.id && st?.id === d.id && rec.buf.sampleRate === d.sampleRate) {
      plan.buf = addonSpan(g.ctx, rec, d.start - st.off, len);
      plan.addon = true;
      addonEvent('tail', { id: d.id, from: d.start - st.off, sec: len / d.sampleRate });
    }
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
  // (durationSec, when known: a song over 8 minutes is marked too long without being analysed)
  function wantSong(id, durationSec = null) {
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
    if (f.state === 'ready') window.__viviAutomix?.request(id, true, durationSec);
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
        : inTrackAt(m, L.t0, now);
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

  // While a mix runs, what is heard is ours (the copy, the decks), not the
  // player: the player may be silent, loading the next song, or held paused
  // (a loop mix waits on it for ~20 s), so its button shows a spinner or
  // "paused", and a press would do nothing heard, or start it. A press of
  // play/pause during any phase of a mix means "pause" (playback.md rule 5):
  // the mix stops at once and the player stays paused.
  function onPlayPauseDuringHold(e) {
    if (!live) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (deck) deck.held = false;   // (cancelling a hold would press play first)
    post({ type: 'pause' });
    live.gateDelay = 0.4;          // the player's gate comes back once it has paused, not over its last moment
    abortLive('paused by you');
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
  // Automix v2's glide (automix.js glideSteps): both songs' speed steps once per
  // beat across the blend, beat-locked. Null for any other mix.
  const glideOf = (m) => (m?.style === 'blend' && m.glide ? window.__viviAutomix.glideSteps(m.glide.q, m.glide.beats, m.glide.beatOutSec) : null);
  // the playing song needs the stretch deck: a speed-up before the blend, or a glide in it
  const needsOutDeck = (m) => m?.style !== 'loop' && (m?.outRate > 1.0001 || !!m?.glide || off1(m?.speedOut || 1));
  // B's second at the mix start: its mix-in, less a late entry (mix-file.md rule 2: B comes in
  // inDelaySec into the mix), so before 0 while B is still silent
  const inStartOf = (m) => m.mixInTrackTime - (m.inDelaySec || 0) * (m.rate || 1);
  // B's gain with a late entry: 0 until `late` s into the curve whatever it says, then up to the curve
  // in 10 ms, so nothing of B before its mix-in is heard (a pre-roll, a player started early).
  // A sampled shape (fadeCurve) over d seconds, and a preset's events [t, v, step]:
  const LATE_RAMP = 0.01;
  function lateShape(shape, d, late) {
    if (!(late > 0) || !shape?.length) return shape;
    const out = shape.slice(), n = out.length;
    for (let i = 0; i < n && (d * i) / (n - 1) < late + LATE_RAMP; i++) out[i] = 0;
    return out;
  }
  function lateEvents(ev, late) {
    if (!(late > 0) || !ev?.length) return ev;
    const b = late + LATE_RAMP;
    let v = ev[ev.length - 1][1];
    for (let i = 1; i < ev.length; i++) {
      if (ev[i][0] < b) continue;
      const [t1, v1] = ev[i - 1], [t2, v2] = ev[i];
      v = ev[i][2] || t2 <= t1 ? (b >= t2 ? v2 : v1) : v1 + ((v2 - v1) * (b - t1)) / (t2 - t1);
      break;
    }
    return [[0, 0, false], [late, 0, false], [b, v, false], ...ev.filter((e) => e[0] > b + 1e-6)];
  }
  // The next song's second at audio time t of a blend that started at t0.
  function inTrackAt(m, t0, t) {
    const G = glideOf(m), dt = t - t0;
    // (during a late entry's wait B is at its mix-in: a skip then lands there, not before it)
    if (!G) return dt < (m.inDelaySec || 0) ? m.mixInTrackTime : inStartOf(m) + dt * (m.rate || 1);
    if (dt >= G.total) return m.mixInTrackTime + m.glide.beats * G.beatInSec + (dt - G.total);
    let k = 0;
    while (k + 1 < G.at.length && G.at[k + 1] <= dt) k++;
    return m.mixInTrackTime + k * G.beatInSec + Math.max(0, dt - G.at[k]) * G.inRate[k];
  }
  // True once the deck holds this decoded copy (starts loading it otherwise).
  function outgoingDeckReady(g, m) {
    if (!needsOutDeck(m)) return true;
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
    // the Looping lane (editor.md §13): from the mix-out on, its first loopSec seconds repeat
    if (m.loopSec > 0) { const a = bufAt(m.mixOutTrackTime); changes.push({ output: t, input: a, rate: R, active: true, loop: [a, a + m.loopSec] }); }
    changes.push({ output: L.tailEnd, input: p.buf.duration, rate: 1, active: false, loop: null });
    runOutDeck(L, p, changes, Tr);
    log(`automix: the playing song speeds up to x${R.toFixed(3)} over ${n} beats from ${rampStart.toFixed(2)} s (in ${(Tr - L.T).toFixed(2)} s)`);
    return true;
  }
  // A song at its playlist speed (spotify-mixes.md rule 10): the copy plays at x1 until the stretch deck
  // takes it over (PREROLL_SEC after the hand-over), then the deck plays it at `s` to its end; with the
  // Looping lane (editor.md §13), from the mix-out on, its first loopSec seconds repeat.
  function steadyOutgoing(L, m, p, off, s) {
    if (!blendDeck || blendDeck.loadedKey !== p.key) return false;
    const bufAt = (songT) => songT + off - p.start;
    const Tr = L.T + PREROLL_SEC + 0.1, songTr = L.aPos + (Tr - L.T);
    if (m.mixOutTrackTime < songTr + 0.2) return false;
    const changes = [{ output: Tr - PREROLL_SEC, input: bufAt(songTr) - PREROLL_SEC, rate: 1, active: true, loop: null },
      { output: Tr, input: bufAt(songTr), rate: s, active: true, loop: null }];
    L.t0 = Tr + (m.mixOutTrackTime - songTr) / s;
    L.tailEnd = Tr + (p.buf.duration - bufAt(songTr)) / s;
    if (m.loopSec > 0) { const a = bufAt(m.mixOutTrackTime); changes.push({ output: L.t0, input: a, rate: s, active: true, loop: [a, a + m.loopSec] }); }
    changes.push({ output: L.tailEnd, input: p.buf.duration, rate: 1, active: false, loop: null });
    runOutDeck(L, p, changes, Tr);
    log(`automix: the playing song goes on at its speed x${s.toFixed(4)} on the stretch deck from ${songTr.toFixed(2)} s${m.loopSec > 0 ? `, looping ${m.loopSec.toFixed(2)} s from the mix-out` : ''}`);
    return true;
  }
  // Automix v2's glide, the playing song's side: from the mix-out on, one rate
  // per beat (x1.0 towards the next song's tempo), held after the blend while it fades.
  function glideOutgoing(L, m, p, off) {
    const G = glideOf(m), b = m.glide.beatOutSec, start = m.mixOutTrackTime, B = G.outRate.length;
    if (!blendDeck || blendDeck.loadedKey !== p.key || start < L.aPos + 0.5) return false;
    const bufAt = (songT) => songT + off - p.start;
    const Tr = L.T + (start - L.aPos);
    const changes = [{ output: Tr - PREROLL_SEC, input: bufAt(start) - PREROLL_SEC, rate: 1, active: true, loop: null }];
    for (let k = 0; k < B; k++) changes.push({ output: Tr + G.at[k], input: bufAt(start + k * b), rate: G.outRate[k], active: true, loop: null });
    L.t0 = Tr;
    L.tailEnd = Tr + G.total + Math.max(0, p.buf.duration - bufAt(start + B * b)) / G.outRate[B - 1];
    changes.push({ output: L.tailEnd, input: p.buf.duration, rate: 1, active: false, loop: null });
    runOutDeck(L, p, changes, Tr);
    log(`automix: glide, the playing song goes x1.000 -> x${G.outRate[B - 1].toFixed(3)} and the next x${G.inRate[0].toFixed(3)} -> x1.000 over ${B} beats from ${start.toFixed(2)} s (in ${(Tr - L.T).toFixed(2)} s)`);
    return true;
  }
  // The playing song moves from its copy onto the stretch deck at Tr (25 ms), which plays `changes`.
  function runOutDeck(L, p, changes, Tr) {
    const H = 0.025;
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
  }

  function handOver(g, v, N, mix = null) {
    const ctx = g.ctx, p = plan, sr = p.rate;
    const frame = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(frame);
    const tRead = ctx.currentTime;
    // a song at its playlist speed (spotify-mixes.md rule 10): what is heard is stretched, so a shorter
    // stretch is matched against the copy, and the copy moves on at that speed
    const sA = off1(mix?.speedOut || 1) ? mix.speedOut : 1, steady = sA !== 1;
    const L = Math.round((steady ? 0.1 : 0.25) * sr), minScore = steady ? 0.8 : 0.9;
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
      if (!hit || hit.score < minScore) hit = locate(tmpl, p.mono, startIdx, Math.round(3 * sr));
      if (!hit || hit.score < minScore) {
        // my position estimate was off: look through the whole tail instead
        hit = locate(tmpl, p.mono, Math.round(p.mono.length / 2), p.mono.length);
      }
      log('alignment score:', hit && hit.score.toFixed(3), '| estimate was off by', hit ? Math.round((hit.index - startIdx) / sr * 1000) + ' ms' : 'n/a');
      if (!hit || hit.score < minScore) { retryOrGiveUp('alignment score too low'); return; }
      startIdx = hit.index;
    }
    // on a whole frame, from a whole sample of the copy: its own samples, not interpolated ones
    const T = Math.round((ctx.currentTime + 0.1) * sr) / sr;
    let idxT = Math.round(startIdx + L * sA + (T - tRead) * sr * sA);
    // the addon deck plays the song and the tail is cut from the same file: the tail goes on from
    // the deck's own sample there (what is heard), not from where YouTube's copy was found
    const deckRec = p.addon && sdeck?.audible && sdeck.addonId === st.id ? readyRec(st.id) : null;
    const deckAt = deckRec ? sdeck.fileAt(T) : null;
    if (deckAt != null) {
      const fromDeck = Math.round(deckAt * sr) - Math.round((p.start - st.off + deckRec.off) * sr);
      if (Math.abs(fromDeck - idxT) > 0.002 * sr) log(`addons: the tail follows the addon deck, ${((fromDeck - idxT) / sr * 1000).toFixed(1)} ms from YouTube's copy`);
      idxT = fromDeck;
    }
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
    // (a drawn mid band, editor.md §12: 0 dB passes through unchanged)
    const midB = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7, gain: 0 });
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000, gain: 0 });
    // (open: a high-pass at 0 Hz and a low-pass at Nyquist pass the samples through unchanged)
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 0, Q: 0.7 });
    // AutoDJ (version 2), or an editor preset's low-pass lane: the outgoing song's highs close through a low-pass
    const lp = (mix?.v2 && (mix.style === 'blend' || mix.style === 'filter')) || (mix?.preset && mix.curves?.out?.lowpassHz) ? new BiquadFilterNode(ctx, { type: 'lowpass', frequency: ctx.sampleRate / 2, Q: 0.7 }) : null;
    const vol = ctx.createGain();
    const srcGain = ctx.createGain();
    src.buffer = p.buf;
    src.connect(srcGain); srcGain.connect(fade); fade.connect(bass); bass.connect(midB); midB.connect(high); high.connect(hp);
    if (lp) { hp.connect(lp); lp.connect(vol); } else hp.connect(vol);
    vol.connect(g.entry);
    // a preset's Effects sends (editor.md §12): the deck after its fader, EQ and filters, into the returns
    const sends = mix?.preset ? fxSends(g, vol, mix.curves?.out) : null;
    vol.gain.setValueAtTime(0, T);
    vol.gain.linearRampToValueAtTime(base, T + SWITCH);
    hold(g.gate.gain, ctx.currentTime);
    if (sdeck?.audible) {
      // the stream deck plays the song (YouTube's gate is down): it gives way to the copy instead
      g.gate.gain.setValueAtTime(0, T);
      const d = sdeck;
      d.release(T, SWITCH);
      sdeck = null;
      // and freed once faded (its file, blob URL and nodes); a released deck's dispose leaves the gate alone
      setTimeout(() => d.dispose('released'), Math.max(0, T - ctx.currentTime + SWITCH + 0.3) * 1000);
    } else {
      streamDeckBack('the next mix');   // (one not in step yet: gone before the gate moves below)
      g.gate.gain.setValueAtTime(1, T);
      g.gate.gain.linearRampToValueAtTime(0, T + SWITCH);
    }
    src.start(T, idxT / sr);
    // echo out (automix.js echoOut): the beat before the catch fed to a delay line with feedback,
    // after the dry fade (which cuts the dry sound on the catch), so the echo rings on under the next song
    let echo = null;
    const echoT0 = mix?.shape === 'echo' && mix.echo && !steady ? T + (mix.mixOutTrackTime - (p.start + idxT / sr - st.off)) : 0;
    // (a catch already due, from a late hand-over, has no beat left to feed: the dry cut alone)
    if (echoT0 && echoT0 <= ctx.currentTime + 0.02) log('automix: echo out too late for its beat, the catch plays without the echo');
    else if (echoT0) {
      const t0 = echoT0, e = mix.echo;
      const send = new GainNode(ctx, { gain: 0 }), delay = new DelayNode(ctx, { maxDelayTime: 2, delayTime: Math.min(2, e.delaySec) });
      const fb = new GainNode(ctx, { gain: e.feedback }), wet = new GainNode(ctx, { gain: 1 });
      srcGain.connect(send); send.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(bass);
      // (the send opens before it closes, or the later-scheduled opening would hold it open)
      const open = Math.min(Math.max(ctx.currentTime + 0.01, t0 - e.delaySec), t0 - 0.01);
      send.gain.setValueAtTime(0, open - 0.005); send.gain.linearRampToValueAtTime(1, open);
      send.gain.setValueAtTime(1, t0 - 0.005); send.gain.linearRampToValueAtTime(0, t0);
      const D = e.beats * e.delaySec;
      wet.gain.setValueAtTime(1, t0 + D - 0.05); wet.gain.linearRampToValueAtTime(0, t0 + D);
      echo = { send, delay, fb, wet };
    }

    const me = {
      phase: 'asked', oldId: st.id, N, mix, src, srcGain, fade, bass, mid: midB, high, hp, lp, vol, base, muted: false, echo, sends,
      // the player's volume `base` was measured at, and the level since (the slider moved: k = volume / volRef)
      volRef: v.volume || 1, k: 1, deckBase: base, inBase: base,
      aPos: p.start + idxT / sr - st.off,   // old song's position (s) at T, for the lyrics
      T, askedAt: 0, playedAt: 0, newId: '', newAt: 0, mixEnd: 0,
      tailEnd: T + (p.buf.duration - idxT / sr),
    };
    // Automix: the blend starts on the audio clock where the old song reaches its mix-out point.
    if (mix) me.t0 = T + (mix.mixOutTrackTime - me.aPos);
    if (mix && mix.style !== 'loop' && (steady ? !steadyOutgoing(me, mix, p, st.off, sA)
      : mix.style === 'blend' && (mix.glide ? !glideOutgoing(me, mix, p, st.off) : mix.outRate > 1.0001 && !rampOutgoing(me, mix, p, st.off)))) {
      try { src.stop(); } catch { /* not started */ }
      vol.disconnect();
      // (the echo's feedback loop keeps itself alive: broken here)
      if (echo) { echo.fb.disconnect(); echo.wet.disconnect(); }
      hold(g.gate.gain, ctx.currentTime);
      g.gate.gain.setValueAtTime(1, ctx.currentTime);
      retryOrGiveUp('too late to bring the song up to tempo');
      return;
    }
    // the Looping lane (editor.md §13) on the copy itself: from the mix-out on, its first loopSec seconds
    // repeat (the copy still stops where it would have ended, A long faded by then)
    if (mix?.loopSec > 0 && !me.deckRamp && mix.style !== 'loop') {
      const a = mix.mixOutTrackTime + st.off - p.start;
      src.loopStart = a; src.loopEnd = a + mix.loopSec; src.loop = true;
      try { src.stop(me.tailEnd); } catch { /* not started */ }
      log(`automix: looping ${mix.loopSec.toFixed(2)} s of the playing song from ${mix.mixOutTrackTime.toFixed(2)} s`);
    } else if (mix?.loopSec > 0 && mix.glide) log('automix: no looping on a glide (its speed steps every beat)');
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
    if (mix?.nextId) cameFrom = { id: mix.nextId, from: me.oldId };
    // versions.md "The mix's ceiling": the limiter holds the sum under -1 dBFS while a mix runs (on the loop mix a clip guard only)
    if (g.limit) { g.limit.report ??= (db) => { if (db < -0.05) log(`limiter: the mix took up to ${(-db).toFixed(1)} dB off its peaks`); }; g.limit(true); if (!g.limit.ready) log(`limiter: not in the graph${g.limit.failed ? ' (' + g.limit.failed + ')' : ' yet'}, the mix plays without it`); }
    addonEvent('handover', { id: me.oldId, T, aPos: me.aPos, addonTail: !!p.addon, base, t0: me.t0 ?? null, style: mix?.style || null, outRate: mix?.outRate ?? null, glide: !!mix?.glide });
    log('handover done, tail gain', base.toFixed(2), mix ? `, blend in ${(me.t0 - ctx.currentTime).toFixed(2)} s, pressing next in ${(me.askAt - ctx.currentTime).toFixed(2)} s` : ', pressing next');
    // (a speed-up stops the copy at its start on purpose: the stretch deck plays on, so the mix goes on)
    if (!me.deckRamp) src.onended = () => { if (live === me) finishLive(); };
    // the loop mix: scheduled now, after the line above (it stops the copy at the loop start on purpose)
    if (mix?.style === 'loop') scheduleLoopMix(g);
    else if (me.inDeck) { kickLockFor(me, p, st.off); scheduleDeckBlend(g); }
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
    // (at rest exactly transparent: a high-pass at 0 Hz and a low-pass at Nyquist pass the samples through)
    const ins = fxBuses.get(g.ctx)?.inSend;
    for (const [param, v] of [[g.bassFilter?.gain, 0], [g.midFilter?.gain, 0], [g.highFilter?.gain, 0], [g.highpass?.frequency, 0], [g.lowpass?.frequency, g.ctx.sampleRate / 2],
      [ins?.echoSend.gain, 0], [ins?.reverbSend.gain, 0], [ins?.delaySend.gain, 0]]) {
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
    // (a mix's noise stops with it; the effect returns ring on by themselves)
    for (const n of L.noise || []) { try { n.stop(); } catch { /* not started */ } }
    // (the echo's feedback loop keeps itself alive: broken here, whichever deck plays on)
    if (L.echo) setTimeout(() => { try { L.echo.fb.disconnect(); L.echo.wet.disconnect(); } catch { /* gone */ } }, 300);
    if (sdeck?.audible) {
      // the stream deck plays the new song: YouTube's gate stays down (the deck brings it back if it fails)
      hold(L.vol.gain, now); L.vol.gain.setValueAtTime(L.vol.gain.value, now); L.vol.gain.linearRampToValueAtTime(0, now + 0.12);
      try { L.src.stop(now + 0.15); } catch { /* not started / already stopped */ }
      setTimeout(() => { try { L.vol.disconnect(); } catch { /* gone */ } }, 300);
      return;
    }
    hold(g.gate.gain, now);
    if (rampGate) {
      const at = now + (L.gateDelay || 0);
      g.gate.gain.setValueAtTime(g.gate.gain.value, now);
      g.gate.gain.setValueAtTime(g.gate.gain.value, at);
      g.gate.gain.linearRampToValueAtTime(1, at + 0.06);
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
    // the mix as heard, for "no effect three times in a row" (automix.js heard): counted at its real
    // end, not at the hand-over, so a mix called off before or during it (abortLive) doesn't count
    if (L?.mix && L.phase === 'mixing') window.__viviAutomix?.heard?.(L.mix);
    g?.limit?.(false);
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
    g?.limit?.(false);
    streamDeckBack('the mix was called off');   // (YouTube's own sound, before the gate is touched below)
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
            post({ type: 'seek', t: inTrackAt(L.mix, L.t0, now) });
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
    // A mix the listener called off (Previous, Next, going back to the song, a seek) never marks it
    // either: the song plays again and is planned again (playback.md "The queue during a mix" rule 2).
    failedId = st && st.id === L.oldId && !(L.mix && !L.askedAt) && !BY_LISTENER.has(why) ? st.id : '';
  }
  const BY_LISTENER = new Set(['previous pressed', 'skipped by you', 'paused by you', 'song changed', 'skipped again', 'seeked',
    'skipped before the mix', 'seeked before the mix', 'repeat one turned on', 'the queue changed before the mix',
    'the audio clock stopped']);   // (not the listener's either, but not the song's fault: it isn't marked)

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
  // the take-over by ear (alignByEar): within EAR_OK_SEC of the player is in step; the deck catches
  // up at most NUDGE_MAX faster or slower, over up to NUDGE_SEC
  const EAR_SEC = 0.3, EAR_RANGE_SEC = 0.1, EAR_OK_SEC = 0.0015, NUDGE_SEC = 2, NUDGE_MAX = 0.04, NUDGE_MIN_SEC = 0.3;
  // a reading (scoring EAR_MIN or more) is acted on once the next one agrees within EAR_AGREE_SEC, with no
  // catch-up between: single readings scoring up to 0.87 were off by 40 ms or flipped sign on some songs,
  // their neighbouring beats; two in a row at the same wrong place didn't happen
  const EAR_MIN = 0.6, EAR_AGREE_SEC = 0.003;
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
        // (a plan still before the song's opening starts it where the plan reaches 0: started at
        // ctxTime, it ran ahead of the plan and was sought again and again until then)
        this.startAt = trackTime < 0 ? ctxTime - trackTime / rate : ctxTime;
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
    // Step the rate back to 1.0 (or the song's speed, `to`) in inaudible ~0.8% increments (AutoMix glideRateToUnity).
    glideToUnity(fromRate, start, to = 1) {
      this.restRate = to;
      if (Math.abs(fromRate - to) < 0.002) { this.setRate(to, start + 0.5); return; }
      for (let i = 1; i <= 8; i++) this.setRate(fromRate + (to - fromRate) * (i / 8), start + i * 3);
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
    // The element runs free again at rate 1 (or the song's speed: restRate, spotify-mixes.md rule 10).
    release() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.v.removeEventListener('seeking', this.onSeeking);
      this.v.removeEventListener('playing', this.onPlaying);
      const rest = this.restRate || 1;
      if (this.v.playbackRate !== rest) this.v.playbackRate = rest;
      if (off1(rest)) speedSet = rest;
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

  // ───────── the take-over by ear ─────────
  // The player is held to the mix by its currentTime, but its sound runs a little off that: 30 ms
  // ahead of the incoming deck in the test Firefox, under QUIET_ERROR_SEC, so nothing moved it.
  // The take-over then skipped that much of the song, heard as a short dropout at a mix's end.
  // Before the gate opens, the player's sound (behind the gate) is found in the incoming deck's on
  // exact audio frames, and the deck catches up with it: a few % faster or slower for up to 2 s,
  // the pitch kept. (The player can't be moved that finely: a seek lands within tens of ms, and in
  // Firefox 0.4 s at x0.9255 moved its sound 1 ms, not 30.)
  const ears = new WeakMap();   // audio node -> Promise of a tap (buffer-deck.js) on it
  function earOn(ctx, node) {
    if (!ears.has(node)) ears.set(node, window.__viviBufferDeck.tap(ctx, node, { frames: 65536 }).catch((e) => { ears.delete(node); throw e; }));
    return ears.get(node);
  }
  // a deck rebuilt with a new graph: its tap goes too (it would keep the old deck processing)
  function earOff(node) {
    const t = node && ears.get(node);
    if (t) { ears.delete(node); t.then((x) => x.close(), () => {}); }
  }
  const monoOfChans = (c) => { const m = new Float32Array(c[0].length); for (let i = 0; i < m.length; i++) m[i] = (c[0][i] + (c[1] || c[0])[i]) / 2; return m; };
  // `tmpl` in `file` near index i0 (±R): every 2nd place on every 4th sample, then each place near the best
  // on every sample. (buffer-deck.js locate's 8x averaged first pass, a low-pass, picked neighbouring beats
  // of a busy opening and its places scored under 0.85; this search found the same spots at 0.90-0.97)
  function earLocate(file, tmpl, i0, R) {
    const L = tmpl.length;
    const ncc = (from, step) => {
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < L; i += step) { const x = tmpl[i], y = file[from + i]; ab += x * y; aa += x * x; bb += y * y; }
      return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    };
    const lo = Math.max(0, i0 - R), hi = Math.min(file.length - L, i0 + R);
    let best = -2, at = i0;
    for (let k = lo; k <= hi; k += 2) { const v = ncc(k, 4); if (v > best) { best = v; at = k; } }
    let fine = -2, fAt = at;
    for (let k = Math.max(lo, at - 3); k <= Math.min(hi, at + 3); k++) { const v = ncc(k, 1); if (v > fine) { fine = v; fAt = k; } }
    return { index: fAt, score: fine };
  }
  // How far the player's sound runs ahead of the deck's (seconds; negative: behind), or null
  async function earError(g, node) {
    const BD = window.__viviBufferDeck;
    if (!BD) return null;
    const [yt, dk] = await Promise.all([earOn(g.ctx, g.source), earOn(g.ctx, node)]);
    const sr = g.ctx.sampleRate, L = Math.round(EAR_SEC * sr), R = Math.round(EAR_RANGE_SEC * sr);
    const a = await yt.grab(L);
    // the deck's audio is read once it has played past the player's by the search range
    await new Promise((r) => setTimeout(r, EAR_RANGE_SEC * 1000 + 60));
    const n = L + 2 * R + Math.round(0.15 * sr), b = await dk.grab(n);
    if (a.closed || b.closed || a.chans[0].length < L || b.chans[0].length < n) return null;
    const tmpl = monoOfChans(a.chans), file = monoOfChans(b.chans);
    const i0 = (a.end - L) - (b.end - n);   // the template's first frame, in the deck's grab
    if (i0 - R < 0 || i0 + R + L > n || rms(tmpl) < 1e-4 || rms(file) < 1e-4) return null;
    const hit = earLocate(file, tmpl, i0, R);
    // (the deck's stretcher reshapes the waveform a little: the right place scored 0.7-0.97, by the song)
    if (!hit || hit.score < EAR_MIN) return null;
    return { err: (hit.index - i0) / sr, score: hit.score };
  }
  // Brings the incoming deck `d` (the blend's, or the loop mix's once its loop is over) in step with the player `pd`'s sound, by ear,
  // from audio time `start`; its catch-ups end by `last` (a little before the gate opens).
  // `trackAt(t)`: where the deck's schedule has the song at audio time t, at the rate `rate`.
  async function alignByEar(L, pd, d, trackAt, rate, start, last) {
    const g = pd.g, ms = (s) => (s * 1000).toFixed(1);
    const until = (t) => new Promise((r) => setTimeout(r, Math.max(0, (t - g.ctx.currentTime) * 1000)));
    const on = () => live === L && deck === pd && !pd.done;
    await until(start);
    let first = null, final = null, nudges = 0, checks = 0, unchecked = false, moved = 0, prev = null;
    const seen = [];   // each reading: [audio time, ms ahead, score, the player's seeks so far]
    try {
      while (on() && checks < 20) {
        // an addon deck takes over from the incoming deck on the mix's own schedule: the player isn't heard
        // (not one that failed or handed back: the player is heard then)
        if (sdeck?.addon && sdeck.addonId === pd.id) return;
        const now = g.ctx.currentTime;
        if (now > last - 0.6) break;   // no time left to measure and catch up
        if (pd.v.seeking || pd.v.paused || now < pd.seekingUntil || pd.errors.length < 3) { await until(now + 0.1); continue; }
        let m = await earError(g, d.lp);
        checks++;
        if (!on()) return;
        if (!m) { await until(g.ctx.currentTime + 0.15); continue; }
        seen.push([+g.ctx.currentTime.toFixed(2), +(m.err * 1000).toFixed(1), +m.score.toFixed(2), pd.seeks]);
        // from the first reading on, the deck follows the player's sound: the player's own quiet seeks
        // (by its currentTime, landing tens of ms anywhere) would move it from under the deck again, and
        // a reading from before a seek isn't compared with one after it (44.2 then 26.2 ms: nothing done)
        pd.quietUntil = Math.min(pd.quietUntil, g.ctx.currentTime);
        const agrees = prev && prev.nudges === nudges && prev.seeks === pd.seeks && Math.abs(m.err - prev.err) <= EAR_AGREE_SEC;
        if (!agrees) { prev = { err: m.err, nudges, seeks: pd.seeks }; await until(g.ctx.currentTime + 0.1); continue; }
        m = { err: (m.err + prev.err) / 2, score: m.score };
        prev = null;
        first ??= m.err; final = m.err; unchecked = false;
        if (Math.abs(m.err) > 0.25) break;   // far off: the servo's to seek
        // in step: checked again until the take-over is near (one reading 4 s ahead said 0 ms, the take-over then skipped 19)
        if (Math.abs(m.err) <= EAR_OK_SEC) { await until(g.ctx.currentTime + 0.3); continue; }
        // the player's sound runs m.err ahead: the deck plays that much more of the song over S
        // (as short as NUDGE_MAX allows: time is left to check it and catch up again). m.err is heard
        // time: at the mix rate that is m.err * rate of the song. S is at least NUDGE_MIN_SEC: the
        // worklet keeps one pending change, so a shorter S would post the end before the start is
        // due, and the start would be dropped (the deck would jump at t1 + S instead of gliding)
        const t1 = g.ctx.currentTime + 0.3, S = Math.min(clamp(Math.abs(m.err) / NUDGE_MAX, NUDGE_MIN_SEC, NUDGE_SEC), last - t1 - 0.12);
        if (S < NUDGE_MIN_SEC || d.pending.some((c) => c.active && c.output > t1 - 0.01)) break;   // (nothing heard may be queued on the deck by then: a stop is)
        const k = clamp(m.err / S, -NUDGE_MAX, NUDGE_MAX), at = trackAt(t1) + moved;
        d.schedule([
          { output: t1, input: at, rate: rate * (1 + k), active: true, loop: null },
          { output: t1 + S, input: at + rate * (1 + k) * S, rate, active: true, loop: null },
        ]);
        moved += rate * k * S;
        nudges++; unchecked = true;
        await until(t1 + S + 0.12);
      }
    } catch (e) { log('automix: the take-over by ear failed:', e?.message || e); return; }
    if (!on()) return;
    log(`automix: the take-over by ear (${seen.map((x) => x[1] + ' ms').join(', ') || 'no reading'}): ${first === null ? 'not measured' : `the player ${ms(first)} ms ahead of the incoming deck${nudges ? `, the deck caught up ${ms(moved)} ms, ${unchecked ? 'not checked again' : `then ${ms(final)} ms`}` : ''}`}`);
    addonEvent('ear', { first, final: unchecked ? null : final, nudges, moved, checks, seen });
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
      loopDecks?.forEach((d) => { d.stop(); earOff(d.lp); });
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

  let loopChoiceLogged = '';
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
      const lyrics = Promise.all([A.loopSungSpans(curId), A.loopSungSpans(nextId)]);
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
      // an addon's copy (ready, at this rate): the decks and the tail play its sound in YouTube's
      // copy's place (the plan stays YouTube's); the playing song's only while its addon deck plays
      // (the tail and the outgoing deck are then the same samples). A copy that comes after the
      // load (the next song's file, the playing song's addon deck) is loaded then (me.reload).
      const AP = window.__viviAddonsPage;
      const outPlayOf = () => { const r = AP?.isOn() ? readyRec(curId) : null; return r && sdeck?.addon && sdeck.addonId === curId && r.buf.sampleRate === outBuffer.sampleRate ? addonView(r, outBuffer) : null; };
      const inPlayOf = () => { const r = AP?.isOn() ? readyRec(nextId) : null; return r && r.buf.sampleRate === inBuffer.sampleRate ? addonView(r, inBuffer) : null; };
      const outAddon = outPlayOf(), inAddon = inPlayOf();
      const outRegion = [Math.max(0, cur.durationSec - A.LOOP.OUT_REGION_SEC), cur.durationSec];
      const inRegion = [0, Math.min(nxt.durationSec, A.LOOP.IN_REGION_SEC)];
      const load = deckLoads.then(async () => {
        if (!still()) return false;
        await loopDecks[0].load(curId, outAddon || outBuffer, ...outRegion);
        await loopDecks[1].load(nextId, inAddon || inBuffer, ...inRegion);
        return true;
      });
      deckLoads = load.catch(() => false);
      if (!(await load)) return;
      const from = Math.max(0, plan.out.loop[0] - HAND_LEAD - 4);
      const a = Math.floor(from * outBuffer.sampleRate);
      const cut = (src) => { const ch = []; for (let c = 0; c < Math.min(2, outBuffer.numberOfChannels); c++) ch.push(src.getChannelData(c).slice(a)); return ch; };
      if (!still()) return;
      Object.assign(me, { state: 'ready', plan, tail: { channels: cut(outAddon || outBuffer), sampleRate: outBuffer.sampleRate, start: a / outBuffer.sampleRate }, outAddon: !!outAddon, inAddon: !!inAddon });
      // a copy ready after the load: its deck is loaded again, before the mix only; the playing
      // song's only while its tail isn't cut yet (the tail and the outgoing deck stay the same samples)
      me.reload = () => {
        if (loopPrep !== me || live?.mix?.style === 'loop' || !st || st.id !== curId) return;
        const vin = me.inAddon ? null : inPlayOf();
        const vout = me.outAddon || me.tailCut ? null : outPlayOf();   // (once the tail is cut, the deck stays its copy)
        if (!vin && !vout) return;
        if (vin) me.inAddon = true;
        if (vout) { me.outAddon = true; me.tail = { ...me.tail, channels: cut(vout) }; }
        const ok = () => loopPrep === me && live?.mix?.style !== 'loop';
        deckLoads = deckLoads.then(async () => {
          if (vout && ok()) await loopDecks[0].load(curId, vout, ...outRegion);
          if (vin && ok()) await loopDecks[1].load(nextId, vin, ...inRegion);
        }).catch(() => false);
        addonEvent('loopdecks', { id: nextId, out: me.outAddon, in: me.inAddon, late: true });
        log(`addons: the loop mix now plays ${[vout && 'the playing song', vin && 'the next song'].filter(Boolean).join(' and ')} from the addon's copy`);
      };
      addonEvent('loopdecks', { id: nextId, out: me.outAddon, in: me.inAddon });
      if (me.outAddon || me.inAddon) log(`addons: the loop mix plays ${[me.outAddon && 'the playing song', me.inAddon && 'the next song'].filter(Boolean).join(' and ')} from the addon's copy`);
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
    // in step by ear once the loop is over: the deck then plays the song straight on, as the player does
    alignByEar(L, deck, idk, trackAt, 1, Math.max(now + 0.6, x.releaseAt + 0.3), tk - 0.1);
    setTimeout(() => matchInLevel(L, tk - 0.05, 'loop'), Math.max(0, (tk - 0.45 - now) * 1000));
    log(`automix: the new song waits on the player, taking over in ${(tk - now).toFixed(2)} s`);
    addonEvent('takeover', { id: st.id, tk, H, startPos: trackAt(tk), inAddon: !!loopPrep.inAddon, style: 'loop' });
    // (an addon deck takes over from the incoming deck where the schedule puts the song)
    startStreamDeck(g, v, st.id, tk, H, L, trackAt(tk));
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
  // The shapes themselves are the planner's (automix.js djShape), so the
  // overview and the spec's curves are what plays.
  const djShapes = new WeakMap();   // plan -> its shapes, made once per blend length
  function djShape(m, style, D) {
    const hit = djShapes.get(m);
    if (hit && hit.D === D && hit.style === style) return hit;
    // ~25 ms steps, so half a beat of bass swap is drawn. Firefox draws a
    // curve as one ramp per step (fadeCurve), five params at once: fewer there.
    const most = typeof AudioParam !== 'undefined' && AudioParam.prototype.cancelAndHoldAtTime ? 4000 : 1200;
    const n = Math.max(EP, Math.min(most, Math.ceil(D * 40)));
    const shape = window.__viviAutomix.djShape(m, style, D, n);
    djShapes.set(m, shape);
    return shape;
  }
  const djNote = (m, style) => (presetOn(m, style) ? ` [editor: ${m.preset}${m.warnings?.length ? "; " + m.warnings.join("; ") : ""}]` : "") + (m.v2 && style !== 'crossfade'
    ? ` [AutoDJ: both sing ${Math.round((m.clash || 0) * 100)}%${m.vocalsBy ? ' (' + m.vocalsBy + ')' : ''}${m.rerouted ? '; ' + m.rerouted : ''}${m.keyClash ? '; keys clash (' + m.keyClash + '), short blend' : ''}]`
    : '');
  // The fader for this mix: AutoDJ's for a version 2 blend or filter mix, else equal power.
  // Automix v2: with the plan's loudness trim (automix.js trimmed).
  // A transition editor preset (automix.js plan → presetCurves): the plan's own curves play, as
  // points (linear; Hz exponential; two points at one t a step), the loudness trim on the faders.
  const presetOn = (m, style) => !!m?.preset && !!m.curves && style === m.style;
  function curveAt(pts, t, geo) {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [a, va] = pts[i - 1], [b, vb] = pts[i];
      if (t > b) continue;
      if (b - a < 1e-9) return vb;
      const x = (t - a) / (b - a);
      return geo ? va * Math.pow(vb / va, x) : va + (vb - va) * x;
    }
    return pts[pts.length - 1][1];
  }
  // events [t, v, step] over the curves' 0..D; mul(t / D) scales them (the trim, sampled in 32 steps
  // too). skip: the seconds a late start missed: the curves go on from there, on the planned beats.
  // Dplay: the seconds the mix really has from then on (the song's tail): the rest fits to it.
  function curveEvents(pts, D, geo, mul, Dplay = D, skip = 0) {
    if (!pts?.length) return null;
    const ev = [];
    const ts = pts.map((p) => p[0]);
    if (mul) for (let k = 0; k <= 32; k++) ts.push((D * k) / 32);
    const uniq = [...new Set(ts.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    for (const t of uniq) {
      const k = mul ? mul(clamp(t / D, 0, 1)) : 1;
      const at = pts.filter((p) => Math.abs(p[0] - t) < 1e-6);
      if (at.length > 1) { ev.push([t, at[0][1] * k, false], [t, at[at.length - 1][1] * k, true]); continue; }
      ev.push([t, curveAt(pts, t, geo) * k, false]);
    }
    let out = ev;
    if (skip > 1e-6 && skip < D) {
      const k0 = mul ? mul(clamp(skip / D, 0, 1)) : 1;
      out = [[0, curveAt(pts, skip, geo) * k0, false], ...ev.filter((e) => e[0] > skip + 1e-6).map((e) => [e[0] - skip, e[1], e[2]])];
    }
    const left = D - (skip > 1e-6 && skip < D ? skip : 0);
    const fit = Dplay > 0 && left > 0 ? Dplay / left : 1;
    if (Math.abs(fit - 1) > 1e-9) for (const e of out) e[0] *= fit;
    return out;
  }
  const curvesSec = (m, D) => (m.curves.durationSec > 0 ? m.curves.durationSec : D);
  function playEvents(param, ev, t0, from, geo) {
    if (!param || !ev?.length) return;
    param.setValueAtTime(ev[0][1], Math.max(0, Math.min(from, t0 + ev[0][0])));
    if (t0 + ev[0][0] > from) param.setValueAtTime(ev[0][1], t0 + ev[0][0]);
    for (let i = 1; i < ev.length; i++) {
      const [t, v, step] = ev[i];
      if (step) param.setValueAtTime(v, t0 + t);
      else if (geo && v > 0 && ev[i - 1][1] > 0) param.exponentialRampToValueAtTime(v, t0 + t);
      else param.linearRampToValueAtTime(v, t0 + t);
    }
  }
  // the faders of a preset (the plan's loudness trim on top, as automix.js trimmed)
  function presetGains(m, D, skip = 0) {
    const t = m.trim, ss = (x) => x * x * (3 - 2 * x);
    const gi = 10 ** ((t?.inDb || 0) / 20), go = 10 ** ((t?.outDb || 0) / 20);
    const trim = !!(t && (t.inDb || t.outDb));
    const P = curvesSec(m, D);
    return [curveEvents(m.curves.in.gain, P, false, trim ? (x) => gi + (1 - gi) * ss(x) : null, D, skip),
      curveEvents(m.curves.out.gain, P, false, trim ? (x) => 1 + (go - 1) * ss(x) : null, D, skip)];
  }
  // A preset's shelves and filters on both songs: the old song's own nodes from t0, the next song's
  // (the player's filters, which the incoming deck feeds too) from `pre`; open again after the mix.
  function presetShape(g, m, t0, D, pre, skip = 0) {
    const c = m.curves, nyq = g.ctx.sampleRate / 2, end = t0 + D + 0.002;
    // the Effects returns (editor.md §12), when the plan sends anything to them
    const sendKeys = ['echoSend', 'reverbSend', 'delaySend'];
    const bus = sendKeys.some((k) => c.in[k]?.length || c.out[k]?.length) ? fxBus(g) : null;
    if (bus && c.fxTime) {
      // (set at the window's start; an earlier tail repeats at the new time from there)
      const at = Math.max(g.ctx.currentTime, t0);
      if (c.fxTime.echoSec > 0) bus.echoDelay.delayTime.setValueAtTime(Math.min(3, c.fxTime.echoSec), at);
      if (c.fxTime.delaySec > 0) bus.delayDelay.delayTime.setValueAtTime(Math.min(3, c.fxTime.delaySec), at);
    }
    // [param, curve, Hz?, value after the mix (null: left), from] (the outgoing deck's from t0, the player's from `pre`)
    const lanes = [
      [live.bass?.gain, c.out.bassDb, false, null, t0], [live.mid?.gain, c.out.midDb, false, null, t0], [live.high?.gain, c.out.highDb, false, null, t0],
      [live.lp?.frequency, c.out.lowpassHz, true, null, t0], [live.hp?.frequency, c.out.highpassHz, true, null, t0],
      ...sendKeys.map((k) => [live.sends?.[k]?.gain, c.out[k], false, 0, t0]),
      [g.bassFilter?.gain, c.in.bassDb, false, 0, pre], [g.midFilter?.gain, c.in.midDb, false, 0, pre], [g.highFilter?.gain, c.in.highDb, false, 0, pre],
      [g.lowpass?.frequency, c.in.lowpassHz, true, nyq, pre], [g.highpass?.frequency, c.in.highpassHz, true, 0, pre],
      ...sendKeys.map((k) => [bus?.inSend[k].gain, c.in[k], false, 0, pre]),
    ];
    for (const [param, pts, geo, rest, from] of lanes) {
      if (!param || !pts?.length) continue;
      playEvents(param, curveEvents(pts, curvesSec(m, D), geo, null, D, skip), t0, from, geo);
      if (rest != null) param.setValueAtTime(rest, end);   // (Hz curves end open: then exactly transparent)
    }
    // the noise (§12 rule 3): from the window's start to its end, not under the deck's fader
    live.noise = [];
    for (const side of ['out', 'in']) {
      const pts = c[side].noise;
      if (!pts?.some(([, v]) => v > 0)) continue;
      const ctx = g.ctx, src = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
      const hpN = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 1500, Q: 0.7 }), lvl = new GainNode(ctx, { gain: 0 });
      src.connect(hpN); hpN.connect(lvl); lvl.connect(g.entry);
      const ev = curveEvents(pts, curvesSec(m, D), false, null, D, skip).map(([t, v, step]) => [t, v * NOISE_LEVEL, step]);
      playEvents(lvl.gain, ev, t0, t0, false);
      lvl.gain.setValueAtTime(0, end);
      src.start(Math.max(ctx.currentTime, t0)); src.stop(end + 0.05);
      src.onended = () => { try { lvl.disconnect(); } catch { /* gone */ } };
      live.noise.push(src);
    }
  }
  // editor.md §12 rule 3: the Effects returns, one set per audio context, fed by both decks' sends and
  // played into the EQ's entry, so a tail rings on after the mix
  const fxBuses = new WeakMap();
  const NOISE_LEVEL = 0.25;
  function fxBus(g) {
    let b = fxBuses.get(g.ctx);
    if (b) return b;
    const ctx = g.ctx, gain = (v) => new GainNode(ctx, { gain: v });
    // echo: feedback 0.45 through a 3 kHz low-pass (each repeat darker)
    const echoIn = gain(1), echoDelay = new DelayNode(ctx, { maxDelayTime: 3, delayTime: 0.375 });
    const echoTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: 0.5 }), echoFb = gain(0.45);
    echoIn.connect(echoDelay); echoDelay.connect(echoTone); echoTone.connect(echoFb); echoFb.connect(echoDelay); echoTone.connect(g.entry);
    // delay: a clean repeat, feedback 0.3
    const delayIn = gain(1), delayDelay = new DelayNode(ctx, { maxDelayTime: 3, delayTime: 0.25 }), delayFb = gain(0.3);
    delayIn.connect(delayDelay); delayDelay.connect(delayFb); delayFb.connect(delayDelay); delayDelay.connect(g.entry);
    // reverb: a generated 2.4 s hall, level 0.7
    const reverbIn = gain(1), conv = new ConvolverNode(ctx, { buffer: hallImpulse(ctx, 2.4) }), reverbOut = gain(0.7);
    reverbIn.connect(conv); conv.connect(reverbOut); reverbOut.connect(g.entry);
    // the next song's sends: from the end of the player's Automix chain (which the incoming deck feeds too)
    const tap = g.lowpass || g.highpass;
    const inSend = { echoSend: gain(0), reverbSend: gain(0), delaySend: gain(0) };
    if (tap) { tap.connect(inSend.echoSend); tap.connect(inSend.reverbSend); tap.connect(inSend.delaySend); }
    inSend.echoSend.connect(echoIn); inSend.reverbSend.connect(reverbIn); inSend.delaySend.connect(delayIn);
    b = { echoIn, echoDelay, delayIn, delayDelay, reverbIn, inSend };
    fxBuses.set(ctx, b);
    return b;
  }
  // the outgoing deck's sends (null when its curves send nothing)
  function fxSends(g, from, out) {
    if (!out || !['echoSend', 'reverbSend', 'delaySend'].some((k) => out[k]?.length)) return null;
    const b = fxBus(g), s = {};
    for (const [k, to] of [['echoSend', b.echoIn], ['reverbSend', b.reverbIn], ['delaySend', b.delayIn]]) {
      s[k] = new GainNode(g.ctx, { gain: 0 });
      from.connect(s[k]); s[k].connect(to);
    }
    return s;
  }
  // stereo white noise decaying by 60 dB over `sec`
  function hallImpulse(ctx, sec) {
    const n = Math.round(ctx.sampleRate * sec), buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * i) / n);
    }
    return buf;
  }
  const noiseBufs = new WeakMap();
  function noiseBuffer(ctx) {
    let buf = noiseBufs.get(ctx);
    if (buf) return buf;
    buf = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    noiseBufs.set(ctx, buf);
    return buf;
  }
  const gainCurves = (m, style, D) => window.__viviAutomix.trimmed(m, ...(m.v2 && style !== 'crossfade' ? (({ gIn, gOut }) => [gIn, gOut])(djShape(m, style, D)) : [EP_IN, EP_OUT]));
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
      f.setValueAtTime(0, t0 + D + 0.002);   // the curve ends open (20 Hz): then exactly transparent
    }
    for (const [node, curve, open] of [[live.lp, s.outLp, g.ctx.sampleRate / 2], [live.hp, s.outHp, 0]]) {
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
    // (a glide needs the incoming deck: on YouTube's player it is a plain crossfade at x1.0)
    const plain = !!m.glide;
    const rate = matched && !plain ? m.rate : 1;
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    if (matched) {
      // (a late entry: B's gain stays 0 until B's start comes, below; the player is there by then,
      // held when that is before the song's 0:00)
      deck.playAt(t0, m.mixInTrackTime - (m.inDelaySec || 0) * rate + (t0 - live.t0) * rate, rate);
      deck.glideToUnity(rate, t0 + D, m.speedIn || 1);
    } else {
      log('automix: the queue played', st.id, 'instead of', m.nextId || '(nothing)', '- crossfading into it as it is');
      deck.follow();
    }

    // gains: equal-power cross (AutoDJ: its own fader)
    const style = matched && !plain ? m.style : 'crossfade';
    // an editor preset plays its own curves either way (a glide's at x1.0); a late start skips their first seconds
    const preset = matched && presetOn(m, m.style), skip = Math.max(0, t0 - live.t0);
    if (matched && plain) log(`automix: the glide had no incoming deck: ${preset ? 'the preset at x1.0' : 'a plain crossfade'} instead`);
    const inn = g.gate.gain, out = live.fade.gain;
    inn.cancelScheduledValues(now); inn.setValueAtTime(0, now);
    out.cancelScheduledValues(now); out.setValueAtTime(1, now);
    const late = matched ? (m.inDelaySec || 0) - skip : 0;   // (its seconds still to come)
    if (preset) { const [eIn, eOut] = presetGains(m, D, skip); playEvents(inn, lateEvents(eIn, late), t0, t0, false); playEvents(out, eOut, t0, t0, false); }
    else { const [cIn, cOut] = gainCurves(m, style, D); fadeCurve(inn, lateShape(cIn, D, late), t0, D); fadeCurve(out, cOut, t0, D); }

    blendShape(g, style, t0, D, rate, preset, skip);
    log(`automix: ${style}${style !== 'crossfade' ? ' of ' + m.bars + ' bars' : ''}, ${D.toFixed(1)} s, starting in ${(t0 - now).toFixed(2)} s; next song from ${m.mixInTrackTime.toFixed(2)} s at x${rate.toFixed(3)}${m.reason ? ' (' + m.reason + ')' : ''}${djNote(m, preset ? m.style : style)}`);
    live.phase = 'mixing';
    live.mixId = st.id;
  }

  // The blend's EQ and filters on both songs, its toasts and its stretch of the
  // bar (mixStart..mixEnd). The incoming song's are the player's own filters,
  // which the incoming deck feeds too.
  function blendShape(g, style, t0, D, rate, preset = presetOn(live.mix, style), skip = 0) {
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
    if (preset) {
      presetShape(g, m, t0, D, pre, skip);
    } else if (m.v2 && style !== 'crossfade') {
      djFilters(g, style, t0, D, pre);
    } else if (style === 'blend') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.high.gain.setValueAtTime(0, t0); live.high.gain.linearRampToValueAtTime(-8, t0 + D);
      if (g.highFilter) { const h = g.highFilter.gain; h.setValueAtTime(-8, pre); h.setValueAtTime(-8, t0); h.linearRampToValueAtTime(0, t0 + D); }
    } else if (style === 'filter') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.hp.frequency.setValueAtTime(20, t0); live.hp.frequency.exponentialRampToValueAtTime(1800, t0 + D);
      if (g.lowpass) { const lp = g.lowpass.frequency; lp.setValueAtTime(350, pre); lp.setValueAtTime(350, t0); lp.exponentialRampToValueAtTime(20000, t0 + D); lp.setValueAtTime(g.ctx.sampleRate / 2, t0 + D + 0.002); }
    }

    const name = m.v2 && style !== 'crossfade' ? (window.__viviAutomix?.getVersion?.() === 3 ? 'Automix v2' : 'Automix Classic') : 'Automix';
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
      if (inDeck) { inDeck.stop(); earOff(inDeck.lp); try { inBus.disconnect(); inDeck.gain.disconnect(); } catch { /* gone */ } }
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
    Promise.all([ensureLoopDecks(g), ensureInDeck(g)])
      // (and the take-over's ears on them and on the player: a worklet started mid-mix could be heard)
      .then(() => window.__viviBufferDeck && Promise.all([g.source, inDeck?.lp, loopDecks?.[1]?.lp].filter(Boolean).map((n) => earOn(g.ctx, n))))
      .catch((e) => log('automix: decks not made ahead:', e?.message || e));
  }

  async function prepareInDeck(g, p, pos = 0) {
    const A = window.__viviAutomix, id = p.nextId;
    if (!id || !g.bassFilter || typeof SignalsmithStretch !== 'function') return;
    // the start of the song, past where a late take-over could still need it
    const want = Math.min(A.get(id)?.durationSec || Infinity, Math.max(120, p.mixInTrackTime + (p.durationSec + 45) * (p.rate || 1)));
    if (inPrep.key === id) {
      // (YouTube's copy is on it and the addon's is ready now: loaded again with the addon's)
      // (not when the mix is under 12 s away: the load takes some seconds and the blend would go without the deck)
      const late = p.mixOutTrackTime - pos < 12;
      if (inPrep.state === 'loading' || (inPrep.state === 'ready' && inPrep.want >= want - 1 && (inPrep.addon || !readyRec(id) || late))) return;
      if (inPrep.state === 'none' && performance.now() < inPrep.retryAt) return;   // failed: tried again later
    }
    if (live?.inDeck) return;   // the deck still plays the last blend
    const me = { key: id, state: 'loading', end: 0, want, why: '', retryAt: 0 };
    inPrep = me;
    try {
      await ensureInDeck(g);
      // an addon's copy of the next song when it is ready (on the song's timeline), else YouTube's
      const rec = window.__viviAddonsPage?.isOn() ? readyRec(id) : null;
      const buf = rec && rec.buf.sampleRate === g.ctx.sampleRate
        ? addonSpan(g.ctx, rec, 0, Math.ceil(Math.max(1, Math.min(want, rec.buf.duration - rec.off)) * g.ctx.sampleRate))
        : await decodeAside(g, await A.audioBytes(id));
      me.addon = buf !== null && !!rec && rec.buf.sampleRate === g.ctx.sampleRate;
      if (inPrep !== me) return;
      if (live?.inDeck) { inPrep = { key: '', state: 'idle', end: 0, want: 0, why: '', retryAt: 0 }; return; }
      const end = Math.min(buf.duration, want);
      await inDeck.load(id, buf, 0, end);
      if (inPrep !== me) return;
      me.end = end;
      // Automix v2's kick lock reads the opening's low end (automix.js kickSource)
      if (A.getVersion() === 3) {
        const ch = [];
        // copied into arrays of our own first: reads through the page's array wrapper are very slow (ownChannel)
        const n = Math.min(buf.length, Math.ceil(end * buf.sampleRate) + 1);
        for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) { const x = new Float32Array(n); buf.copyFromChannel(x, c); ch.push(x); }
        me.kick = A.kickSource(ch, buf.sampleRate, 0, 0, end);
      }
      me.state = 'ready';
      log(`automix: the next song's first ${end.toFixed(0)} s are on the incoming deck${me.addon ? ` (${rec.name}'s copy)` : ''}`);
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
      && inStartOf(m) + (D + 8) * (m.rate || 1) <= inPrep.end;
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
    const pre = Math.min(PREROLL_SEC, m.mixInTrackTime / rate), late = m.inDelaySec || 0;
    // A stretched next song glides back to its own speed here, on the deck,
    // after the blend; the player takes over only once it is at x1.0. (Stepping
    // the <video>'s playbackRate instead restarts the browser's stretcher at
    // every step, heard as a glitch after the mix.)
    const G = glideOf(m);
    live.deckGlide = G ? deckGlideIn(m, t0, G) : deckGlideBack(m, t0, D, rate);
    // (a late entry, mix-file.md rule 2: the deck starts that long into the mix, silent and unstarted
    // until then; the curves below still run from t0)
    inDeck.schedule([{ output: t0 + late - pre, input: m.mixInTrackTime - pre * rate, rate, active: true, loop: null }, ...(live.deckGlide?.points || [])]);
    const ig = inDeck.gain.gain, out = live.fade.gain;
    ig.cancelScheduledValues(0); ig.setValueAtTime(0, now);
    out.cancelScheduledValues(now); out.setValueAtTime(1, now);
    // (a late entry: the deck's gain 0 until B's start, so its warm-up pre-roll isn't heard)
    if (presetOn(m, m.style)) { const [eIn, eOut] = presetGains(m, D); playEvents(ig, lateEvents(eIn, late), t0, t0, false); playEvents(out, eOut, t0, t0, false); }
    else { const [cIn, cOut] = gainCurves(m, m.style, D); fadeCurve(ig, lateShape(cIn, D, late), t0, D); fadeCurve(out, cOut, t0, D); }
    blendShape(g, m.style, t0, D, rate);
    live.handoffAt = t0 + D / 2;
    addonEvent('blend', { id: m.nextId, t0, D, rate, mixIn: m.mixInTrackTime, mixOut: m.mixOutTrackTime, glide: !!G, inAddon: !!inPrep.addon, ...(late ? { inDelay: late } : {}) });
    live.src.onended = null;   // the mix may run on the deck past the old song's end (a late take-over)
    log(`automix: ${m.style}, ${D.toFixed(1)} s, starting in ${(t0 - now).toFixed(2)} s on the incoming deck (next song from ${m.mixInTrackTime.toFixed(2)} s at x${rate.toFixed(3)}${late ? `, ${late.toFixed(2)} s into the mix` : ''}); the player moves on in ${(live.askAt - now).toFixed(2)} s${djNote(m, m.style)}`);
  }
  // Automix v2's kick lock (automix.js kickLock): the next song's cue moves a
  // few ms so both songs' kicks land together. The playing song's side is its
  // decoded copy (song second = copy second - off + its start), the next's
  // the deck's opening.
  function kickLockFor(L, p, off) {
    const A = window.__viviAutomix, m = L.mix;
    if (A.getVersion() !== 3 || m?.style !== 'blend' || m.shape === 'echo' || m.inDelaySec || !inPrep.kick || inPrep.key !== m.nextId || !p?.mono) return;
    try {
      const t = performance.now();
      const k = A.kickLock(m, { data: p.mono, rate: p.rate, origin: p.start - off }, inPrep.kick);
      const took = Math.round(performance.now() - t);
      if (k?.shift) {
        L.mix = { ...m, mixInTrackTime: m.mixInTrackTime + k.shift, kickLock: k };
        log(`automix: kick lock moves the next song ${Math.round(k.shift * 1000)} ms (match ${k.score}, ${k.gain} better; ${took} ms)`);
      } else log(`automix: kick lock: no move (${k?.none || 'no beat'}${k?.score != null ? `, match ${k.score}, gain ${k.gain}` : ''}; ${took} ms)`);
    } catch (e) { log('automix: kick lock failed:', e?.message || e); }
  }
  // The deck's way back from `rate` to x1.0 after a blend of length D from t0:
  // 0.25% every 0.25 s (1% a second), as schedule points. Null when the song
  // plays at its own speed already, or the deck doesn't hold enough of it.
  // Automix v2's glide, the next song's side: one rate per beat, ending at x1.0
  // with the blend (so the player then takes over at x1.0, like after a glide back).
  function deckGlideIn(m, t0, G) {
    const points = [], B = G.inRate.length;
    for (let k = 1; k < B; k++) points.push({ output: t0 + G.at[k], input: m.mixInTrackTime + k * G.beatInSec, rate: G.inRate[k], active: true, loop: null });
    const trackAtEnd = m.mixInTrackTime + B * G.beatInSec;
    points.push({ output: t0 + G.total, input: trackAtEnd, rate: 1, active: true, loop: null });
    return { points, end: t0 + G.total, trackAtEnd };
  }
  const GLIDE_STEP = 0.0025, GLIDE_STEP_SEC = 0.25;
  function deckGlideBack(m, t0, D, rate) {
    const to = m.speedIn || 1;   // B's own speed after the mix (spotify-mixes.md rule 10), else x1
    if (Math.abs(rate - to) < 0.002) return null;
    const n = Math.ceil(Math.abs(rate - to) / GLIDE_STEP), points = [];
    let output = t0 + D, input = inStartOf(m) + D * rate, r = rate;
    for (let i = 1; i <= n; i++) {
      input += GLIDE_STEP_SEC * r; output += GLIDE_STEP_SEC;
      r = i === n ? to : rate + (to - rate) * (i / n);
      points.push({ output, input, rate: r, active: true, loop: null });
    }
    if (input + 10 > inPrep.end) return null;   // (then the player glides, as before)
    return { points, end: output, trackAtEnd: input };
  }
  // The new song is on YouTube's player: silent, held to the clock, it takes over
  // at the blend's end, or where the deck's glide back to x1.0 ends.
  function blendTakeOver(g, v) {
    const now = g.ctx.currentTime, m = live.mix, rate = m.rate || 1, H = 0.025, L = live, G = L.deckGlide, to = m.speedIn || 1;
    if (st.id !== m.nextId) { abortLive('the queue played another song than the blend was for'); return; }
    // just after the curves end (an event inside one is refused), or later if the player came late
    // (a next song cued near its opening: the player only plays from where the plan reaches 0:00, so
    // the deck plays on until the player has played long enough to be matched by ear, alignByEar)
    const tk = Math.max((G ? G.end : L.t0 + L.D) + 0.02, now + 1.6, G ? 0 : L.t0 - inStartOf(m) / rate + 4);
    const trackAt = (t) => (G && t >= G.end ? G.trackAtEnd + (t - G.end) * to : inStartOf(m) + (t - L.t0) * rate);
    if (trackAt(tk + 0.5) > inPrep.end) { abortLive('the player came too late for the incoming deck'); return; }
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    // held to the clock from now on (silent behind the gate), so its level can be read early
    const from = Math.min(now + 0.5, tk - 1.5);
    deck.restRate = to;
    if (G) {
      // only ever at x1.0 (or B's own speed): lined up with the deck where the deck's glide has ended
      deck.playAt(from, trackAt(tk) - (tk - from) * to, to);
      deck.setRate(to, tk + 3);
    } else {
      deck.playAt(from, trackAt(from), rate);
      if (Math.abs(rate - to) < 0.002) deck.setRate(to, tk + 3); else deck.glideToUnity(rate, tk, to);
    }
    deck.quietUntil = tk - 0.35;   // no silent seek right before the gate opens
    const gate = g.gate.gain, ig = inDeck.gain.gain;
    gate.cancelScheduledValues(now); gate.setValueAtTime(0, now); gate.setValueAtTime(0, tk); gate.linearRampToValueAtTime(1, tk + H);
    ig.setValueAtTime(1, tk); ig.linearRampToValueAtTime(0, tk + H);
    // the deck's level is matched to the player's: once the player has settled, and checked again before it takes over
    // (while the deck still glides, the two play different moments: only the late check then)
    const early = now + 2;
    if (!G && early < tk - 1.2) setTimeout(() => matchInLevel(L, early + 0.8), (early - now) * 1000);
    // (in step by ear first: while the deck glides, the two play different moments)
    if (!G) alignByEar(L, deck, inDeck, trackAt, rate, from + 0.6, tk - 0.1);
    setTimeout(() => matchInLevel(L, tk - 0.05), Math.max(0, (tk - 0.45 - now) * 1000));
    log(`automix: the new song waits on the player, taking over from the incoming deck in ${(tk - now).toFixed(2)} s${G ? ` (the deck glides from x${rate.toFixed(3)} to x1.000 first, ${(G.end - L.t0 - L.D).toFixed(1)} s; the player stays at x1.000)` : ''}`);
    addonEvent('takeover', { id: st.id, tk, H, startPos: trackAt(tk), inAddon: !!inPrep.addon });
    startStreamDeck(g, v, st.id, tk, H, L, trackAt(tk));
    L.mixEnd = tk;
    L.phase = 'mixing';
    L.mixId = st.id;
  }
  // ───────── the full-stream deck (src/plus/stream-deck.js, setting "Smooth hand-over") ─────────
  // After a blend the new song goes on from our own copy of its audio instead
  // of YouTube's player: the deck follows the player's clock (YouTube plays on,
  // muted, and still does play, pause, seek and next) and takes over from the
  // incoming deck at the blend's end, where the gate would open. Not in step by
  // then: the gate opens as before and the deck takes over once it is, a fade
  // between two copies of the same audio. On any trouble it hands the sound back
  // to the player, already at the same spot. It plays until the next mix's hand-over.
  let sdeck = null;
  async function startStreamDeck(g, v, id, takeAt, takeSec, L, startPos = null) {
    // (a song at its playlist speed stays on YouTube's player, which plays it at that speed)
    if (off1(speedOf(id))) { log('automix: no smooth hand-over or addon deck for a song at its playlist speed'); return; }
    // an addon's copy of the new song is ready: the addon deck takes over from the incoming deck
    // at the blend's end, where the schedule puts the song (startPos), instead of YouTube's copy
    const AP = window.__viviAddonsPage, rec = AP?.isOn() ? readyRec(id) : null;
    if (rec && startPos != null && window.__viviBufferDeck && rec.buf.sampleRate === g.ctx.sampleRate) {
      const run = adeck = { id, state: 'starting' };
      try { await playAddon(g, v, rec, run, AP, { takeAt, takeSec, startPos }); return; } catch (e) { log('addons: the addon deck could not take over:', e?.message || e); }
    }
    streamDeckBack('a new song');
    const SD = window.__viviStreamDeck, A = window.__viviAutomix;
    if (!userStreamDeck || !SD || !A || !g.bassFilter) return;
    let d = null;
    try {
      const bytes = await A.audioBytes(id);
      if (live !== L || st?.id !== id) return;
      d = SD.create(g.ctx, g.bassFilter);
      sdeck = d;
      await d.load(bytes, 'audio/webm');
      // it follows the player only shortly before it takes over: until then the player is held to
      // the mix (silent seeks, the incoming deck's glide), its clock not yet the song's own
      const wait = (takeAt - 3 - g.ctx.currentTime) * 1000;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // and only once the player has settled there: its quiet seeks (until just before the
      // take-over) would read as the deck losing its place (a glide's take-over comes soon after Next)
      const settled = () => {
        const pd = deck;
        if (!pd || pd.id !== id || pd.done) return true;
        const now = g.ctx.currentTime;
        return now >= pd.quietUntil || (now > pd.seekingUntil && pd.errors.length >= 3 && Math.abs(pd.lastError ?? 1) <= QUIET_ERROR_SEC);
      };
      while (!settled() && sdeck === d && live === L && st?.id === id) await new Promise((r) => setTimeout(r, 100));
      if (sdeck !== d || st?.id !== id || live !== L) { if (sdeck === d) sdeck = null; d.dispose(); return; }
      d.follow({
        clock: () => (st && st.id === id && !st.ad && graph() === g ? { pos: v.currentTime - st.off, playing: !v.paused && !v.seeking && v.readyState >= 3 } : null),
        level: () => (v.muted ? 0 : v.volume),   // the element's volume: the listener's times YouTube's loudness factor
        gate: g.gate.gain, takeAt, takeSec,
        onHandback: () => { if (sdeck === d) sdeck = null; d.dispose(); },
      });
    } catch (e) {
      log('automix: no stream deck for this song:', e?.message || e);
      if (d) { if (sdeck === d) sdeck = null; d.dispose(); }
    }
  }
  // the stream deck stops (YouTube's own sound back, if the deck was playing)
  function streamDeckBack(why) {
    const d = sdeck;
    sdeck = null;
    d?.dispose(why);
  }

  // ───────── addon audio (spec/addons/protocol.md §8, PC; offset-map.md) ─────────
  // When an addon has a song, its file is fetched (by the background), fitted to
  // YouTube's own audio of the song, levelled and decoded: a `rec` (file seconds =
  // song seconds + rec.off, at gain rec.k). The playing song's plays on the addon
  // deck (addons/buffer-deck.js) in step with YouTube, muted underneath. It is
  // `sdeck`, so the next mix releases it, onto a tail cut from the same file; the
  // next song's rec is made ahead, so the blend's incoming deck plays it too and
  // the addon deck takes over from that deck at the blend's end. On any trouble
  // it hands the sound back to YouTube at the same spot.
  let adeck = null;   // { id, state } for the song the addon deck last ran for
  // "Upgrade quality" (page-addons.js): the song's copy is readied afresh; the playing deck keeps
  // playing until the new one takes over (playAddon), and a mix's next song is prepared again
  try {
    window.addEventListener('vivi-addons-refresh', (e) => {
      const id = e.detail?.id;
      if (!id) return;
      prepared.delete(id);
      if (adeck?.id === id && !live) adeck = null;
    });
  } catch { /* no window */ }
  const prepared = new Map();   // song id -> { promise, rec?, none? }: the playing song's, the next one's, the last one's
  const addonEvents = [];       // what the addon path did, on the audio clock (tests)
  const addonEvent = (ev, x = {}) => { addonEvents.push({ ...x, ev, t: graph()?.ctx.currentTime ?? null }); if (addonEvents.length > 60) addonEvents.shift(); };
  const readyRec = (id) => (id && prepared.get(id)?.rec) || null;
  let addonTapFor = null, addonTapP = null;
  function addonTap(g) {
    if (addonTapFor !== g) {
      addonTapP?.then((t) => t?.close());   // the equalizer rebuilt the graph: the old tap goes
      addonTapFor = g;
      addonTapP = window.__viviBufferDeck.tap(g.ctx, g.source).catch((e) => { log('addons: no tap on YouTube\'s output:', e?.message || e); return null; });
    }
    return addonTapP;
  }
  // the decoded copies kept: the playing song's, the next one's, the deck's and the one a mix is
  // still leaving (each is a whole song as float32 at the context's rate, ~100 MB); a finished
  // mix's is let go at once. `idle`: playback paused a while, so the next song's goes too.
  let testRecording = false;
  // the song just left is kept a while: Song -> Video -> Song (the music video is another id) comes
  // back to it, and without its copy it played YouTube's sound ~40 s (fetched and fitted again,
  // queued behind the video's analysis)
  const LEFT_KEEP_MS = 5 * 60e3;
  let left = { id: null, at: 0 }, tickId = null, tickAt = 0;   // tickAt: when the song started here (take-over timing)
  const keptLeft = (k) => k === left.id && performance.now() - left.at < LEFT_KEEP_MS;
  function pruneAddons(idle = false) {
    if (testRecording) return;
    for (const [k, p] of prepared) {
      if (!p.rec && p.state !== 'failed') continue;   // still being prepared
      if (k === st?.id || k === adeck?.id || k === live?.oldId || keptLeft(k) || (!idle && k === st?.next)) continue;
      prepared.delete(k);
    }
  }
  let pausedSince = 0;
  if (typeof setInterval === 'function') setInterval(() => {
    const v = graph()?.video;
    if (!v || !v.paused) { pausedSince = 0; return; }
    pausedSince ||= performance.now();
    if (performance.now() - pausedSince > 5 * 60e3) pruneAddons(true);
  }, 60e3);
  function addonTick(g, v) {
    const AP = window.__viviAddonsPage;
    if (!AP?.isOn() || !st || st.ad || !st.id) return;
    // (a song at its playlist speed plays on YouTube's player: spotify-mixes.md rule 10)
    if (off1(speedOf(st.id))) return;
    AP.deckAlive?.();   // the badge's "Upgrading Quality" only while this runs (no audio graph: no deck)
    if (st.id !== tickId) { if (tickId) left = { id: tickId, at: performance.now() }; tickId = st.id; tickAt = performance.now(); }
    pruneAddons();
    if (adeck?.id !== st.id && !live) {
      const run = adeck = { id: st.id, state: 'starting' };
      // back on a song whose copy played before (Song → Video → Song, a replay): its old 'playing'
      // must not show the badge while YouTube's audio plays until the deck takes over again
      AP.note(run.id, { play: { state: 'starting' } });
      startAddonDeck(g, v, run, AP).catch((e) => {
        run.state = 'failed';
        AP.note(run.id, { play: { state: 'failed', why: String(e?.message || e) } });
        log('addons: no addon audio for this song:', e?.message || e);
      });
    }
    loopPrep.reload?.();   // a loop mix loaded before an addon copy was there
    // the next song, ahead of the mix: opened, fetched, fitted and decoded from 25 s before the
    // transition (protocol.md 8.1.3: the mix-out when one is planned, else the song's end)
    const nx = st.next;
    if (nx && nx !== st.id && (!prepared.has(nx) || retryable(prepared.get(nx))) && adeck?.id === st.id && !['starting', 'fetching', 'fitting'].includes(adeck.state)
      && window.__viviAutomix?.isEnabled?.() && AP.openDue?.(v.currentTime - st.off, amx.id === st.id && amx.plan?.mixOutTrackTime > 0 ? amx.plan.mixOutTrackTime : st.dur)) {
      prepareAddon(g, nx, AP, 0).then((r) => {
        if (r.rec) log(`addons: the next song is ready from ${r.rec.name}: offset ${(r.rec.off * 1000).toFixed(1)} ms, level ${r.rec.gainDb >= 0 ? '+' : ''}${r.rec.gainDb.toFixed(2)} dB`);
        else log('addons: no addon audio for the next song:', r.none);      });
    }
  }
  // a FLAC file's STREAMINFO: 'fLaC', a 4-byte block header, then (after 10 bytes) 20 bits of
  // sample rate, 3 of channels - 1 and 5 of bits per sample - 1
  function flacFormat(bytes) {
    const u = bytes instanceof ArrayBuffer ? new Uint8Array(bytes, 0, Math.min(26, bytes.byteLength)) : new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(26, bytes.byteLength));
    if (u.length < 22 || u[0] !== 0x66 || u[1] !== 0x4c || u[2] !== 0x61 || u[3] !== 0x43 || (u[4] & 0x7f) !== 0) return null;
    const sampleRate = (u[18] << 12) | (u[19] << 4) | (u[20] >> 4);
    const channels = ((u[20] >> 1) & 7) + 1, bitDepth = (((u[20] & 1) << 4) | (u[21] >> 4)) + 1;
    return sampleRate > 0 ? { sampleRate, bitDepth, channels } : null;
  }
  async function decodeAt(bytes, rate, channels) {
    const c = new OfflineAudioContext(channels, 1, rate);
    return c.decodeAudioData(bytes.slice(0));   // (decoding detaches its input)
  }
  // a channel copied into an array of our own: in a Firefox content script getChannelData's
  // array is the page's, and every read through its wrapper is slow (a song's level took 25 s)
  const ownChannel = (buf, c) => { const x = new Float32Array(buf.length); buf.copyFromChannel(x, c); return x; };
  const monoOf = (buf) => {
    if (buf.numberOfChannels === 1) return ownChannel(buf, 0);
    const out = new Float32Array(buf.length), n = buf.numberOfChannels;
    for (let c = 0; c < n; c++) { const d = ownChannel(buf, c); for (let i = 0; i < out.length; i++) out[i] += d[i] / n; }
    return out;
  };
  // an addon's audio on the song's own timeline: `len` samples from song second `from`, at its level
  // (what the tail and the incoming deck play: YouTube's copy's place, the file's sound)
  function addonSpan(ctx, rec, from, len) {
    const out = ctx.createBuffer(2, Math.max(1, len), rec.buf.sampleRate);
    for (let c = 0; c < 2; c++) out.copyToChannel(addonSamples(rec, c, from, Math.max(1, len)), c);
    return out;
  }
  // one channel of it (silence where the file has none)
  function addonSamples(rec, c, from, len) {
    const sr = rec.buf.sampleRate, dst = new Float32Array(Math.max(0, len));
    const start = Math.round((from + rec.off) * sr), s = Math.max(0, start);
    if (dst.length && s < rec.buf.length && s - start < dst.length) rec.buf.copyFromChannel(dst.subarray(s - start), Math.min(c, rec.buf.numberOfChannels - 1), s);
    if (rec.k !== 1) for (let i = 0; i < dst.length; i++) dst[i] *= rec.k;
    return dst;
  }
  // an addon's copy standing in for YouTube's decoded copy `like` (song seconds from 0): the loop
  // decks and the tail read slices of it, the same timeline with the file's sound
  const addonView = (rec, like) => ({
    sampleRate: like.sampleRate, length: like.length, duration: like.duration, numberOfChannels: 2,
    getChannelData: (c) => ({ slice: (a = 0, b = like.length) => addonSamples(rec, c, a / like.sampleRate, Math.min(b, like.length) - a) }),
  });
  // FIND, OPEN, the file, YouTube's audio, the fit, the level and the decode, once per song
  const retryable = (p) => p.state === 'failed' && p.tries < 2 && performance.now() - p.failedAt > 60000;
  const NEXT_ROWS = 4;   // protocol.md 8.1.4: copies tried after a refused one, per song (each is a file download)
  function prepareAddon(g, id, AP, durSec, say = () => {}) {
    const have = prepared.get(id);
    // a failed one is kept (each try downloads the file) and tried once more, a minute later at the earliest
    if (have && !retryable(have)) return have.promise;
    const tries = (have?.tries || 0) + 1;
    // kept: the playing song's, the next one's and the last one's (the mix's tail)
    for (const k of [...prepared.keys()]) if (prepared.size >= 3 && k !== st?.id && k !== st?.next && k !== adeck?.id && k !== live?.oldId && !keptLeft(k)) prepared.delete(k);
    const me = {};
    me.promise = (async () => {
      const F = window.__viviOffsetFit, A = window.__viviAutomix;
      let s = await AP.openFor(id, durSec);
      if (s?.state !== 'ready') return { none: s?.why || 'no addon has it', state: 'none' };
      say('fetching');
      const t0 = performance.now();
      // YouTube's own audio of the song first, so a missing one costs no file download: Automix's
      // download, which may not have started yet (the page answers "not downloaded" at once then),
      // so it is asked again for up to a minute
      let ytBytes = null, why = '';
      for (let i = 0; i < 30 && !ytBytes && prepared.get(id) === me; i++) {
        if (i) await new Promise((r) => setTimeout(r, 2000));
        ytBytes = await A.audioBytes(id).catch((e) => { why = String(e?.message || e); return null; });
        if (!ytBytes && !/not downloaded|loading/.test(why)) break;
      }
      if (!ytBytes) throw new Error('YouTube\'s audio of the song: ' + (why || 'not downloaded'));
      // protocol.md 8.1.4: a copy the fit refuses passes to the next ready row or lane (the song plays YouTube's
      // audio meanwhile), up to NEXT_ROWS more; YouTube's audio stays only when none passes
      for (let more = 0; ; more++) {
        const file = await AP.fetchFor(id);
        if (!file.bytes) {
          // (a copy that is no audio at all, a playlist or manifest, is refused like a bad fit: 8.1.4 and 8.1.6)
          const nx = file.refused && more < NEXT_ROWS && prepared.get(id) === me && AP.nextFor ? await AP.nextFor(id, file.none) : null;
          if (nx?.state === 'ready' && prepared.get(id) === me) { s = nx; say('fetching'); continue; }
          throw new Error(file.none);
        }
        // the file's own format beats what the addon said (some send no bit depth or rate): the badge's Hi-Res
        const fmt = flacFormat(file.bytes);
        if (fmt) AP.note(id, { stream: { ...s.stream, ...fmt, codec: 'flac' } });
        say('fitting');
        const t1 = performance.now();
        const [ytBuf, adBuf] = await Promise.all([decodeAt(ytBytes, F.FIT_RATE, 2), decodeAt(file.bytes, F.FIT_RATE, 2)]);
        // the mono mixes here (cheap); the fit, both loudness reads and the true-peak pass in the
        // analysis frame's worker (addons/fit.worker.js): on this thread they held the page about
        // 1 s per song. This thread only when that frame is out (the arrays are then still here).
        let busy = performance.now();
        let yt = monoOf(ytBuf), ad = monoOf(adBuf);
        busy = performance.now() - busy;
        let where = 'worker';
        let fitted = await A.addonWork({ op: 'fit', yt, ad, opt: { slackSec: 5 } }, [yt.buffer, ad.buffer])
          .catch((e) => { log('addons: no fit worker:', e?.message || e); return null; });
        if (!fitted) {
          if (!yt.length || !ad.length) { yt = monoOf(ytBuf); ad = monoOf(adBuf); }   // (handed to the worker)
          const t = performance.now();
          const f = F.fit(yt, ad, { slackSec: 5 });
          fitted = f.none ? { fit: f } : { fit: f, ytLufs: F.integratedLufs(yt, F.FIT_RATE), addonLufs: F.integratedLufs(ad, F.FIT_RATE) };
          busy += performance.now() - t; where = 'main thread';
        }
        const { fit, ytLufs, addonLufs } = fitted;
        if (fit.none) {
          log(`addons: ${s.addon.name} (${s.addon.host}) refused for this song: ${fit.none}`, fit);
          const nx = more < NEXT_ROWS && prepared.get(id) === me && AP.nextFor ? await AP.nextFor(id, fit.none) : null;
          if (nx?.state === 'ready' && prepared.get(id) === me) { s = nx; say('fetching'); continue; }
          return { none: fit.none, state: 'refused', fit };
        }
        // the whole file at the audio context's rate (what the decks play), and its level: YouTube's
        // loudness minus the file's, a boost at most +6 dB, the true peak kept at or under -1 dBTP
        const full = await decodeAt(file.bytes, g.ctx.sampleRate, 2);
        let lvl;
        if (ytLufs > addonLufs) {   // a boost: its true peak is read over the whole file at the context's rate
          let t = performance.now();
          let addonChannels = Array.from({ length: full.numberOfChannels }, (_, c) => ownChannel(full, c));
          busy += performance.now() - t;
          const args = { ytLufs, addonLufs, addonChannels, rate: g.ctx.sampleRate };
          lvl = (await A.addonWork({ op: 'gain', args }, addonChannels.map((x) => x.buffer)).catch(() => null))?.lvl;
          if (!lvl) {
            t = performance.now();
            if (!addonChannels[0]?.length) args.addonChannels = addonChannels = Array.from({ length: full.numberOfChannels }, (_, c) => ownChannel(full, c));
            lvl = F.sourceGainDb(args); busy += performance.now() - t; where = 'main thread';
          }
        } else lvl = F.sourceGainDb({ ytLufs, addonLufs, addonChannels: [], rate: g.ctx.sampleRate });
        const t3 = performance.now();
        const rec = {
          id, buf: full, off: fit.offsetSec, k: 10 ** (lvl.gainDb / 20), gainDb: lvl.gainDb, lvl, fit,
          name: s.addon.name, host: s.addon.host, stream: s.stream,
          took: { all: t3 - t0, fetch: t1 - t0, fit: t3 - t1 }, fileBytes: file.bytes.byteLength, passedOver: more,
        };
        log(`addons: ${rec.name} (${rec.host}) fits: offset ${(rec.off * 1000).toFixed(1)} ms (score ${fit.score.toFixed(3)}, check ${fit.checkScore.toFixed(3)} at ${fit.checkSec.toFixed(0)} s), ` +
          `level ${lvl.gainDb >= 0 ? '+' : ''}${lvl.gainDb.toFixed(2)} dB (wanted ${lvl.wantDb?.toFixed(2)}${lvl.capped ? ', capped by ' + lvl.capped : ''}), ` +
          `${full.sampleRate} Hz x ${full.numberOfChannels}, ready after ${((t3 - t0) / 1000).toFixed(1)} s (fetch and YouTube's audio ${((t1 - t0) / 1000).toFixed(1)} s, fit, level and decode ${((t3 - t1) / 1000).toFixed(1)} s; fit and level in the ${where}, main thread busy ${busy.toFixed(0)} ms)`);
        return { rec };
      }
    })().then((r) => { if (prepared.get(id) === me) Object.assign(me, r); return r; },
      (e) => { const r = { none: String(e?.message || e), state: 'failed' }; if (prepared.get(id) === me) Object.assign(me, r, { tries, failedAt: performance.now() }); return r; });
    prepared.set(id, me);
    return me.promise;
  }
  async function startAddonDeck(g, v, run, AP) {
    const id = run.id;
    const gone = () => adeck !== run || st?.id !== id || !!live;
    const say = (state, extra = {}) => { run.state = state; AP.note(id, { play: { state, ...extra } }); };
    const missing = [!window.__viviOffsetFit && 'offset fit', !window.__viviBufferDeck && 'addon deck', !window.__viviAutomix && 'automix', !g.bassFilter && 'audio graph'].filter(Boolean);
    if (missing.length) throw new Error('missing parts: ' + missing.join(', '));
    addonTap(g);   // made now, so it holds YouTube's last moments by the time the deck needs them
    const r = await prepareAddon(g, id, AP, st.dur, (s) => { if (!gone()) say(s); });
    if (gone()) return;
    if (!r.rec) { if (r.state === 'failed') throw new Error(r.none); say(r.state, { why: r.none, fit: r.fit }); return; }
    await playAddon(g, v, r.rec, run, AP, {});
  }
  // the addon deck plays `rec` from now (anchored on YouTube's output), or from takeAt at song second startPos
  async function playAddon(g, v, rec, run, AP, { takeAt = 0, takeSec, startPos = null }) {
    const id = rec.id, BD = window.__viviBufferDeck;
    const say = (state, extra = {}) => { run.state = state; AP.note(id, { play: { state, ...extra } }); };
    const tp = await addonTap(g);
    if (adeck !== run || st?.id !== id) return;
    streamDeckBack('the addon\'s copy takes over');
    const d = BD.create(g.ctx, g.bassFilter);
    d.addon = true;
    d.addonId = id;
    const tL = performance.now();
    rec.mono ??= BD.monoOf(rec.buf);   // once per file: a later deck of the same song shares it
    d.load(rec.buf, rec.off, rec.mono);
    log(`addons: deck loaded in ${(performance.now() - tL).toFixed(0)} ms (main thread)`);
    sdeck = d;
    // what the copy costs and how long the song played YouTube's sound first (protocol.md §8 intro:
    // these decide whether the PC ever streams); a deck a mix starts (takeAt) has no wait of its own
    const decodedMB = (rec.buf.length * rec.buf.numberOfChannels * 4 + (rec.mono?.length || 0) * 4) / 1e6;
    const takeoverMs = takeAt ? 0 : Math.round(performance.now() - tickAt);
    log(`addons: take-over ${takeAt ? 'at the mix (prepared ahead)' : (takeoverMs / 1000).toFixed(1) + ' s after the song started'}; ` +
      `the copy holds ${decodedMB.toFixed(0)} MB decoded (${rec.buf.sampleRate} Hz x ${rec.buf.numberOfChannels}, with its mono) from a ${((rec.fileBytes || 0) / 1e6).toFixed(1)} MB file`);
    say('playing', { offsetSec: rec.off, gainDb: rec.lvl.gainDb, wantDb: rec.lvl.wantDb, capped: rec.lvl.capped, score: rec.fit.score, checkScore: rec.fit.checkScore,
      takeoverMs, mixTake: !!takeAt, decodedMB: Math.round(decodedMB), fileMB: Math.round((rec.fileBytes || 0) / 1e5) / 10, took: rec.took });
    addonEvent('deck', { id, takeAt, startPos, off: rec.off, k: rec.k });
    // protocol.md 8.2.1: a lossy copy, or a cached one below the tier asked, gets one pass for a
    // better copy; one found is readied by the next tick and its deck takes over from this one
    AP.upgradeFor?.(id).then((better) => {
      if (!better || adeck !== run || st?.id !== id || live) return;
      log('addons: a better copy was found; it takes over once it is fetched and fitted');
      prepared.delete(id);
      adeck = null;
    }).catch(() => {});
    d.follow({
      clock: () => (st && st.id === id && !st.ad && graph() === g ? { pos: v.currentTime - st.off, playing: !v.paused && !v.seeking && v.readyState >= 3 } : null),
      level: () => (v.muted ? 0 : v.volume) * rec.k,   // the element's volume times the file's correction
      gate: g.gate.gain, tap: tp, takeAt, takeSec, startPos,
      onHandback: (why) => { if (sdeck === d) sdeck = null; d.dispose(); if (adeck === run) say('handed back', { why }); addonEvent('handback', { id, why }); },
    });
  }

  // Tests (the test Firefox): records what the audio graph plays (`out`: its output, `deck`: the
  // addon deck, `yt`: YouTube's own output), with exact audio frames, and hands it over with the
  // addon files' spans and the events; the numbers are worked out on the test's side.
  const recTaps = {};
  async function addonRecTest(d) {
    const reply = (data, transfer = []) => window.postMessage({ ch: CHANNEL, dir: 'fixture', reqId: d.reqId, ...data }, window.location.origin, transfer);
    try {
      const g = graph(), BD = window.__viviBufferDeck;
      if (!g || !BD) throw new Error('no audio graph');
      if (d.op === 'start') {
        const nodes = { out: g.out, mix: g.mix, deck: sdeck?.out, yt: g.source };
        for (const name of d.sources || ['out']) if (!nodes[name]) throw new Error('nothing to record: ' + name);
        testRecording = true;   // (the songs' files stay until the stop hands them over)
        for (const name of d.sources || ['out']) {
          recTaps[name]?.close();
          recTaps[name] = await BD.tap(g.ctx, nodes[name], { frames: 4096 });
          await recTaps[name].record(true);
        }
        reply({ ok: true, at: g.ctx.currentTime });
      } else if (d.op === 'stop') {
        testRecording = false;
        const recs = {}, transfer = [];
        for (const [name, t] of Object.entries(recTaps)) {
          await t.record(false);
          recs[name] = t.take();
          transfer.push(...recs[name].chans.map((a) => a.buffer));
          t.close(); delete recTaps[name];
        }
        const refs = {};
        for (const r of d.refs || []) {
          const rec = readyRec(r.id);
          if (!rec) continue;
          const sr = rec.buf.sampleRate, from = Math.max(0, Math.floor(r.from * sr)), to = Math.min(rec.buf.length, Math.ceil(r.to * sr));
          const chans = [0, 1].map((c) => { const x = new Float32Array(Math.max(0, to - from)); rec.buf.copyFromChannel(x, Math.min(c, rec.buf.numberOfChannels - 1), from); return x; });
          refs[r.id] = { from: from / sr, rate: sr, off: rec.off, k: rec.k, chans };
          transfer.push(...chans.map((a) => a.buffer));
        }
        reply({ ok: true, rate: g.ctx.sampleRate, recs, refs, events: addonEvents.slice() }, transfer);
      } else if (d.op === 'state') {
        reply({
          ok: true, now: g.ctx.currentTime, rate: g.ctx.sampleRate, events: addonEvents.slice(), deck: sdeck?.stats?.() || null, deckIsAddon: !!sdeck?.addon,
          prepared: [...prepared.entries()].map(([id, p]) => ({ id, ready: !!p.rec, none: p.none || null, off: p.rec?.off, k: p.rec?.k, rate: p.rec?.buf.sampleRate, len: p.rec?.buf.duration, name: p.rec?.name, stream: p.rec?.stream })),
          live: live ? { phase: live.phase, oldId: live.oldId, mixId: live.mixId, T: live.T, t0: live.t0, D: live.D, inDeck: !!live.inDeck, style: live.mix?.style } : null,
          inPrep: { key: inPrep.key, state: inPrep.state, addon: !!inPrep.addon, end: inPrep.end },
        });
      }
    } catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
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
  // A mix ends, and most of its checks run, on the audio clock (mixEnd, the copy's onended, the
  // asks and grace times): a context that stops running (suspended, its output device gone) never
  // gets there, and the mix would hold the player and every later skip for good. The wall-clock
  // watchdog: the audio clock standing still CLOCK_STALL_MS while a mix is live calls it off.
  const CLOCK_STALL_MS = 3000;
  const CLOCK_STOPPED = 'the audio clock stopped';
  function clockStalled(L, now, wall) {
    if (!L.clock || now > L.clock.ctx + 1e-6) { L.clock = { ctx: now, wall }; return false; }
    return wall - L.clock.wall > CLOCK_STALL_MS;
  }
  function driveLive(g, v) {
    const now = g.ctx.currentTime;
    if (seconds() === 0 || !v || g.video !== v) { abortLive('crossfade off or player changed'); return; }
    if (clockStalled(live, now, performance.now())) { abortLive(CLOCK_STOPPED); return; }

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
        // Between Next and the new song's title, the player can pause for a reason of its own: an ad slot (uBlock
        // empties it, the flag shows for a moment, AD_GRACE) or a load (its data gone, readyState under 3). Neither
        // is the listener's pause: an ad flag waits out its grace, as after the change; only a settled pause aborts.
        // (Seen 2026-11-24: a blend called off "paused" 1.0 s after our Next, the title 0.2 s from changing.)
        if (st?.ad) { if (adLong) abortLive('ad'); return; }
        if (sinceAsk > 1 && v.paused && v.readyState >= 3 && !v.seeking) abortLive('paused');   // user paused, or next did nothing
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
      // the overview's button (automix-overview.js) pulses with the fill: its colour, the label's beat
      bar.style.setProperty('--vivi-mix-color', fill.style.background || '#fff');
      bar.style.setProperty('--vivi-mix-pulse', (0.35 + 0.65 * m.alpha).toFixed(3));
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
      bar.style.removeProperty('--vivi-mix-color');
      bar.style.removeProperty('--vivi-mix-pulse');
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
    addonTick(g, v);   // an addon's copy of the playing song, when one has it
    if (window.__viviAutomix?.isEnabled()) warmDecks(g);
    // The last blend's incoming song gliding back to its own tempo: its rate is ours, not the user's.
    if (deck && deck.id !== st.id) deck.cancel();
    const gliding = !!deck && deck.id === st.id;

    // a song's playlist speed (spotify-mixes.md rule 10) on the player, between mixes; never over a
    // speed the user set (only from x1 or from one this code set)
    const want = window.__viviAutomix?.isEnabled() ? speedOf(st.id) : 1;
    if (!live && !gliding) {
      if (off1(want) && Math.abs(v.playbackRate - want) > 1e-6 && (v.playbackRate === 1 || v.playbackRate === speedSet)) {
        v.playbackRate = want; speedSet = want;
        log(`automix: ${st.id} plays at its playlist speed x${want}`);
      } else if (!off1(want) && speedSet && v.playbackRate === speedSet) { v.playbackRate = 1; speedSet = 0; }
    }
    const eligible = !v.paused && (Math.abs(v.playbackRate - want) < 1e-3 || gliding) && !st.ad && !st.rep
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
      wantSong(st.id, st.dur);
      if (st.next && st.next !== st.id) wantSong(st.next);
      if (songs.get(st.id)?.state === 'ready') A.request(st.id, true, st.dur);   // the playing song's mix-out comes first
    } else if (amx.state !== 'fallback' && amx.state !== 'done') amx.state = 'off';

    if (amx.state === 'idle' || amx.state === 'waiting' || amx.state === 'ready') {
      if (amx.state === 'idle') {
        // Planned afresh each tick until the outro is asked for: it follows
        // seeks, a queue change and analyses as they land.
        const from = A.get(st.id), to = st.next ? A.get(st.next) : null;
        const pairKey = st.id + '>' + (st.next || '');
        // (an editor override, or a pick from before the editor: automix.js migratePick)
        const pick = A.migratePick(pairPicks[pairKey] || null);
        // No transition (editor.md §2): no mix and no crossfade, the next song starts when this one ends
        if (pick?.preset === 'none') { amx.plan = null; return; }
        const loopPicked = pick?.preset === 'loop';
        // each song's playlist speed (spotify-mixes.md rule 10); the loop mix has its own tempo: none then
        const speed = { out: speedOf(st.id), in: st.next ? A.songSpeed(st.next, st.id, null, (k) => pairPicks[k] || null) : 1 };
        const noLoop = (!!pick && !loopPicked) || off1(speed.out) || off1(speed.in);
        const planArgs = { fromId: st.id, toId: st.next, from, to, durationSec: st.dur, pos, earliest: pos + HAND_LEAD + 0.5, pick: noLoop && !loopPicked ? pick : null, fadeSec: seconds(), speed };
        let p = A.plan(planArgs);
        p.nextId = st.next || '';
        // The loop mix (BitChord AutoDJ): prepared in the background as soon as
        // both songs are analysed, so the status shows it from the start; when
        // it found bars to loop, it is the mix. (Its bars are searched in the
        // song's last OUT_SEARCH_SEC, so preparing early picks the same loop.)
        // (a blend, filter mix or fade picked in the overview: no loop mix for this pair)
        if (st.next && from && to && loopPrep.key !== pairKey && !noLoop) prepareLoopMix(g, st.id, st.next, pos);
        const loopPending = !noLoop && loopPrep.key === pairKey && loopPrep.state === 'loading';
        const lp = !noLoop && loopPrep.key === pairKey && loopPrep.state === 'ready' ? loopPrep : null;
        // (Automix v2 scores the loop against the blend: automix.js loopOrBlend)
        const lpPick = lp ? (loopPicked ? { loop: !lp.plan.none, why: 'Loop picked for these two' } : A.loopOrBlend(p, lp.plan)) : null;
        if (lp && lpPick.why && loopChoiceLogged !== pairKey) { loopChoiceLogged = pairKey; log(`automix: ${lpPick.loop ? 'loop mix' : 'blend'} chosen (${lpPick.why})`); }
        if (lp && lpPick.loop && lp.plan.out.loop[0] > pos + HAND_LEAD + 1) {
          const x = A.loopSchedule(lp.plan, 0);
          // (the loop decks do the tempo: none of the blend's speed-up of the playing song)
          p = { ...p, style: 'loop', loop: lp.plan, fallback: false, reason: '', outRate: 1, rampBeats: 0, rampSongSec: 0,
            mixOutTrackTime: lp.plan.out.loop[0], durationSec: x.elementAt,
            mixInTrackTime: x.elementTrackTime, rate: 1, bars: lp.plan.totalBars, bpm: lp.plan.out.bpm, inBpm: lp.plan.in.bpm, nextId: st.next };
        }
        // Automix v2, Auto's blend and not the loop mix (decided on the usual blend's numbers): the curator
        // blend, placed as Spotify's playlist editors place theirs (analysis-cases.md "The curator blend";
        // the planner falls back to the usual blend where it doesn't fit)
        if (A.getVersion() === 3 && p.style === 'blend' && !p.shape && !loopPending && !(lp && lpPick.loop)) {
          const k = A.plan({ ...planArgs, curator: true });
          if (k.curator) { k.nextId = p.nextId; p = k; }
        }
        amx.plan = p;
        // a blend: the next song's part of it is put on the incoming deck meanwhile
        if (p.style !== 'loop' && !p.fallback && !loopPending && to) prepareInDeck(g, p, pos);
        // the old song moves to its decoded copy this long before the blend: before its speed-up, if it has one
        const lead = HAND_LEAD + (p.style === 'blend' ? p.rampSongSec || 0 : 0);
        if (needsOutDeck(p)) ensureBlendDeck(g);
        if (!(p.durationSec >= 1)) { amxGiveUp('no room left for a blend'); }
        else if (pos >= p.mixOutTrackTime - lead - TAIL_LEAD && !(loopPending && pos < p.mixOutTrackTime - lead - 8)) {
          const needFrom = st.off + Math.max(0, p.mixOutTrackTime - lead - 3);
          ensureTap();
          if (p.style === 'loop' && !(plan && plan.id === st.id && plan.loop)) {
            // the outgoing song's copy is cut from the loop deck's own samples
            setPlan(g, { id: st.id, channels: lp.tail.channels, sampleRate: lp.tail.sampleRate, start: st.off + lp.tail.start });
            plan.loop = true;
            lp.tailCut = true;
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
        if (pos >= handAt - TICK_MS / 2000 && (amx.plan.style === 'loop' || outgoingDeckReady(g, amx.plan))) {
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
      const noMix = !live && st.next && window.__viviAutomix.migratePick(pairPicks[st.id + '>' + st.next] || null)?.preset === 'none';
      const why = live ? 'A plain crossfade is playing' : noMix ? 'No transition: the next song starts when this one ends'
        : amx.state === 'fallback' ? 'This song ends with a plain crossfade' : st.next ? 'Planning the mix…' : 'Nothing queued after this song';
      // a pick for this pair stays undoable while there is no mix to show
      const pairKey = !live && st.next ? st.id + '>' + st.next : '';
      // (the songs, for the overview's progress row: editor.md §11)
      const ids = { curId: st.id, nextId: st.next || null, live: !!live };
      return pairKey && pairPicks[pairKey] ? { why, pairKey, toId: st.next, pick: pairPicks[pairKey], noTransition: noMix, ...ids } : { why, ...ids };
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
      const [gIn, gOut] = x ? [null, null] : m.preset && m.curves
        // (1024: a drawn gate of a fifth of a second still shows, editor.md §10)
        ? [m.curves.in.gain, m.curves.out.gain].map((pts) => Float32Array.from({ length: 1024 }, (_, i) => curveAt(pts, (D * i) / 1023, false)))
        : gainCurves(m, m.style, D);
      ovShape = { m, src, x, D, gIn, gOut };
    }
    const { x, D, gIn, gOut } = ovShape;
    // where the music is on the mix's clock
    let at = null;
    if (g && live?.t0 != null) at = g.ctx.currentTime - live.t0;
    else if (g && !live) at = (g.video.currentTime - (st.off || 0)) - m.mixOutTrackTime;
    const lp = loopPrep.key === pairKey ? loopPrep : null;
    return {
      fromId, toId, pairKey, mix: m, x, D, at, gIn, gOut, live: !!live,
      phase: live ? live.phase : amx.state,
      paused: !live && !!g?.video?.paused,
      fromDur: live ? null : st.dur,
      // the earliest A's mix-out can be moved to now: the playhead plus the planner's lead
      earliest: !live && g ? (g.video.currentTime - (st.off || 0)) + HAND_LEAD + 0.5 : null,
      // (on this app's grid: a mix file's beats at half or double time are folded, mix-file.md rule 4)
      pick: pairPicks[pairKey] ? window.__viviAutomix.foldOverride(window.__viviAutomix.migratePick(pairPicks[pairKey]), window.__viviAutomix.editorGrid(window.__viviAutomix.get(fromId), 'out')?.bpm).ov : null,
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
    importPairPicks,
    queueSongs,
    pairPicksAll: () => JSON.parse(JSON.stringify(pairPicks)),
    curveAt,
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

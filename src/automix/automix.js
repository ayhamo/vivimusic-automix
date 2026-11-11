/**
 * VIVIMUSIC WEB — automix.js  (content script, isolated world)
 *
 * BitChord web's automix (web/app/src/playback/automix, itself AutoMix by
 * David Finnegan), ported to the extension. AGPL-3.0-only, as BitChord's.
 *
 *   • Analysis (BitChord's analysis/analyzer.ts): the whole playing song and
 *     the whole next song are downloaded (crossfade-page.js) and analysed one
 *     at a time: essentia over the song at 44.1 kHz for tempo, key, energy,
 *     intro and outro, and the Beat This! model over its first and last 59 s
 *     for the grid it is mixed in on (head) and out on (tail).
 *   • Planning (BitChord's engine/transition-scheduler.ts): a phrase-aligned
 *     blend in the outgoing song's outro, the incoming song started on its
 *     pre-full-energy phrase and time-stretched to the outgoing tempo (pitch
 *     kept); a filter mix when the pair can't be beatmatched; AutoMix's plain
 *     12-second crossfade when there is no grid. Times here are song seconds;
 *     crossfade.js puts them on the audio clock and plays them.
 *
 *   • The loop mix (BitChord engine/loopMix.ts), when both songs have
 *     instrumental bars to loop (the open-unmix vocal mask says where they
 *     are sung); the planning is here, the stretch decks in crossfade.js.
 *
 * The model runs in a Worker inside a hidden extension frame (host.html):
 * Firefox refuses Workers started from a content script with an extension URL.
 */
(() => {
  'use strict';
  if (window.__viviAutomix) return;

  const log = (...a) => console.log('%c[ViVi automix]', 'color:#ff4b8b', ...a);
  const HOST_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const ANALYSIS_SR = 44100;          // RhythmExtractor2013 assumes 44.1 kHz
  const RETRY_FAILED_MS = 60000;      // a failed analysis is asked for again after this long
  const KEEP_RESULTS = 12;

  let enabled = true;
  let barsSetting = 'auto';
  // 1: the web original; 2: AutoDJ, the original plus BitChord phone ideas.
  // Everything version 2 adds checks `version === 2`, so 1 stays as it was.
  let version = 1;
  let keyAware = false;   // version 2's key-aware blend length, off unless switched on
  try {
    chrome.storage.local.get({ automixEnabled: true, automixBars: 'auto', automixVersion: 1, automixKeyAware: false }, (s) => {
      enabled = s.automixEnabled !== false;
      barsSetting = s.automixBars === 'auto' ? 'auto' : (Number(s.automixBars) || 8);
      version = s.automixVersion === 2 ? 2 : 1;
      keyAware = s.automixKeyAware === true;
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('automixEnabled' in ch) enabled = ch.automixEnabled.newValue !== false;
      if ('automixBars' in ch) barsSetting = ch.automixBars.newValue === 'auto' ? 'auto' : (Number(ch.automixBars.newValue) || 8);
      if ('automixVersion' in ch) version = ch.automixVersion.newValue === 2 ? 2 : 1;
      if ('automixKeyAware' in ch) keyAware = ch.automixKeyAware.newValue === true;
    });
  } catch { /* extension context gone */ }
  // barsSetting: a number is BitChord web's AutoDJ.transitionBars ("Up to N
  // bars"), which the scheduler treats as a maximum and shortens for weaker
  // grids; 'auto' picks the length per pair the way the BitChord phone does
  // (autoBars below).

  const live = { status: 'idle', bpm: null, conf: null, mix: null, updatedAt: 0 };
  const setStatus = (status, extra = {}) => Object.assign(live, { status, updatedAt: Date.now() }, extra);

  // ───────── analysis host frame ─────────
  let frame = null, frameReady = null, frameDead = false;
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (e) => {
    if (e.origin !== HOST_ORIGIN || !e.data || e.data.ch !== 'vivi-automix') return;
    const d = e.data;
    if (d.type === 'ready') { frameReady?.resolve(); return; }
    if (d.type === 'fatal') {
      log('analysis host failed:', d.message);
      frameDead = true;
      frameReady?.reject(new Error(d.message));
      for (const p of pending.values()) p.reject(new Error(d.message));
      pending.clear();
      return;
    }
    const p = pending.get(d.fileKey);
    if (!p) return;
    pending.delete(d.fileKey);
    if (d.type === 'result') p.resolve(d.result);
    else p.reject(new Error(d.message || 'analysis failed'));
  });

  function ensureFrame() {
    if (frameDead) return Promise.reject(new Error('analysis host unavailable'));
    if (frame && frame.isConnected) return frameReady.promise;
    frameReady = {};
    frameReady.promise = new Promise((resolve, reject) => { frameReady.resolve = resolve; frameReady.reject = reject; });
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/automix/host.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0';
    (document.body || document.documentElement).appendChild(frame);
    setTimeout(() => frameReady.reject(new Error('analysis host timed out')), 15000);
    return frameReady.promise;
  }

  // ───────── the downloaded songs (crossfade-page.js) ─────────
  const byteWaits = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== 'vivi-xfade' || d.dir !== 'out' || d.type !== 'bytes') return;
    const w = byteWaits.get(d.id);
    if (!w) return;
    byteWaits.delete(d.id);
    if (d.ok && d.bytes) w.resolve({ bytes: d.bytes, musicVideo: !!d.musicVideo });
    else w.reject(new Error(d.why || 'song not downloaded'));
  });
  function songBytes(id) {
    return new Promise((resolve, reject) => {
      byteWaits.get(id)?.reject(new Error('asked again'));
      byteWaits.set(id, { resolve, reject });
      window.postMessage({ ch: 'vivi-xfade', dir: 'in', type: 'bytes', id }, window.location.origin);
      setTimeout(() => { if (byteWaits.get(id)?.resolve === resolve) { byteWaits.delete(id); reject(new Error('download timed out')); } }, 120000);
    });
  }

  // ───────── analyzer (BitChord analysis/analyzer.ts) ─────────
  // Sequential queue: one decoded song in memory at a time.
  const results = new Map();
  const status = new Map();
  const failedAt = new Map();
  let queue = [];
  let running = false;

  function request(id, urgent = false) {
    if (!id || !enabled) return;
    const known = status.get(id);
    if (known === 'done' || known === 'analyzing') return;
    if (known === 'error' && Date.now() - (failedAt.get(id) ?? 0) < RETRY_FAILED_MS) return;
    if (known === 'pending') {
      if (urgent) {
        const at = queue.indexOf(id);
        if (at > 0) queue.unshift(...queue.splice(at, 1));
      }
      return;
    }
    status.set(id, 'pending');
    if (urgent) queue.unshift(id); else queue.push(id);
    void run();
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      const id = queue.shift();
      if (status.get(id) !== 'pending') continue;
      status.set(id, 'analyzing');
      const started = performance.now();
      try {
        const a = await analyzeOne(id);
        results.set(id, a);
        while (results.size > KEEP_RESULTS) {
          const old = results.keys().next().value;
          results.delete(old);
          status.delete(old);
        }
        status.set(id, 'done');
        log(`analysis of ${id}${a.cached ? ' (saved)' : ''}${a.musicVideo ? ' (music video)' : ''}: ${a.bpm?.toFixed(1) ?? '?'} BPM (end ${a.tailGrid?.bpm?.toFixed(1) ?? '?'}), ${a.keyName ?? '?'}, grid ${a.gridConfidence.toFixed(2)} / end ${a.tailGrid?.gridConfidence?.toFixed(2) ?? '-'}, intro ends ${a.introEndSec?.toFixed(1) ?? '-'} s, outro from ${a.outroStartSec?.toFixed(1) ?? '-'} s${a.contentEndSec != null ? `, music ends ${a.contentEndSec.toFixed(1)} s` : ''}, in${Math.round(performance.now() - started)} ms`);
      } catch (e) {
        log('analysis of', id, 'failed:', e?.message || e);
        failedAt.set(id, Date.now());
        status.set(id, 'error');
      }
    }
    running = false;
  }

  // A message to the analysis frame, answered by fileKey.
  function askHost(msg, transfer = [], timeoutMs = 180000) {
    const fileKey = msg.id + ':' + (++seq);
    return new Promise((resolve, reject) => {
      pending.set(fileKey, { resolve, reject });
      setTimeout(() => { if (pending.delete(fileKey)) reject(new Error('analysis timed out')); }, timeoutMs);
      frame.contentWindow.postMessage({ ch: 'vivi-automix', ...msg, fileKey }, HOST_ORIGIN, transfer);
    });
  }

  // BitChord's analyzeOne. The frame decodes and analyses (off this page's
  // main thread) and keeps the result; a song it has seen before answers at once.
  async function analyzeOne(id) {
    await ensureFrame();
    const cached = await askHost({ type: 'cached', id }, [], 15000).catch(() => null);
    if (cached) {
      cached.cached = true;
      // Advanced AutoDJ: a song saved before its music end was measured gets
      // it now (a decode, not a new analysis; saved with it). null: unmeasurable.
      if (version === 2 && cached.contentEndSec === undefined) {
        try {
          const { bytes } = await songBytes(id);
          cached.contentEndSec = (await askHost({ type: 'contentEnd', id, bytes }, [bytes], 30000))?.contentEndSec ?? null;
        } catch { /* not downloaded (yet): the song's length, as before */ }
      }
      return cached;
    }
    const { bytes, musicVideo } = await songBytes(id);
    const result = await askHost({ type: 'analyzeSong', id, bytes, musicVideo }, [bytes]);
    if (!result) throw new Error('analysis failed');
    return result;
  }

  // The decoded song for the loop mix (BitChord analyzer.audioBytes): its
  // bytes again from the page, which keeps the last few downloaded songs.
  const audioBytes = (id) => songBytes(id).then((r) => r.bytes);

  // ───────── grid (BitChord engine/grid.ts) ─────────
  const BEATS_PER_BAR = 4;
  const BEATS_PER_PHRASE = 32;   // 8 bars

  function gridOf(a) {
    if (!a || !a.bpm || !a.beatIntervalSec || a.firstDownbeatSec == null) return null;
    const beatSec = a.beatIntervalSec;
    return { beatSec, barSec: beatSec * BEATS_PER_BAR, phraseSec: beatSec * BEATS_PER_PHRASE, downbeatSec: a.firstDownbeatSec, bpm: a.bpm };
  }
  // The analysis as the outgoing side sees it: its grid fields swapped for the tail grid.
  function asOutgoing(a) {
    if (a.tailGrid === undefined) return a;
    const t = a.tailGrid;
    return t
      ? { ...a, bpm: t.bpm, beatIntervalSec: t.beatIntervalSec, firstDownbeatSec: t.firstDownbeatSec, gridConfidence: t.gridConfidence }
      : { ...a, beatIntervalSec: null, firstDownbeatSec: null, gridConfidence: 0 };
  }
  const phraseAtOrAfter = (g, t) => g.downbeatSec + Math.ceil((t - g.downbeatSec) / g.phraseSec) * g.phraseSec;
  const downbeatAtOrAfter = (g, t) => g.downbeatSec + Math.ceil((t - g.downbeatSec) / g.barSec) * g.barSec;
  const downbeatAtOrBefore = (g, t) => g.downbeatSec + Math.floor((t - g.downbeatSec) / g.barSec) * g.barSec;

  // Where the blend starts. BitChord web ends it where the outro begins,
  // rounded back to a whole phrase, which on a short song left a third of it
  // unplayed. Here, as on the BitChord phone (TransitionPlanner.kt: the exit
  // at the content end, pulled back onto a downbeat; never more than 12 s of
  // music skipped), it plays over the outro and ends on the downbeat a bar
  // before the song does.
  const naturalMixOut = (g, cur, dur) => downbeatAtOrBefore(g, cur.durationSec - g.barSec - dur);

  // ───────── Auto blend length (BitChord phone, TransitionPlanner.kt) ─────────
  // Advanced Automix's adaptiveOverlap/mixPlan: 16 beats, doubled when both
  // sides of the join are calm (under 0.7 of their song's mean energy); at most
  // 12 s (16 s calm; a filter ride 8 s) and 40% of the next song. The phone
  // rounds to whole bars; here the result is the largest of 32/16/8/4 bars that
  // fits, and never under 4.
  const AUTO_BAR_CHOICES = [32, 16, 8, 4];
  const AUTO_BEATS = 16;
  const AUTO_MAX_SEC = 12;
  const AUTO_CALM_MAX_SEC = 16;
  const AUTO_FILTER_MAX_SEC = 8;
  const CALM_ENERGY = 0.7;
  const ENERGY_WINDOW_BEATS = 8;
  const MAX_NEXT_SHARE = 0.4;

  // The song's energy over [from, to] as a share of its mean (null: no curve).
  function energyShare(a, from, to) {
    const c = a?.energyCurve;
    if (!c?.length || !(a.durationSec > 0) || !(a.energy > 0)) return null;
    const w = a.durationSec / c.length;
    const i0 = Math.max(0, Math.min(c.length - 1, Math.floor(from / w)));
    const i1 = Math.max(i0, Math.min(c.length - 1, Math.floor(Math.max(from, to - 1e-6) / w)));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += c[i];
    return sum / (i1 - i0 + 1) / a.energy;
  }

  function autoBars(cur, next, g, entrySec, filter) {
    const window = ENERGY_WINDOW_BEATS * g.beatSec;
    const exit = cur.durationSec - g.barSec;
    const out = energyShare(cur, exit - window, exit);
    const into = energyShare(next, entrySec, entrySec + window);
    const calm = out != null && into != null && out < CALM_ENERGY && into < CALM_ENERGY;
    const beats = AUTO_BEATS * (calm ? 2 : 1);
    const cap = Math.min(
      beats * g.beatSec,
      filter ? AUTO_FILTER_MAX_SEC : calm ? AUTO_CALM_MAX_SEC : AUTO_MAX_SEC,
      next.durationSec > 0 ? next.durationSec * MAX_NEXT_SHARE : Infinity,
    );
    return AUTO_BAR_CHOICES.find((b) => b * g.barSec <= cap + 1e-6) ?? AUTO_BAR_CHOICES[AUTO_BAR_CHOICES.length - 1];
  }
  // The bars asked for: the "Up to N bars" setting, or the Auto pick for this pair.
  const requestedBars = (cur, next, g, entrySec, filter) => (barsSetting === 'auto' ? autoBars(cur, next, g, entrySec, filter) : barsSetting);

  // ───────── transition planner (BitChord engine/transition-scheduler.ts) ─────────
  const MIN_GRID_CONFIDENCE = 0.2;
  const KILL_DB = -12;
  const SHORT_BLEND_KILL_DB = -6;
  const FULL_SWAP_MIN_BARS = 8;
  const MAX_SLOW_DOWN = 0.1;
  const MAX_SPEED_UP = 0.25;
  // BitChord's Advanced Automix (CrossfadeController.rampOutgoing): a song is
  // brought to a faster tempo one 0.75% step per beat.
  const TEMPO_STEP_PER_BEAT = 0.0075;
  const FILTER_MAX_BARS = 8;
  const FALLBACK_SEC = 12;

  function effectiveBlendBars(requested, fromConf, toConf) {
    const conf = Math.min(fromConf, toConf);
    if (conf >= 0.6) return requested;
    if (conf >= 0.45) return Math.min(requested, 8);
    return Math.min(requested, 4);
  }
  const stretchAllowed = (rate) => (rate >= 1 ? rate - 1 <= MAX_SPEED_UP : 1 - rate <= MAX_SLOW_DOWN);
  // Fold half/double time so the stretch stays near 1 (64 vs 128 BPM still beat-locks).
  const foldRate = (raw) => [raw, raw / 2, raw * 2].reduce((best, r) => (Math.abs(r - 1) < Math.abs(best - 1) ? r : best));

  // A song with no analysis: no grid, so the planner takes AutoMix's plain-crossfade fallback.
  const stub = (id, durationSec) => ({
    fileKey: id, durationSec, bpm: null, beatIntervalSec: null, firstDownbeatSec: null, gridConfidence: 0,
    energy: 0.5, energyCurve: [], introEndSec: null, outroStartSec: null, stub: true,
  });

  /**
   * The blend from the playing song into the next, in song seconds.
   *   from, to: analyses (null: not analysed yet; then both are stubs, as BitChord does)
   *   durationSec: the playing song's length as the player reports it
   *   pos: where it is now; earliest: the first song time the blend can start
   * Returns { style, mixOutTrackTime, durationSec, mixInTrackTime, rate, bars,
   *   swapDb, barSec, bpm, reason, fallback } (durationSec is output seconds;
   *   the outgoing song always plays at rate 1 here).
   */
  function plan({ fromId, toId, from, to, durationSec, pos, earliest }) {
    const both = !!(from && to);
    const cur = asOutgoing(both ? { ...from, durationSec } : stub(fromId, durationSec));
    const next = both ? to : stub(toId, 0);
    const fromGrid = gridOf(cur);
    const toGrid = gridOf(next);

    if (!fromGrid || cur.gridConfidence < MIN_GRID_CONFIDENCE) {
      return fallback(cur, next, earliest, both ? 'this song has no beat grid at its end' : 'songs not analysed in time');
    }
    if (!toGrid || next.gridConfidence < MIN_GRID_CONFIDENCE) return filterMix(cur, next, fromGrid, null, requestedBars(cur, next, fromGrid, 0, true), pos, earliest, 'next song has no beat grid');

    const ratio = foldRate(fromGrid.bpm / toGrid.bpm);
    if (!stretchAllowed(ratio)) return filterMix(cur, next, fromGrid, toGrid, requestedBars(cur, next, fromGrid, toGrid.downbeatSec, true), pos, earliest, `tempos ${Math.round(Math.abs(ratio - 1) * 100)}% apart`);
    // Tempo only ever moves up (BitChord's Advanced Automix): slowing a song
    // with its pitch kept repeats slivers of it, which smears piano and voices,
    // while speeding one up stays clean. The next song faster: the playing one
    // is brought up to its tempo over its last beats before the blend and the
    // next song plays at its own speed. The next song slower: it is sped up.
    const rate = ratio < 1 ? 1 : ratio;               // the next song's
    const outRate = ratio < 1 ? 1 / ratio : 1;        // the playing song's, from the blend on
    const rampBeats = outRate > 1.0001 ? Math.ceil((outRate - 1) / TEMPO_STEP_PER_BEAT) : 0;
    const rampSongSec = rampBeats * fromGrid.beatSec;  // song time the ramp covers, ending at the mix-out
    // AutoDJ's key-aware length (its own toggle): keys that clash get a short blend
    const keyClash = version === 2 && keyAware ? keysClash(cur, next) : null;
    const bars = keyClash ? keyClashBars(fromGrid) : requestedBars(cur, next, fromGrid, toGrid.downbeatSec, false);
    const effBars = effectiveBlendBars(bars, cur.gridConfidence, next.gridConfidence);
    const outSpan = effBars * fromGrid.barSec;        // the playing song's seconds the blend covers
    const dur = outSpan / outRate;                    // output seconds

    // outgoing mix-out point (naturalMixOut: at the song's end); the ramp before it has to fit too
    const first = earliest + rampSongSec;
    const v2 = version === 2;
    let mixOut = naturalMixOut(fromGrid, v2 ? musicEnd(cur) : cur, outSpan);
    if (mixOut < pos + rampSongSec) mixOut = phraseAtOrAfter(fromGrid, first);   // too late for the natural point: the next phrase
    if (mixOut < first) mixOut = downbeatAtOrAfter(fromGrid, first);
    if (mixOut + outSpan > cur.durationSec - 0.3) return filterMix(cur, next, fromGrid, toGrid, bars, pos, earliest, 'too close to the end for a blend');

    // incoming mix-in point: so that its pre-full-energy phrase lands at the blend's end
    const introEnd = next.introEndSec ?? 0;
    const fullEnergyPhrase = phraseAtOrAfter(toGrid, Math.max(introEnd, toGrid.downbeatSec));
    let mixIn = fullEnergyPhrase - dur * rate;
    if (mixIn < toGrid.downbeatSec) mixIn = toGrid.downbeatSec;

    // AutoDJ (version 2): no further than a quarter into the next song, and
    // a blend point where the two songs don't sing over each other.
    let dj = null;
    if (v2) {
      mixIn = capIncomingSkip(next, toGrid, mixIn);
      dj = rerouteForVocals(cur, next, fromGrid, toGrid, mixOut, mixIn, outSpan, rate / outRate, Math.max(first, pos + rampSongSec));
      mixOut = dj.mixOut;
      mixIn = dj.mixIn;
    }

    return {
      style: 'blend', fallback: false, reason: null,
      v2, clash: dj?.clash ?? 0, rerouted: dj?.rerouted ?? null, vocalsBy: dj?.by ?? null, keyClash,
      mixOutTrackTime: mixOut, durationSec: dur, mixInTrackTime: mixIn, rate,
      outRate, rampBeats, rampSongSec, beatSec: fromGrid.beatSec,
      bars: effBars, swapDb: effBars >= FULL_SWAP_MIN_BARS ? KILL_DB : SHORT_BLEND_KILL_DB,
      barSec: fromGrid.barSec / outRate, bpm: fromGrid.bpm * outRate, outBpm: fromGrid.bpm, inBpm: toGrid.bpm,
    };
  }

  // The phone's DJ_FILTER: incoming on its own downbeat at its own tempo,
  // low-passed; outgoing drains through a rising high-pass; bass swaps in one bar.
  function filterMix(cur, next, fromGrid, toGrid, requested, pos, earliest, reason) {
    let bars = Math.min(requested, FILTER_MAX_BARS);
    let dur = bars * fromGrid.barSec;
    const v2 = version === 2;
    let mixOut = naturalMixOut(fromGrid, v2 ? musicEnd(cur) : cur, dur);
    if (mixOut < pos) mixOut = phraseAtOrAfter(fromGrid, earliest);
    if (mixOut < earliest) mixOut = downbeatAtOrAfter(fromGrid, earliest);
    // never past the outgoing song's end: shorten to the bars that still fit
    const room = cur.durationSec - 0.3 - mixOut;
    if (dur > room) {
      bars = Math.max(1, Math.floor(room / fromGrid.barSec));
      dur = bars * fromGrid.barSec;
    }
    if (room < fromGrid.barSec) return fallback(cur, next, earliest, reason);
    const mixIn = toGrid ? toGrid.downbeatSec : Math.min(next.introEndSec ?? 0, 1);
    // AutoDJ: how much the two sing at once, for the filter shapes (no re-route: a filter mix has no tempo match to keep)
    const clash = v2 ? vocalOverlap(cur, next, mixOut, dur, mixIn, 1, { out: lyricSpans(cur), in: lyricSpans(next) }) ?? 0 : 0;
    return {
      style: 'filter', fallback: false, reason, v2, clash, rerouted: null,
      mixOutTrackTime: mixOut, durationSec: dur, mixInTrackTime: mixIn, rate: 1,
      bars, swapDb: KILL_DB, barSec: fromGrid.barSec, bpm: fromGrid.bpm, inBpm: toGrid?.bpm ?? null,
    };
  }

  // ───────── AutoDJ (Automix version 2): BitChord phone ideas ─────────
  // From the BitChord phone's TransitionPlanner / TransitionPolicy: the
  // vocal mask decides whether a blend has both songs singing at once, and
  // a blend that does is moved to a cleaner point when one exists.
  const VOCAL_SUNG = 0.25;          // POL VOCAL_ACTIVE_THRESHOLD
  const REROUTE_OVERLAP = 0.3;      // TP VOCAL_REROUTE_OVERLAP
  const REROUTE_GAIN = 0.5;         // an alternative must halve the overlap
  const MAX_DISCARD_SEC = 12;       // POL MAX_DISCARDED_MUSIC_SECONDS
  const MAX_IN_SKIP = 0.25;         // TP MAX_INCOMING_SKIP_FRACTION
  const ENTRY_SHIFTS = [0, -4, 4, -8, 8];   // bars the incoming cue may move

  // Key-aware blend length (toggle automixKeyAware, version 2 only). The
  // BitChord phone shortens a blend whose keys clash (TP adaptiveOverlap:
  // 8 beats instead of 16). Compatible here is harmonic mixing on the
  // Camelot wheel: the same number, or one step round it on the same
  // letter. A key the analysis is unsure of doesn't count.
  const KEY_MIN_CONFIDENCE = 0.5;
  function keysClash(a, b) {
    const x = a.camelot, y = b.camelot;
    if (!x || !y || !(a.keyConfidence >= KEY_MIN_CONFIDENCE) || !(b.keyConfidence >= KEY_MIN_CONFIDENCE)) return null;
    const step = (x.num - y.num + 12) % 12;
    const ok = x.num === y.num || (x.letter === y.letter && (step === 1 || step === 11));
    return ok ? null : `${a.keyName ?? x.num + x.letter} → ${b.keyName ?? y.num + y.letter}`;
  }
  // 2 bars, unless that is under 4 s (6 s from 140 BPM): then 4.
  const keyClashBars = (g) => (2 * g.barSec >= (g.bpm >= 140 ? 6 : 4) ? 2 : 4);

  // The song with its length cut to where its music ends (analysis
  // contentEndSec), when there's real silence after it; never over 20 s cut.
  function musicEnd(a) {
    const end = a.contentEndSec;
    if (!(end > 0) || end >= a.durationSec - 1) return a;
    return { ...a, durationSec: Math.max(end, a.durationSec - 20) };
  }

  // TP capIncomingSkip: the cue pulled back by whole bars to within a quarter of the song.
  function capIncomingSkip(next, toGrid, mixIn) {
    const cap = next.durationSec > 0 ? next.durationSec * MAX_IN_SKIP : Infinity;
    if (mixIn <= cap) return mixIn;
    return Math.max(toGrid.downbeatSec, mixIn - Math.ceil((mixIn - cap) / toGrid.barSec) * toGrid.barSec);
  }

  // Where a song is sung, from its synced lyrics (the lyrics panel's lookup,
  // as the loop mix uses): asked for once per song, answered on a later
  // plan (the plan is redone every tick until the outro is asked for);
  // until then, and for songs without synced lyrics, the vocal mask. Not
  // for a music video: its audio rarely runs on the song's lyric times.
  const sungCache = new Map();   // id -> { spans: array | null | 'pending', at, tries }
  const SUNG_RETRY_MS = 60000;   // no lyrics found: asked once more after this long (a slow lookup), then never
  function lyricSpans(a) {
    if (!a || a.stub || a.musicVideo || !a.fileKey) return null;
    const id = a.fileKey;
    const known = sungCache.get(id);
    if (!known || (known.spans === null && known.tries < 2 && Date.now() - known.at > SUNG_RETRY_MS)) {
      const me = { spans: 'pending', at: Date.now(), tries: (known?.tries ?? 0) + 1 };
      sungCache.set(id, me);
      sharedSungSpans(id).then((s) => { me.spans = s ?? null; me.at = Date.now(); }, () => { me.spans = null; me.at = Date.now(); });
      while (sungCache.size > 24) sungCache.delete(sungCache.keys().next().value);
    }
    const s = sungCache.get(id).spans;
    return Array.isArray(s) ? s : null;
  }
  // One lookup per song at a time: songMeta answers a second ask for the same
  // song by giving the first one nothing, so the loop mix's lookup and this
  // one, made at the same moment, share a single answer.
  const sungInflight = new Map();
  function sharedSungSpans(id) {
    let p = sungInflight.get(id);
    if (!p) {
      p = sungSpans(id).finally(() => sungInflight.delete(id));
      sungInflight.set(id, p);
    }
    return p;
  }

  // Sung or not at song second t: 1/0 from lyric lines when the song has
  // them, else the vocal mask (open-unmix, 0..1 per ~23 ms frame); null
  // where neither knows.
  function vocalAt(a, t, spans = null) {
    if (spans) return spans.some(([x, y]) => t >= x && t < y) ? 1 : 0;
    for (const w of a.vocals ?? []) {
      const i = Math.round((t - w.startSec) * w.fps);
      if (i >= 0 && i < w.curve.length) return w.curve[i];
    }
    return null;
  }

  // POL simultaneousVocalFraction: the share of the blend where both songs
  // sing. [inPerOut]: incoming song seconds per outgoing song second. null
  // when the masks cover under half of it.
  function vocalOverlap(cur, next, mixOut, outSpan, mixIn, inPerOut, sung = {}) {
    let both = 0, n = 0, steps = 0;
    for (let t = mixOut; t < mixOut + outSpan; t += 0.05) {
      steps++;
      const a = vocalAt(cur, t, sung.out), b = vocalAt(next, mixIn + (t - mixOut) * inPerOut, sung.in);
      if (a == null || b == null) continue;
      n++;
      if (a >= VOCAL_SUNG && b >= VOCAL_SUNG) both++;
    }
    return steps && n >= steps * 0.5 ? both / n : null;
  }

  // TP's vocal re-route: over 30% sung by both, the exit is tried up to
  // 12 s of music earlier (whole bars) and the cue up to 8 bars either way;
  // the cleanest is taken if it halves the overlap. Otherwise the blend
  // stays and its shapes keep the voices apart (clash, in crossfade.js).
  // The plan is redone every tick, so the overlaps are measured once per
  // blend (same songs, points, length and vocal sources) and kept; only the
  // filter for candidates the playhead has passed runs each time.
  let rerouteMemo = null;
  function rerouteForVocals(cur, next, fromGrid, toGrid, mixOut, mixIn, outSpan, inPerOut, earliestOut) {
    const sung = { out: lyricSpans(cur), in: lyricSpans(next) };
    const by = `${sung.out ? 'lyrics' : 'mask'}/${sung.in ? 'lyrics' : 'mask'}`;
    const key = [cur.fileKey, next.fileKey, mixOut, mixIn, outSpan, inPerOut, fromGrid.barSec, toGrid.barSec, by].map(String).join('|');
    if (rerouteMemo?.key !== key) {
      const first = vocalOverlap(cur, next, mixOut, outSpan, mixIn, inPerOut, sung);
      const cands = [];
      if (first != null && first > REROUTE_OVERLAP) {
        const inCap = next.durationSec > 0 ? next.durationSec * MAX_IN_SKIP : Infinity;
        for (let k = 0; k * fromGrid.barSec <= MAX_DISCARD_SEC; k++) {
          for (const j of ENTRY_SHIFTS) {
            if (!k && !j) continue;
            const mi = mixIn + j * toGrid.barSec;
            if (mi < toGrid.downbeatSec - 1e-6 || mi > inCap) continue;
            const mo = mixOut - k * fromGrid.barSec;
            const o = vocalOverlap(cur, next, mo, outSpan, mi, inPerOut, sung);
            if (o != null) cands.push({ o, cost: k + Math.abs(j) / 2, mo, mi, k, j });
          }
        }
      }
      rerouteMemo = { key, primary: first, cands };
    }
    const { primary, cands } = rerouteMemo;
    const keep = { mixOut, mixIn, clash: primary ?? 0, rerouted: null, by };
    if (primary == null || primary <= REROUTE_OVERLAP) return keep;
    let best = null;
    for (const c of cands) {
      if (c.mo < earliestOut) continue;   // the playhead is past where its ramp would start
      if (!best || c.o < best.o - 1e-9 || (Math.abs(c.o - best.o) < 1e-9 && c.cost < best.cost)) best = c;
    }
    const pct = (x) => Math.round(x * 100) + '%';
    if (!best || best.o > primary * REROUTE_GAIN) return { ...keep, rerouted: `both sing ${pct(primary)} of it, no cleaner point` };
    return {
      mixOut: best.mo, mixIn: best.mi, clash: best.o, by,
      rerouted: `both sang ${pct(primary)} of it, moved to ${pct(best.o)} (exit ${best.k} bars earlier, cue ${best.j >= 0 ? '+' : ''}${best.j} bars)`,
    };
  }

  // AutoMix's fallback: a plain 12 s equal-power fade, no beatmatch, no EQ.
  // BitChord web put it on the last 12 s before the outro; here, like the
  // blend, it ends with the song.
  function fallback(cur, next, earliest, reason) {
    const target = cur.durationSec - 0.3 - FALLBACK_SEC;
    const mixOut = Math.max(earliest, target);
    const dur = Math.max(0, Math.min(FALLBACK_SEC, cur.durationSec - 0.3 - mixOut));
    return {
      style: 'crossfade', fallback: true, reason,
      mixOutTrackTime: mixOut, durationSec: dur, mixInTrackTime: next.introEndSec ?? 0, rate: 1,
      bars: 0, swapDb: 0, barSec: 0, bpm: null, inBpm: null,
    };
  }

  // ───────── the loop mix (BitChord engine/loopMix.ts) ─────────
  // The outgoing song hands over to a stretch deck at the start of an
  // instrumental loop near its end and loops it. The incoming song comes in
  // on its own instrumental loop, bass cut, at the outgoing tempo. One master
  // tempo then ramps from the outgoing song's BPM to the incoming one's, both
  // decks following it beat by beat. The bass swaps, the outgoing loop drains
  // through a rising high-pass, the incoming loop lets go into the rest of
  // its song at its own tempo, and its player takes over two bars later.
  // Where a song is sung comes from its synced lyrics (the lyrics panel's
  // own lookup), as in BitChord; the vocal mask is the fallback for a song
  // without them.
  const LOOP_BARS = 4;
  const LOOP_LENGTHS = [4, 2, 1];
  const ENTER_BARS = 4;
  const SETTLE_BARS = 2;
  const MAX_BPM_PER_BAR = 2.5;
  const MIN_RAMP_BARS = 2;
  const MAX_RAMP_BARS = 24;
  const VOCAL_ACTIVE = 0.25;
  const MAX_SUNG_SHARE = 0.03;
  const MAX_SUNG_RUN_SEC = 0.2;
  // Clear time before a loop: from lyrics (which time each line's end) a short
  // guard; from the mask, a whole beat. A synced line is padded at its start
  // (the breath before it) and its end (the voice's tail and reverb).
  const LYRIC_GUARD_SEC = 0.3;
  const LYRIC_LEAD_SEC = 0.15;
  const LYRIC_TAIL_SEC = 0.35;
  const LYRICS_WAIT_MS = 8000;
  const MIN_LOUDNESS = 0.6;
  const OUT_SEARCH_SEC = 60;
  const IN_SEARCH_SEC = 45;
  const OUT_REGION_SEC = OUT_SEARCH_SEC + 5;
  const IN_REGION_SEC = IN_SEARCH_SEC + 40;

  const LOOP_SETUP_SEC = 15;                      // the outgoing loop starts at least this far ahead of the playhead
  const HANDOVER_SEC = 0.025;                     // identical audio crossed this quickly is heard as one
  const BASS_CUT_DB = -18;

  /**
   * The bars to loop on each side; null when there is no usable grid or a
   * music video, and { none: why } when a side has no instrumental bars (a
   * sung word is never looped). [out] is the outgoing song as asOutgoing() gives it;
   * [sung] is each song's sung spans from its synced lyrics, when it has them.
   */
  function planLoopMix(out, outBuffer, inn, inBuffer, earliestOutSec, sung = {}) {
    if (!out.beatIntervalSec || out.firstDownbeatSec == null || !out.bpm) return null;
    if (!inn.beatIntervalSec || inn.firstDownbeatSec == null || !inn.bpm) return null;
    // A music video's audio rarely matches the song's: nothing vouches for its bars.
    if (out.musicVideo || inn.musicVideo) return null;
    const outBar = out.beatIntervalSec * 4;
    const inBar = inn.beatIntervalSec * 4;

    // outgoing: the latest instrumental loop that ends before the song does
    const outEnd = Math.min(out.durationSec - 0.5, outBuffer.duration - 0.1);
    const outFirst = Math.max(earliestOutSec, out.durationSec - OUT_SEARCH_SEC);
    const outPick = firstClean((bars) => loopsBetween(out.tailBeats, out.firstDownbeatSec, outBar, outFirst, outEnd, bars).reverse(), outBuffer, out.vocals ?? [], sung.out ?? null, out.beatIntervalSec);
    if (!outPick) return { none: 'no instrumental bars near the end of the playing song' };
    // incoming: the earliest instrumental loop in its opening
    const inEnd = Math.min(IN_SEARCH_SEC + LOOP_BARS * inBar, inBuffer.duration - 20);
    const inPick = firstClean((bars) => loopsBetween(inn.headBeats, inn.firstDownbeatSec, inBar, 0, inEnd, bars), inBuffer, inn.vocals ?? [], sung.in ?? null, inn.beatIntervalSec);
    if (!inPick) return { none: 'no instrumental bars in the opening of the next song' };
    // a loop's own length is its tempo: its beats exactly, bar line to bar line
    const outBeat = (outPick.end - outPick.start) / (outPick.bars * 4);
    const inBeat = (inPick.end - inPick.start) / (inPick.bars * 4);
    const outBpm = 60 / outBeat;
    const inBpm = 60 / inBeat;
    const fold = [1, 2, 0.5].reduce((best, f) => (Math.abs(Math.log(inBpm / f / outBpm)) < Math.abs(Math.log(inBpm / best / outBpm)) ? f : best));
    const target = inBpm / fold;
    const rampBars = Math.min(MAX_RAMP_BARS, Math.max(MIN_RAMP_BARS, Math.ceil(Math.abs(target - outBpm) / MAX_BPM_PER_BAR)));
    // the incoming loop lets go only at its own loop boundary: whole incoming loops
    const inLoopOutBars = inPick.bars / fold;
    const totalBars = Math.ceil((ENTER_BARS + rampBars + 2) / inLoopOutBars) * inLoopOutBars;
    const pick = (key, p, beatSec, bpm) => ({ key, loop: [p.start, p.end], bars: p.bars, beatSec, bpm, vocal: p.vocal, checkedBy: p.checkedBy });
    return {
      out: pick(out.fileKey, outPick, outBeat, outBpm),
      in: pick(inn.fileKey, inPick, inBeat, inBpm),
      fold, enterBars: ENTER_BARS, rampBars, exitBars: totalBars - ENTER_BARS - rampBars, totalBars,
    };
  }

  // [bars]-bar loops in [from, to]: on the model's own downbeats where it has
  // them (the seam is the music's bar line), else AutoMix's constant grid.
  function loopsBetween(side, anchor, bar, from, to, bars) {
    const loops = [];
    if (side && side.downbeats.length >= bars + 1) {
      const beat = 60 / side.bpm;
      const downs = side.downbeats;
      for (const start of downs) {
        if (start < from) continue;
        const target = start + bars * 4 * beat;
        const end = downs.reduce((best, d) => (Math.abs(d - target) < Math.abs(best - target) ? d : best), downs[0]);
        if (Math.abs(end - target) > beat / 4 || end > to) continue;   // a missed or doubled downbeat in between
        loops.push({ start, end });
      }
      if (loops.length) return loops;
    }
    if (to < from) return loops;
    const len = bars * bar;
    for (let t = anchor + Math.ceil((from - anchor) / bar) * bar; t + len <= to; t += bar) loops.push({ start: t, end: t + len });
    return loops;
  }

  // The first loop (in the order given) that grooves and is instrumental:
  // with synced lyrics, no sung line overlaps it or the guard before it;
  // without them, the vocal mask covers it and finds almost nothing sung in
  // it or the beat before it.
  function firstClean(candidates, buffer, vocals, sung, beatSec) {
    for (const bars of LOOP_LENGTHS) {
      const loops = candidates(bars);
      if (!loops.length) continue;
      // loudness of the quietest bar against the stretch's own: no fade-out tail, no breakdown
      const barLoud = (l) => Math.min(...Array.from({ length: bars }, (_, b) => rms(buffer, l.start + (b * (l.end - l.start)) / bars, l.start + ((b + 1) * (l.end - l.start)) / bars)));
      const louds = loops.map(barLoud);
      const typical = [...louds].sort((a, b) => a - b)[Math.floor(louds.length * 0.6)] ?? 0;
      for (let i = 0; i < loops.length; i++) {
        const l = loops[i];
        if (louds[i] < typical * MIN_LOUDNESS || louds[i] <= 0.01) continue;
        if (sung) {
          const from = l.start - LYRIC_GUARD_SEC;
          if (sung.some(([a, b]) => a < l.end && b > from)) continue;
          return { ...l, bars, vocal: 0, checkedBy: 'lyrics' };
        }
        const m = maskStats(vocals, l.start - beatSec, l.end);
        if (!m || m.share > MAX_SUNG_SHARE || m.longestRunSec > MAX_SUNG_RUN_SEC) continue;
        return { ...l, bars, vocal: m.share, checkedBy: 'mask' };
      }
    }
    return null;
  }

  // How much of [from, to) the vocal mask calls sung, and its longest sung run; null when it covers under 80%.
  function maskStats(windows, from, to) {
    let sung = 0, n = 0, covered = 0, run = 0, longest = 0, fps = 1;
    for (const w of windows) {
      const a = Math.max(0, Math.ceil((from - w.startSec) * w.fps));
      const b = Math.min(w.curve.length, Math.floor((to - w.startSec) * w.fps));
      for (let i = a; i < b; i++) {
        n++;
        if (w.curve[i] > VOCAL_ACTIVE) { sung++; run++; longest = Math.max(longest, run); } else run = 0;
      }
      if (b > a) { covered += (b - a) / w.fps; fps = w.fps; }
    }
    return n && covered >= (to - from) * 0.8 ? { share: sung / n, longestRunSec: longest / fps } : null;
  }

  // BitChord sungSpansFromLines: each sung line, padded; a line with no known
  // end (plain line sync times only its start) lasts to the next, 10 s at most.
  function sungSpansFromLines(lines) {
    const spans = [];
    const sorted = [...lines].filter((l) => Number.isFinite(l?.start)).sort((a, b) => a.start - b.start);
    sorted.forEach((l, i) => {
      const words = Array.isArray(l.words) ? l.words.filter((w) => Number.isFinite(w?.end)) : [];
      if (!String(l.text ?? '').trim() && !words.length) return;   // a gap line
      const start = l.start / 1000;
      const next = sorted.slice(i + 1).find((n) => n.start > l.start)?.start;
      const end = words.length
        ? Math.max(...words.map((w) => w.end)) / 1000
        : Math.min(start + 10, (Number.isFinite(l.end) && l.end > l.start ? l.end : next ?? l.start + 10000) / 1000);
      spans.push([start - LYRIC_LEAD_SEC, Math.max(end, start) + LYRIC_TAIL_SEC]);
    });
    return spans;
  }

  // Song details from YouTube Music's queue (crossfade-page.js), for the lyrics lookup.
  const metaWaits = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== 'vivi-xfade' || d.dir !== 'out' || d.type !== 'meta') return;
    const w = metaWaits.get(d.id);
    if (!w) return;
    metaWaits.delete(d.id);
    w(d.meta || null);
  });
  function songMeta(id) {
    return new Promise((resolve) => {
      metaWaits.get(id)?.(null);
      metaWaits.set(id, resolve);
      window.postMessage({ ch: 'vivi-xfade', dir: 'in', type: 'meta', id }, window.location.origin);
      setTimeout(() => { if (metaWaits.get(id) === resolve) { metaWaits.delete(id); resolve(null); } }, 3000);
    });
  }

  // BitChord state/player.ts sungSpans: where [id] is sung, from its synced
  // lyrics (the lyrics panel's lookup and cache); null when it has none, or
  // they don't come in time: the loop mix then goes by the vocal mask.
  async function sungSpans(id) {
    try {
      const L = window.__viviLyrics;
      if (!L?.fetchBestLyrics) return null;
      const meta = await songMeta(id);
      if (!meta?.song) return null;
      const track = { song: meta.song, artist: meta.artist || '', album: meta.album || '', duration: meta.duration || null, videoId: id };
      // the providers the listener turned away from for this song stay out, as in the lyrics panel
      const excludeKeys = await window.__viviLyricsUI?.loadExcludedProviders?.(track).catch?.(() => []) ?? [];
      const found = await Promise.race([
        L.fetchBestLyrics(track, { excludeKeys }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), LYRICS_WAIT_MS)),
      ]);
      if (!found || found.mode === 'plain' || !Array.isArray(found.lines) || !found.lines.length) return null;
      const spans = sungSpansFromLines(found.lines);
      return spans.length ? spans : null;
    } catch { return null; }
  }

  function rms(buffer, from, to) {
    const data = buffer.getChannelData(0);
    const a = Math.max(0, Math.floor(from * buffer.sampleRate));
    const b = Math.min(data.length, Math.floor(to * buffer.sampleRate));
    let ss = 0, n = 0;
    for (let i = a; i < b; i += 16) { ss += data[i] * data[i]; n++; }
    return n ? Math.sqrt(ss / n) : 0;
  }

  /**
   * The whole mix on one beat clock from [t0] (the audio time the outgoing
   * song reaches its loop start): every deck change, and the times the
   * player needs (scheduleLoopMix, without the decks: crossfade.js posts them).
   */
  function loopSchedule(plan, t0) {
    const { out, in: inn, fold } = plan;
    const beats = plan.totalBars * 4;
    const settleBeats = Math.round((SETTLE_BARS * 4) / fold);
    const rampFrom = plan.enterBars * 4;
    const rampTo = (plan.enterBars + plan.rampBars) * 4;
    const target = inn.bpm / fold;
    const tempo = (k) => (k < rampFrom ? out.bpm : k >= rampTo ? target : out.bpm + ((target - out.bpm) * (k - rampFrom + 0.5)) / (rampTo - rampFrom));
    const beatTimes = [t0];
    for (let k = 0; k < beats + settleBeats; k++) beatTimes.push(beatTimes[k] + 60 / tempo(k));
    const outLoopBeats = out.bars * 4;
    const inLoopBeats = inn.bars * 4;
    const inPerBeat = fold * inn.beatSec;   // incoming track seconds per outgoing beat
    const outChanges = [], inChanges = [];
    for (let k = 0; k < beats; k++) {
      const t = beatTimes[k], T = tempo(k);
      outChanges.push({ output: t, input: out.loop[0] + (k % outLoopBeats) * out.beatSec, rate: (T * out.beatSec) / 60, active: true, loop: out.loop });
      inChanges.push({ output: t, input: inn.loop[0] + ((k * fold) % inLoopBeats) * inn.beatSec, rate: (T * inPerBeat) / 60, active: true, loop: inn.loop });
    }
    const releaseAt = beatTimes[beats];
    outChanges.push({ output: releaseAt + 0.05, input: out.loop[0], rate: 1, active: false, loop: null });
    inChanges.push({ output: releaseAt, input: inn.loop[1], rate: 1, active: true, loop: null });
    const elementAt = beatTimes[beats + settleBeats];
    const elementTrackTime = inn.loop[1] + (elementAt - releaseAt);
    inChanges.push({ output: elementAt + 0.1, input: elementTrackTime + 0.1, rate: 1, active: false, loop: null });
    const midBeat = Math.round((rampFrom + rampTo) / 2);
    return {
      t0, beatTimes, outChanges, inChanges, releaseAt, elementAt, elementTrackTime,
      enterEnd: beatTimes[rampFrom], rampEnd: beatTimes[rampTo],
      mid: beatTimes[midBeat], bar: 4 * (60 / tempo(midBeat)),
      handoffAt: beatTimes[midBeat],
      HANDOVER_SEC, BASS_CUT_DB,
    };
  }

  // The model loads on the first analysis (~1-15 s); run a throwaway one
  // early so the first real song only does its own work.
  let warm = null;
  function warmup() {
    if (warm || !enabled || frameDead) return;
    warm = (async () => {
      const t0 = performance.now();
      await ensureFrame();
      const samples = new Float32Array(ANALYSIS_SR * 4);
      for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() - 0.5) * 1e-3;
      const fileKey = 'warmup:' + (++seq);
      await new Promise((resolve) => {
        pending.set(fileKey, { resolve, reject: resolve });
        setTimeout(() => { if (pending.delete(fileKey)) resolve(); }, 60000);
        frame.contentWindow.postMessage({ ch: 'vivi-automix', type: 'analyze', fileKey, samples, sampleRate: ANALYSIS_SR, offsetSec: 0 }, HOST_ORIGIN, [samples.buffer]);
      });
      log('analysis model loaded in', Math.round(performance.now() - t0), 'ms');
    })().catch((e) => { warm = null; log('warm-up failed:', e?.message || e); });
  }

  window.__viviAutomix = {
    isEnabled: () => enabled,
    getBars: () => barsSetting,
    getVersion: () => version,
    request,
    get: (id) => results.get(id) ?? null,
    statusOf: (id) => status.get(id) ?? null,
    plan,
    asOutgoing,
    gridOk: (a) => !!gridOf(a) && a.gridConfidence >= MIN_GRID_CONFIDENCE,
    audioBytes,
    planLoopMix,
    sungSpans: sharedSungSpans,
    loopSchedule,
    LOOP: { OUT_REGION_SEC, IN_REGION_SEC, LOOP_SETUP_SEC },
    warmup,
    setStatus,
    getLiveState: () => ({ ...live }),
  };
})();

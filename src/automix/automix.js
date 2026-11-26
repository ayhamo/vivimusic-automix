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
  // 1: the web original; 2: AutoDJ, the original plus BitChord phone ideas;
  // 3: Automix v2 (Phase 3), AutoDJ plus Orchard's rules, added one at a time.
  // Everything AutoDJ adds checks `adv()` (2 and 3), what v2 adds `version === 3`,
  // so 1 and 2 stay as they were. spec/automix/versions.md lists the parts.
  // The choice is Classic (2) or Automix v2 (3). Original (1) is retired: a saved 1
  // plays Classic (its loop is the same code; Classic keeps its fixes, PLAN.md
  // Phase 3). Its code paths stay until the code audit.
  let version = 2;
  const adv = () => version >= 2;
  const asVersion = (v) => (v === 3 ? 3 : 2);
  let keyAware = false;   // version 2's key-aware blend length, off unless switched on
  try {
    chrome.storage.local.get({ automixEnabled: true, automixBars: 'auto', automixVersion: 2, automixKeyAware: false }, (s) => {
      enabled = s.automixEnabled !== false;
      barsSetting = s.automixBars === 'auto' ? 'auto' : (Number(s.automixBars) || 8);
      version = asVersion(s.automixVersion);
      keyAware = s.automixKeyAware === true;
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if ('automixEnabled' in ch) enabled = ch.automixEnabled.newValue !== false;
      if ('automixBars' in ch) barsSetting = ch.automixBars.newValue === 'auto' ? 'auto' : (Number(ch.automixBars.newValue) || 8);
      if ('automixVersion' in ch) version = asVersion(ch.automixVersion.newValue);
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
    if (d.type === 'progress') { const id = String(d.fileKey || '').split(':')[0]; if (status.get(id) === 'analyzing') stageOf(id, d.stage); return; }
    const p = pending.get(d.fileKey);
    if (!p) return;
    pending.delete(d.fileKey);
    if (d.type === 'result') p.resolve(d.result);
    else p.reject(new Error(d.message || 'analysis failed'));
  });

  function ensureFrame() {
    if (frameDead) return Promise.reject(new Error('analysis host unavailable'));
    if (frame && frame.isConnected) return frameReady.promise;
    const ready = frameReady = { done: false };
    ready.promise = new Promise((resolve, reject) => {
      ready.resolve = (v) => { ready.done = true; resolve(v); };
      ready.reject = (e) => { ready.done = true; reject(e); };
    });
    const f = frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/automix/host.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0';
    (document.body || document.documentElement).appendChild(frame);
    // a host that never said ready is removed, so the next request builds a new one
    setTimeout(() => {
      if (ready.done) return;
      if (frame === f) { f.remove(); frame = null; }
      ready.reject(new Error('analysis host timed out'));
    }, 15000);
    return ready.promise;
  }

  // ───────── the downloaded songs (crossfade-page.js) ─────────
  const byteWaits = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== 'vivi-xfade' || d.dir !== 'out' || d.type !== 'bytes') return;
    const ws = byteWaits.get(d.id);
    if (!ws) return;
    byteWaits.delete(d.id);
    // each asker gets its own copy: the analysis hands its bytes on to the analyzer frame
    ws.forEach((w, i) => {
      if (d.ok && d.bytes) w.resolve({ bytes: i === 0 ? d.bytes : d.bytes.slice(0), musicVideo: !!d.musicVideo });
      else w.reject(new Error(d.why || 'song not downloaded'));
    });
  });
  function songBytes(id) {
    return new Promise((resolve, reject) => {
      // one ask per song at a time; a second asker (the addon deck, the analysis) waits for the same download
      const ws = byteWaits.get(id), w = { resolve, reject };
      if (ws) { ws.push(w); return; }
      byteWaits.set(id, [w]);
      window.postMessage({ ch: 'vivi-xfade', dir: 'in', type: 'bytes', id }, window.location.origin);
      setTimeout(() => {
        const left = byteWaits.get(id);
        if (left?.[0] === w) { byteWaits.delete(id); left.forEach((x) => x.reject(new Error('download timed out'))); }
      }, 120000);
    });
  }

  // ───────── analyzer (BitChord analysis/analyzer.ts) ─────────
  // Sequential queue: one decoded song in memory at a time.
  const results = new Map();
  const status = new Map();
  const failedAt = new Map();
  // editor.md §11 (the progress row): each analysing song's stage and its fixed % at the stage's start
  // (nothing is counted inside a stage), and a failure's reason, kept until the song is asked again
  const STAGES = { waiting: ['waiting its turn', 0], audio: ['getting the audio', 0], decoding: ['decoding', 5], lowEnd: ['measuring the low end and keys', 15], models: ['finding the beats, the key and the vocals', 25], saving: ['saving', 95] };
  const stage = new Map(), failedWhy = new Map();
  const stageOf = (id, k) => { if (STAGES[k]) stage.set(id, k); };
  function progressOf(id) {
    const s = status.get(id) ?? null;
    if (s === 'pending') return { status: s, stage: STAGES.waiting[0], pct: 0 };
    if (s === 'analyzing') { const k = stage.get(id) || 'audio'; return { status: s, stage: STAGES[k][0], pct: STAGES[k][1] }; }
    if (s === 'error') return { status: s, why: failedWhy.get(id) || 'unknown' };
    return { status: s };
  }
  let queue = [];
  let running = false;

  // Songs over 8 minutes aren't analysed (Laya 1a1f324b; versions.md "Analysis length"): "too long",
  // a status of its own (not a failure, never retried); they mix as songs without an analysis do.
  const ANALYSIS_MAX_SEC = 480;
  function request(id, urgent = false, durationSec = null) {
    if (!id || !enabled) return;
    const known = status.get(id);
    if (known === 'done' || known === 'analyzing' || known === 'tooLong') return;
    if (durationSec > ANALYSIS_MAX_SEC) {
      status.set(id, 'tooLong');
      log(`analysis of ${id}: too long (${Math.round(durationSec)} s, over ${ANALYSIS_MAX_SEC} s), not analysed`);
      return;
    }
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
      stageOf(id, 'audio'); failedWhy.delete(id);
      const started = performance.now();
      try {
        const a = await analyzeOne(id);
        if (a?.tooLong) {
          status.set(id, 'tooLong');
          log(`analysis of ${id}: too long (${Math.round(a.durationSec)} s, over ${ANALYSIS_MAX_SEC} s), not analysed`);
          continue;
        }
        results.set(id, withBarPhase(a));
        while (results.size > KEEP_RESULTS) {
          const old = results.keys().next().value;
          results.delete(old);
          status.delete(old);
        }
        status.set(id, 'done');
        stage.delete(id);
        log(`analysis of ${id}${a.cached ? ' (saved)' : ''}${a.musicVideo ? ' (music video)' : ''}: ${a.bpm?.toFixed(1) ?? '?'} BPM (end ${a.tailGrid?.bpm?.toFixed(1) ?? '?'}), ${a.keyName ?? '?'}, grid ${a.gridConfidence.toFixed(2)} / end ${a.tailGrid?.gridConfidence?.toFixed(2) ?? '-'}, intro ends ${a.introEndSec?.toFixed(1) ?? '-'} s, outro from ${a.outroStartSec?.toFixed(1) ?? '-'} s${a.contentEndSec != null ? `, music ends ${a.contentEndSec.toFixed(1)} s` : ''}${a.subBassRatio != null ? `, sub-bass ${a.subBassRatio.toFixed(2)}` : ''}, in${Math.round(performance.now() - started)} ms`);
      } catch (e) {
        log('analysis of', id, 'failed:', e?.message || e);
        failedAt.set(id, Date.now());
        status.set(id, 'error');
        stage.delete(id);
        failedWhy.set(id, String(e?.message || e).slice(0, 120));
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
      // Automix v2 likewise gets its evidence (subBassRatio, bassCurve, chroma, loudnessCurve).
      if (adv() && (cached.contentEndSec === undefined || (version === 3 && cached.loudnessCurve === undefined))) {
        try {
          const { bytes } = await songBytes(id);
          const got = await askHost({ type: 'contentEnd', id, bytes }, [bytes], 30000);
          cached.contentEndSec = got?.contentEndSec ?? null;
          cached.subBassRatio = got?.subBassRatio ?? null;
          for (const k of ['bassCurve', 'chroma', 'chromaCurve', 'loudnessCurve']) cached[k] = got?.[k] ?? null;
        } catch { /* not downloaded (yet): the song's length, as before */ }
      }
      return cached;
    }
    const { bytes, musicVideo } = await songBytes(id);
    stageOf(id, 'decoding');
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
  // Bar phase (analysis-cases.md "The bar"): a grid's bars start where most of the beat model's
  // downbeats fall (each counted at its grid beat's place in the bar, k mod 4 from the first
  // downbeat, when within a quarter beat of it), not at its first downbeat, which is often a lone
  // pickup. A tie keeps the first downbeat's place. Moving it again changes nothing, so a saved
  // analysis is phased on load.
  function votedDownbeat(beatSec, fd, downs) {
    if (!(beatSec > 0) || fd == null || !downs?.length) return fd;
    const votes = [0, 0, 0, 0];
    for (const d of downs) {
      const k = Math.round((d - fd) / beatSec);
      if (Math.abs(fd + k * beatSec - d) <= beatSec / 4) votes[((k % 4) + 4) % 4]++;
    }
    let best = 0;
    for (let p = 1; p < 4; p++) if (votes[p] > votes[best]) best = p;
    return fd + best * beatSec;
  }
  function withBarPhase(a) {
    if (!a || a.tooLong) return a;
    const fd = votedDownbeat(a.beatIntervalSec, a.firstDownbeatSec, a.headBeats?.downbeats);
    const t = a.tailGrid, tfd = t ? votedDownbeat(t.beatIntervalSec, t.firstDownbeatSec, a.tailBeats?.downbeats) : null;
    if (fd === a.firstDownbeatSec && (!t || tfd === t.firstDownbeatSec)) return a;
    return { ...a, firstDownbeatSec: fd, ...(t ? { tailGrid: { ...t, firstDownbeatSec: tfd } } : {}) };
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
  // A length picked for this pair in the Automix overview comes first.
  let pinnedBars = null;
  let planSpeed = null;   // { out, in } while plan() runs with song speeds (spotify-mixes.md rule 10)
  // The curator blend (analysis-cases.md "The curator blend"): Automix v2's blend when Auto didn't pick
  // the loop mix, placed as Spotify's playlist editors place theirs: 8 bars, starting on the downbeat
  // nearest 31 s before the music ends. plan()'s `curator` asks for it; planFor falls back to the
  // usual blend when the keys aren't trusted or clash, both would sing over it, or the song is short.
  const CURATOR_BARS = 8, CURATOR_LEAD_SEC = 31, CURATOR_MIN_SONG_SEC = 120;
  let curatorAsk = false;
  const requestedBars = (cur, next, g, entrySec, filter) => pinnedBars || (barsSetting === 'auto' ? autoBars(cur, next, g, entrySec, filter) : barsSetting);

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
  // the plain crossfade's length: the user's crossfade slider (1-12 s) when the
  // engine passes it (plan's fadeSec), else 12 s (versions.md: Fallbacks)
  let fallbackSec = FALLBACK_SEC;

  function effectiveBlendBars(requested, fromConf, toConf) {
    const conf = Math.min(fromConf, toConf);
    if (conf >= 0.6) return requested;
    if (conf >= 0.45) return Math.min(requested, 8);
    return Math.min(requested, 4);
  }
  // Automix v2 (Orchard's pairTempoHarmony): the speed-up a pair needs, however it is split
  const V2_MAX_STRETCH = 0.08;
  const stretchOf = (ratio) => Math.max(ratio, 1 / ratio) - 1;
  // Orchard pairTempoHarmony: a constant stretch up to 4%; 4-8% only as a glide
  // (both songs' tempo moves together across the blend, each at its own speed at its loud end)
  const V2_MAX_CONSTANT = 0.04;
  // The glide, one step per beat of the blend: the shared tempo moves
  // geometrically from the playing song's (x = 0) to the next one's (x = 1),
  // q = next tempo / playing tempo (folded). Each beat k plays at x = (k + 0.5) / B:
  // the playing song at q^x, the next at q^(x - 1), so both play one beat of
  // their own in the same output time and stay beat-locked. The playing song
  // starts at its own speed, the next ends at its own. Output seconds per beat
  // in `dur`, `at[k]` = where beat k starts (from the blend's start).
  function glideSteps(q, beats, beatOutSec) {
    const outRate = [], inRate = [], dur = [], at = [];
    let t = 0;
    for (let k = 0; k < beats; k++) {
      const x = (k + 0.5) / beats;
      outRate.push(Math.pow(q, x)); inRate.push(Math.pow(q, x - 1));
      at.push(t); dur.push(beatOutSec / outRate[k]); t += dur[k];
    }
    return { outRate, inRate, dur, at, total: t, beatInSec: beatOutSec / q };
  }
  // v2 gates (Orchard pairTransitionGates, transitionFlow):
  // two 808 styles (subBassRatio apart by this much) are never overlapped;
  const V2_SUB_BASS_VETO = 0.9;
  const subBassContrast = (a, b) => (Number.isFinite(a?.subBassRatio) && Number.isFinite(b?.subBassRatio) ? Math.abs(a.subBassRatio - b.subBassRatio) : null);
  // "beatmatch or do nothing": a pair that can't be beatmatched meets at its natural boundary, with this short fade;
  const V2_SWITCH_SEC = 1.5;
  // the bass swap moves off a line the playing song is singing (voice risk, Orchard's 0.5 / 0.3).
  const SWAP_SINGING = 0.5, SWAP_CLEAR = 0.3;
  // The fallback ladder (Orchard pairTransitionPlanner): a blend both songs would sing over
  // more than this share of, after the re-route, is not played as a blend.
  const V2_CLASH_MAX = 0.3;
  const DROP_IN_BARS = 2;              // a drop-in's overlap (pairTransitionEvidence: two bars)
  // a drop-in trims the playing song at least this much (versions.md "The mix's ceiling"): B lands at
  // full level over A's first beats, and on a loud entry the sum alone tripped the limiter more than either song
  const DROP_IN_OUT_DB = -1.5;
  const dropInTrim = (t) => (t && t.outDb <= DROP_IN_OUT_DB ? t : { ...(t || { diffDb: null, inDb: 0 }), outDb: DROP_IN_OUT_DB });
  const MUFFLE_LEAD_BEATS = 8, MUFFLE_MIN_LEAD_BEATS = 4, MUFFLE_EXIT_BEATS = 2, MUFFLE_MIN_BODY = 0.3, MUFFLE_MIN_OPENING_SEC = 2;
  const BRIDGE_MIN_SEC = 4, BRIDGE_MAX_SEC = 12, BRIDGE_MAX_SKIP_SEC = 16, BEATLESS = 0.3;
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
  // [pick]: what the Automix overview asked for this pair, { style, bars }
  // (style 'blend', 'filter' or 'crossfade'; either may be null: Auto).
  // (an editor override, editor.md §9, or a pick from before the editor: migratePick)
  // speed: { out, in }, each song's speed in its playlist (spotify-mixes.md rule 10), or null (x1)
  function plan({ fromId, toId, from, to, durationSec, pos, earliest, pick = null, fadeSec = null, speed = null, curator = false }) {
    let ov = migratePick(pick);
    const notes = [];
    // a preset no longer offered plays as Automatic, and says so (editor.md §6)
    if (ov?.preset && ov.preset !== 'auto' && !PRESET_NAMES.includes(ov.preset)) {
      notes.push(`the preset "${ov.preset}" is no longer offered: Automatic plays`);
      ov = { ...ov, preset: 'auto' };
    }
    // beats counted on another app's grid at half or double time: on this one's (mix-file.md rule 4)
    if (ov?.gridBpm) {
      const f = foldOverride(ov, editorGrid(from, 'out')?.bpm);
      if (f.note) notes.push(f.note);
      ov = f.ov;
    }
    // an overlap is never longer than a third of either song: a longer length picked is shortened (editor.md §6)
    const pickedBars = ov?.preset !== 'loop' ? ov?.bars || PRESET_BARS[ov?.preset] || null : null;
    if (pickedBars && from && to) {
      const g = editorGrid(from, 'out'), third = Math.min(durationSec, to.durationSec > 0 ? to.durationSec : Infinity) / 3;
      const barSec = (g?.beatSec || 0) * 4;
      if (barSec > 0 && pickedBars * barSec > third + 1e-6) {
        const n = Math.max(1, Math.floor(third / barSec));
        notes.push(`shortened to ${n} bar${n === 1 ? '' : 's'} (${(n * barSec).toFixed(1)} s): an overlap can't be longer than a third of either song`);
        ov = { ...ov, bars: n };
      }
    }
    fallbackSec = fadeSec > 0 ? Math.min(FALLBACK_SEC, Math.max(1, Math.round(fadeSec))) : FALLBACK_SEC;
    pinnedBars = (ov?.preset !== 'loop' && (ov?.bars || PRESET_BARS[ov?.preset])) || null;
    const sOut = speed?.out > 0 ? speed.out : 1, sIn = speed?.in > 0 ? speed.in : 1;
    planSpeed = Math.abs(sOut - 1) >= 1e-4 || Math.abs(sIn - 1) >= 1e-4 ? { out: sOut, in: sIn } : null;
    curatorAsk = !!curator;
    try {
      const warnings = [...notes];
      const p = planFor({ fromId, toId, from, to, durationSec, pos, earliest, pick: ov, warnings });
      // each song's speed (spotify-mixes.md rule 10): A plays at its own from before the mix (the blend's
      // outRate is it), B at its own, through the mix and after it (set first: the curves' tempo shows them)
      if (planSpeed) {
        p.speedOut = planSpeed.out;
        p.speedIn = planSpeed.in;
        if (p.style !== 'blend') p.rate = planSpeed.in;
      }
      p.curves = blendCurves(p);
      // a length the planner didn't use (a hand-over, a drop-in's two bars): why, not "fit here" (editor.md §6)
      if (ov?.bars && ov.preset !== 'loop' && warnings.length === notes.length && (p.handoff || p.bridge || p.fallback || (p.shape === 'dropin' && p.bars !== ov.bars))) {
        warnings.push(`${ov.bars} bars not used: ${p.reason || 'a plain fade here'}`);
      }
      if (ov && ov.preset !== 'loop') {
        if (warnings.length) p.warnings = warnings;
        if (ov.window?.in && p.style === 'blend') p.windowIn = true;   // placed by the user: the kick lock leaves it (editor.md §6)
        // a drawing's beats (editor.md §10 rule 4): the mix's beat of A, its glide steps; with no beat match, A's own beat
        const draw = p.style !== 'crossfade' && p.barSec > 0 ? { beatSec: p.barSec / 4, glide: p.glide } : { beatSec: editorGrid(from, 'out')?.beatSec || 0.5, glide: null };
        const pc = !(p.fallback && !(from && to)) && presetCurves(ov, p.durationSec, p.style === 'crossfade' ? null : p.beatSec, draw);
        if (pc) {
          // the preset's gain, shelves and filters; the planner's tempo stays (editor.md §9)
          for (const side of ['out', 'in']) { if (p.curves[side].rate) pc[side].rate = p.curves[side].rate; }
          p.curves = pc;
          p.preset = ov.preset;
          // the Looping lane (editor.md §13): N of A's beats, in A's song seconds
          if (pc.loopBeats) p.loopSec = pc.loopBeats * (p.beatSec > 0 ? p.beatSec : editorGrid(from, 'out')?.beatSec || 0.5);
        }
      }
      // B's late entry (mix-file.md rule 2): B stays silent that long into the mix, then starts at its
      // mix-in; the curves stay where they are. Only a plain blend or crossfade plays it.
      const late = ov?.preset !== 'loop' ? ov?.window?.in?.delaySec : null;
      if (late > 0) {
        if (p.fallback || p.handoff || p.bridge || p.shape || p.glide || !['blend', 'crossfade'].includes(p.style)) {
          p.warnings = [...(p.warnings || []), `B's late start (${late} s) isn't played in this kind of mix: B starts with it`];
        } else {
          const most = Math.max(0, p.durationSec - 0.5);
          if (late > most + 1e-6) p.warnings = [...(p.warnings || []), `B's late start of ${late} s is past the mix's end: ${most.toFixed(1)} s`];
          const at = Math.round(Math.min(late, most) * 1e3) / 1e3;
          if (at > 0) p.inDelaySec = at;   // (a mix of half a second or less has no room for it)
        }
      }
      return p;
    } finally { pinnedBars = null; planSpeed = null; fallbackSec = FALLBACK_SEC; curatorAsk = false; }
  }
  // An override as saved (editor.md §1, override.schema.json): Auto fields dropped, null when nothing
  // but Auto is left (Auto is the reset). Picking a preset drops a migrated pick's family.
  const nudge = (ms) => (Number.isFinite(ms) ? clamp(Math.round(ms / 10) * 10, -2000, 2000) || 0 : 0);
  // { out, in }: A's and B's speed, 0.5..2 to 0.00001; a 1 left out; null when both are 1
  function normalizeSpeed(sp) {
    if (!sp || typeof sp !== 'object') return null;
    const r = {};
    for (const k of ['out', 'in']) {
      const v = sp[k];
      if (Number.isFinite(v) && v >= 0.5 && v <= 2 && Math.abs(v - 1) >= 1e-4) r[k] = Math.round(v * 1e5) / 1e5;
    }
    return Object.keys(r).length ? r : null;
  }
  // A song's speed while it plays (spotify-mixes.md rule 10): the speed the mix that brought it in
  // gives it (prev → id), else the one the mix taking it out gives it (id → next), else 1.
  // overrideOf(key) → the saved override of that pair, or null.
  function songSpeed(id, prevId, nextId, overrideOf) {
    const inn = prevId ? overrideOf(`${prevId}>${id}`)?.speed?.in : null;
    if (Number.isFinite(inn)) return inn;
    const out = nextId ? overrideOf(`${id}>${nextId}`)?.speed?.out : null;
    return Number.isFinite(out) ? out : 1;
  }
  function normalizeOverride(o) {
    o = migratePick(o);
    if (!o) return null;
    const n = {};
    if (PRESET_NAMES.includes(o.preset)) n.preset = o.preset;
    if (n.preset === 'custom' && o.lanes) {
      // each lane a shape name (§3) or a drawing (§10 rule 2)
      const l = {};
      for (const k of Object.keys(LANE_VALUES)) {
        // (the Effects and Looping lanes may be missing: none, editor.md §12 rule 1, §13)
        const v = OPTIONAL_LANES.includes(k) && o.lanes[k] == null ? 'none' : o.lanes[k];
        l[k] = typeof v === 'string' ? (LANE_VALUES[k].includes(v) ? v : null) : normalizeDrawing(k, v);
      }
      if (Object.values(l).every((v) => v)) { for (const k of OPTIONAL_LANES) if (l[k] === 'none') delete l[k]; n.lanes = l; }
    }
    if (n.preset === 'custom' && !n.lanes) delete n.preset;
    if (!n.preset && (o.family === 'blend' || o.family === 'filter')) n.family = o.family;
    if (n.preset !== 'loop') {
      if ([2, 4, 8, 16, 32].includes(o.bars)) n.bars = o.bars;
      // (no bar: a position in seconds only, as a mix file from another app gives it: editor.md §6)
      const pos = (p) => p && Number.isFinite(p.sec) && (Number.isInteger(p.bar) || p.bar == null)
        ? { ...(Number.isInteger(p.bar) ? { bar: p.bar, ...([1, 2, 3].includes(p.beat) ? { beat: p.beat } : {}) } : {}), ...(nudge(p.nudgeMs) ? { nudgeMs: nudge(p.nudgeMs) } : {}), sec: Math.round(p.sec * 1e3) / 1e3 } : null;
      // (B's late entry, mix-file.md rule 2: on the mix-in only, 1 ms to 60 s)
      const late = (p) => (Number.isFinite(p?.delaySec) && p.delaySec >= 0.001 ? { delaySec: Math.round(Math.min(p.delaySec, 60) * 1e3) / 1e3 } : {});
      const w = { out: pos(o.window?.out), in: pos(o.window?.in) && { ...pos(o.window.in), ...late(o.window.in) } };
      if (w.out || w.in) n.window = Object.fromEntries(Object.entries(w).filter(([, v]) => v));
      // (Loop: the loop decks do their own tempo ramp, editor.md §2)
      if (['sync', 'glide', 'off'].includes(o.beatMatch)) n.beatMatch = o.beatMatch;
    }
    // each song's speed in the playlist it came from (editor.md §1, spotify-mixes.md rule 10)
    const sp = normalizeSpeed(o.speed);
    if (sp) n.speed = sp;
    if (!Object.keys(n).length) return null;
    if (o.lock) n.lock = true;
    // the tempo of A the beats count on (mix-file.md rule 2): not an edit on its own
    if (Number.isFinite(o.gridBpm) && o.gridBpm >= 20 && o.gridBpm <= 400) n.gridBpm = Math.round(o.gridBpm * 100) / 100;
    return { v: 1, ...n, ...(o.engine ? { engine: o.engine } : {}), ...(o.savedAt ? { savedAt: o.savedAt } : {}) };
  }
  // Mix files (spec/automix/mix-file.md): pairs' overrides in one JSON file, to move mixes between
  // the apps and to import ready-made ones. readMixFile → { mixes: [{ key, from, to, override }],
  // skipped: [{ n, why }] } or { refused }; writeMixFile → the file's object; importPlan sorts the
  // mixes against the saved overrides; mixChanges says what a replacement changes.
  const MIX_FORMAT = 'vivi-mix', MIX_VERSION = 1, MIX_MAX = 300, MIX_FILE_MAX_BYTES = 2 * 1024 * 1024;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const textOf = (t) => (typeof t === 'string' && t.trim() ? t.trim().slice(0, 200) : null);
  function mixSong(s) {
    if (!s || typeof s !== 'object' || !VIDEO_ID.test(s.videoId)) return null;
    const title = textOf(s.title), artist = textOf(s.artist);
    return { videoId: s.videoId, ...(title ? { title } : {}), ...(artist ? { artist } : {}) };
  }
  // the override as a mix file carries it: normalized, without this app's engine and savedAt
  function mixOverride(o) {
    const n = normalizeOverride(o);
    if (!n) return null;
    const { engine, savedAt, ...rest } = n;
    return rest;
  }
  // Half and double time (mix-file.md rule 4): an override's beats (bars, drawings in beats) count on
  // A's grid at gridBpm. An app that reads A at half or double that tempo (within 4%) counts its beats
  // x2 or x1/2, so the mix plays the same seconds. k: the factor, or null when the tempos don't fold.
  const FOLD_TOL = 0.04;
  function foldFactor(gridBpm, bpm) {
    if (!(gridBpm > 0) || !(bpm > 0)) return null;
    const r = bpm / gridBpm;
    for (const k of [1, 2, 0.5]) if (Math.abs(r / k - 1) <= FOLD_TOL) return k;
    return null;
  }
  const countsBeats = (o) => !!o && (!!o.bars || (o.preset === 'custom' && Object.values(o.lanes || {}).some((d) => d && typeof d === 'object' && d.unit === 'beat')));
  // -> { ov, k, note }: the override on this app's grid (gridBpm then this app's tempo)
  function foldOverride(o, bpm) {
    if (!o || !countsBeats(o) || !(o.gridBpm > 0) || !(bpm > 0)) return { ov: o, k: 1, note: null };
    const k = foldFactor(o.gridBpm, bpm);
    if (k === null) return { ov: o, k: null, note: `drawn at ${Math.round(o.gridBpm)} BPM, this song reads ${Math.round(bpm)} BPM: its beats are taken as they are` };
    if (k === 1) return { ov: o, k, note: null };
    const ov = JSON.parse(JSON.stringify(o));
    const r3 = (v) => Math.round(v * 1e3) / 1e3;
    const scale = (pts) => (Array.isArray(pts) ? pts.map(([x, v]) => [r3(x * k), v]) : pts);
    for (const d of Object.values(ov.lanes || {})) {
      if (!d || typeof d !== 'object' || d.unit !== 'beat') continue;
      for (const side of ['out', 'in']) {
        if (Array.isArray(d[side])) d[side] = scale(d[side]);
        else if (d[side]) for (const c of Object.keys(d[side])) d[side][c] = scale(d[side][c]);
      }
    }
    let note = null;
    if (ov.bars) {
      const want = ov.bars * k;
      ov.bars = [2, 4, 8, 16, 32].includes(want) ? want : want > 32 ? 32 : 2;
      if (ov.bars !== want) note = `${want} bars on this song's grid: ${ov.bars} play`;
    }
    ov.gridBpm = Math.round(o.gridBpm * k * 100) / 100;
    return { ov, k, note };
  }
  // the import summary's note for one mix (mix-file.md rule 7): no tempo, or one that doesn't fold
  function foldNote(o, bpm) {
    if (!countsBeats(o)) return null;
    if (!(o.gridBpm > 0)) return 'no gridBpm: its beats are taken as they are';
    return foldOverride(o, bpm).note;
  }
  const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}` : JSON.stringify(v));
  const noGrid = (o) => { if (!o) return o; const { gridBpm, ...rest } = o; return rest; };
  const sameMix = (a, b) => stable(noGrid(mixOverride(a))) === stable(noGrid(mixOverride(b)));
  function readMixFile(text) {
    if (typeof text !== 'string') return { refused: 'not a Vivimusic mix file' };
    if (text.length > MIX_FILE_MAX_BYTES) return { refused: 'the file is over 2 MB: not a Vivimusic mix file' };
    let j;
    try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { refused: 'not a Vivimusic mix file: it is not JSON' }; }
    if (j && typeof j === 'object' && j.format === SPOTIFY_FORMAT) return readSpotifyMixes(j);
    if (!j || typeof j !== 'object' || j.format !== MIX_FORMAT) return { refused: 'not a Vivimusic mix file' };
    if (!Number.isInteger(j.version) || j.version < 1) return { refused: 'the mix file has no valid version' };
    if (j.version > MIX_VERSION) return { refused: `this mix file is version ${j.version}, newer than this app reads (${MIX_VERSION}): update the app to import it` };
    if (!Array.isArray(j.mixes) || !j.mixes.length) return { refused: 'the mix file has no mixes' };
    if (j.mixes.length > MIX_MAX) return { refused: `the mix file has ${j.mixes.length} mixes: ${MIX_MAX} is the most` };
    return collectMixes(j.mixes.map((m, i) => ({ n: i + 1, from: m?.from, to: m?.to, override: m?.override })));
  }
  // items: [{ n, from, to, override, why? }] → { mixes, skipped } (mix-file.md rule 4); why: skipped as is
  function collectMixes(items) {
    const mixes = [], skipped = [], at = new Map();
    items.forEach((m) => {
      const n = m.n;
      if (m.why) { skipped.push({ n, why: m.why }); return; }
      const from = mixSong(m.from), to = mixSong(m.to);
      if (!from || !to) { skipped.push({ n, why: 'a song has no valid videoId' }); return; }
      if (from.videoId === to.videoId) { skipped.push({ n, why: 'the same song on both sides' }); return; }
      const o = m.override;
      const ov = mixOverride(o);
      // a preset or a lane this app doesn't know is not dropped quietly
      if (o?.preset && o.preset !== 'auto' && ov?.preset !== o.preset) {
        skipped.push({ n, why: o.preset === 'custom' ? 'its lanes are not valid' : `the preset "${o.preset}" is unknown here` });
        return;
      }
      if (!ov) { skipped.push({ n, why: 'nothing but Auto in it' }); return; }
      const key = from.videoId + '>' + to.videoId;
      const mix = { key, from, to, override: ov };
      if (at.has(key)) { skipped.push({ n: at.get(key).n, why: `the same pair again in mix ${n}: the later one is used` }); mixes[at.get(key).i] = mix; at.set(key, { i: at.get(key).i, n }); return; }
      at.set(key, { i: mixes.length, n });
      mixes.push(mix);
    });
    return { mixes, skipped };
  }
  // A Spotify mix export (spec/automix/spotify-mixes.md): "spotify-mix-export" version 3, the songs'
  // YouTube ids in youtubeVideoId. Each Spotify mix becomes a custom override; the queue is the
  // playlist's tracks in order. → { mixes, skipped, queue, notes, name } or { refused }
  const SPOTIFY_FORMAT = 'spotify-mix-export', SPOTIFY_VERSION = 3;
  // (the names as Spotify's editor shows them: research/spotify-mixes/tools/style_names.json)
  const SP_VOLUME = { 1: 'centerCut', 2: 'crossfade', 5: 'fadeInFadeOut', 6: 'smooth', 7: 'overlap', 9: 'fadeInCutOut', 10: 'cutInFadeOut', 11: 'fadeInFastOut', 12: 'fadeIn1BarCutOut', 13: 'overlap1BarCutOut' };
  const SP_EQ = { 0: 'none', 1: 'threeBandFade', 4: 'centerBassSwap', 10: 'endBassSwap', 11: 'startBassSwap', 12: 'quickBassCut', 13: 'longBassCut', 15: 'bassFadeOut' };
  const SP_FILTER = { 0: 'none', 5: 'hpIn', 6: 'hpOut', 7: 'hpBoth', 9: 'lpIn', 10: 'lpOut', 11: 'lpBoth', 12: 'hpInLpOut', 13: 'lpInHpOut', 14: 'hpHalfOut', 15: 'noiseOutEnd' };
  // (Spotify 9.2.2's names; a drawn lane still carries its drawing, the name its echo or delay time)
  const SP_FX = { 0: 'none', 1: 'reverbOutCenter', 2: 'reverbCutEnd', 3: 'reverbOutEnd', 4: 'echoHalfCutEnd', 5: 'echoHalfOutEnd', 6: 'echo34CutEnd',
    7: 'echo34OutEnd', 8: 'delayHalfCutEnd', 9: 'delay34CutEnd', 10: 'echo1CutEnd', 11: 'echo1OutEnd' };
  const SP_LOOP = { 0: 'none', 1: 'loop2', 2: 'loop4', 3: 'loop8', 4: 'loop16', 8: 'loop1' };
  const SP_DEFAULT = { volume: 'overlap', eq: 'centerBassSwap', effect: 'none', fx: 'none', looping: 'none' };
  // a lane Spotify leaves unset plays its base preset's own (spotify-mixes.md rule 4): style.basePresetId's
  // lanes, the ones of today's presets as editor.md §2; any other id: SP_DEFAULT
  // (ids from Spotify 9.2.2's preset enum; 5, 10 and 19 are older presets, seen in its editor)
  const SP_BASE = { 1: 'smooth', 2: 'blend', 3: 'rise', 4: 'melt', 11: 'slam', 17: 'wave', 20: 'dissolve', 21: 'surge', 22: 'afterglow',
    5: { volume: 'fadeInCutOut' }, 10: { eq: 'centerBassSwap', effect: 'hpBoth' }, 19: { volume: 'overlap', eq: 'centerBassSwap', effect: 'lpBoth' } };
  const spBase = (id) => (typeof SP_BASE[id] === 'string' ? PRESET_LANES[SP_BASE[id]] : SP_BASE[id]) || {};
  function readSpotifyMixes(j) {
    if (!Number.isInteger(j.version) || j.version < 1) return { refused: 'the Spotify mix file has no valid version' };
    if (j.version > SPOTIFY_VERSION) return { refused: `this Spotify mix file is version ${j.version}, newer than this app reads (${SPOTIFY_VERSION}): update the app to import it` };
    if (j.version < SPOTIFY_VERSION) return { refused: `this Spotify mix file is version ${j.version}: it has no YouTube ids yet (version ${SPOTIFY_VERSION} has them)` };
    if (!Array.isArray(j.mixes) || !j.mixes.length) return { refused: 'the mix file has no mixes' };
    if (j.mixes.length > MIX_MAX) return { refused: `the mix file has ${j.mixes.length} mixes: ${MIX_MAX} is the most` };
    const song = (t) => (t && VIDEO_ID.test(t.youtubeVideoId || '') ? { videoId: t.youtubeVideoId, title: t.title, artist: Array.isArray(t.artists) ? t.artists.join(', ') : undefined } : null);
    const lost = { unnamed: 0, notCarried: new Set(), late: 0 };
    const items = j.mixes.map((m, i) => {
      const n = Number.isInteger(m?.index) ? m.index : i + 1;
      const from = song(m?.from), to = song(m?.to);
      if (!from || !to) return { n, why: `no YouTube id for ${(!from ? m?.from?.title : m?.to?.title) || 'a song'}` };
      // (a mix of a millisecond with no start: Spotify's straight cut, its No transition: rule 3)
      if (!(m.durationMs >= 100) && !Number.isFinite(m.fromStartMs)) return { n, from, to, override: { v: 1, preset: 'none' } };
      const override = spotifyOverride(m, lost);
      return override ? { n, from, to, override } : { n, why: 'its timing is not valid' };
    });
    const r = collectMixes(items);
    const queue = [];
    for (const t of j.playlist?.tracks || []) { const id = song(t)?.videoId; if (id && queue[queue.length - 1] !== id) queue.push(id); }
    const notes = [];
    if (lost.unnamed) notes.push(`${lost.unnamed} lane${lost.unnamed === 1 ? '' : 's'} in a Spotify style with no match here play the default shape`);
    if (lost.notCarried.size) notes.push(`not carried: ${[...lost.notCarried].join(', ')}`);
    // (rule 10: saved with the mix; this app doesn't play a song's speed yet)
    if (lost.late) notes.push(`${lost.late} mix${lost.late === 1 ? '' : 'es'} bring${lost.late === 1 ? 's' : ''} B in late in an older export's unsigned time: here B starts with the mix`);
    return { ...r, queue, notes, name: textOf(j.playlist?.name) };
  }
  // One Spotify mix as an override (spotify-mixes.md rules 3 to 6)
  function spotifyOverride(m, lost) {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const D = m.durationMs / 1000;
    // (an older export carries a negative time read as unsigned, 2^64 − x: negative too)
    const ms = (v) => (Number.isFinite(v) && v >= 0 && v < 2 ** 53 ? v : null);
    // a negative B start: B's 0:00 comes in that long after the mix starts (spotify-mixes.md rule 3)
    // (an unsigned one is too far off to read back: B starts with the mix, and the summary says so)
    if (m.toStartMs >= 2 ** 53) lost.late++;
    const late = m.toStartMs < 0 && Number.isFinite(m.toStartMs) ? r3(-m.toStartMs / 1000) : 0;
    if (!(D > 0) || ms(m.fromStartMs) === null) return null;
    const bars = [2, 4, 8, 16, 32].includes(m.bars) ? m.bars : null;
    const unit = bars ? 'beat' : 'sec', N = bars ? bars * 4 : r3(D);
    const st = m.style || {};
    const c = m.curves || {};
    // (spotify-mixes.md rules 6 and 9: no lane here plays a jogwheel, so it is named)
    if (st.jogwheel || c.jogwheel) lost.notCarried.add('jogwheel');
    // (a number with no name here counts only on a lane with no drawing: a drawing carries it)
    const base = { ...SP_DEFAULT, ...spBase(st.basePresetId) };
    const pick = (map, k, lane) => {
      if (st[k] == null) return base[lane] ?? SP_DEFAULT[lane];
      if (st[k] in map) return map[st[k]];
      if (!c[k]) lost.unnamed++;
      return base[lane] ?? SP_DEFAULT[lane];
    };
    const lanes = { volume: pick(SP_VOLUME, 'volume', 'volume'), eq: pick(SP_EQ, 'eq', 'eq'), effect: pick(SP_FILTER, 'filter', 'effect'), fx: pick(SP_FX, 'fx', 'fx'), looping: pick(SP_LOOP, 'looping', 'looping') };
    // a Spotify curve (segments of fractions, lines or cubic Beziers) as [x, v] points in N units
    const points = (segs, f) => {
      const pts = [];
      for (const s of Array.isArray(segs) ? segs : []) {
        const P = Array.isArray(s?.points) ? s.points : [];
        if (P.length < 2) continue;
        const at = (px) => (s.start + px * (s.end - s.start)) * N;
        if (P.length === 4) {
          for (let k = 0; k <= 8; k++) {
            const t = k / 8, u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
            pts.push([at(w.reduce((a, c, i) => a + c * P[i][0], 0)), f(w.reduce((a, c, i) => a + c * P[i][1], 0))]);
          }
        } else if (f.linear) {
          for (const p of P) pts.push([at(p[0]), f(p[1])]);
        } else {
          const [a, b] = [P[0], P[P.length - 1]];
          for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([at(a[0] + t * (b[0] - a[0])), f(a[1] + t * (b[1] - a[1]))]); }
        }
      }
      return pts.map(([x, v]) => [r3(clamp(x, 0, N)), r3(v)]).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    };
    const gain = Object.assign((y) => clamp(y, 0, 1), { linear: true });
    const amount = gain, amountAbove = Object.assign((y) => clamp((y - 0.5) / 0.5, 0, 1), { linear: true });
    const db = Object.assign((y) => (y >= 0.5 ? 0 : (EDITOR_CUT_DB * (0.5 - y)) / 0.5), { linear: true });
    const cutoff = (y) => (y >= 0.5 ? { hp: 20 * Math.pow(HP_CLOSED / 20, (y - 0.5) / 0.5) } : { lp: 20000 * Math.pow(LP_CLOSED / 20000, (0.5 - y) / 0.5) });
    // a lane's shape as a drawing (the deck a curve leaves out, and the shapes drawn here)
    const shape = (lane, v) => {
      const d = shapeDrawing(lane, v, D, unit === 'beat' ? D / N : 0.5, null, unit);
      return d && d !== 'none' ? d : { unit, out: {}, in: {} };
    };
    if (c.volume) {
      const base = shape('volume', lanes.volume);
      lanes.volume = { unit, out: c.volume.from?.curve ? points(c.volume.from.curve, gain) : base.out, in: c.volume.to?.curve ? points(c.volume.to.curve, gain) : base.in };
    }
    if (c.eq) {
      const base = shape('eq', lanes.eq);
      const deck = (dk, b) => {
        const e = c.eq[dk];
        if (!e?.low && !e?.mid && !e?.high) return b;
        const out = {};
        for (const [k, ours] of [['low', 'bass'], ['mid', 'mid'], ['high', 'high']]) {
          const pts = e[k] ? points(e[k], db) : null;
          if (pts?.some(([, v]) => v < 0)) out[ours] = pts;
        }
        return out;
      };
      lanes.eq = { unit, out: deck('from', base.out), in: deck('to', base.in) };
    }
    if (c.filter) {
      const base = shape('effect', lanes.effect);
      const deck = (dk, b) => {
        const segs = c.filter[dk]?.cutoff, ns = c.filter[dk]?.noiseColor;
        if (!segs && !ns) return b;
        const d = {};
        if (segs) {
          const lp = [], hp = [];
          for (const [x, y] of points(segs, (y) => y)) { const v = cutoff(y); lp.push([x, r3(v.lp ?? 20000)]); hp.push([x, r3(v.hp ?? 20)]); }
          if (lp.some(([, v]) => v < 20000)) d.lp = lp;
          if (hp.some(([, v]) => v > 20)) d.hp = hp;
        } else {
          if (b.lp) d.lp = b.lp;
          if (b.hp) d.hp = b.hp;
        }
        // noiseColor 0.5 is no noise; above it, the noise's level up to 1 (rule 5)
        const noise = ns ? points(ns, amountAbove) : null;
        if (noise?.some(([, v]) => v > 0)) d.noise = noise;
        return d;
      };
      lanes.effect = { unit, out: deck('from', base.out), in: deck('to', base.in) };
      if (c.filter.from?.resonance || c.filter.to?.resonance) lost.notCarried.add('filter resonance');
    }
    if (c.fx) {
      const base = shape('fx', lanes.fx);
      const deck = (dk, b) => {
        const e = c.fx[dk];
        if (!e?.echo && !e?.reverb && !e?.delay) return b;
        const out = {};
        for (const k of ['echo', 'reverb', 'delay']) {
          const pts = e[k] ? points(e[k], amount) : null;
          if (pts?.some(([, v]) => v > 0)) out[k] = pts;
        }
        return out;
      };
      const t = FX_SHAPES[lanes.fx];
      lanes.fx = { unit, out: deck('from', base.out), in: deck('to', base.in), ...(t?.send === 'echoSend' ? { echoBeats: t.beats } : t?.send === 'delaySend' ? { delayBeats: t.beats } : {}) };
    }
    for (const k of OPTIONAL_LANES) if (lanes[k] === 'none') delete lanes[k];
    const gridBpm = m.fromBpm > 0 ? m.fromBpm : bars ? (bars * 4 * 60) / D : null;
    // each song's speed in the playlist (rule 10: f18 A's, f19 B's; missing is 1)
    const speed = normalizeSpeed({ out: m.f18, in: m.f19 });

    return mixOverride({
      v: 1, preset: 'custom', lanes,
      ...(bars ? { bars } : { beatMatch: 'off' }),
      // B's start: none → from 0; a negative one → from 0, that long after the mix starts (rule 3)
      window: { out: { sec: r3(m.fromStartMs / 1000) }, in: { sec: r3((ms(m.toStartMs) ?? 0) / 1000), ...(late >= 0.001 ? { delaySec: late } : {}) } },
      ...(gridBpm ? { gridBpm } : {}),
      ...(speed ? { speed } : {}),
    });
  }
  // entries: [{ from: { videoId, title?, artist? }, to, override }] (an invalid one is left out)
  function writeMixFile(entries) {
    const mixes = [];
    for (const e of entries || []) {
      const from = mixSong(e?.from), to = mixSong(e?.to), override = mixOverride(e?.override);
      if (from && to && override) mixes.push({ from, to, override });
    }
    return { format: MIX_FORMAT, version: MIX_VERSION, mixes };
  }
  const speedText = (sp) => (sp ? `A x${sp.out ?? 1} B x${sp.in ?? 1}` : 'x1');
  // What replacing a saved override with another changes, one line per field
  function mixChanges(was, now) {
    const a = mixOverride(was) || {}, b = mixOverride(now) || {};
    const lane = (o, k) => (o.preset !== 'custom' ? (o.preset === 'loop' ? 'loop' : o.preset ? o.preset + "'s" : 'auto') : o.lanes?.[k] == null ? 'none' : typeof o.lanes[k] === 'string' ? o.lanes[k] : 'drawn');
    // (a position in seconds only, editor.md §6, as its time: "218.142 s")
    const pos = (p) => (p ? `${Number.isInteger(p.bar) ? `bar ${p.bar}${p.beat ? '.' + (p.beat + 1) : ''}` : `${p.sec} s`}${p.nudgeMs ? ` ${p.nudgeMs > 0 ? '+' : ''}${p.nudgeMs} ms` : ''}${p.delaySec ? `, ${p.delaySec} s into the mix` : ''}` : null);
    const rows = [
      ['preset', a.preset || 'auto', b.preset || 'auto'],
      ...['volume', 'eq', 'effect', 'fx', 'looping'].map((k) => [k === 'fx' ? 'effects' : k, lane(a, k), lane(b, k)]),
      ['length', a.bars ? a.bars + ' bars' : 'auto', b.bars ? b.bars + ' bars' : 'auto'],
      ['beat match', a.beatMatch || 'auto', b.beatMatch || 'auto'],
      ['speed', speedText(a.speed), speedText(b.speed)],
      ['mix-out', pos(a.window?.out) || 'auto', pos(b.window?.out) || 'auto'],
      ['mix-in', pos(a.window?.in) || 'auto', pos(b.window?.in) || 'auto'],
      ['lock', a.lock ? 'on' : 'off', b.lock ? 'on' : 'off'],
    ];
    const out = [];
    for (const [k, x, y] of rows) {
      // (the Effects lane only when a side has one: most mixes have none)
      if (k === 'effects' && !a.lanes?.fx && !b.lanes?.fx) continue;
      if (k === 'looping' && !a.lanes?.looping && !b.lanes?.looping) continue;
      const lk = k === 'effects' ? 'fx' : k;
      const same = x === y && !(x === 'drawn' && stable(a.lanes?.[lk]) !== stable(b.lanes?.[lk]));
      if (!same) out.push(`${k}: ${x} → ${x === 'drawn' && y === 'drawn' ? 'another drawing' : y}`);
    }
    return out;
  }
  // The file's mixes against the saved overrides (key → override): new, replacing one (with its
  // changes), or the same as saved
  function importPlan(mixes, saved) {
    const add = [], replace = [], same = [];
    for (const m of mixes || []) {
      const was = saved?.[m.key] ? migratePick(saved[m.key]) : null;
      if (!was || !normalizeOverride(was)) add.push(m);
      else if (sameMix(was, m.override)) same.push(m);
      else replace.push({ ...m, changes: mixChanges(was, m.override) });
    }
    return { add, replace, same };
  }
  // "Play these mixes" (mix-file.md rule 7): the file's songs in its order, each mix's from then to; a
  // song that is already next in line isn't added twice (A→B, B→C plays A, B, C)
  function mixQueue(mixes) {
    const ids = [];
    for (const m of mixes || []) {
      for (const id of [m?.from?.videoId, m?.to?.videoId]) if (VIDEO_ID.test(id || '') && ids[ids.length - 1] !== id) ids.push(id);
    }
    return ids;
  }
  // The window's limits as the planner clamps them (editor.md §6), in song seconds: A's mix-out from
  // the earliest it can still start (with the tempo ramp before a blend) to where the window ends with
  // A's music; B's mix-in from 0 to where the window ends 10 s before B's end. from: A's analysis with
  // the playing length; earliest: the playhead plus the hand-over lead.
  function windowLimits(m, from, to, earliest) {
    const blend = m?.style === 'blend' && m.beatSec > 0 && m.bars > 0;
    const outSpan = blend ? m.bars * 4 * m.beatSec : m?.durationSec || 0;
    const inSpan = blend ? outSpan * (m.glide?.q ? 1 / m.glide.q : (m.rate || 1) / (m.outRate || 1)) : outSpan;
    const dur = from?.durationSec || 0, end = from ? musicEnd(from).durationSec : 0;
    const lo = Math.max(0, earliest || 0) + (blend ? m.rampSongSec || 0 : 0);
    const hi = blend ? Math.min(end, dur - 0.3) - outSpan : end - 0.3 - outSpan;
    return { out: [lo, Math.max(lo, hi)], in: [0, Math.max(0, (to?.durationSec || 0) - 10 - inSpan)] };
  }
  // A 10 ms nudge of one side's window position (editor.md §6): { pos } or { refused: 'max' | 'lo' | 'hi' }.
  // A nudge stops at ±2 s of nudges and at the window's limits ([lo, hi] from windowLimits), as a drag
  // does: past a limit the planner clamps it back, so the nudge would save a position that never plays.
  // A nudge back towards the limits from outside them is allowed.
  const NUDGE_STEP_MS = 10, NUDGE_MAX_MS = 2000;
  function nudgeWindow(pos, dir, limits) {
    const n = (pos.nudgeMs || 0) + dir * NUDGE_STEP_MS;
    if (Math.abs(n) > NUDGE_MAX_MS) return { refused: 'max' };
    const sec = Math.round((pos.sec + dir * NUDGE_STEP_MS / 1000) * 1000) / 1000;
    const [lo, hi] = limits || [-Infinity, Infinity];
    if (dir < 0 && sec < lo - 1e-6) return { refused: 'lo' };
    if (dir > 0 && sec > hi + 1e-6) return { refused: 'hi' };
    const out = { ...pos, nudgeMs: n, sec };
    if (!out.nudgeMs) delete out.nudgeMs;
    return { pos: out };
  }
  // A song's grid as the editor snaps to it: the playing song's end grid ('out'), the next song's opening ('in')
  function editorGrid(a, side) {
    const g = a ? gridOf(side === 'out' ? asOutgoing(a) : a) : null;
    return g ? { beatSec: g.beatSec, downbeatSec: g.downbeatSec, bpm: g.bpm } : null;
  }
  // A pick from before the editor ({ style, bars }) as an override (editor.md §1); an override as it is.
  function migratePick(p) {
    if (!p || typeof p !== 'object') return null;
    if (!('style' in p)) return p;
    const o = {};
    if (p.style === 'loop') o.preset = 'loop';
    else if (p.style === 'blend' || p.style === 'filter') { o.preset = 'auto'; o.family = p.style; }
    else if (p.style === 'crossfade') { o.preset = 'auto'; o.beatMatch = 'off'; }
    if (p.bars) o.bars = p.bars;
    return Object.keys(o).length ? o : null;
  }
  // The user's own choice beyond Auto: the planner's style gates warn instead of refusing (editor.md §6)
  const forcedBy = (ov) => !!ov && ((ov.preset && !['auto', 'loop'].includes(ov.preset)) || ['sync', 'glide'].includes(ov.beatMatch) || !!(ov.window?.out || ov.window?.in));
  // Beat match Off (or Sync/Glide out of range): both songs at their own speed, overlapping over the
  // window and length asked for; with neither asked for, the plain crossfade at the song's end.
  function overlap(cur, next, fromGrid, ov, earliest, reason, warnings) {
    const base = fallback(cur, next, earliest, reason);
    const outW = resolveWindow(ov?.window?.out, null), inW = resolveWindow(ov?.window?.in, null);
    const bars = ov?.bars || PRESET_BARS[ov?.preset] || null;
    if (!bars && !outW && !inW) return base;
    const end = musicEnd(cur).durationSec, room = end - 0.3 - earliest;
    if (room < 1) { warnings?.push('no room left in this song for the window asked for'); return base; }
    const want = bars && fromGrid ? bars * fromGrid.barSec : base.durationSec || fallbackSec;
    if (bars && fromGrid && want > room + 0.01) warnings?.push(`${bars} bars don't fit before the end: ${room.toFixed(1)} s`);
    const D = Math.min(want, room), hi = Math.max(earliest, end - 0.3 - D);
    let mixOut = hi;
    if (outW && outW.sec < earliest - 0.01) warnings?.push(playedNote(outW.sec));
    else if (outW) mixOut = clampWindow(outW.sec, earliest, hi, 'the mix-out', warnings, fromGrid);
    const mixIn = inW ? clampWindow(inW.sec, 0, Math.max(0, next.durationSec - 10 - D), 'the mix-in', warnings, gridOf(next)) : base.mixInTrackTime;
    return { ...base, fallback: false, mixOutTrackTime: mixOut, durationSec: D, mixInTrackTime: mixIn, trim: loudnessTrim(cur, mixOut, D, next, mixIn, D) };
  }
  function clampWindow(t, lo, hi, what, warnings, grid) {
    let c = clamp(t, lo, hi);
    if (Math.abs(c - t) <= 0.01) return c;
    if (grid?.barSec > 0) {
      const d = t < lo ? downbeatAtOrAfter(grid, lo) : downbeatAtOrBefore(grid, hi);
      if (d >= lo - 1e-6 && d <= hi + 1e-6) c = d;
    }
    warnings?.push(`${what} moved to ${c.toFixed(1)} s (${t < lo ? 'before the song' : 'too close to the end'})`);
    return c;
  }
  // A saved mix-out the playhead has passed: the planner's own (editor.md §6)
  const playedNote = (sec) => `the mix-out at ${sec.toFixed(1)} s has already played: Auto's mix-out instead`;
  function planFor({ fromId, toId, from, to, durationSec, pos, earliest, pick, warnings = [] }) {
    const both = !!(from && to);
    const cur = asOutgoing(both ? { ...from, durationSec } : stub(fromId, durationSec));
    const next = both ? to : stub(toId, 0);
    const fromGrid = gridOf(cur);
    const toGrid = gridOf(next);
    const forced = forcedBy(pick);
    const bm = pick?.beatMatch || 'auto';

    if (bm === 'off' && both) return overlap(cur, next, fromGrid, pick, earliest, pick.family || pick.preset === 'auto' ? 'picked in the overview' : 'beat match off', warnings);
    const v3 = version === 3;
    if (!fromGrid || cur.gridConfidence < MIN_GRID_CONFIDENCE) {
      if (forced && both) { warnings.push('no beat grid at this song\'s end: plays without beat match'); return overlap(cur, next, null, pick, earliest, 'this song has no beat grid at its end', warnings); }
      if (v3 && both) return handoff(cur, next, earliest, 'this song has no beat grid at its end');
      return fallback(cur, next, earliest, both ? 'this song has no beat grid at its end' : 'songs not analysed in time');
    }
    if (forced && both && (!toGrid || next.gridConfidence < MIN_GRID_CONFIDENCE)) {
      warnings.push('the next song has no beat grid: plays without beat match');
      return overlap(cur, next, fromGrid, pick, earliest, 'next song has no beat grid', warnings);
    }
    // the tempos as they play: each BPM x its song's speed (spotify-mixes.md rule 10)
    const playedRatio = (g1, g2) => foldRate((g1.bpm * (planSpeed?.out || 1)) / (g2.bpm * (planSpeed?.in || 1)));
    if (bm === 'sync' || bm === 'glide') {
      const st = stretchOf(playedRatio(fromGrid, toGrid));
      if (st > V2_MAX_STRETCH) {
        const why = `tempos ${Math.round(st * 100)}% apart: ${bm === 'sync' ? 'Sync' : 'Glide'} stretches at most ${Math.round(V2_MAX_STRETCH * 100)}%, so this plays without beat match`;
        warnings.push(why);
        return overlap(cur, next, fromGrid, pick, earliest, why, warnings);
      }
    }
    if (pick?.family === 'filter') {
      if (pick.window?.out || pick.window?.in) warnings.push("a Filter mix places itself: the saved window isn't used (pick a preset to use it)");
      return filterMix(cur, next, fromGrid, toGrid && next.gridConfidence >= MIN_GRID_CONFIDENCE ? toGrid : null, requestedBars(cur, next, fromGrid, toGrid?.downbeatSec ?? 0, true), pos, earliest, 'picked in the overview');
    }
    if (v3 && (!toGrid || next.gridConfidence < MIN_GRID_CONFIDENCE)) return handoff(cur, next, earliest, 'next song has no beat grid');
    if (!toGrid || next.gridConfidence < MIN_GRID_CONFIDENCE) return filterMix(cur, next, fromGrid, null, requestedBars(cur, next, fromGrid, 0, true), pos, earliest, 'next song has no beat grid');

    const ratio = playedRatio(fromGrid, toGrid);
    // v2: never more than V2_MAX_STRETCH of speed-up (Orchard: 6% fine, 11.8% forced),
    // and never two 808 styles at once; either way it can't beatmatch, so it does nothing
    if (v3 && stretchOf(ratio) > V2_MAX_STRETCH) {
      const why = `tempos ${Math.round(stretchOf(ratio) * 100)}% apart (v2 stretches at most ${Math.round(V2_MAX_STRETCH * 100)}%)`;
      if (!forced && !pick?.bars) return unmatchedMix(cur, next, fromGrid, toGrid, pos, earliest, why);
      warnings.push(`${why}: plays without beat match`);
      return overlap(cur, next, fromGrid, pick, earliest, why, warnings);
    }
    const contrast = subBassContrast(cur, next);
    if (v3 && contrast >= V2_SUB_BASS_VETO) {
      if (!forced) return handoff(cur, next, earliest, `different sub-bass styles (${contrast.toFixed(2)} apart)`);
      warnings.push(`the productions clash (sub-bass ${contrast.toFixed(2)} apart)`);
    }
    const harmonic = v3 ? harmonicEvidence(cur, next) : null;
    if (harmonic?.severeClash) {
      if (!forced) return handoff(cur, next, earliest, `the keys clash (${cur.keyName} → ${next.keyName}, ${harmonic.score})`);
      warnings.push(`the keys clash (${cur.keyName} → ${next.keyName})`);
    }
    if (!stretchAllowed(ratio)) {
      const why = `tempos ${Math.round(Math.abs(ratio - 1) * 100)}% apart`;
      if (!forced) return filterMix(cur, next, fromGrid, toGrid, requestedBars(cur, next, fromGrid, toGrid.downbeatSec, true), pos, earliest, why);
      warnings.push(`${why}: too far to stretch, plays without beat match`);
      return overlap(cur, next, fromGrid, pick, earliest, why, warnings);
    }
    // Tempo only ever moves up (BitChord's Advanced Automix): slowing a song
    // with its pitch kept repeats slivers of it, which smears piano and voices,
    // while speeding one up stays clean. The next song faster: the playing one
    // is brought up to its tempo over its last beats before the blend and the
    // next song plays at its own speed. The next song slower: it is sped up.
    // Automix v2: over 4% apart, a glide on both songs instead (glideSteps)
    // (each song's speed from its playlist, spotify-mixes.md rule 10: A at its speed with no ramp or glide,
    // B at its speed times what is left between the played tempos, gliding back to its speed after the
    // mix; this one may slow a song)
    const sp = planSpeed;
    const glideQ = sp ? null : bm === 'sync' ? null : bm === 'glide' ? (Math.abs(ratio - 1) > 1e-4 ? 1 / ratio : null) : v3 && stretchOf(ratio) > V2_MAX_CONSTANT ? 1 / ratio : null;
    const rate = sp ? sp.in * ratio : glideQ ? 1 : ratio < 1 ? 1 : ratio;               // the next song's
    const outRate = sp ? sp.out : glideQ ? 1 : ratio < 1 ? 1 / ratio : 1;        // the playing song's, from the blend on
    const rampBeats = !sp && outRate > 1.0001 ? Math.ceil((outRate - 1) / TEMPO_STEP_PER_BEAT) : 0;
    const rampSongSec = rampBeats * fromGrid.beatSec;  // song time the ramp covers, ending at the mix-out
    // AutoDJ's key-aware length (its own toggle): keys that clash get a short blend
    // (Automix v2: Orchard's key score, always on: under 0.55 with both keys trusted)
    const keyClash = v3 ? (harmonic.short ? `${cur.keyName} → ${next.keyName}, ${harmonic.score}` : null) : adv() && keyAware ? keysClash(cur, next) : null;
    // the curator blend: only Auto's own blend on Automix v2, nothing picked or set for its length,
    // keys both trusted and not clashing, a song of 2 min or more (fallbacks 1 and 3; 2 is below)
    const curator = curatorAsk && v3 && !forced && !pinnedBars && barsSetting === 'auto' && !pick?.window?.out && !pick?.window?.in
      && !keyClash && (harmonic?.confidence ?? 0) >= TRUSTED_KEY && musicEnd(cur).durationSec >= CURATOR_MIN_SONG_SEC;
    const usual = () => { curatorAsk = false; return planFor({ fromId, toId, from, to, durationSec, pos, earliest, pick, warnings }); };
    const bars = curator ? CURATOR_BARS : keyClash && !pinnedBars ? keyClashBars(fromGrid) : requestedBars(cur, next, fromGrid, toGrid.downbeatSec, false);
    const effBars = effectiveBlendBars(bars, cur.gridConfidence, next.gridConfidence);
    const outSpan = effBars * fromGrid.barSec;        // the playing song's seconds the blend covers
    const glide = glideQ ? glideSteps(glideQ, effBars * 4, fromGrid.beatSec) : null;
    const dur = glide ? glide.total : outSpan / outRate;   // output seconds
    const inPerOut = glide ? 1 / glideQ : rate / outRate;  // next song's seconds per playing song's

    // outgoing mix-out point (naturalMixOut: at the song's end); the ramp before it has to fit too
    const first = earliest + rampSongSec;
    const v2 = adv();
    let mixOut = naturalMixOut(fromGrid, v2 ? musicEnd(cur) : cur, outSpan);
    // Automix v2: where the blend sits, from the playing song's own shape (versions.md "Where the blend sits")
    const anchor = v3 && !forced && !curator ? anchoredMixOut(cur, fromGrid, outSpan, Math.max(first, pos + rampSongSec)) : null;
    if (anchor) mixOut = anchor.mixOut;
    if (curator) {
      // the downbeat (on the song's end grid) nearest 31 s before its music ends; too early to reach: the usual blend
      const t = musicEnd(cur).durationSec - CURATOR_LEAD_SEC;
      mixOut = fromGrid.downbeatSec + Math.round((t - fromGrid.downbeatSec) / fromGrid.barSec) * fromGrid.barSec;
      if (mixOut < Math.max(first, pos + rampSongSec)) return usual();
    }
    if (mixOut < pos + rampSongSec) mixOut = phraseAtOrAfter(fromGrid, first);   // too late for the natural point: the next phrase
    if (mixOut < first) mixOut = downbeatAtOrAfter(fromGrid, first);
    // the editor's window (editor.md §6): A's mix-out on A's end grid, clamped to what can still play
    const wOut = resolveWindow(pick?.window?.out, fromGrid);
    if (wOut && wOut.sec < first - 0.01) warnings.push(playedNote(wOut.sec));
    else if (wOut) mixOut = clampWindow(wOut.sec, first, Math.max(first, Math.min(musicEnd(cur).durationSec, cur.durationSec - 0.3) - outSpan), 'the mix-out', warnings, fromGrid);
    if (wOut?.moved) warnings.push('the mix-out moved with a new beat grid');
    if (mixOut + outSpan > cur.durationSec - 0.3) {
      if (forced) { warnings.push('too close to the end for the window asked for'); return overlap(cur, next, fromGrid, pick, earliest, 'too close to the end for a blend', warnings); }
      if (v3) return handoff(cur, next, earliest, 'too close to the end for a blend');
      return filterMix(cur, next, fromGrid, toGrid, bars, pos, earliest, 'too close to the end for a blend');
    }

    // incoming mix-in point: so that its pre-full-energy phrase lands at the blend's end
    const introEnd = next.introEndSec ?? 0;
    const fullEnergyPhrase = phraseAtOrAfter(toGrid, Math.max(introEnd, toGrid.downbeatSec));
    let mixIn = fullEnergyPhrase - outSpan * inPerOut;
    const introShort = mixIn < toGrid.downbeatSec - 1e-6;   // no intro the whole blend can sit on
    if (mixIn < toGrid.downbeatSec) mixIn = toGrid.downbeatSec;

    // AutoDJ (version 2): no further than a quarter into the next song, and
    // a blend point where the two songs don't sing over each other.
    let dj = null;
    const wIn = resolveWindow(pick?.window?.in, toGrid);
    if (wIn) {
      mixIn = clampWindow(wIn.sec, 0, Math.max(0, next.durationSec - 10 - outSpan * inPerOut), 'the mix-in', warnings, toGrid);
      if (wIn.moved) warnings.push('the mix-in moved with a new beat grid');
    }
    if (curator) {
      // B comes in as the planner places it (its cue, at most a quarter in); both singing over more
      // than V2_CLASH_MAX of the 8 bars, or no intro to blend over: the usual blend (fallback 2)
      mixIn = capIncomingSkip(next, toGrid, mixIn);
      const clash = vocalOverlap(cur, next, mixOut, outSpan, mixIn, inPerOut, { out: lyricSpans(cur), in: lyricSpans(next) }) ?? 0;
      if (introShort || clash > V2_CLASH_MAX) return usual();
      dj = { clash, rerouted: null, by: null, mixOut, mixIn };
    } else if (v2 && !wIn && !wOut) {
      mixIn = capIncomingSkip(next, toGrid, mixIn);
      dj = rerouteForVocals(cur, next, fromGrid, toGrid, mixOut, mixIn, outSpan, inPerOut, Math.max(first, pos + rampSongSec));
      mixOut = dj.mixOut;
      mixIn = dj.mixIn;
    }
    // v2: the bass changes hands on a bar where the playing song isn't mid-line
    const swap = v3 && effBars >= 2 ? vocalSafeSwap(cur, mixOut, outSpan, effBars) : null;

    // v2's fallback ladder for a pair that beatmatches but can't blend (Orchard: a
    // drop-in, then a muffle; else it does nothing): both would sing over the blend,
    // or the next song has no intro to blend over.
    let shape = null, shapeWhy = null, muffleLead = null;
    if (forced && v3) {
      const both = dj ? dj.clash : vocalOverlap(cur, next, mixOut, outSpan, mixIn, inPerOut, { out: lyricSpans(cur), in: lyricSpans(next) });
      if (!dj) dj = { clash: both ?? 0, rerouted: null, by: null };
      if ((both ?? 0) > V2_CLASH_MAX) warnings.push(`both sing over ${Math.round(both * 100)}% of the window`);
      if (introShort && !wIn) warnings.push('no intro in the next song to blend over');
    }
    if (v3 && !forced && (introShort || (dj?.clash ?? 0) > V2_CLASH_MAX)) {
      const why = introShort ? 'no intro in the next song to blend over' : `both would sing ${Math.round((dj?.clash ?? 0) * 100)}% of a blend`;
      const avoid = avoidedMove();   // an effect heard twice running isn't picked a third time
      const sung = { out: lyricSpans(cur), in: lyricSpans(next) };
      // drop-in: the next song on its first downbeat at full level, two bars over the
      // playing song's exit, which may not cut a line (exit at most 12 s of music earlier)
      const dSpan = DROP_IN_BARS * fromGrid.barSec;
      const dGlide = glideQ ? glideSteps(glideQ, DROP_IN_BARS * 4, fromGrid.beatSec) : null;
      const lo = Math.max(first, pos + rampSongSec);
      const natural = naturalMixOut(fromGrid, musicEnd(cur), dSpan);
      for (let k = 0; avoid !== 'dropin' && k * fromGrid.barSec <= MAX_DISCARD_SEC; k++) {
        const o = natural - k * fromGrid.barSec;
        if (o < lo) break;
        const cut = voiceRisk(cur, o + dSpan - 1.5, o + dSpan, sung.out);
        if (cut != null && cut >= SWAP_CLEAR && !singsOut(cur, o + dSpan, sung.out)) continue;
        const both = vocalOverlap(cur, next, o, dSpan, toGrid.downbeatSec, inPerOut, sung);
        if ((both ?? 0) > V2_CLASH_MAX) continue;
        const dDur = dGlide ? dGlide.total : dSpan / outRate;
        return {
          style: 'blend', shape: 'dropin', fallback: false,
          reason: `${why}: a drop-in on the next song's first beat${k ? ` (exit ${k} bar${k === 1 ? '' : 's'} earlier, off a sung line)` : ''}`,
          v2, clash: both ?? 0, rerouted: null, vocalsBy: dj?.by ?? null, keyClash,
          subBassContrast: contrast, swapAt: null, swapMoved: null, glide: dGlide ? { q: glideQ, beats: DROP_IN_BARS * 4, beatOutSec: fromGrid.beatSec } : null,
          harmonic, trim: dropInTrim(loudnessTrim(cur, o, dSpan, next, toGrid.downbeatSec, dSpan * inPerOut)),
          mixOutTrackTime: o, durationSec: dDur, mixInTrackTime: toGrid.downbeatSec, rate: dGlide ? dGlide.inRate[0] : rate,
          outRate, rampBeats, rampSongSec, beatSec: fromGrid.beatSec,
          bars: DROP_IN_BARS, swapDb: SHORT_BLEND_KILL_DB,
          barSec: dGlide ? dDur / DROP_IN_BARS : fromGrid.barSec / outRate, bpm: dGlide ? fromGrid.bpm * Math.sqrt(glideQ) : fromGrid.bpm * outRate, outBpm: fromGrid.bpm, inBpm: toGrid.bpm,
        };
      }
      // muffle (Orchard muffle.js): the playing song keeps its level while a low-pass
      // closes over it, the next fades in over the bars before the bass swap and
      // takes the bass on it; the muffled song is gone two beats later
      const B = effBars * 4, at = swap?.at ?? 0.5;
      const leadBeats = Math.min(MUFFLE_LEAD_BEATS, Math.round(at * B));
      const lead = leadBeats / B;
      const inAt = (f) => mixIn + f * outSpan * inPerOut;
      const body = bassMean(cur, mixOut, mixOut + at * outSpan);
      const swapsSingers = (voiceRisk(cur, mixOut + at * outSpan - 0.5, mixOut + at * outSpan + 0.5, sung.out) ?? 0) >= 0.5
        && (voiceRisk(next, inAt(at) - 0.5, inAt(at) + 0.5, sung.in) ?? 0) >= 0.7;
      if (avoid !== 'muffle' && !introShort && leadBeats >= MUFFLE_MIN_LEAD_BEATS && at + MUFFLE_EXIT_BEATS / B <= 1 + 1e-6
        && (body == null || body >= MUFFLE_MIN_BODY) && inAt(at - lead) >= MUFFLE_MIN_OPENING_SEC && !swapsSingers) {
        shape = 'muffle'; muffleLead = lead;
        shapeWhy = `${why}: a muffle (the playing song closes behind a low-pass)`;
      } else {
        return handoff(cur, next, earliest, `${why} and no drop-in or muffle fits`);
      }
    }

    return {
      style: 'blend', fallback: false, reason: shapeWhy,
      ...(shape ? { shape, muffleLead } : {}),
      v2, clash: dj?.clash ?? 0, rerouted: dj?.rerouted ?? null, vocalsBy: dj?.by ?? null, keyClash,
      ...(anchor ? { anchor: { kind: anchor.kind, sec: anchor.sec, score: anchor.score } } : {}),
      ...(curator ? { curator: true } : {}),
      glide: glide ? { q: glideQ, beats: effBars * 4, beatOutSec: fromGrid.beatSec } : null,
      ...(v3 ? { subBassContrast: contrast, swapAt: swap?.at ?? null, swapMoved: swap?.moved ?? null,
        harmonic, trim: loudnessTrim(cur, mixOut, outSpan, next, mixIn, outSpan * inPerOut) } : {}),
      mixOutTrackTime: mixOut, durationSec: dur, mixInTrackTime: mixIn, rate: glide ? glide.inRate[0] : rate,
      outRate, rampBeats, rampSongSec, beatSec: fromGrid.beatSec,
      bars: effBars, swapDb: effBars >= FULL_SWAP_MIN_BARS ? KILL_DB : SHORT_BLEND_KILL_DB,
      barSec: glide ? dur / effBars : fromGrid.barSec / outRate, bpm: glide ? fromGrid.bpm * Math.sqrt(glideQ) : fromGrid.bpm * outRate, outBpm: fromGrid.bpm, inBpm: toGrid.bpm,
    };
  }

  // The phone's DJ_FILTER: incoming on its own downbeat at its own tempo,
  // low-passed; outgoing drains through a rising high-pass; bass swaps in one bar.
  function filterMix(cur, next, fromGrid, toGrid, requested, pos, earliest, reason, anchorLo = null) {
    let bars = Math.min(requested, FILTER_MAX_BARS);
    let dur = bars * fromGrid.barSec;
    const v2 = adv();
    let mixOut = naturalMixOut(fromGrid, v2 ? musicEnd(cur) : cur, dur);
    // Automix v2's own filter mix (a tempo gap): placed as its blend is (versions.md "Where the blend sits")
    const anchor = anchorLo != null ? anchoredMixOut(cur, fromGrid, dur, anchorLo) : null;
    if (anchor) mixOut = anchor.mixOut;
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
      ...(anchor ? { anchor: { kind: anchor.kind, sec: anchor.sec, score: anchor.score } } : {}),
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

  // ───────── Automix v2: keys, loudness, kick lock (Orchard) ─────────
  // Keys (pairTempoHarmony.js): the two songs' keys on Orchard's table, 0.7 of
  // the score, and their whole-song pitch profiles (cosine), 0.3. With both
  // keys trusted (0.65), a score under 0.2 is a severe clash (no beatmatched
  // blend: the hand-over), under 0.55 a short blend.
  const KEY_ROOTS = { C: 0, 'B#': 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4, F: 5, 'E#': 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11, CB: 11 };
  const TRUSTED_KEY = 0.65;
  function parsedKey(name) {
    const m = String(name || '').trim().match(/^(\S+)\s+(major|minor)$/i);
    const root = m ? KEY_ROOTS[m[1].toUpperCase().replace('♯', '#').replace('♭', 'B')] : undefined;
    return root === undefined ? null : { root, mode: m[2].toLowerCase() };
  }
  function keyRelationship(a, b) {
    if (!a || !b) return null;
    const cw = (b.root - a.root + 12) % 12, d = Math.min(cw, 12 - cw);
    if (a.mode !== b.mode) {
      if ((a.mode === 'major' && cw === 9) || (a.mode === 'minor' && cw === 3)) return 0.95;   // relative
      return d === 0 ? 0.7 : d === 5 ? 0.55 : d === 6 ? 0.05 : 0.35;
    }
    return d === 0 ? 1 : d === 5 ? 0.85 : d === 2 ? 0.65 : d === 1 ? 0.3 : d === 6 ? 0 : 0.45;
  }
  function cosine(a, b) {
    if (!Array.isArray(a) || a.length !== 12 || !Array.isArray(b) || b.length !== 12) return null;
    let dot = 0, pa = 0, pb = 0;
    for (let k = 0; k < 12; k++) { dot += a[k] * b[k]; pa += a[k] * a[k]; pb += b[k] * b[k]; }
    return pa > 0 && pb > 0 ? clamp(dot / Math.sqrt(pa * pb), 0, 1) : null;
  }
  function harmonicEvidence(a, b) {
    const keyScore = keyRelationship(parsedKey(a.keyName), parsedKey(b.keyName));
    const chromaScore = cosine(a.chroma, b.chroma);
    const score = keyScore != null && chromaScore != null ? keyScore * 0.7 + chromaScore * 0.3 : keyScore ?? chromaScore ?? 0.5;
    const confidence = Math.sqrt(clamp(a.keyConfidence || 0, 0, 1) * clamp(b.keyConfidence || 0, 0, 1));
    const r = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    return {
      score: r(score), confidence: r(confidence), keyScore: r(keyScore), chromaScore: r(chromaScore),
      severeClash: confidence >= TRUSTED_KEY && score < 0.2, short: confidence >= TRUSTED_KEY && score < 0.55,
    };
  }
  // Where two songs meet (localHarmony.js): each side's pitch profile over at
  // least 24 s (a key, not the passing chord), correlated; a side without a
  // clear pitch (drums) can't clash. A semitone, tritone or major third apart
  // (-0.3 or under) with both sides tonal is a clash. null: no chroma.
  const CLASH_CORRELATION = -0.3, CLASH_CONFIDENCE = 0.5, KEY_CONTEXT_SEC = 24;
  function chromaProfile(a, from, to) {
    const c = a?.chromaCurve;
    if (!c?.values?.length || !(to >= from)) return null;
    const profile = new Array(12).fill(0);
    let weight = 0, frames = 0;
    for (let i = 0; i < c.values.length; i++) {
      const t = c.start + i * c.step, f = c.values[i];
      if (t < from || t > to || !f) continue;
      for (let k = 0; k < 12; k++) profile[k] += f[k] * c.weights[i];
      weight += c.weights[i]; frames++;
    }
    return frames ? { profile, weight: weight / frames } : null;
  }
  function pearson(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let cov = 0, pa = 0, pb = 0;
    for (let k = 0; k < a.length; k++) { cov += (a[k] - ma) * (b[k] - mb); pa += (a[k] - ma) ** 2; pb += (b[k] - mb) ** 2; }
    return pa > 0 && pb > 0 ? cov / Math.sqrt(pa * pb) : 0;
  }
  function tonality(side) {
    const total = side.profile.reduce((s, v) => s + v, 0);
    if (!(total > 0)) return 0;
    return clamp((Math.max(...side.profile) / (total / 12) - 1.3) / 0.4, 0, 1) * clamp(side.weight, 0, 1);
  }
  function overlapHarmony(cur, next, outFrom, outTo, inFrom, inTo) {
    const left = chromaProfile(cur, Math.min(outFrom, outTo - KEY_CONTEXT_SEC), outTo);
    const right = chromaProfile(next, inFrom, Math.max(inTo, inFrom + KEY_CONTEXT_SEC));
    if (!left || !right) return null;
    const confidence = Math.min(tonality(left), tonality(right)), correlation = pearson(left.profile, right.profile);
    return { correlation: Math.round(correlation * 1000) / 1000, confidence: Math.round(confidence * 1000) / 1000, severeClash: correlation <= CLASH_CORRELATION && confidence >= CLASH_CONFIDENCE };
  }

  // Loudness (Orchard loudness.rs, strategy.rs loudness_trim): a region's EBU
  // R128 gated loudness from the song's 100 ms K-weighted levels (400 ms
  // blocks, 75% overlap, gates at -70 LUFS and 10 LU under the mean). YouTube
  // plays every song at its own normalised level, so each region counts against
  // its whole song. More than 1 dB apart, the louder side is trimmed (at most
  // 6 dB): the playing song down towards the blend's end, or the next song
  // from under its level up to it, both on a smoothstep.
  const TRIM_TOLERANCE_DB = 1, TRIM_MAX_DB = 6;
  function regionLoudness(a, from, dur) {
    const c = a?.loudnessCurve;
    if (!c?.values?.length || !(dur > 0)) return null;
    const i0 = Math.max(0, Math.round((from - c.start) / c.step)), i1 = Math.min(c.values.length, Math.round((from + dur - c.start) / c.step));
    if (i1 <= i0) return null;
    const p = [];
    for (let i = i0; i < i1; i++) p.push(10 ** (c.values[i] / 10));
    const lufs = (x) => -0.691 + 10 * Math.log10(x + 1e-30), mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const blocks = [];
    for (let i = 0; i + 4 <= p.length; i++) blocks.push((p[i] + p[i + 1] + p[i + 2] + p[i + 3]) / 4);
    const loud = blocks.filter((x) => lufs(x) > -70);
    if (!loud.length) return Math.max(-70, lufs(mean(p)));   // (too short or quiet for the gates: its plain level)
    const rel = lufs(mean(loud)) - 10;
    return lufs(mean(loud.filter((x) => lufs(x) > rel)));
  }
  function loudnessTrim(cur, outFrom, outDur, next, inFrom, inDur) {
    const o = regionLoudness(cur, outFrom, outDur), i = regionLoudness(next, inFrom, inDur);
    const ow = regionLoudness(cur, 0, cur.durationSec), iw = regionLoudness(next, 0, next.durationSec);
    if (o == null || i == null || ow == null || iw == null) return null;
    const diff = (o - ow) - (i - iw), r = (v) => Math.round(v * 10) / 10;
    if (Math.abs(diff) <= TRIM_TOLERANCE_DB) return { diffDb: r(diff), outDb: 0, inDb: 0 };
    const t = r(Math.min(Math.abs(diff), TRIM_MAX_DB));
    return diff > 0 ? { diffDb: r(diff), outDb: -t, inDb: 0 } : { diffDb: r(diff), outDb: 0, inDb: -t };
  }
  // A blend's fader with its trim: the playing song from 1 to its trim, the next from its trim to 1.
  function trimmed(m, gIn, gOut) {
    const t = m?.trim;
    if (!t || (!t.outDb && !t.inDb)) return [gIn, gOut];
    const ss = (x) => x * x * (3 - 2 * x), gi = 10 ** (t.inDb / 20), go = 10 ** (t.outDb / 20);
    const along = (arr, f) => Float32Array.from(arr, (v, i) => v * f(arr.length > 1 ? i / (arr.length - 1) : 1));
    return [along(gIn, (x) => gi + (1 - gi) * ss(x)), along(gOut, (x) => 1 + (go - 1) * ss(x))];
  }

  // Kick lock (Orchard lock.rs): beat trackers put a beat tens of ms off its
  // kick, differently per song, and two kicks 30 ms apart flam. Over the blend
  // and 8 beats either side, each song's kick onsets (35-140 Hz level, 10 ms
  // smoothing, its rise over 10 ms, every 1 ms) are folded into 256 bins of the
  // playing song's beat; the next song's cue moves by the shift (under an
  // eighth of a beat) that lines its profile up, when the two match well (0.5)
  // and much better than as planned (by 0.2). Sides: { data, rate, origin }
  // (mono samples, their rate, the song second of data[0]).
  const KICK_HOP = 0.001, KICK_BINS = 256, KICK_CONTEXT_BEATS = 8, KICK_LIMIT = KICK_BINS / 8, KICK_MIN_MATCH = 0.5, KICK_MIN_GAIN = 0.2;
  function lowBiquad(x, type, f, sr) {
    const w = 2 * Math.PI * f / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    const b1 = type === 'lp' ? 1 - cw : -(1 + cw), b0 = Math.abs(b1) / 2, a0 = 1 + al;
    const B0 = b0 / a0, B1 = b1 / a0, B2 = b0 / a0, A1 = -2 * cw / a0, A2 = (1 - al) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = B0 * x[i] + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function kickOnsets(side, from, to) {
    const r = side.rate, a = Math.max(0, Math.floor((from - side.origin) * r)), b = Math.min(side.data.length, Math.ceil((to - side.origin) * r));
    if (b - a < r) return null;
    let x = side.data.subarray(a, b);
    for (const [t, f] of [['hp', 35], ['hp', 35], ['lp', 140], ['lp', 140]]) x = lowBiquad(x, t, f, r);
    const alpha = 1 - Math.exp(-1 / (0.010 * r)), step = Math.max(1, Math.round(KICK_HOP * r)), levels = [];
    let level = 0;
    for (let i = 0; i < x.length; i++) {
      level += alpha * (x[i] * x[i] - level);
      if (i % step === 0) levels.push(Math.log1p(level * 1e4));
    }
    const values = levels.map((v, i) => (i >= 10 ? Math.max(0, v - levels[i - 10]) : 0));
    const origin = side.origin + a / r;
    return (t) => { const i = Math.round((t - origin) / KICK_HOP); return i >= 0 && i < values.length ? values[i] : null; };
  }
  // A side for kickLock from decoded channels: downmixed, low-passed under
  // 400 Hz twice and kept every few samples (about 3 kHz), so the next song's
  // opening costs ~1.5 MB to hold until its blend.
  function kickSource(channels, rate, origin = 0, from = 0, to = Infinity) {
    const a = Math.max(0, Math.floor(from * rate)), b = Math.min(channels[0].length, Math.ceil(to * rate));
    const n = Math.max(0, b - a), mono = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[a + i] / channels.length;
    const low = lowBiquad(lowBiquad(mono, 'lp', 400, rate), 'lp', 400, rate);
    const step = Math.max(1, Math.floor(rate / 3000)), data = new Float32Array(Math.floor(n / step));
    for (let i = 0; i < data.length; i++) data[i] = low[i * step];
    return { data, rate: rate / step, origin: origin + a / rate };
  }
  // The two songs' second at output second t of a blend plan (before it: its first speed; after: its last).
  function blendClocks(m) {
    if (m.glide) {
      const G = glideSteps(m.glide.q, m.glide.beats, m.glide.beatOutSec), B = G.outRate.length;
      const along = (t, base, beatSec, rates, after) => {
        if (t < 0) return base + t * rates[0];
        if (t >= G.total) return base + B * beatSec + (t - G.total) * after;
        let k = 0;
        while (k + 1 < B && G.at[k + 1] <= t) k++;
        return base + k * beatSec + (t - G.at[k]) * rates[k];
      };
      return { D: G.total, inPerOut: G.beatInSec / m.glide.beatOutSec,
        out: (t) => along(t, m.mixOutTrackTime, m.glide.beatOutSec, G.outRate, G.outRate[B - 1]),
        in: (t) => along(t, m.mixInTrackTime, G.beatInSec, G.inRate, 1) };
    }
    const outRate = m.outRate || 1, rate = m.rate || 1;
    return { D: m.durationSec, inPerOut: rate / outRate, out: (t) => m.mixOutTrackTime + t * outRate, in: (t) => m.mixInTrackTime + t * rate };
  }
  // a blend's mix-in moves to the kicks unless the user placed it (editor.md §6)
  const kickLockAllowed = (m) => m?.style === 'blend' && !m.windowIn;
  function kickLock(m, outSide, inSide) {
    const interval = m.beatSec;
    if (m.windowIn) return { none: 'the mix-in was placed in the editor' };
    if (m.style !== 'blend' || !(interval > 0)) return null;
    const ck = blendClocks(m), context = KICK_CONTEXT_BEATS * interval;
    const outAt = kickOnsets(outSide, ck.out(-context) - 0.05, ck.out(ck.D + context) + 0.05);
    const inAt = kickOnsets(inSide, ck.in(-context) - 0.05, ck.in(ck.D + context) + 0.05);
    if (!outAt || !inAt) return { none: 'not enough audio' };
    const sums = [new Float64Array(KICK_BINS), new Float64Array(KICK_BINS)], counts = [new Uint32Array(KICK_BINS), new Uint32Array(KICK_BINS)];
    const steps = Math.floor((ck.D + 2 * context) / KICK_HOP);
    for (let s = 0; s < steps; s++) {
      const t = -context + s * KICK_HOP, o = ck.out(t);
      const ph = (o - m.mixOutTrackTime) / interval;
      const bin = Math.min(KICK_BINS - 1, Math.floor((ph - Math.floor(ph)) * KICK_BINS));
      const vo = outAt(o), vi = inAt(ck.in(t));
      if (vo != null) { sums[0][bin] += vo; counts[0][bin]++; }
      if (vi != null) { sums[1][bin] += vi; counts[1][bin]++; }
    }
    const profile = (k) => {
      const means = Array.from(sums[k], (v, i) => v / Math.max(1, counts[k][i]));
      const mean = means.reduce((s, v) => s + v, 0) / KICK_BINS, peak = Math.max(...means);
      return counts[k].every((c) => c > 0) && mean > 0 && peak > 2 * mean ? means.map((v) => v - mean) : null;
    };
    const L = profile(0), R = profile(1);
    if (!L || !R) return { none: 'no clear kick' };
    const norm = Math.sqrt(L.reduce((s, v) => s + v * v, 0) * R.reduce((s, v) => s + v * v, 0));
    if (!(norm > 0)) return { none: 'no clear kick' };
    const score = (sh) => { let s = 0; for (let b = 0; b < KICK_BINS; b++) s += L[b] * R[(((b + sh) % KICK_BINS) + KICK_BINS) % KICK_BINS]; return s / norm; };
    let best = 0;
    for (let sh = -KICK_LIMIT; sh <= KICK_LIMIT; sh++) if (score(sh) > score(best)) best = sh;
    const r = (v) => Math.round(v * 1000) / 1000, got = { score: r(score(best)), gain: r(score(best) - score(0)) };
    if (Math.abs(best) >= KICK_LIMIT || got.score < KICK_MIN_MATCH || got.gain < KICK_MIN_GAIN) return { none: 'the kicks already line up, or match too loosely', ...got };
    // positive: the next song's kick comes late, so its cue moves on
    return { shift: (best / KICK_BINS) * interval * ck.inPerOut, ...got };
  }

  // Loop mix or blend, Automix v2. A loop mix that passed its gates (its bars
  // instrumental by lyrics or vocal mask, tempos within 8%, sub-bass, keys)
  // keeps priority: the blend has to beat it by LOOP_MARGIN. A blend that
  // fell back (hand-over, bridge, drop-in, muffle) never does. Otherwise both
  // are scored as Orchard does (x0.82) on what differs: both singing at once
  // (its vocal score, weight 0.15), the keys (weight 0.13: the blend lays the
  // two songs' chords over each other, the loop's instrumental bars hold the
  // playing song's own, so it scores 1) and the length (weight 0.02).
  // LOOP_MARGIN is twice Orchard's loop cost (0.01, the price it puts on a
  // loop): the blend has to win by about as much as a fifth of a blend sung by
  // both songs, or a key score 0.19 worse on the loop's side.
  const LOOP_MARGIN = 0.02;
  function loopOrBlend(blend, loop) {
    if (version !== 3 || !loop || loop.none) return { loop: !!loop && !loop.none };
    if (!blend || blend.fallback || blend.style !== 'blend' || blend.shape) return { loop: true, why: 'the blend fell back' };
    const vocal = (clash) => 1 - Math.min(1, clash * 1.15) * 0.72;
    const length = (beats) => (beats === 16 ? 1 : beats === 8 ? 0.85 : beats === 32 ? 0.75 : 0.65);
    const score = (clash, keys, beats) => 0.82 * (0.15 * vocal(clash) + 0.13 * keys + 0.02 * length(beats));
    const b = score(blend.clash || 0, blend.harmonic?.score ?? 0.5, blend.bars * 4);
    const l = score(Math.min(loop.out.vocal ?? 0, loop.in.vocal ?? 0), 1, loop.totalBars * 4);
    const r = (v) => Math.round(v * 1e4) / 1e4;
    return { loop: b < l + LOOP_MARGIN, why: `loop ${r(l)} vs blend ${r(b)} (the blend needs ${LOOP_MARGIN} more)` };
  }

  // The song with its length cut to where its music ends (analysis
  // contentEndSec), when there's real silence after it; never over 20 s cut.
  function musicEnd(a) {
    const end = a.contentEndSec;
    if (!(end > 0) || end >= a.durationSec - 1) return a;
    return { ...a, durationSec: Math.max(end, a.durationSec - 20) };
  }

  // Automix v2, where the blend sits (versions.md "Where the blend sits"; Orchard
  // pairTransitionEvidence + track.rs, Prism SongShape.outroStartMs): candidates over
  // the playing song's last min(60 s, 40%), each a mix-out on its end grid, scored as
  // Orchard does; null when none fits (the natural point then).
  const ANCHOR_SEARCH_SEC = 60, ANCHOR_SEARCH_SHARE = 0.4, ANCHOR_SIDE_SEC = 2, ANCHOR_STEP_SEC = 0.5;
  const NOVELTY_MIN = 0.14, NOVELTY_MERGE_SEC = 4, AUDIBLE_SHARE = 0.1;
  const OUTRO_BELOW = 0.6, OUTRO_MIN_SEC = 6, OUTRO_NOT_BEFORE = 0.6, OUTRO_MAX_EARLY_SEC = 20;
  const ANCHOR_SOURCE = { change: 4, outro: 4, end: 3, downbeat: 2 };
  // the loudness curve as amplitude (0.1 s steps), mean over [from, to)
  function ampMean(a, from, to) {
    const c = a?.loudnessCurve;
    if (!c?.values?.length) return null;
    const i0 = Math.max(0, Math.floor((from - c.start) / c.step)), i1 = Math.min(c.values.length, Math.ceil((to - c.start) / c.step));
    if (i1 <= i0) return null;
    let s = 0;
    for (let i = i0; i < i1; i++) s += 10 ** (c.values[i] / 20);
    return s / (i1 - i0);
  }
  // the song's 85th-percentile second (amplitude): its usual level
  const levelCache = new WeakMap();
  function usualLevel(a) {
    if (levelCache.has(a.loudnessCurve)) return levelCache.get(a.loudnessCurve);
    const xs = [];
    for (let t = 0; t + 1 <= a.durationSec; t += 1) { const v = ampMean(a, t, t + 1); if (v != null) xs.push(v); }
    xs.sort((x, y) => x - y);
    const v = xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.85))] : null;
    levelCache.set(a.loudnessCurve, v);
    return v;
  }
  const meanOf = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  function anchoredMixOut(cur, g, span, lo) {
    if (!cur.loudnessCurve?.values?.length || !cur.bassCurve?.values?.length) return null;
    const level = usualLevel(cur);
    if (!(level > 0)) return null;
    const dur = cur.durationSec, sung = lyricSpans(cur);
    // the audible end: the last half second at a tenth of the usual level, within the music
    let audible = Math.min(musicEnd(cur).durationSec, dur - 0.3);
    while (audible > dur / 2 && (ampMean(cur, audible - ANCHOR_STEP_SEC, audible) ?? 0) < AUDIBLE_SHARE * level) audible -= ANCHOR_STEP_SEC;
    const from = Math.max(dur / 2, audible - Math.min(ANCHOR_SEARCH_SEC, ANCHOR_SEARCH_SHARE * dur));
    const E = (x, y) => Math.min(1.5, (ampMean(cur, x, y) ?? 0) / level);
    const L = (x, y) => Math.min(1.5, bassMean(cur, x, y) ?? 0);
    const V = (x, y) => voiceRisk(cur, x, y, sung) ?? 0;
    // how steady the energy is over [x, x + 2 s): 1 - 2 x its spread in half seconds
    const steady = (x) => { const e = [0, 1, 2, 3].map((k) => E(x + k * 0.5, x + k * 0.5 + 0.5)), m = meanOf(e); return clamp(1 - 2 * Math.sqrt(meanOf(e.map((v) => (v - m) ** 2))), 0, 1); };
    const nearestDownbeat = (t) => g.downbeatSec + Math.round((t - g.downbeatSec) / g.barSec) * g.barSec;
    const grid = clamp(cur.gridConfidence ?? 0, 0, 1);
    const cands = [];
    // a section change: Orchard's novelty (energy 0.55, low end 0.25, voice 0.2), the 2 s after against the 2 s before
    const frames = [];
    for (let t = from + ANCHOR_SIDE_SEC; t <= audible - ANCHOR_SIDE_SEC; t += ANCHOR_STEP_SEC) {
      const a0 = t - ANCHOR_SIDE_SEC, b1 = t + ANCHOR_SIDE_SEC;
      const n = Math.abs(E(t, b1) - E(a0, t)) / 1.5 * 0.55 + Math.abs(L(t, b1) - L(a0, t)) / 1.5 * 0.25 + Math.abs(V(t, b1) - V(a0, t)) * 0.2;
      frames.push({ t, n: clamp(n, 0, 1) });
    }
    const peaks = [];
    for (let i = 1; i < frames.length - 1; i++) {
      const f = frames[i];
      if (f.n < NOVELTY_MIN || f.n < frames[i - 1].n || f.n < frames[i + 1].n) continue;
      const last = peaks[peaks.length - 1];
      if (last && f.t - last.t < NOVELTY_MERGE_SEC) { if (f.n > last.n) peaks[peaks.length - 1] = f; continue; }
      peaks.push(f);
    }
    for (const p of peaks) {
      const end = nearestDownbeat(p.t), stab = Math.max(steady(p.t - ANCHOR_SIDE_SEC), steady(p.t));
      cands.push({ kind: 'change', sec: end, end, conf: clamp(p.n * 0.65 + grid * 0.2 + stab * 0.15, 0, 1), stab });
    }
    // the outro (Prism's finding): energy over 3 s under 0.6 of the body's median to the end, 6 s or
    // more; the blend ENDS on the phrase that opens it (else the first beat in it), so the next song
    // is in by the time the playing one drops. Its music doesn't count as cut.
    const secs = [];
    for (let t = 0; t + 1 <= audible; t += 1) secs.push(ampMean(cur, t, t + 1) ?? 0);
    const body = [...secs].sort((x, y) => x - y)[Math.floor(secs.length / 2)];
    const smooth = (i) => meanOf(secs.slice(Math.max(0, i - 1), Math.min(secs.length, i + 2)));
    let o = secs.length - 1;
    while (o >= 0 && smooth(o) < OUTRO_BELOW * body) o--;
    o++;
    let keepUntil = audible;   // the music a blend ending early cuts: up to the outro
    if (body > 0 && secs.length - o >= OUTRO_MIN_SEC && o >= OUTRO_NOT_BEFORE * dur && o >= audible - OUTRO_MAX_EARLY_SEC) {
      const phrase = g.downbeatSec + Math.floor((o + 2 * g.beatSec - g.downbeatSec) / g.phraseSec) * g.phraseSec;
      const start = o - phrase <= g.barSec ? phrase : g.downbeatSec + Math.ceil((o - g.downbeatSec) / g.beatSec) * g.beatSec;
      const drop = 1 - meanOf(secs.slice(o)) / body, stab = steady(start);
      cands.push({ kind: 'outro', sec: start, end: start, conf: clamp(drop * 0.65 + grid * 0.2 + stab * 0.15, 0, 1), stab });
      keepUntil = Math.min(audible, start);
    }
    // the end of the music (today's point), and each downbeat in the search as Orchard's downbeat evidence
    const natural = naturalMixOut(g, musicEnd(cur), span) + span;
    cands.push({ kind: 'end', sec: natural, end: natural, conf: 0.5, stab: steady(natural - ANCHOR_SIDE_SEC) });
    for (let t = g.downbeatSec + Math.ceil((from - g.downbeatSec) / g.barSec) * g.barSec; t <= audible; t += g.barSec) {
      const stab = steady(t - ANCHOR_SIDE_SEC);
      cands.push({ kind: 'downbeat', sec: t, end: t, conf: Math.min(0.6, grid * 0.35 + stab * 0.35 + (1 - V(t - 1, t + 1)) * 0.3), stab });
    }
    // Orchard's score; the blend must fit before the audible end, cut at most 12 s of the music before
    // the outro (all of it without one), start past half the song
    let best = null;
    for (const c of cands) {
      const start = c.end - span;
      const cut = Math.max(0, keepUntil - c.end);
      if (start < lo - 1e-6 || start < dur / 2 || c.end > audible + 1e-6 || c.end > dur - 0.3 || cut > MAX_DISCARD_SEC) continue;
      const risk = voiceRisk(cur, c.end - 1.5, c.end, sung);
      const clean = risk == null ? 0.35 : 1 - risk;
      const score = ANCHOR_SOURCE[c.kind] / 4 * 0.2 + c.conf * 0.55 + c.stab * 0.15 + clean * 0.1 - cut / MAX_DISCARD_SEC * 0.15;
      if (!best || score > best.score + 1e-9) best = { kind: c.kind, sec: Math.round(c.sec * 1000) / 1000, mixOut: start, score: Math.round(score * 1000) / 1000 };
    }
    return best;
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
    return Array.isArray(s) ? carveSung(s, a) : null;
  }
  // One lyrics lookup per song at a time: the loop mix's lookup and this one,
  // made at the same moment, share a single answer.
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
  // where neither knows. A mask value that isn't a number doesn't know either
  // (NaN gets past clamp's Math.min/Math.max, and voiceRisk read it as sung).
  function vocalAt(a, t, spans = null) {
    if (spans) return spans.some(([x, y]) => t >= x && t < y) ? 1 : 0;
    for (const w of a.vocals ?? []) {
      const i = Math.round((t - w.startSec) * w.fps);
      if (i >= 0 && i < w.curve.length) return Number.isFinite(w.curve[i]) ? w.curve[i] : null;
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

  // AutoMix's fallback: a plain equal-power fade of the user's crossfade length
  // (12 s when none is given), no beatmatch, no EQ.
  // BitChord web put it on the last 12 s before the outro; here, like the
  // blend, it ends with the song.
  // Automix v2's "beatmatch or do nothing" (Orchard's boundary hand-off): two
  // beats that can't be matched are never laid over each other. The playing
  // song runs to where its music ends and the next starts from its beginning,
  // with a short fade between (the fallback ladder adds more ways later).
  // Automix v2, a pair too far apart in tempo to beatmatch (versions.md "Tempo too far
  // apart"): the beatless bridge, else a filter mix at an anchor, else (both would sing
  // over the filter mix) an echo out at one, else the hand-over.
  function unmatchedMix(cur, next, fromGrid, toGrid, pos, earliest, why) {
    const b = beatlessBridge(cur, next);
    if (!b.none && b.mixOut >= earliest) return handoff(cur, next, earliest, why);
    const lo = Math.max(earliest, pos), avoid = avoidedMove();
    const f = filterMix(cur, next, fromGrid, toGrid, requestedBars(cur, next, fromGrid, toGrid.downbeatSec, true), pos, earliest, `${why}: a filter mix (no beat match)`, lo);
    if (f.style === 'filter' && f.clash <= V2_CLASH_MAX && avoid !== 'filter') return f;
    const sang = f.style !== 'filter' ? '' : avoid === 'filter' ? ', a filter mix the last two times' : f.clash > V2_CLASH_MAX ? `, both would sing ${Math.round(f.clash * 100)}% of a filter mix` : '';
    const e = avoid === 'echo' ? null : echoOut(cur, next, fromGrid, toGrid, lo, `${why}${sang}: an echo out (no beat match)`);
    return e ?? handoff(cur, next, earliest, `${why}${sang}, and no ${avoid === 'echo' ? 'third echo out in a row or ' : ''}filter mix or echo out fits`);
  }
  // Echo out (Prism MixMoves ECHO_OUT; editor.md §5): the beat before the catch (a bar line,
  // at an anchor) is fed to a 1-beat delay with feedback 0.53; the playing song's dry sound is
  // cut on the catch in 10 ms and the next song comes in there at full level on its first
  // downbeat (its first 10 s; else from its start), at its own speed, under 8 beats of echo.
  // The repeated beat may not be sung; at most 12 s of music earlier than the anchor.
  const ECHO_BEATS = 8, ECHO_FEEDBACK = 0.53, ECHO_CUT_SEC = 0.01, ECHO_FIRST_BEAT_MAX_SEC = 10;
  function echoOut(cur, next, g, toGrid, lo, reason) {
    const beat = g.beatSec, D = ECHO_BEATS * beat, sung = lyricSpans(cur);
    const end = Math.min(musicEnd(cur).durationSec, cur.durationSec - 0.3);
    const a = anchoredMixOut(cur, g, beat, lo);
    const bar = (t) => g.downbeatSec + Math.floor((t - g.downbeatSec + 1e-6) / g.barSec) * g.barSec;
    const first = a ? bar(a.mixOut + beat) : bar(end - beat);
    // the anchor's bar, then the nearest bars either side (earlier first), within 12 s of it
    for (let j = 0; j <= 2 * Math.floor(MAX_DISCARD_SEC / g.barSec); j++) {
      const k = j % 2 ? (j + 1) / 2 : -j / 2;   // 0, 1, -1, 2, -2, ...: k bars earlier
      const c = first - k * g.barSec;
      if (c - beat < lo - 1e-6 || c < cur.durationSec / 2 || c + D > cur.durationSec - 0.3 || c > end) continue;
      if ((voiceRisk(cur, c - beat, c, sung) ?? 0) >= SWAP_CLEAR) continue;   // the beat that repeats is sung
      const mixIn = toGrid && toGrid.downbeatSec <= ECHO_FIRST_BEAT_MAX_SEC ? toGrid.downbeatSec : 0;
      return {
        style: 'blend', shape: 'echo', fallback: false,
        reason: `${reason}${k ? ` (${Math.abs(k)} bar${Math.abs(k) === 1 ? '' : 's'} ${k > 0 ? 'earlier' : 'later'}, off a sung beat)` : ''}`,
        v2: true, clash: 0, rerouted: null, vocalsBy: null, keyClash: null,
        ...(a ? { anchor: { kind: a.kind, sec: a.sec, score: a.score } } : {}),
        echo: { beats: ECHO_BEATS, delaySec: beat, feedback: ECHO_FEEDBACK, cutSec: ECHO_CUT_SEC },
        glide: null, subBassContrast: null, swapAt: null, swapMoved: null, harmonic: null, trim: null,
        mixOutTrackTime: c, durationSec: D, mixInTrackTime: mixIn, rate: 1,
        outRate: 1, rampBeats: 0, rampSongSec: 0, beatSec: beat,
        bars: ECHO_BEATS / 4, swapDb: 0, barSec: g.barSec, bpm: g.bpm, outBpm: g.bpm, inBpm: toGrid?.bpm ?? null,
      };
    }
    return null;
  }
  // Orchard singsOut (transitionFlow.js, the adlib outro): from `time` to the music's end the voice
  // never pauses 2 s for a line to finish, while the beat is gone over the last 4 s (beat presence
  // under 0.5 at 2 s and at 0.5 s before the end). Any exit cuts such a voice, the song's own end
  // included, so an exit may cut it (versions.md "Adlib outro").
  const SINGS_OUT_TAIL_SEC = 4, LINE_PAUSE_SEC = 2;
  function singsOut(a, time, spans = null) {
    const end = Math.min(musicEnd(a).durationSec, a.durationSec - 0.3);
    if (!(end - time >= SINGS_OUT_TAIL_SEC)) return false;
    const closing = beatPresence(a, end - SINGS_OUT_TAIL_SEC / 2);
    if (closing == null || closing >= 0.5 || (beatPresence(a, end - 0.5) ?? 1) >= 0.5) return false;
    let pause = 0;
    for (let at = time; at < end - 1; at += 0.25) {
      const r = voiceRisk(a, at, at + 0.5, spans);
      if (r == null) return false;
      pause = r < 0.3 ? pause + 0.25 : 0;
      if (pause >= LINE_PAUSE_SEC) return false;
    }
    return true;
  }
  // Prism MixMoves.pick: an effect move isn't heard a third time running (versions.md "No effect
  // three times in a row"). The mixes as heard (crossfade.js finishLive reports each mix that played, at its end), the last 16.
  const RECENT_MOVES = 16, EFFECT_MOVES = ['filter', 'echo', 'dropin', 'muffle'];
  const recentMoves = [];
  const moveOf = (p) => (!p ? null : p.style === 'filter' ? 'filter' : p.style === 'loop' ? 'loop' : p.style === 'blend' ? p.shape || 'blend' : 'crossfade');
  function heard(p) {
    const m = moveOf(p);
    if (!m) return;
    recentMoves.push(m);
    while (recentMoves.length > RECENT_MOVES) recentMoves.shift();
  }
  function avoidedMove() {
    const n = recentMoves.length, m = recentMoves[n - 1];
    return n >= 2 && EFFECT_MOVES.includes(m) && recentMoves[n - 2] === m ? m : null;
  }
  function handoff(cur, next, earliest, reason) {
    // first rung: the two songs' beatless edges, at any tempo
    const b = beatlessBridge(cur, next);
    if (!b.none && b.mixOut >= earliest) {
      return {
        style: 'crossfade', fallback: false, bridge: true, reason: `${reason}: a beatless bridge (${b.dur.toFixed(1)} s, no beat on either side)`,
        mixOutTrackTime: b.mixOut, durationSec: b.dur, mixInTrackTime: b.mixIn, rate: 1,
        bars: 0, swapDb: 0, barSec: 0, bpm: null, inBpm: null, trim: loudnessTrim(cur, b.mixOut, b.dur, next, b.mixIn, b.dur),
      };
    }
    const end = Math.min(musicEnd(cur).durationSec, cur.durationSec - 0.3);
    const mixOut = Math.max(earliest, end - V2_SWITCH_SEC);
    return {
      style: 'crossfade', fallback: false, handoff: true, reason: `${reason}, so a straight hand-over (no beatless bridge: ${b.none || 'past the playhead'})`,
      mixOutTrackTime: mixOut, durationSec: Math.max(0, end - mixOut), mixInTrackTime: 0, rate: 1,
      bars: 0, swapDb: 0, barSec: 0, bpm: null, inBpm: null,
    };
  }

  // Orchard beatPresence: 0 in a beatless passage, 1 once kick and bass are in
  // (bass curve: 0.1 of the song's usual level is none, 0.5 full). null: unmeasured.
  function bassMean(a, from, to) {
    const c = a?.bassCurve;
    if (!c?.values?.length) return null;
    const i0 = Math.max(0, Math.floor((from - c.start) / c.step)), i1 = Math.min(c.values.length - 1, Math.floor((to - c.start) / c.step));
    if (i1 < i0) return null;
    let s = 0;
    for (let i = i0; i <= i1; i++) s += c.values[i];
    return s / (i1 - i0 + 1);
  }
  const beatPresence = (a, t) => { const m = bassMean(a, t - 0.5, t + 0.5); return m == null ? null : clamp((m - 0.1) / 0.4, 0, 1); };
  function beatlessRun(a, from, limit, step) {
    let run = 0;
    for (let t = from; step > 0 ? t < limit : t > limit; t += step) {
      const p = beatPresence(a, t);
      if (p == null || p >= BEATLESS) break;
      run += Math.abs(step);
    }
    return run;
  }
  // Orchard beatlessBridge: the playing song's beatless ending under the next
  // one's beatless opening (4-12 s, both sides beatless throughout), so no beat
  // plays against another and the tempos need not match; the next song's beat
  // lands as the playing one ends. { mixOut, dur, mixIn } or { none: why }.
  function beatlessBridge(cur, next) {
    if (!cur.bassCurve || !next.bassCurve) return { none: 'no bass curves' };
    if (subBassContrast(cur, next) >= V2_SUB_BASS_VETO) return { none: 'the productions clash' };
    const end = Math.min(musicEnd(cur).durationSec, cur.durationSec - 0.3);
    const outRun = beatlessRun(cur, end - 0.125, end - BRIDGE_MAX_SEC, -0.25);
    const inRun = beatlessRun(next, 0.125, Math.min(next.durationSec || 60, 60), 0.25);
    if (Math.min(outRun, inRun) < BRIDGE_MIN_SEC) return { none: `beatless ending ${outRun} s, opening ${inRun} s` };
    const beat = cur.beatIntervalSec > 0 ? cur.beatIntervalSec : 0.5;
    const dur = Math.floor(Math.min(outRun, inRun, BRIDGE_MAX_SEC) / beat) * beat;
    if (dur < BRIDGE_MIN_SEC) return { none: 'beatless edges too short' };
    const skip = Math.min(Math.max(0, inRun - dur), BRIDGE_MAX_SKIP_SEC);
    const sung = { out: lyricSpans(cur), in: lyricSpans(next) };
    if ((vocalOverlap(cur, next, end - dur, dur, skip, 1, sung) ?? 0) > 0.25) return { none: 'voices meet over the bridge' };
    if ((voiceRisk(next, skip - 0.5, skip + 1, sung.in) ?? 0) >= 0.5) return { none: 'the next song would fade in mid-line' };
    const keys = overlapHarmony(cur, next, end - dur, end, skip, skip + dur);
    if (keys?.severeClash) return { none: `the keys clash where they meet (${keys.correlation})` };
    return { mixOut: end - dur, dur, mixIn: skip };
  }

  // Orchard's voice risk: the vocal mask's share mapped to 0..1 (lyric lines: sung or not).
  function voiceRisk(a, from, to, spans) {
    let sum = 0, n = 0;
    for (let t = from; t < to; t += 0.05) {
      const v = vocalAt(a, t, spans);
      if (v == null) continue;
      sum += spans ? v : clamp((v - 0.15) / 0.45, 0, 1);
      n++;
    }
    return n ? sum / n : null;
  }

  // Orchard chooseBassSwap, by the playing song's voice only (no bass curve
  // here): the swap sits on the bar nearest the middle; when the playing song
  // is mid-line there, it moves to the bar nearest the middle (a quarter to
  // three quarters in) where that song is clear. { at: fraction, moved }.
  function vocalSafeSwap(cur, mixOut, outSpan, bars) {
    const spans = lyricSpans(cur);
    const mid = clamp(Math.round(bars / 2), 1, bars - 1) / bars;
    const riskAt = (f) => voiceRisk(cur, mixOut + f * outSpan - 0.5, mixOut + f * outSpan + 0.5, spans);
    const here = riskAt(mid);
    if (here == null || here < SWAP_SINGING) return { at: mid, moved: null };
    const moves = [];
    for (let k = 1; k < bars; k++) {
      const f = k / bars;
      if (f < 0.25 || f > 0.75 || Math.abs(f - mid) < 1e-9) continue;
      const r = riskAt(f);
      if (r != null && r < SWAP_CLEAR) moves.push(f);
    }
    moves.sort((x, y) => Math.abs(x - 0.5) - Math.abs(y - 0.5) || x - y);
    if (!moves.length) return { at: mid, moved: 'sung at the middle, no clear bar' };
    const by = Math.round((moves[0] - mid) * bars);
    return { at: moves[0], moved: `off a sung line, ${by > 0 ? '+' : ''}${by} bar${Math.abs(by) === 1 ? '' : 's'}` };
  }

  function fallback(cur, next, earliest, reason) {
    const target = cur.durationSec - 0.3 - fallbackSec;
    const mixOut = Math.max(earliest, target);
    const dur = Math.max(0, Math.min(fallbackSec, cur.durationSec - 0.3 - mixOut));
    return {
      style: 'crossfade', fallback: true, reason,
      mixOutTrackTime: mixOut, durationSec: dur, mixInTrackTime: next.introEndSec ?? 0, rate: 1,
      bars: 0, swapDb: 0, barSec: 0, bpm: null, inBpm: null,
    };
  }

  // ───────── curves: what each deck does over the transition ─────────
  // spec/automix/plan.schema.json "curves". The engine (crossfade.js) plays
  // these same shapes (djShape below, loopSchedule), so the overview and the
  // phone app can draw a transition without knowing how it was made.
  // Each curve is [[t, v], …] in seconds from the transition's start (t = 0:
  // the mix-out, or the outgoing loop's start), held before its first point and
  // after its last; linear between points (Hz: geometric), a step is two
  // points at one t. A curve that is absent stays neutral.
  // (a value that is not a number reads as lo: Math.max/min let NaN through, and a NaN filter aim throws in setValueAtTime)
  const clamp = (x, lo, hi) => (Number.isNaN(x) ? lo : Math.min(hi, Math.max(lo, x)));
  const glideTo = (a, b, x) => a * Math.pow(b / a, clamp(x, 0, 1));
  const bassCutHz = (x) => glideTo(20, 200, x);
  const entryHp = (p, top, openBy) => (p >= openBy ? 20 : glideTo(20, top, Math.pow(1 - p / openBy, 0.35)));
  const DECK_GLIDE_STEP = 0.0025, DECK_GLIDE_STEP_SEC = 0.25;   // the incoming deck's glide back to x1.0 (crossfade.js deckGlideBack)

  // AutoDJ's (version 2) fader and filters for a blend or filter mix of D
  // seconds, sampled at n points over p = 0..1. The clash (the share both
  // sing, from the plan) deepens the filters and moves the fader towards a
  // vocal-safe pair.
  function djShape(m, style, D, n) {
    if (style === 'blend' && (m.shape === 'dropin' || m.shape === 'muffle' || m.shape === 'echo')) return ladderShape(m, D, n);
    const clash = clamp(m.clash || 0, 0, 1);
    const beat = m.bpm > 0 ? 60 / m.bpm : 0;
    const grid = beat ? D / beat : 0;   // beats in the blend
    const onBar = (f) => (grid >= 8 ? clamp(Math.round((f * grid) / 4) * 4 / grid, 4 / grid, 1 - 4 / grid) : f);
    const w = grid >= 2 ? 0.5 / grid : 0.2;
    const swapAt = m.swapAt > 0 && m.swapAt < 1 ? m.swapAt : onBar(0.5);
    const h = (p) => clamp((p - (swapAt - w)) / w, 0, 1);
    const S = Math.PI / 2;
    let inHp, outHp, outLp, rise, fall;
    if (style === 'filter') {
      const top = glideTo(1200, 2400, clash), openBy = onBar(0.6 + 0.18 * clash);
      outLp = (p) => glideTo(7000, 300, Math.pow(p, 0.75));
      outHp = (p) => bassCutHz(h(p));
      inHp = (p) => Math.max(entryHp(p, top, openBy), bassCutHz(1 - h(p)));
      rise = (p) => Math.sin(Math.pow(p, 0.8) * S);
      fall = (p) => Math.cos(Math.pow(p, 1.6) * S);
    } else {
      const top = glideTo(520, 950, clash), openBy = onBar(0.45 + 0.25 * clash);
      const from = onBar(0.3 - 0.18 * clash), floor = glideTo(2200, 1100, clash);
      const fallFrom = Math.max(0, Math.min(swapAt, 0.5, grid ? 1 - 4 / grid : 0.5));
      outLp = (p) => glideTo(20000, floor, (p - from) / (1 - from));
      outHp = (p) => bassCutHz(h(p));
      inHp = (p) => Math.max(bassCutHz(1 - h(p)), entryHp(p, top, openBy));
      const held = (plain, dj) => plain + (dj - plain) * (1 - clash);
      rise = (p) => held(Math.sin(p * S), Math.sin(clamp(p / swapAt, 0, 1) * S));
      fall = (p) => held(Math.cos(p * S), p <= fallFrom ? 1 : Math.cos(((p - fallFrom) / (1 - fallFrom)) * S));
    }
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
    return { D, style, gIn, gOut, inHp: mk(inHp), outHp: mk(outHp), outLp: mk(outLp) };
  }

  // Automix v2's fallback ladder shapes (Orchard). Drop-in: the next song at full
  // level on its first beat (20 ms), its bass with it; the playing song closes and
  // fades over the two bars. Muffle: the playing song holds its level while its
  // low-pass closes (18 kHz -> 300 Hz) over the lead before the bass swap; the
  // next fades in over the same bars, takes the bass on the swap, and the playing
  // song is gone two beats after it.
  function ladderShape(m, D, n) {
    const S = Math.PI / 2, beats = Math.max(1, (m.bars || 1) * 4);
    let gIn, gOut, inHp, outHp, outLp;
    if (m.shape === 'echo') {
      // echo out: the playing song's dry sound cut on the catch (10 ms), the next song in at full
      // level with it; the echo (crossfade.js, the outgoing deck's delay line) rings on over it
      const e = Math.min((m.echo?.cutSec ?? ECHO_CUT_SEC) / D, 0.05);
      gIn = (p) => clamp(p / e, 0, 1);
      gOut = (p) => 1 - clamp(p / e, 0, 1);
      outLp = () => 20000;
      outHp = () => 20;
      inHp = () => 20;
    } else if (m.shape === 'dropin') {
      const e = Math.min(0.02 / D, 0.05);
      gIn = (p) => clamp(p / e, 0, 1);
      gOut = (p) => Math.cos(p * S);
      outLp = (p) => glideTo(18000, 2000, p);
      outHp = (p) => bassCutHz(clamp(p / e, 0, 1));
      inHp = () => 20;
    } else {
      const at = m.swapAt > 0 && m.swapAt < 1 ? m.swapAt : 0.5, from = Math.max(0, at - (m.muffleLead || 0.25));
      const exit = Math.min(1, at + MUFFLE_EXIT_BEATS / beats), w = 0.5 / beats;
      const h = (p) => clamp((p - at) / w, 0, 1);
      gOut = (p) => (p <= at ? 1 : Math.cos(clamp((p - at) / (exit - at), 0, 1) * S));
      gIn = (p) => Math.sin(clamp((p - from) / (at - from), 0, 1) * S);
      outLp = (p) => glideTo(18000, 300, (p - from) / (at - from));
      outHp = (p) => bassCutHz(h(p));
      inHp = (p) => bassCutHz(1 - h(p));
    }
    const mk = (f) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
    return { D, style: 'blend', gIn: mk(gIn), gOut: mk(gOut), inHp: mk(inHp), outHp: mk(outHp), outLp: mk(outLp) };
  }

  // the incoming deck's glide back to x1.0 after a blend at [rate]: [seconds, steps]
  function glideBack(rate) {
    if (Math.abs(rate - 1) < 0.002) return null;
    const n = Math.ceil(Math.abs(rate - 1) / DECK_GLIDE_STEP);
    return { n, sec: n * DECK_GLIDE_STEP_SEC };
  }

  // sampled shape → points over 0..D (about 8 a second, at least 65)
  const pointsOf = (arr, D) => Array.from(arr, (v, i) => [(D * i) / (arr.length - 1), v]);
  const curveSamples = (D) => Math.max(65, Math.ceil(D * 8) + 1);
  const equalPower = (n, rising) => Float32Array.from({ length: n }, (_, i) => (rising ? Math.sin : Math.cos)((i / (n - 1)) * Math.PI / 2));

  // A blend, filter mix or crossfade plan's curves.
  function blendCurves(m) {
    const D = m.durationSec, style = m.style;
    // the songs' own speeds (spotify-mixes.md rule 10): B's glide back ends at it, not x1
    const sIn = m.speedIn > 0 ? m.speedIn : 1, sOut = m.speedOut > 0 ? m.speedOut : 1;
    const out = {}, inn = {};
    if (m.v2 && style !== 'crossfade') {
      const s = djShape(m, style, D, curveSamples(D));
      const [gIn, gOut] = trimmed(m, s.gIn, s.gOut);
      out.gain = pointsOf(gOut, D); inn.gain = pointsOf(gIn, D);
      out.lowpassHz = pointsOf(s.outLp, D); out.highpassHz = pointsOf(s.outHp, D);
      inn.highpassHz = pointsOf(s.inHp, D);
    } else {
      const [gIn, gOut] = trimmed(m, equalPower(65, true), equalPower(65, false));
      out.gain = pointsOf(gOut, D); inn.gain = pointsOf(gIn, D);
      if (style !== 'crossfade') {
        // the bass swaps within one bar at the midpoint
        const mid = D / 2, bar = Math.min(m.barSec || 0, D / 2);
        inn.bassDb = [[0, m.swapDb], [mid - bar / 2, m.swapDb], [mid + bar / 2, 0]];
        out.bassDb = [[mid - bar / 2, 0], [mid + bar / 2, m.swapDb]];
        if (style === 'blend') { out.highDb = [[0, 0], [D, -8]]; inn.highDb = [[0, -8], [D, 0]]; }
        else { out.highpassHz = [[0, 20], [D, 1800]]; inn.lowpassHz = [[0, 350], [D, 20000]]; }
      }
    }
    // tempo: the playing song speeds up beat by beat before the mix-out (blend only)
    if (style === 'blend' && m.outRate > 1.0001 && m.rampBeats > 0) {
      const R = m.outRate, n = m.rampBeats, b = m.beatSec;
      let t = 0;
      for (let k = 1; k <= n; k++) t -= b / (1 + ((R - 1) * k) / n);
      const pts = [[t, 1]];
      for (let k = 1; k <= n; k++) {
        const r = 1 + ((R - 1) * k) / n, prev = pts[pts.length - 1][1];
        pts.push([t, prev], [t, r]);
        t += b / r;
      }
      pts.push([D, R]);
      out.rate = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    } else if (!m.glide && Math.abs((style === 'blend' ? m.outRate || 1 : sOut) - 1) > 1e-4) {
      // (A at a steady speed through the mix: its playlist speed, spotify-mixes.md rule 10)
      const R = style === 'blend' ? m.outRate : sOut;
      out.rate = [[0, R], [D, R]];
    }
    const rate = style === 'blend' ? m.rate : 1;
    if (style === 'blend' && m.glide) {
      // Automix v2's glide: both songs step once per beat, the next one ends at x1.0
      const G = glideSteps(m.glide.q, m.glide.beats, m.glide.beatOutSec);
      const steps = (rates) => rates.flatMap((r, k) => (k ? [[G.at[k], rates[k - 1]], [G.at[k], r]] : [[0, r]]));
      out.rate = [...steps(G.outRate), [D, G.outRate[G.outRate.length - 1]]];
      inn.rate = [...steps(G.inRate), [D, G.inRate[G.inRate.length - 1]], [D, sIn]];
    } else if (style === 'blend' && Math.abs(rate - 1) > 1e-9 && Math.abs(rate - sIn) > 1e-9) {
      const g = glideBack(1 + rate - sIn);
      inn.rate = g ? [[0, rate], [D, rate], [D + g.sec, sIn]] : [[0, rate], [D, rate], [D, sIn]];
    } else if (Math.abs(sIn - 1) > 1e-4) inn.rate = [[0, sIn], [D, sIn]];   // (B at its own speed throughout)
    return { durationSec: D, out, in: inn };
  }

  // ───────── the transition editor (spec/automix/editor.md) ─────────
  // A preset's (or custom lanes') curves over a window of D seconds, editor.md §3: points at a
  // fraction x of the window, given here in seconds. beatSec: the beat (null with beat match Off).
  const EDITOR_CUT_DB = -18 /* BASS_CUT_DB, declared further down */, LP_CLOSED = 400, HP_CLOSED = 1000, CUT_RAMP_SEC = 0.008;
  // Spotify's presets, as its mix editor shows them (editor.md §2); `smooth` is Spotify's Fade
  const PRESET_LANES = {
    smooth: { volume: 'smooth', eq: 'centerBassSwap', effect: 'none' },
    rise: { volume: 'overlap', eq: 'endBassSwap', effect: 'lpInHpOut' },
    wave: { volume: 'overlap', eq: 'centerBassSwap', effect: 'lpBoth' },
    blend: { volume: 'overlap', eq: 'threeBandFade', effect: 'none' },
    slam: { volume: 'centerCut', eq: 'none', effect: 'none' },
    melt: { volume: 'fadeInFadeOut', eq: 'centerBassSwap', effect: 'hpBoth' },
    afterglow: { volume: 'smooth', eq: 'centerBassSwap', effect: 'none', fx: 'reverbOutCenter' },
    surge: { volume: 'fadeInCutOut', eq: 'endBassSwap', effect: 'hpHalfOut', fx: 'reverbOutEnd' },
    dissolve: { volume: 'fadeInCutOut', eq: 'endBassSwap', effect: 'hpHalfOut', fx: 'echoHalfOutEnd' },
  };
  const PRESET_BARS = {};   // (no preset sets a length: Spotify's show the pair's own)
  // none: Spotify's No transition, the playing song to its end and the next from its start
  const PRESET_NAMES = ['smooth', 'rise', 'wave', 'blend', 'slam', 'melt', 'afterglow', 'surge', 'dissolve', 'none', 'loop', 'custom'];
  const LANE_VALUES = {
    volume: ['smooth', 'crossfade', 'overlap', 'cutInFadeOut', 'fadeInCutOut', 'centerCut', 'fadeInFadeOut', 'fadeInFastOut', 'fadeIn1BarCutOut', 'overlap1BarCutOut'],
    eq: ['centerBassSwap', 'endBassSwap', 'threeBandFade', 'quickBassCut', 'none', 'startBassSwap', 'longBassCut', 'bassFadeOut'],
    effect: ['none', 'lpOut', 'hpIn', 'lpBoth', 'hpBoth', 'lpInHpOut', 'hpOut', 'lpIn', 'hpInLpOut', 'hpHalfOut', 'noiseOutEnd'],
    // editor.md §13: A loops its first N beats of the window (a shape only, never drawn)
    looping: ['none', 'loop1', 'loop2', 'loop4', 'loop8', 'loop16'],
    fx: ['none', 'echo1CutEnd', 'echo34CutEnd', 'echoHalfCutEnd', 'echo1OutEnd', 'echo34OutEnd', 'echoHalfOutEnd', 'delay34CutEnd', 'delayHalfCutEnd', 'reverbCutEnd', 'reverbOutEnd', 'reverbOutCenter'],
  };
  // editor.md §12 rule 4: the Effects shapes, a send on the outgoing deck (x a fraction of the window)
  const FX_CUT = [[0.75, 0], [1, 0.5]], FX_OUT = [[0.5, 0], [1, 0.5]];
  const FX_SHAPES = {
    echo1CutEnd: { send: 'echoSend', curve: FX_CUT, beats: 1 }, echo34CutEnd: { send: 'echoSend', curve: FX_CUT, beats: 0.75 }, echoHalfCutEnd: { send: 'echoSend', curve: FX_CUT, beats: 0.5 },
    echo1OutEnd: { send: 'echoSend', curve: FX_OUT, beats: 1 }, echo34OutEnd: { send: 'echoSend', curve: FX_OUT, beats: 0.75 }, echoHalfOutEnd: { send: 'echoSend', curve: FX_OUT, beats: 0.5 },
    delay34CutEnd: { send: 'delaySend', curve: FX_CUT, beats: 0.75 }, delayHalfCutEnd: { send: 'delaySend', curve: FX_CUT, beats: 0.5 },
    reverbCutEnd: { send: 'reverbSend', curve: FX_CUT }, reverbOutEnd: { send: 'reverbSend', curve: FX_OUT },
    reverbOutCenter: { send: 'reverbSend', curve: [[0.25, 0], [0.5, 0.5], [0.75, 0]] },
  };
  const FX_ECHO_BEATS = 0.75, FX_DELAY_BEATS = 0.5;
  const OPTIONAL_LANES = ['fx', 'looping'];
  const LOOP_BEATS = { loop1: 1, loop2: 2, loop4: 4, loop8: 8, loop16: 16 };
  // the echo's and the delay's time in seconds (§12 rule 3)
  const fxTime = (echoBeats, delayBeats, beatSec) => {
    const b = beatSec > 0 ? beatSec : 0.5, r6 = (v) => Math.round(v * 1e6) / 1e6;
    return { echoSec: r6((echoBeats || FX_ECHO_BEATS) * b), delaySec: r6((delayBeats || FX_DELAY_BEATS) * b) };
  };
  // draw: { beatSec, glide } for drawn lanes (editor.md §10 rule 4; default: beatSec, no glide)
  function presetCurves(override, D, beatSec, draw = null) {
    const lanes = override?.preset === 'custom' ? override.lanes : PRESET_LANES[override?.preset];
    if (!lanes || !(D > 0)) return null;
    const drawn = (k) => lanes[k] && typeof lanes[k] === 'object';
    if (Object.keys(LANE_VALUES).some(drawn)) {
      // the named lanes as §3, then each drawn lane's curves in their place (§10 rule 7)
      const named = { ...lanes };
      for (const k of Object.keys(LANE_VALUES)) if (drawn(k)) named[k] = k === 'volume' ? 'crossfade' : 'none';
      const base = presetCurves({ preset: 'custom', lanes: named }, D, beatSec);
      if (!base) return null;
      const pc = pointCurves(lanes, D, draw?.beatSec ?? beatSec ?? 0.5, draw?.glide || null);
      for (const k of Object.keys(LANE_VALUES)) {
        if (!drawn(k)) continue;
        for (const side of ['out', 'in']) for (const key of DRAW_KEYS[k]) { if (pc[side][key]) base[side][key] = pc[side][key]; else delete base[side][key]; }
      }
      if (drawn('fx')) base.fxTime = fxTime(lanes.fx.echoBeats, lanes.fx.delayBeats, draw?.beatSec ?? beatSec);
      return base;
    }
    const e = CUT_RAMP_SEC / D, hb = beatSec > 0 ? (0.5 * beatSec) / D : 0.02, C = EDITOR_CUT_DB;
    const r4 = (v) => Math.round(v * 1e6) / 1e6;
    const at = (pts) => pts.map(([x, v]) => [r4(x * D), r4(v)]);
    const out = {}, inn = {};
    const ramp17 = (f) => Array.from({ length: 17 }, (_, i) => [i / 16, f((i / 16) * Math.PI / 2)]);
    // §3: the "1 bar cut out" shapes cut A one bar (4 beats) before the end; no beat known: at 7/8
    const bar1 = beatSec > 0 ? Math.max(0.5, 1 - (4 * beatSec) / D) : 0.875;
    switch (lanes.volume) {
      case 'smooth': out.gain = at(ramp17(Math.cos)); inn.gain = at(ramp17(Math.sin)); break;
      case 'crossfade': out.gain = at([[0, 1], [1, 0]]); inn.gain = at([[0, 0], [1, 1]]); break;
      case 'overlap': out.gain = at([[0, 1], [0.75, 1], [1, 0]]); inn.gain = at([[0, 0], [0.25, 1]]); break;
      case 'cutInFadeOut': out.gain = at([[0, 1], [1, 0]]); inn.gain = at([[0, 0], [e, 1]]); break;
      case 'fadeInCutOut': out.gain = at([[0, 1], [1 - e, 1], [1, 0]]); inn.gain = at([[0, 0], [1, 1]]); break;
      case 'centerCut': out.gain = at([[0, 1], [0.5, 1], [0.5 + e, 0]]); inn.gain = at([[0, 0], [0.5, 0], [0.5 + e, 1]]); break;
      // (Spotify's names, editor.md §3: its own shapes aren't known, these are this app's)
      case 'fadeInFadeOut': out.gain = at([[0, 1], [0.5, 1], [1, 0]]); inn.gain = at([[0, 0], [0.5, 1]]); break;
      case 'fadeInFastOut': out.gain = at([[0, 1], [0.75, 1], [1, 0]]); inn.gain = at([[0, 0], [0.75, 1]]); break;
      case 'fadeIn1BarCutOut': out.gain = at([[0, 1], [bar1, 1], [bar1 + e, 0]]); inn.gain = at([[0, 0], [0.5, 1]]); break;
      case 'overlap1BarCutOut': out.gain = at([[0, 1], [bar1, 1], [bar1 + e, 0]]); inn.gain = at([[0, 0], [e, 1]]); break;
      default: return null;
    }
    const swap = (c) => { out.bassDb = at([[c - hb, 0], [c + hb, C]]); inn.bassDb = at([[0, C], [c - hb, C], [c + hb, 0]]); };
    switch (lanes.eq) {
      case 'centerBassSwap': swap(0.5); break;
      case 'endBassSwap': swap(0.875); break;
      case 'threeBandFade': swap(0.5); out.highDb = at([[0.5, 0], [1, C]]); inn.highDb = at([[0, C], [0.5, 0]]); break;
      case 'quickBassCut': out.bassDb = at([[0, 0], [2 * hb, C]]); break;
      case 'startBassSwap': swap(0.125); break;
      case 'longBassCut': out.bassDb = at([[0, 0], [0.5, C]]); break;
      // A's bass eases out over the first half (an S-curve), B's stays full
      case 'bassFadeOut': out.bassDb = at(Array.from({ length: 17 }, (_, i) => [i / 32, (C * (1 - Math.cos((i / 16) * Math.PI))) / 2])); break;
      case 'none': break;
      default: return null;
    }
    switch (lanes.effect) {
      case 'none': break;
      case 'lpOut': out.lowpassHz = at([[0, 20000], [1, LP_CLOSED]]); break;
      case 'hpIn': inn.highpassHz = at([[0, HP_CLOSED], [0.5, 20]]); break;
      case 'lpBoth': out.lowpassHz = at([[0.5, 20000], [1, LP_CLOSED]]); inn.lowpassHz = at([[0, LP_CLOSED], [0.5, 20000]]); break;
      case 'hpBoth': out.highpassHz = at([[0.5, 20], [1, HP_CLOSED]]); inn.highpassHz = at([[0, HP_CLOSED], [0.5, 20]]); break;
      case 'lpInHpOut': out.highpassHz = at([[0, 20], [1, HP_CLOSED]]); inn.lowpassHz = at([[0, LP_CLOSED], [1, 20000]]); break;
      case 'hpOut': out.highpassHz = at([[0, 20], [1, HP_CLOSED]]); break;
      case 'lpIn': inn.lowpassHz = at([[0, LP_CLOSED], [1, 20000]]); break;
      case 'hpInLpOut': out.lowpassHz = at([[0, 20000], [1, LP_CLOSED]]); inn.highpassHz = at([[0, HP_CLOSED], [1, 20]]); break;
      case 'hpHalfOut': out.highpassHz = at([[0.5, 20], [1, HP_CLOSED]]); break;
      case 'noiseOutEnd': out.noise = at([[0.5, 0], [1, 1]]); break;
      default: return null;
    }
    // the Effects lane (§12; missing: none)
    const fx = lanes.fx ?? 'none';
    if (fx !== 'none' && !FX_SHAPES[fx]) return null;
    const fs = FX_SHAPES[fx];
    if (fs) out[fs.send] = at(fs.curve);
    // the Looping lane (§13; missing: none): N beats of A, looped by the engine
    const lo = lanes.looping ?? 'none';
    if (lo !== 'none' && !LOOP_BEATS[lo]) return null;
    return { durationSec: r4(D), out, in: inn, ...(fs ? { fxTime: fxTime(fs.send === 'echoSend' ? fs.beats : 0, fs.send === 'delaySend' ? fs.beats : 0, beatSec) } : {}),
      ...(LOOP_BEATS[lo] ? { loopBeats: LOOP_BEATS[lo] } : {}) };
  }

  // ───────── drawn curves (editor.md §10) ─────────
  const DRAW_MAX_POINTS = 128;   // 20 gates of 4 points (a stutter) fit
  // a lane's plan curves, and each drawn curve's name in the stored deck and its range
  const DRAW_KEYS = { volume: ['gain'], eq: ['bassDb', 'midDb', 'highDb'], effect: ['lowpassHz', 'highpassHz', 'noise'], fx: ['echoSend', 'reverbSend', 'delaySend'] };
  const DRAW_CURVES = {
    gain: { lane: 'volume', name: null, lo: 0, hi: 1, hz: false },
    bassDb: { lane: 'eq', name: 'bass', lo: EDITOR_CUT_DB, hi: 0, hz: false },
    highDb: { lane: 'eq', name: 'high', lo: EDITOR_CUT_DB, hi: 0, hz: false },
    lowpassHz: { lane: 'effect', name: 'lp', lo: 20, hi: 20000, hz: true },
    highpassHz: { lane: 'effect', name: 'hp', lo: 20, hi: 20000, hz: true },
    midDb: { lane: 'eq', name: 'mid', lo: EDITOR_CUT_DB, hi: 0, hz: false },
    noise: { lane: 'effect', name: 'noise', lo: 0, hi: 1, hz: false },
    echoSend: { lane: 'fx', name: 'echo', lo: 0, hi: 1, hz: false },
    reverbSend: { lane: 'fx', name: 'reverb', lo: 0, hi: 1, hz: false },
    delaySend: { lane: 'fx', name: 'delay', lo: 0, hi: 1, hz: false },
  };
  const deckCurve = (drawing, side, key) => { const c = DRAW_CURVES[key], d = drawing?.[side]; return c.name ? d?.[c.name] : d; };
  // rule 4: x (beats of A, or seconds) -> seconds of the mix. glide: the plan's { q, beats, beatOutSec }.
  function drawSec(x, unit, beatSec, glide) {
    if (unit === 'sec') return x;
    if (glide?.q && glide.beats > 0) {
      const G = glideSteps(glide.q, glide.beats, glide.beatOutSec), B = G.dur.length;
      const k = Math.min(B - 1, Math.max(0, Math.floor(x)));
      return G.at[k] + (x - k) * G.dur[k];
    }
    return x * (beatSec > 0 ? beatSec : 0.5);
  }
  // seconds of the mix -> x (the inverse, for the editor)
  function drawX(t, unit, beatSec, glide) {
    if (unit === 'sec') return t;
    if (glide?.q && glide.beats > 0) {
      const G = glideSteps(glide.q, glide.beats, glide.beatOutSec), B = G.dur.length;
      let k = 0;
      while (k < B - 1 && G.at[k + 1] <= t) k++;
      return k + (t - G.at[k]) / G.dur[k];
    }
    return t / (beatSec > 0 ? beatSec : 0.5);
  }
  const valueAt = (a, b, t, hz) => {
    const f = (t - a[0]) / Math.max(1e-12, b[0] - a[0]);
    return hz ? a[1] * Math.pow(b[1] / a[1], f) : a[1] + (b[1] - a[1]) * f;
  };
  // rules 3-5: the drawn lanes -> plan curves { out, in } over a window of D seconds
  function pointCurves(lanes, D, beatSec, glide) {
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const res = { out: {}, in: {} };
    for (const [lane, keys] of Object.entries(DRAW_KEYS)) {
      const d = lanes?.[lane];
      if (!d || typeof d !== 'object') continue;
      for (const side of ['out', 'in']) for (const key of keys) {
        const pts = deckCurve(d, side, key);
        if (!Array.isArray(pts) || !pts.length) continue;
        const hz = DRAW_CURVES[key].hz;
        const ts = pts.map(([x, v]) => [drawSec(x, d.unit, beatSec, glide), v]);
        // a step (two points at one x): its second point 8 ms on, held at the next point's t
        for (let i = 1; i < ts.length; i++) {
          if (pts[i][0] === pts[i - 1][0]) ts[i][0] = Math.min(ts[i][0] + CUT_RAMP_SEC, i + 1 < ts.length ? ts[i + 1][0] : Infinity);
        }
        // the window's end: later points cut, the value at D the last one
        let c = ts;
        const past = ts.findIndex(([t]) => t > D + 1e-9);
        if (past === 0) c = [[0, ts[0][1]]];
        else if (past > 0) {
          c = ts.slice(0, past);
          if (c[c.length - 1][0] < D - 1e-9) c.push([D, valueAt(ts[past - 1], ts[past], D, hz)]);
        }
        res[side][key] = c.map(([t, v]) => [r6(t), r6(v)]);
      }
    }
    return res;
  }
  // rule 2: a drawing as saved (null: invalid; 'none' for an EQ or effect drawing with no curve left)
  function normalizeDrawing(lane, d) {
    if (!d || typeof d !== 'object' || !['beat', 'sec'].includes(d.unit) || !DRAW_KEYS[lane]) return null;
    const r3 = (v) => Math.round(v * 1e3) / 1e3;
    const clean = (pts, c) => {
      if (!Array.isArray(pts)) return null;
      const ok = pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, v]) => [Math.max(0, r3(x)), c.hz ? Math.round(clamp(v, c.lo, c.hi)) : r3(clamp(v, c.lo, c.hi))])
        .map((p, i) => [p, i]).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(([p]) => p);
      const kept = [];
      for (const p of ok) {
        if (kept.length >= DRAW_MAX_POINTS) break;
        const n = kept.length;
        if (n >= 2 && kept[n - 1][0] === p[0] && kept[n - 2][0] === p[0]) continue;   // a third at one x
        kept.push(p);
      }
      return kept.length ? kept : null;
    };
    const out = { unit: d.unit };
    let any = false;
    for (const side of ['out', 'in']) {
      if (lane === 'volume') {
        const c = clean(d[side], DRAW_CURVES.gain);
        if (!c) return null;
        out[side] = c;
        any = true;
      } else {
        const deck = {};
        for (const key of DRAW_KEYS[lane]) {
          const c = clean(d[side]?.[DRAW_CURVES[key].name], DRAW_CURVES[key]);
          if (c) { deck[DRAW_CURVES[key].name] = c; any = true; }
        }
        out[side] = deck;
      }
    }
    if (lane === 'fx') {
      if ([1, 0.75, 0.5].includes(d.echoBeats)) out.echoBeats = d.echoBeats;
      if ([0.75, 0.5].includes(d.delayBeats)) out.delayBeats = d.delayBeats;
    }
    return any ? out : 'none';
  }
  // rule 6: a named shape as a drawing, so "Draw" starts from the shape. The shape's curves read
  // back to x; an 8 ms ramp read back as a step (two points at one x).
  function shapeDrawing(lane, shape, D, beatSec, glide, unit) {
    const pc = presetCurves({ preset: 'custom', lanes: { volume: 'crossfade', eq: 'none', effect: 'none', fx: 'none', [lane]: shape } }, D, beatSec);
    if (!pc) return null;
    const r3 = (v) => Math.round(v * 1e3) / 1e3;
    const toX = (pts) => {
      const xs = pts.map(([t, v]) => [r3(drawX(t, unit, beatSec, glide)), v]);
      for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] <= CUT_RAMP_SEC + 1e-6 && pts[i][0] > pts[i - 1][0]) xs[i][0] = xs[i - 1][0];
      return xs.map(([x, v]) => [x, r3(v)]);
    };
    const d = { unit };
    for (const side of ['out', 'in']) {
      if (lane === 'volume') d[side] = toX(pc[side].gain);
      else {
        d[side] = {};
        for (const key of DRAW_KEYS[lane]) if (pc[side][key]) d[side][DRAW_CURVES[key].name] = toX(pc[side][key]);
      }
    }
    const fs = lane === 'fx' ? FX_SHAPES[shape] : null;
    if (fs?.send === 'echoSend') d.echoBeats = fs.beats;
    if (fs?.send === 'delaySend') d.delayBeats = fs.beats;
    return normalizeDrawing(lane, d);
  }

  // A saved window position back to song seconds, editor.md §6. grid: { downbeatSec, beatSec } of that
  // song (A's end grid for the mix-out, B's opening grid for the mix-in). moved: the grid changed by
  // more than a beat since the save, so the saved seconds were snapped to the new grid instead.
  function resolveWindow(pos, grid) {
    if (!pos) return null;
    const nudge = (pos.nudgeMs || 0) / 1000;
    if (!grid || !(grid.beatSec > 0) || !Number.isFinite(grid.downbeatSec)) return { sec: pos.sec, moved: false, snapped: false };
    // seconds only (no bar): the song's nearest beat, the nudges on top
    if (!Number.isInteger(pos.bar)) {
      const j = Math.round((pos.sec - nudge - grid.downbeatSec) / grid.beatSec);
      return { sec: Math.round((grid.downbeatSec + j * grid.beatSec + nudge) * 1e6) / 1e6, moved: false, snapped: true };
    }
    const bar = 4 * grid.beatSec;
    const t = grid.downbeatSec + pos.bar * bar + (pos.beat || 0) * grid.beatSec + nudge;
    if (!Number.isFinite(pos.sec) || Math.abs(t - pos.sec) <= grid.beatSec) return { sec: Math.round(t * 1e6) / 1e6, moved: false, snapped: true };
    const k = Math.round((pos.sec - grid.downbeatSec) / bar);
    return { sec: Math.round((grid.downbeatSec + k * bar) * 1e6) / 1e6, moved: true, snapped: true, bar: k };
  }

  // A loop mix's curves (crossfade.js scheduleLoopMix), from its loopSchedule: the
  // baseline's (versions.md "The loop mix's baseline"), no trim.
  function loopCurves(plan) {
    const x = loopSchedule(plan, 0), half = x.bar / 2;
    const steps = (changes, until) => {
      const pts = [];
      for (const c of changes) {
        if (c.output > until) break;
        const prev = pts.length ? pts[pts.length - 1][1] : null;
        if (prev === null) pts.push([c.output, c.rate]);
        else if (Math.abs(prev - c.rate) > 1e-9) pts.push([c.output, prev], [c.output, c.rate]);
      }
      return pts;
    };
    return {
      durationSec: x.releaseAt,
      out: {
        gain: [[0, 1], [x.enterEnd, 1], [x.rampEnd, 0.6], [x.releaseAt, 0]],
        bassDb: [[x.mid - half, 0], [x.mid + half, BASS_CUT_DB]],
        highpassHz: [[x.rampEnd, 20], [x.releaseAt, 1500]],
        rate: steps(x.outChanges.filter((c) => c.active), x.releaseAt),
      },
      in: {
        gain: [[0, 0], [x.enterEnd, 0.55], [x.rampEnd, 1]],
        bassDb: [[0, BASS_CUT_DB], [x.mid - half, BASS_CUT_DB], [x.mid + half, 0]],
        rate: steps(x.inChanges, x.releaseAt),
      },
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
    // v2: the loop ramps the tempo too, so the same cap (a wider gap: a blend or filter mix instead)
    if (version === 3 && stretchOf(target / outBpm) > V2_MAX_STRETCH) return { none: `tempos ${Math.round(stretchOf(target / outBpm) * 100)}% apart (v2 stretches at most ${Math.round(V2_MAX_STRETCH * 100)}%)` };
    const contrast = subBassContrast(out, inn);
    if (version === 3 && contrast >= V2_SUB_BASS_VETO) return { none: `different sub-bass styles (${contrast.toFixed(2)} apart)` };
    const harmonic = version === 3 ? harmonicEvidence(out, inn) : null;
    if (harmonic?.severeClash) return { none: `the keys clash (${out.keyName} → ${inn.keyName}, ${harmonic.score})` };
    const rampBars = Math.min(MAX_RAMP_BARS, Math.max(MIN_RAMP_BARS, Math.ceil(Math.abs(target - outBpm) / MAX_BPM_PER_BAR)));
    // the incoming loop lets go only at its own loop boundary: whole incoming loops
    const inLoopOutBars = inPick.bars / fold;
    const totalBars = Math.ceil((ENTER_BARS + rampBars + 2) / inLoopOutBars) * inLoopOutBars;
    const pick = (key, p, beatSec, bpm) => ({ key, loop: [p.start, p.end], bars: p.bars, beatSec, bpm, vocal: p.vocal, checkedBy: p.checkedBy });
    const plan = {
      out: pick(out.fileKey, outPick, outBeat, outBpm),
      in: pick(inn.fileKey, inPick, inBeat, inBpm),
      fold, enterBars: ENTER_BARS, rampBars, exitBars: totalBars - ENTER_BARS - rampBars, totalBars,
    };
    plan.curves = loopCurves(plan);
    return plan;
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
  // (a frame that isn't a number covers nothing: NaN isn't over VOCAL_ACTIVE, so it read as instrumental)
  function maskStats(windows, from, to) {
    let sung = 0, n = 0, covered = 0, run = 0, longest = 0, fps = 1;
    for (const w of windows) {
      const a = Math.max(0, Math.ceil((from - w.startSec) * w.fps));
      const b = Math.min(w.curve.length, Math.floor((to - w.startSec) * w.fps));
      let k = 0;
      for (let i = a; i < b; i++) {
        if (!Number.isFinite(w.curve[i])) { run = 0; continue; }
        n++; k++;
        if (w.curve[i] > VOCAL_ACTIVE) { sung++; run++; longest = Math.max(longest, run); } else run = 0;
      }
      if (b > a) { covered += k / w.fps; fps = w.fps; }
    }
    return n && covered >= (to - from) * 0.8 ? { share: sung / n, longestRunSec: longest / fps } : null;
  }

  // A synced line's shape, without its text: start and end (s; end null when the
  // provider gives none), its word count, and its words' [start, end] when timed.
  function lineShapes(lines, meta = null) {
    const shapes = [];
    for (const l of lines) {
      if (!Number.isFinite(l?.start)) continue;
      const timed = Array.isArray(l.words) ? l.words.filter((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end) && w.end >= w.start) : [];
      const text = String(l.text ?? '').trim();
      if (!text && !timed.length) continue;   // a gap line
      shapes.push({
        start: l.start / 1000,
        end: Number.isFinite(l.end) && l.end > l.start ? l.end / 1000 : null,
        words: text ? text.split(/\s+/).length : timed.length,
        ...(notSung(text, l.start / 1000, meta) ? { notSung: true } : {}),
        wordTimes: timed.length ? timed.map((w) => [w.start / 1000, w.end / 1000]) : null,
      });
    }
    return shapes.sort((a, b) => a.start - b.start);
  }
  // Where each line is sung (versions.md "Where a song is sung", 2026-11-24). With
  // word times: the first word's start to the last word's end + 0.3 s. Without: the
  // line's start to the earliest of the next line's start, the start + its words x
  // 0.35 s + 0.5 s, its own end when the provider gives one, and 10 s. (Until then a
  // line without word times was sung up to the next line, 10 s at most: nearly
  // every second of a song counted as sung, and Automix v2's ladder fell to the
  // hand-over.) A line with no words (0, or no count at all) and no word times is
  // a gap, as lineShapes skips it: no span (a NaN count made a NaN span).
  const LINE_WORD_SEC = 0.35, LINE_PAD_SEC = 0.5, LINE_MAX_SEC = 10, WORD_TAIL_SEC = 0.3;
  function sungSpansFromLines(shapes) {
    const spans = [];
    shapes.forEach((l, i) => {
      if (l.wordTimes?.length) {
        spans.push([Math.min(...l.wordTimes.map((w) => w[0])), Math.max(...l.wordTimes.map((w) => w[1])) + WORD_TAIL_SEC]);
        return;
      }
      if (!(l.words > 0) || !Number.isFinite(l.start)) return;
      const next = shapes.slice(i + 1).find((n) => n.start > l.start)?.start ?? Infinity;
      const end = Math.min(next, l.start + l.words * LINE_WORD_SEC + LINE_PAD_SEC, l.end ?? Infinity, l.start + LINE_MAX_SEC);
      spans.push([l.start, Math.max(end, l.start)]);
    });
    return spans;
  }
  // The vocal mask, where the song has one, still hears a gap: inside a sung span a
  // run of a beat or more with the mask under 0.3 isn't sung (so lyrics never mark
  // sung what the mask hears as instrumental for 2 s or more either).
  const MASK_GAP = 0.3;
  const carved = new WeakMap();   // spans array -> Map(analysis -> carved spans)
  function carveSung(spans, a) {
    if (!Array.isArray(spans) || !a?.vocals?.length) return spans;
    let byA = carved.get(spans);
    if (!byA) { byA = new WeakMap(); carved.set(spans, byA); }
    if (byA.has(a)) return byA.get(a);
    const beat = a.beatIntervalSec > 0 ? a.beatIntervalSec : 0.5, out = [];
    // lines that touch or overlap are one run first: a breath across a line change is one gap
    const runs = [];
    for (const [x, y] of [...spans].sort((p, q) => p[0] - q[0])) {
      const last = runs[runs.length - 1];
      if (last && x <= last[1]) last[1] = Math.max(last[1], y); else runs.push([x, y]);
    }
    const mask = (t) => { for (const w of a.vocals) { const i = Math.round((t - w.startSec) * w.fps); if (i >= 0 && i < w.curve.length) return Number.isFinite(w.curve[i]) ? w.curve[i] : null; } return null; };
    for (const [x, y] of runs) {
      let from = x, gapAt = null;
      for (let t = x; t < y; t += 0.02) {
        const m = mask(t);
        if (m != null && m < MASK_GAP) { if (gapAt == null) gapAt = t; continue; }
        if (gapAt != null && t - gapAt >= beat) { if (gapAt > from) out.push([from, gapAt]); from = t; }
        gapAt = null;
      }
      if (gapAt != null && y - gapAt >= beat) { if (gapAt > from) out.push([from, gapAt]); }
      else if (y > from) out.push([from, y]);
    }
    byA.set(a, out);
    return out;
  }

  // Song details from YouTube Music's queue (crossfade-page.js), for the lyrics lookup.
  // Asks for the same song while one is under way share its answer (a second
  // ask used to answer the first with nothing, so the overview, open during the
  // loop mix's lookup, could leave a song without lyrics and change its loop).
  const metaWaits = new Map();   // id -> { promise, resolve }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== 'vivi-xfade' || d.dir !== 'out' || d.type !== 'meta') return;
    const w = metaWaits.get(d.id);
    if (!w) return;
    metaWaits.delete(d.id);
    w.resolve(d.meta || null);
  });
  function songMeta(id) {
    const pending = metaWaits.get(id);
    if (pending) return pending.promise;
    const w = {};
    w.promise = new Promise((resolve) => { w.resolve = resolve; });
    metaWaits.set(id, w);
    window.postMessage({ ch: 'vivi-xfade', dir: 'in', type: 'meta', id }, window.location.origin);
    setTimeout(() => { if (metaWaits.get(id) === w) { metaWaits.delete(id); w.resolve(null); } }, 3000);
    return w.promise;
  }

  // BitChord state/player.ts sungSpans: where [id] is sung, from its synced
  // lyrics (the lyrics panel's lookup and cache); null when it has none, or
  // they don't come in time: the loop mix then goes by the vocal mask.
  async function lyricLines(id) {
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
      const shapes = lineShapes(found.lines, meta);
      return shapes.length ? shapes : null;
    } catch { return null; }
  }
  async function sungSpans(id) {
    const shapes = await lyricLines(id);
    const spans = shapes ? sungSpansFromLines(shapes) : [];
    return spans.length ? spans : null;
  }
  // A timed line that isn't sung (versions.md "The loop mix's baseline" rule 6): a credit
  // ("作曲: …", "Letra: …", "Lyrics by …", "Prod. …"), the song's title or artist alone,
  // symbols only, or a start before 0. NetEase sends credits as timed lines, with no end.
  const CREDIT_LINE = /^\s*(?:作词|作詞|作曲|编曲|編曲|词|詞|曲|制作人|製作人|监制|監製|混音|母带|母帶|和声|和聲|录音|錄音|出品|发行|發行|letra|m[uú]sica|compositor(?:es)?|autor(?:es)?|lyrics?|lyricist|written|writers?|words|music|composed|composer|composition|arranged|arrangement|arranger|produced|producers?|prod\.?|mixed|mixing|mastered|mastering|recorded|engineer(?:ed)?)\s*(?:by\b|[:：]|\s-\s)/iu;
  const plainOf = (x) => String(x ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function notSung(text, startSec, meta) {
    if (!(startSec >= 0)) return true;
    if (!text) return false;
    if (!/[\p{L}\p{N}]/u.test(text)) return true;
    if (CREDIT_LINE.test(text) || /^\s*prod\.\s/i.test(text)) return true;
    const t = plainOf(text);
    const names = [meta?.song, meta?.artist].map(plainOf).filter(Boolean);
    return names.some((n) => t === n) || (names.length === 2 && t.includes(names[0]) && t.includes(names[1]));
  }

  // The loop mix's sung spans, as the baseline (d26dc16, BitChord sungSpansFromLines) reads
  // them: each line padded 0.15 s before and 0.35 s after; a line with word times ends at its
  // last word, one without at its own end, else at the next line, 10 s at most.
  const LOOP_LYRIC_LEAD_SEC = 0.15, LOOP_LYRIC_TAIL_SEC = 0.35;
  function loopSpansFromLines(shapes) {
    const spans = [];
    shapes.forEach((l, i) => {
      if (!Number.isFinite(l?.start) || l.notSung) return;
      const next = shapes.slice(i + 1).find((n) => n.start > l.start && !n.notSung)?.start;
      const end = l.wordTimes?.length
        ? Math.max(...l.wordTimes.map((w) => w[1]))
        : Math.min(l.start + LINE_MAX_SEC, l.end ?? next ?? l.start + LINE_MAX_SEC);
      spans.push([l.start - LOOP_LYRIC_LEAD_SEC, Math.max(end, l.start) + LOOP_LYRIC_TAIL_SEC]);
    });
    return spans;
  }
  async function loopSungSpans(id) {
    const shapes = await lyricLines(id);
    const spans = shapes ? loopSpansFromLines(shapes) : [];
    return spans.length ? spans : null;
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
    kickLockAllowed,
    request,
    get: (id) => results.get(id) ?? null,
    statusOf: (id) => status.get(id) ?? null,
    progressOf,
    plan,
    withBarPhase,
    heard,
    recentMoves: () => [...recentMoves],
    singsOut,
    asOutgoing,
    gridOk: (a) => !!gridOf(a) && a.gridConfidence >= MIN_GRID_CONFIDENCE,
    audioBytes,
    planLoopMix,
    sungSpans: sharedSungSpans,
    lyricLines,
    sungSpansFromLines,
    carveSung,
    loopSpansFromLines,
    lineShapes,
    loopSungSpans,
    // fixtures and tests: a song's sung spans as if its lyrics had come in (null: none)
    primeSung: (id, spans) => sungCache.set(id, { spans: Array.isArray(spans) ? spans : null, at: Date.now(), tries: 2 }),
    meta: songMeta,
    loopSchedule,
    djShape,
    glideBack,
    glideSteps,
    trimmed,
    dropInTrim,
    DROP_IN_OUT_DB,
    kickLock,
    kickSource,
    loopOrBlend,
    presetCurves, migratePick, normalizeOverride, readMixFile, writeMixFile, mixChanges, importPlan, mixQueue, foldOverride, foldNote, MIX_FORMAT, MIX_VERSION, SPOTIFY_FORMAT, SPOTIFY_VERSION, editorGrid, windowLimits, nudgeWindow,
    pointCurves, drawSec, drawX, shapeDrawing, normalizeDrawing, DRAW_MAX_POINTS, songSpeed, normalizeSpeed,
    resolveWindow,
    PRESET_LANES,
    PRESET_BARS,
    LANE_VALUES,
    FX_SHAPES,
    LOOP: { OUT_REGION_SEC, IN_REGION_SEC, LOOP_SETUP_SEC },
    warmup,
    setStatus,
    getLiveState: () => ({ ...live }),
    // the addon copy's fit and level in the analysis frame's worker (addons/fit.worker.js);
    // `transfer`: the job's arrays, handed over (gone here afterwards)
    addonWork: async (job, transfer = []) => { await ensureFrame(); return askHost({ id: 'addon', type: 'addonWork', job, transfer }, transfer, 60000); },
  };
})();

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
        log(`analysis of ${id}${a.cached ? ' (saved)' : ''}${a.musicVideo ? ' (music video)' : ''}: ${a.bpm?.toFixed(1) ?? '?'} BPM (end ${a.tailGrid?.bpm?.toFixed(1) ?? '?'}), ${a.keyName ?? '?'}, grid ${a.gridConfidence.toFixed(2)} / end ${a.tailGrid?.gridConfidence?.toFixed(2) ?? '-'}, intro ends ${a.introEndSec?.toFixed(1) ?? '-'} s, outro from ${a.outroStartSec?.toFixed(1) ?? '-'} s${a.contentEndSec != null ? `, music ends ${a.contentEndSec.toFixed(1)} s` : ''}${a.subBassRatio != null ? `, sub-bass ${a.subBassRatio.toFixed(2)}` : ''}, in${Math.round(performance.now() - started)} ms`);
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
  // A length picked for this pair in the Automix overview comes first.
  let pinnedBars = null;
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
  function plan({ fromId, toId, from, to, durationSec, pos, earliest, pick = null }) {
    const ov = migratePick(pick);
    pinnedBars = (ov?.preset !== 'loop' && (ov?.bars || PRESET_BARS[ov?.preset])) || null;
    try {
      const warnings = [];
      const p = planFor({ fromId, toId, from, to, durationSec, pos, earliest, pick: ov, warnings });
      p.curves = blendCurves(p);
      // a length the planner didn't use (a hand-over, a drop-in's two bars): why, not "fit here" (editor.md §6)
      if (ov?.bars && ov.preset !== 'loop' && !warnings.length && (p.handoff || p.bridge || p.fallback || (p.shape === 'dropin' && p.bars !== ov.bars))) {
        warnings.push(`${ov.bars} bars not used: ${p.reason || 'a plain fade here'}`);
      }
      if (ov && ov.preset !== 'loop') {
        if (warnings.length) p.warnings = warnings;
        if (ov.window?.in && p.style === 'blend') p.windowIn = true;   // placed by the user: the kick lock leaves it (editor.md §6)
        const pc = !(p.fallback && !(from && to)) && presetCurves(ov, p.durationSec, p.style === 'crossfade' ? null : p.beatSec);
        if (pc) {
          // the preset's gain, shelves and filters; the planner's tempo stays (editor.md §9)
          for (const side of ['out', 'in']) { if (p.curves[side].rate) pc[side].rate = p.curves[side].rate; }
          p.curves = pc;
          p.preset = ov.preset;
        }
      }
      return p;
    } finally { pinnedBars = null; }
  }
  // An override as saved (editor.md §1, override.schema.json): Auto fields dropped, null when nothing
  // but Auto is left (Auto is the reset). Picking a preset drops a migrated pick's family.
  const nudge = (ms) => (Number.isFinite(ms) ? clamp(Math.round(ms / 10) * 10, -2000, 2000) || 0 : 0);
  function normalizeOverride(o) {
    o = migratePick(o);
    if (!o) return null;
    const n = {};
    if (PRESET_NAMES.includes(o.preset)) n.preset = o.preset;
    if (n.preset === 'custom' && o.lanes && Object.keys(LANE_VALUES).every((k) => LANE_VALUES[k].includes(o.lanes[k]))) n.lanes = { volume: o.lanes.volume, eq: o.lanes.eq, effect: o.lanes.effect };
    if (n.preset === 'custom' && !n.lanes) delete n.preset;
    if (!n.preset && (o.family === 'blend' || o.family === 'filter')) n.family = o.family;
    if (n.preset !== 'loop') {
      if ([2, 4, 8, 16, 32].includes(o.bars)) n.bars = o.bars;
      const pos = (p) => p && Number.isFinite(p.sec) && Number.isInteger(p.bar)
        ? { bar: p.bar, ...([1, 2, 3].includes(p.beat) ? { beat: p.beat } : {}), ...(nudge(p.nudgeMs) ? { nudgeMs: nudge(p.nudgeMs) } : {}), sec: Math.round(p.sec * 1e3) / 1e3 } : null;
      const w = { out: pos(o.window?.out), in: pos(o.window?.in) };
      if (w.out || w.in) n.window = Object.fromEntries(Object.entries(w).filter(([, v]) => v));
      // (Loop: the loop decks do their own tempo ramp, editor.md §2)
      if (['sync', 'glide', 'off'].includes(o.beatMatch)) n.beatMatch = o.beatMatch;
    }
    if (!Object.keys(n).length) return null;
    if (o.lock) n.lock = true;
    return { v: 1, ...n, ...(o.engine ? { engine: o.engine } : {}), ...(o.savedAt ? { savedAt: o.savedAt } : {}) };
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
    const want = bars && fromGrid ? bars * fromGrid.barSec : base.durationSec || FALLBACK_SEC;
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
    if (bm === 'sync' || bm === 'glide') {
      const st = stretchOf(foldRate(fromGrid.bpm / toGrid.bpm));
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

    const ratio = foldRate(fromGrid.bpm / toGrid.bpm);
    // v2: never more than V2_MAX_STRETCH of speed-up (Orchard: 6% fine, 11.8% forced),
    // and never two 808 styles at once; either way it can't beatmatch, so it does nothing
    if (v3 && stretchOf(ratio) > V2_MAX_STRETCH) {
      const why = `tempos ${Math.round(stretchOf(ratio) * 100)}% apart (v2 stretches at most ${Math.round(V2_MAX_STRETCH * 100)}%)`;
      if (!forced && !pick?.bars) return handoff(cur, next, earliest, why);
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
    const glideQ = bm === 'sync' ? null : bm === 'glide' ? (Math.abs(ratio - 1) > 1e-4 ? 1 / ratio : null) : v3 && stretchOf(ratio) > V2_MAX_CONSTANT ? 1 / ratio : null;
    const rate = glideQ ? 1 : ratio < 1 ? 1 : ratio;               // the next song's
    const outRate = glideQ ? 1 : ratio < 1 ? 1 / ratio : 1;        // the playing song's, from the blend on
    const rampBeats = outRate > 1.0001 ? Math.ceil((outRate - 1) / TEMPO_STEP_PER_BEAT) : 0;
    const rampSongSec = rampBeats * fromGrid.beatSec;  // song time the ramp covers, ending at the mix-out
    // AutoDJ's key-aware length (its own toggle): keys that clash get a short blend
    // (Automix v2: Orchard's key score, always on: under 0.55 with both keys trusted)
    const keyClash = v3 ? (harmonic.short ? `${cur.keyName} → ${next.keyName}, ${harmonic.score}` : null) : adv() && keyAware ? keysClash(cur, next) : null;
    const bars = keyClash && !pinnedBars ? keyClashBars(fromGrid) : requestedBars(cur, next, fromGrid, toGrid.downbeatSec, false);
    const effBars = effectiveBlendBars(bars, cur.gridConfidence, next.gridConfidence);
    const outSpan = effBars * fromGrid.barSec;        // the playing song's seconds the blend covers
    const glide = glideQ ? glideSteps(glideQ, effBars * 4, fromGrid.beatSec) : null;
    const dur = glide ? glide.total : outSpan / outRate;   // output seconds
    const inPerOut = glide ? 1 / glideQ : rate / outRate;  // next song's seconds per playing song's

    // outgoing mix-out point (naturalMixOut: at the song's end); the ramp before it has to fit too
    const first = earliest + rampSongSec;
    const v2 = adv();
    let mixOut = naturalMixOut(fromGrid, v2 ? musicEnd(cur) : cur, outSpan);
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
    if (v2 && !wIn && !wOut) {
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
      const sung = { out: lyricSpans(cur), in: lyricSpans(next) };
      // drop-in: the next song on its first downbeat at full level, two bars over the
      // playing song's exit, which may not cut a line (exit at most 12 s of music earlier)
      const dSpan = DROP_IN_BARS * fromGrid.barSec;
      const dGlide = glideQ ? glideSteps(glideQ, DROP_IN_BARS * 4, fromGrid.beatSec) : null;
      const lo = Math.max(first, pos + rampSongSec);
      const natural = naturalMixOut(fromGrid, musicEnd(cur), dSpan);
      for (let k = 0; k * fromGrid.barSec <= MAX_DISCARD_SEC; k++) {
        const o = natural - k * fromGrid.barSec;
        if (o < lo) break;
        const cut = voiceRisk(cur, o + dSpan - 1.5, o + dSpan, sung.out);
        if (cut != null && cut >= SWAP_CLEAR) continue;
        const both = vocalOverlap(cur, next, o, dSpan, toGrid.downbeatSec, inPerOut, sung);
        if ((both ?? 0) > V2_CLASH_MAX) continue;
        const dDur = dGlide ? dGlide.total : dSpan / outRate;
        return {
          style: 'blend', shape: 'dropin', fallback: false,
          reason: `${why}: a drop-in on the next song's first beat${k ? ` (exit ${k} bar${k === 1 ? '' : 's'} earlier, off a sung line)` : ''}`,
          v2, clash: both ?? 0, rerouted: null, vocalsBy: dj?.by ?? null, keyClash,
          subBassContrast: contrast, swapAt: null, swapMoved: null, glide: dGlide ? { q: glideQ, beats: DROP_IN_BARS * 4, beatOutSec: fromGrid.beatSec } : null,
          harmonic, trim: loudnessTrim(cur, o, dSpan, next, toGrid.downbeatSec, dSpan * inPerOut),
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
      if (!introShort && leadBeats >= MUFFLE_MIN_LEAD_BEATS && at + MUFFLE_EXIT_BEATS / B <= 1 + 1e-6
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
  function filterMix(cur, next, fromGrid, toGrid, requested, pos, earliest, reason) {
    let bars = Math.min(requested, FILTER_MAX_BARS);
    let dur = bars * fromGrid.barSec;
    const v2 = adv();
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
  // Automix v2's "beatmatch or do nothing" (Orchard's boundary hand-off): two
  // beats that can't be matched are never laid over each other. The playing
  // song runs to where its music ends and the next starts from its beginning,
  // with a short fade between (the fallback ladder adds more ways later).
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
    const target = cur.durationSec - 0.3 - FALLBACK_SEC;
    const mixOut = Math.max(earliest, target);
    const dur = Math.max(0, Math.min(FALLBACK_SEC, cur.durationSec - 0.3 - mixOut));
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
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const glideTo = (a, b, x) => a * Math.pow(b / a, clamp(x, 0, 1));
  const bassCutHz = (x) => glideTo(20, 200, x);
  const entryHp = (p, top, openBy) => (p >= openBy ? 20 : glideTo(20, top, Math.pow(1 - p / openBy, 0.35)));
  const DECK_GLIDE_STEP = 0.0025, DECK_GLIDE_STEP_SEC = 0.25;   // the incoming deck's glide back to x1.0 (crossfade.js deckGlideBack)

  // AutoDJ's (version 2) fader and filters for a blend or filter mix of D
  // seconds, sampled at n points over p = 0..1. The clash (the share both
  // sing, from the plan) deepens the filters and moves the fader towards a
  // vocal-safe pair.
  function djShape(m, style, D, n) {
    if (style === 'blend' && (m.shape === 'dropin' || m.shape === 'muffle')) return ladderShape(m, D, n);
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
    if (m.shape === 'dropin') {
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
    }
    const rate = style === 'blend' ? m.rate : 1;
    if (style === 'blend' && m.glide) {
      // Automix v2's glide: both songs step once per beat, the next one ends at x1.0
      const G = glideSteps(m.glide.q, m.glide.beats, m.glide.beatOutSec);
      const steps = (rates) => rates.flatMap((r, k) => (k ? [[G.at[k], rates[k - 1]], [G.at[k], r]] : [[0, r]]));
      out.rate = [...steps(G.outRate), [D, G.outRate[G.outRate.length - 1]]];
      inn.rate = [...steps(G.inRate), [D, G.inRate[G.inRate.length - 1]], [D, 1]];
    } else if (Math.abs(rate - 1) > 1e-9) {
      const g = glideBack(rate);
      inn.rate = g ? [[0, rate], [D, rate], [D + g.sec, 1]] : [[0, rate], [D, rate], [D, 1]];
    }
    return { durationSec: D, out, in: inn };
  }

  // ───────── the transition editor (spec/automix/editor.md) ─────────
  // A preset's (or custom lanes') curves over a window of D seconds, editor.md §3: points at a
  // fraction x of the window, given here in seconds. beatSec: the beat (null with beat match Off).
  const EDITOR_CUT_DB = -18 /* BASS_CUT_DB, declared further down */, LP_CLOSED = 400, HP_CLOSED = 1000, CUT_RAMP_SEC = 0.008;
  const PRESET_LANES = {
    smooth: { volume: 'smooth', eq: 'centerBassSwap', effect: 'none' },
    rise: { volume: 'overlap', eq: 'endBassSwap', effect: 'lpInHpOut' },
    blend: { volume: 'overlap', eq: 'threeBandFade', effect: 'none' },
    wave: { volume: 'overlap', eq: 'centerBassSwap', effect: 'lpBoth' },
    melt: { volume: 'crossfade', eq: 'centerBassSwap', effect: 'hpBoth' },
    slam: { volume: 'centerCut', eq: 'none', effect: 'none' },
  };
  const PRESET_BARS = { slam: 2 };
  const PRESET_NAMES = ['smooth', 'rise', 'blend', 'wave', 'melt', 'slam', 'loop', 'custom'];
  const LANE_VALUES = {
    volume: ['smooth', 'crossfade', 'overlap', 'cutInFadeOut', 'fadeInCutOut', 'centerCut'],
    eq: ['centerBassSwap', 'endBassSwap', 'threeBandFade', 'quickBassCut', 'none'],
    effect: ['none', 'lpOut', 'hpIn', 'lpBoth', 'hpBoth', 'lpInHpOut'],
  };
  function presetCurves(override, D, beatSec) {
    const lanes = override?.preset === 'custom' ? override.lanes : PRESET_LANES[override?.preset];
    if (!lanes || !(D > 0)) return null;
    const e = CUT_RAMP_SEC / D, hb = beatSec > 0 ? (0.5 * beatSec) / D : 0.02, C = EDITOR_CUT_DB;
    const r4 = (v) => Math.round(v * 1e6) / 1e6;
    const at = (pts) => pts.map(([x, v]) => [r4(x * D), r4(v)]);
    const out = {}, inn = {};
    const ramp17 = (f) => Array.from({ length: 17 }, (_, i) => [i / 16, f((i / 16) * Math.PI / 2)]);
    switch (lanes.volume) {
      case 'smooth': out.gain = at(ramp17(Math.cos)); inn.gain = at(ramp17(Math.sin)); break;
      case 'crossfade': out.gain = at([[0, 1], [1, 0]]); inn.gain = at([[0, 0], [1, 1]]); break;
      case 'overlap': out.gain = at([[0, 1], [0.75, 1], [1, 0]]); inn.gain = at([[0, 0], [0.25, 1]]); break;
      case 'cutInFadeOut': out.gain = at([[0, 1], [1, 0]]); inn.gain = at([[0, 0], [e, 1]]); break;
      case 'fadeInCutOut': out.gain = at([[0, 1], [1 - e, 1], [1, 0]]); inn.gain = at([[0, 0], [1, 1]]); break;
      case 'centerCut': out.gain = at([[0, 1], [0.5, 1], [0.5 + e, 0]]); inn.gain = at([[0, 0], [0.5, 0], [0.5 + e, 1]]); break;
      default: return null;
    }
    const swap = (c) => { out.bassDb = at([[c - hb, 0], [c + hb, C]]); inn.bassDb = at([[0, C], [c - hb, C], [c + hb, 0]]); };
    switch (lanes.eq) {
      case 'centerBassSwap': swap(0.5); break;
      case 'endBassSwap': swap(0.875); break;
      case 'threeBandFade': swap(0.5); out.highDb = at([[0.5, 0], [1, C]]); inn.highDb = at([[0, C], [0.5, 0]]); break;
      case 'quickBassCut': out.bassDb = at([[0, 0], [2 * hb, C]]); break;
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
      default: return null;
    }
    return { durationSec: r4(D), out, in: inn };
  }

  // A saved window position back to song seconds, editor.md §6. grid: { downbeatSec, beatSec } of that
  // song (A's end grid for the mix-out, B's opening grid for the mix-in). moved: the grid changed by
  // more than a beat since the save, so the saved seconds were snapped to the new grid instead.
  function resolveWindow(pos, grid) {
    if (!pos) return null;
    const nudge = (pos.nudgeMs || 0) / 1000;
    if (!grid || !(grid.beatSec > 0) || !Number.isFinite(grid.downbeatSec)) return { sec: pos.sec, moved: false, snapped: false };
    const bar = 4 * grid.beatSec;
    const t = grid.downbeatSec + pos.bar * bar + (pos.beat || 0) * grid.beatSec + nudge;
    if (!Number.isFinite(pos.sec) || Math.abs(t - pos.sec) <= grid.beatSec) return { sec: Math.round(t * 1e6) / 1e6, moved: false, snapped: true };
    const k = Math.round((pos.sec - grid.downbeatSec) / bar);
    return { sec: Math.round((grid.downbeatSec + k * bar) * 1e6) / 1e6, moved: true, snapped: true, bar: k };
  }

  // A loop mix's curves (crossfade.js scheduleLoopMix), from its loopSchedule.
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
    kickLockAllowed,
    request,
    get: (id) => results.get(id) ?? null,
    statusOf: (id) => status.get(id) ?? null,
    plan,
    asOutgoing,
    gridOk: (a) => !!gridOf(a) && a.gridConfidence >= MIN_GRID_CONFIDENCE,
    audioBytes,
    planLoopMix,
    sungSpans: sharedSungSpans,
    meta: songMeta,
    loopSchedule,
    djShape,
    glideBack,
    glideSteps,
    trimmed,
    kickLock,
    kickSource,
    loopOrBlend,
    presetCurves, migratePick, normalizeOverride, editorGrid, windowLimits,
    resolveWindow,
    PRESET_LANES,
    PRESET_BARS,
    LOOP: { OUT_REGION_SEC, IN_REGION_SEC, LOOP_SETUP_SEC },
    warmup,
    setStatus,
    getLiveState: () => ({ ...live }),
    // the addon copy's fit and level in the analysis frame's worker (addons/fit.worker.js);
    // `transfer`: the job's arrays, handed over (gone here afterwards)
    addonWork: async (job, transfer = []) => { await ensureFrame(); return askHost({ id: 'addon', type: 'addonWork', job, transfer }, transfer, 60000); },
  };
})();

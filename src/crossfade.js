/* VIVIMUSIC WEB — crossfade.js  (content script, isolated world)
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
    param.setValueAtTime(v, t);
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
  let plan = null, reqId = '', failedId = '', retryAt = 0, tries = 0;
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
      }
    } else if (d.type === 'tail') {
      acceptTail(d);
    } else if (d.type === 'prefetch') {
      const f = songs.get(d.id) || { retried: false };
      songs.set(d.id, { ...f, state: d.state, why: d.why || '', client: d.client || '', at: performance.now() });
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
  }

  function setPlan(g, d) {
    const len = d.channels[0].length;
    const buf = g.ctx.createBuffer(d.channels.length, len, d.sampleRate);
    d.channels.forEach((c, i) => buf.copyToChannel(c, i));
    const L = d.channels[0], R = d.channels[1] || L;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    plan = { id: d.id, buf, mono, rate: d.sampleRate, start: d.start };
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

  // A whole-song download for automix: asked once, retried once a little
  // later if it failed; analysed (BitChord's analyzer) once it is in.
  function wantSong(id) {
    const now = performance.now();
    let f = songs.get(id);
    if (!f) {
      songs.set(id, { state: 'loading', at: now, retried: false, why: '' });
      while (songs.size > 6) songs.delete(songs.keys().next().value);
      post({ type: 'prefetch', id });
      return;
    }
    if (f.state === 'failed' && !f.retried && now - f.at > 20000) {
      songs.set(id, { ...f, state: 'loading', retried: true, at: now });
      log('automix: download of', id, 'failed (' + f.why + '), trying once more');
      post({ type: 'prefetch', id, retry: true });
      return;
    }
    if (f.state === 'ready') window.__viviAutomix?.request(id, true);
  }

  function onManualSkipRequested(e) {
    if (!userManualSkip || seconds() === 0 || skip || live) return;
    const g = graph();
    const v = g?.video;
    if (!g || !v || !st || st.ad || v.paused || st.id === failedId || g.ctx.state !== 'running') return;
    if (performance.now() - stAt > 1500) return;
    if (st.dur - (v.currentTime - st.off) < seconds() + 2) return;   // the song is ending anyway

    e.preventDefault();
    e.stopImmediatePropagation();
    dropPlan();
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

  // Only real user input: our own hand-over presses Next with a synthetic click.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest?.('ytmusic-player-bar .next-button')) onManualSkipRequested(e);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || (e.key !== 'N' && e.key !== 'n')) return;
    const active = e.composedPath?.()[0] || document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    onManualSkipRequested(e);
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
    if (e.isTrusted && e.target.closest?.('ytmusic-player-bar .play-pause-button')) onPlayPauseDuringHold(e);
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
    const base = loud > 0.001 && ref > 1e-4 ? clamp(loud / ref, 0, 4) : (v.muted ? 0 : v.volume);

    const src = ctx.createBufferSource();
    const fade = ctx.createGain();
    // Automix's outgoing deck (BitChord): bass swap, high-shelf cross and the
    // filter mix's high-pass. Flat / open for a plain crossfade.
    const bass = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250, gain: 0 });
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000, gain: 0 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 });
    const vol = ctx.createGain();
    src.buffer = p.buf;
    src.connect(fade); fade.connect(bass); bass.connect(high); high.connect(hp); hp.connect(vol); vol.connect(g.entry);
    vol.gain.setValueAtTime(0, T);
    vol.gain.linearRampToValueAtTime(base, T + SWITCH);
    hold(g.gate.gain, ctx.currentTime);
    g.gate.gain.setValueAtTime(1, T);
    g.gate.gain.linearRampToValueAtTime(0, T + SWITCH);
    src.start(T, idxT / sr);

    const me = {
      phase: 'asked', oldId: st.id, N, mix, src, fade, bass, high, hp, vol, base, muted: false,
      aPos: p.start + idxT / sr - st.off,   // old song's position (s) at T, for the lyrics
      T, askedAt: 0, playedAt: 0, newId: '', newAt: 0, mixEnd: 0,
      tailEnd: T + (p.buf.duration - idxT / sr),
    };
    // Automix: the blend starts on the audio clock where the old song reaches its mix-out point.
    if (mix) me.t0 = T + (mix.mixOutTrackTime - me.aPos);
    live = me;
    plan = null;
    log('handover done, tail gain', base.toFixed(2), mix ? ', blend in ' + (me.t0 - ctx.currentTime).toFixed(2) + ' s' : '', ', pressing next');
    src.onended = () => { if (live === me) finishLive(); };
    setTimeout(() => {
      if (live !== me) return;
      me.askedAt = graph()?.ctx.currentTime || 0;
      post({ type: 'next' });
    }, Math.max(0, (T + SWITCH - ctx.currentTime) * 1000) + 10);
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
    g.gate.gain.setValueCurveAtTime(FADE_IN, now, M);
    live.fade.gain.cancelScheduledValues(now);
    live.fade.gain.setValueCurveAtTime(FADE_OUT, now, M);
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
    if (!g || !L) return;
    cleanup(L, g, false);
    dropPlan();
    reqId = ''; failedId = ''; tries = 0;
  }

  function abortLive(why = '') {
    log('aborted crossfade', why);
    const g = graph(), L = live;
    live = null;
    if (L?.mix) {
      deck?.cancel();
      if (L.mix.style === 'loop') stopLoopDecks(true);
      for (const t of L.toastTimers || []) clearTimeout(t);
      hideAutomixNotification();
    }
    if (!g || !L) return;
    cleanup(L, g, true);
    dropPlan();
    // Only the song that couldn't hand over is skipped by the next tries; once
    // the next song plays (an ad, a pause or a seek cut the mix short), it is
    // a new song with its own mix ahead of it.
    failedId = st && st.id === L.oldId ? st.id : '';
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

  const SEEK_ERROR_SEC = 0.25;   // off by more than this, a seek; below it, a rate nudge
  const DEADBAND_SEC = 0.006;    // inside this, on the beat
  const MAX_NUDGE = 0.03;        // 3% is below what a listener hears with pitch preserved
  const MAX_QUIET_NUDGE = 0.1;   // while the deck's gain is under 0.3
  const SERVO_GAIN = 0.8;        // seconds of error corrected per second of playback
  const SERVO_MS = 40;
  let deck = null;               // the incoming song's deck, while it is held or still gliding

  class PlayerDeck {
    constructor(g, v, id) {
      Object.assign(this, {
        g, v, id, timeline: new Timeline(), latency: 0.25, errors: [], seekingUntil: 0, ownSeekUntil: 0,
        held: false, startAt: 0, startAsked: 0, foreign: false, done: false, seeks: 0,
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
        if (took > 0 && took < 1.5) this.latency = this.latency * 0.5 + took * 0.5;
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
      const expected = this.timeline.trackTimeAt(now), rate = this.timeline.rateAt(now), p = this.pos();
      if (expected === null || !rate || p === null || v.paused || v.seeking || now < this.seekingUntil) return;
      const error = p - expected;
      if (Math.abs(error) > SEEK_ERROR_SEC) { this.seek(expected + this.latency * rate); return; }
      // currentTime moves in audio-callback steps: a short median keeps the nudge off that jitter
      this.errors.push(error);
      if (this.errors.length > 5) this.errors.shift();
      const smoothed = [...this.errors].sort((a, b) => a - b)[this.errors.length >> 1];
      this.lastError = smoothed;
      // still quiet (its first bars): nobody hears a 10% nudge at -20 dB
      const limit = this.g.gate.gain.value < 0.3 ? MAX_QUIET_NUDGE : MAX_NUDGE;
      const nudge = Math.abs(smoothed) < DEADBAND_SEC ? 0 : clamp(-smoothed * SERVO_GAIN * (limit / MAX_NUDGE), -limit, limit);
      const want = rate * (1 + nudge);
      if (Math.abs(v.playbackRate - want) > 0.0015) v.playbackRate = want;
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
    // Loads [startSec, endSec) of a decoded song.
    async load(key, buffer, startSec, endSec) {
      this.stop();
      await this.stretch.dropBuffers();
      const from = Math.max(0, Math.floor(startSec * buffer.sampleRate));
      const to = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
      const channels = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice(from, to));
      if (channels.length === 1) channels.push(channels[0].slice());
      await this.stretch.addBuffers(channels);
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
        param.cancelScheduledValues(now);
        param.setValueAtTime(v, now);
      }
    }
  }

  // BitChord AutoDJ.prepareLoopMix: picks the bars to loop and loads both
  // decks in the background while the song plays (from 100 s before its end).
  // Each song is decoded once from its downloaded copy; the decks keep only
  // the stretch they play, and the outgoing song's tail for the hand-over is
  // cut from the same samples, so the switch onto its deck is seamless.
  let loopPrep = { key: '', state: 'idle' };
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
      const [outBuffer, inBuffer] = await Promise.all([g.ctx.decodeAudioData(ob), g.ctx.decodeAudioData(ib)]);
      const [sungOut, sungIn] = await lyrics;
      if (!still()) return;
      const plan = A.planLoopMix(cur, outBuffer, nxt, inBuffer, pos + A.LOOP.LOOP_SETUP_SEC, { out: sungOut, in: sungIn });
      log(`automix: sung parts from ${sungOut ? 'synced lyrics' : 'the vocal mask'} (playing song) and ${sungIn ? 'synced lyrics' : 'the vocal mask'} (next song)`);
      if (!plan || plan.none) return none(plan?.none || 'no beat grid to loop on');
      if (!deckOut) { deckOut = g.ctx.createGain(); deckOut.connect(g.entry); }
      if (!loopDecks) {
        loopDecksMaking ??= Promise.all([LoopDeck.create(g.ctx, deckOut), LoopDeck.create(g.ctx, deckOut)])
          .finally(() => { loopDecksMaking = null; });
        loopDecks ??= await loopDecksMaking;
      }
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
      if (loopPrep === me) none(String(e?.message || e));
    }
  }

  // The loop mix on the clock (BitChord scheduleLoopMix + AutoDJ.scheduleLoop).
  // The old song is on its decoded copy (cut from the deck's own samples), so
  // at its loop start it crosses onto the outgoing deck in 25 ms. YouTube's
  // player waits on the new song, silent and held to the clock, and takes
  // over from the incoming deck two bars after that deck's loop lets go.
  function beginLoopMix(g, v) {
    const ctx = g.ctx, now = ctx.currentTime, m = live.mix, A = window.__viviAutomix;
    const [od, idk] = loopDecks;
    const x = A.loopSchedule(m.loop, live.t0), H = x.HANDOVER_SEC, t0 = x.t0;
    deckOut.gain.cancelScheduledValues(now);
    deckOut.gain.setValueAtTime(live.muted ? 0 : live.base, now);
    od.schedule(x.outChanges);
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
    // the new song on YouTube's player: silent, held to the clock, takes over at elementAt
    resetPlayerFilters(g);
    const inn = g.gate.gain;
    inn.cancelScheduledValues(now); inn.setValueAtTime(0, now); inn.setValueAtTime(0, x.elementAt); inn.linearRampToValueAtTime(1, x.elementAt + H);
    deck?.cancel();
    deck = new PlayerDeck(g, v, st.id);
    deck.playAt(x.elementAt - 1.5, x.elementTrackTime - 1.5, 1);
    deck.setRate(1, x.elementAt + 3);   // held to the clock until well after it takes over

    const D = x.elementAt - t0;
    live.toastTimers = [
      setTimeout(() => showAutomixNotification('Automix · loop mix', `${m.loop.out.bars}-bar loop · ${Math.round(m.loop.out.bpm)}→${Math.round(m.loop.in.bpm)} BPM · ${D.toFixed(1)} s`), Math.max(0, (t0 - ctx.currentTime) * 1000)),
      setTimeout(finishAutomixNotification, Math.max(0, (x.elementAt - ctx.currentTime) * 1000)),
    ];
    log(`automix: loop mix, ${m.loop.totalBars} bars (${D.toFixed(1)} s), starting in ${(t0 - now).toFixed(2)} s; the player takes over at ${x.elementTrackTime.toFixed(2)} s of the new song`);
    live.phase = 'mixing';
    live.mixId = st.id;
    live.mixStart = t0;
    live.mixEnd = x.elementAt + 0.15;
    live.handoffAt = x.handoffAt;
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

    // gains: equal-power cross
    const inn = g.gate.gain, out = live.fade.gain;
    inn.cancelScheduledValues(now); inn.setValueAtTime(0, now); inn.setValueCurveAtTime(EP_IN, t0, D);
    out.cancelScheduledValues(now); out.setValueAtTime(1, now); out.setValueCurveAtTime(EP_OUT, t0, D);

    resetPlayerFilters(g);
    const style = matched ? m.style : 'crossfade';
    const mid = t0 + D / 2, bar = Math.min(m.barSec || 0, D / 2);
    const swap = (to, from) => {
      // incoming low end cut until the midpoint, then the two hand over within one bar
      to.setValueAtTime(m.swapDb, now + 0.01); to.setValueAtTime(m.swapDb, mid - bar / 2); to.linearRampToValueAtTime(0, mid + bar / 2);
      from.setValueAtTime(0, mid - bar / 2); from.linearRampToValueAtTime(m.swapDb, mid + bar / 2);
    };
    if (style === 'blend') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.high.gain.setValueAtTime(0, t0); live.high.gain.linearRampToValueAtTime(-8, t0 + D);
      if (g.highFilter) { const h = g.highFilter.gain; h.setValueAtTime(-8, now + 0.01); h.setValueAtTime(-8, t0); h.linearRampToValueAtTime(0, t0 + D); }
    } else if (style === 'filter') {
      if (g.bassFilter) swap(g.bassFilter.gain, live.bass.gain);
      live.hp.frequency.setValueAtTime(20, t0); live.hp.frequency.exponentialRampToValueAtTime(1800, t0 + D);
      if (g.lowpass) { const lp = g.lowpass.frequency; lp.setValueAtTime(350, now + 0.01); lp.setValueAtTime(350, t0); lp.exponentialRampToValueAtTime(20000, t0 + D); }
    }

    const title = style === 'blend' ? 'Automix' : style === 'filter' ? 'Automix · filter mix' : 'Automix · crossfade';
    const sub = style === 'crossfade'
      ? `${D.toFixed(1)} s${m.reason ? ' · ' + m.reason : ''}`
      : `${m.bars} bars · ${D.toFixed(1)} s · ${Math.round(m.bpm)} BPM${style === 'blend' && Math.abs(rate - 1) > 0.002 ? ` · ×${rate.toFixed(3)}` : ''}`;
    live.toastTimers = [
      setTimeout(() => showAutomixNotification(title, sub), Math.max(0, (t0 - ctx.currentTime) * 1000)),
      setTimeout(finishAutomixNotification, Math.max(0, (t0 + D - ctx.currentTime) * 1000)),
    ];
    log(`automix: ${style}${style !== 'crossfade' ? ' of ' + m.bars + ' bars' : ''}, ${D.toFixed(1)} s, starting in ${(t0 - now).toFixed(2)} s; next song from ${m.mixInTrackTime.toFixed(2)} s at x${rate.toFixed(3)}${m.reason ? ' (' + m.reason + ')' : ''}`);
    live.phase = 'mixing';
    live.mixId = st.id;
    live.mixStart = t0;
    live.mixEnd = t0 + D;
  }

  // ───────── per-tick logic while a crossfade is in progress ─────────
  function driveLive(g, v) {
    const now = g.ctx.currentTime;
    if (seconds() === 0 || !v || g.video !== v) { abortLive('crossfade off or player changed'); return; }

    // honour a mute that happens while the tail is still audible
    const muted = v.muted || v.volume === 0;
    if (muted !== live.muted && now > live.T + 0.1) {
      live.muted = muted;
      live.vol.gain.cancelScheduledValues(now);
      live.vol.gain.setTargetAtTime(muted ? 0 : live.base, now, 0.03);
      if (deckOut && live.mix?.style === 'loop') { deckOut.gain.cancelScheduledValues(now); deckOut.gain.setTargetAtTime(muted ? 0 : live.base, now, 0.03); }
    }

    if (live.phase === 'asked') {
      if (!live.askedAt) return;
      const sinceAsk = now - live.askedAt;
      const changed = st && st.id && st.id !== live.oldId;
      if (!changed) {
        if (sinceAsk > 1 && v.paused) abortLive('paused');   // user paused, or next did nothing
        else if (sinceAsk > 8) abortLive('next song never started');
        return;
      }
      if (!live.newId) { live.newId = st.id; live.newAt = now; }
      else if (st.id !== live.newId) { abortLive('skipped again'); return; }
      if (st.ad) { abortLive('ad'); return; }
      // YouTube can switch the title before the <video> really plays the new
      // song. Fading the player back in then replays the old song's last
      // moments over the tail. Only bring it in once its position looks like
      // the start of the new song.
      const newPos = v.currentTime - (st.off || 0);
      const fresh = newPos >= 0 && newPos < (now - live.askedAt) + 2;
      const audible = fresh && !v.paused && (live.playedAt >= live.askedAt || now - live.newAt > 1.2);
      if (audible) {
        if (live.mix?.style === 'loop') {
          if (st.id === live.mix.nextId && g.ctx.currentTime < live.t0 - 0.3) beginLoopMix(g, v);
          else {
            // the queue played another song, or the loop start has passed: a plain crossfade
            log('automix: loop mix not possible now, crossfading instead');
            live.mix = { ...live.mix, style: 'crossfade', reason: 'loop mix missed', mixInTrackTime: 0, rate: 1, durationSec: 12 };
            beginAutomix(g, v);
          }
        } else if (live.mix) beginAutomix(g, v);
        else beginMix(g);
      }
      else if (now - live.newAt > 5) abortLive('next song silent');
    } else if (live.phase === 'mixing') {
      const ours = live.mix && deck && deck.id === live.mixId && deck.holding;   // our own hold before the start
      if (st.ad) abortLive('ad');   // an ad mid-blend: stop steering the player (its rate would go to the ad)
      else if ((v.paused && !ours) || st.id !== live.mixId) abortLive(v.paused ? 'paused' : 'song changed');
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

  function showAutomixNotification(title, subtitle) {
    try {
      clearToastTimers();
      let toast = toastEl();
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'vivi-automix-toast';
        document.body.appendChild(toast);
      }
      toast.classList.remove('vivi-automix-done', 'vivi-automix-swap');
      toast.style.width = '';
      toast.replaceChildren(...toastBody('🎧', title, subtitle, true));
      // Let the hidden state render first, or a toast made just now would
      // appear in place instead of sliding up.
      void toast.offsetWidth;
      requestAnimationFrame(() => toast.classList.add('vivi-automix-visible'));
    } catch (e) {
      console.warn('[Vivi Crossfade] Toast error:', e);
    }
  }

  function finishAutomixNotification() {
    try {
      const toast = toastEl();
      if (!toast || !toast.classList.contains('vivi-automix-visible')) return;
      clearToastTimers();
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

  function hideAutomixNotification() {
    const toast = toastEl();
    if (!toast) return;
    clearToastTimers();
    toast.classList.remove('vivi-automix-visible', 'vivi-automix-swap');
    toastTimers.push(setTimeout(() => { if (!toast.classList.contains('vivi-automix-visible')) toast.style.width = ''; }, 400));
  }

  // ───────── main tick ─────────
  setInterval(() => {
    const g = graph();
    const v = g?.video;
    if (live) { if (g) driveLive(g, v); else live = null; return; }
    if (skip) return;   // a manual skip is being prepared

    const N = seconds();
    if (!N || !g || !v || !st || performance.now() - stAt > 1500) return;
    if (g.ctx.state !== 'running' || g.video !== document.querySelector('#movie_player video, ytmusic-player video, video')) return;
    watchVideo(v);
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
        let p = A.plan({ fromId: st.id, toId: st.next, from, to, durationSec: st.dur, pos, earliest: pos + HAND_LEAD + 0.5 });
        p.nextId = st.next || '';
        // The loop mix (BitChord AutoDJ): prepared in the background from
        // 100 s before the end; when it found bars to loop, it is the mix.
        const pairKey = st.id + '>' + (st.next || '');
        // (and before the blend is settled, if that comes first)
        const prepNow = remaining < A.LOOP.LOOP_PREPARE_SEC || pos > p.mixOutTrackTime - HAND_LEAD - TAIL_LEAD - 25;
        if (st.next && from && to && prepNow && loopPrep.key !== pairKey) prepareLoopMix(g, st.id, st.next, pos);
        const loopPending = loopPrep.key === pairKey && loopPrep.state === 'loading';
        const lp = loopPrep.key === pairKey && loopPrep.state === 'ready' ? loopPrep : null;
        if (lp && lp.plan.out.loop[0] > pos + HAND_LEAD + 1) {
          const x = A.loopSchedule(lp.plan, 0);
          p = { ...p, style: 'loop', loop: lp.plan, fallback: false, reason: '', mixOutTrackTime: lp.plan.out.loop[0], durationSec: x.elementAt,
            mixInTrackTime: x.elementTrackTime, rate: 1, bars: lp.plan.totalBars, bpm: lp.plan.out.bpm, inBpm: lp.plan.in.bpm, nextId: st.next };
        }
        amx.plan = p;
        if (!(p.durationSec >= 1)) { amxGiveUp('no room left for a blend'); }
        else if (pos >= p.mixOutTrackTime - HAND_LEAD - TAIL_LEAD && !(loopPending && pos < p.mixOutTrackTime - HAND_LEAD - 8)) {
          const needFrom = st.off + Math.max(0, p.mixOutTrackTime - HAND_LEAD - 3);
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
            post({ type: 'prepare', id: st.id, sampleRate: g.ctx.sampleRate, needFrom, cover: p.durationSec + HAND_LEAD + 3, automix: true });
          }
        }
        A.setStatus(amx.state === 'fallback' ? 'fallback' : 'planned', { bpm: p.bpm, conf: from ? (from.tailGrid?.gridConfidence ?? from.gridConfidence) : null, mix: p });
      }
      if (amx.state === 'ready' && plan && plan.id === st.id && tap) {
        const handAt = amx.plan.mixOutTrackTime - HAND_LEAD;
        if (pos > handAt + 1) { amx.state = 'idle'; return; }   // seeked past it: plan again from here
        if (pos >= handAt - TICK_MS / 2000) {
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

  window.__viviCrossfade = {
    active: () => !!live,
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
        deck: deck && { id: deck.id, rate: deck.v.playbackRate, error: deck.lastError ?? null, seeks: deck.seeks, held: deck.held },
      },
    }),
  };
})();

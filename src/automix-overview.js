/* VIVIMUSIC WEB — automix-overview.js
 *
 * The Automix overview (BitChord's MixViewPopup, with Spotify Mix's
 * per-transition choices): the coming mix, or the one playing, drawn on its
 * own clock. Each song gets a 3-band waveform (low under 200 Hz, mid to
 * 2.5 kHz, high above), dimmed outside the mix; the mix is framed, with its
 * beat grid (bars brighter) and each song's fader curve.
 *
 * Beyond BitChord, the transition editor (spec/automix/editor.md): a preset
 * or custom lanes, beat match, a length (Auto, 2 to 32 bars) and the window
 * (each song dragged under the mix, snapped to its grid, nudged in 10 ms) can
 * be set for each pair of songs, kept (or locked) for the next time the pair
 * plays, and Preview jumps to just before the mix. A lane can be drawn point by
 * point instead (editor.md §10): Draw in its dropdown, then the curve chips.
 *
 * Opened by its button in the player bar (while Automix is on) or by
 * clicking the Automix toast. Everything here only reads what crossfade.js plans
 * (window.__viviCrossfade.overview()); a pick goes back through setPairPick.
 */
(() => {
  'use strict';
  if (window.__viviAutomixOverview) return;

  const COLORS = { low: '#2E45E6', mid: '#E08B35', high: '#F1DDC4', frame: '#3A9BDC' };
  const OUTSIDE_ALPHA = 0.32;      // audio outside the mix
  const BANDS = ['low', 'mid', 'high'];
  const FR = 40;                   // waveform columns per second of song
  const DECODE_SR = 22050;
  // editor.md §2-§4, §7
  // Spotify's preset row in its order (editor.md §2), then this app's Loop
  const PRESETS = [['auto', 'Auto'], ['custom', 'Custom'], ['smooth', 'Fade'], ['rise', 'Rise'], ['wave', 'Wave'], ['blend', 'Blend'], ['slam', 'Slam'], ['melt', 'Melt'],
    ['afterglow', 'Afterglow'], ['surge', 'Surge'], ['dissolve', 'Dissolve'], ['none', 'No transition'], ['loop', 'Loop']];
  const BEAT_MATCH = [['auto', 'Auto'], ['sync', 'Sync'], ['glide', 'Glide'], ['off', 'Off']];
  const BARS = [[0, 'Auto'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [32, '32']];
  const LANE_OPTIONS = {
    // (Spotify's names for its shapes, spotify-mixes.md rule 4)
    volume: [['smooth', 'Smooth crossfade'], ['crossfade', 'Crossfade'], ['overlap', 'Overlap'], ['cutInFadeOut', 'Cut in fade out'], ['fadeInCutOut', 'Fade in cut out'], ['centerCut', 'Center cut'],
      ['fadeInFadeOut', 'Fade in fade out'], ['fadeInFastOut', 'Fade in fast out'], ['fadeIn1BarCutOut', 'Fade in 1 bar cut out'], ['overlap1BarCutOut', 'Overlap 1 bar cut out']],
    eq: [['centerBassSwap', 'Center bass swap'], ['endBassSwap', 'End bass swap'], ['startBassSwap', 'Start bass swap'], ['threeBandFade', '3-band fade'],
      ['quickBassCut', 'Quick bass cut'], ['longBassCut', 'Long bass cut'], ['bassFadeOut', 'Bass fade out'], ['none', 'None']],
    effect: [['none', 'None'], ['hpIn', 'High pass filter in'], ['hpOut', 'High pass filter out'], ['hpBoth', 'High pass filter in high pass filter out'],
      ['lpIn', 'Low pass filter in'], ['lpOut', 'Low pass filter out'], ['lpBoth', 'Low pass filter in low pass filter out'],
      ['hpInLpOut', 'High pass filter in low pass filter out'], ['lpInHpOut', 'Low pass filter in high pass filter out'], ['hpHalfOut', 'High-pass filter half out'], ['noiseOutEnd', 'Noise out end']],
    // editor.md §12: Spotify's Effects list
    fx: [['none', 'None'], ['echo1CutEnd', 'Echo 1 cut end'], ['echo34CutEnd', 'Echo ¾ cut end'], ['echoHalfCutEnd', 'Echo ½ cut end'],
      ['echo1OutEnd', 'Echo 1 out end'], ['echo34OutEnd', 'Echo ¾ out end'], ['echoHalfOutEnd', 'Echo ½ out end'],
      ['delay34CutEnd', 'Delay ¾ cut end'], ['delayHalfCutEnd', 'Delay ½ cut end'],
      ['reverbCutEnd', 'Reverb cut end'], ['reverbOutEnd', 'Reverb out end'], ['reverbOutCenter', 'Reverb out center']],
  };
  for (const k of Object.keys(LANE_OPTIONS)) LANE_OPTIONS[k].push(['draw', 'Draw…']);
  // editor.md §13: the playing song loops its first N beats of the window (a shape only, never drawn)
  LANE_OPTIONS.looping = [['none', 'None'], ['loop1', '1 beat loop'], ['loop2', '2 beat loop'], ['loop4', '4 beat loop'], ['loop8', '8 beat loop'], ['loop16', '16 beat loop']];
  const LANE_COLORS = { volume: '#4C8DFF', eq: '#F5C542', effect: '#A779FF', fx: '#E8E8E8', looping: '#5FD39A' };
  const NUDGE_MS = 10, NUDGE_MAX_MS = 2000;
  // editor.md §10: the drawable curves: plan key, chip, lane, name in the stored deck, and the
  // lane's height (0 at the bottom, 1 at the top) as the canvas draws it
  const LOG1K = Math.log(1000);
  const CURVES = {
    gain: { chip: 'Volume', lane: 'volume', name: null, norm: (v) => v, value: (n) => n },
    bassDb: { chip: 'Bass', lane: 'eq', name: 'bass', norm: (v) => 1 + v / 18, value: (n) => 18 * n - 18 },
    highDb: { chip: 'High', lane: 'eq', name: 'high', norm: (v) => 1 + v / 18, value: (n) => 18 * n - 18 },
    lowpassHz: { chip: 'Lowpass', lane: 'effect', name: 'lp', norm: (v) => Math.log(v / 20) / LOG1K, value: (n) => 20 * Math.pow(1000, n) },
    highpassHz: { chip: 'Highpass', lane: 'effect', name: 'hp', norm: (v) => 1 - Math.log(v / 20) / LOG1K, value: (n) => 20 * Math.pow(1000, 1 - n) },
    // editor.md §12
    midDb: { chip: 'Mid', lane: 'eq', name: 'mid', norm: (v) => 1 + v / 18, value: (n) => 18 * n - 18 },
    noise: { chip: 'Noise', lane: 'effect', name: 'noise', norm: (v) => v, value: (n) => n },
    echoSend: { chip: 'Echo', lane: 'fx', name: 'echo', norm: (v) => v, value: (n) => n },
    reverbSend: { chip: 'Reverb', lane: 'fx', name: 'reverb', norm: (v) => v, value: (n) => n },
    delaySend: { chip: 'Delay', lane: 'fx', name: 'delay', norm: (v) => v, value: (n) => n },
  };
  // a new curve in an empty deck: open (0 dB, the filter open, no noise, nothing sent)
  const OPEN = { bassDb: 0, midDb: 0, highDb: 0, lowpassHz: 20000, highpassHz: 20, noise: 0, echoSend: 0, reverbSend: 0, delaySend: 0 };
  const MAX_POINTS = 128, UNDO_MAX = 50, HIT_PX = 7;

  const xf = () => window.__viviCrossfade;
  const A = () => window.__viviAutomix;
  const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ───────── a song's 3-band waveform ─────────
  // Decoded on demand from the song automix already downloaded, at 22 kHz
  // mono, and filtered here in slices (the page stays responsive). The last
  // few songs are kept. Without the download, the analysis' energy curve.
  const waves = new Map();       // id -> Promise<{ low, mid, high, fr, coarse? }>
  const waveCache = new Map();   // id -> the same, once there (the drawing is synchronous)
  function waveOf(id) {
    if (waves.has(id)) return waves.get(id);
    const p = (async () => {
      try {
        const bytes = await A().audioBytes(id);
        const ctx = new OfflineAudioContext(1, DECODE_SR, DECODE_SR);
        const buf = await ctx.decodeAudioData(bytes);
        return await bandsOf(buf);
      } catch {
        const a = A()?.get(id);
        const c = a?.energyCurve;
        if (!c?.length || !(a.durationSec > 0)) return null;
        const max = Math.max(...c) || 1;
        const mid = Float32Array.from(c, (v) => v / max);
        return { low: new Float32Array(mid.length), mid, high: new Float32Array(mid.length), fr: c.length / a.durationSec, coarse: true };
      }
    })();
    waves.set(id, p);
    p.then((w) => {
      if (!w) { waves.delete(id); return; }
      waveCache.set(id, w);
      while (waveCache.size > 6) waveCache.delete(waveCache.keys().next().value);
    });
    while (waves.size > 6) waves.delete(waves.keys().next().value);
    return p;
  }
  // RBJ biquad coefficients
  function biquad(type, f, sr, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    const a0 = 1 + al;
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
  }
  async function bandsOf(buf) {
    const x = buf.getChannelData(0), sr = buf.sampleRate, hop = Math.round(sr / FR);
    const n = Math.floor(x.length / hop);
    const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
    const L = biquad('lp', 200, sr), H = biquad('hp', 2500, sr);
    let l1 = 0, l2 = 0, ly1 = 0, ly2 = 0, h1 = 0, h2 = 0, hy1 = 0, hy2 = 0;
    const slice = sr * 8;
    for (let start = 0; start < n * hop; start += slice) {
      const end = Math.min(n * hop, start + slice);
      for (let i = start; i < end; i++) {
        const s = x[i];
        const lo = L.b0 * s + L.b1 * l1 + L.b2 * l2 - L.a1 * ly1 - L.a2 * ly2;
        l2 = l1; l1 = s; ly2 = ly1; ly1 = lo;
        const hi = H.b0 * s + H.b1 * h1 + H.b2 * h2 - H.a1 * hy1 - H.a2 * hy2;
        h2 = h1; h1 = s; hy2 = hy1; hy1 = hi;
        const k = (i / hop) | 0;
        const al = lo < 0 ? -lo : lo, ah = hi < 0 ? -hi : hi, md = s - lo - hi, am = md < 0 ? -md : md;
        if (al > low[k]) low[k] = al;
        if (am > mid[k]) mid[k] = am;
        if (ah > high[k]) high[k] = ah;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    // one scale for the three bands: the song's loud parts fill the lane
    const all = Float32Array.from(low, (v, i) => Math.max(v, mid[i], high[i])).sort();
    const top = all[Math.floor(all.length * 0.99)] || 1;
    for (const b of [low, mid, high]) for (let i = 0; i < n; i++) b[i] = Math.min(1, b[i] / top);
    return { low, mid, high, fr: FR };
  }

  // ───────── the mix on its own clock ─────────
  // Track seconds each song plays at mix time t (null: silent), and its fader.
  function lanes(s) {
    const m = s.mix, x = s.x, D = s.D;
    const seg = (changes, t) => {
      let c = null;
      for (const ch of changes) { if (ch.output <= t) c = ch; else break; }
      return c && c.active ? c.input + (t - c.output) * c.rate : null;
    };
    const sample = (arr, p) => {
      if (!arr) return p;
      const f = Math.max(0, Math.min(1, p)) * (arr.length - 1), i = Math.floor(f), r = f - i;
      return arr[i] + ((arr[Math.min(arr.length - 1, i + 1)] ?? arr[i]) - arr[i]) * r;
    };
    if (x) {
      const outAt = m.loop.out.loop[0];
      const lin = (t, pts) => {   // piecewise linear through [t, v] points
        if (t <= pts[0][0]) return pts[0][1];
        for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * ((t - a) / Math.max(1e-6, b - a)); }
        return pts[pts.length - 1][1];
      };
      return {
        out: (t) => (t < 0 ? outAt + t : t < x.releaseAt ? seg(x.outChanges, t) : null),
        in: (t) => (t < 0 ? null : t < x.releaseAt ? seg(x.inChanges, t) : m.loop.in.loop[1] + (t - x.releaseAt)),
        gOut: (t) => lin(t, [[0, 1], [x.enterEnd, 1], [x.rampEnd, 0.6], [x.releaseAt, 0]]),
        gIn: (t) => lin(t, [[0, 0], [x.enterEnd, 0.55], [x.rampEnd, 1]]),
      };
    }
    const outRate = m.outRate || 1, rate = m.rate || 1;
    // (each song's playlist speed, spotify-mixes.md rule 10: A at its own before the mix, B at its own after it)
    const sOut = m.speedOut > 0 ? m.speedOut : 1, sIn = m.speedIn > 0 ? m.speedIn : 1;
    return {
      out: (t) => (t < 0 ? m.mixOutTrackTime + t * sOut : t <= D ? m.mixOutTrackTime + t * outRate : null),
      // (a late entry: B is silent, and not drawn, until inDelaySec into the mix)
      in: (t) => (t < (m.inDelaySec || 0) ? null : t <= D ? m.mixInTrackTime + (t - (m.inDelaySec || 0)) * rate : m.mixInTrackTime + (D - (m.inDelaySec || 0)) * rate + (t - D) * sIn),
      gOut: (t) => (t < 0 ? 1 : t > D ? 0 : sample(s.gOut, t / D)),
      gIn: (t) => (t < 0 ? 0 : t > D ? 1 : sample(s.gIn, t / D)),
    };
  }
  // the beats to draw: the loop mix's own, else the blend's tempo from its start
  function beatsOf(s, t0, t1) {
    if (s.x) return s.x.beatTimes.map((t, k) => ({ t, bar: k % 4 === 0 }));
    const bpm = s.mix.bpm;
    if (!(bpm > 0) || s.mix.style === 'crossfade') return [];
    const b = 60 / bpm, out = [];
    for (let k = Math.ceil(t0 / b); k * b <= t1; k++) out.push({ t: k * b, bar: ((k % 4) + 4) % 4 === 0 });
    return out;
  }

  // the canvas's layout (drawStatic, and the drawing editor's hit tests)
  function layout(D, w, h) {
    const pad = Math.max(4, D * 0.24), t0 = -pad, t1 = D + pad;
    const gap = 10, laneH = (h - gap * 3) / 2;
    const top = [gap, gap * 2 + laneH];
    return {
      t0, t1, top, laneH,
      X: (t) => ((t - t0) / (t1 - t0)) * w,
      T: (x) => t0 + (x / w) * (t1 - t0),
      // a curve's height n (0..1) in deck k's half: the fader's own scale for volume, the EQ/filter one else
      Y: (key, k, n) => (key === 'gain' ? top[k] + laneH - 1 - n * (laneH - 4) : top[k] + 2 + (1 - n) * (laneH - 6)),
      N: (key, k, y) => Math.max(0, Math.min(1, key === 'gain' ? (top[k] + laneH - 1 - y) / (laneH - 4) : 1 - (y - top[k] - 2) / (laneH - 6))),
    };
  }

  // ───────── the dialog ─────────
  let ui = null;   // { root, card, canvas, ... } while open
  let frame = 0, sig = '', staticLayer = null, songsSig = '', drawnShape = null;

  function open() {
    if (ui) return;
    const root = el('div', 'vivi-amx-ov');
    root.id = 'vivi-amx-ov';
    const card = el('div', 'vivi-amx-ov-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Automix overview');
    const head = el('div', 'vivi-amx-ov-head');
    const titles = el('div', 'vivi-amx-ov-titles');
    const title = el('div', 'vivi-amx-ov-title', 'Automix');
    const sub = el('div', 'vivi-amx-ov-sub', '');
    titles.append(title, sub);
    const close = el('button', 'vivi-amx-ov-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hide);
    head.append(titles, close);
    const songsRow = el('div', 'vivi-amx-ov-songs');
    const well = el('div', 'vivi-amx-ov-well');
    const canvas = el('canvas', 'vivi-amx-ov-canvas');
    const msg = el('div', 'vivi-amx-ov-msg', '');
    well.append(canvas, msg);
    // editor.md §11: the progress row, under the drawing well: hidden until first shown, then it keeps its room
    const prog = el('div', 'vivi-amx-ov-prog');
    const progText = el('div', 'vivi-amx-ov-prog-text', '');
    const progBar = el('div', 'vivi-amx-ov-prog-bar');
    const progFill = el('i');
    progBar.append(progFill);
    prog.append(progText, progBar);
    prog.hidden = true;
    const legend = el('div', 'vivi-amx-ov-legend');
    for (const [k, t] of [['low', 'Low'], ['mid', 'Mid'], ['high', 'High'], ['volume', 'Volume'], ['eq', 'EQ'], ['effect', 'Filter'], ['fx', 'Effects']]) {
      const i = el('span', 'vivi-amx-ov-key');
      const sw = el('i');
      sw.style.background = COLORS[k] || LANE_COLORS[k];
      i.append(sw, document.createTextNode(t));
      legend.append(i);
    }
    const clock = el('span', 'vivi-amx-ov-clock', '');
    legend.append(clock);
    const controls = el('div', 'vivi-amx-ov-controls');
    // a shape or preset over a drawing asks first, and Undo brings the drawing back (editor.md §10 rule 7)
    const presetRow = chipRow('Preset', PRESETS, (v) => { if (v !== 'custom' && !replaceDrawing(null)) { sig = ''; return; } pick(v === 'custom' ? { preset: 'custom', lanes: lanesNow() } : { preset: v }); });
    const custom = el('details', 'vivi-amx-ov-custom');
    custom.append(el('summary', '', 'Customize'));
    const laneSel = {};
    // Spotify's lane names: the `effect` lane is its Filter (editor.md §2)
    for (const [k, label] of [['volume', 'Volume'], ['eq', 'EQ'], ['effect', 'Filter'], ['fx', 'Effects'], ['looping', 'Looping']]) {
      const lab = el('label', 'vivi-amx-ov-lane');
      const sw = el('i');
      sw.style.background = LANE_COLORS[k];
      const sel = el('select');
      for (const [v, t] of LANE_OPTIONS[k]) { const o = el('option', '', t); o.value = v; sel.append(o); }
      sel.addEventListener('change', () => {
        if (sel.value === 'draw') { startDraw(k); return; }
        if (!replaceDrawing(k)) { sig = ''; return; }
        pick({ preset: 'custom', lanes: { ...lanesNow(), [k]: sel.value } });
      });
      lab.append(sw, document.createTextNode(label), sel);
      custom.append(lab);
      laneSel[k] = sel;
    }
    // the drawing's tools (editor.md §10 rule 6): which curve, Repeat, Undo
    const drawRow = el('div', 'vivi-amx-ov-draw');
    drawRow.hidden = true;
    const curveChips = chipRow('Draw', [...Object.entries(CURVES).map(([k, c]) => [k, c.chip]), ['', 'Done']], (v) => { drawKey = v || null; pdrag = null; sig = ''; });
    const rep = el('div', 'vivi-amx-ov-repeat');
    const num = (title, v) => { const i = el('input'); i.type = 'number'; i.min = '0'; i.step = '0.25'; i.value = String(v); i.title = title; return i; };
    const repFrom = num('Where the part to repeat starts', 0), repLen = num('How long it is, and how far apart the copies are', 2);
    const repUnit = el('span', '', 'beats');
    const repBtn = el('button', 'vivi-amx-ov-chip', 'Repeat');
    repBtn.type = 'button';
    repBtn.title = 'Copy this part of the chosen line along the window, both songs';
    repBtn.addEventListener('click', () => repeat(Number(repFrom.value), Number(repLen.value)));
    const undoBtn = el('button', 'vivi-amx-ov-chip', 'Undo');
    undoBtn.type = 'button';
    undoBtn.title = 'Undo (Ctrl+Z)';
    undoBtn.addEventListener('click', undoDraw);
    rep.append(document.createTextNode('Repeat from'), repFrom, document.createTextNode('every'), repLen, repUnit, repBtn, undoBtn);
    const drawHint = el('div', 'vivi-amx-ov-hint', '');
    drawRow.append(curveChips.row, rep, drawHint);
    const matchRow = chipRow('Beat match', BEAT_MATCH, (v) => pick({ beatMatch: v }));
    const barsRow = chipRow('Length', BARS, (v) => pick({ bars: Number(v) || null }));
    const winRow = el('div', 'vivi-amx-ov-row');
    winRow.append(el('span', 'vivi-amx-ov-label', 'Window'));
    const nudges = el('div', 'vivi-amx-ov-chips');
    const nudgeBtn = (side, d, text) => {
      const b = el('button', 'vivi-amx-ov-chip', text);
      b.type = 'button';
      b.title = `${side === 'out' ? 'The playing song' : 'The next song'} ${d < 0 ? 'earlier' : 'later'} by ${NUDGE_MS} ms`;
      b.addEventListener('click', () => { if (!b.disabled) nudge(side, d); });
      nudges.append(b);
      return b;
    };
    const nudgeBtns = [nudgeBtn('out', -1, 'A −10 ms'), nudgeBtn('out', 1, 'A +10 ms'), nudgeBtn('in', -1, 'B −10 ms'), nudgeBtn('in', 1, 'B +10 ms')];
    const winReset = el('button', 'vivi-amx-ov-chip', 'Auto');
    winReset.type = 'button';
    winReset.title = 'The planner places the window';
    winReset.addEventListener('click', () => { if (!winReset.disabled) pick({ window: null }); });
    nudges.append(winReset);
    // B's late entry (mix-file.md rule 2): seconds into the mix before B starts at its mix-in
    const lateIn = el('input');
    lateIn.type = 'number'; lateIn.min = '0'; lateIn.max = '60'; lateIn.step = '0.1'; lateIn.value = '0';
    lateIn.title = 'B comes in this long after the mix starts, silent until then (a late entry, as in a Spotify mix); 0: with the mix';
    // (an emptied or unreadable field is no number: nothing saved, the saved one shows again; Number('') was 0 and cleared it)
    lateIn.addEventListener('change', () => setLate(lateIn.value.trim() === '' ? NaN : Number(lateIn.value)));
    const late = el('label', 'vivi-amx-ov-repeat');
    late.append(document.createTextNode('B in after'), lateIn, document.createTextNode('s'));
    nudges.append(late);
    winRow.append(nudges);
    const actions = el('div', 'vivi-amx-ov-actions');
    const lock = el('button', 'vivi-amx-ov-btn', 'Lock');
    lock.type = 'button';
    lock.setAttribute('aria-pressed', 'false');
    lock.title = 'Keep this edit past the 300 kept pairs';
    lock.addEventListener('click', () => { if (!lock.disabled) pick({ lock: lock.getAttribute('aria-pressed') !== 'true' }); });
    const reset = el('button', 'vivi-amx-ov-btn', 'Reset to Auto');
    reset.type = 'button';
    reset.addEventListener('click', () => { const s = xf()?.overview?.(); if (s?.pairKey && !reset.disabled) { xf().setPairPick(s.pairKey, null); refused = null; pendingDraw = null; sig = ''; } });   // (a Draw waiting on a loop mix goes with the edit)
    const preview = el('button', 'vivi-amx-ov-btn', '▶ Preview');
    preview.type = 'button';
    preview.addEventListener('click', () => { const s = xf()?.overview?.(); if (s?.editable) xf().seekTo(s.previewAt); });
    const note = el('span', 'vivi-amx-ov-note', '');
    const badge = el('span', 'vivi-amx-ov-badge', 'Custom');
    badge.hidden = true;
    // Undo outside the drawing's tools: a drawing replaced by a shape or preset comes back
    const undoReplace = el('button', 'vivi-amx-ov-btn', 'Undo');
    undoReplace.type = 'button';
    undoReplace.title = 'Bring the drawing back (Ctrl+Z)';
    undoReplace.hidden = true;
    undoReplace.addEventListener('click', undoDraw);
    actions.append(preview, lock, reset, undoReplace, badge, note);
    // mix files (spec/automix/mix-file.md rule 9): import ready-made mixes, export this pair's or all
    const files = el('div', 'vivi-amx-ov-row vivi-amx-ov-files');
    files.append(el('span', 'vivi-amx-ov-label', 'Mix files'));
    const fileChips = el('div', 'vivi-amx-ov-chips');
    const fileBtn = (text, title, fn) => { const b = el('button', 'vivi-amx-ov-chip', text); b.type = 'button'; b.title = title; b.addEventListener('click', () => { if (!b.disabled) fn(); }); fileChips.append(b); return b; };
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) importFile(f); });
    const importBtn = fileBtn('Import…', 'Add the mixes of a mix file (.json) or a Spotify mix export (spotify-mix-export)', () => fileInput.click());
    const exportPair = fileBtn('Export this pair', "Save these two songs' edit as a mix file", () => exportMixes(true));
    const exportAll = fileBtn('Export all', 'Save every edited pair as one mix file', () => exportMixes(false));
    const playMixes = fileBtn('Play these mixes', "Queue the last imported file's songs in its order and play them", playImported);
    playMixes.disabled = !lastImport?.ids.length;
    const fileNote = el('span', 'vivi-amx-ov-note', '');
    files.append(fileChips, fileInput, fileNote);
    controls.append(presetRow.row, custom, drawRow, matchRow.row, barsRow.row, winRow, actions, files);
    card.append(head, songsRow, well, prog, legend, controls);
    root.append(card);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) hide(); });
    document.body.append(root);
    ui = { root, card, sub, songsRow, canvas, msg, clock, prog, progText, progFill, presetRow, custom, laneSel, matchRow, barsRow, nudgeBtns, winReset, lateIn, preview, lock, reset, badge, note,
      drawRow, curveChips, repUnit, repBtn, undoBtn, undoReplace, drawHint, importBtn, exportPair, exportAll, playMixes, fileNote };
    canvas.addEventListener('dblclick', (e) => pointDelete(e));
    canvas.addEventListener('contextmenu', (e) => { if (drawOn(xf()?.overview?.())) { e.preventDefault(); pointDelete(e); } });
    canvas.addEventListener('pointerdown', dragStart);
    canvas.addEventListener('pointermove', dragMove);
    canvas.addEventListener('pointerup', dragEnd);
    canvas.addEventListener('pointercancel', () => { drag = null; pdrag = null; sig = ''; });
    document.addEventListener('keydown', onKey, true);
    sig = ''; songsSig = ''; staticLayer = null;
    requestAnimationFrame(() => root.classList.add('vivi-open'));
    loop();
  }
  function hide() {
    if (!ui) return;
    const root = ui.root;
    ui = null;
    drag = null;   // (a drag the Esc key cut short is dropped, not saved)
    pdrag = null; drawKey = null; undo.length = 0; pendingDraw = null;
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('vivi-open');
    setTimeout(() => root.remove(), 250);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); hide(); return; }
    // Ctrl+Z: a drawing's last edit back (not while typing in a field)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && undo.length && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) {
      e.stopPropagation(); e.preventDefault(); undoDraw();
    }
  }
  function chipRow(label, items, onPick) {
    const row = el('div', 'vivi-amx-ov-row');
    row.append(el('span', 'vivi-amx-ov-label', label));
    const group = el('div', 'vivi-amx-ov-chips');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const chips = items.map(([v, t]) => {
      const b = el('button', 'vivi-amx-ov-chip', t);
      b.type = 'button';
      b.dataset.v = String(v);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => { if (!b.disabled) onPick(v); });
      group.append(b);
      return b;
    });
    row.append(group);
    return { row, chips };
  }
  // An edit of this pair's override (editor.md §1): merged into what is saved; a field set to its
  // Auto value goes; picking a preset drops a migrated pick's family. The planner gets it next tick.
  let refused = null;   // { pair, text }: a refused save, shown while that pair is on screen
  function pick(change) {
    const s = xf()?.overview?.();
    if (!s?.pairKey || !s.toId) return;
    const next = { ...(A().migratePick(s.pick) || {}), ...change };
    if ('preset' in change) delete next.family;
    if (next.preset !== 'custom') delete next.lanes;
    if (next.preset === 'loop') { delete next.bars; delete next.window; delete next.beatMatch; }
    if (!next.bars) delete next.bars;
    if (!next.window) delete next.window;
    const r = xf().setPairPick(s.pairKey, next);
    refused = r?.refused ? { pair: s.pairKey, text: r.refused } : null;
    sig = '';
  }
  // the lanes on screen: the custom ones, else the preset's, else Smooth's
  function lanesNow() {
    const s = xf()?.overview?.();
    const ov = A().migratePick(s?.pick);
    return { ...(ov?.preset === 'custom' && ov.lanes ? ov.lanes : A().PRESET_LANES[ov?.preset] || A().PRESET_LANES.smooth) };
  }
  // "Auto · <what the planner chose>" (editor.md §7)
  function autoName(m) {
    if (!m) return 'Auto';
    if (m.style === 'loop') return 'Auto · Loop';
    if (m.style === 'filter') return 'Auto · Filter';
    if (m.style === 'crossfade') return m.handoff ? 'Auto · Hand-over' : m.bridge ? 'Auto · Bridge' : 'Auto · Fade';
    return m.shape === 'dropin' ? 'Auto · Drop-in' : m.shape === 'muffle' ? 'Auto · Muffle' : m.shape === 'echo' ? 'Auto · Echo out' : m.glide ? 'Auto · Glide' : 'Auto · Blend';
  }

  // ───────── the window (editor.md §6) ─────────
  // Each song is dragged under the mix's frame: its lane (top: the playing song, A; bottom: the
  // next, B) moves, and the song second at the frame's start is that song's mix-out or mix-in.
  // Snapped to that song's downbeats (beats with Shift), not at all with beat match Off.
  let drag = null;   // { side, x0, base, sec, pos, s, w, span, limit }
  const fmtSec = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
  function gridFor(s, side) { return A().editorGrid?.(A().get(side === 'out' ? s.fromId : s.toId), side) || null; }
  // a song second as a saved position: { bar, beat?, nudgeMs?, sec } on that song's grid
  function positionOf(sec, grid, snap, beats) {
    if (!grid) return { bar: 0, sec };
    const b = grid.beatSec;
    if (snap) {
      const j = beats ? Math.round((sec - grid.downbeatSec) / b) : 4 * Math.round((sec - grid.downbeatSec) / (4 * b));
      const bar = Math.floor(j / 4), beat = j - 4 * bar;
      return { bar, ...(beat ? { beat } : {}), sec: grid.downbeatSec + j * b };
    }
    const j = Math.floor((sec - grid.downbeatSec) / b + 1e-9), bar = Math.floor(j / 4), beat = j - 4 * bar;
    const nudgeMs = Math.round((sec - grid.downbeatSec - j * b) * 100) * 10;
    return { bar, ...(beat ? { beat } : {}), ...(nudgeMs ? { nudgeMs } : {}), sec };
  }
  const barNo = (p) => p.bar + 1;   // on screen bars count from 1
  function readout(s, out, inn) {
    // (a position in seconds only, from a mix file, has no bar until it is moved here)
    const bar = (p) => (Number.isInteger(p.bar) ? ` (bar ${barNo(p)})` : '');
    return `A mixes out at ${fmtSec(out.sec)}${bar(out)} · B enters at ${fmtSec(inn.sec)}${bar(inn)}${inn.delaySec ? `, ${inn.delaySec} s into the mix` : ''}`;
  }
  function windowEditable(s) {
    const ov = A().migratePick(s?.pick);
    return !!s && !s.why && s.editable && !!s.toId && s.mix.style !== 'loop' && ov?.preset !== 'loop';
  }
  function dragStart(e) {
    const s = xf()?.overview?.();
    if (drawOn(s)) { if (e.button === 0 && e.detail < 2) pointStart(e, s); return; }
    if (!windowEditable(s) || e.button !== 0) return;
    const r = ui.canvas.getBoundingClientRect();
    const side = e.clientY - r.top < r.height / 2 ? 'out' : 'in';
    const pad = Math.max(4, s.D * 0.24);
    drag = { side, x0: e.clientX, base: side === 'out' ? s.mix.mixOutTrackTime : s.mix.mixInTrackTime, sec: null, s, w: r.width, span: s.D + 2 * pad };
    ui.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  // the limits a drag stops at (the planner's, automix.js windowLimits) and what each one means
  function limitsOf(s, side) {
    const a = A().get(s.fromId);
    const from = a ? { ...a, durationSec: s.fromDur || a.durationSec } : null;
    return A().windowLimits(s.mix, from, A().get(s.toId), s.earliest)[side];
  }
  const LIMIT_WHY = {
    out: ['A has already played up to there', "the window has to end before A does"],
    in: ["that is B's start", "the window has to end before B does"],
  };
  function dragMove(e) {
    if (pdrag) { pointMove(e); return; }
    if (!drag) return;
    if (!(e.buttons & 1)) { drag = null; sig = ''; return; }   // released where we didn't hear it
    const s = drag.s, ov = A().migratePick(s.pick);
    // the song moves with the pointer: what was left of the frame comes under it
    const want = drag.base - ((e.clientX - drag.x0) / drag.w) * drag.span;
    const [lo, hi] = limitsOf(s, drag.side);
    const sec = Math.max(lo, Math.min(want, hi));
    const grid = gridFor(s, drag.side), snap = ov?.beatMatch !== 'off';
    let pos = positionOf(sec, grid, snap, e.shiftKey);
    // a snap past a limit: the nearest step inside it
    if (snap && grid && (pos.sec < lo - 1e-6 || pos.sec > hi + 1e-6)) {
      const step = grid.beatSec * (e.shiftKey ? 1 : 4);
      const inside = positionOf(pos.sec + (pos.sec < lo ? step : -step), grid, snap, e.shiftKey);
      if (inside.sec >= lo - 1e-6 && inside.sec <= hi + 1e-6) pos = inside;
    }
    drag.pos = pos;
    drag.sec = pos.sec;
    drag.limit = want < lo - 0.01 ? LIMIT_WHY[drag.side][0] : want > hi + 0.01 ? LIMIT_WHY[drag.side][1] : null;
    sig = '';
  }
  // A window edit of one side (editor.md §6): the other side is saved too, where the plan has it
  // now, so the planner's own moves of an unsaved side (capIncomingSkip, the vocal re-route) don't
  // move it once the window is the user's.
  function windowWith(s, ov, side, pos) {
    // (a moved mix-in keeps its late entry, unless the move sets one)
    if (side === 'in' && ov?.window?.in?.delaySec && !('delaySec' in pos)) pos = { ...pos, delaySec: ov.window.in.delaySec };
    const w = { ...(ov?.window || {}), [side]: pos }, other = side === 'out' ? 'in' : 'out';
    if (!w[other]) w[other] = positionOf(other === 'out' ? s.mix.mixOutTrackTime : s.mix.mixInTrackTime, gridFor(s, other), false, false);
    return w;
  }
  function dragEnd(e) {
    if (pdrag) { pointEnd(e); return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    try { ui.canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    sig = '';
    if (d.pos == null || Math.abs(d.pos.sec - d.base) < 0.005) return;
    if (xf()?.overview?.()?.pairKey !== d.s.pairKey) return;   // the song changed under the drag
    const ov = A().migratePick(d.s.pick);
    pick({ window: windowWith(d.s, ov, d.side, d.pos) });
  }
  // A 10 ms step of one song's position (from where the plan has it, when nothing is saved yet),
  // held at the drag's limits (automix.js nudgeWindow, editor.md §6)
  function nudge(side, dir) {
    const s = xf()?.overview?.();
    if (!windowEditable(s)) return;
    const ov = A().migratePick(s.pick);
    const grid = gridFor(s, side);
    const now = ov?.window?.[side] || positionOf(side === 'out' ? s.mix.mixOutTrackTime : s.mix.mixInTrackTime, grid, false, false);
    const r = A().nudgeWindow(now, dir, limitsOf(s, side));
    if (r.refused === 'max') { refused = { pair: s.pairKey, text: `Nudges reach ${NUDGE_MAX_MS / 1000} s at most: drag the song instead` }; return; }
    if (r.refused) { refused = { pair: s.pairKey, text: `Held: ${LIMIT_WHY[side][r.refused === 'lo' ? 0 : 1]}` }; return; }
    pick({ window: windowWith(s, ov, side, r.pos) });
  }

  // B's late entry, in seconds (0 clears it): saved on the mix-in, placed where the plan has it if unsaved
  function setLate(v) {
    const s = xf()?.overview?.();
    if (!windowEditable(s) || !Number.isFinite(v)) return;
    const ov = A().migratePick(s.pick);
    const now = ov?.window?.in || positionOf(s.mix.mixInTrackTime, gridFor(s, 'in'), false, false);
    const want = Math.round(Math.min(Math.max(v, 0), 60) * 1000) / 1000;
    if (want === (now.delaySec || 0)) return;
    pick({ window: windowWith(s, ov, 'in', { ...now, delaySec: want }) });
  }

  // ───────── drawn curves (editor.md §10) ─────────
  let drawKey = null;            // the curve being drawn (a CURVES key), null: none chosen
  let pdrag = null;              // a point being dragged: { s, key, side, i, d, moved }
  let pendingDraw = null;        // { pair, lane }: Draw picked on a loop mix, started once the blend is planned
  const undo = [];               // { pair, lanes } before each edit, newest last
  // the beat a drawing's x counts in, as the planner reads it (automix.js plan, §10 rule 4)
  function drawCtx(s) {
    const m = s.mix;
    const beat = m.style !== 'crossfade' && m.barSec > 0;
    return {
      beatSec: beat ? m.barSec / 4 : A().editorGrid(A().get(s.fromId), 'out')?.beatSec || 0.5,
      glide: beat ? m.glide || null : null,
      unit: m.style === 'crossfade' ? 'sec' : 'beat',
    };
  }
  const drawingOf = (s, lane) => { const l = A().migratePick(s?.pick)?.lanes?.[lane]; return l && typeof l === 'object' ? l : null; };
  const pointsOf = (d, key, side) => { const n = CURVES[key].name; return (n ? d?.[side]?.[n] : d?.[side]) || []; };
  function withPoints(d, key, side, pts) {
    const n = CURVES[key].name, c = JSON.parse(JSON.stringify(d));
    if (n) { c[side] = { ...(c[side] || {}) }; if (pts.length) c[side][n] = pts; else delete c[side][n]; } else c[side] = pts;
    return c;
  }
  function drawOn(s) {
    return !!(drawKey && s && !s.why && s.toId && s.mix && s.mix.style !== 'loop' && drawingOf(s, CURVES[drawKey].lane));
  }
  // Draw in a lane's dropdown: the lane's shape as points, saved (rule 6)
  function startDraw(lane) {
    const s = xf()?.overview?.();
    if (!s?.mix || s.why || !s.toId) { sig = ''; return; }
    // on a loop mix (Auto chose one): Custom first, and the drawing once the blend is planned
    if (s.mix.style === 'loop') { pendingDraw = { pair: s.pairKey, lane }; pick({ preset: 'custom', lanes: lanesNow() }); return; }
    const cur = lanesNow()[lane];
    const c = drawCtx(s);
    let d = typeof cur === 'object' ? cur : A().shapeDrawing(lane, cur, s.D, c.beatSec, c.glide, c.unit);
    if (!d || d === 'none') d = { unit: c.unit, out: {}, in: {} };
    // the lane's curves the shape didn't have start flat and open, so each can be drawn
    for (const key of Object.keys(CURVES).filter((k) => CURVES[k].lane === lane)) {
      for (const side of ['out', 'in']) if (!pointsOf(d, key, side).length && key !== 'gain') d = withPoints(d, key, side, [[0, OPEN[key]]]);
    }
    saveDrawing(s, lane, d);
    drawKey = Object.keys(CURVES).find((k) => CURVES[k].lane === lane);
  }
  function saveDrawing(s, lane, d) {
    const ov = A().migratePick(s.pick) || {};
    // the length it was drawn for stays (rule 6): Auto would move it under the drawing
    const bars = ov.bars || ([2, 4, 8, 16, 32].includes(s.mix.bars) && s.mix.style !== 'crossfade' ? s.mix.bars : null);
    undo.push({ pair: s.pairKey, lanes: ov.lanes ? JSON.parse(JSON.stringify(ov.lanes)) : null, preset: ov.preset || null, bars: ov.bars || null, barsAfter: bars });
    if (undo.length > UNDO_MAX) undo.shift();
    pick({ preset: 'custom', lanes: { ...lanesNow(), [lane]: d }, ...(bars ? { bars } : {}) });
  }
  // A shape (lane: its name) or a preset (lane: null) over a drawing: "Replace the drawing?" first;
  // on yes the whole override goes on the undo list. false: declined, nothing changes.
  function replaceDrawing(lane) {
    const s = xf()?.overview?.();
    const ov = A().migratePick(s?.pick);
    if (!s?.pairKey || ov?.preset !== 'custom' || !ov.lanes) return true;
    const drawn = Object.keys(ov.lanes).filter((k) => typeof ov.lanes[k] === 'object' && (lane == null || k === lane));
    if (!drawn.length) return true;
    if (!window.confirm(drawn.length > 1 ? 'Replace the drawings?' : 'Replace the drawing?')) return false;
    undo.push({ pair: s.pairKey, whole: JSON.parse(JSON.stringify(ov)) });
    if (undo.length > UNDO_MAX) undo.shift();
    return true;
  }
  function undoDraw() {
    const s = xf()?.overview?.();
    while (undo.length && undo[undo.length - 1].pair !== s?.pairKey) undo.pop();   // another pair's edits are gone with it
    const u = undo.pop();
    if (!u) return;
    if (u.whole) { const r = xf().setPairPick(u.pair, u.whole); refused = r?.refused ? { pair: u.pair, text: r.refused } : null; sig = ''; return; }
    // the length goes back only if this edit set it (one picked by hand since stays)
    const now = A().migratePick(s.pick)?.bars || null;
    pick({ ...(u.lanes && u.preset === 'custom' ? { preset: 'custom', lanes: u.lanes } : { preset: u.preset || 'auto' }), bars: now === u.barsAfter ? u.bars : now });
  }
  // the point of the chosen curve under the pointer: { side, k, i } (i: null when none is near)
  function hitOf(e, s) {
    const r = ui.canvas.getBoundingClientRect(), L = layout(s.D, r.width, r.height);
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k = py < r.height / 2 ? 0 : 1, side = k ? 'in' : 'out';
    const c = drawCtx(s), d = drawingOf(s, CURVES[drawKey].lane), C = CURVES[drawKey];
    const pts = pointsOf(d, drawKey, side);
    let best = null, bd = HIT_PX;
    pts.forEach(([x, v], i) => {
      const dist = Math.hypot(L.X(A().drawSec(x, d.unit, c.beatSec, c.glide)) - px, L.Y(drawKey, k, C.norm(v)) - py);
      if (dist <= bd) { bd = dist; best = i; }
    });
    return { side, k, i: best, px, py, L, c, d, pts };
  }
  // a pointer position as a point [x, v]: x snapped (a quarter beat, or 10 ms; Shift: free)
  function pointAt(h, e) {
    const t = Math.max(0, Math.min(h.L.T(h.px), pdrag?.s?.D ?? Infinity));
    let x = Math.max(0, A().drawX(t, h.d.unit, h.c.beatSec, h.c.glide));
    x = e.shiftKey ? Math.round(x * 1000) / 1000 : h.d.unit === 'sec' ? Math.round(x * 100) / 100 : Math.round(x * 4) / 4;
    const v = CURVES[drawKey].value(h.L.N(drawKey, h.k, h.py));
    return [x, drawKey.endsWith('Hz') ? Math.round(v) : Math.round(v * 1000) / 1000];
  }
  function pointStart(e, s) {
    const h = hitOf(e, s);
    let pts = h.pts.map((p) => [...p]), i = h.i;
    if (i == null) {
      const t = h.L.T(h.px);
      if (t < 0 || t > s.D) return;   // points go inside the frame
      if (pts.length >= MAX_POINTS) { refused = { pair: s.pairKey, text: `${MAX_POINTS} points is the most for one line` }; return; }
      pdrag = { s };
      const p = pointAt(h, e);
      if (pts.filter((q) => q[0] === p[0]).length >= 2) return void (pdrag = null);   // never a third at one x
      i = pts.findIndex((q) => q[0] > p[0]);
      if (i < 0) i = pts.length;
      pts.splice(i, 0, p);
    }
    pdrag = { s, key: drawKey, side: h.side, k: h.k, i, d: withPoints(h.d, drawKey, h.side, pts), added: h.i == null, moved: h.i == null };
    ui.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    sig = '';
  }
  function pointMove(e) {
    if (!(e.buttons & 1)) { pdrag = null; sig = ''; return; }
    const r = ui.canvas.getBoundingClientRect(), s = pdrag.s;
    const h = { px: e.clientX - r.left, py: e.clientY - r.top, k: pdrag.k, L: layout(s.D, r.width, r.height), c: drawCtx(s), d: pdrag.d };
    const pts = pointsOf(pdrag.d, pdrag.key, pdrag.side).map((p) => [...p]), i = pdrag.i;
    const p = pointAt(h, e);
    // held between its neighbours: onto one makes a step, but never a third point at one x
    const prev = pts[i - 1], next = pts[i + 1];
    let lo = prev ? prev[0] : 0, hi = next ? next[0] : Infinity;
    if (prev && pts[i - 2] && pts[i - 2][0] === prev[0]) lo += 0.001;
    if (next && pts[i + 2] && pts[i + 2][0] === next[0]) hi -= 0.001;
    p[0] = Math.max(lo, Math.min(hi, p[0]));
    pts[i] = p;
    pdrag.d = withPoints(pdrag.d, pdrag.key, pdrag.side, pts);
    pdrag.moved = true;
    sig = '';
  }
  function pointEnd(e) {
    const d = pdrag;
    pdrag = null;
    try { ui.canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    sig = '';
    if (!d.moved || xf()?.overview?.()?.pairKey !== d.s.pairKey) return;
    saveDrawing(d.s, CURVES[d.key].lane, d.d);
  }
  // a double-click or right-click on a point deletes it; a volume deck keeps its last point
  function pointDelete(e) {
    const s = xf()?.overview?.();
    if (!drawOn(s)) return;
    e.preventDefault();
    pdrag = null;
    const h = hitOf(e, s);
    if (h.i == null) return;
    if (drawKey === 'gain' && h.pts.length <= 1) { refused = { pair: s.pairKey, text: 'A volume line keeps at least one point' }; return; }
    saveDrawing(s, CURVES[drawKey].lane, withPoints(h.d, drawKey, h.side, h.pts.filter((_, j) => j !== h.i)));
  }
  // Repeat (rule 6): the chosen curve's points in [from, from + len), both decks, copied every len
  // along the window; each copy replaces the points in its span
  function repeat(from, len) {
    const s = xf()?.overview?.();
    if (!drawOn(s) || !(len > 0) || !(from >= 0)) return;
    const lane = CURVES[drawKey].lane, c = drawCtx(s);
    let d = drawingOf(s, lane);
    const end = A().drawX(s.D, d.unit, c.beatSec, c.glide);
    for (const side of ['out', 'in']) {
      const pts = pointsOf(d, drawKey, side);
      const part = pts.filter(([x]) => x >= from && x < from + len);
      if (!part.length) continue;
      let out = pts.filter(([x]) => x < from + len);
      for (let a = from + len; a < end - 1e-9; a += len) {
        out = out.filter(([x]) => x < a);
        out.push(...part.map(([x, v]) => [Math.round((x - from + a) * 1000) / 1000, v]));
        // (a tiny interval would copy without end: refused as soon as it is over)
        if (out.length > MAX_POINTS) { refused = { pair: s.pairKey, text: `${MAX_POINTS} points is the most for one line` }; return; }
      }
      out.push(...pts.filter(([x]) => x >= end - 1e-9 && x > out[out.length - 1][0]));
      if (out.length > MAX_POINTS) { refused = { pair: s.pairKey, text: `${MAX_POINTS} points is the most for one line` }; return; }
      d = withPoints(d, drawKey, side, out);
    }
    saveDrawing(s, lane, d);
  }
  // the chosen curve on top of the canvas: bold, with its points (the one being dragged as it moves)
  function drawPoints(g, s, w, h) {
    if (!drawOn(s)) return;
    const lane = CURVES[drawKey].lane, d = pdrag?.d || drawingOf(s, lane), C = CURVES[drawKey];
    const L = layout(s.D, w, h), c = drawCtx(s);
    const x0 = L.X(0), x1 = L.X(s.D);
    g.save();
    g.beginPath(); g.rect(x0, 0, x1 - x0, h); g.clip();
    for (const [k, side] of [[0, 'out'], [1, 'in']]) {
      const pts = pointsOf(d, drawKey, side);
      if (!pts.length) continue;
      const xy = pts.map(([x, v]) => [L.X(A().drawSec(x, d.unit, c.beatSec, c.glide)), L.Y(drawKey, k, C.norm(v))]);
      g.strokeStyle = LANE_COLORS[lane];
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(x0, xy[0][1]);
      for (const [x, y] of xy) g.lineTo(x, y);
      g.lineTo(x1, xy[xy.length - 1][1]);
      g.stroke();
      xy.forEach(([x, y], i) => {
        g.fillStyle = pdrag && pdrag.side === side && pdrag.i === i ? '#fff' : LANE_COLORS[lane];
        g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#15141c'; g.lineWidth = 1; g.stroke();
      });
    }
    g.restore();
  }

  function loop() {
    frame = 0;
    if (!ui) return;
    try { clearPlayerBar(ui.root); render(); } catch (e) { console.warn('[ViVi automix overview]', e); }
    frame = requestAnimationFrame(loop);
  }
  // The card ends above YouTube's player bar (it is drawn over the overlay), and scrolls inside
  // what's left, so its last rows are never hidden under the bar.
  function clearPlayerBar(root) {
    const r = document.querySelector('ytmusic-player-bar')?.getBoundingClientRect();
    const under = r && r.height > 0 && r.top < innerHeight ? Math.round(innerHeight - r.top) : 0;
    const pad = `${16 + under}px`;
    if (root.style.paddingBottom !== pad) root.style.paddingBottom = pad;
  }

  function describe(m, s) {
    if (m.style === 'loop') {
      const l = m.loop;
      return `Loop mix · ${l.totalBars} bars · ${Math.round(l.out.bpm)}→${Math.round(l.in.bpm)} BPM · ${s.D.toFixed(1)} s`;
    }
    // (Automix v2 names its ways: the hand-over and bridge of a pair it can't beatmatch, the drop-in, muffle and glide)
    if (m.style === 'crossfade') return `${m.bridge ? 'Beatless bridge' : m.handoff ? 'Hand-over' : 'Fade'} · ${s.D.toFixed(1)} s${m.reason ? ' · ' + m.reason : ''}`;
    const bpm = m.inBpm && Math.round(m.inBpm) !== Math.round(m.bpm) ? `${Math.round(m.outBpm || m.bpm)}→${Math.round(m.inBpm)} BPM` : `${Math.round(m.bpm)} BPM`;
    const kind = m.style === 'filter' ? 'Filter mix' : m.shape === 'dropin' ? 'Drop-in' : m.shape === 'muffle' ? 'Muffle' : m.shape === 'echo' ? 'Echo out' : m.glide ? 'Glide blend' : 'Blend';
    return `${kind} · ${m.bars} bars · ${bpm} · ${s.D.toFixed(1)} s`;
  }

  // editor.md §11: one row, this song's analysis before the next one's; "Looking for a loop mix…" while the
  // loop search runs; a failure's reason in its place; hidden during a live mix. Shown once, it keeps its room.
  // rule 6: this song's addon copy, after its analysis: fetched, lined up with YouTube's, then the take-over
  function addonStage(id, paused = false) {
    const AP = window.__viviAddonsPage;
    if (!id || !AP?.isOn?.()) return '';
    const a = AP.statusOf(id), play = a?.play?.state;
    const st = a?.stream || {};
    const copy = /^(flac|alac|wav|aiff|pcm)/i.test(st.codec || '') || st.bitDepth > 0 ? 'the lossless copy' : "the addon's copy";
    if (a?.state === 'opening' || play === 'starting' || play === 'fetching') return a?.state === 'ready' || play === 'fetching' ? `Getting ${copy}…` : 'Asking your addons…';
    if (play === 'fitting') return `Lining up ${copy} with YouTube's…`;
    // (paused, the deck can't line up with YouTube's sound, which stands still: it takes over once the song plays)
    if (play === 'playing' && xf()?.addonTakeover?.(id) === 'switching') return paused ? `${copy[0].toUpperCase() + copy.slice(1)} is ready: it takes over when the song plays` : `Switching to ${copy}…`;
    return '';
  }
  function progressRow(s) {
    const P = A()?.progressOf;
    const live = !!s?.live;
    let text = '', pct = null, kind = '';
    if (P && s && !live) {
      const cur = s.curId ?? s.fromId, nxt = s.nextId ?? s.toId;
      for (const [id, who] of [[cur, 'this song'], [nxt, 'the next song']]) {
        if (!id) continue;
        const p = P(id);
        if (p.status === 'pending' || p.status === 'analyzing') { text = `Analysing ${who}: ${p.stage} · ${p.pct}%`; pct = p.pct; break; }
        if (p.status === 'error') { text = `Analysis of ${who} failed: ${p.why}`; kind = 'failed'; break; }
        if (p.status === 'tooLong') { text = `${who === 'this song' ? 'This song' : 'The next song'} is over 8 minutes: not analysed, a plain crossfade`; kind = 'note'; break; }
      }
      if (!text) { const a = addonStage(cur, !!s.paused); if (a) { text = a; kind = a.endsWith('…') ? 'busy' : 'note'; } }
      if (!text && s.loop?.state === 'loading') { text = 'Looking for a loop mix…'; kind = 'busy'; }
    }
    const { prog, progText, progFill } = ui;
    if (text) prog.hidden = false;
    setIf(prog.style, 'visibility', text ? 'visible' : 'hidden');
    setIf(progText, 'textContent', text);
    prog.dataset.kind = kind;
    setIf(progFill.style, 'width', pct == null ? '' : pct + '%');
  }

  // ───────── mix files (spec/automix/mix-file.md) ─────────
  function fileSay(text) { if (ui) ui.fileNote.textContent = text; }
  // the last imported file's songs (rule 7: "Play these mixes"), kept while the page is open
  let lastImport = null;   // { ids, n }
  let queuing = false;     // a queue request on its way (Play these mixes)
  async function playImported() {
    if (!lastImport?.ids.length || queuing) return;
    queuing = true;
    fileSay('Queuing…');
    const r = await xf().queueSongs(lastImport.ids);
    queuing = false;
    fileSay(r.ok ? `Playing ${lastImport.n === 1 ? 'the mix' : 'the ' + lastImport.n + ' mixes'}: ${lastImport.ids.length} songs in the queue, in the ${lastImport.playlist ? 'playlist' : "file"}'s order.` : 'Not queued: ' + r.why + '.');
    sig = '';
  }
  async function importFile(f) {
    if (f.size > 2 * 1024 * 1024) { fileSay('Not imported: the file is over 2 MB, not a mix file.'); return; }
    let text;
    try { text = await f.text(); } catch { fileSay('Not imported: the file could not be read.'); return; }
    const r = A().readMixFile(text);
    if (r.refused) { fileSay('Not imported: ' + r.refused + '.'); return; }
    const plan = A().importPlan(r.mixes, xf().pairPicksAll());
    const name = (m) => `${m.from.title || m.from.videoId} → ${m.to.title || m.to.videoId}`;
    // rule 5: a saved edit is replaced only after a confirm that lists what changes
    if (plan.replace.length) {
      const lines = plan.replace.map((m) => `${name(m)}:\n  ${m.changes.join('\n  ')}`);
      const ask = `${plan.replace.length === 1 ? 'One pair already has' : plan.replace.length + ' pairs already have'} an edit. Replace with the file's?\n\n${lines.join('\n\n')}`
        + (plan.add.length ? `\n\n(${plan.add.length} new pair${plan.add.length === 1 ? '' : 's'} are added either way.)` : '');
      if (!window.confirm(ask)) plan.replace.length = 0;
    }
    const r2 = xf().importPairPicks([...plan.add, ...plan.replace]);
    const parts = [];
    parts.push(`Imported ${r2.saved.length} mix${r2.saved.length === 1 ? '' : 'es'}`);
    if (plan.same.length) parts.push(`${plan.same.length} already saved as they are`);
    const kept = r.mixes.length - plan.add.length - plan.replace.length - plan.same.length;
    if (kept > 0) parts.push(`${kept} kept as saved`);
    for (const x of r2.refused) parts.push(`${x.key}: ${x.why}`);
    for (const x of r.skipped) parts.push(`mix ${x.n} skipped: ${x.why}`);
    for (const x of r.notes || []) parts.push(x);   // (a Spotify export: what didn't carry over)
    r.mixes.forEach((m) => {
      const why = A().foldNote(m.override, A().editorGrid?.(A().get(m.from.videoId), 'out')?.bpm);
      if (why && r2.saved.includes(m.key)) parts.push(`${m.from.title || m.from.videoId}: ${why}`);
    });
    // a Spotify export queues its playlist in order, songs in no mix too (spotify-mixes.md rule 8)
    const ids = r.queue || A().mixQueue(r.mixes);
    lastImport = ids.length ? { ids, n: r.mixes.length, playlist: !!r.queue } : lastImport;
    fileSay(parts.join(' · ') + '.' + (ids.length ? ' Play these mixes queues them.' : ''));
    sig = '';
  }
  async function exportMixes(onlyThis) {
    const s = xf()?.overview?.();
    const picks = xf().pairPicksAll();
    const keys = onlyThis ? (s?.pairKey && picks[s.pairKey] ? [s.pairKey] : []) : Object.keys(picks);
    if (!keys.length) { fileSay(onlyThis ? 'These two songs have no edit to export.' : 'No edited pairs to export.'); return; }
    const song = async (id) => {
      let meta = null;
      try { meta = await Promise.race([A().meta?.(id), new Promise((res) => setTimeout(res, 3000))]); } catch { meta = null; }
      return { videoId: id, ...(meta?.song ? { title: meta.song } : {}), ...(meta?.artist ? { artist: meta.artist } : {}) };
    };
    const entries = [];
    for (const k of keys) {
      const [from, to] = k.split('>');
      // the tempo the beats count on (mix-file.md rule 8): as saved, else this app's for A
      const ov = A().migratePick(picks[k]);
      const bpm = ov?.gridBpm || A().editorGrid?.(A().get(from), 'out')?.bpm;
      entries.push({ from: await song(from), to: await song(to), override: bpm ? { ...ov, gridBpm: bpm } : ov });
    }
    const file = A().writeMixFile(entries);
    if (!file.mixes.length) { fileSay('Nothing to export: no valid edit.'); return; }
    const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'song';
    const one = file.mixes.length === 1 ? file.mixes[0] : null;
    const fname = (one ? `${slug(one.from.title || one.from.videoId)}-${slug(one.to.title || one.to.videoId)}` : `mixes-${new Date().toISOString().slice(0, 10)}`) + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = fname;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    fileSay(`Exported ${file.mixes.length} mix${file.mixes.length === 1 ? '' : 'es'} as ${fname}.`);
  }

  function render() {
    let s = xf()?.overview?.();
    progressRow(s);
    ui.playMixes.disabled = !lastImport?.ids.length || queuing;   // (with or without a mix on screen)
    if (!s || s.why) {
      ui.sub.textContent = s?.why || 'Automix is not running';
      ui.msg.textContent = s?.why || '';
      ui.msg.hidden = false;
      ui.canvas.hidden = true;
      ui.songsRow.replaceChildren();
      songsSig = '';
      // (No transition: the presets stay, to pick another)
      setControls(s?.noTransition ? s : null);
      ui.clock.textContent = '';
      // an edit for these two songs, with no mix to show: Reset can still clear it
      if (s?.pick) {
        ui.reset.disabled = false;
        ui.badge.hidden = false;
        ui.note.textContent = 'These two songs have an edit of their own: Reset to Auto clears it.';
      }
      return;
    }
    ui.msg.hidden = true;
    ui.canvas.hidden = false;
    ui.sub.textContent = describe(s.mix, s);
    // while a song is dragged, it is drawn where it would mix
    if (drag?.sec != null) s = { ...s, mix: { ...s.mix, [drag.side === 'out' ? 'mixOutTrackTime' : 'mixInTrackTime']: drag.sec } };
    // the cards again once an analysis lands (their BPM and key)
    const ss = s.pairKey + '|' + [s.fromId, s.toId].map((id) => (id && A()?.get(id)?.bpm ? 1 : 0)).join('');
    if (songsSig !== ss) { songsSig = ss; drawSongs(s); }
    if (pendingDraw && (pendingDraw.pair !== s.pairKey || !s.editable)) pendingDraw = null;
    else if (pendingDraw && s.mix.style !== 'loop' && s.mix.preset === 'custom') { const l = pendingDraw.lane; pendingDraw = null; startDraw(l); return; }   // (the next frame shows the saved drawing)
    setControls(s);
    draw(s);
  }

  const setIf = (node, key, v) => { if (node[key] !== v) node[key] = v; };
  function setControls(s) {
    const { presetRow, custom, laneSel, matchRow, barsRow, nudgeBtns, winReset, lateIn, preview, lock, reset, badge, note } = ui;
    const ov = A()?.migratePick?.(s?.pick) || {};
    const has = !!s?.pick;
    const preset = ov.preset || 'auto', bm = ov.beatMatch || 'auto';
    const loopNone = s?.loop?.state === 'none';
    const mark = (b, on) => { b.classList.toggle('vivi-on', on); b.setAttribute('aria-checked', String(on)); };
    for (const b of presetRow.chips) {
      mark(b, b.dataset.v === preset);
      b.disabled = !s?.toId || (b.dataset.v === 'loop' && loopNone);
      setIf(b, 'title', b.dataset.v === 'loop' && loopNone ? `No loop mix for these two: ${s.loop.why}` : '');
      if (b.dataset.v === 'auto') setIf(b, 'textContent', preset === 'auto' ? autoName(s?.mix) : 'Auto');
    }
    // (Auto: Smooth's, the lanes a first change starts from: lanesNow)
    const lanes = preset === 'loop' ? null : preset === 'custom' && ov.lanes ? ov.lanes : A()?.PRESET_LANES?.[preset] || A()?.PRESET_LANES?.smooth || null;
    for (const [k, sel] of Object.entries(laneSel)) {
      sel.disabled = !s?.toId || preset === 'loop' || preset === 'none';
      // (no Effects or Looping lane: none, editor.md §12 rule 1, §13)
      const v = lanes?.[k] ? (typeof lanes[k] === 'object' ? 'draw' : lanes[k]) : lanes && (k === 'fx' || k === 'looping') ? 'none' : '';
      if (v && sel.value !== v) sel.value = v;
    }
    // the drawing's tools: shown while a lane is drawn; the chips of the drawn lanes' curves
    const drawnLanes = preset === 'custom' && ov.lanes ? Object.keys(ov.lanes).filter((k) => typeof ov.lanes[k] === 'object') : [];
    const canDraw = !!s?.toId && !!s.mix && s.mix.style !== 'loop' && drawnLanes.length > 0;
    if (drawKey && !(canDraw && drawnLanes.includes(CURVES[drawKey].lane))) { drawKey = null; pdrag = null; }
    ui.drawRow.hidden = !canDraw;
    ui.undoReplace.hidden = canDraw || !undo.some((u) => u.pair === s?.pairKey);
    for (const b of ui.curveChips.chips) {
      const key = b.dataset.v;
      b.hidden = !!key && !drawnLanes.includes(CURVES[key].lane);
      mark(b, key === (drawKey || ''));
    }
    if (canDraw) {
      setIf(ui.repUnit, 'textContent', drawCtx(s).unit === 'sec' ? 's' : 'beats');
      ui.repBtn.disabled = !drawKey;
      ui.undoBtn.disabled = !undo.some((u) => u.pair === s.pairKey);
      setIf(ui.drawHint, 'textContent', drawKey
        ? `Click in the frame to add a point to ${CURVES[drawKey].chip.toLowerCase()}, drag to move it, double-click or right-click to delete (Shift: free). Done moves the window again.`
        : 'Pick a line to draw on.');
    }
    custom.classList.toggle('vivi-off', preset === 'loop');
    for (const b of matchRow.chips) { mark(b, b.dataset.v === bm); b.disabled = !s?.toId || preset === 'loop' || preset === 'none'; }
    const isLoop = preset === 'loop' || (preset === 'auto' && s?.mix?.style === 'loop');
    for (const b of barsRow.chips) {
      const v = Number(b.dataset.v);
      mark(b, v === (ov.bars || 0));
      b.disabled = !s?.toId || preset === 'none' || (isLoop && v !== 0);
      setIf(b, 'title', b.disabled && v !== 0 && s?.toId && preset !== 'none' ? 'A loop mix sets its own length' : '');
    }
    const winOn = windowEditable(s);
    for (const b of nudgeBtns) b.disabled = !winOn;
    winReset.disabled = !winOn || !ov.window;
    lateIn.disabled = !winOn;
    if (document.activeElement !== lateIn) setIf(lateIn, 'value', String(ov.window?.in?.delaySec || 0));
    mark(winReset, !ov.window);
    lock.disabled = !has;
    lock.setAttribute('aria-pressed', String(!!ov.lock));
    lock.classList.toggle('vivi-on', !!ov.lock);
    setIf(lock, 'textContent', ov.lock ? 'Locked' : 'Lock');
    reset.disabled = !has;
    ui.exportPair.disabled = !has;
    badge.hidden = !has;   // any saved override is an edit (a lone lock is never saved: editor.md §1, §2)
    const left = s && s.editable && s.at != null ? -s.at : null;
    preview.disabled = !s?.editable || !(s.previewAt > 0) || left == null || left < 25;
    setIf(preview, 'title', preview.disabled ? '' : 'Jump to just before the mix');
    const m = s?.mix;
    let n = '';
    if (!s) n = '';
    else if (drag?.pos) {
      const other = drag.side === 'out' ? positionOf(m.mixInTrackTime, gridFor(s, 'in'), false, false) : positionOf(m.mixOutTrackTime, gridFor(s, 'out'), false, false);
      n = (drag.side === 'out' ? readout(s, drag.pos, other) : readout(s, other, drag.pos)) + (drag.limit ? ` · held: ${drag.limit}` : '');
    } else if (refused?.pair === s.pairKey) n = refused.text;
    else if (!s.editable) n = 'Mixing now: an edit is for the next time these two play.';
    else if (preset === 'loop' && m.style !== 'loop') n = loopNone ? `No loop mix for these two: ${s.loop.why}` : 'Preparing the loop mix…';
    else if (m.warnings?.length) n = '⚠ ' + m.warnings.join('; ');
    else if (ov.bars && m.bars && ov.bars !== m.bars && m.style !== 'loop' && m.style !== 'crossfade') n = `${ov.bars} bars asked; ${m.bars} fit here.`;
    else if (ov.window && m.style !== 'loop') n = readout(s, ov.window.out || positionOf(m.mixOutTrackTime, gridFor(s, 'out'), false, false), ov.window.in || positionOf(m.mixInTrackTime, gridFor(s, 'in'), false, false));
    else if (has) n = ov.lock ? 'Locked for these two songs.' : 'Kept for these two songs.';
    else if (m.reason) n = m.reason;
    else if (windowEditable(s)) n = 'Drag a song under the mix to move the window (Shift: beats).';
    if (note.textContent !== n) note.textContent = n;
  }

  async function drawSongs(s) {
    const key = songsSig;
    const row = ui.songsRow;
    row.replaceChildren();
    const card = (id, side) => {
      const c = el('div', 'vivi-amx-ov-song vivi-' + side);
      const img = el('img', 'vivi-amx-ov-cover');
      img.alt = '';
      img.decoding = 'async';
      if (id) img.src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
      const text = el('div', 'vivi-amx-ov-text');
      const t = el('div', 'vivi-amx-ov-name', id ? '…' : 'Nothing queued');
      const ar = el('div', 'vivi-amx-ov-artist', '');
      const tags = el('div', 'vivi-amx-ov-tags');
      text.append(t, ar, tags);
      c.append(img, text);
      return { c, t, ar, tags };
    };
    const a = card(s.fromId, 'out'), b = card(s.toId, 'in');
    row.append(a.c, el('div', 'vivi-amx-ov-arrow', '→'), b.c);
    for (const [id, c] of [[s.fromId, a], [s.toId, b]]) {
      if (!id) continue;
      const an = A()?.get(id);
      const tags = [];
      if (an?.bpm) tags.push(`${Math.round(an.bpm)} BPM`);
      if (an?.camelot) tags.push(`${an.camelot.num}${an.camelot.letter}${an.keyName ? ' · ' + an.keyName : ''}`);
      if (an?.durationSec) tags.push(fmt(an.durationSec));
      for (const t of tags) c.tags.append(el('span', 'vivi-amx-ov-tag', t));
      A()?.meta?.(id).then((meta) => {
        if (!ui || songsSig !== key) return;
        c.t.textContent = meta?.song || id;
        c.ar.textContent = meta?.artist || '';
      });
      waveOf(id).then(() => { if (ui && songsSig === key) sig = ''; });
    }
  }

  // The static picture (waveforms, grid, frame, faders) is drawn once per
  // plan; each frame only adds the playhead.
  function draw(s) {
    const cv = ui.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, cv.clientWidth), h = Math.max(120, cv.clientHeight);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); sig = ''; }
    const pad = Math.max(4, s.D * 0.24);
    const t0 = -pad, t1 = s.D + pad;
    const m = s.mix;
    const want = [s.pairKey, m.style, m.mixOutTrackTime.toFixed(2), m.mixInTrackTime.toFixed(2), s.D.toFixed(2), m.bars, cv.width, cv.height].join('|');
    // (s.gOut / s.x: the engine's shape of this plan, made once per plan: a replan is a new one)
    const shape = s.x || s.gOut || s.mix;
    if (want !== sig || !staticLayer || shape !== drawnShape) {
      sig = want;
      drawnShape = shape;
      staticLayer = drawStatic(s, w, h, dpr, t0, t1);
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(staticLayer, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // playhead, on the mix's clock
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    let clock = '';
    if (s.at != null) {
      if (s.at < t0) clock = `Mix in ${fmt(-s.at)}`;
      else if (s.at > t1) clock = '';
      else {
        const x = X(s.at);
        g.fillStyle = '#fff';
        g.fillRect(Math.round(x) - 1, 4, 2, h - 8);
        clock = s.at < 0 ? `Mix in ${fmt(-s.at)}` : s.at <= s.D ? `Mixing · ${fmt(s.at)} / ${fmt(s.D)}` : '';
      }
    }
    ui.clock.textContent = s.paused && clock ? clock + ' (paused)' : clock;
    drawPoints(g, s, w, h);
  }

  function drawStatic(s, w, h, dpr, t0, t1) {
    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr); layer.height = Math.round(h * dpr);
    const g = layer.getContext('2d');
    g.scale(dpr, dpr);
    const { X, T, top, laneH } = layout(s.D, w, h);
    const L = lanes(s);
    // grey well, the mix's frame
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(0, 0, w, h);
    const fx0 = X(0), fx1 = X(s.D);
    g.fillStyle = 'rgba(58,155,220,0.08)';
    g.fillRect(fx0, 2, fx1 - fx0, h - 4);
    // beat grid
    for (const b of beatsOf(s, t0, t1)) {
      const x = Math.round(X(b.t)) + 0.5;
      g.strokeStyle = `rgba(255,255,255,${b.bar ? 0.14 : 0.06})`;
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x, h - 2); g.stroke();
    }
    // waveforms
    const ids = [s.fromId, s.toId], maps = [L.out, L.in];
    for (let lane = 0; lane < 2; lane++) {
      const id = ids[lane];
      const yMid = top[lane] + laneH / 2, half = laneH / 2 - 2;
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath(); g.moveTo(0, yMid + 0.5); g.lineTo(w, yMid + 0.5); g.stroke();
      if (!id) continue;
      const wv = waveCache.get(id);
      if (!wv) continue;
      const step = 2;
      for (let x = 0; x < w; x += step) {
        const t = T(x + step / 2);
        const tt = maps[lane](t);
        if (tt == null || tt < 0) continue;
        const i = Math.floor(tt * wv.fr);
        if (i < 0 || i >= wv.mid.length) continue;
        g.globalAlpha = t < 0 || t > s.D ? OUTSIDE_ALPHA : 1;
        // loudest band first, so the quieter ones show in front of it
        const bands = BANDS.map((b) => [b, wv[b][i] * half]).sort((p, q) => q[1] - p[1]);
        for (const [band, a] of bands) {
          if (a < 0.5) continue;
          g.fillStyle = COLORS[band];
          g.fillRect(x, yMid - a, step - 0.5, a * 2);
        }
      }
      g.globalAlpha = 1;
    }
    // faders
    const faders = [L.gOut, L.gIn];
    g.strokeStyle = LANE_COLORS.volume;
    g.lineWidth = 1.5;
    for (let lane = 0; lane < 2; lane++) {
      const y0 = top[lane] + laneH - 1, span = laneH - 4;
      g.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = y0 - faders[lane](T(x)) * span;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.lineWidth = 1;
    // the plan's EQ (bass, then highs; 0 dB at the top of the lane, BASS_CUT_DB at its bottom) and its
    // filters (log Hz: 20 Hz at the bottom, 20 kHz at the top, as the opening of each song's filter)
    const c = s.mix.curves;
    if (c && s.mix.style !== 'loop') {
      const at = xf().curveAt;
      const lane = (pts, k, color, geo, toY) => {
        if (!pts?.length) return;
        const y0 = top[k] + 2, span = laneH - 6;
        g.strokeStyle = color;
        g.setLineDash(geo ? [4, 3] : []);
        g.beginPath();
        for (let x = Math.max(0, Math.floor(fx0)); x <= Math.min(w, Math.ceil(fx1)); x += 2) {
          const y = y0 + (1 - toY(at(pts, T(x), geo))) * span;
          if (x <= fx0 + 1) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      };
      const db = (v) => 1 - Math.min(1, Math.max(0, v / -18));
      const hzLp = (v) => Math.log(Math.max(20, v) / 20) / Math.log(1000);
      const hzHp = (v) => 1 - Math.log(Math.max(20, v) / 20) / Math.log(1000);
      for (const [k, side] of [[0, c.out], [1, c.in]]) {
        lane(side.bassDb, k, LANE_COLORS.eq, false, db);
        lane(side.highDb, k, LANE_COLORS.eq + 'aa', false, db);
        lane(side.lowpassHz, k, LANE_COLORS.effect, true, hzLp);
        lane(side.highpassHz, k, LANE_COLORS.effect, true, hzHp);
        // editor.md §12: the mid band as the other EQ curves; noise and the sends 0 at the bottom, 1 at the top
        lane(side.midDb, k, LANE_COLORS.eq + '77', false, db);
        lane(side.noise, k, LANE_COLORS.effect + 'aa', false, (v) => v);
        lane(side.echoSend, k, LANE_COLORS.fx, false, (v) => v);
        lane(side.reverbSend, k, LANE_COLORS.fx + 'bb', false, (v) => v);
        lane(side.delaySend, k, LANE_COLORS.fx + '88', false, (v) => v);
      }
      g.setLineDash([]);
    }
    // frame
    g.strokeStyle = COLORS.frame;
    g.lineWidth = 2;
    roundRect(g, fx0, 2, fx1 - fx0, h - 4, 6);
    g.stroke();
    // the bars chip
    const bars = s.mix.style === 'loop' ? s.mix.loop.totalBars : s.mix.bars;
    if (bars) {
      const text = `${bars} bars`;
      g.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
      const tw = g.measureText(text).width + 14;
      const cx = Math.min(Math.max(fx0 + (fx1 - fx0) / 2 - tw / 2, 2), w - tw - 2);
      g.fillStyle = COLORS.frame;
      roundRect(g, cx, h / 2 - 10, tw, 20, 10);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(text, cx + 7, h / 2 + 4);
    }
    return layer;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  // ───────── ways in ─────────
  // A button in the player bar (while Automix is on), and the Automix toast.
  const toggle = () => { try { if (ui) hide(); else open(); } catch (err) { console.warn('[ViVi automix overview] could not open:', err?.stack || err); } };
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !e.target.closest?.('#vivi-automix-toast')) return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);

  const BTN_ID = 'vivi-amx-ov-open';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function makeButton() {
    const b = el('button', 'vivi-amx-ov-open');
    b.id = BTN_ID;
    b.type = 'button';
    b.setAttribute('aria-label', 'Automix overview');
    b.setAttribute('aria-haspopup', 'dialog');
    // two lines crossing: one song out, the next in
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M3 7h3.5c4 0 7 10 11 10H21', 'M3 17h3.5c4 0 7-10 11-10H21']) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    b.append(svg);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    return b;
  }
  // YT Music redraws the player bar now and then: the button is put back each check.
  let warned = '';
  function syncButton() {
    const host = document.querySelector('ytmusic-player-bar .right-controls-buttons');
    if (!host) return;
    let s = null;
    try { s = xf()?.overview?.() || null; } catch (err) {
      if (warned !== String(err)) { warned = String(err); console.warn('[ViVi automix overview] no view of the mix:', err?.stack || err); }
    }
    const on = !!window.__viviAutomix?.isEnabled?.();
    let b = document.getElementById(BTN_ID);
    if (!on) { if (b) b.hidden = true; return; }
    if (!b) b = makeButton();
    // between the volume control (left) and Repeat (right)
    const kids = [...host.children];
    const at = kids.find((c) => c.matches('.repeat')) || kids.find((c) => c.matches('.volume'))?.nextElementSibling;
    if (b.parentElement !== host || (at ? b.nextElementSibling !== at : b !== host.firstElementChild)) {
      if (at) host.insertBefore(b, at); else host.prepend(b);
    }
    b.hidden = false;
    const state = !s || s.why ? 'idle' : s.editable ? 'planned' : 'mixing';
    if (b.dataset.state !== state) b.dataset.state = state;
    const title = s?.why ? `Automix: ${s.why}` : state === 'mixing' ? 'Automix: mixing now' : 'Automix: see the next mix';
    if (b.title !== title) b.title = title;
  }
  setInterval(syncButton, 1000);

  window.__viviAutomixOverview = { open, hide };
})();

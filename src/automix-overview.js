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
 * plays, and Preview jumps to just before the mix.
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
  const PRESETS = [['auto', 'Auto'], ['smooth', 'Smooth'], ['rise', 'Rise'], ['blend', 'Blend'], ['wave', 'Wave'], ['melt', 'Melt'], ['slam', 'Slam'], ['loop', 'Loop'], ['custom', 'Custom']];
  const BEAT_MATCH = [['auto', 'Auto'], ['sync', 'Sync'], ['glide', 'Glide'], ['off', 'Off']];
  const BARS = [[0, 'Auto'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [32, '32']];
  const LANE_OPTIONS = {
    volume: [['smooth', 'Smooth'], ['crossfade', 'Crossfade'], ['overlap', 'Overlap'], ['cutInFadeOut', 'Cut in, fade out'], ['fadeInCutOut', 'Fade in, cut out'], ['centerCut', 'Cut at the centre']],
    eq: [['centerBassSwap', 'Bass swap at the centre'], ['endBassSwap', 'Bass swap at the end'], ['threeBandFade', 'Three-band fade'], ['quickBassCut', 'Quick bass cut'], ['none', 'None']],
    effect: [['none', 'None'], ['lpOut', 'Low-pass out'], ['hpIn', 'High-pass in'], ['lpBoth', 'Low-pass both'], ['hpBoth', 'High-pass both'], ['lpInHpOut', 'Low-pass in, high-pass out']],
  };
  const LANE_COLORS = { volume: '#4C8DFF', eq: '#F5C542', effect: '#A779FF' };
  const NUDGE_MS = 10, NUDGE_MAX_MS = 2000;

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
    return {
      out: (t) => (t < 0 ? m.mixOutTrackTime + t : t <= D ? m.mixOutTrackTime + t * outRate : null),
      in: (t) => (t < 0 ? null : t <= D ? m.mixInTrackTime + t * rate : m.mixInTrackTime + D * rate + (t - D)),
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
    const legend = el('div', 'vivi-amx-ov-legend');
    for (const [k, t] of [['low', 'Low'], ['mid', 'Mid'], ['high', 'High'], ['volume', 'Volume'], ['eq', 'EQ'], ['effect', 'Effect']]) {
      const i = el('span', 'vivi-amx-ov-key');
      const sw = el('i');
      sw.style.background = COLORS[k] || LANE_COLORS[k];
      i.append(sw, document.createTextNode(t));
      legend.append(i);
    }
    const clock = el('span', 'vivi-amx-ov-clock', '');
    legend.append(clock);
    const controls = el('div', 'vivi-amx-ov-controls');
    const presetRow = chipRow('Preset', PRESETS, (v) => pick(v === 'custom' ? { preset: 'custom', lanes: lanesNow() } : { preset: v }));
    const custom = el('details', 'vivi-amx-ov-custom');
    custom.append(el('summary', '', 'Customize'));
    const laneSel = {};
    for (const [k, label] of [['volume', 'Volume'], ['eq', 'EQ'], ['effect', 'Effect']]) {
      const lab = el('label', 'vivi-amx-ov-lane');
      const sw = el('i');
      sw.style.background = LANE_COLORS[k];
      const sel = el('select');
      for (const [v, t] of LANE_OPTIONS[k]) { const o = el('option', '', t); o.value = v; sel.append(o); }
      sel.addEventListener('change', () => pick({ preset: 'custom', lanes: { ...lanesNow(), [k]: sel.value } }));
      lab.append(sw, document.createTextNode(label), sel);
      custom.append(lab);
      laneSel[k] = sel;
    }
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
    winRow.append(nudges);
    const actions = el('div', 'vivi-amx-ov-actions');
    const lock = el('button', 'vivi-amx-ov-btn', 'Lock');
    lock.type = 'button';
    lock.setAttribute('aria-pressed', 'false');
    lock.title = 'Keep this edit past the 300 kept pairs';
    lock.addEventListener('click', () => { if (!lock.disabled) pick({ lock: lock.getAttribute('aria-pressed') !== 'true' }); });
    const reset = el('button', 'vivi-amx-ov-btn', 'Reset to Auto');
    reset.type = 'button';
    reset.addEventListener('click', () => { const s = xf()?.overview?.(); if (s?.pairKey && !reset.disabled) { xf().setPairPick(s.pairKey, null); refused = null; sig = ''; } });
    const preview = el('button', 'vivi-amx-ov-btn', '▶ Preview');
    preview.type = 'button';
    preview.addEventListener('click', () => { const s = xf()?.overview?.(); if (s?.editable) xf().seekTo(s.previewAt); });
    const note = el('span', 'vivi-amx-ov-note', '');
    const badge = el('span', 'vivi-amx-ov-badge', 'Custom');
    badge.hidden = true;
    actions.append(preview, lock, reset, badge, note);
    controls.append(presetRow.row, custom, matchRow.row, barsRow.row, winRow, actions);
    card.append(head, songsRow, well, legend, controls);
    root.append(card);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) hide(); });
    document.body.append(root);
    ui = { root, card, sub, songsRow, canvas, msg, clock, presetRow, custom, laneSel, matchRow, barsRow, nudgeBtns, winReset, preview, lock, reset, badge, note };
    canvas.addEventListener('pointerdown', dragStart);
    canvas.addEventListener('pointermove', dragMove);
    canvas.addEventListener('pointerup', dragEnd);
    canvas.addEventListener('pointercancel', () => { drag = null; sig = ''; });
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
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('vivi-open');
    setTimeout(() => root.remove(), 250);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); hide(); }
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
    return m.shape === 'dropin' ? 'Auto · Drop-in' : m.shape === 'muffle' ? 'Auto · Muffle' : m.glide ? 'Auto · Glide' : 'Auto · Blend';
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
    return `A mixes out at ${fmtSec(out.sec)} (bar ${barNo(out)}) · B enters at ${fmtSec(inn.sec)} (bar ${barNo(inn)})`;
  }
  function windowEditable(s) {
    const ov = A().migratePick(s?.pick);
    return !!s && !s.why && s.editable && !!s.toId && s.mix.style !== 'loop' && ov?.preset !== 'loop';
  }
  function dragStart(e) {
    const s = xf()?.overview?.();
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
    out: ['A has already played up to there', "the window has to end before A's music does"],
    in: ["that is B's start", "the window has to end 10 s before B's end"],
  };
  function dragMove(e) {
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
    const w = { ...(ov?.window || {}), [side]: pos }, other = side === 'out' ? 'in' : 'out';
    if (!w[other]) w[other] = positionOf(other === 'out' ? s.mix.mixOutTrackTime : s.mix.mixInTrackTime, gridFor(s, other), false, false);
    return w;
  }
  function dragEnd(e) {
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
  // A 10 ms step of one song's position (from where the plan has it, when nothing is saved yet)
  function nudge(side, dir) {
    const s = xf()?.overview?.();
    if (!windowEditable(s)) return;
    const ov = A().migratePick(s.pick);
    const grid = gridFor(s, side);
    const now = ov?.window?.[side] || positionOf(side === 'out' ? s.mix.mixOutTrackTime : s.mix.mixInTrackTime, grid, false, false);
    const n = (now.nudgeMs || 0) + dir * NUDGE_MS;
    if (Math.abs(n) > NUDGE_MAX_MS) { refused = { pair: s.pairKey, text: `Nudges reach ${NUDGE_MAX_MS / 1000} s at most: drag the song instead` }; return; }
    const pos = { ...now, nudgeMs: n, sec: Math.round((now.sec + dir * NUDGE_MS / 1000) * 1000) / 1000 };
    if (!pos.nudgeMs) delete pos.nudgeMs;
    pick({ window: windowWith(s, ov, side, pos) });
  }

  function loop() {
    frame = 0;
    if (!ui) return;
    try { render(); } catch (e) { console.warn('[ViVi automix overview]', e); }
    frame = requestAnimationFrame(loop);
  }

  function describe(m, s) {
    if (m.style === 'loop') {
      const l = m.loop;
      return `Loop mix · ${l.totalBars} bars · ${Math.round(l.out.bpm)}→${Math.round(l.in.bpm)} BPM · ${s.D.toFixed(1)} s`;
    }
    // (Automix v2 names its ways: the hand-over and bridge of a pair it can't beatmatch, the drop-in, muffle and glide)
    if (m.style === 'crossfade') return `${m.bridge ? 'Beatless bridge' : m.handoff ? 'Hand-over' : 'Fade'} · ${s.D.toFixed(1)} s${m.reason ? ' · ' + m.reason : ''}`;
    const bpm = m.inBpm && Math.round(m.inBpm) !== Math.round(m.bpm) ? `${Math.round(m.outBpm || m.bpm)}→${Math.round(m.inBpm)} BPM` : `${Math.round(m.bpm)} BPM`;
    const kind = m.style === 'filter' ? 'Filter mix' : m.shape === 'dropin' ? 'Drop-in' : m.shape === 'muffle' ? 'Muffle' : m.glide ? 'Glide blend' : 'Blend';
    return `${kind} · ${m.bars} bars · ${bpm} · ${s.D.toFixed(1)} s`;
  }

  function render() {
    let s = xf()?.overview?.();
    if (!s || s.why) {
      ui.sub.textContent = s?.why || 'Automix is not running';
      ui.msg.textContent = s?.why || '';
      ui.msg.hidden = false;
      ui.canvas.hidden = true;
      ui.songsRow.replaceChildren();
      songsSig = '';
      setControls(null);
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
    setControls(s);
    draw(s);
  }

  const setIf = (node, key, v) => { if (node[key] !== v) node[key] = v; };
  function setControls(s) {
    const { presetRow, custom, laneSel, matchRow, barsRow, nudgeBtns, winReset, preview, lock, reset, badge, note } = ui;
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
      sel.disabled = !s?.toId || preset === 'loop';
      const v = lanes?.[k] || '';
      if (v && sel.value !== v) sel.value = v;
    }
    custom.classList.toggle('vivi-off', preset === 'loop');
    for (const b of matchRow.chips) { mark(b, b.dataset.v === bm); b.disabled = !s?.toId || preset === 'loop'; }
    const isLoop = preset === 'loop' || (preset === 'auto' && s?.mix?.style === 'loop');
    for (const b of barsRow.chips) {
      const v = Number(b.dataset.v);
      mark(b, v === (ov.bars || 0));
      b.disabled = !s?.toId || (isLoop && v !== 0);
      setIf(b, 'title', b.disabled && v !== 0 && s?.toId ? 'A loop mix sets its own length' : '');
    }
    const winOn = windowEditable(s);
    for (const b of nudgeBtns) b.disabled = !winOn;
    winReset.disabled = !winOn || !ov.window;
    mark(winReset, !ov.window);
    lock.disabled = !has;
    lock.setAttribute('aria-pressed', String(!!ov.lock));
    lock.classList.toggle('vivi-on', !!ov.lock);
    setIf(lock, 'textContent', ov.lock ? 'Locked' : 'Lock');
    reset.disabled = !has;
    badge.hidden = !has || (!ov.preset && !ov.lanes && !ov.window && !ov.beatMatch && !ov.bars);
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
  }

  function drawStatic(s, w, h, dpr, t0, t1) {
    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr); layer.height = Math.round(h * dpr);
    const g = layer.getContext('2d');
    g.scale(dpr, dpr);
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const T = (x) => t0 + (x / w) * (t1 - t0);
    const gap = 10, laneH = (h - gap * 3) / 2;
    const top = [gap, gap * 2 + laneH];
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

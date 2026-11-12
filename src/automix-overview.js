/* VIVIMUSIC WEB — automix-overview.js
 *
 * The Automix overview (BitChord's MixViewPopup, with Spotify Mix's
 * per-transition choices): the coming mix, or the one playing, drawn on its
 * own clock. Each song gets a 3-band waveform (low under 200 Hz, mid to
 * 2.5 kHz, high above), dimmed outside the mix; the mix is framed, with its
 * beat grid (bars brighter) and each song's fader curve.
 *
 * Beyond BitChord: a style (Auto, Loop, Blend, Filter, Fade) and a length
 * (Auto, 4 to 32 bars) can be picked for each pair of songs, kept for the
 * next time the pair plays, and Preview jumps to just before the mix.
 *
 * Opened by its button in the player bar (while Automix is on) or by
 * clicking the Automix toast. Everything here only reads what crossfade.js plans
 * (window.__viviCrossfade.overview()); a pick goes back through setPairPick.
 */
(() => {
  'use strict';
  if (window.__viviAutomixOverview) return;

  const COLORS = { low: '#2E45E6', mid: '#E08B35', high: '#F1DDC4', frame: '#3A9BDC', fader: '#F2C230' };
  const OUTSIDE_ALPHA = 0.32;      // audio outside the mix
  const BANDS = ['low', 'mid', 'high'];
  const FR = 40;                   // waveform columns per second of song
  const DECODE_SR = 22050;
  const STYLES = [['', 'Auto'], ['loop', 'Loop'], ['blend', 'Blend'], ['filter', 'Filter'], ['crossfade', 'Fade']];
  const BARS = [[0, 'Auto'], [4, '4'], [8, '8'], [16, '16'], [32, '32']];
  const FILTER_MAX_BARS = 8;       // automix.js FILTER_MAX_BARS

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
  let frame = 0, sig = '', staticLayer = null, songsSig = '';

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
    for (const [k, t] of [['low', 'Low'], ['mid', 'Mid'], ['high', 'High'], ['fader', 'Volume']]) {
      const i = el('span', 'vivi-amx-ov-key');
      const sw = el('i');
      sw.style.background = COLORS[k];
      i.append(sw, document.createTextNode(t));
      legend.append(i);
    }
    const clock = el('span', 'vivi-amx-ov-clock', '');
    legend.append(clock);
    const controls = el('div', 'vivi-amx-ov-controls');
    const styleRow = chipRow('Style', STYLES, (v) => pick({ style: v || null }));
    const barsRow = chipRow('Length', BARS, (v) => pick({ bars: Number(v) || null }));
    const actions = el('div', 'vivi-amx-ov-actions');
    const preview = el('button', 'vivi-amx-ov-btn', '▶ Preview');
    preview.type = 'button';
    preview.addEventListener('click', () => { const s = xf()?.overview?.(); if (s?.editable) xf().seekTo(s.previewAt); });
    const note = el('span', 'vivi-amx-ov-note', '');
    actions.append(preview, note);
    controls.append(styleRow.row, barsRow.row, actions);
    card.append(head, songsRow, well, legend, controls);
    root.append(card);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) hide(); });
    document.body.append(root);
    ui = { root, card, sub, songsRow, canvas, msg, clock, styleRow, barsRow, preview, note };
    document.addEventListener('keydown', onKey, true);
    sig = ''; songsSig = ''; staticLayer = null;
    requestAnimationFrame(() => root.classList.add('vivi-open'));
    loop();
  }
  function hide() {
    if (!ui) return;
    const root = ui.root;
    ui = null;
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
  function pick(change) {
    const s = xf()?.overview?.();
    if (!s?.pairKey || !s.toId) return;
    const cur = s.pick || { style: null, bars: null };
    const next = { ...cur, ...change };
    // a loop's length is its loops'; a fade's is fixed
    if (next.style === 'loop' || next.style === 'crossfade') next.bars = null;
    if (next.style === 'filter' && next.bars > FILTER_MAX_BARS) next.bars = FILTER_MAX_BARS;
    xf().setPairPick(s.pairKey, next);
    sig = '';
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
    if (m.style === 'crossfade') return `Fade · ${s.D.toFixed(1)} s${m.reason ? ' · ' + m.reason : ''}`;
    const bpm = m.inBpm && Math.round(m.inBpm) !== Math.round(m.bpm) ? `${Math.round(m.outBpm || m.bpm)}→${Math.round(m.inBpm)} BPM` : `${Math.round(m.bpm)} BPM`;
    return `${m.style === 'filter' ? 'Filter mix' : 'Blend'} · ${m.bars} bars · ${bpm} · ${s.D.toFixed(1)} s`;
  }

  function render() {
    const s = xf()?.overview?.();
    if (!s || s.why) {
      ui.sub.textContent = s?.why || 'Automix is not running';
      ui.msg.textContent = s?.why || '';
      ui.msg.hidden = false;
      ui.canvas.hidden = true;
      ui.songsRow.replaceChildren();
      songsSig = '';
      setControls(null);
      ui.clock.textContent = '';
      // a pick for these two songs, with no mix to show: Auto can still clear it
      if (s?.pick) {
        for (const r of [ui.styleRow, ui.barsRow]) r.chips[0].disabled = false;   // Auto comes first in both
        // what is picked shows as picked
        const mark = (b, on) => { b.classList.toggle('vivi-on', on); b.setAttribute('aria-checked', String(on)); };
        for (const b of ui.styleRow.chips) mark(b, b.dataset.v === (s.pick.style || ''));
        for (const b of ui.barsRow.chips) mark(b, Number(b.dataset.v) === (s.pick.bars || 0));
        ui.note.textContent = 'These two songs have a pick of their own: Auto clears it.';
      }
      return;
    }
    ui.msg.hidden = true;
    ui.canvas.hidden = false;
    ui.sub.textContent = describe(s.mix, s);
    // the cards again once an analysis lands (their BPM and key)
    const ss = s.pairKey + '|' + [s.fromId, s.toId].map((id) => (id && A()?.get(id)?.bpm ? 1 : 0)).join('');
    if (songsSig !== ss) { songsSig = ss; drawSongs(s); }
    setControls(s);
    draw(s);
  }

  function setControls(s) {
    const { styleRow, barsRow, preview, note } = ui;
    const pk = s?.pick || {};
    const style = pk.style || '';
    const loopNone = s?.loop?.state === 'none';
    for (const b of styleRow.chips) {
      const on = b.dataset.v === style;
      b.classList.toggle('vivi-on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !s?.toId || (b.dataset.v === 'loop' && loopNone);
      b.title = b.dataset.v === 'loop' && loopNone ? `No loop mix for these two: ${s.loop.why}` : '';
    }
    const actual = s?.mix?.style;
    const fixedLen = style === 'loop' || style === 'crossfade' || (!style && !pk.bars && (actual === 'loop' || actual === 'crossfade'));
    const lenWhy = !s?.toId ? '' : fixedLen
      ? ((style || actual) === 'loop' ? 'A loop mix sets its own length: pick Blend or Filter to choose one' : 'A fade has a fixed length')
      : style === 'filter' ? `A filter mix is at most ${FILTER_MAX_BARS} bars` : '';
    for (const b of barsRow.chips) {
      const v = Number(b.dataset.v);
      const on = v === (pk.bars || 0);
      b.classList.toggle('vivi-on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !s?.toId || (fixedLen && v !== 0) || ((style === 'filter') && v > FILTER_MAX_BARS);
      b.title = b.disabled && v !== 0 ? lenWhy : '';
    }
    const left = s && s.editable && s.at != null ? -s.at : null;
    preview.disabled = !s?.editable || !(s.previewAt > 0) || left == null || left < 25;
    preview.title = preview.disabled ? '' : 'Jump to just before the mix';
    let n = '';
    if (!s) n = '';
    else if (!s.editable) n = 'Mixing now: a new pick is for the next time these two play.';
    else if (style && style !== actual && !(style === 'crossfade' && actual === 'crossfade')) n = style === 'loop' ? 'Preparing the loop mix…' : 'Planning…';
    else if (pk.bars && s.mix.bars && pk.bars !== s.mix.bars && actual !== 'loop') n = `${pk.bars} bars asked; ${s.mix.bars} fit here.`;
    else if (style || pk.bars) n = 'Kept for these two songs.';
    else if (s.mix.reason) n = s.mix.reason;
    else if (fixedLen) n = lenWhy + '.';
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
    if (want !== sig || !staticLayer) {
      sig = want;
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
    g.strokeStyle = COLORS.fader;
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
    if (b.parentElement !== host) host.prepend(b);
    b.hidden = false;
    const state = !s || s.why ? 'idle' : s.editable ? 'planned' : 'mixing';
    if (b.dataset.state !== state) b.dataset.state = state;
    const title = s?.why ? `Automix: ${s.why}` : state === 'mixing' ? 'Automix: mixing now' : 'Automix: see the next mix';
    if (b.title !== title) b.title = title;
  }
  setInterval(syncButton, 1000);

  window.__viviAutomixOverview = { open, hide };
})();

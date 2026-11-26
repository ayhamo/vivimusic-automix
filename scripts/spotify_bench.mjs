// The Spotify benchmark (spec/automix/spotify-benchmark.md): Spotify's own song analysis as an answer key
// for each app's analyser. Offline: nothing plays.
//
//   node scripts/spotify_bench.mjs --key              line each song's YouTube audio up with Spotify's, write key.json
//   node scripts/spotify_bench.mjs --analyse          the extension's analyser on every song, into pc/<videoId>.json
//   node scripts/spotify_bench.mjs --plan [app]       the PC planner on an app's analyses, into <app>/plans.json (pc)
//   node scripts/spotify_bench.mjs --score [app]      score an app (pc): print the report, write report-<app>.json
//     [--bench DIR]                                   the bench folder (default: the shared one in YT Clients)
//     [--only id,id]                                  some songs only
//     [--content-end]                                 --analyse: only add the music's end to analyses made before it was kept
//     [--version 2|3]                                 --plan: the Automix version (default 2, Classic)
//     [--curator]                                     --plan, version 3: the curator blend (analysis-cases.md "The curator blend")
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ANALYSIS_SR, BEAT_SR, ANALYSIS_MAX_SEC, analyse } from './analysis_worker.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RESEARCH = 'D:/Programs/Projects/YT Clients/research/spotify-mixes/';
const BENCH = opt('--bench', RESEARCH + 'bench').replace(/\/$/, '') + '/';
const ONLY = opt('--only', '') ? new Set(opt('--only').split(',')) : null;
const EXPORTS = ['budget-dj-mix', 'dj-club-mixes', 'heavenly-transitions', 'rap-mixes'];

// rule 3's numbers
const WIN = 0.02, MAX_LAG = 15, MIN_ALIGN = 0.6, SUNG_AT = 50, SUNG_GAP = 0.3;
// rule 6's numbers
const TOL = 0.07, TEMPO_TOL = 0.02, VOCAL_SUNG = 0.25, VOCAL_GRID = 0.05;
const r3 = (x) => Math.round(x * 1000) / 1000;
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const exports = () => Object.fromEntries(EXPORTS.map((f) => [f, readJson(RESEARCH + f + '.json')]));
const audioOf = (id) => { const f = existsSync(BENCH + 'audio') ? readdirSync(BENCH + 'audio').find((x) => x.startsWith(id + '.') && !x.endsWith('.part')) : null; return f ? BENCH + 'audio/' + f : null; };
const decode = (file, sr, ch) => { const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(ch), '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 }); return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice(); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

// ───────── rule 3: lining up, the key ─────────
const logEnv = (a) => { const v = a.map((x) => Math.log1p(x)); const m = v.reduce((s, x) => s + x, 0) / v.length; return v.map((x) => x - m); };
// Spotify's threeBand and loudness values are protobuf packed varints (a value over 127 takes two bytes), 20 ms each
const varints = (b64) => { const out = []; let v = 0, s = 0; for (const b of Buffer.from(b64, 'base64')) { v |= (b & 127) << s; if (b & 128) s += 7; else { out.push(v); v = 0; s = 0; } } return out; };
function spotifyEnv(t) {
  const [lo, mi, hi] = ['low', 'mid', 'high'].map((k) => varints(t.threeBand[k]));
  const n = Math.min(lo.length, mi.length, hi.length);
  return logEnv(Array.from({ length: n }, (_, i) => lo[i] + mi[i] + hi[i]));
}
function youtubeEnv(file) {
  const sr = 8000, x = decode(file, sr, 1), w = Math.round(WIN * sr), n = Math.floor(x.length / w);
  const env = new Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * w; k < (i + 1) * w; k++) s += x[k] * x[k]; env[i] = 255 * Math.sqrt(s / w); }
  return { env: logEnv(env), sec: x.length / sr };
}
// YouTube time = Spotify time + offset: the lag of the best normalized cross-correlation, refined by a parabola
function lineUp(sp, yt) {
  const L = Math.round(MAX_LAG / WIN), cs = [];
  for (let lag = -L; lag <= L; lag++) {
    let xy = 0, xx = 0, yy = 0;
    const i0 = Math.max(0, -lag), i1 = Math.min(sp.length, yt.length - lag);
    for (let i = i0; i < i1; i++) { const a = sp[i], b = yt[i + lag]; xy += a * b; xx += a * a; yy += b * b; }
    cs.push(i1 - i0 > 500 && xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : -1);
  }
  let k = 0; cs.forEach((c, i) => { if (c > cs[k]) k = i; });
  const [a, b, c] = [cs[k - 1] ?? cs[k], cs[k], cs[k + 1] ?? cs[k]], d = a - 2 * b + c;
  const frac = d < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0;
  return { offsetSec: r3((k - L + frac) * WIN), alignScore: Math.round(b * 1000) / 1000 };
}
function sungSpans(v, off) {
  const bytes = Buffer.from(v.values, 'base64'), step = v.hop / v.sampleRate;
  const t0 = (v.firstWindowStart > 60 ? v.firstWindowStart / v.sampleRate : v.firstWindowStart || 0) + off;
  const spans = [];
  bytes.forEach((b, i) => {
    if (b < SUNG_AT) return;
    const s = t0 + i * step, e = s + step, last = spans[spans.length - 1];
    if (last && s - last[1] < SUNG_GAP) last[1] = e; else spans.push([s, e]);
  });
  return spans.map(([s, e]) => [r3(s), r3(e)]);
}
async function key() {
  const sa = readJson(RESEARCH + 'spotify-analysis.json'), ex = exports();
  const ytOf = {}, meta = {};
  for (const e of Object.values(ex)) for (const t of [...(e.playlist?.tracks || []), ...e.mixes.flatMap((m) => [m.from, m.to])]) if (t?.uri && t.youtubeVideoId) { ytOf[t.uri] = t.youtubeVideoId; meta[t.uri] = t; }
  const songs = {}, skipped = [];
  let noId = 0;
  for (const [uri, t] of Object.entries(sa.tracks)) {
    if (!t.beats) continue;
    const id = ytOf[uri];
    if (!id) { noId++; continue; }
    if (ONLY && !ONLY.has(id)) continue;
    const file = audioOf(id);
    if (!file) { skipped.push({ videoId: id, uri, why: 'no audio' }); continue; }
    if (!t.threeBand) { skipped.push({ videoId: id, uri, why: 'no threeBand in the Spotify analysis' }); continue; }
    const { offsetSec, alignScore } = lineUp(spotifyEnv(t), youtubeEnv(file).env);
    // (two Spotify tracks on one video: the better lined up one)
    if (songs[id] && songs[id].alignScore >= alignScore) continue;
    if (alignScore < MIN_ALIGN) { skipped.push({ videoId: id, uri, why: `not lined up (${alignScore})` }); continue; }
    const B = t.beats.beats, sh = (s) => r3(s + offsetSec), ms = (c) => r3(c.ms / 1000 + offsetSec);
    const ibi = B.slice(1).map((b, i) => b[0] - B[i][0]).filter((d) => d > 0);
    const cues = t.cuepoints ? { mixIn: t.cuepoints.mixIn ? ms(t.cuepoints.mixIn) : null, mixOut: t.cuepoints.mixOut ? ms(t.cuepoints.mixOut) : null,
      fadeIn: (t.cuepoints.fadeIn || []).map(ms), fadeOut: (t.cuepoints.fadeOut || []).map(ms) } : null;
    songs[id] = { uri, title: meta[uri]?.title || '', offsetSec, alignScore, bpm: Math.round(6000 / median(ibi)) / 100, camelot: t.attributes?.camelot || null,
      beats: B.map((b) => sh(b[0])), downbeats: B.filter((b) => b[3] === 1).map((b) => sh(b[0])), cues, sung: t.vocalActivity ? sungSpans(t.vocalActivity, offsetSec) : null };
    process.stdout.write(`${id} ${offsetSec >= 0 ? '+' : ''}${offsetSec.toFixed(3)} s, ${alignScore}\n`);
  }
  for (const s of skipped) if (songs[s.videoId]) s.why = 'another Spotify track on this video was lined up';
  const left = skipped.filter((s) => !songs[s.videoId] || s.why.startsWith('another'));
  writeFileSync(BENCH + 'key.json', JSON.stringify({ format: 'spotify-bench-key', version: 1, songs, skipped: left }));
  console.log(`key.json: ${Object.keys(songs).length} songs lined up, ${left.length} skipped, ${noId} Spotify tracks with no YouTube id`);
}

// ───────── rule 4: the PC's analyses ─────────
let PHASE = null;
// host.js's contentEnd (where the music ends), read from the extension's own file: the analysis keeps it
// as the extension saves it (automix.js musicEnd plans against it)
let CONTENT_END = null;
function contentEndOf(mono) {
  if (!CONTENT_END) {
    const host = readFileSync(ROOT + 'src/automix/host.js', 'utf8'), i = host.indexOf('function contentEnd(');
    let d = 0, j = host.indexOf('{', i);
    for (; j < host.length; j++) { if (host[j] === '{') d++; else if (host[j] === '}' && !--d) break; }
    CONTENT_END = new Function('return ' + host.slice(i, j + 1))();
  }
  return CONTENT_END(mono, ANALYSIS_SR);
}
async function analyseAll() {
  const k = readJson(BENCH + 'key.json');
  mkdirSync(BENCH + 'pc', { recursive: true });
  let done = 0;
  for (const id of Object.keys(k.songs)) {
    if (ONLY && !ONLY.has(id)) continue;
    const out = BENCH + `pc/${id}.json`;
    if (existsSync(out) && args.includes('--content-end')) {
      const a = readJson(out);
      if (a.contentEndSec !== undefined) continue;
      const st = decode(audioOf(id), ANALYSIS_SR, 2), n = st.length >> 1, mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = (st[2 * i] + st[2 * i + 1]) / 2;
      writeFileSync(out, JSON.stringify({ ...a, contentEndSec: contentEndOf(mono) }));
      done++;
      continue;
    }
    if (existsSync(out) && !args.includes('--again')) continue;
    const file = audioOf(id);
    const st = decode(file, ANALYSIS_SR, 2), n = st.length >> 1;
    if (n / ANALYSIS_SR > ANALYSIS_MAX_SEC) { console.log(`${id}: over ${ANALYSIS_MAX_SEC} s, not analysed (as in the app)`); continue; }
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = st[2 * i]; R[i] = st[2 * i + 1]; }
    const r = await analyse(id, L, R, decode(file, BEAT_SR, 1));
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) / 2;
    r.contentEndSec = contentEndOf(mono);
    // as the extension keeps it: the bar phase is set on load (automix.js withBarPhase)
    writeFileSync(out, JSON.stringify({ side: 'pc', videoId: id, fileKey: id, ...(PHASE ??= loadAutomix().withBarPhase)(r) }));
    done++;
    console.log(`${done} ${id}: ${r.bpm?.toFixed(2)} BPM (Spotify ${k.songs[id].bpm}), ${r.camelot ? r.camelot.num + r.camelot.letter : '-'} (Spotify ${k.songs[id].camelot})`);
  }
  console.log(`${done} song(s) analysed into ${BENCH}pc`);
}

// ───────── rule 5: plans ─────────
function loadAutomix() {
  const window = { addEventListener() {}, postMessage() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = { runtime: { getURL: (p) => 'moz-extension://test/' + p }, storage: { local: { get: (d, cb) => cb({ ...d, ...(opt('--version', null) ? { automixVersion: Number(opt('--version')) } : {}) }) }, onChanged: { addListener() {} } } };
  vm.runInContext(readFileSync(ROOT + 'src/automix/automix.js', 'utf8'), vm.createContext({ window, chrome, document: {}, console: { log() {}, warn() {} }, performance, setTimeout, clearTimeout, URL }));
  return window.__viviAutomix;
}
const loadSide = (app) => (existsSync(BENCH + app) ? Object.fromEntries(readdirSync(BENCH + app).filter((f) => f.endsWith('.json') && f !== 'plans.json').map((f) => { const j = readJson(BENCH + app + '/' + f); return [j.videoId || j.fileKey, j]; })) : {});
function planAll() {
  const app = opt('--plan', 'pc'), side = loadSide(app), A = loadAutomix(), plans = [];
  for (const [name, e] of Object.entries(exports())) for (const m of e.mixes) {
    const a = m.from?.youtubeVideoId, b = m.to?.youtubeVideoId;
    if (!side[a] || !side[b] || a === b) continue;
    const args0 = { fromId: a, toId: b, from: side[a], to: side[b], durationSec: side[a].durationSec, pos: 30, earliest: 34.5 };
    let p = A.plan(args0);
    // --curator: as crossfade.js asks for it, only over Auto's plain blend (the bench has no loop mix)
    if (args.includes('--curator') && p.style === 'blend' && !p.shape) { const k = A.plan({ ...args0, curator: true }); if (k.curator) p = k; }
    plans.push({ playlist: name, index: m.index, from: a, to: b, style: p.style, ...(p.curator ? { curator: true } : {}), mixOutTrackTime: r3(p.mixOutTrackTime), mixInTrackTime: r3(p.mixInTrackTime), durationSec: r3(p.durationSec), bars: p.bars });
  }
  writeFileSync(BENCH + app + '/plans.json', JSON.stringify({ format: 'spotify-bench-plans', version: 1, app, analysisVersion: Object.values(side)[0]?.analysisVersion || null, plans }));
  console.log(`${plans.length} plans into ${BENCH}${app}/plans.json`);
}

// ───────── rule 6: the metrics ─────────
// one-to-one matches within TOL, both lists sorted
function fMeasure(ref, est) {
  let i = 0, j = 0, hit = 0;
  while (i < ref.length && j < est.length) {
    const d = est[j] - ref[i];
    if (Math.abs(d) <= TOL) { hit++; i++; j++; } else if (d < 0) j++; else i++;
  }
  const p = est.length ? hit / est.length : 0, r = ref.length ? hit / ref.length : 0;
  return { f: p + r ? (2 * p * r) / (p + r) : 0, p, r };
}
const within = (list, t, tol) => list.some((x) => Math.abs(x - t) <= tol);
const span = (list, a, b) => list.filter((t) => t >= a - TOL && t <= b + TOL);
function gridBeats(a) {
  const grid = (g, from, to) => { const out = []; if (!(g?.beatIntervalSec > 0) || g.firstDownbeatSec == null) return out; let k = Math.ceil((from - g.firstDownbeatSec) / g.beatIntervalSec); for (let t; (t = g.firstDownbeatSec + k * g.beatIntervalSec) <= to; k++) out.push([t, k]); return out; };
  const tailFrom = a.tailGrid && a.tailBeats?.beats?.length ? a.tailBeats.beats[0] : Infinity;
  return [...grid(a, 0, Math.min(a.durationSec, tailFrom - 1e-6)), ...(Number.isFinite(tailFrom) ? grid(a.tailGrid, tailFrom, a.durationSec) : [])];
}
const camelotOf = (c) => (c ? { n: c.num, l: c.letter } : null);
const parseCam = (s) => (s ? { n: Number(s.slice(0, -1)), l: s.slice(-1) } : null);
function keyClass(ours, sp) {
  if (!ours) return 'none';
  if (!sp) return 'no key';
  if (ours.n === sp.n && ours.l === sp.l) return 'right';
  if (ours.n === sp.n) return 'relative';
  const d = (((ours.n - sp.n) % 12) + 12) % 12;
  if (ours.l === sp.l && (d === 1 || d === 11)) return 'fifth';
  // parallel: same tonic, other mode = B number is A number + 3 (Camelot)
  if (ours.l !== sp.l && (((ours.l === 'B' ? ours.n - sp.n : sp.n - ours.n) % 12) + 12) % 12 === 3) return 'parallel';
  return 'wrong';
}
function tempoClass(r) {
  for (const [name, x] of [['right', 1], ['half', 0.5], ['double', 2], ['two-thirds', 2 / 3], ['three-halves', 1.5]]) if (Math.abs(r / x - 1) <= TEMPO_TOL) return name;
  return 'wrong';
}
function vocalIoU(a, sung) {
  if (!a.vocals?.length || !sung) return null;
  let both = 0, either = 0, ours = 0, theirs = 0;
  const inSung = (t) => sung.some(([s, e]) => t >= s && t < e);
  for (const w of a.vocals) {
    const end = w.startSec + w.curve.length / w.fps;
    for (let t = w.startSec; t < end; t += VOCAL_GRID) {
      const o = w.curve[Math.min(w.curve.length - 1, Math.floor((t - w.startSec) * w.fps))] >= VOCAL_SUNG, s = inSung(t);
      if (o && s) both++; if (o || s) either++; if (o) ours++; if (s) theirs++;
    }
  }
  return { iou: either ? both / either : 1, p: ours ? both / ours : 1, r: theirs ? both / theirs : 1 };
}
function score() {
  const app = opt('--score', 'pc'), k = readJson(BENCH + 'key.json'), side = loadSide(app);
  const plans = existsSync(BENCH + app + '/plans.json') ? readJson(BENCH + app + '/plans.json').plans : [];
  const ex = exports(), mixOf = (p) => ex[p.playlist].mixes.find((m) => m.index === p.index);
  const rows = [];
  for (const [id, s] of Object.entries(k.songs)) {
    if (ONLY && !ONLY.has(id)) continue;
    const a = side[id];
    if (!a) { rows.push({ id, title: s.title, missing: true }); continue; }
    const row = { id, title: s.title, offsetSec: s.offsetSec };
    row.tempo = a.bpm ? { ours: Math.round(a.bpm * 100) / 100, spotify: s.bpm, class: tempoClass(a.bpm / s.bpm) } : null;
    const from = s.beats[0], to = s.beats[s.beats.length - 1];
    const gb = gridBeats(a);
    row.beats = gb.length ? fMeasure(span(s.beats, from, to), span(gb.map((x) => x[0]), from, to)) : null;
    const mb = [a.headBeats?.beats || [], a.tailBeats?.beats || []].filter((b) => b.length);
    if (mb.length) {
      let hit = 0, nr = 0, ne = 0;
      for (const b of mb) { const ref = span(s.beats, b[0], b[b.length - 1]), r = fMeasure(ref, b); hit += r.r * ref.length; nr += ref.length; ne += b.length; }
      const p = ne ? hit / ne : 0, r = nr ? hit / nr : 0;
      row.modelBeats = { f: p + r ? (2 * p * r) / (p + r) : 0, p, r };
    } else row.modelBeats = null;
    if (gb.length && s.downbeats.length) {
      const bars = (shift) => gb.filter(([, kk]) => (((kk - shift) % 4) + 4) % 4 === 0).map((x) => x[0]);
      const share = (list) => span(s.downbeats, from, to).filter((t) => within(list, t, TOL)).length / span(s.downbeats, from, to).length;
      const sh0 = share(bars(0));
      row.downbeats = { share: sh0 };
      if (sh0 < 0.5) { const best = [1, 2, 3].map((x) => [x, share(bars(x))]).sort((x, y) => y[1] - x[1])[0]; row.downbeats.shift = best[0]; row.downbeats.shiftShare = best[1]; }
    } else row.downbeats = null;
    row.key = { ours: a.camelot ? a.camelot.num + a.camelot.letter : null, spotify: s.camelot, class: keyClass(camelotOf(a.camelot), parseCam(s.camelot)) };
    row.vocals = vocalIoU(a, s.sung);
    const beat = 60 / s.bpm;
    row.mixOut = []; row.mixIn = [];
    for (const p of plans) {
      const m = mixOf(p);
      if (!m) continue;
      // (a straight cut has no mix-out time in Spotify's export: nothing to measure; its NaN once broke the median's sort)
      if (p.from === id && Number.isFinite(m.fromStartMs)) {
        const spot = m.fromStartMs / 1000 + s.offsetSec, cues = s.cues ? [s.cues.mixOut, ...s.cues.fadeOut].filter((x) => x != null) : [];
        row.mixOut.push({ playlist: p.playlist, index: p.index, ours: p.mixOutTrackTime, spotify: r3(spot), beats: Math.round((Math.abs(p.mixOutTrackTime - spot) / beat) * 10) / 10, nearCue: within(cues, p.mixOutTrackTime, beat) });
      }
      if (p.to === id) {
        const neg = m.toStartMs == null || m.toStartMs < 0 || m.toStartMs >= 2 ** 53;
        const spot = (neg ? 0 : m.toStartMs / 1000) + s.offsetSec, cues = s.cues ? [s.cues.mixIn, ...s.cues.fadeIn].filter((x) => x != null) : [];
        row.mixIn.push({ playlist: p.playlist, index: p.index, ours: p.mixInTrackTime, spotify: r3(spot), beats: Math.round((Math.abs(p.mixInTrackTime - spot) / beat) * 10) / 10, nearCue: within(cues, p.mixInTrackTime, beat) });
      }
    }
    // rule 7's failures
    row.fails = [];
    if (row.tempo && row.tempo.class !== 'right') row.fails.push(`tempo ${row.tempo.class} (${row.tempo.ours} vs ${row.tempo.spotify})`);
    if (row.beats && row.beats.f < 0.8) row.fails.push(`beats F ${row.beats.f.toFixed(2)}`);
    if (row.downbeats && row.downbeats.share < 0.8) row.fails.push(`downbeats ${(row.downbeats.share * 100).toFixed(0)}%${row.downbeats.shift ? `, ${row.downbeats.shift} beat(s) off fits ${(row.downbeats.shiftShare * 100).toFixed(0)}%` : ''}`);
    if (row.key.class !== 'right' && row.key.class !== 'relative' && row.key.class !== 'no key') row.fails.push(`key ${row.key.class} (${row.key.ours} vs ${row.key.spotify})`);
    for (const c of [...row.mixOut.map((x) => ['mix-out', x]), ...row.mixIn.map((x) => ['mix-in', x])]) if (c[1].beats > 4) { row.fails.push(`${c[0]} ${c[1].beats} beats off (${c[1].playlist} #${c[1].index})`); break; }
    if (row.vocals && row.vocals.iou < 0.5) row.fails.push(`vocal IoU ${row.vocals.iou.toFixed(2)}`);
    rows.push(row);
  }
  // the report
  const got = rows.filter((r) => !r.missing), L = [];
  const count = (f) => { const c = {}; for (const r of got) { const v = f(r); if (v != null) c[v] = (c[v] || 0) + 1; } return c; };
  const dist = (vals) => (vals.length ? `median ${median(vals).toFixed(3)}, 10th percentile ${pct(vals, 0.1).toFixed(3)} (${vals.length} songs)` : 'none');
  L.push(`Spotify benchmark, ${app}: ${got.length} songs scored, ${rows.length - got.length} with no analysis, ${k.skipped.length} not in the key`);
  L.push(`tempo: ${JSON.stringify(count((r) => r.tempo?.class ?? 'none'))}`);
  L.push(`grid beats F (±70 ms): ${dist(got.filter((r) => r.beats).map((r) => r.beats.f))}`);
  L.push(`model beats F (±70 ms): ${dist(got.filter((r) => r.modelBeats).map((r) => r.modelBeats.f))}`);
  L.push(`downbeats: ${dist(got.filter((r) => r.downbeats).map((r) => r.downbeats.share))}; bar shift where under 50%: ${JSON.stringify(count((r) => r.downbeats?.shift ?? null))}`);
  L.push(`key: ${JSON.stringify(count((r) => r.key.class))}`);
  for (const k2 of ['mixOut', 'mixIn']) {
    const all = got.flatMap((r) => r[k2]);
    L.push(`${k2}: ${all.length} plans, median ${all.length ? median(all.map((x) => x.beats)) : '-'} beats from Spotify's, ${all.length ? ((all.filter((x) => x.beats <= 1).length / all.length) * 100).toFixed(0) : '-'}% within 1 beat, ${all.length ? ((all.filter((x) => x.nearCue).length / all.length) * 100).toFixed(0) : '-'}% within 1 beat of a Spotify cue`);
  }
  L.push(`vocals IoU: ${dist(got.filter((r) => r.vocals).map((r) => r.vocals.iou))}`);
  const worst = [...got].sort((x, y) => y.fails.length - x.fails.length || (x.beats?.f ?? 1) - (y.beats?.f ?? 1)).slice(0, 10);
  L.push('', 'the 10 worst songs:');
  for (const r of worst) L.push(`${r.id} ${r.title} (offset ${r.offsetSec} s): ${r.fails.join('; ') || 'nothing failed'}`);
  console.log(L.join('\n'));
  writeFileSync(BENCH + `report-${app}.json`, JSON.stringify({ format: 'spotify-bench-report', version: 1, app, summary: L, songs: rows }));
}

if (args.includes('--key')) await key();
else if (args.includes('--analyse')) await analyseAll();
else if (args.includes('--plan')) planAll();
else if (args.includes('--score')) score();
else console.log('one of --key, --analyse, --plan, --score (see the top of this file)');
process.exit(0);

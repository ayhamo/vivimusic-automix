// The analysis cases of spec/automix/analysis-cases.md, on the extension's real analyser: BitChord's
// analysis worker (src/vendor/automix/analysis.worker.js with the same .onnx files), run in node.
//
//   node scripts/analysis_cases.mjs                          synthetic songs against their truth (CI)
//     [--only a,b] [--debug] [--spec FILE]                  some cases; the beats missed; another case file
//   node scripts/analysis_cases.mjs --real [--cache DIR]     analyse the cached real songs, write DIR/pc/<id>.json
//   node scripts/analysis_cases.mjs --compare A B [--cache DIR]
//                                                            layer 1 (DIR/A against DIR/B per song) and
//                                                            layer 2 (each pair planned on A's and on B's analysis)
//
// The cache (default .cache/analysis, git-ignored) holds <videoId>.wav: 44100 Hz stereo float, decoded
// once, which both sides read. Exit 1 on a failed case; known misses, threshold cases and layer 1
// differences on real songs (reported per platform pair, analysis-cases.md) don't fail.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { render, half, beatTimes } from './analysis_signals.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VENDOR = ROOT + 'src/vendor/automix/';
const SPEC_FILE = (() => { const i = process.argv.indexOf('--spec'); return i > 0 ? process.argv[i + 1] : ROOT + 'spec/automix/analysis-cases.json'; })();
const SPEC = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
const RULE = SPEC.rules;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CACHE = opt('--cache', ROOT + '.cache/analysis');

// host.js's constants: what the extension hands the worker
const ANALYSIS_SR = 44100, BEAT_SR = 22050, BEAT_WINDOW_SEC = 59, VOCAL_WINDOW_SEC = (958 * 1024) / 44100;

// ───────── the worker, in node ─────────
let worker = null;
async function startWorker() {
  if (worker) return worker;
  const out = [];
  globalThis.self = globalThis;
  globalThis.__dirname = VENDOR;   // the bundled essentia.js looks for it; it loads nothing from disk
  globalThis.postMessage = (m) => out.push(m);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (!s.startsWith('vendor:')) return realFetch(u, o);
    return new Response(readFileSync(VENDOR + s.slice(7)), { headers: { 'content-type': s.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
  };
  await import(pathToFileURL(VENDOR + 'analysis.worker.js').href);
  self.onmessage({ data: { type: 'init', wasmUrl: 'vendor:ort-wasm-simd-threaded.wasm', modelUrl: 'vendor:beat_this_final0_q8.onnx', vocalModelUrl: 'vendor:vocals_umxhq_int8.onnx' } });
  for (let t = 0; !out.some((m) => m.type === 'ready'); t++) {
    const bad = out.find((m) => m.type === 'fatal' || m.type === 'error');
    if (bad || t > 600) throw new Error('worker: ' + (bad?.message || 'no ready'));
    await new Promise((r) => setTimeout(r, 100));
  }
  worker = { out };
  return worker;
}

// one song, the way host.js analyzeSong cuts it: the beat model on the opening and the end 59 s, the
// vocal model on two opening windows and up to three at the end
async function analyse(key, left, right, mono22) {
  const w = await startWorker();
  const sec = left.length / ANALYSIS_SR;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
  const beatWindows = [{ offsetSec: 0, pcm: mono22.slice(0, Math.round(Math.min(sec, BEAT_WINDOW_SEC) * BEAT_SR)) }];
  if (sec > BEAT_WINDOW_SEC) beatWindows.push({ offsetSec: sec - BEAT_WINDOW_SEC, pcm: mono22.slice(Math.round((sec - BEAT_WINDOW_SEC) * BEAT_SR)) });
  const starts = [0, VOCAL_WINDOW_SEC].filter((s) => s + VOCAL_WINDOW_SEC <= sec);
  for (let k = 1; k <= 3; k++) { const s = sec - k * VOCAL_WINDOW_SEC; if (s >= 2 * VOCAL_WINDOW_SEC) starts.push(s); }
  const vocalWindows = starts.map((s) => {
    const a = Math.round(s * ANALYSIS_SR), b = Math.min(left.length, a + Math.floor(VOCAL_WINDOW_SEC * ANALYSIS_SR));
    return { offsetSec: s, left: left.slice(a, b), right: right.slice(a, b) };
  });
  self.onmessage({ data: { fileKey: key, samples: mono, sampleRate: ANALYSIS_SR, beatWindows, vocalWindows } });
  while (!w.out.some((m) => m.fileKey === key)) await new Promise((r) => setTimeout(r, 100));
  const m = w.out.find((x) => x.fileKey === key);
  if (m.type !== 'result') throw new Error(key + ': ' + (m.message || m.type));
  return { durationSec: sec, ...m.result };
}

// ───────── measures ─────────
const beatsOf = (a) => [...new Set([...(a.headBeats?.beats || []), ...(a.tailBeats?.beats || [])].map((t) => Math.round(t * 1e4) / 1e4))].sort((x, y) => x - y);
const nearest = (list, t) => { let lo = 0, hi = list.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (list[m] < t) lo = m; else hi = m; } return Math.min(Math.abs(list[lo] - t), Math.abs(list[hi] - t)); };
const shareWithin = (want, got, tol) => (want.length ? want.filter((t) => got.length && nearest(got, t) <= tol).length / want.length : 1);
// the bar starts a reading implies: its beats from the first downbeat on, every 4th (and back before it)
function barStarts(a) {
  const b = beatsOf(a);
  if (!b.length || a.firstDownbeatSec == null) return [];
  let i0 = 0;
  b.forEach((t, i) => { if (Math.abs(t - a.firstDownbeatSec) < Math.abs(b[i0] - a.firstDownbeatSec)) i0 = i; });
  return b.filter((_, i) => (i - i0) % 4 === 0);
}
// frames the planner counts as sung (VOCAL_SUNG): [time, sung] over the vocal windows
function sungFrames(a) {
  const f = [];
  for (const w of a.vocals || []) w.curve.forEach((v, i) => f.push([w.startSec + i / w.fps, v >= RULE.vocalSung]));
  return f;
}
function iou(pairs) {   // [[a, b] booleans]; no frames compared: 0
  if (!pairs.length) return 0;
  let both = 0, either = 0;
  for (const [x, y] of pairs) { if (x && y) both++; if (x || y) either++; }
  return either ? both / either : 1;
}
const f2 = (x) => (x * 100).toFixed(0) + '%';

// ───────── synthetic (CI) ─────────
async function synthetic() {
  let failed = 0;
  const fixed = [];   // known misses that pass now: their knownMiss entry should go
  const only = opt('--only', null);
  const unknown = only ? only.split(',').filter((n) => !SPEC.synthetic.some((c) => c.name === n)) : [];
  if (unknown.length) { console.error('no such case: ' + unknown.join(', ')); return 1; }
  for (const c of SPEC.synthetic) {
    if (only && !only.split(',').includes(c.name)) continue;
    // one render; the beat model's input is its fixed resample (analysis_signals.mjs half)
    const a = render(c.song, ANALYSIS_SR), b = half(a);
    const r = await analyse('syn-' + c.name, a, a, b);
    const truth = beatTimes(c.song).filter((x) => x.t <= c.song.sec - 0.5);
    const lines = [];
    let bad = 0, known = 0;
    const verdict = (what, ok, text) => {
      const k = c.knownMiss?.[what];
      if (!ok && k) known++; else if (!ok) bad++;
      if (ok && k) fixed.push(`${c.name} ${what}`);
      lines.push(`${ok ? (k ? 'FIXED' : 'ok   ') : k ? 'KNOWN' : 'DIFF '} ${what}: ${text}`);
    };
    for (const what of c.check) {
      if (what === 'tempo') {
        const want = c.song.parts[0].bpm;
        verdict('tempo', Math.abs(r.bpm - want) <= RULE.tempoBpm, `${r.bpm.toFixed(2)} BPM for ${want} (±${RULE.tempoBpm}, no half or double)`);
      } else if (what === 'beats') {
        const s = shareWithin(truth.map((x) => x.t), beatsOf(r), RULE.beatSec);
        if (args.includes('--debug')) { const got = beatsOf(r); lines.push('missed: ' + truth.filter((x) => !got.length || nearest(got, x.t) > RULE.beatSec).map((x) => x.t.toFixed(2) + (got.length ? '(' + Math.round(nearest(got, x.t) * 1000) + 'ms)' : '')).join(' ')); }
        verdict('beats', s >= RULE.beatShare, `${f2(s)} within ${RULE.beatSec * 1000} ms (needs ${f2(RULE.beatShare)})`);
      } else if (what === 'downbeat') {
        const s = shareWithin(truth.filter((x) => x.beatInBar === 0).map((x) => x.t), barStarts(r), RULE.beatSec);
        verdict('downbeat', s >= RULE.downbeatBarShare, `${f2(s)} of bars start on a reported downbeat (first ${r.firstDownbeatSec?.toFixed(3)} s; needs ${f2(RULE.downbeatBarShare)})`);
      } else if (what === 'vocals') {
        const voice = c.song.voice || [];
        const edge = (t) => voice.some(([x, y]) => Math.abs(t - x) < 0.25 || Math.abs(t - y) < 0.25);
        const pairs = sungFrames(r).filter(([t]) => !edge(t)).map(([t, s]) => [s, voice.some(([x, y]) => t >= x && t < y)]);
        const v = iou(pairs);
        verdict('vocals', v >= RULE.vocalIoU, `sung regions overlap ${f2(v)} (IoU, needs ${f2(RULE.vocalIoU)}; ${pairs.filter((p) => p[0]).length} of ${pairs.length} frames sung)`);
      }
    }
    if (bad) failed++;
    console.log(`${bad ? 'DIFF' : known ? 'ok* ' : 'ok  '} ${c.name}`);
    for (const l of lines) console.log('       ' + l);
  }
  console.log(failed ? `${failed} case(s) failed` : 'all synthetic cases pass');
  if (fixed.length) console.log(`known misses that pass now (drop their knownMiss in ${SPEC_FILE.replace(ROOT, '')}): ${fixed.join(', ')}`);
  return failed;
}

// ───────── real songs (local) ─────────
function realIds() {
  const ids = new Set(SPEC.real.extra || []);
  for (const f of readdirSync(ROOT + 'spec/automix/pairs').filter((x) => x.endsWith('.json'))) for (const s of JSON.parse(readFileSync(ROOT + 'spec/automix/pairs/' + f, 'utf8')).songs) ids.add(s.id);
  return [...ids];
}
// a float WAV's two channels (the cache's own format: no general WAV reader needed)
function readWav(file) {
  const buf = readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), len = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') data = { at: p + 8, len };
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.sr !== ANALYSIS_SR || fmt.ch !== 2 || fmt.bits !== 32) throw new Error(file + ': not 44100 Hz stereo 32-bit float');
  const n = Math.floor(data.len / 8), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = buf.readFloatLE(data.at + i * 8); R[i] = buf.readFloatLE(data.at + i * 8 + 4); }
  return [L, R];
}
async function real() {
  mkdirSync(CACHE + '/pc', { recursive: true });
  let done = 0;
  for (const id of realIds()) {
    const wav = `${CACHE}/${id}.wav`;
    if (!existsSync(wav)) { console.log(`skip ${id}: no ${wav}`); continue; }
    const [L, R] = readWav(wav);
    // the beat model's 22050 Hz mono: ffmpeg's resampler here (the browser's in the extension)
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-ac', '1', '-ar', String(BEAT_SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const mono22 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice();
    const r = await analyse(id, L, R, mono22);
    writeFileSync(`${CACHE}/pc/${id}.json`, JSON.stringify({ side: 'pc', videoId: id, ...r }));
    console.log(`${id}: ${r.bpm.toFixed(2)} BPM, first downbeat ${r.firstDownbeatSec.toFixed(3)} s, ${beatsOf(r).length} beats`);
    done++;
  }
  console.log(`${done} song(s) analysed into ${CACHE}/pc`);
  return 0;
}

// ───────── side against side ─────────
// Layer 1: the analysers on the same decoded file
function layer1(a, b) {
  const out = [];
  out.push(['tempo', Math.abs(a.bpm - b.bpm) <= RULE.tempoBpm, `${a.bpm.toFixed(2)} / ${b.bpm.toFixed(2)} BPM`]);
  const ba = beatsOf(a), bb = beatsOf(b);
  const s = Math.min(shareWithin(ba, bb, RULE.beatSec), shareWithin(bb, ba, RULE.beatSec));
  out.push(['beats', s >= RULE.beatShare, `${f2(s)} within ${RULE.beatSec * 1000} ms`]);
  const da = barStarts(a), db = barStarts(b);
  const d = Math.min(shareWithin(da, db, RULE.beatSec), shareWithin(db, da, RULE.beatSec));
  out.push(['downbeat', d >= RULE.downbeatBarShare, `${f2(d)} of bars on the same downbeat`]);
  const fa = sungFrames(a), fb = sungFrames(b);
  if (fa.length && fb.length) {
    const at = (f, t) => { let best = null; for (const x of f) if (!best || Math.abs(x[0] - t) < Math.abs(best[0] - t)) best = x; return best && Math.abs(best[0] - t) < 0.05 ? best[1] : null; };
    const pairs = fa.map(([t, s]) => [s, at(fb, t)]).filter((p) => p[1] !== null);
    const v = iou(pairs);
    out.push(['vocals', v >= RULE.vocalIoU, `sung regions overlap ${f2(v)} (IoU)`]);
  }
  return out;
}

function loadAutomix(version) {
  const window = { addEventListener() {}, postMessage() {}, location: { origin: 'https://music.youtube.com' } };
  const chrome = { runtime: { getURL: (p) => 'moz-extension://test/' + p }, storage: { local: { get: (d, cb) => cb({ ...d, automixBars: 'auto', automixVersion: version, automixKeyAware: false }) }, onChanged: { addListener() {} } } };
  const ctx = vm.createContext({ window, chrome, document: {}, console: { log() {}, warn() {} }, performance, setTimeout, clearTimeout, URL });
  vm.runInContext(readFileSync(ROOT + 'src/automix/automix.js', 'utf8'), ctx);
  return window.__viviAutomix;
}
function bufferOf(song) {
  const n = song.loudness20Hz.length * 16, data = new Float32Array(n);
  song.loudness20Hz.forEach((v, w) => data.fill(v, w * 16, w * 16 + 16));
  return { duration: song.decodedSec, sampleRate: 320, numberOfChannels: 1, length: n, getChannelData: () => data };
}
// the pair planned the way automix_fixtures.mjs does, with the worker's fields from one side's analysis
const WORKER_FIELDS = ['bpm', 'beatIntervalSec', 'firstDownbeatSec', 'gridConfidence', 'camelot', 'keyName', 'keyConfidence', 'energy', 'energyCurve', 'introEndSec', 'outroStartSec', 'tailGrid', 'headBeats', 'tailBeats', 'vocals'];
function planWith(pair, side, version) {
  const A = loadAutomix(version);
  const [a, b] = pair.songs.map((s) => ({ ...s, analysis: { ...s.analysis, ...Object.fromEntries(WORKER_FIELDS.filter((k) => k in side[s.id]).map((k) => [k, side[s.id][k]])) } }));
  const pos = Math.max(30, a.analysis.durationSec - 95), earliest = pos + 4.5;
  const blend = A.plan({ fromId: a.id, toId: b.id, from: a.analysis, to: b.analysis, durationSec: a.analysis.durationSec, pos, earliest });
  const cur = A.asOutgoing(a.analysis);
  const loop = A.gridOk(cur) && A.gridOk(b.analysis) ? A.planLoopMix(cur, bufferOf(a), b.analysis, bufferOf(b), pos + A.LOOP.LOOP_SETUP_SEC, { out: a.sung, in: b.sung }) : { none: 'beat grid too weak' };
  const pick = A.loopOrBlend(blend, loop);
  const plays = pick.loop ? 'loop' : blend.style;
  const points = pick.loop ? [loop.out.loop[0], loop.in.loop[0]] : [blend.mixOutTrackTime, blend.mixInTrackTime];
  const beat = pick.loop ? Math.max(loop.out.beatSec, loop.in.beatSec) : blend.beatSec || 60 / (blend.bpm || 120);
  return { plays, points, beat, why: pick.why || null };
}
function layer2(pair, A, B, version) {
  const x = planWith(pair, A, version), y = planWith(pair, B, version);
  const off = x.points.map((p, i) => Math.abs(p - y.points[i]));
  const same = x.plays === y.plays && off.every((d) => d <= RULE.mixPointBeats * Math.max(x.beat, y.beat));
  if (same) return ['ok', `${x.plays}, mix points ${off.map((d) => (d * 1000).toFixed(0)).join(' / ')} ms apart`];
  // a choice that sits on a threshold: the loop-or-blend margin (LOOP_MARGIN) is the one readable from the plan here
  const margin = (why) => { const m = /loop ([\d.]+) vs blend ([\d.]+)/.exec(why || ''); return m ? +m[2] - +m[1] : null; };
  const t = SPEC.thresholds.find((h) => h.name === 'LOOP_MARGIN').value;
  const near = [margin(x.why), margin(y.why)].some((d) => d != null && Math.abs(d - t) <= RULE.thresholdBand * Math.max(Math.abs(t), 0.1));
  const text = `${x.plays} / ${y.plays}, mix points ${off.map((d) => d.toFixed(3)).join(' / ')} s apart (${x.why || '-'} | ${y.why || '-'})`;
  return [near ? 'threshold case' : 'DIFF', text + (near ? `: blend minus loop sits within ${RULE.thresholdBand * 100}% of LOOP_MARGIN ${t}` : '')];
}
async function compare(sa, sb) {
  const load = (s) => Object.fromEntries(readdirSync(`${CACHE}/${s}`).filter((f) => f.endsWith('.json')).map((f) => { const j = JSON.parse(readFileSync(`${CACHE}/${s}/${f}`, 'utf8')); return [j.videoId, j]; }));
  const A = load(sa), B = load(sb);
  let failed = 0;
  console.log(`layer 1: ${sa} against ${sb}, same decoded files`);
  for (const id of realIds()) {
    if (!A[id] || !B[id]) { console.log(`skip ${id}: ${!A[id] ? sa : sb} has no analysis`); continue; }
    const res = layer1(A[id], B[id]), bad = res.some((r) => !r[1]);   // reported, not failed
    console.log(`${bad ? 'DIFF' : 'ok  '} ${id}`);
    for (const [what, ok, text] of res) console.log(`       ${ok ? 'ok  ' : 'DIFF'} ${what}: ${text}`);
  }
  console.log('layer 2: each pair planned on each side\'s analysis');
  for (const f of readdirSync(ROOT + 'spec/automix/pairs').filter((x) => x.endsWith('.json')).sort()) {
    const pair = JSON.parse(readFileSync(ROOT + 'spec/automix/pairs/' + f, 'utf8'));
    if (!pair.songs.every((s) => A[s.id] && B[s.id])) { console.log(`skip ${f}: a song has no analysis on one side`); continue; }
    for (const v of [2, 3]) {
      const [verdict, text] = layer2(pair, A, B, v);
      if (verdict === 'DIFF') failed++;
      console.log(`${verdict === 'ok' ? 'ok  ' : verdict === 'DIFF' ? 'DIFF' : 'THRS'} ${f} v${v}: ${text}`);
    }
  }
  return failed;
}

const failed = args.includes('--real') ? await real()
  : args.includes('--compare') ? await compare(opt('--compare'), args[args.indexOf('--compare') + 2])
    : await synthetic();
process.exit(failed ? 1 : 0);

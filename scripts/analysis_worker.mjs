// The extension's analysis worker (src/vendor/automix/analysis.worker.js with its .onnx files) run in
// node, fed the way host.js analyzeSong feeds it. Shared by analysis_cases.mjs and spotify_bench.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VENDOR = ROOT + 'src/vendor/automix/';

// host.js's constants: what the extension hands the worker
export const ANALYSIS_SR = 44100, BEAT_SR = 22050, BEAT_WINDOW_SEC = 59, VOCAL_WINDOW_SEC = (958 * 1024) / 44100;
// songs over 8 minutes aren't analysed (versions.md "Analysis length"); read from both files so the cases can't drift
export const ANALYSIS_MAX_SEC = (() => {
  const of = (f) => Number(/const ANALYSIS_MAX_SEC = (\d+)/.exec(readFileSync(ROOT + f, 'utf8'))?.[1]);
  const a = of('src/automix/automix.js'), h = of('src/automix/host.js');
  if (!(a > 0) || a !== h) throw new Error(`ANALYSIS_MAX_SEC: automix.js ${a}, host.js ${h}`);
  return a;
})();

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
export async function analyse(key, left, right, mono22) {
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
  const m = w.out.splice(w.out.findIndex((x) => x.fileKey === key), 1)[0];   // (taken out: a long run keeps no results)
  if (m.type !== 'result') throw new Error(key + ': ' + (m.message || m.type));
  return { durationSec: sec, ...m.result };
}

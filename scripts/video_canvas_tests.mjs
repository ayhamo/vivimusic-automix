// Tests for src/plus/video-canvas-page.js: the phone's VideoCanvasTest and ClipJudgeTest
// fixtures (same numbers), plus a remux round trip on a synthetic fragmented MP4.
//
//   node scripts/video_canvas_tests.mjs        (exit 1 on a failure)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../src/plus/video-canvas-page.js');
const V = globalThis.__viviVideoCanvasCore;

let failed = 0, n = 0;
const check = (name, ok, info = '') => {
  n++;
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : info);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ───────────── VideoCanvasTest ─────────────
/** 100 markers over [dur] s, flat at 0.2 with a bump at [peakAt]. */
function curve(dur, peakAt) {
  const k = 100, step = dur / k, h = new Array(k * 3);
  for (let i = 0; i < k; i++) {
    const t = i * step;
    h[i * 3] = t;
    h[i * 3 + 1] = step;
    h[i * 3 + 2] = Math.abs(t - peakAt) < 15 ? 1 - Math.abs(t - peakAt) / 30 : 0.2;
  }
  return h;
}
{
  const s = V.partStart(curve(200, 120), 200);
  check('the part starts where the most-replayed rise starts', s > 95 && s < 122, s);
  const s2 = V.partStart(curve(200, 5), 200);
  check('a peak in the first 12 seconds is ignored', s2 >= 12, s2);
  check('without a curve the part is 40% in', near(V.partStart(null, 200), 80, 1e-9) && near(V.partStart(null, 5), 0, 1e-9));
}
{
  const zara = V.artists('Zara Larsson');
  const m = (t, ch) => V.matches('Midnight Sun', zara, t, ch);
  check("the artist's own music video matches", m('Midnight Sun', 'Zara Larsson') === true);
  check('VEVO upload with brackets matches', m('Zara Larsson - Midnight Sun (Official Music Video)', 'ZaraLarssonVEVO') === true);
  check('lyrics upload by someone else is refused', m('Zara Larsson - Midnight Sun (Lyrics)', 'Ghosts We Carry') === false);
  check("lyric video on the artist's channel is refused", m('Midnight Sun (Lyric Video)', 'Zara Larsson') === false);
  check('a cover in the Live Lounge is refused', m('Midnight Sun (Zara Larsson cover) in the Live Lounge', 'BBCRadio1VEVO') === false);
  check("another artist's song is refused", m('Stateside + Zara Larsson', 'PinkPantheress') === false);
  check('"A & B" is two artists', V.artists('Taylor Swift & Ed Sheeran').length === 2);
}
{
  const b = Buffer.alloc(32 + 3 * 12);
  let p = 0;
  const i32 = (v) => { b.writeUInt32BE(v >>> 0, p); p += 4; };
  i32(32 + 3 * 12); i32(0x73696478); i32(0); i32(1); i32(1000); i32(0); i32(0);
  b.writeUInt16BE(0, p); p += 2; b.writeUInt16BE(3, p); p += 2;
  for (let i = 0; i < 3; i++) { i32(100 * (i + 1)); i32(5000); i32(0x90000000); }
  const s = V.parseSidx(new Uint8Array(b), 0);
  // fragments: 0-5 s (100 B), 5-10 s (200 B), 10-15 s (300 B), from byte 1000
  check('sidx gives the fragments covering the part (6+3 s)', JSON.stringify(V.sidxRange(s, 6, 3, 1000)) === JSON.stringify([1100, 1299, 5000000]), JSON.stringify(V.sidxRange(s, 6, 3, 1000)));
  check('sidx gives the fragments covering the part (6+8 s)', JSON.stringify(V.sidxRange(s, 6, 8, 1000)) === JSON.stringify([1100, 1599, 5000000]), JSON.stringify(V.sidxRange(s, 6, 8, 1000)));
}

// ───────────── ClipJudgeTest ─────────────
const { W, H } = V;
function frame(seed, bar) {
  const f = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = y < bar || y >= H - bar ? 5 : 60 + (x * 37 + y * 11 + seed * 53) % 120;
  return f;
}
const flat = (v) => new Array(W * H).fill(v);
{
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push(frame(i, 3));
  const b = V.bars(frames);
  check('letterbox bars are found', near(b[0], 0, 1e-6) && near(b[1], 3 / H, 1e-6) && near(b[3], 3 / H, 1e-6), JSON.stringify(b));
}
{
  const st = [], moving = [];
  for (let i = 0; i < 10; i++) { st.push(frame(0, 0)); moving.push(frame(i, 0)); }
  check('a still upload is still', V.still(st, [0, 0, 0, 0]) === true);
  check('a moving video is not still', V.still(moving, [0, 0, 0, 0]) === false);
}
{
  // 30 fps for 10 s: one shot, a cut at 6 s, another shot
  const frames = [], t = [];
  for (let i = 0; i < 300; i++) { t[i] = Math.trunc(i * 1000 / 30); frames.push(t[i] < 6000 ? flat(80) : flat(180)); }
  const end = V.end(frames, t, 10000);
  check('the loop ends on the last cut in range', end >= 5990 && end <= 6040, 'end ' + end);
}
{
  // black/white every frame at 10 fps for 10 s, no cuts to retreat to
  const frames = [], t = [];
  for (let i = 0; i < 100; i++) { t[i] = i * 100; frames.push(flat(i % 2 === 0 ? 10 : 240)); }
  check('strobing is flashing', V.flashing(frames, t, 10000) === true);
  check('strobing is never shown', V.end(frames, t, 10000) === -1);
}

// ───────────── extra: search walker, heatmap, storyboard, crop ─────────────
{
  const col = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });
  const j = { contents: { a: [{ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: 'abcdefghijk' },
    flexColumns: [col([{ text: 'Midnight Sun' }]), col([{ text: 'Zara Larsson' }, { text: ' • ' }, { text: '3M views' }])],
  } }] } };
  check('search results give id, title, channel', JSON.stringify(V.searchResults(j)) === JSON.stringify([['abcdefghijk', 'Midnight Sun', 'Zara Larsson']]));
  const markers = Array.from({ length: 12 }, (_, i) => ({ startMillis: i * 1000, durationMillis: 1000, intensityScoreNormalized: i / 11 }));
  const h = V.heatmapOf({ frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { macroMarkersListEntity: { markersList: { markerType: 'MARKER_TYPE_HEATMAP', markers } } } }] } } });
  check('heatmap markers flatten to start/duration/intensity', h && h.length === 36 && h[3] === 1 && h[4] === 1 && near(h[35], 1, 1e-9));
  const plan = V.storyboardPlan('https://i.ytimg.com/sb/X/storyboard3_L$L/$N.jpg?sqp=a|48#27#100#10#10#0#default#rs$A|160#90#80#5#5#2000#M$M#rs$B', 160000);
  check('storyboard plan takes the largest level', plan && plan.w === 160 && plan.sheets === 4 && plan.interval === 2000
    && plan.url(2) === 'https://i.ytimg.com/sb/X/storyboard3_L1/M2.jpg?sqp=a&sigh=rs%24B', plan && plan.url(2));
  const cr = V.cropRect(0.5, [0, 0, 0, 0], 1280, 720);
  check('centred square crop of a 16:9 frame', cr.w === 0.5625 && cr.h === 1 && cr.x === 0.2188 && cr.y === 0, JSON.stringify(cr));
  const f = V.pickFormat({ adaptiveFormats: [
    { mimeType: 'video/mp4; codecs="avc1.640028"', url: 'u1', height: 1080, fps: 30, initRange: {}, indexRange: {} },
    { mimeType: 'video/mp4; codecs="avc1.4d401f"', url: 'u2', height: 720, fps: 60, initRange: {}, indexRange: {} },
    { mimeType: 'video/mp4; codecs="avc1.4d401f"', url: 'u3', height: 720, fps: 30, initRange: {}, indexRange: {} },
    { mimeType: 'video/webm; codecs="vp9"', url: 'u4', height: 720, fps: 30, initRange: {}, indexRange: {} },
    { mimeType: 'video/mp4; codecs="avc1.4d4015"', url: 'u5', height: 360, fps: 30, initRange: {}, indexRange: {} },
  ] }, 720);
  check('format: H.264 ≤ 720p, ≤ 30 fps', f && f.url === 'u3', f && f.url);
}

// ───────────── extra: remux round trip ─────────────
{
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const bx = (type, ...parts) => { const body = parts.flat(); return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body]; };
  const fb = (type, ver, flags, ...parts) => bx(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const zeros = (k) => new Array(k).fill(0);
  const avcC = bx('avcC', [1, 0x4d, 0x40, 0x1f, 0xff, 0xe0, 0x00]);
  const avc1 = bx('avc1', zeros(6), [0, 1], zeros(16), [0x05, 0x00, 0x02, 0xd0], zeros(50), avcC);
  const stsd = fb('stsd', 0, 0, u32(1), avc1);
  const moov = bx('moov',
    fb('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), zeros(80)),
    bx('trak', fb('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(60)),
      bx('edts', fb('elst', 0, 0, u32(0))),
      bx('mdia', fb('mdhd', 0, 0, u32(0), u32(0), u32(90000), u32(0), zeros(4)), bx('minf', bx('stbl', stsd)))),
    bx('mvex', fb('mehd', 0, 0, u32(0)), fb('trex', 0, 0, u32(1), u32(1), u32(3000), u32(0), u32(0x10000))));
  const ftyp = bx('ftyp', [...'dash'].map((c) => c.charCodeAt(0)), u32(0));
  const init = [...ftyp, ...moov];
  // one fragment: 6 samples of 3000 ticks (1/30 s), key at 0 and 3, sizes 10..15, cto 3000 each
  const sizes = [10, 11, 12, 13, 14, 15];
  const flagsOf = (i) => (i % 3 === 0 ? 0x02000000 : 0x01010000);
  const rowsOf = sizes.flatMap((s, i) => [...u32(3000), ...u32(s), ...u32(flagsOf(i)), ...u32(3000)]);
  const mk = (off) => bx('moof', fb('mfhd', 0, 0, u32(1)), bx('traf', fb('tfhd', 0, 0x020000, u32(1)), fb('tfdt', 0, 0, u32(900000)),
    fb('trun', 0, 0xf01, u32(6), u32(off), rowsOf)));
  const moofLen = mk(0).length;
  const data = sizes.flatMap((s, i) => new Array(s).fill(i + 1));
  const frag = [...mk(moofLen + 8), ...bx('mdat', data)];
  const u = Uint8Array.from([...init, ...frag]);
  const facts = V.parseInit(u, init.length);
  check('init: timescales, track, avcC, size', facts.mediaTs === 90000 && facts.movieTs === 1000 && facts.trackId === 1 && facts.avcC.length === 7 && facts.width === 1280 && facts.height === 720,
    JSON.stringify({ ...facts, avcC: facts.avcC && facts.avcC.length, ftyp: 0, moov: 0 }));
  const samples = V.parseSamples(u, init.length, u.length, facts);
  check('fragment: 6 samples, key frames at 0 and 3', samples.length === 6 && samples.map((s) => s.sync).join() === 'true,false,false,true,false,false' && samples[0].dts === 900000 && u[samples[5].at] === 6);
  // pts = dts + 3000: start 10.15 s -> key frame sample 3 (10.1333 s); end 10.2 s -> samples 3 and 4
  const picked = V.selectSamples(samples, 10.15 * 90000, 10.2 * 90000);
  check('selection starts on the key frame at or before the start', picked.length >= 1 && picked[0] === samples[3], picked.map((s) => s.pts).join());
  const out = V.buildClip(u, facts, picked);
  const o = out.bytes;
  const top = V.readBoxes(o, 0, o.length).map((b) => b.type).join();
  check('clip boxes: ftyp, moov, moof, mdat (no sidx)', top === 'ftyp,moov,moof,mdat', top);
  const re = V.parseInit(o, V.readBoxes(o, 0, o.length)[1].end);
  const moovOut = V.readBoxes(o, 0, o.length)[1];
  const hasEdts = V.readBoxes(o, moovOut.start + 8, moovOut.end).some((b) => b.type === 'trak' && V.readBoxes(o, b.start + 8, b.end).some((k) => k.type === 'edts'));
  const outSamples = V.parseSamples(o, moovOut.end, o.length, re);
  check('clip: tfdt 0, key frame first, composition from 0, bytes kept',
    outSamples.length === picked.length && outSamples[0].dts === 0 && outSamples[0].pts === 0 && outSamples[0].sync && u[picked[0].at] === o[outSamples[0].at],
    JSON.stringify(outSamples.map((s) => [s.dts, s.pts, s.size])));
  const mvhd = V.readBoxes(o, moovOut.start + 8, moovOut.end).find((b) => b.type === 'mvhd');
  const mvDur = new DataView(o.buffer).getUint32(mvhd.start + 24);
  check('clip: edts dropped, mvhd duration = clip length', !hasEdts && mvDur === Math.round(picked.length * 3000 * 1000 / 90000) && near(out.fromSec, 900000 / 90000 + 3 * 3000 / 90000 + 3000 / 90000, 1e-9),
    JSON.stringify({ hasEdts, mvDur, fromSec: out.fromSec, lenSec: out.lenSec }));
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);

// Tests for src/addons/stream-assemble.js and its use in bg-addons.js FETCH: HLS and DASH rows put
// together into one file the page decodes (spec/addons/protocol.md §8.1.5). A fake fetch; no network.
//
//   node scripts/addon_stream_tests.mjs        (exit 1 on a failure)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SA = require('../src/addons/stream-assemble.js');
const FC = require('../src/addons/file-cache.js');
const A = require('../src/addons/bg-addons.js');

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const u8 = (...a) => new Uint8Array(a.flat());
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const bytesOf = (b) => [...new Uint8Array(b)];
const BASE = 'https://addon.example/TOKEN';

// a fake server: url -> { body, status, type, redirect, ignoreRange, hang }; logs each request
function server(routes) {
  const log = [];
  let open = 0, maxOpen = 0;
  const fetch = async (url, opt = {}) => {
    log.push({ url, range: opt.headers?.Range ?? null, headers: opt.headers, credentials: opt.credentials });
    open++; maxOpen = Math.max(maxOpen, open);
    try {
      const r = routes[url];
      if (r?.hang) await new Promise((res, rej) => opt.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      await new Promise((res) => setTimeout(res, 2));
      if (!r) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      let body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : new Uint8Array(r.body);
      let status = r.status ?? 200;
      const m = opt.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
      let range = null;
      if (m && !r.ignoreRange) {
        // wrongStart: the part from another place than asked (its Content-Range says so); short: a byte less, no Content-Range
        const from = r.wrongStart ? 0 : Number(m[1]), to = Number(m[2]) - (r.wrongStart ? Number(m[1]) : 0) - (r.short ? 1 : 0);
        const total = body.length;
        body = body.slice(from, to + 1); status = 206;
        if (!r.short) range = `bytes ${from}-${to}/${total}`;
      }
      const hdr = { 'content-type': r.type ?? null, 'content-range': range };
      return { ok: status < 400, status, url: r.redirect ?? url, headers: { get: (h) => hdr[h.toLowerCase()] ?? null }, arrayBuffer: async () => body.slice().buffer };
    } finally { open--; }
  };
  return { fetch, log, max: () => maxOpen };
}
const run = (routes, stream, opt = {}) => { const s = server(routes); return SA.assemble({ headers: { 'X-Token': 'H' }, ...stream }, { base: BASE, fetch: s.fetch, ...opt }).then((a) => ({ a, s })); };

// ---- HLS, fMP4 ----
const INIT = u8(0, 0, 0, 16, ascii('ftypiso6'), 0, 0, 0, 0);
const SEG = (n) => u8(0, 0, 0, 12, ascii('moof'), n, n, n, n);
{
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nlow/index.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="ec-3"\natmos/index.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\nhigh/index.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.m4s\n#EXTINF:4,\nseg1.m4s\n#EXTINF:2,\n../high/seg2.m4s\n#EXT-X-ENDLIST\n';
  const { a, s } = await run({
    'https://cdn.example/song/master.m3u8': { body: master },
    'https://cdn.example/song/high/index.m3u8': { body: media },
    'https://cdn.example/song/high/init.mp4': { body: INIT },
    'https://cdn.example/song/high/seg0.m4s': { body: SEG(1) },
    'https://cdn.example/song/high/seg1.m4s': { body: SEG(2) },
    'https://cdn.example/song/high/seg2.m4s': { body: SEG(3) },
  }, { transport: 'hls', url: 'https://cdn.example/song/master.m3u8' });
  check('HLS fMP4: the best AAC variant (Dolby passed over), init then the segments in order, joined', [a.mime, bytesOf(a.bytes)], ['audio/mp4', [...INIT, ...SEG(1), ...SEG(2), ...SEG(3)]]);
  check('HLS: every request with the stream\'s headers and no credentials', s.log.every((l) => l.headers['X-Token'] === 'H' && l.credentials === 'omit'), true);
  check('HLS: the low and the Dolby variant never asked', s.log.some((l) => /low|atmos/.test(l.url)), false);
}
{
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=NO,URI="a/alt.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,URI="a/main.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"\nvideo.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns.m4s\n#EXT-X-ENDLIST\n';
  const { a, s } = await run({
    'https://cdn.example/m.m3u8': { body: master }, 'https://cdn.example/a/main.m3u8': { body: media },
    'https://cdn.example/a/init.mp4': { body: INIT }, 'https://cdn.example/a/s.m4s': { body: SEG(7) },
  }, { transport: 'hls', url: 'https://cdn.example/m.m3u8' });
  check('HLS: an audio rendition (the group\'s default) over the video variant', [a.mime, bytesOf(a.bytes).length, s.log.some((l) => /video|alt/.test(l.url))], ['audio/mp4', INIT.length + 12, false]);
}

// ---- HLS, MPEG-TS: the ADTS stream out of the TS ----
function adtsFrame(n, len = 300) {
  const f = new Uint8Array(len);
  f.set([0xff, 0xf1, 0x50, 0x80 | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
  for (let i = 7; i < len; i++) f[i] = (i * 7 + n) & 0xff;
  return f;
}
function tsPacket(pid, pusi, payload, cc) {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47; p[1] = (pusi ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff;
  const room = 184;
  if (payload.length >= room) { p[3] = 0x10 | (cc & 15); p.set(payload.subarray(0, room), 4); return p; }
  // adaptation field stuffing so the payload ends the packet
  const af = room - payload.length - 1;
  p[3] = 0x30 | (cc & 15); p[4] = af;
  if (af > 0) p[5] = 0x00;
  p.set(payload, 5 + af);
  return p;
}
function section(tableId, body) {   // with a CRC of zeros (not checked)
  const len = body.length + 5 + 4;
  return u8(0, tableId, 0xb0 | (len >> 8), len & 0xff, 0, 1, 0xc1, 0, 0, ...body, 0, 0, 0, 0);
}
function tsFile(frames, { streamType = 0x0f, pid = 0x101 } = {}) {
  const out = [];
  const pat = section(0x00, [0, 1, 0xe0 | (0x1000 >> 8), 0x1000 & 0xff]);
  const pmt = section(0x02, [0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0, streamType, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0]);
  out.push(tsPacket(0, true, pat, 0), tsPacket(0x1000, true, pmt, 0));
  let cc = 0;
  for (const f of frames) {
    const pes = u8(0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, ...f);   // with a PTS
    for (let o = 0; o < pes.length; o += 184) out.push(tsPacket(pid, o === 0, pes.subarray(o, o + 184), cc++));
  }
  return u8(...out.map((p) => [...p]));
}
{
  const f = [adtsFrame(1), adtsFrame(2, 500), adtsFrame(3, 90), adtsFrame(4)];
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nhttps://seg.example/a.ts\n#EXTINF:4,\nhttps://seg.example/b.ts\n#EXT-X-ENDLIST\n';
  const { a } = await run({
    'https://cdn.example/t.m3u8': { body: media },
    'https://seg.example/a.ts': { body: tsFile(f.slice(0, 2)) },
    'https://seg.example/b.ts': { body: tsFile(f.slice(2)) },
  }, { transport: 'hls', url: 'https://cdn.example/t.m3u8' });
  const want = f.flatMap((x) => [...x]);
  check('HLS TS: exactly the ADTS bytes, as audio/aac (METHOD=NONE is no key)', [a.mime, bytesOf(a.bytes).length, JSON.stringify(bytesOf(a.bytes)) === JSON.stringify(want)], ['audio/aac', want.length, true]);
  const mp3 = SA.demuxTs([tsFile([u8(0xff, 0xfb, 0x90, 0x64, 1, 2, 3)], { streamType: 0x03 })]);
  check('TS: MPEG audio comes out as audio/mpeg', [mp3.mime, bytesOf(mp3.bytes)], ['audio/mpeg', [0xff, 0xfb, 0x90, 0x64, 1, 2, 3]]);
  const ac3 = await run({ 'https://cdn.example/t.m3u8': { body: media }, 'https://seg.example/a.ts': { body: tsFile([u8(0x0b, 0x77, 1)], { streamType: 0x81 }) }, 'https://seg.example/b.ts': { body: tsFile([u8(0x0b, 0x77, 2)], { streamType: 0x81 }) } }, { transport: 'hls', url: 'https://cdn.example/t.m3u8' });
  check('TS: AC-3 audio refused', [ac3.a.none, ac3.a.refused], ['the stream\'s audio is a codec it can\'t play', true]);
  const sa = await run({ 'https://cdn.example/t.m3u8': { body: media }, 'https://seg.example/a.ts': { body: tsFile([adtsFrame(1)], { streamType: 0xcf }) }, 'https://seg.example/b.ts': { body: tsFile([adtsFrame(1)], { streamType: 0xcf }) } }, { transport: 'hls', url: 'https://cdn.example/t.m3u8' });
  check('TS: SAMPLE-AES audio refused as encrypted', [sa.a.none, sa.a.refused], ['encrypted (SAMPLE-AES)', true]);
}
{
  // packed audio: each segment an ID3 tag (its timestamp), then ADTS frames
  const id3 = u8(ascii('ID3'), 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5);
  const media = '#EXTM3U\n#EXTINF:4,\n0.aac\n#EXTINF:4,\n1.aac\n#EXT-X-ENDLIST\n';
  const { a } = await run({ 'https://cdn.example/p/i.m3u8': { body: media }, 'https://cdn.example/p/0.aac': { body: u8(...id3, ...adtsFrame(1, 20)) }, 'https://cdn.example/p/1.aac': { body: u8(...id3, ...adtsFrame(2, 20)) } }, { transport: 'hls', url: 'https://cdn.example/p/i.m3u8' });
  check('HLS packed AAC: the frames without their ID3 tags', [a.mime, bytesOf(a.bytes)], ['audio/aac', [...adtsFrame(1, 20), ...adtsFrame(2, 20)]]);
}
{
  // byte ranges in one file; a server that ignores Range sends it whole and the range is cut from it
  const file = u8(...INIT, ...SEG(1), ...SEG(2));
  const media = `#EXTM3U\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="${INIT.length}@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:12@${INIT.length}\nall.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:12\nall.mp4\n#EXT-X-ENDLIST\n`;
  for (const ignoreRange of [false, true]) {
    const { a, s } = await run({ 'https://cdn.example/r.m3u8': { body: media }, 'https://cdn.example/all.mp4': { body: file, ignoreRange } }, { transport: 'hls', url: 'https://cdn.example/r.m3u8' });
    check(`HLS byte ranges${ignoreRange ? ' (Range ignored by the server)' : ''}: the ranges asked, the file rebuilt`, [s.log.slice(1).map((l) => l.range), JSON.stringify(bytesOf(a.bytes)) === JSON.stringify(bytesOf(file.buffer))], [['bytes=0-15', 'bytes=16-27', 'bytes=28-39'], true]);
  }
  // (audit 2026-11-26, the phone's B4-01) a part that isn't the range asked is not joined: another start (its
  // Content-Range), a byte short (no Content-Range shown), or a whole file too short to hold the range
  const wrong = await run({ 'https://cdn.example/r.m3u8': { body: media }, 'https://cdn.example/all.mp4': { body: file, wrongStart: true } }, { transport: 'hls', url: 'https://cdn.example/r.m3u8' });
  const short = await run({ 'https://cdn.example/r.m3u8': { body: media }, 'https://cdn.example/all.mp4': { body: file, short: true } }, { transport: 'hls', url: 'https://cdn.example/r.m3u8' });
  const cut = await run({ 'https://cdn.example/r.m3u8': { body: media }, 'https://cdn.example/all.mp4': { body: file.slice(0, 30), ignoreRange: true } }, { transport: 'hls', url: 'https://cdn.example/r.m3u8' });
  check('HLS byte ranges: another range than asked, or a file too short for it, is not joined', [wrong.a.none, wrong.a.bytes, short.a.none, cut.a.none],
    ['a segment answered another range than the one asked', undefined, 'a segment answered another range than the one asked', 'a segment is shorter than its range']);
}
{
  const seg = { 'https://cdn.example/s0.ts': { body: tsFile([adtsFrame(1)]) } };
  const enc = await run({ 'https://cdn.example/e.m3u8': { body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns0.ts\n#EXT-X-ENDLIST\n' }, ...seg }, { transport: 'hls', url: 'https://cdn.example/e.m3u8' });
  check('HLS: an AES-128 key refused, no segment asked', [enc.a.none, enc.a.refused, enc.s.log.length], ['encrypted (HLS key)', true, 1]);
  const sess = await run({ 'https://cdn.example/m.m3u8': { body: '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXT-X-STREAM-INF:BANDWIDTH=1\ne.m3u8\n' } }, { transport: 'hls', url: 'https://cdn.example/m.m3u8' });
  check('HLS: a session key refused', [sess.a.none, sess.a.refused], ['encrypted (HLS key)', true]);
  const live = await run({ 'https://cdn.example/l.m3u8': { body: '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4,\ns0.ts\n' }, ...seg }, { transport: 'hls', url: 'https://cdn.example/l.m3u8' });
  check('HLS: a live playlist (no ENDLIST) refused', [live.a.none, live.a.refused], ['a live stream (no end)', true]);
  const dolby = await run({ 'https://cdn.example/m.m3u8': { body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="ec-3"\ne.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,CODECS="mp4a.a6"\nf.m3u8\n' } }, { transport: 'hls', url: 'https://cdn.example/m.m3u8' });
  check('HLS: Dolby only refused', [dolby.a.none, dolby.a.refused], ['Dolby audio only', true]);
  const two = await run({ 'https://cdn.example/x.m3u8': { body: '#EXTM3U\n#EXT-X-MAP:URI="i1.mp4"\n#EXTINF:4,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="i2.mp4"\n#EXTINF:4,\nb.m4s\n#EXT-X-ENDLIST\n' } }, { transport: 'hls', url: 'https://cdn.example/x.m3u8' });
  check('HLS: two init segments refused (one file can\'t hold both)', [two.a.none, two.a.refused], ['more than one init segment', true]);
  const html = await run({ 'https://cdn.example/x.m3u8': { body: '<html>no</html>' } }, { transport: 'hls', url: 'https://cdn.example/x.m3u8' });
  check('HLS: not a playlist refused', [html.a.none, html.a.refused], ['the playlist is not an HLS playlist', true]);
  const odd = await run({ 'https://cdn.example/x.m3u8': { body: '#EXTM3U\n#EXTINF:4,\na.bin\n#EXT-X-ENDLIST\n' }, 'https://cdn.example/a.bin': { body: u8(1, 2, 3, 4, 5, 6, 7, 8) } }, { transport: 'hls', url: 'https://cdn.example/x.m3u8' });
  check('HLS: segments of an unknown kind refused', [odd.a.none, odd.a.refused], ['segments of a kind it can\'t read', true]);
}

// ---- DASH ----
const mpd = (inner, root = 'type="static" mediaPresentationDuration="PT10S"') => `<?xml version="1.0" encoding="utf-8"?>\n<!-- made by a test -->\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${root}><BaseURL>https://cdn.example/d/</BaseURL><Period id="0">${inner}</Period></MPD>`;
{
  const xml = mpd(`
    <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="9000000" codecs="avc1.640028"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number%03d$-$Bandwidth$.m4s" startNumber="5">
        <SegmentTimeline><S t="0" d="4000" r="1"/><S d="2000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="lo" bandwidth="128000" codecs="mp4a.40.2"/>
      <Representation id="hi" bandwidth="320000" codecs="mp4a.40.2"/>
      <Representation id="atmos" bandwidth="768000" codecs="ec-3"/>
    </AdaptationSet>`);
  const routes = { 'https://cdn.example/m.mpd': { body: xml }, 'https://cdn.example/d/hi/init.mp4': { body: INIT } };
  ['005', '006', '007'].forEach((n, i) => { routes[`https://cdn.example/d/hi/${n}-320000.m4s`] = { body: SEG(i + 1) }; });
  const { a, s } = await run(routes, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH SegmentTemplate + Timeline: the best non-Dolby audio, $Number%03d$ from startNumber, $Bandwidth$, joined', [a.mime, bytesOf(a.bytes)], ['audio/mp4', [...INIT, ...SEG(1), ...SEG(2), ...SEG(3)]]);
  check('DASH: the video set never asked', s.log.some((l) => /\/v\//.test(l.url)), false);
  const time = mpd(`<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1" codecs="flac">
      <SegmentTemplate timescale="100" initialization="i.mp4" media="t$Time$.m4s"><SegmentTimeline><S t="50" d="400" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>`);
  const r2 = { 'https://cdn.example/m.mpd': { body: time }, 'https://cdn.example/d/i.mp4': { body: INIT } };
  [50, 450, 850].forEach((t, i) => { r2[`https://cdn.example/d/t${t}.m4s`] = { body: SEG(i) }; });
  const t2 = await run(r2, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH $Time$ with r="-1": segments until the period ends (10 s)', [t2.a.mime, t2.s.log.slice(2).map((l) => l.url.split('/').pop())], ['audio/mp4', ['t50.m4s', 't450.m4s', 't850.m4s']]);
  const dur = mpd(`<AdaptationSet mimeType="audio/webm"><Representation id="o" bandwidth="1" codecs="opus">
      <SegmentTemplate timescale="1000" duration="4000" initialization="o/init.webm" media="o/$Number$.webm"/></Representation></AdaptationSet>`);
  const ebml = u8(0x1a, 0x45, 0xdf, 0xa3, 1, 2);
  const r3 = { 'https://cdn.example/m.mpd': { body: dur }, 'https://cdn.example/d/o/init.webm': { body: ebml } };
  [1, 2, 3].forEach((n) => { r3[`https://cdn.example/d/o/${n}.webm`] = { body: u8(0x1f, 0x43, 0xb6, 0x75, n) }; });
  const t3 = await run(r3, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH SegmentTemplate by duration: ceil(10 s / 4 s) = 3 segments, WebM', [t3.a.mime, bytesOf(t3.a.bytes).length], ['audio/webm', ebml.length + 15]);
}
{
  const list = mpd(`<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"><BaseURL>list/</BaseURL>
      <SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s?x=1&amp;y=2"/></SegmentList></Representation></AdaptationSet>`);
  const { a, s } = await run({ 'https://cdn.example/m.mpd': { body: list }, 'https://cdn.example/d/list/init.mp4': { body: INIT }, 'https://cdn.example/d/list/a.m4s': { body: SEG(1) }, 'https://cdn.example/d/list/b.m4s?x=1&y=2': { body: SEG(2) } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH SegmentList: nested BaseURL, an &amp; read as &', [a.mime, bytesOf(a.bytes), s.log.at(-1).url], ['audio/mp4', [...INIT, ...SEG(1), ...SEG(2)], 'https://cdn.example/d/list/b.m4s?x=1&y=2']);
  const ranged = mpd(`<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"><BaseURL>one.mp4</BaseURL>
      <SegmentList><Initialization range="0-15"/><SegmentURL mediaRange="16-27"/></SegmentList></Representation></AdaptationSet>`);
  const r = await run({ 'https://cdn.example/m.mpd': { body: ranged }, 'https://cdn.example/d/one.mp4': { body: u8(...INIT, ...SEG(4)) } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH SegmentList by ranges of one file', [r.s.log.slice(1).map((l) => l.range), bytesOf(r.a.bytes)], [['bytes=0-15', 'bytes=16-27'], [...INIT, ...SEG(4)]]);
  const single = mpd(`<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1" codecs="mp4a.40.2"><BaseURL>song.m4a</BaseURL><SegmentBase indexRange="16-40"><Initialization range="0-15"/></SegmentBase></Representation></AdaptationSet>`);
  const sb = await run({ 'https://cdn.example/m.mpd': { body: single }, 'https://cdn.example/d/song.m4a': { body: u8(...INIT, ...SEG(9)) } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH SegmentBase: the one file, whole', [sb.s.log.length, sb.s.log[1].range, bytesOf(sb.a.bytes)], [2, null, [...INIT, ...SEG(9)]]);
}
{
  const prot = mpd(`<AdaptationSet mimeType="audio/mp4"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="a" bandwidth="1"><BaseURL>x.mp4</BaseURL></Representation></AdaptationSet>`);
  const p = await run({ 'https://cdn.example/m.mpd': { body: prot } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH: ContentProtection refused, nothing more asked', [p.a.none, p.a.refused, p.s.log.length], ['encrypted (ContentProtection)', true, 1]);
  const dyn = await run({ 'https://cdn.example/m.mpd': { body: mpd('<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet>', 'type="dynamic"') } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH: a dynamic (live) MPD refused', [dyn.a.none, dyn.a.refused], ['a live stream (dynamic MPD)', true]);
  const dol = await run({ 'https://cdn.example/m.mpd': { body: mpd('<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1" codecs="ec-3"/></AdaptationSet>') } }, { transport: 'dash', url: 'https://cdn.example/m.mpd' });
  check('DASH: Dolby only refused', [dol.a.none, dol.a.refused], ['Dolby audio only', true]);
}

// ---- limits: the byte cap, the redirect guard, failures, parallelism, the time limit ----
{
  const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' + Array.from({ length: 12 }, (_, i) => `#EXTINF:4,\ns${i}.m4s\n`).join('') + '#EXT-X-ENDLIST\n';
  const routes = { 'https://cdn.example/c.m3u8': { body: media }, 'https://cdn.example/init.mp4': { body: INIT } };
  for (let i = 0; i < 12; i++) routes[`https://cdn.example/s${i}.m4s`] = { body: SEG(i) };
  const ok = await run(routes, { transport: 'hls', url: 'https://cdn.example/c.m3u8' });
  check('parallel: at most 4 requests at once, the order kept', [ok.s.max() <= 4, ok.s.max() > 1, bytesOf(ok.a.bytes).length], [true, true, INIT.length + 12 * 12]);
  const cap = await run(routes, { transport: 'hls', url: 'https://cdn.example/c.m3u8' }, { maxBytes: 100 });
  check('the cap counts every segment: over it, too big (not a refusal)', [cap.a.none, cap.a.refused], ['the file is too big (over 0 MB)', undefined]);
  const r404 = { ...routes }; delete r404['https://cdn.example/s5.m4s'];
  const miss = await run(r404, { transport: 'hls', url: 'https://cdn.example/c.m3u8' });
  check('a missing segment: the download failed (not a refusal)', [miss.a.none, miss.a.refused], ['a segment answered 404', undefined]);
  const red = { ...routes, 'https://cdn.example/s3.m4s': { body: SEG(3), redirect: 'http://cdn.example/s3.m4s' } };
  const rd = await run(red, { transport: 'hls', url: 'https://cdn.example/c.m3u8' });
  check('a segment redirected off https: refused', [rd.a.none, rd.a.refused], ['a segment was redirected: not https', true]);
  const pl = await run({ 'https://cdn.example/c.m3u8': { body: media, redirect: 'https://127.0.0.1/c.m3u8' } }, { transport: 'hls', url: 'https://cdn.example/c.m3u8' });
  check('the playlist redirected to this machine: refused', [pl.a.none, pl.a.refused], ['the playlist was redirected: points at this machine', true]);
  const lk = await run({ 'https://cdn.example/h.m3u8': { body: '#EXTM3U\n#EXTINF:4,\nhttp://cdn.example/a.ts\n#EXT-X-ENDLIST\n' } }, { transport: 'hls', url: 'https://cdn.example/h.m3u8' });
  check('a plain-http segment link: refused before it is asked', [lk.a.none, lk.a.refused, lk.s.log.length], ['a segment link: not https', true, 1]);
  const loc = await run({ 'https://cdn.example/h.m3u8': { body: '#EXTM3U\n#EXTINF:4,\nhttps://localhost/a.ts\n#EXT-X-ENDLIST\n' } }, { transport: 'hls', url: 'https://cdn.example/h.m3u8' });
  check('a segment link to this machine: refused', [loc.a.none, loc.a.refused], ['a segment link: points at this machine', true]);
  const s = server({ 'http://127.0.0.1:9/h.m3u8': { body: '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n' }, 'http://127.0.0.1:9/a.ts': { body: tsFile([adtsFrame(1)]) } });
  const mine = await SA.assemble({ transport: 'hls', url: 'http://127.0.0.1:9/h.m3u8' }, { base: 'http://127.0.0.1:9/addon', fetch: s.fetch });
  check('an addon on this machine may use plain http on it (the tests\' mock server)', mine.mime, 'audio/aac');
  const hang = await run({ 'https://cdn.example/h.m3u8': { body: '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n' }, 'https://cdn.example/a.ts': { hang: true } }, { transport: 'hls', url: 'https://cdn.example/h.m3u8' }, { requestMs: 30 });
  check('a segment past its time limit: the download failed', [hang.a.none, hang.a.refused], ['a segment took too long', undefined]);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  const all = await run({ 'https://cdn.example/h.m3u8': { body: '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n' }, 'https://cdn.example/a.ts': { hang: true } }, { transport: 'hls', url: 'https://cdn.example/h.m3u8' }, { signal: ctl.signal });
  check('the whole download\'s limit (the caller\'s signal) stops it', all.a.none, 'the file took too long');
}

// ---- in the store: FETCH of an HLS row assembles it and keeps nothing in the cache (§8.1.6.1) ----
{
  const fakeStorage = (init = {}) => { const data = JSON.parse(JSON.stringify(init)); return { data, get: async (d) => ({ ...d, ...JSON.parse(JSON.stringify(data)) }), set: async (p) => { Object.assign(data, JSON.parse(JSON.stringify(p))); } }; };
  const m = new Map();
  const cache = { match: async (k) => (m.has(k) ? new Response(m.get(k)) : undefined), put: async (k, r) => { m.set(k, await r.arrayBuffer()); }, delete: async (k) => m.delete(k) };
  const st = fakeStorage({ addonsEnabled: true, addonsList: [{ id: 'idA', base: 'https://a.example/SECRET-A', name: 'A', host: 'a.example' }] });
  const files = FC.create({ open: () => cache, storage: st, maxBytes: async () => 512e6 });
  let transport = 'hls';
  const client = {
    health: () => ({}),
    find: async (song, addons) => ({ found: addons.map((a) => ({ addon: { ...a }, rows: [{ id: 'r1' }] })), tried: [] }),
    open: async (found) => ({ addon: { ...found[0].addon }, row: found[0].rows[0], stream: { url: transport === 'hls' ? 'https://cdn.example/x.m3u8' : 'https://cdn.example/m.mpd', transport, codec: 'aac', headers: { 'X-Token': 'H' } }, tried: [] }),
  };
  const srv = server({
    'https://cdn.example/x.m3u8': { body: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n#EXT-X-ENDLIST\n' },
    'https://cdn.example/init.mp4': { body: INIT }, 'https://cdn.example/a.m4s': { body: SEG(1) },
    'https://cdn.example/m.mpd': { body: mpd('<AdaptationSet mimeType="audio/mp4"><ContentProtection/><Representation id="a" bandwidth="1"/></AdaptationSet>') },
  });
  const S = A.create({ storage: st, client, fetch: srv.fetch, files });
  const f = await S.handle({ type: 'VIVI_ADDONS_FIND', song: { title: 'S', artist: 'X', durationSec: 200 } });
  await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f.ticket });
  const got = await S.handle({ type: 'VIVI_ADDONS_FETCH', ticket: f.ticket });
  await new Promise((r) => setTimeout(r, 10));
  check('FETCH of an HLS row: one fMP4 file, nothing put in the cache', [got.mime, bytesOf(got.bytes), (await files.stats()).files], ['audio/mp4', [...INIT, ...SEG(1)], 0]);
  transport = 'dash';
  const f2 = await S.handle({ type: 'VIVI_ADDONS_FIND', song: { title: 'T', artist: 'X', durationSec: 200 } });
  await S.handle({ type: 'VIVI_ADDONS_OPEN', ticket: f2.ticket });
  const bad = await S.handle({ type: 'VIVI_ADDONS_FETCH', ticket: f2.ticket });
  check('FETCH of a protected DASH row: refused, so the page tries the next row (8.1.4)', [bad.none, bad.refused, bad.bytes], ['encrypted (ContentProtection)', true, undefined]);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

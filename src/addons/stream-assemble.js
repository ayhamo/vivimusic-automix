/* Vivimusic Web+ — addons/stream-assemble.js (background script; node for tests)
 *
 * An HLS or DASH row's audio as ONE file the page can decode (spec/addons/protocol.md §8.1.5):
 * the playlist or manifest is read here, the best audio picked, and its segments fetched in
 * order and joined, so the page's decodeAudioData, the offset fit and the decks get bytes like
 * a progressive file's.
 *
 *   HLS: a master playlist's best audio (an audio rendition, else the best variant, by BANDWIDTH;
 *        Dolby codecs passed over), then its media playlist.
 *        fMP4 segments (#EXT-X-MAP): the init segment and the segments, joined (a fragmented MP4).
 *        MPEG-TS segments: the audio stream taken out of the TS: ADTS AAC (.aac) or MPEG audio (.mp3).
 *        Packed audio segments (ADTS or MP3, an ID3 tag first): joined without their ID3 tags.
 *   DASH: the MPD's best audio Representation (by bandwidth; Dolby passed over), its segments from
 *        SegmentTemplate ($Number$, $Time$, $RepresentationID$, $Bandwidth$, SegmentTimeline),
 *        SegmentList, or a single file (SegmentBase or a BaseURL alone); init and segments joined.
 *
 * Refused (the next row is tried, §8.1.4): encrypted (#EXT-X-KEY or a session key not NONE,
 * SAMPLE-AES streams, ContentProtection), live (no #EXT-X-ENDLIST, an MPD of type dynamic), more
 * than one init segment or Period, Dolby-only audio, a segment of a kind it can't read, and any
 * link (or a redirect) off https or to this machine (client.offLimits; an addon on this machine may).
 *
 *   assemble(stream, { base, fetch, signal, maxBytes, requestMs, parallel })
 *     -> { bytes: ArrayBuffer, mime } or { none, refused? }
 *   No DOM: the MPD is read by a small XML reader (Chrome's service worker has no DOMParser).
 *
 * globalThis.__viviStreamAssemble
 */
(() => {
  'use strict';
  const C = globalThis.__viviAddonClient || (typeof require === 'function' ? require('./client.js') : null);

  const LIST_MAX_BYTES = 4e6;       // a playlist or manifest
  const MAX_SEGMENTS = 20000;
  const REQUEST_MS = 30e3;          // each request (the whole download has the caller's limit)
  const PARALLEL = 4;
  // Dolby (Atmos and its cousins): neither browser's decodeAudioData plays it; mp4a.a5/a6 are AC-3/E-AC-3 too
  const DOLBY = /^(ac-3|ec-3|ac-4|eac3|ac3|mp4a\.a[56])\b/i;
  const VIDEO = /\b(avc\d?|hvc1|hev1|vp0?8|vp0?9|av01|dvh1|dvhe|mp4v)\b/i;

  class Refusal extends Error { constructor(m) { super(m); this.refused = true; } }
  class Failure extends Error {}
  const refuse = (m) => { throw new Refusal(m); };

  // ---- fetching: the stream's headers, no credentials, a time limit each, one byte budget ----
  function fetcher({ base, fetch: doFetch, signal, maxBytes, requestMs = REQUEST_MS, headers = {} }) {
    const budget = { left: maxBytes };
    async function get(url, { range = null, cap = null, what = 'a segment' } = {}) {
      const off = C.offLimits(base, url);
      if (off) refuse(`${what} link: ${off}`);
      if (signal?.aborted) throw new Failure('the file took too long');
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener?.('abort', stop, { once: true });
      const timer = setTimeout(stop, requestMs);
      try {
        const h = { ...headers };
        if (range) h.Range = `bytes=${range[0]}-${range[1]}`;
        let r;
        try { r = await doFetch(url, { headers: h, signal: ctl.signal, credentials: 'omit', cache: 'no-store' }); }
        catch (e) { throw new Failure(ctl.signal.aborted ? (signal?.aborted ? 'the file took too long' : `${what} took too long`) : `${what} failed: ${e?.message || e}`); }
        const roff = C.offLimits(base, r.url || url);
        if (roff) { try { await r.body?.cancel?.(); } catch { /* gone */ } refuse(`${what} was redirected: ${roff}`); }
        if (!r.ok) { try { await r.body?.cancel?.(); } catch { /* gone */ } throw new Failure(`${what} answered ${r.status}`); }
        let bytes;
        try { bytes = await readCapped(r, cap ?? budget); }
        catch (e) { throw new Failure(ctl.signal.aborted ? `${what} took too long` : `${what} failed: ${e?.message || e}`); }
        if (!bytes) throw new Failure(cap != null ? `${what} is too big` : `the file is too big (over ${Math.round(maxBytes / 1e6)} MB)`);
        if (range) {
          const want = range[1] - range[0] + 1;
          if (r.status === 206) {
            // the range asked and nothing else (the phone's B4-01): a part that starts or ends elsewhere (its
            // Content-Range, when the answer shows it) or holds another length would join the wrong bytes
            const cr = String(r.headers?.get?.('content-range') || '').match(/^\s*bytes\s+(\d+)-(\d+)\//i);
            if ((cr && (Number(cr[1]) !== range[0] || Number(cr[2]) !== range[1])) || bytes.byteLength !== want) throw new Failure(`${what} answered another range than the one asked`);
          } else {
            // a server that ignored the Range sent the whole file: the range is cut from it (a file too short to hold it: no)
            if (bytes.byteLength < range[1] + 1) throw new Failure(`${what} is shorter than its range`);
            if (cap == null) budget.left += bytes.byteLength - want;
            bytes = bytes.slice(range[0], range[1] + 1);
          }
        }
        return { bytes, url: r.url || url, type: (r.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase() };
      } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', stop); }
    }
    // cap: a number (its own limit) or the shared budget (counted down as bytes come)
    async function readCapped(r, cap) {
      const shared = typeof cap === 'object';
      const room = () => (shared ? cap.left : cap);
      const take = (n) => { if (shared) cap.left -= n; else cap -= n; };
      if (!r.body?.getReader) {
        const b = r.arrayBuffer ? await r.arrayBuffer() : new TextEncoder().encode(await r.text()).buffer;
        if (b.byteLength > room()) { if (shared) cap.left = -1; return null; }
        take(b.byteLength);
        return b;
      }
      const rd = r.body.getReader(), parts = [];
      let n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (value.byteLength > room()) { try { await rd.cancel(); } catch { /* gone */ } if (shared) cap.left = -1; return null; }
        take(value.byteLength);
        parts.push(value); n += value.byteLength;
      }
      return join(parts, n).buffer;
    }
    const text = async (url, what) => {
      const g = await get(url, { cap: LIST_MAX_BYTES, what });
      return { text: new TextDecoder().decode(g.bytes).replace(/^﻿/, ''), url: g.url };
    };
    return { get, text };
  }

  function join(parts, n = parts.reduce((s, p) => s + p.byteLength, 0)) {
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { const u = p instanceof Uint8Array ? p : new Uint8Array(p); out.set(u, o); o += u.byteLength; }
    return out;
  }
  const resolve = (rel, base) => new URL(String(rel).trim(), base).href;

  // segments in order, `parallel` at a time -> [Uint8Array]
  async function fetchAll(F, list, parallel) {
    if (list.length > MAX_SEGMENTS) refuse(`too many segments (${list.length})`);
    const out = new Array(list.length);
    let next = 0, err = null;
    const lane = async () => {
      while (!err && next < list.length) {
        const i = next++;
        try { out[i] = new Uint8Array((await F.get(list[i].url, { range: list[i].range })).bytes); }
        catch (e) { err = err || e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, lane));
    if (err) throw err;
    return out;
  }

  // ---- HLS ----
  function attrs(s) {
    const o = {};
    for (const m of String(s).matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) o[m[1]] = m[3] ?? m[2];
    return o;
  }
  const lines = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const encrypted = (a) => a.METHOD && a.METHOD.toUpperCase() !== 'NONE';
  // a codecs list whose audio is all Dolby (no list: not known, so not passed over)
  const audioCodecs = (codecs) => String(codecs || '').split(',').map((c) => c.trim()).filter((c) => c && !VIDEO.test(c));
  const dolbyOnly = (codecs) => { const a = audioCodecs(codecs); return a.length > 0 && a.every((c) => DOLBY.test(c)); };

  function readMaster(t, url) {
    const L = lines(t), variants = [], media = [];
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      if (l.startsWith('#EXT-X-SESSION-KEY:') && encrypted(attrs(l.slice(19)))) refuse('encrypted (HLS key)');
      if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(l.slice(13));
        if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) media.push({ group: a['GROUP-ID'], uri: resolve(a.URI, url), def: (a.DEFAULT || '').toUpperCase() === 'YES', codecs: a.CODECS || '' });
      }
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18));
        const uri = L.slice(i + 1).find((x) => !x.startsWith('#'));
        if (uri) variants.push({ bw: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH']) || 0, codecs: a.CODECS || '', audio: a.AUDIO || null, uri: resolve(uri, url) });
      }
    }
    // an audio rendition of the best group its variants use (Dolby-only variants passed over)
    const groups = new Map();
    for (const v of variants) {
      if (!v.audio || dolbyOnly(v.codecs)) continue;
      if (!media.some((m) => m.group === v.audio)) continue;
      groups.set(v.audio, Math.max(groups.get(v.audio) ?? -1, v.bw));
    }
    const rendition = (g) => { const ms = media.filter((m) => m.group === g && !dolbyOnly(m.codecs)); return ms.find((m) => m.def) || ms[0]; };
    const bestGroup = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).find((g) => rendition(g));
    if (bestGroup) return rendition(bestGroup).uri;
    if (!variants.length && media.length) { const m = media.find((x) => !dolbyOnly(x.codecs)); if (m) return m.uri; }
    const ok = variants.filter((v) => !dolbyOnly(v.codecs));
    if (!ok.length) refuse(variants.length || media.length ? 'Dolby audio only' : 'no audio in the playlist');
    // audio-only variants first (no picture to download), then the higher bandwidth
    ok.sort((a, b) => (VIDEO.test(a.codecs) - VIDEO.test(b.codecs)) || b.bw - a.bw);
    return ok[0].uri;
  }

  function readMedia(t, url) {
    const L = lines(t), segs = [];
    let map = null, maps = 0, nextRange = null, ended = false, lastEnd = new Map();
    const byterange = (v, uri) => {
      const m = String(v).match(/^(\d+)(?:@(\d+))?$/);
      if (!m) return null;
      const len = Number(m[1]), at = m[2] != null ? Number(m[2]) : (lastEnd.get(uri) ?? 0);
      lastEnd.set(uri, at + len);
      return [at, at + len - 1];
    };
    for (const l of L) {
      if (l.startsWith('#EXT-X-STREAM-INF')) refuse('a playlist of playlists inside a playlist');
      else if (l.startsWith('#EXT-X-KEY:')) { if (encrypted(attrs(l.slice(11)))) refuse('encrypted (HLS key)'); }
      else if (l.startsWith('#EXT-X-MAP:')) {
        const a = attrs(l.slice(11));
        const uri = resolve(a.URI, url);
        const m = { url: uri, range: a.BYTERANGE ? byterange(a.BYTERANGE, uri) : null };
        if (!map || map.url !== m.url || String(map.range) !== String(m.range)) { maps++; map = m; }
        if (maps > 1) refuse('more than one init segment');
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) nextRange = l.slice(17);
      else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
      else if (!l.startsWith('#')) {
        const uri = resolve(l, url);
        segs.push({ url: uri, range: nextRange != null ? byterange(nextRange, uri) : null });
        nextRange = null;
      }
    }
    if (!ended) refuse('a live stream (no end)');
    if (!segs.length) refuse('no segments');
    return { init: map, segs };
  }

  async function hls(F, url, parallel) {
    let { text: t, url: at } = await F.text(url, 'the playlist');
    if (!t.trimStart().startsWith('#EXTM3U')) refuse('the playlist is not an HLS playlist');
    if (/^#EXT-X-STREAM-INF/m.test(t) || (/^#EXT-X-MEDIA:/m.test(t) && !/^#EXTINF/m.test(t))) {
      const pick = readMaster(t, at);
      ({ text: t, url: at } = await F.text(pick, 'the playlist'));
      if (!t.trimStart().startsWith('#EXTM3U')) refuse('the media playlist is not an HLS playlist');
    }
    const { init, segs } = readMedia(t, at);
    const [initBytes] = init ? await fetchAll(F, [init], 1) : [null];
    const parts = await fetchAll(F, segs, parallel);
    return finish(initBytes, parts);
  }

  // ---- the joined bytes, by what the segments are ----
  const isTs = (b) => b.byteLength >= 188 && b[0] === 0x47 && (b.byteLength < 376 || b[188] === 0x47);
  const isFmp4 = (b) => b.byteLength >= 8 && /^(ftyp|styp|moov|moof|sidx|emsg|prft|free)$/.test(String.fromCharCode(b[4], b[5], b[6], b[7]));
  const isEbml = (b) => b.byteLength >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  function id3Len(b, o = 0) {
    if (b.byteLength - o < 10 || b[o] !== 0x49 || b[o + 1] !== 0x44 || b[o + 2] !== 0x33) return 0;
    const size = ((b[o + 6] & 0x7f) << 21) | ((b[o + 7] & 0x7f) << 14) | ((b[o + 8] & 0x7f) << 7) | (b[o + 9] & 0x7f);
    return 10 + size + (b[o + 5] & 0x10 ? 10 : 0);
  }
  const adts = (b, o = 0) => b[o] === 0xff && (b[o + 1] & 0xf6) === 0xf0;           // sync, layer 0
  const mpa = (b, o = 0) => b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0 && (b[o + 1] & 0x06) !== 0;
  const mp4Mime = (init) => (init && isEbml(init) ? 'audio/webm' : 'audio/mp4');

  function finish(init, parts, mimeHint = '') {
    const first = parts[0] || new Uint8Array(0);
    if (init) {
      if (isTs(first)) return demuxTs([init, ...parts]);
      return { bytes: join([init, ...parts]).buffer, mime: /webm/.test(mimeHint) ? 'audio/webm' : mp4Mime(init) };
    }
    if (isTs(first)) return demuxTs(parts);
    if (isFmp4(first)) return { bytes: join(parts).buffer, mime: 'audio/mp4' };
    if (isEbml(first)) return { bytes: join(parts).buffer, mime: 'audio/webm' };
    if (first.byteLength >= 4 && String.fromCharCode(...first.subarray(0, 4)) === 'fLaC') return { bytes: join(parts).buffer, mime: 'audio/flac' };
    // packed audio (HLS): each segment an ID3 tag (its timestamp) then ADTS or MPEG audio frames
    const bare = parts.map((p) => p.subarray(id3Len(p)));
    const b0 = bare.find((p) => p.byteLength) || new Uint8Array(0);
    if (adts(b0)) return { bytes: join(bare).buffer, mime: 'audio/aac' };
    if (mpa(b0)) return { bytes: join(bare).buffer, mime: 'audio/mpeg' };
    refuse('segments of a kind it can\'t read');
  }

  // MPEG-TS: the first audio stream it can play (ADTS AAC, MPEG audio) out of the PES packets
  const TS_AUDIO = { 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3' };
  const TS_ENCRYPTED = new Set([0xcf, 0xdb, 0xc1, 0xc2]);   // SAMPLE-AES AAC, H.264, AC-3, E-AC-3
  function demuxTs(chunks) {
    let pmtPid = -1, audioPid = -1, kind = null, sawAudio = false, sawEnc = false;
    const out = [];
    let pes = null;   // the open PES: { skip } bytes of its header still to drop
    for (const c of chunks) {
      for (let o = 0; o + 188 <= c.byteLength; o += 188) {
        if (c[o] !== 0x47) { const n = c.indexOf(0x47, o + 1); if (n < 0) break; o = n - 188; continue; }
        const pusi = (c[o + 1] & 0x40) !== 0, pid = ((c[o + 1] & 0x1f) << 8) | c[o + 2], afc = (c[o + 3] >> 4) & 3;
        let p = o + 4;
        if (afc & 2) p += 1 + c[o + 4];
        if (!(afc & 1) || p >= o + 188) continue;
        const payload = c.subarray(p, o + 188);
        if (pid === 0 && pusi) {
          const s = payload.subarray(1 + payload[0]);
          const end = Math.min(s.byteLength, 3 + (((s[1] & 0x0f) << 8) | s[2])) - 4;
          for (let i = 8; i + 4 <= end; i += 4) {
            const prog = (s[i] << 8) | s[i + 1];
            if (prog) { pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; break; }
          }
        } else if (pid === pmtPid && pusi && audioPid < 0) {
          const s = payload.subarray(1 + payload[0]);
          const end = Math.min(s.byteLength, 3 + (((s[1] & 0x0f) << 8) | s[2])) - 4;
          let i = 12 + (((s[10] & 0x0f) << 8) | s[11]);
          while (i + 5 <= end) {
            const type = s[i], epid = ((s[i + 1] & 0x1f) << 8) | s[i + 2], esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
            if (TS_ENCRYPTED.has(type)) sawEnc = true;
            if (TS_AUDIO[type]) { audioPid = epid; kind = TS_AUDIO[type]; break; }
            if ([0x11, 0x81, 0x87, 0x06].includes(type)) sawAudio = true;
            i += 5 + esLen;
          }
        } else if (pid === audioPid) {
          if (pusi) {
            if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) { pes = null; continue; }
            pes = true;
            const data = payload.subarray(9 + payload[8]);
            if (data.byteLength) out.push(data);
          } else if (pes) out.push(payload);
        }
      }
    }
    if (audioPid < 0) refuse(sawEnc ? 'encrypted (SAMPLE-AES)' : sawAudio ? 'the stream\'s audio is a codec it can\'t play' : 'no audio in the stream');
    const bytes = join(out);
    if (!bytes.byteLength) refuse('no audio in the stream');
    return { bytes: bytes.buffer, mime: kind === 'aac' ? 'audio/aac' : 'audio/mpeg' };
  }

  // ---- DASH: a small XML reader (no DOM in a service worker) ----
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unent = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
  const local = (n) => n.replace(/^.*:/, '');
  function parseXml(t) {
    const root = { name: '#root', attrs: {}, kids: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    for (const m of t.matchAll(re)) {
      const top = stack[stack.length - 1];
      if (m[1] != null) top.text += m[1];
      else if (m[2]) { const n = local(m[2]); const i = stack.map((e) => e.name).lastIndexOf(n); if (i > 0) stack.length = i; }
      else if (m[3]) {
        const el = { name: local(m[3]), attrs: {}, kids: [], text: '' };
        for (const a of (m[4] || '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[local(a[1])] = unent(a[2] ?? a[3]);
        top.kids.push(el);
        if (!m[5]) stack.push(el);
      } else if (m[6]) top.text += unent(m[6]);
    }
    return root;
  }
  const kid = (e, n) => e?.kids.find((k) => k.name === n) || null;
  const kidsOf = (e, n) => e?.kids.filter((k) => k.name === n) || [];
  function isoSec(d) {
    const m = String(d || '').match(/^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/);
    if (!m) return null;
    const [y, mo, w, dd, h, mi, s] = m.slice(1).map((x) => Number(x) || 0);
    return y * 31536000 + mo * 2592000 + w * 604800 + dd * 86400 + h * 3600 + mi * 60 + s;
  }
  const rangeOf = (r) => { const m = String(r || '').match(/^(\d+)-(\d+)$/); return m ? [Number(m[1]), Number(m[2])] : null; };
  function fill(tpl, v) {
    return String(tpl).replace(/\$(RepresentationID|Number|Bandwidth|Time|)(?:%0(\d+)d)?\$/g, (m, k, w) => {
      if (!k) return '$';
      const x = String(v[k] ?? '');
      return w && k !== 'RepresentationID' ? x.padStart(Number(w), '0') : x;
    });
  }

  function readMpd(t, url) {
    const doc = parseXml(t);
    const mpd = kid(doc, 'MPD');
    if (!mpd) refuse('the manifest is not a DASH manifest');
    if ((mpd.attrs.type || 'static') === 'dynamic') refuse('a live stream (dynamic MPD)');
    const periods = kidsOf(mpd, 'Period');
    if (periods.length !== 1) refuse(periods.length ? 'more than one Period' : 'no Period');
    const period = periods[0];
    const periodSec = isoSec(period.attrs.duration) ?? isoSec(mpd.attrs.mediaPresentationDuration);
    const audioOf = (as, rep) => {
      const mime = rep?.attrs.mimeType || as.attrs.mimeType || '';
      const ct = as.attrs.contentType || kidsOf(as, 'ContentComponent').map((c) => c.attrs.contentType).join(' ');
      if (/^video\//.test(mime) || /video|text|image/.test(ct) && !/audio/.test(ct)) return false;
      if (/^audio\//.test(mime) || /audio/.test(ct)) return true;
      const codecs = rep?.attrs.codecs || as.attrs.codecs || '';
      return !!codecs && !VIDEO.test(codecs) && !rep?.attrs.width && !as.attrs.width;
    };
    const cands = [];
    let protectedSeen = false, dolbySeen = false;
    for (const as of kidsOf(period, 'AdaptationSet')) {
      for (const rep of kidsOf(as, 'Representation')) {
        if (!audioOf(as, rep)) continue;
        if (kid(as, 'ContentProtection') || kid(rep, 'ContentProtection')) { protectedSeen = true; continue; }
        const codecs = rep.attrs.codecs || as.attrs.codecs || '';
        if (dolbyOnly(codecs)) { dolbySeen = true; continue; }
        cands.push({ as, rep, bw: Number(rep.attrs.bandwidth) || 0, mime: rep.attrs.mimeType || as.attrs.mimeType || '' });
      }
    }
    if (!cands.length) refuse(protectedSeen ? 'encrypted (ContentProtection)' : dolbySeen ? 'Dolby audio only' : 'no audio in the manifest');
    cands.sort((a, b) => b.bw - a.bw);
    const { as, rep, mime } = cands[0];
    // BaseURL: the MPD's, the Period's, the set's, the Representation's, each on the one above
    let baseUrl = url;
    for (const e of [mpd, period, as, rep]) { const b = kid(e, 'BaseURL'); if (b && b.text.trim()) baseUrl = resolve(b.text.trim(), baseUrl); }
    const vars = { RepresentationID: rep.attrs.id || '', Bandwidth: rep.attrs.bandwidth || '' };
    const chain = [period, as, rep];
    const tpls = chain.map((e) => kid(e, 'SegmentTemplate')).filter(Boolean);
    const lists = chain.map((e) => kid(e, 'SegmentList')).filter(Boolean);
    let init = null; const segs = [];
    if (tpls.length) {
      const a = Object.assign({}, ...tpls.map((x) => x.attrs));
      const tl = tpls.map((x) => kid(x, 'SegmentTimeline')).filter(Boolean).pop();
      const initEl = tpls.map((x) => kid(x, 'Initialization')).filter(Boolean).pop();
      const scale = Number(a.timescale) || 1;
      let num = a.startNumber != null ? Number(a.startNumber) : 1;
      const initT = a.initialization || initEl?.attrs.sourceURL;
      if (initT) init = { url: resolve(fill(initT, vars), baseUrl), range: rangeOf(initEl?.attrs.range) };
      if (!a.media) refuse('a SegmentTemplate without media');
      const add = (time) => { segs.push({ url: resolve(fill(a.media, { ...vars, Number: num, Time: time }), baseUrl), range: null }); num++; if (segs.length > MAX_SEGMENTS) refuse('too many segments'); };
      if (tl) {
        let time = 0;
        const S = kidsOf(tl, 'S');
        S.forEach((s, i) => {
          if (s.attrs.t != null) time = Number(s.attrs.t);
          const d = Number(s.attrs.d);
          if (!(d > 0)) refuse('a SegmentTimeline entry without a length');
          let r = Number(s.attrs.r) || 0;
          if (r < 0) {
            const until = S[i + 1]?.attrs.t != null ? Number(S[i + 1].attrs.t) : periodSec != null ? periodSec * scale + (Number(a.presentationTimeOffset) || 0) : null;
            if (until == null) refuse('a SegmentTimeline without an end');
            r = Math.ceil((until - time) / d) - 1;
          }
          for (let k = 0; k <= r; k++) { add(time); time += d; }
        });
      } else {
        if (/\$Time/.test(a.media)) refuse('a $Time$ template without a timeline');
        const d = Number(a.duration);
        if (!(d > 0) || periodSec == null) refuse('a SegmentTemplate without a length');
        const n = Math.ceil(periodSec * scale / d - 1e-9);
        if (n > MAX_SEGMENTS) refuse('too many segments');
        for (let k = 0; k < n; k++) add(null);
      }
    } else if (lists.length) {
      const list = lists[lists.length - 1];
      const initEl = lists.map((x) => kid(x, 'Initialization')).filter(Boolean).pop();
      if (initEl) init = { url: initEl.attrs.sourceURL ? resolve(initEl.attrs.sourceURL, baseUrl) : baseUrl, range: rangeOf(initEl.attrs.range) };
      for (const su of kidsOf(list, 'SegmentURL')) segs.push({ url: su.attrs.media ? resolve(su.attrs.media, baseUrl) : baseUrl, range: rangeOf(su.attrs.mediaRange) });
      if (!segs.length) refuse('a SegmentList without segments');
    } else {
      // SegmentBase, or a BaseURL alone: one progressive file
      segs.push({ url: baseUrl, range: null });
    }
    return { init, segs, mime };
  }

  async function dash(F, url, parallel) {
    const { text: t, url: at } = await F.text(url, 'the manifest');
    const { init, segs, mime } = readMpd(t, at);
    const [initBytes] = init ? await fetchAll(F, [init], 1) : [null];
    const parts = await fetchAll(F, segs, parallel);
    return finish(initBytes, parts, mime);
  }

  async function assemble(s, { base, fetch: doFetch = globalThis.fetch?.bind(globalThis), signal = null, maxBytes = 300e6, requestMs = REQUEST_MS, parallel = PARALLEL } = {}) {
    const F = fetcher({ base, fetch: doFetch, signal, maxBytes, requestMs, headers: s?.headers || {} });
    try {
      if (s?.transport === 'hls') return await hls(F, s.url, parallel);
      if (s?.transport === 'dash') return await dash(F, s.url, parallel);
      return { none: 'not a stream' };
    } catch (e) {
      if (e instanceof Refusal) return { none: C.scrub(e.message), refused: true };
      if (e instanceof Failure) return { none: C.scrub(e.message) };
      return { none: C.scrub(`the stream failed: ${e?.message || e}`) };
    }
  }

  const api = { assemble, parseXml, demuxTs, readMpd, readMaster, readMedia };
  globalThis.__viviStreamAssemble = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

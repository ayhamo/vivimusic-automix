/* VIVIMUSIC XTEN — crossfade-page.js  (runs in the page's MAIN world)
 *
 * Crossfading needs the *end* of the current song to keep playing after the
 * <video> element has already moved on to the next one. The only place that
 * audio exists ahead of time is the MediaSource buffer YouTube Music feeds
 * the player, and that can only be observed from the page's own JS world.
 *
 * This file therefore does three small jobs and nothing else:
 *   1. Keeps a bounded copy of the audio segments appended to MSE.
 *   2. On request, decodes the final stretch of the current song into PCM
 *      and posts it to crossfade.js (the isolated-world half).
 *   3. Reports a little player state (video id, ad flag, repeat mode) and
 *      can press "next".
 *   4. For automix, downloads the whole current and next song through an app
 *      client (VISIONOS, with fallbacks; the web player only gets ~50 s ahead,
 *      often too late for the outro), as BitChord does. The current song's
 *      outro is decoded from that copy, and both files go to automix for
 *      BitChord's analysis. It also reports which song the queue plays next
 *      and can seek, pause and resume the player for the blend.
 *
 * Talking to crossfade.js happens over window.postMessage on one channel.
 */
(() => {
  'use strict';
  if (window.__viviXfadePage) return;
  window.__viviXfadePage = true;

  const CHANNEL = 'vivi-xfade';
  const MAX_BYTES_PER_SINK = 24 * 1024 * 1024;
  const MAX_SINKS = 4;

  const sinks = [];        // one per audio SourceBuffer we have seen
  let capturing = false;   // chunk copies are only kept while crossfade is on

  const log = (...a) => console.log('%c[ViVi crossfade/page]', 'color:#7aa2ff', ...a);
  const say = (payload) => window.postMessage({ ch: CHANNEL, dir: 'out', ...payload }, window.location.origin);

  // ───────────────────────── byte helpers ─────────────────────────
  const rd32 = (u, i) => ((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0;

  function findTag(u, tag, from = 0, to = u.length) {
    const a = tag.charCodeAt(0), b = tag.charCodeAt(1), c = tag.charCodeAt(2), d = tag.charCodeAt(3);
    const stop = Math.min(to, u.length) - 4;
    for (let i = from; i <= stop; i++) {
      if (u[i] === a && u[i + 1] === b && u[i + 2] === c && u[i + 3] === d) return i;
    }
    return -1;
  }

  const isWebm = (u) => u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3;
  const isMp4Init = (u) => findTag(u, 'ftyp', 4, 8) === 4;

  // Big-endian unsigned read of 1..8 bytes.
  function readUint(u, at, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + u[at + i];
    return v;
  }

  // Timescale: mp4 → mdhd box; webm → TimecodeScale element (default 1 ms).
  function timescaleOf(init) {
    if (isWebm(init)) {
      for (let i = 0; i < Math.min(init.length - 5, 512); i++) {
        if (init[i] === 0x2a && init[i + 1] === 0xd7 && init[i + 2] === 0xb1) {
          const n = init[i + 3];
          if ((n & 0xf0) === 0x80) return readUint(init, i + 4, n & 0x0f) / 1e9;
        }
      }
      return 1e6 / 1e9;
    }
    const m = findTag(init, 'mdhd');
    if (m < 0) return 0;
    return 1 / (rd32(init, m + (init[m + 4] ? 24 : 16)) || 1);
  }

  // Start time (seconds, container timeline) of the first fragment in a segment.
  function segmentStart(u, webm, secPerTick) {
    if (webm) {
      if (!(u[0] === 0x1f && u[1] === 0x43 && u[2] === 0xb6 && u[3] === 0x75)) return null;
      let len = 1, mask = 0x80;
      while (len < 8 && !(u[4] & mask)) { len++; mask >>= 1; }
      const from = 4 + len;
      for (let p = from; p < Math.min(u.length - 3, from + 32); p++) {
        if (u[p] !== 0xe7) continue;
        const n = u[p + 1];
        if (n >= 0x81 && n <= 0x88) return readUint(u, p + 2, n & 0x7f) * secPerTick;
      }
      return null;
    }
    const t = findTag(u, 'tfdt', 0, 4096);
    if (t < 0 || !secPerTick) return null;
    const ticks = u[t + 4] ? rd32(u, t + 8) * 4294967296 + rd32(u, t + 12) : rd32(u, t + 8);
    return ticks * secPerTick;
  }

  // ───────────────────────── MSE capture ─────────────────────────
  const nativeAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = nativeAdd.call(this, mime);
    try {
      if (/^audio\//i.test(String(mime))) {
        sinks.push({ sb, ms: this, init: null, webm: false, tick: 0, parts: [], bytes: 0 });
        while (sinks.length > MAX_SINKS) sinks.shift();
      }
    } catch { /* never break playback */ }
    return sb;
  };

  const nativeAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const sink = sinks.find((s) => s.sb === this);
      if (sink) remember(sink, this, data);
    } catch { /* never break playback */ }
    return nativeAppend.call(this, data);
  };

  function remember(sink, sb, data) {
    const u = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (isWebm(u) || isMp4Init(u)) {
      sink.init = u.slice();            // init segments are tiny: always keep
      sink.webm = isWebm(u);
      sink.tick = timescaleOf(sink.init);
      return;
    }
    if (!capturing || !sink.init) return;
    const t = segmentStart(u, sink.webm, sink.tick);
    if (t == null || !isFinite(t)) {
      // YouTube Music often appends one segment in several chunks; only the
      // first starts with a cluster / fragment header. The rest belong to the
      // segment before them, and dropping them leaves holes the decoder stops at.
      const last = sink.parts[sink.parts.length - 1];
      if (!last || last.init !== sink.init || last.shift !== sb.timestampOffset) return;
      const joined = new Uint8Array(last.bytes.byteLength + u.byteLength);
      joined.set(last.bytes, 0);
      joined.set(u, last.bytes.byteLength);
      last.bytes = joined;
    } else {
      sink.parts.push({ t, shift: sb.timestampOffset, init: sink.init, bytes: u.slice() });
    }
    sink.bytes += u.byteLength;
    while (sink.bytes > MAX_BYTES_PER_SINK && sink.parts.length > 1) {
      sink.bytes -= sink.parts.shift().bytes.byteLength;
    }
  }

  function dropAll() {
    for (const s of sinks) { s.parts = []; s.bytes = 0; }
    files.clear();
  }

  // ───────────────────────── whole-song prefetch ─────────────────────────
  // The web player is only ever sent ~50 s beyond what has played, so the
  // outro automix needs is often not there in time. Asked as one of YouTube's
  // app clients instead, it returns a plain stream URL (no attestation),
  // which we download in full right after the song starts, like BitChord.
  // Same-origin call from the page: an extension Origin gets a 403 here.
  //
  // Measured 6 Nov 2026: VISIONOS URLs serve the whole file, any range.
  // ANDROID_VR URLs serve ranges of at most 512 KB and refuse every byte
  // past the first ~1 MB; it stays last in case that cap is lifted. IOS and
  // ANDROID only answer with SABR now, the music/creator apps want a login.
  //
  // Fallbacks, in order: each client in turn; for each, the Opus file then
  // the AAC one; every URL is probed at its end first (where a capped URL
  // refuses), so a dead client costs one small request; a URL refused
  // mid-download is resolved once more; network errors are retried with a
  // backoff; the file must decode before it counts. crossfade.js asks once
  // more later in the song if all of that failed, and the web player's own
  // buffer stays the last resort when automix asks for the outro.
  const VISION = {
    clientName: 'VISIONOS',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice14,1',
    osName: 'visionOS',
    osVersion: '1.3.21O771',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  };
  const CLIENTS = [
    { name: 'VISIONOS 0.1', range: 2 * 1024 * 1024, client: { ...VISION, clientVersion: '0.1' } },
    { name: 'VISIONOS 1.02', range: 2 * 1024 * 1024, client: { ...VISION, clientVersion: '1.02' } },
    {
      name: 'ANDROID_VR',
      range: 512 * 1024,
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      },
    },
  ];
  const PROBE_BYTES = 64 * 1024;
  // id -> { id, state: loading|ready|failed, file, init, segs, why, done }:
  // the playing song and the next one (BitChord keeps a few around too).
  const files = new Map();
  const MAX_FILES = 3;
  let visitorFromReply = '';            // when the page has no visitor id of its own

  const cfg = (k) => { try { return window.ytcfg?.get?.(k); } catch { return undefined; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const refused = (msg) => Object.assign(new Error(msg), { refused: true });

  async function callPlayer(id, client, visitor) {
    const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',   // the app clients don't take the web session
      headers: { 'Content-Type': 'application/json', ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}) },
      body: JSON.stringify({
        context: { client: { ...client, hl: cfg('HL') || 'en', gl: cfg('GL') || 'US', ...(visitor ? { visitorData: visitor } : {}) } },
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) throw new Error('player HTTP ' + res.status);
    return res.json();
  }

  // Plain audio formats for `id` as `client` sees it: the best Opus, then the best AAC.
  async function resolveFormats(id, client) {
    const visitor = cfg('VISITOR_DATA') || visitorFromReply;
    let j = await callPlayer(id, client, visitor);
    const fresh = decodeURIComponent(j.responseContext?.visitorData || '');
    if (fresh && !visitorFromReply) visitorFromReply = fresh;
    // Without a visitor id the app clients are asked to "confirm you're not a
    // bot"; the refusal itself hands out one, so ask again with it.
    if (j.playabilityStatus?.status !== 'OK' && !visitor && fresh) j = await callPlayer(id, client, fresh);
    const ps = j.playabilityStatus || {};
    if (ps.status !== 'OK') throw new Error('player ' + ps.status + (ps.reason ? ' (' + ps.reason + ')' : ''));
    const audio = (j.streamingData?.adaptiveFormats || [])
      .filter((f) => f.url && /^audio\//.test(f.mimeType || '') && Number(f.contentLength) > 0)
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const picks = [audio.find((f) => /webm/.test(f.mimeType)), audio.find((f) => /mp4/.test(f.mimeType))].filter(Boolean);
    if (!picks.length) throw new Error('no plain audio URL');
    // BitChord's rule: a picture wider than 1.2:1 is a music video; a square
    // one is YouTube's art track for the song. The loop mix leaves videos alone.
    const pictures = (j.streamingData?.adaptiveFormats || []).filter((f) => f.width && f.height);
    const widest = pictures.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const musicVideo = !!widest && widest.width / widest.height >= 1.2;
    return picks.map((f) => ({ url: f.url, size: Number(f.contentLength), initEnd: Number(f.initRange?.end) || 0, itag: f.itag, musicVideo }));
  }

  // Some files are served after two redirects between Google's servers: the
  // browser then sends Origin "null" and the last server's reply fails the
  // CORS check ("Failed to fetch", every time, for that song). The
  // extension's background worker is not bound by CORS, so crossfade.js
  // fetches those bytes through it (measured 10 Nov 2026: 2 MB in ~0.4 s).
  const viaExtension = new Set();   // URLs the page itself can't fetch
  const relayWait = new Map();      // rid -> { resolve, reject, timer }
  let relaySeq = 0;
  function relayRange(url) {
    return new Promise((resolve, reject) => {
      const rid = ++relaySeq;
      const timer = setTimeout(() => { relayWait.delete(rid); reject(new Error('extension fetch timed out')); }, 30000);
      relayWait.set(rid, { resolve, reject, timer });
      say({ type: 'range', rid, url });
    });
  }
  async function getRange(url, a, b) {
    const ranged = url + '&range=' + a + '-' + b;
    if (viaExtension.has(url)) return relayRange(ranged);
    try {
      return await fetch(ranged, { credentials: 'omit' });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (viaExtension.size > 20) viaExtension.clear();
      viaExtension.add(url);
      log('the page may not fetch this file (CORS); fetching it through the extension');
      return relayRange(ranged);
    }
  }

  // Bytes a..b of `url`; null when the song changed meanwhile. A refusal
  // (403/404/410) throws at once with .refused; anything else is retried.
  async function fetchRange(url, a, b, wanted) {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(600 * 2 ** attempt);
      if (!wanted()) return null;
      try {
        const res = await getRange(url, a, b);
        if (!wanted()) return null;
        if (res.status === 403 || res.status === 404 || res.status === 410) throw refused('HTTP ' + res.status + ' at ' + Math.round(a / 1024) + ' KB');
        if (!res.ok) { last = 'HTTP ' + res.status; continue; }
        const u = new Uint8Array(await res.arrayBuffer());
        if (u.byteLength === b - a + 1) return u;
        last = 'short read at ' + Math.round(a / 1024) + ' KB';
      } catch (e) {
        if (e.refused) throw e;
        last = String(e?.message || e);
      }
    }
    throw new Error(last || 'network error');
  }

  async function download(f, step, wanted) {
    const file = new Uint8Array(f.size);
    for (let at = 0; at < f.size; at += step) {
      const end = Math.min(f.size, at + step) - 1;
      const r = await fetchRange(f.url, at, end, wanted);
      if (!r) return null;
      file.set(r, at);
    }
    return file;
  }

  // Index the file and make sure its outro actually decodes here.
  async function prepareFile(file, initEnd) {
    const init = initEnd + 1;
    const webm = isWebm(file);
    const tick = timescaleOf(file.subarray(0, init));
    const segs = webm ? webmClusters(file, init) : mp4Fragments(file, init, tick);
    if (!segs.length || !tick) throw new Error('could not index the file');
    const p = { file, init, webm, tick, segs };
    const { decoded } = await tailFromFile(p, segs[segs.length - 1].t - 1, 48000);
    if (!(decoded.duration > 1)) throw new Error('outro decodes to nothing');
    return p;
  }

  // One client: Opus then AAC. Each URL is probed at its end, then
  // downloaded; one that passed the probe and is refused partway was likely
  // stood down mid-download, so it gets one fresh URL for the same file.
  async function tryClient(id, c, wanted) {
    const formats = await resolveFormats(id, c.client);
    let lastErr = null;
    for (let f of formats) {
      for (let pass = 0; pass < 2; pass++) {
        let probed = false;
        try {
          if (!(await fetchRange(f.url, Math.max(0, f.size - PROBE_BYTES), f.size - 1, wanted))) return null;
          probed = true;
          const file = await download(f, c.range, wanted);
          if (!file) return null;
          return { ...(await prepareFile(file, f.initEnd)), itag: f.itag, size: f.size, musicVideo: f.musicVideo };
        } catch (e) {
          lastErr = e;
          if (!wanted()) return null;
          if (!e.refused || !probed || pass === 1) break;
          const again = (await resolveFormats(id, c.client)).find((x) => x.itag === f.itag);
          if (!again || again.size !== f.size) break;
          f = again;
        }
      }
    }
    throw lastErr || new Error('no usable file');
  }

  async function prefetchSong(id, retry = false) {
    if (!id) return;
    const old = files.get(id);
    if (old && !(retry && old.state === 'failed')) return;
    const me = { id, state: 'loading' };
    files.delete(id);
    files.set(id, me);
    while (files.size > MAX_FILES) files.delete(files.keys().next().value);
    const t0 = performance.now();
    const wanted = () => files.get(id) === me;
    // Pushed out by newer downloads before it finished (not replaced by a new
    // try of the same song): the extension forgets it, so it can ask again.
    const dropped = () => { if (!files.has(id)) say({ type: 'prefetch', id, state: 'dropped', why: 'evicted before it finished' }); };
    me.done = (async () => {
      const errors = [];
      for (const c of CLIENTS) {
        try {
          const got = await tryClient(id, c, wanted);
          if (!got) { dropped(); return; }   // the song changed
          Object.assign(me, got, { state: 'ready', client: c.name });
          log('prefetch: whole song', id, 'downloaded via', c.name, '| itag', got.itag, '|', (got.size / 1048576).toFixed(1), 'MB in', Math.round(performance.now() - t0), 'ms |', got.segs.length, 'segments' + (errors.length ? ' | after: ' + errors.join('; ') : ''));
          break;
        } catch (e) {
          if (!wanted()) { dropped(); return; }
          errors.push(c.name + ': ' + (e?.message || e));
        }
      }
      if (me.state !== 'ready') {
        me.state = 'failed';
        me.why = errors.join('; ');
        log('prefetch failed' + (retry ? ' again' : '') + ':', me.why);
      }
      if (wanted()) say({ type: 'prefetch', id, state: me.state, why: me.why || '', client: me.client || '' });
      else dropped();
    })();
  }

  // EBML variable-length size at u[i]: { len, value } (value -1 = unknown size).
  function vint(u, i) {
    let len = 1, mask = 0x80;
    while (len <= 8 && !(u[i] & mask)) { len++; mask >>= 1; }
    if (len > 8) return null;
    let v = u[i] & (mask - 1), allOnes = v === mask - 1;
    for (let k = 1; k < len; k++) { v = v * 256 + u[i + k]; if (u[i + k] !== 0xff) allOnes = false; }
    return { len, value: allOnes ? -1 : v };
  }

  // Byte ranges and start times of every Cluster in a whole WebM file.
  function webmClusters(u, from) {
    const segs = [];
    let i = findTag(u, '\x1f\x43\xb6\x75', from);
    const tick = timescaleOf(u.subarray(0, from));
    while (i >= 0 && i + 12 < u.length) {
      if (!(u[i] === 0x1f && u[i + 1] === 0x43 && u[i + 2] === 0xb6 && u[i + 3] === 0x75)) break;
      const sz = vint(u, i + 4);
      if (!sz || sz.value < 0) break;
      const end = Math.min(u.length, i + 4 + sz.len + sz.value);
      const t = segmentStart(u.subarray(i, Math.min(end, i + 64)), true, tick);
      if (t == null) break;
      segs.push({ t, start: i, end });
      i = end;
    }
    return segs;
  }

  // Byte ranges (moof + its mdat) and start times of every fragment in a whole MP4 file.
  function mp4Fragments(u, from, tick) {
    const segs = [];
    let i = from;
    while (i + 8 <= u.length) {
      let size = rd32(u, i);
      const type = String.fromCharCode(u[i + 4], u[i + 5], u[i + 6], u[i + 7]);
      if (size === 1) size = rd32(u, i + 8) * 4294967296 + rd32(u, i + 12);
      else if (size === 0) size = u.length - i;
      if (size < 8) break;
      if (type === 'moof') {
        const t = segmentStart(u.subarray(i, Math.min(u.length, i + size)), false, tick);
        if (t != null) segs.push({ t, start: i, end: i + size });
      } else if (type === 'mdat' && segs.length) {
        segs[segs.length - 1].end = Math.min(u.length, i + size);
      }
      i += size;
    }
    return segs;
  }

  // Init segment + every cluster/fragment from the one covering song time
  // `fromSec` to the end of the file, decoded. Times are song time.
  async function tailFromFile(p, fromSec, sampleRate) {
    let first = 0;
    for (let i = 0; i < p.segs.length; i++) { if (p.segs[i].t <= fromSec) first = i; else break; }
    const seg = p.segs[first];
    const lastEnd = p.segs[p.segs.length - 1].end;
    const blob = new Uint8Array(p.init + (lastEnd - seg.start));
    blob.set(p.file.subarray(0, p.init), 0);
    blob.set(p.file.subarray(seg.start, lastEnd), p.init);
    const offline = new OfflineAudioContext(2, 1, sampleRate);
    const decoded = await offline.decodeAudioData(blob.buffer);
    return { decoded, start: seg.t };
  }

  // ───────────────────────── player access ─────────────────────────
  const moviePlayer = () => document.getElementById('movie_player');
  const videoEl = () => document.querySelector('#movie_player video, ytmusic-player video, video');
  const liveSink = () => {
    for (let i = sinks.length - 1; i >= 0; i--) {
      if (sinks[i].ms.readyState !== 'closed') return sinks[i];
    }
    return null;
  };

  function snapshot() {
    const p = moviePlayer(), v = videoEl();
    if (!p || !v || typeof p.getVideoData !== 'function') return null;
    const id = p.getVideoData()?.video_id || '';
    const dur = Number(p.getDuration?.()) || 0;
    const pos = Number(p.getCurrentTime?.()) || 0;
    return {
      id,
      dur,
      off: v.currentTime - pos,           // element timeline minus track timeline
      ad: p.classList.contains('ad-showing'),
      rep: repeatOne(),
      next: nextQueued(id),
    };
  }

  // The song the queue plays after `current` on its own: the next queue item,
  // else the first autoplay suggestion, else (repeat all) the first item.
  // Read from YouTube Music's own store; '' when there is none.
  function nextQueued(current) {
    try {
      const q = document.querySelector('ytmusic-player-queue')?.getState?.().queue;
      if (!q || !Array.isArray(q.items)) return '';
      const variants = (it) => {
        const w = it?.playlistPanelVideoWrapperRenderer;
        const main = it?.playlistPanelVideoRenderer || w?.primaryRenderer?.playlistPanelVideoRenderer;
        const other = w?.counterpart?.[0]?.counterpartRenderer?.playlistPanelVideoRenderer;
        return [main?.videoId || '', other?.videoId || ''];
      };
      let at = q.items.findIndex((it) => variants(it).includes(current));
      if (at < 0) at = Number(q.selectedItemIndex);
      if (!(at >= 0)) return '';
      // a song/video pair: the next one plays in the variant this one is in
      const side = variants(q.items[at])[1] === current ? 1 : 0;
      const pick = (it) => { const v = variants(it); return v[side] || v[0]; };
      if (at + 1 < q.items.length) return pick(q.items[at + 1]);
      if (q.repeatMode === 'ALL') return pick(q.items[0]);
      if (q.autoplay && q.automixItems?.length) return pick(q.automixItems[0]);
      return '';
    } catch { return ''; }
  }

  // A queued song's title, artist, album and length (for automix's lyrics
  // lookup), from YouTube Music's queue store; the player for the playing song.
  function songMeta(id) {
    const text = (x) => (x?.runs || []).map((r) => r.text).join('').trim();
    const pageType = (r) => r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
    const seconds = (t) => String(t || '').split(':').reduce((acc, n) => acc * 60 + (Number(n) || 0), 0) || null;
    try {
      const q = document.querySelector('ytmusic-player-queue')?.getState?.().queue;
      const items = [...(q?.items || []), ...(q?.automixItems || [])];
      for (const it of items) {
        const w = it?.playlistPanelVideoWrapperRenderer;
        const all = [it?.playlistPanelVideoRenderer, w?.primaryRenderer?.playlistPanelVideoRenderer, w?.counterpart?.[0]?.counterpartRenderer?.playlistPanelVideoRenderer];
        const r = all.find((x) => x?.videoId === id);
        if (!r) continue;
        const by = r.longBylineText?.runs || r.shortBylineText?.runs || [];
        const artists = by.filter((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ARTIST').map((x) => x.text);
        return {
          song: text(r.title),
          artist: artists.join(', ') || r.shortBylineText?.runs?.[0]?.text || '',
          album: by.find((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '',
          duration: seconds(text(r.lengthText)),
        };
      }
      const p = moviePlayer(), v = p?.getVideoData?.();
      if (v && v.video_id === id) return { song: v.title || '', artist: v.author || '', album: '', duration: Number(p.getDuration?.()) || null };
    } catch { /* store changed shape */ }
    return null;
  }

  setInterval(() => {
    if (!capturing) return;
    const s = snapshot();
    if (s) say({ type: 'state', ...s });
  }, 250);

  // ───────────────────────── tail decoding ─────────────────────────
  async function buildTail(req) {
    const snap = snapshot();
    if (!snap || snap.id !== req.id) return { ok: false, why: 'track-changed', automix: !!req.automix, manualSkip: !!req.manualSkip };

    // The whole song, when the prefetch has it: the outro is there however
    // little the web player has buffered. Automix waits a little for a
    // download still in flight; anything else uses it only when it's done.
    const p0 = files.get(req.id);
    if (!req.manualSkip && p0) {
      if (p0.state === 'loading' && req.automix) await Promise.race([p0.done, new Promise((r) => setTimeout(r, 10000))]);
      const p = files.get(req.id);
      if (p && p.state === 'ready') {
        try {
          const { decoded, start } = await tailFromFile(p, req.needFrom - snap.off, req.sampleRate);
          const again = snapshot();
          if (!again || again.id !== req.id) return { ok: false, why: 'track-changed', automix: !!req.automix };
          const channels = [];
          for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) channels.push(decoded.getChannelData(c).slice());
          log('tail from the prefetched song:', (decoded.duration).toFixed(1), 's from', start.toFixed(1), 's');
          return { ok: true, sampleRate: decoded.sampleRate, start: snap.off + start, channels, automix: !!req.automix, manualSkip: false, source: 'prefetch' };
        } catch (e) {
          log('prefetched song could not be decoded, using the player buffer:', e?.message || e);
        }
      }
    }

    const sink = liveSink();
    if (!sink || !sink.parts.length) return { ok: false, why: 'no-data', automix: !!req.automix, manualSkip: !!req.manualSkip };

    // Segments belonging to this song share one timestampOffset.
    const mine = sink.parts.filter((p) => Math.abs(p.shift - snap.off) < 0.05);
    if (!mine.length) return { ok: false, why: 'no-group', automix: !!req.automix, manualSkip: !!req.manualSkip };

    // Order by time, de-duplicate re-appended segments.
    mine.sort((a, b) => a.t - b.t);
    const uniq = mine.filter((p, i) => i === mine.length - 1 || mine[i + 1].t - p.t > 0.01);

    const gaps = [];
    for (let i = 1; i < uniq.length; i++) gaps.push(uniq[i].t - uniq[i - 1].t);
    gaps.sort((x, y) => x - y);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 8;
    const limit = typical * 1.6 + 0.5;

    let run;
    if (req.manualSkip) {
      let first = -1;
      for (let i = 0; i < uniq.length; i++) {
        const segStart = uniq[i].t + uniq[i].shift;
        if (segStart <= req.needFrom) first = i; else break;
      }
      if (first === -1) first = 0;
      const candidates = uniq.slice(first);
      if (!candidates.length) return { ok: false, why: 'no-candidates', manualSkip: true };
      const lastAvailable = candidates[candidates.length - 1].t + candidates[candidates.length - 1].shift;
      if (lastAvailable < req.needFrom + 0.8) return { ok: false, why: 'not-enough-buffered', manualSkip: true };

      const maxSegs = Math.max(1, Math.min(candidates.length, Math.ceil(((req.cover || 6) + 4) / typical) + 2));
      run = candidates.slice(0, maxSegs);
    } else {
      let begin = uniq.length - 1;
      while (begin > 0 && uniq[begin].t - uniq[begin - 1].t <= limit) begin--;
      const solid = uniq.slice(begin);

      // The song must be buffered right to the end...
      const trackEnd = snap.off + snap.dur;
      const lastStart = solid[solid.length - 1].t + solid[solid.length - 1].shift;
      if (lastStart < trackEnd - (typical * 1.5 + 1)) return { ok: false, why: 'not-buffered', automix: !!req.automix };
      // ...and the unbroken part must reach back far enough to cover the fade.
      if (solid[0].t + solid[0].shift > trackEnd - (req.cover || 6)) return { ok: false, why: 'short', automix: !!req.automix };

      // Start at the last segment that begins at or before the requested time.
      let first = 0;
      for (let i = 0; i < solid.length; i++) {
        if (solid[i].t + solid[i].shift <= req.needFrom) first = i; else break;
      }
      run = solid.slice(first);
    }

    // A quality switch mid-song brings a new init segment; one decode can only
    // cover segments of one format, so keep the run that reaches the end.
    if (run.length > 1) {
      let k = run.length - 1;
      while (k > 0 && run[k - 1].init === run[k].init) k--;
      run = run.slice(k);
    }
    if (!run.length || !run[0].init) return { ok: false, why: 'empty-run', automix: !!req.automix, manualSkip: !!req.manualSkip };
    const init = run[0].init;
    const total = run.reduce((n, p) => n + p.bytes.byteLength, init.byteLength);
    const blob = new Uint8Array(total);
    blob.set(init, 0);
    let at = init.byteLength;
    for (const p of run) { blob.set(p.bytes, at); at += p.bytes.byteLength; }

    let decoded;
    try {
      const offline = new OfflineAudioContext(2, 1, req.sampleRate);
      decoded = await offline.decodeAudioData(blob.buffer);
    } catch {
      return { ok: false, why: 'decode', automix: !!req.automix, manualSkip: !!req.manualSkip };
    }

    // Song might have changed while decoding.
    const again = snapshot();
    if (!again || again.id !== req.id) return { ok: false, why: 'track-changed', automix: !!req.automix, manualSkip: !!req.manualSkip };

    const channels = [];
    for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
      channels.push(decoded.getChannelData(c).slice());
    }
    return { ok: true, sampleRate: decoded.sampleRate, start: run[0].t + run[0].shift, channels, automix: !!req.automix, manualSkip: !!req.manualSkip };
  }

  function setPlayerVolume(vol) {
    try {
      const mp = moviePlayer();
      if (mp) {
        if (typeof mp.setVolume === 'function') mp.setVolume(Math.round(vol * 100));
        if (vol > 0 && typeof mp.unMute === 'function') mp.unMute();
      }
      const video = document.querySelector('video');
      if (video) video.volume = vol;
    } catch { /* ignore */ }
  }

  // Repeat-one from the player bar; from the queue store when there is no bar
  // (YouTube Music's new-layout test: see NEXT_BUTTONS in crossfade.js).
  function repeatOne() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (bar) return bar.repeatMode === 'ONE';
    try { return document.querySelector('ytmusic-player-queue')?.getState?.().queue?.repeatMode === 'ONE'; } catch { return false; }
  }

  function pressNext() {
    // (the miniplayer selectors: YouTube Music's new-layout test, untested; see crossfade.js)
    const btn = document.querySelector('ytmusic-player-bar .next-button, ytmusic-miniplayer .next-button, ytmusic-miniplayer [class*="NextButton"]');
    if (btn) btn.click();
    else moviePlayer()?.nextVideo?.();
  }


  // ───────────────────────── Dev Console Test Helpers ─────────────────────────
  window.viviTest = (type = 'lyrics', customUrl) => {
    const urls = {
      lyrics: 'https://lrclib.net/api/get?artist_name=Lady+Gaga&track_name=Poker+Face',
      sponsorblock: 'https://sponsor.ajay.app/api/skipSegments?videoID=oG-4Uvhm4lI',
      artwork: 'https://yt3.googleusercontent.com/NyFdEd7W29cZ3skSIqph5L1FkDa1ISRY0Rjwm82LqlmUuxq6MuEDUs8vLwvTUWi4PwiaJyHhjqHZ2ReT=w60-h60-l90-rj'
    };
    const testUrl = customUrl || urls[type] || type;
    say({ type: 'vivi-dev-test', testUrl });
    console.log('%c[ViVi Test]', 'color:#3b82f6;font-weight:bold;', 'Testing relay fetch for:', testUrl);
  };

  window.viviAutomixStatus = () => {
    say({ type: 'vivi-automix-status' });
  };

  // ───────────────────────── messages in ─────────────────────────
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ch !== CHANNEL || d.dir !== 'in') return;
    if (d.type === 'config') {
      capturing = !!d.enabled;
      log('capturing =', capturing, '| audio sinks seen so far:', sinks.length);
      if (!capturing) dropAll();
    } else if (d.type === 'prepare') {
      const out = await buildTail(d);
      if (!out.ok) log('buildTail failed:', out.why, '| sinks:', sinks.length, '| parts:', sinks.map((s) => s.parts.length));
      say({ type: 'tail', id: d.id, ...out });
    } else if (d.type === 'prefetch') {
      if (capturing) prefetchSong(String(d.id || ''), !!d.retry);
    } else if (d.type === 'bytes') {
      // A downloaded song for automix's analysis, waited for if still loading.
      const id = String(d.id || '');
      let f = files.get(id);
      if (f?.state === 'loading') { await f.done; f = files.get(id); }
      if (f?.state === 'ready') {
        const bytes = f.file.slice().buffer;
        window.postMessage({ ch: CHANNEL, dir: 'out', type: 'bytes', id, ok: true, bytes, musicVideo: !!f.musicVideo }, window.location.origin, [bytes]);
      } else say({ type: 'bytes', id, ok: false, why: f ? f.why || f.state : 'not downloaded' });
    } else if (d.type === 'meta') {
      const id = String(d.id || '');
      say({ type: 'meta', id, meta: songMeta(id) });
    } else if (d.type === 'seek') {
      // song time, through the player so its own state follows
      try { moviePlayer()?.seekTo?.(Number(d.t) || 0, true); } catch { /* ignore */ }
    } else if (d.type === 'pause') {
      try { moviePlayer()?.pauseVideo?.(); } catch { /* ignore */ }
    } else if (d.type === 'play') {
      try { moviePlayer()?.playVideo?.(); } catch { /* ignore */ }
    } else if (d.type === 'range') {
      // bytes crossfade.js fetched through the extension (see relayRange)
      const w = relayWait.get(d.rid);
      if (!w) return;
      relayWait.delete(d.rid);
      clearTimeout(w.timer);
      if (d.ok) w.resolve(new Response(d.bytes, { status: d.status }));
      else w.reject(new Error(d.why || 'extension fetch failed'));
    } else if (d.type === 'next') {
      pressNext();
    } else if (d.type === 'set-volume') {
      setPlayerVolume(d.volume);
    }
  });
})();

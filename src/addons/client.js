/* Vivimusic Web+ — addons/client.js (background script; node for tests)
 *
 * The addon client (spec/addons/protocol.md): BitChord-compatible addons,
 * asked in the user's priority order for a YouTube Music song.
 *
 *   const C = __viviAddonClient.create({ fetch, now, sleep, log })   (defaults: the real ones)
 *   C.discover(pastedUrl)        -> { base, manifest } or throws          (§2, discovery)
 *   C.manifest(base)             -> manifest (cached 10 min)
 *   C.search(addon, target, q)   -> raw rows (first 15; cached 10 min)
 *   C.stream(addon, row)         -> { url, codec, transport, tier, sampleRate, bitDepth, bitrate } or { miss }
 *   C.find(target, addons, opt)  -> { found: [{ addon, rows }], tried }   search only: the look-ahead
 *   C.open(found, target, opt)   -> { addon, row, stream } or { none, tried }   /stream + probe, just before use
 *   C.resolve(target, addons, opt) -> find, then open
 *        addons: [{ base, quality? }] in priority order (on ones only)
 *        opt: { slackSec, tier ('LOSSLESS' (the best) | 'HIRES' | 'CD' | 'HIGH' | 'LOW') }
 *   C.health()                   -> { [host]: { fails, coolUntil, last, ms } }
 *
 * An addon's URL holds its owner's token: logs show only the host (redact).
 * globalThis.__viviAddonClient
 */
(() => {
  'use strict';
  const Pick = globalThis.__viviAddonPick || (typeof require === 'function' ? require('./pick.js') : null);
  const M = globalThis.__viviTrackMatcher || (typeof require === 'function' ? require('./track-matcher.js') : null);

  // No User-Agent of our own, and no setting for one: the browser's normal one goes out (§1).
  const TIMEOUT_MS = 45000;
  const PROBE_TIMEOUT_MS = 4000;
  const TTL = { manifest: 10 * 60e3, search: 10 * 60e3, stream: 5 * 60e3 };
  const CACHE_MAX = 128;
  const RETRIES_429 = 2;
  // health: this many failures in a row (not misses) put an addon to rest, 2 min doubling to 30 min
  const FAILS_TO_REST = 3, REST_MS = 2 * 60e3, REST_MAX_MS = 30 * 60e3;
  const ATMOS = /atmos|dolby|eac3[_-]?joc|ec-?3/i;
  // §4a stream limits (TorBox-backed addons): unless the manifest says otherwise
  const LIMITS = { streamsPerMinute: 5, uncachedPerHour: 60, cachedMarker: 'cached' };
  const NEEDS_OFFICIAL = 'needs official BitChord';

  const text = (v) => (v == null ? '' : String(v));
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  const redact = (u) => { try { const x = new URL(u); return x.host; } catch { return '(addon)'; } };
  // any URL inside a text (an error message, say) as its host: links hold tokens
  // A place a remote addon may not send the background (§1, §4: https only, never this machine). Checked on
  // the answer's final URL too: an extension's fetch can't read a redirect's Location (redirect: 'manual' gives
  // an opaque answer), so a hop to such a place is refused before anything of its answer is read or used.
  // (An addon on this machine, the tests' mock server, may use plain http on it.)
  // (by the parsed host, every spelling of this machine: all of 127/8 (2130706433 and 0x7f.1 parse to it),
  // 0.0.0.0, localhost and its subdomains, a trailing dot, [::1], [::] and IPv4-mapped loopback)
  const isLocal = (u) => {
    let h;
    try { const x = new URL(text(u)); if (!/^https?:$/.test(x.protocol)) return false; h = x.hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
    return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0'
      || h === '[::1]' || h === '[::]' || /^\[::ffff:(127\.|0\.0\.0\.0|7f[0-9a-f]{2}:|0:0\])/.test(h);
  };
  function offLimits(base, url) {
    if (!url || !base || isLocal(base)) return null;
    if (!/^https:/i.test(url)) return 'not https';
    if (isLocal(url)) return 'points at this machine';
    return null;
  }
  // A fetch whose every redirect hop is checked before it is sent (protocol.md §1, §4): Firefox's blocking
  // webRequest (fx-headers.js __viviHopWatch) cancels a hop off https or to this machine before it
  // connects. Where there is none (the Chromium build) only the final URL is checked, by the callers.
  function guarded(doFetch, base) {
    return async (url, opt) => {
      const release = globalThis.__viviHopWatch?.add?.(url, base, offLimits) || (() => {});
      try { return await doFetch(url, opt); } finally { release(); }
    };
  }
  const scrub = (t) => text(t).replace(/https?:\/\/[^\s'"<>)]+/gi, (u) => redact(u));

  class AddonError extends Error {
    // kind: 'miss' (404, an error field: next source, not a fault), 'down' (5xx, timeout, network),
    // 'error' (other 4xx, a bad body: permanent)
    constructor(kind, message, status = null) { super(scrub(message)); this.kind = kind; this.status = status; }
  }

  // §2: trim, no trailing '/', no final *.json segment, token segments kept
  function baseOf(url) {
    let u = text(url).trim().replace(/\/+$/, '');
    u = u.replace(/\/[^/]*\.json$/i, '');
    return u.replace(/\/+$/, '');
  }
  function sameAddon(a, b) {
    try {
      const x = new URL(baseOf(a)), y = new URL(baseOf(b));
      return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && x.pathname === y.pathname;
    } catch { return false; }
  }
  const flag = (v, def) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = text(v).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(s) ? true : ['0', 'false', 'no', 'off'].includes(s) ? false : def;
  };
  function readManifest(j) {
    if (!j || typeof j !== 'object' || !text(j.id).trim()) return null;
    const resources = (Array.isArray(j.resources) ? j.resources : []).map((r) => text(r).toLowerCase());
    return {
      id: text(j.id), name: text(j.name) || text(j.id), version: text(j.version), resources,
      usable: !resources.length || resources.includes('search'),
      settings: (Array.isArray(j.settings) ? j.settings : []).filter((s) => s && text(s.key)).map((s) => ({
        key: text(s.key), default: s.default, options: (Array.isArray(s.options) ? s.options : []).map((o) => ({ value: o?.value, label: text(o?.label) || text(o?.value) })),
      })),
      allowDownloads: flag(j.allowDownloads, true),
      needsOfficial: flag(j.bitchordAuth, false),   // signed by the official app only: unsupported
      limits: readLimits(j.limits),
    };
  }
  function readLimits(l) {
    const pos = (v, d) => { const n = num(v); return n != null && n >= 1 ? Math.floor(n) : d; };
    return {
      streamsPerMinute: pos(l?.streamsPerMinute, LIMITS.streamsPerMinute),
      uncachedPerHour: pos(l?.uncachedPerHour, LIMITS.uncachedPerHour),
      cachedMarker: text(l?.cachedMarker).trim() || LIMITS.cachedMarker,
    };
  }
  const looksLikeManifest = (j) => j && typeof j === 'object' && (Array.isArray(j.resources) || (text(j.id) && (j.name != null || j.version != null)));

  // §1: settings' defaults in order, then quality; atmos=false in place of a declared atmos default (ours)
  // tiers: LOSSLESS (the addon's best: its first option), HIRES, CD, HIGH, LOW
  // (sample rates only with their unit, so "96 kbps" is never Hi-Res; lossy options never count)
  const WANT = { HIRES: /hi[\s_-]?res|24[\s-]?bit|(192|176\.4|96|88\.2)\s*k\s*hz/i, CD: /\bcd\b|16[\s-]?bit|44\.1\s*k\s*hz/i };
  const LOSSY = /kbps|mp3|aac|opus|vorbis|\bogg\b/i;
  function paramsFor(manifest, tier = 'LOSSLESS', picked = null) {
    const out = [];
    for (const s of manifest?.settings || []) {
      if (s.key === 'quality') continue;
      if (s.key.toLowerCase() === 'atmos') { out.push(['atmos', 'false']); continue; }
      if (s.default !== undefined && s.default !== null) out.push([s.key, text(s.default)]);
    }
    const q = (manifest?.settings || []).find((s) => s.key === 'quality');
    let quality = WANT[tier] ? 'LOSSLESS' : tier;
    if (q && q.options.length) {
      const vals = q.options.map((o) => text(o.value));
      if (tier === 'LOSSLESS') quality = picked != null && vals.includes(text(picked)) ? text(picked) : vals[0];
      // Hi-Res or CD: the option that names it, else (CD) one called "lossless", else the first
      else if (WANT[tier]) quality = vals.find((v, i) => { const l = text(q.options[i].label); return !LOSSY.test(v) && !LOSSY.test(l) && (WANT[tier].test(v) || WANT[tier].test(l)); }) ?? (tier === 'CD' ? vals.find((v) => v.toLowerCase() === 'lossless') : null) ?? vals[0];
      else {
        const re = tier === 'LOW' ? /low|96|128|min/i : /high|320|normal|standard/i;
        const by = (r) => vals.find((v, i) => r.test(v) || r.test(text(q.options[i].label)));
        // (Low with no low option: the high one, else the last, which addons list as the smallest)
        quality = vals.find((v) => v.toUpperCase() === tier) ?? by(re) ?? (tier === 'LOW' ? by(/high|320|normal|standard/i) ?? vals[vals.length - 1] : vals[0]);
      }
    }
    out.push(['quality', quality]);
    return out;
  }
  const qs = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  function create({ fetch: doFetch = globalThis.fetch?.bind(globalThis), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
    const cache = new Map();      // key -> { until, value }
    const inflight = new Map();   // key -> promise
    const quietUntil = new Map(); // base -> time (a 429's window)
    const healthOf = new Map();   // base -> { fails, coolUntil, rest, last, ms }
    const budgets = new Map();    // base -> { calls: [t], uncached: [t], perMinute (learned), until }

    const cached = (key) => { const e = cache.get(key); if (!e) return undefined; if (e.until < now()) { cache.delete(key); return undefined; } return e.value; };
    const remember = (key, value, ttl) => {
      cache.delete(key);
      cache.set(key, { until: now() + ttl, value });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    };
    // one request for identical calls in flight, cached on success (`keep`: which answers count as one, §6)
    function shared(key, ttl, make, keep = () => true) {
      const hit = cached(key);
      if (hit !== undefined) return Promise.resolve(hit);
      if (inflight.has(key)) return inflight.get(key);
      const p = make().then((v) => { if (keep(v)) remember(key, v, ttl); return v; }).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }

    // One GET of JSON, §1 and §5. Resolves the body; throws AddonError.
    // a response body read up to `max` bytes (more: cancelled, null); into one array sized by
    // Content-Length when there is one, else gathered. Without a stream body (tests' mocks): read whole.
    async function readCapped(r, max) {
      if (!r.body?.getReader) { const b = r.arrayBuffer ? await r.arrayBuffer() : new TextEncoder().encode(await r.text()).buffer; return b.byteLength > max ? null : b; }
      const rd = r.body.getReader(), len = Number(r.headers?.get?.('content-length')) || 0;
      let one = len > 0 && len <= max ? new Uint8Array(len) : null, parts = [], n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (n + value.byteLength > max) { try { await rd.cancel(); } catch { /* gone */ } return null; }
        if (one && n + value.byteLength <= one.length) one.set(value, n); else { if (one) { parts.push(one.subarray(0, n)); one = null; } parts.push(value); }
        n += value.byteLength;
      }
      if (one) return n === one.length ? one.buffer : one.slice(0, n).buffer;
      const out = new Uint8Array(n); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return out.buffer;
    }
    const JSON_MAX_BYTES = 4e6;
    async function getJson(base, url, { manifest = false, retry429 = true } = {}) {
      for (let attempt = 0; ; attempt++) {
        const wait = (quietUntil.get(base) ?? 0) - now();
        if (wait > 0) await sleep(wait);
        let r, body = null;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);   // (until the body is read too)
        try {
          r = await guarded(doFetch, base)(url, { headers: { Accept: 'application/json' }, signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
          const off = offLimits(base, r.url);
          if (off) { try { await r.body?.cancel?.(); } catch { /* gone */ } throw new AddonError('error', `redirected: ${off}`); }
          if (r.status < 400 && r.status !== 429) {
            const b = await readCapped(r, JSON_MAX_BYTES);
            if (!b) throw new AddonError('error', 'answer too big');
            body = new TextDecoder().decode(b);
          } else if (r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 429) {
            // (a refusal's detail: read while the timeout still runs, and capped)
            const b = await readCapped(r, 16384).catch(() => null);
            body = b ? new TextDecoder().decode(b) : '';
          }
        } catch (e) {
          if (e instanceof AddonError) throw e;
          throw new AddonError('down', ctl.signal.aborted ? 'timed out' : `network: ${e?.message || e}`);
        } finally { clearTimeout(timer); }
        if (r.status === 429) {
          const ra = num(r.headers.get('retry-after'));
          const ms = Math.min(8000, Math.max(500, ra != null ? ra * 1000 : 500 << attempt));
          quietUntil.set(base, now() + ms);
          if (!retry429 || attempt >= RETRIES_429) throw Object.assign(new AddonError('down', 'rate limited (429)', 429), { retryAfterSec: ra });
          continue;
        }
        if (r.status === 404) throw new AddonError(manifest ? 'error' : 'miss', 'not found (404)', 404);
        if (r.status >= 500) throw new AddonError('down', `server error (${r.status})`, r.status);
        if (r.status >= 400) {
          let detail = '';
          try { detail = text(JSON.parse(body || '')?.detail).slice(0, 120); } catch { /* not JSON */ }
          throw new AddonError('error', `refused (${r.status})${detail ? ': ' + detail : ''}`, r.status);
        }
        if (!body.trim()) throw new AddonError('error', 'empty answer', r.status);
        try { return JSON.parse(body); } catch { throw new AddonError('error', 'not JSON', r.status); }
      }
    }

    function manifest(base) {
      return shared('m|' + base, TTL.manifest, async () => {
        const m = readManifest(await getJson(base, base + '/manifest.json', { manifest: true }));
        if (!m) throw new AddonError('error', 'not an addon manifest');
        return m;
      });
    }

    // §2 discovery from a pasted URL
    async function discover(pasted) {
      const raw = text(pasted).trim().replace(/\/+$/, '');
      const base = baseOf(raw);
      const tries = /\.json$/i.test(new URL(raw).pathname) ? [raw, base + '/manifest.json'] : [raw + '/manifest.json', raw];
      let last = null;
      for (const u of tries) {
        try {
          const j = await getJson(base, u, { manifest: true });
          if (looksLikeManifest(j)) {
            const m = readManifest(j);
            if (m?.needsOfficial) throw new AddonError('error', NEEDS_OFFICIAL);
            if (m) { remember('m|' + base, m, TTL.manifest); return { base, manifest: m }; }
          }
        } catch (e) { if (e.message === NEEDS_OFFICIAL) throw e; last = last && last.status !== 404 ? last : e; }   // (a 403's reason beats a later 404)
      }
      try {   // last resort: a search answers
        const j = await getJson(base, base + '/search?q=music');
        if (j && Array.isArray(j.tracks)) {
          const host = new URL(base).host;
          const m = { id: base, name: host, version: '', resources: ['search', 'stream'], usable: true, settings: [], allowDownloads: true, needsOfficial: false, limits: readLimits(null) };
          remember('m|' + base, m, TTL.manifest);
          return { base, manifest: m };
        }
      } catch (e) { last = last && last.status !== 404 ? last : e; }
      throw last || new AddonError('error', 'no addon there');
    }

    function search(addon, target, query, man) {
      const params = paramsFor(man, addon.tier, addon.quality);
      const extra = [];
      const title = text(target?.title).trim(), artist = text(target?.artist).trim();   // §3: trimmed
      if (title) extra.push(['title', title]);
      if (artist) extra.push(['artist', artist]);
      const q = text(query).trim();
      if (q) extra.push(['q', q]);
      const url = `${addon.base}/search?${qs([...params, ...extra])}`;
      return shared('s|' + url, TTL.search, async () => {
        const j = await getJson(addon.base, url);
        if (j?.error) throw new AddonError('miss', text(j.error).slice(0, 120));
        return (Array.isArray(j?.tracks) ? j.tracks : []).slice(0, 15);
      });
    }

    // §4: the stream answer, read leniently
    function readStream(j, marker = LIMITS.cachedMarker) {
      const url = text(j?.url).trim();
      if (!url || j?.error) return { miss: scrub(j?.error).slice(0, 120) || 'no url' };   // (an addon's own text may hold its link)
      // https only, never probed otherwise (plain http to this machine: the PC's tests' mock server)
      if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return { miss: 'not https' };
      const enc = j.encrypted;
      if (!(enc === false || enc == null || text(enc).trim() === '' || text(enc).toLowerCase() === 'none' || text(enc).toLowerCase() === 'false')) return { miss: 'encrypted' };
      const quality = text(j.quality ?? j.streamQuality ?? j.audioQuality);
      // (never the URL: its path or token could read as numbers)
      const all = [j.format, quality, j.codec, j.fileCodec, j.container, j.containerFormat, j.mimeType, j.manifest, j.mediaType, j.audioMode].map(text).join(' ');
      if (ATMOS.test([j.codec, j.audioMode, j.format, quality].map(text).join(' '))) return { miss: 'atmos' };
      // transport: the URL path's extension and the answer's own format fields, never words inside
      // the host, query or a token (a progressive /Dashboard.flac or ?t=..mpd.. is a file)
      const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
      const fields = [j.format, quality, j.codec, j.fileCodec, j.container, j.containerFormat, j.mimeType, j.manifest, j.mediaType].map(text).join(' ');
      const transport = /\.m3u8$/.test(path) || /\b(hls|m3u8)\b|mpegurl/i.test(fields) ? 'hls'
        : /\.mpd$/.test(path) || /\b(dash|mpd)\b|dash\+xml/i.test(fields) ? 'dash' : 'file';
      let sampleRate = num(j.sampleRate) ?? num(all.match(/([\d.]+)\s*kHz/i)?.[1]);
      if (sampleRate != null && sampleRate < 1000) sampleRate *= 1000;
      const bitDepth = num(j.bitDepth) ?? num(all.match(/(\d{1,2})\s*-?bit/i)?.[1]);
      const tier = Pick.tierOf(`${text(j.format)} ${quality} ${text(j.codec)}`);
      let bitrate = num(j.bitrate) ?? num(all.match(/(\d{2,4})\s*kbps/i)?.[1]);
      if (bitrate != null && bitrate > 3000) bitrate /= 1000;
      if (bitrate == null) bitrate = tier === 'HIGH' ? 320 : tier === 'LOW' ? 128 : null;
      // audio extensions only (an .m3u8 is not a codec)
      const ext = (() => { try { return new URL(url).pathname.match(/\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac)$/i)?.[1]?.toLowerCase() ?? null; } catch { return null; } })();
      const codec = text(j.codec || j.fileCodec).toLowerCase() || (text(j.container || j.containerFormat).toLowerCase().match(/flac|wav|mp3|aiff/)?.[0])
        || (text(j.mimeType).split('/')[1]?.toLowerCase() || null) || (tier === 'LOSSLESS' ? 'flac' : null) || ext;
      // §4: the headers the addon wants on the file request, strings only; nothing else is sent with it.
      // One fixed User-Agent (the user's rule) and our own Range and Accept-Encoding: an addon's are dropped.
      const headers = {};
      if (j.headers && typeof j.headers === 'object' && !Array.isArray(j.headers)) {
        for (const [k, v] of Object.entries(j.headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /^(user-agent|range|accept-encoding)$/i.test(k)) continue;
          if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v);
        }
      }
      return { url, codec, transport, tier, sampleRate, bitDepth, bitrate, mimeType: text(j.mimeType) || null, headers, cached: flag(j[marker], false) };
    }
    // §4a: /stream calls are counted per addon (a minute and an hour window); a 429 on /stream
    // lowers the per-minute count to what got through and waits it out. Not a failure: kind 'limit'.
    function budgetOf(base, man) {
      const b = budgets.get(base) ?? { calls: [], uncached: [], perMinute: null, until: 0 };
      const t = now();
      b.calls = b.calls.filter((x) => x > t - 60e3);
      b.uncached = b.uncached.filter((x) => x > t - 3600e3);
      budgets.set(base, b);
      const perMinute = Math.min(man.limits?.streamsPerMinute ?? LIMITS.streamsPerMinute, b.perMinute ?? Infinity);
      let wait = 0;
      if (b.until > t) wait = b.until - t;
      else if (b.calls.length >= perMinute) wait = b.calls[0] + 60e3 - t;
      else if (b.uncached.length >= (man.limits?.uncachedPerHour ?? LIMITS.uncachedPerHour)) wait = b.uncached[0] + 3600e3 - t;
      return { b, wait };
    }
    // a plain-http file on this machine only from an addon that is on it too (the tests' mock server):
    // a remote addon may not point the background at localhost
    // (an https link to this machine too: offLimits)
    function local(base, s) { const off = s.url && offLimits(base, s.url); return off ? { miss: off } : s; }
    function streamWait(addon, man) { return budgetOf(baseOf(addon.base), man).wait; }
    function stream(addon, row, man) {
      // (counted and asked on the addon's base: a pasted link's trailing '/' is the same addon, §4a)
      const base = baseOf(addon.base);
      const url = `${base}/stream/${encodeURIComponent(row.id)}?${qs(paramsFor(man, addon.tier, addon.quality))}`;
      // a miss is not kept (§6: failures, 404s included, are not cached); it may be asked again
      return shared('t|' + url, TTL.stream, async () => {
        const { b, wait } = budgetOf(base, man);
        if (wait > 0) throw new AddonError('limit', `stream limit, free in ${Math.ceil(wait / 1000)} s`);
        b.calls.push(now());
        try {
          const j = await getJson(base, url, { retry429: false });
          // §4: a blank url or an error field is a miss like a 404: the row's streamURL, else the next source
          if ((!text(j?.url).trim() || j?.error) && row.streamURL) return local(base, readStream({ url: row.streamURL }));
          const s = local(base, readStream(j, man.limits?.cachedMarker));
          if (!s.cached) b.uncached.push(now());
          return s;
        } catch (e) {
          if (e.status === 429) {
            b.perMinute = Math.max(1, b.calls.length - 1);
            b.until = now() + Math.max(1, Math.min(3600, e.retryAfterSec ?? 60)) * 1000;
            throw new AddonError('limit', `stream limit (429), ${b.perMinute}/min from now on`);
          }
          if (e.kind === 'miss' && row.streamURL) return local(base, readStream({ url: row.streamURL }));
          throw e;
        }
      }, (s) => !s?.miss);
    }

    // §7: Range bytes=0-0 (4 s); the file must hold the whole song
    // (fetch itself adds Accept-Encoding: identity to a Range request)
    // a server error or timeout on the probe is read once more before the row counts as refused (a passing fault)
    async function probe(url, row, songSec, slackSec, headers = {}, base = null) {
      const p = await probeOnce(url, row, songSec, slackSec, headers, base);
      return p.retry ? probeOnce(url, row, songSec, slackSec, headers, base).then((q) => (q.retry ? { ok: false, why: q.why } : q)) : p;
    }
    async function probeOnce(url, row, songSec, slackSec, headers, base) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      try {
        const r = await guarded(doFetch, base)(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
        try { await r.body?.cancel?.(); } catch { /* already read */ }
        const off = offLimits(base, r.url);
        if (off) return { ok: false, why: `stream redirected: ${off}` };
        if (r.status >= 500 || r.status === 408) return { ok: false, retry: true, why: `stream answered ${r.status}` };
        if (r.status >= 400) return { ok: false, why: `stream answered ${r.status}` };
        return Pick.probeVerdict({ status: r.status, contentRange: r.headers.get('content-range'), contentLength: r.headers.get('content-length') }, row, songSec, slackSec);
      } catch { return { ok: true }; } finally { clearTimeout(timer); }   // unmeasurable: not refused
    }

    function note(base, ok, last, ms) {
      const h = healthOf.get(base) ?? { fails: 0, coolUntil: 0, rest: REST_MS, last: '', ms: null };
      if (ok === true) { h.fails = 0; h.rest = REST_MS; }
      else if (ok === false && ++h.fails >= FAILS_TO_REST) { h.coolUntil = now() + h.rest; h.rest = Math.min(REST_MAX_MS, h.rest * 2); h.fails = 0; }
      h.last = last; h.ms = ms ?? h.ms;
      healthOf.set(base, h);
    }

    // Look-ahead (§8): search and pick only, every addon at once (§8.1.4), listed in priority order.
    // No /stream calls, so it is safe for the next song. -> { found: [{ addon, rows }], tried }
    async function find(target, addons, opt = {}) {
      const lanes = addons.map(() => []);
      const got = await Promise.all(addons.map((a, i) => findOne(a, target, opt, lanes[i])));
      return { found: got.filter(Boolean), tried: lanes.flat() };
    }
    // one addon's search and pick -> { addon, rows } or null (why in `tried`)
    async function findOne(a, target, { slackSec = 5, tier = 'LOSSLESS' } = {}, tried) {
      const addon = { tier, ...a, base: baseOf(a.base) };
      const host = redact(addon.base);
      const h = healthOf.get(addon.base);
      if (h && h.coolUntil > now()) { tried.push({ addon: host, why: 'resting after failures' }); return null; }
      const t0 = now();
      try {
        const man = await manifest(addon.base);
        if (man.needsOfficial) { tried.push({ addon: host, why: NEEDS_OFFICIAL }); return null; }
        if (!man.usable) { tried.push({ addon: host, why: 'no search' }); return null; }
        let open = [], refused = [];
        for (const q of M.queries(target)) {
          ({ open, refused } = Pick.rowsToOpen(await search(addon, target, q, man), target, { slackSec }));
          if (open.length) break;
        }
        note(addon.base, true, open.length ? 'ok' : 'no match', now() - t0);
        if (!open.length) { tried.push({ addon: host, why: 'no match', refused }); return null; }
        return { addon: { ...addon, name: man.name, host }, rows: open };
      } catch (e) { failed(addon.base, host, e, t0, tried); return null; }
    }

    // Just before the song is needed: /stream and the probe, the addons raced (§8.1.4), each with
    // its own rows in its own order. -> { addon, row, stream, tried } or { none, tried }
    function open(found, target, opt = {}, tried = []) {
      return race(found.map(({ addon, rows }) => (tr, over) => openOne(addon, rows, target, opt, tr, over)), tried);
    }
    // one addon's rows, in order, until one opens and passes the probe -> { addon, row, stream } or null
    // over(): the race is decided (§8.1.4): no further /stream call or probe
    async function openOne(addon, rows, target, { slackSec = 5, accept = null } = {}, tried, over = () => false) {
      const t0 = now();
      try {
        const man = await manifest(addon.base);
        for (const row of rows) {
          if (over()) return null;
          const s = await stream(addon, row, man).catch((e) => (e.kind === 'miss' ? { miss: e.message } : Promise.reject(e)));
          if (s.miss) { tried.push({ addon: addon.host, row: row.id, why: s.miss }); continue; }
          if (!['file', 'hls', 'dash'].includes(s.transport)) { tried.push({ addon: addon.host, row: row.id, why: `${s.transport} (not played here)` }); continue; }
          // the caller's own bar (the lossy floor, the upgrade pass: protocol.md 8.2.1): true, or why not
          const want = accept ? accept(s) : true;
          if (want !== true) { tried.push({ addon: addon.host, row: row.id, why: want || 'not wanted' }); continue; }
          if (over()) return null;
          // (an HLS or DASH row: no probe; a playlist's size says nothing of the song's length, and its
          // segments are read when the background puts them together into one file, §8.1.5)
          const p = s.transport !== 'file' ? { ok: true } : await probe(s.url, { ...row, tier: s.tier ?? row.tier, kbps: s.bitrate ?? row.kbps }, target.durationSec, slackSec, s.headers, addon.base);
          if (!p.ok) { tried.push({ addon: addon.host, row: row.id, why: p.why }); continue; }
          note(addon.base, true, 'ok', now() - t0);
          log(`addons: ${man.name} (${addon.host}) has it: row ${row.id}, ${s.codec || '?'}${s.sampleRate ? ' ' + s.sampleRate / 1000 + ' kHz' : ''}${s.bitDepth ? '/' + s.bitDepth : ''}`);
          return { addon: { base: addon.base, name: man.name, host: addon.host, id: addon.id, quality: addon.quality ?? null }, row, stream: s };
        }
      } catch (e) {
        if (e.kind === 'limit') { tried.push({ addon: addon.host, why: e.message }); return null; }   // not a fault
        failed(addon.base, addon.host, e, t0, tried);
      }
      return null;
    }

    // §8.1.4: every lane at once; the first playable answer wins, and of answers ready in the same
    // turn the higher-ranked addon's. Then the losers stop: a lane still searching never sends its
    // /stream (each /stream can add the song to the user's debrid account); one already sent runs out.
    // `tried` gets each lane's misses in rank order, as far as they have got.
    function race(lanes, tried) {
      const own = lanes.map(() => []), got = lanes.map(() => undefined);
      let left = lanes.length, settled = false, waiting = false;
      return new Promise((resolve) => {
        const decide = () => {
          if (settled) return;
          const i = got.findIndex((r) => r?.addon);
          if (i < 0 && left) return;
          settled = true;
          tried.push(...own.flat());
          resolve(i < 0 ? { none: 'no addon has it', tried } : { ...got[i], tried });
        };
        if (!left) decide();
        const over = () => settled;
        lanes.forEach((lane, i) => lane(own[i], over).catch(() => null).then((r) => {
          got[i] = r || null; left--;
          if (r?.addon && !waiting) { waiting = true; sleep(0).then(decide); } else if (!left) decide();
        }));
      });
    }

    function failed(base, host, e, t0, tried) {
      const kind = e instanceof AddonError ? e.kind : 'error';
      note(base, kind === 'miss' ? null : false, e.message, now() - t0);
      tried.push({ addon: host, why: scrub(e.message) });
      log(`addons: ${host}: ${scrub(e.message)}`);
    }

    // The addons raced end to end (each its search, then its rows); the first playable answer,
    // the higher-ranked of those ready together (§8.1.4).
    function resolve(target, addons, opt = {}) {
      return race(addons.map((a) => async (tr, over) => { const f = await findOne(a, target, opt, tr); return f && !over() ? openOne(f.addon, f.rows, target, opt, tr, over) : null; }), []);
    }

    // protocol.md 8.1.7, "Upgrade quality": a song's search answers (empty ones too) and the /stream
    // answers of its rows are forgotten, so the next ask goes to the addons again
    function forget(target, found = []) {
      // each a whole parameter of the search URL: forgetting "Love" keeps "Love Story"
      const marks = [['title', text(target?.title).trim()], ['artist', text(target?.artist).trim()]].filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v));
      const rows = new Set(found.flatMap((f) => (f.rows || []).map((r) => '/stream/' + encodeURIComponent(r.id) + '?')));
      let n = 0;
      for (const k of [...cache.keys()]) {
        const drop = (k.startsWith('s|') && marks.length && marks.every((m) => ['?', '&'].some((c) => (k + '&').includes(c + m + '&')))) || (k.startsWith('t|') && [...rows].some((r) => k.includes(r)));
        if (drop) { cache.delete(k); n++; }
      }
      return n;
    }

    const health = () => Object.fromEntries([...healthOf].map(([b, h]) => [redact(b), { ...h }]));
    // one addon's health, by its base: two addons on one host (two TorBox tokens) each their own (§2)
    const healthFor = (base) => { const h = healthOf.get(base) ?? healthOf.get(baseOf(base)); return h ? { ...h } : null; };
    return { discover, manifest, search, stream, streamWait, probe, find, open, resolve, forget, health, healthFor, paramsFor, readStream };
  }

  const api = { create, baseOf, sameAddon, paramsFor, readManifest, redact, AddonError, scrub, offLimits, guarded };
  globalThis.__viviAddonClient = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

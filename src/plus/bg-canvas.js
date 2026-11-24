// Vivimusic Web+: Spotify Canvas without a Spotify login, as on the phone (SpotifyCanvas.java,
// Metrolist's DirectCanvasProvider): an anonymous web-player token (TOTP), the client token,
// Spotify's search (pathfinder searchTopResultsList), Metrolist's match rules, and the canvas from
// Spotify's own pathfinder `canvas` query (Metrolist 460a3168a; the public mirror now answers 402).
// Only https scdn.co media is taken.
//
// Loaded after spotify.js and background.js. It wraps upstream's spotifyCanvasForTrack (a global
// function, called by background.js for VIVI_SPOTIFY_CANVAS), so upstream's file is unchanged:
// only the no-login lookup runs: Spotify's canvas is anonymous only (canvas.md §13 rule 9), so
// upstream's signed-in lookup is never called.

'use strict';

const viviSpotifyCanvas = (() => {
  const TOKEN_URL = 'https://open.spotify.com/api/token';
  const CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken';
  const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
  const SEARCH_HASH = '12d940b3f7381506a82ff5382eb59b0ed65118656e6bcdfbe4cebc528f75d29d';
  const CANVAS_HASH = '575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f';
  const APP_VERSION = '1.2.96.390.gd46a85db';
  const WEB_CLIENT_ID = 'd8a5ed958d274c2e8ee717e6a4b0971d';
  // spotlib's Totp: the web player's secret (obfuscated), version 61, 30 s steps
  const TOTP_SECRET = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
  const TOTP_VERSION = 61;
  const TIMEOUT_MS = 8000;
  const MISS_MS = 24 * 3600e3;

  let accessToken = null, accessExpires = 0, clientToken = null;
  const deviceId = crypto.randomUUID();
  const misses = new Map();   // song key -> time of the miss (24 h, in memory)

  async function totp(nowMs) {
    // the xor'd values joined as decimal digits (spotlib Totp.kt: joinToString), not as characters
    let raw = '';
    for (let i = 0; i < TOTP_SECRET.length; i++) raw += String(TOTP_SECRET.charCodeAt(i) ^ (i % 33 + 9));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(raw), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const counter = Math.floor(nowMs / 1000 / 30);
    const data = new Uint8Array(8);
    new DataView(data.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
    new DataView(data.buffer).setUint32(4, counter >>> 0);
    const d = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
    const off = d[d.length - 1] & 0x0f;
    const bin = ((d[off] & 0x7f) << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3];
    return String(bin % 1e6).padStart(6, '0');
  }

  async function get(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', ...init, signal: ctl.signal });
    } finally { clearTimeout(t); }
  }

  async function auth() {
    if (!accessToken || Date.now() > accessExpires - 60e3) {
      const ask = (code, ver) => get(`${TOKEN_URL}?reason=init&productType=web-player&totp=${code}&totpServer=${code}&totpVer=${ver}`,
        { headers: { Accept: '*/*' } });
      let r = await ask(await totp(Date.now()), TOTP_VERSION);
      // the phone's secret is refused: the newest one from upstream's list (spotify.js)
      if (r.status === 400 && typeof getSecretDict === 'function' && typeof makeTotp === 'function') {
        const dict = await getSecretDict();
        const ver = Object.keys(dict).map(Number).sort((x, y) => y - x)[0];
        if (ver) r = await ask(await makeTotp(dict[String(ver)], Math.floor(Date.now() / 1000)), ver);
      }
      if (!r.ok) throw new Error(`/api/token: HTTP ${r.status}`);
      const t = await r.json();
      if (!t.accessToken) throw new Error('/api/token: no access token');
      accessToken = t.accessToken;
      accessExpires = t.accessTokenExpirationTimestampMs || Date.now() + 30 * 60e3;
      clientToken = null;
    }
    if (!clientToken) {
      const r = await get(CLIENT_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_data: { client_version: APP_VERSION, client_id: WEB_CLIENT_ID, js_sdk_data: {
          device_brand: 'unknown', device_model: 'unknown', os: 'windows', os_version: 'unknown', device_id: deviceId, device_type: 'computer' } } }),
      });
      if (!r.ok) throw new Error(`clienttoken: HTTP ${r.status}`);
      const token = (await r.json())?.granted_token?.token;
      if (!token) throw new Error('clienttoken: no token');
      clientToken = token;
    }
  }

  // a pathfinder persisted query with the anonymous tokens: an expired session (401) drops both
  // tokens and asks once more; a rate limit (429) or any other error fails the lookup (canvas.md §4 rule 5)
  async function query(operationName, sha256Hash, variables) {
    const body = JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await auth();
      const r = await get(PATHFINDER_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8',
          'app-platform': 'WebPlayer', 'spotify-app-version': APP_VERSION,
          Authorization: `Bearer ${accessToken}`, 'client-token': clientToken,
        },
        body,
      });
      if (r.status === 401 && attempt === 0) { accessToken = clientToken = null; continue; }
      if (r.status >= 400) throw new Error(`${operationName}: HTTP ${r.status}`);
      const data = await r.json();
      if (data.errors) throw new Error(`${operationName}: GraphQL errors`);
      return data;
    }
    throw new Error(`${operationName}: session expired`);
  }

  // Metrolist's trustedMedia for Spotify: https on 443, no user info, a scdn.co host
  function trusted(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443')
        && (host === 'scdn.co' || host.endsWith('.scdn.co'));
    } catch { return false; }
  }

  const NOISE = new Set(['feat', 'ft', 'featuring', 'official', 'video', 'audio']);
  function words(value) {
    const s = String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
    return new Set(s.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !NOISE.has(w)));
  }
  function similarity(a, b) {
    const x = words(a), y = words(b);
    if (!x.size || !y.size) return 0;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / Math.max(x.size, y.size);
  }
  const same = (a, b) => a.size === b.size && [...a].every((w) => b.has(w));

  // Metrolist's DirectCanvasProvider.matches: the artist (or the primary one) exactly, title words 75%,
  // lengths (ms) within 10 s and album words 50%, each only when both sides know it
  function matches(title, artist, album, duration, foundTitle, foundArtist, foundAlbum, foundDuration, primary, foundPrimary) {
    const want = words(artist), got = words(foundArtist), wantP = words(primary), gotP = words(foundPrimary);
    if (!want.size || !(same(want, got) || (wantP.size && same(wantP, gotP)))) return false;
    return similarity(title, foundTitle) >= 0.75
      && (!(duration > 0) || foundDuration == null || Math.abs(duration - foundDuration) <= 10000)
      && (!String(album || '').trim() || !String(foundAlbum || '').trim() || similarity(album, foundAlbum) >= 0.5);
  }

  // the canvas URL in a pathfinder `canvas` answer, when trusted (Metrolist's spotifyTrackCanvas)
  function canvasOf(answer) {
    const url = answer?.data?.trackUnion?.canvas?.url;
    return typeof url === 'string' && trusted(url) ? url : null;
  }
  // the track's canvas, asked of Spotify (canvas.md §4 rule 5)
  async function trackCanvas(trackId) {
    if (!/^[A-Za-z0-9]{22}$/.test(trackId)) return null;
    return canvasOf(await query('canvas', CANVAS_HASH, { trackUri: `spotify:track:${trackId}` }));
  }

  // Metrolist's spotifyCanvas: the first matching track among the top 10 results that has a canvas
  async function canvasUrl(title, artist, album, durationMs) {
    const primary = artist.split(/\s*(?:,|&| x | X |\bfeat\.?|\bft\.?)\s*/)[0].trim();
    const search = await query('searchTopResultsList', SEARCH_HASH, {
      query: `${title} ${artist}`, limit: 10, offset: 0, numberOfTopResults: 10,
      includeArtistHasConcertsField: false, includeAudiobooks: true, includeAuthors: false,
      includePreReleases: true, includeAlbumPreReleases: false, includeEpisodeContentRatingsV2: true,
      sectionFilters: ['GENERIC', 'VIDEO_CONTENT'],
    });
    const items = search?.data?.searchV2?.topResultsV2?.itemsV2;
    if (!Array.isArray(items)) { console.info(`[vivi canvas] spotify: no results for '${title}'`); return null; }
    for (const it of items.slice(0, 10)) {
      const track = it?.item?.data;
      if (!track || track.__typename !== 'Track' || !track.id) continue;
      const names = (track.artists?.items || []).map((a) => a?.profile?.name).filter(Boolean);
      const foundMs = Number(track.duration?.totalMilliseconds);
      if (!matches(title, artist, album, durationMs, track.name || '', names.join(', '),
        track.albumOfTrack?.name, Number.isFinite(foundMs) ? foundMs : null, primary, names[0])) continue;
      const canvas = await trackCanvas(track.id);
      if (trusted(canvas)) {
        console.info(`[vivi canvas] spotify: '${track.name}' by ${names.join(', ')} (${track.id}) has a canvas`);
        return canvas;
      }
      console.info(`[vivi canvas] spotify: '${track.name}' by ${names.join(', ')} (${track.id}) matches, no canvas`);
    }
    console.info(`[vivi canvas] spotify: none for '${title}' by '${artist}'`);
    return null;
  }

  // the canvas URL, null (no canvas for the song), or an error
  async function find(track) {
    const title = String(track?.song || '').trim(), artist = String(track?.artist || '').trim();
    if (!title || !artist) return null;
    // album and length (s, as content.js's getCurrentTrack gives it) are checked when the request has them
    const album = String(track.album || '').trim() || null;
    const durationMs = track.duration > 0 ? Math.round(track.duration * 1000) : null;
    // a miss is per version: another length (to 10 s) of the same title is asked again
    const key = `${artist}—${title}${durationMs ? '—' + Math.round(durationMs / 10000) : ''}`;
    const missed = misses.get(key);
    if (missed && Date.now() - missed < MISS_MS) return null;
    const url = await canvasUrl(title, artist, album, durationMs);
    if (!url) {
      misses.delete(key); misses.set(key, Date.now());
      if (misses.size > 500) misses.delete(misses.keys().next().value);
    }
    return url;
  }

  return { find, totp, matches, trusted, canvasOf };
})();
globalThis.viviSpotifyCanvas = viviSpotifyCanvas;   // for the test page and the console

// vivi+ hook: replaces upstream's lookup (spotify.js); upstream's saved canvas URLs are used first
if (typeof spotifyCanvasForTrack === 'function') {
  // eslint-disable-next-line no-global-assign
  spotifyCanvasForTrack = async function (track) {
    const key = `${track.artist}—${track.song}`;
    const saved = (await chrome.storage.local.get(`spotify_canvas_${key}`))[`spotify_canvas_${key}`];
    if (saved?.videoUrl) return saved.videoUrl;
    try {
      const url = await viviSpotifyCanvas.find(track);
      if (url) await chrome.storage.local.set({ [`spotify_canvas_${key}`]: { videoUrl: url, cachedAt: Date.now() } });
      return url;
    } catch (e) {
      console.warn('[vivi canvas] spotify without login failed:', e?.message || e);
      return null;
    }
  };
}

// The source order (canvas.md §13, canvasSourceOrder; default music video, Spotify, Apple). Once:
// the old two-way "prefer" select becomes the order (Apple first only if it was picked in it).
chrome.storage.local.get({ viviCanvasOrderSet: false, canvasPriority: 'spotify', canvasSourceOrder: null }).then((s) => {
  if (s.canvasSourceOrder != null) return;
  chrome.storage.local.set({ canvasSourceOrder: s.viviCanvasOrderSet && s.canvasPriority === 'apple' ? 'apple' : '', canvasPriority: 'spotify', viviCanvasOrderSet: true });
}).catch(() => {});

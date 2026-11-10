/**
 * VIVIMUSIC XTEN — apple-canvas.js
 *
 * Fetches Apple Music's animated "motion artwork" (Canvas) directly from
 * Apple's own private catalog API, the same way the official web player
 * (music.apple.com) and the VIVIMUSIC Android app do it — no third-party
 * proxy (artwork.boidu.dev) involved.
 *
 * This only works from an extension's own privileged context (background
 * service worker), never from a content script: it needs to read the
 * response regardless of CORS, and needs `Origin`/`Referer` request headers
 * spoofed to look like music.apple.com's own web player — both of which
 * require host_permissions + declarativeNetRequest, not something a page's
 * own JS (or a content script sharing that page's fetch sandbox) can do.
 *
 * Two-part flow, mirroring AppleMusicCanvasProvider.kt:
 *
 *  1. getOrFetchAmpToken() — scrapes music.apple.com's own bundled JS for
 *     the short-lived JWT its web player uses to call its private API.
 *     This is inherently fragile (Apple owes us nothing here and can change
 *     their bundling at any time); a fallback token is baked in for when
 *     scraping comes up empty, same safety net the Android app keeps.
 *
 *  2. searchAndFetchMotion() / fetchMotionArtwork() — call
 *     amp-api.music.apple.com directly with that token, extract
 *     `editorialVideo`'s motion asset URL, and apply the same
 *     scoring/blacklist heuristics the Android resolver uses to avoid
 *     matching a random playlist/session/DJ-mix "album" instead of the
 *     track's real release.
 */

'use strict';

const AMP_BASE_URL = 'https://amp-api.music.apple.com';

// Token handling (ported from BitChord's AppleMusicCanvas.kt):
//  - the web player's own JWT is scraped from music.apple.com's bundles,
//    picked by its kid/iss, not just the first JWT that parses;
//  - the last good one is saved in storage as the backup for when a scrape
//    fails, until it expires (no baked-in token, those die within weeks);
//  - a 401 strikes the token off (never picked again), re-scrapes and retries
//    the request once; a failed scrape waits 30 min before the next try.
const APPLE_TOKEN_BACKUP_KEY = 'viviAppleTokenBackup';
const APPLE_TOKEN_RETRY_MS = 30 * 60 * 1000;

let cachedAmpToken = null;
let ampTokenExpiryMs = 0;
let ampScrapeRetryAt = 0;
const rejectedAmpTokens = new Set();

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - (str.length % 4)) % 4, '=');
  const binary = atob(padded);
  // JWT payloads are UTF-8 JSON; atob() gives us a binary string, so decode
  // it byte-by-byte through TextDecoder rather than assuming latin1==utf8.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function jwtExpiryMs(jwt) {
  try {
    const payload = JSON.parse(base64UrlDecode(jwt.split('.')[1]));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

// The web player's token names itself: header kid "WebPlayKid", payload iss "AMPWebPlay".
function isWebPlayerToken(jwt) {
  try {
    const [h, p] = jwt.split('.');
    return base64UrlDecode(h).includes('WebPlayKid') || base64UrlDecode(p).includes('AMPWebPlay');
  } catch { return false; }
}

async function useBackupAmpToken(now) {
  try {
    const { [APPLE_TOKEN_BACKUP_KEY]: b } = await chrome.storage.local.get(APPLE_TOKEN_BACKUP_KEY);
    if (b?.jwt && b.exp - 60_000 > now && !rejectedAmpTokens.has(b.jwt)) {
      cachedAmpToken = b.jwt;
      ampTokenExpiryMs = b.exp;
      return b.jwt;
    }
  } catch { /* storage unavailable */ }
  return null;
}

async function scrapeAmpToken(now) {
  const htmlRes = await fetch('https://music.apple.com/us/browse');
  const html = await htmlRes.text();
  const scripts = [...new Set(html.match(/\/assets\/index(?:-legacy)?[~-][a-zA-Z0-9_-]+\.js/g) || [])];
  for (const scriptPath of scripts) {
    let scriptText;
    try {
      scriptText = await (await fetch(`https://music.apple.com${scriptPath}`)).text();
    } catch { continue; }
    const candidates = [...new Set(scriptText.match(/ey[a-zA-Z0-9_-]+\.ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g) || [])]
      .filter((t) => !rejectedAmpTokens.has(t))
      .map((t) => ({ t, exp: jwtExpiryMs(t) }))
      .filter((c) => c.exp && c.exp > now);
    if (!candidates.length) continue;
    // The web player's own token first; any other is a guess, kept so a change
    // in how Apple labels it is not fatal.
    return candidates.find((c) => isWebPlayerToken(c.t)) || candidates[0];
  }
  return null;
}

async function getOrFetchAmpToken() {
  const now = Date.now();
  if (cachedAmpToken && now < ampTokenExpiryMs - 60_000) return cachedAmpToken;
  if (now < ampScrapeRetryAt) return useBackupAmpToken(now);

  let found = null;
  try { found = await scrapeAmpToken(now); } catch { /* network hiccup */ }
  if (found) {
    cachedAmpToken = found.t;
    ampTokenExpiryMs = found.exp;
    try { await chrome.storage.local.set({ [APPLE_TOKEN_BACKUP_KEY]: { jwt: found.t, exp: found.exp } }); } catch { /* ignore */ }
    return found.t;
  }
  console.warn('[Vivi Apple] no usable web player token found; retrying in 30 min, using the saved one meanwhile');
  ampScrapeRetryAt = now + APPLE_TOKEN_RETRY_MS;
  return useBackupAmpToken(now);
}

async function rejectAmpToken(token) {
  rejectedAmpTokens.add(token);
  if (cachedAmpToken === token) { cachedAmpToken = null; ampTokenExpiryMs = 0; }
  ampScrapeRetryAt = 0;   // a rejected token is worth an immediate re-scrape
  try {
    const { [APPLE_TOKEN_BACKUP_KEY]: b } = await chrome.storage.local.get(APPLE_TOKEN_BACKUP_KEY);
    if (b?.jwt === token) await chrome.storage.local.remove(APPLE_TOKEN_BACKUP_KEY);
  } catch { /* ignore */ }
}

// Throws on network errors, a missing token and a 401 that a fresh token did
// not fix, so callers report a failed lookup instead of caching "no Canvas".
async function ampGet(path, params, retried = false) {
  const token = await getOrFetchAmpToken();
  if (!token) throw new Error('no Apple Music token');
  const url = new URL(AMP_BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // Origin/Referer are rewritten to music.apple.com's by fx-headers.js.
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    console.warn('[Vivi Apple] token rejected by the catalog API; re-scraping');
    await rejectAmpToken(token);
    if (retried) throw new Error('Apple Music token rejected');
    return ampGet(path, params, true);
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeForComparison(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ARTIST_DELIMITERS = /(?:\s*,\s*|\s*&\s*|\s+×\s+|\s+x\s+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)/i;

function artistMatches(requested, returned) {
  const req = (requested || '').split(ARTIST_DELIMITERS).map(normalizeForComparison).filter(Boolean);
  const ret = (returned || '').split(ARTIST_DELIMITERS).map(normalizeForComparison).filter(Boolean);
  if (!req.length || !ret.length) return false;
  return req.every((r) => ret.some((x) => x === r));
}

const BLACKLIST_WORDS = [
  'playlist', 'set list', 'essentials', 'dj mix', 'mixed', 'apple music', "today's hits", 'session',
];

function isBlacklistedAlbumName(name) {
  const lower = (name || '').toLowerCase();
  return BLACKLIST_WORDS.some((w) => lower.includes(w));
}

// Apple's motion-artwork payload can carry the actual media URL under any of
// a few keys depending on the asset's shape (segmented HLS or a plain file),
// and older payloads use motionSquareVideo1x1 / motionTallVideo3x4.
function motionLink(ev, key) {
  const asset = ev?.[key];
  const v = asset && (asset.video || asset.videoUrl || asset.hlsUrl || asset.url);
  return v || null;
}
// { primary, alternate, tall }: the square clip first (fills a square cover
// uncropped), a different one to retry with when it won't play, and the 3:4
// one for portrait surfaces.
function motionUrls(ev) {
  const square = motionLink(ev, 'motionDetailSquare') || motionLink(ev, 'motionSquareVideo1x1');
  const raw = motionLink(ev, 'motionDetailRaw');
  const tall = motionLink(ev, 'motionDetailTall') || motionLink(ev, 'motionTallVideo3x4');
  const primary = square || raw || tall || motionLink(ev, 'motionDetailStatic');
  if (!primary) return null;
  const alternate = [square, raw, tall].find((u) => u && u !== primary) || null;
  return { primary, alternate, tall };
}

async function fetchMotionArtwork(albumId, storefront, fallbackArtist, titleOverride, artistOverride) {
  if (!albumId || albumId.startsWith('pl.')) return null; // playlist id, not a real album

  const root = await ampGet(`/v1/catalog/${storefront}/albums/${albumId}`, {
    extend: 'editorialVideo',
    include: 'tracks',
  });
  const albumObj = root?.data?.[0];
  if (!albumObj) return null;

  const attributes = albumObj.attributes || {};
  const albumName = attributes.name || '';
  const artistName = attributes.artistName || fallbackArtist || null;

  if (isBlacklistedAlbumName(albumName)) return null;

  const finalTitle = titleOverride || albumName;
  const finalArtist = artistOverride || artistName;

  const m = attributes.editorialVideo && motionUrls(attributes.editorialVideo);
  if (m) {
    return {
      name: finalTitle,
      artist: finalArtist,
      albumId,
      albumName,
      animated: m.primary,
      animatedAlt: m.alternate,
      animatedTall: m.tall,
    };
  }
  return null;
}

async function searchAndFetchMotion(term, artist, album, storefront, type) {
  let query = term.toLowerCase().includes((artist || '').toLowerCase()) ? term : `${artist} ${term}`;
  if (album && !query.toLowerCase().includes(album.toLowerCase())) query = `${query} ${album}`;

  const root = await ampGet(`/v1/catalog/${storefront}/search`, {
    term: query,
    types: type,
    limit: '10',
    extend: 'editorialVideo',
    include: 'albums',
  });
  const results = root?.results?.[type]?.data;
  if (!Array.isArray(results) || !results.length) return null;

  const normTerm = normalizeForComparison(term);
  const editionWords = ['deluxe', 'expanded', 'remastered', 'remix', 'version', 'edit', 'mix', 'bonus'];

  const scored = results
    .map((item) => {
      const attributes = item.attributes;
      if (!attributes) return null;
      const resultArtistName = attributes.artistName || '';
      const resultName = attributes.name || '';
      const resultCollectionName = attributes.albumName || attributes.collectionName || '';

      const nameLower = resultName.toLowerCase();
      const collectionLower = resultCollectionName.toLowerCase();
      if (isBlacklistedAlbumName(nameLower) || isBlacklistedAlbumName(collectionLower)) return null;

      if (!artistMatches(artist, resultArtistName)) return null;

      let score = 10; // artist match, guaranteed by the check above
      const normResultName = normalizeForComparison(resultName);
      if (normResultName === normTerm) score += 15;
      else if (normResultName.includes(normTerm) || normTerm.includes(normResultName)) score += 7;
      else score -= 10;

      for (const word of editionWords) {
        const inTerm = term.toLowerCase().includes(word);
        const inResult = resultName.toLowerCase().includes(word);
        if (inTerm && inResult) score += 5;
        else if (inTerm !== inResult && inResult) score -= 3;
      }

      if (album && resultCollectionName) {
        const normAlbum = normalizeForComparison(album);
        const normCollection = normalizeForComparison(resultCollectionName);
        if (normCollection === normAlbum) score += 20;
        else if (normCollection.includes(normAlbum) || normAlbum.includes(normCollection)) score += 10;
      }

      return { score, item };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  for (const { score, item } of scored) {
    if (score < 12) continue;
    const attributes = item.attributes;
    const resultArtistName = attributes.artistName || '';
    const itemType = item.type;

    let targetAlbumId = null;
    if (itemType === 'songs') {
      targetAlbumId = item.relationships?.albums?.data?.[0]?.id || attributes.collectionId || null;
      if (!targetAlbumId && attributes.url) {
        const albumPart = attributes.url.split('/album/')[1]?.split('?')[0] || '';
        const id = albumPart.split('/').filter(Boolean).pop() || '';
        if (id && /^\d+$/.test(id)) targetAlbumId = id;
      }
    } else if (itemType === 'albums') {
      targetAlbumId = item.id;
    }
    if (!targetAlbumId || String(targetAlbumId).startsWith('pl.')) continue;

    // Motion asset sometimes rides along directly on the search result itself.
    const m = attributes.editorialVideo && motionUrls(attributes.editorialVideo);
    if (m) {
      const name = attributes.name || '';
      const collName = attributes.collectionName || attributes.albumName || null;
      return {
        name,
        artist: resultArtistName,
        albumId: targetAlbumId,
        albumName: itemType === 'songs' ? collName : name,
        animated: m.primary,
        animatedAlt: m.alternate,
        animatedTall: m.tall,
      };
    }

    const fetched = await fetchMotionArtwork(
      targetAlbumId,
      storefront,
      resultArtistName,
      itemType === 'songs' ? attributes.name : null,
      itemType === 'songs' ? resultArtistName : null,
    );
    if (fetched) return fetched;
  }
  return null;
}

const canvasCache = new Map(); // key -> {value, expiresAtMs}
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h, matches the Android app

function cacheKey(prefix, ...parts) {
  return `${prefix}|${parts.map((p) => (p || '').trim().toLowerCase()).join('|')}`;
}

/**
 * Public entry point — resolves a track's Apple Music Canvas video directly
 * against Apple's own catalog, no proxy involved.
 *
 * @param {{song: string, artist: string, album?: string|null}} track
 * @param {string} storefront
 * @returns {Promise<{videoUrl: string|null}|null>}
 */
// Motion art is per storefront: use the browser's region (en-GB -> gb), else us.
function defaultStorefront() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    if (region && /^[A-Z]{2}$/.test(region)) return region.toLowerCase();
  } catch { /* ignore */ }
  return 'us';
}

async function resolveAppleCanvasDirect(track, storefront = defaultStorefront()) {
  const { song, artist, album } = track || {};
  if (!song || !artist) return null;

  const key = cacheKey('song', song, artist, album || '', storefront);
  const cached = canvasCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.value;

  let result = null;
  try {
    const motion = await searchAndFetchMotion(song, artist, album || null, storefront, 'songs');
    if (motion) result = { videoUrl: motion.animated || null, fallbackUrl: motion.animatedAlt || null, tallUrl: motion.animatedTall || null };
  } catch (e) {
    // A failed lookup (network, token) is not "this song has no Canvas":
    // report it and keep it out of the cache so it is tried again.
    return { videoUrl: null, error: String(e?.message || e) };
  }

  canvasCache.set(key, { value: result, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return result;
}

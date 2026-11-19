// Vivimusic Web+ additions to upstream's background.js. Loaded after it: by the
// manifest's background.scripts in Firefox, by importScripts in Chrome (see the
// hook at the top of background.js). Kept out of upstream's file so merges stay
// clean: our own message types get their own listeners here, and upstream's
// switch statements return undefined for them.

'use strict';

// ── Chrome/Edge: Spotify web-player Origin/Referer for this extension's own requests ──
// Firefox does this in fx-headers.js (blocking webRequest) and has no DNR here.
const SPOTIFY_HEADER_RULE_ID = 9002;
async function ensureSpotifyHeaderRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SPOTIFY_HEADER_RULE_ID],
      addRules: [{
        // Chrome/Edge: the Spotify web-player endpoints want the web player's
        // Origin/Referer. tabIds [-1] = only this extension's own requests,
        // never the open.spotify.com page itself.
        id: SPOTIFY_HEADER_RULE_ID,
        priority: 1,
        condition: {
          requestDomains: ['spotify.com'],   // and every subdomain (spclient hosts vary)
          resourceTypes: ['xmlhttprequest'],
          tabIds: [-1],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'https://open.spotify.com' },
            { header: 'Referer', operation: 'set', value: 'https://open.spotify.com/' },
          ],
        },
      }],
    });
  } catch (e) {
    console.warn('[vivi] Spotify header rule failed', e);
  }
}
chrome.runtime.onInstalled?.addListener(() => { ensureSpotifyHeaderRule(); });
chrome.runtime.onStartup?.addListener(() => { ensureSpotifyHeaderRule(); });
ensureSpotifyHeaderRule();

/* -------------------------------------------------------------------------
 * ListenBrainz Integration
 * ------------------------------------------------------------------------- */
async function listenbrainzGetSession() {
  const { listenbrainzSession } = await chrome.storage.local.get('listenbrainzSession');
  return listenbrainzSession || null;
}

async function handleListenbrainzLogin(token) {
  try {
    const { valid, username } = await listenbrainzValidateToken(token);
    await chrome.storage.local.set({
      listenbrainzSession: { token, username },
    });
    return { ok: true, username };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleListenbrainzLogout() {
  await chrome.storage.local.remove('listenbrainzSession');
  return { ok: true };
}

async function handleListenbrainzNowPlaying(track) {
  const session = await listenbrainzGetSession();
  if (!session) return { ok: false, error: 'Not logged in' };
  try {
    await listenbrainzUpdateNowPlaying(session.token, track);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleListenbrainzScrobble(track, timestamp) {
  const session = await listenbrainzGetSession();
  if (!session) return { ok: false, error: 'Not logged in' };
  try {
    await listenbrainzScrobble(session.token, track, timestamp);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'VIVI_LISTENBRAINZ_LOGIN':
      handleListenbrainzLogin(msg.token).then(sendResponse);
      return true;
    case 'VIVI_LISTENBRAINZ_LOGOUT':
      handleListenbrainzLogout().then(sendResponse);
      return true;
    case 'VIVI_LISTENBRAINZ_STATUS':
      listenbrainzGetSession().then((s) => sendResponse({ loggedIn: !!s, username: s?.username || null }));
      return true;
    case 'VIVI_LISTENBRAINZ_NOWPLAYING':
      handleListenbrainzNowPlaying(msg.track).then(sendResponse);
      return true;
    case 'VIVI_LISTENBRAINZ_SCROBBLE':
      handleListenbrainzScrobble(msg.track, msg.timestamp).then(sendResponse);
      return true;
    default:
      return undefined;
  }
});

// Inject / remove our theme additions (theme-plus.css) for the sending tab,
// next to upstream's theme.css.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // background.js's own listener adds theme.css and answers; this one only adds
  // our additions next to it, without answering.
  if (msg?.type !== 'VIVI_THEME_CSS' || !sender?.tab?.id) return undefined;
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  const files = ['src/plus/theme-plus.css'];
  Promise.resolve(msg.on ? chrome.scripting.insertCSS({ target, files }) : chrome.scripting.removeCSS({ target, files })).catch(() => {});
  return undefined;
});

// ── Title & Artist Cleaners for Lyrics & Artwork Search (from BitChord) ──
const CREDITS_PATTERNS = [
  /#[\w\d_]+/g,
  /\s*[([]\s*(feat|ft|featuring|with)\b[^)\]]*[)\]]/gi,
  /\s+(feat|ft|featuring)\.?\s+.*$/gi,
  /\s*[([]\s*(official\s*)?(music\s*)?(video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m\/?v|hd|hq|4k|60fps|full\s*song)\s*[)\]]/gi,
  /\s*[([]\s*official\s*[)\]]/gi,
  /\s*[([]\s*(slowed(\s*\+\s*reverb)?|sped\s*up|speed\s*up|nightcore|daycore|bass\s*boosted|reverb|tiktok|tik\s*tok(\s*version)?|jersey\s*club|jerseyclub)(\s*(remix|version|mix|edit))?\s*[)\]]/gi,
  /\s*[([]\s*(prod|produced)\s*(by)?\s*[^)\]]+[)\]]/gi,
  /\s*[([]\s*\d+\s*(hour|min|minute)s?\s*(loop)?\s*[)\]]/gi,
  /\s*[([]\s*(remix|edit|vip|flip)\s*[)\]]/gi,
  /\s*[([]\s*(audio\s*only|lyrics?)\s*[)\]]/gi,
];

function cleanTitleForLyrics(title) {
  if (!title) return '';
  let name = String(title);
  for (const pattern of CREDITS_PATTERNS) name = name.replace(pattern, ' ');
  const cleaned = name.replace(/\s+/g, ' ').trim().replace(/[,\-–—|~]+$/, '').trim();
  return cleaned || String(title).trim();
}

function cleanArtistForLyrics(artist) {
  if (!artist) return '';
  return String(artist).replace(/ - Topic$/i, '').trim() || String(artist).trim();
}

// ── Apple Music Artist Hero Art & Palette Extraction (from BitChord) ──
async function getAppleArtistArt(artistName) {
  const cleanArtist = cleanArtistForLyrics(artistName);
  if (!cleanArtist) return null;

  try {
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanArtist)}&entity=musicArtist&limit=5`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const results = searchData?.results || [];

    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');
    const targetNorm = norm(cleanArtist);
    const hit = results.find((r) => norm(r.artistName) === targetNorm) || results[0];
    if (!hit || !hit.artistLinkUrl) return null;

    const pageUrl = hit.artistLinkUrl.split('?')[0];
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const marker = html.indexOf('id="serialized-server-data"');
    if (marker < 0) return null;
    const start = html.indexOf('>', marker) + 1;
    const end = html.indexOf('</script>', start);
    if (start <= 0 || end < 0) return null;

    let jsonData = null;
    try {
      jsonData = JSON.parse(html.slice(start, end));
    } catch {
      return null;
    }

    function findHeader(node) {
      if (Array.isArray(node)) {
        for (const child of node) {
          const f = findHeader(child);
          if (f) return f;
        }
        return null;
      }
      if (node && typeof node === 'object') {
        if ('artistLogo' in node || 'colorBackdropArtwork' in node) return node;
        for (const child of Object.values(node)) {
          const f = findHeader(child);
          if (f) return f;
        }
      }
      return null;
    }

    const header = findHeader(jsonData);
    if (!header) return null;

    const hero = header.artwork?.dictionary || header.colorBackdropArtwork?.dictionary;
    const logo = header.artistLogo?.dictionary;

    const fillUrl = (template, w, h, fmt) => {
      if (!template || typeof template !== 'string' || !template.includes('{w}')) return null;
      return template.replace('{w}', String(w)).replace('{h}', String(h)).replace('{c}', 'bb').replace('{f}', fmt);
    };

    let heroUrl = null;
    let heroAspect = 1.77;
    if (hero && hero.url && hero.width && hero.height) {
      const w = 1200;
      const h = Math.round((1200 * hero.height) / hero.width);
      heroUrl = fillUrl(hero.url, w, h, 'jpg');
      heroAspect = hero.width / hero.height;
    }

    let logoUrl = null;
    let logoAspect = 1;
    if (logo && logo.url && logo.width && logo.height) {
      const lw = 1000;
      const lh = Math.round((1000 * logo.height) / logo.width);
      logoUrl = fillUrl(logo.url, lw, lh, 'png');
      logoAspect = logo.width / logo.height;
    }

    const hexColor = (val) => {
      const s = String(val || '');
      return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
    };

    const background = hexColor(hero?.bgColor) || '#111111';
    const accent = hexColor(hero?.textColor1) || '#fa2d48';
    const keyColor = hexColor(header?.keyColor) || null;

    return {
      heroUrl,
      heroAspect,
      logoUrl,
      logoAspect,
      background,
      accent,
      keyColor,
    };
  } catch (err) {
    console.warn('[Vivi] getAppleArtistArt failed:', err?.message || err);
    return null;
  }
}

// ── Paxsenix (Apple Music Synced TTML) ──
async function getPaxsenixLyrics(track) {
  const song = cleanTitleForLyrics(track.song || '');
  const artist = cleanArtistForLyrics(track.artist || '');
  const query = `${song} ${artist}`.trim();
  if (!query) return null;

  try {
    const searchRes = await ampGet('/v1/catalog/us/search', {
      term: query,
      types: 'songs',
      limit: 5,
    });
    const songs = searchRes?.results?.songs?.data;
    if (!Array.isArray(songs) || !songs.length) return null;

    let matchedSong = songs[0];
    if (artist) {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const targetArtist = norm(artist);
      const hit = songs.find((s) => {
        const a = norm(s?.attributes?.artistName);
        return a && (a.includes(targetArtist) || targetArtist.includes(a));
      });
      if (hit) matchedSong = hit;
    }

    const songId = matchedSong?.id;
    if (!songId) return null;

    const paxRes = await fetch(`https://lyrics.paxsenix.org/apple-music/lyrics?id=${encodeURIComponent(songId)}&ttml=true`, {
      headers: { 'Accept': 'application/json, text/xml, */*' },
    });
    if (!paxRes.ok) return null;
    const json = await paxRes.json();
    return json?.content || (typeof json === 'string' ? json : null);
  } catch (e) {
    console.warn('[Vivi] Paxsenix fetch failed:', e?.message || e);
    return null;
  }
}

// ── Genius (Plain Lyrics Fallback) ──
async function getGeniusLyrics(track) {
  const song = cleanTitleForLyrics(track.song || '');
  const artist = cleanArtistForLyrics(track.artist || '');
  const query = `${song} ${artist}`.trim();
  if (!query) return null;

  try {
    const searchUrl = `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!searchRes.ok) return null;
    const data = await searchRes.json();
    const sections = data?.response?.sections || [];
    const songSec = sections.find((s) => s.type === 'song');
    const hits = songSec?.hits?.map((h) => h.result).filter(Boolean) || [];
    if (!hits.length) return null;

    let bestHit = hits[0];
    if (artist) {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const targetArtist = norm(artist);
      const targetSong = norm(song);
      const scored = hits.map((h) => {
        const t = norm(h.title);
        const a = norm(h.artist_names);
        let score = 0;
        if (t === targetSong) score += 50;
        else if (t.includes(targetSong)) score += 25;
        if (a === targetArtist) score += 40;
        else if (a.includes(targetArtist)) score += 20;
        return { hit: h, score };
      }).sort((a, b) => b.score - a.score);
      if (scored.length && scored[0].score > 0) bestHit = scored[0].hit;
    }

    if (!bestHit?.url) return null;
    const pageRes = await fetch(bestHit.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!pageRes.ok) return null;
    return await pageRes.text();
  } catch (e) {
    console.warn('[Vivi] Genius fetch failed:', e?.message || e);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'VIVI_PAXSENIX_LYRICS') {
    getPaxsenixLyrics(msg.track || {})
      .then((ttml) => sendResponse({ ok: !!ttml, ttml: ttml || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'VIVI_APPLE_ARTIST_ART') {
    getAppleArtistArt(msg.artist || '')
      .then((art) => sendResponse({ ok: !!art, art: art || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'VIVI_GENIUS_LYRICS') {
    getGeniusLyrics(msg.track || {})
      .then((html) => sendResponse({ ok: !!html, html: html || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return undefined;
});

/* ── Our versions of upstream background functions ─────────────────────────
 * background.js, spotify.js and apple-canvas.js are upstream's files, unchanged
 * apart from a few `// vivi+ hook` lines. All background scripts share one global
 * scope (Firefox: background.scripts; Chrome: importScripts), and upstream calls
 * these functions by name at call time, so reassigning them here replaces them.
 * Nothing calls them before this file has loaded.
 */

// ── background.js: update check against this fork's releases ──
{
  // This fork's own releases (the repo is private: an unauthenticated check gets a 404).
  const REPO = 'ayhamo/vivimusic-automix';
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
  checkForUpdate = async function checkForUpdate() {
    const currentVersion = chrome.runtime.getManifest().version;
    let result;
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) throw new Error('the fork repo is private, open its releases page while signed in to GitHub');
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();
      // Fork release titles read "Vivimusic Web+ 10.2.0.12 (upstream …)"; the tag
      // (fork-v10.2.0-amo10.2.0-<sha>) carries upstream's version, not ours.
      const latestVersion = (String(data.name || '').match(/\d+(?:\.\d+)+/) || [data.tag_name || ''])[0];
      const updateAvailable = latestVersion ? isNewer(latestVersion, currentVersion) : false;
      const releaseUrl = data.html_url || RELEASES_PAGE, source = 'github';   // Vivimusic Web+: our releases, not AMO's listing
      result = {
        ok: true,
        currentVersion,
        latestVersion: latestVersion.replace(/^v/i, ''),
        updateAvailable,
        releaseUrl,
        source,
        checkedAt: Date.now(),
      };
    } catch (e) {
      result = {
        ok: false,
        currentVersion,
        error: e.message,
        releaseUrl: RELEASES_PAGE,
        checkedAt: Date.now(),
      };
    }

    await chrome.storage.local.set({ vivi_update_check: result });

    if (result.ok && result.updateAvailable) {
      chrome.action.setBadgeText({ text: '1' });
      chrome.action.setBadgeBackgroundColor({ color: '#5b6cf5' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

    return result;
  };
}

// ── spotify.js: login via the browser's own Spotify cookie (any cookie store),
// a remembered Disconnect, the TOTP secret fallback, keep-alive while connecting ──
getSpDc = async function getSpDc() {
  const { spotifySpDc, spotifyDisconnected } = await chrome.storage.local.get(['spotifySpDc', 'spotifyDisconnected']);
  if (spotifySpDc) return spotifySpDc;
  // After "Disconnect" the browser's own Spotify login is left alone, so do
  // not pick it up again until the user presses Connect.
  if (spotifyDisconnected) return null;

  // Upstream's plain lookup first: the normal first-party login cookie.
  try {
    const c = await chrome.cookies.get({ url: SPOTIFY_HOME, name: 'sp_dc' });
    if (c?.value) {
      await chrome.storage.local.set({ spotifySpDc: c.value });
      return c.value;
    }
  } catch {}

  try {
    const stores = await chrome.cookies.getAllCookieStores().catch(() => [{ id: null }]);
    const storeIds = [null, ...stores.map(s => s.id).filter(Boolean)];

    for (const storeId of storeIds) {
      const storeOpt = storeId ? { storeId } : {};
      const queries = [
        { name: 'sp_dc', ...storeOpt, partitionKey: {}, firstPartyDomain: null },
        { name: 'sp_dc', ...storeOpt, firstPartyDomain: null },
        { name: 'sp_dc', ...storeOpt, partitionKey: {} },
        { name: 'sp_dc', ...storeOpt },
        { domain: 'spotify.com', name: 'sp_dc', ...storeOpt },
        { domain: '.spotify.com', name: 'sp_dc', ...storeOpt },
        { url: 'https://open.spotify.com/', name: 'sp_dc', ...storeOpt },
        { url: 'https://spotify.com/', name: 'sp_dc', ...storeOpt },
        { url: 'https://accounts.spotify.com/', name: 'sp_dc', ...storeOpt }
      ];

      for (const q of queries) {
        try {
          let results;
          if (q.url) {
            const single = await chrome.cookies.get(q).catch(() => null);
            results = single ? [single] : [];
          } else {
            results = await chrome.cookies.getAll(q).catch(() => []);
          }
          for (const c of results) {
            if (c && c.name === 'sp_dc' && c.value) {
              const val = String(c.value).trim();
              if (val) {
                await chrome.storage.local.set({ spotifySpDc: val });
                return val;
              }
            }
          }
        } catch {}
      }
    }

    // Direct check of open Spotify tabs
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.spotify.com/*' });
      for (const tab of tabs) {
        if (tab.cookieStoreId) {
          const cks = await chrome.cookies.getAll({ name: 'sp_dc', storeId: tab.cookieStoreId }).catch(() => []);
          for (const c of cks) {
            if (c && c.name === 'sp_dc' && c.value) {
              const val = String(c.value).trim();
              if (val) {
                await chrome.storage.local.set({ spotifySpDc: val });
                return val;
              }
            }
          }
        }
      }
    } catch {}

    return null;
  } catch (e) {
    console.warn('[Vivi Spotify] Error getting sp_dc:', e);
    return null;
  }
};

setSpDc = async function setSpDc(value) {
  value = String(value || '').trim();
  if (!value) throw new Error('Empty sp_dc');
  // Keep a local copy and also install it as the Spotify web-player cookie so
  // extension fetch() requests can authenticate with credentials: include.
  await chrome.storage.local.set({ spotifySpDc: value, spotifyDisconnected: false });
  // Only install the cookie when the browser does not already have this
  // login: rewriting it would turn a remembered login into a session cookie.
  const existing = await chrome.cookies.get({ url: SPOTIFY_HOME, name: 'sp_dc' }).catch(() => null);
  if (existing?.value === value) return;
  await chrome.cookies.set({
    url: SPOTIFY_HOME,
    name: 'sp_dc',
    value,
    domain: '.spotify.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  });
};

getSecretDict = async function getSecretDict() {
  if (spotifySecretCache) return spotifySecretCache;
  try {
    const r = await fetch(SPOTIFY_SECRET_URL, { cache: 'no-store' });
    if (r.ok) {
      spotifySecretCache = await r.json();
      return spotifySecretCache;
    }
  } catch {}
  spotifySecretCache = {
    '12': [107, 81, 49, 57, 67, 93, 87, 81, 69, 67, 40, 93, 48, 50, 46, 91, 94, 113, 41, 47]
  };
  return spotifySecretCache;
};

{
  const connect = async function spotifyConnectFromBrowser() {
    // Read the browser's current login, not an older saved copy.
    spotifyTokenCache = null;
    await chrome.storage.local.remove('spotifySpDc');
    await chrome.storage.local.set({ spotifyDisconnected: false });
    // Without the Spotify host permission Firefox hides the cookie entirely.
    try {
      const allowed = await chrome.permissions.contains({ origins: ['https://open.spotify.com/*'] });
      if (!allowed) {
        console.warn('[Vivi Spotify] no host permission for open.spotify.com');
        return spotifyJsonError('Vivimusic Web is not allowed to access Spotify. Allow it in about:addons → Vivimusic Web+ → Permissions, then press Connect again.');
      }
    } catch {}
    // 1. First, check if sp_dc is ALREADY available right now in browser cookies!
    const existingSpDc = await getSpDc();
    if (existingSpDc) {
      await setSpDc(existingSpDc);
      return { ok: true };
    }

    // 2. If not found, focus existing Spotify tab or open open.spotify.com
    let tab;
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.spotify.com/*' });
      if (tabs.length > 0) {
        tab = tabs[0];
        await chrome.tabs.update(tab.id, { active: true });
      } else {
        tab = await chrome.tabs.create({ url: SPOTIFY_HOME, active: true });
      }
    } catch {
      tab = await chrome.tabs.create({ url: SPOTIFY_HOME, active: true });
    }

    // 3. Poll for cookie for up to 120 seconds
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1200));
      const val = await getSpDc();
      if (val) {
        await setSpDc(val);
        return { ok: true };
      }
    }
    return spotifyJsonError('No sp_dc cookie detected. Log in to Spotify in the opened tab and try again.');
  };
  spotifyConnectFromBrowser = function spotifyConnectFromBrowser() { return viviWithKeepAlive(connect); };
}

clearSpotify = async function clearSpotify() {
  spotifyTokenCache = null;
  spotifyClientTokenCache = null;
  // Forget the session here only. Removing the browser's sp_dc cookie (as
  // before) logged the user out of open.spotify.com as well.
  await chrome.storage.local.remove(['spotifySpDc']);
  await chrome.storage.local.set({ spotifyDisconnected: true });
  return { ok: true };
};

// ── apple-canvas.js (ported from BitChord's AppleMusicCanvas.kt) ──
//  - the web player's own JWT is scraped from music.apple.com's bundles,
//    picked by its kid/iss, not just the first JWT that parses;
//  - the last good one is saved in storage as the backup for when a scrape
//    fails, until it expires (no baked-in token, those die within weeks);
//  - a 401 strikes the token off (never picked again), re-scrapes and retries
//    the request once; a failed scrape waits 30 min before the next try;
//  - motion art: the square clip first, an alternate to retry with, the 3:4 one
//    for portrait, older key names too; the browser's storefront; a failed
//    lookup is reported and not cached as "no Canvas".
// Upstream's scoring stays (searchAndFetchMotion is a copy, with the inline art
// taken before the album id), and so does fetchMotionArtwork.
{
  const APPLE_TOKEN_BACKUP_KEY = 'viviAppleTokenBackup';
  const APPLE_TOKEN_RETRY_MS = 30 * 60 * 1000;
  let ampScrapeRetryAt = 0;
  const rejectedAmpTokens = new Set();

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

  getOrFetchAmpToken = async function getOrFetchAmpToken() {
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
  };

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
  ampGet = async function ampGet(path, params, retried = false) {
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
  };

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
    const primary = square || raw || tall;   // a static still is not motion art (BitChord)
    if (!primary) return null;
    const alternate = [square, raw, tall].find((u) => u && u !== primary) || null;
    return { primary, alternate, tall };
  }

  // Upstream's search calls extractEditorialVideoUrl(ev, false) for the clip and
  // (ev, true) for the tall one; the alternate rides along here, keyed by the clip.
  const motionAltByPrimary = new Map();
  extractEditorialVideoUrl = function extractEditorialVideoUrl(ev, preferTall) {
    const m = motionUrls(ev);
    if (!m) return null;
    motionAltByPrimary.delete(m.primary);
    motionAltByPrimary.set(m.primary, m.alternate);
    if (motionAltByPrimary.size > 200) motionAltByPrimary.delete(motionAltByPrimary.keys().next().value);
    return preferTall ? m.tall : m.primary;
  };

  // Upstream's search and scoring, with BitChord's order per hit: its inline motion art is
  // taken before its album id is looked at, so a hit that names no album still counts.
  searchAndFetchMotion = async function searchAndFetchMotion(term, artist, album, storefront, type) {
    let query = term.toLowerCase().includes((artist || '').toLowerCase()) ? term : `${artist} ${term}`;
    if (album && !query.toLowerCase().includes(album.toLowerCase())) query = `${query} ${album}`;
    const root = await ampGet(`/v1/catalog/${storefront}/search`, {
      term: query, types: type, limit: '10', extend: 'editorialVideo', include: 'albums',
    });
    const results = root?.results?.[type]?.data;
    if (!Array.isArray(results) || !results.length) return null;

    const normTerm = normalizeForComparison(term);
    const editionWords = ['deluxe', 'expanded', 'remastered', 'remix', 'version', 'edit', 'mix', 'bonus'];
    const scored = results.map((item) => {
      const attributes = item.attributes;
      if (!attributes) return null;
      const resultName = attributes.name || '';
      const resultCollectionName = attributes.albumName || attributes.collectionName || '';
      if (isBlacklistedAlbumName(resultName.toLowerCase()) || isBlacklistedAlbumName(resultCollectionName.toLowerCase())) return null;
      if (!artistMatches(artist, attributes.artistName || '')) return null;
      let score = 10;
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
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    for (const { score, item } of scored) {
      if (score < 12) break;   // ranked: the rest score less
      const attributes = item.attributes;
      const resultArtistName = attributes.artistName || '';
      const itemType = item.type;
      let targetAlbumId = null;
      if (itemType === 'songs') {
        targetAlbumId = item.relationships?.albums?.data?.[0]?.id || attributes.collectionId || null;
        if (!targetAlbumId && attributes.url) {
          const id = (attributes.url.split('/album/')[1]?.split('?')[0] || '').split('/').filter(Boolean).pop() || '';
          if (/^\d+$/.test(id)) targetAlbumId = id;
        }
      } else if (itemType === 'albums') {
        targetAlbumId = item.id;
      }
      const ev = attributes.editorialVideo;
      const hlsUrl = ev ? extractEditorialVideoUrl(ev, false) : null;
      if (hlsUrl) {
        return {
          name: attributes.name || '', artist: resultArtistName, albumId: targetAlbumId,
          albumName: itemType === 'songs' ? (attributes.collectionName || null) : (attributes.name || ''),
          animated: hlsUrl, animatedTall: extractEditorialVideoUrl(ev, true) || null,
        };
      }
      if (!targetAlbumId || String(targetAlbumId).startsWith('pl.')) continue;
      const fetched = await fetchMotionArtwork(targetAlbumId, storefront, resultArtistName,
        itemType === 'songs' ? attributes.name : null, itemType === 'songs' ? resultArtistName : null);
      if (fetched) return fetched;
    }
    return null;
  };

  // Motion art is per storefront: use the browser's region (en-GB -> gb), else us.
  function defaultStorefront() {
    try {
      const region = new Intl.Locale(navigator.language).maximize().region;
      if (region && /^[A-Z]{2}$/.test(region)) return region.toLowerCase();
    } catch { /* ignore */ }
    return 'us';
  }

  resolveAppleCanvasDirect = async function resolveAppleCanvasDirect(track, storefront = defaultStorefront()) {
    const { song, artist, album } = track || {};
    if (!song || !artist) return null;

    const key = cacheKey('song', song, artist, album || '', storefront);
    const cached = canvasCache.get(key);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;

    let result = null;
    try {
      const motion = await searchAndFetchMotion(song, artist, album || null, storefront, 'songs');
      if (motion) result = { videoUrl: motion.animated || null, fallbackUrl: motionAltByPrimary.get(motion.animated) || null, tallUrl: motion.animatedTall || null };
    } catch (e) {
      // A failed lookup (network, token) is not "this song has no Canvas":
      // report it and keep it out of the cache so it is tried again.
      return { videoUrl: null, error: String(e?.message || e) };
    }

    canvasCache.set(key, { value: result, expiresAtMs: Date.now() + CACHE_TTL_MS });
    return result;
  };
}

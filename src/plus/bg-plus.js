// Vivimusic Web+ additions to upstream's background.js. Loaded after it: by the
// manifest's background.scripts in Firefox, by importScripts in Chrome (see the
// hook at the top of background.js). Kept out of upstream's file so merges stay
// clean: our own message types get their own listeners here, and upstream's
// switch statements return undefined for them.

'use strict';

// every request here has a time limit (15 s unless said), the body's read included: a host that stalls
// must not hold a message's answer (or the background) forever
function plusFetch(url, init = {}, ms = 15000) {
  const t = AbortSignal.timeout(ms);
  return fetch(url, { ...init, signal: init.signal && AbortSignal.any ? AbortSignal.any([init.signal, t]) : t });
}

// an answer's body, read to at most [max] bytes (fx-headers.js viviReadCapped; more fails the request) as
// text, or parsed when [as] is 'json' (audit 2026-11-26, phone F5-6: no host's answer is read uncapped)
const PLUS_JSON_MAX = 4e6, PLUS_PAGE_MAX = 8e6;
async function plusRead(r, max, as) {
  if (!r.body?.getReader || typeof viviReadCapped !== 'function') return as === 'json' ? r.json() : r.text();   // (the node tests' stand-ins)
  const b = await viviReadCapped(r, max);
  if (!b) throw new Error(`answer over ${max / 1e6} MB`);
  const t = new TextDecoder().decode(b);
  return as === 'json' ? JSON.parse(t) : t;
}

// ── Chrome/Edge: Spotify web-player Origin/Referer (and SimpMusic's User-Agent) for this extension's own requests ──
// Firefox does this in fx-headers.js (blocking webRequest) and has no DNR here.
const SPOTIFY_HEADER_RULE_ID = 9002;
const SIMPMUSIC_UA_RULE_ID = 9003;
async function ensureSpotifyHeaderRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SPOTIFY_HEADER_RULE_ID, SIMPMUSIC_UA_RULE_ID],
      addRules: [{
        // lyrics.md §11.1: SimpMusic answers its own clients only, by the User-Agent (a
        // browser's gets 403). Chrome drops a User-Agent set in fetch(); Firefox keeps it.
        id: SIMPMUSIC_UA_RULE_ID,
        priority: 1,
        condition: { requestDomains: ['api-lyrics.simpmusic.org'], resourceTypes: ['xmlhttprequest'], tabIds: [-1] },
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'SimpMusicLyrics/1.0' }] },
      }, {
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
// lyrics.md §7: lyrics show on music videos as on songs. Applied once; upstream's older "off" migration is marked done
// with it, so it never turns them off again. The popup's switch stays.
chrome.storage.local.get({ vivi_video_lyrics_on_2026_11: false }).then((s) => {
  if (!s.vivi_video_lyrics_on_2026_11) chrome.storage.local.set({ lyricsShowForVideos: true, vivi_video_lyrics_default_off: true, vivi_video_lyrics_on_2026_11: true });
}).catch(() => {});
// spotify.js and bg-canvas.js keep one spotify_canvas_<artist>—<song> key per song, with no
// limit: once a day the oldest beyond SPOTIFY_CANVAS_KEEP are dropped (they are asked again).
const SPOTIFY_CANVAS_KEEP = 2000;
async function pruneSpotifyCanvasCache() {
  const { vivi_canvas_pruned_at: at = 0 } = await chrome.storage.local.get('vivi_canvas_pruned_at');
  if (Date.now() - at < 24 * 3600 * 1000) return;
  await chrome.storage.local.set({ vivi_canvas_pruned_at: Date.now() });
  const names = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
  const keys = names.filter((k) => k.startsWith('spotify_canvas_'));
  if (keys.length <= SPOTIFY_CANVAS_KEEP) return;
  const all = await chrome.storage.local.get(keys);
  keys.sort((a, b) => (all[a]?.cachedAt || 0) - (all[b]?.cachedAt || 0));
  await chrome.storage.local.remove(keys.slice(0, keys.length - SPOTIFY_CANVAS_KEEP));
}
pruneSpotifyCanvasCache().catch(() => {});
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (viviRefuseFromTab(msg, sender, sendResponse)) return false;   // sign-in and out: our own pages only (fx-headers.js)
  const answer = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  switch (msg?.type) {
    case 'VIVI_LISTENBRAINZ_LOGIN':
      answer(handleListenbrainzLogin(msg.token));
      return true;
    case 'VIVI_LISTENBRAINZ_LOGOUT':
      answer(handleListenbrainzLogout());
      return true;
    case 'VIVI_LISTENBRAINZ_STATUS':
      answer(listenbrainzGetSession().then((s) => ({ loggedIn: !!s, username: s?.username || null })));
      return true;
    case 'VIVI_LISTENBRAINZ_NOWPLAYING':
      answer(handleListenbrainzNowPlaying(msg.track));
      return true;
    case 'VIVI_LISTENBRAINZ_SCROBBLE':
      answer(handleListenbrainzScrobble(msg.track, msg.timestamp));
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
    const searchRes = await plusFetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await plusRead(searchRes, PLUS_JSON_MAX, 'json');
    const results = searchData?.results || [];

    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '');
    const targetNorm = norm(cleanArtist);
    const hit = results.find((r) => norm(r.artistName) === targetNorm) || results[0];
    if (!hit || !hit.artistLinkUrl) return null;

    const pageUrl = hit.artistLinkUrl.split('?')[0];
    // the link comes from iTunes' answer: only Apple Music's own https pages are opened
    if (!/^https:\/\/music\.apple\.com\//.test(pageUrl)) return null;
    const pageRes = await plusFetch(pageUrl, {
      credentials: 'omit',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!pageRes.ok) return null;
    const html = await plusRead(pageRes, PLUS_PAGE_MAX);

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
      const u = template.replace('{w}', String(w)).replace('{h}', String(h)).replace('{c}', 'bb').replace('{f}', fmt);
      // the art comes from Apple's page: only Apple's own https image hosts are shown (phone F5-6)
      try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)(mzstatic\.com|apple\.com)$/i.test(x.hostname) ? u : null; } catch { return null; }
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

    const paxRes = await plusFetch(`https://lyrics.paxsenix.org/apple-music/lyrics?id=${encodeURIComponent(songId)}&ttml=true`, {
      headers: { 'Accept': 'application/json, text/xml, */*' },
    });
    if (!paxRes.ok) return null;
    const json = await plusRead(paxRes, PLUS_JSON_MAX, 'json');
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
    const searchRes = await plusFetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!searchRes.ok) return null;
    const data = await plusRead(searchRes, PLUS_JSON_MAX, 'json');
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
    // the link comes from Genius' answer: only genius.com's own https pages are opened
    if (!/^https:\/\/genius\.com\//.test(String(bestHit.url))) return null;
    const pageRes = await plusFetch(bestHit.url, {
      credentials: 'omit',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!pageRes.ok) return null;
    return await plusRead(pageRes, PLUS_PAGE_MAX);
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
  if (msg?.type === 'VIVI_TRANSLATE') {
    // lyrics.md §10: Google's keyless endpoint (it answers any origin)
    if (typeof msg.body !== 'string' || msg.body.length > 20000) { sendResponse({ ok: false }); return undefined; }
    plusFetch('https://translate.googleapis.com/translate_a/single', { method: 'POST', body: new URLSearchParams(msg.body), credentials: 'omit' })
      .then((r) => (r.ok ? plusRead(r, PLUS_JSON_MAX) : null))
      .then((body) => sendResponse({ ok: !!body, body: body || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'VIVI_SIMPMUSIC_LYRICS') {
    // lyrics.md §11.1: SimpMusic answers its own clients only (by the User-Agent) and sends no CORS header
    const id = String(msg.videoId || '');
    if (!/^[\w-]{11}$/.test(id)) { sendResponse({ ok: false }); return undefined; }
    plusFetch('https://api-lyrics.simpmusic.org/v1/' + id, { headers: { 'User-Agent': 'SimpMusicLyrics/1.0', Accept: 'application/json' }, credentials: 'omit' })
      .then((r) => (r.ok ? plusRead(r, PLUS_JSON_MAX) : null))
      .then((body) => sendResponse({ ok: !!body, body: body || null }))
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
      const res = await plusFetch(RELEASES_API, {
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

// ── spotify.js: login via the browser's own Spotify cookie (the default cookie
// store only), a remembered Sign out, the TOTP secret fallback, keep-alive while connecting ──
// canvas.md §4 rule 0: the cookie is read from the browser each time and never
// copied into storage (content scripts can read storage.local); Firefox
// containers and private windows (other cookie stores) are never read.
chrome.storage.local.remove('spotifySpDc').catch(() => {});   // the copy older versions kept
getSpDc = async function getSpDc() {
  // After Sign out the browser's own Spotify login is left alone, so do
  // not pick it up again until the listener presses Sign in.
  const { spotifyDisconnected } = await chrome.storage.local.get('spotifyDisconnected');
  if (spotifyDisconnected) return null;

  // Upstream's plain lookup first: the normal first-party login cookie.
  try {
    const c = await chrome.cookies.get({ url: SPOTIFY_HOME, name: 'sp_dc' });
    if (c?.value) return c.value;
  } catch {}

  // The same default store, asked the ways Firefox's dFPI / first-party isolation need
  // (no storeId: the background's own store, never a container's or a private window's).
  // (Spotify's domain only: an sp_dc of another site the extension may read is never sent to Spotify, §4 rule 0)
  const queries = [
    { domain: 'spotify.com', name: 'sp_dc', partitionKey: {}, firstPartyDomain: null },
    { domain: 'spotify.com', name: 'sp_dc', firstPartyDomain: null },
    { domain: 'spotify.com', name: 'sp_dc', partitionKey: {} },
    { domain: 'spotify.com', name: 'sp_dc' },
    { url: 'https://spotify.com/', name: 'sp_dc' },
    { url: 'https://accounts.spotify.com/', name: 'sp_dc' },
  ];
  for (const q of queries) {
    try {
      const results = q.url
        ? [await chrome.cookies.get(q).catch(() => null)]
        : await chrome.cookies.getAll(q).catch(() => []);
      for (const c of results) {
        const dom = String(c?.domain || '').toLowerCase().replace(/^\./, '');
        if (dom !== 'spotify.com' && !dom.endsWith('.spotify.com')) continue;
        const val = c && c.name === 'sp_dc' ? String(c.value || '').trim() : '';
        if (val && (!c.storeId || c.storeId === 'firefox-default' || c.storeId === '0')) return val;
      }
    } catch {}
  }
  return null;
};

setSpDc = async function setSpDc(value) {
  value = String(value || '').trim();
  if (!value) throw new Error('Empty sp_dc');
  // Install it as the Spotify web-player cookie (no copy in storage) so extension
  // fetch() requests can authenticate with credentials: include.
  await chrome.storage.local.set({ spotifyDisconnected: false });
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
    const r = await plusFetch(SPOTIFY_SECRET_URL, { cache: 'no-store' }, 8000);   // (soon back to the bundled secret)
    if (r.ok) {
      spotifySecretCache = await plusRead(r, PLUS_JSON_MAX, 'json');
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
    await chrome.storage.local.set({ spotifyDisconnected: false });
    // Without the Spotify host permission Firefox hides the cookie entirely.
    try {
      const allowed = await chrome.permissions.contains({ origins: ['https://open.spotify.com/*'] });
      if (!allowed) {
        console.warn('[Vivi Spotify] no host permission for open.spotify.com');
        return spotifyJsonError('Vivimusic Web is not allowed to access Spotify. Allow it in about:addons → Vivimusic Web+ → Permissions, then press Connect again.');
      }
    } catch {}
    // 1. Already signed in on open.spotify.com in this browser (its default cookie store)?
    // The cookie is the browser's own: nothing is copied or rewritten.
    if (await getSpDc()) return { ok: true };

    // 2. If not found, focus existing Spotify tab or open open.spotify.com
    let tab;
    try {
      // a container's or private window's tab has its own cookies, never read: not that one
      const tabs = (await chrome.tabs.query({ url: '*://*.spotify.com/*' }))
        .filter((t) => !t.incognito && (!t.cookieStoreId || t.cookieStoreId === 'firefox-default'));
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
      if (await getSpDc()) return { ok: true };
    }
    return spotifyJsonError('No sp_dc cookie detected. Log in to Spotify in the opened tab and try again.');
  };
  // background.js's VIVI_SPOTIFY_CONNECT already runs it inside viviWithKeepAlive
  spotifyConnectFromBrowser = connect;
}

// canvas.md §4 rule 0: no part of the sp_dc cookie leaves the background (upstream showed 8 of its characters)
{
  const status = spotifyStatus;
  spotifyStatus = async function spotifyStatus() { const s = await status(); if (s) delete s.masked; return s; };
}

// ── Sign out and the signed-in token ──
// A token request still in flight when the listener signs out must not be
// stored or used after it: Sign out bumps a generation, and a token whose
// request began in an older generation is dropped (audit 2026-11-24).
{
  let signOutGen = 0;
  const fetchToken = getSpotifyToken;
  getSpotifyToken = async function getSpotifyToken(spDc) {
    const gen = signOutGen;
    const auth = await fetchToken(spDc);
    if (gen !== signOutGen) {
      if (spotifyTokenCache === auth) spotifyTokenCache = null;
      throw new Error('Spotify was signed out');
    }
    return auth;
  };

  clearSpotify = async function clearSpotify() {
    signOutGen++;
    spotifyTokenCache = null;
    spotifyClientTokenCache = null;
    // Forget the session here only. Removing the browser's sp_dc cookie (as
    // before) logged the user out of open.spotify.com as well.
    await chrome.storage.local.remove(['spotifySpDc']);   // a copy older versions kept
    await chrome.storage.local.set({ spotifyDisconnected: true });
    return { ok: true };
  };
}

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
    const htmlRes = await plusFetch('https://music.apple.com/us/browse');
    const html = await plusRead(htmlRes, PLUS_PAGE_MAX);
    const scripts = [...new Set(html.match(/\/assets\/index(?:-legacy)?[~-][a-zA-Z0-9_-]+\.js/g) || [])];
    // Every bundle is read before picking: the web player's own token may sit in
    // a later bundle than an unlabelled one (audit 2026-11-24).
    const candidates = [];
    for (const scriptPath of scripts) {
      let scriptText;
      try {
        scriptText = await plusRead(await plusFetch(`https://music.apple.com${scriptPath}`), 16e6);   // (a bundle is a few MB)
      } catch { continue; }
      for (const t of scriptText.match(/ey[a-zA-Z0-9_-]+\.ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g) || []) {
        if (!rejectedAmpTokens.has(t) && !candidates.some((c) => c.t === t)) candidates.push({ t, exp: jwtExpiryMs(t) });
      }
      // The web player's own token ends the search early; an unlabelled one waits for the rest.
      const own = candidates.find((c) => c.exp && c.exp > now && isWebPlayerToken(c.t));
      if (own) return own;
    }
    // No web player token in any bundle: the first unexpired one is a guess, kept
    // so a change in how Apple labels it is not fatal.
    return candidates.find((c) => c.exp && c.exp > now) || null;
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
    const res = await plusFetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      console.warn('[Vivi Apple] token rejected by the catalog API; re-scraping');
      await rejectAmpToken(token);
      if (retried) throw new Error('Apple Music token rejected');
      return ampGet(path, params, true);
    }
    if (!res.ok) return null;
    try {
      return await plusRead(res, PLUS_JSON_MAX, 'json');
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
      // only Apple's own https hosts are played: an untrusted link is no motion art (phone F5-3, trustedPair);
      // content.js plays any non-Apple URL in a plain <video>
      const ok = (u) => (u && trustedApple(u) ? u : null);
      const v = ok(motion?.animated), alt = ok(motion && motionAltByPrimary.get(motion.animated));
      if (v || alt) result = { videoUrl: v || alt, fallbackUrl: v ? alt : null, tallUrl: ok(motion.animatedTall) };
    } catch (e) {
      // A failed lookup (network, token) is not "this song has no Canvas":
      // report it and keep it out of the cache so it is tried again.
      return { videoUrl: null, error: String(e?.message || e) };
    }

    canvasCache.set(key, { value: result, expiresAtMs: Date.now() + CACHE_TTL_MS });
    return result;
  };
  // ── Apple artist image and video for the artist page's header (canvas.md §13 rule 8) ──
  // Metrolist's fetchArtistArtwork (AnimatedArtworkService.kt:270-341, 736-785, 977-1050): the
  // artist id by an exact name match on iTunes (two or more exact matches: none), then the artist
  // from Apple's catalog: its artwork as the image, its motion video (wide 16:9, then fullscreen
  // 16:9, then square) at the quality asked. Hits 30 days, misses (and a video asked but none)
  // 7 days, failures not kept. Key: storefront, language, name, both switches, the quality.
  const ARTIST_CACHE = 'viviAppleArtistHeaderCache';
  const ARTIST_HIT_MS = 30 * 864e5, ARTIST_MISS_MS = 7 * 864e5, ARTIST_MAX = 200;
  const profileName = (s) => String(s || '').trim().toLowerCase().replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/\s+/g, ' ');
  const trustedApple = (u, ext) => {
    try {
      const x = new URL(u);
      return x.protocol === 'https:' && /(^|\.)(apple\.com|mzstatic\.com|aaplimg\.com|cdn-apple\.com)$/i.test(x.hostname) && (!ext || x.pathname.endsWith(ext));
    } catch { return false; }
  };

  async function appleArtistId(name, country) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&attribute=artistTerm&limit=200&country=${country}`;
    const r = await plusFetch(url);
    if (!r.ok) throw new Error('artist id lookup HTTP ' + r.status);
    const target = profileName(name);
    const ids = [...new Set(((await plusRead(r, PLUS_JSON_MAX, 'json'))?.results || [])
      .filter((x) => profileName(x.artistName) === target && x.artistId > 0).map((x) => x.artistId))];
    return ids.length === 1 ? ids[0] : null;   // none, or ambiguous
  }

  // the HLS variant for the quality (canvas-settings.js pickVariant over RESOLUTION and BANDWIDTH)
  async function appleVariant(master, quality) {
    const CS = globalThis.__viviCanvasSettings;
    const r = await plusFetch(master);
    if (!r.ok) return null;
    const lines = (await plusRead(r, 512e3)).split(/\r?\n/);
    const vs = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]), bw = /[:,]BANDWIDTH=(\d+)/.exec(lines[i]);
      const uri = (lines[i + 1] || '').trim();
      if (!res || !uri || uri.startsWith('#')) continue;
      const abs = new URL(uri, master).toString();
      if (trustedApple(abs, '.m3u8')) vs.push({ url: abs, v: [Number(res[1]), Number(res[2]), Number(bw?.[1] || 0)] });
    }
    if (!vs.length) return master;
    const i = CS ? CS.pickVariant(vs.map((x) => x.v), CS.capOf(quality)) : 0;
    return i >= 0 ? vs[i].url : master;
  }

  async function appleArtistHeader({ artist, image, video, quality }) {
    if (!artist || (!image && !video)) return { ok: true, imageUrl: null, videoUrl: null };
    const country = defaultStorefront();
    const lang = String(navigator.language || '').split('-')[0].toLowerCase();
    const key = [country, lang, profileName(artist), !!image, !!video, quality || '720'].join('|');
    const { [ARTIST_CACHE]: cache = {} } = await chrome.storage.local.get(ARTIST_CACHE);
    const hit = cache[key];
    if (hit && Date.now() - hit.at <= (hit.short ? ARTIST_MISS_MS : ARTIST_HIT_MS)) return { ok: true, imageUrl: hit.imageUrl, videoUrl: hit.videoUrl, from: 'cache' };

    let result = null;
    try {
      const id = await appleArtistId(artist, country);
      if (id) {
        const root = await ampGet(`/v1/catalog/${country}/artists/${id}`, {
          'art[url]': 'c,f', extend: video ? 'editorialVideo' : undefined, 'format[resources]': 'map',
          l: lang ? `${lang}-${country}` : undefined, platform: 'web',
        });
        const a = root?.resources?.artists?.[String(id)]?.attributes || root?.data?.[0]?.attributes;
        if (a) {
          let imageUrl = null, videoUrl = null;
          const art = a.artwork;
          if (image && art?.url && art.width && art.height) {
            const u = art.url.replace('{w}', art.width).replace('{h}', art.height).replace('{c}', 'bb').replace('{f}', 'webp');
            if (trustedApple(u)) imageUrl = u;
          }
          if (video) {
            const ev = a.editorialVideo || {};
            const asset = ['motionArtistWide16x9', 'motionArtistFullscreen16x9', 'motionArtistSquare1x1'].map((k) => ev[k]).find((x) => x?.video);
            if (asset && trustedApple(asset.video, '.m3u8')) videoUrl = await appleVariant(asset.video, quality);
          }
          if (imageUrl || videoUrl) result = { imageUrl, videoUrl };
        }
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };   // not kept: tried again next time
    }
    cache[key] = { imageUrl: result?.imageUrl || null, videoUrl: result?.videoUrl || null, at: Date.now(), short: !result || (!!video && !result.videoUrl) };
    const keys = Object.keys(cache);
    if (keys.length > ARTIST_MAX) keys.sort((x, y) => cache[x].at - cache[y].at).slice(0, keys.length - ARTIST_MAX).forEach((k) => delete cache[k]);
    await chrome.storage.local.set({ [ARTIST_CACHE]: cache });
    return { ok: true, imageUrl: result?.imageUrl || null, videoUrl: result?.videoUrl || null, from: 'net' };
  }

  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {   // (no runtime in the node tests)
    if (msg?.type !== 'VIVI_APPLE_ARTIST_HEADER') return undefined;
    appleArtistHeader(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });
}

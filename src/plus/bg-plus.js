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

// Inject / remove theme.css for the sending tab. Done from here (not with a
// <link> in the page) so the browser's page-side extension-URL check is never
// involved.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'VIVI_THEME_CSS') return undefined;
  if (!sender?.tab?.id) { sendResponse({ ok: false }); return undefined; }
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  const files = ['src/theme.css', 'src/plus/theme-plus.css'];
  const job = msg.on
    ? chrome.scripting.insertCSS({ target, files })
    : chrome.scripting.removeCSS({ target, files });
  Promise.resolve(job)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
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

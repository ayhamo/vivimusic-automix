/**
 * VIVIMUSIC WEB (Firefox) — fx-headers.js
 *
 * Chrome build used a declarativeNetRequest session rule + the fact that
 * Chrome treats extension fetches as same-site. In Firefox we do the same
 * job with a blocking webRequest listener, limited to requests that THIS
 * extension itself initiates (never the page's own traffic):
 *
 *  - amp-api.music.apple.com : Origin / Referer -> music.apple.com
 *  - *.spotify.com           : Origin / Referer -> open.spotify.com,
 *                              desktop User-Agent where the code asked for one,
 *                              and the sp_dc cookie (Firefox may withhold
 *                              SameSite cookies from moz-extension:// origins)
 *
 * Also hosts the generic VIVI_FETCH proxy used by content scripts when the
 * page's CSP / CORS blocks a direct fetch, and a keep-alive helper for long
 * background tasks (event pages are suspended after ~30s idle in Firefox).
 */
'use strict';

// This extension's own base URL ("moz-extension://<uuid>/"). Only requests from
// it get the Spotify login and spoofed headers: any other extension's
// moz-extension:// origin, or a failed lookup (null), never matches.
const VIVI_EXT_BASE = (() => {
  try { const b = chrome.runtime.getURL(''); return /^[a-z-]+:\/\/[^/]+\/$/.test(b) ? b : null; } catch { return null; }
})();

function viviIsFromExtension(details) {
  const o = details.originUrl || details.documentUrl || '';
  return !!VIVI_EXT_BASE && o.startsWith(VIVI_EXT_BASE) || details.tabId === -1 && !o;
}

function viviSetHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const i = headers.findIndex((h) => h.name.toLowerCase() === lower);
  if (i >= 0) headers[i].value = value; else headers.push({ name, value });
}
function viviGetHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

// canvas.md §4 rule 0: the listener's own login, read from the browser's default
// cookie store by getSpDc (src/plus/bg-plus.js), which answers null after Sign out.
async function viviSpDcForCookie() {
  try {
    if (typeof getSpDc === 'function') return (await getSpDc()) || null;
    const { spotifyDisconnected } = await chrome.storage.local.get('spotifyDisconnected');
    if (spotifyDisconnected) return null;
    const c = await chrome.cookies.get({ url: 'https://open.spotify.com/', name: 'sp_dc' });
    return c?.value || null;
  } catch { return null; }
}

try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!viviIsFromExtension(details)) return {};
      const headers = details.requestHeaders || [];
      let host = '';
      try { host = new URL(details.url).hostname; } catch { return {}; }

      if (host === 'amp-api.music.apple.com') {
        viviSetHeader(headers, 'Origin', 'https://music.apple.com');
        viviSetHeader(headers, 'Referer', 'https://music.apple.com/');
        return { requestHeaders: headers };
      }

      if (host === 'spotify.com' || host.endsWith('.spotify.com')) {
        return (async () => {
          // Only spoof the browser-ish origin for the web-player endpoints.
          if (host === 'open.spotify.com' || host === 'api-partner.spotify.com' || host === 'clienttoken.spotify.com') {
            viviSetHeader(headers, 'Origin', 'https://open.spotify.com');
            viviSetHeader(headers, 'Referer', 'https://open.spotify.com/');
          } else if (host.endsWith('.spotify.com')) {
            if (!viviGetHeader(headers, 'Origin')) viviSetHeader(headers, 'Origin', 'https://open.spotify.com');
            viviSetHeader(headers, 'Referer', 'https://open.spotify.com/');
          }
          // (not on the no-login canvas lookup's token request, src/plus/bg-canvas.js: reason=init,
          // sent without cookies on purpose; upstream's signed-in request says reason=transport)
          const anonymous = /\/api\/token\?(.*&)?reason=init(&|$)/.test(details.url);
          if (host === 'open.spotify.com' && !anonymous) {
            const spDc = await viviSpDcForCookie();
            if (spDc) {
              const existing = viviGetHeader(headers, 'Cookie') || '';
              if (!/(^|;\s*)sp_dc=/.test(existing)) {
                viviSetHeader(headers, 'Cookie', (existing ? existing + '; ' : '') + 'sp_dc=' + spDc);
              }
            }
          }
          return { requestHeaders: headers };
        })();
      }
      return {};
    },
    {
      urls: [
        'https://amp-api.music.apple.com/*',
        'https://*.spotify.com/*',
      ],
    },
    ['blocking', 'requestHeaders']
  );
} catch (e) {
  console.debug('[Vivi] webRequest header rewrite unavailable:', e?.message);
}


/* ---- Page CSP: let the page use this extension's own resources ----
 * Firefox applies the page's Content-Security-Policy to favicons, injected
 * stylesheets, fonts, the lyrics video and the Apple canvas iframe. YouTube
 * Music's policy doesn't list moz-extension:/data:, so those loads can be
 * silently blocked (e.g. the Vivimusic tab icon never appears). Append the
 * extra sources — this only ever LOOSENS img/media/font/style/frame for this
 * extension's own origin (moz-extension://<uuid>), nothing else is touched.
 */
try {
  // this extension's own origin only (moz-extension://<uuid>), not every extension's: no lookup, no patch
  const EXT = VIVI_EXT_BASE ? VIVI_EXT_BASE.slice(0, -1) : null;
  if (!EXT) throw new Error('no extension origin');
  const CSP_DIRECTIVES = {
    'img-src': ['data:', EXT],
    'media-src': [EXT, 'blob:'],
    'font-src': ['data:', EXT],
    'style-src': [EXT],
    'style-src-elem': [EXT],
    'frame-src': [EXT],
    'child-src': [EXT],
  };
  const patchCsp = (value) => {
    const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
    const map = new Map();
    // a repeated directive is ignored by the browser (CSP3 §2.2.1): keep the first, as it does
    parts.forEach((p) => { const [n, ...v] = p.split(/\s+/); const k = n.toLowerCase(); if (!map.has(k)) map.set(k, v); });
    const def = map.get('default-src');
    for (const [name, extra] of Object.entries(CSP_DIRECTIVES)) {
      let cur = map.get(name);
      if (!cur) {
        // Only create a directive when default-src would otherwise govern it.
        if (!def || def.includes('*') && !def.includes("'none'")) continue;
        if (name === 'style-src-elem' && !map.has('style-src')) { cur = [...def]; }
        else if (name === 'style-src-elem') { cur = [...map.get('style-src')]; }
        else cur = [...def];
        map.set(name, cur);
      }
      if (cur.includes("'none'")) cur.splice(cur.indexOf("'none'"), 1);
      for (const e of extra) if (!cur.includes(e) && !cur.includes('*')) cur.push(e);
    }
    return [...map.entries()].map(([n, v]) => [n, ...v].join(' ')).join('; ');
  };
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const headers = details.responseHeaders || [];
      let changed = false;
      for (const h of headers) {
        if (h.name.toLowerCase() === 'content-security-policy' && h.value) {
          h.value = patchCsp(h.value); changed = true;
        }
      }
      return changed ? { responseHeaders: headers } : {};
    },
    { urls: ['https://music.youtube.com/*'], types: ['main_frame', 'sub_frame'] },
    ['blocking', 'responseHeaders']
  );
} catch (e) {
  console.debug('[Vivi] CSP patch unavailable:', e?.message);
}


/* ---- Keep-alive for long-running background work ---- */
function viviKeepAlive() {
  const t = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch { /* ignore */ } }, 15000);
  return () => clearInterval(t);
}
async function viviWithKeepAlive(fn) {
  const stop = viviKeepAlive();
  try { return await fn(); } finally { stop(); }
}

/* ---- Generic fetch proxy for content scripts ---- */
const VIVI_PROXY_ALLOWED = [
  'lyrics-api.boidu.dev', 'unison.betterlyrics.org', 'api.betterlyrics.org', 'unison.boidu.dev',
  'lrclib.net', 'lrc.red', 'api.deezer.com', 'apic-desktop.musixmatch.com', 'apic-appmobile.musixmatch.com', 'apic.musixmatch.com',
  'www.musixmatch.com', 'sponsor.ajay.app', 'itunes.apple.com', 'song.link', 'lyrics-api.binimum.org',
];
function viviProxyHostOk(u) {
  try {
    const h = new URL(u).hostname;
    if (new URL(u).protocol !== 'https:') return false;
    return VIVI_PROXY_ALLOWED.some((a) => h === a || h.endsWith('.' + a)) || h.endsWith('.mzstatic.com') || h.endsWith('.lrc.red') || h.endsWith('.googleusercontent.com') || h.endsWith('.ggpht.com') || h.endsWith('.ytimg.com');
  } catch { return false; }
}
function viviB64(buf) {
  const bytes = new Uint8Array(buf); let s = ''; const c = 0x8000;
  for (let i = 0; i < bytes.length; i += c) s += String.fromCharCode.apply(null, bytes.subarray(i, i + c));
  return btoa(s);
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'VIVI_FETCH') return undefined;
  (async () => {
    if (!viviProxyHostOk(msg.url)) return { ok: false, error: 'host not allowed' };
    const opts = { method: msg.method || 'GET', headers: msg.headers || undefined, credentials: 'omit', cache: 'no-store' };
    if (msg.body != null && opts.method !== 'GET' && opts.method !== 'HEAD') opts.body = msg.body;
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(msg.url, { ...opts, signal: ctrl.signal });
      // a redirect is followed by the browser: its target must be allowed too, or nothing is returned
      if (res.url && !viviProxyHostOk(res.url)) return { ok: false, error: 'redirect not allowed' };
      const buf = await res.arrayBuffer();
      const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: true, status: res.status, statusText: res.statusText, headers, body: viviB64(buf) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    finally { clearTimeout(timer); }
  })().then(sendResponse);
  return true;
});

/* ---- VIVI_NET_FETCH (background.js, the relay behind net.js) ----
 * Its callers are content scripts' cross-origin fetch() calls (net.js), none of
 * which send credentials. So: no cookies ever, a time limit, and no host where
 * this extension adds a login itself (Spotify: the sp_dc cookie above). A
 * redirect's target is checked the same way before anything is returned.
 */
const VIVI_NET_TIMEOUT_MS = 120000;   // whole song files from googlevideo come through here
function viviNetHostRefused(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'spotify.com' || h.endsWith('.spotify.com');
}
function viviNetUrlOk(url, hostAllowed) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hostAllowed(u.hostname) && !viviNetHostRefused(u.hostname);
  } catch { return false; }
}

/* ---- Account actions answer extension pages only ----
 * Signing in or out, Spotify transfer and the YouTube Music transfer are sent by
 * the popup, transfer.html and their scripts. A content script in a web tab
 * (its sender.url is the web page) is refused.
 */
const VIVI_PAGE_ONLY = new Set([
  'VIVI_SPOTIFY_SET_COOKIE', 'VIVI_SPOTIFY_CONNECT', 'VIVI_SPOTIFY_LOGOUT',
  'VIVI_SPOTIFY_TRANSFER_USER', 'VIVI_SPOTIFY_TRANSFER_PLAYLISTS', 'VIVI_SPOTIFY_TRANSFER_PLAYLIST_TRACKS', 'VIVI_SPOTIFY_TRANSFER_PLAYLIST_COUNT',
  'VIVI_YTM_TRANSFER',
  'VIVI_LASTFM_LOGIN', 'VIVI_LASTFM_WEB_START', 'VIVI_LASTFM_WEB_CANCEL', 'VIVI_LASTFM_LOGOUT',
  'VIVI_LISTENBRAINZ_LOGIN', 'VIVI_LISTENBRAINZ_LOGOUT',
  'VIVI_DISCORD_LOGIN', 'VIVI_DISCORD_CALLBACK', 'VIVI_DISCORD_LOGOUT',
]);
function viviFromExtensionPage(sender) {
  return !!sender && sender.id === chrome.runtime.id && !!VIVI_EXT_BASE && String(sender.url || '').startsWith(VIVI_EXT_BASE);
}
// true (and answered) when msg is an account action from anywhere but our own pages
function viviRefuseFromTab(msg, sender, sendResponse) {
  if (!VIVI_PAGE_ONLY.has(msg?.type) || viviFromExtensionPage(sender)) return false;
  try { sendResponse({ ok: false, error: 'Only the add-on settings can do that.' }); } catch { /* port gone */ }
  return true;
}

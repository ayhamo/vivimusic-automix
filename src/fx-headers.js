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

const VIVI_EXT_ORIGIN = (() => { try { return new URL(chrome.runtime.getURL('/')).origin; } catch { return 'moz-extension://'; } })();

function viviIsFromExtension(details) {
  const o = details.originUrl || details.documentUrl || '';
  return o.startsWith('moz-extension://') || o.startsWith(VIVI_EXT_ORIGIN) || details.tabId === -1 && !o;
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

async function viviSpDcForCookie() {
  try {
    const { spotifySpDc } = await chrome.storage.local.get('spotifySpDc');
    if (spotifySpDc) return spotifySpDc;
  } catch { /* ignore */ }
  try {
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
          if (host === 'open.spotify.com') {
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
 * extension's own scheme, nothing else is touched.
 */
try {
  const CSP_DIRECTIVES = {
    'img-src': ['data:', 'moz-extension:'],
    'media-src': ['moz-extension:', 'blob:'],
    'font-src': ['data:', 'moz-extension:'],
    'style-src': ['moz-extension:'],
    'style-src-elem': ['moz-extension:'],
    'frame-src': ['moz-extension:'],
    'child-src': ['moz-extension:'],
  };
  const patchCsp = (value) => {
    const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
    const map = new Map();
    parts.forEach((p) => { const [n, ...v] = p.split(/\s+/); map.set(n.toLowerCase(), v); });
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


/* ---- Tab icon: rewrite the initial HTML ----
 * Firefox registers every <link rel=icon> it parses and then picks the "best"
 * one, so removing YouTube's links afterwards (from JS) is too late. Rewrite
 * the document itself: drop YouTube's icon links and put ours first.
 */
const VIVI_FAVICON_HREF = chrome.runtime.getURL('icons/custom-logo-icon.png');
const VIVI_FAVICON_TAG = '<link rel="icon" type="image/png" data-vivi="1" href="' + VIVI_FAVICON_HREF + '">';
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type !== 'main_frame' || !chrome.webRequest.filterResponseData) return {};
      let filter;
      try { filter = chrome.webRequest.filterResponseData(details.requestId); } catch { return {}; }
      const chunks = [];
      filter.ondata = (ev) => { chunks.push(new Uint8Array(ev.data)); };
      filter.onstop = () => {
        try {
          let len = 0; for (const c of chunks) len += c.length;
          const all = new Uint8Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
          const head = new TextDecoder('utf-8').decode(all.subarray(0, 256)).trimStart().toLowerCase();
          if (!(head.startsWith('<!doctype html') || head.startsWith('<html'))) { filter.write(all); filter.close(); return; }
          let html = new TextDecoder('utf-8').decode(all);
          html = html.replace(/<link\b[^>]*\brel\s*=\s*["']?(?:shortcut\s+icon|icon|apple-touch-icon(?:-precomposed)?)["']?[^>]*>/gi, '');
          html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + VIVI_FAVICON_TAG) : html;
          filter.write(new TextEncoder().encode(html));
          filter.close();
        } catch (e) {
          try { let len = 0; for (const c of chunks) len += c.length; const all = new Uint8Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } filter.write(all); filter.close(); } catch { /* ignore */ }
        }
      };
      filter.onerror = () => { try { filter.disconnect(); } catch { /* ignore */ } };
      return {};
    },
    { urls: ['https://music.youtube.com/*'], types: ['main_frame'] },
    ['blocking']
  );
} catch (e) {
  console.debug('[Vivi] HTML icon rewrite unavailable:', e?.message);
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
      const buf = await res.arrayBuffer();
      const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: true, status: res.status, statusText: res.statusText, headers, body: viviB64(buf) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    finally { clearTimeout(timer); }
  })().then(sendResponse);
  return true;
});

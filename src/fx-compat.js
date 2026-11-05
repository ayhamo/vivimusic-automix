/**
 * VIVIMUSIC WEB (Firefox) — fx-compat.js  (content-script side)
 *
 * 1. fetch() fallback: Firefox content scripts are subject to the page's CORS
 *    (and, on some versions, CSP). If a direct fetch to one of our known API
 *    hosts fails with a network error, retry through the background page,
 *    which has full host-permission access.
 * 2. page-world helper for reading YouTube's player API (Xray vision hides
 *    page-defined methods like getVideoData from content scripts).
 */
(() => {
  'use strict';
  if (window.__VIVI_FX_COMPAT__) return;
  window.__VIVI_FX_COMPAT__ = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);

  function b64ToBytes(b64) {
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function proxyFetch(url, init) {
    let headers;
    if (init?.headers) {
      headers = {};
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    }
    let body = init?.body;
    if (body instanceof URLSearchParams) body = body.toString();
    if (body != null && typeof body !== 'string') throw new TypeError('unsupported body for proxy');
    const resp = await chrome.runtime.sendMessage({
      type: 'VIVI_FETCH', url: String(url), method: init?.method || 'GET', headers, body,
    });
    if (!resp?.ok) throw new TypeError(resp?.error || 'proxy fetch failed');
    const status = resp.status;
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : b64ToBytes(resp.body), { status, statusText: resp.statusText, headers: resp.headers });
  }

  // net.js already relays every cross-origin fetch through the background in
  // this fork, and Firefox makes the patched fetch read-only afterwards.
  if (!window.__viviNetPatched) globalThis.fetch = async function viviFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let abs;
    try { abs = new URL(url, location.href); } catch { return nativeFetch(input, init); }
    if (abs.origin === location.origin || abs.protocol === 'moz-extension:' || abs.protocol === 'chrome-extension:' || abs.protocol === 'blob:' || abs.protocol === 'data:') {
      return nativeFetch(input, init);
    }
    try {
      return await nativeFetch(input, init);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (init?.signal?.aborted) throw err;
      try { return await proxyFetch(abs.href, init); } catch { throw err; }
    }
  };

  // Page-world player access (Firefox Xray): returns the player element's
  // getVideoData() result, or null.
  window.__viviPageVideoData = function () {
    try {
      const el = document.querySelector('#movie_player, ytmusic-player');
      const raw = el && el.wrappedJSObject;
      const fn = raw && raw.getVideoData;
      if (typeof fn === 'function') {
        const d = fn.call(raw);
        const id = d && d.video_id;
        return id ? { video_id: String(id) } : null;
      }
    } catch { /* ignore */ }
    return null;
  };
})();

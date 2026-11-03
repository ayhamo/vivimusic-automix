/* VIVIMUSIC WEB (Firefox) — fx-storage.js  (content script, isolated world)
 *
 * Firefox's storage.local.get occasionally fails right as a page loads
 * ("An unexpected error occurred"). The callback then gets `undefined`, and
 * every module reading its settings in that moment would silently fall back
 * to "off". Retry such reads a few times before giving up.
 */
(() => {
  'use strict';
  if (window.__viviStorageRetry) return;
  window.__viviStorageRetry = true;
  const area = chrome.storage && chrome.storage.local;
  if (!area) return;
  const nativeGet = area.get.bind(area);

  const read = (keys, tries) => new Promise((resolve, reject) => {
    Promise.resolve(nativeGet(keys)).then(resolve, (err) => {
      if (tries <= 0) { reject(err); return; }
      setTimeout(() => read(keys, tries - 1).then(resolve, reject), 250);
    });
  });

  function get(keys, callback) {
    const p = read(keys === undefined ? null : keys, 4);
    if (typeof callback !== 'function') return p;
    p.then(callback, (err) => console.warn('[Vivimusic] storage read failed:', err && err.message));
    return undefined;
  }

  try { area.get = get; } catch { /* read-only in this browser: keep the native one */ }
})();

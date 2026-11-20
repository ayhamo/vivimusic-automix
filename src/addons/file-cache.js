/* Vivimusic Web+ — addons/file-cache.js (background script; node for tests)
 *
 * The persistent addon cache (spec/addons/protocol.md §8.1.6): the addon files the deck
 * played, kept across plays so a replay needs no /stream call and no download. Keyed by
 * addon (its list id), row and quality, never by the file URL (it holds a token). Least
 * recently played dropped first once the size setting is passed; size 0 keeps nothing.
 *
 *   create({ open, storage, maxBytes, now })
 *     open()      -> a Cache-like store { match(url), put(url, Response), delete(url) } (the Cache API)
 *     storage     -> chrome.storage.local-like { get(defaults), set(patch) }: holds the index
 *     maxBytes()  -> the size setting in bytes (async)
 *   keyOf(addonId, rowId, quality) -> the key
 *   has(key)                -> the entry's meta, or null (the index only, no file read)
 *   get(key)                -> { bytes, meta } or null; marks it played
 *   put(key, bytes, meta)   -> true when kept
 *   drop(key)               forgets one file
 *   stats()                 -> { files, bytes }
 *   clear()
 *
 * globalThis.__viviAddonFileCache
 */
(() => {
  'use strict';
  const INDEX = 'addonsCacheIndex';   // storage.local: { key: { size, at, meta } }
  const PREFIX = 'https://vivi-addon-cache.invalid/';
  const urlOf = (key) => PREFIX + encodeURIComponent(key);

  function create({ open = () => globalThis.caches.open('vivi-addon-files'), storage, maxBytes = async () => 512e6, now = () => Date.now() } = {}) {
    let store = null;
    const files = () => (store ??= Promise.resolve(open()));
    // index reads and writes one at a time, so two plays can't lose each other's entries
    let turn = Promise.resolve();
    const inTurn = (f) => { const p = turn.then(f); turn = p.catch(() => {}); return p; };
    const index = async () => (await storage.get({ [INDEX]: {} }))[INDEX] || {};
    const save = (ix) => storage.set({ [INDEX]: ix });

    const keyOf = (addonId, rowId, quality) => [addonId, rowId, quality || ''].map((x) => String(x ?? '')).join('|');

    async function has(key) {
      if (!(await maxBytes())) return null;
      return (await index())[key]?.meta ?? null;
    }

    function get(key) {
      return inTurn(async () => {
        if (!(await maxBytes())) return null;
        const ix = await index();
        if (!ix[key]) return null;
        const r = await (await files()).match(urlOf(key));
        if (!r) { delete ix[key]; await save(ix); return null; }   // the browser let it go
        ix[key] = { ...ix[key], at: now() };
        await save(ix);
        return { bytes: await r.arrayBuffer(), meta: ix[key].meta };
      });
    }

    function put(key, bytes, meta = {}) {
      return inTurn(async () => {
        const max = await maxBytes(), size = bytes?.byteLength || 0;
        if (!max || !size || size > max) return false;
        const ix = await index(), c = await files();
        delete ix[key];
        // least recently played out first, until the new file fits
        let total = Object.values(ix).reduce((n, e) => n + (e.size || 0), 0);
        for (const [k] of Object.entries(ix).sort((a, b) => a[1].at - b[1].at)) {
          if (total + size <= max) break;
          total -= ix[k].size || 0;
          delete ix[k];
          await c.delete(urlOf(k));
        }
        await c.put(urlOf(key), new Response(bytes, { headers: { 'content-type': meta.mime || 'application/octet-stream' } }));
        ix[key] = { size, at: now(), meta };
        await save(ix);
        return true;
      });
    }

    // the size setting went down: drop the oldest until within it
    function trim() {
      return inTurn(async () => {
        const max = await maxBytes(), ix = await index(), c = await files();
        let total = Object.values(ix).reduce((n, e) => n + (e.size || 0), 0);
        for (const [k] of Object.entries(ix).sort((a, b) => a[1].at - b[1].at)) {
          if (total <= max) break;
          total -= ix[k].size || 0;
          delete ix[k];
          await c.delete(urlOf(k));
        }
        await save(ix);
      });
    }

    function drop(key) {
      return inTurn(async () => {
        const ix = await index();
        if (!ix[key]) return false;
        delete ix[key];
        await (await files()).delete(urlOf(key));
        await save(ix);
        return true;
      });
    }

    async function stats() {
      const ix = await index();
      return { files: Object.keys(ix).length, bytes: Object.values(ix).reduce((n, e) => n + (e.size || 0), 0) };
    }

    function clear() {
      return inTurn(async () => {
        const ix = await index(), c = await files();
        for (const k of Object.keys(ix)) await c.delete(urlOf(k));
        await save({});
      });
    }

    return { keyOf, has, get, put, drop, trim, stats, clear };
  }

  const api = { create, INDEX };
  globalThis.__viviAddonFileCache = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

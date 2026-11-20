/* Vivimusic Web+ — plus/canvas-settings.js (popup, content scripts, Apple player; node for tests)
 *
 * The canvas settings of spec/canvas/canvas.md §13, as pure reads of what is stored:
 *   parseOrder(csv)        the source order: unknown names dropped, a repeat counts once,
 *                          the missing ones follow in the default order (rule 3)
 *   parseEnabled(csv)      the sources on, in the default order: '' = all, 'NONE' = none
 *   storeEnabled(list)     the other way: all on -> '', none on -> 'NONE'
 *   pickVariant(v, cap)    Apple's HLS variant for a quality cap (rule 5): v = [[w, h, bandwidth]],
 *                          cap = the shorter side's limit or null (Original); the most pixels
 *                          within the cap (ties: higher bandwidth), else the fewest pixels
 *   capOf(quality)         '360' | '720' | '1080' | 'original' -> 360 | 720 | 1080 | null
 *
 * Storage keys (chrome.storage.local) with their defaults: KEYS.
 * globalThis.__viviCanvasSettings
 */
(() => {
  'use strict';
  const SOURCES = ['video', 'spotify', 'apple'];
  const KEYS = {
    canvasSourceOrder: '',        // rule 3: the order, comma separated
    canvasSourcesOn: '',          // rule 3: the sources on ('' all, 'NONE' none)
    appleCoverQuality: '720',     // rule 5: 360 | 720 | 1080 | original
    videoCanvasQuality: '480',    // rule 6: auto | 2160 | 1440 | 1080 | 720 | 480
    videoCanvasMode: 'clips',     // rule 7: clips | full
  };
  const COVER_QUALITIES = ['360', '720', '1080', 'original'];
  const VIDEO_QUALITIES = ['auto', '2160', '1440', '1080', '720', '480'];

  const names = (csv) => String(csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  function parseOrder(csv) {
    const out = [];
    for (const n of names(csv)) if (SOURCES.includes(n) && !out.includes(n)) out.push(n);
    for (const n of SOURCES) if (!out.includes(n)) out.push(n);
    return out;
  }

  function parseEnabled(csv) {
    const s = String(csv ?? '').trim();
    if (!s) return SOURCES.slice();
    if (s === 'NONE') return [];
    const on = names(s);
    return SOURCES.filter((n) => on.includes(n));
  }

  function storeEnabled(list) {
    const on = SOURCES.filter((n) => (list || []).includes(n));
    return on.length === SOURCES.length ? '' : on.length ? on.join(',') : 'NONE';
  }

  const capOf = (q) => (q === 'original' ? null : COVER_QUALITIES.includes(String(q)) ? Number(q) : 720);

  function pickVariant(variants, cap) {
    let best = -1, bestPx = -1, bestBw = -1, small = -1, smallPx = Infinity;
    (variants || []).forEach(([w, h, bw], i) => {
      const px = (w || 0) * (h || 0);
      if (px < smallPx) { small = i; smallPx = px; }
      if (cap != null && Math.min(w || 0, h || 0) > cap) return;
      if (px > bestPx || (px === bestPx && (bw || 0) > bestBw)) { best = i; bestPx = px; bestBw = bw || 0; }
    });
    return best >= 0 ? best : small;
  }

  // the stored values, read with their defaults
  function read(stored = {}) {
    const g = (k) => (stored[k] ?? KEYS[k]);
    return {
      order: parseOrder(g('canvasSourceOrder')),
      on: parseEnabled(g('canvasSourcesOn')),
      coverQuality: COVER_QUALITIES.includes(String(g('appleCoverQuality'))) ? String(g('appleCoverQuality')) : KEYS.appleCoverQuality,
      videoQuality: VIDEO_QUALITIES.includes(String(g('videoCanvasQuality'))) ? String(g('videoCanvasQuality')) : KEYS.videoCanvasQuality,
      mode: g('videoCanvasMode') === 'full' ? 'full' : 'clips',
    };
  }

  const api = { SOURCES, KEYS, COVER_QUALITIES, VIDEO_QUALITIES, parseOrder, parseEnabled, storeEnabled, pickVariant, capOf, read };
  globalThis.__viviCanvasSettings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

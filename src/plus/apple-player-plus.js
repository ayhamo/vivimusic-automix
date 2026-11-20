// Vivimusic Web+: the animated cover quality (canvas.md §13 rule 5) in upstream's Apple player
// (src/apple-canvas-player.html). Its hls.js gets the master list; once parsed, the variant with
// the most pixels whose shorter side is within the cap is locked (canvas-settings.js pickVariant).
// The cache keeps the master list's URL, so a new quality applies at the next play, no new lookup.
'use strict';
(() => {
  const CS = globalThis.__viviCanvasSettings;
  if (!CS) return;
  let cap;                    // undefined until read
  let lock = null;            // runs once both the setting and the levels are in
  try {
    chrome.storage.local.get({ appleCoverQuality: CS.KEYS.appleCoverQuality }, (s) => { cap = CS.capOf(s?.appleCoverQuality); lock?.(); });
  } catch { cap = CS.capOf(CS.KEYS.appleCoverQuality); }
  window.__viviApplePlayer = (hls) => {
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
      const levels = data?.levels || hls.levels || [];
      lock = () => {
        if (cap === undefined || levels.length < 2) return;
        lock = null;
        const i = CS.pickVariant(levels.map((l) => [l.width || 0, l.height || 0, l.bitrate || 0]), cap);
        if (i >= 0) hls.currentLevel = i;
      };
      lock();
    });
  };
})();

/* Vivimusic Web+ — plus/pill-bar.js
 * The pill player bar's title and artist lines: one too long for its room scrolls back and forth
 * (plus.css .vivi-marquee), at about 30 px a second, so the whole name can be read.
 */
(() => {
  'use strict';
  if (window.__viviPillBar) return;
  window.__viviPillBar = true;
  const SEL = ['ytmusic-player-bar .content-info-wrapper .title', 'ytmusic-player-bar .content-info-wrapper .byline'];
  const seen = new WeakMap();   // line -> the text it scrolls for
  function check() {
    if (!document.documentElement.classList.contains('vivi-pill-player')) return;
    for (const sel of SEL) {
      const el = document.querySelector(sel), box = el?.closest('.content-info-wrapper');
      if (!el || !box) continue;
      const text = el.textContent || '', room = box.clientWidth, full = el.scrollWidth;
      const over = full - room;
      if (over > 2) {
        if (seen.get(el) === text + '|' + room && el.classList.contains('vivi-marquee')) continue;
        el.style.setProperty('--vivi-marquee-px', over + 'px');
        el.style.setProperty('--vivi-marquee-sec', Math.max(6, over / 30 / 0.7).toFixed(1) + 's');
        el.classList.remove('vivi-marquee'); void el.offsetWidth; el.classList.add('vivi-marquee');   // (from the start for a new name)
        seen.set(el, text + '|' + room);
      } else if (el.classList.contains('vivi-marquee')) {
        el.classList.remove('vivi-marquee');
        // (its own width again: measured next time without the scroll)
        seen.delete(el);
      }
    }
  }
  setInterval(check, 1000);
})();

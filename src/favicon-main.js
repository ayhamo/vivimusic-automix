/**
 * VIVIMUSIC WEB (Firefox) — favicon-main.js
 * Runs in the PAGE's own JS world at document_start. Inserting the <link rel=icon>
 * from the page world (instead of from the content-script sandbox) is what
 * Firefox's tab-icon loader handles most reliably, and sidesteps Xray wrappers.
 * Idempotent with the identical logic in loader.js (same data-vivi marker).
 */
(() => {
  'use strict';
  if (window.__viviFaviconMain) return;
  window.__viviFaviconMain = true;
  const HREF = "https://music.youtube.com/vivi-favicon.png?v=1";
  const ours = (el) => el.getAttribute && el.getAttribute('data-vivi') === '1';

  function make() {
    const l = document.createElement('link');
    l.setAttribute('rel', 'icon');
    l.setAttribute('type', 'image/png');
    l.setAttribute('sizes', '32x32');
    l.setAttribute('data-vivi', '1');
    l.setAttribute('href', HREF);
    return l;
  }
  function ensure() {
    const head = document.head;
    if (!head) return;
    head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((el) => { if (!ours(el)) el.remove(); });

  }
  // Diagnostics (visible in the page console)
  document.addEventListener('securitypolicyviolation', (e) => {
    try { console.warn('[Vivimusic] CSP blocked:', e.violatedDirective, String(e.blockedURI).slice(0, 80)); } catch (_) {}
  }, true);
  const report = (tag) => {
    try {
      const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')]
        .map((l) => (l.getAttribute('data-vivi') === '1' ? 'VIVI' : (l.href || '').slice(0, 70)));
      console.info('[Vivimusic] icon links @' + tag + ':', links.length, links);
    } catch (_) {}
  };
  setTimeout(() => report('3s'), 3000);
  setTimeout(() => report('10s'), 10000);
  ensure();
  let pending = false;
  new MutationObserver((muts) => {
    if (pending) return;
    let hit = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'LINK' || n.tagName === 'HEAD' || n.tagName === 'HTML')) { hit = true; break; }
      }
      if (hit) break;
    }
    if (!hit) return;
    pending = true;
    setTimeout(() => { pending = false; ensure(); }, 100);
  }).observe(document, { childList: true, subtree: true });
  window.addEventListener('DOMContentLoaded', ensure);
  window.addEventListener('load', ensure);
  let n = 0; const t = setInterval(() => { ensure(); if (++n > 30) clearInterval(t); }, 2000);
})();

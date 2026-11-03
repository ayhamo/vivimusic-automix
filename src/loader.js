/**
 * VIVIMUSIC WEB — loader.js
 *
 * Runs at document_start, before YT Music has painted anything, so we can
 * cover the page with our own splash before the stock UI has a chance to
 * flash in unstyled/partially-themed.
 */

(() => {
  'use strict';

  const OVERLAY_ID   = 'vivi-loading-overlay';
  const MIN_VISIBLE  = 350;   // avoid a jarring one-frame flash on fast loads
  const HARD_TIMEOUT = 8000;  // never block the app forever if something goes wrong

  let logoUrl = '';
  try {
    logoUrl = chrome.runtime.getURL('icons/custom-logo-icon.png');
  } catch { /* no-op */ }

  // ── Favicon override, as early as possible ──
  // This runs at document_start, before the parser has even produced <head>
  // in most cases, so there's no favicon to remove yet — we just need to make
  // sure OUR icon link wins the moment <head> (and YT Music's own icon link
  // inside it) shows up. We watch for both events and strip anything that
  // isn't ours the instant it appears, which is as close to zero-flicker as
  // a content script can get (a native browser feature, not something we
  // can hook synchronously the way a MutationObserver requires a tick).
  // Firefox won't show moz-extension:// icons that a web page links as its
  // favicon (the tab strip loads favicons outside the page's context), so the
  // icon is embedded as a small data: URI, which works in every browser.
  const FAVICON_DATA_URI = chrome.runtime.getURL('icons/custom-logo-icon.png');

  function installFaviconOverride() {
    function isOurs(el) { return el.dataset && el.dataset.vivi === '1'; }

    function ourLink() {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = FAVICON_DATA_URI;
            link.dataset.vivi = '1';
      return link;
    }

    function stripForeignIcons(root) {
      root.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]').forEach((el) => {
        if (!isOurs(el)) el.remove();
      });
    }

    function ensureOurs() {
      if (!document.head) return;
      stripForeignIcons(document.head);
      if (!document.head.querySelector('link[data-vivi="1"]')) {
        document.head.insertBefore(ourLink(), document.head.firstChild);
      }
    }

    ensureOurs();

    const observer = new MutationObserver((mutations) => {
      if (!document.head) return;
      let needs = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('link[rel~="icon"]') && !isOurs(node)) needs = true;
          else if (node.querySelector?.('link[rel~="icon"]')) needs = true;
        }
        for (const node of m.removedNodes) {
          if (node.nodeType === 1 && isOurs(node)) needs = true;
        }
      }
      if (needs) ensureOurs();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // Belt and braces: re-assert on load and periodically for the first minute.
    window.addEventListener('load', ensureOurs);
    let n = 0; const t = setInterval(() => { ensureOurs(); if (++n > 30) clearInterval(t); }, 2000);
  }
  installFaviconOverride();
  // Firefox only (re)loads the tab icon reliably when a link's href CHANGES after
  // the initial pass, so re-point our icon link at the packaged logo several
  // times while the page loads (the query string is ignored by the file).
  (function bumpFavicon() {
    let n = 0;
    const base = chrome.runtime.getURL('icons/custom-logo-icon.png');
    function bump() {
      const el = document.querySelector('link[data-vivi="1"]');
      if (!el) return;
      el.href = base + '?v=' + (++n);
    }
    [300, 1000, 2000, 3500, 6000].forEach((ms) => setTimeout(bump, ms));
    document.addEventListener('DOMContentLoaded', bump);
    window.addEventListener('load', bump);
  })();




  // ── Title override, as early as possible ──
  // YT Music may replace the entire <title> node (not merely its text), so
  // watching only the current title element is not sufficient. Keep watching
  // <head> until content.js takes over the real track title.
  (function installTitleOverride() {
    const PLACEHOLDER = 'VIVIMUSIC';

    let writes = [];
    function enforce() {
      if (window.__viviTitleTakeover) return;
      if (document.title === PLACEHOLDER) return;
      const now = performance.now();               // never fight the page in a tight loop
      writes = writes.filter((t) => now - t < 1000);
      if (writes.length >= 20) return;
      writes.push(now);
      document.title = PLACEHOLDER;
    }

    enforce();

    const headObserver = new MutationObserver(() => enforce());
    const watch = () => {
      if (document.head) {
        headObserver.observe(document.head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        enforce();
      }
    };

    if (document.head) watch();
    else {
      const rootObserver = new MutationObserver(() => {
        if (document.head) {
          rootObserver.disconnect();
          watch();
        }
      });
      rootObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  })();

  const shownAt = Date.now();

  function injectOverlay() {
    const style = document.createElement('style');
    style.id = OVERLAY_ID + '-style';
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: #030303;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 18px;
        opacity: 1;
        transition: opacity 0.4s ease;
      }
      #${OVERLAY_ID}.vivi-loading-hide {
        opacity: 0;
        pointer-events: none;
      }
      #${OVERLAY_ID} img {
        width: 72px;
        height: 72px;
        animation: vivi-loading-pulse 1.3s ease-in-out infinite;
      }
      #${OVERLAY_ID} .vivi-loading-text {
        font-family: 'Roboto', Arial, sans-serif;
        font-size: 15px;
        letter-spacing: 0.3px;
        color: rgba(255, 255, 255, 0.72);
      }
      @keyframes vivi-loading-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50%      { transform: scale(0.88); opacity: 0.6; }
      }
    `;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    const img = document.createElement('img');
    img.src = logoUrl;
    img.alt = 'Vivimusic';

    const text = document.createElement('div');
    text.className = 'vivi-loading-text';
    text.textContent = 'Loading Vivimusic…';

    overlay.appendChild(img);
    overlay.appendChild(text);

    const root = document.documentElement;
    root.appendChild(style);
    root.appendChild(overlay);
  }

  // documentElement always exists by the time a content script runs, even
  // at document_start, so we don't need to wait for it.
  injectOverlay();

  function removeOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    const style   = document.getElementById(OVERLAY_ID + '-style');
    if (!overlay) return;

    const elapsed = Date.now() - shownAt;
    const wait = Math.max(0, MIN_VISIBLE - elapsed);

    setTimeout(() => {
      overlay.classList.add('vivi-loading-hide');
      overlay.addEventListener('transitionend', () => {
        overlay.remove();
        style?.remove();
      }, { once: true });
      // Fallback in case transitionend doesn't fire for some reason
      setTimeout(() => { overlay.remove(); style?.remove(); }, 600);
    }, wait);
  }

  function whenReady() {
    // YT Music is a SPA shell — "ready" means its nav bar / player bar has
    // actually mounted, not just that the HTML document finished loading.
    if (document.querySelector('ytmusic-nav-bar, ytmusic-player-bar')) {
      removeOverlay();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector('ytmusic-nav-bar, ytmusic-player-bar')) {
        observer.disconnect();
        removeOverlay();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Absolute fallback so a slow/odd load never leaves the cover stuck up.
    setTimeout(() => {
      observer.disconnect();
      removeOverlay();
    }, HARD_TIMEOUT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', whenReady);
  } else {
    whenReady();
  }
})();

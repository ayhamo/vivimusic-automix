/**
 * VIVIMUSIC XTEN — fullscreen-mode.js
 *
 * Always on (independent of the "Full screen mode" setting):
 *   • switches the pill-shaped player bar style off while YTM is fullscreen and
 *     straight back on when leaving it;
 *   • auto-hides the player bar in fullscreen and shows it again near the
 *     bottom edge (the "Auto-hide player bar" setting);
 *   • while YTM is fullscreen with the pill player bar, measures where the
 *     thumbnail inside the bar ends and publishes --vivi-prog-left so the seek
 *     bar starts after it instead of running underneath it.
 *
 * Only while the "Full screen mode" setting is on (window.__viviFullscreenMode.set):
 *   • toggles html.vivi-fs-mode (the layout itself lives in fullscreen-mode.css);
 *   • while fullscreen, selects the Lyrics tab (the CSS hides the tab strip),
 *     nudges YouTube's player to re-measure so videos fill the screen, and
 *     measures the offset of position:fixed children of the player page,
 *     published as --vivi-fs-x/-y/-r/-b (hidden probe element, removed again);
 */
(() => {
  'use strict';

  const CLASS = 'vivi-fs-mode';
  const SHOW_CLASS = 'vivi-fs-bar-show';
  const PROBE_ID = 'vivi-fs-probe';
  const VARS = ['--vivi-fs-x', '--vivi-fs-y', '--vivi-fs-r', '--vivi-fs-b'];
  const root = document.documentElement;

  let modeOn = false; // mirrors the Full screen mode setting

  // classList.add/remove rewrite the class attribute (and fire MutationObservers)
  // even when nothing changes. We watch <html>'s class attribute, so only touch
  // it when the state really changes, or we would retrigger ourselves forever.
  function setRootClass(name, on) {
    if (document.documentElement.classList.contains(name) === on) return;
    document.documentElement.classList.toggle(name, on);
  }
  const getPage = () => document.querySelector('ytmusic-player-page');
  const BAR_SEL = 'ytmusic-player-bar, ytmusic-miniplayer';
  const getBar = () => document.querySelector('ytmusic-player-bar') || document.querySelector('ytmusic-miniplayer');
  const isFullscreened = (page) => !!page && page.hasAttribute('player-fullscreened');

  /* ───────────── Always on: pill seek bar vs. thumbnail ───────────── */

  let progTimer = null;

  function syncPillProgress() {
    const bar = getBar();
    if (!bar) return;
    if (!isFullscreened(getPage())) {
      bar.style.removeProperty('--vivi-prog-left');
      return;
    }
    const thumb = bar.querySelector('.middle-controls img, .middle-controls .image, .thumbnail-image-wrapper img');
    if (!thumb) return;
    const t = thumb.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    if (!t.width || !b.width) return;
    bar.style.setProperty('--vivi-prog-left', Math.round(t.right - b.left + 14) + 'px');
  }

  function updateProgTimer() {
    const fs = isFullscreened(getPage());
    if (fs && !progTimer) {
      syncPillProgress();
      progTimer = setInterval(syncPillProgress, 800);
    } else if (!fs && progTimer) {
      clearInterval(progTimer);
      progTimer = null;
      syncPillProgress();
    }
  }

  /* ───────────── Always on: player bar auto-hide in fullscreen ─────────────
     While fullscreen (and the "Auto-hide player bar" setting is on) the bar
     fades out, and comes back when the pointer is near the bottom edge or over
     the bar, when the bar has keyboard focus, while a menu is open, and while
     the seek bar is being dragged. It is shown for a moment on entering
     fullscreen and is back to normal the instant fullscreen ends. */

  const AUTO_CLASS = 'vivi-fs-autohide';
  const ZONE_PX = 120;
  let autoHideSetting = true;
  let barHideTimer = null;
  let barDragging = false;

  const autoHideWanted = () => autoHideSetting && isFullscreened(getPage());

  function menuOpen() {
    return Array.from(document.querySelectorAll('ytmusic-popup-container tp-yt-iron-dropdown')).some(
      (d) => d.getAttribute('aria-hidden') !== 'true' &&
             getComputedStyle(d).display !== 'none' &&
             d.getBoundingClientRect().height > 0
    );
  }

  // Only real keyboard use inside the bar keeps it open. Focus left behind by
  // a mouse click (seek bar, volume slider, buttons) must not, so we track the
  // time of the last key press ourselves instead of trusting :focus / :focus-visible.
  let lastKeyTs = 0;
  document.addEventListener('keydown', () => { lastKeyTs = Date.now(); }, true);
  document.addEventListener('mousedown', () => { lastKeyTs = 0; }, true);

  function keyboardFocusInBar(bar) {
    const ae = document.activeElement;
    if (!bar || !ae || ae === document.body || !bar.contains(ae)) return false;
    return Date.now() - lastKeyTs < 3000;
  }

  function dropFocusInBar(bar) {
    const ae = document.activeElement;
    if (bar && ae && ae !== document.body && bar.contains(ae) && typeof ae.blur === 'function') ae.blur();
  }

  function holdBar() {
    clearTimeout(barHideTimer);
    barHideTimer = null;
    setRootClass(SHOW_CLASS, true);
  }

  function releaseBar(delay) {
    clearTimeout(barHideTimer);
    barHideTimer = setTimeout(function tryHide() {
      barHideTimer = null;
      if (!autoHideWanted()) return;
      const bar = getBar();
      if (barDragging || menuOpen() || (bar && (bar.matches(':hover') || keyboardFocusInBar(bar)))) {
        barHideTimer = setTimeout(tryHide, 600);
        return;
      }
      setRootClass(SHOW_CLASS, false);
      // A slider you just clicked (seek / volume) keeps focus and its "active"
      // knob; drop it so the bar goes back to its idle look.
      dropFocusInBar(bar);
    }, delay);
  }

  function updateAutoHide() {
    const on = autoHideWanted();
    const was = root.classList.contains(AUTO_CLASS);
    setRootClass(AUTO_CLASS, on);
    if (on && !was) {
      holdBar();            // show it briefly on entering fullscreen
      releaseBar(2500);
    } else if (!on) {
      clearTimeout(barHideTimer);
      barHideTimer = null;
      barDragging = false;
      setRootClass(SHOW_CLASS, false);
    }
  }

  document.addEventListener('mousemove', (e) => {
    if (!root.classList.contains(AUTO_CLASS)) return;
    if (barDragging && e.buttons === 0) { // button released outside the page
      barDragging = false;
      releaseBar(900);
    }
    const rect = getBar()?.getBoundingClientRect();
    const nearBottom = e.clientY >= window.innerHeight - ZONE_PX;
    const overBar = !!rect && e.clientY >= rect.top - 16 && e.clientX >= rect.left && e.clientX <= rect.right;
    if (nearBottom || overBar) holdBar();
    else if (root.classList.contains(SHOW_CLASS) && !barHideTimer) releaseBar(900);
  }, { passive: true });

  document.addEventListener('mousedown', (e) => {
    if (!root.classList.contains(AUTO_CLASS)) return;
    if (e.target instanceof Element && e.target.closest(BAR_SEL)) {
      barDragging = true;
      holdBar();
    }
  }, true);

  document.addEventListener('mouseup', () => {
    if (!barDragging) return;
    barDragging = false;
    if (root.classList.contains(AUTO_CLASS)) releaseBar(1200);
  }, true);
  window.addEventListener('blur', () => { barDragging = false; });

  document.addEventListener('focusin', (e) => {
    if (!root.classList.contains(AUTO_CLASS) || !(e.target instanceof Element)) return;
    if (e.target.closest(BAR_SEL) && Date.now() - lastKeyTs < 3000) holdBar();
  });
  document.addEventListener('focusout', (e) => {
    if (root.classList.contains(AUTO_CLASS) && e.target instanceof Element && e.target.closest(BAR_SEL)) releaseBar(1200);
  });

  /* ───────────── Always on: no Home flash when leaving fullscreen ─────────────
     While the player page is open the page content is hidden with a *delayed*
     visibility transition (so the slide-up looks smooth). Leaving fullscreen
     re-shows that content for a moment, so keep it hidden for a short grace
     period (html.vivi-fs-exit) as long as the player page is still open. */

  const EXIT_CLASS = 'vivi-fs-exit';
  let prevFsCount = 0;
  let prevDomFs = false;
  let exitTimer = null;

  const onWatchPage = () => {
    const path = window.location.pathname || '';
    return path === '/watch' || path.startsWith('/watch/');
  };

  // Must fire at the FIRST sign that fullscreen is ending: YTM removes
  // [player-fullscreened] from the app layout (which un-hides the page content)
  // before it removes it from the player page, and the browser's own
  // fullscreenchange can come even earlier. Waiting for the last signal is
  // too late and the page flashes for a frame.
  function syncExitGrace() {
    const count = document.querySelectorAll('[player-fullscreened]').length;
    const domFs = !!document.fullscreenElement;
    const ended = (prevFsCount > 0 && count < prevFsCount) || (prevDomFs && !domFs);
    if (ended) {
      if (onWatchPage() && !root.hasAttribute('vivi-player-closed')) {
        setRootClass(EXIT_CLASS, true);
        clearTimeout(exitTimer);
        exitTimer = setTimeout(() => setRootClass(EXIT_CLASS, false), 1100);
      }
    } else if (count > prevFsCount) { // entering fullscreen
      clearTimeout(exitTimer);
      setRootClass(EXIT_CLASS, false);
    }
    prevFsCount = count;
    prevDomFs = domFs;
  }

  /* ───────────── Always on: pill bar style off while fullscreen ─────────────
     Entering fullscreen switches the pill-shaped player bar style off (the
     normal bar is used instead); leaving fullscreen switches it straight back
     on, if the Appearance setting is on. Only the html.vivi-pill-player class
     is touched — the saved setting itself never changes. */

  const PILL_CLASS = 'vivi-pill-player';
  let pillSuspended = false;

  function syncPillForFullscreen() {
    if (isFullscreened(getPage())) {
      if (root.classList.contains(PILL_CLASS)) {
        pillSuspended = true;
        setRootClass(PILL_CLASS, false);
      }
    } else if (pillSuspended) {
      pillSuspended = false;
      setRootClass(PILL_CLASS, true); // instant
      // If the setting was switched off meanwhile, respect that.
      try {
        chrome.storage.local.get({ pillPlayerEnabled: true }, (r) => {
          if (r && r.pillPlayerEnabled === false && !isFullscreened(getPage())) setRootClass(PILL_CLASS, false);
        });
      } catch (_) { /* storage unavailable: keep it on */ }
    }
  }

  /* ───────────── Full screen mode (setting) ───────────── */

  let enabled = false;
  let raf = 0;
  let timers = [];
  let observer = null;
  let tabTimer = null;
  let synthetic = false;

  function clearVars() { VARS.forEach((v) => root.style.removeProperty(v)); }
  function removeProbe() { document.getElementById(PROBE_ID)?.remove(); }

  function setPx(name, value) {
    const px = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
    root.style.setProperty(name, px + 'px');
  }

  function measure() {
    raf = 0;
    const page = getPage();
    if (!enabled || !isFullscreened(page)) {
      removeProbe();
      clearVars();
      return;
    }
    const host = page.querySelector('.content') || page;
    let probe = document.getElementById(PROBE_ID);
    if (probe && probe.parentElement !== host) {
      probe.remove();
      probe = null;
    }
    if (!probe) {
      probe = document.createElement('div');
      probe.id = PROBE_ID;
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;width:auto;height:auto;' +
        'margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;transform:none;';
      host.appendChild(probe);
    }
    const r = probe.getBoundingClientRect();
    setPx('--vivi-fs-x', -r.left);
    setPx('--vivi-fs-y', -r.top);
    setPx('--vivi-fs-r', r.right - root.clientWidth);
    setPx('--vivi-fs-b', r.bottom - root.clientHeight);
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(measure);
  }

  // Fullscreen mode shows lyrics only, so make sure the Lyrics tab is the
  // selected one. Skipped in video mode (no side panel there).
  function ensureLyricsTab() {
    const page = getPage();
    if (!enabled || !isFullscreened(page) || page.hasAttribute('video-mode')) return;
    const tabs = Array.from(page.querySelectorAll('tp-yt-paper-tab, yt-tab-shape'));
    if (!tabs.length) return;
    const T = window.__viviTabs;
    const lyrics = tabs.find((t) =>
      T ? T.kindOf(t, tabs) === 'lyrics' : (t.textContent || '').trim().toLowerCase() === 'lyrics'
    );
    if (!lyrics) return;
    if (lyrics.getAttribute('aria-selected') === 'true' || lyrics.hasAttribute('selected')) return;
    if (lyrics.hasAttribute('disabled') || lyrics.getAttribute('aria-disabled') === 'true') return;
    lyrics.click();
  }

  // YouTube's player sizes the <video> from its container on window resize.
  function nudge() {
    synthetic = true;
    try { window.dispatchEvent(new Event('resize')); } finally { synthetic = false; }
  }

  function onResize() { if (!synthetic) schedule(); }

  function burst() {
    schedule();
    timers.forEach(clearTimeout);
    timers = [120, 400, 900, 1600].map((ms) => setTimeout(() => {
      schedule();
      if (enabled && isFullscreened(getPage())) { nudge(); ensureLyricsTab(); }
    }, ms));
  }

  function onChange() {
    if (!enabled) return;
    burst();
  }

  function onTransitionEnd(e) {
    if (enabled && e.target instanceof Element && e.target.closest('ytmusic-player-page')) schedule();
  }

  function attach() {
    if (observer) return;
    observer = new MutationObserver(onChange);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['player-fullscreened', 'video-mode', 'is-mweb-modernization-enabled'],
    });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('transitionend', onTransitionEnd, true);
    tabTimer = setInterval(ensureLyricsTab, 1500);
  }

  function detach() {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onChange);
    document.removeEventListener('transitionend', onTransitionEnd, true);
    if (tabTimer) clearInterval(tabTimer);
    tabTimer = null;
    timers.forEach(clearTimeout);
    timers = [];
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function set(on) {
    const was = enabled;
    enabled = on === true;
    modeOn = enabled;
    setRootClass(CLASS, enabled);
    if (enabled) {
      attach();
      burst();
    } else {
      detach();
      removeProbe();
      clearVars();
      if (was) nudge();
    }
  }

  /* Always-on observer: fullscreen state drives the seek-bar sync */
  const onFsState = () => { syncExitGrace(); syncPillForFullscreen(); updateProgTimer(); updateAutoHide(); };
  new MutationObserver(onFsState).observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ['player-fullscreened'],
  });
  // The pill setting is a class on <html>; watch only <html> itself (not the subtree).
  new MutationObserver(onFsState).observe(root, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('fullscreenchange', onFsState);
  window.addEventListener('resize', () => { if (progTimer) syncPillProgress(); }, { passive: true });
  onFsState();

  window.__viviFullscreenMode = {
    set,
    setAutoHide(on) {
      autoHideSetting = on !== false;
      updateAutoHide();
    },
  };
})();

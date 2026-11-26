/* Vivimusic Web+ — autoplay-row-page.js  (runs in the page's MAIN world)
 *
 * YouTube Music's Autoplay row at the top of Up next (its title and switch) is
 * hidden by its own rule shouldHideAutomixHeading(autoMixItems, cast state,
 * shouldHideAutoplay), which also reads isQueue (is Up next showing?) but only
 * runs again when one of its three inputs changes. A song that starts on the
 * Lyrics tab (the lyrics panel switches there at each song) has it run while
 * isQueue is false, and the row then stays hidden on Up next until the
 * autoplay list changes: the switch is never there. Here the same rule is run
 * again while Up next shows, and the row follows it.
 */
(() => {
  'use strict';
  if (window.__viviAutoplayRow) return;
  window.__viviAutoplayRow = true;

  function check() {
    const tr = document.querySelector('ytmusic-player-page ytmusic-tab-renderer');
    const row = tr?.querySelector('.autoplay.ytmusic-tab-renderer');
    const c = tr?.polymerController || tr;
    if (!row || !c?.isQueue || typeof c.shouldHideAutomixHeading !== 'function') return;
    let hide;
    try { hide = !!c.shouldHideAutomixHeading(c.autoMixItems || [], c.castConnectionState, c.shouldHideAutoplay); } catch { return; }
    if (row.hidden !== hide) row.hidden = hide;
  }

  setInterval(check, 1000);
  // a tab change: at once, not up to a second later
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape')) setTimeout(check, 150);
  }, true);
})();

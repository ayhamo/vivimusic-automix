/* VIVIMUSIC WEB — music-only.js  (content script, isolated world)
 *
 * "Prefer music-only version", after BitChord's MusicOnlyPlayback: a music
 * video is heard as its song. YouTube Music already has this built in, as the
 * player's Song / Video switch (Song plays the album version where the queue
 * pairs one with the video, and the video's own audio without the picture
 * otherwise). The switch resets to Video on every page load, so with this
 * setting on it is flipped to Song whenever it shows Video.
 *
 * A video the listener switches back to Video by hand stays a video, as in
 * BitChord, until another song plays.
 *
 * The switch only works for a queue item YouTube Music paired with its song.
 * For a music video with no pair, src/plus/music-only-page.js finds the song
 * and adds the pair; Song is clicked once the pair is there.
 */
(() => {
  'use strict';
  if (window.__viviMusicOnly) return;
  window.__viviMusicOnly = true;

  const log = (...a) => console.log('%c[ViVi music-only]', 'color:#9ccc65', ...a);
  let on = false;
  let kept = '';   // the video the listener chose to watch as a video
  let keepAt = 0;  // when Video was clicked: the switch then moves to the video's own id

  try {
    chrome.storage.local.get({ preferMusicOnly: false }, (r) => { on = r.preferMusicOnly === true; });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && 'preferMusicOnly' in ch) on = ch.preferMusicOnly.newValue === true;
    });
  } catch { /* extension context gone */ }

  // the page URL has no id while the player page is closed: then the player's (music-only-page.js)
  const currentId = () => new URLSearchParams(location.search).get('v') || document.documentElement.dataset.viviPlayingId || '';
  // tells music-only-page.js whether to pair videos with their songs now
  const tell = (v) => { if (document.documentElement.dataset.viviMusicOnly !== v) document.documentElement.dataset.viviMusicOnly = v; };

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest?.('ytmusic-av-toggle .video-button')) { kept = currentId(); keepAt = Date.now(); }
    else if (e.target.closest?.('ytmusic-av-toggle .song-button')) { kept = ''; keepAt = 0; }
  }, true);

  setInterval(() => {
    const mixing = !!window.__viviCrossfade?.active?.();
    tell(on && !mixing ? '1' : '0');
    if (!on) return;
    const toggle = document.querySelector('ytmusic-av-toggle');
    if (!toggle || toggle.getAttribute('playback-mode') !== 'OMV_PREFERRED') return;
    const id = currentId();
    // just after the click the id changes to the video's: that one is kept
    if (keepAt && Date.now() - keepAt < 5000) { kept = id; return; }
    keepAt = 0;
    if (kept && kept === id) return;
    kept = '';
    if (mixing) return;   // never mid-blend
    // no pair yet (music-only-page.js may still be finding the song): Song would only hide the picture
    if (!toggle.hasAttribute('selected-queue-item-has-counterpart')) return;
    const song = toggle.querySelector('.song-button');
    if (!song) return;
    song.click();
    log('switched YouTube Music to Song mode for', id || 'this queue');
  }, 1000);
})();

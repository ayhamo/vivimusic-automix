// Vivimusic Web+ additions to upstream's popup. Loaded by popup.html before
// popup-ui.js and popup.js, so our rows are in the page before upstream's
// scripts look at it. Kept out of upstream's files so merges stay clean.
// Upstream's popup-ui.js and popup.js pick up our extra providers and the
// ListenBrainz card through window.viviPlusPopup (one hook line each).
(() => {
  'use strict';

  // ── What upstream's scripts read from us ──
  window.viviPlusPopup = {
    // popup.js: extra lyrics providers (on by default) and their priority labels
    providers: { lyricsplus: true, paxsenix: true, genius: true },
    priorityLabels: { paxsenix: 'Paxsenix (Apple Music)', lyricsplus: 'LyricsPlus (Syllable / Word)' },
    // popup.js: where the update button leads (upstream's points at its own AMO listing)
    updatePage: 'https://github.com/ayhamo/vivimusic-automix/releases/latest',
    // popup-ui.js: the ListenBrainz home card, after Last.fm, and the Addons card, after Audio
    // playback (its section title reads "Addons Test" with the tag; without an entry here it
    // would fall into the hidden Updates slot and could not be opened)
    extendCards(rsNotes, meta, order) {
      rsNotes.listenbrainz = 'ListenBrainz scrobbling is paused while Optimized & resource saving mode is on.';
      meta.ListenBrainz = ['ListenBrainz', 'Open-source scrobbling to ListenBrainz', 'listenbrainz', 'static'];
      const at = order.indexOf('Last.fm');
      if (!order.includes('ListenBrainz')) order.splice(at < 0 ? order.length : at + 1, 0, 'ListenBrainz');
      meta['Addons Test'] = ['Addons', 'Play songs from your addons, lossless when they have it', 'addons', 'static'];
      const ap = order.indexOf('Audio playback');
      if (!order.includes('Addons Test')) order.splice(ap < 0 ? order.length : ap + 1, 0, 'Addons Test');
    },
  };

  // ── Our name instead of upstream's; upstream's issue link and support footer removed ──
  document.title = 'Vivimusic Web+';
  const logo = document.querySelector('.header .logo-wrap img');
  if (logo) logo.alt = 'Vivimusic Web+';
  const brand = document.querySelector('.header .brand h1');
  if (brand) brand.textContent = 'Vivimusic Web+';
  document.querySelector('.header .issue-button')?.remove();
  document.querySelector('body > .footer')?.remove();

  const style = document.createElement('style');
  style.textContent = `
    .home-card[data-feature="listenbrainz"] { --card-accent: #eb743b; }
    .view-settings[data-feature="listenbrainz"] { --panel-accent: #eb743b; }
    .home-card[data-feature="addons"] { --card-accent: #38bdf8; }
    .view-settings[data-feature="addons"] { --panel-accent: #38bdf8; }
  `;
  document.head.appendChild(style);

  // ── Our settings rows, placed next to upstream elements found by id ──
  // A row whose anchor is gone (upstream moved things) is put at the end of the
  // popup, so it still works and the problem is visible.
  function place(html, anchor, where) {
    if (anchor) anchor.insertAdjacentHTML(where, html);
    else {
      console.warn('[Vivimusic Web+] popup anchor missing; row added at the end');
      document.body.insertAdjacentHTML('beforeend', html);
    }
  }
  // the row holding element #id, or the note paragraph right after it
  function rowOrNote(id) {
    const row = document.getElementById(id)?.closest('.row');
    if (!row) return null;
    const next = row.nextElementSibling;
    return next?.matches('p.theme-sub') ? next : row;
  }

  // Audio playback: crossfade options, Automix and its analysis cache
  place(`    <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
      <div class="row">
        <span class="row-label">Crossfade on manual skip</span>
        <label class="switch">
          <input type="checkbox" id="crossfadeManualSkipToggle" checked/>
          <span class="slider"></span>
        </label>
      </div>
      <div class="row">
        <span class="row-label">Crossfade on auto-advance</span>
        <label class="switch">
          <input type="checkbox" id="crossfadeAutoAdvanceToggle" checked/>
          <span class="slider"></span>
        </label>
      </div>
      <div class="row" style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
        <span class="row-label">Automix / Auto-DJ <span class="beta-tag" style="background:#ff4b8b;color:#fff;">AI DJ</span></span>
        <label class="switch">
          <input type="checkbox" id="automixToggle" checked/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Needs Crossfade on. BitChord's automix: the playing and the next song are downloaded and analysed on your device (tempo, downbeats, intro, outro, where it is sung). When a song ends on its own it loops an instrumental bar into the next song, or blends on a phrase with the next song matched to its tempo, or uses a filter mix or a 12 s crossfade when the pair can't be beatmatched.</p>
      <div class="kawarp-slider-row" id="automixVersionRow" style="margin-top:4px;">
        <div class="kw-label-row"><span>Automix version</span><span class="kw-val" id="automixVersionVal">Classic</span></div>
        <select id="automixVersionSelect" style="width:100%;background:rgba(255,255,255,0.06);color:var(--text-1);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;font-size:12.5px;margin-top:4px;">
          <option value="2" selected>Classic</option>
          <option value="3">Automix v2 (test)</option>
        </select>
        <p class="theme-sub" style="margin-top:4px;"><b>Classic</b>: the automix you know. Loop mixes when both songs have clean instrumental bars, else a beat-matched blend on a phrase. It looks (with synced lyrics, or the vocal model) for a blend point where the two songs don't sing over each other. The bass swaps in one quick step, the old song's highs fade away while the new one opens up, and a filter mix sweeps the old song down to a muffle. Blends end where a song's music ends, and the next song never starts more than a quarter of the way in.</p>
        <p class="theme-sub" style="margin-top:4px;"><b>Automix v2</b> (test): Classic with Orchard's rules. Up to 4% apart, one song is sped up; 4-8%, both glide to meet; further apart, or with clashing bass styles or keys, the songs aren't beat-matched: a beatless bridge where both have beatless edges, else a straight hand-over. A blend both songs would sing over becomes a drop-in or a muffle. Levels are matched over the blend and the kicks lined up. The overview says which and why. You can switch back any time.</p>
      </div>
      <div class="row" id="automixKeyAwareRow" style="margin-top:6px;">
        <span class="row-label">Shorter blend when keys clash <span class="beta-tag" style="background:rgba(255,255,255,0.15);color:#fff;">Test</span></span>
        <label class="switch">
          <input type="checkbox" id="automixKeyAwareToggle"/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Classic only (Automix v2 always checks keys), off by default. Every song is in a musical key (C major, A minor…). Two songs in keys that don't go together can sound out of tune while they play on top of each other. With this on, such a pair gets a short blend (2 bars, about 4–6 s) instead of the usual length, so the out-of-tune moment is brief. Keys that go together (the same key, its relative major/minor, or a neighbour on the Camelot wheel) keep the normal blend. Off: every pair gets the normal length, whatever the keys.</p>
      <div class="row" style="margin-top:6px;">
        <span class="row-label">Smooth hand-over <span class="beta-tag" style="background:rgba(255,255,255,0.15);color:#fff;">Test</span></span>
        <label class="switch">
          <input type="checkbox" id="automixStreamDeckToggle"/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Off by default. After a blend, the new song keeps playing from the copy Automix already downloaded, in step with YouTube's player (which plays on, muted), so there is no switch back to the player right after the mix. Play, pause, seek and skip work as usual. If the copy ever falls out of step, YouTube's own sound comes back at the same spot.</p>
      <div class="kawarp-slider-row" id="automixBarsRow" style="margin-top:4px;">
        <div class="kw-label-row"><span>Blend length</span><span class="kw-val" id="automixBarsVal">Auto</span></div>
        <select id="automixBarsSelect" style="width:100%;background:rgba(255,255,255,0.06);color:var(--text-1);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:5px 8px;font-size:12.5px;margin-top:4px;">
          <option value="auto" selected>Auto (picks per song, like BitChord phone)</option>
          <option value="4">Up to 4 bars</option>
          <option value="8">Up to 8 bars</option>
          <option value="16">Up to 16 bars (BitChord web default)</option>
          <option value="32">Up to 32 bars</option>
        </select>
        <p class="theme-sub" style="margin-top:4px;">Auto follows the BitChord phone: usually 4 bars, 8 when both songs are calm there, never over 12–16 s. Each blend ends a bar before the song does. Up to N bars is BitChord web's setting; a weak beat grid or a filter mix shortens it.</p>
      </div>
      <div class="row" style="margin-top:6px;">
        <span class="row-label">Prefer music-only version</span>
        <label class="switch">
          <input type="checkbox" id="preferMusicOnlyToggle"/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Music videos play as their song: YouTube Music's Song / Video switch is set to Song whenever it shows Video. Switch a video back by hand and it stays a video.</p>
      <div class="row" style="margin-top:6px;">
        <span class="row-label">Saved song analyses <span class="kw-val" id="automixCacheCount" style="margin-left:4px;"></span></span>
        <button type="button" id="automixCacheClearBtn" class="clear-btn">Clear</button>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Each analysed song is kept on your device so it is never analysed twice. Clearing frees that space; songs are analysed again as they play.</p>
      <div class="row" style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
        <span class="row-label">Stats for Nerds Overlay <span class="beta-tag" style="background:rgba(255,255,255,0.15);color:#fff;">HUD</span></span>
        <label class="switch">
          <input type="checkbox" id="nerdStatsToggle"/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Floating HUD with the current song, Web Audio state and live crossfade / Automix status. Shortcut: <code>Shift + D</code>.</p>
      <div class="row" style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
        <span class="row-label">Mouse Wheel Volume</span>
        <label class="switch">
          <input type="checkbox" id="wheelVolumeToggle" checked/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Scroll mouse wheel over the bottom player bar or album artwork to adjust volume smoothly in ±5% steps.</p>
      <div class="row" style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
        <span class="row-label">Apple Artist Art & Palette</span>
        <label class="switch">
          <input type="checkbox" id="appleArtistArtToggle" checked/>
          <span class="slider"></span>
        </label>
      </div>
      <p class="theme-sub" style="margin-top:2px;">Fetches high-res artist photography and dynamic color palettes from Apple Music to tint backgrounds and panels.</p>
    </div>
`, document.getElementById('crossfadeSeconds')?.parentElement, 'afterend');

  // Lyrics: blur around the current line (Apple Music style)
  place(`    <div class="row" style="margin-top:8px;">
      <span class="row-label">Blur around the current line</span>
      <select id="lyricsLineBlurSelect" style="background:rgba(255,255,255,0.06); color:var(--text-1); border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:5px 8px; font-size:12.5px;">
        <option value="off">Off</option>
        <option value="low" selected>Low</option>
        <option value="normal">Normal</option>
      </select>
    </div>
    <p class="theme-sub">How much the lines before and after the sung one are blurred (Apple Music style).</p>
`, rowOrNote('lyricsAnimSelect'), 'afterend');

  // Lyrics: extra providers
  place(`      <div class="provider-row">
        <span>LyricsPlus</span><span class="lvls"><i class="lvl lvl-syllable">SYLLABLE</i><i class="lvl lvl-word">WORD</i><i class="lvl lvl-line">LINE</i></span>
        <label class="switch small"><input type="checkbox" id="prov-lyricsplus" checked/><span class="slider"></span></label>
      </div>
      <div class="provider-row">
        <span>Paxsenix (Apple Music)</span><span class="lvls"><i class="lvl lvl-syllable">SYLLABLE</i><i class="lvl lvl-word">WORD</i><i class="lvl lvl-line">LINE</i></span>
        <label class="switch small"><input type="checkbox" id="prov-paxsenix" checked/><span class="slider"></span></label>
      </div>
      <div class="provider-row">
        <span class="pname">Genius<small>Fallback</small></span><span class="lvls"><i class="lvl lvl-line" style="background:rgba(255,255,255,0.15);color:#fff;">PLAIN</i></span>
        <label class="switch small"><input type="checkbox" id="prov-genius" checked/><span class="slider"></span></label>
      </div>
`, document.getElementById('prov-lrclib')?.closest('.provider-row'), 'afterend');

  // Spotify Canvas: where it plays, and its blur
  place(`    <div class="row" style="margin-top:10px;">
      <span class="row-label">Show the Spotify Canvas</span>
      <select id="spotifyCanvasPlacement" style="background:rgba(255,255,255,0.06); color:var(--text-1); border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:5px 8px; font-size:12.5px;">
        <option value="cover" selected>On the cover</option>
        <option value="lyrics">Behind the lyrics</option>
        <option value="side">Behind the side panel</option>
        <option value="off">Off</option>
      </select>
    </div>
    <p class="theme-sub">On the cover: the original. Behind the lyrics: plays blurred behind the lyrics while the Lyrics tab is open. Behind the side panel: the same, on every tab (Up next, Lyrics, Related). With either of those, the cover shows Apple Music's animated artwork when the song has it, otherwise the normal cover.</p>

    <div class="kawarp-slider-row" style="margin-top:10px;">
      <div class="kw-label-row"><span>Blur behind the panel</span><span class="kw-val" id="canvasBlurPxVal">3 px</span></div>
      <input type="range" id="canvasBlurPx" min="0" max="20" step="1" value="3"/>
    </div>
`, rowOrNote('canvasPrioritySelect'), 'afterend');

  // ListenBrainz section, before Updates
  place(`  <!-- ListenBrainz -->
  <div class="section">
    <div class="section-title"><span class="dot-ico"></span>ListenBrainz</div>
    <div class="row">
      <span class="row-label">ListenBrainz scrobbling</span>
      <label class="switch">
        <input type="checkbox" id="listenbrainzEnabledToggle"/>
        <span class="slider"></span>
      </label>
    </div>

    <div id="listenbrainzLoginBlock" style="margin-top:11px; display:flex; flex-direction:column; gap:7px;">
      <p class="theme-sub" style="margin:0;">Enter your User Token from <a href="https://listenbrainz.org/profile/" target="_blank" rel="noopener noreferrer" style="color:#bdabff;">listenbrainz.org/profile</a>.</p>
      <form id="listenbrainzLoginForm" autocomplete="off" style="margin-top:4px; display:flex; flex-direction:column; gap:7px;">
        <input id="listenbrainzToken" type="password" placeholder="ListenBrainz User Token" style="width:100%;"/>
        <button id="listenbrainzLoginBtn" type="submit" class="update-btn primary" style="width:100%;">Connect ListenBrainz</button>
      </form>
      <div id="listenbrainzLoginError" style="display:none; font-size:11px; color:#f87171;"></div>
    </div>

    <div id="listenbrainzConnectedBlock" style="display:none; margin-top:11px;">
      <div class="status-row" style="margin-top:0;">
        <div class="dot active"></div>
        <span id="listenbrainzConnectedAs">Connected</span>
      </div>
      <button id="listenbrainzLogoutBtn" class="clear-btn" style="margin-top:7px;">Disconnect</button>
    </div>

    <div style="margin-top:14px; display:flex; flex-direction:column; gap:10px;">
      <div class="row">
        <span class="row-label">Send Now Playing</span>
        <label class="switch"><input type="checkbox" id="listenbrainzNowPlayingToggle" checked/><span class="slider"></span></label>
      </div>
    </div>
  </div>
`, document.getElementById('updateStatus')?.closest('.section'), 'beforebegin');

  // Same as upstream's relay(): sends a setting change to the open YouTube Music tab.
  function relay(patch) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.url?.includes('music.youtube.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'VIVI_SETTINGS', ...patch }).catch(() => {});
      }
    });
  }
  const spotifyCanvasEnabled = document.getElementById('spotifyCanvasEnabled');

  const crossfadeManualSkipToggle = document.getElementById('crossfadeManualSkipToggle');
  const crossfadeAutoAdvanceToggle = document.getElementById('crossfadeAutoAdvanceToggle');

  chrome.storage.local.get({ crossfadeManualSkip: true, crossfadeAutoAdvance: true }, (r) => {
    if (crossfadeManualSkipToggle) crossfadeManualSkipToggle.checked = r.crossfadeManualSkip !== false;
    if (crossfadeAutoAdvanceToggle) crossfadeAutoAdvanceToggle.checked = r.crossfadeAutoAdvance !== false;
  });

  crossfadeManualSkipToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ crossfadeManualSkip: crossfadeManualSkipToggle.checked });
  });
  crossfadeAutoAdvanceToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ crossfadeAutoAdvance: crossfadeAutoAdvanceToggle.checked });
  });

  const automixToggle = document.getElementById('automixToggle');
  const automixBarsSelect = document.getElementById('automixBarsSelect');
  const automixBarsVal = document.getElementById('automixBarsVal');

  chrome.storage.local.get({ automixEnabled: true, automixBars: 'auto' }, (r) => {
    if (automixToggle) automixToggle.checked = r.automixEnabled !== false;
    if (automixBarsSelect) {
      automixBarsSelect.value = String(r.automixBars || 'auto');
      if (automixBarsVal) automixBarsVal.textContent = automixBarsSelect.value === 'auto' ? 'Auto' : 'Up to ' + automixBarsSelect.value + ' bars';
    }
  });

  automixToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ automixEnabled: automixToggle.checked });
  });

  const automixStreamDeckToggle = document.getElementById('automixStreamDeckToggle');
  chrome.storage.local.get({ automixStreamDeck: false }, (r) => {
    if (automixStreamDeckToggle) automixStreamDeckToggle.checked = r.automixStreamDeck === true;
  });
  automixStreamDeckToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ automixStreamDeck: automixStreamDeckToggle.checked });
  });

  // Automix engine: 2 = Classic, 3 = Automix v2 (Orchard's rules). Original (1) is retired: shown and played as Classic.
  const automixVersionSelect = document.getElementById('automixVersionSelect');
  const automixVersionVal = document.getElementById('automixVersionVal');
  const automixKeyAwareToggle = document.getElementById('automixKeyAwareToggle');
  const automixKeyAwareRow = document.getElementById('automixKeyAwareRow');
  // The key toggle is Classic's: greyed out (its setting kept) under v2, which always checks keys.
  const asVersion = (v) => (v === 3 ? 3 : 2);
  const showVersion = (v) => {
    if (automixVersionVal) automixVersionVal.textContent = v === 3 ? 'v2' : 'Classic';
    if (automixKeyAwareToggle) automixKeyAwareToggle.disabled = v === 3;
    if (automixKeyAwareRow) automixKeyAwareRow.style.opacity = v === 3 ? '0.45' : '';
  };
  chrome.storage.local.get({ automixVersion: 2 }, (r) => {
    const v = asVersion(r.automixVersion);
    if (automixVersionSelect) automixVersionSelect.value = String(v);
    showVersion(v);
  });
  chrome.storage.local.get({ automixKeyAware: false }, (r) => {
    if (automixKeyAwareToggle) automixKeyAwareToggle.checked = r.automixKeyAware === true;
  });
  automixKeyAwareToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ automixKeyAware: automixKeyAwareToggle.checked });
  });
  automixVersionSelect?.addEventListener('change', () => {
    const v = asVersion(Number(automixVersionSelect.value));
    chrome.storage.local.set({ automixVersion: v });
    showVersion(v);
  });

  const preferMusicOnlyToggle = document.getElementById('preferMusicOnlyToggle');
  chrome.storage.local.get({ preferMusicOnly: false }, (r) => {
    if (preferMusicOnlyToggle) preferMusicOnlyToggle.checked = r.preferMusicOnly === true;
  });
  preferMusicOnlyToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ preferMusicOnly: preferMusicOnlyToggle.checked });
  });

  // Automix's analysis cache (IndexedDB 'vivi-automix', kept by automix/host.js
  // in the extension's own origin, which this popup shares).
  const automixCacheCount = document.getElementById('automixCacheCount');
  const automixCacheClearBtn = document.getElementById('automixCacheClearBtn');
  const withAnalysisStore = (mode, fn) => new Promise((resolve) => {
    try {
      const open = indexedDB.open('vivi-automix', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('analysis', { keyPath: 'fileKey' });
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction('analysis', mode);
          const req = fn(tx.objectStore('analysis'));
          tx.oncomplete = () => { db.close(); resolve(req ? req.result : true); };
          tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    } catch { resolve(null); }
  });
  const showAutomixCache = async () => {
    if (!automixCacheCount) return;
    const n = await withAnalysisStore('readonly', (s) => s.count());
    automixCacheCount.textContent = n == null ? '' : `${n} song${n === 1 ? '' : 's'}`;
    if (automixCacheClearBtn) automixCacheClearBtn.disabled = !n;
  };
  showAutomixCache();
  automixCacheClearBtn?.addEventListener('click', async () => {
    automixCacheClearBtn.disabled = true;
    const ok = await withAnalysisStore('readwrite', (s) => { s.clear(); return null; });
    // The analysis frames in open YouTube Music tabs clear theirs too, in case
    // the browser keeps a separate copy for a frame inside a site. (A tab keeps
    // the few songs it holds in memory until it is reloaded.)
    chrome.storage.local.set({ automixCacheClearedAt: Date.now() });
    if (automixCacheCount) automixCacheCount.textContent = ok ? 'cleared' : 'could not clear';
    setTimeout(showAutomixCache, 1500);
  });

  automixBarsSelect?.addEventListener('change', () => {
    const v = automixBarsSelect.value;
    chrome.storage.local.set({ automixBars: v === 'auto' ? 'auto' : (Number(v) || 8) });
    if (automixBarsVal) automixBarsVal.textContent = v === 'auto' ? 'Auto' : 'Up to ' + v + ' bars';
  });

  const nerdStatsToggle = document.getElementById('nerdStatsToggle');
  const wheelVolumeToggle = document.getElementById('wheelVolumeToggle');
  const appleArtistArtToggle = document.getElementById('appleArtistArtToggle');

  chrome.storage.local.get({
    nerdStatsEnabled: false,
    wheelVolumeEnabled: true,
    appleArtistArtEnabled: true,
  }, (r) => {
    if (nerdStatsToggle) nerdStatsToggle.checked = r.nerdStatsEnabled === true;
    if (wheelVolumeToggle) wheelVolumeToggle.checked = r.wheelVolumeEnabled !== false;
    if (appleArtistArtToggle) appleArtistArtToggle.checked = r.appleArtistArtEnabled !== false;
  });

  nerdStatsToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ nerdStatsEnabled: nerdStatsToggle.checked });
  });

  wheelVolumeToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ wheelVolumeEnabled: wheelVolumeToggle.checked });
  });

  appleArtistArtToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ appleArtistArtEnabled: appleArtistArtToggle.checked });
  });

  // Placement of the Spotify Canvas; "Off" is the same as the switch above.
  const placementSelect = document.getElementById('spotifyCanvasPlacement');
  const canvasBlurPx = document.getElementById('canvasBlurPx');
  const canvasBlurPxVal = document.getElementById('canvasBlurPxVal');
  chrome.storage.local.get({ spotifyCanvasPlacement: 'cover', spotifyCanvasEnabled: true, canvasBlurPx: 3 }, (s) => {
    placementSelect.value = s.spotifyCanvasEnabled === false ? 'off' : (['lyrics', 'side'].includes(s.spotifyCanvasPlacement) ? s.spotifyCanvasPlacement : 'cover');
    canvasBlurPx.value = s.canvasBlurPx;
    canvasBlurPxVal.textContent = s.canvasBlurPx + ' px';
  });
  placementSelect.addEventListener('change', () => {
    const v = placementSelect.value;
    if (v === 'off') {
      spotifyCanvasEnabled.checked = false;
      chrome.storage.local.set({ spotifyCanvasEnabled: false });
      relay({ spotifyCanvasEnabled: false });
      return;
    }
    spotifyCanvasEnabled.checked = true;
    chrome.storage.local.set({ spotifyCanvasEnabled: true, spotifyCanvasPlacement: v });
    relay({ spotifyCanvasEnabled: true, spotifyCanvasPlacement: v });
  });
  spotifyCanvasEnabled.addEventListener('change', () => {
    if (!spotifyCanvasEnabled.checked) placementSelect.value = 'off';
    else if (placementSelect.value === 'off') {
      chrome.storage.local.get({ spotifyCanvasPlacement: 'cover' }, (s) => { placementSelect.value = s.spotifyCanvasPlacement; });
    }
  });
  canvasBlurPx.addEventListener('input', () => {
    const px = Number(canvasBlurPx.value);
    canvasBlurPxVal.textContent = px + ' px';
    chrome.storage.local.set({ canvasBlurPx: px });
    relay({ canvasBlurPx: px });
  });

  const lyricsLineBlurSelect = document.getElementById('lyricsLineBlurSelect');
  chrome.storage.local.get({ lyricsLineBlur: 'low' }, (s) => { lyricsLineBlurSelect.value = s.lyricsLineBlur; });
  lyricsLineBlurSelect.addEventListener('change', () => {
    chrome.storage.local.set({ lyricsLineBlur: lyricsLineBlurSelect.value });
    relay({ lyricsLineBlur: lyricsLineBlurSelect.value });
  });

  // Spotify Connect: Firefox lets the user withhold host permissions of MV3
  // add-ons; without the Spotify ones the cookie API sees no sp_dc and Connect
  // waits forever. permissions.request must run straight from the click, so
  // this capture listener asks first, holds upstream's handler back, and lets
  // it run with a second click once access is granted.
  const SPOTIFY_ORIGINS = ['https://open.spotify.com/*', 'https://*.spotify.com/*', 'https://spotify.com/*'];
  const spotifyConnectBtn = document.getElementById('spotifyConnectBtn');
  const spotifyStatus = document.getElementById('spotifyStatus');
  spotifyConnectBtn?.addEventListener('click', (e) => {
    if (spotifyConnectBtn.dataset.viviGranted === '1') { delete spotifyConnectBtn.dataset.viviGranted; return; }
    const api = globalThis.browser?.permissions || chrome.permissions;
    if (!api?.request) return;
    e.stopImmediatePropagation();
    Promise.resolve(api.request({ origins: SPOTIFY_ORIGINS })).catch(() => false).then((granted) => {
      if (!granted) {
        if (spotifyStatus) spotifyStatus.textContent = 'Spotify access was not allowed. Allow it to connect (about:addons → Vivimusic Web+ → Permissions).';
        return;
      }
      spotifyConnectBtn.dataset.viviGranted = '1';
      spotifyConnectBtn.click();
    });
  }, true);


  /* -------------------------------------------------------------------------
   * Addons (spec/addons/protocol.md): BitChord-compatible addons that play a
   * song from another source, YouTube's player kept as the clock. The list,
   * its order and the links live in the background (src/addons/bg-addons.js);
   * this page only ever sees each addon's name and host, never its link.
   * ------------------------------------------------------------------------- */
  place(`  <div class="section" id="addonsSection">
    <div class="section-title"><span class="dot-ico"></span>Addons <span class="beta-tag" style="background:rgba(255,255,255,0.15);color:#fff;">Test</span></div>
    <div class="row">
      <span class="row-label">Play songs from addons</span>
      <label class="switch">
        <input type="checkbox" id="addonsEnabledToggle"/>
        <span class="slider"></span>
      </label>
    </div>
    <p class="theme-sub">Off by default. Needs Crossfade and Automix on (the copy is lined up against the audio Automix downloads). BitChord addons (links with your own token) can have a song in better quality than YouTube. When one has the playing song, that copy plays in step with YouTube's player, which keeps running muted, so play, pause, seek, skip and Automix work as usual. A copy that isn't the same recording, or falls out of step, goes back to YouTube's sound. Firefox asks once for access to all https sites: the songs come from whatever servers the addons send them from.</p>
    <form id="addonsAddForm" style="display:flex; gap:6px; margin-top:8px;">
      <input type="password" id="addonsUrl" placeholder="Paste an addon link (manifest.json)" autocomplete="off" spellcheck="false" style="flex:1; min-width:0;"/>
      <button type="submit" id="addonsAddBtn" class="clear-btn" style="color:var(--text-1);">Add</button>
    </form>
    <p class="theme-sub" id="addonsMsg" style="display:none; margin-top:4px;"></p>
    <div id="addonsList" style="display:flex; flex-direction:column; gap:4px; margin-top:8px;"></div>
    <p class="theme-sub" id="addonsEmpty" style="margin-top:2px;">No addons yet. They are asked in this order; the first one that has the song plays it.</p>
    <div class="row" style="margin-top:8px;">
      <span class="row-label">Quality</span>
      <select id="addonsTierSelect" style="background:rgba(255,255,255,0.06); color:var(--text-1); border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:5px 8px; font-size:12.5px;">
        <option value="LOSSLESS" selected>Lossless (FLAC)</option>
        <option value="HIGH">High (320 kbps)</option>
        <option value="LOW">Low (128 kbps)</option>
      </select>
    </div>
    <div class="kawarp-slider-row" style="margin-top:8px;">
      <div class="kw-label-row"><span>Length difference allowed</span><span class="kw-val" id="addonsSlackVal">5 s</span></div>
      <input type="range" id="addonsSlackSec" min="0" max="10" step="1" value="5"/>
    </div>
    <p class="theme-sub" style="margin-top:2px;">An addon's song may be this much longer or shorter than YouTube's and still be used. Atmos versions and short previews are never used.</p>
  </div>
`, document.getElementById('eqToggle')?.closest('.section'), 'afterend');

  const ALL_HTTPS = { origins: ['https://*/*'] };
  const permissionsApi = globalThis.browser?.permissions || chrome.permissions;
  // permissions.request must run straight from the click: call it first thing
  const askAccess = () => (permissionsApi?.request ? Promise.resolve(permissionsApi.request(ALL_HTTPS)).catch(() => false) : Promise.resolve(true));
  const addonsMsg = document.getElementById('addonsMsg');
  const say = (text, bad) => {
    addonsMsg.textContent = text || '';
    addonsMsg.style.display = text ? 'block' : 'none';
    addonsMsg.style.color = bad ? '#ff6b6b' : '';
  };
  const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)));

  const addonsEnabledToggle = document.getElementById('addonsEnabledToggle');
  const addonsTierSelect = document.getElementById('addonsTierSelect');
  const addonsSlack = document.getElementById('addonsSlackSec');
  const addonsSlackVal = document.getElementById('addonsSlackVal');
  const addonsListEl = document.getElementById('addonsList');

  const HEALTH = {
    unused: ['rgba(255,255,255,0.3)', 'Not asked yet'],
    ok: ['#3ecf6e', 'Answering'],
    failing: ['#f2c230', 'Failing'],
    resting: ['#ff6b6b', 'Resting after failures'],
  };
  function healthText(h) {
    const [, label] = HEALTH[h?.state] || HEALTH.unused;
    if (h?.state === 'ok' && h.ms != null) return `${label} (${(h.ms / 1000).toFixed(1)} s)`;
    if (h?.state === 'resting' && h.until) return `${label}, back at ${new Date(h.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${h.last ? ': ' + h.last : ''}`;
    if (h?.state === 'failing') return `${label}${h.last ? ': ' + h.last : ''}`;
    return label;
  }

  function renderAddons(state) {
    addonsListEl.textContent = '';
    document.getElementById('addonsEmpty').style.display = state.addons.length ? 'none' : 'block';
    state.addons.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'gap:6px; align-items:center;';
      const dot = document.createElement('span');
      const [color] = HEALTH[a.health?.state] || HEALTH.unused;
      dot.style.cssText = `width:8px; height:8px; border-radius:50%; flex:none; background:${color};`;
      dot.title = healthText(a.health);
      const label = document.createElement('span');
      label.className = 'row-label';
      label.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      label.textContent = `${i + 1}. ${a.name}`;
      const host = document.createElement('small');
      host.style.cssText = 'display:block; color:var(--text-3); font-weight:400;';
      host.textContent = `${a.host} · ${healthText(a.health)}`;
      label.appendChild(host);
      label.title = `${a.name} (${a.host})`;
      const btn = (text, title, onClick, disabled) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'clear-btn'; b.textContent = text; b.title = title; b.disabled = !!disabled;
        b.addEventListener('click', onClick);
        return b;
      };
      const sw = document.createElement('label');
      sw.className = 'switch small';
      sw.innerHTML = '<input type="checkbox"/><span class="slider"></span>';
      const box = sw.querySelector('input');
      box.checked = a.enabled;
      box.addEventListener('change', () => ask({ type: 'VIVI_ADDONS_TOGGLE', id: a.id, enabled: box.checked }).then(refreshAddons));
      row.append(dot, label,
        btn('↑', 'Ask it earlier', () => ask({ type: 'VIVI_ADDONS_MOVE', id: a.id, by: -1 }).then(refreshAddons), i === 0),
        btn('↓', 'Ask it later', () => ask({ type: 'VIVI_ADDONS_MOVE', id: a.id, by: 1 }).then(refreshAddons), i === state.addons.length - 1),
        sw,
        btn('✕', 'Remove', () => ask({ type: 'VIVI_ADDONS_REMOVE', id: a.id }).then(refreshAddons)));
      addonsListEl.appendChild(row);
    });
  }
  function refreshAddons() {
    return ask({ type: 'VIVI_ADDONS_LIST' }).then((state) => {
      if (!state?.addons) return;
      addonsEnabledToggle.checked = state.enabled;
      addonsTierSelect.value = state.tier;
      addonsSlack.value = state.slackSec;
      addonsSlackVal.textContent = state.slackSec + ' s';
      renderAddons(state);
    });
  }
  refreshAddons();

  addonsEnabledToggle.addEventListener('change', () => {
    if (!addonsEnabledToggle.checked) { ask({ type: 'VIVI_ADDONS_SETTINGS', enabled: false }); relay({ addonsEnabled: false }); return; }
    askAccess().then((granted) => {
      if (!granted) {
        addonsEnabledToggle.checked = false;
        say('Firefox access to the addons\' servers was not allowed, so addons stay off.', true);
        return;
      }
      say('');
      ask({ type: 'VIVI_ADDONS_SETTINGS', enabled: true });
      relay({ addonsEnabled: true });
    });
  });
  document.getElementById('addonsAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('addonsUrl');
    const url = input.value.trim();
    if (!url) return;
    const addBtn = document.getElementById('addonsAddBtn');
    addBtn.disabled = true;
    askAccess().then((granted) => {
      if (!granted) { say('Firefox access to the addon\'s server was not allowed.', true); return null; }
      say('Asking the addon…');
      return ask({ type: 'VIVI_ADDONS_ADD', url });
    }).then((r) => {
      if (!r) return;
      if (!r.ok) { say(r.error || 'The addon could not be added.', true); return; }
      input.value = '';
      say(`Added ${r.addon.name} (${r.addon.host}).`);
      return refreshAddons();
    }).finally(() => { addBtn.disabled = false; });
  });
  addonsTierSelect.addEventListener('change', () => ask({ type: 'VIVI_ADDONS_SETTINGS', tier: addonsTierSelect.value }));
  addonsSlack.addEventListener('input', () => { addonsSlackVal.textContent = addonsSlack.value + ' s'; });
  addonsSlack.addEventListener('change', () => ask({ type: 'VIVI_ADDONS_SETTINGS', slackSec: Number(addonsSlack.value) }));

  /* -------------------------------------------------------------------------
   * ListenBrainz Scrobbling
   * ------------------------------------------------------------------------- */
  const lbEnabledToggle    = document.getElementById('listenbrainzEnabledToggle');
  const lbLoginBlock       = document.getElementById('listenbrainzLoginBlock');
  const lbConnectedBlock   = document.getElementById('listenbrainzConnectedBlock');
  const lbConnectedAs      = document.getElementById('listenbrainzConnectedAs');
  const lbToken            = document.getElementById('listenbrainzToken');
  const lbLoginBtn         = document.getElementById('listenbrainzLoginBtn');
  const lbLoginForm        = document.getElementById('listenbrainzLoginForm');
  const lbLoginError       = document.getElementById('listenbrainzLoginError');
  const lbLogoutBtn        = document.getElementById('listenbrainzLogoutBtn');
  const lbNowPlayingToggle = document.getElementById('listenbrainzNowPlayingToggle');

  function refreshListenbrainzStatus() {
    chrome.runtime.sendMessage({ type: 'VIVI_LISTENBRAINZ_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.loggedIn) {
        if (lbLoginBlock) lbLoginBlock.style.display = 'none';
        if (lbConnectedBlock) lbConnectedBlock.style.display = 'block';
        if (lbConnectedAs) lbConnectedAs.textContent = `Connected as ${resp.username || 'user'}`;
      } else {
        if (lbLoginBlock) lbLoginBlock.style.display = 'flex';
        if (lbConnectedBlock) lbConnectedBlock.style.display = 'none';
      }
    });
  }

  chrome.storage.local.get({
    listenbrainzEnabled: false,
    listenbrainzSendNowPlaying: true,
  }, (s) => {
    if (lbEnabledToggle) lbEnabledToggle.checked = s.listenbrainzEnabled === true;
    if (lbNowPlayingToggle) lbNowPlayingToggle.checked = s.listenbrainzSendNowPlaying !== false;
    refreshListenbrainzStatus();
  });

  lbEnabledToggle?.addEventListener('change', () => {
    const listenbrainzEnabled = lbEnabledToggle.checked;
    chrome.storage.local.set({ listenbrainzEnabled });
    relay({ listenbrainzEnabled });
  });

  lbNowPlayingToggle?.addEventListener('change', () => {
    const listenbrainzSendNowPlaying = lbNowPlayingToggle.checked;
    chrome.storage.local.set({ listenbrainzSendNowPlaying });
    relay({ listenbrainzSendNowPlaying });
  });

  lbLoginForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = lbToken.value.trim();
    if (!token) return;
    if (lbLoginBtn) lbLoginBtn.disabled = true;
    if (lbLoginError) lbLoginError.style.display = 'none';
    chrome.runtime.sendMessage({ type: 'VIVI_LISTENBRAINZ_LOGIN', token }, (resp) => {
      if (lbLoginBtn) lbLoginBtn.disabled = false;
      if (chrome.runtime.lastError || !resp?.ok) {
        if (lbLoginError) {
          lbLoginError.textContent = resp?.error || chrome.runtime.lastError?.message || 'Login failed';
          lbLoginError.style.display = 'block';
        }
      } else {
        if (lbToken) lbToken.value = '';
        refreshListenbrainzStatus();
      }
    });
  });

  lbLogoutBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VIVI_LISTENBRAINZ_LOGOUT' }, () => {
      refreshListenbrainzStatus();
    });
  });
})();

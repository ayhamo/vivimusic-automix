// Vivimusic Web+: one song's canvas (spec/canvas/canvas.md §15, Prism's song menu): a small Canvas button on the
// player page's art opens the song's rows: the Canvas, Spotify canvas and Animated cover switches, Pick another
// part, Pick another video, Use and Not this video. YT Music's own song menu isn't ours, so the rows live here.
// The choices are kept per song by src/plus/video-canvas.js (window.__viviCanvasSongs, storage.local
// viviCanvasChoices); content.js's hook VP.reCheckCanvas shows a change at once.
'use strict';

(() => {
  if (window.__viviCanvasMenu) return;
  window.__viviCanvasMenu = true;
  const CS = globalThis.__viviCanvasSettings;
  const songs = () => window.__viviCanvasSongs;
  const reCheck = () => { try { window.__viviPlus?.content?.reCheckCanvas?.(); } catch { /* the next song shows it */ } };
  const songId = () => new URLSearchParams(location.search).get('v') || '';
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const NAMES = { video: 'Music video', spotify: 'Spotify canvas', apple: 'Animated cover' };

  let set = { canvasOn: true, appleOn: true, order: CS ? CS.read({}).order : ['video', 'spotify', 'apple'], on: CS ? CS.read({}).on : ['video', 'spotify', 'apple'] };
  const KEYS = ['spotifyCanvasEnabled', 'enabled', 'canvasSourceOrder', 'canvasSourcesOn'];
  const readSet = (s) => {
    const r = CS ? CS.read(s) : { order: set.order, on: set.on };
    set = { canvasOn: s.spotifyCanvasEnabled !== false, appleOn: s.enabled !== false, order: r.order, on: r.on };
  };
  chrome.storage.local.get(KEYS).then(readSet).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && KEYS.some((k) => k in ch)) chrome.storage.local.get(KEYS).then(readSet).catch(() => {});
  });

  function track() {
    const m = navigator.mediaSession?.metadata;
    const id = songId();
    return id && m?.title ? { videoId: id, song: m.title, artist: m.artist || '', album: m.album || '' } : null;
  }

  const css = document.createElement('style');
  css.textContent = `
    #vivi-canvas-menu-btn { position: fixed; z-index: 1000; width: 30px; height: 30px; border-radius: 50%; display: none;
      align-items: center; justify-content: center; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.25);
      color: #fff; cursor: pointer; opacity: .55; transition: opacity .15s; backdrop-filter: blur(8px); }
    #vivi-canvas-menu-btn:hover { opacity: 1; }
    #vivi-canvas-menu-btn svg { width: 16px; height: 16px; }
    #vivi-canvas-menu { position: fixed; z-index: 1001; width: 290px; max-height: 70vh; overflow: auto; padding: 8px 0;
      border-radius: 14px; background: rgba(28,28,28,.97); border: 1px solid rgba(255,255,255,.12); color: #fff;
      font: 13px/1.4 Roboto, Arial, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
    #vivi-canvas-menu .head { padding: 4px 16px 8px; color: rgba(255,255,255,.6); font-size: 11.5px; }
    #vivi-canvas-menu .row { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; }
    #vivi-canvas-menu .row:hover { background: rgba(255,255,255,.08); }
    #vivi-canvas-menu .row .val { margin-left: auto; color: rgba(255,255,255,.6); }
    #vivi-canvas-menu .sw { margin-left: auto; width: 30px; height: 16px; border-radius: 8px; background: rgba(255,255,255,.25); position: relative; }
    #vivi-canvas-menu .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .12s; }
    #vivi-canvas-menu .sw.on { background: #3ea6ff; }
    #vivi-canvas-menu .sw.on::after { left: 16px; }
    #vivi-canvas-menu .tiles { display: flex; gap: 8px; overflow-x: auto; padding: 4px 16px 10px; }
    #vivi-canvas-menu .tile { flex: none; cursor: pointer; border-radius: 8px; padding: 4px; text-align: center; }
    #vivi-canvas-menu .tile.cur { outline: 2px solid #3ea6ff; }
    #vivi-canvas-menu .tile:hover { background: rgba(255,255,255,.08); }
    #vivi-canvas-menu .part { width: 64px; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 15px;
      border-radius: 6px; background: rgba(255,255,255,.08); font-variant-numeric: tabular-nums; }
    #vivi-canvas-menu .vid { width: 140px; text-align: left; }
    #vivi-canvas-menu .vid img { width: 140px; height: 79px; object-fit: cover; border-radius: 6px; display: block; background: rgba(255,255,255,.08); }
    #vivi-canvas-menu .vid .t { font-size: 12px; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #vivi-canvas-menu .vid .by { font-size: 11px; color: rgba(255,255,255,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #vivi-canvas-menu .note { padding: 8px 16px; color: rgba(255,255,255,.6); }
    #vivi-canvas-toast { position: fixed; z-index: 1002; left: 50%; bottom: 110px; transform: translateX(-50%); padding: 8px 16px;
      border-radius: 8px; background: rgba(28,28,28,.95); color: #fff; font: 13px Roboto, Arial, sans-serif; }`;
  (document.head || document.documentElement).append(css);

  function toast(text) {
    document.getElementById('vivi-canvas-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'vivi-canvas-toast';
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M10 9l5 3-5 3z"/></svg>';
  let btn = null, menu = null, menuSong = '';

  function art() {
    if (!document.querySelector('ytmusic-app-layout[player-page-open]')) return null;
    const el = document.querySelector('ytmusic-player#player') || document.querySelector('ytmusic-player');
    const r = el?.getBoundingClientRect();
    return r && r.width > 80 && r.height > 80 ? r : null;
  }

  // the rows for the playing song (§15 rules 1-8)
  function state(id) {
    const S = songs();
    const choice = S?.choice(id) || {};
    const ans = S?.answer(id) || null;
    const videoOn = !!S?.videoOn() && set.on.includes('video');
    const hasLoop = !!ans?.ok;
    const use = choice.use || null;
    // the loop shows when the music video comes first among the sources on (or is the song's Use)
    const firstOn = (use ? [use, ...set.order.filter((n) => n !== use)] : set.order).find((n) => set.on.includes(n) && !choice[{ video: 'loopOff', spotify: 'spotifyOff', apple: 'appleOff' }[n]]);
    const loopShows = hasLoop && !choice.loopOff && firstOn === 'video';
    const rows = CS.songMenu({ canvasOn: set.canvasOn, useVideos: videoOn, isSong: true, hasLoop, loopOff: !!choice.loopOff, loopShows });
    const spotifyOn = set.canvasOn && set.on.includes('spotify'), appleOn = set.appleOn && set.on.includes('apple');
    const others = [spotifyOn && !choice.spotifyOff && 'spotify', appleOn && !choice.appleOff && 'apple'].filter(Boolean);
    return { choice, ans, rows, spotifyOn, appleOn, use: hasLoop && !choice.loopOff && others.length ? ['video', ...others] : null, current: firstOn };
  }

  async function change(id, patch) {
    const S = songs();
    if (!S) return;
    await S.save(id, { ...S.choice(id), ...patch });
    reCheck();
  }

  function closeMenu() { menu?.remove(); menu = null; menuSong = ''; }

  function openMenu() {
    const id = songId();
    if (!id || !songs() || !CS) return;
    closeMenu();
    menuSong = id;
    const r = art();
    menu = document.createElement('div');
    menu.id = 'vivi-canvas-menu';
    if (r) { menu.style.top = (r.top + 48) + 'px'; menu.style.left = Math.max(8, r.right - 300) + 'px'; } else { menu.style.top = '80px'; menu.style.right = '20px'; }
    render();
    document.body.append(menu);
  }

  function render(sub) {
    if (!menu) return;
    const id = menuSong;
    const st = state(id);
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = 'Canvas for this song';
    menu.append(head);
    const row = (label, onClick, extra) => {
      const el = document.createElement('div');
      el.className = 'row';
      el.append(Object.assign(document.createElement('span'), { textContent: label }));
      if (extra) el.append(extra);
      el.addEventListener('click', onClick);
      menu.append(el);
      return el;
    };
    const sw = (on) => Object.assign(document.createElement('span'), { className: 'sw' + (on ? ' on' : '') });
    const val = (t) => Object.assign(document.createElement('span'), { className: 'val', textContent: t });

    // rules 1-2: the switches; each stays after it was switched off for the song
    if (st.rows.canvasSwitch) row('Canvas (music video)', () => change(id, { loopOff: !st.choice.loopOff }).then(() => render()), sw(!st.choice.loopOff));
    if (st.spotifyOn || st.choice.spotifyOff) row('Spotify canvas', () => change(id, { spotifyOff: !st.choice.spotifyOff }).then(() => render()), sw(!st.choice.spotifyOff));
    if (st.appleOn || st.choice.appleOff) row('Animated cover', () => change(id, { appleOff: !st.choice.appleOff }).then(() => render()), sw(!st.choice.appleOff));

    // rule 3: the part playing and up to 4 others
    if (st.rows.pickPart && st.ans?.partMs != null) {
      row('Pick another part', () => render(sub === 'parts' ? null : 'parts'));
      if (sub === 'parts') {
        const tiles = document.createElement('div');
        tiles.className = 'tiles';
        for (const ms of [st.ans.partMs, ...(st.ans.parts || [])]) {
          const t = document.createElement('div');
          t.className = 'tile' + (ms === st.ans.partMs ? ' cur' : '');
          t.innerHTML = `<div class="part">${fmt(ms)}</div>`;
          t.addEventListener('click', () => {
            // rule 4: the part the listener picked; the one it was takes its place among the others
            const p = CS.pickPart(st.ans.partMs, st.ans.parts || [], ms);
            change(id, { part: { video: st.ans.videoId, startMs: p.startMs, others: p.others } });
            closeMenu();
          });
          tiles.append(t);
        }
        menu.append(tiles);
      }
    }

    // rules 5-6: another video
    if (st.rows.pickVideo) {
      row('Pick another video', () => render(sub === 'videos' ? null : 'videos'));
      if (sub === 'videos') {
        const box = document.createElement('div');
        box.className = 'note';
        box.textContent = 'Searching…';
        menu.append(box);
        const tr = track();
        if (!tr) { box.textContent = 'No videos found for this song'; return; }
        songs().videos(tr).then((r) => {
          if (!menu || menuSong !== id) return;
          const list = r?.ok ? r.videos : [];
          if (!list.length) { box.textContent = 'No videos found for this song'; return; }
          const tiles = document.createElement('div');
          tiles.className = 'tiles';
          for (const v of list) {
            const t = document.createElement('div');
            t.className = 'tile vid' + (v.id === st.ans?.videoId ? ' cur' : '');
            const img = document.createElement('img');
            img.src = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`;
            img.alt = '';
            t.append(img, Object.assign(document.createElement('div'), { className: 't', textContent: v.title }),
              Object.assign(document.createElement('div'), { className: 'by', textContent: v.by }));
            t.addEventListener('click', async () => {
              closeMenu();
              toast('Making a loop from that video…');
              const got = await songs().tryPick(tr, v.id);
              if (!got?.ok) { toast("That video can't make a loop"); return; }
              // taken: the listener's from now on, and the song uses its music video (rule 6)
              await change(id, { picked: v.id, part: null, use: 'video', loopOff: false, rejected: (st.choice.rejected || []).filter((x) => x !== v.id) });
              document.getElementById('vivi-canvas-toast')?.remove();
            });
            tiles.append(t);
          }
          box.replaceWith(tiles);
        });
      }
    }

    // rule 7: which source the song shows
    if (st.use) {
      row('Use', () => render(sub === 'use' ? null : 'use'), val(NAMES[st.current] || ''));
      if (sub === 'use') {
        for (const n of st.use) {
          const el = row('  ' + NAMES[n], () => { change(id, { use: n }); closeMenu(); }, n === st.current ? val('✓') : null);
          el.style.paddingLeft = '28px';
        }
      }
    }

    // rule 8: not this video
    if (st.rows.notThisVideo && st.ans?.videoId) {
      row('Not this video', () => {
        const away = [...new Set([...(st.choice.rejected || []), st.ans.videoId])];
        change(id, { rejected: away, picked: st.choice.picked === st.ans.videoId ? null : st.choice.picked, part: null });
        closeMenu();
      });
    }
    if (menu.children.length === 1) menu.append(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Nothing to choose for this song yet.' }));
  }

  function place() {
    const r = art();
    const id = songId();
    if (!btn) {
      btn = document.createElement('div');
      btn.id = 'vivi-canvas-menu-btn';
      btn.title = 'Canvas for this song';
      btn.innerHTML = ICON;
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu) closeMenu(); else openMenu(); });
      document.body.append(btn);
    }
    const show = !!r && !!id && !!songs() && (set.canvasOn || set.appleOn);
    btn.style.display = show ? 'flex' : 'none';
    if (show) { btn.style.top = (r.top + 10) + 'px'; btn.style.left = (r.right - 40) + 'px'; }
    if (menu && (menuSong !== id || !show)) closeMenu();
  }

  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) closeMenu(); }, true);
  setInterval(place, 400);
})();

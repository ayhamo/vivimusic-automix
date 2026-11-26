// Vivimusic Web+: the song's best part (spec/canvas/canvas.md §14, Prism's BestParts): a "Best part" button
// above the player bar early in the song (click: jump there; right-click: Your best part), a mark on the
// seek bar, and "Your best part", the listener's own per song (storage.local viviBestPartMine).
// The part itself comes from the page (src/plus/video-canvas-page.js op 'bestpart': the most replayed
// stretch, else the chorus of the lyrics, snapped to a lyric line); seeking goes through seek-page.js.
'use strict';

(() => {
  if (window.__viviBestPart) return;
  window.__viviBestPart = true;
  const CHANNEL = 'vivi-vcanvas';
  const MINE = 'viviBestPartMine';
  const MINE_MAX = 500;
  let mine = {};
  let cur = null;       // { id, auto, from, knownAtMs }
  let seq = 0;

  // §14 rule 8: the Best part button setting (storage.local bestPartButton, on by default); off hides only the button
  let buttonOn = true;
  chrome.storage.local.get({ [MINE]: {}, bestPartButton: true }).then((s) => { mine = s[MINE] || {}; buttonOn = s.bestPartButton !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch[MINE]) mine = ch[MINE].newValue || {};
    if (ch.bestPartButton) buttonOn = ch.bestPartButton.newValue !== false;
  });

  const video = () => document.querySelector('video');
  // the playing song: the URL's ?v= (the player page), else the player's own (a song playing under the
  // home page, a playlist or a search has no ?v=); the chain content.js and lyrics-ui.js use
  const songId = () => {
    const fromUrl = new URLSearchParams(location.search).get('v');
    if (fromUrl) return fromUrl;
    try { return (document.querySelector('#movie_player, ytmusic-player')?.getVideoData?.() || window.__viviPageVideoData?.())?.video_id || ''; } catch { return ''; }
  };
  const posMs = () => Math.round((video()?.currentTime || 0) * 1000);
  const durMs = () => Math.round((video()?.duration || 0) * 1000);
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const own = () => (cur && Number.isFinite(mine[cur.id]) ? mine[cur.id] : null);
  const startMs = () => own() ?? cur?.auto ?? null;
  const shows = (at, start, known) => at < Math.min(Math.max(30000, known + 15000), 45000) && at < start - 3000;   // §14 rule 3

  function seek(ms) {
    const sec = Math.max(0, ms / 1000);
    try { window.postMessage({ ch: 'vivi-seek', t: sec }, window.location.origin); } catch { /* fallback below */ }
    const v = video();
    if (v) try { v.currentTime = sec; } catch { /* the player's seek did it */ }
  }

  function ask(msg, ms = 20000) {
    return new Promise((resolve) => {
      const reqId = 'bp' + (++seq);
      const t = setTimeout(() => { window.removeEventListener('message', on); resolve(null); }, ms);
      const on = (e) => {
        if (e.source !== window || e.data?.ch !== CHANNEL || e.data.dir !== 'out' || e.data.reqId !== reqId) return;
        clearTimeout(t); window.removeEventListener('message', on); resolve(e.data);
      };
      window.addEventListener('message', on);
      window.postMessage({ ch: CHANNEL, dir: 'in', reqId, ...msg }, window.location.origin);
    });
  }

  // the page tells when the lyrics made the part better (a lyric line, or the chorus)
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || d?.ch !== CHANNEL || d.dir !== 'out' || d.type !== 'bestpart' || d.id !== cur?.id) return;
    cur.auto = d.startMs ?? null; cur.from = d.from;
    if (cur.knownAtMs == null && cur.auto != null) cur.knownAtMs = posMs();
  });

  function newSong(id) {
    cur = { id, auto: null, from: '', knownAtMs: null };
    closeEditor();
    if (!id) return;
    ask({ op: 'bestpart', id }).then((r) => {
      if (cur?.id !== id || !r?.ok) return;
      cur.auto = r.startMs ?? null; cur.from = r.from || '';
      // (known only with a part: one that comes later, the chorus from the lyrics, starts the window then, §14 rule 3)
      if (cur.auto != null) cur.knownAtMs = posMs();
      console.info('[ViVi best part]', id, cur.auto == null ? `none (${cur.from})` : `${fmt(cur.auto)} (${cur.from})`);
    });
  }

  // ── the button (rule 3) and the mark on the seek bar (rule 4) ──
  const css = document.createElement('style');
  css.textContent = `
    #vivi-best-part { position: fixed; z-index: 1000; transform: translateX(-50%); display: none; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 999px; font: 500 12px/1.4 Roboto, Arial, sans-serif; color: rgba(255,255,255,.92);
      background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.28); backdrop-filter: blur(10px); cursor: pointer; }
    #vivi-best-part:hover { background: rgba(255,255,255,.16); }
    #vivi-best-part svg { width: 12px; height: 12px; }
    .vivi-best-mark { position: absolute; top: 50%; width: 3px; height: 9px; margin-left: -1.5px; transform: translateY(-50%);
      border-radius: 2px; background: #ff9e3d; z-index: 2; }
    #vivi-best-editor { position: fixed; z-index: 1001; width: 300px; transform: translateX(-50%); padding: 14px 16px 12px;
      border-radius: 14px; background: rgba(28,28,28,.96); border: 1px solid rgba(255,255,255,.12); color: #fff;
      font: 13px/1.4 Roboto, Arial, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
    #vivi-best-editor h3 { margin: 0 0 2px; font-size: 15px; font-weight: 500; }
    #vivi-best-editor .sub { color: rgba(255,255,255,.6); font-size: 11.5px; }
    #vivi-best-editor .at { text-align: center; font-size: 26px; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
    #vivi-best-editor .what { text-align: center; color: rgba(255,255,255,.6); font-size: 11.5px; margin-bottom: 6px; }
    #vivi-best-editor input[type=range] { width: 100%; }
    #vivi-best-editor .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    #vivi-best-editor button { border: 0; border-radius: 999px; padding: 6px 12px; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; font: inherit; }
    #vivi-best-editor button.primary { background: #fff; color: #000; margin-left: auto; }
    #vivi-best-editor button.link { background: none; padding: 6px 0; color: rgba(255,255,255,.7); }`;
  (document.head || document.documentElement).append(css);

  const FLAME = '<svg viewBox="0 0 24 24" fill="FILL" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
  let btn = null;
  function button() {
    if (btn?.isConnected) return btn;
    btn = document.createElement('div');
    btn.id = 'vivi-best-part';
    btn.title = 'Skip to the best part (right-click: set your own)';
    btn.addEventListener('click', () => { const s = startMs(); if (s != null) seek(s); });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openEditor(); });
    document.body.append(btn);
    return btn;
  }

  function render() {
    const bar = document.querySelector('ytmusic-player-bar');
    const s = startMs(), d = durMs(), at = posMs();
    const b = button();
    const up = buttonOn && !!bar && s != null && d > 0 && shows(at, s, cur?.knownAtMs ?? 0) && !editor;
    if (up) {
      const r = bar.getBoundingClientRect();
      b.style.left = (r.left + r.width / 2) + 'px';
      b.style.bottom = (innerHeight - r.top + 10) + 'px';
      const label = own() != null ? 'Your best part' : 'Best part';
      if (b.dataset.label !== label) { b.dataset.label = label; b.innerHTML = FLAME.replace('FILL', own() != null ? 'currentColor' : 'none') + `<span>${label}</span>`; }
    }
    b.style.display = up ? 'flex' : 'none';
    // the mark
    const slider = bar?.querySelector('#progress-bar');
    let mark = slider?.querySelector('.vivi-best-mark');
    const frac = s != null && d > 0 ? s / d : -1;
    if (slider && frac >= 0.01 && frac <= 0.99) {
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'vivi-best-mark';
        // a right-click on the mark opens Your best part too (the only way in with the button off, rule 8)
        mark.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openEditor(); });
        if (getComputedStyle(slider).position === 'static') slider.style.position = 'relative';
        slider.append(mark);
      }
      mark.style.left = (frac * 100) + '%';
      mark.title = (own() != null ? 'Your best part ' : 'Best part ') + fmt(s) + ' (right-click: set your own)';
    } else mark?.remove();
  }

  // ── Your best part (rule 5) ──
  let editor = null;
  function closeEditor() { editor?.remove(); editor = null; }
  function openEditor() {
    if (!cur?.id) return;
    closeEditor();
    const id = cur.id, d = Math.max(1000, durMs());
    let at = Math.min(Math.max(0, own() ?? cur.auto ?? posMs()), d - 1000);
    const bar = document.querySelector('ytmusic-player-bar')?.getBoundingClientRect();
    editor = document.createElement('div');
    editor.id = 'vivi-best-editor';
    editor.style.left = (bar ? bar.left + bar.width / 2 : innerWidth / 2) + 'px';
    editor.style.bottom = (bar ? innerHeight - bar.top + 10 : 100) + 'px';
    editor.innerHTML = `<h3>Your best part</h3><div class="sub">Where Best part takes you in this song.</div>
      <div class="at"></div><div class="what"></div>
      <input type="range" min="0" max="${d - 1000}" step="250">
      <div class="row"><button data-d="-5000">−5 s</button><button data-d="5000">+5 s</button><button data-now>Now</button></div>
      <div class="row"><button class="link" data-listen>Listen from here</button><button class="primary" data-save>Save</button></div>
      ${own() != null ? `<div class="row"><button class="link" data-forget>${cur.auto != null ? 'Back to the part people replay' : 'Forget my best part'}</button></div>` : ''}`;
    const atEl = editor.querySelector('.at'), what = editor.querySelector('.what'), range = editor.querySelector('input');
    const set = (ms) => {
      at = Math.min(Math.max(0, Math.round(ms)), d - 1000);
      range.value = String(at);
      atEl.textContent = fmt(at);
      what.textContent = cur.auto != null && Math.abs(at - cur.auto) < 1000 ? (cur.from === 'chorus' ? 'the chorus' : 'the part people replay most')
        : own() != null && at === own() ? 'your pick' : 'pick a moment on the bar';
    };
    set(at);
    range.addEventListener('input', () => set(Number(range.value)));
    editor.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => set(at + Number(b.dataset.d))));
    editor.querySelector('[data-now]').addEventListener('click', () => set(posMs()));
    editor.querySelector('[data-listen]').addEventListener('click', () => seek(at));
    const store = (ms) => {
      const next = { ...mine };
      delete next[id];
      if (ms != null) next[id] = ms;
      const keys = Object.keys(next);
      if (keys.length > MINE_MAX) keys.slice(0, keys.length - MINE_MAX).forEach((k) => delete next[k]);   // oldest set first out
      mine = next;
      chrome.storage.local.set({ [MINE]: next }).catch(() => {});
      closeEditor();
    };
    editor.querySelector('[data-save]').addEventListener('click', () => store(at));
    editor.querySelector('[data-forget]')?.addEventListener('click', () => store(null));
    document.body.append(editor);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editor) closeEditor(); }, true);
  document.addEventListener('mousedown', (e) => { if (editor && !editor.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) closeEditor(); }, true);

  setInterval(() => {
    const id = songId();
    if (id !== (cur?.id || '')) newSong(id);
    render();
  }, 250);
})();

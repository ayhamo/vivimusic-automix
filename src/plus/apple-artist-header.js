// Vivimusic Web+: Apple Music's artist image and artist video in YT Music's artist page header
// (spec/canvas/canvas.md §13 rule 8; Metrolist's ArtistViewModel + fetchArtistArtwork). Off by
// default: two switches (images; videos follow images until set) and the video quality. The
// lookup is the background's (VIVI_APPLE_ARTIST_HEADER in src/plus/bg-plus.js); the video plays
// muted in upstream's Apple player page (src/apple-canvas-player.html, hls.js), over the image.
'use strict';

(() => {
  if (window.__viviAppleArtistHeader) return;
  window.__viviAppleArtistHeader = true;
  const CS = globalThis.__viviCanvasSettings;
  const LAYER = 'vivi-apple-artist-layer';
  let opts = { image: false, video: false, quality: '720' };
  let shownFor = '';    // the page and settings the layer was made (or is being looked up) for
  let layerEl = null;   // the layer made for shownFor (YT Music may re-render the header)
  let seq = 0;

  const read = (s) => {
    const image = s.appleArtistImages === true;
    return { image, video: s.appleArtistVideos == null ? image : s.appleArtistVideos === true, quality: CS ? CS.read({ appleCoverQuality: s.appleArtistVideoQuality }).coverQuality : '720' };
  };
  const KEYS = { appleArtistImages: false, appleArtistVideos: null, appleArtistVideoQuality: '720' };
  chrome.storage.local.get(KEYS).then((s) => { opts = read(s); check(); }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !Object.keys(KEYS).some((k) => k in ch)) return;
    chrome.storage.local.get(KEYS).then((s) => { opts = read(s); shownFor = ''; check(); }).catch(() => {});
  });

  // the artist page's header: its picture box and the artist's name
  function header() {
    if (!/^\/(channel|browse)\/UC/.test(location.pathname)) return null;
    const h = document.querySelector('ytmusic-browse-response:not([hidden]) ytmusic-immersive-header-renderer, ytmusic-browse-response:not([hidden]) ytmusic-visual-header-renderer');
    const box = h?.querySelector('#image, .image');
    const name = h?.querySelector('h1, .title')?.textContent?.trim();
    return box && name ? { box, name } : null;
  }

  function clear() {
    layerEl = null;
    document.querySelectorAll('.' + LAYER).forEach((el) => el.remove());
  }

  async function check() {
    const h = header();
    const want = h && (opts.image || opts.video) ? [location.pathname, h.name, opts.image, opts.video, opts.quality].join('|') : '';
    if (want === shownFor) {
      if (layerEl && !layerEl.isConnected) {   // the header was drawn again
        if (getComputedStyle(h.box).position === 'static') h.box.style.position = 'relative';
        h.box.append(layerEl);
      }
      return;   // shown, nothing to show, or still looking it up
    }
    shownFor = want;
    clear();
    if (!want) return;
    const my = ++seq;
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'VIVI_APPLE_ARTIST_HEADER', artist: h.name, ...opts }); } catch { /* context gone */ }
    if (my !== seq || shownFor !== want) return;
    if (!r?.ok) { shownFor = ''; console.info('[ViVi artist header]', `'${h.name}': lookup failed (${r?.error || 'no answer'})`); return; }
    console.info('[ViVi artist header]', `'${h.name}':`, r.imageUrl ? 'image' : 'no image', r.videoUrl ? '+ video' : '', `(${r.from})`);
    if (!r.imageUrl && !r.videoUrl) return;
    const layer = document.createElement('div');
    layer.className = LAYER;
    layer.style.cssText = 'position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:0;';
    if (r.imageUrl) {
      const img = document.createElement('img');
      img.src = r.imageUrl;
      img.alt = '';
      img.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover;';
      layer.append(img);
    }
    if (r.videoUrl) {
      const id = 'vivi-artist-' + my;
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL(`src/apple-canvas-player.html?fit=cover&id=${encodeURIComponent(id)}&r=0#${encodeURIComponent(r.videoUrl)}`);
      frame.setAttribute('allow', 'autoplay');
      frame.setAttribute('frameborder', '0');
      frame.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0; background:transparent; color-scheme:light; opacity:0; transition:opacity .4s;';
      const onMsg = (e) => {
        const m = e.data;
        if (!m || !m.__viviAppleCanvas || m.id !== id) return;
        if (m.type === 'playing') frame.style.opacity = '1';
        else if (m.type === 'error') frame.remove();
        window.removeEventListener('message', onMsg);
      };
      window.addEventListener('message', onMsg);
      layer.append(frame);
    }
    if (getComputedStyle(h.box).position === 'static') h.box.style.position = 'relative';
    h.box.append(layer);
    layerEl = layer;
  }

  document.addEventListener('yt-navigate-finish', () => setTimeout(check, 300));
  setInterval(() => { if (opts.image || opts.video) check(); }, 1500);
})();

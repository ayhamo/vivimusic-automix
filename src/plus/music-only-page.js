/* Vivimusic Web+ — music-only-page.js  (runs in the page's MAIN world)
 *
 * The page half of "Prefer music-only version" (src/music-only.js). YouTube
 * Music's Song / Video switch can only swap a queue item for its paired song
 * (the item's "counterpart"). Some items have no pair, often the video a radio
 * was started from by its link, so Song only hides the picture and the video's
 * audio plays on.
 *
 * For such an item (an official music video, OMV) this finds the song version
 * with a YT Music song search: the same title, one of the same artists, no
 * other take (live, remix, cover ...), and a length within 10 s. It is added to
 * the queue item as its pair, the way YouTube Music sends paired items. The
 * switch then works as usual: in Song mode YouTube Music moves to the song at
 * the same position, and the rest of the queue stays as it was.
 *
 * Talks to music-only.js through attributes on <html>:
 *   data-vivi-music-only="1"   set by music-only.js: the setting is on and no
 *                              blend is running (anything else: do nothing)
 *   data-vivi-playing-id       set here: the id the player plays (the page URL
 *                              has none while the player page is closed)
 */
(() => {
  'use strict';
  if (window.__viviMusicOnlyPage) return;
  window.__viviMusicOnlyPage = true;

  const log = (...a) => console.log('%c[ViVi music-only]', 'color:#9ccc65', ...a);
  const SONGS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';   // YT Music search: songs only
  const OTHER = ['live', 'remix', 'cover', 'acoustic', 'unplugged', 'instrumental', 'karaoke', 'sped up', 'slowed',
    'nightcore', 'version', 'versión', 'edit', 'mix', 'demo', 'session', 'en vivo', 'ao vivo', 'piano', 'reverb', 'remaster'];
  const found = new Map();   // video id -> { id, ms } of its song, or null (none); 200 kept
  let busy = false;

  const cfg = (k) => { try { return window.ytcfg?.get?.(k); } catch { return undefined; } };
  const text = (t) => (t?.runs ? t.runs.map((r) => r.text || '').join('') : t?.simpleText || '');
  const secs = (s) => String(s || '').split(':').reduce((a, x) => a * 60 + (Number(x) || 0), 0);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const wordIn = (w, s) => new RegExp('(?<![\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(s);

  function queueStore() {
    try { return document.querySelector('ytmusic-player-queue')?.queue?.store?.store || null; } catch { return null; }
  }

  /** The title without bracketed parts, "| ..." tails, feat. credits and video words. */
  function core(title) {
    let t = String(title).toLowerCase().replace(/\(.*?\)|\[.*?]|【.*?】/g, ' ');
    const bar = t.indexOf(' | ');
    if (bar >= 0) t = t.substring(0, bar);
    t = t.replace(/\s(ft\.?|feat\.?|featuring)\s.*$/, ' ')
      .replace(/(?<![\p{L}])(official|music|video|videoclip|clip|hd|4k|hq|visualizer|mv|m\/v)(?![\p{L}])/gu, ' ');
    return norm(t);
  }

  function artistsOf(s) {
    return String(s || '').split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i).map(norm).filter(Boolean);
  }

  /** The song version of a music video, from a YT Music song search, or null. */
  async function findSong(title, artist, lenSec) {
    const names = artistsOf(artist);
    const want = core(title);
    if (!want || !names.length) return null;
    const visitor = cfg('VISITOR_DATA') || '';
    const res = await fetch('/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}) },
      body: JSON.stringify({
        query: title.replace(/\(.*?\)|\[.*?]/g, ' ').trim() + ' ' + String(artist).split(/\s*(?:,|&)\s*/)[0],
        params: SONGS,
        context: { client: { clientName: 'WEB_REMIX', clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || '1.20251101.01.00', hl: 'en', gl: 'US', ...(visitor ? { visitorData: visitor } : {}) } },
      }),
    });
    if (!res.ok) throw new Error('search HTTP ' + res.status);
    const rows = [];
    (function walk(n) {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const r = n.musicResponsiveListItemRenderer;
      if (r) {
        const col = (i) => r.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
        const first = col(0)?.runs?.[0];
        rows.push({
          id: r.playlistItemData?.videoId || '',
          title: text(col(0)),
          by: text(col(1)).split(' • '),
          type: first?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType,
        });
        return;
      }
      Object.values(n).forEach(walk);
    })(await res.json());
    const vt = String(title).toLowerCase();
    for (const r of rows.slice(0, 8)) {
      if (!r.id || r.type !== 'MUSIC_VIDEO_TYPE_ATV') continue;
      const rt = r.title.toLowerCase();
      if (core(r.title) !== want) continue;
      if (OTHER.some((w) => wordIn(w, rt) && !wordIn(w, vt))) continue;
      if (!artistsOf(r.by[0]).some((a) => names.includes(a))) continue;
      const len = secs(r.by[r.by.length - 1]);
      if (!len || Math.abs(len - lenSec) > 10) continue;
      return { id: r.id, title: r.title, ms: Math.min(len, lenSec) * 1000 };
    }
    log('no song version for', `'${title}' / ${artist}`, 'among', rows.slice(0, 5).map((r) => `'${r.title}' (${r.by.join(' • ')})`).join('; ') || 'no results');
    return null;
  }

  /** The playing queue item with the song added as its pair, as YouTube Music sends paired items. */
  function withPair(item, pr, song) {
    const c = JSON.parse(JSON.stringify(pr));
    delete c.menu;
    c.videoId = song.id;
    c.thumbnail = { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + song.id + '/hqdefault.jpg', width: 480, height: 360 }] };
    const we = c.navigationEndpoint?.watchEndpoint;
    if (we) {
      we.videoId = song.id;
      delete we.params;
      delete we.playerParams;
      we.watchEndpointMusicSupportedConfigs = { watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } };
    }
    const out = { ...item };
    delete out.playlistPanelVideoRenderer;
    out.playlistPanelVideoWrapperRenderer = {
      primaryRenderer: item.playlistPanelVideoWrapperRenderer?.primaryRenderer || { playlistPanelVideoRenderer: pr },
      counterpart: [{
        counterpartRenderer: { playlistPanelVideoRenderer: c },
        segmentMap: { segment: [{ primaryVideoStartTimeMilliseconds: '0', counterpartVideoStartTimeMilliseconds: '0', durationMilliseconds: String(song.ms) }] },
      }],
    };
    return out;
  }

  async function tick() {
    try {
      const playing = document.getElementById('movie_player')?.getVideoData?.()?.video_id || '';
      if (document.documentElement.dataset.viviPlayingId !== playing) document.documentElement.dataset.viviPlayingId = playing;
    } catch { /* player not ready */ }
    if (busy || document.documentElement.dataset.viviMusicOnly !== '1') return;
    const st = queueStore();
    const q = st?.getState?.()?.queue;
    const sel = q?.selectedItemIndex;
    const item = q?.items?.[sel];
    if (!item || item.playlistPanelVideoWrapperRenderer?.counterpart) return;
    const pr = item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer || item.playlistPanelVideoRenderer;
    const type = pr?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
    if (!pr?.videoId || type !== 'MUSIC_VIDEO_TYPE_OMV') return;
    const vid = pr.videoId;
    let song = found.get(vid);
    if (song === undefined) {
      busy = true;
      try {
        song = await findSong(text(pr.title), text(pr.shortBylineText || pr.longBylineText).split(' • ')[0], secs(text(pr.lengthText)));
      } catch (e) {
        log('song search failed:', e?.message || e);
        return;   // not remembered: tried again on the next tick
      } finally { busy = false; }
      found.set(vid, song);
      while (found.size > 200) found.delete(found.keys().next().value);
    }
    if (!song) return;
    // the queue may have moved on during the search
    const q2 = st.getState().queue;
    const now = q2.items[q2.selectedItemIndex];
    const pr2 = now?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer || now?.playlistPanelVideoRenderer;
    if (pr2?.videoId !== vid || now.playlistPanelVideoWrapperRenderer?.counterpart || document.documentElement.dataset.viviMusicOnly !== '1') return;
    st.dispatch({
      type: 'UPDATE_ITEMS',
      payload: { items: [withPair(now, pr2, song), ...q2.items.slice(q2.selectedItemIndex + 1)], currentIndex: q2.selectedItemIndex - 1, shouldAssignIds: false, nextQueueItemId: q2.nextQueueItemId },
    });
    log('paired', vid, 'with its song version', song.id, `'${song.title}'`, '(YouTube Music had no pair for it)');
  }

  setInterval(tick, 1000);
})();

/* Vivimusic Web+ — lyrics-plus.js  (content script, isolated world)
 *
 * Our additions to upstream's lyrics.js, kept out of that file so upstream
 * merges stay small. Loads right BEFORE src/lyrics.js; lyrics.js calls in
 * through its `// vivi+ hook` lines:
 *
 *   extendKeys(DEFAULT_PROVIDERS, providerSettings, PRIORITY_ELIGIBLE_KEYS)
 *        adds the LyricsPlus, Paxsenix and Genius providers to the settings
 *        and LyricsPlus / Paxsenix to the top-3 priority choices
 *   cleanTrack(track)       the title/artist cleaned for the lookup
 *   addProviders(add)       queues the three extra providers in the race
 *   fallback(rawTrack, track, excludeKeys, onUpdate)
 *        the second pass when nothing was found (split "Artist - Title",
 *        then title only); resolves null when it finds nothing
 *   bind(ctx)               lyrics.js's private helpers (end of lyrics.js);
 *        also adds the cleaners and the extra provider names to
 *        window.__viviLyrics
 */
(() => {
  'use strict';

  const plus = (window.__viviPlus = window.__viviPlus || {});
  let L = null; // lyrics.js helpers, from bind()

  // ---- Title & Artist Cleaner for Lyrics (from BitChord / LyricsQuery) ----
  const CREDITS = [
    /#[\w\d_]+/g,
    /\s*[([]\s*(feat|ft|featuring|with)\b[^)\]]*[)\]]/gi,
    /\s+(feat|ft|featuring)\.?\s+.*$/gi,
    /\s*[([]\s*(official\s*)?(music\s*)?(video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m\/?v|hd|hq|4k|60fps|full\s*song)\s*[)\]]/gi,
    /\s*[([]\s*official\s*[)\]]/gi,
    /\s*[([]\s*(slowed(\s*\+\s*reverb)?|sped\s*up|speed\s*up|nightcore|daycore|bass\s*boosted|reverb|tiktok|tik\s*tok(\s*version)?|jersey\s*club|jerseyclub)(\s*(remix|version|mix|edit))?\s*[)\]]/gi,
    /\s*[([]\s*(prod|produced)\s*(by)?\s*[^)\]]+[)\]]/gi,
    /\s*[([]\s*\d+\s*(hour|min|minute)s?\s*(loop)?\s*[)\]]/gi,
    /\s*[([]\s*(remix|edit|vip|flip)\s*[)\]]/gi,
    /\s*[([]\s*(audio\s*only|lyrics?)\s*[)\]]/gi,
  ];

  function cleanTitleForLyrics(title) {
    if (!title) return '';
    let name = String(title);
    for (const pattern of CREDITS) name = name.replace(pattern, ' ');
    const cleaned = name.replace(/\s+/g, ' ').trim().replace(/[,\-–—|~]+$/, '').trim();
    return cleaned || String(title).trim();
  }

  function cleanArtistForLyrics(artist) {
    if (!artist) return '';
    return String(artist).replace(/ - Topic$/i, '').trim() || String(artist).trim();
  }

  // Rebuilds obj in place with the given keys at the front / before `before`,
  // keeping the key order the settings object always had.
  function insertKeys(obj, front, beforeKey, middle) {
    const old = { ...obj };
    Object.keys(obj).forEach((k) => { delete obj[k]; });
    Object.assign(obj, front);
    for (const [k, v] of Object.entries(old)) {
      if (k === beforeKey) Object.assign(obj, middle);
      if (!(k in obj)) obj[k] = v;
    }
    for (const k of Object.keys(middle)) if (!(k in obj)) obj[k] = middle[k];
  }

  function extendKeys(defaults, settings, priorityKeys) {
    // { lyricsplus, ...upstream, paxsenix, genius, spotify }
    for (const obj of [defaults, settings]) {
      insertKeys(obj, { lyricsplus: true }, 'spotify', { paxsenix: true, genius: true });
    }
    // ['lyricsplus', ..., 'betterlyrics', 'paxsenix', ...]
    priorityKeys.unshift('lyricsplus');
    const bl = priorityKeys.indexOf('betterlyrics');
    priorityKeys.splice(bl >= 0 ? bl + 1 : priorityKeys.length, 0, 'paxsenix');
  }

  function cleanTrack(rawTrack) {
    const cleanSong = cleanTitleForLyrics(rawTrack?.song || '');
    const cleanArtist = cleanArtistForLyrics(rawTrack?.artist || '');
    return { ...rawTrack, song: cleanSong, artist: cleanArtist, rawSong: rawTrack?.song, rawArtist: rawTrack?.artist };
  }

  // Paxsenix — Apple Music syllable/word-synced TTML
  async function fromPaxsenix(track) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_PAXSENIX_LYRICS',
        track: { song: track.song, artist: track.artist, duration: track.duration || 0 },
      });
      if (!response?.ok || !response.ttml) return null;
      const parsed = L.checkTiming(L.parseTTML(response.ttml), track, 'Paxsenix');
      if (!parsed) return null;
      parsed.provider = 'Paxsenix';
      return parsed;
    } catch (e) {
      L.log('Paxsenix request failed', e?.message || e);
      return null;
    }
  }

  // Genius — plain-text lyrics fallback
  async function fromGenius(track) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VIVI_GENIUS_LYRICS',
        track: { song: track.song, artist: track.artist },
      });
      if (!response?.ok || !response.html) return null;
      const doc = new DOMParser().parseFromString(response.html, 'text/html');
      let containers = [...doc.querySelectorAll('div[data-lyrics-container="true"]')];
      if (!containers.length) containers = [...doc.querySelectorAll('div.lyrics')];
      if (!containers.length) return null;

      let fullText = '';
      for (const el of containers) {
        el.querySelectorAll('[data-exclude-from-selection="true"], [class*="LyricsHeader__Container"], [class*="SongBioPreview"], [class*="InreadAd"], button, script, style').forEach((n) => n.remove());
        el.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
        fullText += (el.textContent || '') + '\n';
      }
      const cleaned = fullText
        .replace(/\d*You might also like/gi, '')
        .replace(/\d*Embed\s*$/gim, '')
        .trim();
      const parsed = L.parsePlain(cleaned);
      if (!parsed) return null;
      parsed.provider = 'Genius';
      return parsed;
    } catch (e) {
      L.log('Genius request failed', e?.message || e);
      return null;
    }
  }

  // LyricsPlus — community mirrors with syllable/word sync
  const LYRICS_PLUS_MIRRORS = ['https://lyricsplus.prjktla.my.id', 'https://lyricsplus.binimum.org'];
  let lyricsPlusGoodMirror = null;

  async function fromLyricsPlus(track) {
    const mirrors = lyricsPlusGoodMirror
      ? [lyricsPlusGoodMirror, ...LYRICS_PLUS_MIRRORS.filter((m) => m !== lyricsPlusGoodMirror)]
      : LYRICS_PLUS_MIRRORS;

    for (const host of mirrors) {
      try {
        const durSec = Math.round(track.duration || 0);
        const qs = new URLSearchParams({
          title: track.song,
          artist: track.artist,
          duration: durSec ? String(durSec) : '',
        }).toString();
        const res = await L.withTimeout(fetch(`${host}/v2/lyrics/get?${qs}`), L.FETCH_TIMEOUT);
        if (!res || !res.ok) continue;
        const data = await res.json();
        if (!data || !Array.isArray(data.lyrics) || !data.lyrics.length) continue;
        lyricsPlusGoodMirror = host;

        const lines = [];
        let hasSyllables = false;
        for (const item of data.lyrics) {
          if (typeof item.time !== 'number') continue;
          const startMs = item.time;
          const endMs = startMs + (item.duration || 5000);
          const rawText = String(item.text || '').trim();

          let words = null;
          if (Array.isArray(item.syllabus) && item.syllabus.length) {
            const parts = item.syllabus
              .filter((s) => typeof s.text === 'string' && typeof s.time === 'number')
              .map((s) => ({
                text: s.text,
                start: s.time,
                end: s.time + (s.duration || 0),
              }));
            if (parts.length) {
              words = L.buildWordsFromParts(parts);
              L.repairTimings(words, endMs);
              hasSyllables = true;
            }
          }

          lines.push({
            start: startMs,
            end: endMs,
            text: rawText || (words ? words.map((w) => w.text).join(' ') : ''),
            words: words && words.length ? words : undefined,
          });
        }

        if (!lines.length) continue;
        const parsed = {
          mode: hasSyllables ? 'syllable' : 'line',
          provider: 'LyricsPlus',
          lines,
        };
        const checked = L.checkTiming(parsed, track, 'LyricsPlus');
        if (checked) checked.provider = 'LyricsPlus';
        return checked;
      } catch (e) {
        L.log('LyricsPlus mirror error:', host, e?.message || e);
      }
    }
    return null;
  }

  // Queued after upstream's providers, in this order.
  function addProviders(add) {
    add('paxsenix', fromPaxsenix);
    add('lyricsplus', fromLyricsPlus);
    add('genius', fromGenius);
  }

  // Smart Fallback Cascade: if no lyrics were found on the first pass
  async function fallback(rawTrack, track, excludeKeys, onUpdate) {
    const on = (key) => L.providerSettings()[key] && !excludeKeys.has(key); // read live, as before
    const { log, raceProviders } = L;
    let best = null;
    const rawTitle = rawTrack?.song || '';
    // 1. If title has a hyphen (e.g. 'Artist - Song Title'), split and retry with parsed track
    if (rawTitle.includes(' - ')) {
      const parts = rawTitle.split(' - ');
      const candidateTitle = cleanTitleForLyrics(parts[parts.length - 1].trim());
      const candidateArtist = cleanArtistForLyrics(parts[0].trim());
      if (candidateTitle && candidateTitle.toLowerCase() !== (track.song || '').toLowerCase()) {
        log('Retrying lyrics search with parsed hyphen title/artist:', candidateTitle, candidateArtist);
        const fallbackTrack = { ...track, song: candidateTitle, artist: candidateArtist || track.artist };
        const fbJobs = [];
        const addFb = (key, fn) => { if (on(key)) fbJobs.push(fn(fallbackTrack)); };
        addFb('lrcred', L.fromLrcRed);
        addFb('lyricsplus', fromLyricsPlus);
        addFb('paxsenix', fromPaxsenix);
        addFb('betterlyrics', L.fromBetterLyrics);
        addFb('lrclib', L.fromLrclib);
        addFb('musixmatch', L.fromMusixmatch);
        addFb('binilyrics', L.fromBiniLyrics);
        addFb('genius', fromGenius);
        if (fbJobs.length) {
          best = await raceProviders(fbJobs, onUpdate);
        }
      }
    }
    // 2. If still no lyrics, search title-only on LRCLIB, Paxsenix, and Genius (fixes remix/channel uploads)
    if (!best && track.artist) {
      log('Retrying lyrics search title-only for:', track.song);
      const titleOnlyTrack = { ...track, artist: '' };
      const titleJobs = [];
      if (on('lrclib')) titleJobs.push(L.fromLrclib(titleOnlyTrack));
      if (on('paxsenix')) titleJobs.push(fromPaxsenix(titleOnlyTrack));
      if (on('genius')) titleJobs.push(fromGenius(titleOnlyTrack));
      if (titleJobs.length) {
        best = await raceProviders(titleJobs, onUpdate);
      }
    }
    return best;
  }

  // Result labels of our providers, for providerKeyForName().
  const PLUS_KEY_BY_NAME = { Paxsenix: 'paxsenix', LyricsPlus: 'lyricsplus', Genius: 'genius' };

  function bind(ctx) {
    L = ctx;
    const api = window.__viviLyrics;
    if (!api) return;
    const upstreamKeyForName = api.providerKeyForName;
    api.providerKeyForName = (name) => upstreamKeyForName(name)
      || (Object.prototype.hasOwnProperty.call(PLUS_KEY_BY_NAME, name) ? PLUS_KEY_BY_NAME[name] : null);
    api.cleanTitleForLyrics = cleanTitleForLyrics;
    api.cleanArtistForLyrics = cleanArtistForLyrics;
  }

  plus.lyrics = { extendKeys, cleanTrack, addProviders, fallback, bind, cleanTitleForLyrics, cleanArtistForLyrics };
})();

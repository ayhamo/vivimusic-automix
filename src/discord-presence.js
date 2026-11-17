/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 Archimetrix
 * Discord Rich Presence approach (OAuth `sdk.social_layer_presence` + headless sessions)
 * credit: Neurobox by Sheathed (AGPL-3.0) — https://github.com/Sheathed/Neurobox
 * See README.md → "Discord Rich Presence" and THIRD_PARTY_NOTICES.md. */
/**
 * VIVIMUSIC XTEN — discord-presence.js (content script, music.youtube.com)
 *
 * Independent of content.js on purpose: it only reads the player DOM and
 * reports changes to the background worker (discord-rpc.js). Sends a message
 * only on track change, pause/resume, seek, or a 30 s heartbeat.
 */
(() => {
  'use strict';
  if (window.__viviDiscordPresence) return;
  window.__viviDiscordPresence = true;

  const TICK_MS = 1000;
  const HEARTBEAT_MS = 30000;
  const SEEK_TOLERANCE_S = 2.5;
  const PAUSE_CLEAR_MS = 3 * 60 * 1000;   // paused this long → remove the activity
  const ENDED_CLEAR_MS = 10 * 1000;       // song finished and nothing new started → remove it
  const ENABLED_KEY = 'discordRpcEnabled';

  let enabled = false;
  let live = false;                // we currently have presence shown
  let last = null;                 // { key, paused, pos, at }
  let candidate = null;            // { key, ticks }  – debounce for half-rendered track changes
  let pausedSince = 0;
  let pauseCleared = false;
  let endedSince = 0;

  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* extension reloaded */ }
  };

  chrome.storage.local.get(ENABLED_KEY).then((r) => { enabled = !!r[ENABLED_KEY]; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ENABLED_KEY in ch) {
      enabled = !!ch[ENABLED_KEY].newValue;
      if (!enabled) { live = false; last = null; }
    }
  });

  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  function upsizeArt(u) {
    if (!u || !/^https:\/\//i.test(u)) return null;
    if (/googleusercontent\.com|ggpht\.com/.test(u)) return u.replace(/=w\d+-h\d+[^?#]*$/, '=w544-h544-l90-rj');
    return u;
  }

  function readPlayer() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    if (document.querySelector('#movie_player.ad-showing, ytmusic-player[ad-showing]')) return { ad: true };

    const song = text(bar.querySelector('yt-formatted-string.title'));
    const byline = bar.querySelector('yt-formatted-string.byline, .byline');
    const artist = text(byline).split('•')[0].trim();
    if (!song || !artist) return null;

    const links = byline ? byline.querySelectorAll('a') : [];
    const album = links.length >= 2 ? text(links[links.length - 1]) : '';

    let videoId = new URLSearchParams(location.search).get('v');
    if (!videoId) {
      try { videoId = new URL(bar.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v'); } catch (_) {}
    }

    const video = document.querySelector('ytmusic-player video, video');
    const duration = video && isFinite(video.duration) ? video.duration : 0;
    const img = bar.querySelector('.image-wrapper img, ytmusic-thumbnail-renderer img, img#img, img');

    const ended = !!video && (video.ended || (duration > 0 && video.currentTime >= duration - 0.75 && video.paused));

    return {
      ended,
      song, artist,
      album: album && album !== '•' ? album : '',
      videoId: videoId || '',
      duration,
      position: video ? video.currentTime || 0 : 0,
      paused: video ? video.paused : true,
      thumb: upsizeArt(img?.src),
    };
  }

  function clear() {
    if (!live) return;
    live = false; last = null; candidate = null;
    send({ type: 'VIVI_DISCORD_CLEAR' });
  }

  function tick() {
    if (!enabled) return;
    const t = readPlayer();
    if (!t) { clear(); return; }
    if (t.ad) return; // keep whatever was showing; don't announce an advert as a song

    const now = Date.now();

    // A finished song (end of queue) must not linger as "Paused": give autoplay a moment, then clear.
    if (t.ended) {
      if (!endedSince) endedSince = now;
      if (now - endedSince > ENDED_CLEAR_MS) { clear(); pauseCleared = true; }
      return;
    }
    endedSince = 0;

    const key = `${t.videoId}|${t.song}|${t.artist}`;

    // Pause bookkeeping → auto-clear after a long pause.
    if (t.paused) {
      if (!pausedSince) pausedSince = now;
      if (!pauseCleared && now - pausedSince > PAUSE_CLEAR_MS) { pauseCleared = true; clear(); return; }
      if (pauseCleared) return;
    } else {
      pausedSince = 0; pauseCleared = false;
    }

    // Is there anything new worth sending?
    let reason = null;
    if (!last || last.key !== key) {
      // Title / byline / videoId render at slightly different moments; require two identical reads.
      if (candidate?.key === key) candidate.ticks++; else candidate = { key, ticks: 1 };
      if (candidate.ticks >= 2) reason = 'track';
    } else {
      candidate = null;
      const expected = last.paused ? last.pos : last.pos + (now - last.at) / 1000;
      if (t.paused !== last.paused) reason = 'pause';
      else if (!t.paused && Math.abs(t.position - expected) > SEEK_TOLERANCE_S) reason = 'seek';
      else if (now - last.at >= HEARTBEAT_MS) reason = 'heartbeat';
      else if (!live) reason = 'resume';
    }
    if (!reason) return;

    last = { key, paused: t.paused, pos: t.position, at: now };
    live = true;
    send({ type: 'VIVI_DISCORD_PRESENCE', track: { ...t, force: reason === 'seek' || reason === 'pause' } });
  }

  setInterval(tick, TICK_MS);
  window.addEventListener('pagehide', () => { if (live) send({ type: 'VIVI_DISCORD_CLEAR' }); });
})();

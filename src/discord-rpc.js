/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 Archimetrix
 * Discord Rich Presence approach (OAuth `sdk.social_layer_presence` + headless sessions)
 * credit: Neurobox by Sheathed (AGPL-3.0) — https://github.com/Sheathed/Neurobox
 * See README.md → "Discord Rich Presence" and THIRD_PARTY_NOTICES.md. */
/**
 * VIVIMUSIC XTEN — discord-rpc.js (background / service worker, Chromium)
 *
 * Discord Rich Presence with NO desktop software. Flow:
 *   1. OAuth2 + PKCE via chrome.identity.launchWebAuthFlow, scopes
 *      `openid sdk.social_layer_presence` (Public Client, no client secret).
 *   2. POST /users/@me/headless-sessions { activities:[…] } with the user's
 *      own OAuth bearer token — the same transport Discord's Social SDK uses.
 *
 * Content script (discord-presence.js) sends VIVI_DISCORD_PRESENCE messages;
 * the popup talks to us through VIVI_DISCORD_STATUS / LOGIN / LOGOUT /
 * SET_ENABLED / TEST. The service worker can be killed at any time, so every
 * piece of state that matters lives in chrome.storage.
 */
'use strict';

(() => {
  const CFG = {
    CLIENT_ID: '1569581582509936660',
    API: 'https://discord.com/api/v10',
    SCOPES: ['openid', 'sdk.social_layer_presence'],
    ACTIVITY_NAME: 'VIVIMUSIC-XTEN',
    BUTTON_LABEL: 'Listen on YouTube Music',
    REPO_LABEL: 'Get VIVIMUSIC-XTEN',
    REPO_URL: 'https://github.com/Archimetrix/VIVIMUSIC_XTEN',
    LOGO_URL: 'https://raw.githubusercontent.com/Archimetrix/VIVIMUSIC_XTEN/main/icons/icon128.png',
    MIN_GAP_MS: 3000,          // minimum spacing between two writes to Discord
    ART_TIMEOUT_MS: 4000,
  };

  const AUTH_KEY = 'discordAuth';          // storage.local  { accessToken, refreshToken, expiresAt, user }
  const ENABLED_KEY = 'discordRpcEnabled'; // storage.local  boolean
  const SESSION_KEY = 'discordSession';    // storage.local { headlessToken, tabId, lastKey, lastSentAt } (local, so a stale session can be deleted after a browser restart)
  const SEEN_KEY = 'discordLastSeen';      // storage.local  ms timestamp of the last message from the player tab
  const WATCHDOG = 'vivi-discord-watchdog';
  const STALE_MS = 150000;                 // no word from the player tab for this long → clear presence
  const ERR_KEY = 'discordLastError';      // storage.local  string
  const PENDING_KEY = 'discordPendingOAuth'; // storage.local { verifier, state, createdAt } while a login is in flight
  const PENDING_TTL = 10 * 60 * 1000;

  const sessionStore = chrome.storage.local;

  /* ---------------------------------------------------------------- utils */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const trunc = (s, n) => {
    s = String(s || '');
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  };
  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomB64Url = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  async function sha256B64Url(s) {
    return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  }
  const lget = async (k) => (await chrome.storage.local.get(k))[k];
  const lset = (o) => chrome.storage.local.set(o);
  const sget = async () => (await sessionStore.get(SESSION_KEY))[SESSION_KEY] || {};
  const sset = async (patch) => sessionStore.set({ [SESSION_KEY]: { ...(await sget()), ...patch } });
  async function setError(msg) { await lset({ [ERR_KEY]: msg || '' }); }

  /* ----------------------------------------------------------------- auth */
  async function saveTokens(data, prev) {
    const auth = {
      ...(prev || {}),
      accessToken: data.access_token,
      refreshToken: data.refresh_token || prev?.refreshToken || '',
      expiresAt: Date.now() + Math.max((data.expires_in || 3600) - 60, 60) * 1000,
      scope: data.scope || '',
    };
    await lset({ [AUTH_KEY]: auth });
    return auth;
  }

  async function tokenRequest(params) {
    const res = await fetch(`${CFG.API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CFG.CLIENT_ID,
        redirect_uri: chrome.identity.getRedirectURL('discord'),
        ...params,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.message || `OAuth error ${res.status}`);
    return data;
  }

  async function getAccessToken() {
    const auth = await lget(AUTH_KEY);
    if (!auth?.accessToken) throw new Error('Connect Discord first.');
    if (Date.now() < auth.expiresAt) return auth.accessToken;
    if (!auth.refreshToken) throw new Error('Discord login expired. Connect again.');
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    return (await saveTokens(data, auth)).accessToken;
  }

  async function discordFetch(path, body) {
    const token = await getAccessToken();
    const res = await fetch(`${CFG.API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `Discord API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Firefox event pages are suspended after ~30 s idle; keep this one alive while the user logs in.
  const withKeepAlive = (fn) => (typeof viviWithKeepAlive === 'function' ? viviWithKeepAlive(fn) : fn());

  async function login() {
    const verifier = randomB64Url(64);
    const challenge = await sha256B64Url(verifier);
    const state = randomB64Url(24);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', CFG.CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', chrome.identity.getRedirectURL('discord'));
    url.searchParams.set('scope', CFG.SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    // Persisted (not kept in memory) so a suspended event page / service worker can't lose it,
    // and so the Firefox "paste the callback URL" fallback can finish the same login.
    await lset({ [PENDING_KEY]: { verifier, state, createdAt: Date.now() } });

    let redirect;
    try {
      redirect = await withKeepAlive(() => chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }));
    } catch (e) {
      const m = e?.message || '';
      // Firefox words "the window ended on an error page / was closed" as a cancellation.
      throw new Error(/cancel|denied/i.test(m)
        ? 'Login was not completed. If Discord showed "Invalid OAuth2 redirect_uri", register the address below in your Discord app.'
        : (m || 'Discord login did not finish.'));
    }
    if (!redirect) throw new Error('Discord login was cancelled.');
    return completeLogin(redirect);
  }

  async function completeLogin(redirectUrl) {
    const pending = await lget(PENDING_KEY);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL) {
      throw new Error('Start "Connect Discord" again, then paste the address within 10 minutes.');
    }
    let back;
    try { back = new URL(String(redirectUrl).trim()); } catch (_) { throw new Error('That is not a valid address.'); }
    if (back.searchParams.get('state') !== pending.state) throw new Error('Discord OAuth state mismatch.');
    const code = back.searchParams.get('code');
    if (!code) throw new Error(back.searchParams.get('error_description') || 'Discord did not return a code.');

    const data = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pending.verifier });
    let auth = await saveTokens(data, null);
    await lset({ [PENDING_KEY]: null });
    try {
      const u = await discordFetch('/oauth2/userinfo');
      auth = { ...auth, user: { id: u.sub, username: u.preferred_username || u.nickname || u.sub } };
      await lset({ [AUTH_KEY]: auth });
    } catch (_) { /* username is cosmetic */ }
    await lset({ [ENABLED_KEY]: true });
    await setError('');
    return auth;
  }

  /* ------------------------------------------------------------- artwork */
  const artCache = new Map();
  const upsizeItunes = (u) => u.replace(/(\d+)x\1(bb)?\.(jpe?g|png)$/i, (_, __, bb, ext) => `600x600${bb || ''}.${ext}`);

  async function itunesArtwork(track) {
    const key = `${track.song}\u0000${track.artist}\u0000${track.album || ''}`.toLowerCase();
    if (artCache.has(key)) return artCache.get(key);
    let out = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.ART_TIMEOUT_MS);
    try {
      const q = new URLSearchParams({ term: `${track.song} ${track.artist}`, media: 'music', entity: 'song', limit: '5' });
      const res = await fetch(`https://itunes.apple.com/search?${q}`, { signal: ctl.signal });
      if (res.ok) {
        const results = (await res.json()).results || [];
        const norm = (s) => (s || '').toLowerCase().trim();
        const hit =
          (track.album && results.find((r) => norm(r.collectionName) === norm(track.album) && norm(r.artistName) === norm(track.artist))) ||
          results.find((r) => norm(r.artistName) === norm(track.artist) && norm(r.trackName) === norm(track.song)) ||
          null;                       // no loose match: a wrong cover is worse than the YT thumbnail
        const raw = hit && (hit.artworkUrl100 || hit.artworkUrl60);
        if (raw) out = upsizeItunes(raw);
      }
    } catch (_) { /* offline / timeout → fall back to YT thumbnail */ }
    clearTimeout(timer);
    artCache.set(key, out);
    if (artCache.size > 200) artCache.delete(artCache.keys().next().value);
    return out;
  }

  /* ------------------------------------------------------------ activity */
  const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u) && u.length <= 512;

  function buildActivity(track, artUrl, now = Date.now()) {
    const url = track.videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(track.videoId)}` : null;
    const playing = !track.paused;
    const art = isHttps(artUrl) ? artUrl : (isHttps(track.thumb) ? track.thumb : null);

    const activity = {
      application_id: CFG.CLIENT_ID,
      platform: 'desktop',
      supported_platforms: ['desktop'],
      type: 2, // Listening
      name: CFG.ACTIVITY_NAME,
      details: trunc(track.song, 128),
      state: trunc(playing ? track.artist : `${track.artist} · Paused`, 128),
    };
    // Cover art is the big picture with our logo as the small corner badge. With no cover, the logo
    // takes the big slot so the activity always carries the app's branding.
    activity.assets = art
      ? { large_image: art, large_text: trunc(track.album || track.song, 128),
          small_image: CFG.LOGO_URL, small_text: 'VIVIMUSIC-XTEN', small_url: CFG.REPO_URL }
      : { large_image: CFG.LOGO_URL, large_text: 'VIVIMUSIC-XTEN', large_url: CFG.REPO_URL };
    if (art && url) activity.assets.large_url = url;
    // Discord shows at most two buttons (and never shows your own buttons to you; other people see them).
    activity.buttons = [];
    if (url) activity.buttons.push({ label: CFG.BUTTON_LABEL, url });
    activity.buttons.push({ label: CFG.REPO_LABEL, url: CFG.REPO_URL });
    activity.metadata = { button_urls: activity.buttons.map((b) => b.url) };
    if (playing && track.duration > 0 && isFinite(track.duration)) {
      const startMs = Math.floor(now - Math.max(track.position || 0, 0) * 1000);
      activity.timestamps = { start: String(startMs), end: String(Math.floor(startMs + track.duration * 1000)) };
    }
    return activity;
  }

  /* ------------------------------------------------- presence write queue */
  let chain = Promise.resolve();
  let lastWriteAt = 0;
  let generation = 0; // bumped by clear(), so a queued stale update never resurrects presence
  const enqueue = (fn) => (chain = chain.catch(() => {}).then(fn));

  async function writeActivities(activities, headlessToken) {
    const body = { activities };
    if (headlessToken) body.token = headlessToken;
    return discordFetch('/users/@me/headless-sessions', body);
  }

  async function pushPresence(track, sender, gen) {
    const store = await lget(ENABLED_KEY);
    if (!store || !(await lget(AUTH_KEY))?.accessToken) return;

    const sess = await sget();
    const key = JSON.stringify([track.videoId || '', track.song, track.artist, !!track.paused]);
    const sinceLast = Date.now() - (sess.lastSentAt || 0);
    if (!track.force && key === sess.lastKey && sinceLast < 25000) return;

    const gap = CFG.MIN_GAP_MS - (Date.now() - lastWriteAt);
    if (gap > 0) await sleep(gap);
    if (gen !== generation) return;

    const art = await itunesArtwork(track);
    if (gen !== generation) return;
    const activity = buildActivity(track, art);

    // If Discord rejects a field, shed the least important parts first instead of losing everything:
    // 1) link fields  2) our logo badge  3) all images  4) buttons.
    const attempts = [
      (x) => x,
      (x) => { if (x.assets) { delete x.assets.small_url; delete x.assets.large_url; } return x; },
      (x) => { if (x.assets) { delete x.assets.small_image; delete x.assets.small_text; } return x; },
      (x) => { delete x.assets; return x; },
      (x) => { delete x.buttons; delete x.metadata; return x; },
    ];
    let result;
    for (let i = 0; i < attempts.length; i++) {
      attempts[i](activity);
      try {
        result = await writeActivities([activity], sess.headlessToken);
        break;
      } catch (e) {
        if (e.status === 401) { await lset({ [AUTH_KEY]: null }); throw e; }
        if (e.status !== 400 || i === attempts.length - 1) throw e;
      }
    }
    lastWriteAt = Date.now();
    if (gen !== generation) { await doClear(); return; }
    await sset({
      headlessToken: result?.token || sess.headlessToken || '',
      tabId: sender?.tab?.id ?? sess.tabId ?? null,
      lastKey: key,
      lastSentAt: Date.now(),
    });
    await setError('');
  }

  async function doClear() {
    const sess = await sget();
    await sset({ headlessToken: '', tabId: null, lastKey: '', lastSentAt: 0 });
    if (!(await lget(AUTH_KEY))?.accessToken) return;
    if (sess.headlessToken) {
      await discordFetch('/users/@me/headless-sessions/delete', { token: sess.headlessToken }).catch(() => {});
    }
    await discordFetch('/users/@me/headless-sessions', { activities: [] }).catch(() => {});
  }

  function clearPresence() {
    generation++;
    return enqueue(doClear);
  }

  function updatePresence(track, sender) {
    const gen = generation;
    return enqueue(() => pushPresence(track, sender, gen)).catch(async (e) => {
      await setError(e.message || String(e));
    });
  }

  /* -------------------------------------------------------------- status */
  async function status() {
    const auth = await lget(AUTH_KEY);
    const pending = await lget(PENDING_KEY);
    const redirectUri = chrome.identity.getRedirectURL('discord');
    return {
      // Firefox only: offer "paste the callback address" when a login was started but not completed.
      canPaste: /allizom\.org/.test(redirectUri) && !auth?.accessToken && !!pending && Date.now() - pending.createdAt < PENDING_TTL,
      connected: !!auth?.accessToken,
      username: auth?.user?.username || '',
      enabled: !!(await lget(ENABLED_KEY)),
      error: (await lget(ERR_KEY)) || '',
      redirectUri,
    };
  }

  async function revokeToken() {
    const auth = await lget(AUTH_KEY);
    if (!auth) return;
    for (const [tok, hint] of [[auth.refreshToken, 'refresh_token'], [auth.accessToken, 'access_token']]) {
      if (!tok) continue;
      await fetch(`${CFG.API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CFG.CLIENT_ID, token: tok, token_type_hint: hint }),
      }).catch(() => {});
    }
  }

  async function logout() {
    await clearPresence().catch(() => {});
    await revokeToken(); // best effort: Discord drops the authorization, not just our copy
    await lset({ [AUTH_KEY]: null, [ENABLED_KEY]: false });
    await setError('');
  }

  /* ------------------------------------------------------------ messages */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('VIVI_DISCORD_')) return false;
    const done = (p) => p.then((r) => sendResponse({ ok: true, ...(r || {}) }),
                               (e) => sendResponse({ ok: false, error: e.message || String(e) }));
    switch (msg.type) {
      case 'VIVI_DISCORD_PRESENCE':
        if (sender.id !== chrome.runtime.id || !msg.track?.song) { sendResponse({ ok: false }); return false; }
        lset({ [SEEN_KEY]: Date.now() });
        done(updatePresence(msg.track, sender).then(() => ({})));
        return true;
      case 'VIVI_DISCORD_CLEAR':
        done(clearPresence().then(() => ({})));
        return true;
      case 'VIVI_DISCORD_STATUS':
        done(status());
        return true;
      case 'VIVI_DISCORD_LOGIN':
        done(login().then(status).catch(async (e) => { await setError(e.message); throw e; }));
        return true;
      case 'VIVI_DISCORD_CALLBACK':
        done(completeLogin(msg.url).then(status).catch(async (e) => { await setError(e.message); throw e; }));
        return true;
      case 'VIVI_DISCORD_LOGOUT':
        done(logout().then(status));
        return true;
      case 'VIVI_DISCORD_SET_ENABLED':
        done((async () => {
          await lset({ [ENABLED_KEY]: !!msg.enabled });
          if (!msg.enabled) await clearPresence();
          return status();
        })());
        return true;
      default:
        return false;
    }
  });

  // Tab that owned the presence went away → don't leave a ghost activity behind.
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const sess = await sget();
    if (sess.tabId != null && sess.tabId === tabId) clearPresence().catch(() => {});
  });

  // Safety nets so a presence can never outlive the player:
  //  • watchdog: if the player tab stops reporting (crash, frozen/discarded tab, extension reload) clear it;
  //  • startup: after a browser restart, delete whatever session the last run left behind.
  // (If the whole browser is killed, nothing can run; Discord drops idle headless sessions on its own
  //  after ~20 min, per community API docs.)
  async function watchdog() {
    const sess = await sget();
    if (!sess.lastSentAt) return;                       // nothing live
    const seen = (await lget(SEEN_KEY)) || 0;
    if (Date.now() - seen > STALE_MS) await clearPresence().catch(() => {});
  }
  chrome.alarms.get(WATCHDOG).then((a) => { if (!a) chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 }); });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === WATCHDOG) watchdog(); });
  chrome.runtime.onStartup.addListener(() => { clearPresence().catch(() => {}); });

  globalThis.__viviDiscord = { buildActivity, itunesArtwork, CFG };
})();

/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 Archimetrix
 * Discord Rich Presence approach (OAuth `sdk.social_layer_presence` + headless sessions)
 * credit: Neurobox by Sheathed (AGPL-3.0) — https://github.com/Sheathed/Neurobox
 * See README.md → "Discord Rich Presence" and THIRD_PARTY_NOTICES.md. */
// Discord Rich Presence controls (popup). Talks to discord-rpc.js in the background worker.
(() => {
  const toggle = document.getElementById('discordEnabledToggle');
  const statusEl = document.getElementById('discordStatus');
  const loginBtn = document.getElementById('discordLoginBtn');
  const logoutBtn = document.getElementById('discordLogoutBtn');
  const cbForm = document.getElementById('discordCallbackForm');
  const cbUrl = document.getElementById('discordCallbackUrl');
  if (!toggle) return;

  const ask = (type, extra) => chrome.runtime.sendMessage({ type, ...extra }).catch((e) => ({ ok: false, error: e.message }));

  function render(s) {
    const connected = !!s?.connected;
    if (cbForm) cbForm.hidden = !(s?.canPaste && !connected);
    const uriEl = document.getElementById('discordRedirectUri');
    if (uriEl && s?.redirectUri) uriEl.textContent = s.redirectUri;
    toggle.checked = !!s?.enabled && connected;
    toggle.disabled = !connected;
    loginBtn.style.display = connected ? 'none' : '';
    logoutBtn.style.display = connected ? '' : 'none';
    if (connected) {
      statusEl.textContent = s.error ? `Connected as ${s.username || 'Discord user'} — last error: ${s.error}`
                                     : `Connected as ${s.username || 'Discord user'}.`;
    } else if (s?.error) {
      statusEl.textContent = `Not connected — ${s.error}`;
    } else {
      statusEl.textContent = 'Not connected.';
    }
  }

  const refresh = async () => render(await ask('VIVI_DISCORD_STATUS'));

  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true; statusEl.textContent = 'Waiting for Discord…';
    render(await ask('VIVI_DISCORD_LOGIN'));
    loginBtn.disabled = false;
  });
  cbForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.textContent = 'Finishing…';
    render(await ask('VIVI_DISCORD_CALLBACK', { url: cbUrl.value.trim() }));
    cbUrl.value = '';
  });
  logoutBtn.addEventListener('click', async () => render(await ask('VIVI_DISCORD_LOGOUT')));
  toggle.addEventListener('change', async () => render(await ask('VIVI_DISCORD_SET_ENABLED', { enabled: toggle.checked })));

  refresh();
})();

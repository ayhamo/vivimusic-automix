<div align="center">

<img src="icons/icon128.png" alt="ViviMusic Xten" width="96" height="96" />

# ViviMusic Xten

**Apple Music–style Canvas artwork, Spotify Canvas, synced lyrics with romanization, a built-in equalizer, crossfade between songs, Discord Rpc, Last.fm scrobbling, Spotify → YouTube Music playlist transfer tool for YouTube Music and many more.**

[![Manifest](https://img.shields.io/badge/Manifest-V3-ff6b6b?style=flat-square)](#)
[![Version](https://img.shields.io/badge/Version-11.5.0-4ecdc4?style=flat-square)](#)
[![Browsers](https://img.shields.io/badge/Chrome%20%7CFirefox%20%7C%20All%20Firefox%20Based%20Browsers%20%7cAll%20Chromium%20Browsers-supported-6c5ce7?style=flat-square)](#)
[![License](https://img.shields.io/badge/License-AGPL_v3-blue?style=flat-square)](LICENSE)
</div>

---

ViviMusic Xten is a browser extension that reskins **[music.youtube.com](https://music.youtube.com)** with animated Canvas-style backgrounds (like Apple Music/Spotify Canvas), word-synced lyrics, an audio equalizer with crossfade between songs, SponsorBlock skipping, Discord Rpc, Last.fm scrobbling, and a dark, glassy theme — without needing a separate desktop app .

This extension is **not published on the Chrome Web Store**. It's distributed as source from this repository and loaded manually as an "unpacked" extension. Follow the installation guide below — it takes about a minute.


**💠This extension require some amount of ram and some graphics for example if you have a littlebit gpu even windows intregated gpu thats also can run this just make sure that graphics acceleration is turn on in your browser.**

---

## Watch the Extension in Action

<div align="center">

<a href="https://youtu.be/d4SHceAjRGk">
  <img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/random-share/vivimusicdemo.gif" alt="ViviMusic Xten demo — click to watch the full video" width="800" />
</a>

**Click the preview above to watch the full video** 

</div>

---
## 📥 Download
<a href="https://github.com/Archimetrix/VIVIMUSIC_XTEN/releases" target="_blank">
    <img src="https://img.shields.io/badge/Download_ZIP-101010?style=for-the-badge&logo=github&logoColor=white" alt="Download ZIP" height="56">
  </a>
<a href="https://addons.mozilla.org/en-US/firefox/addon/vivimusicxten/" target="_blank">
    <img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" alt="Get the Add-on for Firefox" height="56">
  </a>
  
 **Note:** The Chromium build works on Chrome, Brave, Opera, Edge, Vivaldi and other Chromium browsers . Please use the **Download ZIP** button above and follow the quick **Local Installation** guide below.
---

## Screenshots

<div align="center">

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebfiles/spotify%20canvas%20and%20synced%20lyrics%20with%20animation.png" alt="Spotify Canvas &amp; synced lyrics" width="800" />

<sub><b>Spotify Canvas &amp; synced lyrics</b> — Looping Spotify Canvas video behind the player, with word-by-word synced lyrics and animated highlighting.</sub>

<br />

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebfiles/Different%20Fonts%20and%20lyrics%20animations.png" alt="Lyrics fonts &amp; animations" width="800" />

<sub><b>Lyrics fonts &amp; animations</b> — Pick from bundled fonts and switch between highlight styles such as Fill sweep, Glow, Word bounce, Smooth zoom, Apple Music and Fluid flow.</sub>

<br />

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebfiles/vinyl%20disc%20appearance.png" alt="Vinyl disc appearance" width="800" />

<sub><b>Vinyl disc appearance</b> — Show the artwork as a rotating record with a tonearm that parks on pause, plus an optional shine effect.</sub>

<br />

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebfiles/Glassy%20floating%20miniplayer%20-modified%20icons%20instead%20of%20description.png" alt="Glass floating mini player" width="800" />

<sub><b>Glass floating mini player</b> — A floating liquid-glass pill player bar, with icon-only player tabs instead of text labels.</sub>

<br />

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/random-share/fullscreen.gif" alt="Full screen mode" width="800" />

<sub><b>Full screen mode</b> — In fullscreen the album art fills the whole screen height on the left and fades into the synced lyrics on the right, with an auto-hiding player bar. Always on.</sub>

<br />

<img src="https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/vivimusicwebfiles/Spotify%20to%20YTmusic%20playlists%20transfer.png" alt="Spotify → YouTube Music transfer" width="800" />

<sub><b>Spotify → YouTube Music transfer</b> — Move liked songs and playlists from Spotify to YouTube Music in a few clicks from a dedicated transfer window.</sub>

<br />

</div>

---

## Table of Contents

- [Watch the Extension in Action](#watch-the-extension-in-action)
- [Screenshots](#screenshots)
- [Features](#features)
- [Installation Guide](#installation-guide)
  - [Chrome / Brave / Vivaldi / Opera](#chrome--edge--brave--vivaldi--opera)
  - [Firefox](#firefox)
- [Updating](#updating)
  - [Smoother Updates Process (Beta)](#smoother-updates-process-beta)
  - [Manual update](#manual-update)
- [Settings](#settings)
- [Spotify Canvas Login](#spotify-canvas-login)
- [Spotify → YouTube Music Playlist Transfer](#spotify--youtube-music-playlist-transfer)
- [Discord Rich Presence](#discord-rich-presence)
- [Last.fm Scrobbling](#lastfm-scrobbling)
- [SponsorBlock](#sponsorblock)
- [Star Verification](#star-verification)
- [Permissions & Privacy](#permissions--privacy)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)
- [License](#license)

---

## Features

- 🎨 **Canvas Artwork** — Fetches animated, Apple Music–style Canvas videos (or high-res artwork as a fallback) for the currently playing song and blends it into the player thumbnail and page background. If a track has both Apple Music artwork and a Spotify Canvas, you choose which one is preferred.
- 🖼️ **Spotify Canvas** — Spotify Canvas support for YT Music songs. Connect with a one-click Spotify login or by supplying your `sp_dc` cookie locally.
- 🔄 **Spotify → YouTube Music Playlist Transfer** — Transfer your Spotify playlists and Liked Songs directly from the browser into YouTube Music without sending your library to a ViviMusic Xten server. The transfer page shows which Spotify account and which YouTube Music account are connected, lets you search and multi-select, shows live per-playlist progress with a **Stop** button, and finishes with a results summary (links to the new playlists and a list of tracks that were not found). See [the transfer guide](#spotify--youtube-music-playlist-transfer).
- 🎨 **THEME** — A full dark, glassy visual reskin of YouTube Music, toggleable independently of Canvas and Lyrics.
- 🌊 **Kawarp Background Engine** — The animated Canvas background is fully tunable from the popup: opacity, warp intensity, blur passes, saturation, brightness, dithering, animation speed, and transition duration all have live sliders, plus a "pause when inactive" toggle and a one-click **Reset to defaults** button. There's also an "artwork/image-only" mode if you'd rather skip the warped background animation entirely and just show static art.
- 💿 **Vinyl Disc Artwork** — Show the player artwork as a rotating record. The tonearm parks when playback pauses and returns when it resumes. (Turning this on switches off Apple Music artwork and Spotify Canvas.)
- 🖥️ **Full Screen Mode** — A reCover-style fullscreen player: the album art fills the whole screen height on the left and fades into the synced lyrics on the right, with no tabs or side lists in the way. Videos play as a normal full-screen landscape video. The player bar keeps the theme's glass blur and can auto-hide, returning when you move the mouse to the bottom of the screen. It is always on and cannot be turned off. Nothing outside fullscreen is changed.
- 🏷️ **Icons-only Player Tabs** — Replace the Up next / Lyrics / Comments / Related labels with icons; the active tab glows.
- 🎶 **Crossfade (Beta)** — Blend the end of one song into the start of the next instead of a hard cut. Choose a length from 1 to 12 seconds in the **Audio playback** card. It is off by default, uses smooth equal-power fades, and is automatically skipped for ads, repeat-one and very short tracks.
- 🎚️ **Built-in Equalizer** — A toggleable 3-band equalizer (low / mid / high) with a room-reverb send and one-click presets (Bass Boost, Clear Vocals, Empty Room), available from the full player screen.
- 🎤 **Synced Lyrics** — Syllable-synced lyrics when available, then word-synced, then line-synced, then plain lyrics. Pulled from multiple providers so you almost always get *something*.
- 🔀 **Multiple Lyrics Providers** — Toggle individual sources on or off:
  - lrc.red
  - Better Lyrics (one toggle; tries syllable/word-sync sources first — TTML and QQ Music "Portato" — then falls back to Kugou "Legato" and "Legacy" line-sync)
  - Better Lyrics Unison
  - BiniLyrics
  - Musixmatch
  - LRCLIB
  - Spotify (needs a connected Spotify account)
- 🔠 **Lyrics Romanization** — Show lyrics in Latin letters, written the way they sound (not translated), either instead of the original or as a small line under each original line. Korean, Japanese kana, Chinese (pinyin), Hindi, Punjabi and Georgian are converted on-device. Other scripts (for example Japanese kanji, Arabic, Cyrillic, Greek, Thai and several Indic scripts) are looked up through Google Translate only if you tick them, and only the lyric text is sent. You choose which languages are romanized.
- ✨ **Lyrics Alignment & Highlight Animations** — Align lyrics left, center or right, and pick the current-word animation: Fill sweep, Glow up, Word bounce, Smooth zoom, Apple Music style, or Fluid flow (modelled on the Better Lyrics engine: lines glide up together with a soft ease, and the current word lights up letter by letter).
- 💃 **REZE Dance** — An animated dancer plays when no lyrics can be found for a track, toggleable in the popup.
- ⏭️ **SponsorBlock** — Automatically skips non-music segments (spoken intros, skits, outros) of music videos using community data from [SponsorBlock](https://sponsor.ajay.app/), and keeps the lyrics timeline in sync after each skip. See [SponsorBlock](#sponsorblock) for how it works and the required attribution.
- 💬 **Discord Rich Presence (Beta)** — Show what you're playing on your Discord profile ("Listening to VIVIMUSIC-XTEN") with song, artist, album cover and a live progress bar — straight from the browser, with **no Discord desktop app, local helper or extra software**. Chromium and Firefox. See [Discord Rich Presence](#discord-rich-presence).
- 🎧 **Last.fm Scrobbling** — Sign in through Last.fm's browser authorization page (or with username and password), scrobble what you listen to, send Now Playing status, and sync Likes/Unlikes as Loves/Unloves.
- 💾 **Local Artwork Cache** — Previously fetched artwork/Canvas links are cached locally so repeat plays load instantly. View, search, preview, export, import and clear them from the popup.
- ⌨️ **Cache Overlay Shortcut** — Press **Alt+C** on the YouTube Music tab to see the artwork cache and the current track's live cache status without opening the popup.
- 🔋 **Optimized & Resource Saving Mode** — One switch on the popup's home screen that pauses the heaviest effects and background work: the fluid background and Apple Music artwork lookups, the equalizer and crossfade, SponsorBlock and the no-lyrics dancer, Last.fm scrobbling, and artwork fetching/caching. Your settings are kept and apply again when you switch it off.
- 🔔 **Update Checker & Smoother Updates Process (Beta)** — Since this isn't on the Web Store, the popup checks this GitHub repo's [Releases](../../releases) page and tells you when a newer version is out. With **Smoother Updates Process** (on by default) you can then install it with one click: no ZIP, no extracting, no re-loading by hand. See [Updating](#updating).


---

## Installation Guide

> Because this extension isn't listed on Chrome webstore , your browser will warn you that it's an "unpacked" / "developer mode" extension. That's expected and normal — it just means you installed it from source instead of a store.

### Chrome / Edge / Brave / Vivaldi / Opera /Other all Chromium Browsers

1. **Download The Zipfile From Releases**
2. **Extract it** to a folder you won't move or delete later (e.g. `Documents/ViviMusic Xten`). Chrome loads the extension directly from this folder, so if you delete it, the extension breaks.
3. Open your browser and go to:
   ```
   chrome://extensions
   ```
   (For Edge: `edge://extensions` · For Brave: `brave://extensions` · For Vivaldi: `vivaldi://extensions` · For Opera: `opera://extensions`)
4. Turn on **Developer mode** — the toggle is in the top-right corner of the extensions page.
5. Click **Load unpacked**.
6. Select the folder you extracted and open the folder you will see icon and src folder when you see these two folders dont click on them just click open to select (the one that directly contains `manifest.json`).
7. ViviMusic Xten should now appear in your extensions list and in your toolbar. Open **[music.youtube.com](https://music.youtube.com)**, play a song, and you should see the new theme and Canvas artwork kick in within a second or two.

**Click On the image below for extension installation guide video :-**
[![Extension Installation Guide](https://i.postimg.cc/tC00y0XF/Screenshot-2026-09-13-195414.png)](https://youtu.be/HIBwMWksrTg)

### Firefox

Firefox addon is currently available in official firefox addon store install the extension directly from there .

---

## Updating

The popup checks this repository's [Releases](../../releases) automatically (twice a day), or on demand via **Check for updates**. When a newer version exists you'll see an **Update available** notice with an **Update now** button.

### Smoother Updates Process (Beta)

> **Beta.** From version (11.4.0+) This one-click updater is new. If anything goes wrong your previous files are restored automatically, and the manual method below always still works.

Because the extension is loaded "unpacked", Chrome can't update it by itself. **Smoother Updates Process** (Popup → Updates panel, **on by default**) fills that gap: it replaces the extension's own files inside the folder you loaded it from, then reloads the extension.

**First update only (about 30 seconds):**

1. Click **Update now**. A setup tab opens.
2. Open `chrome://extensions` → ViviMusic Xten → **Details** and note the folder path.
3. Click **Choose folder & update**, pick that exact folder (the one containing `manifest.json`), and click **Allow / Edit files** when your browser asks.

ViviMusic checks that it really is the folder your browser loaded; if you pick the wrong one it tells you and nothing is changed.

**Every update after that:** click **Update now** in the popup. You'll see a progress bar with the current step (Check folder → Download → Verify → Unpack → Install), then the extension reloads on the new version. Refresh your YouTube Music tab afterwards.

**What to expect:**

- **Your settings are kept.** They live in your browser profile's extension storage, not in the extension folder, so replacing the files never touches them.
- **Re-allow after a restart.** Browsers sometimes pause folder access after a restart. If so, the next update shows an **Allow access & update** button, one extra click. If your browser offers **Allow on every visit**, choose it.
- **Safe by design.** The update is downloaded from this project's GitHub release, checked against its SHA-256 checksum when the release publishes one, confirmed to be this same extension and a newer version, fully unpacked in memory, and only then written to disk with `manifest.json` last. If any step fails, the files are rolled back to the previous version.
- **Only your extension folder is touched.** ViviMusic can only write inside the one folder you chose. You can disconnect it any time from the setup tab (Popup → Updates → **Manage**).
- **Wrong or moved folder?** If you move or rename the extension folder, reload it once via **Load unpacked** and run the setup again.

**Browser support:** Chrome, Edge, Opera, Vivaldi and other Chromium browsers work out of the box. **Brave** ships with the needed feature switched off: open `brave://flags/#file-system-access-api`, set it to **Enabled**, relaunch Brave, then try again. Firefox isn't affected (it uses the Add-ons store), and Safari isn't supported. On a browser where the feature isn't available, the popup automatically falls back to the manual method.

### Manual update

If you'd rather not use the one-click updater, switch **Smoother Updates Process** off in the Updates panel (or use this if your browser doesn't support it):

1. Click **Download update** in the popup (or grab the latest ZIP from the [Releases page](../../releases)).
2. Extract it over your existing folder, or to a new one.
3. Open `chrome://extensions` and click **Load unpacked** (or the reload icon if you replaced the files in place).

No need to remove and re-add the extension; your settings are kept.

---

## Settings

All settings live in the extension popup (click the ViviMusic Xten icon in your toolbar):

| Setting | What it does |
|---|---|
| **Apple Music Animated Artwork** | Turns the animated artwork/background feature on or off. |
| **Image-only mode** | Shows static artwork instead of the animated looping Canvas video (less data and CPU). |
| **Fluid Background (Kawarp)** | Enables the animated warp effect, with an expandable panel of fine-tuning sliders: opacity, warp intensity, blur passes, saturation, brightness, dithering, animation speed, transition duration, plus a "pause when inactive" toggle and a **Reset to defaults** button. |
| **Audio playback → Equalizer** | Shows or hides the floating equalizer button on the full player screen. |
| **Audio playback → Crossfade (Beta)** | Turns the blend between songs on or off (off by default). A **Crossfade length** slider sets it from 1 to 12 seconds. It needs a little normal playback before the end of a song to prepare, so if you drag the seek bar, avoid landing within the last minute of a song. |
| **Synced Lyrics** | Turns the custom lyrics panel on or off. |
| **Auto-open Lyrics tab** | Automatically switches to the Lyrics tab when a new track starts. |
| **Romanization** | Off, Romanized only, or Original + romanized. |
| **Languages to romanize** | Choose which scripts are romanized (all, none, or individual languages). |
| **Lyrics alignment** | Left, Center or Right. |
| **Highlight animation** | Fill sweep, Glow up, Word bounce, Smooth zoom or Apple Music. |
| **Lyrics font** | Changes the font of the lyrics lines only. Lyrics in scripts a font doesn't cover (Hindi, Bengali, Korean…) fall back to the default font. |
| **Show lyrics for video songs** | Shows the synced lyrics panel for tracks played as music videos, not just audio. |
| **Show dancer when no lyrics found** | Plays the animated dancer when no lyrics can be found for a track. |
| **Skip non-music sections (SponsorBlock)** | Automatically skips non-music segments using SponsorBlock data. |
| **Lyrics providers** | Toggle individual lyrics sources on/off. |
| **Customize provider priority** | Enables custom priority ordering (1st / 2nd / 3rd), with a "wait for priority source" toggle. |
| **Theme** | Toggles the full visual reskin independently of Canvas/Lyrics. |
| **Vinyl disc artwork** | Shows the player artwork as a rotating record with a tonearm. Turns off Apple Music artwork and Spotify Canvas while on. |
| **Player tabs: icons only** | Replaces the Up next, Lyrics, Comments and Related labels with icons. |
| **Floating pill player bar** | Turns the bottom player bar into a floating liquid-glass pill. |
| **Full screen mode** | Always on and locked (the switch is greyed out). Reskins YouTube Music's fullscreen player: album art on the left fading into lyrics on the right. Does not change anything outside fullscreen. |
| **Auto-hide player bar in fullscreen** | Fades the player bar away in fullscreen and brings it back when you move the mouse to the bottom of the screen. On by default. |
| **Language localization** | On by default. Lets lyrics and the player tabs work when YouTube Music is not in English. |
| **Spotify Canvas** | Enables Spotify Canvas videos for YT Music tracks; connect via login or `sp_dc` cookie. |
| **When both are available, prefer** | Chooses Apple Music artwork or Spotify Canvas when a track has both. |
| **Playlist transfer** | Opens the client-side Spotify → YouTube Music transfer tool (Beta). Select playlists and/or Liked Songs and transfer them into private YouTube Music playlists. |
| **Discord (Beta) → Show what I'm listening to** | Turns Discord Rich Presence on or off. Connect once with **Connect Discord**; **Disconnect** also revokes access at Discord. |
| **Last.fm scrobbling** | Turns Last.fm integration on or off entirely. |
| **Send Now Playing** | Sends a "Now Playing" update to Last.fm as soon as a track starts. |
| **Send Likes/Unlikes** | Mirrors the YouTube Music like button to Last.fm Love/Unlove. |
| **Min. song length (sec)** | Tracks shorter than this are never scrobbled. |
| **Scrobble delay (%)** | Scrobble once this percentage of the track has played. |
| **Scrobble delay (min)** | Or once this many minutes have played — whichever threshold is reached first. |
| **Artwork Cache** | Shows how many songs are cached locally, with search, preview, **Export**, **Import** and a one-click **Clear all**. |
| **Check for updates** | Manually checks this repo's latest release against your installed version. |
| **Smoother Updates Process (Beta)** | One-click, in-place updates (on by default). Shows whether your extension folder is connected, with **Set up / Re-allow / Manage** to connect, re-allow or disconnect it. Turn it off to use the manual download flow. |
| **Optimized & resource saving mode** | Pauses heavy effects and background activity (see the feature description above). Settings are kept. |
| **Updates (refresh icon)** | Opens the Updates panel. A red 1 appears on it when a newer release exists. |
| **Notification bell** | Opens developer announcements. |
| **Report an issue (warning icon)** | Opens a new GitHub issue for this project. |

---

## Spotify Canvas Login

To get Spotify Canvas videos on YouTube Music tracks, connect a Spotify account from the popup in one of two ways:

1. **Connect Spotify** — click the button and log in normally.
2. **Paste `sp_dc` cookie** — if the one-click login doesn't work for your browser (this is common on **Brave**, due to its cookie/shield handling), paste your Spotify `sp_dc` cookie value into the field and click **Save sp_dc locally**. It's stored locally in your browser only.



Once connected, you'll see your connected account shown in the popup with a **Disconnect Spotify** option to revoke access at any time.


---

## Spotify → YouTube Music Playlist Transfer

ViviMusic Xten can transfer Spotify playlists and your Liked Songs into YouTube Music directly from your browser. The transfer runs client-side: playlist metadata and track information are processed by the extension in your browser, and the extension talks directly to Spotify and YouTube Music using the sessions you already have open.

### What it supports

- Pick one or many Spotify playlists, or your **Liked Songs**, with a search box and **Select all / Clear** buttons. The action bar shows how many playlists and tracks you have selected.
- Shows the **Spotify account** (name and profile picture) and the **YouTube Music account** (name, handle and picture) that will be used.
- Search YouTube Music for each Spotify track using title and artist information.
- Create a matching **private** YouTube Music playlist for each selection and add the matched videos in the same order as the Spotify playlist. Liked Songs are created as a playlist named "Liked Songs".
- A live progress view with an overall progress bar, matched / not-found counters, elapsed time, a status for each playlist, and an activity log.
- A **Stop** button that ends the transfer after the current track. A playlist that was stopped before it was created is not created.
- A results screen with a summary for each playlist, an **Open in YouTube Music** link for each new playlist, and an expandable list of tracks that could not be matched.
- If one playlist fails, the remaining playlists continue. Playlists where nothing matched are skipped instead of creating an empty playlist.

### Account safety

The YouTube Music account is read from YouTube Music itself and re-checked whenever you return to the transfer page. If you switch accounts in YouTube Music, the page updates and shows a notice. The account is checked again when you press **Transfer** and before each playlist is created; if it changed mid-transfer, the transfer stops so nothing is added to the wrong account.

### What it does not require

This feature does **not** require a Spotify Developer account, Spotify Client ID/secret, Google Cloud project, OAuth app registration, ViviMusic Xten server, Render deployment, database, or separate transfer application. It uses the user's existing logged-in browser sessions.

### Authentication model

**Spotify:** Open Spotify and sign in normally. ViviMusic Xten reads the existing Spotify Web Player `sp_dc` session cookie and uses Spotify's own Web Player session flow to obtain the session needed to read playlists. The extension never asks for or stores your Spotify password.

**YouTube Music:** Open [music.youtube.com](https://music.youtube.com) and sign in normally. The transfer uses the logged-in YouTube Music page and its own browser session/configuration to search, create, and update playlists. The extension never asks for or stores your Google password.

### Important implementation note

The transfer feature uses internal web interfaces exposed by Spotify and YouTube Music rather than their public developer APIs. This is why no developer application credentials are required, but those internal interfaces are not stable public APIs and can change without notice. A future Spotify or Google web-client change may require an extension update.

### Privacy model

There is no ViviMusic Xten transfer server in the data path:

```text
Spotify session
      ↓
ViviMusic Xten extension (your browser)
      ↓
YouTube Music session
      ↓
Private YouTube Music playlists
```

The extension does not upload your Spotify library to a ViviMusic Xten backend. Spotify and YouTube Music still receive the requests required for the transfer because they are the services being read from and written to.

### Transfer safety

Keep the transfer page open until the operation finishes. Do not close the YouTube Music tab, switch apps, or intentionally interrupt the browser while matching and playlist updates are running. The current implementation uses a page bridge inside the logged-in YouTube Music tab, so keeping that environment intact reduces the chance of an interrupted transfer. The browser will warn you if you try to close the transfer page while a transfer is running.

---

## Discord Rich Presence

> 🧪 **Beta.** This feature relies on a Discord endpoint that is not part of Discord's public API (see [Limitations](#limitations-and-honesty-notes)), so it may change or break without notice. Feedback and bug reports are welcome.

ViviMusic Xten can show your current song on your Discord profile as **"Listening to VIVIMUSIC-XTEN"**, with the title, artist, album cover, a progress bar, the ViviMusic Xten logo as a small badge on the cover, and two buttons: **Listen on YouTube Music** and **Get VIVIMUSIC-XTEN** (this repository). Discord never shows you your own buttons, only other people see them; the logo and cover appear on your own profile too. It works from the browser alone: **no Discord desktop client, no local bridge, no native helper.** It doesn't depend on the Discord app running on that computer.

> **Browser support:** Chromium browsers (Chrome, Brave, Edge, Vivaldi, Opera…) and Firefox 128+ (the Firefox build uses the add-on ID `vivimusic-web@archimetrix.app`).

### Using it

0. Make sure you are **signed in to Discord in the same browser** (<https://discord.com/login>); the authorization page uses that session.
1. Open the popup → **Discord** → **Connect Discord**.
2. Approve the Discord authorization page.
3. Switch on **Show what I'm listening to** and play a song on [music.youtube.com](https://music.youtube.com).

*Firefox only:* Firefox occasionally fails to hand Discord's login result back to the extension. If that happens, the popup shows a box: copy the full address from the Discord window (it starts with `https://` and contains `.extensions.allizom.org/discord?code=`), paste it there and press **Finish connecting**. The pasted address is only used once, to finish your own login.

Presence updates on track change, pause/resume and seeking, and is cleared when you close the tab, stop playing for 5 minutes, or turn the feature off. Ads are never shown as songs.

### About the permission screen

Discord's consent screen looks long (friends list, game invites, profile…). That is not ViviMusic asking for more. Discord's only open way for a third-party app to set a user's activity is the scope **`sdk.social_layer_presence`**, which Discord's Social SDK defines as one bundle: account linking, friends list, rich presence. The narrower presence scopes (`activities.write`, `rpc.activities.write`) are restricted by Discord to approved partners.

What ViviMusic Xten actually does with it:

- reads your Discord username (to show "Connected as …" in the popup);
- sends your *Listening* activity to Discord;
- nothing else. It does not read your friends, servers, messages or invites, and the code contains no calls that do (see `src/discord-rpc.js`).

Your Discord login token is stored **only in your browser's extension storage** and sent only to `discord.com`. **Disconnect** revokes the token at Discord. You can also remove ViviMusic any time in Discord → **Settings → Authorized Apps**.

### How it works

```text
music.youtube.com tab  ──►  discord-presence.js (content script: reads player, sends changes)
                                   │  runtime message
                                   ▼
                      discord-rpc.js (background service worker)
                       • OAuth2 + PKCE via chrome.identity (Public Client, no secret)
                       • cover art: iTunes lookup → YouTube thumbnail fallback
                       • POST discord.com/api/v10/users/@me/headless-sessions
                                   ▼
                              Discord profile
```

It uses the same OAuth scope and "headless session" endpoint that Discord's own Social SDK uses to publish presence without a running client. Nothing is spoofed, and it never touches your Discord account token. It uses a scoped OAuth authorization that you grant and can revoke.

### Limitations and honesty notes

**Disclaimer.** ViviMusic Xten is an independent project, not affiliated with or endorsed by Discord. The feature uses Discord's normal OAuth sign-in (it never sees your Discord password or account token and can only set your Listening status), but it depends on an interface that is not part of Discord's public API. Discord may change or block it at any time, and no guarantee can be given that using it has no effect on your account. Use it at your own discretion.

- **Clean-up behaviour.** The activity is removed when you pause for 3 minutes, 10 seconds after a song ends with nothing queued, when you close the music tab, or if the tab stops reporting for ~2.5 minutes (a watchdog), and any leftover session is deleted at the next browser start. If the browser is killed outright, nothing can run; Discord then drops the idle session by itself. Community API documentation says headless sessions expire about 20 minutes after their last update, so the activity can linger up to that long (it also shows on your phone, because activity belongs to your account, not to one device).
- The `headless-sessions` endpoint is **not part of Discord's public, documented REST API**. Discord can change or restrict it, or lock the scope, at any time, which would break this feature without any change to ViviMusic.
- Discord's activity "name" is set by the extension (`VIVIMUSIC-XTEN`), and Discord decides how it prioritises overlapping activities (for example, a game outranks a listening status on your card, but stays visible on your full profile).
- Cover art comes from an iTunes search (only used when artist, title and album match closely) with the YouTube Music thumbnail as fallback; Discord shows an image only if it accepts the URL.



### Credit

The idea of using `sdk.social_layer_presence` and a headless session to publish Rich Presence from a browser extension comes from **[Neurobox](https://github.com/Sheathed/Neurobox)** by **Sheathed** (AGPL-3.0), which proved the approach works. ViviMusic Xten's implementation is written for this project (MV3 service-worker-safe state, YouTube Music player tracking, artwork resolution, popup UI), but it follows Neurobox's approach and activity format, which is also why this project is licensed under the same AGPL-3.0. Thanks also to Discord for documenting the Social SDK scopes.

---

## Last.fm Scrobbling

ViviMusic Xten can scrobble what you listen to on YouTube Music straight to your Last.fm profile.

**Logging in** — two options:
1. Open the popup and switch on **Last.fm scrobbling**.
2. **Sign in with Last.fm:** a Last.fm tab opens, you approve access there, and the popup shows you as connected. Your password is never entered in the extension.
3. **Or use username & password instead:** enter your Last.fm **username** and **password** and click **Connect Last.fm account**. Your password is sent once, directly to Last.fm's own API, and is never stored.
4. In both cases only the session token Last.fm returns is saved locally, and it can be revoked any time from your Last.fm account's **Applications** settings.

**How scrobble timing works:**
A track is scrobbled once it has played past *whichever comes first*:
- the configured **percentage** of its total duration, or
- the configured **number of minutes**,

as long as the track is longer than the configured **minimum song length**. These three thresholds are all adjustable in the popup.

**Likes/Unlikes:**
When enabled, liking or unliking a song in YouTube Music sends a matching Love/Unlove to Last.fm.

---

## SponsorBlock

ViviMusic Xten can skip the **non-music** parts of music videos — spoken intros, skits and outros — using community-submitted segments from [SponsorBlock](https://sponsor.ajay.app/).

**How it works**

- When a track starts, the extension asks SponsorBlock's API for segments in the **Non-Music** (`music_offtopic`) category with the **Skip** action only.
- Lookups use SponsorBlock's privacy-preserving hash-prefix endpoint: only the first 4 characters of the SHA-256 hash of the video ID are sent, and the exact video is matched locally in your browser.
- Each segment is skipped once per track. Segments longer than 2 minutes are ignored as probably mislabeled, and the synced-lyrics timeline is shifted so lyrics stay aligned after a skip.
- Results (including "no segments found") are cached locally for 6 hours, for up to 500 videos.
- It is controlled by **Skip non-music sections (SponsorBlock)** in the popup. When it is off, no SponsorBlock requests are made.
- ViviMusic Xten is **read-only** here: it does not submit or vote on segments. To contribute segments, use the official [SponsorBlock extension](https://sponsor.ajay.app/).

**Attribution and licensing**

> This product uses data from **SponsorBlock** (<https://sponsor.ajay.app/>), created by **Ajay Ramachandran** and contributors, used under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International license](https://creativecommons.org/licenses/by-nc-sa/4.0/).

- SponsorBlock's API and database are licensed CC BY-NC-SA 4.0 unless its author gives explicit permission.
- The SponsorBlock browser extension is licensed under GPL-3.0. **No code from the SponsorBlock extension is used in ViviMusic Xten.** The small API client in `src/sponsorblock.js` is original code that only calls the public API, so ViviMusic Xten's own license is unaffected.
- SponsorBlock data is fetched live and cached locally for each user. It is not bundled with or redistributed in this package.
- Because the data is licensed for non-commercial use, anyone who redistributes or forks this extension commercially should check SponsorBlock's license terms, or contact its author, before keeping this feature.

---

## Star Verification

ViviMusic Xten asks you to star this repository on GitHub once before it unlocks. This is what the check does, so there are no surprises:

- When you press the verify button, the extension uses **GitHub's OAuth Device Flow**: it shows you a short code, and you approve it on `github.com`. The extension never sees your GitHub password.
- The resulting GitHub token is used for one thing only: asking GitHub whether your account has starred `Archimetrix/VIVIMUSIC_XTEN`. It does not read your repositories, and it does not star or change anything on your behalf.
- The token and the result are stored **locally in your browser** (extension storage). They are sent only to GitHub, never to a ViviMusic Xten server.
- **Not forced.** The verification screen has a **Show it later** button. It hides the screen for that browser tab only; opening a new tab shows it again until you verify. New installs also get a 10-minute head start before it first appears.
- **Verify once, unlocked for good.** After a successful check there are no re-checks, even if you un-star later.
- **Already verified? You won't be asked again.** Updates never show it, and a small "verified" flag is kept in browser-synced extension storage so removing and re-adding the extension on a profile with extension sync turned on doesn't ask again either. (Without profile sync, removing the extension erases it and you would need to verify once more.)


---

## Permissions & Privacy

ViviMusic Xten's content scripts only run on `music.youtube.com`. Everything else listed below is contacted by the extension's background service worker (or, for lyrics, the page script) only for the feature that needs it.

| Permission | Why it's needed |
|---|---|
| `storage`, `unlimitedStorage` | Saves your settings and caches artwork and SponsorBlock results locally, in your browser only. |
| `activeTab`, `tabs` | Detects the current track and communicates between the popup, the transfer page and the YouTube Music tab. |
| `alarms` | Schedules the twice-daily update check and the short polling used while you sign in to Last.fm through its browser page. |
| `cookies` | Used only for Spotify login (reading/managing the `sp_dc` session cookie needed for Spotify Canvas, Spotify lyrics and the playlist transfer). |
| `declarativeNetRequestWithHostAccess` | Adds the request headers (such as `Origin`/`Referer`) that Apple Music's and Spotify's web players require for the artwork, Canvas and playlist requests the extension makes on your behalf. |
| `scripting` | Runs the YouTube Music page bridge used by the playlist transfer inside your logged-in YouTube Music tab. |
| `identity` | Opens Discord's authorization page for Discord Rich Presence (`chrome.identity.launchWebAuthFlow`). Only used when you press **Connect Discord**. |

| Host access | Why it's needed |
|---|---|
| `music.youtube.com` | Where the extension actually runs and injects its UI. |
| `api.betterlyrics.org`, `lyrics-api.boidu.dev`, `unison.betterlyrics.org`, `unison.boidu.dev`, `lrclib.net`, `lrc.red` (and `*.lrc.red`), `apic-desktop.musixmatch.com`, `apic-appmobile.musixmatch.com`, `apic.musixmatch.com`, `www.musixmatch.com` | Lyrics providers. Also contacted for lyrics: `lyrics-api.binimum.org` (BiniLyrics). |
| `*.apple.com`, `*.itunes.apple.com`, `*.mzstatic.com`, `*.cdn-apple.com`, `*.aaplimg.com`, `api.deezer.com` | Apple Music animated/static artwork, and ISRC lookups (Apple, with Deezer as a fallback) used to find lyrics by ISRC. |
| `open.spotify.com`, `api.spotify.com`, `api-partner.spotify.com`, `spclient.wg.spotify.com`, `apresolve.spotify.com`, `clienttoken.spotify.com`, `canvaz.scdn.co` | Spotify's own endpoints, used for Spotify Canvas, Spotify lyrics and the Spotify → YouTube Music playlist transfer, all through your logged-in Web Player session. |
| `code.thetadev.de` | Community-maintained Spotify web-player secrets ([ThetaDev/spotify-secrets](https://code.thetadev.de/ThetaDev/spotify-secrets)) needed to obtain a Spotify web-player session. |
| `sponsor.ajay.app` | SponsorBlock's API — used only if SponsorBlock is enabled, to fetch skip segments for the currently playing video. |
| `translate.googleapis.com` | Optional romanization lookups for scripts that can't be converted on-device. Used only for languages you tick, and only the lyric text is sent. |
| `api.github.com`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `raw.githubusercontent.com`, `avatars.githubusercontent.com` | Update check (read-only release lookup), downloading the release ZIP when you press **Update now** (including the redirect hosts GitHub serves release files from), developer announcements (a read-only JSON file in this project's repository), and [star verification](#star-verification) (GitHub's device flow, your token, and your avatar on the verification screen). |
| `discord.com` (`/api/*`, `/oauth2/*`) | Discord Rich Presence: sign-in, and sending your current song as your activity. Used only if you connect Discord. Your Discord token stays in your browser. |
| `ws.audioscrobbler.com` | Last.fm's API — used only if you enable and log in to Last.fm scrobbling. Sends the current artist/track (and your login once, to establish a session) directly to Last.fm. |

**Folder access (Smoother Updates Process):** if you use it, your browser's folder-access feature lets the extension write to the single folder you picked, and only after you approve the browser's prompt. The folder handle is stored locally in the extension's own browser storage; you can disconnect it at any time. It is not a manifest permission and nothing outside that folder is accessible.

Nothing is sent to a ViviMusic Xten-owned server. The extension communicates directly with the external services needed by the enabled features: Spotify, YouTube Music, Apple Music and Deezer, the lyrics providers, GitHub (updates, announcements and star verification), SponsorBlock if enabled, Google Translate if you enable romanization lookups, and Last.fm if you opt in to scrobbling. For the Spotify → YouTube Music transfer, Spotify playlist data is read locally by the extension and YouTube Music receives the search/playlist-update requests needed to perform the transfer. No analytics and no tracking.

---

## Troubleshooting

**Nothing changed after installing.**
Make sure you're on `music.youtube.com` (not `youtube.com/music` or the mobile site), and refresh the tab after loading the extension for the first time.

**"Manifest file is missing or unreadable" when loading unpacked.**
You selected the wrong folder — make sure you pick the folder that directly contains `manifest.json`, not its parent folder or the `src` subfolder.

**Extension disappeared / shows an error icon after a browser restart.**
The folder you extracted the extension to was moved, renamed, or deleted. Re-extract it somewhere permanent and reload it via `chrome://extensions`.

**Update now says "showDirectoryPicker is not defined" / "Not available in this browser setting".**
Your browser has the File System Access API switched off. In Brave, open `brave://flags/#file-system-access-api`, set it to **Enabled** and relaunch. Otherwise use the [manual update](#manual-update).

**"That isn't the folder Chrome loaded ViviMusic from."**
Pick the folder shown under `chrome://extensions` → ViviMusic Xten → **Details**, the one that directly contains `manifest.json` (not its parent or the `src` subfolder).

**Update asks to "Allow access" again.**
Normal after a browser restart. Click it once; choose **Allow on every visit** if your browser offers it.

**An update failed.**
The message says why (download, checksum, or write error). Your previous version is restored automatically. Try again, or use the [manual update](#manual-update).

**Spotify → YouTube Music says Spotify is not connected.**
Open Spotify and make sure you are fully signed in. Then return to the transfer page and click **Refresh**. Vivimusic uses the existing Spotify Web Player session rather than a separate Spotify developer login.

**Spotify playlists appear, but a transfer stops or the YouTube Music bridge times out.**
Keep the transfer page open and make sure a YouTube Music tab is also open and signed in. Do not close the YT Music tab or interrupt the browser while the transfer is running. Reload `music.youtube.com` and retry if the page was left idle for a long time.

**A Spotify playlist cannot be transferred because some songs are missing.**
The matcher searches YouTube Music and selects the best candidate from the returned results. Ambiguous, region-specific, live, remix, cover, or otherwise unavailable tracks may not match correctly. The transfer continues with the remaining tracks and reports the final results.

**Lyrics aren't showing for a song.**
Not every song has synced lyrics available from any provider. Try toggling different providers on/off in the popup — coverage varies per source.

**Last.fm login fails.**
Double-check your username and password (not your email, unless that's what you normally log in with). If it still fails, your Last.fm account may have two-factor or app-specific restrictions — try generating the connection again after a few minutes.

**Scrobbles aren't showing up on Last.fm.**
Check that **Last.fm scrobbling** is switched on and you're shown as connected in the popup. Remember scrobbles only send after your configured percentage/minutes threshold is reached, not the instant a song starts (that's what "Now Playing" is for).

**The GitHub star screen keeps appearing.**
Make sure you finished approving the code on `github.com` and that you starred `Archimetrix/VIVIMUSIC_XTEN` with the same GitHub account, then press the check again. You can use **Show it later** to keep listening for that browser tab in the meantime. Once verification succeeds it stays unlocked.

**Crossfade isn't blending songs.**
Check that **Crossfade** is switched on in **Audio playback** and click once anywhere on the YouTube Music page after enabling it (browsers only start audio processing after a click or key press). The first song after switching it on or reloading the tab plays normally; blending starts from the next one. It is skipped for ads, repeat-one, very short tracks, and when you seek to within the last minute of a song.

**SponsorBlock isn't skipping anything.**
Skipping only happens for music videos that SponsorBlock contributors have marked with Non-Music segments, so most tracks will have none. Make sure **Skip non-music sections (SponsorBlock)** is on in the popup.

**Something looks visually broken after a YouTube Music redesign.**
YouTube Music's own layout changes occasionally, which can break selectors this extension relies on. Open an issue on this repository with a screenshot and the URL/page you were on.

---

## Credits

**Project**

- Built and maintained by **Archimetrix**
- Theme design foundation: the **"Dynamic Background"** theme by **chengggit**
- Full Screen Immersive mode : **Recover Theme** by **Mukeenanyafiq**

**Data and services**

- **[SponsorBlock](https://sponsor.ajay.app/)** — non-music segment data by **Ajay Ramachandran** and contributors, used under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See [SponsorBlock](#sponsorblock).
- **Lyrics** — **[Better Lyrics](https://github.com/better-lyrics)** (BetterLyrics, Unison, Portato, Legato, Legacy), **[LRCLIB](https://lrclib.net)**, **[lrc.red](https://lrc.red)**, **BiniLyrics**, **Musixmatch**, and **Spotify**
- **Artwork and track lookup** — **Apple Music / iTunes**, **Deezer**, and **Spotify Canvas**
- **Scrobbling** — **[Last.fm](https://www.last.fm)**
- **Romanization lookups** — **Google Translate**
- **Spotify web-player secrets** — **[ThetaDev/spotify-secrets](https://code.thetadev.de/ThetaDev/spotify-secrets)**
- **Discord Rich Presence (no desktop app)** — approach and idea from **[Neurobox](https://github.com/Sheathed/Neurobox)** by **Sheathed** (AGPL-3.0). See [Discord Rich Presence](#discord-rich-presence).
- Musixmatch module-artwork fetching directly from apple-- **[VIVIMUSIC](https://github.com/vivizzz007/vivi-music)** 

**Open-source components bundled with the extension**

- **Kawarp** (fluid background engine, `@kawarp/core`) — © 2026 Better Lyrics, MIT License
- **hls.js** — © 2017 Dailymotion, Apache License 2.0
- **pinyin-pro** (Chinese pinyin romanization) — © 2022-present zh-lx, MIT License
- **reCover** (fullscreen player layout) — © mukeenanyafiq and contributors, MIT License
- **Lyrics fonts** — Playfair Display, Cormorant, DM Serif Display, Lora, Poppins, Montserrat, Outfit, Space Grotesk, Caveat, Dancing Script, Pacifico and Bebas Neue, SIL Open Font License 1.1, Latin subsets via [Fontsource](https://fontsource.org)

Full copyright notices and license texts for the bundled components are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Disclaimer**

ViviMusic Xten is an independent project and is **not affiliated with, endorsed by, or sponsored by** Google, YouTube, YouTube Music, Spotify, Apple, Last.fm, Musixmatch, Deezer, GitHub, SponsorBlock, Better Lyrics or any other service named here. All product names, logos and trademarks are the property of their respective owners.

---

## License

ViviMusic Xten is free software, licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only). The full text is in [`LICENSE`](LICENSE).

Copyright (c) 2026 Archimetrix

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

**In short:** you may use, study, modify and share it, including commercially, as long as any version you distribute, or offer to users over a network, stays under the AGPL with its complete source available and with the original copyright and attribution notices kept.

**Third-party components.** The bundled third-party components listed under [Credits](#credits) stay under their own licenses (Apache-2.0, MIT and SIL OFL 1.1), and nothing above restricts the rights those licenses grant. Apache-2.0, MIT and OFL components are compatible with distribution inside an AGPL-3.0 package. Services the extension connects to, including SponsorBlock (data licensed CC BY-NC-SA 4.0) and Discord, are not part of the software and are governed by their own terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Source code.** The complete source is in this repository: <https://github.com/Archimetrix/VIVIMUSIC_XTEN>.

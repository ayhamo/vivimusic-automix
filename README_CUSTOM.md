# ViViMusic Web — Custom Fork Documentation

> **Local Project Root:** `C:\Users\ayham\Desktop\Projects\YT Music Extension`  
> **Upstream Origin:** [Archimetrix/VIVIMUSIC_WEB](https://github.com/Archimetrix/VIVIMUSIC_WEB) (Tracked on `10.1.x` line, currently `10.1.6`)  
> **Inspirations & Features Ported From:** [ayhamo/BitChord](https://github.com/ayhamo/BitChord) (`bitchord-extension-firefox 0.4.4`) & [heydavidf/automix](https://github.com/heydavidf/automix)  
> **Packaged Archive:** `vivimusic-firefox-ready-to-sign.zip` (100% POSIX forward slashes, 0 AMO errors, 22 standard vendor WASM warnings)

---

## Agent Handoff / Executive Summary for Claude

If you are continuing work on this extension, here is the exact current state and architecture:

1. **Version & Manifest:**
   - Manifest: Manifest V3 (`manifest_version: 3`).
   - Version: Kept strictly on **`10.1.6`** in `manifest.json` (do NOT bump to 10.2.x, keep on `10.1.x` for upstream sync).
   - Target Browser: Firefox 142.0+ (`strict_min_version: "142.0"`, `data_collection_permissions: { required: ["none"] }`).
   - Permissions: `"storage"`, `"unlimitedStorage"`, `"activeTab"`, `"tabs"`, `"alarms"`, `"cookies"`, `"declarativeNetRequest"`, `"declarativeNetRequestWithHostAccess"`, `"scripting"`.
   - Host Permissions: Includes `https://music.youtube.com/*`, `https://*.spotify.com/*`, `https://spotify.com/*`, `https://open.spotify.com/*`, `https://accounts.spotify.com/*`, `https://sponsor.ajay.app/*`, `https://*.googleusercontent.com/*`, and all 12 lyrics providers.

2. **Network Relay (`src/background.js` & `src/net.js`):**
   - Content scripts relay cross-origin HTTP fetches through `background.js` via message type `VIVI_NET_FETCH`.
   - **Critical Rule:** In Firefox MV3 content scripts, `sender.url` and `sender.tab` are undefined or internal `moz-extension://` URIs. `src/background.js` only checks `sender.id && sender.id !== chrome.runtime.id`, and delegates domain security to `hostAllowed(u.hostname)` against `host_permissions`. Do not re-add `sender.url.startsWith('https://music.youtube.com/')`.

3. **Spotify Session Detection & Token Minting (`src/spotify.js`):**
   - Implements the exact pattern from BitChord Firefox (`bitchord-extension-firefox 0.4.4`).
   - Session detection (`getSpDc`): Reads `sp_dc` cookie across all Firefox cookie stores (`getAllCookieStores()`) using `partitionKey: {}` and `firstPartyDomain: null` to pierce Firefox Dynamic First-Party Isolation (dFPI) and Total Cookie Protection.
   - Token Minting: Uses `declarativeNetRequest.updateSessionRules` (rule ID `303`) to inject `Cookie: sp_dc=${spDc}` into `||open.spotify.com/api/token` before calling `fetch`, then clears the rule in a `finally` block.
   - Secret Fallback: If `code.thetadev.de` is unreachable, falls back to the static TOTP codes array `Pt = { version: 12, codes: [...] }`.

4. **Automix Engine (`src/automix/automix.js`, `src/crossfade.js`, `src/crossfade-page.js`):**
   - Neural beat-tracking runs completely client-side via ONNX Runtime Web (`analysis.worker.js` + `ort-wasm-simd-threaded.wasm` + `beat_this_final0_q8.onnx`).
   - Modes: `auto` (Smart adaptive: dynamically selects 4, 8, or 16 bars based on tempo delta and beat-grid confidence), `4`, `8`, `16`.
   - Queue Discovery: `getNextTrackInfo()` pierces Firefox's content script sandbox via `wrappedJSObject` on `movie_player` to read `p.getPlaylist()` and `p.getPlaylistIndex()`, with DOM fallbacks for `ytmusic-player-queue-item`.
   - Visual Toast: Shows animated floating toast (`#vivi-automix-toast`) during the transition with pulsating pink equalizer bars and tempo indicators.
   - Timeouts: Track B intro fetch timeout is 10s; Track A tail buffer timeout is 15s.

5. **Packaging & Signing:**
   - Script: Run Python build script to create `vivimusic-firefox-ready-to-sign.zip`.
   - AMO Linter: Validated with `npx addons-linter vivimusic-firefox-ready-to-sign.zip` -> `errors: 0, warnings: 22` (all 22 warnings are pre-existing vendor WASM eval/innerHTML warnings; 0 errors).
   - AMO Submission: Upload unlisted to [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/upload-unlisted).

---

## Table of Contents
1. [Architectural Overview](#architectural-overview)
2. [Feature Breakdown & Where They Live](#feature-breakdown--where-they-live)
   - [1. Complete Star Gate Stripping](#1-complete-star-gate-stripping)
   - [2. ListenBrainz Scrobbling](#2-listenbrainz-scrobbling)
   - [3. Expanded Lyrics System & Title Cleaner](#3-expanded-lyrics-system--title-cleaner)
   - [4. 5-Second Equal-Power Manual Skip Crossfade](#4-5-second-equal-power-manual-skip-crossfade)
   - [5. On-Device Neural Automix (Auto-DJ) Engine](#5-on-device-neural-automix-auto-dj-engine)
   - [6. BitChord Automix Enhancements: Smart Adaptive Mode & 3-Band Bass Swap](#6-bitchord-automix-enhancements-smart-adaptive-mode--3-band-bass-swap)
   - [7. Mouse Wheel Volume Control](#7-mouse-wheel-volume-control)
   - [8. Apple Music Artist Hero Art & Color Palette Extraction](#8-apple-music-artist-hero-art--color-palette-extraction)
   - [9. "Stats for Nerds" Overlay HUD](#9-stats-for-nerds-overlay-hud)
   - [10. Kawarp WebGL CORS Relay Fix](#10-kawarp-webgl-cors-relay-fix)
   - [11. Spotify Session Detection & DNR Token Injection](#11-spotify-session-detection--dnr-token-injection)
3. [Modified & Added Files Map](#modified--added-files-map)
4. [Keyboard Shortcuts & UI Controls](#keyboard-shortcuts--ui-controls)
5. [Audio Graph Topology](#audio-graph-topology)
6. [Audit, Verification & Build Guide](#audit-verification--build-guide)

---

## Architectural Overview

This fork transforms the original Vivimusic extension into a high-performance desktop music powerhouse for YouTube Music in Firefox. All changes adhere to three core design rules:
1. **Zero External Server Dependencies:** All beat tracking, audio decoding, and transition planning run locally on your machine via WebAssembly SIMD and Web Audio API.
2. **Strict Playback Integrity:** Manual track skips (`Next` button / `Shift+N`) always execute a 5-second Equal-Power crossfade without artificial delays. Automix executes exclusively on natural track auto-advance.
3. **Graceful Fallbacks:** If any advanced source (e.g. neural beat grid, Apple Music canvas, TTML lyrics mirror) fails or is low confidence, the extension seamlessly falls back to standard pipelines without interrupting playback.

---

## Feature Breakdown & Where They Live

### 1. Complete Star Gate Stripping
* **Files Modified/Removed:**
  - Removed files: `src/gate.js`, `src/gate.css`, `src/stargate.js`.
  - Cleaned: `manifest.json`, `src/content.js`, `src/background.js`, `src/popup.html`, `src/popup.js`.
* **Details:**
  - Stripped all telemetry, remote check-ins, and mandatory OAuth device approval loops.
  - The extension is fully independent, offline-capable, and immediately unlocked on install.

---

### 2. ListenBrainz Scrobbling
* **Files:**
  - Implementation: `src/listenbrainz.js`
  - Content Script Bridge: `src/content.js`
  - Background Relay: `src/background.js`
  - UI Settings: `src/popup.html` & `src/popup.js`
* **Details:**
  - Supports standard ListenBrainz user tokens.
  - Submits `playing_now` notification immediately on track start.
  - Submits the recorded listen when the track reaches 50% completion or 4 minutes of continuous playback.
  - Configurable scrobble delay and instant test scrobble button in popup.

---

### 3. Expanded Lyrics System & Title Cleaner
* **Files:**
  - Core Provider Logic: `src/lyrics.js`
  - Scrapers & Relays: `src/background.js`
  - Permissions: `manifest.json`
* **Features:**
  - **Title & Artist Cleaner (`cleanTitleForLyrics` / `cleanArtistForLyrics`):**
    Strips YouTube packaging clutter (`(Official Music Video)`, `[Lyrics Video]`, `(Visualizer)`, `[HD]`, `[4K]`, `feat.`, `ft.`, `#JerseyClub`, `(Slowed)`, `Artist - Topic`) while keeping version indicators (`Remix`, `Acoustic`). Applied before querying any lyrics API, boosting search hit rates dramatically.
  - **12 Parallel Providers:** All enabled providers (LRCLIB, Paxsenix, BetterLyrics, Unison, Musixmatch, Genius, Spotify, etc.) are queried concurrently in parallel.
  - **Unblocked Background Fetch:** Content script requests pass through `background.js` with zero CORS restrictions.

---

### 4. 5-Second Equal-Power Manual Skip Crossfade
* **Files:**
  - Isolated World Controller: `src/crossfade.js`
  - Main Page MSE Decoder: `src/crossfade-page.js`
* **Details:**
  - Matches the Equal-Power curve profile from mobile players.
  - Outgoing track gain: $G_{\text{out}}(t) = \cos\left(\frac{\pi}{2} \cdot \frac{t}{T}\right)$
  - Incoming track gain: $G_{\text{in}}(t) = \sin\left(\frac{\pi}{2} \cdot \frac{t}{T}\right)$
  - Constant acoustic power across the entire transition ($G_{\text{out}}^2 + G_{\text{in}}^2 = 1$).
  - Triggered instantaneously on Next button click and `Shift + N` shortcut without stalling playback.

---

### 5. On-Device Neural Automix (Auto-DJ) Engine
* **Files:**
  - Orchestrator: `src/automix/automix.js`
  - Analysis Worker: `src/vendor/automix/analysis.worker.js`
  - WebAssembly Runtime: `src/vendor/automix/ort-wasm-simd-threaded.wasm` (14.2 MB)
  - Neural Network: `src/vendor/automix/beat_this_final0_q8.onnx` (23.1 MB)
  - Dual-Deck Fader: `src/crossfade.js`
  - Audio Sinks & Player Bridge: `src/crossfade-page.js`
* **Details:**
  - At T - 60s of Track A, preloads Track A's outro tail and fetches the first 1.2 MB of Track B via InnerTube / googlevideo.
  - Analyzes both audio buffers using the Beat This neural network to determine precise BPM, downbeats, and beat grids.
  - Computes optimal tempo ratio (`rateB`), time-stretching Track B to match Track A.

---

### 6. BitChord Automix Enhancements: Smart Adaptive Mode & 3-Band Bass Swap
* **Files:** `src/automix/automix.js`, `src/crossfade.js`, `src/equalizer.js`, `src/popup.html`, `src/popup.js`, `src/canvas.css`
* **Features:**
  - **Auto (Smart adaptive) Mode:** Dynamically scales transition length based on tempo drift:
    - 4 bars (Quick blend) if tempo drift > 5% or beat-grid confidence < 0.45.
    - 8 bars (Standard phrase) for normal musical transitions.
    - 16 bars (Extended club mix) if tempo matches within 2% and confidence is high.
  - **3-Band EQ Bass Swap:** Crossfades low-end frequencies (low-shelf 250 Hz) inverted at the midpoint to prevent bass clashing.
  - **Visual Automix Toast (`#vivi-automix-toast`):** On transition execution, displays an animated floating notification with pulsating pink equalizer bars showing the active mix details (e.g. `8 bars (14.2s) • 128 ➔ 130 BPM`).

---

### 7. Mouse Wheel Volume Control
* **Files:** `src/content.js`, `src/popup.html`, `src/popup.js`
* **Details:** Smooth $\pm 5\%$ volume adjustments when scrolling over the player bar or album art.

---

### 8. Apple Music Artist Hero Art & Color Palette Extraction
* **Files:** `src/background.js`, `src/content.js`, `src/canvas.css`
* **Details:** Scrapes high-res Apple Music artist hero imagery and dynamically adjusts YouTube Music page gradient accents to match the artist's visual theme.

---

### 9. "Stats for Nerds" Overlay HUD
* **Files:** `src/content.js`, `src/canvas.css`
* **Details:** Shortcut `Shift + D`. Displays live Opus audio bitrate, sample rate, channels, current song metadata, and real-time Automix transition state.

---

### 10. Kawarp WebGL CORS Relay Fix
* **Files:** `src/kawarp-bg.js`, `src/background.js`, `manifest.json`
* **Details:** Google CDN image URLs (`yt3.googleusercontent.com`) are fetched via the background fetch relay to generate same-origin `blob:` URLs, completely bypassing WebGL canvas cross-origin tainting in Firefox.

---

### 11. Spotify Session Detection & DNR Token Injection
* **Files:** `src/spotify.js`, `manifest.json`
* **Details:** 
  - `getSpDc()` searches all Firefox cookie stores and partitions (`partitionKey: {}`, `firstPartyDomain: null`) to detect `sp_dc` even under Firefox Total Cookie Protection.
  - Uses `declarativeNetRequest.updateSessionRules` to inject `Cookie: sp_dc=${spDc}` into requests to `open.spotify.com/api/token` before token minting.
  - Fallback TOTP secret codes embedded in code if ThetaDev server is unreachable.

---

## Keyboard Shortcuts & UI Controls

| Action | Shortcut / Trigger | Description |
|---|---|---|
| **Manual Crossfade Skip** | `Shift + N` or Next Button | Triggers instant 5-second Equal-Power crossfade |
| **Toggle Nerd Stats HUD** | `Shift + D` | Shows/hides live audio stream & Automix diagnostic overlay |
| **Mouse Wheel Volume** | Wheel scroll on player bar / art | Smooth $\pm 5\%$ volume adjustments |
| **Automix Auto-Advance** | Natural track end (T - 60s) | Runs neural beatmatching, tempo scaling, and bass swap |
| **Automix Bars Selector** | Extension Popup | Choose between Auto (Smart adaptive), 4 bars, 8 bars, or 16 bars |

---

## Audio Graph Topology

```
[HTML5 Video Element] (Deck A)
        │
   [MediaElementSource]
        │
     [xfGate]  (Deck A Gain: 1.0 -> 0.0)
        │
   [xfBassFilter] (Low-Shelf 250 Hz: 0 dB -> -12 dB at midpoint)
        │
   [lowShelf] ────► [midPeak] ────► [highShelf] ────► [Master & Destination]
        ▲
        │
     [volB]  (Deck B Gain: 0.0 -> 1.0)
        │
     [eqB]   (Deck B Low-Shelf 250 Hz: -12 dB -> 0 dB at midpoint)
        │
 [srcB: AudioBufferSource] (Deck B: Tempo-Scaled PCM)
```

---

## Audit, Verification & Build Guide

### Syntax & Health Audit
Verify all 32 JavaScript files:
```powershell
Get-ChildItem -Path "src" -Filter "*.js" -Recurse | ForEach-Object { node -c $_.FullName }
```

### Build Zip Archive
To rebuild `vivimusic-firefox-ready-to-sign.zip` with 100% POSIX forward slashes:
```powershell
python "C:\Users\ayham\.gemini\antigravity\brain\d7beeeb7-3c71-4c37-80a9-524d02f90215\scratch\build_zip.py"
```

### Validate with AMO Linter
```powershell
npx addons-linter vivimusic-firefox-ready-to-sign.zip
```
*Current result: 0 errors, 22 warnings (clean vendor baseline).*

### Loading Locally in Firefox
1. Open Firefox to `about:debugging#/runtime/this-firefox`.
2. Click **"Load Temporary Add-on..."**.
3. Select `manifest.json` from the repository root.

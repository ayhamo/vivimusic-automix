# ViViMusic Web — Custom Fork Documentation

> **Local Project Root:** `C:\Users\ayham\Desktop\Projects\YT Music Extension`  
> **Upstream Origin:** [Archimetrix/VIVIMUSIC_WEB](https://github.com/Archimetrix/VIVIMUSIC_WEB)  
> **Inspirations & Features Ported From:** [ayhamo/BitChord](https://github.com/ayhamo/BitChord) & [heydavidf/automix](https://github.com/heydavidf/automix)  
> **Packaged Archive:** `vivimusic-firefox-ready-to-sign.zip` (Ready for Mozilla Add-on Developer Hub signing & permanent Firefox installation)

---

## Table of Contents
1. [Architectural Overview](#architectural-overview)
2. [Feature Breakdown & Where They Live](#feature-breakdown--where-they-live)
   - [1. Complete Star Gate Stripping](#1-complete-star-gate-stripping)
   - [2. ListenBrainz Scrobbling](#2-listenbrainz-scrobbling)
   - [3. Expanded Lyrics System & Title Cleaner](#3-expanded-lyrics-system--title-cleaner)
   - [4. 5-Second Equal-Power Manual Skip Crossfade](#4-5-second-equal-power-manual-skip-crossfade)
   - [5. On-Device Neural Automix (Auto-DJ) Engine](#5-on-device-neural-automix-auto-dj-engine)
   - [6. BitChord Automix Enhancements: Scaling & 3-Band Bass Swap](#6-bitchord-automix-enhancements-scaling--3-band-bass-swap)
   - [7. Mouse Wheel Volume Control](#7-mouse-wheel-volume-control)
   - [8. Apple Music Artist Hero Art & Color Palette Extraction](#8-apple-music-artist-hero-art--color-palette-extraction)
   - [9. "Stats for Nerds" Overlay HUD](#9-stats-for-nerds-overlay-hud)
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
  - Implementation: [`src/listenbrainz.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/listenbrainz.js)
  - Content Script Bridge: [`src/content.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/content.js)
  - Background Relay: [`src/background.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/background.js)
  - UI Settings: [`src/popup.html`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/popup.html) & [`src/popup.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/popup.js)
* **Details:**
  - Supports standard ListenBrainz user tokens.
  - Submits `playing_now` notification immediately on track start.
  - Submits the recorded listen when the track reaches 50% completion or 4 minutes of continuous playback.
  - Configurable scrobble delay and instant test scrobble button in popup.

---

### 3. Expanded Lyrics System & Title Cleaner
* **Files:**
  - Core Provider Logic: [`src/lyrics.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/lyrics.js)
  - Scrapers & Relays: [`src/background.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/background.js)
  - Permissions: [`manifest.json`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/manifest.json)
* **New Features:**
  - **Title & Artist Cleaner (`cleanTitleForLyrics` / `cleanArtistForLyrics`):**
    Strips YouTube packaging clutter (`(Official Music Video)`, `[Lyrics Video]`, `(Visualizer)`, `[HD]`, `[4K]`, `feat.`, `ft.`, `Artist - Topic`) while keeping version indicators (`Remix`, `Acoustic`). Applied before querying any lyrics API, boosting search hit rates dramatically.
  - **Paxsenix Provider (`fromPaxsenix`):**
    Searches Apple Music catalog for matching track IDs and pulls line/word-synced TTML lyrics.
  - **Genius Fallback (`fromGenius`):**
    Multi-container DOM parser that scrapes full plain-text lyrics from Genius when timed sources have no match.
  - **LyricsPlus Mirrors (`fromLyricsPlus`):**
    Races `https://lyricsplus.prjktla.my.id` and `https://lyricsplus.binimum.org` community mirrors for syllable-by-syllable karaoke timings.

---

### 4. 5-Second Equal-Power Manual Skip Crossfade
* **Files:**
  - Isolated World Controller: [`src/crossfade.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/crossfade.js)
  - Main Page MSE Decoder: [`src/crossfade-page.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/crossfade-page.js)
* **Details:**
  - Matches the exact Equal-Power curve profile from mobile players (Samsung Music / Viper).
  - Outgoing track gain: $G_{\text{out}}(t) = \cos\left(\frac{\pi}{2} \cdot \frac{t}{T}\right)$
  - Incoming track gain: $G_{\text{in}}(t) = \sin\left(\frac{\pi}{2} \cdot \frac{t}{T}\right)$
  - Constant acoustic power across the entire transition ($G_{\text{out}}^2 + G_{\text{in}}^2 = 1$), eliminating mid-crossfade volume dips.
  - Triggered instantaneously on Next button click and `Shift + N` shortcut without stalling playback.

---

### 5. On-Device Neural Automix (Auto-DJ) Engine
* **Files:**
  - Orchestrator: [`src/automix/automix.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/automix/automix.js)
  - Analysis Worker: [`src/vendor/automix/analysis.worker.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/vendor/automix/analysis.worker.js)
  - WebAssembly Runtime: [`src/vendor/automix/ort-wasm-simd-threaded.wasm`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/vendor/automix/ort-wasm-simd-threaded.wasm) (14.2 MB)
  - Neural Network: [`src/vendor/automix/beat_this_final0_q8.onnx`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/vendor/automix/beat_this_final0_q8.onnx) (23.1 MB)
* **How It Works:**
  1. **60-Second Trigger:** When Track A has 60 seconds left, Automix inspects the queue (`getNextTrackInfo`).
  2. **Prefetching:** Requests a 1.2 MB byte-range audio chunk of Track B's intro from YouTube's streaming server via the authenticated page session.
  3. **Tail Extraction:** Reads up to 59 seconds of buffered audio from Track A's MSE audio sink in `crossfade-page.js`.
  4. **Neural Analysis:** Feeds downsampled mono 22,050 Hz PCM to the on-device "Beat This" model in a dedicated Web Worker to extract BPM, beat grids, and downbeat timestamps.
  5. **Tempo Alignment:** Checks tempo ratios across octave multiples (1x, 0.5x, 2x). If within the 12% max tempo limit, plans a downbeat-aligned transition.
  6. **Dual-Deck Blending:** Deck B starts playback stretched to Deck A's tempo via Web Audio API, fading in while Deck A fades out.

---

### 6. BitChord Automix Enhancements: Scaling & 3-Band Bass Swap
* **Files:**
  - Scheduler & Scaling: [`src/automix/automix.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/automix/automix.js) (`effectiveBlendBars`)
  - Filter Node Injection: [`src/equalizer.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/equalizer.js) (`xfBassFilter`)
  - Transition Driver: [`src/crossfade.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/crossfade.js)
* **Details:**
  - **Dynamic Confidence Scaling (`effectiveBlendBars`):**
    Instead of forcing a long blend on uncertain rhythms, transition length is dynamically clamped:
    - $\text{Confidence} \ge 0.60 \implies$ full requested bars (8 or 16 bars).
    - $0.45 \le \text{Confidence} < 0.60 \implies$ clamped to 8 bars.
    - $0.20 \le \text{Confidence} < 0.45 \implies$ clamped to 4 bars.
    - $\text{Confidence} < 0.20 \implies$ clean fallback to 5-second crossfade.
  - **3-Band Midpoint Bass Swap (`ThreeBandEQ`):**
    During beat-synced mixes, outgoing Deck A and incoming Deck B pass through $250\text{ Hz}$ low-shelf filters. Over 1 bar centered on the transition midpoint:
    - Deck A bass ramps down to $-12\text{ dB}$ ($-6\text{ dB}$ on 4-bar blends).
    - Deck B bass ramps up from $-12\text{ dB}$ to $0\text{ dB}$.
    - Completely prevents low-end kick clash and phase distortion.
  - **Always-Fresh Analysis:**
    No static caching is used; every song transition is analyzed fresh for creative and varied blends.

---

### 7. Mouse Wheel Volume Control
* **Files:**
  - Content Event Listener: [`src/content.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/content.js) (`initWheelVolume`)
  - Main Page Dispatcher: [`src/crossfade-page.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/crossfade-page.js) (`setPlayerVolume`)
* **Details:**
  - Scrolling the mouse wheel over the bottom player bar, album art, or volume slider steps volume up/down in smooth $\pm 5\%$ increments.
  - Synchronizes both the HTML5 `<video>` element and YouTube Music's native UI volume slider.
  - Automatically un-mutes if volume is scrolled up while muted.
  - Safely ignores scrolls inside long queue lists or lyrics panels unless `Ctrl`/`Alt` is held.

---

### 8. Apple Music Artist Hero Art & Color Palette Extraction
* **Files:**
  - Background Fetcher: [`src/background.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/background.js) (`getAppleArtistArt`)
  - Content Styler: [`src/content.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/content.js) (`applyAppleArtistArtForTrack`)
* **Details:**
  - Searches the Apple Music catalog for the active artist, fetches the artist page, and parses the hydration server data.
  - Extracts 1200px hero photographs, transparent artist logo PNGs, and official Apple color tokens (`bgColor`, `textColor1`, `keyColor`).
  - Sets CSS variables on `:root`:
    - `--vivi-apple-bg`
    - `--vivi-apple-accent`
    - `--vivi-apple-key`
  - Subtly tints player panels and backdrops to match official artist aesthetic.

---

### 9. "Stats for Nerds" Overlay HUD
* **Files:**
  - HUD DOM & Clock: [`src/content.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/content.js) (`createNerdStatsOverlay`, `updateNerdStatsHUD`)
  - State Exporter: [`src/automix/automix.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/automix/automix.js) (`getLiveState`)
  - Popup Toggle: [`src/popup.html`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/popup.html) & [`src/popup.js`](file:///C:/Users/ayham/Desktop/Projects/YT Music Extension/src/popup.js)
* **Details:**
  - Minimal glassmorphic HUD in the lower-left corner with monospace tabular numbers.
  - **Line 1 (Stream):** `Opus · 48 kHz · 160 kbps · Stereo | Track Title`
  - **Line 2 (Automix):** Real-time BPM of current and upcoming songs, neural network confidence, planned bar count, tempo stretch ratio, and active bass swap status.
  - **Hotkeys:** Press **`Shift + D`** at any time to toggle the overlay on/off.

---

## Modified & Added Files Map

```
C:\Users\ayham\Desktop\Projects\YT Music Extension\
├── manifest.json                                # Permissions, web-accessible resources & mirrors
├── README_CUSTOM.md                             # This comprehensive guide
├── vivimusic-firefox-ready-to-sign.zip          # 28.59 MB packaged production zip
└── src\
    ├── automix\
    │   └── automix.js                           # On-device Auto-DJ scheduler & scaling
    ├── vendor\
    │   └── automix\
    │       ├── analysis.worker.js               # Web Worker running ONNX Runtime
    │       ├── beat_this_final0_q8.onnx         # 8-bit quantized Beat This model (23.1 MB)
    │       └── ort-wasm-simd-threaded.wasm      # ONNX WebAssembly SIMD runtime (14.2 MB)
    ├── background.js                            # Paxsenix, Genius, Apple artist art & token management
    ├── content.js                               # Wheel volume, NerdStats HUD, Apple palette injection
    ├── crossfade.js                             # Dual-deck crossfade engine, 3-band bass swap
    ├── crossfade-page.js                        # Main-world MSE capture, audio decoder, volume sync
    ├── equalizer.js                             # Audio graph topology with xfBassFilter node
    ├── listenbrainz.js                          # Native ListenBrainz scrobbler
    ├── lyrics.js                                # Lyrics provider race, title cleaner & LyricsPlus
    ├── popup.html                               # Popup UI with Automix, HUD & volume controls
    └── popup.js                                 # Popup setting storage & change listeners
```

---

## Keyboard Shortcuts & UI Controls

| Action | Shortcut / Trigger | Description |
|---|---|---|
| **Manual Crossfade Skip** | `Shift + N` or Next Button | Triggers instant 5-second Equal-Power crossfade |
| **Toggle Nerd Stats HUD** | `Shift + D` | Shows/hides live audio stream & Automix diagnostic overlay |
| **Mouse Wheel Volume** | Wheel scroll on player bar / art | Smooth $\pm 5\%$ volume adjustments |
| **Automix Auto-Advance** | Natural track end (T - 60s) | Runs neural beatmatching, tempo scaling, and bass swap |
| **Automix Bars Selector** | Extension Popup | Choose between 4 bars (quick), 8 bars (phrase), or 16 bars (club) |

---

## Audio Graph Topology

During Automix playback and transitions, the extension constructs this real-time Web Audio graph:

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
All JavaScript files in the extension can be verified using Node.js:
```powershell
node "C:\Users\ayham\.gemini\antigravity\brain\d7beeeb7-3c71-4c37-80a9-524d02f90215\scratch\audit.js"
```
*Current result: 32/32 JavaScript files validated with 0 syntax errors.*

### Rebuilding the Zip Package
To rebuild `vivimusic-firefox-ready-to-sign.zip`:
```powershell
node "C:\Users\ayham\.gemini\antigravity\brain\d7beeeb7-3c71-4c37-80a9-524d02f90215\scratch\build_zip.js"
```

### Permanent Installation on Firefox
1. Open Firefox and navigate to the **[Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/upload-unlisted)**.
2. Select **"On your own" (Unlisted)**.
3. Upload `C:\Users\ayham\Desktop\Projects\YT Music Extension\vivimusic-firefox-ready-to-sign.zip`.
4. Mozilla will sign the package within seconds and provide a `.xpi` file.
5. Click the signed `.xpi` file in Firefox to install permanently.

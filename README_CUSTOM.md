# ViViMusic Web — Custom Firefox Fork

> **Credits.** Vivimusic Web is created by **[Archimetrix](https://github.com/Archimetrix)**, and the large majority of this code is theirs: the theme, Canvas / Apple artwork, lyrics, Kawarp, Spotify, Last.fm, the popup and the crossfade core. Huge thanks to them for building it. This fork adds Firefox fixes, Automix, crossfade fixes, ListenBrainz and extra lyrics providers on top. Upstream's code stays under upstream's licence ([LICENSE.txt](LICENSE.txt)); it is not relicensed by this fork.

Fork of [Archimetrix/VIVIMUSIC_WEB](https://github.com/Archimetrix/VIVIMUSIC_WEB) v10.1.1, packaged for Firefox (142+), with extra features ported from [BitChord](https://github.com/ayhamo/BitChord) and [heydavidf/automix](https://github.com/heydavidf/automix).

- Manifest V3, version `10.1.7`, gecko id `vivimusic-web@custom`
- Firefox port pieces are taken from upstream's own AMO build (`vivimusicweb-10.1.1.xpi`), which is a separate port of the same version; the GitHub repo only holds the Chrome source.

---

## Status (verified 2026-11-03 in Firefox 159 with the extension loaded on music.youtube.com)

| Feature | State |
|---|---|
| Background page, fetch relay, SponsorBlock, lyrics, theme, popup | Working |
| Crossfade on natural song end | Working (alignment 1.000, 6 s mix) |
| Crossfade on manual skip (Next button / Shift+N) | Working (alignment 1.000 on click and Shift+N, no double skip); falls back to a plain skip when alignment is weak or the tail is not ready in 1.5 s |
| Automix (beat-aligned blend) | Working (detected 114 BPM on a 113 BPM song, 8 bars / 16.8 s, started on a downbeat) |
| Spotify Canvas | Lookup verified with a real account (connect, token, Canvas URL for Midnight Sun); needs "Connect" in the popup once, and Canvas priority set to Spotify to prefer it over Apple |
| Last.fm, ListenBrainz | Code paths fixed but not tested (need your accounts) |

---

## What was broken in the previous state, and the fixes

1. **Background never loaded in Firefox.** `background.js` called `importScripts()`, which only exists in service workers; Firefox runs MV3 backgrounds as event pages, so the first line threw and every feature that talks to the background died. Now the manifest's `background.scripts` loads the helpers and `importScripts` is only used when it exists (Chrome).
2. **Upstream's Firefox port merged in** (3-way merge: upstream git v10.1.1 → AMO 10.1.1 build → this fork):
   - `src/fx-headers.js` — blocking `webRequest` for Origin/Referer spoofing (Apple `amp-api`, Spotify), the `sp_dc` cookie on `open.spotify.com` requests, a CSP patch so YouTube Music allows `moz-extension:` frames/images/fonts, a `VIVI_FETCH` proxy and a keep-alive for long background tasks. Replaces the previous agent's DNR cookie hack in `spotify.js`.
   - `src/fx-compat.js` (page-world `getVideoData` helper; its fetch wrapper is skipped because `net.js` already relays fetches), plus the Firefox fixes in `kawarp.js` (half-float FBO), `kawarp-bg.js` (artwork through the background), `content.js`, `theme.css`, `lyrics-ui.js`.
   - Permissions now match upstream's Firefox build: `webRequest`, `webRequestBlocking` instead of DNR, plus the `ytimg` / `ggpht` / `scdn` / `itunes` hosts.
3. **Settings randomly read as "off".** Firefox's `storage.local.get` sometimes fails while a page loads ("An unexpected error occurred") and callbacks get `undefined`. `src/fx-storage.js` (first script in each content-script group) retries those reads. `null` defaults in `storage.get` were also replaced with `false`.
4. **Crossfade audio capture had holes.** YouTube Music appends one segment in several chunks; only the first chunk has a cluster/fragment header, and the others were dropped, so decoding stopped after a few seconds (this also hurt upstream's crossfade after seeks). `crossfade-page.js` now joins continuation chunks to their segment and keeps one stream format per decode.
5. **Manual-skip crossfade looped.** The hand-over presses Next with a synthetic click, which our own click interceptor caught again. Only trusted clicks/keys are intercepted now, a late tail can no longer hand over onto the next song, and the click is never held longer than 1.5 s.
6. **Automix was rewritten** (see below). The old version could never work: it fetched Track B's audio from the InnerTube player API (YouTube only returns ciphered stream URLs there), played Track B's intro and then started Track B from 0 again, used an undefined `warn()`, and disabled itself for the rest of the session after one fallback.
7. **Analysis worker could not run in MV3.** It bundles an old Emscripten/embind build that generates glue code with `Function()`. Five embind functions in `src/vendor/automix/analysis.worker.js` were replaced with their non-eval equivalents (`St`, the dynCall wrapper in `U`, `Cn` craftInvokerFunction, `tr` method caller, `ar` emval allocator), and the extension CSP allows `'wasm-unsafe-eval'`.
8. **ListenBrainz never scrobbled** (the functions were never called) and its popup code sat outside the popup's IIFE, so toggling it threw. Both fixed.
9. **Lyrics priority list was ignored** — the previous change raced every provider regardless of your top-3. Upstream's priority logic is back; LyricsPlus, Paxsenix and Genius remain as extra providers (LyricsPlus now has a toggle).
10. **Stats for Nerds HUD showed made-up values** ("Opus · 48 kHz · 160 kbps" was hardcoded). It now shows the song, position, Web Audio state and live crossfade/automix state.
11. Apple artist art lookups are cached per artist instead of re-fetching the Apple Music page on every song.
12. Manual-skip alignment waited too little: the analyser is attached at the click, and matching ran before it held real audio (seen as alignment 0.68 and a plain skip). It now waits until 0.4 s of audio is in; both test skips then aligned at 1.000.
13. After a blend, the silent old tail kept the crossfade "busy" until its buffer ended (up to ~25 s), so a quick second skip got no blend. The crossfade now finishes as soon as the fade does.
14. **Animated art / Canvas missing on songs that have one.** The artwork cache saved failed lookups (for example while the background page was broken) as "no Canvas", forever. Upstream's Apple resolver also reported network/token errors as "no Canvas". Failed lookups are now reported as failures and never cached, and the first start of this version clears every saved "no Canvas" once (`viviCanvasNotFoundPurgedV1`), so those songs are looked up again.
15. **Automix gave up on dance tracks** ("fallback, no usable beat grid" at ~65 BPM). The beat model often locks onto half time; the planner now folds the tempo into 90–180 BPM (65 → 130), fills in the downbeats between the detected ones, and tries shorter blends (16 → 8 → 4 bars) before giving up.
16. **Lyrics jumped to the next song as soon as a blend started**, while the old song was still the louder one (for up to 30 s with automix). During a blend the lyrics now stay on the old song, on its own clock, until the middle of the blend, then switch.
17. **Canvas kept playing while the song was paused.** Apple animated art, Spotify Canvas and the lyrics dancer now pause with the song and resume with it (`syncCanvasWithSong` in content.js; the Apple frame no longer restarts itself on tab focus while the page has it paused).
18. **Spotify "Disconnect" logged you out of Spotify, and "Connect" could hang.** Upstream's disconnect deleted the browser's own `sp_dc` login cookie, so the next Connect waited for a fresh Spotify login; Connect also rewrote that cookie without an expiry (a remembered login became session-only). Disconnect now only forgets the session in the extension (`spotifyDisconnected` flag, so it is not picked up again until Connect), and Connect leaves an existing cookie untouched.
19. **Automix "analysis too slow" on short songs.** The beat model loaded only at the first analysis near the end. It now loads in the middle of the song (`warmup()` in automix.js), so the real analysis has the time.
20. **Spotify Connect stuck on "Opening Spotify…".** Firefox lets the user withhold an add-on's site access; without Spotify's, the cookie is invisible. Connect now asks Firefox for that access first and reports it if it is still missing.
21. **YouTube Music's own look kept.** The theme stays, but the Vivimusic logo swap, the "Upgrade" → "Support" (Buy Me a Coffee) swap, the loading splash, the `VIVIMUSIC` tab title and the Vivimusic tab icon are gone (`loader.js`, `favicon-main.js` and the custom logos deleted; the sync scripts keep them deleted).
22. **New: where the Spotify Canvas plays** (Spotify Canvas → "Show the Spotify Canvas"): on the cover (the original, default), behind the lyrics (only while the Lyrics tab is open), behind the side panel (every tab), or off. Behind the panel it is blurred, darkened and fades out at the edges, pauses with the song, and the cover shows Apple's animated art when the song has it, otherwise the normal cover (`fetchLyricsCanvas` / `placeLyricsCanvas` in content.js, `#vivi-lyrics-canvas` in canvas.css). A "Blur behind the panel" slider (0–20 px, default 3) sets its blur, and Lyrics → "Blur around the current line" (off / low, the new default / normal) sets how much the Apple Music style blurs the other lines.
23. **Apple animated art lookups made sturdier** (ported from BitChord's AppleMusicCanvas.kt): no baked-in token any more (it had expired). The last scraped web-player token is kept in storage (`viviAppleTokenBackup`) and used when a scrape fails, until it expires. The web player's JWT is picked by its kid/iss. A 401 strikes the token off, re-scrapes and retries once (never cached as "no Canvas"), and a failed scrape waits 30 min. The storefront follows the browser's region (en-GB → gb, else us), older `motionSquareVideo1x1` / `motionTallVideo3x4` keys are read, and a second rendition is tried before falling back to the still cover.
24. **UI text in a serif font on Windows.** The theme forced `"Inter","PingFangSC-Regular","Apple SD Gothic Neo"` (none bundled, none on Windows) onto all UI text, so Firefox fell back to Times New Roman. `--font-family` in theme.css is now YouTube Music's own stack (YouTube Sans, Roboto, …). Lyrics keep their own font setting.
25. **First song after a page reload opened on Up next, not Lyrics.** After a reload YT Music can open the player with an empty tab bar and fill in the tabs seconds later; the auto-switch gave up after 3 s. It now waits up to 15 s for the Lyrics tab, and stops as soon as the user picks a tab themselves (`clickLyricsTabWithRetry` in lyrics-ui.js).
26. **YouTube ads were taken for music videos.** An ad before a song is a 16:9 video, so the song was judged a "real music video": no lyrics ("Lyrics are off for video songs") and no Canvas. `isRealMusicVideo()` now answers "no" while the player has `ad-showing` / `ad-interrupting`.
27. **New: Edge / Chrome build.** `scripts/build_zip.py` builds two zips from the same code: `vivimusic-firefox-ready-to-sign.zip` and `vivimusic-chromium.zip` (Edge and Chrome; one build for both, MV3). The Chromium manifest is derived from manifest.json at build time: service worker only, `declarativeNetRequestWithHostAccess` instead of blocking `webRequest`, no Firefox settings, no upstream `key` (so the ID never clashes with upstream's store add-on). In Chrome the background loads `fx-headers.js` too (keep-alive and the `VIVI_FETCH` proxy; its Firefox-only header rewrite skips itself) and registers session rules for Apple's and Spotify's Origin/Referer (only for the extension's own requests). Releases carry both zips (`-firefox.zip`, `-edge-chrome.zip`). Install in Edge/Chrome: unzip, Developer mode, Load unpacked; to update, replace the folder's contents and press Reload.

---

## Automix: how it works now

Files: `src/automix/automix.js` (planner), `src/automix/host.html` + `host.js` (hidden extension iframe that runs the worker), `src/vendor/automix/*` (worker, ONNX runtime WASM, Beat This model), `src/crossfade.js` (audio), `src/crossfade-page.js` (MSE capture).

1. Needs **Crossfade on** and the Automix toggle on (Audio playback card).
2. ~50 s before a song ends on its own, crossfade.js asks the page world for the buffered outro; it retries until YouTube has buffered to the end (it buffers ~30–40 s ahead).
3. The outro (mono, 22.05 kHz) goes to the Beat This model in the hidden extension frame. Firefox refuses Workers started from a content script with an extension URL, hence the frame.
4. `planMix` folds the detected tempo into 90–180 BPM (half/double time), picks 4/8/16 bars (auto: by grid confidence, capped at 30 s) and the latest downbeat that lets the whole blend finish before the song ends, trying shorter blends if the longer one no longer fits.
5. At that downbeat (minus the learned next-song start delay) the normal crossfade hand-over runs with the longer length, plus a bass swap at the midpoint (outgoing low-shelf cut, incoming restored within one beat). The toast shows bars, length and BPM.
6. If anything fails (weak grid, analysis too slow, missed downbeat), that song gets the normal crossfade instead.

The next song's tempo is **not** matched: its audio is not available before YouTube's own player starts it.

First analysis after page load takes ~15–20 s (model load); there is enough lead time for that.

---

## How to update (read this first when continuing)

### Where everything lives

| What | Where |
|---|---|
| This fork | private repo `ayhamo/vivimusic-firefox` (remote `origin`) |
| Upstream Chrome source | GitHub `Archimetrix/VIVIMUSIC_WEB`, tagged `vX.Y.Z` (remote `upstream`) |
| Upstream Firefox port | AMO `vivimusicweb` (https://addons.mozilla.org/firefox/addon/vivimusicweb/). A separate port of each version, **never pushed to GitHub** |
| Copy of upstream's Firefox build | `upstream-amo/vivimusicweb-<version>.xpi` (the original AMO file, for reference; open it as a zip) |
| AMO manifest we last handled | `upstream-amo/manifest-last-synced.json` |

Both upstream sources have to be pulled in for each new version: GitHub for the shared code, AMO for upstream's Firefox-only fixes.

### A. Update the git repo from upstream (on your PC)

```bash
git pull
```
```bash
git fetch upstream --tags
```
```bash
python scripts/merge_upstream.py vX.Y.Z --commit
```
Merges upstream's GitHub tag. It keeps the star-gate and funding files deleted and keeps our `manifest.json` version; anything else that conflicts is left for you (exit code 2).

```bash
python scripts/sync_upstream_firefox.py --save-xpi
```
Dry run: downloads upstream's current AMO build, stores it in `upstream-amo/`, and reports what a 3-way merge (base = upstream tag, theirs = AMO, ours = this tree) would change. Then apply it:

```bash
python scripts/sync_upstream_firefox.py --apply --save-xpi
```

If it prints new `manifest.json` changes, copy them into our `manifest.json` by hand, then record them as handled:
```bash
python scripts/sync_upstream_firefox.py --accept-manifest
```
When editing the manifest, keep: gecko id `vivimusic-web@custom`, `data_collection_permissions: none`, `fx-storage.js` first in both isolated content-script groups, `net.js` before `fx-compat.js`, the automix entries and the `'wasm-unsafe-eval'` CSP. `src/background.js` always keeps our side where it conflicts with AMO (upstream's Firefox build deletes the `VIVI_NET_FETCH` relay that `net.js` needs); the script does that automatically.

Then test in Firefox (crossfade, manual skip, automix, lyrics), bump `version` in `manifest.json` (keep three parts, e.g. `10.1.8`), commit and push:
```bash
git push
```

Last synced: GitHub v10.1.1 + AMO 10.1.1 (2026-11-03).

### B. The daily workflow (`.github/workflows/fork-sync-release.yml`)

- Runs every day at 05:23 UTC, or by hand: Actions → "Fork sync and release" → Run workflow (`force` rebuilds and replaces the release even if nothing changed).
- It checks upstream's latest GitHub release, upstream's AMO version and this repo's `main`. When any of them is new, it does part A in the runner (nothing is pushed back), lints, and publishes a **GitHub release** (repo page → Releases) with `vivimusic-web-<version>.zip` attached. Release tag: `fork-<upstream tag>-amo<AMO version>-<fork commit>`.
- A red run means upstream changed something that needs a human (a conflict or new AMO manifest changes) or the linter found errors. Nothing is published; do part A locally to see and fix it.
- A green run after an upstream update only built a release: still do part A locally and push, so `main` has the merge.
- Release version is `<manifest version>.<run number>` (e.g. `10.1.7.3`). AMO refuses a version it has seen before, and the run number makes every build higher. Keep `manifest.json` at three parts.

### C. Sign on AMO and install

The add-on is already on your AMO account (https://addons.mozilla.org/en-US/developers/addons, uploaded as unlisted).

1. Download `vivimusic-web-<version>.zip` from the newest release.
2. AMO Developer Hub → Vivimusic Web → **Upload New Version** → the zip → follow the steps. Unlisted versions are signed automatically, usually within minutes.
3. Download the signed `.xpi` AMO gives back and open it in Firefox (any edition). Same add-on id and a higher version, so it updates in place and keeps your settings.

Unlisted add-ons do not auto-update in Firefox (that needs an `update_url` Firefox can fetch without logging in), so repeat steps 1–3 for each new release.

Without signing (Developer Edition / Nightly only): `about:config` → `xpinstall.signatures.required` = `false`, then `about:addons` → gear → Install Add-on From File… → the zip.

### Build and lint locally

```bash
python scripts/build_zip.py
```
```bash
npx addons-linter vivimusic-firefox-ready-to-sign.zip
```
Last result: 0 errors, 20 warnings (upstream `innerHTML` uses, one vendor dynamic import, and the Chrome-only `background.service_worker` key that Firefox ignores).

For quick tests without installing: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json`.

### Repository notes

- Not a GitHub fork (forks of public repos cannot be private), just a repo with `upstream` as a second remote.
- `.github/README.md` is the repo landing page; upstream's `readme.md` is left untouched so merges stay clean.
- `scripts/merge_upstream.py` auto-resolves only routine conflicts: files deleted here on purpose (star gate, `.github/FUNDING.yml`) and `manifest.json` hunks that differ only in `version`. It never commits a file with conflict markers.

---

## Debug helpers (page console on music.youtube.com)

- `viviTest('lyrics' | 'sponsorblock' | 'artwork' | url)` — relays a fetch through the background and logs the HTTP status.
- `viviAutomixStatus()` — logs automix engine state and crossfade state as JSON.
- `Shift + D` — Stats for Nerds HUD.

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Next with crossfade | `Shift + N` or the Next button |
| Stats for Nerds HUD | `Shift + D` |
| Volume ±5% | Mouse wheel over the player bar or artwork |

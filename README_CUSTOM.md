# Vivimusic Web+ — maintainer notes

> **Credits.** Vivimusic Web is created by **[Archimetrix](https://github.com/Archimetrix)**, and the large majority of this code is theirs: the theme, Canvas / Apple artwork, lyrics, Kawarp, Spotify, Last.fm, the popup and the crossfade core. Huge thanks to them for building it. This fork adds a Firefox port, an Edge / Chrome build, Automix (from BitChord), crossfade fixes, ListenBrainz and extra lyrics providers on top. Upstream's code stays under upstream's licence ([LICENSE.txt](LICENSE.txt)); it is not relicensed by this fork.

The landing page for the repo is [`.github/README.md`](.github/README.md); these are the notes for maintaining it. Fork of [Archimetrix/VIVIMUSIC_WEB](https://github.com/Archimetrix/VIVIMUSIC_WEB) v10.2.0 (GitHub and AMO), built for Firefox (142+) and Edge / Chrome, with extra features ported from [BitChord](https://github.com/ayhamo/BitChord) and [heydavidf/automix](https://github.com/heydavidf/automix).

- Name **Vivimusic Web+** (renamed from "Vivimusic Web" on 7 Nov 2026, so it can't be mistaken for upstream), repo `ayhamo/vivimusic-automix` (renamed from `vivimusic-firefox` the same day)
- Manifest V3, version `10.2.0`, gecko id `vivimusic-automix@ayhamo` (was `vivimusic-web@custom` until 7 Nov 2026, when the add-on was re-created on AMO under the new name). Don't change it again: Firefox and AMO treat a new id as a different add-on, and its settings would be lost
- Firefox port pieces are taken from upstream's own AMO build (`vivimusicweb-10.1.1.xpi`), which is a separate port of the same version; the GitHub repo only holds the Chrome source.

---

## Status (Firefox 159 checked on 2026-11-03, Edge on 2026-11-07)

| Feature | State |
|---|---|
| Background page, fetch relay, SponsorBlock, lyrics, theme, popup | Working |
| Crossfade on natural song end | Working (alignment 1.000, 6 s mix) |
| Crossfade on manual skip (Next button / Shift+N) | Working (alignment 1.000 on click and Shift+N, no double skip); falls back to a plain skip when alignment is weak or the tail is not ready in 1.5 s |
| Automix blend | Working in Edge: 16-bar blends with the next song time-stretched, beat lock within 1-3 ms; finished on every pair tested (7 Nov) |
| Automix loop mix | Working in Edge: Levels → One More Time with the synced-lyrics check (4-bar loops, 126→123 BPM, 19.3 s), YouTube's player took over on time. In Firefox it is planned the same way, but the automated test browser's player stalls before the hand-over |
| Analysis cache and Clear button | Working (Edge: 17 songs → 0) |
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
27. **New: Edge / Chrome build.** `scripts/build_zip.py` builds two zips from the same code: `vivimusic-automix-firefox.zip` and `vivimusic-automix-edge-chrome.zip` (Edge and Chrome; one build for both, MV3). The Chromium manifest is derived from manifest.json at build time: service worker only, `declarativeNetRequestWithHostAccess` instead of blocking `webRequest`, no Firefox settings, no upstream `key` (so the ID never clashes with upstream's store add-on). In Chrome the background loads `fx-headers.js` too (keep-alive and the `VIVI_FETCH` proxy; its Firefox-only header rewrite skips itself) and registers session rules for Apple's and Spotify's Origin/Referer (only for the extension's own requests). Releases carry both zips (`-firefox.zip`, `-edge-chrome.zip`). Install in Edge/Chrome: unzip, Developer mode, Load unpacked; to update, replace the folder's contents and press Reload.
28. **Update check points to this fork.** `REPO` in background.js is `ayhamo/vivimusic-automix`. The version is read from the release title ("Vivimusic Web+ 10.2.0.12 (…)"), because the fork's tags carry upstream's version. While the repo is private, GitHub answers the unauthenticated check with 404; the popup then says so and links to the Releases page.
29. **New: refresh button in the tab bar.** A circular-arrow button sits above the "i" next to the Lyrics tab and runs "Refetch from other providers" without opening the info panel (spins while working, flashes red if no other provider has lyrics). The panel's button has the same icon.
30. **Normal songs got plain or wrong lyrics.** The song length used by the lyrics timing check was read from `<video>` the moment the title changed: during an ad that is the ad's length, right after a song change it can still be the previous song's. Correct synced lyrics were then rejected as "implausible" and a plain result won. `resolveSongDuration()` in lyrics-ui.js now waits until no ad is showing and the video length agrees with the player bar's (`#progress-bar` aria-valuemax), and refetch re-reads it.
31. **First song from a library playlist: blank tab bar, no lyrics (Firefox).** Started from a playlist row, YT Music can draw the player tabs with empty labels and fill the names in later. The tab-icon CSS hid the (empty) labels and no icon was added, so the bar looked blank, and the Lyrics auto-switch could not find a tab named "Lyrics". Now the label is hidden only on tabs that already have their icon, the icon observer also reacts to text filled in place (`characterData`), and `findTabByLabel('lyrics')` falls back to the 2nd tab while all labels are empty.
32. **Skip with crossfade could replay a bit of the old song.** Two guards in crossfade.js: the hand-over alignment searches ±0.75 s around the expected spot first (shorter than a bar, so a repeated earlier bar can't win) and only then the old ±3 s; and the player is faded back in during a skip blend only once its position looks like the start of the new song (YouTube can switch the title before the `<video>` really plays the new song). Measured alignment error: 1–2 ms in Edge, 12–34 ms in Firefox. Ideas from BitChord's AutoDJ (one finisher per transition, which ours already had).
33. **ListenBrainz card showed the Last.fm icon.** The home card now has its own `icons/popup/listenbrainz-static.png` (headphones in the card's ListenBrainz orange) and `popup-ui.js` no longer falls back to the Last.fm icon.
34. **Arabic / Hebrew lyrics were laid out left to right.** Not a provider problem: there was no right-to-left handling. `populateLine()` in lyrics-ui.js now marks a line `.vivi-lyrics-rtl` + `dir="rtl"` when its first letter is Arabic, Hebrew, Syriac, Thaana or NKo (the romanized sub-line stays `dir="ltr"`). In canvas.css "left" alignment means "where the line starts", so those lines sit on the right (also in Apple Music and Smooth zoom, which force start alignment), "right" puts them on the left, and zoom grows from their start; word spacing uses `margin-inline-end`, so gaps fall between words and background vocals `(…)` end up at the end of the line. Their karaoke fill is mirrored: a 270deg gradient, and `fillPos()` swaps the positions (0% = unsung, 100% = sung). Glow and Bounce have no gradient and are untouched; Fluid already skips letter-splitting for joined scripts (`FLOW_SAFE`). Checked in Firefox with the real canvas.css for Apple Music, centre, right, Smooth zoom and Glow, plus an English line (unchanged).

---

## Automix: how it works now

A port of **BitChord web's** automix (`web/app/src/playback/automix`, itself AutoMix by heydavidf; AGPL-3.0-only).

Files: `src/automix/automix.js` (BitChord's analyzer queue + transition planner), `src/automix/host.html` + `host.js` (hidden extension iframe that runs the worker), `src/vendor/automix/*` (BitChord's analysis worker: essentia + Beat This, ONNX runtime WASM, model), `src/crossfade.js` (the blend and the incoming deck), `src/crossfade-page.js` (downloads, queue, player control), `src/equalizer.js` (the player path's automix filters).

1. Needs **Crossfade on** and the Automix toggle on (Audio playback card).
2. As soon as a song plays, the page world downloads the **whole current song and the whole next song** (the next one read from YouTube Music's queue store, autoplay and repeat-all included) through an app client, like BitChord: VISIONOS (two versions), then ANDROID_VR; Opus then AAC; each URL probed at its end first; one retry later if all fail.
3. Each downloaded song is analysed in full, one at a time, as BitChord's `analyzer.ts` does: essentia over the song at 44.1 kHz (tempo, key, energy, intro end, outro start) and Beat This over its first and last 59 s (the grid it is mixed in on, and the one it is mixed out on). ~18-25 s per song, in the background.
4. BitChord's `scheduleTransition`, in song time: a **blend** whose length is the "Up to N bars" setting shortened for weaker grids, or with **Auto** the BitChord phone's pick (16 beats, 32 when both sides of the join are calm, at most 12 s / 16 s calm / 8 s filter and 40% of the next song, as the largest of 32/16/8/4 bars that fits). Unlike BitChord web (which ended it where the outro begins, rounded back a whole phrase, so a short song lost a third of itself), it **ends on the downbeat a bar before the song ends**, as the phone does (at most 12 s of music skipped); the incoming song starts so that its pre-full-energy phrase lands at the blend's end, **time-stretched to the outgoing tempo** (pitch kept; at most 10% slower or 25% faster). A pair it can't beatmatch gets the **filter mix** (incoming low-passed on its own downbeat, outgoing through a rising high-pass, up to 8 bars). No grid, or the songs not analysed in time: AutoMix's plain **12 s crossfade** in the song's last 12 s. Unit tests: `node --test scripts/test_automix_plan.mjs`.
5. 4 s before the blend, the old song moves to its decoded copy (aligned to what is playing by cross-correlation) and Next is pressed. YouTube's player becomes BitChord's incoming deck: it is seeked (or held paused and started on time) to the planned point, and a servo keeps it on the audio clock by nudging its pitch-preserving `playbackRate` (≤3%, ≤10% while still quiet; a seek past 0.25 s off). Equal-power cross; blend: bass swap over one bar at the midpoint (−12 dB on 8+ bars, −6 dB shorter) and a −8 dB high-shelf cross; after the blend the new song glides back to its own tempo in eight steps over 24 s.
6. The toast slides up when the blend starts (bars, length, BPM, stretch) and turns into "Blend finished" when it ends, then slides down.
7. If the outro can't be had in time, the user's plain crossfade runs instead. A pause, a seek, a skip or an ad during the blend drops it; the song plays on at rate 1. Pausing while YouTube's player is held for the mix (play/pause button in either layout, Space or K) drops the mix and leaves the song paused.
8. **Loop mix** (BitChord's `loopMix.ts` / `loopDeck.ts`): from 100 s before the end (or before the blend is settled, if earlier) both songs are decoded and the bars to loop are picked: the latest instrumental 4/2/1-bar loop in the outgoing song's last 60 s and the earliest one in the incoming song's first 45 s. "Instrumental" is judged as in BitChord: from the song's **synced lyrics** first (the extension's own lyrics providers, the ones turned off in the popup skipped; each line padded 0.15 s before and 0.35 s after, a line with no end lasting to the next line or 10 s at most; a loop must end 0.3 s before the next line; up to 8 s is waited for the lyrics), and only for a song with no synced lyrics from the open-unmix vocal mask (`vocals_umxhq_int8.onnx`, run in the analysis): at most 3% sung and no sung run over 0.2 s. When both are found, the loop mix replaces the blend: the old song crosses onto a **signalsmith-stretch** deck at its loop start and loops; the incoming loop enters bass-cut at the outgoing tempo, one master tempo ramps to the new song's (≤2.5 BPM per bar), the bass swaps mid-ramp, the outgoing loop drains through a rising high-pass, the incoming loop lets go into the rest of its song and YouTube's player (held silent on the clock) takes over two bars later. Music videos never get a loop mix (their audio rarely matches the song), as in BitChord. Most pop pairs still get the blend: a 4-bar loop needs bars with no lyric line near the end of one song and the start of the other.
9. **Analysis cache**: every result is kept in IndexedDB (`vivi-automix` in the extension frame, keyed by video id, versioned), like BitChord's `db.ts`: a song is analysed once (a cached one loads in <0.1 s). The Audio playback card shows how many songs are saved, with a **Clear** button that empties the cache (the popup and the frame share the extension's origin). Decoding for analysis happens in the extension frame, not on YouTube Music's page (the skip stall in Firefox).
10. **Prefer music-only version** (popup, off by default; `src/music-only.js`): flips YouTube Music's own Song/Video switch to Song whenever it shows Video; clicking Video by hand keeps that song a video. It helps only where YouTube Music pairs the video with an album version: a video opened directly by its link (no pair in the queue) just loses its picture, the audio is still the video's.

Measured in Edge, 6 Nov 2026: Despacito → LALA (blend, 16 bars, next song ×0.962) and LALA → Gata Only (blend, 16 bars, ×0.914): beat lock within 1-3 ms through the blend after the first second. Edge, same day: Levels → LoopeDe loop mix (4-bar loops, 131→126 BPM, 12 bars, 26.2 s; vocal-mask limits loosened in the test copy so a pair qualified): the new song's player took over at 11.4 s (planned 11.47 s), no abort. Edge, 7 Nov 2026, synced-lyrics check (normal limits): Levels → One More Time loop mix (4-bar loops at 182.87 s and 1.38 s, "no lyric line" on both sides, 126→123 BPM, 8 bars, 19.3 s): YouTube's player was held and took over, no abort. Seven other radio pairs (Levitating, Moves Like Jagger, Don't Call Me Up, Levels → others) had lyric lines in the way and got the blend, which finished each time. Lyrics for one side and the mask for the other also worked (Levels → a song without synced lyrics). An ad mid-mix and a pause during the hold both dropped the mix cleanly; the Clear button emptied the cache (17 songs → 0). Firefox: downloads, analysis and planning checked; the handover can't be reached there in the signed-out automated browser (YouTube's player stalls at ~0:45-0:50, also without the extension).

---

## How to update (read this first when continuing)

### Where everything lives

| What | Where |
|---|---|
| This fork | private repo `ayhamo/vivimusic-automix` (remote `origin`; was `vivimusic-firefox`, GitHub redirects the old name) |
| Upstream Chrome source | GitHub `Archimetrix/VIVIMUSIC_WEB`, tagged `vX.Y.Z` (remote `upstream`) |
| Upstream Firefox port | AMO `vivimusicxten` (https://addons.mozilla.org/firefox/addon/vivimusicxten/; was `vivimusicweb` until v11). A separate port of each version, **never pushed to GitHub** |
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
When editing the manifest, keep: gecko id `vivimusic-automix@ayhamo`, `data_collection_permissions: none`, `fx-storage.js` first in both isolated content-script groups, `net.js` before `fx-compat.js`, the automix entries and the `'wasm-unsafe-eval'` CSP. `src/background.js` always keeps our side where it conflicts with AMO (upstream's Firefox build deletes the `VIVI_NET_FETCH` relay that `net.js` needs); the script does that automatically.

Then test in Firefox (crossfade, manual skip, automix, lyrics), bump `version` in `manifest.json` (keep three parts, e.g. `10.1.8`), commit and push:
```bash
git push
```

Last synced: GitHub v10.1.1 + AMO 10.1.1 (2026-11-03).

### B. The daily workflow (`.github/workflows/fork-sync-release.yml`)

- Runs every day at 05:23 UTC, or by hand: Actions → "Fork sync and release" → Run workflow (`force` rebuilds and replaces the release even if nothing changed).
- It checks upstream's latest GitHub release, upstream's AMO version and this repo's `main`. When any of them is new, it does part A in the runner (nothing is pushed back), lints, and publishes a **GitHub release** (repo page → Releases) with `vivimusic-automix-<version>-firefox.zip` and `vivimusic-automix-<version>-edge-chrome.zip` attached. Release tag: `fork-<upstream tag>-amo<AMO version>-<fork commit>`.
- A red run means upstream changed something that needs a human (a conflict or new AMO manifest changes) or the linter found errors. Nothing is published; do part A locally to see and fix it.
- A green run after an upstream update only built a release: still do part A locally and push, so `main` has the merge.
- Release version is `<manifest version>.<run number>` (e.g. `10.1.7.3`). AMO refuses a version it has seen before, and the run number makes every build higher. Keep `manifest.json` at three parts.

### C. Sign on AMO and install

The add-on is already on your AMO account (https://addons.mozilla.org/en-US/developers/addons, uploaded as unlisted).

1. Download `vivimusic-automix-<version>-firefox.zip` from the newest release.
2. AMO Developer Hub → the add-on → **Upload New Version** (AMO keeps its own listing name and summary, not the manifest's: they were changed by hand under Edit Product Page → Describe Add-on) → the zip → follow the steps. Unlisted versions are signed automatically, usually within minutes.
3. Download the signed `.xpi` AMO gives back and open it in Firefox (any edition). Same add-on id and a higher version, so it updates in place and keeps your settings.

Unlisted add-ons do not auto-update in Firefox (that needs an `update_url` Firefox can fetch without logging in), so repeat steps 1–3 for each new release.

Without signing (Developer Edition / Nightly only): `about:config` → `xpinstall.signatures.required` = `false`, then `about:addons` → gear → Install Add-on From File… → the zip.

### Build and lint locally

```bash
python scripts/build_zip.py
```
```bash
npx addons-linter vivimusic-automix-firefox.zip
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

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
| Spotify Canvas / lyrics, Last.fm, ListenBrainz | Code paths fixed but not tested (need your accounts) |

---

## What was broken in the previous state, and the fixes

1. **Background never loaded in Firefox.** `background.js` called `importScripts()`, which only exists in service workers; Firefox runs MV3 backgrounds as event pages, so the first line threw and every feature that talks to the background died. Now the manifest's `background.scripts` loads the helpers and `importScripts` is only used when it exists (Chrome).
2. **Upstream's Firefox port merged in** (3-way merge: upstream git v10.1.1 → AMO 10.1.1 build → this fork):
   - `src/fx-headers.js` — blocking `webRequest` for Origin/Referer spoofing (Apple `amp-api`, Spotify), the `sp_dc` cookie on `open.spotify.com` requests, a CSP patch so YouTube Music allows `moz-extension:` frames/images/fonts, the favicon rewrite, a `VIVI_FETCH` proxy and a keep-alive for long background tasks. Replaces the previous agent's DNR cookie hack in `spotify.js`.
   - `src/fx-compat.js` (page-world `getVideoData` helper; its fetch wrapper is skipped because `net.js` already relays fetches), `src/favicon-main.js`, plus the Firefox fixes in `kawarp.js` (half-float FBO), `kawarp-bg.js` (artwork through the background), `loader.js`, `content.js`, `theme.css`, `lyrics-ui.js`.
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

---

## Automix: how it works now

Files: `src/automix/automix.js` (planner), `src/automix/host.html` + `host.js` (hidden extension iframe that runs the worker), `src/vendor/automix/*` (worker, ONNX runtime WASM, Beat This model), `src/crossfade.js` (audio), `src/crossfade-page.js` (MSE capture).

1. Needs **Crossfade on** and the Automix toggle on (Audio playback card).
2. ~50 s before a song ends on its own, crossfade.js asks the page world for the buffered outro; it retries until YouTube has buffered to the end (it buffers ~30–40 s ahead).
3. The outro (mono, 22.05 kHz) goes to the Beat This model in the hidden extension frame. Firefox refuses Workers started from a content script with an extension URL, hence the frame.
4. `planMix` picks 4/8/16 bars (auto: by grid confidence, capped at 30 s) and the latest downbeat that lets the whole blend finish before the song ends.
5. At that downbeat (minus the learned next-song start delay) the normal crossfade hand-over runs with the longer length, plus a bass swap at the midpoint (outgoing low-shelf cut, incoming restored within one beat). The toast shows bars, length and BPM.
6. If anything fails (weak grid, analysis too slow, missed downbeat), that song gets the normal crossfade instead.

The next song's tempo is **not** matched: its audio is not available before YouTube's own player starts it.

First analysis after page load takes ~15–20 s (model load); there is enough lead time for that.

---

## Syncing with upstream (read this first when continuing)

Upstream ships **two separate codebases for each version**, and both have to be pulled in:

| Source | What it is | Where |
|---|---|---|
| GitHub `Archimetrix/VIVIMUSIC_WEB` | Chrome source, tagged `vX.Y.Z` | `git fetch upstream --tags` |
| AMO `vivimusicweb` | Firefox port of the same version; **never pushed to GitHub** | https://addons.mozilla.org/firefox/addon/vivimusicweb/ |

Steps for a new upstream version:

1. `git fetch upstream --tags`, then `git merge vX.Y.Z` (Chrome-side changes; star-gate files stay deleted).
2. `python scripts/sync_upstream_firefox.py` (dry run), then `--apply`. It downloads the current AMO build and 3-way merges every file (base = upstream tag, theirs = AMO, ours = this tree). If AMO is ahead of or behind GitHub, pass `--tag`.
3. Apply the printed `manifest.json` differences by hand. Keep: our gecko id `vivimusic-web@custom`, `data_collection_permissions: none`, `fx-storage.js` first in both isolated content-script groups, `net.js` before `fx-compat.js`, the automix entries and the `'wasm-unsafe-eval'` CSP.
4. Expected, deliberate conflict: `src/background.js`. Upstream's Firefox build deletes the `VIVI_NET_FETCH` relay at the end; keep ours (`net.js` depends on it).
5. Test in Firefox (crossfade, manual skip, automix, lyrics), bump `version`, `python scripts/build_zip.py`, lint.

Last synced: GitHub v10.1.1 + AMO 10.1.1 (2026-11-03).

### Repository and CI

- Private repo `ayhamo/vivimusic-firefox`; remotes: `origin` = that repo, `upstream` = `Archimetrix/VIVIMUSIC_WEB`. Not a GitHub fork (forks of public repos cannot be private). `.github/README.md` is the repo landing page; upstream's `readme.md` is left untouched so merges stay clean.
- `.github/workflows/fork-sync-release.yml` (daily 05:23 UTC + manual "Run workflow", with a `force` option) does steps 1–2 and 5 above in the runner and publishes a release tagged `fork-<upstream tag>-amo<AMO version>-<fork sha>`. Nothing is pushed back to `main`; when a release succeeds after an upstream update, run the same merge locally (`python scripts/merge_upstream.py <tag> --commit`, then `python scripts/sync_upstream_firefox.py --apply`) and push it.
- `scripts/merge_upstream.py` auto-resolves only the routine conflicts: files deleted here on purpose (star gate, `.github/FUNDING.yml`) and `manifest.json` hunks that differ only in `version`. Anything else fails the run.
- Release version is `<manifest version>.<run number>` (AMO needs a higher version on every upload), so keep `manifest.json` at three parts (`10.1.7`).
- Signing: add repo secrets `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (AMO Developer Hub → Manage API Keys) and the release gets a signed `.xpi`; without them it ships the unsigned zip.

---

## Debug helpers (page console on music.youtube.com)

- `viviTest('lyrics' | 'sponsorblock' | 'artwork' | url)` — relays a fetch through the background and logs the HTTP status.
- `viviAutomixStatus()` — logs automix engine state and crossfade state as JSON.
- `Shift + D` — Stats for Nerds HUD.

---

## Build, lint, load

```bash
python scripts/build_zip.py
npx addons-linter vivimusic-firefox-ready-to-sign.zip
```

Last result: 0 errors, 20 warnings (upstream `innerHTML` uses, one vendor dynamic import, and the Chrome-only `background.service_worker` key that Firefox ignores).

Load for testing: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json`.
Upload for signing: AMO Developer Hub → submit unlisted. Bump `version` in `manifest.json` for every upload (stay on the `10.1.x` line).

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Next with crossfade | `Shift + N` or the Next button |
| Stats for Nerds HUD | `Shift + D` |
| Volume ±5% | Mouse wheel over the player bar or artwork |

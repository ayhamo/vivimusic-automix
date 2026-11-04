# Test plan — every feature, by hand

About 60–90 minutes for everything. Do it in order: later parts assume earlier ones work.
Tick each box; anything that fails, note the step number, what you saw, and the console lines (see "Before you start").

Settings are in the popup (toolbar icon): **Artwork, Audio playback, Lyrics, Appearance, Spotify Canvas, Last.fm, ListenBrainz, Updates**.

## Before you start

- [ ] Install the newest release zip (sign it on AMO, open the signed `.xpi`). `about:addons` shows Vivimusic Web with the new version.
- [ ] Open https://music.youtube.com, press **F12 → Console**, type `Vivi` in the filter box. Our lines start with `[ViVi` / `[Vivi`.
- [ ] Known harmless noise you can ignore: `Content-Security-Policy: (Report-Only…`, `[Vivimusic] CSP blocked: img-src data`, `OpaqueResponseBlocking`, `Source map error`, and any `TIMEOUT waiting for …` from `moz-extension://…/js/content.js` (another add-on).
- [ ] Press **Shift + D** to show the Stats HUD (bottom left). Keep it on; it shows crossfade / automix state live.

## 1. Basics

- [ ] 1.1 Tab title, tab icon, top-left logo and the sidebar's Upgrade entry are YouTube Music's own; no loading splash.
- [ ] 1.2 Dark glassy theme is on. Appearance → Theme off/on switches it live.
- [ ] 1.3 Popup opens on the card grid; no donation footer, no warning-triangle button.
- [ ] 1.4 Every card opens its page and the back arrow returns.
- [ ] 1.5 Close and reopen Firefox: settings you changed are still set.

## 2. Artwork and backgrounds

Test songs: **Zara Larsson – Midnight Sun**, **The Weeknd – Blinding Lights** (both have animated art).

- [ ] 2.1 Artwork → Apple Music Animated Artwork on: the big cover plays a moving video within a few seconds.
- [ ] 2.2 Minimise the player to the bar and reopen: the animation comes back, corners rounded, no square edges.
- [ ] 2.3 A song with no animated art shows the normal cover (no black box).
- [ ] 2.4 Image-only mode on: covers stay still; off again: animation returns.
- [ ] 2.5 Fluid Background (Kawarp) on: the page background is the cover, blurred and slowly moving. Appearance sliders (opacity, warp, blur, saturation, brightness, speed) change it live; Reset restores defaults.
- [ ] 2.6 Pause when inactive: switch to another tab for 10 s, come back — background resumes.
- [ ] 2.7 Appearance → Vinyl disc artwork on: cover becomes a spinning record; pause → tonearm lifts, play → returns. Vinyl shine on/off. Turn vinyl off again (it disables animated art while on).
- [ ] 2.8 Player tabs: icons only on/off swaps the Up next / Lyrics / Related labels for icons.
- [ ] 2.9 Apple Artist Art & Palette on: no visible errors; colours may shift slightly per artist.
- [ ] 2.10 Artwork Cache card: lists songs you played with their art; export works; clear empties it, and the art loads again on the next play.

## 3. Spotify Canvas

- [ ] 3.1 Log in to open.spotify.com in this Firefox. Popup → Spotify Canvas → **Connect**: shows connected (masked id).
- [ ] 3.2 "When both are available, prefer" → **Spotify**. Play Midnight Sun: the Spotify Canvas (short looping clip) plays on the cover.
- [ ] 3.3 Switch preference back to Apple: the Apple animation shows instead.
- [ ] 3.4 Disconnect: status shows not connected; Apple art still works.

## 4. Lyrics

- [ ] 4.1 Synced Lyrics on, Auto-open Lyrics tab on: a normal song opens the Lyrics tab, lines highlight in time; word-by-word on songs that have it (e.g. Midnight Sun).
- [ ] 4.2 Click a lyric line: playback jumps there.
- [ ] 4.3 Provider list (Lyrics → providers): turning off the provider shown at the bottom of the lyrics makes another one load on the next song. LyricsPlus, Paxsenix, Genius toggles exist.
- [ ] 4.4 Customize provider priority: set a top 3, play a new song, the lyrics credit one of those three when they have it.
- [ ] 4.5 Offset panel (the timing control on the lyrics): ± moves the highlight; it is remembered for that song.
- [ ] 4.6 Romanization on with a Korean or Japanese song: romanized line appears under the original. Languages to romanize toggles work.
- [ ] 4.7 Alignment, highlight animation and font change live.
- [ ] 4.8 A music video (not an audio track): with "Show lyrics for video songs" off you get the notice; on → lyrics load.
- [ ] 4.9 A song with no lyrics anywhere: the dancer appears (if enabled).
- [ ] 4.10 A messy YouTube title like `Artist - Song (Official Video) [4K]` still finds lyrics.

## 5. Audio: equalizer, volume

- [ ] 5.1 Audio playback → Equalizer on: low / mid / high sliders audibly change the sound; off → flat again.
- [ ] 5.2 Mouse Wheel Volume on: scroll over the player bar or big cover → volume moves 5% per step and the YT Music volume slider follows. Off → scrolling scrolls the page.

## 6. Crossfade

Crossfade on, length 6 s, both "on manual skip" and "on auto-advance" on, **Automix off** for this section.

- [ ] 6.1 Natural end: in a playlist, seek to ~25 s before the end. Console: `requesting tail` → `alignment score: 0.9…/1.000` → `handover done` → `mixing for 6.0 s`. You hear both songs overlap, no gap, no click.
- [ ] 6.2 Manual skip, Next button mid-song: `manual skip: asking for the tail` → `mixing`. Old song fades out under the new one. Skips **one** song.
- [ ] 6.3 Manual skip, **Shift + N**: same as 6.2, one song only (no double skip).
- [ ] 6.4 Skip twice quickly (second press ~3 s after the first): both blend or the second skips cleanly; never stuck.
- [ ] 6.5 Pause during a blend: everything stops cleanly (`aborted crossfade paused`), play resumes the new song.
- [ ] 6.6 Repeat-one on: the song restarts without a crossfade.
- [ ] 6.7 Turn "on manual skip" off: Next skips instantly. Turn "on auto-advance" off: songs end with a normal cut.
- [ ] 6.8 Crossfade length slider: 3 s and 12 s both work (`mixing for 3.0 s` / `12.0 s`).

## 7. Automix

Automix on, bars **Auto**. Use dance/pop tracks; seek to ~70 s before the end so it has time to analyse.

- [ ] 7.1 HUD: `Automix · waiting/analyzing` → `ready · 128 BPM … 8 bars / 15.0 s from 3:12` (numbers vary). Console: `planned 8 bars … starting on the downbeat`.
- [ ] 7.2 At the planned time: toast **Automix · 8 bars · 15.0 s · 128 BPM**, the blend starts on a beat and lasts the shown time; halfway the bass of the old song drops out and the new song's comes in.
- [ ] 7.3 Half-time songs (e.g. Zeddy Will – Bow Bow Bow, Stereo Love): HUD shows ~130 BPM (not 65) and the console says `(detected 65.x)`; it mixes instead of `fallback`.
- [ ] 7.4 Bars set to 4 / 8 / 16: the planned length changes (16 bars is capped at 30 s).
- [ ] 7.5 A song with no clear beat (ballad, spoken intro): HUD `fallback` with a reason, then a normal 6 s crossfade still happens.
- [ ] 7.6 Lyrics during an automix blend: the old song's lyrics keep going until halfway, then the new song's lyrics take over.
- [ ] 7.7 First analysis after opening the page can take ~15 s; later ones are faster. If the HUD says `analysis too slow`, note the song.

## 8. SponsorBlock

- [ ] 8.1 Skip non-music sections on. Play a music video known for a talking intro: console `[Vivi:SponsorBlock] N non-music segment(s)` and the intro is skipped. Lyrics stay in time after the skip.

## 9. Scrobbling

- [ ] 9.1 Last.fm: log in from the popup, Send Now Playing on. last.fm/user/you shows "Scrobbling now" within a few seconds of a song starting.
- [ ] 9.2 After half the song (or the minutes you set) the scrobble appears in your history once.
- [ ] 9.3 Send Likes/Unlikes on: like a song in YT Music → it is loved on Last.fm; unlike → unloved.
- [ ] 9.4 ListenBrainz: paste your user token, Connect shows your name. Now playing appears on listenbrainz.org; the listen appears after half the song.
- [ ] 9.5 Disconnect both; no more scrobbles.

## 10. Spotify → YouTube Music playlist transfer

- [ ] 10.1 With Spotify connected and YT Music logged in, open the transfer page from the popup. Both accounts show.
- [ ] 10.2 Transfer one small playlist: progress runs, a new YT Music playlist appears, the summary lists any songs not found. Stop works mid-transfer.

## 11. Optimized & resource saving mode

- [ ] 11.1 Turn it on: animated art, Kawarp, equalizer/crossfade, scrobbling and SponsorBlock pause (the popup shows notices). Turn it off: they come back.

## 12. Updates

- [ ] 12.1 Popup → Updates shows the installed version.
- [ ] 12.2 Next release: install the newer signed `.xpi` over the old one — it updates in place, settings and Spotify/Last.fm logins stay.

## 13. Repo and automation (on GitHub)

- [ ] 13.1 Actions → "Fork sync and release" → Run workflow: green, and a new release with a zip appears under Releases.
- [ ] 13.2 Run it again without changes: it says `already released, nothing to do`.
- [ ] 13.3 Locally: `python scripts/sync_upstream_firefox.py` prints `nothing new from upstream` and exits 0.

## Reporting a problem

Send: the step number, the song, a screenshot with the HUD (Shift + D) visible, and the console lines filtered by `Vivi`. For automix also run `viviAutomixStatus()` in the console and send its output.

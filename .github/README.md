<div align="center">

<img src="../icons/icon128.png" alt="Vivimusic Web+" width="96" height="96" />

# Vivimusic Web+

**YouTube Music with Automix: beatmatched blends and loop mixes between songs, on top of Vivimusic Web's synced lyrics, Canvas artwork, crossfade and scrobbling.**

Firefox and Edge / Chrome · Manifest V3 · based on Vivimusic Web 10.2.0

</div>

---

Vivimusic Web is made by **[Archimetrix](https://github.com/Archimetrix/VIVIMUSIC_WEB)**, and most of this code is theirs: the theme, Apple and Spotify Canvas, lyrics, the popup, Last.fm, the playlist transfer and the crossfade core. This fork adds a Firefox port, Automix ported from [BitChord](https://github.com/ayhamo/BitChord), and a set of fixes. Upstream's own README, describing the base features, is [`readme.md`](../readme.md).

## What this fork adds

### Automix (from BitChord)
- **Whole songs downloaded early.** As soon as a song plays, the current and the next song in the queue are downloaded and analysed in the background: tempo, key, beat grid (Beat This!), intro and outro, and the sung parts.
- **Blend.** Over the end of the song, finishing a bar before it ends, the next song comes in time-stretched to the current tempo, locked to the beat. The bass swaps at the midpoint, and afterwards the new song glides back to its own tempo.
- **Loop mix.** When both songs have clean instrumental bars (judged from synced lyrics, or from a vocal model when there are none), the old song loops 4/2/1 bars while the new one enters, and the tempo ramps across.
- **Filter mix** for pairs that can't be beatmatched, and a plain 12 s crossfade when nothing better is possible.
- **Blend length.** Auto picks 4 or 8 bars per pair by the BitChord phone's rules (8 only when both sides are calm, never over 12-16 s); or "Up to 4 / 8 / 16 / 32 bars", BitChord web's setting.
- **Analysis cache.** Each song is analysed once. The Audio playback card shows how many are saved and has a **Clear** button.
- A toast shows each mix (bars, length, BPM) and "Blend finished". A pause, seek, skip or ad during a mix stops it cleanly.

### Firefox and Edge / Chrome
- Runs in Firefox 142+ (event-page background, Firefox's header handling) and in Edge / Chrome from the same code.
- Releases come from a daily workflow that merges upstream's GitHub and AMO releases, then builds and lints both zips.

### Fixes and smaller additions
- Crossfade on manual skip without double skips or replayed audio; full audio capture.
- ListenBrainz scrobbling actually works, with its own popup card.
- Lyrics: provider priority honoured, extra providers, a refresh button next to the Lyrics tab, right-to-left layout for Arabic and Hebrew, correct timing after ads.
- Canvas and artwork: pause with the song, sturdier Apple animated-art lookups, failed lookups no longer cached, a choice of where the Spotify Canvas plays.
- Spotify Connect and Disconnect fixed (Disconnect no longer logs you out of Spotify).
- **Prefer music-only version** (off by default): switches music videos to their song version when YouTube Music has one.
- Title cleaner, mouse-wheel volume, Apple Music artist colours, a Stats for Nerds HUD (Shift+D), and no donation links in the popup.
- Firefox robustness: storage reads that retry, a CSP-safe analysis worker.
- Update check points at this fork's releases.

The full list, with the reasons for each change, is in [`README_CUSTOM.md`](../README_CUSTOM.md).

## Install

Get the zips from this repo's **Releases**.

**Firefox.** Upload `vivimusic-automix-<version>-firefox.zip` at [addons.mozilla.org → Developer Hub](https://addons.mozilla.org/en-US/developers/addons) → Vivimusic Web+ → Upload New Version (self-distributed). Install the signed `.xpi` it gives back. Firefox keeps your settings across versions because the add-on id stays `vivimusic-automix@ayhamo`.

**Edge / Chrome.** Unzip `vivimusic-automix-<version>-edge-chrome.zip`. Open `edge://extensions` (or `chrome://extensions`), turn on Developer mode, then Load unpacked → the folder. To update, replace the folder's contents and press Reload.

Then open the popup → **Audio playback**, turn **Crossfade** on, and turn on Automix.

## Staying in sync with upstream

`.github/workflows/fork-sync-release.yml` runs daily (and on demand). Inside the runner it merges upstream's newest GitHub release and AMO Firefox build, lints, and publishes both zips as a release. When a merge needs a person, the run fails and nothing is published. Upstream's original Firefox build is kept in `upstream-amo/` for reference.

## Building

```bash
python scripts/build_zip.py
```

This builds `vivimusic-automix-firefox.zip` and `vivimusic-automix-edge-chrome.zip` in the repo root. How upstream is merged, released and signed is in [`README_CUSTOM.md`](../README_CUSTOM.md#how-to-update-read-this-first-when-continuing).

## Credits

- [Archimetrix](https://github.com/Archimetrix/VIVIMUSIC_WEB): Vivimusic Web
- [BitChord](https://github.com/ayhamo/BitChord): the Automix engine this ports
- [heydavidf/automix](https://github.com/heydavidf/automix): the earlier automix approach
- Automix runs on essentia.js, Beat This!, ONNX Runtime Web, the open-unmix vocals model and signalsmith-stretch. The other bundled components are listed in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

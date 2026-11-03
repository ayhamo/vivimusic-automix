# Vivimusic Web — Firefox fork

Private fork of **[Vivimusic Web](https://github.com/Archimetrix/VIVIMUSIC_WEB) by [Archimetrix](https://github.com/Archimetrix)**, the extension that reskins YouTube Music with Apple Music–style Canvas artwork, synced lyrics, an equalizer and crossfade. All credit for the extension itself goes to them, and their code stays under their licence ([LICENSE.txt](../LICENSE.txt)).

This fork packages it for Firefox and adds:

- **Firefox that actually works:** background page loading, upstream's own AMO Firefox port merged in, retrying storage reads, a CSP-safe analysis worker
- **Automix:** on-device Beat This model finds the outgoing song's tempo and downbeats, then blends over 4/8/16 bars starting on a downbeat, with a bass swap
- **Crossfade fixes:** audio capture without holes, crossfade on manual skip (Next button / Shift+N) without loops or double skips
- **ListenBrainz** scrobbling, **LyricsPlus / Paxsenix / Genius** lyrics providers, title cleaner
- Mouse-wheel volume, Apple Music artist colours, Stats for Nerds HUD (Shift+D)
- No donation links in the popup

## Install

Grab the newest release from this repo's **Releases**:
- signed `.xpi` (when AMO signing secrets are set): open it in Firefox
- unsigned zip: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on, or upload to AMO as unlisted to sign it

## Staying in sync with upstream

`.github/workflows/fork-sync-release.yml` runs daily (and on demand). It merges upstream's newest GitHub release and AMO Firefox build into this fork inside the runner, lints, builds, optionally signs on AMO, and publishes a release. If a merge needs a human, the run fails and nothing is published.

Everything else — what changed and why, how automix works, the manual sync steps, build and debug notes — is in **[README_CUSTOM.md](../README_CUSTOM.md)**.

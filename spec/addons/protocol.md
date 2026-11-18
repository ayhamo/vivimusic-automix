# Addon protocol (BitChord-compatible)

What the extension and the phone app send to and expect from a music addon. It is BitChord's protocol as of v1.9.2 (a2d886e6), so BitChord addons, including our three TorBox addons, work unchanged. Source: `research/BitChord.md` part 2 in the comparison folder, checked against BitChord's code. Where this file and BitChord differ, the difference is marked **(ours)**.

An addon is an HTTP(S) server with three GET endpoints that return JSON. Parse leniently: ignore unknown keys, allow nulls, coerce values.

Regular expressions here are JavaScript's: `\s` matches Unicode white space, while `\w`, `\d` and `\b` are ASCII only. A port in another language must match that. In Java/Kotlin, `\s` is ASCII unless `UNICODE_CHARACTER_CLASS` is on, and that flag also widens `\w`, `\d` and `\b`; so spell out the Unicode spaces in place of `\s` instead.

## 1. Requests, all endpoints

Headers:
- `Accept: application/json`
- A browser User-Agent, never BitChord's **(ours, the user's call)**. The developer of tidotido blocks every request whose UA contains "bitchord", at Cloudflare and in the addon, on all his addons; any other agent is fine. On PC nothing is overridden and there is no setting for it (the user's call): the extension's background fetch sends Firefox's own UA. Where a client must set one (the phone), use a browser's, e.g. the BitChord fork's presets: Firefox `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0`, Edge `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0`. Cloudflare may still refuse node by its TLS/HTTP2 fingerprint, so judge an addon from the browser, not node.
- Nothing else: no Origin, no Referer, no cookies (`credentials: omit`), no `bitchordAuth` headers.
- The audio file request sends only the headers the `/stream` answer supplies (§4 `headers`, without any `User-Agent`, `Range` or `Accept-Encoding` of the addon's: one fixed UA, and ours), plus our `Range` where one is used (the probe; a ranged download), always with `Accept-Encoding: identity` (a compressed answer's sizes would be the compressed ones). The Fetch standard adds that header to every request with `Range` (browsers and node alike), so on PC nothing sets it by hand; a client outside fetch (the phone's OkHttp) sends it itself.
- Links hold their owner's token. Wherever a link could show (logs, errors, health, the popup, what the page gets, test output), only its host appears.
- `https` only. Plain `http://localhost` and `http://127.0.0.1` links are allowed on PC for the local mock server in tests; the phone and release builds accept `https` only.

Every search and stream request carries these query parameters, percent-encoded, in this order:
1. Each declared setting default, `key=default`.
2. `quality=`:
   - lossless tier (the best): the user's pick if the manifest still lists it, else the first option;
   - Hi-Res or CD tier **(ours)**: the first option whose value or label names it (`hi-res`, `24-bit`, `192 k`, `96 k`; `CD`, `16-bit`, `44.1`), else (CD) an option called `lossless`, else the first option;
   - other tiers: an exact option match, else the first option containing `low|96|128|min` (LOW) or `high|320|normal|standard` (HIGH), else the first option (LOW: else the HIGH one, else the last option **(ours)**);
   - no quality setting declared: the tier name `LOSSLESS`, `HIGH` or `LOW` (Hi-Res and CD send `LOSSLESS`).
   This overrides any declared quality default.
3. `atmos=`: not sent. The extension and the phone app play stereo **(ours)**. An addon that declares an `atmos` setting (NullBeat: a toggle, default true) gets `atmos=false` in its place, overriding the default **(ours)**.

Timeout: 45 s for the whole call, connect to last byte. That is the one that ends a slow request (BitChord also sets a 60 s read timeout, which the 45 s call limit always reaches first). TorBox-backed addons can take 20–32 s on a cold cache.

## 2. `GET {base}/manifest.json`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | Blank means "not an addon manifest". |
| `name` | string | `id` | Display name. |
| `version` | string | "" | Shown as "name vX". |
| `resources` | string[] | [] | Case-insensitive. Usable when empty or it contains `search`. Non-empty without `search`: unsupported. |
| `settings` | `[{key, default, options:[{value,label}]}]` | [] | Values are JSON primitives, sent as strings. |
| `settings[key=quality]` | | | Its options are the quality picker, shown only with 2+ options. A pick that is no longer listed falls back to the first option. |
| `allowDownloads` | flag | true | false: never used for downloads (phone only; the PC doesn't download). |
| `limits` | `{streamsPerMinute, uncachedPerHour, cachedMarker}` | 5, 60, `cached` | Optional **(BitChord fork)**. See 4a. |
| `checkValidLossless` | flag | false | Ignored **(ours)**: no output-device check, the addon is asked like any other. (BitChord asks it only while a lossless-capable output is connected.) |
| `bitchordAuth` | flag | false | Unsupported: it needs the official, signed BitChord app. Such an addon can't be added ("needs official BitChord"); one already in the list is skipped with that reason, which is not a failure, so there are no retries. |

Flags: a JSON boolean as is; `"1" "true" "yes" "on"` true, `"0" "false" "no" "off"` false; other numbers true when non-zero; anything else the default.

Base URL: trim, strip a trailing `/`, drop a final `*.json` segment, keep everything else including token path segments (`https://host/{token}`). Two addons are the same when scheme and host match case-insensitively and the path matches exactly.

Discovery from a pasted URL: if the path ends in `.json`, try it, then `{base}/manifest.json`; otherwise `{url}/manifest.json`, then the URL. A body with a `resources` array, or `id` plus `name`/`version`, is a manifest. Last resort: `GET {base}/search?q=music`; on success use `{id: base, name: host, resources: [search, stream]}`.

Cache the manifest 10 min and re-read its policy fields before each search and stream.

## 3. `GET {base}/search?{settings}&title=…&artist=…&q={query}`

- `q`: the trimmed query; a blank query sends nothing.
- `title`, `artist`: the queue item's raw title and artist, sent when matching a known song (v1.9.2). Not sent for a typed search.
- Queries, tried in order until one matches (see 7): `"{searchable title} {primary artist}"`, then the title alone.
- Response `{"tracks": [ … ]}`, row order kept. Keep the first 15 rows for matching.

| Row field | Notes |
|---|---|
| `id`, `title` | Required. |
| `artist`, `album` | |
| `duration` | Seconds, may be fractional. |
| `artworkURL`, `albumArtworkURL` | |
| `format`, `audioQuality` | Text the tier is read from: FLAC/ALAC/WAV/hi-res/16- or 24-bit → LOSSLESS; low/128/96/64 → LOW; 320/MP3/AAC/Opus → HIGH. |
| `audioMode`, `audioModes[]`, `atmos`, `isAtmos`, `isAtmosOnly` | Atmos when `atmos`, `isAtmos` or `isAtmosOnly` (NullBeat's flags) is true or the text matches `atmos|dolby|eac3[_-]?joc|ec-?3`. We skip Atmos rows **(ours)**: a different mix from YouTube's stereo track breaks the alignment, and Firefox can't decode E-AC-3. |
| `explicit` | Optional; used by matching when present. |
| `isrc` | Optional, not BitChord. When both sides have one, an equal ISRC is the match **(ours, from Mornye)**. |
| `streamURL` | Optional fallback when `/stream` fails. |

## 4. `GET {base}/stream/{trackId}?{settings}`

`trackId` is percent-encoded as one path segment.

| Field | Notes |
|---|---|
| `url` | `https` only: any other link is a miss (`not https`) and is never probed. (PC tests: plain `http` to 127.0.0.1 or localhost.) |
| `format`; `quality` / `streamQuality` / `audioQuality` | Quality text. |
| `codec` / `fileCodec`; `container` / `containerFormat`; `mimeType` | |
| `manifest` / `mediaType` | `none`, `hls`, `dash`. |
| `encrypted` | Refuse unless false, `"none"` or blank. |
| Atmos | Refuse a stream whose `codec`, `audioMode`, `format` or `quality` reads as Atmos (same pattern as the rows): an addon may answer Atmos for a row that didn't say so **(ours)**. |
| `sampleRate` | Hz; under 1000 means kHz. |
| `bitDepth` | |
| `bitrate` | Over 3000 means bit/s, else kbps. Absent: 320 for HIGH, 128 for LOW. |
| `headers` | Optional object of header name → string (a number is sent as text). Sent with the audio file request (and its probe), and nothing else is. Invalid names, other values, and `User-Agent`, `Range` and `Accept-Encoding` (any case) are dropped. |
| the `cachedMarker` field (default `cached`) | A true flag: the file came from the service's cache and doesn't count against the uncached limit (4a). |
| `error` | Logged; the answer is a miss. |

Transport: from the URL's path extension and the answer's format fields only (`format`, the quality text, `codec`, `fileCodec`, `container`, `containerFormat`, `mimeType`, `manifest`, `mediaType`), never from words inside the host, the query or a token. HLS when the path ends in `.m3u8` or a field has the word `hls` or `m3u8` or contains `mpegurl`; DASH when the path ends in `.mpd` or a field has the word `dash` or `mpd` or contains `dash+xml`; else a progressive file (so `/Dashboard.flac` and `?t=…mpd…` are files). Missing numbers are read from the quality text: `([\d.]+)\s*kHz`, `(\d{1,2})\s*-?bit`, `(\d{2,4})\s*kbps`.

Codec, first that applies: stated codec; container (flac/wav/mp3/aiff); MIME subtype; `flac` if the text says lossless; the URL's extension when it is an audio one (flac, mp3, m4a, aac, ogg, oga, opus, wav, aif, aiff, alac).

On a 404, a blank `url` or an `error`: use the row's `streamURL`, else the next source.

## 4a. Stream limits (BitChord fork)

TorBox-backed addons allow about 5 `/stream` calls a minute and 60 uncached an hour. Per addon, the client counts its `/stream` calls over the last minute and its uncached answers over the last hour, against the manifest's `limits` or those defaults. A call over either count is not made: the row is skipped with "stream limit, free in N s", which is not a failure (health untouched). A cached `/stream` answer (6) costs nothing.

A 429 on `/stream` is not retried. The client learns from it: from then on the per-minute count is the number that got through before it (at least 1), and no `/stream` call goes to that addon until `Retry-After` (default 60 s) has passed.

So `/stream` is never spent on speculation: the look-ahead for the next song is search only (8), and `/stream` is called just before the song is needed.

## 5. Status codes

| Answer | Meaning |
|---|---|
| 2xx with a body | OK. A blank body is an error. |
| 404 | A miss, not a fault. Not logged; next source. (A manifest 404 is an error.) |
| ≥ 500 | Down for now. |
| 429 | Wait `Retry-After` (seconds, may be fractional), else 500 ms << attempt, clamped to 0.5–8 s. After 2 retries give up. Every later request to that addon waits out the same quiet window. On `/stream`: no retry, see 4a. |
| other 4xx | Permanent error. |
| 200 with `error` | A miss. |

## 6. Caching

Identical calls in flight share one request (optional for a client whose cache already covers repeats). Manifest 10 min, search 10 min (key `query|params`, so title and artist are part of it), stream URL 5 min. Empty `tracks` are cached; failures, 404s included, are not. At most 128 entries.

## 7. Matching a YouTube Music song to addon rows

Port of BitChord's TrackMatcher (v1.9.2 web port: `web/app/src/data/match/trackMatcher.ts`). `spec/addons/matcher-cases.json` holds cases with the answers BitChord's own matcher gives; our ports must reproduce them (`scripts/addon_matcher_fixtures.mjs`).

Title:
1. NFKC, lowercase, `&` → "and", CJK brackets → `()`.
2. Up to 3 passes over bracketed asides: neutral (`album version`, `original mix`, `radio edit`), versions (remix, live, acoustic, instrumental, karaoke, cover, edit, version, mix, sped, slowed, part, pt), or context (other words over 2 letters, minus noise: official, video, audio, lyrics, remaster(ed), explicit, deluxe…).
3. Up to 3 passes over ` - ` and `|` tails; keep the head unless the head is just the artist.
4. Strip `feat|ft|featuring|with …`. Drop trailing noise words; trailing instrumental/karaoke/acapella/remix/rmx/nightcore move into versions.
5. Core: CJK titles without spaces and punctuation; otherwise the words joined and folded (`ı` → `i`, NFD, combining marks dropped). Artists are folded the same way.

Score of a row (null = refused):
- Title must match: equal cores, equal romaji, a translation match, or one core containing the other when both are over 3 characters.
- Version sets must be equal (album no-vocal markers count: instrumental, karaoke, acapella, backing, stems).
- Artist: names split on `, & / ; · | 、 ， ×`, and, x, vs, feat, ft, featuring, with. Two names match when one is a contiguous word run of the other. Exact set +25; any shared name +10; none: −30, allowed only when the target is not a video and the lengths agree within 2 s.
- Length: within 3 s +40, within 30 s +15. A row with a shared artist may be up to 90 s off at 0 points (a music video's intro and outro; YouTube doesn't flag videos reliably, so this holds for every shared-artist row). Otherwise refused. Unknown length: 0.
- Album equal after normalising: +35. Explicit flags both known: equal +20, unequal refused. A shared context word: +20. Base 100.
- Ranking: if any accepted row shares an artist, rows without one are dropped. Sort by score; ties keep the addon's order.

Then, before playing a row **(ours)**:
- Length within the user's slack (default 5 s, 0–10) of the YouTube song for playback, ±2 s for downloads. Rows within 3 s are preferred.
- Preview check: refuse a row ≤ 35 s when the song is > 45 s (Mornye), and probe the stream with `Range: bytes=0-0` (4 s timeout). From `Content-Range` or `Content-Length`, max length = bytes·8 / (floor·1000), floor = 200 kbps for lossless, else min(stated kbps, 64). Refuse when that is shorter than the song minus the slack. An unmeasurable file is not refused.
- Open at most 3 rows.

These rules, and the tier, kbps, probe, parameter, stream-answer and base-URL readings, are data in `spec/addons/pick-cases.json`, which every port's tests read.

## 8. Playback

- Look-ahead (both apps): as soon as the next song is known, search the addons for it (FIND: manifest, search, pick; no `/stream`). Call `/stream` and the probe (OPEN) for the playing song when it starts, and for the next song only when the mix or the deck needs it. On PC the background keeps the addon links and the file URLs and gives the page a ticket (`src/addons/bg-addons.js`, `src/addons/page-addons.js`).
- Extension (PC: YouTube-first with a deck switch only; decided 2026-11-17). There is no Direct mode: swapping the `<video>`'s source would break YouTube's player (it plays through MediaSource; seek, next and history depend on it). Instead:
  1. YouTube starts the song as always.
  2. The picked row's file is fetched (FETCH: by the background script, which holds the host permission and the file URL; at most 300 MB, 120 s) and handed to the page as bytes.
  3. Its timeline is fitted to YouTube's own audio (`offset-map.md`). A row that doesn't fit (another edit or master) is refused and the next row or addon is tried.
  4. The stream deck (Phase 2) plays the file on YouTube's clock, YouTube muted underneath, and takes over with a short crossfade. Its level is YouTube's element volume times the source gain (`offset-map.md`, Level).
  5. On any failure mid-song the deck hands back to YouTube, which is at the same spot.
  Progressive files only for now; HLS and DASH rows are skipped. The fit reads YouTube's audio of the song from Automix's download, so on PC addons need Crossfade and Automix on (`src/crossfade.js` addonTick).
- The PC deck (`src/addons/buffer-deck.js`): the whole file, decoded at the audio context's rate (on PC the output device's rate; `decodeAudioData` resamples a 44.1 or 96 kHz file there, the one resample on the way out), played by buffer sources. Every start is on a whole output frame and a whole file sample, so the output is the file's own samples (measured: −152 dB residual against the decoded file).
  - Its place comes from YouTube's output: a tap records what YouTube plays on exact frames, and its last 0.25 s is matched against the file (±0.35 s around YouTube's time). YouTube's time (plus the lead learnt from the last match) is a last resort only: after a seek the lead changes (measured 144 → 31 ms), so the time alone can be 0.1 s off.
  - After a pause, a seek or a stall, the sound goes back to YouTube, the deck waits for 0.4 s of YouTube's new sound in the tap and tries the match up to 4 times, 0.25 s apart, then crosses back (50 ms). Nothing is silent meanwhile.
  - Started by a mix (a take-over), it starts at the mix's schedule (a song position at an audio time) and keeps it: until 1.5 s after the take-over the player's state doesn't move it (the mix seeks and holds the player meanwhile).
- Automix on addon audio (extension): the analysis and the plans stay on YouTube's audio. What plays is the addon's file wherever a copy is ready, every song time mapped through the offset map:
  - the outgoing song's tail is cut from the file; when the deck plays the song, the tail goes on from the deck's own sample at the hand-over (not from where YouTube's copy was found), so deck → tail is sample-exact;
  - the incoming deck of a blend, and both loop decks of a loop mix (a copy that arrives after the loop mix was loaded is loaded into its deck before the mix), play the file;
  - the take-over hands the new song from the incoming deck to the addon deck at the schedule's song position.
  - Filters that are part of the graph at rest (the player's and the tail's high- and low-pass) rest at 0 Hz and Nyquist, which pass the samples through unchanged, and the mix's filter curves end there. 20 Hz / 20 kHz still filtered every song (measured −15 to −30 dB residuals).
  - The loop decks and a glide stretch time, so what they play is the file's sound, not its samples.
- Phone (as built, phone commit 5f16dfe): its own media3 player plays the addon file, with YouTube's player muted underneath as the clock. Resolve and fit happen during the previous song (the look-ahead above, then OPEN and the fit before the hand-over).
  - Clock: the media3 player locks to YouTube's position through `StepClock` (file position = YouTube's time + `offsetSec`); when it drifts or YouTube seeks, it re-locks silently.
  - Start: a prepared song starts on the addon file from 0. A song started cold (nothing prepared) plays on YouTube first while the file is resolved, fitted and silently locked (measured about 3.6–4.3 s after opening), then upgrades mid-song with the crossfade in.
  - Hand-over: a 200 ms crossfade in from YouTube to the addon file; a 30 ms crossfade out back to YouTube (on a failure or a hand-back).
  - Level: YouTube's normalisation gain times the source gain (`offset-map.md`, Level), applied as the player's volume. ExoPlayer's volume is at most 1, so on the phone the level is capped at 0 dB: it only cuts, never boosts (PC can boost up to +6 dB, true peak kept at or under −1 dBTP).
- PC stays deck-only (above).
- Downloads (phone only): only addons with `allowDownloads` not false; a lossy row must be over 256 kbps.

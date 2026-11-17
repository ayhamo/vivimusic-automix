# Addon protocol (BitChord-compatible)

What the extension and the phone app send to and expect from a music addon. It is BitChord's protocol as of v1.9.2 (a2d886e6), so BitChord addons, including our three TorBox addons, work unchanged. Source: `research/BitChord.md` part 2 in the comparison folder, checked against BitChord's code. Where this file and BitChord differ, the difference is marked **(ours)**.

An addon is an HTTP(S) server with three GET endpoints that return JSON. Parse leniently: ignore unknown keys, allow nulls, coerce values.

## 1. Requests, all endpoints

Headers:
- `Accept: application/json`
- `User-Agent: BitChord/v1.9.1`. That is the string the addons are known to accept. Not yet verified how strictly they check it; keep this exact value until someone checks.
- No `bitchordAuth` headers **(ours)**. The manifest field is ignored; an addon that enforces it fails its requests and the normal fallback takes over.

Every search and stream request carries these query parameters, percent-encoded, in this order:
1. Each declared setting default, `key=default`.
2. `quality=`:
   - lossless tier: the user's pick if the manifest still lists it, else the first option;
   - other tiers: an exact option match, else the first option containing `low|96|128|min` (LOW) or `high|320|normal|standard` (HIGH), else the first option;
   - no quality setting declared: the tier name `LOSSLESS`, `HIGH` or `LOW`.
   This overrides any declared quality default.
3. `atmos=`: not sent. The extension and the phone app play stereo **(ours)**.

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
| `allowDownloads` | flag | true | false: never used for downloads. |
| `checkValidLossless` | flag | false | Ignored **(ours)**: no output-device check, the addon is asked like any other. (BitChord asks it only while a lossless-capable output is connected.) |
| `bitchordAuth` | flag | false | Ignored **(ours)**, see 1. |

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
| `audioMode`, `audioModes[]`, `atmos` | Atmos when `atmos` is true or the text matches `atmos|dolby|eac3[_-]?joc|ec-?3`. We skip Atmos rows **(ours)**: a different mix from YouTube's stereo track breaks the alignment, and Firefox can't decode E-AC-3. |
| `explicit` | Optional; used by matching when present. |
| `isrc` | Optional, not BitChord. When both sides have one, an equal ISRC is the match **(ours, from Mornye)**. |
| `streamURL` | Optional fallback when `/stream` fails. |

## 4. `GET {base}/stream/{trackId}?{settings}`

`trackId` is percent-encoded as one path segment.

| Field | Notes |
|---|---|
| `url` | |
| `format`; `quality` / `streamQuality` / `audioQuality` | Quality text. |
| `codec` / `fileCodec`; `container` / `containerFormat`; `mimeType` | |
| `manifest` / `mediaType` | `none`, `hls`, `dash`. |
| `encrypted` | Refuse unless false, `"none"` or blank. |
| `sampleRate` | Hz; under 1000 means kHz. |
| `bitDepth` | |
| `bitrate` | Over 3000 means bit/s, else kbps. Absent: 320 for HIGH, 128 for LOW. |
| `error` | Logged; the answer is a miss. |

Transport: HLS when any of the text says `hls`, `m3u8` or `mpegurl`; DASH for `dash`, `mpd` or `dash+xml`; else a progressive file. Missing numbers are read from the quality text: `([\d.]+)\s*kHz`, `(\d{1,2})\s*-?bit`, `(\d{2,4})\s*kbps`.

Codec, first that applies: stated codec; container (flac/wav/mp3/aiff); MIME subtype; `flac` if the text says lossless; URL extension.

On a 404, a blank `url` or an `error`: use the row's `streamURL`, else the next source.

## 5. Status codes

| Answer | Meaning |
|---|---|
| 2xx with a body | OK. A blank body is an error. |
| 404 | A miss, not a fault. Not logged; next source. (A manifest 404 is an error.) |
| ≥ 500 | Down for now. |
| 429 | Wait `Retry-After` (seconds, may be fractional), else 500 ms << attempt, clamped to 0.5–8 s. After 2 retries give up. Every later request to that addon waits out the same quiet window. |
| other 4xx | Permanent error. |
| 200 with `error` | A miss. |

## 6. Caching

Identical calls in flight share one request. Manifest 10 min, search 10 min (key `query|params`, so title and artist are part of it), stream URL 5 min. Empty `tracks` are cached; failures, 404s included, are not. At most 128 entries.

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

## 8. Playback

- Extension: replace the media source before the song starts ("Direct Source Stream"). No mid-song swap.
- Phone: Direct first. Later the race plus silent-audition upgrade: same recording within the slack, worth swapping (lossless, or at least +96 kbps), at least 20 s left.
- Downloads use only addons with `allowDownloads` not false; a lossy row must be over 256 kbps.

# Shared spec

What the extension (this repo) and the phone app must agree on. The phone app keeps a copy of this folder and a script that checks its copy against this one; this folder is the master.

```
spec/
  automix/
    analysis.schema.json   one song's analysis (beats, downbeats, key, energy, vocals, sections, loudness)
    plan.schema.json       one transition plan (loop mix and blend/filter/crossfade)
    pairs/*.json           5 real song pairs, captured from the extension
    golden/*.json          today's planner's plans for those pairs, engine versions 1 and 2
  addons/
    protocol.md            the BitChord-compatible addon protocol and matching rules
    matcher-cases.json     YouTube song + addon rows → the row the matcher must pick
```

## Automix fixtures

Each pair file holds two songs as the extension saw them: `analysis` (analysis.schema.json, minus the cache flag), `sung` (sung spans from synced lyrics, `[[start, end], …]`, or null when the song had no synced lyrics at capture time), `decodedSec` and `loudness20Hz` (RMS of the decoded audio in 50 ms windows, what the loop planner reads). `listening` says what the transition should sound like: these 5 are the pairs from the comparison report, and pair 2 is the one that must not loop.

Check today's planner against the golden plans:

```
node scripts/automix_fixtures.mjs
```

It loads `src/automix/automix.js` in a sandbox, plans each pair from the playing song's second max(30, duration − 95), and prints `ok` or `DIFF` per pair. After an intended planner change, rewrite the golden files with `--update` and review their diff: the golden files are the baseline the new planner is judged against, so a change there is a change in behaviour.

Every plan carries `curves`: each song's fader, filters, bass and high shelves and rate over the transition, as the engine plays them (the engine takes its shapes from the same planner functions). The overview draws these, so a port that matches the golden curves draws and plays the same transition.

Each song's loudness: `loudness20Hz` (optional in the analysis, used by the overview's waveform; the pair files carry it beside the analysis) and `ytLoudnessDb` (YouTube's own `loudnessDb`, which both decks level against; see analysis.schema.json for where each app reads it and when `perceptualLoudnessDb` is preferred).

Golden plans today: pairs 1 and 2 loop, 3–5 blend. Pair 2's loop is the known bad pick (a 2-bar outgoing loop checked only by the vocal mask); the next planner should not loop it.

### Recapturing a pair

The test Firefox (`~/.claude/firefox-test/bidi.mjs`, with uBlock) has a `capture` scenario: it plays song A, queues song B, waits until both are analysed, then asks the page for the fixture through the debug message `vivi-automix-fixture` (see README_CUSTOM.md, Debug helpers) and writes the pair file.

Lyrics availability changes between captures: a song with synced lyrics one day may have none the next, and then its `sung` is null and the planner falls back to the vocal mask. Compare `sung` before blaming a planner change for a golden diff.

## Addon fixtures

`matcher-cases.json` was filled by BitChord's own matcher (v1.9.2, a2d886e6). A port must reproduce every `expect` block. A JS port runs the script below; a port in another language (the phone app's, from a JVM test) reads `matcher-cases.json` in its own test and checks the same `pick`, `ranked`, `scores` and `rejected`.

```
node scripts/addon_matcher_fixtures.mjs --matcher path/to/trackMatcher.js
```

To check against BitChord itself, export its matcher from the BitChord clone and run it (Node 23.6+ runs the .ts file directly):

```
git -C "../YT Clients/BitChord" show a2d886e6:web/app/src/data/match/trackMatcher.ts > "$TMP/trackMatcher.ts"
node scripts/addon_matcher_fixtures.mjs --matcher "$TMP/trackMatcher.ts"
```

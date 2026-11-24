# Automix: where Original and Advanced differ

Phase 3 builds one engine part by part, keeping the better version of each part.
This lists every place the code branches on the version (`version === 2` in
`src/automix/automix.js`, `m.v2` in `src/crossfade.js`), as of commit 11c69dd.

"Original" (version 1) is BitChord web's automix, the one the plan calls "Web".
"Advanced" (version 2, "Advanced AutoDJ") adds ideas from the BitChord phone app.

**Now (end of Phase 3):** the user picks between two engines. **Classic** is
version 2 (Advanced's planning and sound shape; the loop code is shared, so it
plays Web's loops). **Automix v2** is version 3 (below). Original is retired: a
saved version 1 plays Classic, and the golden files hold only versions 2 and 3.
Version 1's code paths stay until the code audit. The tables below are the
record of how Original and Advanced differed.

## Shared by both (no choice to make)

| Part | Behaviour |
|---|---|
| Loop mix | Same planner (`planLoopMix`), same sung-part check (synced lyrics, else the vocal mask), same schedule and curves (`loopCurves`). The loop on Vaina Loca → SI NO ES CONTIGO comes from here. Its loops sit on the blend's bar lines: rules under "Loop on the blend's bars" below. |
| Which style | Loop mix when the pair has one, else blend, else filter mix, else a plain crossfade of the user's crossfade length (1–12 s; 12 s where the platform has no such setting). |
| Tempo | Only ever speeds up (the slower song is brought up), at most +25% (−10% for the folded case), the playing song ramps 0.75% per beat before the mix-out; half/double time folded. |
| Blend length | Auto (phone rules: usually 4 bars, 8 when both songs are calm, never over 12–16 s) or "up to N bars"; shortened on a weak grid (`effectiveBlendBars`). |
| Fallbacks | Filter mix when a grid is missing or tempos are too far apart; a plain crossfade of the user's crossfade length (12 s without such a setting) without analysis. |
| After the mix | The incoming deck glides back to ×1.0 at 0.25% per 0.25 s; the stream deck (Phase 2) takes over. |
| Where a song is sung | From its synced lyrics, each line only as long as it is sung, with the vocal mask's gaps cut out; else the vocal mask. Rules under "Where a song is sung" below. |
| Analysis length | A song over 8 minutes (480 s) isn't analysed: "too long", its own outcome, not a failure, never retried. It mixes as a song without an analysis does. Rules under "Analysis length" below. |

## Planning: Advanced only

| Part | Original | Advanced | Where |
|---|---|---|---|
| Song end | Mix-out against the song's full length | Against where the music ends (`musicEnd`: trailing silence or applause cut, at most 20 s) | `planFor`, `filterMix` |
| Incoming cue | Lands the next song's pre-full-energy phrase at the blend's end, however far in | Same, but never more than a quarter into the song (`capIncomingSkip`) | `planFor` |
| Vocals | Not considered for blends | Measures how much both songs sing at once (lyrics or vocal mask); moves the blend by up to ±8 bars when another point halves the overlap (`rerouteForVocals`) | `planFor` |
| Key clash | Not considered | Optional toggle: clashing keys get a 2–4 bar blend (`keysClash`) | `planFor` |
| Analysis | `contentEndSec` not needed | Re-analyses cached songs without `contentEndSec` | `get` (line ~195) |

## Sound shape: Advanced only

| Part | Original | Advanced (`djShape`) |
|---|---|---|
| Fader | Equal power (sin/cos) | New song at full level by the bass swap; old song held, then falls after it. A vocal clash moves both towards a vocal-safe pair |
| Bass | Low shelf −12 dB (−6 dB under 8 bars), swapped within one bar at the midpoint | High-pass bass cut (20→200 Hz), swapped in one short step on a bar near the middle |
| Highs (blend) | High shelf ±8 dB cross over the whole blend | Old song closes through a low-pass (20 kHz → 2.2 kHz, lower on a clash); new song opens through a high-pass entry |
| Filter mix | Old: high-pass 20 → 1800 Hz; new: low-pass 350 Hz → open | Old: low-pass 7 kHz → 300 Hz (a muffle) plus bass cut; new: high-pass entry opening by 60–78% |
| Toast | "Automix" | "Advanced AutoDJ" |

## What Phase 3 has to decide by ear

Planning parts: Advanced's are fixes (no silence mixed, no deep skips, fewer
vocal clashes), so the merged engine keeps them unless a test pair says
otherwise. The sound shape is a matter of taste: the listening set (PLAN.md,
Phase 3) is played in both shapes and the user picks per style (blend,
filter mix).

## Automix v2 (version 3): Orchard's pieces on top of Advanced

Advanced's planning and sound shapes stay (`adv()` is true for 2 and 3);
what v2 adds checks `version === 3`, so Original and Advanced plan as before.

| Piece | Rule | Where |
|---|---|---|
| Tempo | Up to 4% apart: a constant stretch as before. 4-8%: a beat-locked geometric glide on both decks, one rate per beat; the playing song starts at x1.0, the next ends at x1.0 (`glideSteps`). Over 8%: no beatmatch | `planFor`, `planLoopMix`; crossfade.js `glideOutgoing`, `deckGlideIn` |
| Sub-bass veto | `subBassRatio` (log10 of 25-60 Hz over 60-250 Hz energy, the song's middle 60%) 0.9 or more apart: no blend or loop | host.js `lowEnd`; `subBassContrast` |
| Beatmatch or do nothing | A pair that can't be beatmatched is never overlapped: a beatless bridge if both songs have 4+ s of beatless edge (`bassCurve`), else a straight hand-over at the playing song's music end (1.5 s fade) | `handoff`, `beatlessBridge` |
| Bass swap | Moved off the middle bar when the playing song is mid-line there, to the nearest clear bar (a quarter to three quarters in) | `vocalSafeSwap`, `djShape` |
| Fallback ladder | A blend both songs would sing over (over 30% after the re-route), or with no intro to sit on: a drop-in (next song at full level on its first downbeat, two bars, exit off a sung line), else a muffle (the playing song closes behind a low-pass, the next fades in before the swap), else the hand-over | `planFor`, `ladderShape` |
| Keys | Orchard's key table (same 1, fifth 0.85, relative 0.95, whole tone 0.65, semitone 0.3, tritone 0, ...) 0.7 of the score, the whole-song pitch profiles' cosine 0.3. Both keys trusted (`keyConfidence` 0.65): under 0.2 no blend or loop (the hand-over), under 0.55 a short blend (2-4 bars). The bridge checks where the songs meet: pitch profiles over 24 s correlated -0.3 or under with both sides tonal | host.js `chromaEvidence`; `harmonicEvidence`, `overlapHarmony` |
| Loudness | Each overlap region's EBU R128 gated loudness against its whole song's (YouTube plays every song at its own normalised level). Over 1 dB apart the louder side is trimmed, at most 6 dB: the playing song down to it by the blend's end, or the next song up from it, on a smoothstep. Blends, drop-ins, muffles and bridges | host.js `loudnessCurve`; `loudnessTrim`, `trimmed` |
| Kick lock | Over the blend and 8 beats either side, both songs' kick onsets (35-140 Hz, every 1 ms) folded into 256 bins of a beat; the next song's cue moves by the shift that lines them up (under an eighth of a beat), when they match 0.5 and 0.2 better than planned. In the engine, from the decoded songs, on the incoming deck only | `kickLock`, `kickSource`; crossfade.js `kickLockFor` |
| Tempo too far apart | Over 8% apart (no beatmatch): the beatless bridge, else a filter mix placed at an anchor, else (both would sing over 30% of the filter mix) an echo out at one, else the hand-over. Rules under the table | `unmatchedMix`, `filterMix`, `echoOut` |
| Adlib outro | A drop-in's exit may cut a voice that sings out: the beat gone over the playing song's last 4 s of music and the voice never pausing 2 s from the exit to there. Rules under the table | `singsOut` |
| No effect three times in a row | An effect move (filter mix, echo out, drop-in, muffle) heard on both of the last two mixes isn't picked for the next one; the next rung is. Rules under the table | `heard`, `avoidedMove` |
| Where the blend sits | From the playing song's own shape, not a fixed bar before its end: candidates over its last min(60 s, 40%) of music, the best by Orchard's score; the rules are under the table | `anchoredMixOut` |
| Loop or blend | A loop mix that passed its gates keeps priority: the blend must beat it by 0.02 (twice Orchard's loop cost). A blend that fell back (hand-over, bridge, drop-in, muffle) never does. Both are scored as Orchard does (x0.82) on what differs: both singing at once (weight 0.15), the keys (weight 0.13; the loop's instrumental bars score 1, a blend lays both songs' chords over each other) and length (weight 0.02). Fixture rule: Vaina Loca → SI NO ES CONTIGO stays a loop, Stereo Love → Midnight Sun is never one | `loopOrBlend`; scripts/automix_fixtures.mjs |

### Where the blend sits

Automix v2's own blend (not a pick from the editor, not a saved window) asks
`anchoredMixOut` where to start; with no candidate that fits it keeps the
natural point (the blend ending a bar before the music ends). The vocal
re-route and the fallback ladder then work from that point as before.
Orchard `pairTransitionEvidence.js` and `earmark/analysis/track.rs`, Prism
`SongShape.outroStartMs` and `MixMoves.outroStartMs`.

1. **The search.** The audible end: the music's end (`contentEndSec`, as
   `musicEnd`), pulled back by half seconds while the last half second is under
   a tenth of the song's usual level (the 85th-percentile second of the
   loudness curve, as amplitude). The search runs from the audible end back
   min(60 s, 40% of the song), never before half the song.
2. **A section change** (the blend ends on it): Orchard's novelty, every half
   second, from the 2 s after against the 2 s before: |energy change| / 1.5 x
   0.55 + |bass change| / 1.5 x 0.25 + |voice change| x 0.2 (energy: the
   loudness curve against the usual level, bass: the bass curve, both capped
   at 1.5; voice: the voice risk). A peak of 0.14 or more counts; peaks under
   4 s apart keep the stronger. Snapped to the nearest downbeat of the end
   grid. Confidence: novelty x 0.65 + grid confidence x 0.2 + steadiness x 0.15.
3. **The outro** (the blend ends on it; Prism finds it): the first second from which
   the energy over 3 s stays under 0.6 of the median second until the audible
   end, at least 6 s of it, at 60% of the song or later and no more than 20 s
   before the audible end. The blend ends on the 16-beat phrase that opens it
   (the phrase at or before 2 beats past it, when that is within a bar of it),
   else on the first beat in it, so the next song is in by the time the
   playing one drops. Prism starts its move there instead; ending there is
   what keeps the mix from coming too late (the master's review, 2026-11-24).
   The outro's music is not counted as cut (rules 5 and 6). Confidence: (1 - the outro's mean / the
   median) x 0.65 + grid confidence x 0.2 + steadiness x 0.15.
4. **The end of the music**: today's natural point, confidence 0.5. **Each
   downbeat** in the search (Orchard's downbeat evidence): confidence
   min(0.6, grid confidence x 0.35 + steadiness x 0.35 + (1 - voice) x 0.3).
5. **The score** (Orchard): source / 4 x 0.2 + confidence x 0.55 +
   steadiness x 0.15 + clean x 0.1 - cut / 12 s x 0.15. Source: a section
   change or the outro 4, the end 3, a downbeat 2. Clean: 1 - the voice risk
   over the blend's last 1.5 s (0.35 unknown). Cut: the audible seconds after
   the blend's end and before the outro's start (to the audible end when the
   song has no outro). Steadiness: 1 - 2 x the spread of the energy's half seconds
   over 2 s (after a change or the outro's start, before an end).
6. **The limits** stay: no blend starting before half the song or before the
   earliest mix-out, none ending past the audible end or within 0.3 s of the
   file's end, none cutting over 12 s of it (rule 5's cut); the blend's length is
   still the planner's (a third of either song at most).
   - **[all]** An anchor moves when the playing song leaves, never how long the
     blend is: a candidate the planner's length doesn't fit at is skipped and
     the next one tried, down to the natural point. Vaina Loca's v2 blend is 2
     bars (4.95 s) for its keys (F# major → C minor, 0.307 < 0.55: a short
     blend), not for its anchor; Classic's is 4 bars.

7. **Phone logs, 2026-11-24.** Before this rule every blend followed
   `naturalMixOut`: the analysed music ends only 0.5-6 s before the file ends,
   so every blend landed at the very end (Vaina Loca: 175.7 - 2.47 - 9.9 =
   163.3, on the downbeat at 160.98 s). What sounded good were the loop mixes,
   which sit on an instrumental bar earlier in the song.

### Tempo too far apart

A pair over 8% apart can't be beatmatched (`V2_MAX_STRETCH`). Until now
Automix v2 handed it over in 1.5 s at the music's end; on the phone 4 of 5
mixes in one listening were that. Now, Automix v2's own plan (not a pick from
the editor, not a length picked), in this order:

1. **The beatless bridge**, when both songs have one (as before).
2. **A filter mix** (no beatmatch; as Classic's): placed by "Where the blend
   sits" with its own length (at most 8 bars), the next song on its first
   downbeat at its own speed. Taken when both sing over 30% of it or less
   (`V2_CLASH_MAX`).
3. **An echo out** (editor.md §5), when both would sing over the filter mix:
   the catch is the bar line at the anchor (the anchor's blend of one beat,
   its end snapped back to a bar line), else the bar line a beat before the
   music's end. The beat before the catch repeats, so it may not be sung
   (voice risk 0.3 or more); then the nearest bars either side, earlier first,
   at most 12 s from it. The echo's 8 beats must end 0.3 s before the file's
   end; the catch's beat starts no earlier than the earliest mix-out, the catch
   past half the song.
   - The vocal check is ours, beyond Prism: Prism's `MixMoves.place` puts the
     catch on the bar line before the music's end with no look at the voice.
     An echo of mid-line words sounds like a stutter. Measured 2026-11-24 on
     Poker Face (pair 5): with "Where a song is sung" four bar lines in its
     last 40 s have an unsung catch beat (the breath before a new line), and
     the echo takes 230.04 s. A catch on a line's last word would add one bar
     line there (203.82 s), which the mask hears as sung, so it isn't allowed.
4. **The hand-over**, when none of these fits.

Fixture rules: Stereo Love → Midnight Sun (11% apart) plays a filter mix;
Unethical → Escapism (24%) and Poker Face → Let Me Love You (19%) play an echo
out (both would sing about half of a filter mix).

### Loop on the blend's bars

Found 2026-11-24 on Vaina Loca → SI NO ES CONTIGO: the loop brought the next
song in on a different drum than the blend did.

1. **[all]** A loop's bars start and end on the same bar lines the blend uses:
   the playing song's end grid (`tailGrid`, else its main grid) and the next
   song's main grid (`firstDownbeatSec` + whole bars of 4 `beatIntervalSec`).
2. **[all]** The beat model's own downbeats (`headBeats`, `tailBeats`) are used
   for a loop's seams only where they sit on those bar lines (within a quarter
   beat). Where too few do, the loop is cut on the grid itself.
3. **[all]** A loop whose incoming bars start on a 4-bar phrase line of the
   next song (counted from its first downbeat, within a quarter beat; `phrase`
   on the loop's `in` side) gets 0.01 added to its score in "Loop or blend".
   Not required: any whole bar on the grid is the same drum.
4. Why: SI NO ES CONTIGO's grid has its downbeats at 6.00 s + 2.40 s × k
   (100 BPM). The model's own list is 6.00, then 7.17, 9.60, 12.00, 14.40 …:
   from 7.17 s on it is 2 beats after the grid. The loop took B's 4 bars from
   9.60 s, 2.5 bars from the blend's cue at 15.60 s (grid bar 4). The listener
   heard B come in on a different drum; the blend's cue sounded right. Now the
   loop takes B from 10.80 s (grid bar 2) to 20.40 s.
5. Fixture rule: in every pair, each loop's start in both songs is a whole
   number of bars on these grids. Vaina Loca's loop (B from grid bar 2) gets
   no phrase bonus and still plays: loop 0.2403 against the blend's 0.1687.

### Where a song is sung

Every planner check that asks whether a song is sung there (both singing in a
blend, a sung catch for the echo out, a drop-in's exit, the loop's bars) reads
the song's sung spans: from its synced lyrics, else the vocal mask. Found
2026-11-24 on the phone: most synced lyrics are plain LRC (a start time per
line), and a line without an end counted as sung up to the next line, 10 s at
most. Nearly every second of a song was "sung" (78-97% of the fixture songs),
and the ladder fell to the hand-over.

1. **[all] A line's sung span.** With word times: the first word's start to
   the last word's end + 0.3 s. Without: the line's start to the earliest of
   the next line's start, the start + its word count x 0.35 s + 0.5 s, its own
   end when the provider gives one, and 10 s. A line with no words is a gap.
2. **[all] The mask still hears gaps.** When the song has a vocal mask there,
   a run of one beat or more (the song's beat; 0.5 s without a grid) with the
   mask under 0.3 inside a sung span isn't sung. So lyrics never mark sung
   what the mask hears as instrumental for 2 s or more. Without a mask there,
   the lyrics stand. Spans that touch or overlap are joined first, so a breath
   across a line change is one gap (half a beat at the end of one line and
   half at the start of the next is a beat).
   - Why the carve matters: word end times are often not measured. Enhanced
     LRC stamps each word's start only; each word then ends where the next
     starts, and the last at the next line's start (lyrics.js
     `repairTimings`). The starts are real (uneven, not spread evenly over the
     line: checked 2026-11-24 on all 7 captured songs with word times, 0 of
     337 timed lines evenly spaced), so word times still count as word times.
     But the spans run back to back: Poker Face's 59 lines have 488 word
     pairs, all contiguous, and 27 lines end on the next line's start. Only
     the carve frees its breaths (the catch beats at 226.005 s and 230.038 s,
     mask 0.02-0.17 there).
3. **[all]** The same spans everywhere: the blend, the ladder, the echo out,
   the bridge, the "where the blend sits" score and the loop mix.
4. **[PC]** `sungSpansFromLines` (line shapes from `lyricLines`), `carveSung`.
   The fixture capture keeps each line's shape only: start, end, word count,
   word times, never its text (`lines` in `pairs/*.json`).
5. Fixtures: each pair is also planned on Automix v2 with its lyrics
   (`v3lyrics`), and with the same lines cut to plain LRC (`v3lrc`). Fixture
   rule: Unethical → Escapism and Poker Face → Let Me Love You don't fall to
   the hand-over with either. Mixed, as live when only the playing song has
   synced lyrics: the next song on its vocal mask, the playing song on its
   captured old-rule spans (`v3mixedOld`), its lines (`v3mixed`) and its
   lines cut to plain LRC (`v3mixedLrc`). Fixture rule: Poker Face → Let Me
   Love You is an echo out in `v3mixed` and `v3mixedLrc`.
6. Measured 2026-11-24 (share of the playing song counted as sung, old rule →
   new; Automix v2's plan with plain-LRC lines, old → new):
   - Vaina Loca 83% → 75%: the loop either way.
   - UNETHICAL 89% → 71%: an echo out → a filter mix, both singing 24%.
   - Bazovyy minimum 93% → 54%: a muffle (31%) → a blend (18%).
   - Poker Face 97% → 68%: a filter mix, both singing 28% → 23%.
   On the PC none of these fell to the hand-over under the old rule either;
   the phone's hand-overs on the same pairs need something more than the spans.

### Adlib outro

Orchard `transitionFlow.js` `singsOut` (:245-262). Some songs end on the singer
alone, ad-libbing over a fading or stopped beat. No exit can wait for that
voice to finish a line: it never pauses, and the song's own end cuts it too.

1. **[all]** A voice sings out from time T when, over the playing song's music
   (from T to its music end, at most its length − 0.3 s):
   - at least 4 s of music are left after T;
   - the beat is gone: beat presence under 0.5 both 2 s and 0.5 s before the
     music's end;
   - the voice never pauses 2 s: walked in 0.25 s steps, no run of 2 s with a
     voice risk under 0.3. With no vocal data it doesn't count as singing out.
2. **[all]** Where it applies: the drop-in's exit (the fallback ladder), which
   otherwise refuses an exit with a voice risk of 0.3 or more over its last
   1.5 s. A voice that sings out from the exit lets that exit stand.

### No effect three times in a row

Prism `MixMoves.pick`. The same effect three mixes running sounds like a trick.

1. **[all]** The moves heard are kept in order, the last 16 (each one when its
   hand-over is reached, so a mix aborted before it doesn't count). A mix's
   move is its shape: filter mix, echo out, drop-in, muffle, loop, blend,
   bridge, hand-over or crossfade.
2. **[all]** When the last two are the same **effect move** (filter mix, echo
   out, drop-in, muffle), Automix v2's own plan skips that move for the next
   mix and takes the next rung of its ladder: a filter mix falls to the echo
   out, an echo out to the hand-over, a drop-in to the muffle, a muffle to the
   hand-over. For a filter mix or an echo out the reason says so ("a filter
   mix the last two times").
3. **[all]** Not effects: the blend, the loop, the bridge, the hand-over and the
   plain crossfade may repeat. A pick from the editor is never changed by this.
4. **[PC]** The list lives in the page and starts empty on each page load.

### Analysis length

Laya 1a1f324b. Analysing a long mix or an hour-long set takes minutes of work
and memory for a song that mixes at its very end, if at all.

1. **[all]** A song over 8 minutes (480 s, `ANALYSIS_MAX_SEC`) isn't analysed:
   the outcome is "too long". It is not a failure: it is never retried, isn't
   saved as an analysis, and isn't logged as an error.
2. **[all]** The length is the queue's length when that is known, else the
   decoded file's (checked right after decoding, before any model runs).
3. **[all]** A "too long" song mixes as a song without an analysis: the plain
   crossfade of the user's crossfade length.
4. Case: analysis-cases.json `too-long-481` (check `tooLong`, not rendered).

Fixture rule: Vaina Loca → SI NO ES CONTIGO's blend under Automix v2 starts at
158.4 s and ends where its outro begins (163.5 s, where the bass drops out); Classic
starts at 160.98 s.
Not taken from Orchard: its beat-entry anchor (the playing song's bass leaving
is in the novelty's bass part) and its length preference (16 beats, then 8,
32, 4): the blend's length stays the planner's.

Simplified from Orchard: the key confidence is the analysis's own key
strength (Orchard's is its key margin); the loop-vs-blend score keeps only the
parts that differ between the two (Orchard scores eleven) and favours a passed loop instead of charging it; a short blend stands
in for Orchard's filtered class.

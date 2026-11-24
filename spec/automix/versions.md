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
| Loop mix | Same planner (`planLoopMix`), same sung-part check (synced lyrics, else the vocal mask), same schedule and curves (`loopCurves`). The loop on Vaina Loca → SI NO ES CONTIGO comes from here. |
| Which style | Loop mix when the pair has one, else blend, else filter mix, else a plain crossfade of the user's crossfade length (1–12 s; 12 s where the platform has no such setting). |
| Tempo | Only ever speeds up (the slower song is brought up), at most +25% (−10% for the folded case), the playing song ramps 0.75% per beat before the mix-out; half/double time folded. |
| Blend length | Auto (phone rules: usually 4 bars, 8 when both songs are calm, never over 12–16 s) or "up to N bars"; shortened on a weak grid (`effectiveBlendBars`). |
| Fallbacks | Filter mix when a grid is missing or tempos are too far apart; a plain crossfade of the user's crossfade length (12 s without such a setting) without analysis. |
| After the mix | The incoming deck glides back to ×1.0 at 0.25% per 0.25 s; the stream deck (Phase 2) takes over. |

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
4. **The hand-over**, when none of these fits.

Fixture rules: Stereo Love → Midnight Sun (11% apart) plays a filter mix;
Unethical → Escapism (24%) and Poker Face → Let Me Love You (19%) play an echo
out (both would sing about half of a filter mix).

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

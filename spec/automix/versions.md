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
| Loop or blend | A loop mix that passed its gates keeps priority: the blend must beat it by 0.02 (twice Orchard's loop cost). A blend that fell back (hand-over, bridge, drop-in, muffle) never does. Both are scored as Orchard does (x0.82) on what differs: both singing at once (weight 0.15), the keys (weight 0.13; the loop's instrumental bars score 1, a blend lays both songs' chords over each other) and length (weight 0.02). Fixture rule: Vaina Loca → SI NO ES CONTIGO stays a loop, Stereo Love → Midnight Sun is never one | `loopOrBlend`; scripts/automix_fixtures.mjs |

Simplified from Orchard: the key confidence is the analysis's own key
strength (Orchard's is its key margin); the loop-vs-blend score keeps only the
parts that differ between the two (Orchard scores eleven) and favours a passed loop instead of charging it; a short blend stands
in for Orchard's filtered class.

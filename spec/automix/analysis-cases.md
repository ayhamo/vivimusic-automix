# Analysis cases

The phone and the extension each run their own song analysis (beats, downbeats, tempo, key, vocals).
These cases check the analysers and the mixes they lead to. Cases and thresholds:
`analysis-cases.json`. Runner on the extension: `scripts/analysis_cases.mjs`.

## Rules (decided 2026-11-18 and 2026-11-19)

1. **Neither side is tuned to copy the other.** Each platform runs its analyser as it is: its own
   resampler and model runtime. A case that fails is a finding to look at, not a number to chase.
2. **Two layers**, both strict (on real songs, layer 1 is reported instead: see below):

   **Layer 1: the analysers agree.** Both sides analyse the same decoded file of each song, so this
   tests the analysers and not the streams.

   | What | Must |
   |---|---|
   | Tempo | equal within 0.5 BPM; a half or double reading fails |
   | Beats | at least 95% of each side's beats within 25 ms of a beat of the other side |
   | Downbeat | the same bar start (within the same 25 ms) on at least 90% of bars (every 4th beat from each side's first downbeat) |

   25 ms is one frame of the beat model (Beat This! reads 50 frames a second, so a beat is placed to
   20 ms) plus a few ms of rounding. It was 20 ms until 2026-11-19: a beat placed one frame late, or
   a few ms past its frame, failed at 20 ms though both sides had found the same beat.
   | Vocals | sung frames (the vocal curve at 0.25 or more, the planner's `VOCAL_SUNG`) overlap with an IoU of at least 0.8 |

   **Layer 2: the mixes agree.** Each pair of `pairs/` is planned on each side's analysis (the analyser's
   fields swapped into the captured pair, everything else as captured). For each engine (Classic and
   Automix v2) both must make the same loop / blend / hand-over choice, with mix points within one beat.

   One exception: when the deciding number sits within 5% of a planner threshold, the pair is reported
   as a **threshold case**, not a failure, and the report shows the number and the threshold. The
   thresholds are listed in `analysis-cases.json` (LOOP_MARGIN 0.02, the key score 0.55,
   V2_SUB_BASS_VETO 0.9).
3. **Real songs are allowed.** They make the best test. Their audio stays out of git:
   - Each song is decoded once into a local cache (the extension's is `.cache/analysis/`, git-ignored)
     as `<videoId>.wav`: 44100 Hz, stereo, 32-bit float, from `ffmpeg -i <audio> -ar 44100 -ac 2 -c:a pcm_f32le`.
   - Both sides read that same file.
   - Each side writes its analysis to `<cache>/<side>/<videoId>.json`, with the analysis.schema.json
     field names.
   - `--compare` checks one side's folder against the other's.
   - These cases run on the developer's machine, not in GitHub CI. The songs: every song of
     `pairs/*.json`, plus `real.extra`.
4. **Synthetic songs run everywhere,** CI included, against the truth they were built from (the same
   tolerances as layer 1). `scripts/analysis_signals.mjs` renders them, and its comments spell out every
   sound: mulberry32 noise, a click track, a drum kit with a bar marker, a voice-like tone, a chord pad.
   Each song is rendered once, at 44100 Hz. The beat model's 22050 Hz input is that render through the
   resampler `half` spelled out there (129-tap Blackman-windowed sinc, cut-off 10143 Hz, every second
   sample), so both sides analyse the same samples at both rates; neither uses its own resampler here.
   Real songs are different: there each side resamples as it does in use.
5. **Every synthetic case passes with room:** at least 3 points over each share it needs (beats 98% or
   more for 95%, downbeats 93% or more for 90%, vocal IoU 83% or more for 80%) on the extension's
   analyser, so a second analyser on the same samples isn't failed by rounding. A case that passes
   with less is changed (its song, never the rule), and the change is noted in its `what`.
   - 2026-11-19: `tempo-change-100-110` passed at 95% beats and 91% downbeats, and failed on any
     other resample of the same song; it became `tempo-change-120-126` (98%, 100%). `drums-85`
     passed its beats at 96%; it became `drums-80` (100%).
   - What the margins guard against: on the extension's analyser, beats come out about 20 ms late
     on some tempos (the beat model works in 20 ms frames), mostly between 26 and 30 s into a 50 s
     song, with or without a tempo change there. That finding moved the tolerance to 25 ms (layer 1).
   - With 25 ms, `drums-85` came back (100% beats; its bar start stays a known miss) and `drums-90`
     joined (100%, 100%). `tempo-change-100-110` came back for its downbeat only, as a known miss:
     at 97% its beats are under the margin.

6. **A song over 8 minutes (480 s) isn't analysed** (2026-11-24, versions.md "Analysis length"). The
   check `tooLong` needs no render: both apps answer "too long" from the decoded length, before any
   model runs. The extension's runner reads the cap from `automix.js` and `host.js` and fails when
   they differ.

## Known misses (found 2026-11-19, kept as found)

On the extension's analyser (BitChord's worker with `beat_this_final0_q8` and `vocals_umxhq_int8`).
A known miss prints as KNOWN and doesn't fail; a side that gets it right should say so.

These four are model limits shared with the extension; a port should match them, not tune them away.

- `drums-85`: tempo and beats are right, but the bar start is half a bar late, every bar.
- `tempo-change-100-110`: a beat is lost 3 to 5 s after the jump to 110 BPM, so the bars after it
  start half a bar off (59% of bars right).
- `no-voice`: noise snares and hats read as voice frame by frame (about 29% of frames at 0.25 or more).
- `voice-over-chord`: a held sine chord reads as voice (92% of frames).

The last two matter to the loop planner when a song has no synced lyrics: it allows at most 3% sung
frames over a loop. A song whose drums or pads trip the vocal model loses its loop mixes.

## Real songs: layer 1 is reported, not failed

On real songs, layer 1 differences are reported per platform pair and don't fail the run; layer 2
still does. The set found on 2026-11-19, against the PC:

- `exHJb5t-6e8`, `JBbSlADtG-g`, `2mUTNSMcezg`: bar starts differ (the PC and the phone disagree on
  these too).
- `6Edmp3yHv1s`: BitChord only, 65% of bars.

All of them pass layer 2.

## Running

```
node scripts/analysis_cases.mjs                         synthetic cases (about a minute)
node scripts/analysis_cases.mjs --only a,b --debug      some of them, with the beats each one missed
node scripts/analysis_cases.mjs --real                  analyse .cache/analysis/*.wav into .cache/analysis/pc/
node scripts/analysis_cases.mjs --compare pc phone      layers 1 (reported) and 2, PC against the phone's results
```

# Playback targets

What a listener must get from every mix, on every platform. These are targets, not methods: each
platform meets them by its own means. A platform's internal numbers (look-ahead, trims, servo
thresholds, take-over code) are its own business and stay out of this spec.

## Targets

| Where | Target |
|---|---|
| Hand-over and take-over (one player or deck hands the song to another) | The splice lands within 10 ms of the same song position: no audible skip or repeat |
| Any mix, end to end | 0 cuts: no run of audio under −20 dB of the median level around it (2 ms windows, ±0.3 s around each hand-over) |
| Two decks playing the same song together (a deck locked to the player) | Within ±7 ms, ±5 ms where the platform can reach it, after the first second of the lock |
| Fades | Each fade follows the plan's `curves` (plan.schema.json): the gain at any moment within 1 dB of the curve, and no step over 1 dB between 10 ms windows |
| Level | Both songs levelled against YouTube's loudness (analysis.schema.json `ytLoudnessDb`) |

A take-over that has no time to measure (it is due within about 1.5 s) may miss the 10 ms target. It
must still have 0 cuts, and the platform logs it.

## How each side checks them

- **Extension:** test hooks record the graph's output and YouTube's source around each take-over. The
  skip comes from cross-correlating the two, the cuts from the 2 ms level envelope. Runs happen in the
  test Firefox (TESTING.md). Results as of 2026-11-18:
  - blend: −1.3 to +7.6 ms skip, 0 cuts;
  - loop mixes on pairs 1 and 2: the in-app measurement leaves −5.7 to +8 ms; the outside check
    scatters ±11 ms on these songs, because they match poorly there (scores 0.7–0.88);
  - 0 cuts in every recording.
- **Phone:** its own logcat measurements on the real device (the emulator's audio timing doesn't
  count).

Each platform reports its numbers against this table; a miss is a bug on that platform.

## The queue during a mix [all]

Rules for any app with Automix, not sound targets. Phone: Vivimusic 4370de0. The PC hasn't been
checked against them yet.

1. **Going back aborts the mix.** Once the queue has named the incoming song, the outgoing song named
   again is the listener going back: the mix stops there. (Before the incoming song is named, the
   outgoing song showing up isn't "another song" and the mix carries on.) On the phone a carried-on
   mix's forced hand-over had seeked the outgoing song 23 s off, to the deck's place in the incoming
   one.
2. **A song left "done" is planned again.** A song whose mix began and then ended, or was cut short
   (rule 1), is planned again when it plays again:
   - from more than 5 s before its mix point (the take-over);
   - with the same length, within 0.5 s, so YT's queue still naming it just after the mix moved on
     isn't taken for that.

   Otherwise it stayed "done", and the overview showed "Planning the mix…" for good.

## Playback speed [all]

Mornye 7d35c877.

1. **Plans are in song time.** Mix points, lengths and curves are positions in the songs, not wall
   time. At a playback speed other than x1 a platform that mixes converts them by the speed; one that
   can't mixes nothing (rule 2).
2. **[PC]** YouTube Music on the web has no speed control. The PC mixes only while the player plays
   at x1 (crossfade.js: `playbackRate === 1`); at any other speed YouTube plays the song through,
   unmixed.

## Sleep timer [all]

Mornye 8a6b7fb5.

1. **A sleep timer set to "end of song" drops a prepared mix.** The song plays to its own end and
   playback stops there: the next song is never faded in, and its deck is let go.
2. **[PC]** YouTube Music on the web has no sleep timer, so there is nothing to build.

## Blend when I skip [all]

Prism `SkipFadeRules.kt`. A skip (Next) that blends into the next song instead of cutting.

Prism's targets:
1. A setting, **off by default**.
2. The blend lasts **1.5 s**.
3. If the next song isn't ready to play within **4 s** of the skip, it is a plain skip.

**[PC]** Built its own way, before this section: "Blend when I skip" (`crossfadeManualSkip`) is **on
by default**; the blend lasts the user's crossfade length (1-12 s), the playing song fading out over
a copy of its tail. After Next the PC waits up to 1.5 s for that copy, else it is a plain Next. Next
(the button and Shift+N) only, and not within the song's last crossfade length + 2 s; Next or Prev
during a planned mix is handled by the mix (`skipDuringMix`). The PC keeps these; a platform building it new
takes Prism's targets.

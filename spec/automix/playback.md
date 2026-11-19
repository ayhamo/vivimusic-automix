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

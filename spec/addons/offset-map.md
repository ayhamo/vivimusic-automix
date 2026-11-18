# Offset map and level: an addon file against YouTube's audio

An addon's file of a song is the same recording as YouTube's, but rarely the same file. It can start with more or less silence, and it is mastered at its own level. Before it plays, it is fitted to YouTube's audio. All song times in the apps (the player's position, the analysis, automix plans) are YouTube's. An addon file is read through this map.

Reference code: `src/addons/offset-fit.js`. Fixtures: `scripts/addon_offset_fixtures.mjs`.

## Map

`addonTime = youtubeTime + offsetSec`, one constant per file. The same recording plays at the same speed, so there is no rate term. A file that needs one is another edit or master, and is refused.

`offsetSec` is positive when the addon file has more lead-in than YouTube's. Times past the addon file's end clamp to its end. Before its start (a negative `addonTime`) they are silence.

## Input

Both sides: the decoded song, downmixed to mono (the mean of its channels), at 22 050 Hz (`FIT_RATE`). Each side is decoded by the same path that will play it, so any decoder delay (AAC priming, MP3 encoder delay, Opus pre-skip) is removed, or left in, the same way in the fit as in playback. On PC that is Web Audio's `decodeAudioData` for both (the deck plays that buffer), resampled to 22 050 Hz by an `OfflineAudioContext`. A port must not fit on one decoder's output and play another's.

## Fit

Coarse first, then fine: the coarse stage finds the offset to 10 ms over ±15 s cheaply; only ±20 ms around it is searched at 4 kHz.

1. **Envelope.** RMS of 10 ms windows: window `i` covers samples `[round(i·220.5), round((i+1)·220.5))`. A window under 0.001 (−60 dBFS) is silent. The envelope is `log1p(rms·100)`.
2. **Start.** 0, or the first whole second holding a non-silent window of YouTube's audio (a song that opens silent is read from its first sound). The span is 60 s from there, or to the end. If either side has no non-silent window, or under half the span's windows are non-silent: refused (`silent`).
3. **Coarse.** For each lag from −15 s to +15 s in 10 ms steps, the Pearson correlation of YouTube's span against the addon envelope at that lag, over the windows inside both (partial overlap at the edges). A lag that covers under half the span is skipped. The best lag must score 0.8 or more, else refused (`no match`).
4. **Fine.** 20 s (or the song less 0.2 s, if shorter) from the start, moved inside both files if it would run outside either. Both sides band-limited to 1 kHz and resampled to 4 kHz in one step: output sample `n` at input time `t = (start + n)·22050/4000` (any real number) is `Σ x[k]·h(t − k)`, with `h(u) = g·sinc(g·u)·(0.5 + 0.5·cos(π·u/W))`, `g = 2·1000/22050`, half-width `W = ceil(4·22050/1000) = 89` input samples, and samples outside the file as 0. The addon side is read on a grid shifted by the coarse offset. Pearson correlation over lags of ±20 ms (±80 samples), refined parabolically on the best lag's neighbours. The result is `offsetSec`. The fine score must be 0.8 or more, else refused (`no match`): two songs on the same beat grid can share an envelope, but not a waveform.
5. **Check.** A second 20 s span, ending 30 s before YouTube's end (a song under 90 s: its middle 20 s), moved inside both files. Coarse over ±0.5 s around `offsetSec` (score ≥ 0.8), then fine. It must agree with `offsetSec` within 30 ms, else refused (`different edit`).
6. **Length.** `|(addonDuration − offsetSec) − youtubeDuration|` must be within the length slack (protocol.md §7, default 5 s), else refused (`length`).

Result: `{ offsetSec, score, coarseScore, checkSec, checkScore }`, or `{ none: 'no match' | 'different edit' | 'length' | 'silent', … }`.

## Level

The deck plays the file at YouTube's playback level times a source gain, which brings the file to YouTube's level for that song. On PC YouTube's playback level is the element volume (the listener's volume times YouTube's normalisation). On the phone it is YouTube's normalisation gain applied as a sample gain, not the element volume.

- `gainDb = youtubeLufs − addonLufs`, each the EBU R128 integrated loudness (ITU-R BS.1770-4) of the whole decoded song, measured the same way on both sides: the fit's mono 22 050 Hz signal, K-weighted, 400 ms blocks every 100 ms, absolute gate −70 LUFS, relative gate −10 LU. Mono on both sides keeps the difference right for a stereo pair even though the absolute value isn't BS.1770's channel sum. K-weighting at any rate uses libebur128's filter design, which gives the standard's 48 kHz coefficients exactly: a 997 Hz sine at −20 dBFS reads −23.01 LUFS at 48 kHz and −22.98 at 22 050 Hz.
- This is not the automix analysis' `loudnessCurve`: that is a mono K-weighted curve of 100 ms blocks, used for the blend's level match, not an R128 integrated figure.
- At most +6 dB of boost. Cuts are unlimited.
- Never clips. The true peak is measured only when boosting, on each channel of the file at the rate it plays (on PC the audio context's, decoded again at that rate), 4× oversampled (Hann-windowed sinc, 8 input samples each side), and only around samples within 3.5 dB of the level where the boost would reach −1 dBTP (an oversampled peak sits at most about 3 dB over its samples). The boost is lowered until that peak stays at or under −1 dBTP.
- Ramped, never stepped: the deck reaches the gain over its take-over fade, and any later change over at least 0.5 s.

## Fixtures

`scripts/addon_offset_fixtures.mjs` builds synthetic songs and checks the fit and the level:

- the same audio shifted by +0.7 s, −2.3 s and +11 s: each offset within 1 ms;
- YouTube's copy opening with 1.5 s of silence, the addon's with 0.4 s: −1.1 s within 1 ms;
- an edit with 8 s cut from the middle: `different edit`;
- a file 12 s longer at the end: `length`;
- another song on the same beat grid: `no match`;
- the same 10 ms loudness shape on noise (another recording of the same arrangement): coarse ≥ 0.8, fine under 0.8, `no match`;
- silent YouTube audio: `silent`;
- a 60 s song shifted by +0.25 s: found, checked in its middle (20 s);
- the file 4 dB quieter: +4 dB; 9 dB quieter: capped at +6 dB; 3 dB quieter with YouTube's copy peaking at −0.5 dBFS: held where the true peak meets −1 dBTP (about +2.5 dB); 3 dB louder: −3 dB, no peak measured;
- the K-weighting calibration above.

A port builds the same signals:

- **PRNG**: mulberry32. State `a` (uint32) starts at the seed. Each call: `a = (a + 0x6D2B79F5) mod 2³²; t = a; t = imul(t ^ (t >>> 15), t | 1); t ^= t + imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2³²`. `imul` is the low 32 bits of the product.
- **Song** `(seed, seconds, peakDb = −12)` at 22 050 Hz: zeros, then for each beat `b` (every 0.5 s, `ceil(seconds·2)` beats, start sample `round(b·0.5·22050)`), in this order of draws: `kick = 0.3 + 0.7·rnd()`, `hat = 0.1·rnd()`; if `b mod 4 = 0` a chord of 3 tones, each `f = 110 + 770·rnd()`, `g = 0.05 + 0.1·rnd()`. Over the beat's 0.5 s (sample `i`, `t = i/22050`): add `kick·e^(−8t)·sin(2π·60·t)`, and from `t ≥ 0.25` add `hat·e^(−30(t−0.25))·(2·rnd() − 1)` (one draw per sample, in sample order). For a chord, over 2 s from the beat's start add `g·sin(2π·f·T)` per tone, `T` the song time in seconds. Then scale so the absolute peak is `peakDb`.
- **Cases**: YouTube's song is seed 1, 120 s. Unrelated: seed 2. The 12 s tail: seed 7. The 60 s song: seed 3. The loudness-shape noise: seed 5, one `2·rnd() − 1` draw per sample, scaled per 10 ms window to YouTube's RMS there times √3.

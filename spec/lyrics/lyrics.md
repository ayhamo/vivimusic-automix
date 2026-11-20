# Lyrics: timing, layout and sources

What a lyrics display does with a song's lyrics once they are found, and where they are found. The PC extension's lyrics panel, BitChord's lyrics and the phone's one-line strip follow these rules.

Cases: `lyrics-cases.json` (inputs and expected outputs, synthetic). `node scripts/lyrics_cases_tests.mjs` checks them against a port of Metrolist's functions kept in that script, and against the PC's own code once it has pure functions for them; the phone and BitChord read the same file from their tests.

## How to read this

- Each rule says where it applies:
  - **[view]**: a full lyrics view, many lines on screen (the PC's panel, BitChord's lyrics). On the phone the full view is Morphe's, not ours, so the phone builds none of these.
  - **[strip]**: a one-line strip, one line at a time under the art (the phone's).
  - **[view, strip]**: both.
- The original is the rule: Metrolist unless a rule names BitChord. Where the PC or the phone differs today, §12 says so.
- Paths:
  - Metrolist (v14.0.1): `ML/` = `Metrolist/shared/src/commonMain/kotlin/com/metrolist/shared/`.
  - BitChord: `BC/` = `BitChord/sharedUi/src/jvmSharedMain/kotlin/com/music/bitchord/ui/player/`, `BCA/` = `BitChord/app/src/main/java/com/music/bitchord/`.
  - Phone strip: `FEAT/` = `yt music patches/bundle/extensions/extension/src/main/java/app/ayham/extension/music/features/` (`LyricTiming.java`, `PlayerScreen.java`).
  - PC: `src/` in this repo (`lyrics.js` finds, `lyrics-ui.js` shows).
- Times are in ms. "The position" is the player's position plus the offset (§3).

## 1. The clock

1. **[view, strip]** The lyrics run on a smooth clock, not on the player's raw position: between two readings of the player it runs on at the playback speed, and it never goes backwards except on a seek. `ML/ui/components/lyrics/LyricsDeadlinePosition.kt:133-139`, `ML/ui/components/lyrics/LyricsSmoothPosition.kt:81, 203-245, 290-297`.
2. **[view, strip]** A seek: a reading more than 80 ms behind the clock, or more than 300 ms away from where the clock expected it (1500 ms while casting). The clock jumps to it and every line state is rebuilt. A reading 1 to 250 ms behind that isn't a seek is jitter: the clock keeps its value. `LyricsDeadlinePosition.kt:101-120`, `LyricsSmoothPosition.kt:299-312`.
3. **[view, strip]** Paused or buffering: no running on, the readings as they come. The playback speed comes from the player (casting: 1.0). `LyricsDeadlinePosition.kt:80, 83, 130`.
4. **[view, strip]** Hidden: the clock stops (no work while nothing is shown). `LyricsDeadlinePosition.kt:85-95`.

## 2. Early highlight

The lines change ahead of the voice, so the change has finished when the line is sung.

1. **[view]** A line becomes active when the position plus 660 ms reaches its start (`DEFAULT_SUGGESTED_LINE_OFFSET_MS` = −(500 + 160)). It stops being active at its end; when the next line is already active by the same rule, it stops then. `ML/ui/components/lyrics/LyricsRetiming.kt:31, 397-452`.
2. **[view]** A line that starts while another is still active (a duet, §5) uses a shorter lead: the position plus max(250, 660 − 150) for word-synced lyrics, max(250, 660 − 250) for line-synced. Both lines are active together. An overlap under 250 ms is timing noise, not two voices: it is trimmed. `LyricsRetiming.kt:39, 164-165, 401-403`.
3. **[view, strip]** The word sweep (the fill across each word) runs on the clock with no lead. Only line changes lead. BitChord `BC/PlayerLyrics.kt:1825-1826` (the same).
4. **[strip]** One line at a time: the line shown is the last line whose start is less than the position plus the strip's lead. The lead is the strip's change animation, so the change ends on the line's start (the phone's slide: 340 ms, `FEAT/LyricTiming.java:390, 406-409`). Seeking by lyrics (a tap on a line) and "which line is now" outside the view use Metrolist's 100 ms: line i is current while the next line's start is at or after the position plus 100. `ML/api/lyrics/LyricsUtils.kt:111-121`.
5. **[view]** The scroll to the next line starts ahead of it too: clamp(the next line's start − this line's end, 350, 500) ms, never more than 450 ms of animation. `LyricsRetiming.kt:15-17`, `ML/ui/components/lyrics/LyricsView.kt` (scroll), BitChord `BC/PlayerLyrics.kt:425-426, 470-484`.
6. **[view, strip]** A setting "lyrics by real timing" turns all leads off (default off). `ML/settings/Settings.kt:469`, `LyricsRetiming.kt:330-331`.

Cases: `currentLine`.

## 3. Offsets

1. **[view, strip]** Two offsets, added: a global one (default 0) and one per song (default 0). `ML/api/lyrics/LyricsUtils.kt:94-97`, `ML/settings/Settings.kt:460`.
2. **[view, strip]** Sign: the lyrics position is the player's position plus the offset, so a positive offset shows the lyrics earlier. Seeking by lyrics goes the other way: the player is sent to the lyric's time minus the offset, never below 0. `LyricsUtils.kt:99-107`. (BitChord's offset has the opposite sign, `BCA/data/settings/AppSettings.kt:521`; a port reading BitChord's setting turns it around.)
3. **[view, strip]** The editor: steps of 50 ms, a slider over ±3000 ms, a field for any value, and a reset to 0. `ML/ui/components/lyrics/LyricsOffsetEditor.kt:80-81, 119-122, 137, 272-281`.
4. **[view, strip]** The song's offset is saved by video id (Metrolist: the song's row, `ML/db/entities/SongEntity.kt:49`), the global one as a setting. **(ours)** Both apply as they are changed, with no Save step.

Cases: `offset`.

## 4. Auto-scroll

1. **[view]** On by default (`lyricsAutoScroll`), with a setting. The active line is centred in the view. `ML/settings/Settings.kt:475`, `LyricsView.kt:156, 682`.
2. **[view]** A drag (a touch or mouse drag, a wheel or a trackpad scroll) of more than 0.5 px stops following. The view then stays where the listener left it while the song plays on. `LyricsView.kt:614-640`.
3. **[view]** Following comes back on a "follow lyrics" button shown while it is off, on a tap on a line (which seeks there), or when the lyrics are shown again. Not on a timer. `LyricsView.kt:278-284, 1460-1463, 1666-1680`.
4. **[strip]** Not applicable: the strip has one line.

## 5. Duets

1. **[view, strip]** TTML's singers: `head/metadata/ttm:agent` (`xml:id`, `type`), inherited from a `div`, overridden on a `p`. `role="x-bg"` on a `p` or a span is a background vocal. Spans with `x-translation` or `x-roman` are not sung text. `ML/api/lyrics/BetterLyricsProvider.kt:133-135, 462, 496-521`.
2. **[view]** Sides (`ML/api/lyrics/LyricsUtils.kt:160-235`):
   - an agent's type is its `type`; without one, `v1000` and ids starting with `g` are a group, `v2000` and ids starting with `o` are "other", the rest a person;
   - a group's line is centred;
   - a person or other: the first such line goes left (right if its singer is "other"); after that the side changes each time the singer changes;
   - a line with no singer keeps the view's alignment (centre by default);
   - when 85% or more of the sided lines are on the right, all sides are swapped;
   - a setting turns sides off (default on), `Settings.kt:551`.
3. **[view]** Lines that overlap are active together (§2.2), each on its side.
4. **[view]** Background vocals: smaller and dimmer, under their line (BitChord: 23 sp at alpha 0.72; open 250 ms before the first word, over 400 ms; close over 450 ms, `BC/PlayerLyrics.kt:257-280`).
5. **[strip]** **(ours)** One line: the strip shows the line that started last; a background vocal never replaces the main line.

Cases: `sides`.

## 6. Instrumental gaps

1. **[view, strip]** A gap is 7000 ms or more without a line (`LYRICS_GAP_MIN_MS`). The intro counts: when the first line starts at 7000 or later, a gap runs from 0 to the first line's start − 800. Between lines, a gap runs from the end of the lines so far (the latest end, not the last line's) + 310 to the next line's start − 800. `ML/ui/components/lyrics/LyricsListIndexing.kt:28-53`.
2. **[view, strip]** It is shown while the position plus 190 ms is inside it (`HIGHLIGHT_LOOK_AHEAD_MS`). `LyricsView.kt:1353-1357`, `LyricsRetiming.kt:19`.
3. **[view]** What it shows: an indicator that fills with the gap's progress (Metrolist: a 36 dp wavy ring; BitChord: 3 dots). It appears 300 ms after the gap starts showing, fading in over 200 ms, and leaves over 800 ms (grows to 1.2 at 35%, then shrinks away). `ML/ui/components/lyrics/IntervalIndicator.kt:37-42, 65-94, 130-149`.
4. **[strip]** **(ours)** The strip shows its own gap mark (the phone: a note) in place of a line over the same gaps.

Cases: `gaps`.

## 7. Music videos

1. **[view, strip]** Lyrics show on music videos as on songs, with no switch to hide them. A video's lyrics can come from sources keyed by the video (SimpMusic, YouTube's captions, §11). `ML/repository/LyricsRepository.kt:328, 368`.

## 8. Text size and line spacing

1. **[view]** Text size: 10 to 40, default 36, steps of 1 (Metrolist's sp; the PC reads it as px at the same numbers). `ML/settings/Settings.kt:462`, `ML/ui/settings/LyricsSettingsRegistration.kt:158-166`.
2. **[view]** Line spacing: 1.0 to 2.5 times the text size, default 1.3, steps of 0.1. `Settings.kt:463`, `LyricsSettingsRegistration.kt:167-175`.
3. **[strip]** Not applicable: the strip's size is its layout's.

## 9. Romanization

1. **[view, strip]** Off by default. When on, for the languages switched on (Japanese, Korean, Chinese, Arabic, Hindi, Punjabi, Thai, Russian, Ukrainian, Serbian, Bulgarian, Belarusian, Kyrgyz, Macedonian; all on by default). `ML/settings/Settings.kt:540, 547-549`.
2. **[view]** Layout: the romanized line sits under the original at 0.64 of its size, 4 dp below it, at 0.8 of its opacity. "Romanized as main" swaps the two, with a switch to keep the original under it. `ML/ui/components/lyrics/Lines.kt:517-559, 640-659`, `Settings.kt:541-542`.
3. **[strip]** **(ours)** One line: the strip shows the original, or the romanized line when "romanized as main" is on.

## 10. Translation

1. **[view, strip]** Off by default, a switch in the lyrics menu. `ML/settings/Settings.kt:481`, `ML/ui/menu/LyricsMenu.kt:239-244`.
2. **[view, strip]** Source: Google's keyless endpoint (`translate.googleapis.com/translate_a/single`), into the app's language. BitChord `BCA/data/lyrics/LyricsTranslation.kt:68`. Metrolist's AI and DeepL providers need a key and are not ported.
3. **[view]** Layout: under the line, at 0.64 of its size, opacity 0.7 on the active line and 0.3 on the others. `ML/ui/components/lyrics/Lines.kt:561-583`.
4. **[strip]** Not applicable on one line, unless the strip has a second line.

## 11. Sources

1. **[view, strip]** **SimpMusic**: `GET https://api-lyrics.simpmusic.org/v1/{videoId}` with User-Agent `SimpMusicLyrics/1.0`. Of its tracks, the one closest to the song's length within ±10 s; its `richSyncLyrics` first, then `syncedLyrics`. `ML/api/lyrics/SimpMusicLyricsProvider.kt:22, 35-68`, BitChord `BCA/data/lyrics/SimpMusicLyrics.kt:24-47`.
2. **[view, strip]** **YouTube captions**: the player response's `captions.playerCaptionsTracklistRenderer.captionTracks`; the track in the app's language first, else the first; read with `fmt=json3`; at most 8 tracks looked at. Line-synced only. `ML/api/lyrics/YouTubeSubtitleLyricsProvider.kt:36-102, 188, 204-218`.
3. **[view, strip]** Both come after the listener's ordered providers (Metrolist puts YouTube's sources last, `ML/model/Models.kt:510, 522, 595-598`). For a music video, SimpMusic is asked as well.
4. **[view, strip]** Choosing between answers: the listener's own lyrics first; synced over unsynced; then the provider order; then the finer timing (word over line). With "prefer word-synced" on (default off), the finer timing comes first. `ML/repository/LyricsRepository.kt:99-117, 411-459`.
5. **[view, strip]** An accepted answer's ISRC (lrc.red's document, a BiniLyrics hit) is kept for the addon matcher. `spec/addons/protocol.md` §7, ISRC first.

## 12. Where the apps differ

### PC against the original (as of 917f33f)

- Early highlight: none; the line is active from its start to its end (`src/lyrics-ui.js:1381-1391`). The Fluid style scrolls 540 ms early (`:819, 1421-1427`).
- One active line at a time (`break` at `src/lyrics-ui.js:1390`): duet lines don't run together.
- Offset: per song and provider only (`vivi_lyrics_offset_` + artist, title, provider; `src/lyrics-ui.js:14, 228-254`), steps of 100 ms, a Save button. No global offset. Same sign as the rule.
- Auto-scroll: every line change scrolls the line to the centre (`src/lyrics-ui.js:842-847, 1416`); a drag or wheel doesn't stop it, and there is no follow button.
- Duets: `ttm:agent` isn't read; background vocals are (`src/lyrics.js:290, 306-307`).
- Gaps: nothing is shown in an intro or a gap.
- Music videos: lyrics are off for videos by default (`lyricsShowForVideos` false, `src/lyrics-ui.js:19, 95`).
- Text size and spacing: fixed per style in CSS (`src/canvas.css:158-171, 342, 361`); no settings.
- Romanization: off / only / both (`lyricsRoman`), the romanized line under the original at 0.62 em (`src/canvas.css:1311`); a language picker.
- Translation: none.
- Sources: no SimpMusic, no YouTube captions. The PC races its providers (`src/lyrics.js:1050-1119`).

### Phone strip against the original

- Lead: the slide's 340 ms, and the word fill 150 ms ahead (`FEAT/LyricTiming.java:251, 390, 395`). The rule: the fill has no lead (§2.3).
- Gaps: a note on the intro and on gaps of 2500 ms or more (`FEAT/LyricTiming.java:24, 205-226`). The rule: 7000 ms (§6.1).
- Offsets: none.

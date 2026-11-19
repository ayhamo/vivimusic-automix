# Transition editor

The Automix overview grows into an editor: presets, three lanes (volume, EQ, effect), a draggable
transition window and a beat-match mode. The phone and the extension build the same editor from this
file. The user's edits are saved per pair as an **override** (`override.schema.json`); the planner
turns an override into a plan whose `curves` (plan.schema.json) both engines play.

Fixtures: `editor-cases.json` (an override → its curves and window). Runner on the extension:
`node scripts/editor_cases.mjs`. Functions: `presetCurves` and `resolveWindow` in
`src/automix/automix.js`.

Sources: research `Spotify-Apple-Mixing.md` §1.2 (Spotify's editor) and §5 (what we lack), and
SHORTLIST "Overview → editor".

## 1. The override (question 1)

- **Key:** `"<fromVideoId>>``<toVideoId>"`, the same key both apps use today for `{style, bars}`.
- **Fields:**
  - `preset`;
  - `lanes` {volume, eq, effect} (only for `custom`);
  - `bars`;
  - `beatMatch`;
  - `window` {out, in}, each a bar index plus a nudge in ms plus the seconds it meant when saved;
  - `lock`;
  - `engine` (the Automix version the user saw it under; informational);
  - `savedAt`.

  The full shape is in `override.schema.json`.
- **A missing field means Auto.** An override with nothing but Auto in it is deleted: Auto is the reset.
  - Auto values are never stored: no `preset: "auto"`, no `beatMatch: "auto"`, no `bars: 0`. A
    migrated `{style: blend}` is saved as `{family: blend}`.
  - `preset: loop` stores no `bars`, `window` or `beatMatch` (§2).
  - A nudge that rounds to 0 ms is not stored.
- **Lock** marks an edit, so it is never saved alone. On a pair with no edit the Lock button is off.
  When the last edit of a locked pair goes (its fields back to Auto), the override goes with its lock.
- **The cap:** 300 unlocked overrides, oldest saved first out. Locked overrides don't count against
  it and are never evicted. A lock is the user saying "keep this one". Locked overrides have a cap of
  their own, 300, and a lock beyond it is refused, with exactly this message:
  "300 pairs are locked already: unlock one first".
- **Today's picks migrate** as they're read, with no rewrite pass:

  | Today's `{style, bars}` | Becomes |
  |---|---|
  | `style: loop` | `preset: loop` |
  | `style: blend` | `preset: auto`, `family: blend` |
  | `style: filter` | `preset: auto`, `family: filter` |
  | `style: crossfade` | `preset: auto`, `beatMatch: off` |
  | `bars` | `bars` |

  `family` only exists to carry these old picks (the planner's own blend or filter mix, forced). The
  editor never writes it. Picking a preset drops it.

## 2. Presets (questions 2, 7, 9, 12)

A preset sets the three lanes together. Editing a lane turns the preset into `custom`, with the
lanes it had. Picking a preset keeps the window and the length (Spotify does the same).

| Preset | Volume | EQ | Effect | Default length | Colour chip |
|---|---|---|---|---|---|
| Auto | the planner's | the planner's | the planner's | the planner's | neutral |
| Smooth | smooth | centerBassSwap | none | Auto | blue |
| Rise | overlap | endBassSwap | lpInHpOut | Auto | purple |
| Blend | overlap | threeBandFade | none | Auto | yellow |
| Wave | overlap | centerBassSwap | lpBoth | Auto | purple |
| Melt | crossfade | centerBassSwap | hpBoth | Auto | purple |
| Slam | centerCut | none | none | 2 bars | red |
| Echo out | *reserved, see §5* | | | | |
| Loop | the loop mix's | the loop mix's | the loop mix's | the loop's own | green |
| Custom | the user's | the user's | the user's | Auto | the badge only |

**Lane colours (both apps):**

| Lane | Colour |
|---|---|
| volume | blue `#4C8DFF` |
| EQ | yellow `#F5C542` |
| effect | purple `#A779FF` |
| rate | grey `#9AA0A6` |

**The UI:**
- Presets are a chip row. Lanes sit under a folded "Customize", each a dropdown of the named shapes.
- An edited pair shows a "Custom" badge (also for a non-Auto preset). The badge shows exactly when the
  pair has a saved override. That includes a migrated `family` pick, since a lone lock is never saved
  (§1). The Auto chip takes the preset
  back to Auto and keeps the rest of the edit (length, window, beat match, lock); "Reset to Auto"
  clears the whole edit and the badge.

**Loop (question 7):**
- The loop mix keeps its own length and its own curves. The loop planner picks bars it found clear of
  vocals, so the length chips, the lanes and the window drag are off for Loop in v1.
- The phone's loop renderer draws only gain, the 250 Hz shelf and HP, so any lane beyond that would be
  phone-only.
- The beat-match mode doesn't apply either: the loop decks do their own tempo ramp. Picking Loop
  drops a saved beat match.

**Slam (question 9):** a cut, not a fade:
- The volume swap is an 8 ms ramp (`CUT_RAMP_SEC`), which keeps it free of clicks.
- The ramp starts on the window's centre.
- Slam's default 2 bars put that centre on a downbeat. With any even bar count it's a bar line too.

## 3. Lanes as curves (questions 2, 3)

All curves are `[[t, v], …]` as in plan.schema.json: seconds from the window's start, held before
the first point and after the last, linear between points (Hz: geometric). Below, points are given at
a fraction `x` of the window's length `D` (t = x·D).

**Constants:**

| Name | Value | Note |
|---|---|---|
| `CUT_DB` | −18 dB | the planner's `BASS_CUT_DB` |
| shelves | low shelf 250 Hz, high shelf 4 kHz | slope 1, the Web Audio default; both apps already use these |
| `LP_CLOSED` | 400 Hz | |
| `HP_CLOSED` | 1000 Hz | |
| open filters | LP 20 kHz, HP 20 Hz | |
| `CUT_RAMP_SEC` | 0.008 s | the cut ramp, `e = 0.008 / D` as a fraction |

`hb` is half a beat as a fraction of the window: `0.5 · beatSec / D`. With beat match Off it is
`0.02`.

### Volume (`gain` per deck)

| Shape | Outgoing | Incoming |
|---|---|---|
| smooth | cos(x·π/2) at x = 0, 1/16 … 1 (17 points) | sin(x·π/2) at the same 17 points |
| crossfade | [0, 1] [1, 0] | [0, 0] [1, 1] |
| overlap | [0, 1] [0.75, 1] [1, 0] | [0, 0] [0.25, 1] |
| cutInFadeOut | [0, 1] [1, 0] | [0, 0] [e, 1] |
| fadeInCutOut | [0, 1] [1−e, 1] [1, 0] | [0, 0] [1, 1] |
| centerCut | [0, 1] [0.5, 1] [0.5+e, 0] | [0, 0] [0.5, 0] [0.5+e, 1] |

### EQ (`bassDb`, `highDb` per deck)

| Shape | Outgoing | Incoming |
|---|---|---|
| centerBassSwap | bass [0.5−hb, 0] [0.5+hb, CUT] | bass [0, CUT] [0.5−hb, CUT] [0.5+hb, 0] |
| endBassSwap | bass [0.875−hb, 0] [0.875+hb, CUT] | bass [0, CUT] [0.875−hb, CUT] [0.875+hb, 0] |
| threeBandFade | as centerBassSwap, plus high [0.5, 0] [1, CUT] | as centerBassSwap, plus high [0, CUT] [0.5, 0] |
| quickBassCut | bass [0, 0] [2·hb, CUT] | none |
| none | none | none |

**Question 3: no mid curve.** "3-band fade" uses the two shelves plus the volume lane. The mids
follow the fader. The extension's decks have a 1 kHz band and the phone's have none, so a `midDb`
lane would be extension-only. It isn't added.

### Effect (`lowpassHz`, `highpassHz` per deck)

| Shape | Outgoing | Incoming |
|---|---|---|
| none | none | none |
| lpOut | LP [0, 20000] [1, 400] | none |
| hpIn | none | HP [0, 1000] [0.5, 20] |
| lpBoth | LP [0.5, 20000] [1, 400] | LP [0, 400] [0.5, 20000] |
| hpBoth | HP [0.5, 20] [1, 1000] | HP [0, 1000] [0.5, 20] |
| lpInHpOut | HP [0, 20] [1, 1000] | LP [0, 400] [1, 20000] |

### Rate (`rate`), from the beat-match mode (§4)

- The planner's rate curves stay as they are for Auto.
- Sync: the incoming deck at `r = A's BPM / B's BPM` for the whole window, then its glide back to
  ×1.0, as the planner's blend does today: [0, r] [D, r] [D + glide, 1].
- Glide: the planner's glide (`glideSteps`), one tempo step per beat on both songs: A goes from ×1.0
  towards B's tempo and B from A's tempo to ×1.0, geometrically, so the two meet on every beat and B
  ends at ×1.0. Both engines play the plan's rate points; editor-cases.json checks that the plan
  carries the glide.
- Off: no rate curve.

## 4. Beat match (question 6)

| Mode | What plays |
|---|---|
| Auto | the planner's choice, as today: a stretched blend when the tempos fit, else a hand-over |
| Sync | one tempo over the whole window (key lock), then B glides back to its own. Tempo only ever moves up, as in Auto: B faster, A is brought up to it before the window; B slower, B is sped up to A |
| Glide | B's tempo goes from A's to its own across the window |
| Off | both at their own tempo; a plain overlap with no snapping to beats |

- **The tempo range:** Sync and Glide stretch at most 8% (the planner's `V2_MAX_STRETCH`, after
  folding half and double time).
- **Out of range:** the pair plays Off, and the editor says why ("tempos 11% apart: Sync stretches at
  most 8%, so this plays without beat match"). The override keeps Sync, so a re-analysis that brings
  the tempos into range brings Sync back.

## 5. Echo out (question 4)

Deferred.
- It needs a new lane (wet, feedback, and a delay in beats) and a delay line in both engines. Today
  neither engine has one, and the phone's loop renderer can't take one either.
- The preset id `echoOut` and the effect id `echoOut` are reserved. Until both apps render it, the UI
  doesn't show it.
- It gets its own section here before either app ships it.

## 6. The window (question 5)

**What can move:** A's mix-out and B's mix-in, the window's start in each song. The length comes
from `bars`.

**Snapping:** each position snaps to its own song's grid.
- A's mix-out snaps to A's end grid (`tailGrid`); B's mix-in snaps to B's opening grid.
- Downbeats by default, beats on a long-press (phone) or with Shift (extension).
- With beat match Off, nothing snaps.
- Nudges are 10 ms steps (`nudgeMs`, ±2000 ms at most). A nudge past that is refused with
  "Nudges reach 2 s at most: drag the song instead".
- **The grids** (`editorGrid(analysis, side)` → `{beatSec, downbeatSec, bpm}`):
  - `out` (A): A's end grid, the `tailGrid` fields (`beatIntervalSec`, `firstDownbeatSec`, `bpm`)
    when the analysis has one, else its main grid.
  - `in` (B): B's main grid.
  - None when that grid lacks `bpm`, `beatIntervalSec` or `firstDownbeatSec`. Then nothing snaps,
    and the position is saved as `{bar: 0, sec}`.
  - A bar is 4 beats. Positions are `downbeatSec + j × beatSec`, with bar = floor(j / 4) and beat
    = j − 4 × bar.

**Readout while dragging:**
"A mixes out at 3:12.4 (bar 81) · B enters at 0:32.4 (bar 17)".

**Stored as** a bar index on that song's grid, plus the nudge, plus the seconds it meant when saved
(`sec`).
- A bar index survives a re-analysis that shifts the grid a little. `sec` catches a re-analysis that
  moved it more.
- **Reading it back** (`resolveWindow`): the time is `downbeat(bar) + nudgeMs/1000`. If that is more
  than one beat from `sec`, the grid changed under it. Then the position is `sec`, snapped to the new
  grid's nearest downbeat, and the result says `moved: true` so the editor can mark it.

**Limits (a drag past one is held there, and the readout says why).** These are the planner's
`windowLimits(plan, A, B, earliest)`, in song seconds:
- **Inputs:**
  - `earliest` = A's playhead + the hand-over lead + 0.5 s (`HAND_LEAD`; the planner's own
    `earliest`).
  - A's music end = `contentEndSec`, when that is more than 1 s before A's length; at most 20 s are
    cut (`musicEnd`).
  - For a blend (`style: blend`, with `bars` and `beatSec`): A's span = bars × 4 × beatSec, and B's
    span = A's span × (`rate` / `outRate`), or ÷ `glide.q` for a glide.
  - For anything else, both spans are the plan's `durationSec`.
- **A's mix-out:**
  - from `earliest`, plus `rampSongSec` for a blend;
  - up to min(music end, length − 0.3) − A's span for a blend, or music end − 0.3 − span otherwise
    (never below the lower limit).
- **B's mix-in:** from 0 up to B's length − 10 − B's span (never below 0).
- **The readout's reasons:** "· held: " plus one of these:
  - "A has already played up to there" (A, low);
  - "the window has to end before A's music does" (A, high);
  - "that is B's start" (B, low);
  - "the window has to end 10 s before B's end" (B, high).
- A snap that lands past a limit moves one step (a bar, or a beat with Shift or long-press) back
  inside.

What the limits are, in words:
- A's mix-out: no earlier than the planner's `earliest`, and late enough that the window ends before
  A's music does (`contentEndSec`, else the duration).
- B's mix-in: 0 or later, the window ending at least 10 s before B's end.
- A saved position past a limit moves to the nearest downbeat inside it (the clamped second itself
  when the song has no grid there), with the reason shown.
- A saved mix-out the playhead has already passed isn't moved to "now": the planner's own mix-out
  plays instead, with "the mix-out at X s has already played" shown.
- A length that doesn't fit before A's end plays as long as there is room, with the reason shown.
- The first window edit of one side (a drag or a nudge) saves the other side too, where the plan has
  it at that moment. With one side saved, the planner would still move the other (B's skip cap, the
  vocal re-route), and B's mix-in could jump bars under a 10 ms nudge of A.
- A length the plan can't use (a hand-over for the sub-bass or key gates, a drop-in's two bars, a
  plain fade) shows "N bars not used:" and the reason, not "fit here".
- A pick from before the editor that forced the filter mix (`family: filter`) places the filter mix
  itself: a saved window shows "the saved window isn't used". Picking a preset uses it.
- A saved mix-in isn't moved by Automix v2's kick lock (`kickLockAllowed`): the lock shifts B by
  up to an eighth of a beat, which would undo a nudge. editor-cases.json `plans` has the cases.
- Unlike Spotify, the first and last moments of a song are reachable when the limits allow.

**The planner's other gates** (question 8):
- An override is the user's choice, so the style gates don't block it: the vocal clash, the sub-bass
  veto (`V2_SUB_BASS_VETO`) and the "beat match or hand-over" ladder.
- When a gate would have refused, the editor shows the reason as a warning ("both sing over the
  window", "the productions clash").
- Physical limits are clamped or fall back, with the reason shown: the tempo range (§4), the song
  bounds, a missing grid for snapping. A pair the planner would hand over or filter out for its
  tempos plays the user's preset, length and window without beat match instead.
- Nothing is refused silently.

## 7. Auto's name and the header (question 10)

**The header** under the title names the plan (numbers rounded; D = the mix's seconds, one decimal):

| Plan | Header |
|---|---|
| `style: loop` | Loop mix · {totalBars} bars · {A BPM}→{B BPM} BPM · {D} s |
| `style: crossfade` | {Beatless bridge | Hand-over | Fade} · {D} s[ · {reason}] |
| anything else | {Filter mix | Drop-in | Muffle | Glide blend | Blend} · {bars} bars · {BPM} · {D} s |

{BPM} is "{outBpm}→{inBpm} BPM" when the two round to different numbers, else "{bpm} BPM".

With no override the preset row shows "Auto · <what the planner chose>":

| Plan | Shown |
|---|---|
| `style: loop` | Auto · Loop |
| `style: blend` | Auto · Blend |
| `style: blend`, `shape: dropin` | Auto · Drop-in |
| `style: blend`, `shape: muffle` | Auto · Muffle |
| `style: blend`, `glide` | Auto · Glide |
| `style: filter` | Auto · Filter |
| `style: crossfade` | Auto · Fade |
| `style: crossfade`, `handoff` | Auto · Hand-over |
| `style: crossfade`, `bridge` | Auto · Bridge |

## 8. Editing during a mix (question 11)

An edit made while the pair's mix is playing applies the next time the pair mixes, as today. The mix
that is playing finishes as planned. Changing curves on running decks would need both engines to
re-schedule mid-mix, and a half-old, half-new transition isn't what the user previewed.

Preview stays a seek on the real player: the overview seeks the playing song to a few seconds before
the window.

## 9. How an override reaches the planner

`plan({ …, pick })` takes the override (today's `{style, bars}` migrated as in §1):
1. `preset: loop` → the loop mix (today's `style: loop`).
2. Beat match Off, or Sync/Glide out of range → the plain overlap (today's crossfade path), at the
   window and length asked for.
3. Otherwise the planner plans its blend at the window and length asked for (`bars`, `window`).
   - A preset other than Auto then replaces the plan's curves with `presetCurves(override, D,
     beatSec)` for gain, the shelves and the filters.
   - It keeps the planner's tempo ramp before the mix and the rate curve for the beat-match mode.
4. `family` (migrated picks only) forces the planner's own blend or filter mix, as today.

Both engines play `plan.curves`. The extension's engine plays gain, the low and high shelves, HP, LP
and rate on both decks. The phone's blend engine plays the same six.

# Canvas: the moving art behind a song

What the phone app and the PC extension both do to find a song's canvas, pick and judge it, and draw what sits around it. A later BitChord fork follows the same rules.

Cases: `canvas-cases.json` (inputs and expected outputs, synthetic, no media). The PC runs them with `node scripts/canvas_cases_tests.mjs`; the phone reads the same file from its JVM tests.

## How to read this

- Each rule says **[both]** or **[phone only]** with the reason.
- Each rule cites the phone's code and the original it was ported from. Where the two differ, or the PC differs, the original is the rule. §12 lists every difference.
- Paths:
  - Phone: `FEAT/` = `yt music patches/bundle/extensions/extension/src/main/java/app/ayham/extension/music/features/`.
  - Metrolist (v14.0.1): `ML/` = `Metrolist/shared/src/`.
  - Prism: `PR/` = `Prism/app/src/main/java/com/prism/music/data/`.
  - BitChord: `BC/` = `BitChord/app/src/main/java/com/music/bitchord/`, `BCS/` = `BitChord/shared/src/jvmSharedMain/kotlin/com/music/bitchord/`, `BCU/` = `BitChord/sharedUi/src/jvmSharedMain/kotlin/com/music/bitchord/ui/player/`.
  - PC: `src/` in this repo.
- Times are in ms unless they say otherwise.

## 1. Source order

1. **[both]** The sources are tried in this order: the song's music video, Spotify's Canvas, Apple's motion art. The first one that has a clip wins. Phone `FEAT/AnimatedCover.java:467-593`. Original `ML/commonMain/kotlin/com/metrolist/shared/api/artwork/AnimatedCoverSelection.kt:28` (`defaultOrder`), `:119-143` (`selectAnimatedCoverUrl`).
2. **[both]** A source still loading holds the ones after it: nothing is shown from a later source until it answers. A clip that failed to play is skipped. `AnimatedCoverSelection.kt:139-140`.
3. **[both]** The music video and Spotify are Canvas; Apple's is an animated cover, with its own switch. `AnimatedCoverSelection.kt:43-46`. Phone: `FEAT/AnimatedCover.java:423-425` (`canvasApple`, `canvasSpotify`, `canvasVideo`).
4. **[both]** A listener's own order and set of sources may replace the default; sources left out of a custom order follow in the default order. `AnimatedCoverSelection.kt:30-33, 38-39`.
5. **[phone only: the PC has no downloaded songs]** A downloaded song's saved Spotify canvas comes first, then its saved art clip, both by video id, so they play offline. `FEAT/AnimatedCover.java:454-466`. No original (Metrolist has no offline canvas).
6. **[phone only: settle time for a touch UI]** A lookup starts 700 ms after the song shows, so skipping through songs looks nothing up. `FEAT/AnimatedCover.java:50, 428-437`.

Cases: `sourceOrder`.

## 2. Cache

1. **[both]** A found clip is kept and plays at any age, also offline. A miss is kept for 24 h (under 24 h: still a miss; at 24 h: look again). A failed lookup (network, token) is never saved as a miss. Phone `FEAT/CanvasCache.java:21, 56-72`; `FEAT/AnimatedCover.java:543, 590-593`. No original keeps a lasting cache: Metrolist memoises a lookup for 60 s (miss) or 5 min (hit), `ML/jvmSharedMain/kotlin/com/metrolist/shared/api/artwork/DirectCanvasProvider.kt:116`; BitChord keeps 64 answers in memory, `BC/data/canvas/CanvasRepository.kt:41, 54-57`. This rule is ours.
2. **[both]** A damaged entry reads as unknown (look it up again), never as an error. `FEAT/CanvasCache.java:59-68`.
3. **[both]** A saved clip whose file is gone is looked up again. `FEAT/CanvasCache.java:69-71`.
4. **[both]** What each answer is keyed on: the music video by the song's id; Spotify by title and artist; Apple by title and artist, and whether the tall (3:4) clip was asked for. Phone `FEAT/AnimatedCover.java:438, 469, 522`. BitChord keys on the song id and on the source order (`spotifyFirst`), so a changed order never reuses an answer: `BC/data/canvas/CanvasRepository.kt:89, 159-160`.
5. **[phone only: offline downloads]** `spid:<id>` and `id:<id>` keys for downloaded songs. `FEAT/CanvasCache.java:75-82`.

Cases: `cache`.

## 3. Apple motion art

Original: BitChord `BC/data/canvas/AppleMusicCanvas.kt`. Phone: `FEAT/AppleCanvas.java`. PC: `src/apple-canvas.js` with `src/plus/bg-plus.js:623-804`.

1. **[both]** Token: the web player's own anonymous JWT, scraped from `music.apple.com/us/browse` and its `/assets/index…js` bundles. The first unexpired one whose header `kid` says `WebPlayKid` or payload `iss` says `AMPWebPlay`; else the first unexpired one. A token that got a 401 is never picked again. Kept until 60 s before it expires. A scrape that finds none waits 30 min. BC `:356-396, 404-435`. Phone `FEAT/AppleCanvas.java:218-278`.
2. **[both]** Search: `types=songs`, `limit=10`, `extend=editorialVideo`, `include=albums`. The term is the artist (unless the title holds it), the title, and the album (unless the title holds it). BC `:52-67`. Phone `:56-58` (no album).
3. **[both]** Normalising: accents removed, lower case, anything but a-z and 0-9 becomes a space, spaces collapsed. Brackets are kept. BCS `data/canvas/CanvasArtwork.kt:73-79`.
4. **[both]** Artists split on `,` `&` ` × ` ` x ` `feat.` `ft.` `featuring` `with` (not "and"). BCS `CanvasArtwork.kt:86-94`.
5. **[both]** Score of a hit (BC `:178-233`):
   - rejected if its name or album holds `playlist`, `set list`, `essentials`, `dj mix`, `mixed`, `apple music`, `today's hits` or `session` (BC `:243-251`);
   - rejected unless every wanted artist is among the hit's artists;
   - start at 10;
   - title: equal +15, one contains the other +7, else −10;
   - album, when both sides have one: equal +20, one contains the other +10;
   - each edition word (`deluxe`, `expanded`, `remastered`, `remix`, `version`, `edit`, `mix`, `bonus`) as plain substrings: in both +5, only in the hit −3.
6. **[both]** Hits are ranked by score, ties in Apple's order. A hit under 12 ends the search. BC `:76-85, 171`.
7. **[both]** For each hit from the top: its inline motion art if it has some; else its album (from `relationships`, else the number at the end of its `/album/` URL; not a `pl.` id), read with `extend=editorialVideo`, skipped if the album is a compilation. BC `:92-106, 255-304`.
8. **[both]** Motion URLs: an asset's `video`, else `videoUrl`, `hlsUrl`, `url`. Primary: the square clip (`motionDetailSquare`, else `motionSquareVideo1x1`), else `motionDetailRaw`, else the tall one. Alternate: the next of square, raw, tall that differs. Tall (3:4, for a portrait player): `motionDetailTall`, else `motionTallVideo3x4`, else none. A static still is not motion art. BC `:306-330`.
9. **[both]** Storefront: the device's country, else `us`. BC `:42-44`.

Cases: `appleScore`, `appleRank`, `appleToken`, `appleMotion`.

## 4. Spotify Canvas, no login

Original: Metrolist `ML/jvmSharedMain/kotlin/com/metrolist/shared/api/artwork/DirectCanvasProvider.kt`. Phone: `FEAT/SpotifyCanvas.java`. PC: `src/plus/bg-canvas.js`.

1. **[both]** Always anonymous: the web player's token by TOTP (spotlib's secret, version 61, 30 s steps, 6 digits), then a client token. Never the listener's Spotify account. ML `:139-149`. Phone `:44-45, 209-272`.
2. **[both]** Search: pathfinder `searchTopResultsList`, query `title artist`, 10 results. ML `:159-186`.
3. **[both]** The first Track among the top 10 that matches and has a canvas wins. ML `:187-221`.
4. **[both]** Match (ML `:397-436`):
   - words: NFKD, marks removed, lower case, split on anything but letters and digits, without `feat`, `ft`, `featuring`, `official`, `video`, `audio`;
   - the artist words equal, or the primary artist's words equal (when given);
   - title: shared words over the larger set, at least 0.75;
   - length: within 10 000 ms when both are known;
   - album: at least 0.5 the same way, when both are known.
5. **[both]** The canvas comes from the public mirror `spotify-canva.vercel.app/api/canvas?trackId=` for a 22-character id; the entry must name `spotify:track:<id>`. ML `:224-234`.
6. **[both]** Media is taken only from https, port 443, no user or password, host `scdn.co` or under it. ML `:378-395`.
7. **[both]** Each request times out at 8000 ms; an answer is read up to 256 KB. ML `:60-64, 124, 227`. Phone `:46`.

Cases: `spotifyMatch`, `spotifyMedia`, `spotifyTotp`.

## 5. Finding the music video

Original: Prism `PR/innertube/MusicVideoMatch.kt`, `PR/innertube/YouTubeMusic.kt:905-927`, `PR/canvas/ClipFinder.kt`. Phone: `FEAT/VideoCanvas.java:232-347`. PC: `src/plus/video-canvas-page.js:38-112, 888-907`.

1. **[both]** A video search for `title artist`, then once more for `title artist official video` when nothing passes. The first passing result wins. YTM `:911-919`. Phone `:246-260`.
2. **[both]** Its title must be the song's: brackets, a `|` or `//` tail, a `ft.`/`feat.` credit, the words `official music video videoclip clip hd 4k hq remastered remaster visualizer mv m/v` and the artists' and channel's names (and their "official" forms) all taken out. MVM `:78-96`.
3. **[both]** Never: a title (or, for a channel not the artist's, a channel name) with `lyric(s)`, `letra(s)`, `paroles`, `testo`, `traducida`, `traducción`, `sub español`, `subtitulad`, `перевод`, `текст`, `karaoke`, `instrumental`, `reaction`, `tutorial`, `lesson`, `guitar`, `piano`, `drum`, `bass`, `slowed`, `sped up`, `nightcore`, `8d`, `fan made`, `fanmade`, `remix`, `highlights`, `edit audio`, `official audio`, `audio oficial`, `audio only`, `rebassed`, `bass boosted`, `bassboosted`, `boosted`, `reverb`, `daycore`, `speed up`, `1 hour`, `10 hours`, `loop`, `mashup`, `parody`, `ai cover`, or a frequency like `432hz`; unless the song's own title has the word. MVM `:107-119`.
4. **[both]** First choice: posted by the artist (their channel id, their channel name or its VEVO/"Official" form, or a record label naming them), within 150 s of the song's length, and not another take (`cover`, `acoustic`, `acústic`, `unplugged`, `live`, `en vivo`, `ao vivo`, `concert`, `session`) unless the song is that take. MVM `:41-47, 60-72, 121-125, 143`.
5. **[both]** A song naming a source in brackets ("SiriusXM Session"): that recording by whoever posted it, within 4 s, naming the artist. A studio song takes nobody else's upload. MVM `:48-57, 144`.
6. **[both]** Prism also takes YouTube's own song-to-video pairing first and requires the official type (`OMV`). Signed out, YouTube no longer pairs; both apps search. YTM `:906`, `PR/canvas/ClipFinder.kt:159-165`.

Cases: `videoMatch`.

## 6. The part: BestPart

Original: Prism `PR/BestPart.kt:68-101`, used by `PR/canvas/ClipFinder.kt:183`. Phone: `FEAT/VideoCanvas.java:434-465`. PC: `src/plus/video-canvas-page.js:196-221`.

1. **[both]** The curve: YouTube's "Most replayed" markers (`MARKER_TYPE_HEATMAP`), 10 or more; the segment length is the median marker length. BestPart `:44-58`.
2. **[both]** None for a song under 60 000 ms or a curve under 10 segments. BestPart `:35, 70`.
3. **[both]** Smoothing: the mean over `round(4500 / segment)` segments either side (at least 1). BestPart `:74-79`.
4. **[both]** Trend: the median of the smoothed curve over `round(45 000 / segment)` segments either side (at least 3), leaving out segment 0. BestPart `:80-86`.
5. **[both]** Rise of a segment: smoothed / max(trend, 0.05) − 1. BestPart `:87`.
6. **[both]** Candidates start at max(5000, 2 segments) and end 30 000 before the song's end. The largest rise wins; on a tie, the earlier. BestPart `:31-33, 88-91`.
7. **[both]** None when the rise is under 0.08 or the smoothed value is under 0.03 above the trend. BestPart `:37-39, 92`.
8. **[both]** The start is pulled back over candidates whose rise is at least half the peak's, then forward to the first raw segment that reaches that half. BestPart `:93-100`.
9. **[both]** With no curve, the loop's window is chosen from the frames alone (§7.6). With no frames either: the middle 8000 ms of the video. `PR/canvas/FrameJudge.kt:72-76`, `ClipFinder.kt:175-177`.
10. **[both]** The loop is 8 s at first (`CLIP_SEC`, `WINDOW_MS`). `PR/canvas/FrameJudge.kt:13`. Phone `FEAT/VideoCanvas.java:34`.

Cases: `bestPart`, `noFrames`.

## 7. Judging the clip: ClipJudge

Original: Prism `PR/canvas/FrameJudge.kt` (storyboard frames) and `PR/canvas/ClipRefine.kt` (the real frames). Phone: `FEAT/ClipJudge.java`. PC: `src/plus/video-canvas-page.js:225-476, 1045-1113`.

Frames are 32 × 18 grids of grey values.

1. **[both]** Black bars: a cell at or under 24 is black; a frame is lit when a cell reaches 48. A row or column is a bar when it is black (90% of its cells) in 90% of the lit frames. Bars run in from each edge. Fewer than 3 lit frames: no bars. A pair of sides over half the picture: no bars on that axis. FrameJudge `:22-27, 97-112`. Phone `:50-89`.
2. **[both]** A still upload: in the middle 60% of the picture inside the bars, a step under 3 counts as still; 60% or more still steps is a still upload, never shown. FrameJudge `:28-31, 116-140`. Phone `:117-123`.
3. **[both]** Windows: one per storyboard frame, `round(8000 / interval)` steps long. In a video of at least 51 000 ms, windows starting in the first 12 000 or ending in the last 15 000 are left out; in a shorter one they count at half score. A window with 75% or more still steps is left out. FrameJudge `:13-17, 149-177`. Phone `:128-164`.
4. **[both]** Window score = movement × brightness × (1 − dark share) × (0.5 near an end):
   - movement (mean step inside the bars): m / 18 up to 18, then falling to 0.5 at 60 and above;
   - brightness: (mean − 16) / (64 − 16), clamped to 0..1;
   - dark share: frames under 16. FrameJudge `:34-40, 167-173`.
5. **[both]** When every window is left out, the video is a still upload. FrameJudge `:64`, `ClipFinder.kt:186`.
6. **[both]** The window (FrameJudge `:187-210`):
   - the best within −4000..+8000 of the "most replayed" peak, if the peak is at 12 000 or later;
   - else the best within 10 000 of the chorus (from synced lyrics);
   - else the best in the middle third;
   - each of these only from windows scoring above 0 and at least 0.3 of the best;
   - else the best anywhere, even at 0;
   - ties go to the earlier start.
7. **[both]** Runners-up: up to 4 other starts, 15 000 apart. FrameJudge `:18-20, 213-222`.
8. **[both]** Crop: the band of the picture holding the most detail and movement, 0.32 of the width inside the bars; the centre unless the best leads it by 1.15×; ties go to the band nearer the centre. 0 left, 0.5 centred, 1 right. FrameJudge `:41-44, 232-257`.
9. **[both]** Cut: a step whose mean change is 22 or more and at least 3 × the steps before and after (and 3 × 2). ClipRefine `:59-60, 79-91`.
10. **[both]** The loop ends on the last cut 5000 to 9000 in; else at 8000 or where the frames end. ClipRefine `:123-126`, `PR/canvas/ClipRepository.kt:260-261`.
11. **[both]** Flashing (WCAG 2.3.1): a step that moves 25% of the cells by 26 or more is a flash; 7 changes of direction within 1000 ms is flashing. While the loop flashes, it ends on an earlier cut (5000 or more); if it still flashes, another part is tried once; if that flashes too, no canvas. ClipRefine `:61-65, 94-117, 195-198`; ClipRepository `:191-205`.
12. **[both]** The loop starts on the key frame at or before its start. `PR/canvas/VideoCanvas.kt:14`. Phone `FEAT/VideoCanvas.java:130`.

Cases: `bars`, `still`, `windows`, `choose`, `cropX`, `loopEnd`, `judge`.

## 8. Display

1. **[both]** A video that is not tall fills the player. Only a tall clip (height / width over 1.2 and under 1.45: Apple's 3:4) stops at its own edge and fades into the backdrop. Phone `FEAT/AnimatedCover.java:170-174`, `FEAT/FullArt.java:447-448`. Original: BitChord's portrait clip `BC/data/canvas/AppleMusicCanvas.kt:313-315`.
2. **[both]** The clip's fade: the banner height × 0.42 over where the clip ends, clamped to 0..1 (0 when it has no end). `BCU/NowPlayingScreen.kt:288, 1548-1550`.
3. **[both]** A clip's black bars are zoomed out of view. Phone, on the playing frame: rows under grey 24 from the top and bottom, each at least 1/16 of the height, the picture at least half the height; zoom at most 1.6. `FEAT/AnimatedCover.java:190-210`. No original.

Cases: `display`.

## 9. Backdrop: BitChord mesh

Original: `BCU/ArtworkMeshBackdrop.kt`, `BCU/NowPlayingScreen.kt`. Phone: `FEAT/ArtMesh.java`, `FEAT/ArtBackdrop.java`.

1. **[phone only: the PC draws YouTube Music's own page]** A 6 × 6 grid of the cover's colours (`MESH_GRID`), read about every 1/128 of each side, smoothly resampled to 32 × 32 texels (`MESH_TEX`), blurred by 3 box passes of radius 1. BC mesh `:536, 549, 558-559, 582, 596-646, 697-721`. Phone `FEAT/ArtMesh.java:12, 19-38, 68-97`.
2. **[phone only]** Each cell's colour is lifted before resampling: saturation × 1.12 (at most 1), lightness at least 0.045. BC mesh `:747-755`.
3. **[phone only]** Rows below the seam are mirrored and shifted by a seeded random. BC mesh `:677-691`.
4. **[phone only]** A clip's mesh is read again every 3000 ms; a new mesh fades in over 900 ms. BC `NowPlayingScreen.kt:302`, mesh `:571`. Phone `FEAT/ArtBackdrop.java:48`.
5. **[phone only]** The cover's lowest 0.42 fades into the mesh. `NowPlayingScreen.kt:288`. Phone `FEAT/ArtBackdrop.java:50`.

Cases: `backdrop` (`meshLift`).

## 10. Backdrop: Metrolist bleed

Original: `ML/commonMain/kotlin/com/metrolist/shared/ui/player/FullscreenArtworkBleed.kt`. Phone: `FEAT/ArtBackdrop.java`, `FEAT/FullArt.java`.

The bleed is phone-only because it is blended onto YouTube's own art. A player that draws its own backdrop instead (the PC redraws none; BitChord has its mesh, §9) marks this section not applicable.

1. **[phone only: blended onto YouTube's own art; not applicable to a player with its own backdrop]** The cover reaches 0.6 of the player's height, zoom 1 to 1.6, sides cropped. Bleed `:82-83, 120-122`.
2. **[phone only]** Below the cover: its bottom 18% (at least 2 rows), flipped and stretched (Catmull-Rom). Bleed `:78, 333-374`.
3. **[phone only]** Blur by depth (rows over the container width): 0 down to 0.70, then 250 × ((r − 0.70) / 0.85)^1.8 px at 1080 wide, full at 1.55; blended between the two nearest of {0, 1, 2, 3.5, 5.5, 8, 11, 15, 20, 27, 36, 48, 63, 82, 105, 135, 170, 210, 250}; 3 passes. Bleed `:51-59, 408-411, 427-429, 463`.
4. **[phone only]** Detail rows start at min(0.70 × width, art height − 48), on a multiple of 4; 0.40 of the width below that is drawn at full size, the rest at quarter size. Half size from sigma 4, quarter from sigma 8. Bleed `:66-72, 126-127, 156-163`.
5. **[phone only]** Tone: from the 10%-45% darkest pixels, saturation at most 0.5, lightness × 1.15 within 0.07..0.30; mixed in by 0.90 × smootherstep((r − 0.90) / 0.95). Bleed `:60-64, 298-327, 468`.
6. **[phone only]** The first 48 rows fade in; grain: a 64 px tile at alpha 3. Bleed `:73-74, 79, 102-106, 267-277`.
7. **[phone only]** Canvas crossfade 300 ms; the blurred art's scrim 0.12; full-screen blur 48 dp, clip bleed 24 dp. `ML/commonMain/kotlin/com/metrolist/shared/ui/player/CanvasLayers.kt:26`, `PlayerArtworkBackground.kt:970-972`.

Cases: `backdrop` (`blurRadius`, `bleedRows`, `coverZoom`, `stripRows`).

## 11. Quality badge shimmer

Original: `BCU/PlayerControls.kt:1861-1924` (ShimmerText), `BCU/PlayerChrome.kt:24-33`. Phone: `FEAT/PlayerScreen.java:987-1108`. PC: `src/plus/plus.css:467-482`.

1. **[both]** A confirmed lossless badge shimmers: the text at white 0.55; a band 0.6 × the text width each side of its centre, full white at the centre, sweeping left to right in 3000 ms, linear, restarting; the centre goes from −band to width + band. Painted SrcIn over the glyphs. PlayerControls `:1881-1922`.
2. **[phone only: the PC has no Plus-blended chrome]** Additive chrome, BitChord's PlayerChrome rule (the `chromeWhite` cases): every white is 0.15 lower, full white is 0.73. PlayerChrome `:24, 27, 32-33`. Phone `:987-993`.
3. **[phone only: phone layout]** The icon shimmers too, peaking at full white; the row sits 16 dp below the bar's middle and a third of the glyph's width left of centre. Phone `:1025, 1104, 1180`. No original.

Cases: `badge`.

## 12. Where the apps differ

The original is the rule. Each line: what, where.

### Phone against its original

The phone's 428206d (2026-11-19) brought Apple's scoring (brackets kept, no "and" split, the album in
the term and the score, BitChord's motion urls), Spotify's album and length checks, Prism's full
MusicVideoMatch, BestPart, `noFrames`, `choose`, the still refusal, the flash fallback's other part
and `cropX` to the original. What is left (line numbers from before that commit; some have moved):

- Source order: Apple runs only when `canvasApple=1` (off by default), and the music video is off whenever Spotify is (`canvasSpotify=0`). Metrolist switches Apple with animated covers and the other two with Canvas. `FEAT/AnimatedCover.java:423-425` vs `AnimatedCoverSelection.kt:43-46`.
- Source order: no wait for a source still loading; each source is asked in turn. `FEAT/AnimatedCover.java:467-593` vs `AnimatedCoverSelection.kt:140`.
- Cache key: Apple's key holds `|tall`, not the source order; BitChord's holds `spotifyFirst`. `FEAT/AnimatedCover.java:438` vs `CanvasRepository.kt:159-160`.
- Apple: the normaliser keeps non-Latin letters; BitChord's keeps a-z and 0-9 only. `FEAT/AppleCanvas.java:189-191` vs `CanvasArtwork.kt:73-79`.
- Apple: at most 3 albums read per lookup. `FEAT/AppleCanvas.java:80`.
- Apple: a fallback to the iTunes album page (Prism's). `FEAT/AppleCanvas.java:116-147`. Not in BitChord.
- Apple: YouTube's player gives no album, so the album part of the term and score is null in use.
- Spotify: the primary artist is cut from the artist line; Metrolist takes YouTube's first artist. `FEAT/SpotifyCanvas.java:100`.
- Music video: no pairing, no official-type check, no second try with other videos. `FEAT/VideoCanvas.java:246-260` vs `ClipFinder.kt:104-136`.
- No chorus source: `choose` takes the chorus as a parameter, null on the phone today.
- No face-based crop (ClipRefine `sceneCrops`, `closeUp`); `cropX` is Prism's 0.32 band. `PR/canvas/ClipRefine.kt:132-224`.
- Mesh: cells sampled every min(w, h)/96 px; the lift is applied after resampling and blur, not per cell before; rows below the seam are flipped and turned one column per row (no seeded random). `FEAT/ArtMesh.java:22, 44-61, 90-95` vs BC mesh `:605-606, 637, 677-691`.
- Backdrop: song-change crossfade 350 ms (Metrolist 300); scrim 0 (Metrolist 0.12). `FEAT/ArtBackdrop.java:43, 46` vs `CanvasLayers.kt:26`, `PlayerArtworkBackground.kt:972`.
- Badge: the band spans glyph, gap and text (BitChord: the text only); the glyph peaks at full white. `FEAT/PlayerScreen.java:1101-1105` vs PlayerControls `:1911-1913`.

### PC against the original

Fixed on the PC on 2026-11-19, so the cases pass: Apple's inline motion art without an album id and the static still (`src/plus/bg-plus.js`, a replaced `searchAndFetchMotion`); Spotify's album and length checks (`src/plus/bg-canvas.js` `matches`); the music-video match, BestPart, `noFrames`, `choose`, `judge`, `cropX` and the still refusal (`src/plus/video-canvas-page.js`, ports of Prism). What is left:

- Apple: the album is added to the term unless the term (with the artist) holds it; BitChord checks the title only. `src/apple-canvas.js:207` vs BC `:55`.
- Spotify: the length is the player's own, read by the song's id while it plays (`video-canvas-page.js` `playingLength`, passed on by `video-canvas.js`), asked for the song's id with or without the music video (the page's `length` op when the video canvas is off or already knows the song has none); the length isn't checked only when the player is on another song by then. The album is the player bar's.
- Spotify: a miss is kept 24 h in memory only, keyed `artist—title`, plus the length to 10 s when known (another version is asked again); a hit in `chrome.storage` with no expiry. `src/plus/bg-canvas.js`.
- Music video: the song's length is the player's own, by id, so lookups run for the playing song only; the PC never looks one up ahead (the page's `prefetch` op has no caller).
- Music video: no YouTube pairing, no official-type check, no second try with other videos (as the phone). vs `ClipFinder.kt:104-136`.
- No chorus from synced lyrics: `choose` gets none. No face-based crop.
- Display: bars are zoomed out by the storyboard's bars (keep share 0.5 to 0.98, no 1.6 cap); no tall-clip rule. `src/plus/video-canvas.js:56-64`.
- No mesh, no bleed. Badge: CSS only, no additive chrome. `src/plus/plus.css`.
- Settings (§13), as of 917f33f: the music video has no switch in the popup (`videoCanvasEnabled` is read by `src/plus/video-canvas.js:44`, default on); Spotify and Apple have a switch each and a "prefer" pick between the two (`canvasPrioritySelect`), not an ordered list of three; no animated cover quality, YouTube canvas quality or mode; no artist images or videos. The Spotify panel's text still speaks of the listener's Spotify session (`src/popup.html:2004`, `spotifyDisconnected`), against §4.1 and §13.9.

## 13. Settings

Original: Metrolist's Artwork page, `ML/commonMain/kotlin/com/metrolist/shared/ui/settings/AppearanceSettingsRegistration.kt:733-866`, with `ML/commonMain/kotlin/com/metrolist/shared/settings/Settings.kt` (`Settings.kt`) and `ML/commonMain/kotlin/com/metrolist/shared/ui/settings/SettingsFeatureControls.kt:100-175` (the source list). Where a setting is shown is each app's own (the phone's settings screen, the PC's popup); what it does is the rule.

1. **[both]** Two master switches: **Canvas** (the music video and Spotify) and **Animated covers** (Apple). A source whose master switch is off is greyed out in the list and never looked up. The music video also needs music-video playback on, where an app has that switch. `Settings.kt:409-417`, `AnimatedCoverSelection.kt:43-46`, `SettingsFeatureControls.kt:127-129`. Defaults: Metrolist ships both off (`Settings.kt:409, 705`); our apps ship canvas on, a deliberate difference.
2. **[both]** **Sources:** one row per source in the current order (music video, Spotify, Apple by default; §1), each with up and down to swap it with its neighbour and its own on/off switch. Turning a source off keeps its place in the order. `SettingsFeatureControls.kt:115-175`.
3. **[both]** How the two lists are stored and read (`AnimatedCoverSelection.kt:28-39`, `SettingsFeatureControls.kt:168-171`):
   - the order: source names joined by commas; unknown names are dropped, a repeat counts once, and sources missing from it follow in the default order;
   - the sources on: empty means all on; all off is stored as `NONE` (read as none on), never as empty;
   - the ids are ours: `video`, `spotify`, `apple` (Metrolist: `YOUTUBE_MUSIC_VIDEO`, `SPOTIFY_CANVAS`, `APPLE_MUSIC`).
4. **[phone only: a browser can't tell mobile data reliably (Firefox has no `navigator.connection`)]** **Off on mobile data**, default off. When on and the network is mobile data, no canvas or animated cover is looked up or played, artist videos included. `Settings.kt:706-709`. Metrolist hides it on desktop: `AppearanceSettingsRegistration.kt:773-779`.
5. **[both]** **Animated cover quality:** 360p, 720p (default), 1080p or Original; disabled while animated covers are off. Apple's HLS master list is read and the variant picked is the one with the most pixels (ties: the higher `BANDWIDTH`) whose shorter side is at most the cap (Original: no cap); when none fits, the one with the fewest pixels. Only trusted `.m3u8` variants count. The quality is part of the cache key (with `:tall` for the 3:4 clip). `Settings.kt:713`, `ML/commonMain/kotlin/com/metrolist/shared/api/artwork/AnimatedArtworkService.kt:1195-1245, 1276-1282`, `AnimatedCoverSelection.kt:48-51`.
6. **[both]** **YouTube canvas quality:** Auto, 2160p, 1440p, 1080p, 720p or 480p (default); the music video's stream is asked for at that height, Auto leaves it to the player. Changing it looks the song's video canvas up again. `Settings.kt:722`, `ML/commonMain/kotlin/com/metrolist/shared/settings/SettingEnums.kt:143-160`, `ML/commonMain/kotlin/com/metrolist/shared/viewmodels/PlayerViewModel.kt:782`.
7. **[both]** **YouTube canvas mode:** Clips (default) or Full video. Full video plays the whole music video, muted. Clips plays the part picked by §6-7; this is ours. Metrolist's clips are 4 random 3000 ms parts of the video (`AnimatedCoverSelection.kt:12, 55-79`), which our clip picking replaces. Metrolist shows both YouTube settings on Android only (`AppearanceSettingsRegistration.kt:824-866`).
8. **[both]** **Artist images** and **Artist videos** from Apple Music, for the artist page's header: two switches, both off by default (videos follow images until set), and an artist video quality with the same choices as rule 5, default 720p. Keyed by the storefront country and language, the artist's name, both switches and the quality. `Settings.kt:711-714`, `AnimatedArtworkService.kt:275-290`. Metrolist hides them on iOS.
9. **[both]** No Spotify login, and no setting for one: Spotify's canvas is anonymous only (§4.1). Metrolist 14.0.1's Spotify sign-in page is for importing playlists, not canvas.
10. **[both]** A change to the order, the sources on, the mode, either quality or a master switch clears the "failed" marks, so the new choice is tried at once. `ML/commonMain/kotlin/com/metrolist/shared/ui/player/PlayerScreen.kt:647-655`.

Cases: `settings` (`settingsOrder`, `settingsEnabled`, `appleVariant`).

/* Vivimusic Web+ — video-canvas-page.js  (runs in the page's MAIN world)
 *
 * Canvas from the song's music video, ported from the phone app (VideoCanvas,
 * BestPart's pick, ClipJudge): a YT Music video search scored by Prism's
 * MusicVideoMatch rules finds the video, its "Most replayed" curve and the
 * storyboard pick the part, only the DASH fragments of that part are fetched
 * (visionOS player URLs need no signature solving), and they are remuxed into a
 * small self-contained fragmented MP4 that loops muted over the art.
 *
 * Talks to the content script over window.postMessage on channel 'vivi-vcanvas':
 *   in : { op:'find', reqId, id, title, artist, album, durationSec }
 *        { op:'prefetch', reqId?, ids:[{ id, title, artist, album, durationSec }] }
 *        { op:'clear', reqId? }
 *        { op:'fetch', rid, ok, status, bytes, why }   (relay answer, see below)
 *   out: { reqId, ok:true, blobUrl, videoId, width, height, startSec, lenSec, crop?, from }
 *        { reqId, ok:false, why }
 *        { type:'fetch', rid, url }   bytes the page may not fetch itself (CORS): the
 *        content side fetches `url` (only *.ytimg.com / *.googlevideo.com) and answers
 *        with op 'fetch'. googlevideo ranges go through crossfade.js's existing
 *        'vivi-xfade' range relay instead, which already does exactly that.
 *
 * The pure parts are exposed on globalThis.__viviVideoCanvasCore so node can
 * check them against the phone's test fixtures (scripts/video_canvas_tests.mjs).
 */
(() => {
  'use strict';
  const G = typeof globalThis !== 'undefined' ? globalThis : this;
  const PAGE = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.postMessage === 'function';
  if (PAGE && window.__viviVCanvasPage) return;
  if (PAGE) window.__viviVCanvasPage = true;

  const CHANNEL = 'vivi-vcanvas';
  const CLIP_SEC = 8;
  const log = (...a) => console.log('%c[ViVi video canvas]', 'color:#7c9cff', ...a);
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

  // ═════════════════════════════ finding the video (VideoCanvas.findVideo) ═════════════════════════════

  const VIDEOS = 'EgWKAQIQAWoMEA4QChADEAQQCRAF';
  /** Never the song's video, whoever posted it (Prism's MusicVideoMatch). */
  const NEVER = ['lyric', 'lyrics', 'letra', 'letras', 'paroles', 'testo', 'traducida', 'traducción', 'sub español',
    'subtitulad', 'перевод', 'текст', 'karaoke', 'instrumental', 'reaction', 'tutorial', 'lesson', 'guitar', 'piano',
    'drum', 'bass', 'slowed', 'sped up', 'nightcore', '8d', 'fan made', 'fanmade', 'remix', 'highlights', 'edit audio',
    'official audio', 'audio oficial', 'audio only', 'rebassed', 'bass boosted', 'bassboosted', 'boosted', 'reverb',
    'daycore', 'speed up', '1 hour', '10 hours', 'loop', 'mashup', 'parody', 'ai cover'];
  /** A frequency in the title ("(25-70Hz)", "432hz") marks a re-tuned or bass-boosted copy. */
  const HZ = /(?<![\p{L}])\d+\s?hz(?![\p{L}])/u;
  /** Another take on the song: fine when the song is that take itself. */
  const OTHER_TAKE = ['cover', 'acoustic', 'acústic', 'unplugged', 'live', 'en vivo', 'ao vivo', 'concert', 'session'];
  /** Bracket words that don't name a source. */
  const GENERIC = new Set(['feat', 'with', 'from', 'the', 'and', 'version', 'session', 'sessions', 'live', 'remaster',
    'remastered', 'edit', 'radio', 'mix', 'original', 'deluxe', 'explicit', 'clean', 'cover', 'acoustic', 'mono', 'stereo', 'single']);
  /** Record labels that post their artists' official videos (normalized channel names). */
  const LABELS = new Set(['fueledbyramen', 'atlanticrecords', 'warnerrecords', 'warnermusic', 'elektrarecords',
    'roadrunnerrecords', 'interscope', 'interscoperecords', 'republicrecords', 'islandrecords', 'defjam', 'defjamrecordings',
    'capitolrecords', 'columbiarecords', 'epicrecords', 'rcarecords', 'sonymusic', 'sonymusicentertainment',
    'universalmusicgroup', 'emimusic', 'parlophone', 'parlophonerecords', 'epitaphrecords', 'hopelessrecords', 'riserecords',
    'sumerianrecords', 'nuclearblastrecords', 'spinninrecords', 'monstercat', 'ultramusic', 'armadamusic', 'xlrecordings',
    'subpop', 'dominorecordco', '4ad', 'matadorrecords', 'bigmachinerecords', 'rhinorecords', 'motownrecords', 'topdawgent',
    'xorecords', 'glassnoterecords']);
  const LABEL_WORDS = /(?<![\p{L}])(records|recordings|music group|entertainment|label)(?![\p{L}])/u;
  /** The artist's upload: the song's length give or take LOOSE_S; someone else's: the very recording, within TIGHT_S. */
  const LOOSE_S = 150, TIGHT_S = 4;

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRes = new Map();
  const wordRe = (w) => {
    let r = wordRes.get(w);
    if (!r) wordRes.set(w, r = new RegExp('(?<![\\p{L}\\p{N}])' + reEsc(w) + '(?![\\p{L}\\p{N}])', 'u'));
    return r;
  };

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  }

  /** The artists named in YT's artist line ("A & B", "A, B", "A x B", "A feat. B"). */
  function artists(artist) {
    const out = [];
    if (artist != null) {
      for (const a of String(artist).split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)) {
        if (norm(a)) out.push(a.trim());
      }
    }
    return out;
  }

  /** "NirvanaVEVO", "Official Billie Eilish" -> the artist's own name, normalized. */
  function officialChannel(n) {
    const name = n;
    for (const s of ['vevo', 'official', 'oficial', 'officiel', 'offiziell', 'ufficiale', 'music', 'tv', 'channel']) {
      if (n.endsWith(s)) n = n.substring(0, n.length - s.length);
    }
    if (n.startsWith('official')) n = n.substring(8);
    return n ? n : name;
  }

  function has(words, text, song) {
    for (const w of words) {
      const p = wordRe(w);
      if (p.test(text) && !p.test(song)) return true;
    }
    return false;
  }
  const never = (text, song) => has(NEVER, text, song) || (HZ.test(text) && !HZ.test(song));

  /** The title without brackets, "| ..." tails, feat. credits, video words and the artists' names. */
  function titleCore(title, names) {
    let t = String(title).toLowerCase().replace(/\(.*?\)|\[.*?]|【.*?】/g, ' ');
    const bar = t.indexOf(' | ');
    if (bar >= 0) t = t.substring(0, bar);
    const slashes = t.indexOf(' // ');
    if (slashes >= 0) t = t.substring(0, slashes);
    t = t.replace(/\s(ft\.?|feat\.?|featuring)\s.*$/, ' ')
      .replace(/(?<![\p{L}])(official|music|video|videoclip|clip|hd|4k|hq|remastered|remaster|visualizer|mv|m\/v)(?![\p{L}])/gu, ' ');
    t = norm(t);
    for (const n of names) if (t !== n && n) t = t.split(n).join('');
    return t;
  }

  /** Whether a video's title is the song's: the song's artists' and the channel's names (and "official" forms) out. */
  function sameTitle(songTitle, artistList, videoTitle, channel) {
    const want = titleCore(songTitle, []);
    if (!want) return false;
    const names = [...new Set([...artistList, channel].map(norm).filter((n) => n.length >= 2)
      .flatMap((n) => [n, officialChannel(n)]))].sort((x, y) => y.length - x.length);
    return want === titleCore(videoTitle, names);
  }

  /** Posted by the artist's record label, naming the artist: a label we know, or a "… Records" channel saying official. */
  function byLabel(videoTitle, channel, names) {
    if (!names.some((n) => norm(videoTitle).includes(n))) return false;
    return LABELS.has(norm(channel))
      || (LABEL_WORDS.test(String(channel).toLowerCase()) && /(?<![\p{L}])official(?![\p{L}])/u.test(String(videoTitle).toLowerCase()));
  }

  /**
   * The song's music video among search results [id, title, channel, durationSec] (Prism's MusicVideoMatch.pick):
   * the artist's (or their label's) upload within LOOSE_S of the song, not another take; else, for a song naming a
   * source in brackets ("SiriusXM Session"), that recording by whoever posted it, within TIGHT_S, naming the artist.
   * A studio song takes nobody else's upload. A length of 0 is unknown.
   */
  function pick(songTitle, artistList, durationSec, results) {
    const names = artistList.map(norm).filter(Boolean);
    if (!norm(songTitle) || !names.length) return null;
    const song = String(songTitle).toLowerCase();
    // the source the song names in its brackets ("SiriusXM Session" -> "siriusxm"), without the generic words
    const source = [...new Set((song.match(/\(.*?\)|\[.*?]/g) || []).flatMap((m) => m.split(/[^\p{L}\p{N}]+/u))
      .filter((w) => w.length > 2 && !GENERIC.has(w)))];
    const dur = Number(durationSec) || 0;
    const within = (v, s) => dur === 0 || !v[3] || Math.abs(v[3] - dur) <= s;
    // the channel counts too ("Rebassed by Justin"), unless it is the artist's own (The Piano Guys)
    const own = (v) => { const ch = officialChannel(norm(v[2])); return !!ch && names.includes(ch); };
    const candidates = results.filter((v) => sameTitle(songTitle, artistList, v[1], v[2])
      && !never(String(v[1]).toLowerCase(), song) && (own(v) || !never(String(v[2]).toLowerCase(), song)));
    const first = candidates.find((v) => (own(v) || byLabel(v[1], v[2], names)) && within(v, LOOSE_S)
      && !has(OTHER_TAKE, String(v[1]).toLowerCase(), song));
    if (first) return first;
    if (!source.length) return null;
    return candidates.find((v) => {
      const words = String(v[1]).toLowerCase(), where = words + ' ' + String(v[2]).toLowerCase();
      return within(v, TIGHT_S) && dur > 0 && v[3] > 0 && names.some((n) => norm(words).includes(n))
        && source.some((w) => where.includes(w));
    }) || null;
  }

  /** One video against the song, lengths unknown. */
  function matches(songTitle, artistList, videoTitle, channel) {
    return !!pick(songTitle, artistList, 0, [['', videoTitle, channel, 0]]);
  }

  function runsText(text) {
    if (!text) return '';
    if (!Array.isArray(text.runs)) return text.simpleText || '';
    return text.runs.map((r) => (r && r.text) || '').join('');
  }

  function flexText(fc, i) {
    const r = fc[i] && fc[i].musicResponsiveListItemFlexColumnRenderer;
    return (r && r.text) || null;
  }

  /** "3:45" or "1:02:03" in seconds; 0 when it is not a length. */
  function lengthOf(text) {
    const t = String(text || '').trim();
    if (!/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return 0;
    return t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  }

  /** [videoId, title, channel, durationSec] of each search result (the length from the fixed column, else the subtitle's last time). */
  function searchResults(node, out = []) {
    if (Array.isArray(node)) {
      for (const x of node) searchResults(x, out);
    } else if (node && typeof node === 'object') {
      const r = node.musicResponsiveListItemRenderer;
      if (r && typeof r === 'object') {
        const id = (r.playlistItemData && r.playlistItemData.videoId) || '';
        const fc = r.flexColumns;
        if (id && Array.isArray(fc) && fc.length > 1) {
          const second = flexText(fc, 1);
          const rr = second && second.runs;
          const fixed = Array.isArray(r.fixedColumns) && r.fixedColumns[0] && r.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
          let len = lengthOf(fixed && runsText(fixed.text));
          for (let i = 1; !len && i < fc.length; i++) {
            const runs = (flexText(fc, i) || {}).runs;
            if (Array.isArray(runs)) for (const x of runs) len = lengthOf(x && x.text) || len;
          }
          out.push([id, runsText(flexText(fc, 0)), Array.isArray(rr) && rr.length ? (rr[0] && rr[0].text) || '' : '', len]);
        }
        return out;
      }
      for (const k of Object.keys(node)) searchResults(node[k], out);
    }
    return out;
  }

  // ═════════════════════════════ the stream (VideoCanvas.pickFormat) ═════════════════════════════

  /** The video-only H.264 DASH stream nearest below [want] px tall, at most 30 fps. */
  function pickFormat(streaming, want) {
    const a = streaming && streaming.adaptiveFormats;
    if (!Array.isArray(a)) return null;
    let best = null;
    for (const f of a) {
      if (!f || !String(f.mimeType || '').startsWith('video/mp4; codecs="avc1') || !f.url
        || !f.initRange || !f.indexRange || (f.fps == null ? 30 : Number(f.fps)) > 30) continue;
      const h = Number(f.height) || 0;
      if (best == null) best = f;
      else {
        const bh = Number(best.height) || 0;
        const better = h <= want ? (bh > want || h > bh) : (bh > want && h < bh);
        if (better) best = f;
      }
    }
    return best;
  }

  // ═════════════════════════════ the part (VideoCanvas.heatmapOf / partStart, BestPart) ═════════════════════════════

  /** YouTube's "Most replayed" curve as {start s, duration s, intensity} per marker, flattened; or null. */
  function heatmapOf(next) {
    const muts = next && next.frameworkUpdates && next.frameworkUpdates.entityBatchUpdate
      && next.frameworkUpdates.entityBatchUpdate.mutations;
    if (!Array.isArray(muts)) return null;
    for (const mu of muts) {
      const list = mu && mu.payload && mu.payload.macroMarkersListEntity && mu.payload.macroMarkersListEntity.markersList;
      if (!list || list.markerType !== 'MARKER_TYPE_HEATMAP') continue;
      const mk = list.markers;
      if (!Array.isArray(mk) || mk.length < 10) continue;
      const out = new Array(mk.length * 3);
      for (let k = 0; k < mk.length; k++) {
        const o = mk[k] || {};
        out[k * 3] = (Number(o.startMillis) || 0) / 1000;
        out[k * 3 + 1] = (Number(o.durationMillis) || 0) / 1000;
        out[k * 3 + 2] = Number(o.intensityScoreNormalized) || 0;
      }
      return out;
    }
    return null;
  }

  /**
   * Where the most replayed stretch begins, in seconds, or null when nothing stands out or the song is too short
   * (Prism's BestPart.peakMs). [dur] is the song's length in seconds (0: the curve's own). Each moment of a ~9 s
   * smoothed curve is measured against the median of the curve about 45 s either side (the opening left out); the
   * biggest rise, as a share over that trend, wins, pulled back to where the heat starts to rise.
   */
  function partStart(heat, dur) {
    if (heat == null) return null;
    const n = Math.floor(heat.length / 3);
    if (n < MIN_SEGMENTS) return null;
    // YouTube's segments are equal (the length / 100); the median in case one is cut short at the end
    const seg = Math.round([...Array(n).keys()].map((i) => heat[i * 3 + 1]).sort((a, b) => a - b)[idiv(n, 2)] * 1000);
    if (!(seg > 0)) return null;
    const duration = dur > 0 ? dur * 1000 : seg * n;
    if (duration < MIN_SONG_MS) return null;
    const v = new Array(n), smooth = new Array(n), trend = new Array(n);
    for (let i = 0; i < n; i++) v[i] = Math.max(0, Math.min(1, heat[i * 3 + 2]));
    const half = Math.max(1, Math.round(4500 / seg));
    for (let i = 0; i < n; i++) {
      let sum = 0, c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++, c++) sum += v[j];
      smooth[i] = sum / c;
    }
    const wide = Math.max(3, Math.round(TREND_HALF_MS / seg));
    for (let i = 0; i < n; i++) {
      const w = smooth.slice(Math.max(1, i - wide), Math.min(n - 1, i + wide) + 1).sort((a, b) => a - b);
      trend[i] = w[idiv(w.length, 2)];
    }
    const over = (x, i) => x / Math.max(trend[i], TREND_FLOOR) - 1;
    const head = Math.max(PART_HEAD_MS, 2 * seg);
    const isCandidate = (i) => i >= 0 && i * seg >= head && i * seg <= duration - PART_TAIL_MS;
    let peak = -1;
    for (let i = 0; i < n; i++) if (isCandidate(i) && (peak < 0 || over(smooth[i], i) > over(smooth[peak], peak))) peak = i;
    if (peak < 0) return null;
    const rise = over(smooth[peak], peak);
    if (rise < MIN_RISE || smooth[peak] - trend[peak] < MIN_LIFT) return null;
    // back to where the heat starts to rise: half the peak's rise above the trend
    const floor = rise * 0.5;
    let start = peak;
    while (isCandidate(start - 1) && over(smooth[start - 1], start - 1) >= floor) start--;
    // the rise is gradual in the smoothed curve; the raw segments say where it actually jumps
    let jump = start;
    for (let i = start; i <= peak; i++) if (over(v[i], i) >= floor) { jump = i; break; }
    return jump * seg / 1000;
  }

  /** A video with no preview frames: its middle WINDOW_MS (Prism's FrameJudge.noFrames), [startMs, endMs]. */
  function noFrames(lengthMs) {
    const w = Math.min(WINDOW_MS, lengthMs);
    const start = Math.max(0, Math.trunc((lengthMs - w) / 2));
    return [start, start + w];
  }

  // ═════════════════════════════ frame judging (ClipJudge) ═════════════════════════════

  const W = 32, H = 18;
  // Prism's BestPart: no part in the first 5 s (or 2 segments) or the last 30 s, none in a song under 60 s
  const PART_HEAD_MS = 5000, PART_TAIL_MS = 30000, MIN_SONG_MS = 60000, MIN_SEGMENTS = 10;
  const MIN_RISE = 0.08, MIN_LIFT = 0.03, TREND_HALF_MS = 45000, TREND_FLOOR = 0.05;
  /** Fewer preview frames than this can't tell a still from a moving video (Prism's ClipFinder). */
  const MIN_FRAMES = 8;
  const WINDOW_MS = 8000, HEAD_MS = 12000, TAIL_MS = 15000, MIN_LOOP_MS = 5000, MAX_LOOP_MS = 9000;
  const BLACK = 24, LIT = 48;
  const BAR_SHARE = 0.9, STEP_MOVE = 3, STILL_SHARE = 0.6, WINDOW_STILL_SHARE = 0.75;
  const IDEAL_MOVE = 18, FRANTIC_MOVE = 60, DARK = 16, BRIGHT = 64, CROP_SHARE = 0.32, CROP_LEAD = 1.15;
  const PEAK_BEFORE_MS = 4000, PEAK_AFTER_MS = 8000, CHORUS_NEAR_MS = 10000, APART_MS = 15000, RUNNERS_UP = 4;
  const GOOD_ENOUGH = 0.3;
  const CUT = 22, FLASH_AREA = 0.25;
  const FLASH_STEP = 26, FLASH_CHANGES = 7;
  const idiv = (a, b) => Math.trunc(a / b);

  /** One frame reduced to W x H grey values (0..255), row by row. */
  function grid(luma, width, x0, y0, w, h) {
    const out = new Array(W * H);
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const ya = y0 + idiv(cy * h, H), yb = Math.max(ya + 1, y0 + idiv((cy + 1) * h, H));
        const xa = x0 + idiv(cx * w, W), xb = Math.max(xa + 1, x0 + idiv((cx + 1) * w, W));
        let sum = 0, n = 0;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++, n++) sum += luma[y * width + x];
        out[cy * W + cx] = n > 0 ? idiv(sum, n) : 0;
      }
    }
    return out;
  }

  /** Black bars baked into the picture: [left, top, right, bottom] as shares of the frame. */
  function bars(frames) {
    const lit = frames.filter((f) => f.some((v) => v >= LIT));
    if (lit.length < 3) return [0, 0, 0, 0];
    const need = lit.length * BAR_SHARE;
    const col = new Array(W).fill(false), row = new Array(H).fill(false);
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (const f of lit) {
        let b = 0;
        for (let y = 0; y < H; y++) if (f[y * W + x] <= BLACK) b++;
        if (b >= idiv(H * 9, 10)) c++;
      }
      col[x] = c >= need;
    }
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (const f of lit) {
        let b = 0;
        for (let x = 0; x < W; x++) if (f[y * W + x] <= BLACK) b++;
        if (b >= idiv(W * 9, 10)) c++;
      }
      row[y] = c >= need;
    }
    let left = 0, right = 0, top = 0, bottom = 0;
    while (left < W && col[left]) left++;
    while (right < W - left && col[W - 1 - right]) right++;
    while (top < H && row[top]) top++;
    while (bottom < H - top && row[H - 1 - bottom]) bottom++;
    if (left + right > idiv(W, 2)) left = right = 0;
    if (top + bottom > idiv(H, 2)) top = bottom = 0;
    return [left / W, top / H, right / W, bottom / H];
  }

  /** The picture inside the bars, in cells: [x0, y0, x1, y1]. */
  function area(b) {
    return [Math.round(b[0] * W), Math.round(b[1] * H), W - Math.round(b[2] * W), H - Math.round(b[3] * H)];
  }

  function middle(a) {
    const dx = Math.round((a[2] - a[0]) * 0.2), dy = Math.round((a[3] - a[1]) * 0.2);
    return [a[0] + dx, a[1] + dy, Math.max(a[0] + dx + 1, a[2] - dx), Math.max(a[1] + dy + 1, a[3] - dy)];
  }

  function diff(p, q, a) {
    let sum = 0;
    for (let y = a[1]; y < a[3]; y++) for (let x = a[0]; x < a[2]; x++) sum += Math.abs(p[y * W + x] - q[y * W + x]);
    return sum / ((a[2] - a[0]) * (a[3] - a[1]));
  }

  function mean(g, a) {
    let sum = 0;
    for (let y = a[1]; y < a[3]; y++) for (let x = a[0]; x < a[2]; x++) sum += g[y * W + x];
    return sum / ((a[2] - a[0]) * (a[3] - a[1]));
  }

  /** A still upload: most steps show no change in the middle of the picture. */
  function still(frames, b) {
    if (frames.length < 2) return true;
    const m = middle(area(b));
    let n = 0;
    for (let i = 1; i < frames.length; i++) if (diff(frames[i - 1], frames[i], m) < STEP_MOVE) n++;
    return n / (frames.length - 1) >= STILL_SHARE;
  }

  /** [startMs, endMs, score] of every scoring ~8 s window, one per frame. */
  function windows(frames, intervalMs, lengthMs, b) {
    const out = [];
    if (frames.length < 2 || intervalMs <= 0) return out;
    const a = area(b), m = middle(a);
    const steps = Math.max(1, Math.min(frames.length - 1, Math.round(WINDOW_MS / intervalMs)));
    const move = [], moveMid = [], light = [];
    for (let i = 0; i + 1 < frames.length; i++) {
      move[i] = diff(frames[i], frames[i + 1], a);
      moveMid[i] = diff(frames[i], frames[i + 1], m);
    }
    for (let i = 0; i < frames.length; i++) light[i] = mean(frames[i], a);
    const roomy = lengthMs >= HEAD_MS + TAIL_MS + 3 * WINDOW_MS;
    for (let i = 0; i <= frames.length - 1 - steps; i++) {
      const start = i * intervalMs, end = Math.min(start + WINDOW_MS, lengthMs);
      const nearEnds = start < HEAD_MS || end > lengthMs - TAIL_MS;
      if (nearEnds && roomy) continue;
      let stillN = 0, motion = 0, bright = 0, dark = 0;
      for (let k = i; k < i + steps; k++) {
        if (moveMid[k] < STEP_MOVE) stillN++;
        motion += move[k];
      }
      if (stillN >= steps * WINDOW_STILL_SHARE) continue;
      for (let k = i; k <= i + steps; k++) {
        bright += light[k];
        if (light[k] < DARK) dark++;
      }
      motion /= steps;
      bright /= steps + 1;
      dark /= steps + 1;
      const moveScore = motion <= IDEAL_MOVE ? motion / IDEAL_MOVE
        : 1 - 0.5 * Math.min(1, (motion - IDEAL_MOVE) / (FRANTIC_MOVE - IDEAL_MOVE));
      const brightScore = Math.max(0, Math.min(1, (bright - DARK) / (BRIGHT - DARK)));
      out.push([start, end, moveScore * brightScore * (1 - dark) * (nearEnds ? 0.5 : 1)]);
    }
    return out;
  }

  /** Best first; equal scores: the earlier start (the answer never depends on the windows' order). */
  const better = (w, than) => than == null || w[2] > than[2] || (w[2] === than[2] && w[0] < than[0]);

  /**
   * The loop's window (Prism's FrameJudge.choose): the best near the "Most replayed" peak (one in the first
   * HEAD_MS is the intro: ignored), else near the chorus, else in the middle third, each only from windows
   * scoring above 0 and at least GOOD_ENOUGH of the best; else the best anywhere, even at 0. Null without windows.
   * [peakMs] and [chorusMs]: -1 or null when unknown.
   */
  function choose(wins, lengthMs, peakMs, chorusMs) {
    let top = null;
    for (const w of wins) if (better(w, top)) top = w;
    const pick = (near) => {
      let b = null;
      for (const w of wins) if (near(w) && w[2] > 0 && w[2] >= top[2] * GOOD_ENOUGH && better(w, b)) b = w;
      return b;
    };
    let w = null;
    if (peakMs != null && peakMs >= HEAD_MS) w = pick((x) => x[0] >= peakMs - PEAK_BEFORE_MS && x[0] <= peakMs + PEAK_AFTER_MS);
    if (!w && chorusMs != null && chorusMs >= 0) w = pick((x) => Math.abs(x[0] - chorusMs) <= CHORUS_NEAR_MS);
    // a third as Prism's Long division gives it
    if (!w) w = pick((x) => x[0] >= Math.trunc(lengthMs / 3) && x[0] <= Math.trunc(lengthMs * 2 / 3));
    if (!w) for (const x of wins) if (better(x, w)) w = x;
    return w;
  }

  /** Other good parts' starts (Prism's FrameJudge.runnersUp): scoring windows, best first, APART_MS from the chosen and each other. */
  function runnersUp(wins, chosenMs) {
    const taken = [chosenMs], out = [];
    for (const w of wins.filter((x) => x[2] > 0).sort((x, y) => (better(x, y) ? -1 : better(y, x) ? 1 : 0))) {
      if (out.length >= RUNNERS_UP) break;
      if (taken.some((t) => Math.abs(t - w[0]) < APART_MS)) continue;
      taken.push(w[0]); out.push(w[0]);
    }
    return out;
  }

  /**
   * Prism's FrameJudge.judge on storyboard frames: null for a still upload (also when every window is left out),
   * else the window { startMs, endMs, score }, the crop and bars, and every window (for another part later).
   */
  function judge(frames, intervalMs, lengthMs, peakMs, chorusMs) {
    const length = Math.max(lengthMs, frames.length * intervalMs);
    const b = bars(frames);
    if (still(frames, b)) return null;
    const wins = windows(frames, intervalMs, length, b);
    const w = choose(wins, length, peakMs, chorusMs);
    if (!w) return null;
    const first = Math.trunc(w[0] / intervalMs), last = Math.min(frames.length - 1, Math.trunc((w[1] + intervalMs - 1) / intervalMs));
    return { startMs: w[0], endMs: w[1], score: w[2], cropX: cropX(frames.slice(first, last + 1), b), bars: b, windows: wins, length };
  }

  function sumOf(w, from, n) {
    let s = 0;
    for (let i = from; i < from + n; i++) s += w[i];
    return s;
  }

  /**
   * Where the square crop sits across the picture inside the bars (0 left, 0.5 centred, 1 right):
   * the band of CROP_SHARE of its width (what a full-height upright crop of 16:9 keeps, as Prism's
   * FrameJudge) that holds the most detail and movement, when it clearly leads the centre.
   */
  function cropX(frames, b) {
    const a = area(b);
    const aw = a[2] - a[0], ah = a[3] - a[1];
    if (!frames.length || aw < 4 || ah < 1) return 0.5;
    const weight = new Array(aw).fill(0);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      for (let y = a[1]; y < a[3]; y++) {
        for (let x = a[0]; x < a[2]; x++) {
          const k = x - a[0];
          if (x + 1 < a[2]) {
            const d = Math.abs(f[y * W + x + 1] - f[y * W + x]);
            weight[k] += d / 2;
            weight[k + 1] += d / 2;
          }
          if (i > 0) weight[k] += Math.abs(f[y * W + x] - frames[i - 1][y * W + x]);
        }
      }
    }
    const band = Math.max(1, Math.min(aw, Math.round(aw * CROP_SHARE)));
    const room = aw - band;
    if (room <= 0) return 0.5;
    const centre = sumOf(weight, idiv(room, 2), band);
    let bestAt = idiv(room, 2), best = centre;
    for (let s = 0; s <= room; s++) {
      const v = sumOf(weight, s, band);
      if (v > best || (v === best && Math.abs(s * 2 - room) < Math.abs(bestAt * 2 - room))) { best = v; bestAt = s; }
    }
    if (best <= centre * CROP_LEAD) return 0.5;
    return bestAt / room;
  }

  function change(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  /** The times of the first frame after each cut (a lone large change, not movement or a dissolve). */
  function cuts(frames, times) {
    const out = [];
    if (frames.length < 3) return out;
    const d = new Array(frames.length).fill(0);
    for (let i = 1; i < frames.length; i++) d[i] = change(frames[i - 1], frames[i]);
    for (let i = 1; i < frames.length; i++) {
      const before = i > 1 ? d[i - 1] : 0, after = i + 1 < frames.length ? d[i + 1] : 0;
      if (d[i] >= CUT && d[i] >= 3 * Math.max(Math.max(before, after), 2)) out.push(times[i]);
    }
    return out;
  }

  /** More than three flashes in any one second over a quarter of the picture or more (frames before [untilMs]). */
  function flashing(frames, times, untilMs) {
    const at = [], up = [];
    for (let i = 1; i < frames.length && times[i] < untilMs; i++) {
      const a = frames[i - 1], b = frames[i];
      let cells = 0, sum = 0;
      for (let k = 0; k < a.length; k++) {
        const st = b[k] - a[k];
        if (Math.abs(st) >= FLASH_STEP) { cells++; sum += st; }
      }
      if (cells >= a.length * FLASH_AREA && sum !== 0) { at.push(times[i]); up.push(sum > 0); }
    }
    for (let i = 0; i < at.length; i++) {
      let changes = 1, last = up[i];
      for (let j = i + 1; j < at.length && at[j] - at[i] <= 1000; j++) {
        if (up[j] !== last) { changes++; last = up[j]; }
      }
      if (changes >= FLASH_CHANGES) return true;
    }
    return false;
  }

  /**
   * Where the loop ends (ms from the clip's start): on the last cut leaving it 5 to 9 s long, else 8 s
   * or where the frames end; moved to earlier cuts while it flashes. -1 when it still flashes.
   */
  function loopEnd(frames, times, framesEndMs) {
    const cs = cuts(frames, times);
    let end = -1;
    for (const c of cs) if (c >= MIN_LOOP_MS && c <= MAX_LOOP_MS && c <= framesEndMs) end = c;
    if (end < 0) end = Math.max(1, Math.min(WINDOW_MS, framesEndMs));
    while (flashing(frames, times, end)) {
      let earlier = -1;
      for (const c of cs) if (c < end && c >= MIN_LOOP_MS) earlier = c;
      if (earlier < 0) return -1;
      end = earlier;
    }
    return end;
  }

  /**
   * The phone keeps {cropX, bars} in its .crop sidecar and crops when drawing. Here it is handed over
   * as a rect in fractions of the whole frame: the square (picture-tall) band inside the bars.
   */
  function cropRect(cx, b, width, height) {
    const ax = b[0], ay = b[1], aw = Math.max(0, 1 - b[0] - b[2]), ah = Math.max(0, 1 - b[1] - b[3]);
    if (!(width > 0 && height > 0) || aw <= 0 || ah <= 0) return null;
    const side = Math.min(aw, ah * height / width);
    const r = (x) => Math.round(x * 10000) / 10000;
    return { x: r(ax + cx * (aw - side)), y: r(ay), w: r(side), h: r(ah) };
  }

  // ═════════════════════════════ storyboard (VideoCanvas.board) ═════════════════════════════

  /** Prism's Storyboard on the largest level: tile size, count, layout, interval and each sheet's URL. */
  function storyboardPlan(spec, lengthMs) {
    if (!spec) return null;
    const parts = String(spec).split('|');
    if (parts.length < 2) return null;
    const f = parts[parts.length - 1].split('#');
    if (f.length < 8) return null;
    const [w, h, count, cols, rows] = f.slice(0, 5).map((x) => parseInt(x, 10));
    let interval = parseInt(f[5], 10);
    if ([w, h, count, cols, rows, interval].some((x) => !Number.isFinite(x))) return null;
    if (interval <= 0) interval = lengthMs > 0 ? idiv(lengthMs, count) : 0;
    if (w <= 0 || h <= 0 || count <= 0 || interval <= 0 || cols <= 0 || rows <= 0) return null;
    const level = parts.length - 2, per = cols * rows, sheets = Math.ceil(count / per);
    const url = (n) => parts[0].split('$L').join(String(level)).split('$N').join(f[6].split('$M').join(String(n)))
      + '&sigh=' + f[7].split('$').join('%24');
    return { w, h, count, cols, rows, interval, per, sheets, url };
  }

  // ═════════════════════════════ sidx and mp4 (VideoCanvas.Sidx, cut, remux) ═════════════════════════════

  const rd16 = (u, i) => (u[i] << 8) | u[i + 1];
  const rd32 = (u, i) => ((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0;
  const rd64 = (u, i) => rd32(u, i) * 4294967296 + rd32(u, i + 4);
  const str4 = (u, i) => String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);

  /** One segment index box: where each fragment's bytes and time are. */
  function parseSidx(b, at) {
    if (at + 8 > b.length || rd32(b, at + 4) !== 0x73696478) return null; // 'sidx'
    let p = at + 8;
    const version = b[p];
    p += 8; // version/flags, reference id
    const s = { timescale: rd32(b, p), earliest: 0, sizes: [], durations: [] };
    p += 4;
    let firstOffset;
    if (version === 0) {
      s.earliest = rd32(b, p);
      firstOffset = rd32(b, p + 4);
      p += 8;
    } else {
      s.earliest = rd64(b, p);
      firstOffset = rd64(b, p + 8);
      p += 16;
    }
    if (firstOffset !== 0) return null;
    p += 2;
    const count = rd16(b, p);
    p += 2;
    for (let i = 0; i < count; i++) {
      s.sizes.push(rd32(b, p) & 0x7fffffff);
      s.durations.push(rd32(b, p + 4));
      p += 12;
    }
    return s;
  }

  /**
   * Byte range [from, to] (inclusive) of the fragments covering [start, start + len], fragments
   * from [base], and the first one's video time in microseconds.
   */
  function sidxRange(s, start, len, base) {
    let off = base, t = s.earliest, from = -1, to = -1, fromTime = s.earliest;
    for (let i = 0; i < s.sizes.length; i++) {
      const a = t / s.timescale, z = (t + s.durations[i]) / s.timescale;
      if (z > start && a < start + len) {
        if (from < 0) { from = off; fromTime = t; }
        to = off + s.sizes[i] - 1;
      }
      off += s.sizes[i];
      t += s.durations[i];
    }
    if (from < 0) { from = base; to = base + s.sizes[0] - 1; }
    return [from, to, Math.round(fromTime * 1e6 / s.timescale)];
  }

  function readBoxes(u, from, to) {
    const out = [];
    let i = from;
    while (i + 8 <= to) {
      let size = rd32(u, i), hdr = 8;
      const type = str4(u, i + 4);
      if (size === 1) { size = rd64(u, i + 8); hdr = 16; } else if (size === 0) size = to - i;
      if (size < hdr) break;
      if (i + size > to) { out.push({ type, start: i, hdr, end: to, partial: true }); break; }
      out.push({ type, start: i, hdr, end: i + size });
      i += size;
    }
    return out;
  }
  const kid = (u, box, type, skip = 0) => box && readBoxes(u, box.start + box.hdr + skip, box.end).find((b) => b.type === type && !b.partial);
  const kids = (u, box, type) => readBoxes(u, box.start + box.hdr, box.end).filter((b) => b.type === type && !b.partial);

  /** The init segment's facts: boxes to copy, timescales, track, avcC and trex defaults. */
  function parseInit(u, initLen) {
    const top = readBoxes(u, 0, initLen);
    const ftyp = top.find((b) => b.type === 'ftyp'), moov = top.find((b) => b.type === 'moov' && !b.partial);
    if (!moov) throw new Error('no moov in the init segment');
    const mvhd = kid(u, moov, 'mvhd');
    const movieTs = mvhd ? rd32(u, mvhd.start + mvhd.hdr + (u[mvhd.start + mvhd.hdr] ? 20 : 12)) : 0;
    const trak = kid(u, moov, 'trak');
    const tkhd = kid(u, trak, 'tkhd');
    const trackId = tkhd ? rd32(u, tkhd.start + tkhd.hdr + (u[tkhd.start + tkhd.hdr] ? 20 : 12)) : 1;
    const mdia = kid(u, trak, 'mdia');
    const mdhd = kid(u, mdia, 'mdhd');
    const mediaTs = mdhd ? rd32(u, mdhd.start + mdhd.hdr + (u[mdhd.start + mdhd.hdr] ? 20 : 12)) : 0;
    if (!mediaTs) throw new Error('no media timescale');
    const stsd = kid(u, kid(u, kid(u, mdia, 'minf'), 'stbl'), 'stsd');
    const entry = stsd && readBoxes(u, stsd.start + stsd.hdr + 8, stsd.end)[0];
    let avcC = null, width = 0, height = 0;
    if (entry && /^avc[13]$/.test(entry.type)) {
      width = rd16(u, entry.start + entry.hdr + 24);
      height = rd16(u, entry.start + entry.hdr + 26);
      const c = readBoxes(u, entry.start + entry.hdr + 78, entry.end).find((b) => b.type === 'avcC');
      if (c) avcC = u.slice(c.start + c.hdr, c.end);
    }
    const mvex = kid(u, moov, 'mvex');
    const trexBox = mvex && kid(u, mvex, 'trex');
    const trex = trexBox
      ? { dur: rd32(u, trexBox.start + 20), size: rd32(u, trexBox.start + 24), flags: rd32(u, trexBox.start + 28) }
      : { dur: 0, size: 0, flags: 0 };
    return { ftyp, moov, movieTs: movieTs || mediaTs, mediaTs, trackId, avcC, width, height, trex };
  }

  /**
   * Every sample of the fragments in u[from, to) in decode order: { dts, dur, size, flags, cto, sync, pts, at }.
   * [mapOffset] turns a tfhd base_data_offset (original file offsets) into an offset in u.
   */
  function parseSamples(u, from, to, init, mapOffset) {
    const out = [];
    for (const moof of readBoxes(u, from, to)) {
      if (moof.type !== 'moof' || moof.partial) continue;
      for (const traf of kids(u, moof, 'traf')) {
        const tfhd = kid(u, traf, 'tfhd');
        if (!tfhd) continue;
        const tf = rd32(u, tfhd.start + 8) & 0xffffff;
        let p = tfhd.start + 16;
        let base = moof.start, defDur = init.trex.dur, defSize = init.trex.size, defFlags = init.trex.flags;
        if (tf & 0x1) { base = mapOffset ? mapOffset(rd64(u, p)) : rd64(u, p); p += 8; }
        if (tf & 0x2) p += 4;
        if (tf & 0x8) { defDur = rd32(u, p); p += 4; }
        if (tf & 0x10) { defSize = rd32(u, p); p += 4; }
        if (tf & 0x20) { defFlags = rd32(u, p); p += 4; }
        const tfdt = kid(u, traf, 'tfdt');
        let dts = tfdt ? (u[tfdt.start + 8] ? rd64(u, tfdt.start + 12) : rd32(u, tfdt.start + 12)) : (out.length ? out[out.length - 1].dts + out[out.length - 1].dur : 0);
        let pos = base;
        for (const trun of kids(u, traf, 'trun')) {
          const ver = u[trun.start + 8], fl = rd32(u, trun.start + 8) & 0xffffff;
          const count = rd32(u, trun.start + 12);
          let q = trun.start + 16;
          if (fl & 0x1) { pos = base + (rd32(u, q) | 0); q += 4; }
          let first = null;
          if (fl & 0x4) { first = rd32(u, q); q += 4; }
          for (let i = 0; i < count; i++) {
            const dur = fl & 0x100 ? rd32(u, (q += 4) - 4) : defDur;
            const size = fl & 0x200 ? rd32(u, (q += 4) - 4) : defSize;
            let flags = fl & 0x400 ? rd32(u, (q += 4) - 4) : defFlags;
            if (i === 0 && first != null && !(fl & 0x400)) flags = first;
            let cto = 0;
            if (fl & 0x800) { const raw = rd32(u, q); q += 4; cto = ver ? (raw | 0) : raw; }
            if (pos + size > u.length) return out;   // the fetched bytes end here
            out.push({ dts, dur, size, flags, cto, sync: !(flags & 0x10000), pts: dts + cto, at: pos });
            pos += size;
            dts += dur;
          }
        }
      }
    }
    return out;
  }

  /**
   * The samples from the key frame at or before [startT] up to the last one shown before [endT]
   * (media ticks), as the phone's remux reads them (SEEK_TO_PREVIOUS_SYNC, then until [end]).
   */
  function selectSamples(samples, startT, endT) {
    let key = -1;
    for (let i = 0; i < samples.length; i++) if (samples[i].sync && samples[i].pts <= startT) key = i;
    if (key < 0) key = samples.findIndex((s) => s.sync);
    if (key < 0) return [];
    let last = key;
    for (let i = key; i < samples.length; i++) if (samples[i].pts < endT) last = i;
    return samples.slice(key, last + 1);
  }

  // ── writing ──
  function cat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const o = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { o.set(p, at); at += p.length; }
    return o;
  }
  const u32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const u64 = (v) => cat([u32(Math.floor(v / 4294967296)), u32(v % 4294967296)]);
  const box = (type, ...parts) => {
    const body = cat(parts);
    const o = new Uint8Array(8 + body.length);
    o.set(u32(o.length), 0);
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    o.set(body, 8);
    return o;
  };
  const full = (type, ver, flags, ...parts) => box(type, u32(((ver & 255) << 24 | (flags & 0xffffff)) >>> 0), ...parts);
  function put(o, at, v, wide) {
    if (wide) { o.set(u64(v), at); } else o.set(u32(Math.min(v, 0xffffffff)), at);
  }

  /** The init's ftyp/moov copied with edits gone (the clip is shifted itself) and durations set to the clip's. */
  function copyBox(u, b, d) {
    if (b.type === 'edts') return null;
    if (['moov', 'trak', 'mdia', 'mvex'].includes(b.type)) {
      return box(b.type, ...readBoxes(u, b.start + b.hdr, b.end).map((k) => copyBox(u, k, d)).filter(Boolean));
    }
    const o = u.slice(b.start, b.end), h = b.hdr, v1 = !!o[h];
    if (b.type === 'mvhd') put(o, h + (v1 ? 24 : 16), d.movie, v1);
    else if (b.type === 'mdhd') put(o, h + (v1 ? 24 : 16), d.media, v1);
    else if (b.type === 'tkhd') put(o, h + (v1 ? 28 : 20), d.movie, v1);
    else if (b.type === 'mehd') put(o, h + 4, d.movie, v1);
    return o;
  }

  /**
   * One self-contained fragmented MP4 of [picked]: ftyp, moov (durations = the clip), one moof with
   * tfdt 0 and every sample spelled out (composition shifted so the key frame shows at 0), mdat.
   */
  function buildClip(u, init, picked) {
    if (!picked.length) throw new Error('no frames in the part');
    let total = 0;
    for (const s of picked) total += s.dur;
    const d = { media: total, movie: Math.round(total * init.movieTs / init.mediaTs) };
    const head = [];
    if (init.ftyp) head.push(u.slice(init.ftyp.start, init.ftyp.end));
    head.push(copyBox(u, init.moov, d));
    const k = picked[0];
    const rows = new Uint8Array(picked.length * 16);
    picked.forEach((s, i) => {
      rows.set(u32(s.dur), i * 16);
      rows.set(u32(s.size), i * 16 + 4);
      rows.set(u32(s.flags >>> 0), i * 16 + 8);
      rows.set(u32((s.cto - k.cto) >>> 0), i * 16 + 12);
    });
    const trun = full('trun', 1, 0x000f01, u32(picked.length), u32(0), rows);
    const traf = box('traf', full('tfhd', 0, 0x020000, u32(init.trackId)), full('tfdt', 1, 0, u64(0)), trun);
    const moof = box('moof', full('mfhd', 0, 0, u32(1)), traf);
    // trun's data_offset: from the moof's first byte to the first sample in the mdat
    const trunAt = moof.length - trun.length;
    moof.set(u32(moof.length + 8), trunAt + 16);
    const mdat = new Uint8Array(8 + picked.reduce((n, s) => n + s.size, 0));
    mdat.set(u32(mdat.length), 0);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
    let at = 8;
    for (const s of picked) { mdat.set(u.subarray(s.at, s.at + s.size), at); at += s.size; }
    return { bytes: cat([...head, moof, mdat]), fromSec: k.pts / init.mediaTs, lenSec: total / init.mediaTs };
  }

  const core = {
    CLIP_SEC, W, H, NEVER, OTHER_TAKE,
    norm, artists, officialChannel, titleCore, matches, searchResults, pickFormat,
    heatmapOf, partStart, noFrames, pick,
    grid, bars, area, diff, still, windows, choose, runnersUp, judge, cropX, change, cuts, flashing, end: loopEnd, cropRect,
    storyboardPlan, parseSidx, sidxRange, readBoxes, parseInit, parseSamples, selectSamples, buildClip,
  };
  G.__viviVideoCanvasCore = core;
  if (!PAGE) return;

  // ═════════════════════════════ the page: network ═════════════════════════════

  const cfg = (k) => { try { return window.ytcfg && window.ytcfg.get && window.ytcfg.get(k); } catch { return undefined; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const refused = (msg) => Object.assign(new Error(msg), { refused: true });
  let visitorFromReply = '';
  const visitor = () => cfg('VISITOR_DATA') || visitorFromReply;

  // the time limit covers the body too (read), so a stalled download can't hold the queue
  async function timed(url, init, ms, read) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await read(await fetch(url, { ...init, signal: ac.signal })); } finally { clearTimeout(t); }
  }

  /** Same-origin InnerTube call, signed out (as the phone asks). */
  async function innertube(endpoint, body) {
    const v = visitor();
    const res = await timed('/youtubei/v1/' + endpoint + '?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...(v ? { 'X-Goog-Visitor-Id': v } : {}) },
      body: JSON.stringify(body),
    }, 15000, (r) => {
      if (!r.ok) throw new Error(endpoint + ' HTTP ' + r.status);
      return r.json();
    });
    return res;
  }

  // ── relays: bytes the page may not fetch itself (CORS after redirects) ──
  const relayWait = new Map();
  let relaySeq = 0;
  function relay(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* bad URL */ }
    const viaXfade = host.endsWith('.googlevideo.com');   // crossfade.js's existing range relay
    return new Promise((resolve, reject) => {
      const rid = 'vc' + (++relaySeq);
      const timer = setTimeout(() => { relayWait.delete(rid); reject(new Error('extension fetch timed out')); }, viaXfade ? 30000 : 10000);
      relayWait.set(rid, { resolve, reject, timer });
      if (viaXfade) window.postMessage({ ch: 'vivi-xfade', dir: 'out', type: 'range', rid, url }, window.location.origin);
      else window.postMessage({ ch: CHANNEL, dir: 'out', type: 'fetch', rid, url }, window.location.origin);
    });
  }
  function relayAnswer(d) {
    const w = relayWait.get(d.rid);
    if (!w) return;
    relayWait.delete(d.rid);
    clearTimeout(w.timer);
    if (d.ok) w.resolve(new Response(d.bytes, { status: d.status || 200 }));
    else w.reject(new Error(d.why || 'extension fetch failed'));
  }

  const viaExtension = new Set();
  async function getUrl(url, key) {
    if (viaExtension.has(key)) return relay(url);
    try {
      return await timed(url, { credentials: 'omit' }, 20000,
        async (r) => new Response([204, 205, 304].includes(r.status) ? null : await r.arrayBuffer(), { status: r.status }));
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (viaExtension.size > 20) viaExtension.clear();
      viaExtension.add(key);
      log('the page may not fetch', new URL(url).hostname, '(CORS); asking the extension');
      return relay(url);
    }
  }

  async function fetchRange(url, a, b) {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(600 * 2 ** attempt);
      try {
        const res = await getUrl(url + '&range=' + a + '-' + b, url);
        if (res.status === 403 || res.status === 404 || res.status === 410) throw refused('HTTP ' + res.status + ' for bytes ' + a + '-' + b);
        if (!res.ok) { last = 'HTTP ' + res.status; continue; }
        const u = new Uint8Array(await res.arrayBuffer());
        if (u.byteLength === b - a + 1) return u;
        last = 'short read at ' + a;
      } catch (e) {
        if (e.refused) throw e;
        last = String((e && e.message) || e);
      }
    }
    throw new Error(last || 'network error');
  }

  async function fetchBytes(url, a, b) {
    const STEP = 2 * 1024 * 1024;   // VISIONOS URLs serve any range; the relay stays small
    const parts = [];
    for (let at = a; at <= b; at += STEP) parts.push(await fetchRange(url, at, Math.min(b, at + STEP - 1)));
    return parts.length === 1 ? parts[0] : cat(parts);
  }

  // ── YouTube's answers ──
  const VISION = {
    clientName: 'VISIONOS',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice14,1',
    osName: 'visionOS',
    osVersion: '1.3.21O771',
    clientScreen: 'WATCH',
    platform: 'MOBILE',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  };

  /** The video's player answer as YouTube's visionOS app (stream URLs need no signature solving), as Prism asks it. */
  async function visionPlayer(videoId) {
    let j = null;
    for (const version of ['1.02', '0.1']) {
      const ask = (v) => innertube('player', {
        context: { client: { ...VISION, clientVersion: version, hl: 'en', gl: 'US', utcOffsetMinutes: 0, ...(v ? { visitorData: v } : {}) } },
        videoId, contentCheckOk: true, racyCheckOk: true,
      });
      const v = visitor();
      j = await ask(v);
      const fresh = decodeURIComponent((j.responseContext && j.responseContext.visitorData) || '');
      if (fresh && !visitorFromReply) visitorFromReply = fresh;
      // without a visitor id the app clients are asked to "confirm you're not a bot"; the refusal hands one out
      if (j.playabilityStatus && j.playabilityStatus.status !== 'OK' && fresh && fresh !== v) j = await ask(fresh);
      if (j.playabilityStatus && j.playabilityStatus.status === 'OK') return j;
    }
    return j;
  }

  /**
   * [videoId, title] of the song's music video, or null. Signed out, YouTube no longer pairs songs with their
   * videos in `next`, so it is found as Prism does: a video search, and the result pick() takes (the song's title,
   * posted by the artist or their label within 150 s of the song, or the very session the song names).
   */
  async function findVideo(title, artist, durationSec) {
    const names = artists(artist);
    if (!title || !String(title).trim() || !names.length) return null;
    for (const q of [title + ' ' + names[0], title + ' ' + names[0] + ' official video']) {
      const v = visitor();
      const j = await innertube('search', {
        query: q, params: VIDEOS,
        context: { client: { clientName: 'WEB_REMIX', clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || '1.20251101.01.00', hl: 'en', gl: 'US', ...(v ? { visitorData: v } : {}) } },
      });
      const found = searchResults(j);
      const r = pick(title, names, durationSec, found);
      if (r) {
        log('found', r[0], `'${r[1]}' by ${r[2]} (${r[3]} s)`, 'for', `'${title}' / ${artist} (${durationSec || '?'} s)`, '(search', JSON.stringify(q) + ': the song\'s title, by the artist or their label or the session it names, no lyric/remix copy)');
        return [r[0], r[1]];
      }
      log('none for', JSON.stringify(q), 'among', found.slice(0, 5).map((x) => `'${x[1]}' by ${x[2]} ${x[3]} s`).join('; ') || 'no results');
    }
    return null;
  }

  /** "Most replayed" curves, 20 kept: an answer without a curve is remembered, a failed fetch is not. */
  const heats = new Map();
  async function heatmap(videoId) {
    if (heats.has(videoId)) { const h = heats.get(videoId); heats.delete(videoId); heats.set(videoId, h); return h; }
    try {
      const h = heatmapOf(await innertube('next', {
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: '2.20251101.01.00', hl: 'en', gl: 'US' } },
      }));
      heats.set(videoId, h);
      while (heats.size > 20) heats.delete(heats.keys().next().value);
      return h;
    } catch (e) {
      log('no most-replayed curve:', (e && e.message) || e);
      return null;
    }
  }

  // ── pixels ──
  function lumaOf(img, w, h) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    const px = x.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = idiv(px[j] * 3 + px[j + 1] * 6 + px[j + 2], 10);
    return out;
  }

  /** The storyboard's preview frames as grids (Prism's Storyboard, largest level, sheets up to 2 MB). */
  async function board(player, lengthMs) {
    const r = player.storyboards && player.storyboards.playerStoryboardSpecRenderer;
    const plan = storyboardPlan(r && r.spec, lengthMs);
    if (!plan) return null;
    const frames = [];
    let bytes = 0;
    for (let n = 0; n < plan.sheets && bytes < 2000000; n++) {
      const url = plan.url(n);
      const res = await getUrl(url, new URL(url).hostname);
      if (res.status >= 400) break;
      const blob = await res.blob();
      bytes += blob.size;
      let bmp;
      try { bmp = await createImageBitmap(blob); } catch { break; }
      const luma = lumaOf(bmp, bmp.width, bmp.height);
      for (let i = 0; i < plan.per && n * plan.per + i < plan.count; i++) {
        const x0 = (i % plan.cols) * plan.w, y0 = idiv(i, plan.cols) * plan.h;
        if (x0 + plan.w > bmp.width || y0 + plan.h > bmp.height) break;
        frames.push(grid(luma, bmp.width, x0, y0, plan.w, plan.h));
      }
      if (bmp.close) bmp.close();
    }
    return frames.length < 3 ? null : { frames, interval: plan.interval };
  }

  // ── cutting ──
  /** The fragments holding [start, end] (video seconds), parsed: init facts, bytes and the chosen samples. */
  async function fetchCut(f, start, end) {
    const url = f.url;
    const initEnd = Number(f.indexRange.end), initLen = Number(f.initRange.end) + 1;
    const head = await fetchBytes(url, 0, initEnd);
    const sidx = parseSidx(head, Number(f.indexRange.start));
    if (!sidx) throw new Error('no sidx');
    const [from, to] = sidxRange(sidx, start, end - start, initEnd + 1);
    const body = await fetchBytes(url, from, to);
    const u = cat([head.subarray(0, initLen), body]);
    const init = parseInit(u, initLen);
    const samples = parseSamples(u, initLen, u.length, init, (off) => off - from + initLen);
    const picked = selectSamples(samples, start * init.mediaTs, end * init.mediaTs);
    if (!picked.length) throw new Error('no frames in the part');
    return { u, init, picked, fetched: head.length + body.length };
  }

  /** Real frames of the picked samples as grids, times in ms from the key frame (Prism's ClipDecode). */
  async function decodeFrames(init, u, picked) {
    if (typeof VideoDecoder === 'undefined' || !init.avcC) return null;
    const c = init.avcC;
    const hex = (x) => x.toString(16).padStart(2, '0');
    const config = { codec: 'avc1.' + hex(c[1]) + hex(c[2]) + hex(c[3]), description: c, codedWidth: init.width, codedHeight: init.height, optimizeForLatency: true };
    try { if (!(await VideoDecoder.isConfigSupported(config)).supported) return null; } catch { return null; }
    const out = [];
    let failed = null;
    const gw = 128, gh = 72;
    const dec = new VideoDecoder({
      output: (fr) => {
        try { out.push({ t: fr.timestamp, g: grid(lumaOf(fr, gw, gh), gw, 0, 0, gw, gh) }); } catch (e) { failed = e; } finally { fr.close(); }
      },
      error: (e) => { failed = e; },
    });
    try {
      dec.configure(config);
      const k = picked[0], ts = init.mediaTs;
      for (const s of picked) {
        if (failed) break;
        dec.decode(new EncodedVideoChunk({
          type: s.sync ? 'key' : 'delta',
          timestamp: Math.round((s.pts - k.pts) * 1e6 / ts),
          duration: Math.round(s.dur * 1e6 / ts),
          data: u.subarray(s.at, s.at + s.size),
        }));
        if (dec.decodeQueueSize > 16) await sleep(4);
      }
      await Promise.race([dec.flush(), sleep(15000).then(() => { throw new Error('decode timed out'); })]);
    } finally {
      try { dec.close(); } catch { /* closed */ }
    }
    if (failed && out.length < 10) throw failed;
    out.sort((a, b) => a.t - b.t);
    return { frames: out.map((x) => x.g), times: out.map((x) => Math.round(x.t / 1000)) };
  }

  /**
   * The loop's end (video seconds; on a cut 5 to 9 s in, else 8 s), from a small copy of the
   * same seconds read frame by frame; -1 when it flashes, 0 when the frames could not be read.
   */
  async function refine(low, start) {
    try {
      const c = await fetchCut(low, start, start + CLIP_SEC + 2);
      const key = c.picked[0].pts / c.init.mediaTs;
      const fr = await decodeFrames(c.init, c.u, c.picked);
      if (!fr || fr.frames.length < 10) {
        log('real frames: only', fr ? fr.frames.length : 0, 'read' + (typeof VideoDecoder === 'undefined' ? ' (no WebCodecs)' : ''));
        return 0;
      }
      const ts = fr.times, n = ts.length;
      const step = idiv(ts[n - 1] - ts[0], Math.max(1, n - 1));
      const e = loopEnd(fr.frames, ts, ts[n - 1] + step);
      log('real frames:', n, 'read from', f1(key), 's, cuts at', JSON.stringify(cuts(fr.frames, ts)), 'ms, loop', e < 0 ? 'flashes' : e + ' ms');
      return e < 0 ? -1 : key + e / 1000;
    } catch (e) {
      log('real frames not read:', (e && e.message) || e);
      return 0;
    }
  }

  /** The song's loop (VideoCanvas.clip): { bytes, meta } or { none:true } (no usable video) or null (not this time). */
  async function clip(song) {
    const t0 = performance.now();
    const video = await findVideo(song.title, song.artist, song.durationSec);
    if (!video) return { none: true, why: 'no music video by the artist' };
    const player = await visionPlayer(video[0]);
    const status = (player && player.playabilityStatus && player.playabilityStatus.status) || '';
    if (status !== 'OK') {
      log(video[0], 'not playable (' + status + ')');
      return { none: false, why: 'video not playable (' + status + ')' };
    }
    const sd = player.streamingData;
    const f = pickFormat(sd, 720);
    if (!f) {
      log(video[0], 'has no H.264 DASH stream');
      return { none: true, why: 'no H.264 stream' };
    }
    const dur = Number(player.videoDetails && player.videoDetails.lengthSeconds) || 0;
    const heat = await heatmap(video[0]);
    const peak = heat == null ? null : partStart(heat, dur);
    let b = [0, 0, 0, 0], crop = 0.5, wins = null, judged = false;
    let length = Math.round(dur * 1000);
    // no preview frames: the middle of the video, the curve unused (Prism's FrameJudge.noFrames)
    let start = noFrames(length)[0] / 1000;
    let why = 'no preview frames: the middle';
    // Prism's first look: the storyboard (bars, a still upload, the best window near the peak, the crop)
    try {
      const sb = await board(player, length);
      if (sb && sb.frames.length >= MIN_FRAMES) {
        const j = judge(sb.frames, sb.interval, length, peak == null ? null : Math.round(peak * 1000), null);
        if (!j) {
          log(video[0], 'is a still picture (' + sb.frames.length + ' preview frames, no window that moves)');
          return { none: true, why: 'still picture' };
        }
        ({ bars: b, cropX: crop, windows: wins, length } = j);
        start = j.startMs / 1000;
        why = (heat == null ? 'no most-replayed curve' : peak == null ? 'no most-replayed peak' : 'most replayed at ' + f1(peak) + ' s')
          + ', storyboard window ' + f1(start) + ' s (score ' + f2(j.score) + ')';
        judged = true;
        log('storyboard', sb.frames.length, 'frames every', sb.interval, 'ms, bars', b.map(f2).join('/'), ',', wins.length, 'windows, crop', f2(crop));
      }
    } catch (e) {
      log('storyboard not read:', (e && e.message) || e);
    }
    start = Math.max(0, Math.min(start, dur - CLIP_SEC));
    log(video[0], `'${video[1]}'`, f.height + 'p itag ' + f.itag + ', part at', f1(start), 's of', Math.trunc(dur), 's (' + why + '), found in', Math.round(performance.now() - t0), 'ms');

    // Prism's second look, on real frames (a small copy of the same seconds): end on a cut, no flashing
    const low = pickFormat(sd, 240);
    let end = start + CLIP_SEC;
    if (low) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const e = await refine(low, start);
        if (e > 0) { end = e; break; }
        // another part of the same video, once (Prism's ClipRepository: the first runner-up)
        const next = wins == null ? null : runnersUp(wins, Math.round(start * 1000))[0];
        if (e === 0 || attempt === 1 || next == null) {
          if (e < 0) {
            log(video[0], 'flashes: not shown');
            return { none: true, why: 'the part flashes' };
          }
          break;
        }
        log('the part flashes, trying another');
        start = next / 1000;
        end = start + CLIP_SEC;   // the window moved: its end with it
      }
    }
    // the loop starts on the key frame at or before [start]
    const c = await fetchCut(f, start, end);
    const out = buildClip(c.u, c.init, c.picked);
    const width = Number(f.width) || c.init.width, height = Number(f.height) || c.init.height;
    const meta = {
      videoId: video[0], videoTitle: video[1], width, height,
      startSec: Math.round(out.fromSec * 1000) / 1000, lenSec: Math.round(out.lenSec * 1000) / 1000,
      ...(judged ? { crop: cropRect(crop, b, width, height), cropX: crop, bars: b } : {}),
    };
    log(Math.round(out.bytes.length / 1024), 'KB loop', f1(out.fromSec), '-', f1(out.fromSec + out.lenSec), 's (' + c.picked.length, 'frames,', Math.round(c.fetched / 1024), 'KB fetched) ready',
      Math.round(performance.now() - t0), 'ms after the lookup');
    return { bytes: out.bytes, meta };
  }

  // ═════════════════════════════ the page: cache ═════════════════════════════
  // Phone: CanvasCache "mv:<song>" (a clip at any age, a miss for 24 h, errors not saved),
  // clip files mv_<song>.mp4 kept under 80 MB, least recently shown first out.
  const DAY = 24 * 3600 * 1000;
  const CACHE_BYTES = 80 * 1024 * 1024;
  const MEM_MAX = 4;
  const keyOf = (id) => 'mv_' + id;
  const mem = new Map();          // song id -> { blobUrl, meta }
  let lastShown = '';

  function memPut(id, blob, meta) {
    const old = mem.get(id);
    if (old) { mem.delete(id); mem.set(id, old); return old; }
    const e = { blobUrl: URL.createObjectURL(blob), meta };
    mem.set(id, e);
    for (const k of [...mem.keys()]) {
      if (mem.size <= MEM_MAX) break;
      if (k === id || k === lastShown) continue;
      URL.revokeObjectURL(mem.get(k).blobUrl);
      mem.delete(k);
    }
    return e;
  }

  let dbp = null;
  function db() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const r = indexedDB.open('vivi-video-canvas', 1);
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('mv')) r.result.createObjectStore('mv'); };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const t = d.transaction('mv', mode);
        const st = t.objectStore('mv');
        let result;
        const r = fn(st, (v) => { result = v; });
        if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = t.onabort = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }
  const idbGet = (k) => tx('readonly', (st) => st.get(k));
  const idbPut = (k, v) => tx('readwrite', (st) => st.put(v, k));
  const idbDel = (k) => tx('readwrite', (st) => st.delete(k));

  /** null: look it up; { miss:true }: no video, saved < 24 h ago; else { bytes, meta } (any age). */
  async function lookup(id) {
    const v = await idbGet(keyOf(id));
    if (!v || typeof v !== 'object' || !Number.isFinite(v.at)) return null;
    if (v.miss) {
      if (Date.now() - v.at < DAY) return v;
      idbDel(keyOf(id));
      return null;
    }
    if (!v.bytes || !v.meta) return null;
    return v;
  }

  async function save(id, got) {
    const now = Date.now();
    if (got.meta) await idbPut(keyOf(id), { at: now, shown: now, size: got.bytes.byteLength, bytes: got.bytes.buffer.slice(got.bytes.byteOffset, got.bytes.byteOffset + got.bytes.byteLength), meta: got.meta });
    else await idbPut(keyOf(id), { at: now, miss: true, why: got.why || '' });
    if (got.meta) trim(keyOf(id));
  }

  /** Keep the clips under CACHE_BYTES: the least recently shown go first. */
  async function trim(keep) {
    const rows = [];
    await tx('readonly', (st) => {
      const r = st.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const v = c.value;
        if (v && !v.miss) rows.push({ k: c.key, shown: v.shown || v.at || 0, size: v.size || 0 });
        c.continue();
      };
    });
    rows.sort((a, b) => b.shown - a.shown);
    let total = 0, removed = 0;
    for (const r of rows) {
      total += r.size;
      if (total > CACHE_BYTES && r.k !== keep) { await idbDel(r.k); removed++; }
    }
    if (removed) log('cache over', CACHE_BYTES / 1048576, 'MB, removed', removed, 'old loops');
  }

  // ═════════════════════════════ the page: one at a time ═════════════════════════════
  const queue = { hi: [], lo: [] };
  const inflight = new Map();   // song id -> job
  let running = false;

  function run(song, hi) {
    let job = inflight.get(song.id);
    if (job) {
      if (hi && !job.started && queue.lo.includes(job)) { queue.lo.splice(queue.lo.indexOf(job), 1); queue.hi.push(job); }
      return job.done;
    }
    if (hi) {
      // skipping through songs: only the newest song's lookup is still wanted
      for (const old of queue.hi.splice(0)) {
        inflight.delete(old.song.id);
        old.resolve({ none: false, why: 'not this time (skipped)' });
      }
    }
    job = { song, started: false };
    job.done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    inflight.set(song.id, job);
    (hi ? queue.hi : queue.lo).push(job);
    pump();
    return job.done;
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.hi.length || queue.lo.length) {
      const job = (queue.hi.length ? queue.hi : queue.lo).shift();
      job.started = true;
      try {
        const got = await clip(job.song);
        if (got.meta || got.none) await save(job.song.id, got);
        job.resolve(got);
      } catch (e) {
        log('failed for', `'${job.song.title}':`, (e && e.message) || e);
        job.reject(e);
      } finally {
        inflight.delete(job.song.id);
      }
    }
    running = false;
  }

  const say = (m) => window.postMessage({ ch: CHANNEL, dir: 'out', ...m }, window.location.origin);
  const answer = (reqId, e, from) => ({ reqId, ok: true, blobUrl: e.blobUrl, ...e.meta, from });

  // the song's length when the request has none: the player's, while it plays that song (0: unknown, not checked)
  function playingLength(id) {
    try {
      const p = document.getElementById('movie_player');
      const v = p && p.getVideoData && p.getVideoData();
      return v && v.video_id === id ? Math.round(Number(p.getDuration()) || 0) : 0;
    } catch { return 0; }
  }

  let findSeq = 0;
  async function find(d) {
    const my = ++findSeq;
    const id = String(d.id || '');
    if (!id || !d.title) return { reqId: d.reqId, ok: false, why: 'no song id or title' };
    const song = { id, title: String(d.title), artist: String(d.artist || ''), album: d.album || '', durationSec: Number(d.durationSec) || playingLength(id) };
    const m = mem.get(id);
    if (m) {
      mem.delete(id); mem.set(id, m);
      lastShown = id;
      log('cache hit (memory):', id, '->', m.meta.videoId);
      return answer(d.reqId, m, 'cache');
    }
    const saved = await lookup(id);
    if (saved && saved.miss) {
      log('cache hit: no video for', `'${song.title}'`, '(saved', Math.round((Date.now() - saved.at) / 60000), 'min ago)');
      return { reqId: d.reqId, ok: false, none: true, why: 'no music video (saved miss: ' + (saved.why || 'none') + ')' };
    }
    if (saved) {
      idbPut(keyOf(id), { ...saved, shown: Date.now() });
      lastShown = id;
      const e = memPut(id, new Blob([saved.bytes], { type: 'video/mp4' }), saved.meta);
      log('cache hit (stored):', id, '->', saved.meta.videoId, Math.round(saved.size / 1024), 'KB');
      return answer(d.reqId, e, 'cache');
    }
    const got = await run(song, true);
    if (!got.meta) return { reqId: d.reqId, ok: false, none: !!got.none, why: got.why || 'not this time' };
    if (my === findSeq) lastShown = id;   // a stale answer must not shield its clip from eviction
    return answer(d.reqId, memPut(id, new Blob([got.bytes], { type: 'video/mp4' }), got.meta), 'net');
  }

  // Prism's CanvasAhead: the next two songs' loops, one at a time, 15 s after they show up next
  // (skipping through songs asks for none). The phone waits for an unmetered network; the
  // browser only tells about Data Saver.
  const aheadAsked = new Set();
  function prefetch(list) {
    for (const s of (Array.isArray(list) ? list : []).slice(0, 2)) {
      const id = s && String(s.id || '');
      if (!id || !s.title || aheadAsked.has(id)) continue;
      if (aheadAsked.size > 200) aheadAsked.clear();
      aheadAsked.add(id);
      setTimeout(async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) { aheadAsked.delete(id); return; }
          if (mem.has(id) || (await lookup(id))) return;
          const got = await run({ id, title: String(s.title), artist: String(s.artist || ''), album: s.album || '', durationSec: Number(s.durationSec) || 0 }, false);
          log('ahead:', `'${s.title}'`, got.meta ? 'loop cached' : got.none ? 'has no video' : 'not this time');
        } catch (e) {
          aheadAsked.delete(id);
          log('ahead:', `'${s.title}'`, 'failed:', (e && e.message) || e);
        }
      }, 15000);
    }
  }

  async function clearAll() {
    for (const e of mem.values()) URL.revokeObjectURL(e.blobUrl);
    mem.clear();
    heats.clear();
    aheadAsked.clear();
    await tx('readwrite', (st) => st.clear());
    log('caches cleared');
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.dir !== 'in') return;
    if (d.ch === 'vivi-xfade') {
      if (d.type === 'range' && typeof d.rid === 'string' && d.rid.startsWith('vc')) relayAnswer(d);
      return;
    }
    if (d.ch !== CHANNEL) return;
    try {
      if (d.op === 'fetch') relayAnswer(d);
      // (songSec: the song's length, read while it plays that song; content.js passes it on to the Spotify match)
      else if (d.op === 'find') { const songSec = Number(d.durationSec) || playingLength(String(d.id || '')); say({ ...(await find(d)), songSec }); }
      else if (d.op === 'prefetch') { prefetch(d.ids); say({ reqId: d.reqId, ok: true }); }
      else if (d.op === 'clear') { await clearAll(); say({ reqId: d.reqId, ok: true }); }
    } catch (err) {
      say({ reqId: d.reqId, ok: false, why: String((err && err.message) || err) });
    }
  });
})();

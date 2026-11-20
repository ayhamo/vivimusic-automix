// Vivimusic Web+: the lyrics rules (spec/lyrics/lyrics.md) as pure functions, for the lyrics panel
// (src/plus/lyrics-ui-plus.js) and scripts/lyrics_cases_tests.mjs. Times in ms.
'use strict';

(() => {
  /** §2.1: lines change this far ahead of the voice (Metrolist's DEFAULT_SUGGESTED_LINE_OFFSET_MS, 500 + 160). */
  const LEAD_MS = 660;
  /** §2.2: overlaps shorter than this are timing noise, not two voices (LINE_OVERLAP_MIN_MS). */
  const OVERLAP_MIN_MS = 250;

  /**
   * The lines active at [pos] (§2.1-2.2, Metrolist's LyricsSyncEngine.updateByLookAhead read without its memory):
   * a line is active from position + lead reaching its start; it ends at its end, or when the next line is active by
   * the same rule. A line starting while another is still active (a duet) uses the shorter overlap lead,
   * max(250, lead - 150) word-synced or max(250, lead - 250) line-synced, and both are active. An overlap under 250 is
   * trimmed. lines: [{ start, end }] in order; opts: { wordSynced, leadMs (0: "lyrics by real timing") }.
   * Answers the active lines' indices, in order.
   */
  function activeLines(lines, pos, opts = {}) {
    const lead = opts.leadMs ?? LEAD_MS;
    const items = (Array.isArray(lines) ? lines : []).map((l, i, all) => {
      const next = all[i + 1];
      let end = Number(l.end);
      if (next && end > next.start && end - next.start < OVERLAP_MIN_MS) end = Number(next.start);
      return { start: Number(l.start), end };
    });
    const predictive = pos + lead;
    const overlapTime = pos + (lead > 0 ? Math.max(OVERLAP_MIN_MS, lead - (opts.wordSynced ? 150 : 250)) : 0);
    const out = [];
    let maxEnd = -Infinity;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const startCheck = out.length && it.start < maxEnd ? overlapTime : predictive;
      if (it.start > startCheck && it.start > predictive) break;
      const next = items[i + 1];
      const endCheck = next && next.start < it.end ? overlapTime
        : next && predictive >= next.start ? predictive
          : pos;
      if (startCheck >= it.start && endCheck < it.end) {
        out.push(i);
        if (it.end > maxEnd) maxEnd = it.end;
      }
    }
    return out;
  }

  /**
   * §3.1-3.2: the offsets add up; the lyrics run at the player's position plus the offset (a positive one shows them
   * earlier), and a seek by lyrics goes to the lyric's time minus the offset, never below 0.
   */
  function offsetOf(songMs, globalMs, playerMs, lyricMs) {
    const offset = (Number(songMs) || 0) + (Number(globalMs) || 0);
    const lyrics = playerMs + offset;
    return { offset, lyrics, seekTo: Math.max(0, (lyricMs ?? lyrics) - offset) };
  }

  /**
   * The sides of a duet (§5.2, Metrolist's assignLineAlignments, the view's alignment centre): ids per line (null: no
   * singer), types { id: 'person' | 'group' | 'other' } (else from the id: v1000 / g… a group, v2000 / o… other),
   * respect: the sides setting. Answers 'left' | 'right' | 'center' per line.
   */
  function sides(ids, types = {}, respect = true) {
    const out = [];
    let left = true, last = null, right = 0, total = 0;
    for (const id of ids) {
      let a = 'center';
      if (id != null) {
        const t = types[id];
        const type = t === 'group' ? 'group' : t === 'other' ? 'other' : t ? 'person'
          : id === 'v1000' || id.startsWith('g') ? 'group' : id === 'v2000' || id.startsWith('o') ? 'other' : 'person';
        if (type !== 'group' && respect) {
          if (last == null) left = type !== 'other';
          else if (id !== last) left = !left;
          last = id;
          a = left ? 'left' : 'right';
        }
      }
      if (a !== 'center') { total++; if (a === 'right') right++; }
      out.push(a);
    }
    if (respect && total > 0 && right / total >= 0.85) return out.map((a) => (a === 'left' ? 'right' : a === 'right' ? 'left' : a));
    return out;
  }

  /** §6.1: a gap is this long or more without a line (LYRICS_GAP_MIN_MS); §6.2: shown this far ahead (HIGHLIGHT_LOOK_AHEAD_MS). */
  const GAP_MIN_MS = 7000, GAP_AHEAD_MS = 190;

  /**
   * The instrumental gaps (§6.1, Metrolist's buildLyricsListItems): an intro from 0 to the first line - 800 when that
   * line starts at 7000 or later; between lines, from the latest end so far + 310 to the next start - 800, when they
   * are 7000 or more apart. lines: [{ start, end }] in order. Answers [[start, end], ...] with each gap's line index
   * after it ([start, end, before]).
   */
  function gaps(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const out = [];
    if (list.length && list[0].start >= GAP_MIN_MS) out.push([0, list[0].start - 800, 0]);
    let lastEnd = null;
    list.forEach((l, i) => {
      if (lastEnd != null && l.start - lastEnd >= GAP_MIN_MS) out.push([lastEnd + 310, l.start - 800, i]);
      lastEnd = Math.max(lastEnd ?? 0, l.end);
    });
    return out;
  }

  const api = { LEAD_MS, activeLines, offsetOf, sides, gaps, GAP_AHEAD_MS };
  globalThis.__viviLyricsRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

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

  const api = { LEAD_MS, activeLines, offsetOf };
  globalThis.__viviLyricsRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

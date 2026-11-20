// The lyrics cases of spec/lyrics/lyrics.md (spec/lyrics/lyrics-cases.json), checked against a port of
// Metrolist's own functions kept here (the rule's reference), so the expectations every port reads are
// the original's. The PC's lyrics-ui.js has no pure functions for these yet (lyrics.md §12): when it
// gets them, they are checked here too.
//
//   node scripts/lyrics_cases_tests.mjs        (exit 1 on a failure)
import { readFileSync } from 'node:fs';

const cases = JSON.parse(readFileSync(new URL('../spec/lyrics/lyrics-cases.json', import.meta.url), 'utf8'));

// ── Metrolist, ported as written ──
// LyricsUtils.kt:111-121 findCurrentLineIndex
function currentLine(starts, position) {
  for (let i = 0; i < starts.length; i++) if (starts[i] >= position + 100) return i - 1;
  return starts.length - 1;
}
// LyricsUtils.kt:94-107
const combinedOffset = (song, global) => song + global;
const lyricsPosition = (player, offset) => player + offset;
const seekPosition = (lyric, offset) => Math.max(0, lyric - offset);
// LyricsUtils.kt:160-235 assignLineAlignments (the view's alignment: centre)
function sides(lines, agents = {}, respect = true) {
  const out = [];
  let left = true, last = null, right = 0, total = 0;
  for (const id of lines) {
    let a;
    if (id != null) {
      const t = agents[id];
      const type = t === 'group' ? 'group' : t === 'other' ? 'other' : t ? 'person'
        : id === 'v1000' || id.startsWith('g') ? 'group' : id === 'v2000' || id.startsWith('o') ? 'other' : 'person';
      if (type === 'group') a = 'center';
      else if (!respect) a = 'center';
      else {
        if (last == null) left = type !== 'other';
        else if (id !== last) left = !left;
        last = id;
        a = left ? 'left' : 'right';
      }
    } else a = 'center';
    if (a !== 'center') { total++; if (a === 'right') right++; }
    out.push(a);
  }
  if (respect && total > 0 && right / total >= 0.85) return out.map((a) => (a === 'left' ? 'right' : a === 'right' ? 'left' : a));
  return out;
}
// LyricsListIndexing.kt:28-53 buildLyricsListItems (the gap indicators only)
function gaps(lines) {
  const out = [];
  if ((lines[0]?.start ?? 0) >= 7000) out.push([0, lines[0].start - 800]);
  let lastEnd = null;
  for (const l of lines) {
    if (lastEnd != null && l.start - lastEnd >= 7000) out.push([lastEnd + 310, l.start - 800]);
    lastEnd = Math.max(lastEnd ?? 0, l.end);
  }
  return out;
}

let failed = 0, ok = 0;
const check = (group, name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) ok++; else failed++;
  console.log(`${same ? 'ok  ' : 'DIFF'} ${group}: ${name}${same ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};
for (const c of cases.currentLine) check('currentLine', c.name, currentLine(c.input.starts, c.input.position), c.expect);
for (const c of cases.offset) {
  const { song, global, player, lyricTime } = c.input;
  const offset = combinedOffset(song, global), lyrics = lyricsPosition(player, offset);
  check('offset', c.name, { offset, lyrics, seekTo: seekPosition(lyricTime ?? lyrics, offset) }, c.expect);
}
for (const c of cases.sides) check('sides', c.name, sides(c.input.lines, c.input.agents, c.input.respect), c.expect);
for (const c of cases.gaps) check('gaps', c.name, gaps(c.input.lines), c.expect);
console.log('skip  the PC: lyrics-ui.js has no pure currentLine, offset, sides or gaps functions yet (lyrics.md §12)');
console.log(`\nlyrics cases: ${ok} ok, ${failed} DIFF`);
process.exit(failed ? 1 : 0);

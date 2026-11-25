// node scripts/spotify_mix_ids.mjs <spotify-mix-export.json> <ids.json> [--write]
// Each playlist track's YouTube Music song: a songs-only search (title + first artist), scored on
// title, artists and length. Resumes from ids.json; check the scores under 1 by hand and fix them in
// ids.json ({ uri: { id, title, by, sec, score, why } }). --write then puts each id into the export as
// "youtubeVideoId" after the track's "uri" (playlist.tracks and every mix's from and to) and sets
// "version" to 3, as text, so the rest of the file stays byte for byte (spec/automix/spotify-mixes.md).
// The apps import that file directly.
import fs from 'node:fs';
const [src, out] = process.argv.slice(2).filter((x) => x !== '--write');
const WRITE = process.argv.includes('--write');
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const done = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const SONGS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const text = (t) => (t?.runs ? t.runs.map((r) => r.text || '').join('') : t?.simpleText || '');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const core = (t) => norm(String(t).toLowerCase().replace(/\(.*?\)|\[.*?]/g, ' ').replace(/\s-\s.*$/, ' ').replace(/\s(ft\.?|feat\.?|featuring|with)\s.*$/, ' '));
const secs = (s) => String(s || '').split(':').reduce((a, x) => a * 60 + (Number(x) || 0), 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q) {
  const r = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: q, params: SONGS, context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251101.01.00', hl: 'en', gl: 'US' } } }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const rows = [];
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    const x = n.musicResponsiveListItemRenderer;
    if (x) {
      const col = (i) => x.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
      const by = text(col(1)).split(' • ');
      rows.push({ id: x.playlistItemData?.videoId || '', title: text(col(0)), by: by[0] || '', sec: secs(by[by.length - 1]) });
      return;
    }
    Object.values(n).forEach(walk);
  })(await r.json());
  return rows.filter((x) => x.id);
}

function score(t, row) {
  const want = core(t.title), got = core(row.title);
  const title = want === got ? 1 : (got.includes(want) || want.includes(got)) && Math.min(want.length, got.length) >= 3 ? 0.7 : 0;
  const names = t.artists.map(norm);
  const by = row.by.split(/\s*(?:,|&|\band\b|\bx\b)\s*/i).map(norm).filter(Boolean);
  const artist = names[0] && by.includes(names[0]) ? 1 : by.some((b) => names.includes(b)) ? 0.7 : 0;
  const len = t.durationMs / 1000;
  const dl = Math.abs(row.sec - len);
  const dur = dl <= 3 ? 1 : dl <= 10 ? 0.7 : dl <= 30 ? 0.3 : 0;
  return { s: title * 0.45 + artist * 0.35 + dur * 0.2, title, artist, dl: Math.round(dl) };
}

const tracks = d.playlist.tracks;
for (const t of tracks) {
  if (done[t.uri]) continue;
  const q = t.title.replace(/\(.*?\)|\[.*?]/g, ' ').replace(/\s-\s.*$/, ' ').trim() + ' ' + t.artists[0];
  let rows = [];
  for (let k = 0; k < 3; k++) { try { rows = await search(q); break; } catch (e) { await sleep(2000 * (k + 1)); } }
  const best = rows.slice(0, 8).map((r) => ({ r, sc: score(t, r) })).sort((a, b) => b.sc.s - a.sc.s)[0];
  done[t.uri] = best ? { id: best.r.id, title: best.r.title, by: best.r.by, sec: best.r.sec, score: Math.round(best.sc.s * 100) / 100, why: `title ${best.sc.title} artist ${best.sc.artist} length off ${best.sc.dl} s`, q } : { id: null, q };
  fs.writeFileSync(out, JSON.stringify(done, null, 1));
  console.log((best ? best.sc.s.toFixed(2) : '----'), t.title, '/', t.artists[0], '->', best ? `${best.r.title} / ${best.r.by} (${best.r.id})` : 'nothing');
  await sleep(400);
}

if (WRITE) {
  // as text: an id line already there is replaced, the rest of the file stays byte for byte
  const raw = fs.readFileSync(src, 'utf8');
  let added = 0;
  const lines = raw.split('\n').filter((l) => !/^\s*"youtubeVideoId": "[^"]*",\r?$/.test(l)).flatMap((l) => {
    const m = /^(\s*)"uri": "(spotify:track:[A-Za-z0-9]+)",(\r?)$/.exec(l);
    if (!m || !done[m[2]]?.id) return [l];
    added++;
    return [l, `${m[1]}"youtubeVideoId": "${done[m[2]].id}",${m[3]}`];
  });
  const t = lines.join('\n').replace(/\n "version": \d+,(\r?)\n/, (s, r) => `\n "version": 3,${r}\n`);
  JSON.parse(t);
  fs.writeFileSync(src, t);
  console.log(`${added} ids written into ${src} (version 3)`);
}

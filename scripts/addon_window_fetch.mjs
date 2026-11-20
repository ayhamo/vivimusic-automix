// The addon side of spec/addons/window-cases.json (offset-map.md, Window check), from the phone chat's
// offset test of 2026-11-20. It calls the user's addons: run it only with the user's word.
// Usage: node scripts/addon_window_fetch.mjs <a file of addon links, one a line> .cache/addons
//
// Fetches each song's lossless copy from the user's addons (protocol.md §1-4), for the
// 12 s offset test. Links hold tokens: only hosts are printed. One /stream per song,
// at least 13 s apart per addon (under 5 a minute).
import fs from 'node:fs';
import path from 'node:path';

const LINKS = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  .map((l) => l.replace(/\/+$/, '').replace(/\/[^/]*\.json$/, ''));
const OUT = process.argv[3];
const SONGS = [
  ['weaRBsTrSkM', 'Vaina Loca', 'Ozuna', 176.1],
  ['vNQjKyEMJxk', 'SI NO ES CONTIGO', 'Cris Mj', 156],
  ['exHJb5t-6e8', 'Stereo Love X Where Have You Been', 'smashup', 229.0],
  ['sGgMHiRiklo', 'Midnight Sun', 'Zara Larsson', 189.9],
  ['JBbSlADtG-g', 'UNETHICAL', 'Faouzia', 219.9],
  ['A7Zlgi2FMUE', 'Escapism. (Sped Up)', 'RAYE', 239.9],
  ['ndHnHIgQxys', 'Базовый минимум', 'Sabi', 135.2],
  ['2mUTNSMcezg', 'MONTAGEM FAMA (Super Slowed)', 'hansika.', 111.3],
  ['oG-4Uvhm4lI', 'Poker Face', 'Lady Gaga', 237.2],
  ['6Edmp3yHv1s', 'LET ME LOVE YOU x GATA ONLY', 'Moonshine', 172.7],
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
const host = (u) => new URL(u).host;
const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const lastStream = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const qualityOf = async (base) => {
  try {
    const m = await json(base + '/manifest.json');
    const q = (m.settings || []).find((s) => s.key === 'quality');
    const params = new URLSearchParams();
    for (const s of m.settings || []) if (s.key !== 'quality' && s.key !== 'atmos' && s.default != null) params.set(s.key, String(s.default));
    if ((m.settings || []).some((s) => s.key === 'atmos')) params.set('atmos', 'false');
    params.set('quality', q && q.options && q.options.length ? String(q.options[0].value) : 'LOSSLESS');
    return { name: m.name || m.id, params };
  } catch (e) { return { name: host(base), params: new URLSearchParams({ quality: 'LOSSLESS' }) }; }
};

fs.mkdirSync(OUT, { recursive: true });
const addons = [];
for (const base of LINKS) addons.push({ base, ...(await qualityOf(base)) });
for (const [id, title, artist, dur] of SONGS) {
  const file = path.join(OUT, id + '.audio');
  if (fs.existsSync(file)) { console.log(id, 'already here'); continue; }
  let done = false;
  for (const a of addons) {
    if (done) break;
    try {
      const q = new URLSearchParams(a.params); q.set('title', title); q.set('artist', artist); q.set('q', `${title} ${artist}`);
      const rows = (await json(`${a.base}/search?${q}`)).tracks || [];
      const want = fold(title).split(' ').filter((w) => w.length > 2);
      const row = rows.slice(0, 15).find((r) => r.id && r.title && Math.abs((Number(r.duration) || 0) - dur) <= 3
        && want.every((w) => fold(r.title).includes(w)) && !/atmos|dolby/i.test(`${r.format} ${r.audioQuality} ${r.audioMode}`));
      if (!row) { console.log(id, a.name, 'no row within 3 s'); continue; }
      const wait = (lastStream.get(a.base) || 0) + 13000 - Date.now();
      if (wait > 0) await sleep(wait);
      lastStream.set(a.base, Date.now());
      const s = await json(`${a.base}/stream/${encodeURIComponent(row.id)}?${a.params}`);
      if (!s.url || !/^https:/.test(s.url)) { console.log(id, a.name, 'no https url'); continue; }
      const h = { 'User-Agent': UA, 'Accept-Encoding': 'identity' };
      for (const [k, v] of Object.entries(s.headers || {})) if (!/^(user-agent|range|accept-encoding)$/i.test(k)) h[k] = String(v);
      const r = await fetch(s.url, { headers: h, signal: AbortSignal.timeout(180000) });
      if (!r.ok) { console.log(id, a.name, 'audio HTTP', r.status); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      console.log(id, a.name, `row ${row.title} ${row.duration}s, ${s.codec || s.format || ''} ${s.sampleRate || ''}/${s.bitDepth || ''}, ${(buf.length / 1048576).toFixed(1)} MB`);
      done = true;
    } catch (e) { console.log(id, a.name, 'failed:', String(e.message || e).replace(/https?:\/\/\S+/g, '<url>')); }
  }
  if (!done) console.log(id, 'NO COPY');
}

/* Vivimusic Web+ — addons/pick.js (background script; node for tests)
 *
 * Which of an addon's search rows to open for a YouTube Music song: our rules
 * (spec/addons/protocol.md §3 and §7) on top of BitChord's TrackMatcher
 * (addons/track-matcher.js).
 *
 *   rowOf(raw)                    an addon's row, its fields read leniently
 *   rowsToOpen(raws, target, opt) { open: rows (at most 3, best first), refused: [{ id, why }] }
 *        target: { title, artist, durationSec, album, isExplicit, isVideo, isrc }
 *        opt:    { slackSec (default 5, 0-10), forDownload (then ±2 s) }
 *   probeVerdict(head, row, songSec, slackSec)   the Range bytes=0-0 probe's answer:
 *        { ok: true } or { ok: false, why }; head: { status, contentRange, contentLength }
 *
 * globalThis.__viviAddonPick
 */
(() => {
  'use strict';
  const M = globalThis.__viviTrackMatcher || (typeof require === 'function' ? require('./track-matcher.js') : null);

  const MAX_ROWS = 15;            // rows kept for matching
  const MAX_OPEN = 3;             // rows opened (stream asked, probed, fitted)
  const PREFER_SEC = 3;           // rows this close in length go first
  const DOWNLOAD_SLACK_SEC = 2;
  const PREVIEW_MAX_SEC = 35, PREVIEW_SONG_SEC = 45;   // (Mornye) a clip this short of a longer song is a preview

  const text = (v) => (v == null ? '' : String(v));
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  const flag = (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = text(v).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(s) ? true : ['0', 'false', 'no', 'off'].includes(s) ? false : null;
  };

  // §3: the tier a row's format text names
  function tierOf(s) {
    const t = text(s).toLowerCase();
    if (!t) return null;
    if (/flac|alac|wav|hi-?res|(16|24)[\s-]?bit|lossless/.test(t)) return 'LOSSLESS';
    if (/\blow\b|128|96|64/.test(t)) return 'LOW';
    if (/320|mp3|aac|opus|high/.test(t)) return 'HIGH';
    return null;
  }
  const ATMOS = /atmos|dolby|eac3[_-]?joc|ec-?3/i;
  function isAtmos(raw) {
    if ([raw?.atmos, raw?.isAtmos, raw?.isAtmosOnly].some((v) => flag(v) === true)) return true;   // (isAtmos, isAtmosOnly: NullBeat's)
    const modes = [raw?.audioMode, ...(Array.isArray(raw?.audioModes) ? raw.audioModes : []), raw?.format, raw?.audioQuality];
    return modes.some((m) => ATMOS.test(text(m)));
  }
  // ISRC: 12 letters and digits, case and separators ignored
  function isrcOf(v) {
    const s = text(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : null;
  }

  function rowOf(raw) {
    const q = `${text(raw?.format)} ${text(raw?.audioQuality)}`;
    return {
      id: text(raw?.id), title: text(raw?.title), artist: text(raw?.artist), album: raw?.album == null ? null : text(raw.album),
      durationSec: num(raw?.duration), explicit: flag(raw?.explicit), isrc: isrcOf(raw?.isrc),
      tier: tierOf(q), kbps: num(text(q).match(/(\d{2,4})\s*kbps/i)?.[1]), atmos: isAtmos(raw),
      streamURL: raw?.streamURL ? text(raw.streamURL) : null, raw,
    };
  }

  function rowsToOpen(raws, target, { slackSec = 5, forDownload = false } = {}) {
    const refused = [];
    const slack = forDownload ? DOWNLOAD_SLACK_SEC : Math.min(10, Math.max(0, slackSec));
    const song = num(target?.durationSec) > 0 ? num(target.durationSec) : null;   // 0: unknown
    const rows = (Array.isArray(raws) ? raws : []).slice(0, MAX_ROWS).map(rowOf).filter((r) => r.id && r.title);
    // Atmos (another mix than YouTube's) and previews (Mornye: a clip this short of a longer song) first
    const preview = (r) => r.durationSec != null && song != null && r.durationSec <= PREVIEW_MAX_SEC && song > PREVIEW_SONG_SEC;
    const usable = rows.filter((r) => {
      const why = r.atmos ? 'atmos' : preview(r) ? 'preview' : null;
      if (why) refused.push({ id: r.id, why });
      return !why;
    });
    // ISRC first (ours, from Mornye): an equal ISRC is the same recording, whatever the titles say
    const want = isrcOf(target?.isrc);
    const byIsrc = want ? usable.filter((r) => r.isrc === want) : [];
    const matched = M.ranked(usable.filter((r) => !byIsrc.includes(r)), song == null ? { ...target, durationSec: null } : target);
    for (const r of usable) if (!byIsrc.includes(r) && !matched.includes(r)) refused.push({ id: r.id, why: 'not this song' });
    const ok = [];
    for (const r of [...byIsrc, ...matched]) {
      if (r.durationSec != null && song != null && Math.abs(r.durationSec - song) > slack) { refused.push({ id: r.id, why: 'length' }); continue; }
      ok.push(r);
    }
    // rows within 3 s first, otherwise in the order above (stable)
    const near = (r) => r.durationSec != null && song != null && Math.abs(r.durationSec - song) <= PREFER_SEC;
    const ordered = [...ok.filter(near), ...ok.filter((r) => !near(r))];
    return { open: ordered.slice(0, MAX_OPEN), refused };
  }

  // §7: a file too small to hold the whole song at the row's lowest believable bitrate is a cut
  function probeVerdict(head, row, songSec, slackSec = 5) {
    // the size: Content-Range's total, or Content-Length of a full (200) answer (a 206's is the 1 byte)
    const total = num(text(head?.contentRange).match(/\/(\d+)\s*$/)?.[1]) ?? (head?.status === 200 ? num(head?.contentLength) : null);
    if (!(total > 0) || !(songSec > 0)) return { ok: true };   // unmeasurable: not refused
    const floor = row?.tier === 'LOSSLESS' ? 200 : Math.min(row?.kbps ?? 64, 64);
    const maxSec = (total * 8) / (floor * 1000);
    return maxSec < songSec - slackSec ? { ok: false, why: `file holds at most ${Math.round(maxSec)} s` } : { ok: true, maxSec };
  }

  const api = { rowOf, rowsToOpen, probeVerdict, tierOf, isAtmos, isrcOf };
  globalThis.__viviAddonPick = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

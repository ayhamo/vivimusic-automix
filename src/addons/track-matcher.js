/* Vivimusic Web+ — addons/track-matcher.js (background script; node for tests)
 *
 * BitChord's TrackMatcher (web/app/src/data/match/trackMatcher.ts at a2d886e6,
 * GPL-3.0, by the BitChord authors), types stripped and otherwise unchanged,
 * so spec/addons/matcher-cases.json holds for it as for BitChord, except the vivi+
 * mashup rule (isMashup, protocol.md §7, the (ours, mashups) cases). Our other rules
 * (ISRC first, Atmos rows, the checks before a row plays) are in
 * addons/pick.js, on top of this file.
 *
 * globalThis.__viviTrackMatcher = { score, ranked, best, queries, ... }
 */
(() => {
  'use strict';
  /**
   * Whether one catalogue's track is the same recording as another's: a port of
   * TrackMatcher.kt (shared/…/data/sources), line for line where it can be.
   *
   * Titles are taken apart into the words that carry identity (must agree), the
   * markers of a different take — remix, live, acoustic (must agree in both
   * directions) — and packaging (film names, "Official Video": a tie-break,
   * never a veto). Then the credit and the runtime are checked against that.
   * The reasoning behind every rule is in the Kotlin file's comments; the
   * comments here only mark where JavaScript needed something different.
   */

  /** One row from a catalogue: a YouTube Music search result, a Spotify track, an addon's answer. */

  /** The recording being looked for, as much of it as is known. */

  // ── Weights ─────────────────────────────────────────────────────────────

  const BASE = 100;
  const ARTIST_EXACT = 25;
  const ARTIST_SHARED = 10;
  const CREDITS_DISAGREE = -30;
  const CREDIT_OVERRIDE_SEC = 2;
  const DURATION_TIGHT = 40;
  const DURATION_LOOSE = 15;
  const ALBUM_EXACT = 35;
  const EXPLICIT_EXACT = 20;
  const CONTEXT_SHARED = 20;
  const DURATION_TIGHT_SEC = 3;
  const DURATION_LIMIT_SEC = 30;
  const VIDEO_DURATION_LIMIT_SEC = 90;
  const BRACKET_PASSES = 3;
  const DASH_PASSES = 3;

  const BRACKETED = /[([]([^()[\]]*)[)\]]/g;
  const BRACKETED_TEST = /[([]([^()[\]]*)[)\]]/;
  const DASH = /\s+[-–—|]+\s+/;
  const FEATURING = /\b(feat|ft|featuring|with)\b.*/g;
  const WORD_SPLIT = /[\s.·~〜]+/u;
  const NON_ALNUM = /[^\p{L}\p{N}]/gu;
  const LATIN = /[a-z0-9]/;
  const LATIN_QUERY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  const CJK_OPEN = /[「『【〈《〔［｛]/g;
  const CJK_CLOSE = /[」』】〉》〕］｝]/g;
  /** Java's `\p{Punct}` is ASCII punctuation only; spelled out here. */
  const CJK_CORE_STRIP = /[\s!-/:-@[-`{-~・～〜ー-]+/gu;
  /** Character.UnicodeBlock: HIRAGANA, KATAKANA, CJK_UNIFIED_IDEOGRAPHS, HANGUL_SYLLABLES. */
  const CJK = /[぀-ゟ゠-ヿ一-鿿가-힯]/;
  const ARTIST_SEPARATORS =
    /\s*(?:[,&/;·|、，×]|\band\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/u;

  const VERSION_WORDS = new Set([
    'remix', 'remixes', 'rmx', 'refix', 'flip', 'bootleg', 'mashup', 'medley',
    'live', 'concert', 'unplugged', 'acoustic', 'instrumental', 'karaoke',
    'vocals', 'vocal', 'acapella', 'acappella', 'backing', 'stems', 'stem',
    'cover', 'demo', 'reprise', 'remake', 'rework', 'extended', 'edit',
    'version', 'mix', 'dub', 'vip', 'session', 'sessions',
    'sped', 'slowed', 'reverb', 'nightcore', 'lofi', 'orchestral', 'symphonic',
    'part', 'pt', 'chapter',
    'カバー', 'カラオケ', 'リミックス', 'ライブ', 'アコースティック',
    'インスト', 'バージョン', '歌ってみた', '踊ってみた', '弾いてみた',
    '翻唱', '现场', '混音',
    '커버', '라이브', '리믹스',
  ]);
  const TRAILING_TAKES = new Set(['instrumental', 'karaoke', 'acapella', 'acappella', 'remix', 'rmx', 'nightcore']);
  const NOVOCAL_TAKES = new Set(['instrumental', 'karaoke', 'acapella', 'acappella', 'backing', 'stems', 'stem']);
  const NEUTRAL_SEGMENTS = new Set([
    'albumversion', 'originalversion', 'originalmix', 'singleversion',
    'radioversion', 'radioedit', 'stereoversion', 'monoversion',
    'studioversion', 'fullversion', 'standardversion', 'explicitversion',
    'deluxeversion', 'originaltrack',
  ]);
  const NOISE_WORDS = new Set([
    'official', 'video', 'audio', 'lyrics', 'lyric', 'lyrical', 'visualizer',
    'song', 'songs', 'full', 'music', 'the', 'and', 'from', 'feat', 'ft',
    'featuring', 'with', 'new', 'latest', 'free', 'download', 'remaster',
    'remastered', 'explicit', 'clean', 'bonus', 'track', 'deluxe', 'original',
    'album', 'single', 'hd', 'hq', '4k', 'mp3',
  ]);
  const ALBUM_NOISE_WORDS = new Set([
    'album', 'deluxe', 'edition', 'expanded', 'remaster', 'remastered',
    'version', 'explicit', 'clean', 'bonus', 'anniversary',
  ]);
  const TRAILING_NOISE = new Set([
    'song', 'songs', 'video', 'audio', 'lyrics', 'lyric', 'lyrical',
    'official', 'full', 'hd', 'hq', '4k', 'mp3', 'ost', 'soundtrack',
  ]);
  const JOINING_WORDS = new Set(['and']);

  // ── Small helpers ──────────────────────────────────────────────────────────

  const strip = (word        ) => word.replace(NON_ALNUM, '');
  const wordsOf = (text        ) => text.split(WORD_SPLIT).map(strip).filter((w) => w.length > 0);
  const sameSet =    (a        , b        ) => a.size === b.size && [...a].every((x) => b.has(x));
  const union =    (...sets               ) => new Set(sets.flatMap((s) => [...s]));
  const intersect =    (a        , b        ) => new Set([...a].filter((x) => b.has(x)));

  function normalize(text        )         {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replaceAll('&', ' and ')
      .replace(CJK_OPEN, '(')
      .replace(CJK_CLOSE, ')');
  }

  /**
   * TrackMatcher.foldLatin: Latin letters without their accents, for comparing
   * only ("Şımarık" / "Simarik"). Other scripts keep their combining marks.
   */
  function foldLatin(text        )         {
    return [...text]
      .map((c) => {
        if (c === 'ı') return 'i';
        if (c.charCodeAt(0) < 0x80 || !/\p{Script=Latin}/u.test(c)) return c;
        return c.normalize('NFD').replace(/\p{Mn}/gu, '');
      })
      .join('');
  }

  // ── Asking ─────────────────────────────────────────────────────────────────

  /** What to put to a search box, best query first (TrackMatcher.queries). */
  function queries(target             )           {
    const title = searchableTitle(target.title, target.artist ?? '');
    if (!title.trim()) return [];
    const artist = primaryArtist(target.artist ?? '');
    const out = artist ? [`${title} ${artist}`, title] : [title];
    const latin = romajiOf(title).trim();
    const otherScript =
      latin && latin !== title && [...latin].every((c) => LATIN_QUERY_CHARS.includes(c))
        ? latin
        : scriptMates(target.title).find((s) => s.trim() && s !== title);
    if (otherScript) out.push(otherScript);
    return [...new Set(out)];
  }

  function searchableTitle(title        , artist = '')         {
    const parts = parseTitle(title, artist);
    return [...parts.words, ...parts.versions].join(' ');
  }

  function primaryArtist(artist        )         {
    return normalize(artist).split(ARTIST_SEPARATORS)[0]?.trim() ?? '';
  }

  function sharesArtist(wanted        , got        )          {
    const want = artistNames(wanted);
    const have = artistNames(got);
    return want.length > 0 && have.length > 0 && want.some((w) => have.some((h) => sameArtist(w, h)));
  }

  // ── Judging ────────────────────────────────────────────────────────────────

  function best                          (candidates     , target             )           {
    return ranked(candidates, target)[0] ?? null;
  }

  function ranked                          (candidates     , target             )      {
    const scored = candidates.flatMap((candidate) => {
      const value = score(candidate, target);
      return value === null ? [] : [{ candidate, value }];
    });
    const credited = scored.filter(({ candidate }) => artistScore(target.artist ?? '', candidate.artist) !== null);
    // Stable: equal scores keep the search's order, as Kotlin's sortedByDescending does.
    return (credited.length ? credited : scored).sort((a, b) => b.value - a.value).map((s) => s.candidate);
  }

  /** How confident this is the same recording, or null when it is not one. */
  function score(candidate                , target             )                {
    const wanted = parseTitle(target.title, target.artist ?? '');
    const got = parseTitle(candidate.title, candidate.artist);
    if (!wanted.core.trim() || !got.core.trim()) return null;
    // vivi+ (protocol.md §7, mashups; ours, not in BitChord a2d886e6): a mashup's title holds whole song titles,
    // so one of them inside it is another song; the whole title must match, and the credit must
    const mashup = isMashup(target.title, target.artist ?? '');
    const isTitleMatch =
      wanted.core === got.core ||
      romajiOf(wanted.core) === romajiOf(got.core) ||
      isTranslationMatch(wanted, got) ||
      (!mashup && !([...wanted.core].length <= 3 || [...got.core].length <= 3) &&
        (wanted.core.includes(got.core) || got.core.includes(wanted.core)));
    if (!isTitleMatch) return null;

    const albumMarks = albumVersionMarkers(candidate.album);
    const effectiveVersions = union(got.versions, intersect(albumMarks, NOVOCAL_TAKES), intersect(albumMarks, wanted.versions));
    if (!sameSet(wanted.versions, effectiveVersions)) return null;

    const creditedArtist = artistScore(target.artist ?? '', candidate.artist);
    const duration = durationScore(target.durationSec ?? null, positive(candidate.durationSec), creditedArtist !== null);
    if (duration === null) return null;
    const artist =
      creditedArtist ??
      (!target.isVideo && !mashup && withinSeconds(candidate, target, CREDIT_OVERRIDE_SEC) ? CREDITS_DISAGREE : null);
    if (artist === null) return null;
    const explicit = explicitScore(target.isExplicit ?? null, candidate.explicit ?? null);
    if (explicit === null) return null;
    return BASE + artist + duration + albumScore(target.album ?? null, candidate.album) + explicit + contextScore(wanted, got);
  }

  function matches(candidate                , title        , artist        , durationSec                = null)          {
    return score(candidate, { title, artist, durationSec }) !== null;
  }

  /** TrackMatcher.hasConflictingAlbums. */
  function hasConflictingAlbums(candidates                  , target             )          {
    if (target.album?.trim()) return false;
    const comparable =
      target.durationSec != null ? candidates.filter((c) => withinSeconds(c, target, DURATION_LIMIT_SEC)) : candidates;
    if (target.durationSec != null && comparable.length === 0) return false;
    return new Set(comparable.map((c) => albumKey(c.album)).filter((k)              => !!k)).size > 1;
  }

  /** TrackMatcher.uniquelyMostCreditedCloseMatch. */
  function uniquelyMostCreditedCloseMatch                          (candidates     , target             )           {
    const close = candidates.filter((c) => withinSeconds(c, target, DURATION_LIMIT_SEC));
    if (close.length < 2) return null;
    const counted = close.map((c) => ({ c, n: artistNames(c.artist).length }));
    const top = Math.max(...counted.map((x) => x.n));
    if (top < 2) return null;
    const winners = counted.filter((x) => x.n === top);
    return winners.length === 1 ? winners[0] .c : null;
  }

  function withinSeconds(candidate                , target             , seconds        )          {
    const wanted = target.durationSec;
    const got = positive(candidate.durationSec);
    if (wanted == null || got === null) return false;
    return Math.abs(wanted - got) <= seconds;
  }

  function isSevereMismatch(expectedSec               , actualSec               )          {
    if (expectedSec == null || actualSec == null) return false;
    return Math.abs(actualSec - expectedSec) > DURATION_LIMIT_SEC;
  }

  /** secondsOf's `takeIf { it > 0 }`: an unstated runtime is null, not zero. */
  function positive(seconds                           )                {
    return seconds != null && seconds > 0 ? Math.round(seconds) : null;
  }

  // ── Title ──────────────────────────────────────────────────────────────────

  function parseTitle(raw        , artist = '')             {
    const versions = new Set        ();
    const context = new Set        ();
    let text = normalize(raw);

    for (let pass = 0; pass < BRACKET_PASSES; pass++) {
      if (!BRACKETED_TEST.test(text)) continue;
      text = text.replace(BRACKETED, (_, inner        ) => {
        classify(inner, versions, context);
        return ' ';
      });
    }
    const open = text.search(/[([]/);
    if (open >= 0) {
      classify(text.slice(open), versions, context);
      text = text.slice(0, open);
    }

    for (let pass = 0; pass < DASH_PASSES; pass++) {
      const dash = DASH.exec(text);
      if (!dash) continue;
      const head = text.slice(0, dash.index);
      const tail = text.slice(dash.index + dash[0].length);
      if (isArtistName(head, artist)) {
        classify(head, versions, context);
        text = tail;
      } else if (!hasFilingLatin(head) && hasFilingLatin(tail) && !isArtistName(tail, artist)) {
        classify(head, versions, context);
        text = tail;
      } else {
        classify(tail, versions, context);
        text = head;
      }
    }

    text = text.replace(FEATURING, ' ');
    const containsCJK = CJK.test(text);

    let words = text.split(WORD_SPLIT).map(strip).filter((w) => w.length > 0 && !JOINING_WORDS.has(w));
    while (words.length > 1) {
      const last = words.at(-1) ;
      if (TRAILING_NOISE.has(last)) words = words.slice(0, -1);
      else if (TRAILING_TAKES.has(last)) {
        versions.add(last);
        words = words.slice(0, -1);
      } else break;
    }

    const core = containsCJK ? text.replace(CJK_CORE_STRIP, '') : foldLatin(words.join(''));
    return { words, core, versions, context };
  }

  function classify(segment        , versions             , context             )       {
    const words = wordsOf(segment);
    if (!words.length) return;
    if (NEUTRAL_SEGMENTS.has(words.join(''))) return;
    const marks = words.filter((w) => VERSION_WORDS.has(w));
    if (marks.length) {
      marks.forEach((m) => versions.add(m));
      return;
    }
    // A single CJK syllable is a whole title: the length gate exists
    // for Latin glue words and must not drop it.
    words.filter((w) => ([...w].length > 2 || CJK.test(w)) && !NOISE_WORDS.has(w)).forEach((w) => context.add(w));
  }

  function containsCJKChar(text        )          {
    return CJK.test(text);
  }

  /**
   * Whether a bracketed aside is the same title in another script rather
   * than packaging around it. True when one core is CJK-only, the other is
   * Latin, and the other's aside is that core in full (one word of a longer
   * aside is not enough). Same-script asides never qualify.
   */
  function isTranslationMatch(wanted            , got            )          {
    const wantedCJK = containsCJKChar(wanted.core) && !hasFilingLatin(wanted.core);
    const gotCJK = containsCJKChar(got.core) && !hasFilingLatin(got.core);
    const wantedLatin = hasFilingLatin(wanted.core);
    const gotLatin = hasFilingLatin(got.core);
    if ((wantedCJK && gotLatin) || (gotCJK && wantedLatin)) {
      // Folded as the core is: "東京 (Tōkyō)" files the upload "Tōkyō".
      if (foldLatin([...wanted.context].join('')) === got.core) return true;
      if (foldLatin([...got.context].join('')) === wanted.core) return true;
    }
    return false;
  }

  /**
   * vivi+ (protocol.md §7, mashups): a mashup or medley, by a "mashup" / "medley" word anywhere, or by two or more
   * titles joined with " x ", " vs ", " / " or " × " in one part of the title (brackets and dash parts apart).
   * A side that is the credited artist makes it a credit ("Sigala x Ella Eyre - Came Here For Love"), not a mashup.
   */
  const MASHUP_WORD = /(?:^|[^\p{L}\p{N}])(?:mash[\s-]?ups?|medley)(?:$|[^\p{L}\p{N}])/u;
  const MASHUP_JOIN = /\s+(?:x|×|vs\.?|\/)\s+/u;
  function isMashup(raw        , artist         = '')          {
    let text = normalize(raw ?? '');
    if (MASHUP_WORD.test(text)) return true;
    for (let pass = 0; pass < BRACKET_PASSES; pass++) text = text.replace(BRACKETED, ' ');   // nested asides too
    return text
      .split(DASH)
      .filter((part) => !isArtistName(part, artist))
      .some((part) => {
        const sides = part.split(MASHUP_JOIN).map((s) => s.trim()).filter((s) => wordsOf(s).length);
        return sides.length >= 2 && sides.every((s) => !isArtistName(s, artist));
      });
  }

  function isArtistName(text        , artist         = '')          {
    if (!String(artist ?? '').trim()) return false;
    const words = wordsOf(text);
    if (!words.length) return false;
    const credited = new Set(wordsOf(normalize(artist)));
    return words.every((w) => credited.has(w));
  }

  function hasFilingLatin(text        )          {
    return wordsOf(text).some(
      (w) => LATIN.test(w) && !VERSION_WORDS.has(w) && !NOISE_WORDS.has(w) && !TRAILING_NOISE.has(w) && !JOINING_WORDS.has(w),
    );
  }

  function scriptMates(raw        )           {
    const text = normalize(raw);
    const dash = DASH.exec(text);
    if (!dash) return [];
    const head = searchableTitle(text.slice(0, dash.index));
    const tail = searchableTitle(text.slice(dash.index + dash[0].length));
    if (!head.trim() || !tail.trim() || head === tail) return [];
    return romajiOf(head) === tail || romajiOf(tail) === head ? [head, tail] : [];
  }

  // ── Romaji ─────────────────────────────────────────────────────────────────

  const KANA_ROMAJI                      = (() => {
    const map = new Map                ();
    const row = (consonant        , kana        , vowels = 'aiueo') =>
      [...kana].forEach((k, i) => map.set(k, consonant + vowels[i]));
    row('', 'あいうえお');
    row('k', 'かきくけこ');
    row('g', 'がぎぐげご');
    row('s', 'さしすせそ');
    map.set('し', 'shi');
    row('z', 'ざじずぜぞ');
    map.set('じ', 'ji');
    row('t', 'たちつてと');
    map.set('ち', 'chi');
    map.set('つ', 'tsu');
    row('d', 'だぢづでど');
    map.set('ぢ', 'ji');
    map.set('づ', 'zu');
    row('n', 'なにぬねの');
    row('h', 'はひふへほ');
    map.set('ふ', 'fu');
    row('b', 'ばびぶべぼ');
    row('p', 'ぱぴぷぺぽ');
    row('m', 'まみむめも');
    map.set('や', 'ya');
    map.set('ゆ', 'yu');
    map.set('よ', 'yo');
    row('r', 'らりるれろ');
    map.set('わ', 'wa');
    map.set('を', 'wo');
    map.set('ん', 'n');
    map.set('ゔ', 'vu');
    for (const [k, v] of Object.entries({ ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa', ゕ: 'ka', ゖ: 'ke' })) {
      map.set(k, v);
    }
    return map;
  })();
  const SMALL_Y                         = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' };
  const SMALL_V                         = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
  const CONS_OVERRIDES                     = [
    ['shi', 'sh'], ['chi', 'ch'], ['tsu', 'ts'], ['fu', 'f'], ['ji', 'j'], ['zu', 'z'],
  ];

  /** Katakana to hiragana, as the Kotlin `c.code - 0x60` over 'ァ'..'ヶ'. */
  const toHiragana = (c                    )                     => {
    if (c === undefined) return undefined;
    const code = c.charCodeAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : c;
  };

  function romajiOf(text        )         {
    let out = '';
    let geminate = false;
    let lastVowel                = null;
    const emit = (roma        ) => {
      let r = roma;
      if (geminate) {
        geminate = false;
        r = r.startsWith('ch') ? `t${r}` : r.startsWith('sh') ? `s${r}` : r.startsWith('ts') ? `t${r}` : `${r[0]}${r}`;
      }
      out += r;
      lastVowel = [...r].reverse().find((c) => 'aeiou'.includes(c)) ?? null;
    };
    let i = 0;
    while (i < text.length) {
      const c = toHiragana(text[i]) ;
      if (c === 'っ') {
        geminate = true;
        i++;
      } else if (c === 'ー') {
        if (lastVowel) out += lastVowel;
        i++;
      } else if (c === 'ん') {
        const peek = KANA_ROMAJI.get(toHiragana(text[i + 1]) ?? '')?.[0];
        emit(peek === 'b' || peek === 'm' || peek === 'p' ? 'm' : 'n');
        i++;
      } else {
        const base = KANA_ROMAJI.get(c);
        if (base === undefined) {
          out += text[i];
          lastVowel = null;
          geminate = false;
          i++;
        } else {
          const next = toHiragana(text[i + 1]);
          const small = next !== undefined ? (SMALL_Y[next] ?? SMALL_V[next]) : undefined;
          if (small !== undefined) {
            const cons = CONS_OVERRIDES.find(([key]) => base.startsWith(key))?.[1] ?? base.slice(0, -1);
            const glide = cons === 'sh' || cons === 'ch' || cons === 'j' ? small.replace(/^y/, '') : small;
            emit(cons + glide);
            i += 2;
          } else {
            emit(base);
            i++;
          }
        }
      }
    }
    return out;
  }

  // ── Artist ─────────────────────────────────────────────────────────────────

  function artistScore(wanted        , got        )                {
    const want = artistNames(wanted);
    const have = artistNames(got);
    if (!want.length || !have.length) return 0;
    if (!sharesArtist(wanted, got)) return null;
    const key = (names            ) => names.map((n) => n.join(' ')).sort().join('|');
    return key(want) === key(have) ? ARTIST_EXACT : ARTIST_SHARED;
  }

  /** The credited artists, each as its own list of words; a Set in Kotlin, de-duplicated here. */
  function artistNames(value        )             {
    const seen = new Map                  ();
    for (const name of foldLatin(normalize(value)).split(ARTIST_SEPARATORS)) {
      const words = name.split(WORD_SPLIT).map(strip).filter((w) => [...w].length > 1);
      if (words.length) seen.set(words.join(' '), words);
    }
    return [...seen.values()];
  }

  const sameArtist = (a          , b          ) => runOf(a, b) || runOf(b, a);

  function runOf(outer          , inner          )          {
    if (!inner.length || inner.length > outer.length) return false;
    for (let at = 0; at <= outer.length - inner.length; at++) {
      if (inner.every((w, i) => outer[at + i] === w)) return true;
    }
    return false;
  }

  // ── Duration, album, explicit, context ─────────────────────────────────────

  function durationScore(wanted               , got               , allowVideoDrift         )                {
    if (wanted === null || got === null) return 0;
    const drift = Math.abs(wanted - got);
    if (drift > DURATION_LIMIT_SEC && allowVideoDrift && drift <= VIDEO_DURATION_LIMIT_SEC) return 0;
    if (drift > DURATION_LIMIT_SEC) return null;
    return drift <= DURATION_TIGHT_SEC ? DURATION_TIGHT : DURATION_LOOSE;
  }

  function albumScore(wanted               , got               )         {
    const want = albumKey(wanted);
    const have = albumKey(got);
    return want && have && want === have ? ALBUM_EXACT : 0;
  }

  function explicitScore(wanted                , got                )                {
    if (wanted === null || got === null) return 0;
    return wanted !== got ? null : EXPLICIT_EXACT;
  }

  function albumVersionMarkers(album                           )              {
    return album?.trim() ? parseTitle(album).versions : new Set();
  }

  function albumKey(value                           )                {
    let text = normalize(value ?? '').trim();
    if (!text) return null;
    for (let pass = 0; pass < BRACKET_PASSES; pass++) text = text.replace(BRACKETED, ' ');
    const key = text.split(WORD_SPLIT).map(strip).filter((w) => w && !ALBUM_NOISE_WORDS.has(w)).join('');
    return key || null;
  }

  function contextScore(wanted            , got            )         {
    return [...wanted.context].some((w) => got.context.has(w)) ? CONTEXT_SHARED : 0;
  }

  const api = { DURATION_LIMIT_SEC, isMashup, normalize, foldLatin, queries, searchableTitle, primaryArtist, sharesArtist, best, ranked, score, matches, hasConflictingAlbums, uniquelyMostCreditedCloseMatch, withinSeconds, isSevereMismatch, parseTitle, isTranslationMatch, hasFilingLatin, scriptMates, romajiOf, artistNames, albumVersionMarkers };
  globalThis.__viviTrackMatcher = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();

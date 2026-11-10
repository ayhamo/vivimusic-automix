// ViviMusic Xten — player tab recognition (language localization).
//
// YouTube Music's full-player tabs (Up next / Lyrics / Comments / Related) are
// plain translated text. Matching them against English words only works when
// the whole site is in English. This module is the single place that decides
// "which tab is this?" so lyrics-ui.js and content.js agree.
//
// Setting: `localizationEnabled` (chrome.storage.local, default TRUE).
//   ON  → English words, then a multilingual word list, then a positional
//         fallback for the standard 3-tab strip (Up next, Lyrics, Related).
//   OFF → legacy behaviour: English words only.
(() => {
  'use strict';
  if (window.__viviTabs) return;

  const TAB_SELECTOR = 'ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape';

  // English is always checked, whatever the setting says.
  // Other languages: matched as lowercase substrings of the tab's label.
  // Not exhaustive — languages missing here are still handled by the
  // positional fallback below.
  const WORDS = {
    next: [
      'up next', 'queue',
      '次のコンテンツ', '次の曲', '次に再生', '다음 트랙', '다음 곡', '接下来', '接下來', '播放序列',
      'a continuación', 'siguiente', 'à suivre', 'als nächstes', 'nächster titel', 'a seguir', 'próxima',
      'su prossimo', 'in coda', 'далее', 'следующ', 'आगे', 'अगला', 'berikutnya', 'selanjutnya',
      'sıradaki', 'التالي', 'tiếp theo', 'ถัดไป', 'hierna', 'volgende', 'dalej', 'następne',
    ],
    lyrics: [
      'lyric',
      '歌詞', '歌词', '가사', 'letra', 'paroles', 'songtext', 'testi', 'testo', 'текст',
      'बोल', 'lirik', 'şarkı sözleri', 'كلمات', 'lời bài hát', 'เนื้อเพลง', 'songtekst', 'tekst', 'গানের কথা',
    ],
    comments: [
      'comment',
      'コメント', '댓글', '评论', '評論', 'comentario', 'commentaire', 'kommentar', 'comentário',
      'commenti', 'комментар', 'टिप्पणि', 'komentar', 'yorum', 'التعليقات', 'bình luận',
      'ความคิดเห็น', 'opmerking',
    ],
    related: [
      'related',
      '関連', '관련', '相关', '相關', 'relacionad', 'similaires', 'associé', 'ähnlich', 'verwandt',
      'correlati', 'simili', 'похожие', 'संबंधित', 'terkait', 'i̇lgili', 'ilgili', 'ذات صلة',
      'liên quan', 'ที่เกี่ยวข้อง', 'gerelateerd', 'powiązane',
    ],
  };

  // Standard YTM strip order, used only when words can't identify the tabs.
  const POSITIONAL_3 = ['next', 'lyrics', 'related'];

  let enabled = true;

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function labelOf(tab) {
    const content = tab.querySelector?.('.tab-content')?.textContent;
    return norm(`${tab.getAttribute?.('aria-label') || ''} ${content || tab.textContent || ''}`);
  }

  function matchWords(label, list) {
    return list.some((w) => label.includes(w));
  }

  function allTabs() {
    return Array.from(document.querySelectorAll(TAB_SELECTOR));
  }

  // kind ∈ 'next' | 'lyrics' | 'comments' | 'related' | null
  function kindOf(tab, tabsHint) {
    if (!tab) return null;
    const label = labelOf(tab);
    if (!label) return null;

    // English first (always on — this is the pre-localization behaviour).
    if (label.includes('up next') || label.includes('queue')) return 'next';
    if (label.includes('lyric')) return 'lyrics';
    if (label.includes('comment')) return 'comments';
    if (label.includes('related')) return 'related';
    if (!enabled) return null;

    // Multilingual word list. Order matters little; labels are short.
    for (const kind of ['lyrics', 'next', 'related', 'comments']) {
      if (matchWords(label, WORDS[kind])) return kind;
    }

    // Positional fallback: only for the plain 3-tab strip, and only if none
    // of the words above identified anything on this strip.
    const tabs = tabsHint || Array.from(tab.parentElement?.querySelectorAll?.('tp-yt-paper-tab, yt-tab-shape') || []);
    if (tabs.length === 3) {
      const anyKnown = tabs.some((t) => t !== tab && matchesAnyWord(labelOf(t)));
      if (!anyKnown) return POSITIONAL_3[tabs.indexOf(tab)] || null;
    }
    return null;
  }

  function matchesAnyWord(label) {
    return Object.values(WORDS).some((list) => matchWords(label, list));
  }

  function find(kind) {
    const tabs = allTabs();
    for (const tab of tabs) {
      if (kindOf(tab, tabs) === kind) return tab;
    }
    return null;
  }

  function setEnabled(value) {
    const next = value !== false;
    if (next === enabled) return;
    enabled = next;
    document.dispatchEvent(new CustomEvent('vivi-localization-changed', { detail: { enabled } }));
  }

  try {
    chrome.storage.local.get({ localizationEnabled: true }, ({ localizationEnabled }) => {
      setEnabled(localizationEnabled);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.localizationEnabled) setEnabled(changes.localizationEnabled.newValue);
    });
  } catch { /* storage unavailable — keep default (on) */ }

  window.__viviTabs = { TAB_SELECTOR, kindOf, find, isEnabled: () => enabled };
})();

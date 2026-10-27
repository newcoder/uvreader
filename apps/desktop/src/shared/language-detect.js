// Small local source-language detector. It intentionally only distinguishes the
// languages the ebook translator currently supports; it does not try to label
// every language in the world. Classical vs modern Chinese is a separate manual
// choice because early vernacular (e.g. 红楼梦) is easily confused with 文言.
const GERMAN_WORDS = new Set([
  "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "einer", "zu", "mit", "auf",
  "für", "von", "den", "dem", "des", "sich", "auch", "werden", "wird", "hat", "haben",
  "aus", "bei", "nach", "über", "als", "noch", "nur", "kann", "muss", "zum", "zur",
  "durch", "gegen", "ohne", "unter", "zwischen", "ich", "wir", "sie", "es", "man",
]);
const ENGLISH_WORDS = new Set([
  "the", "and", "is", "are", "was", "were", "of", "to", "in", "that", "it", "for",
  "with", "as", "on", "be", "this", "have", "from", "or", "by", "not", "you", "we",
  "they", "at", "an", "but", "his", "her", "their", "which", "will", "would", "can",
]);

function lettersOf(sample) {
  const letters = [...String(sample || "")].filter((char) => /\p{L}/u.test(char));
  return {
    total: letters.length,
    han: letters.filter((char) => /\p{Script=Han}/u.test(char)).length,
    kana: letters.filter((char) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)).length,
    hangul: letters.filter((char) => /\p{Script=Hangul}/u.test(char)).length,
    latin: letters.filter((char) => /\p{Script=Latin}/u.test(char)).length,
  };
}

function latinLanguage(sample) {
  const words = String(sample || "").toLowerCase().match(/\p{Script=Latin}[\p{Script=Latin}\p{M}'-]*/gu) || [];
  let german = 0;
  let english = 0;
  for (const word of words) {
    if (GERMAN_WORDS.has(word)) german += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  // Umlauts and ß are strong signals even in a short paragraph.
  if (/[äöüß]/i.test(sample)) german += 3;
  if (german >= 2 && german > english * 1.05) return { language: "de", confidence: Math.min(0.99, 0.55 + german / 80) };
  return { language: "en", confidence: Math.min(0.99, 0.55 + english / 80) };
}

export function detectSourceLanguage(text, { maxChars = 50000 } = {}) {
  const sample = String(text || "").slice(0, Math.max(1000, Number(maxChars) || 50000));
  const counts = lettersOf(sample);
  if (counts.total < 8) return { language: "unknown", confidence: 0 };
  const kana = counts.kana / counts.total;
  const hangul = counts.hangul / counts.total;
  const han = counts.han / counts.total;
  const latin = counts.latin / counts.total;
  if (kana >= 0.12) return { language: "ja", confidence: Math.min(0.99, 0.6 + kana) };
  if (hangul >= 0.12) return { language: "ko", confidence: Math.min(0.99, 0.6 + hangul) };
  if (han >= 0.25 && han >= latin) return { language: "zh", confidence: Math.min(0.99, 0.6 + han) };
  if (latin >= 0.35) return latinLanguage(sample);
  return { language: "unknown", confidence: 0 };
}

// Detect a book by voting on its chapters. A single large English license or
// front-matter chapter (common in Project Gutenberg EPUBs) can outweigh the
// actual Chinese body when the whole sample is counted by characters.
export function detectBookLanguage(chapters, { maxChars = 50000, chapterChars = 12000 } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  const votes = { zh: 0, en: 0, de: 0 };
  let voted = 0;
  for (const chapter of list) {
    const sample = `${chapter?.title || ""}\n${chapter?.text || ""}`.slice(0, chapterChars);
    const detected = detectSourceLanguage(sample, { maxChars: chapterChars });
    if (!Object.hasOwn(votes, detected.language)) continue;
    votes[detected.language] += 1;
    voted += 1;
  }
  if (!voted) {
    const sample = list
      .map((chapter) => `${chapter?.title || ""}\n${chapter?.text || ""}`)
      .join("\n")
      .slice(0, maxChars);
    return detectSourceLanguage(sample, { maxChars });
  }
  const ranked = Object.entries(votes).sort((left, right) => right[1] - left[1]);
  // A tie is ambiguous; fall back to the whole sample rather than picking an
  // arbitrary language.
  if (ranked[0][1] === ranked[1][1]) {
    const sample = list
      .map((chapter) => `${chapter?.title || ""}\n${chapter?.text || ""}`)
      .join("\n")
      .slice(0, maxChars);
    return detectSourceLanguage(sample, { maxChars });
  }
  return {
    language: ranked[0][0],
    confidence: Math.min(0.99, 0.5 + ranked[0][1] / Math.max(1, voted) * 0.5),
    votes,
  };
}

// A local script heuristic, not a network language detector. Ignore punctuation,
// numbers, and occasional English names inside otherwise Chinese prose.
export function isNonChineseSource(value) {
  const letters = String(value || "").slice(0, 12000).match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const han = letters.filter((letter) => /\p{Script=Han}/u.test(letter)).length;
  const kana = letters.filter((letter) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(letter)).length;
  return kana >= 2 && kana / letters.length >= 0.1 || han / letters.length < 0.5;
}

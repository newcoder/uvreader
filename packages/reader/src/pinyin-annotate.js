// Offline pinyin and glossary lookup for the selection popup. Everything is
// bundled: pinyin-pro handles polyphones with word segmentation, and the
// generated HANZI_GLOSSES table carries one short definition per character.
import { pinyin, segment } from "pinyin-pro";

import { HANZI_GLOSSES } from "./hanzi-dict-data.js";

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function isHanChar(char) {
  return HAN.test(String(char || ""));
}

export function hanziCount(text) {
  let count = 0;
  for (const char of String(text || "")) if (HAN.test(char)) count += 1;
  return count;
}

// Word-level pinyin: segment first so polyphones resolve from their word
// context ("银行" → yín háng, "行走" → xíng zǒu).
export function pinyinWords(text) {
  const words = [];
  for (const part of segment(String(text || ""))) {
    const origin = String(part?.origin || "");
    if (!HAN.test(origin)) continue;
    const syllables = pinyin(origin, { type: "array", toneType: "symbol", nonZh: "removed" });
    const value = syllables.join(" ");
    if (value) words.push({ text: origin, pinyin: value });
  }
  return words;
}

export function pinyinText(text) {
  return pinyinWords(text).map((word) => word.pinyin).join(" ");
}

// The popup only annotates short selections: a single character gets its
// glossary too, a longer run only the reading.
export function lookupSelection(text, options = {}) {
  const clean = String(text || "").trim();
  const maxChars = Number(options.maxChars) || 8;
  if (!clean || hanziCount(clean) === 0) return null;
  if (hanziCount(clean) > maxChars) return null;
  const words = pinyinWords(clean);
  if (!words.length) return null;
  const chars = [...clean].filter((char) => HAN.test(char));
  const single = chars.length === 1;
  const gloss = single ? HANZI_GLOSSES[chars[0]] || "" : "";
  return {
    text: clean,
    pinyin: words.map((word) => word.pinyin).join(" "),
    gloss,
    single,
    words,
  };
}

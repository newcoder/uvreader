// Offline pinyin and glossary lookup for the selection popup. Everything is
// bundled: pinyin-pro handles polyphones with word segmentation, and the
// generated HANZI_GLOSSES table carries one short definition per character.
// HANZI_VARIANTS sends traditional and variant forms to a covered character so
// a classical text gets definitions for 輒/滯 style characters too. Multi
// character selections use the generated word glossary (idioms and common
// words); a run that is not a word stays without a definition.
import { pinyin, segment } from "pinyin-pro";

import { HANZI_GLOSSES, HANZI_TRADITIONAL, HANZI_VARIANTS } from "./hanzi-dict-data.js";
import { WORD_DICT_GZIP_BASE64 } from "./word-dict-data.js";

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const HAN_ONLY = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u;
const NON_HAN_EDGE = /^[^\p{Script=Han}]+|[^\p{Script=Han}]+$/gu;

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

// Traditional forms keep the modern meaning of their simplified character even
// when they have an entry of their own (歡 is 欢, not the rare 歡乃). Variant
// forms without an entry fall back through the variant map instead.
export function glossFor(char) {
  const key = String(char || "");
  const simplified = HANZI_TRADITIONAL[key];
  if (simplified && HANZI_GLOSSES[simplified]) return HANZI_GLOSSES[simplified];
  return HANZI_GLOSSES[key] || HANZI_GLOSSES[HANZI_VARIANTS[key]] || "";
}

// Whole runs are converted the same way before the word lookup.
export function simplifiedWord(text) {
  return [...String(text || "")].map((char) => HANZI_TRADITIONAL[char] || char).join("");
}

// ── multi-character word glossary ───────────────────────────────────────────
// The generated table is gzipped to keep the bundle small; it is inflated on
// the first word lookup (and pre-warmed when a book opens).
let wordGlosses = null;
let wordGlossesLoad = null;

function wordTable() {
  if (!wordGlossesLoad) {
    wordGlossesLoad = (async () => {
      const bytes = Uint8Array.from(atob(WORD_DICT_GZIP_BASE64), (char) => char.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      const map = new Map();
      for (const line of text.split("\n")) {
        const at = line.indexOf("\t");
        if (at > 0) map.set(line.slice(0, at), line.slice(at + 1));
      }
      wordGlosses = map;
      return map;
    })();
  }
  return wordGlossesLoad;
}

export function warmWordGlosses() {
  void wordTable().catch(() => { /* pinyin alone is still useful */ });
}

// The lookup key of a selection: punctuation around the run is ignored, but a
// run that is not made of Han characters only is not a word.
export function wordKeyFor(text) {
  const key = String(text || "").replace(NON_HAN_EDGE, "");
  if (!HAN_ONLY.test(key) || key.length < 2 || key.length > 8) return "";
  return key;
}

export async function lookupWordGloss(text) {
  const key = wordKeyFor(text);
  if (!key) return "";
  const table = await wordTable();
  if (table.has(key)) return table.get(key);
  const simplified = simplifiedWord(key);
  if (simplified !== key && table.has(simplified)) return table.get(simplified);
  return "";
}

// The popup only annotates short selections: a single character gets its
// glossary right away, a multi-character run carries the key for the async
// word lookup.
export function lookupSelection(text, options = {}) {
  const clean = String(text || "").trim();
  const maxChars = Number(options.maxChars) || 8;
  if (!clean || hanziCount(clean) === 0) return null;
  if (hanziCount(clean) > maxChars) return null;
  const words = pinyinWords(clean);
  if (!words.length) return null;
  const chars = [...clean].filter((char) => HAN.test(char));
  const single = chars.length === 1;
  const gloss = single ? glossFor(chars[0]) : "";
  return {
    text: clean,
    pinyin: words.map((word) => word.pinyin).join(" "),
    gloss,
    single,
    words,
    wordKey: single ? "" : wordKeyFor(clean),
  };
}

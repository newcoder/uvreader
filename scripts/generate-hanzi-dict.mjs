// Generates the compact single-character glossary and the variant fallback map
// used by the selection pinyin/definition popup. Everything is offline at
// runtime: this script downloads the sources once, caches them under
// node_modules/.cache and writes packages/reader/src/hanzi-dict-data.js.
//
//   node scripts/generate-hanzi-dict.mjs [--source <word.json>]
//
// Sources:
//   - chinese-xinhua data/word.json (MIT)
//   - OpenCC TSCharacters / TWVariants / HKVariants (Apache-2.0)
//   - Unihan_Variants.txt from the Unicode Character Database (optional; when
//     it cannot be downloaded the OpenCC maps are still used)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const output = path.join(repoRoot, "packages/reader/src/hanzi-dict-data.js");
const cacheDir = path.join(repoRoot, "node_modules/.cache/chinese-xinhua");
const variantDir = path.join(repoRoot, "node_modules/.cache/hanzi-variants");
const wordCache = path.join(cacheDir, "word.json");
const unihanCache = path.join(variantDir, "Unihan.zip");

const RAW = "https://raw.githubusercontent.com";
const mirrors = (url) => [
  `https://ghproxy.net/${url}`,
  `https://gh-proxy.com/${url}`,
  url,
];
const WORD_SOURCES = mirrors(`${RAW}/pwxcoo/chinese-xinhua/master/data/word.json`);
const OPENCC_FILES = ["TSCharacters.txt", "TWVariants.txt", "HKVariants.txt"];
const UNIHAN_SOURCES = mirrors("https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip");

const PINYIN_CHARS = "a-züǖǘǚǜāáǎàēéěèīíǐìōóǒòūúǔùńňǹ·ɡ";
const BOPOMOFO_CHARS = "\\u3105-\\u3129\\u02c7\\u02ca\\u02cb\\u02c9\\u02d9\\u02c8\\u255d\\u2557\\u2554";
const BOPOMOFO = new RegExp(`[${BOPOMOFO_CHARS}]+`, "gu");
const CJK = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/u;
const MAX_GLOSS = 64;

function sourcePath() {
  const index = process.argv.indexOf("--source");
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
}

async function fetchCached(file, urls, { binary = false } = {}) {
  if (fs.existsSync(file)) return binary ? fs.readFileSync(file) : fs.readFileSync(file, "utf8");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lastError = null;
  for (const url of urls) {
    try {
      console.log("downloading", url);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
      fs.writeFileSync(file, data);
      return data;
    } catch (error) {
      lastError = error;
      console.warn("  failed:", error.message);
    }
  }
  throw lastError || new Error("download failed");
}

async function loadWordSource() {
  const explicit = sourcePath();
  if (explicit) return JSON.parse(fs.readFileSync(explicit, "utf8"));
  return JSON.parse(await fetchCached(wordCache, WORD_SOURCES));
}

// ── variant maps ────────────────────────────────────────────────────────────
async function loadOpenCcMaps() {
  const maps = [];
  for (const name of OPENCC_FILES) {
    const file = path.join(variantDir, name);
    try {
      const text = await fetchCached(file, mirrors(`${RAW}/BYVoid/OpenCC/master/data/dictionary/${name}`));
      const map = new Map();
      for (const line of text.split("\n")) {
        const [from, to] = line.trim().split(/\s+/);
        if (from && to) map.set(from, to.split("")[0]);
      }
      maps.push(map);
    } catch (error) {
      console.warn(`skipping ${name}:`, error.message);
    }
  }
  return maps;
}

async function loadUnihanMaps() {
  const fields = {
    kSimplifiedVariant: new Map(),
    kSemanticVariant: new Map(),
    kZVariant: new Map(),
    kSpecializedSemanticVariant: new Map(),
  };
  try {
    const buffer = await fetchCached(unihanCache, UNIHAN_SOURCES, { binary: true });
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const text = await zip.file("Unihan_Variants.txt").async("string");
    for (const line of text.split("\n")) {
      if (!line || line[0] === "#") continue;
      const parts = line.split("\t");
      const bucket = parts.length > 2 ? fields[parts[1].trim()] : null;
      if (!bucket) continue;
      const char = String.fromCodePoint(parseInt(parts[0].trim().slice(2), 16));
      if (bucket.has(char)) continue;
      const targets = parts[2].trim().split(/\s+/).map((part) => part.split("<")[0]).filter(Boolean)
        .map((hex) => { try { return String.fromCodePoint(parseInt(hex.slice(2), 16)); } catch { return ""; } })
        .filter(Boolean);
      if (targets.length) bucket.set(char, targets);
    }
    console.log("unihan variants:", Object.entries(fields).map(([name, map]) => `${name}=${map.size}`).join(" "));
  } catch (error) {
    console.warn("unihan variants unavailable:", error.message);
  }
  return fields;
}

// ── gloss extraction ────────────────────────────────────────────────────────
const SENSE_MARK = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑]|\([1-9]\d?\)|（[1-9]\d?）|\b[1-9][.、]/gu;
const norm = (value) => String(value || "").replace(/ɡ/gu, "g").replace(/·/gu, "").toLowerCase();
const toneless = (value) => norm(value).normalize("NFD").replace(/\p{M}/gu, "").replace(/ü/gu, "v");

function cutCitation(value) {
  const at = value.search(/《|--/u);
  return at > 0 ? value.slice(0, at) : value;
}

// One sense: strip part-of-speech marks, pronunciation parentheses, readings,
// stroke data and citations; keep the readable definition.
function cleanSense(value) {
  let text = String(value || "");
  const etymology = /[（(][^）)]{0,80}本义([^）)]{1,40})[）)]/u.exec(text);
  text = text
    .replace(/[（(][^）)]*《[^）)]*[）)]/gu, " ")
    .replace(/〈[^〉]*〉/g, " ").replace(/【[^】]*】/g, " ").replace(/\[[^\]]*\]/g, " ")
    .replace(BOPOMOFO, " ")
    .replace(/郑码\S*|笔画数\s*\d+|笔顺编号\s*\d+|部首笔画\s*\d+|总笔画\s*\d+|部首\s*\S*/gu, " ")
    .replace(new RegExp(`[（(]\\s*[${PINYIN_CHARS}]{1,14}\\s*[）)]`, "gu"), " ")
    .replace(/^[①-⑳⒈-⒑1-9][.、．)）]?\s*/u, "")
    .replace(/^又[a-züāáǎàēéěèīíǐìōóǒòūúǔùńňǹ·\s]{1,12}[；;，,]?\s*/iu, "")
    .replace(/^[（(][^）)]{0,60}[）)]\s*/u, "")
    .replace(/^[～~·]\s*/u, "")
    .replace(/\s+/g, " ").replace(/^[，、；;。～~\s]+/u, "").trim();
  text = cutCitation(text).replace(/[，、；;（(【\s]+$/u, "").trim();
  if (text.length < 2 && etymology) text = etymology[1].trim();
  return text;
}

// Reading markers ("字pinyin", "字（异体）pinyin") anchor each dictionary
// section. Bopomofo-only sections inherit the reading of the section above.
function markers(text, word) {
  const out = [];
  const pinyinRe = new RegExp(`(?:^|\\n)\\s*${word}(?:（[^）]{1,6}）)?\\s*[${PINYIN_CHARS}]{1,16}`, "gu");
  for (const hit of text.matchAll(pinyinRe)) {
    const tail = hit[0].replace(/^\s*/u, "").slice(word.length).replace(/^（[^）]*）/u, "").trim();
    out.push({ index: hit.index, end: hit.index + hit[0].length, reading: norm(tail), loose: toneless(tail), bopomofo: false });
  }
  const bopomofoRe = new RegExp(`(?:^|\\n)\\s*${word}(?:（[^）]{1,6}）)?\\s*[${BOPOMOFO_CHARS}]{1,16}`, "gu");
  for (const hit of text.matchAll(bopomofoRe)) {
    out.push({ index: hit.index, end: hit.index + hit[0].length, reading: null, loose: null, bopomofo: true });
  }
  out.sort((a, b) => a.index - b.index);
  let lastReading = null, lastLoose = null;
  for (const marker of out) {
    if (!marker.bopomofo) { lastReading = marker.reading; lastLoose = marker.loose; }
    else { marker.reading = lastReading; marker.loose = lastLoose; }
  }
  return out;
}

function bodyAt(text, marker, word) {
  const after = text.slice(marker.end);
  const next = markers(after, word)[0];
  return next && next.index > 0 ? after.slice(0, next.index) : after;
}

function sensesFrom(body) {
  const senses = [];
  for (const part of body.split(SENSE_MARK)) {
    const cleaned = cleanSense(part);
    if (cleaned.length < 2) continue;
    if (/^(?:同本义|本义|引申|形声|会意|象形|指事|又如|姓氏|见|姓|姓。|古)$/u.test(cleaned)) continue;
    if (/本义|同本义|又如|形声|会意|象形/u.test(cleaned) && !cleaned.includes("～")) continue;
    if (!/[\u4e00-\u9fff]/u.test(cleaned)) continue;
    if (BOPOMOFO.test(cleaned)) continue;
    if (/搜索与|成语接龙|打头的/u.test(cleaned)) continue;
    if (/[a-z]{3,}/iu.test(cleaned)) continue;
    senses.push(cleaned);
    if (senses.length >= 3) break;
  }
  return senses;
}

function firstBlock(body) {
  for (const block of String(body || "").split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
    const cleaned = cleanSense(block);
    if (cleaned.length < 2) continue;
    if (/^(?:同本义|本义|引申|形声|会意|象形|指事|又如|姓氏|见|姓)/u.test(cleaned)) continue;
    if (!/[\u4e00-\u9fff]/u.test(cleaned)) continue;
    return cleaned;
  }
  return "";
}

// A modern concise entry uses ～ as the character placeholder; an etymology
// block mentions 本义/同本义 or quotes a classic.
function scoreGloss(gloss) {
  if (!gloss) return -Infinity;
  let score = 0;
  if (gloss.includes("～")) score += 2;
  if (gloss.includes("；")) score += 1;
  if (/本义|同本义|又如/u.test(gloss)) score -= 4;
  if (/《|--/u.test(gloss)) score -= 4;
  if (/[a-z]{3,}/iu.test(gloss)) score -= 2;
  if (gloss.length >= 6) score += 1;
  if (gloss.length <= 3) score -= 1;
  return score;
}

function cap(gloss) {
  const firstStop = gloss.indexOf("。");
  if (firstStop >= 8) gloss = gloss.slice(0, firstStop + 1);
  if (gloss.length > MAX_GLOSS) {
    const cut = gloss.slice(0, MAX_GLOSS);
    const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"), cut.lastIndexOf(";"));
    gloss = stop > MAX_GLOSS * 0.4 ? cut.slice(0, stop + 1) : `${cut.replace(/[，、；;]$/u, "")}…`;
  }
  return gloss;
}

export function compactGloss(entry) {
  const word = String(entry?.word || "").trim();
  const primary = norm(String(entry?.pinyin || "").split(/[、,，;；/]/)[0].trim());
  const loose = toneless(primary);
  const texts = [String(entry?.explanation || ""), String(entry?.more || "")]
    .filter((text) => text.trim().length > word.length + 4);
  const candidates = [];
  const push = (gloss, marker, textIndex) => {
    if (!gloss) return;
    let score = scoreGloss(gloss) - textIndex * 0.5 - candidates.length * 0.02;
    if (marker?.reading && marker.reading === primary) score += 2;
    else if (marker?.loose && marker.loose === loose) score += 1;
    candidates.push({ gloss, score });
  };
  for (const [textIndex, text] of texts.entries()) {
    for (const marker of markers(text, word)) {
      push(cap(sensesFrom(bodyAt(text, marker, word)).join("；")), marker, textIndex);
    }
    const block = firstBlock(text);
    if (block) push(cap(block), null, textIndex);
  }
  if (!candidates.length) return "";
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].gloss;
}

function escapeValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function main() {
  const data = await loadWordSource();
  const entries = [];
  for (const entry of data) {
    const word = String(entry?.word || "").trim();
    if (!CJK.test(word)) continue;
    const gloss = compactGloss(entry);
    if (!gloss) continue;
    entries.push([word, gloss]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0], "zh"));

  // Variant fallback: only characters the glossary does not cover, resolved
  // through OpenCC and Unihan to a character that does.
  const glosses = new Map(entries);
  const opencc = await loadOpenCcMaps();
  const unihan = await loadUnihanMaps();
  const resolve = (char, depth = 0) => {
    if (!char || depth > 2) return "";
    if (glosses.has(char)) return char;
    for (const map of opencc) {
      const next = map.get(char);
      if (next) return resolve(next, depth + 1);
    }
    for (const name of ["kSimplifiedVariant", "kSemanticVariant", "kZVariant", "kSpecializedSemanticVariant"]) {
      for (const next of unihan[name].get(char) || []) {
        const hit = resolve(next, depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };
  const variantCandidates = new Set();
  for (const map of opencc) for (const char of map.keys()) variantCandidates.add(char);
  for (const name of Object.keys(unihan)) for (const char of unihan[name].keys()) variantCandidates.add(char);
  const variants = [];
  for (const char of variantCandidates) {
    if (glosses.has(char)) continue;
    const target = resolve(char);
    if (target && target !== char) variants.push([char, target]);
  }
  variants.sort((a, b) => a[0].localeCompare(b[0], "zh"));

  const lines = entries.map(([word, gloss]) => `  "${escapeValue(word)}": "${escapeValue(gloss)}",`);
  const variantLines = variants.map(([char, target]) => `  "${escapeValue(char)}": "${escapeValue(target)}",`);
  const module = `// Generated by scripts/generate-hanzi-dict.mjs — do not edit.
// Sources: chinese-xinhua data/word.json (MIT), OpenCC (Apache-2.0) and the
// Unihan database. HANZI_GLOSSES holds one short definition per character;
// HANZI_VARIANTS maps traditional and variant forms to a covered character.
export const HANZI_GLOSSES = Object.freeze({
${lines.join("\n")}
});

export const HANZI_VARIANTS = Object.freeze({
${variantLines.join("\n")}
});
`;
  fs.writeFileSync(output, module);
  console.log(`wrote ${entries.length} glosses and ${variants.length} variants -> ${path.relative(repoRoot, output)} (${Math.round(module.length / 1024)} KB)`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) await main();

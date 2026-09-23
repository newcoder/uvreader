import assert from "node:assert/strict";
import test from "node:test";

import { glossFor, hanziCount, isHanChar, lookupSelection, pinyinText, pinyinWords } from "../packages/reader/src/pinyin-annotate.js";
import { HANZI_GLOSSES, HANZI_VARIANTS } from "../packages/reader/src/hanzi-dict-data.js";

test("isHanChar and hanziCount only count CJK ideographs", () => {
  assert.equal(isHanChar("汉"), true);
  assert.equal(isHanChar("a"), false);
  assert.equal(isHanChar("，"), false);
  assert.equal(isHanChar(""), false);
  assert.equal(hanziCount("阅读abc，。"), 2);
  assert.equal(hanziCount(""), 0);
});

test("pinyinWords keeps word context for polyphones", () => {
  assert.equal(pinyinText("银行"), "yín háng");
  assert.equal(pinyinText("行走"), "xíng zǒu");
  assert.deepEqual(pinyinWords("阅读"), [{ text: "阅", pinyin: "yuè" }, { text: "读", pinyin: "dú" }]);
  assert.deepEqual(pinyinWords("abc"), []);
  assert.deepEqual(pinyinWords(""), []);
});

test("lookupSelection returns pinyin and the glossary for a single character", () => {
  const result = lookupSelection("犇");
  assert.equal(result.pinyin, "bēn");
  assert.match(result.gloss, /^群牛受惊奔跑。/u);
  assert.equal(result.single, true);
});

test("lookupSelection gives a reading without a glossary for words", () => {
  const result = lookupSelection("饕餮");
  assert.equal(result.pinyin, "tāo tiè");
  assert.equal(result.gloss, "");
  assert.equal(result.single, false);
});

test("lookupSelection rejects empty, latin and over-long selections", () => {
  assert.equal(lookupSelection(""), null);
  assert.equal(lookupSelection("hello"), null);
  assert.equal(lookupSelection("这是一段很长的中文句子用来测试上限"), null);
  assert.equal(lookupSelection("这是一段很长的中文句子用来测试上限", { maxChars: 40 })?.pinyin.includes(" "), true);
});

test("unknown characters degrade to no result instead of throwing", () => {
  assert.equal(lookupSelection("𠮷"), null);
  assert.equal(lookupSelection("　"), null);
});

test("traditional and variant characters fall back to the covered form", () => {
  assert.equal(HANZI_GLOSSES["輒"], undefined, "the traditional form has no entry of its own");
  assert.equal(HANZI_VARIANTS["輒"], "辄");
  assert.equal(glossFor("輒"), HANZI_GLOSSES["辄"]);
  assert.equal(glossFor("滯"), HANZI_GLOSSES["滞"]);
  assert.equal(lookupSelection("輒").gloss, HANZI_GLOSSES["辄"]);
  assert.match(glossFor("犇"), /^群牛受惊奔跑。/u);
});

test("the generated glossary keeps modern definitions instead of classical citations", () => {
  assert.match(HANZI_GLOSSES["品"], /物|等级|性质/u);
  assert.doesNotMatch(HANZI_GLOSSES["粗"], /《/u);
  assert.match(HANZI_GLOSSES["粗"], /横剖面|颗粒|粗糙/u);
  assert.doesNotMatch(HANZI_GLOSSES["睹"], /《/u);
  assert.match(HANZI_GLOSSES["睹"], /看见/u);
  const citations = Object.values(HANZI_GLOSSES).filter((gloss) => gloss.includes("《"));
  assert.equal(citations.length, 0, "no gloss may quote a classical dictionary");
});

import assert from "node:assert/strict";
import test from "node:test";

import { hanziCount, isHanChar, lookupSelection, pinyinText, pinyinWords } from "../packages/reader/src/pinyin-annotate.js";

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
  assert.equal(result.gloss, "群牛受惊奔跑。");
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

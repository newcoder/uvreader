import test from "node:test";
import assert from "node:assert/strict";
import { isNonChineseSource } from "../packages/reader/src/ai-source-language.js";
import { HIGHLIGHT_PAINTS, HL_COLOR_SWATCHES } from "../packages/reader/src/highlight-colors.js";

test("translation is offered for foreign-language prose but not Chinese, numbers, or punctuation", () => {
  for (const text of ["Hello", "Reading changes how we understand the world.", "吾輩は猫である。名前はまだ無い。", "책을 읽고 있습니다.", "Чтение помогает нам думать.", "Bonjour le monde", "This passage includes 中文 but is mostly English."]) assert.equal(isNonChineseSource(text), true, text);
  for (const text of ["", "123 — ?!", "读书使我们理解世界。", "这里提到 AI，但整段都是中文，也不需要翻译。", "繁體中文同樣不需要翻譯。", "这是带有一小段日本名字かな的长篇中文叙述，仍然主要属于中文。", null]) assert.equal(isNonChineseSource(text), false, String(text));
});

test("every offered highlight color has translucent fill, including pink", () => {
  for (const [id, , paint] of HL_COLOR_SWATCHES) {
    assert.equal(HIGHLIGHT_PAINTS[id], paint);
    assert.match(paint, /^rgba\(/);
  }
  assert.match(HIGHLIGHT_PAINTS.pink, /^rgba\(248,123,168,/);
});

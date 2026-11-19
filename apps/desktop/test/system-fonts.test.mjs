import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSystemFontNames } from "../src/main/system-fonts.js";

test("normalizeSystemFontNames dedupes and rejects CSS-breaking font names", () => {
  const fonts = normalizeSystemFontNames([
    "宋体",
    "Arial",
    "Arial",
    'bad"; font-family: x',
    "bad\\name",
    "  ",
    "微软雅黑",
  ]);
  assert.deepEqual(new Set(fonts.map((font) => font.name)), new Set(["Arial", "微软雅黑", "宋体"]));
  assert.equal(fonts.find((font) => font.name === "Arial").family, '"Arial"');
  assert.equal(fonts.find((font) => font.name === "微软雅黑").family, '"微软雅黑"');
});

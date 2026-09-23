import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHanzi } from "../packages/reader/src/hanzi-normalize.js";

test("normalizeHanzi maps traditional and variant characters one for one", () => {
  assert.equal(normalizeHanzi("歡喜這本書"), "欢喜这本书");
  assert.equal(normalizeHanzi("輒滯覩濬"), "辄滞睹浚");
  assert.equal(normalizeHanzi("阅读是一件安静的事情"), "阅读是一件安静的事情", "simplified text is returned unchanged");
  assert.equal(normalizeHanzi(""), "");
  const traditional = [..."歡喜這本書"];
  const normalized = [...normalizeHanzi("歡喜這本書")];
  assert.equal(normalized.length, traditional.length, "offsets stay valid");
});

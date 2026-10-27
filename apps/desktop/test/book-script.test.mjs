import assert from "node:assert/strict";
import test from "node:test";

import { convertChineseScript, scriptTargetLabel } from "../src/main/book-script.js";

test("Chinese script conversion handles common phrases and target labels", () => {
  assert.equal(convertChineseScript("汉语 简体字 国家 学习 发展", "t"), "漢語 簡體字 國家 學習 發展");
  assert.equal(convertChineseScript("漢語 繁體字 國家 學習 發展", "s"), "汉语 繁体字 国家 学习 发展");
  assert.equal(scriptTargetLabel("t"), "繁體");
  assert.equal(scriptTargetLabel("s"), "简体");
});

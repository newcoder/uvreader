import assert from "node:assert/strict";
import test from "node:test";

import { buildQuizAiContext } from "../packages/reader/src/quiz-context.js";

const manifest = {
  title: "2025 上海卷",
  questions: [
    { id: "q7", number: "7.", type: "choice", stemHtml: "<p>第七题题干</p>", options: [{ key: "A", html: "一" }, { key: "B", html: "二" }], answer: "A", analysisHtml: "<p>第七题解析</p>" },
    { id: "q16", number: "16.", type: "choice", stemHtml: "<p>第十六题题干</p>", options: [{ key: "A", html: "甲" }, { key: "B", html: "乙" }], answer: "B", analysisHtml: "<p>第十六题解析</p>" },
  ],
};

test("the quiz AI context contains the whole paper, not only the active question", () => {
  const before = buildQuizAiContext(manifest, { currentId: "q16" });
  assert.match(before, /第七题题干/);
  assert.match(before, /第十六题题干/);
  assert.match(before, /当前查看：q16/);
  assert.match(before, /（当前题）/);
  assert.doesNotMatch(before, /正确答案/);
  const after = buildQuizAiContext(manifest, { currentId: "q16", submitted: true });
  assert.match(after, /正确答案：A/);
  assert.match(after, /第七题解析/);
});

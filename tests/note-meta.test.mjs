import assert from "node:assert/strict";
import test from "node:test";

import { formatNoteTime, noteMetaLine } from "../packages/reader/src/note-meta.js";

const translate = (key) => ({
  "note-meta-time": "时间",
  "note-meta-source": "来源",
}[key] || key);

test("note metadata records time, source and origin", () => {
  const at = new Date(2026, 10, 2, 16, 30).getTime();
  assert.equal(formatNoteTime(at), "2026-11-02 16:30");
  assert.equal(
    noteMetaLine({ translate, created: at, source: "[[读书笔记]]", detail: "第 12 页", origin: "AI 回复" }),
    "> 时间：2026-11-02 16:30 · 来源：[[读书笔记]] · 第 12 页 · AI 回复",
  );
});

test("an old highlight without a timestamp still keeps its source and origin", () => {
  assert.equal(
    noteMetaLine({ translate, source: "[[读书笔记]]", origin: "手动输入" }),
    "> 来源：[[读书笔记]] · 手动输入",
  );
  assert.equal(formatNoteTime(0), "");
});

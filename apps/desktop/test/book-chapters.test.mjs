import assert from "node:assert/strict";
import test from "node:test";

import { chapterStats, mergeChapters, moveChapter, normalizeChapters, removeChapter, renameChapter, splitChapter } from "../src/shared/book-chapters.js";

const sample = () => [
  { title: "第一章 起风了", text: "第一段。\n\n第二段。" },
  { title: "第二章 雨", text: "第三段。" },
  { title: "第三章 晴", text: "第四段。" },
];

test("normalizeChapters trims titles and drops empties", () => {
  const list = normalizeChapters([{ title: " 一 ", text: " a " }, { title: "", text: "   " }, null]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "一");
  assert.equal(normalizeChapters(null).length, 0);
});

test("renameChapter keeps the old title when the input is blank", () => {
  const renamed = renameChapter(sample(), 1, "  雨夜  ");
  assert.equal(renamed[1].title, "雨夜");
  assert.equal(renameChapter(sample(), 1, "")[1].title, "第二章 雨");
  assert.deepEqual(renameChapter(sample(), 9, "x").length, 3);
});

test("mergeChapters joins with the next chapter and keeps the first title", () => {
  const merged = mergeChapters(sample(), 0);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "第一章 起风了");
  assert.match(merged[0].text, /第二段。\n\n第三章?/);
  assert.equal(merged[0].text.includes("第三段。"), true);
  assert.equal(mergeChapters(sample(), 2).length, 3, "the last chapter cannot merge forward");
});

test("splitChapter cuts at the paragraph boundary nearest the middle", () => {
  const chapters = [{ title: "长章", text: "甲".repeat(10) + "\n\n" + "乙".repeat(10) + "\n\n" + "丙".repeat(10) }];
  const split = splitChapter(chapters, 0);
  assert.equal(split.length, 2);
  assert.equal(split[0].title, "长章");
  assert.equal(split[1].title, "长章（下）");
  assert.equal(
    (split[0].text + "\n\n" + split[1].text).replace(/\s+/g, ""),
    "甲".repeat(10) + "乙".repeat(10) + "丙".repeat(10),
    "splitting loses no text",
  );
  assert.equal(splitChapter([{ title: "短", text: "只有一段" }], 0).length, 1, "a single paragraph cannot split");
});

test("moveChapter reorders within bounds", () => {
  const moved = moveChapter(sample(), 0, 1);
  assert.deepEqual(moved.map((chapter) => chapter.title), ["第二章 雨", "第一章 起风了", "第三章 晴"]);
  assert.deepEqual(moveChapter(sample(), 0, -1).map((c) => c.title), sample().map((c) => c.title));
  assert.deepEqual(moveChapter(sample(), 2, 1).length, 3);
});

test("chapterStats reports counts and characters", () => {
  const stats = chapterStats(sample());
  assert.equal(stats.chapters, 3);
  assert.equal(stats.chars, sample().reduce((sum, chapter) => sum + chapter.text.length, 0));
});

test("removeChapter drops one chapter but never empties the book", () => {
  const chapters = sample();
  const after = removeChapter(chapters, 0);
  assert.equal(after.length, chapters.length - 1);
  assert.equal(after[0].title, chapters[1].title);
  const single = [{ title: "唯一一章", text: "正文。" }];
  assert.equal(removeChapter(single, 0).length, 1, "最后一章不允许删空");
  assert.equal(removeChapter(chapters, 99).length, chapters.length, "越界不动");
});

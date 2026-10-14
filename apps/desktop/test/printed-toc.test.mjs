import assert from "node:assert/strict";
import test from "node:test";

import { isPrintedTocChapter, looksLikeTocEntry, stripPrintedToc, stripTocBlock, tocRatio } from "../src/shared/printed-toc.js";

const tocText = [
  "第 1 章 光学简史 …… 1",
  "1.1 开场白 …… 11",
  "1.2 初始时期 …… 11",
  "第 2 章 波动 …… 12",
  "2.1 一维波 …… 12",
  "2.1.1 微分波动方程 …… 15",
].join("\n");

test("looksLikeTocEntry recognises leaders and trailing page numbers", () => {
  assert.equal(looksLikeTocEntry("第 1 章 光学简史 …… 1"), true);
  assert.equal(looksLikeTocEntry("1.1 开场白 .... 11"), true);
  assert.equal(looksLikeTocEntry("Contents 12"), true);
  assert.equal(looksLikeTocEntry("从（5.5）式出发，证明：当 $l_o$ 近似稍作改进时得到（5.46）式"), false, "正文句子不算");
  assert.equal(looksLikeTocEntry("## 目录"), false, "标题行不算条目");
  assert.equal(looksLikeTocEntry("| $s_o=2f$ | 倒像 |"), false, "表格行不算");
  assert.equal(looksLikeTocEntry(""), false);
});

test("tocRatio measures how much of a chapter looks like a listing", () => {
  assert.equal(tocRatio(tocText), 1);
  assert.ok(tocRatio("这是一段正文。\n还有一句。") === 0);
});

test("a 目录 chapter with leaders is a printed toc", () => {
  assert.equal(isPrintedTocChapter({ title: "目录", text: tocText }), true);
  assert.equal(isPrintedTocChapter({ title: "Contents", text: tocText }, { frontMatter: true }), true);
  assert.equal(isPrintedTocChapter({ title: "第 1 章", text: "正文。\n另一段。" }), false);
});

test("a title-less listing only counts in the front matter", () => {
  assert.equal(isPrintedTocChapter({ title: "无题", text: tocText }, { frontMatter: true }), true);
  assert.equal(isPrintedTocChapter({ title: "无题", text: tocText }, { frontMatter: false }), false, "正文里的编号列表不能当目录");
});

test("stripPrintedToc drops the toc chapter and keeps the rest", () => {
  const chapters = [
    { title: "目录", text: tocText },
    { title: "第 1 章", text: "开头。" },
    { title: "第 2 章", text: "结尾。" },
  ];
  const result = stripPrintedToc(chapters);
  assert.equal(result.dropped, 1);
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["第 1 章", "第 2 章"]);
  assert.equal(result.removedLines, 6);
});

test("stripTocBlock only removes entries after the heading", () => {
  const text = ["前言：写这本书的缘由。", "", "## 目录", "", tocText, "", "正文从这里开始。", "6.31 见习题 12"].join("\n");
  const result = stripTocBlock(text);
  assert.ok(result.removed >= 7, `标题与条目都要去掉(${result.removed})`);
  assert.ok(!result.text.includes("……"), "条目不再留着");
  assert.match(result.text, /前言：写这本书的缘由。/);
  assert.match(result.text, /正文从这里开始。/);
  assert.match(result.text, /6\.31 见习题 12/, "没有「目录」标题时一行不动");
});

test("stripPrintedToc can be switched off and never empties the book", () => {
  const chapters = [{ title: "目录", text: tocText }];
  assert.equal(stripPrintedToc(chapters, { enabled: false }).dropped, 0);
  assert.equal(stripPrintedToc(chapters).chapters.length, 1, "全掉光时还原");
  assert.equal(stripPrintedToc(chapters).dropped, 0);
});

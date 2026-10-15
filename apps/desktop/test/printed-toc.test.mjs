import assert from "node:assert/strict";
import test from "node:test";

import { buildNavPlan, fillPageGaps, isPrintedTocChapter, looksLikeTocEntry, normalizeNavLevels, parsePrintedTocEntries, printedPageOf, stripPrintedToc, stripTocBlock, tocRatio } from "../src/shared/printed-toc.js";
import { outlineToTocEntries } from "../src/main/pdf-outline.js";

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

test("parsePrintedTocEntries keeps labels and infers levels", () => {
  const text = [
    "第 1 章 光学简史 …… 1",
    "1.1 开场白 ……… 11",
    "1.1.1 微分波动方程 …… 15",
    "§ 2 关于公理化的一般评论 …… 9",
    "形式主义的数学基础 …… 43",
  ].join("\n");
  const entries = parsePrintedTocEntries(text);
  assert.deepEqual(entries.map((entry) => entry.label), [
    "第 1 章 光学简史", "1.1 开场白", "1.1.1 微分波动方程", "§ 2 关于公理化的一般评论", "形式主义的数学基础",
  ]);
  assert.deepEqual(entries.map((entry) => entry.level), [1, 2, 3, 2, 1], "无编号的条目按 1 级(宁可平铺,不猜层级)");
  assert.deepEqual(entries.map((entry) => entry.page), [1, 11, 15, 9, 43]);
});

test("buildNavPlan matches in order, drops what it cannot find, keeps the ends", () => {
  const chapters = [
    { title: "译者序" },
    { title: "第一章 光学简史" },
    { title: "1.1 开场白" },
    { title: "1.2 初始时期" },
    { title: "第二章 波动" },
    { title: "注释" },
  ];
  const tocEntries = parsePrintedTocEntries([
    "第一章 光学简史 …… 1",
    "1.1 开场白 …… 11",
    "找不到的一节 …… 20",
    "第二章 波动 …… 12",
  ].join("\n"));
  const plan = buildNavPlan({ chapters, tocEntries });
  assert.equal(plan.matched, 3);
  assert.deepEqual(plan.dropped, ["找不到的一节"]);
  assert.deepEqual(plan.items.map((item) => item.title), ["译者序", "第一章 光学简史", "1.1 开场白", "第二章 波动", "注释"], "两端的前言/附录保留,匹配不上的中间条目丢弃");
  assert.equal(plan.items.find((item) => item.title === "1.1 开场白").level, 2);
});

test("normalizeNavLevels never jumps more than one level", () => {
  const items = normalizeNavLevels([
    { title: "a", level: 3 },
    { title: "b", level: 3 },
    { title: "c", level: 1 },
  ]);
  assert.deepEqual(items.map((item) => item.level), [1, 2, 1]);
});

test("buildNavPlan returns null when too little matches", () => {
  const plan = buildNavPlan({ chapters: [{ title: "甲" }, { title: "乙" }], tocEntries: parsePrintedTocEntries("丙 …… 3") });
  assert.equal(plan, null, "匹配太少时交回按标题分章");
});

test("printedPageOf reads the printed page from the anchor", () => {
  assert.equal(printedPageOf("<!--page:16 printed:7-->\n正文"), 7);
  assert.equal(printedPageOf("<!--page:16-->\n正文"), 0, "没有印刷页码就是 0");
  assert.equal(printedPageOf("正文"), 0);
});

test("a page hint rescues an entry whose title OCR mangled", () => {
  const chapters = [
    { title: "第一章 光学简史" },
    { title: "1.1 开场白" },
    { title: "第二章 波动" },
  ];
  const pages = [1, 11, 12];
  const tocEntries = [
    { label: "第一章 光学简史", key: "光学简史", page: 1, level: 1 },
    { label: "1.1 开 场 白", key: "开场白", page: 11, level: 2 },
    { label: "第二章 波动", key: "波动", page: 12, level: 1 },
  ];
  const withoutHint = buildNavPlan({ chapters, tocEntries });
  const withHint = buildNavPlan({ chapters, tocEntries, pages });
  assert.ok(withHint, "有页码提示时能出计划");
  assert.equal(withHint.matched, 3, "标题被 OCR 弄花也能靠页码命中");
  assert.equal(withoutHint.matched <= withHint.matched, true);
});

test("cover-ish chapters never lead the nav", () => {
  const chapters = [
    { title: "" },
    { title: "(第五版)" },
    { title: "Optics Fifth Edition" },
    { title: "译者序" },
    { title: "第一章 光学简史" },
    { title: "第二章 波动" },
  ];
  const tocEntries = parsePrintedTocEntries(["第一章 光学简史 …… 1", "第二章 波动 …… 12"].join("\n"));
  const plan = buildNavPlan({ chapters, tocEntries });
  assert.deepEqual(plan.items.map((item) => item.title), ["Optics Fifth Edition", "译者序", "第一章 光学简史", "第二章 波动"]);
  assert.ok(!plan.items.some((item) => /^[（(]/.test(item.title)), "括号版次条目不进导航");
  assert.ok(!plan.items.some((item) => !item.title), "无标题章节也不进导航");
});

test("a chapter is used by at most one entry", () => {
  const chapters = [{ title: "第一章 起点" }, { title: "第二章 终点" }];
  const tocEntries = [
    { label: "第一章 起点", key: "起点", page: 0, level: 1 },
    { label: "第一章 起点(重复条)", key: "起点重复条", page: 0, level: 1 },
    { label: "第二章 终点", key: "终点", page: 0, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries });
  const used = plan.items.map((item) => item.chapterIndex);
  assert.equal(new Set(used).size, used.length, "同一章不会出现在两条导航里");
  assert.equal(plan.matched, 2);
  assert.deepEqual(plan.dropped, ["第一章 起点(重复条)"]);
});

test("pageFirst lets an exact PDF page claim a chapter whose title was split", () => {
  // 上游把「第4章 电磁学」拆成了「第」;大纲页码是精确的 PDF 页 → 以页码认领。
  const chapters = [{ title: "第" }, { title: "4.1 静电场" }, { title: "第5章 光学" }];
  const pages = [40, 41, 52];
  const tocEntries = [
    { label: "第4章 电磁学", key: "电磁学", page: 40, level: 1 },
    { label: "第5章 光学", key: "光学", page: 52, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true });
  assert.equal(plan.matched, 2);
  assert.equal(plan.items[0].chapterIndex, 0, "页码命中被拆坏的标题章");
});

test("fillPageGaps interpolates between known anchors", () => {
  assert.deepEqual(fillPageGaps([10, 0, 0, 13, 0, 15]), [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(fillPageGaps([0, 0, 0]), [0, 0, 0], "全未知时保持原样");
  assert.deepEqual(fillPageGaps([5]), [5]);
});

test("outlineToTocEntries keeps the PDF's own levels", () => {
  const entries = outlineToTocEntries([
    { level: 1, title: "第1章 光学简史", page: 17 },
    { level: 2, title: "1.1 开场白", page: 17 },
    { level: 3, title: "1.1.1 细节", page: 18 },
    { level: 1, title: "   ", page: 20 },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.label, entry.page, entry.level]), [
    ["第1章 光学简史", 17, 1],
    ["1.1 开场白", 17, 2],
    ["1.1.1 细节", 18, 3],
  ]);
  assert.equal(entries[0].key, "光学简史");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTocOffset,
  bestTocPageRange,
  buildTocExtractionMessages,
  cleanTocLine,
  inferTocOffset,
  inferTocOffsetFromFooters,
  mergeTocEntries,
  parseTocExtractionReply,
  parseTocText,
  pdfTextLines,
  repairTocTitles,
  tocCandidates,
  tocPageRanges,
  tocTextFromLines,
  validateTocEntries,
} from "../packages/reader/src/pdf-toc.js";

// Real OCR lines from page 6 of 《小学数学奥林匹克常规训练试题库 六年级 修订版》.
const TOC_PAGE_TEXT = [
  "第一单元",
  "运算中的巧算………… (1)/(82)",
  "第二单元",
  "定义新运算………… (5)/(85)",
  "第三单元",
  "估算· ……………… (9)/(90)",
  "第四单元",
  "包含与排除… (13)/(96)",
].join("\n");

test("candidate pages are ranked by the TOC heuristics", () => {
  const ranked = tocCandidates([
    { page: 3, text: "普通正文\n这是一段没有目录特征的文字。\n还有几行。" },
    { page: 6, text: TOC_PAGE_TEXT },
    { page: 7, text: "目 录\n第一章 …… 1\n第二章 …… 9\n第三章 …… 20\n第四章 …… 30" },
  ]);
  assert.equal(ranked[0].page, 7, "heading plus leaders wins");
  assert.equal(ranked.some((item) => item.page === 6), true);
  assert.equal(ranked.some((item) => item.page === 3), false, "plain prose is not a candidate");
  const heading = ranked.find((item) => item.page === 7);
  assert.match(heading.reason, /heading/);
  assert.match(heading.reason, /leaders/);
});

test("a long TOC becomes one contiguous page range instead of four ranked pages", () => {
  const candidates = [
    { page: 10, score: 68 }, { page: 11, score: 68 }, { page: 12, score: 66 }, { page: 13, score: 66 },
    { page: 4, score: 62 }, { page: 9, score: 62 }, { page: 5, score: 61 }, { page: 3, score: 60 },
    { page: 6, score: 58 }, { page: 7, score: 61 }, { page: 8, score: 61 }, { page: 14, score: 66 },
    { page: 15, score: 64 }, { page: 16, score: 61 }, { page: 17, score: 64 }, { page: 18, score: 60 },
  ];
  assert.deepEqual(tocPageRanges(candidates), [
    { from: 3, to: 18, count: 16, score: 68, pages: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] },
  ]);
  const separated = tocPageRanges([{ page: 6, score: 40 }, { page: 7, score: 40 }, { page: 12, score: 35 }, { page: 13, score: 35 }]);
  assert.deepEqual(separated.map((range) => [range.from, range.to]), [[6, 7], [12, 13]]);
});

test("the best TOC range wins by score, not by the longest run", () => {
  const candidates = [
    { page: 3, score: 77 }, { page: 4, score: 77 }, { page: 5, score: 70 }, { page: 6, score: 70 },
    { page: 7, score: 70 }, { page: 8, score: 70 }, { page: 9, score: 70 }, { page: 10, score: 70 },
    { page: 11, score: 70 }, { page: 12, score: 70 }, { page: 13, score: 70 }, { page: 14, score: 70 },
    { page: 15, score: 70 }, { page: 16, score: 70 }, { page: 17, score: 70 },
    { page: 2177, score: 38 }, { page: 2178, score: 38 }, { page: 2179, score: 38 }, { page: 2180, score: 38 },
  ];
  const best = bestTocPageRange(candidates);
  assert.deepEqual([best.from, best.to], [3, 17], "the index run is longer but scores lower");
});

test("printed lines parse into entries with single, dual and bracketed numbers", () => {
  const entries = parseTocText([
    "第一章 起点 ......... 1",
    "1.1 小标题 ......... 12",
    "1.1.1 更小 ......... 13",
    "第二单元 定义新运算 (5)/（85）",
    "（一）括号编号 ......... 3",
  ].join("\n"));
  assert.deepEqual(entries[0], { level: 1, title: "第一章 起点", page: 1, page2: null });
  assert.equal(entries[1].level, 2);
  assert.equal(entries[2].level, 3);
  assert.deepEqual(entries[3], { level: 1, title: "第二单元 定义新运算", page: 5, page2: 85 });
  assert.equal(entries[4].level, 2, "bracketed numbering is a sub-level");
  assert.equal(entries.every((entry) => !entry.title.includes("…")), true, "leaders are stripped");
});

test("a formula split across two TOC lines keeps the full title", () => {
  const entries = parseTocText([
    "3.2 Vector Spaces . . . . . . 61",
    "3.3 Indexed Families; the Sum Notation ∑",
    "i∈I ai . . . . . . . . . . . . 64",
    "3.4 Linear Independence, Subspaces . . . . . . 70",
  ].join("\n"));
  assert.equal(entries[1].title, "3.3 Indexed Families; the Sum Notation ∑ i∈I ai");
  assert.equal(entries[1].page, 64);
  assert.equal(entries[2].title, "3.4 Linear Independence, Subspaces");
});

test("a formula-only AI title is repaired from the text-layer entry on the same page", () => {
  const repaired = repairTocTitles([
    { level: 1, title: "i∈I ai", page: 64 },
    { level: 1, title: "Vector Spaces", page: 61 },
    { level: 1, title: "Index", page: 2177 },
  ], [
    { level: 1, title: "3.3 Indexed Families; the Sum Notation ∑ i∈I ai", page: 64 },
    { level: 1, title: "3.2 Vector Spaces", page: 61 },
  ]);
  assert.equal(repaired[0].title, "3.3 Indexed Families; the Sum Notation ∑ i∈I ai");
  assert.equal(repaired[1].title, "3.2 Vector Spaces");
  assert.equal(repaired[2].title, "Index");
});

test("spaced dot leaders and running page headers are stripped from printed rows", () => {
  assert.equal(cleanTocLine("1 Introduction . . . . . . . 19"), "1 Introduction 19");
  const entries = parseTocText([
    "Contents Contents 3",
    "1 Introduction . . . . . . 19",
    "4 CONTENTS 5.1 Introduction . . . . . 143",
    "18 CONTENTS",
    "2 Groups, Rings, and Fields . . . . 21",
  ].join("\n"));
  assert.deepEqual(entries, [
    { level: 1, title: "1 Introduction", page: 19, page2: null },
    { level: 2, title: "5.1 Introduction", page: 143, page2: null },
    { level: 1, title: "2 Groups, Rings, and Fields", page: 21, page2: null },
  ]);
});

test("the offset is inferred from outline anchors by majority", () => {
  const verdict = inferTocOffset([
    { printed: 82, pdf: 88 },
    { printed: 85, pdf: 91 },
    { printed: 90, pdf: 96 },
    { printed: 122, pdf: 128 },
  ]);
  assert.deepEqual(verdict, { offset: 6, agree: 4, total: 4 });
  assert.equal(inferTocOffset([{ printed: 1, pdf: 7 }]), null, "one anchor is not enough");
});

test("applying the offset yields both exercise and answer PDF pages", () => {
  const entries = parseTocText(TOC_PAGE_TEXT);
  const shifted = applyTocOffset(entries, 6);
  assert.equal(shifted[0].pdfPage, 1 + 6);
  assert.equal(shifted[0].pdfPage2, 82 + 6);
  assert.equal(shifted[1].pdfPage, 5 + 6);
  const report = validateTocEntries(shifted, { totalPages: 201 });
  assert.equal(report.ok, true, report.problems.join("; "));
});

test("merging keeps outline-only entries and adds the missing exercise links", () => {
  const existing = [
    { label: "前言", page: 5, level: 1 },
    { label: "第一单元 运算中的巧算 试题*1 解答", page: 88, level: 1 },
    { label: "附录", page: null, level: 1 },
  ];
  const generated = applyTocOffset(parseTocText(TOC_PAGE_TEXT), 6);
  const merged = mergeTocEntries(existing, generated);
  assert.equal(merged.some((item) => item.title === "前言"), true);
  assert.equal(merged.some((item) => item.title === "附录"), true);
  const unit = merged.find((item) => item.title.includes("运算中的巧算"));
  assert.equal(unit.page, 1 + 6);
  assert.equal(unit.page2, 82 + 6);
  assert.deepEqual(unit.sources.sort(), ["outline", "toc"]);
  const ordered = merged.map((item) => item.page || 0);
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered, "merged list stays ordered by page");
});

test("multi-page images travel in page order, each beside its own text", () => {
  const messages = buildTocExtractionMessages(
    [{ page: 6, text: "甲" }, { page: 7, text: "乙" }],
    { images: { 7: { data: "B", mimeType: "image/jpeg" }, 6: { data: "A", mimeType: "image/jpeg" } } },
  );
  const parts = messages[1].content;
  assert.deepEqual(parts.map((part) => part.type), ["text", "text", "image", "text", "image"]);
  assert.equal(parts[2].data, "A");
  assert.equal(parts[4].data, "B");
  assert.match(parts[0].text, /共 2 页/);
  assert.match(parts[0].text, /以图片为准/);
});

test("mis-ordered OCR titles are repaired from the outline by matching answer pages", () => {
  // The real page-6 text layer glues 第十五单元's subtitle onto 第十四单元 and
  // puts 试题解答 (the column header) at the end; the printed numbers still land
  // on the outline destinations, so those titles win.
  const outline = [
    { label: "第十四单元 最佳选择 试题*67 解答", page: 128, level: 1 },
    { label: "第十五单元 最大最小问题 试题*73 解答", page: 134, level: 1 },
    { label: "第十六单元 博奕问题 试题*78 解答", page: 140, level: 1 },
  ];
  const generated = [
    { title: "第十四单元 最佳选择 最大最小问题", level: 1, pdfPage: 73, pdfPage2: 128 },
    { title: "第十五单元 博奕问题", level: 1, pdfPage: 79, pdfPage2: 134 },
    { title: "第十六单元 试题解答", level: 1, pdfPage: 84, pdfPage2: 140 },
  ];
  const merged = mergeTocEntries(outline, generated);
  assert.deepEqual(merged.map((item) => item.title), [
    "第十四单元 最佳选择",
    "第十五单元 最大最小问题",
    "第十六单元 博奕问题",
  ]);
  assert.deepEqual(merged.map((item) => item.page), [73, 79, 84]);
  assert.deepEqual(merged.map((item) => item.page2), [128, 134, 140]);
});

test("validation flags impossible levels, ranges and reversals", () => {
  const report = validateTocEntries([
    { title: "a", level: 1, pdfPage: 10 },
    { title: "b", level: 3, pdfPage: 12 },
    { title: "c", level: 2, pdfPage: 500 },
  ], { totalPages: 200 });
  assert.equal(report.ok, false);
  assert.match(report.problems.join(";"), /层级跳跃/);
  assert.match(report.problems.join(";"), /超出范围/);
});

test("model replies parse out of fences and drop unusable rows", () => {
  const reply = "这是目录：\n```json\n{\"entries\":[{\"level\":1,\"title\":\"第一单元 运算中的巧算\",\"page\":1,\"page2\":82},{\"level\":0,\"title\":\"\",\"page\":9},{\"level\":9,\"title\":\"附录\",\"page\":null}]}\n```";
  const entries = parseTocExtractionReply(reply);
  assert.deepEqual(entries, [{ level: 1, title: "第一单元 运算中的巧算", page: 1, page2: 82 }]);
  assert.deepEqual(parseTocExtractionReply("没有 JSON"), []);
  const roles = buildTocExtractionMessages([{ page: 6, text: TOC_PAGE_TEXT }]);
  assert.equal(roles[0].role, "system");
  assert.match(roles[0].content, /只输出/);
  assert.match(roles[1].content, /第 6 页/);
  assert.deepEqual(buildTocExtractionMessages([]), []);
});


test("positioned text lines keep two columns apart and merge title/page rows", () => {
  const item = (str, x, y, width = 30) => ({
    str,
    transform: [10, 0, 0, 10, x, y],
    width,
    height: 10,
  });
  const items = [
    item("图解 纳兰词", 50, 760, 100),
    item("左一", 50, 700),
    item("1", 170, 700, 10),
    item("右一", 350, 700),
    item("37", 470, 700, 10),
    item("左二", 50, 680),
    item("5", 170, 680, 10),
    item("右二", 350, 680),
    item("43", 470, 680, 10),
  ];
  const lines = pdfTextLines(items, { pageWidth: 600 });
  const text = tocTextFromLines(lines, { pageWidth: 600 });
  assert.equal(text, ["左一 1", "左二 5", "右一 37", "右二 43"].join("\n"));
});

test("footer page numbers infer a printed→PDF offset without an outline", () => {
  const pages = [
    { page: 11, text: "正文第一页\n1" },
    { page: 12, text: "正文第二页\n2" },
    { page: 13, text: "正文第三页\n3" },
    { page: 20, text: "正文第十页\n10" },
  ];
  assert.deepEqual(inferTocOffsetFromFooters(pages, { tocPages: [7, 8, 9, 10] }), {
    offset: 10, agree: 4, total: 4,
  });
  assert.equal(inferTocOffsetFromFooters(pages.slice(0, 2), { tocPages: [] }), null);
});


test("a merged two-column row is split into left and right entries", () => {
  const text = tocTextFromLines([
    { text: "Left title / 1 Right title / 37", x0: 50, x1: 560, y: 700 },
  ], { pageWidth: 600 });
  assert.equal(text, ["Left title / 1", "Right title / 37"].join("\n"));
});

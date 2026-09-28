import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTocOffset,
  buildTocExtractionMessages,
  inferTocOffset,
  mergeTocEntries,
  parseTocExtractionReply,
  parseTocText,
  scoreTocPage,
  tocCandidates,
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

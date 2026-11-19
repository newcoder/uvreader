import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTocPages,
  extractTocFromLayout,
  inferLayoutPageOffset,
  orderTocPage,
  parseLayoutTocLine,
  tocRowsForPdf,
} from "../src/shared/layout-toc.js";

const block = (type, bbox, text) => ({ type, bbox, text });

test("parseLayoutTocLine handles slash, space, leader and dual page numbers", () => {
  assert.deepEqual(parseLayoutTocLine("纳兰家族与曹家的渊源 / 1"), {
    title: "纳兰家族与曹家的渊源", page: 1, page2: null, level: 1,
  });
  assert.equal(parseLayoutTocLine("纳兰性德的爱情观与生活态度/8").page, 8);
  assert.equal(parseLayoutTocLine("纳兰性德其人 2").page, 2);
  assert.equal(parseLayoutTocLine("Chapter 1 .... 12").page, 12);
  assert.deepEqual(parseLayoutTocLine("Unit 1 (1)/(82)"), {
    title: "Unit 1", page: 1, page2: 82, level: 1,
  });
  assert.equal(parseLayoutTocLine("目录"), null);
  assert.equal(parseLayoutTocLine("图解 纳兰词"), null);
});

test("orderTocPage reads the left column before the right column", () => {
  const page = {
    page: 7,
    blocks: [
      block("text", [0.49, 0.3, 0.8, 0.32], "右一 / 37"),
      block("text", [0.04, 0.7, 0.3, 0.72], "左三 / 23"),
      block("text", [0.04, 0.3, 0.3, 0.32], "左一 / 1"),
      block("text", [0.49, 0.5, 0.8, 0.52], "右二 / 43"),
      block("text", [0.04, 0.5, 0.3, 0.52], "左二 / 12"),
    ],
  };
  assert.deepEqual(orderTocPage(page).entries.map((entry) => entry.title), [
    "左一", "左二", "左三", "右一", "右二",
  ]);
});

test("orderTocPage keeps index-block order and treats it as one column", () => {
  const page = {
    page: 8,
    blocks: [
      block("index", [0.52, 0.04, 0.87, 0.9], "右一 / 101\n右二 / 103"),
      block("index", [0.07, 0.04, 0.41, 0.5], "左一 / 66\n左二 / 68"),
    ],
  };
  assert.deepEqual(orderTocPage(page).entries.map((entry) => entry.title), [
    "左一", "左二", "右一", "右二",
  ]);
});

test("extractTocFromLayout detects the double-column run and the body offset", () => {
  const layout = {
    pages: [
      {
        page: 1,
        blocks: [
          block("paragraph_title", [0.8, 0.1, 0.9, 0.12], "目录"),
          block("text", [0.04, 0.2, 0.4, 0.22], "第一章 / 1"),
          block("text", [0.04, 0.3, 0.4, 0.32], "第二章 / 5"),
          block("text", [0.5, 0.2, 0.9, 0.22], "第三章 / 9"),
          block("text", [0.5, 0.3, 0.9, 0.32], "第四章 / 13"),
        ],
      },
      {
        page: 2,
        blocks: [
          block("text", [0.04, 0.2, 0.4, 0.22], "第五章 / 17"),
          block("text", [0.04, 0.3, 0.4, 0.32], "第七章 / 25"),
          block("text", [0.5, 0.2, 0.9, 0.22], "第六章 / 21"),
          block("text", [0.5, 0.3, 0.9, 0.32], "第八章 / 29"),
        ],
      },
      { page: 10, blocks: [block("page_number", [0.04, 0.95, 0.1, 0.97], "1")] },
      { page: 11, blocks: [block("page_number", [0.04, 0.95, 0.1, 0.97], "2")] },
      { page: 12, blocks: [block("page_number", [0.04, 0.95, 0.1, 0.97], "3")] },
      { page: 20, blocks: [block("page_number", [0.04, 0.95, 0.1, 0.97], "11")] },
    ],
  };
  const toc = extractTocFromLayout(layout, { pageCount: 50 });
  assert.deepEqual(toc.pages, [1, 2]);
  assert.equal(toc.offset, 9);
  assert.equal(toc.entries.length, 8);
  assert.equal(toc.entries[0].title, "第一章");
  assert.equal(toc.entries[0].pdfPage, 10);
  assert.equal(toc.entries[3].title, "第四章");
  assert.equal(toc.entries[3].pdfPage, 22);
});

test("inferLayoutPageOffset ignores TOC pages and needs a majority", () => {
  const layout = {
    pages: [
      { page: 7, blocks: [block("page_number", [0.9, 0.9, 0.95, 0.92], "1")] },
      { page: 20, blocks: [block("page_number", [0.9, 0.9, 0.95, 0.92], "10")] },
      { page: 21, blocks: [block("page_number", [0.9, 0.9, 0.95, 0.92], "11")] },
      { page: 22, blocks: [block("page_number", [0.9, 0.9, 0.95, 0.92], "12")] },
    ],
  };
  assert.equal(inferLayoutPageOffset(layout, [7]).offset, 10);
  assert.equal(inferLayoutPageOffset(layout, [7, 20, 21, 22]).total, 0);
});

test("detectTocPages prefers the early contents run over a later index", () => {
  const entries = (label, count) => Array.from({ length: count }, (_, index) =>
    block("text", [0.04, 0.2 + index * 0.04, 0.4, 0.22 + index * 0.04], `${label} ${index + 1} / ${index + 1}`));
  const layout = {
    pages: [
      {
        page: 3,
        blocks: [block("paragraph_title", [0.4, 0.1, 0.6, 0.12], "目录"), ...entries("目录条目", 4)],
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        page: 4 + index,
        blocks: entries("目录条目", 4),
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        page: 100 + index,
        blocks: entries("索引条目", 4),
      })),
    ],
  };
  assert.deepEqual(detectTocPages(layout).pages, [3, 4, 5, 6, 7]);
});

test("tocRowsForPdf emits PyMuPDF rows and clamps levels", () => {
  assert.deepEqual(tocRowsForPdf([
    { level: 0, title: "第一章", pdfPage: 10 },
    { level: 9, title: "第二节", pdfPage: 12 },
    { level: 1, title: "", pdfPage: 13 },
  ]), [[1, "第一章", 10], [3, "第二节", 12]]);
});

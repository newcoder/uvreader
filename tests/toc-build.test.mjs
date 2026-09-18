import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  buildTocItems,
  chapterForBlock,
  pageForBlock,
  pdfTextLooksUnreadable,
  readerSearchTexts,
  tocBoldHeadingText,
  tocFromBoldParagraphs,
  tocFromPrintedContents,
  tocLooksLikeNoise,
  tocNorm,
  tocTitleMatches,
} from "../packages/reader/src/toc-build.js";

function dom(html) {
  return new JSDOM(`<body>${html}</body>`).window;
}

test("chapterForBlock returns the last heading at or before the block", () => {
  const toc = [
    { label: "One", block: 0 },
    { label: "Two", block: 10 },
    { label: "Three", block: 20 },
  ];
  assert.equal(chapterForBlock(toc, 0), "One");
  assert.equal(chapterForBlock(toc, 9), "One");
  assert.equal(chapterForBlock(toc, 10), "Two");
  assert.equal(chapterForBlock(toc, 99), "Three");
  assert.equal(chapterForBlock([], 3), "");
  assert.equal(chapterForBlock(toc, undefined), "");
});

test("pageForBlock reads the PDF page holder around a block", () => {
  const win = dom(`
    <div data-pdf-page-no="1"><p>first</p></div>
    <div data-pdf-page-no="2"><p>second</p></div>
  `);
  const flow = win.document.body;
  assert.equal(pageForBlock(flow, 0), 1);
  assert.equal(pageForBlock(flow, 1), 2);
  assert.equal(pageForBlock(flow, 9), null);
  assert.equal(pageForBlock(null, 0), null);
});

test("buildTocItems prefers the outline and maps pages onto blocks", () => {
  const win = dom(`
    <div data-pdf-page-no="1"><p>Cover</p></div>
    <div data-pdf-page-no="2"><p>Chapter One</p></div>
    <div data-pdf-page-no="3"><p>Chapter Two</p></div>
  `);
  const items = buildTocItems(win.document.body.innerHTML, [
    { label: "Chapter One", page: 2, level: 0 },
    { label: "Chapter Two", page: 3, level: 1 },
  ], win);
  assert.deepEqual(items, [
    { label: "Chapter One", block: 1, level: 0, page: 2 },
    { label: "Chapter Two", block: 2, level: 1, page: 3 },
  ]);
});

test("buildTocItems falls back to headings when the outline is missing", () => {
  const win = dom("<h1>First</h1><p>body</p><h2>Second</h2><p>more</p><h3>Third</h3>");
  const items = buildTocItems(win.document.body.innerHTML, null, win);
  assert.deepEqual(items.map((it) => it.label), ["First", "Second", "Third"]);
  assert.deepEqual(items.map((it) => it.block), [0, 2, 4]);
});

test("printed contents lines are matched against the body in order", () => {
  const line = (title) =>
    `<p class="qiaomu-reader-toc-line"><span class="qiaomu-reader-toc-t">${title}</span></p>`;
  const html = [
    line("Alpha"),
    line("Beta"),
    line("Gamma"),
    "<p>Alpha</p>",
    "<p>filler</p>",
    "<p>Beta</p>",
    "<p>Gamma</p>",
  ].join("");
  const win = dom(html);
  const blocks = [...win.document.body.querySelectorAll("p")];
  const matched = tocFromPrintedContents(blocks);
  assert.deepEqual(matched.map((it) => it.label), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(matched.map((it) => it.block), [3, 5, 6]);
});

test("bold-paragraph fallback accepts short unique headings and drops pager noise", () => {
  const win = dom(
    "<p><b>Chapter One</b></p><p>body</p><p><b>Chapter Two</b></p><p>body</p>" +
    "<p><b>Chapter Three</b></p><p>body</p><p><b>123</b></p><p>body</p>" +
    "<p><b>This is a full sentence that ends with a period.</b></p>" +
    "<p>filler</p>".repeat(30),
  );
  const blocks = [...win.document.body.querySelectorAll("p")];
  assert.equal(tocBoldHeadingText(blocks[0]), "Chapter One");
  assert.equal(tocBoldHeadingText(blocks[6]), null, "page-number noise is rejected");
  assert.equal(tocBoldHeadingText(blocks[8]), null, "sentences are rejected");
  const items = tocFromBoldParagraphs(blocks);
  assert.deepEqual(items.map((it) => it.label), ["Chapter One", "Chapter Two", "Chapter Three"]);
});

test("tocLooksLikeNoise flags a dump longer than the page budget", () => {
  const win = dom(
    Array.from({ length: 40 }, (_, i) =>
      `<div data-pdf-page-no="${Math.floor(i / 10) + 1}"><p>line ${i}</p></div>`).join(""),
  );
  const blocks = [...win.document.body.querySelectorAll("p")];
  const short = blocks.slice(0, 5).map((_, i) => ({ label: `x${i}`, block: i }));
  const long = blocks.map((_, i) => ({ label: `x${i}`, block: i }));
  assert.equal(tocLooksLikeNoise(short, blocks), false);
  assert.equal(tocLooksLikeNoise(long, blocks), true);
});

test("tocNorm and tocTitleMatches normalize punctuation and prefixes", () => {
  assert.equal(tocNorm("  The «Quick»  Brown, Fox! "), "the quick brown fox");
  assert.equal(tocTitleMatches("the quick brown fox", "the quick"), true);
  assert.equal(tocTitleMatches("the quick brown fox", "quick"), false);
  assert.equal(tocTitleMatches("a-very-long-prefix-heading", "a-very-long-"), true);
});

test("pdfTextLooksUnreadable detects single-character token dumps", () => {
  assert.equal(pdfTextLooksUnreadable([]), false);
  const clean = Array.from({ length: 40 }, (_, i) => ({ str: `word${i}` }));
  assert.equal(pdfTextLooksUnreadable(clean), false);
  const broken = Array.from({ length: 40 }, (_, i) => ({ str: i % 2 ? "x" : "y" }));
  assert.equal(pdfTextLooksUnreadable(broken), true);
});

test("readerSearchTexts reads block text in document order", () => {
  const win = dom("<p>one</p><h1>two</h1><p>three</p>");
  assert.deepEqual(readerSearchTexts(win.document.body), ["one", "two", "three"]);
  assert.deepEqual(readerSearchTexts(null), []);
});

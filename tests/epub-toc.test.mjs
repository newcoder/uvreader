import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { buildEpubToc, findPrintedToc } from "../packages/reader/src/epub-toc.js";

function section(html, index = 0, id = `s${index}.xhtml`) {
  const dom = new JSDOM(`<body>${html}</body>`);
  return { index, id, doc: dom.window.document };
}

test("a printed EPUB contents page is parsed and matched to body headings", () => {
  const toc = section(`
    <section>
      <h2><p>Table of Content</p></h2>
      <u>
        <p>INTRODUCTION 6</p>
        <p>CHAPTER ONE 9</p>
        <p>A CHAPTER WITHOUT A PRINTED PAGE</p>
      </u>
      <b><p>INTRODUCTION</p></b>
      <p>Body text.</p>
      <h2>CHAPTER ONE</h2>
      <p>Body text.</p>
      <p>A CHAPTER WITHOUT A PRINTED PAGE</p>
    </section>`);
  const found = findPrintedToc([toc]);
  assert.equal(found.entries.length, 3);
  const report = buildEpubToc([toc], {
    cfiFromRange: (_index, range) => `cfi:${range.startContainer.parentNode?.textContent || ""}`,
  });
  assert.equal(report.ok, true);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.entries.map((entry) => entry.title), [
    "INTRODUCTION",
    "CHAPTER ONE",
    "A CHAPTER WITHOUT A PRINTED PAGE",
  ]);
  assert.match(report.entries[0].cfi, /INTRODUCTION/);
  assert.match(report.entries[1].cfi, /CHAPTER ONE/);
});

test("printed contents can point at headings in a later spine section", () => {
  const toc = section(`
    <section>
      <h1>Contents</h1>
      <ul><li><a href="chapter-1.xhtml">Chapter One</a></li></ul>
      <ul><li><a href="chapter-2.xhtml">Chapter Two</a></li></ul>
    </section>`, 0, "toc.xhtml");
  const body = section(`
    <section><h1>Chapter One</h1><p>One.</p><h1>Chapter Two</h1><p>Two.</p></section>`,
  1, "body.xhtml");
  const report = buildEpubToc([toc, body], {
    cfiFromRange: (index, range) => `cfi:${index}:${range.startContainer.parentNode?.textContent || ""}`,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.entries.map((entry) => entry.href), ["", ""]);
  assert.match(report.entries[0].cfi, /^cfi:1:/);
  assert.match(report.entries[1].cfi, /^cfi:1:/);
});

test("AZW3-style loose printed rows do not absorb following body paragraphs", () => {
  const azw3 = section(`
    <p>Table of Contents</p>
    <p>Chapter One 1</p>
    <p>Chapter Two 5</p>
    <p>Chapter One</p><p>Body one.</p>
    <p>Chapter Two</p><p>Body two.</p>`, 0, 0);
  const report = buildEpubToc([azw3], {
    cfiFromRange: (_index, range) => `cfi:${range.startContainer.parentNode?.textContent || ""}`,
  });
  assert.equal(report.ok, true);
  assert.equal(report.entries.length, 2);
  assert.equal(report.entries[0].sectionId, "0");
  assert.equal(report.entries[1].sectionId, "0");
  assert.deepEqual(report.entries.map((entry) => entry.title), ["Chapter One", "Chapter Two"]);
});

test("a contents heading in ordinary prose is not accepted without enough entries", () => {
  const body = section("<p>Contents of this chapter are explained below.</p><p>Body.</p>");
  assert.equal(findPrintedToc([body]), null);
  assert.equal(buildEpubToc([body]).ok, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSHOP_CAPABILITIES,
  groupWorkshopCapabilities,
  workshopCapabilitiesFor,
  workshopCapability,
} from "../src/shared/workshop-capabilities.js";

test("workshop capability copy stays outcome-first", () => {
  const forbidden = /OCR|DocVortex|Calibre|MinerU|pdf_tool|文字层|payload/i;
  for (const capability of WORKSHOP_CAPABILITIES) {
    assert.doesNotMatch(capability.title, forbidden);
    assert.doesNotMatch(capability.summary, forbidden);
    assert.doesNotMatch(capability.cue || "", forbidden);
  }
});

test("the catalogue recommends PDF and EPUB outcomes for the current book", () => {
  const pdf = workshopCapabilitiesFor({ extension: "pdf" });
  assert.deepEqual(
    pdf.slice(0, 3).map((capability) => capability.id),
    ["make-searchable", "exam-answer-page", "extract-text"],
  );
  assert.equal(pdf[0].recommended, true);
  assert.deepEqual(
    pdf.filter((capability) => capability.recommended && capability.primary).map((capability) => capability.id),
    ["make-searchable", "exam-answer-page", "extract-text", "make-ebook", "convert-word", "convert-markdown", "navigation-toc"],
  );
  const epub = workshopCapabilitiesFor({ extension: ".EPUB" });
  assert.equal(epub[0].id, "extract-text");
  assert.equal(epub.find((capability) => capability.id === "convert-kindle").recommended, true);
  assert.equal(epub.find((capability) => capability.id === "make-searchable").recommended, false);
  assert.equal(epub.find((capability) => capability.id === "navigation-toc").recommended, true);
  assert.equal(epub.find((capability) => capability.id === "navigation-toc").hidden, false);
  assert.equal(epub.find((capability) => capability.id === "export-navigation-epub").hidden, true);
  const azw3 = workshopCapabilitiesFor({ extension: "azw3" });
  assert.equal(azw3.find((capability) => capability.id === "navigation-toc").recommended, true);
  assert.equal(azw3.find((capability) => capability.id === "export-navigation-epub").hidden, true);
  const epubWithToc = workshopCapabilitiesFor({
    extension: "epub",
    readerView: {
      file: { extension: "epub" },
      tocItems: [{ label: "Chapter 1", sectionId: "OEBPS/text/ch1.xhtml" }],
    },
  });
  assert.equal(epubWithToc.find((capability) => capability.id === "export-navigation-epub").hidden, false);
  assert.equal(epubWithToc.find((capability) => capability.id === "export-navigation-epub").recommended, true);
  const azw3WithToc = workshopCapabilitiesFor({
    extension: "azw3",
    readerView: {
      file: { extension: "azw3" },
      tocItems: [{ label: "Chapter 1", sectionId: "0", cfi: "epubcfi(/6/2!/4)" }],
    },
  });
  assert.equal(azw3WithToc.find((capability) => capability.id === "export-navigation-epub").hidden, false);
  assert.equal(azw3WithToc.find((capability) => capability.id === "export-navigation-epub").recommended, true);
});

test("standalone exam images expose extraction, conversion and answer-page outcomes", () => {
  const image = workshopCapabilitiesFor({ extension: "png" });
  const recommended = image.filter((capability) => capability.recommended).map((capability) => capability.id);
  for (const id of ["exam-answer-page", "extract-text", "questions-and-answers", "convert-word", "convert-markdown", "convert-pdf"]) {
    assert.equal(recommended.includes(id), true, id);
  }
  assert.equal(recommended.includes("make-ebook"), false, "image tools lead with Markdown, not EPUB creation");
  assert.equal(image.find((capability) => capability.id === "make-ebook").hidden, false);
  assert.equal(image.find((capability) => capability.id === "make-searchable").recommended, false);
  assert.equal(image.find((capability) => capability.id === "navigation-toc").recommended, false);
});

test("search and navigation disappear once the document already has them", () => {
  const ready = workshopCapabilitiesFor({
    extension: "pdf",
    readerView: {
      pager: { total: 3 },
      _pdfLazy: { _pageText: ["一", "二", "三"] },
      tocItems: [{ label: "第一章" }],
    },
  });
  assert.equal(ready.find((item) => item.id === "make-searchable").hidden, true);
  assert.equal(ready.find((item) => item.id === "searchable-copy").hidden, true);
  assert.equal(ready.find((item) => item.id === "navigation-toc").hidden, true);
  assert.equal(ready.find((item) => item.id === "make-searchable").recommended, false);

  const scanned = workshopCapabilitiesFor({
    extension: "pdf",
    readerView: { pager: { total: 3 }, _pdfLazy: { _pageText: ["", "", ""] } },
  });
  assert.equal(scanned.find((item) => item.id === "make-searchable").hidden, false);
  assert.equal(scanned.find((item) => item.id === "navigation-toc").hidden, false);

  const epubWithToc = workshopCapabilitiesFor({
    extension: "epub",
    readerView: { tocItems: [{ label: "Chapter 1", cfi: "epubcfi(/6/2)" }] },
  });
  assert.equal(epubWithToc.find((item) => item.id === "navigation-toc").hidden, true);
});

test("the exam outcome opens the quiz format and all groups have items", () => {
  const exam = workshopCapability("exam-answer-page");
  assert.equal(exam.tool, "convert");
  assert.equal(exam.convertFormat, "quiz-ai");
  const markdown = workshopCapability("convert-markdown");
  assert.equal(markdown.tool, "convert");
  assert.equal(markdown.convertFormat, "markdown");
  assert.equal(markdown.title, "把文档转成 Markdown");
  assert.equal(workshopCapability("make-ebook").title, "制作电子书");
  assert.equal(workshopCapability("make-ebook").primary, true);
  const toc = workshopCapability("navigation-toc");
  assert.equal(toc.action, "ai-prompt");
  assert.match(toc.prompt, /导航目录/);
  const groups = groupWorkshopCapabilities(workshopCapabilitiesFor({ extension: "pdf" }));
  assert.deepEqual(groups.map((group) => group.id), ["reading", "study", "documents", "books"]);
  assert.ok(groups.every((group) => group.items.length > 0));
});

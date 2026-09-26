import assert from "node:assert/strict";
import test from "node:test";

import { pdfScanVerdict, searchablePdfName } from "../packages/reader/src/pdf-scan.js";

test("a PDF without a text layer counts as scanned", () => {
  const full = pdfScanVerdict(["scan", "scan", "scan", "scan"], { total: 4 });
  assert.deepEqual(full, { scanned: true, total: 4, textPages: 0 });
});

test("a text PDF stays below the scan threshold", () => {
  const text = Array.from({ length: 20 }, () => "text");
  assert.equal(pdfScanVerdict(text, { total: 20 }).scanned, false);
  const withImages = [...text.slice(0, 17), "scan", "scan", "scan"];
  assert.equal(pdfScanVerdict(withImages, { total: 20 }).scanned, false, "15% image pages is normal");
});

test("a mostly scanned book is treated as scanned", () => {
  const mixed = ["text", ...Array.from({ length: 9 }, () => "scan")];
  const verdict = pdfScanVerdict(mixed, { total: 10 });
  assert.equal(verdict.scanned, true);
  assert.equal(verdict.textPages, 1);
});

test("an empty or unreadable document is never scanned", () => {
  assert.equal(pdfScanVerdict([], { total: 0 }).scanned, false);
  assert.equal(pdfScanVerdict(null).scanned, false);
});

test("the generated copy keeps the source stem", () => {
  assert.equal(searchablePdfName("book.pdf"), "book.searchable.pdf");
  assert.equal(searchablePdfName("Books/扫描件.PDF"), "扫描件.searchable.pdf");
  assert.equal(searchablePdfName(""), "book.searchable.pdf");
  assert.equal(searchablePdfName("no-extension"), "no-extension.searchable.pdf");
});

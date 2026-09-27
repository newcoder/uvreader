import assert from "node:assert/strict";
import test from "node:test";

import { PDF_SCAN_MIN_TEXT_CHARS, pdfScanPageKind, pdfScanVerdict, searchablePdfName } from "../packages/reader/src/pdf-scan.js";

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

test("a watermark does not make a scanned page digital", () => {
  assert.equal(pdfScanPageKind(""), "scan");
  assert.equal(pdfScanPageKind("4"), "scan");
  assert.equal(pdfScanPageKind("www.example.com/1"), "scan", "watermarks stay scans");
  assert.equal(pdfScanPageKind("x".repeat(PDF_SCAN_MIN_TEXT_CHARS)), "text");
  assert.equal(pdfScanPageKind("这是一段真正的正文文字，足够长，可以当作数字排版层的证据。".repeat(2)), "text");
  // The two books the OCR pass skipped: every page carries four watermark
  // characters, so the whole document counts as scanned.
  const watermarked = Array.from({ length: 9 }, () => pdfScanPageKind("4"));
  assert.equal(pdfScanVerdict(watermarked, { total: 9 }).scanned, true);
});

test("the generated copy keeps the source stem and adds _text", () => {
  assert.equal(searchablePdfName("book.pdf"), "book_text.pdf");
  assert.equal(searchablePdfName("Books/扫描件.PDF"), "扫描件_text.pdf");
  assert.equal(searchablePdfName(""), "book_text.pdf");
  assert.equal(searchablePdfName("no-extension"), "no-extension_text.pdf");
});

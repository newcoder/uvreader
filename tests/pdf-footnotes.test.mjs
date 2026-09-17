import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { JSDOM } from 'jsdom';
import { footnotePdfBytes } from './fixtures/pdf-footnotes.mjs';
import { pdfPageShell } from '../packages/reader/src/pdf-page-mode.js';
import { getPdfTextContent } from '../packages/reader/src/pdf-text-content.js';

test('PDF superscript references and footnotes preserve original page geometry', async () => {
  const task = getDocument({ data: footnotePdfBytes(), isEvalSupported: false, useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    const before = text.items.find((item) => item.str === 'Text before');
    const reference = text.items.find((item) => item.str === '31');
    const after = text.items.find((item) => item.str.includes('continues on'));
    const footnote = text.items.find((item) => item.str.includes('This footnote'));
    assert.equal(before.transform[5], after.transform[5]);
    assert.ok(reference.transform[5] > before.transform[5]);
    assert.ok(reference.height < before.height);
    assert.ok(footnote.transform[5] < 100);
    const dom = new JSDOM(pdfPageShell({ pageNumber: 1, width: page.view[2], height: page.view[3], kind: 'text', isLast: true }));
    const image = dom.window.document.querySelector('img[data-pdf-page="1"]');
    assert.equal(image.width, 612);
    assert.equal(image.height, 792);
    assert.equal(dom.window.document.querySelectorAll('p').length, 0);
    dom.window.close();
    // Both desktop and mobile dispatch through this extractor. Prevent a later
    // typography feature from routing PDFs back through the old reflow path.
    const source = fs.readFileSync(new URL('../packages/reader/src/main.js', import.meta.url), 'utf8');
    const extractor = source.slice(source.indexOf('async function extractPdf('), source.indexOf('async function extractPdf(') + 5000);
    assert.ok(extractor.includes('parts.push(pdfPageShell({'));
    assert.ok(!extractor.includes('pdfItemsToHtml('));
  } finally {
    await task.destroy();
  }
});

test('PDF text extraction works when Safari lacks ReadableStream async iteration', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  const task = getDocument({ data: footnotePdfBytes(), isEvalSupported: false, useSystemFonts: true });
  try {
    assert.equal(delete ReadableStream.prototype[Symbol.asyncIterator], true);
    const pdf = await task.promise;
    const page = await pdf.getPage(1);

    await assert.rejects(page.getTextContent(), /async iterable|not a function/i);
    const text = await getPdfTextContent(page);

    assert.ok(text.items.some((item) => item.str === 'Text before'));
    assert.ok(text.items.some((item) => item.str.includes('This footnote')));
  } finally {
    if (descriptor) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, descriptor);
    await task.destroy();
  }
});

test('PDF text compatibility reader preserves XFA handling in PDF.js', async () => {
  const expected = { items: [{ str: 'XFA' }], styles: {}, lang: null };
  let streamCalls = 0;
  const page = {
    isPureXfa: true,
    async getTextContent() { return expected; },
    streamTextContent() { streamCalls += 1; },
  };
  assert.equal(await getPdfTextContent(page), expected);
  assert.equal(streamCalls, 0);
});

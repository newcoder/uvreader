import assert from "node:assert/strict";
import test from "node:test";

import { createPdfDocument, pdfFieldObjectsHaveFillableForm } from "../packages/reader/src/pdf-document.js";

function makeReader(win = globalThis) {
  return createPdfDocument({ setupWorker: async () => {}, win });
}

test("pdfFieldObjectsHaveFillableForm accepts editable text and checkboxes only", () => {
  assert.equal(pdfFieldObjectsHaveFillableForm(null), false);
  assert.equal(pdfFieldObjectsHaveFillableForm({}), false);
  assert.equal(pdfFieldObjectsHaveFillableForm({ a: [{ type: "text", editable: true }] }), true);
  assert.equal(pdfFieldObjectsHaveFillableForm({ allFields: { a: [{ type: "checkbox", editable: true }] } }), true);
  assert.equal(pdfFieldObjectsHaveFillableForm({ a: [{ type: "text", editable: false }] }), false);
  assert.equal(pdfFieldObjectsHaveFillableForm({ a: [{ type: "text", hidden: true }] }), false);
  assert.equal(pdfFieldObjectsHaveFillableForm({ a: [{ type: "radiobutton" }] }), false);
  assert.equal(pdfFieldObjectsHaveFillableForm({ a: [{ type: "signature" }] }), false);
});

test("pdfPageCharCount ignores whitespace and pdfPageSize normalizes the view box", () => {
  const reader = makeReader();
  assert.equal(reader.pdfPageCharCount([{ str: "a b" }, { str: " c " }, {}]), 3);
  assert.equal(reader.pdfPageCharCount(null), 0);
  assert.deepEqual(reader.pdfPageSize({ view: [0, 0, 612.4, 792.6] }), { width: 612, height: 793 });
  assert.deepEqual(reader.pdfPageSize({}), { width: 612, height: 792 });
});

test("readPdfPage reports progress, geometry and text for a readable page", async () => {
  const reader = makeReader();
  let cleaned = 0;
  const page = {
    pageNumber: 2,
    view: [0, 0, 612, 792],
    async getTextContent() { return { items: [{ str: "Hello world" }, { str: " second" }] }; },
    cleanup() { cleaned += 1; },
  };
  const progress = [];
  const sharedText = [];
  const part = await reader.readPdfPage({ getPage: async () => page }, 2, undefined, (n, t) => progress.push([n, t]), 2,
    (pageNumber, content) => sharedText.push([pageNumber, content.items.length]));
  assert.deepEqual(progress, [[2, 2]]);
  assert.deepEqual(sharedText, [[2, 2]], "the background pass hands its text extraction to the lazy render cache");
  assert.deepEqual(part, {
    width: 612,
    height: 792,
    kind: "text",
    textFallback: "Hello world second",
    aiText: "Hello world second",
  });
  assert.equal(cleaned, 1);
});

test("readPdfPage suppresses the text layer when the page text is unreadable", async () => {
  const reader = makeReader();
  const items = Array.from({ length: 40 }, (_, i) => ({ str: i % 2 ? "x" : "y" }));
  const page = {
    pageNumber: 1,
    view: [0, 0, 400, 600],
    async getTextContent() { return { items }; },
    cleanup() {},
  };
  const part = await reader.readPdfPage({ getPage: async () => page }, 1, undefined, null, 10);
  assert.equal(part.kind, "scan");
  assert.equal(part.textFallback, "");
  assert.equal(part.aiText, "");
});

test("readPdfPage rethrows the abort error before touching the page", async () => {
  const reader = makeReader();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reader.readPdfPage({ getPage: async () => { throw new Error("must not load"); } }, 1, controller.signal),
    (error) => error.name === "AbortError",
  );
});

test("collectPdfOutlineInto walks nested destinations depth-first", async () => {
  const reader = makeReader();
  const doc = {
    async getOutline() {
      return [{ title: "One", dest: "d1", items: [{ title: " Child ", dest: ["ref", 0] }] }];
    },
    async getDestination(name) { return name === "d1" ? ["ref", 0] : null; },
    async getPageIndex() { return 4; },
  };
  const outline = [];
  await reader.collectPdfOutlineInto(doc, outline);
  assert.deepEqual(outline, [
    { label: "One", page: 5, level: 0 },
    { label: "Child", page: 5, level: 1 },
  ]);
});

test("startRenderBudget cancels the task and rejects with the budget marker", async () => {
  const timers = [];
  const cleared = [];
  const win = {
    setTimeout(fn) { timers.push(fn); return 7; },
    clearTimeout(id) { cleared.push(id); },
  };
  const reader = makeReader(win);
  const task = { cancelled: 0, cancel() { this.cancelled += 1; } };
  const budget = reader.startRenderBudget(task, 5000);
  const expectation = assert.rejects(budget.promise, /qiaomu-reader-render-budget/);
  timers[0]();
  await expectation;
  assert.equal(task.cancelled, 1);
  budget.clear();
  assert.deepEqual(cleared, [7]);
});

test("the lazy view renders a page image and tears the loading task down", async () => {
  const reader = makeReader();
  const canvases = [];
  const ownerDocument = {
    createElement(_tag) {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect() {} }),
        toDataURL: () => "data:image/jpeg;base64,AAA",
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const page = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    cleanup() {},
  };
  let destroyed = 0;
  const pageText = ["", "text for page two"];
  const lazy = reader.createPdfLazyView({ getPage: async () => page }, { destroy: async () => { destroyed += 1; } }, pageText);
  const result = await lazy.render(1, ownerDocument);
  assert.equal(result.src, "data:image/jpeg;base64,AAA");
  assert.equal(result.textLayer, null);
  assert.equal(canvases.length, 1);
  assert.equal(lazy.textFor(2), "text for page two");
  assert.equal(lazy.textFor(3), "");
  lazy.destroy();
  assert.equal(destroyed, 1);
  assert.equal(pageText.length, 0, "destroy releases the text cache");
});

test("the lazy view refuses to render after destroy", async () => {
  const reader = makeReader();
  const lazy = reader.createPdfLazyView({ getPage: async () => ({}) }, { destroy: async () => {} }, [""]);
  lazy.destroy();
  await assert.rejects(lazy.render(1, { createElement: () => ({}) }), /Reader closed/);
});

function screenRenderFixture(pageText) {
  const calls = [];
  let textExtractions = 0;
  const ownerDocument = {
    createElement() {
      return {
        width: 0,
        height: 0,
        className: "",
        style: {},
        setAttribute() {},
        appendChild() {},
        getContext: () => ({ fillStyle: "", fillRect() {} }),
        toDataURL(type, quality) {
          calls.push([type, quality]);
          return type === "image/png" ? "data:image/png;base64,AAA" : "data:image/jpeg;base64,AAA";
        },
      };
    },
  };
  const page = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    getTextContent: async () => { textExtractions += 1; return { items: [{ str: "text" }] }; },
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    cleanup() {},
  };
  const reader = makeReader();
  const lazy = reader.createPdfLazyView({ getPage: async () => page }, { destroy: async () => {} }, pageText);
  return { lazy, ownerDocument, calls, textExtractionCount: () => textExtractions };
}

test("a screen-sized page renders at HiDPI resolution and uses lossless PNG for text", async () => {
  const { lazy, ownerDocument, calls, textExtractionCount } = screenRenderFixture(["text on page one"]);
  const result = await lazy.render(1, ownerDocument, {
    cssWidth: 300,
    cssHeight: 400,
    devicePixelRatio: 2,
    withTextLayer: false,
  });
  assert.equal(result.pixelWidth, 1200);
  assert.equal(result.pixelHeight, 1600);
  assert.equal(result.scale, 2);
  assert.equal(result.limited, false);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(calls, [["image/png", undefined]]);
  assert.equal(textExtractionCount(), 0, "a bitmap-only repaint must not rebuild the text layer");
});

test("page text extraction is reused across bitmap re-renders", async () => {
  const { lazy, ownerDocument, textExtractionCount } = screenRenderFixture(["text on page one"]);
  const first = await lazy.render(1, ownerDocument, { cssWidth: 300, cssHeight: 400, devicePixelRatio: 2 });
  const second = await lazy.render(1, ownerDocument, { cssWidth: 300, cssHeight: 400, devicePixelRatio: 2 });
  assert.equal(first.mimeType, "image/png");
  assert.equal(second.mimeType, "image/png");
  assert.equal(textExtractionCount(), 1, "the second paint reuses the cached text content");
});

test("a page without a text layer keeps JPEG output for scans", async () => {
  const { lazy, ownerDocument, calls } = screenRenderFixture([""]);
  const result = await lazy.render(1, ownerDocument, {
    cssWidth: 300,
    cssHeight: 400,
    devicePixelRatio: 1.5,
  });
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(calls, [["image/jpeg", 0.92]]);
});

test("a render that omits screen measurements keeps the legacy JPEG thumbnail", async () => {
  const { lazy, ownerDocument, calls } = screenRenderFixture([""]);
  const result = await lazy.render(1, ownerDocument);
  assert.equal(result.pixelWidth, 1200);
  assert.equal(result.pixelHeight, 1600);
  assert.equal(result.limited, false);
  assert.deepEqual(calls, [["image/jpeg", 0.82]]);
});

test("openPdfLoadingTask checks the abort signal before any work", async () => {
  const reader = makeReader();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.openPdfLoadingTask({ vault: {} }, {}, controller.signal), (error) => error.name === "AbortError");
});

test("the PDF sidecar loader reads figures through the vault and the adapter", async () => {
  const reader = makeReader();
  const payload = {
    figures: [
      { page: 20, bbox: [0.1, 0.1, 0.5, 0.5], name: "插图" },
      { page: 0, bbox: [0.1, 0.1, 0.5, 0.5] },
    ],
  };
  const expected = { figures: [{ page: 20, bbox: [0.1, 0.1, 0.5, 0.5], name: "插图", type: "image" }] };
  const vaultApp = {
    vault: {
      getAbstractFileByPath: (filePath) => (filePath.endsWith(".figures.json") ? { path: filePath } : null),
      read: async () => JSON.stringify(payload),
      adapter: { exists: async () => false, read: async () => "" },
    },
  };
  assert.deepEqual(await reader.readPdfFigureManifest(vaultApp, { path: "Books/书.pdf" }), expected);

  const adapterApp = {
    vault: {
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (filePath) => filePath.endsWith(".figures.json"),
        read: async () => JSON.stringify(payload),
      },
    },
  };
  assert.deepEqual(await reader.readPdfFigureManifest(adapterApp, { path: "C:\\书.pdf" }), expected);
  assert.equal(await reader.readPdfFigureManifest(vaultApp, { path: "Books/书.epub" }), null);
});

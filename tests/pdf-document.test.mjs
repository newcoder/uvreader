import assert from "node:assert/strict";
import test from "node:test";

import { createPdfDocument } from "../packages/reader/src/pdf-document.js";

function makeReader(win = globalThis) {
  return createPdfDocument({ setupWorker: async () => {}, win });
}

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
  const part = await reader.readPdfPage({ getPage: async () => page }, 2, undefined, (n, t) => progress.push([n, t]), 2);
  assert.deepEqual(progress, [[2, 2]]);
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
    createElement(tag) {
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

test("openPdfLoadingTask checks the abort signal before any work", async () => {
  const reader = makeReader();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.openPdfLoadingTask({ vault: {} }, {}, controller.signal), (error) => error.name === "AbortError");
});

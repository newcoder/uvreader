import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// foliate-js reads DOM globals (NodeFilter, HTMLElement, customElements) while
// its modules load; the browser provides them, so the test borrows the jsdom
// window before importing the reader modal.
const dom = new JSDOM("<div></div>");
globalThis.NodeFilter ??= dom.window.NodeFilter;
globalThis.HTMLElement ??= dom.window.HTMLElement;
globalThis.customElements ??= dom.window.customElements;
const { createReaderModal } = await import("../packages/reader/src/reader-modal.js");

function build() {
  const Base = class Modal { constructor(app) { this.app = app; } };
  const ReaderModal = createReaderModal({
    Modal: Base,
    createPdfPaginator: () => ({ total: 0, spread: 0 }),
  });
  return { Base, ReaderModal };
}

test("the factory extends the injected host base class instead of importing Obsidian", () => {
  const { Base, ReaderModal } = build();
  assert.equal(Object.getPrototypeOf(ReaderModal.prototype), Base.prototype);
  assert.equal(ReaderModal.name, "ReaderModal");
});

test("the modal tracks the book it was opened with", () => {
  const { ReaderModal } = build();
  const app = {};
  const file = { path: "Books/Alice.epub", basename: "Alice.epub", extension: "epub" };
  const modal = new ReaderModal(app, { settings: {} }, file);
  assert.equal(modal.app, app);
  assert.equal(modal.file, file);
  assert.equal(modal.ext, "epub");
  assert.equal(modal._closed, false);
  assert.equal(modal.pdfZoom, 1, "PDF zoom starts at the default scale");
});

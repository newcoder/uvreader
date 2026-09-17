import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// foliate-js reads DOM globals (NodeFilter, HTMLElement, customElements) while
// its modules load; the browser provides them, so the test borrows the jsdom
// window before importing the reader view.
const dom = new JSDOM("<div></div>");
globalThis.NodeFilter ??= dom.window.NodeFilter;
globalThis.HTMLElement ??= dom.window.HTMLElement;
globalThis.customElements ??= dom.window.customElements;
const { createReaderView } = await import("../packages/reader/src/reader-view.js");

function build() {
  const Base = class ItemView { constructor(leaf) { this.leaf = leaf; } };
  const ReaderView = createReaderView({
    ItemView: Base,
    VIEW_TYPE: "qiaomu-reader",
    createPdfPaginator: () => ({ total: 0, spread: 0 }),
  });
  return { Base, ReaderView };
}

test("the factory extends the injected host base class instead of importing Obsidian", () => {
  const { Base, ReaderView } = build();
  assert.equal(Object.getPrototypeOf(ReaderView.prototype), Base.prototype);
  assert.equal(ReaderView.name, "ReaderView");
});

test("view identity and state come from the reader constants and the open file", () => {
  const { ReaderView } = build();
  const view = new ReaderView({}, { settings: {} });
  assert.equal(view.getViewType(), "qiaomu-reader");
  assert.equal(view.getIcon(), "book-open");
  assert.equal(view.getDisplayText(), "UV Reader", "a view without a file falls back to the product name");
  view.file = { basename: "Alice.epub", path: "Books/Alice.epub" };
  assert.equal(view.getDisplayText(), "Alice.epub");
  assert.deepEqual(view.getState(), { file: "Books/Alice.epub", path: "Books/Alice.epub" });
  assert.equal(view.pdfZoom, 1, "PDF zoom starts at the default scale");
  assert.equal(view.bookHtml, "");
});

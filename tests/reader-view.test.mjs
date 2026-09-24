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
// The view's resize debounce uses the browser timer API; give the test the
// jsdom window so the real code path runs.
globalThis.window ??= dom.window;
const { createReaderView } = await import("../packages/reader/src/reader-view.js");
const { beginColumnDrag, endColumnDrag } = await import("../packages/reader/src/column-drag.js");

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

function sizedView() {
  const { ReaderView } = build();
  const view = new ReaderView({}, { settings: {} });
  view.app = { isMobile: false };
  view.bookHtml = "<p>page</p>";
  view._closed = false;
  view._openingBook = false;
  view.containerEl = { offsetParent: {} };
  view.areaEl = { clientWidth: 500, clientHeight: 600 };
  view.pager = { builtHeight: 600 };
  view._laidOutWidth = 400;
  view.repaginate = async () => { view.repaginations = (view.repaginations || 0) + 1; };
  return view;
}

test("a plain resize debounces the reflow without blurring the pages first", () => {
  const view = sizedView();
  let relayouts = 0;
  view._setRelayout = () => { relayouts += 1; };
  view._onAreaResized();
  assert.notEqual(view._resizeTimer, null, "the reflow is scheduled");
  assert.equal(relayouts, 0, "the veil waits for the reflow itself, not for every resize frame");
  window.clearTimeout(view._resizeTimer);
  view._resizeTimer = null;
  view._laidOutWidth = 500;
  view._onAreaResized();
  assert.equal(view._resizeTimer, null, "a width jitter within the settling window stays quiet");
});

test("a divider drag holds the reflow and lands it when the pointer is released", () => {
  const view = sizedView();
  view._setRelayout = () => {};
  beginColumnDrag();
  try {
    view._onAreaResized();
    assert.equal(view._resizeTimer, null, "no reflow is scheduled while the divider is dragged");
    assert.equal(view._columnDragResized, true);
    assert.equal(view.repaginations || 0, 0);
    view._afterColumnDrag();
    assert.equal(view._columnDragResized, false);
    assert.equal(view.repaginations, 1, "the layout lands once the drag ends");
  } finally {
    endColumnDrag();
  }
  view._afterColumnDrag();
  assert.equal(view.repaginations, 1, "a drag without a pending resize does nothing");
  window.clearTimeout(view._resizeTimer);
});

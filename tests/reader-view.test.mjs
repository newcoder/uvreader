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

function build(extraPorts = {}) {
  const Base = class ItemView { constructor(leaf) { this.leaf = leaf; } };
  const ReaderView = createReaderView({
    ItemView: Base,
    VIEW_TYPE: "qiaomu-reader",
    createPdfPaginator: () => ({ total: 0, spread: 0 }),
    readerAiPanelContext: (view) => (view.file && view.bookHtml ? { bookFile: view.file, readerView: view } : null),
    ...extraPorts,
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

test("setState reloads the same book when its file was replaced on disk", async () => {
  class FakeTFile {}
  const { ReaderView } = build({ TFile: FakeTFile });
  const view = new ReaderView({}, { settings: {} });
  const openFile = new FakeTFile();
  openFile.path = "Books/A.epub";
  openFile.stat = { mtime: 1, size: 10 };
  const freshFile = new FakeTFile();
  freshFile.path = "Books/A.epub";
  freshFile.stat = { mtime: 1, size: 10 };
  view.file = openFile;
  view.bookHtml = "<p>old</p>";
  view._openedFileStamp = { mtime: 1, size: 10 };
  view.app = { vault: { getAbstractFileByPath: () => freshFile } };
  let opened = 0;
  view.openFile = async () => { opened += 1; };

  await view.setState({ path: openFile.path });
  assert.equal(opened, 0, "an unchanged file keeps the open book");

  freshFile.stat = { mtime: 2, size: 11 };
  await view.setState({ path: openFile.path });
  assert.equal(opened, 1, "a rebuilt library copy is re-read");
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

function stubButton() {
  return {
    classes: new Set(),
    attrs: {},
    toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
  };
}

test("the AI toolbar button toggles the companion and presses while it is open", async () => {
  const { ReaderView } = build();
  const plugin = {
    settings: {},
    companionOpen: false,
    opened: 0,
    closed: 0,
    aiCompanionOpen() { return this.companionOpen; },
    async openAiChat() { this.opened += 1; this.companionOpen = true; },
    closeReadingCompanion() { this.closed += 1; this.companionOpen = false; },
  };
  const view = new ReaderView({}, plugin);
  view.file = { path: "Books/A.epub", basename: "A", extension: "epub" };
  view.bookHtml = "<p>x</p>";
  view.aiBtn = stubButton();
  view.hlBtn = stubButton();
  view.tocBtn = stubButton();

  await view._toggleAiCompanion();
  assert.equal(plugin.opened, 1, "a closed companion opens");
  assert.equal(view.aiBtn.classes.has("qiaomu-reader-ibtn-on"), true, "the button looks pressed while open");
  assert.equal(view.aiBtn.attrs["aria-expanded"], "true");

  await view._toggleAiCompanion();
  assert.equal(plugin.closed, 1, "a second click closes the companion");
  assert.equal(view.aiBtn.classes.has("qiaomu-reader-ibtn-on"), false);
  assert.equal(view.aiBtn.attrs["aria-expanded"], "false");
});

test("the toolbar sync mirrors the companion, the highlights dock and the TOC panel", () => {
  const { ReaderView } = build();
  const plugin = { settings: {}, aiCompanionOpen: () => true };
  const view = new ReaderView({}, plugin);
  view.aiBtn = stubButton();
  view.hlBtn = stubButton();
  view.tocBtn = stubButton();
  view.hlDockPanel = { isOpen: () => true };
  view.panelOpen = "toc";

  view._syncToolButtons();
  for (const [name, btn] of [["ai", view.aiBtn], ["highlights", view.hlBtn], ["toc", view.tocBtn]]) {
    assert.equal(btn.classes.has("qiaomu-reader-ibtn-on"), true, `${name} looks pressed while open`);
    assert.equal(btn.attrs["aria-expanded"], "true", `${name} announces its open state`);
  }

  plugin.aiCompanionOpen = () => false;
  view.hlDockPanel = { isOpen: () => false };
  view.panelOpen = null;
  view._syncToolButtons();
  for (const [name, btn] of [["ai", view.aiBtn], ["highlights", view.hlBtn], ["toc", view.tocBtn]]) {
    assert.equal(btn.classes.has("qiaomu-reader-ibtn-on"), false, `${name} releases when closed`);
    assert.equal(btn.attrs["aria-expanded"], "false", `${name} announces its closed state`);
  }
});

test("a PDF chapter click during the first layout is applied after the book opens", async () => {
  const { ReaderView } = build({ readerIsPdf: (view) => view.file?.extension === "pdf" });
  const view = new ReaderView({}, { settings: {} });
  const lazy = {};
  view.file = { path: "Books/book.pdf", extension: "pdf" };
  view.bookHtml = "<div></div>";
  view._pdfLazy = lazy;
  view._openingBook = {};
  view.pager = { total: 0 };
  await view._jumpToBlock(346);
  assert.deepEqual(view._pendingPdfJump, {
    block: 346, flash: true, path: "Books/book.pdf", lazy,
  }, "the click is held until the pager exists");
  view._openingBook = null;
  view.pager.total = 369;
  let applied = null;
  view._jumpToBlock = (block, flash) => { applied = { block, flash }; };
  view._flushPendingPdfJump();
  assert.deepEqual(applied, { block: 346, flash: true });
  assert.equal(view._pendingPdfJump, null);
});

test("a PDF highlight whose page is not rendered still jumps to its page", () => {
  // 锚点找不回来(目标页已被按需渲染收回去)时,不再只弹「找不到」。
  const { ReaderView } = build({ resolveHighlightAnchor: () => null });
  const view = new ReaderView({}, { settings: {} });
  const highlight = { id: "hl-late", color: "yellow", text: "第4页的正文内容", block: 3, occ: 0, created: 1 };
  view.file = { path: "Books/论文.pdf", extension: "pdf" };
  view.plugin = { getHighlights: () => [highlight], saveProgress: () => {} };
  view.pager = {
    total: 12,
    currentBlockIndex: () => 0,
    // 按需渲染把远处的页收回去之后,flow 里已经没有目标页的文本层,
    // 锚点找不回来——这时按 block→页→spread 的关系直接跳。
    flow: { querySelectorAll: () => [] },
    spreadForBlock: (block) => block,
    jumpTo: (spread) => { view.jumped = spread; return [spread, 12]; },
  };
  view._pdfLazy = true;
  view.updateUI = () => {};
  view.closePanel = () => {};
  view._flashHighlightLater = () => {};
  // jsdom 默认不带 requestAnimationFrame;跳页后用它排一次闪烁。
  const hadRaf = typeof window.requestAnimationFrame === "function";
  if (!hadRaf) window.requestAnimationFrame = (fn) => { fn(); return 0; };
  try {
    view._jumpToHighlightRecord("hl-late");
  } finally {
    if (!hadRaf) delete window.requestAnimationFrame;
  }
  assert.equal(view.jumped, 3, "block 3 就是第 4 页的 spread");
});

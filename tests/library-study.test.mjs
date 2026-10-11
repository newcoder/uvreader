import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import { coverPalette } from "../packages/reader/src/book-cover.js";
import { bookTagsOf, createLibraryData, groupLibChips, mergeBookTags } from "../packages/reader/src/library-data.js";

const libData = createLibraryData({
  translate: (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key),
  path: (value) => String(value == null ? "" : value).trim().replace(/\\/g, "/"),
});

// The library modal lives in its own module now; the test evaluates the
// factory with stub ports so the class keeps running against jsdom.
const modalSource = fs.readFileSync(new URL("../packages/reader/src/library-modal.js", import.meta.url), "utf8");
const modalFactory = modalSource.slice(modalSource.indexOf("export function createLibraryModal(")).replace("export function", "function");

function setup() {
  const { window } = new JSDOM("<main></main>");
  const { document, HTMLElement } = window;
  HTMLElement.prototype.setText = function (text) { this.textContent = text; };
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
  HTMLElement.prototype.toggleClass = function (name, value) { this.classList.toggle(name, value); };
  HTMLElement.prototype.removeClass = function (...names) { for (const name of names) this.classList.remove(name); };
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  HTMLElement.prototype.createEl = function (tag, options = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
    this.append(el); return el;
  };
  for (const tag of ["div", "span"]) HTMLElement.prototype[`create${tag[0].toUpperCase() + tag.slice(1)}`] = function (options) {
    return this.createEl(tag, typeof options === "string" ? { cls: options } : options);
  };
  let reads = 0, notes = 0, menus = 0, panels = 0;
  const reader = { file: { path: "Books/example.epub" }, hlPan: {}, togglePanel(name) { this.panelOpen = name; panels++; } };
  const plugin = { settings: {}, getProgress: () => ({ percent: 12 }), getHighlights: () => [{ text: "A useful idea" }], openFile: async () => { reads++; return reader; }, _saveLocalData: async () => {} };
  const Library = vm.runInNewContext(`${modalFactory}\ncreateLibraryModal({
    Modal, Notice, window, qiaomuReaderTranslate, svgIcon, docOf, bookNoteLinkFor,
    resolveBookNote, openOrCreateBookNoteBeside, qiaomuReaderPath, coverPalette,
    coverFromBytes: () => null, STARTER_BOOKS: [], findStarterBook: () => null,
    pdfjsLib: {}, BOOK_EXTENSIONS: __bookExtensions, readerHud,
    bookStatusOf, bookTagsOf, buildLibChips, filterLibBooks, groupLibChips, mergeBookTags,
    deleteBookFromVault: () => {}, freeBookPath: (dir, name) => (dir ? dir + "/" + name : name),
    pickLibraryFolder: () => "", qiaomuReaderLibTheme: () => ({}), qiaomuReaderLocale: () => "zh",
    setupWorker: () => ({}),
  })`, {
    Modal: class { close() {} }, window, Date, console,
    readerHud: { autoFocus() {}, blurOnTapOutside() {} },
    qiaomuReaderTranslate: (key, n) => n === undefined ? key : `${key}:${n}`,
    svgIcon() {}, docOf: (el) => el.ownerDocument,
    bookNoteLinkFor: () => "linked", resolveBookNote: () => ({}),
    openOrCreateBookNoteBeside: async () => { notes++; },
    Notice: class {}, qiaomuReaderPath: value => value, coverPalette,
    __bookExtensions: new Set(["epub", "pdf"]),
    bookStatusOf: libData.bookStatusOf, bookTagsOf, buildLibChips: libData.buildLibChips,
    filterLibBooks: libData.filterLibBooks, groupLibChips, mergeBookTags,
  });
  const library = new Library({}, plugin);
  library.loadThumb = async () => {};
  library._libCardMenu = () => ev => { ev.preventDefault(); ev.stopPropagation(); menus++; };
  const file = { path: "Books/example.epub", basename: "Example", extension: "epub" };
  const host = document.querySelector("main");
  library.renderCard(host, file);
  return { window, Library, library, file, reader, host, stats: () => ({ reads, notes, menus, panels }) };
}

test("library note and highlight controls do not also open the book through card keyboard bubbling", async () => {
  const x = setup();
  const [highlight, note] = x.host.querySelectorAll(".qiaomu-reader-lib-study-button");
  note.dispatchEvent(new x.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  note.click();
  assert.deepEqual(x.stats(), { reads: 0, notes: 1, menus: 0, panels: 0 });
  highlight.dispatchEvent(new x.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  highlight.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(x.stats(), { reads: 1, notes: 1, menus: 0, panels: 1 });
  assert.equal(x.reader.panelOpen, "highlights");
});

test("card keyboard activation opens once and menu activation stays local", () => {
  const x = setup();
  x.host.querySelector(".qiaomu-reader-lib-card").dispatchEvent(new x.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  x.host.querySelector(".qiaomu-reader-lib-morebtn").click();
  assert.deepEqual(x.stats(), { reads: 1, notes: 0, menus: 1, panels: 0 });
});

test("reopening highlights from library preserves an already open panel", async () => {
  const x = setup(); x.reader.panelOpen = "highlights";
  await x.library._openLibHighlights(x.file);
  assert.equal(x.stats().panels, 0);
});

test("a later book selection cancels pending library highlight opening", async () => {
  const x = setup();
  let finish;
  x.library.plugin.openFile = () => new Promise(resolve => { finish = resolve; });
  const pending = x.library._openLibHighlights(x.file);
  x.library._highlightOpenRequest = {};
  finish(x.reader);
  await pending;
  assert.equal(x.stats().panels, 0);
});


test("overlapping library refreshes render only the newest content", async () => {
  const x = setup(), library = x.library;
  library.containerEl = library.modalEl = library.contentEl = x.host;
  x.host.empty = () => x.host.replaceChildren();
  library._applyLibTheme = library._setupDropZone = () => {};
  library._buildLibSide = (side) => {
    side.createDiv("header");
    return { collapse: side.createEl("button"), tree: side.createDiv("tree") };
  };
  library._buildLibSearch = () => ({ input: x.host.createEl("input") });
  library._drawLibTree = () => {};
  library._selectLibNode = () => {};
  library._libVaultBooks = () => [];
  let emptyRenders = 0;
  library._buildLibEmpty = () => { emptyRenders++; };
  const ready = [];
  library.plugin.ensureStarterBooks = () => new Promise(resolve => ready.push(resolve));
  library.plugin.refreshProgress = async () => {};
  const first = library.onOpen();
  const second = library.onOpen();
  ready[1](); await second;
  ready[0](); await first;
  assert.equal(emptyRenders, 1);
  assert.equal(x.host.querySelectorAll(".header").length, 1);
});


test("library regenerates stale object-URL covers instead of hiding the title behind a blank image", async () => {
  const x = setup();
  x.library.plugin.thumbCache = { [x.file.path]: "blob:expired-window" };
  x.library.coverFromBookNote = () => null;
  x.library._scheduleThumbFlush = () => {};
  let generated = 0;
  x.library.makeEngineThumb = async () => { generated++; return "data:image/png;base64,new-cover"; };
  const shown = [];
  x.library.showImg = async (_cover, _placeholder, url) => { shown.push(url); return true; };
  await x.Library.prototype.loadThumb.call(x.library, x.file, {}, {});
  assert.equal(generated, 1);
  assert.deepEqual(shown, ["data:image/png;base64,new-cover"]);
  assert.equal(x.library.plugin.thumbCache[x.file.path], shown[0]);
});

// Builds the two panes (tree + local grid + online grid + search box) with the
// real renderers, so pane switching and stale-refresh can be exercised.
function openPanes(x, files) {
  const library = x.library;
  library.containerEl = library.modalEl = library.contentEl = x.host;
  library._applyLibTheme = () => {};
  library._setupDropZone = () => {};
  library.app = { vault: { getFiles: () => files, getAbstractFileByPath: () => null } };
  const side = x.host.createDiv("side");
  const tree = side.createDiv("tree");
  const grid = x.host.createDiv("grid");
  const onlineGrid = x.host.createDiv("online");
  onlineGrid.hidden = true;
  const input = x.host.createEl("input");
  const viewLabel = x.host.createDiv("label");
  const contentEl = x.host.createDiv("content");
  library._libTree = tree;
  library._libDeps = { contentEl, side, grid, onlineGrid, input, viewLabel, nodeEls: new Map() };
  library._drawLibTree(tree);
  library._runOnlineSearch = async () => {};
  return { tree, grid, onlineGrid, input };
}

test("the online search query never filters the local grid", () => {
  const x = setup();
  const { grid, input } = openPanes(x, [x.file]);
  const library = x.library;
  library._renderOnline = () => {};
  // Online pane with a query typed in, then switch back to a local node.
  library._libMode = "online";
  library._onlineQuery = "zzz";
  library._libQuery = "";
  input.value = "zzz";
  library._selectLibNode("all");
  assert.equal(input.value, "", "the local pane restores its own empty query");
  assert.equal(grid.querySelectorAll(".qiaomu-reader-lib-card").length, 1, "local books are still listed");
  assert.equal(grid.querySelector(".qiaomu-reader-lib-noresult"), null);
  // Switching back to the online pane restores the online query.
  library._selectLibNode("online");
  assert.equal(input.value, "zzz");
  assert.equal(library._libMode, "online");
});

test("a finished download refreshes the local tree and grid", () => {
  const x = setup();
  const { tree, grid } = openPanes(x, [x.file]);
  const library = x.library;
  library._libMode = "vault";
  library._selectLibNode("all");
  assert.equal(grid.querySelectorAll(".qiaomu-reader-lib-card").length, 1);
  // The download lands while the online pane is open.
  library._libMode = "online";
  const fresh = { path: "Books/新下载.epub", basename: "新下载", extension: "epub" };
  library.app.vault.getFiles = () => [x.file, fresh];
  library._markLibraryStale();
  assert.equal(library._libStale, true, "the local pane is marked stale while online");
  library._selectLibNode("all");
  assert.equal(grid.querySelectorAll(".qiaomu-reader-lib-card").length, 2, "the new book joins the grid");
  const allCount = tree.querySelector('[data-node="all"] .qiaomu-reader-lib-node-count');
  assert.equal(allCount?.textContent, "2", "the tree recount includes the new book");
});

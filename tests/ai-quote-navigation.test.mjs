import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { jumpToEngineHighlight } from "../packages/reader/src/highlight-navigation.js";

const source = fs.readFileSync(new URL("../packages/reader/src/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("async function jumpToAiQuote("), source.indexOf("\nfunction showLocationMarks"));
function setup() {
  const dom = new JSDOM('<input>');
  class TFile { constructor(path) { this.path = path; } }
  const file = new TFile("Books/Source.epub"), notices = [], jumps = [], revealed = [], saved = [];
  let hits = [{ cfi: "chapter-2-passage" }];
  const view = { file, _openingBook: false, _findInput: dom.window.document.querySelector("input"),
    engine: { async *search(query, options) { assert.equal(options.paint, false); assert.equal(options.limit, 2); yield* hits; }, goTo: async cfi => jumps.push(cfi) },
    closePanel() { this.panelOpen = null; }, togglePanel(name) { this.panelOpen = name; },
  };
  const leaf = { view };
  const plugin = { app: { vault: { getAbstractFileByPath: () => file }, workspace: {
    getLeavesOfType: () => [leaf], revealLeaf: async leaf => revealed.push(leaf),
  } }, openFile: async () => view, saveProgress: async (...args) => saved.push(args) };
  const jump = vm.runInNewContext(`${code};jumpToAiQuote`, {
    AbortController, TFile, VIEW_TYPE: "reader", window: dom.window,
    Notice: class { constructor(message) { notices.push(message); } }, qiaomuReaderTranslate: key => key,
    jumpToEngineHighlight, searchBookBlocks: () => [{ block: 3, offset: 25 }], readerSearchTexts: () => [],
    rememberReaderJump() {}, restoreReadingAnchor: () => [4, 10], markFoundIn() {},
  });
  return { view, file, plugin, jump, notices, jumps, revealed, saved, setHits: value => hits = value, close: () => dom.window.close() };
}

test("AI source citation navigates a loaded engine without a legacy pager and reveals its tab", async () => {
  const f = setup();
  f.plugin._openReaderModal = { file: { path: "Other.epub" } };
  await f.jump(f.plugin, f.file, "source quote");
  assert.deepEqual(f.jumps, ["chapter-2-passage"]); assert.equal(f.revealed.length, 1);
  assert.deepEqual(f.notices, []); f.close();
});

test("closed source book uses the returned reader, never the first unrelated tab", async () => {
  const f = setup(); let opened = 0;
  f.plugin.app.workspace.getLeavesOfType = () => [{ view: { file: { path: "Other.epub" } } }];
  f.plugin.openFile = async () => { opened++; return f.view; };
  await f.jump(f.plugin, f.file, "quote");
  assert.equal(opened, 1); assert.equal(f.jumps.length, 1); assert.equal(f.notices.length, 0); f.close();
});

for (const hits of [[], [{ cfi: "a" }, { cfi: "b" }]]) test(`ambiguous or absent quotes show search candidates (${hits.length} hits)`, async () => {
  const f = setup(); f.setHits(hits); f.view.panelOpen = "find";
  f.view.togglePanel = () => assert.fail("must not close the already open find panel");
  let inputs = 0; f.view._findInput.addEventListener("input", () => inputs++);
  await f.jump(f.plugin, f.file, "quote");
  assert.equal(f.view._findInput.value, "quote"); assert.equal(inputs, 1);
  assert.equal(f.jumps.length, 0); assert.match(f.notices[0], /no-unique/); f.close();
});

test("a superseded lookup or a switched book cannot jump to stale source", async () => {
  const f = setup(); let release;
  const blocked = new Promise(resolve => release = resolve);
  f.view.engine.search = async function* (query) { if (query === "old") await blocked; yield { cfi: query }; };
  const old = f.jump(f.plugin, f.file, "old");
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.jump(f.plugin, f.file, "new"); release(); await old;
  assert.deepEqual(f.jumps, ["new"]);
  f.view.engine.search = async function* () { f.view.file = { path: "Other.epub" }; yield { cfi: "wrong" }; };
  await f.jump(f.plugin, f.file, "switch");
  assert.deepEqual(f.jumps, ["new"]); assert.equal(f.notices.length, 0); f.close();
});

test("legacy PDF text navigation still updates and persists the correct page", async () => {
  const f = setup(); delete f.view.engine;
  f.view.pager = { flow: {}, currentPct: 0.2, currentBlockIndex: () => 3 };
  let updated; f.view.updateUI = (...args) => updated = args;
  await f.jump(f.plugin, f.file, "quote");
  assert.deepEqual(updated, [4, 10]); assert.deepEqual(f.saved, [[f.file.path, 4, 10, 3]]);
  assert.equal(f.notices.length, 0); f.close();
});

test("missing source produces a recoverable notice without opening a different book", async () => {
  const f = setup(); f.plugin.app.vault.getAbstractFileByPath = () => null;
  f.plugin.openFile = () => assert.fail("missing book");
  await f.jump(f.plugin, f.file, "quote");
  assert.match(f.notices[0], /cannot-locate/); f.close();
});

const engineSource = fs.readFileSync(new URL("../packages/reader/src/reader-engine.js", import.meta.url), "utf8");
const searchMethod = engineSource.slice(engineSource.indexOf("    async *search("), engineSource.indexOf("    async clearSearchHits("));
test("citation search is bounded, cancellable, and leaves existing search annotations alone", async () => {
  const visited = [], painted = [];
  const sections = [0, 1, 2, 3].map(index => ({ createDocument: async () => { visited.push(index); return index; } }));
  const Engine = vm.runInNewContext(`(class {
    #view; #book; #searchGeneration = 0; #searchHits = ['existing'];
    constructor(view, book) { this.#view = view; this.#book = book; }
    clearSearchHits() { throw Error('must not clear existing search'); }
    ${searchMethod}
  })`, { searchMatcher: () => function* (doc) { yield { range: doc, excerpt: { match: "quote" } }; }, textWalker: {}, SEARCH_PREFIX: "search:" });
  const engine = new Engine({ getCFI: index => `cfi-${index}`, addAnnotation: async x => painted.push(x) }, { sections });
  const hits = [];
  for await (const hit of engine.search("quote", { paint: false, limit: 2 })) hits.push(hit);
  assert.equal(hits.length, 2); assert.deepEqual(visited, [0, 1]); assert.deepEqual(painted, []);
  const controller = new AbortController(); controller.abort();
  for await (const hit of engine.search("quote", { paint: false, signal: controller.signal })) assert.fail(hit.cfi);
  assert.deepEqual(visited, [0, 1]);
});

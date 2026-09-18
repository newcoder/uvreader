import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { addMissingQuoteLinks, highlightBacklink, jumpToEngineHighlight } from "../packages/reader/src/highlight-navigation.js";

const pluginSource = fs.readFileSync(new URL("../packages/reader/src/plugin.js", import.meta.url), "utf8");

const cfi = "epubcfi(/6/30!/4/26,/1:351,/1:357)";

test("CFI backlinks round-trip vault, paths and ranges without breaking Markdown", () => {
  const vault = "中文 Library & # +";
  const book = "书籍/三国 (演义) & # +.mobi";
  const uri = highlightBacklink(vault, book, { id: "mark-1", cfi });
  assert.doesNotMatch(uri, /[ ()]/);
  const parsed = new URL(uri);
  assert.equal(parsed.hostname, "qiaomu-reader");
  assert.equal(parsed.searchParams.get("vault"), vault);
  assert.equal(parsed.searchParams.get("book"), book);
  assert.equal(parsed.searchParams.get("cfi"), cfi);
  assert.equal(parsed.searchParams.get("highlight"), "mark-1");
  assert.equal(parsed.searchParams.has("block"), false);
});

test("legacy block zero and PDF page backlinks keep format-specific anchors", () => {
  assert.equal(new URL(highlightBacklink("V", "a.epub", { block: 0 })).searchParams.get("block"), "0");
  assert.equal(new URL(highlightBacklink("V", "a.pdf", { page: 12 })).searchParams.get("page"), "12");
  assert.equal(highlightBacklink("V", "a.mobi", { text: "missing anchor" }), "");
});

test("engine highlight jumps use CFI and repaint before dismissing the panel", async () => {
  const calls = [];
  const view = { engine: { goTo: async (value) => calls.push(value), addHighlight: async (...args) => calls.push(args) }, closePanel: () => calls.push("close") };
  await jumpToEngineHighlight(view, { id: "h1", cfi, color: "green" });
  assert.deepEqual(calls, [cfi, ["h1", cfi, "green"], "close"]);
  await assert.rejects(jumpToEngineHighlight(view, {}));
  view.engine.goTo = async () => { throw new Error("bad CFI"); };
  await assert.rejects(jumpToEngineHighlight(view, { cfi }), /bad CFI/);
});

test("a late highlight jump does not change the next book's panel", async () => {
  let finish, closed = false;
  const view = { engine: { goTo: () => new Promise((resolve) => { finish = resolve; }) }, closePanel: () => { closed = true; } };
  const pending = jumpToEngineHighlight(view, { cfi });
  view.engine = {};
  finish();
  await pending;
  assert.equal(closed, false);
});

test("existing notes get only missing exact quote links, preserving manual edits and CRLF", () => {
  const quote = '> <mark style="background:#abc">原文</mark>';
  const uri = highlightBacklink("V", "a.mobi", { cfi });
  const before = `# 笔记\r\n${quote}\r\n\r\n我的批注\r\n> 修改过的原文\r\n`;
  const entries = [{ quote, uri }];
  const after = addMissingQuoteLinks(before, entries);
  assert.equal(after, before.replace(quote, `${quote} [↩](${uri})`));
  assert.equal(addMissingQuoteLinks(after, entries), after);
  assert.equal(addMissingQuoteLinks(before, [...entries, { quote, uri: uri + "2" }]), before);
});

test("protocol dispatch waits for its opened view and keeps CFI ahead of legacy page fields", async () => {
  const source = fs.readFileSync(new URL("../packages/reader/src/wire.js", import.meta.url), "utf8");
const pluginSource = fs.readFileSync(new URL("../packages/reader/src/plugin.js", import.meta.url), "utf8");
  const code = pluginSource.slice(pluginSource.indexOf("  async openBookAt("), pluginSource.indexOf("  _dataFolder()"));
  class TFile { constructor(path) { this.path = path; } }
  const file = new TFile("书籍/a.mobi");
  const calls = [];
  const openBookAt = vm.runInNewContext(`({${code}}).openBookAt`, {
    TFile, qiaomuReaderPath: (s) => s, qiaomuReaderTranslate: (s) => s,
    Notice: class { constructor(s) { throw new Error(s); } }, console,
    window: { setTimeout }, rememberReaderJump: () => {}, jumpToEngineHighlight,
  });
  const view = { file, engine: { currentLocation: () => ({ cfi }), goTo: async (value) => calls.push(value) },
    goToHighlight: async (id) => calls.push(id), jumpToBlockWhenReady: (n) => calls.push(n), jumpToPdfPageWhenReady: (n) => calls.push(`page:${n}`) };
  const plugin = { app: { vault: { getAbstractFileByPath: () => file } }, openFile: async () => view, getHighlights: () => [{ id: "h1", cfi }] };
  await openBookAt.call(plugin, file.path, undefined, undefined, "h1", cfi);
  assert.deepEqual(calls, ["h1"]);
  await openBookAt.call(plugin, file.path, undefined, undefined, "deleted", cfi);
  assert.equal(calls[1], cfi);
  await assert.rejects(openBookAt.call(plugin, file.path, "0"), /highlight-not-found/);
  assert.equal(calls.length, 2, "ebook block links must not use PDF navigation");
  view.engine = null; view.pager = { total: 12 };
  await openBookAt.call(plugin, file.path, "0");
  assert.equal(calls[2], 0);
  await openBookAt.call(plugin, file.path, undefined, "12");
  assert.equal(calls[3], "page:12");
});

test("new and existing note protocols dispatch to the same book location", async () => {
  const source = fs.readFileSync(new URL("../packages/reader/src/wire.js", import.meta.url), "utf8");
  const code = pluginSource.slice(pluginSource.indexOf("  _registerBookProtocol() {"), pluginSource.indexOf("  _registerReaderExtensions() {"));
  const register = vm.runInNewContext(`({${code}})._registerBookProtocol`);
  const handlers = new Map();
  const calls = [];
  register.call({ registerObsidianProtocolHandler: (name, handler) => handlers.set(name, handler), openBookAt: (...args) => calls.push(args) });
  for (const scheme of ["qiaomu-reader", "qiaomu-book-reader"]) {
    assert.equal(typeof handlers.get(scheme), "function");
    handlers.get(scheme)({ book: "书籍/a.mobi", highlight: "h1", cfi });
  }
  assert.deepEqual(calls, [["书籍/a.mobi", undefined, undefined, "h1", cfi], ["书籍/a.mobi", undefined, undefined, "h1", cfi]]);
});

test("reading-note paths resolve settings from the new plugin identity", () => {
  const source = fs.readFileSync(new URL("../packages/reader/src/note-paths.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function _readerSettings(app)"), source.indexOf("function inboxNotePath("));
  const resolve = vm.runInNewContext(`(()=>{${code};return bookNotesFolderPath})()`, { path: (s) => s, qiaomuReaderPath: (s) => s });
  const app = { plugins: { plugins: { "qiaomu-reader": { settings: { bookNotesFolder: "阅读笔记" } }, "qiaomu-book-reader": { settings: { bookNotesFolder: "旧路径" } } } } };
  assert.equal(resolve(app), "阅读笔记");
});

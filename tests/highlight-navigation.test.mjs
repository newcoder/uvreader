import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { jumpToEngineHighlight } from "../packages/reader/src/highlight-navigation.js";

const cfi = "epubcfi(/6/30!/4/26,/1:351,/1:357)";

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

test("reading-note paths resolve settings from the new plugin identity", () => {
  const source = fs.readFileSync(new URL("../packages/reader/src/note-paths.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function _readerSettings(app)"), source.indexOf("function inboxNotePath("));
  const resolve = vm.runInNewContext(`(()=>{${code};return bookNotesFolderPath})()`, { path: (s) => s, qiaomuReaderPath: (s) => s });
  const app = { plugins: { plugins: { "qiaomu-reader": { settings: { bookNotesFolder: "阅读笔记" } }, "qiaomu-book-reader": { settings: { bookNotesFolder: "旧路径" } } } } };
  assert.equal(resolve(app), "阅读笔记");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";

// NoteView lives in the renderer module (it imports obsidian), so evaluate just
// the factory with a tiny ItemView stub. This keeps the state/render ordering
// testable without booting Electron.
const source = fs.readFileSync(new URL("../src/renderer/views.js", import.meta.url), "utf8");
const start = source.indexOf("export function createNoteView(");
const end = source.indexOf("function jumpToTocItem(");
const factory = source.slice(start, end).replace("export function", "function");

function dom() {
  const { window } = new JSDOM("<main></main>");
  const proto = window.HTMLElement.prototype;
  proto.createEl = function createEl(tag, opts = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (typeof opts === "string") el.className = opts;
    else {
      el.className = opts.cls || "";
      el.textContent = opts.text || "";
    }
    this.append(el);
    return el;
  };
  proto.createDiv = function createDiv(opts) { return this.createEl("div", opts); };
  proto.createSpan = function createSpan(opts) { return this.createEl("span", opts); };
  proto.addClass = function addClass(...names) { this.classList.add(...names); };
  proto.setText = function setText(text) { this.textContent = text; };
  proto.empty = function empty() { this.replaceChildren(); };
  return window;
}

test("a note panel renders the file when its state arrives and on every reopen", async () => {
  const window = dom();
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.contentEl = window.document.createElement("main");
    }
  }
  const files = {
    "notes/a.md": { path: "notes/a.md", basename: "a", extension: "md" },
    "notes/b.md": { path: "notes/b.md", basename: "b", extension: "md" },
  };
  const texts = { "notes/a.md": "正文 a", "notes/b.md": "正文 b" };
  const app = {
    vault: {
      getAbstractFileByPath: (path) => files[path] || null,
      read: async (file) => texts[file.path],
      modify: async (file, value) => { texts[file.path] = value; },
    },
  };
  const { createNoteView } = vm.runInNewContext(`${factory}\n({ createNoteView })`, { ItemView, setTimeout, clearTimeout });
  const view = createNoteView({}, { app, renderMarkdown: (text) => `<p>${text}</p>` });
  await view.setState({ path: "notes/a.md" });
  assert.match(view.contentEl.textContent, /正文 a/);
  assert.doesNotMatch(view.contentEl.textContent, /还没有阅读笔记/);
  await view.setState({ path: "notes/b.md" });
  assert.match(view.contentEl.textContent, /正文 b/);
});

test("the note editor saves and returns to a fresh preview", async () => {
  const window = dom();
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.contentEl = window.document.createElement("main");
    }
  }
  const file = { path: "notes/a.md", basename: "a", extension: "md" };
  const texts = { "notes/a.md": "第一行" };
  const app = {
    vault: {
      getAbstractFileByPath: (path) => (path === file.path ? file : null),
      read: async () => texts[file.path],
      modify: async (_file, value) => { texts[file.path] = value; },
    },
  };
  const { createNoteView } = vm.runInNewContext(`${factory}\n({ createNoteView })`, { ItemView, setTimeout, clearTimeout });
  const view = createNoteView({}, { app, renderMarkdown: (text) => `<p>${text}</p>`, leaf: { detach() {} } });
  view.leaf = { detach() {} };
  await view.setState({ path: file.path });
  const button = (label) => [...view.contentEl.querySelectorAll("button")].find((item) => item.textContent === label);
  button("编辑").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const editor = view.contentEl.querySelector(".qbr-note-editor");
  assert.ok(editor, "the editor should be visible");
  editor.value = "第二行";
  editor.dispatchEvent(new window.Event("input"));
  assert.match(view.contentEl.textContent, /未保存/);
  await view._flushSave();
  assert.equal(texts[file.path], "第二行");
  button("预览").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.contentEl.textContent, /第二行/);
  assert.equal(view.contentEl.querySelector(".qbr-note-editor"), null);
});

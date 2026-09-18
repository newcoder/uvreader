import assert from "node:assert/strict";
import test from "node:test";

import { createNotePaths } from "../packages/reader/src/note-paths.js";
import { createBookNotes } from "../packages/reader/src/book-notes.js";

const translate = (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key);
const normalize = (p) => String(p == null ? "" : p).trim()
  .replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");

class TFile {
  constructor(path) { this.path = path; this.basename = path.split("/").at(-1).replace(/\.md$/, ""); this.extension = "md"; }
}
class TFolder {
  constructor(path) { this.path = path; }
}

function setup(overrides = {}) {
  const paths = createNotePaths({
    translate, path: normalize, TFile, TFolder,
    AbstractInputSuggest: class {}, FuzzySuggestModal: class {}, Setting: class {},
    window: { setTimeout: (fn) => fn() }, getCreateFolderModal: () => class {},
  });
  const notes = createBookNotes({
    translate,
    path: normalize,
    Notice: class { constructor(message) { this.message = message; } },
    TFile,
    getHlColors: () => [
      { id: "yellow", css: "#ff0" },
      { id: "green", css: "#0f0" },
    ],
    normalizeAiTurnContext: (value) => (value?.text ? value : null),
    readerSettings: paths._readerSettings,
    getWhatsNew: () => [{ v: "1.1.0", items: ["a"] }, { v: "1.0.0", items: ["b"] }],
    noteTemplatePath: paths.noteTemplatePath,
    bookNotesFolderPath: paths.bookNotesFolderPath,
    notesFolderPath: paths.notesFolderPath,
    inboxNotePath: paths.inboxNotePath,
    resolveNotesFolder: paths.resolveNotesFolder,
    resolveBookNote: paths.resolveBookNote,
    bookNoteLinkFor: paths.bookNoteLinkFor,
    sanitizeNoteTitle: paths.sanitizeNoteTitle,
    suggestNoteTitle: paths.suggestNoteTitle,
    isUnsafeReadingNote: paths.isUnsafeReadingNote,
    flattenSelectionText: paths.flattenSelectionText,
    processTemplateManually: paths.processTemplateManually,
    getNoteTitleModal: () => class {},
    getConfirmModal: () => class Confirm { constructor(app, opts) { this.opts = opts; } open() { this.opened = true; } },
    getHighlightExportModal: () => class {},
    ...overrides,
  });
  return { paths, notes };
}

test("bookNoteAction decides between linked, auto, ask and prompted", () => {
  const { notes } = setup();
  assert.equal(notes.bookNoteAction({ bookNoteLinks: { "a.epub": "Note" } }, "a.epub"), "linked");
  assert.equal(notes.bookNoteAction({ autoBookNote: true }, "a.epub"), "auto");
  assert.equal(notes.bookNoteAction({ autoBookNote: true, bookNotePrompted: { "a.epub": true } }, "a.epub"), "prompted");
  assert.equal(notes.bookNoteAction({}, "a.epub"), "ask");
  assert.equal(notes.bookNoteAction({}, ""), "prompted");
});

test("hlMark colors the quote and respects the export setting", () => {
  const { notes } = setup();
  const app = { plugins: { plugins: { "qiaomu-reader": { settings: { exportColors: true } } } } };
  assert.equal(notes.hlMark(app, "a & b", "yellow"), '<mark style="background:#ff0">a &amp; b</mark>');
  assert.equal(notes.hlMark(app, "plain", "missing"), "plain");
  const muted = { plugins: { plugins: { "qiaomu-reader": { settings: { exportColors: false } } } } };
  assert.equal(notes.hlMark(muted, "plain", "yellow"), "plain");
});

test("highlight dedupe normalizes markdown and quotes", () => {
  const { notes } = setup();
  assert.equal(notes.normalizeHlText("> **Hello** ==world=="), "**hello** world");
  const result = notes.splitExportedHighlights("> Hello world", [{ text: "Hello world" }, { text: "Fresh quote" }]);
  assert.deepEqual(result.already.map((h) => h.text), ["Hello world"]);
  assert.deepEqual(result.fresh.map((h) => h.text), ["Fresh quote"]);
});

test("quoteMarkdown fills the template with book, page, backlink and comment", () => {
  const { notes } = setup();
  const plugin = {
    app: { vault: { getName: () => "Vault" } },
    settings: { quoteTemplate: "> {text}{link}{page}\n— [[{book}]]", quoteBacklinks: true },
  };
  const out = notes.quoteMarkdown(plugin, { text: "quoted text", page: "12", comment: "my note", cfi: "cfi-1" }, { path: "Books/a.epub", basename: "a" });
  assert.match(out, /quoted text/);
  assert.match(out, /— \[\[a\]\]/);
  assert.match(out, /p-0-2:12/);
  assert.match(out, /comment-on-a-highlight/);
  assert.equal(notes.hlCommentMd({ comment: "line1\nline2" }), "\n\n**comment-on-a-highlight：** line1\n\nline2");
  assert.equal(notes.hlCommentMd({}), "");
});

test("renderManagedReadingHighlights sorts and labels the quotes section", () => {
  const { notes } = setup();
  const plugin = {
    app: { vault: { getName: () => "Vault" } },
    settings: { quoteBacklinks: false },
  };
  const out = notes.renderManagedReadingHighlights(plugin, { path: "a.epub" }, [
    { text: "second", block: 5, chapter: "Ch 2" },
    { text: "first", block: 1 },
  ]);
  assert.match(out, /^quotes/);
  assert.ok(out.indexOf("first") < out.indexOf("second"));
  assert.match(out, /\*\*Ch 2\*\*/);
});

test("composeExcerptQuote handles selections and AI answers", () => {
  const { notes } = setup();
  const app = { plugins: { plugins: { "qiaomu-reader": { settings: { exportColors: true } } } } };
  const selection = notes.composeExcerptQuote(app, { color: "yellow", extra: "\n\nnote" }, "line one\nline two", "\n\nfrom book", "");
  assert.match(selection, /<mark style="background:#ff0">line one\n&gt; line two<\/mark>/);
  const answer = notes.composeExcerptQuote(app, { noteKind: "ai-answer", noteBody: "The answer", sourceText: "The source" }, "ignored", "from book", "");
  assert.match(answer, /The answer/);
  assert.match(answer, /The source/);
});

test("cmpVer and whatsNewSince compare dotted versions", () => {
  const { notes } = setup();
  assert.equal(notes.cmpVer("1.2.0", "1.1.9"), 1);
  assert.equal(notes.cmpVer("1.1", "1.1.0"), 0);
  assert.equal(notes.cmpVer("0.9", "1.0"), -1);
  assert.deepEqual(notes.whatsNewSince("1.0.0", "1.1.0").map((r) => r.v), ["1.1.0"]);
});

test("collectHighlightGroups groups by chapter and keeps order", () => {
  const { notes } = setup();
  const app = { vault: { getName: () => "Vault" } };
  const plugin = { settings: { quoteBacklinks: false } };
  const groups = notes.collectHighlightGroups(app, plugin, { path: "a.epub" }, [
    { text: "one", chapter: "Ch 1" },
    { text: "two", chapter: "Ch 1" },
    { text: "three" },
    { text: "" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].chapter, "Ch 1");
  assert.equal(groups[0].lines.length, 2);
  assert.equal(groups[1].lines.length, 1);
});

test("firstFreeNoteName avoids existing files and reserved names", () => {
  const { notes } = setup();
  const existing = new Set(["Title.md", "Title 2.md"]);
  const app = { vault: { getAbstractFileByPath: (p) => existing.has(p) ? new TFile(p) : null } };
  const reserved = new Set();
  assert.equal(notes.firstFreeNoteName(app, "Title", null, reserved), "Title 3");
  assert.equal(reserved.has("Title 3"), true);
  assert.equal(notes.tagPrefix(["a", "b"]), "#a #b\n\n");
  assert.equal(notes.tagPrefix([]), "");
});

test("writeNoteText prefers process() and falls back to modify", async () => {
  const { notes } = setup();
  const processed = [];
  const app = { vault: {
    process: async (file, reshape) => { processed.push(reshape("old")); },
    modify: async () => { throw new Error("must not modify"); },
    read: async () => "old",
  } };
  await notes.writeNoteText(app, { path: "a.md" }, (data) => `${data}+new`);
  assert.deepEqual(processed, ["old+new"]);
  const legacy = { vault: {
    modify: async (file, data) => { legacy.written = data; },
    read: async () => "base",
  } };
  await notes.writeNoteText(legacy, { path: "a.md" }, (data) => `${data}+x`);
  assert.equal(legacy.written, "base+x");
});

test("dropBookState forgets every path-keyed store", async () => {
  const { notes } = setup();
  let saves = 0;
  const plugin = {
    progress: { "a.epub": 1 },
    progressBackups: { "a.epub": 1 },
    highlights: { "a.epub": [] },
    settings: { coverFits: { "a.epub": "cover" } },
    saveAll: async () => { saves += 1; },
  };
  await notes.dropBookState(plugin, "a.epub");
  assert.deepEqual(plugin.progress, {});
  assert.deepEqual(plugin.highlights, {});
  assert.deepEqual(plugin.settings.coverFits, {});
  assert.equal(saves, 1);
});

test("deleteBookFromVault confirms, trashes and drops state", async () => {
  const { notes } = setup();
  const notices = [];
  const app = { fileManager: { trashFile: async () => {} } };
  const plugin = { progress: { "a.epub": 1 }, saveAll: async () => {} };
  let done = 0;
  notes.deleteBookFromVault(app, plugin, { path: "a.epub", basename: "a" }, () => { done += 1; });
  const modal = notes.deleteBookFromVault(app, plugin, { path: "b.epub", basename: "b" });
  assert.equal(modal, undefined);
  assert.equal(done, 0, "the wipe waits for confirmation");
  assert.equal(notices.length, 0);
});

test("_escHtml escapes markup", () => {
  const { notes } = setup();
  assert.equal(notes._escHtml("<a & b>"), "&lt;a &amp; b&gt;");
});

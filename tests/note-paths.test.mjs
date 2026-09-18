import assert from "node:assert/strict";
import test from "node:test";

import { createNotePaths } from "../packages/reader/src/note-paths.js";

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
  return createNotePaths({
    translate,
    path: normalize,
    TFile,
    TFolder,
    AbstractInputSuggest: class {},
    FuzzySuggestModal: class {},
    Setting: class {},
    window: { setTimeout: (fn) => fn() },
    getCreateFolderModal: () => class {},
    ...overrides,
  });
}

test("sanitizeNoteTitle strips illegal characters, reserved names and empties", () => {
  const paths = setup();
  assert.equal(paths.sanitizeNoteTitle('a/b\\c:d*e?f"g<h>i|j#k^[l]'), "abcdefghijkl");
  assert.equal(paths.sanitizeNoteTitle("  spaced   out  "), "spaced out");
  assert.equal(paths.sanitizeNoteTitle("CON"), "_CON");
  assert.equal(paths.sanitizeNoteTitle("com1"), "_com1");
  assert.equal(paths.sanitizeNoteTitle(""), "note");
  assert.equal(paths.sanitizeNoteTitle("...."), "note");
  assert.equal(paths.sanitizeNoteTitle("abcdef", 3), "abc");
});

test("suggestNoteTitle prefers a full sentence and trims dangling words", () => {
  const paths = setup();
  assert.equal(paths.suggestNoteTitle("A short title."), "A short title");
  const long = paths.suggestNoteTitle("This is a sentence that ends properly. Then more text follows here.");
  assert.equal(long, "This is a sentence that ends properly");
  const noSentence = paths.suggestNoteTitle("word ".repeat(30), 20);
  assert.ok(noSentence.length <= 20);
  assert.equal(paths.suggestNoteTitle("   "), "");
});

test("parseNoteTags splits inline tags and normalizes spaces", () => {
  const paths = setup();
  assert.deepEqual(paths.parseNoteTags("#one #two, three; four\none"), ["one", "two", "three", "four"]);
  assert.deepEqual(paths.parseNoteTags("multi word tag"), ["multi-word-tag"]);
});

test("processTemplateManually replaces Templater placeholders and strips the rest", () => {
  const paths = setup();
  const out = paths.processTemplateManually(
    "title=<% tp.file.title %> date=<% tp.date.now() %> cursor=<% tp.file.cursor(1) %> other=<% whatever %>",
    "My Title",
  );
  assert.match(out, /title=My Title/);
  assert.match(out, /date=\d{4}-\d{2}-\d{2}/);
  assert.equal(out.includes("cursor="), true);
  assert.equal(out.includes("whatever"), false);
});

test("isMarkedReadingNote only trusts explicit book-reader notes", () => {
  const paths = setup();
  const makeApp = (frontmatter) => ({
    metadataCache: { getFileCache: () => ({ frontmatter }) },
  });
  const note = new TFile("Books/笔记.md");
  assert.equal(paths.isMarkedReadingNote(makeApp({ type: "person", book: "[[a.epub]]" }), note), false);
  assert.equal(paths.isMarkedReadingNote(makeApp({ book: "[[a.epub]]" }), note), false);
  assert.equal(paths.isMarkedReadingNote(makeApp({ type: "reading-note" }), note), true);
  assert.equal(paths.isMarkedReadingNote(makeApp({ "book-reader-note": true }), note), true);
  const template = new TFile("Templates/笔记.md");
  assert.equal(paths.isMarkedReadingNote(makeApp({ "book-reader-note": true }), template), false);
});

test("bookNoteFromFrontmatter finds the note linked to the book", () => {
  const paths = setup();
  const book = { path: "Books/a.epub", basename: "a" };
  const marked = new TFile("Notes/a.md");
  const other = new TFile("Notes/b.md");
  const app = {
    vault: { getMarkdownFiles: () => [other, marked] },
    metadataCache: {
      getFileCache: (file) => file === marked
        ? { frontmatter: { "book-reader-note": true, book: "[[Books/a.epub]]" } }
        : { frontmatter: { book: "[[Books/a.epub]]" } },
    },
  };
  const plugin = { app, settings: { bookNoteLinks: {} } };
  assert.equal(paths.bookNoteFromFrontmatter(plugin, book), "a");
  assert.equal(paths.bookNoteLinkFor(plugin, book), "a");
  plugin.settings.bookNoteLinks[book.path] = "Custom/Note";
  assert.equal(paths.bookNoteLinkFor(plugin, book), "Custom/Note");
});

test("writeBookProperty marks the resolved note explicitly", async () => {
  const paths = setup();
  const note = new TFile("Notes/a.md");
  let written = null;
  const app = {
    vault: { getAbstractFileByPath: () => note, getMarkdownFiles: () => [note] },
    fileManager: { processFrontMatter: async (file, mutate) => { const fm = {}; mutate(fm); written = fm; } },
  };
  await paths.writeBookProperty(app, "Notes/a.md", { path: "Books/a.epub" });
  assert.deepEqual(written, { book: "[[Books/a.epub]]", type: "reading-note", "book-reader-note": true });
});

test("allVaultTags sorts by usage and flattens selection text", () => {
  const paths = setup();
  const app = { metadataCache: { getTags: () => ({ "#a": 1, "#b": 3, "#c": 2 }) } };
  assert.deepEqual(paths.allVaultTags(app), ["b", "c", "a"]);
  assert.deepEqual(paths.allVaultTags({ metadataCache: {} }), []);
  assert.equal(paths.flattenSelectionText("one \t two\n three "), "one two three");
});

test("note path helpers compose paths from settings", () => {
  const paths = setup();
  const app = { plugins: { plugins: { "qiaomu-reader": { settings: {
    noteTemplate: "Templates/excerpt",
    bookNoteTemplate: "Templates/book",
    notesFolder: "Notes",
    bookNotesFolder: "Notes/Books",
    bookTemplates: { "Books/a.epub": "Templates/a" },
  } } } } };
  assert.equal(paths.noteTemplatePath(app, { path: "Books/a.epub" }), "Templates/a");
  assert.equal(paths.noteTemplatePath(app, { path: "Books/b.epub" }), "Templates/excerpt");
  assert.equal(paths.bookNoteTemplatePath(app), "Templates/book");
  assert.equal(paths.notesFolderPath(app), "Notes");
  assert.equal(paths.bookNotesFolderPath(app), "Notes/Books");
  assert.equal(paths.inboxNotePath(app, "My Note"), "Notes/My Note.md");
  assert.equal(paths.inboxNotePath(app, "My Note", "Other"), "Other/My Note.md");
  assert.equal(paths._readerSettings(app).notesFolder, "Notes");
});

import assert from "node:assert/strict";
import test from "node:test";

import { createLibraryData, IMPORT_MIME_EXT } from "../packages/reader/src/library-data.js";

const normalize = (p) => String(p == null ? "" : p).trim()
  .replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
const translate = (key, ...args) => (args.length ? `${key}:${args.join(",")}` : key);
const data = createLibraryData({ translate, path: normalize });

const book = (path) => ({ path, basename: path.split("/").pop() });

test("bookRelFolder and bookCategoryOf normalize paths against the library root", () => {
  assert.equal(data.bookRelFolder("Books/Fiction/a.epub", "Books"), "Fiction");
  assert.equal(data.bookRelFolder("Books/Fiction/Sub/a.epub", "Books"), "Fiction/Sub");
  assert.equal(data.bookRelFolder("Books/a.epub", "Books"), "");
  assert.equal(data.bookRelFolder("Other/a.epub", "Books"), "Other");
  assert.equal(data.bookRelFolder("Books\\Fiction\\a.epub", "Books"), "Fiction");
  assert.equal(data.bookCategoryOf("Books/Fiction/Sub/a.epub", "Books"), "Fiction");
  assert.equal(data.bookCategoryOf("Books/a.epub", "Books"), "");
});

test("bookStatusOf maps progress onto new/reading/done", () => {
  assert.equal(data.bookStatusOf(null), "new");
  assert.equal(data.bookStatusOf({ lastRead: 1 }), "new");
  assert.equal(data.bookStatusOf({ lastRead: 1, percent: 42 }), "reading");
  assert.equal(data.bookStatusOf({ lastRead: 1, percent: 98 }), "done");
  assert.equal(data.bookStatusOf({ lastRead: 1, percent: 100 }), "done");
});

test("buildLibChips tallies statuses, tags and folders in display order", () => {
  const files = [
    book("Books/root.epub"),
    book("Books/Fiction/a.epub"),
    book("Books/Fiction/b.epub"),
    book("Books/SciFi/c.epub"),
  ];
  const progress = {
    "Books/root.epub": { lastRead: 1, percent: 100 },
    "Books/Fiction/a.epub": { lastRead: 1, percent: 20 },
    "Books/Fiction/b.epub": { lastRead: 1, percent: 10 },
  };
  const tags = { "Books/Fiction/a.epub": ["classic"], "Books/SciFi/c.epub": ["space"] };
  const chips = data.buildLibChips(files, "Books", (p) => progress[p], (p) => tags[p] || [], "all");
  assert.deepEqual(chips, [
    { id: "all", label: "all", count: 4 },
    { id: "status:reading", label: "reading-2", count: 2 },
    { id: "status:new", label: "not-started", count: 1 },
    { id: "status:done", label: "finished", count: 1 },
    { id: "tag:classic", label: "classic", count: 1 },
    { id: "tag:space", label: "space", count: 1 },
    { id: "folder:Fiction", label: "Fiction", count: 2 },
    { id: "folder:SciFi", label: "SciFi", count: 1 },
    { id: "folder:", label: "no-folder", count: 1 },
  ]);
});

test("an open folder chip expands its subfolders", () => {
  const files = [
    book("Books/Fiction/a.epub"),
    book("Books/Fiction/Sub/b.epub"),
    book("Books/Fiction/Sub2/c.epub"),
    book("Books/SciFi/d.epub"),
  ];
  const chips = data.buildLibChips(files, "Books", () => null, () => [], "folder:Fiction");
  assert.deepEqual(chips.filter((c) => c.id.startsWith("folder:")), [
    { id: "folder:Fiction", label: "Fiction", count: 3 },
    { id: "folder:Fiction/Sub", label: "└ Sub", count: 1, sub: true },
    { id: "folder:Fiction/Sub2", label: "└ Sub2", count: 1, sub: true },
    { id: "folder:SciFi", label: "SciFi", count: 1 },
  ]);
});

test("libChipMatches handles status, folder and tag chips", () => {
  const f = book("Books/Fiction/Sub/a.epub");
  const progress = { "Books/Fiction/Sub/a.epub": { lastRead: 1, percent: 50 } };
  const tags = { "Books/Fiction/Sub/a.epub": ["classic"] };
  const getProgress = (p) => progress[p];
  const getTags = (p) => tags[p] || [];
  assert.equal(data.libChipMatches("status:reading", f, "Books", getProgress, getTags), true);
  assert.equal(data.libChipMatches("status:done", f, "Books", getProgress, getTags), false);
  assert.equal(data.libChipMatches("folder:Fiction", f, "Books", getProgress, getTags), true);
  assert.equal(data.libChipMatches("folder:Fiction/Sub", f, "Books", getProgress, getTags), true);
  assert.equal(data.libChipMatches("folder:SciFi", f, "Books", getProgress, getTags), false);
  assert.equal(data.libChipMatches("tag:classic", f, "Books", getProgress, getTags), true);
  assert.equal(data.libChipMatches("tag:space", f, "Books", getProgress, getTags), false);
  assert.equal(data.libChipMatches("all", f, "Books", getProgress, getTags), true);
  assert.equal(data.libChipMatches("", f, "Books", getProgress, getTags), true);
});

test("filterLibBooks combines the search query with the active chip", () => {
  const files = [book("Books/Fiction/Alpha.epub"), book("Books/Fiction/Beta.epub"), book("Books/SciFi/Alpha Two.epub")];
  const progress = { "Books/Fiction/Alpha.epub": { lastRead: 1, percent: 50 } };
  const getProgress = (p) => progress[p];
  const getTags = () => [];
  assert.deepEqual(
    data.filterLibBooks(files, "all", "", "Books", getProgress, getTags).map((f) => f.path),
    files.map((f) => f.path),
  );
  assert.deepEqual(
    data.filterLibBooks(files, "all", "alpha", "Books", getProgress, getTags).map((f) => f.basename),
    ["Alpha.epub", "Alpha Two.epub"],
  );
  assert.deepEqual(
    data.filterLibBooks(files, "folder:Fiction", "alpha", "Books", getProgress, getTags).map((f) => f.basename),
    ["Alpha.epub"],
  );
  assert.deepEqual(
    data.filterLibBooks(files, "status:reading", "", "Books", getProgress, getTags).map((f) => f.basename),
    ["Alpha.epub"],
  );
});

test("tag helpers parse, dedupe and sort", () => {
  assert.deepEqual(data.parseBookTags(" #a, b; a\nc "), ["a", "b", "c"]);
  assert.deepEqual(data.parseBookTags(""), []);
  assert.deepEqual(data.bookTagsOf({ bookTags: { "a.epub": ["x", "", "y"] } }, "a.epub"), ["x", "y"]);
  assert.deepEqual(data.bookTagsOf({}, "a.epub"), []);
  assert.deepEqual(data.allBookTags({ bookTags: { "a.epub": ["z", "a"], "b.epub": ["a"] } }), ["a", "z"]);
  assert.deepEqual(data.allBookTags(null), []);
});

test("IMPORT_MIME_EXT maps the importable MIME types", () => {
  assert.equal(IMPORT_MIME_EXT.get("application/pdf"), "pdf");
  assert.equal(IMPORT_MIME_EXT.get("application/epub+zip"), "epub");
  assert.equal(IMPORT_MIME_EXT.has("text/plain"), false);
});

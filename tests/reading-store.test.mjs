import assert from "node:assert/strict";
import test from "node:test";

import {
  createReadingStore,
  readingBookPaths,
  sanitizeReadingFolder,
} from "../packages/reader/src/reading-store.js";

// Minimal in-memory stand-in for the vault adapter the reader writes through.
// Directories are tracked like the Obsidian adapter: a file write implies its
// parents exist, and mkdir records them.
export function memoryAdapter(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const parentsOf = (path) => {
    const parts = String(path).split("/");
    return parts.slice(1, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  };
  const addParents = (path) => { for (const dir of parentsOf(path)) dirs.add(dir); };
  return {
    files,
    dirs,
    async exists(path) { return files.has(path) || dirs.has(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    async mkdir(dir) { dirs.add(String(dir)); addParents(dir); },
    async write(path, data) { addParents(path); files.set(path, String(data)); },
    async process(path, fn, options = {}) {
      const current = files.get(path) ?? options.initial ?? "";
      const next = await fn(current);
      if (next === undefined) return current;
      files.set(path, String(next));
      return next;
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

test("book folder names are readable and filesystem safe", () => {
  assert.equal(sanitizeReadingFolder("量子力学的数学基础"), "量子力学的数学基础");
  assert.equal(sanitizeReadingFolder("  A/B: C?  "), "A B C");
  assert.equal(sanitizeReadingFolder("trailing dots..."), "trailing dots");
  assert.equal(sanitizeReadingFolder("con"), "con (book)");
  assert.equal(sanitizeReadingFolder(""), "未命名书籍");
  assert.equal(sanitizeReadingFolder("x".repeat(200)).length, 60);
});

test("ensureBook assigns one stable folder per book and writes book.json", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "plugin/reading" });
  const first = await store.ensureBook("Books/a.pdf", { title: "同一个名字", format: "pdf", sourcePath: "Books/a.pdf", note: "notes/a.md" });
  const again = await store.ensureBook("Books/a.pdf", { title: "改过的标题", format: "pdf" });
  const other = await store.ensureBook("Books/b.epub", { title: "同一个名字", format: "epub" });
  assert.equal(first.folder, "同一个名字");
  assert.equal(again.folder, first.folder, "the folder never changes once assigned");
  assert.equal(other.folder, "同一个名字 (2)", "a colliding title gets a suffix");
  const paths = readingBookPaths("plugin/reading", first.folder);
  const meta = JSON.parse(adapter.files.get(paths.meta));
  assert.equal(meta.source.path, "Books/a.pdf");
  assert.equal(meta.note, "notes/a.md");
  assert.deepEqual(meta.anchorSource, { kind: "source" });
  const index = await store.readIndex();
  assert.equal(index.books["Books/a.pdf"].folder, "同一个名字");
  assert.equal(index.books["Books/b.epub"].folder, "同一个名字 (2)");
});

test("opening a book creates the reading root and its folder without saving", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "plugin/reading" });
  await store.ensureBook("Books/a.pdf", { title: "一本书" });
  assert.equal(adapter.dirs.has("plugin"), true);
  assert.equal(adapter.dirs.has("plugin/reading"), true);
  assert.equal(adapter.dirs.has("plugin/reading/一本书"), true, "the book folder exists before any save");

  // Reopening is a no-op: no index rewrite, no extra mkdir.
  const indexBefore = adapter.files.get("plugin/reading/index.json");
  const dirsBefore = new Set(adapter.dirs);
  await store.ensureBook("Books/a.pdf", { title: "一本书" });
  assert.equal(adapter.files.get("plugin/reading/index.json"), indexBefore);
  assert.deepEqual([...adapter.dirs].sort(), [...dirsBefore].sort());
});

test("per-book saves round-trip and keep the index summary current", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.ensureBook("Books/a.pdf", { title: "一本书" });
  await store.ensureBook("Books/b.pdf", { title: "另一本" });
  await store.saveBook("Books/a.pdf", "progress", { pct: 0.5, percent: 50, lastRead: 111, block: 3 });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1", text: "句子", color: "yellow" }]);
  await store.saveBook("Books/b.pdf", "pins", [{ id: "p1", pinyin: "bēn" }]);

  const loaded = await store.loadBook("Books/a.pdf");
  assert.deepEqual(loaded.progress, { pct: 0.5, percent: 50, lastRead: 111, block: 3 });
  assert.equal(loaded.highlights.length, 1);
  assert.equal(loaded.pins, null, "no pins written for this book");
  assert.deepEqual(loaded.blocked, []);

  const index = await store.readIndex();
  assert.equal(index.books["Books/a.pdf"].percent, 50);
  assert.equal(index.books["Books/a.pdf"].highlights, 1);
  assert.equal(index.books["Books/a.pdf"].lastRead, 111);
  assert.equal(index.books["Books/b.pdf"].pins, 1);
  assert.equal(index.books["Books/b.pdf"].highlights, 0);

  // A book opened before any migration still gets its folder on first save.
  await store.saveBook("Books/missing.pdf", "progress", { pct: 0.9, lastRead: 222 }, { title: "missing" });
  const created = await store.loadBook("Books/missing.pdf");
  assert.equal(created.progress.pct, 0.9);
  assert.equal((await store.readIndex()).books["Books/missing.pdf"].percent, 90);

  await assert.rejects(() => store.saveBook("Books/a.pdf", "unknown", {}), /unknown reading store kind/);
});

test("a damaged book file blocks that book only", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.ensureBook("Books/a.pdf", { title: "一本书" });
  await store.saveBook("Books/a.pdf", "progress", { pct: 0.2, lastRead: 5 });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1" }]);
  const paths = readingBookPaths("reading", "一本书");
  adapter.files.set(paths.highlights, "{ not json");

  const loaded = await store.loadBook("Books/a.pdf");
  assert.equal(loaded.highlights, null, "the unreadable file yields no data");
  assert.deepEqual(loaded.progress, { pct: 0.2, lastRead: 5 }, "the other files stay usable");
  assert.deepEqual(loaded.blocked, [paths.highlights]);
});

test("migration splits the legacy global files into per-book folders", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "plugin/reading" });
  const report = await store.migrate({
    progress: { "Books/a.pdf": { pct: 0.3, lastRead: 9 }, "Books/b.pdf": { pct: 1, lastRead: 20 } },
    highlights: { "Books/a.pdf": [{ id: "h1", text: "甲" }, { id: "h2", text: "乙" }] },
    pins: { "Books/b.pdf": [{ id: "p1", pinyin: "yǐ" }] },
    notes: { "Books/a.pdf": "notes/a.md" },
    titles: {
      "Books/a.pdf": { title: "第一本", format: "pdf", size: 10 },
      "Books/b.pdf": { title: "第二本", format: "pdf" },
    },
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.books, 2);

  const a = await store.loadBook("Books/a.pdf");
  assert.equal(a.progress.pct, 0.3);
  assert.equal(a.highlights.length, 2);
  const b = await store.loadBook("Books/b.pdf");
  assert.equal(b.pins.length, 1);
  assert.deepEqual(b.highlights, null);

  const index = await store.readIndex();
  assert.equal(index.books["Books/a.pdf"].title, "第一本");
  assert.equal(index.books["Books/a.pdf"].highlights, 2);
  assert.equal(index.books["Books/b.pdf"].percent, 100);
  const meta = JSON.parse(adapter.files.get(readingBookPaths("plugin/reading", "第一本").meta));
  assert.equal(meta.note, "notes/a.md");

  // Nothing to move is not an error.
  const empty = await store.migrate({});
  assert.deepEqual(empty, { books: 0, files: 0, errors: [] });
});

test("a lost index rebuilds from the per-book book.json files", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.ensureBook("Books/a.pdf", { title: "一本书" });
  await store.ensureBook("Books/b.pdf", { title: "一本书" });
  await store.saveBook("Books/a.pdf", "progress", { pct: 0.4, lastRead: 8 });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1" }]);
  adapter.files.delete("reading/index.json");

  const index = await store.rebuildIndex([
    { bookPath: "Books/a.pdf", title: "一本书", format: "pdf" },
    { bookPath: "Books/b.pdf", title: "一本书", format: "pdf" },
    { bookPath: "Books/c.pdf", title: "从没读过", format: "pdf" },
  ]);
  assert.equal(Object.keys(index.books).length, 2, "only books with a folder come back");
  assert.equal(index.books["Books/a.pdf"].highlights, 1);
  assert.equal(index.books["Books/a.pdf"].percent, 40);
  assert.equal(index.books["Books/b.pdf"].folder, "一本书 (2)");
  const loaded = await store.loadBook("Books/a.pdf");
  assert.equal(loaded.highlights.length, 1);
});

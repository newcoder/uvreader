import assert from "node:assert/strict";
import test from "node:test";

import {
  createReadingStore,
  readingBookPaths,
  readingProjectPath,
  sanitizeReadingFileName,
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
    async exists(path) {
      if (files.has(path) || dirs.has(path)) return true;
      const prefix = `${path}/`;
      for (const key of files.keys()) if (key.startsWith(prefix)) return true;
      return false;
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    async mkdir(dir) { dirs.add(String(dir)); addParents(dir); },
    async write(path, data) { addParents(path); files.set(path, String(data)); },
    async list(dir) {
      const prefix = `${dir}/`;
      const names = new Set();
      for (const path of [...files.keys(), ...dirs]) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length).split("/")[0];
        if (rest) names.add(rest);
      }
      return [...names];
    },
    async remove(path) {
      const prefix = `${path}/`;
      for (const key of [...files.keys()]) if (key === path || key.startsWith(prefix)) files.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(prefix)) dirs.delete(dir);
    },
    async process(path, fn, options = {}) {
      const current = files.get(path) ?? options.initial ?? "";
      const next = await fn(current);
      if (next === undefined) return current;
      files.set(path, String(next));
      return next;
    },
    async rename(from, to) {
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
        return;
      }
      const prefix = `${from}/`;
      const children = [...files.keys()].filter((key) => key.startsWith(prefix));
      const folderKeys = [...dirs].filter((dir) => dir === from || dir.startsWith(prefix));
      if (!children.length && !folderKeys.length) throw new Error(`ENOENT: ${from}`);
      for (const key of children) {
        files.set(`${to}${key.slice(from.length)}`, files.get(key));
        files.delete(key);
      }
      for (const dir of folderKeys) {
        dirs.delete(dir);
        dirs.add(`${to}${dir.slice(from.length)}`);
      }
      dirs.add(to);
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

test("chat file names stay safe and bounded", () => {
  assert.equal(sanitizeReadingFileName("chat-1"), "chat-1");
  assert.equal(sanitizeReadingFileName("../坏/名字"), "chat");
  assert.equal(sanitizeReadingFileName(""), "chat");
  assert.equal(sanitizeReadingFileName("a".repeat(300)).length, 120);
});

test("conversations live one file per book and follow deletions", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveChat("Books/a.pdf", { id: "c1", title: "一问", bookPath: "Books/a.pdf", updatedAt: 10 }, { title: "一本书" });
  await store.saveChat("Books/a.pdf", { id: "c2", title: "二问", bookPath: "Books/a.pdf", updatedAt: 20 });
  await store.saveChat("Books/b.pdf", { id: "c3", title: "别的书", bookPath: "Books/b.pdf", updatedAt: 5 }, { title: "另一本" });

  const a = await store.loadBook("Books/a.pdf");
  assert.deepEqual(a.chats.map((chat) => chat.id), ["c2", "c1"], "newest first");
  assert.equal((await store.readIndex()).books["Books/a.pdf"].chats, 2);

  await store.deleteChat("Books/a.pdf", "c1");
  const after = await store.loadBook("Books/a.pdf");
  assert.deepEqual(after.chats.map((chat) => chat.id), ["c2"]);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].chats, 1);
  assert.equal((await store.loadBook("Books/b.pdf")).chats.length, 1, "the other book keeps its own");
});

test("a draft saves per book and clearing removes the file", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveBook("Books/a.pdf", "drafts", { text: "半句", updatedAt: 5 }, { title: "一本书" });
  const loaded = await store.loadBook("Books/a.pdf");
  assert.deepEqual(loaded.drafts, { text: "半句", updatedAt: 5 });
  assert.equal((await store.readIndex()).books["Books/a.pdf"].draft, true);

  await store.clearBook("Books/a.pdf", "drafts");
  const after = await store.loadBook("Books/a.pdf");
  assert.equal(after.drafts, null);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].draft, false);
  assert.equal(adapter.files.has(readingBookPaths("reading", "一本书").drafts), false);
});

test("bookmarks save per book and clearing removes the file", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveBook("Books/a.pdf", "marks", [{ id: "m1", title: "位置", anchor: { cfi: "x" } }], { title: "一本书" });
  const loaded = await store.loadBook("Books/a.pdf");
  assert.equal(loaded.marks.length, 1);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].marks, 1);

  await store.clearBook("Books/a.pdf", "marks");
  assert.equal((await store.loadBook("Books/a.pdf")).marks, null);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].marks, 0);
});

test("a damaged chat file is reported without losing the others", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveChat("Books/a.pdf", { id: "c1", bookPath: "Books/a.pdf", updatedAt: 1 }, { title: "一本书" });
  await store.saveChat("Books/a.pdf", { id: "c2", bookPath: "Books/a.pdf", updatedAt: 2 });
  const paths = readingBookPaths("reading", "一本书");
  adapter.files.set(`${paths.chats}/c1.json`, "{ broken");

  const loaded = await store.loadBook("Books/a.pdf");
  assert.deepEqual(loaded.chats.map((chat) => chat.id), ["c2"]);
  assert.deepEqual(loaded.blocked, [`${paths.chats}/c1.json`]);
});

test("moving a book into a project takes its traces but keeps its identity", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveBook("Books/a.pdf", "progress", { pct: 0.4, lastRead: 8 }, { title: "一本书" });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1" }]);
  await store.saveBook("Books/a.pdf", "drafts", { text: "半句", updatedAt: 1 });
  await store.saveBook("Books/a.pdf", "pins", [{ id: "p1" }]);
  await store.saveBook("Books/a.pdf", "marks", [{ id: "m1" }]);
  await store.saveChat("Books/a.pdf", { id: "c1", bookPath: "Books/a.pdf", updatedAt: 2 });
  const paths = readingBookPaths("reading", "一本书");
  adapter.files.set(`${paths.attachments}/a.png`, "bytes");

  const project = await store.createProject("冬季阅读");
  assert.equal(project, "冬季阅读");
  const report = await store.moveBook("Books/a.pdf", project);
  assert.equal(report.moved, 5, "progress, highlights, drafts, chats and attachments move");

  assert.equal(adapter.files.has(paths.meta), true, "book.json stays with the book");
  assert.equal(adapter.files.has(paths.pins), true, "pinned pinyin stays with the book");
  assert.equal(adapter.files.has(paths.marks), true, "bookmarks stay with the book");
  const projectPaths = readingBookPaths("reading", "一本书", project);
  assert.equal(projectPaths.tracesDir, "reading/_projects/冬季阅读/一本书");
  assert.equal(adapter.files.has(projectPaths.progress), true);
  assert.equal(adapter.files.has(projectPaths.highlights), true);
  assert.equal(adapter.files.has(projectPaths.drafts), true);
  assert.equal(adapter.files.has(`${projectPaths.chats}/c1.json`), true);
  assert.equal(adapter.files.has(`${projectPaths.attachments}/a.png`), true);
  assert.equal(adapter.files.has(paths.progress), false, "the old copies are gone");

  const loaded = await store.loadBook("Books/a.pdf");
  assert.equal(loaded.progress.pct, 0.4);
  assert.equal(loaded.highlights.length, 1);
  assert.equal(loaded.drafts.text, "半句");
  assert.equal(loaded.pins.length, 1);
  assert.equal(loaded.marks.length, 1);
  assert.equal(loaded.chats.length, 1);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].project, "冬季阅读");
  assert.equal(JSON.parse(adapter.files.get(paths.meta)).project, "冬季阅读");
  const projects = await store.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].books[0].path, "Books/a.pdf");

  await store.moveBook("Books/a.pdf", "");
  assert.equal(adapter.files.has(paths.progress), true);
  assert.equal(adapter.files.has(projectPaths.progress), false);
  assert.equal((await store.listProjects())[0].books.length, 0);
  assert.equal(JSON.parse(adapter.files.get(paths.meta)).project, null);
});

test("a failed move rolls the already-moved files back", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveBook("Books/a.pdf", "progress", { pct: 0.3, lastRead: 1 }, { title: "一本书" });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1" }]);
  await store.saveBook("Books/a.pdf", "drafts", { text: "x", updatedAt: 1 });
  const project = await store.createProject("项目");
  const projectPaths = readingBookPaths("reading", "一本书", project);
  adapter.files.set(projectPaths.drafts, "{\"schemaVersion\":1,\"data\":{\"text\":\"旧\"}}");

  await assert.rejects(() => store.moveBook("Books/a.pdf", project), /同名内容/);
  const paths = readingBookPaths("reading", "一本书");
  assert.equal(adapter.files.has(paths.progress), true, "progress moved back");
  assert.equal(adapter.files.has(paths.highlights), true, "highlights moved back");
  assert.equal(adapter.files.has(projectPaths.progress), false);
  assert.equal((await store.readIndex()).books["Books/a.pdf"].project || "", "");
  assert.equal((await store.listProjects())[0].books.length, 0);
});

test("deleting a project moves its books back before removing the folder", async () => {
  const adapter = memoryAdapter();
  const store = createReadingStore({ adapter, root: "reading" });
  await store.saveBook("Books/a.pdf", "highlights", [{ id: "h1" }], { title: "一本书" });
  const project = await store.createProject("项目");
  await store.moveBook("Books/a.pdf", project);

  const result = await store.deleteProject(project);
  assert.deepEqual(result.failed, []);
  assert.equal(adapter.files.has(readingBookPaths("reading", "一本书").highlights), true);
  assert.equal(adapter.files.has(`${readingProjectPath("reading", project)}/project.json`), false);
  assert.deepEqual(await store.listProjects(), []);
});

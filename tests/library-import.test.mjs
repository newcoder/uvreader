import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

import { bookTagsOf, existingVaultBookPath, freeBookPath, isInsideVaultPath, mergeBookTags, pickLibraryFolder } from "../packages/reader/src/library-data.js";

// The importer is a plugin method, so the test runs its source against a fake
// vault: copying a book that already lives in the vault forked duplicates (the
// home page hands over vault-relative paths), which is what this guards.
const pluginSource = fs.readFileSync(new URL("../packages/reader/src/plugin.js", import.meta.url), "utf8");

function importer(options = {}) {
  const method = pluginSource.slice(pluginSource.indexOf("  async importBookToLibrary("), pluginSource.indexOf("  async createBookNote("));
  const files = new Map();
  const created = [];
  const folders = [];
  const reads = [];
  const vault = {
    // The desktop shim resolves absolute paths against the real filesystem:
    // any existing file on disk looks like a vault file. `lenientLookup` models
    // that divergence so the importer's guard is exercised.
    getAbstractFileByPath: (p) => {
      const key = String(p).replace(/\\/g, "/");
      if (files.has(key)) return files.get(key);
      if (options.lenientLookup && /^[a-zA-Z]:\//.test(key)) return { path: key, extension: key.split(".").pop() };
      return null;
    },
    getFiles: () => [...files.values()],
    createFolder: async (p) => { folders.push(p); },
    createBinary: async (p, _bytes) => {
      created.push(p);
      files.set(p, { path: p, extension: p.split(".").pop() });
    },
    adapter: {
      readBinary: async (p) => { reads.push(p); return new Uint8Array([1, 2, 3]); },
      getBasePath: () => options.basePath,
    },
  };
  const plugin = {
    app: { vault },
    settings: { importedBooks: {} },
    tags: new Map(),
    setBookTags: async (p, tags) => { plugin.tags.set(p, tags); },
  };
  const api = vm.runInNewContext(`({${method}})`, {
    qiaomuReaderPath: (p) => String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    freeBookPath,
    pickLibraryFolder,
    mergeBookTags,
    bookTagsOf,
    existingVaultBookPath,
    isInsideVaultPath,
    BOOK_EXTENSIONS: new Set(["epub", "pdf"]),
    qiaomuReaderTranslate: (key) => key,
  });
  return { import: api.importBookToLibrary.bind(plugin), plugin, files, created, folders, reads };
}

test("a path that already points at a vault book is reused instead of copied", async () => {
  const h = importer();
  h.files.set("Books/下载/萤窗小语.epub", { path: "Books/下载/萤窗小语.epub", extension: "epub" });
  const target = await h.import("Books/下载/萤窗小语.epub");
  assert.equal(target, "Books/下载/萤窗小语.epub");
  assert.equal(h.created.length, 0, "no duplicate was written");
  assert.equal(h.reads.length, 0, "the vault file was not read back");
  assert.deepEqual(h.plugin.settings.importedBooks, {}, "no import entry is recorded for a vault book");
  // Backslashes arrive from Windows shells and clipboard paths.
  assert.equal(await h.import("Books\\下载\\萤窗小语.epub"), "Books/下载/萤窗小语.epub");
});

test("an outside book is copied in and tagged as imported", async () => {
  const h = importer();
  const target = await h.import("C:/Users/me/Downloads/萤窗小语.epub");
  assert.equal(target, "萤窗小语.epub", "an empty vault puts the copy at the root");
  assert.deepEqual(h.created, ["萤窗小语.epub"]);
  assert.equal(h.plugin.settings.importedBooks["C:/Users/me/Downloads/萤窗小语.epub"], "萤窗小语.epub");
  assert.deepEqual(h.plugin.tags.get("萤窗小语.epub"), ["auto-tag-import"]);
});

test("opening the same outside file again reuses its copy", async () => {
  const h = importer();
  const first = await h.import("C:/Users/me/Downloads/萤窗小语.epub");
  h.reads.length = 0;
  const second = await h.import("C:/Users/me/Downloads/萤窗小语.epub");
  assert.equal(second, first);
  assert.equal(h.created.length, 1, "the second open writes nothing");
  assert.equal(h.reads.length, 0, "the copy is reused without reading the source again");
});

test("the desktop shim's absolute lookups do not stop an outside book from being copied", async () => {
  const h = importer({ lenientLookup: true, basePath: "C:/Users/me/AppData/Roaming/uv-reader/library" });
  const target = await h.import("D:/projects/auto_chat/pdf_tool/test-docs/testpdf2.pdf");
  assert.equal(target, "testpdf2.pdf", "the outside document lands in the library");
  assert.deepEqual(h.created, ["testpdf2.pdf"]);
  assert.equal(h.reads.length, 1, "the source is read once for the copy");
});

test("an absolute path under the vault root is still reused, not copied", async () => {
  const basePath = "C:/Users/me/AppData/Roaming/uv-reader/library";
  const h = importer({ lenientLookup: true, basePath });
  const inside = `${basePath}/Books/萤窗小语.epub`;
  h.files.set(inside, { path: inside, extension: "epub" });
  assert.equal(await h.import(inside), inside);
  assert.equal(h.created.length, 0, "no duplicate for a book already in the library");
  assert.equal(h.reads.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createLibraryData, existingVaultBookPath, freeBookPath, groupLibChips, IMPORT_MIME_EXT, isInsideVaultPath, mergeBookTags, pickLibraryFolder, vaultBookPaths, vaultOnlyRecord } from "../packages/reader/src/library-data.js";

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

test("mergeBookTags unions existing and added tags without duplicates", () => {
  assert.deepEqual(mergeBookTags(["小说", "历史"], ["导入"]), ["小说", "历史", "导入"]);
  assert.deepEqual(mergeBookTags(["导入"], ["导入"]), ["导入"]);
  assert.deepEqual(mergeBookTags(undefined, ["下载"]), ["下载"]);
  assert.deepEqual(mergeBookTags([" "], []), []);
  assert.deepEqual(mergeBookTags(["a"], ["b", "a", "c"]), ["a", "b", "c"]);
});

test("freeBookPath keeps the extension and suffixes duplicates", () => {
  const taken = new Set(["Books/a.epub", "Books/a (1).epub", "Books/a (2).epub"]);
  assert.equal(freeBookPath("Books", "a.epub", (p) => taken.has(p)), "Books/a (3).epub");
  assert.equal(freeBookPath("Books", "b.epub", () => false), "Books/b.epub");
  assert.equal(freeBookPath("", "c.pdf", () => false), "c.pdf");
  // Unsafe characters are replaced instead of escaping the folder.
  assert.equal(freeBookPath("Books", "../x.epub", () => false), "Books/.._x.epub");
});

test("pickLibraryFolder prefers the configured folder, else the busiest one", () => {
  const files = [
    { extension: "epub", parent: { path: "Books" } },
    { extension: "epub", parent: { path: "Books" } },
    { extension: "pdf", parent: { path: "Papers" } },
    { extension: "md", parent: { path: "Notes" } },
  ];
  const wanted = new Set(["epub", "pdf"]);
  assert.equal(pickLibraryFolder(files, "Shelf", wanted), "Shelf");
  assert.equal(pickLibraryFolder(files, "", wanted), "Books");
  assert.equal(pickLibraryFolder([], "", wanted), "");
});

test("existingVaultBookPath reuses books that already live in the vault", () => {
  const vault = new Map([["Books/下载/萤窗小语.epub", { path: "Books/下载/萤窗小语.epub", extension: "epub" }]]);
  const lookup = (p) => vault.get(p) || null;
  assert.equal(existingVaultBookPath("Books/下载/萤窗小语.epub", lookup), "Books/下载/萤窗小语.epub");
  assert.equal(existingVaultBookPath("Books\\下载\\萤窗小语.epub", lookup), "Books/下载/萤窗小语.epub", "backslashes are normalized");
  assert.equal(existingVaultBookPath("D:/Outside/book.epub", lookup), "", "outside paths are not vault books");
  assert.equal(existingVaultBookPath("", lookup), "");
  assert.equal(existingVaultBookPath("Books/下载/萤窗小语.epub", null), "");
  assert.equal(existingVaultBookPath("Books/下载", () => ({ path: "Books/下载", extension: "" })), "", "folders are not books");
});

test("isInsideVaultPath only trusts absolute paths under the vault root", () => {
  const root = "C:/Users/me/AppData/Roaming/uv-reader/library";
  assert.equal(isInsideVaultPath("Books/下载/萤窗小语.epub", root), true, "relative paths are vault paths");
  assert.equal(isInsideVaultPath(`${root}/Books/萤窗小语.epub`, root), true);
  assert.equal(isInsideVaultPath("C:\\Users\\me\\AppData\\Roaming\\uv-reader\\library\\Books\\萤窗小语.epub", root), true, "backslashes normalize");
  assert.equal(isInsideVaultPath("c:/users/me/appdata/roaming/uv-reader/library/Books/x.epub", root), true, "drive letter case is ignored");
  assert.equal(isInsideVaultPath("D:/projects/auto_chat/pdf_tool/test-docs/testpdf2.pdf", root), false, "outside files stay outside");
  assert.equal(isInsideVaultPath(`${root}-backup/Books/x.epub`, root), false, "a sibling folder with the same prefix is outside");
  assert.equal(isInsideVaultPath("D:/outside/x.epub", ""), true, "no root means no guard");
});

test("vaultBookPaths and vaultOnlyRecord drop outside reading records", () => {
  const root = "C:/Users/me/AppData/Roaming/uv/library";
  const paths = ["Books/a.epub", "C:/Users/rayni/Downloads/x.pdf", `${root}/Books/b.epub`, "D:/projects/assets/starter-books/11.epub"];
  assert.deepEqual(vaultBookPaths(paths, root), ["Books/a.epub", `${root}/Books/b.epub`]);
  assert.deepEqual(vaultBookPaths(null, root), []);
  const record = {
    "11.epub": { percent: 3 },
    "D:/projects/uvreader/assets/starter-books/11.epub": { percent: 0 },
    "C:/Users/rayni/Downloads/dlbook.pdf": { percent: 0 },
  };
  assert.deepEqual(vaultOnlyRecord(record, root), { "11.epub": { percent: 3 } });
  assert.deepEqual(vaultOnlyRecord(null, root), {});
});

test("groupLibChips splits the tree groups and nests subfolders", () => {
  const chips = [
    { id: "all", label: "全部", count: 9 },
    { id: "status:reading", label: "正在阅读", count: 2 },
    { id: "tag:小说", label: "小说", count: 4 },
    { id: "tag:历史", label: "历史", count: 2 },
    { id: "folder:Books", label: "Books", count: 6 },
    { id: "folder:Books/合集", label: "└ 合集", count: 2, sub: true },
    { id: "folder:下载", label: "下载", count: 3 },
  ];
  const groups = groupLibChips(chips);
  assert.equal(groups.total, 9);
  assert.deepEqual(groups.statuses.map((c) => c.id), ["status:reading"]);
  assert.deepEqual(groups.tags.map((c) => c.id), ["tag:小说", "tag:历史"]);
  assert.deepEqual(groups.folders.map((f) => f.id), ["folder:Books", "folder:下载"]);
  assert.deepEqual(groups.folders[0].subs.map((s) => s.id), ["folder:Books/合集"]);
  assert.deepEqual(groups.folders[1].subs, []);
  assert.deepEqual(groupLibChips(undefined), { total: 0, statuses: [], tags: [], folders: [] });
});

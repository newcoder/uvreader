import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_BUILDER_SOURCE_EXTENSIONS, filterLibraryFiles, libraryRoot } from "../src/shared/library-files.js";

const file = (path, extension = path.split(".").pop()) => ({ path, extension, basename: path.split("/").pop() });

test("workshop library lists include books at the root and under Books", () => {
  const files = [
    file("old.pdf"),
    file("Books/下载/book.epub"),
    file("Books/示例书库/example.fb2"),
    file("Books/下载/book.uvtext.pdf"),
    file("notes/note.md"),
    file("CSP2019_questions.md"),
  ];
  assert.equal(libraryRoot(files, ""), "");
  assert.deepEqual(
    filterLibraryFiles(files, { extensions: ["pdf", "epub", "fb2"] }).map((entry) => entry.path),
    ["old.pdf", "Books/下载/book.epub", "Books/示例书库/example.fb2", "Books/下载/book.uvtext.pdf"],
  );
});

test("a configured books folder wins and a non-recursive filter is gone", () => {
  const files = [
    file("Books/下载/a.epub"),
    file("Books/下载/docs/b.docx"),
    file("Books/示例/c.epub"),
  ];
  assert.deepEqual(
    filterLibraryFiles(files, { booksFolder: "Books/下载", extensions: ["epub", "docx"] }).map((entry) => entry.path),
    ["Books/下载/a.epub", "Books/下载/docs/b.docx"],
  );
  const rootOnly = [file("a.pdf"), file("notes/b.pdf"), file("images/c.jpg")];
  assert.deepEqual(filterLibraryFiles(rootOnly, { extensions: ["pdf"] }).map((entry) => entry.path), ["a.pdf", "notes/b.pdf"]);
});

test("the ebook source picker only offers library book formats", () => {
  assert.deepEqual(
    [...BOOK_BUILDER_SOURCE_EXTENSIONS],
    ["epub", "pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp"],
  );
  const files = [
    file("Books/a.epub"),
    file("Books/b.pdf"),
    file("Books/c.png"),
    file("Books/notes.md"),
    file("Books/source.docx"),
    file("Books/d.uvtext.pdf"),
    file("Books/e.azw3"),
  ];
  assert.deepEqual(
    filterLibraryFiles(files, { extensions: BOOK_BUILDER_SOURCE_EXTENSIONS }).map((entry) => entry.path),
    ["Books/a.epub", "Books/b.pdf", "Books/c.png", "Books/d.uvtext.pdf"],
  );
});

test("the library predicate can exclude data roots", () => {
  const files = [file("Books/下载/a.epub"), file("Books/隐藏/b.epub")];
  assert.deepEqual(
    filterLibraryFiles(files, {
      extensions: ["epub"],
      isLibraryBook: (entry) => entry.path.includes("隐藏") ? false : true,
    }).map((entry) => entry.path),
    ["Books/下载/a.epub"],
  );
});

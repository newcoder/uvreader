import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_EXTENSIONS, EXTERNAL_DOC_EXTENSIONS, extensionOf, isBookFile, isExternalDocFile, isOpenableFile } from "../src/shared/books.js";

test("the desktop shell accepts the reader formats including standalone images", () => {
  assert.deepEqual([...BOOK_EXTENSIONS], ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "cbz", "pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp"]);
  for (const extension of BOOK_EXTENSIONS) {
    assert.equal(isBookFile(`C:\\Books\\sample.${extension}`), true, extension);
    assert.equal(isBookFile(`/home/reader/sample.${extension.toUpperCase()}`), true, extension);
  }
});

test("non-book files are rejected before the reader opens", () => {
  for (const name of ["notes.md", "book.txt", "archive.zip", "no-extension"]) {
    assert.equal(isBookFile(name), false, name);
  }
  assert.equal(isBookFile("cover.jpg"), true);
  assert.equal(extensionOf("C:\\Books\\My Book.EPUB"), "epub");
  assert.equal(extensionOf("no-extension"), "");
});

test("office documents are handed to the system default application", () => {
  for (const extension of EXTERNAL_DOC_EXTENSIONS) {
    assert.equal(isExternalDocFile(`C:\\Docs\\sample.${extension}`), true, extension);
    assert.equal(isExternalDocFile(`/home/reader/sample.${extension.toUpperCase()}`), true, extension);
    assert.equal(isBookFile(`sample.${extension}`), false, extension);
    assert.equal(isOpenableFile(`sample.${extension}`), true, extension);
  }
  assert.equal(isExternalDocFile("book.epub"), false);
  assert.equal(isExternalDocFile("notes.md"), false);
  assert.equal(isExternalDocFile("no-extension"), false);
  assert.equal(isOpenableFile("book.epub"), true);
  assert.equal(isOpenableFile("notes.md"), false);
});

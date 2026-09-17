import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_EXTENSIONS, extensionOf, isBookFile } from "../src/shared/books.js";

test("the desktop shell accepts exactly the reader formats", () => {
  assert.deepEqual([...BOOK_EXTENSIONS], ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "cbz", "pdf"]);
  for (const extension of BOOK_EXTENSIONS) {
    assert.equal(isBookFile(`C:\\Books\\sample.${extension}`), true, extension);
    assert.equal(isBookFile(`/home/reader/sample.${extension.toUpperCase()}`), true, extension);
  }
});

test("non-book files are rejected before the reader opens", () => {
  for (const name of ["notes.md", "cover.jpg", "book.txt", "archive.zip", "no-extension"]) {
    assert.equal(isBookFile(name), false, name);
  }
  assert.equal(extensionOf("C:\\Books\\My Book.EPUB"), "epub");
  assert.equal(extensionOf("no-extension"), "");
});

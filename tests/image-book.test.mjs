import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { IMAGE_BOOK_EXTENSIONS, imageBookBytes, isImageBookFile } from "../packages/reader/src/image-book.js";

test("image files are exposed as reader book formats", () => {
  assert.deepEqual([...IMAGE_BOOK_EXTENSIONS], ["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
  for (const extension of IMAGE_BOOK_EXTENSIONS) {
    assert.equal(isImageBookFile({ extension }), true, extension);
    assert.equal(isImageBookFile(`/tmp/page.${extension.toUpperCase()}`), true, extension);
  }
  assert.equal(isImageBookFile("page.tiff"), false);
  assert.equal(isImageBookFile("book.pdf"), false);
});

test("a single image becomes a valid one-page CBZ without touching the source", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-image-book-"));
  const source = path.join(dir, "试卷 第1页.png");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(source, image);

  const archive = imageBookBytes(fs.readFileSync(source), path.basename(source));
  const zip = await JSZip.loadAsync(archive);
  const entry = zip.file("试卷 第1页.png");
  assert.ok(entry, "the image keeps its name inside the CBZ");
  assert.equal(entry.dir, false);
  assert.deepEqual([...await entry.async("uint8array")], [...image]);
  assert.equal(fs.readFileSync(source).equals(image), true, "the original image is untouched");
});

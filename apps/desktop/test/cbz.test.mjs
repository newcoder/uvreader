import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { buildCbz, cbzPath, compareImageNames, imageFiles } from "../src/main/cbz.js";

function imageDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-cbz-"));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `img:${name}`);
  return dir;
}

test("compareImageNames sorts numbers naturally", () => {
  const names = ["10.jpg", "2.jpg", "1.jpg", "b.jpg", "a.jpg"];
  assert.deepEqual([...names].sort(compareImageNames), ["1.jpg", "2.jpg", "10.jpg", "a.jpg", "b.jpg"]);
});

test("imageFiles keeps supported images only", () => {
  assert.deepEqual(imageFiles(["a.png", "b.JPG", "c.txt", "d.webp", "e"]), ["a.png", "b.JPG", "d.webp"]);
  assert.deepEqual(imageFiles(null), []);
});

test("cbzPath names the archive after the folder, with numbering", () => {
  const images = ["D:/comics/MyBook/001.jpg"];
  assert.equal(cbzPath(images).replace(/\\/g, "/"), "D:/comics/MyBook.cbz");
  const taken = new Set(["D:/comics/MyBook.cbz"]);
  assert.equal(cbzPath(images, (candidate) => taken.has(candidate.replace(/\\/g, "/"))).replace(/\\/g, "/"), "D:/comics/MyBook (1).cbz");
});

test("buildCbz packs the images in natural order and refuses empty input", async () => {
  const dir = imageDir(["10.jpg", "2.jpg", "1.jpg"]);
  const out = path.join(dir, "..", `${path.basename(dir)}.cbz`);
  const result = await buildCbz(["10.jpg", "2.jpg", "1.jpg"].map((name) => path.join(dir, name)), out);
  assert.equal(result.pages, 3);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  assert.deepEqual(Object.keys(zip.files), ["1.jpg", "2.jpg", "10.jpg"]);
  assert.equal(await zip.file("1.jpg").async("string"), "img:1.jpg");
  await assert.rejects(buildCbz([], out), /没有可打包的图片/);
  await assert.rejects(buildCbz([path.join(dir, "missing.png")], out), /图片不存在/);
});

test("buildCbz disambiguates identical basenames from different folders", async () => {
  const a = imageDir(["page.jpg"]);
  const b = imageDir(["page.jpg"]);
  const out = path.join(os.tmpdir(), `qbr-cbz-dup-${Date.now()}.cbz`);
  await buildCbz([path.join(a, "page.jpg"), path.join(b, "page.jpg")], out);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  assert.deepEqual(Object.keys(zip.files), ["page.jpg", "page (1).jpg"]);
});

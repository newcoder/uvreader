import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSpaceService, SPACE_TYPES } from "../src/main/spaces.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-spaces-"));
  const library = path.join(root, "library");
  fs.mkdirSync(library, { recursive: true });
  const service = createSpaceService({
    libraryRoot: library,
    registryPath: path.join(root, "spaces.json"),
  });
  return { root, library, service };
}

test("a space gets a directory, metadata and an empty source index", () => {
  const { library, service } = setup();
  const space = service.create({ name: "论文研究", type: "research" });
  assert.equal(space.name, "论文研究");
  assert.equal(space.type, "research");
  assert.equal(space.color, SPACE_TYPES.research.color);
  assert.equal(space.exists, true);
  assert.equal(space.bookCount, 0);
  assert.ok(fs.existsSync(path.join(space.root, "books")));
  assert.ok(fs.existsSync(path.join(space.root, ".uvreader", "space.json")));
  assert.equal(path.dirname(space.root), path.join(library, "Spaces"));
  const meta = JSON.parse(fs.readFileSync(path.join(space.root, ".uvreader", "space.json"), "utf8"));
  assert.equal(meta.name, "论文研究");
  assert.equal(meta.type, "research");
});

test("import copies a source into books and never modifies the original", async () => {
  const { root, service } = setup();
  const source = path.join(root, "外面.pdf");
  const bytes = Buffer.from("pdf-bytes");
  fs.writeFileSync(source, bytes);
  const space = service.create({ name: "研究", type: "research" });
  const result = await service.importFiles(space.id, [source]);
  assert.equal(result.imported.length, 1);
  assert.equal(result.duplicates.length, 0);
  assert.deepEqual(result.failed, []);
  const imported = result.imported[0];
  assert.equal(imported.name, "外面.pdf");
  assert.equal(imported.size, bytes.length);
  assert.equal(imported.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(fs.readFileSync(imported.path), bytes);
  assert.deepEqual(fs.readFileSync(source), bytes, "the original stays");

  const listed = service.list()[0];
  assert.equal(listed.bookCount, 1);
  assert.equal(listed.books[0].path, imported.path);
});

test("the same content is reused instead of copied twice", async () => {
  const { root, service } = setup();
  const source = path.join(root, "same.epub");
  fs.writeFileSync(source, "same");
  const space = service.create({ name: "阅读", type: "reading" });
  await service.importFiles(space.id, [source]);
  const copy = path.join(root, "renamed.epub");
  fs.writeFileSync(copy, "same");
  const again = await service.importFiles(space.id, [copy]);
  assert.equal(again.imported.length, 0);
  assert.equal(again.duplicates.length, 1);
  assert.equal(service.list()[0].bookCount, 1);
  assert.equal(again.duplicates[0].name, "same.epub");
});

test("a different file with the same name gets a hash suffix, not (1)", async () => {
  const { root, service } = setup();
  const space = service.create({ name: "学习", type: "learning" });
  const first = path.join(root, "a", "试卷.pdf");
  const second = path.join(root, "b", "试卷.pdf");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, "first");
  fs.writeFileSync(second, "second");
  const one = await service.importFiles(space.id, [first]);
  const two = await service.importFiles(space.id, [second]);
  assert.equal(one.imported[0].name, "试卷.pdf");
  assert.match(two.imported[0].name, /^试卷 \[[0-9a-f]{8}\]\.pdf$/);
  assert.equal(service.list()[0].bookCount, 2);
});

test("failed files are reported without leaving partial copies", async () => {
  const { service } = setup();
  const space = service.create({ name: "工作", type: "work" });
  const result = await service.importFiles(space.id, ["C:/definitely/missing/file.pdf"]);
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(fs.readdirSync(path.join(space.root, "books")).length, 0);
});

test("derived documents in a space are listed and linked to their source", async () => {
  const { root, service } = setup();
  const source = path.join(root, "论文.pdf");
  fs.writeFileSync(source, "pdf");
  const space = service.create({ name: "研究", type: "research" });
  const imported = await service.importFiles(space.id, [source]);
  const book = imported.imported[0];
  const write = (relative) => {
    const file = path.join(space.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "derived");
    return file;
  };
  write("exports/论文.epub");
  write("translations/论文（简体）.epub");
  write("quizzes/论文.AI答题页.html");
  write("quizzes/论文.普通答题页.html");
  write("polish/论文-空间版.epub");
  write("polish/polish.md");
  write("polish/polish.baseline.md");
  write("extracts/论文.md");
  write("books/论文.md");
  write("books/论文.AI答题页.html");
  write("books/论文.普通答题页.html");
  write("exports/ignored.bin");
  write(".uvreader/should-not-show.json");

  const listed = service.list()[0];
  assert.equal(listed.outputs.length, 10, JSON.stringify(listed.outputs));
  const byPath = new Map(listed.outputs.map((item) => [item.relativePath, item]));
  assert.equal(byPath.get("exports/论文.epub").sourceId, book.id);
  assert.equal(byPath.get("translations/论文（简体）.epub").sourceId, book.id);
  assert.equal(byPath.get("quizzes/论文.AI答题页.html").sourceId, book.id);
  assert.equal(byPath.get("polish/论文-空间版.epub").sourceId, book.id);
  assert.equal(byPath.get("extracts/论文.md").sourceId, book.id);
  assert.equal(byPath.get("books/论文.md").sourceId, book.id);
  assert.equal(byPath.get("books/论文.AI答题页.html").sourceId, book.id);
  assert.equal(byPath.get("books/论文.AI答题页.html").category, "quizzes");
  assert.equal(byPath.get("quizzes/论文.普通答题页.html").sourceId, book.id);
  assert.equal(byPath.get("books/论文.普通答题页.html").sourceId, book.id);
  assert.equal(byPath.get("books/论文.普通答题页.html").category, "quizzes");
  assert.equal(byPath.get("polish/polish.md").sourceId, "");
  assert.equal(byPath.has("polish/polish.baseline.md"), false);
  assert.equal(byPath.has("exports/ignored.bin"), false);
  assert.equal(byPath.has(".uvreader/should-not-show.json"), false);
  assert.equal(byPath.get("quizzes/论文.AI答题页.html").ext, "html");
  assert.ok(byPath.get("quizzes/论文.AI答题页.html").path.startsWith(space.root));
});

test("derived outputs can be deleted but space sources cannot", async () => {
  const { root, service } = setup();
  const source = path.join(root, "论文.pdf");
  fs.writeFileSync(source, "pdf");
  const space = service.create({ name: "研究", type: "research" });
  await service.importFiles(space.id, [source]);
  const output = path.join(space.root, "exports", "论文.epub");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, "epub");
  const remove = async (file) => fs.unlinkSync(file);
  await service.deleteOutput(space.id, "exports/论文.epub", { remove });
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(path.join(space.root, "books", "论文.pdf")), true);
  await assert.rejects(() => service.deleteOutput(space.id, "books/论文.pdf", { remove }), /源文件/);
  await assert.rejects(() => service.deleteOutput(space.id, "../outside.txt", { remove }), /路径无效/);
  await assert.rejects(() => service.deleteOutput(space.id, ".uvreader/index.json", { remove }), /内部数据/);
});

test("opening a space syncs a renamed source from the books directory", async () => {
  const { root, service } = setup();
  const source = path.join(root, "old.pdf");
  fs.writeFileSync(source, "pdf-content");
  const space = service.create({ name: "研究", type: "research" });
  const imported = (await service.importFiles(space.id, [source])).imported[0];
  const oldOutput = path.join(space.root, "quizzes", "old.AI答题页.html");
  fs.mkdirSync(path.dirname(oldOutput), { recursive: true });
  fs.writeFileSync(oldOutput, "<html></html>");
  const renamed = path.join(space.root, "books", "new name.pdf");
  fs.renameSync(imported.path, renamed);

  const result = await service.sync(space.id);

  assert.equal(result[0].ok, true);
  assert.equal(result[0].renamed, 1);
  assert.equal(result[0].removed, 0);
  const listed = service.list()[0];
  assert.equal(listed.bookCount, 1);
  assert.equal(listed.books[0].id, imported.id, "the source id survives a rename");
  assert.equal(listed.books[0].name, "new name.pdf");
  assert.equal(listed.books[0].relativePath, "books/new name.pdf");
  assert.equal(listed.books[0].title, "new name");
  assert.equal(listed.books[0].path, renamed);
  assert.equal(listed.outputs.find((item) => item.relativePath === "quizzes/old.AI答题页.html")?.sourceId, imported.id,
    "derived files named after the old source stay linked");
});

test("opening a space removes deleted sources and adds copied books", async () => {
  const { root, service } = setup();
  const source = path.join(root, "old.pdf");
  fs.writeFileSync(source, "old");
  const space = service.create({ name: "研究", type: "research" });
  const imported = (await service.importFiles(space.id, [source])).imported[0];
  fs.unlinkSync(imported.path);
  const addedPath = path.join(space.root, "books", "manual.docx");
  fs.writeFileSync(addedPath, "manual");

  const result = await service.sync(space.id);

  assert.equal(result[0].removed, 1);
  assert.equal(result[0].added, 1);
  const listed = service.list()[0];
  assert.equal(listed.bookCount, 1);
  assert.equal(listed.books[0].relativePath, "books/manual.docx");
  assert.equal(listed.books[0].title, "manual");
  assert.equal(fs.existsSync(listed.books[0].path), true);
});

test("answer pages copied into books stay derived outputs, not sources", async () => {
  const { service } = setup();
  const space = service.create({ name: "研究", type: "research" });
  const answerPage = path.join(space.root, "books", "2025北京.AI答题页.html");
  fs.mkdirSync(path.dirname(answerPage), { recursive: true });
  fs.writeFileSync(answerPage, "<html></html>");

  await service.sync(space.id);

  const listed = service.list()[0];
  assert.equal(listed.bookCount, 0);
  assert.equal(listed.outputs.some((item) => item.relativePath === "books/2025北京.AI答题页.html"), true);
});

test("spaces outside the library and non-empty target folders are rejected", () => {
  const { root, library, service } = setup();
  assert.throws(() => service.create({ name: "外部", root: path.join(root, "outside") }), /书库目录内/);
  const existing = path.join(library, "Spaces", "已存在");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "a.txt"), "x");
  assert.throws(() => service.create({ name: "已存在" }), /已经存在且不为空/);
});

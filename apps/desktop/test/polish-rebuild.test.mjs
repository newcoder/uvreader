import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { linkPolishFootnotes, registerEpubRunners, remapChapterNav, safePolishTag } from "../src/main/workshop-epub.js";
import { readPolishBundle, savePolishMarkdown } from "../src/main/polish-session.js";
import { waitForTask } from "./wait-for-task.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeQueue(cacheRoot) {
  const queue = createWorkshopQueue({
    file: path.join(tempDir("qbr-polish-tasks-"), "tasks.json"),
    onState: () => {},
    log: { warn() {} },
  });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot, log: () => {} });
  return queue;
}

async function chapterTexts(epubPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(epubPath));
  const names = Object.keys(zip.files).filter((name) => /\.xhtml$/i.test(name));
  const texts = [];
  for (const name of names) texts.push(await zip.file(name).async("string"));
  return texts.join("\n");
}

test("polish tags stay inside a safe filename suffix", () => {
  assert.equal(safePolishTag(""), "精修");
  assert.equal(safePolishTag(" v2 "), "v2");
  assert.equal(safePolishTag("精修/v2"), "精修 v2");
  assert.equal(safePolishTag(".."), "精修");
});

test("remapping a deleted chapter keeps the printed TOC parent entries and levels", () => {
  const oldMeta = [
    { id: "ch-001", title: "第一章" },
    { id: "ch-002", title: "康" },
    { id: "ch-003", title: "康熙六次南巡" },
    { id: "ch-004", title: "两淮盐务" },
  ];
  const chapters = [
    { title: "第一章" },
    { title: "康熙六次南巡" },
    { title: "两淮盐税" },
  ];
  const files = ["chapter-001.xhtml", "chapter-002.xhtml", "chapter-003.xhtml"];
  const oldNav = [
    { title: "第一章", file: "chapter-001.xhtml", level: 1 },
    { title: "第一章 子目", file: "chapter-001.xhtml", level: 2 },
    { title: "康熙六次南巡", file: "chapter-003.xhtml", level: 2 },
    { title: "第五章 两淮盐务", file: "chapter-004.xhtml", level: 1 },
    { title: "两淮盐税", file: "chapter-004.xhtml", level: 2 },
  ];
  const nav = remapChapterNav(oldNav, oldMeta, chapters, files);
  assert.deepEqual(nav.map((item) => item.title), [
    "第一章",
    "第一章 子目",
    "康熙六次南巡",
    "第五章 两淮盐务",
    "两淮盐税",
  ]);
  assert.deepEqual(nav.map((item) => item.level), [1, 2, 2, 1, 2]);
  assert.equal(nav[2].file, "chapter-002.xhtml");
  assert.equal(nav[3].file, "chapter-003.xhtml");
  assert.equal(nav[4].file, "chapter-003.xhtml");
});

test("polish footnotes become cross-chapter links in both directions", () => {
  const chapters = [
    {
      title: "正文",
      text: '正文 <sup>15</sup><!-- polish:marker marker-018-014 chapter=ch-018 page=0 label="15" note=note-196 --> 继续。',
    },
    {
      title: "注释",
      text: [
        '<!-- polish:note note-196 chapter=ch-021 page=0 label="15" linked=true alignment=ordinal -->',
        "15、注释内容。",
      ].join("\n"),
    },
  ];
  const linked = linkPolishFootnotes(chapters, {
    chapterIds: ["ch-018", "ch-021"],
    chapterFiles: ["chapter-018.xhtml", "chapter-021.xhtml"],
    markdown: chapters.map((chapter) => chapter.text).join("\n\n"),
  });
  assert.match(linked[0], /id="marker-018-014"/);
  assert.match(linked[0], /href="chapter-021\.xhtml#note-196"/);
  assert.match(linked[0], /<sup>\[15\]<\/sup>/);
  assert.match(linked[1], /id="note-196"/);
  assert.match(linked[1], /href="chapter-018\.xhtml#marker-018-014"/);
  assert.match(linked[1], />\[15\]<\/a> 注释内容/);
  assert.doesNotMatch(linked[1], /polish:note/);
});

test("book-polish rebuilds the EPUB from edited polish.md", async () => {
  const dir = tempDir("qbr-polish-rebuild-");
  const source = path.join(dir, "book.md");
  const cacheRoot = path.join(dir, "cache");
  fs.writeFileSync(source, [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文里有一个上标 $^{1}$。",
    "",
    "注释:",
    "",
    "1、《测试资料》，1页。",
    "",
    "2、《测试资料》，2页。",
  ].join("\n"), "utf8");

  const queue = makeQueue(cacheRoot);
  const build = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, title: "测试书", author: "作者" },
  }), 15000);
  assert.equal(build.status, "done", build.error);
  assert.ok(build.result?.polish?.path, "book-build returns polish paths");
  assert.ok(fs.existsSync(build.result.polish.path));
  assert.ok(fs.existsSync(build.result.polish.markdownPath));
  assert.equal(build.result.polish.needsReview, 1, "only the unlinked note needs review");

  const bundle = readPolishBundle(build.result.polish.path);
  assert.equal(bundle.report.summary.needsReview, 1);
  const edited = bundle.markdown
    .replace("正文里有一个上标", "修正后的正文里有一个上标")
    .replace("2、《测试资料》，2页。", "2、《测试资料》，已修订，2页。");
  savePolishMarkdown(build.result.polish.path, edited);

  const rebuild = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path },
  }), 15000);
  assert.equal(rebuild.status, "done", rebuild.error);
  assert.match(rebuild.detail, /精修重建/);
  assert.notEqual(rebuild.output, build.output, "the original build is not overwritten");
  assert.match(rebuild.output, /-精修\.epub$/i);
  assert.ok(fs.existsSync(build.output), "the original output stays");
  assert.ok(fs.existsSync(rebuild.output));
  const html = await chapterTexts(rebuild.output);
  assert.match(html, /修正后的正文里有一个上标/);
  assert.match(html, /2、《测试资料》，已修订，2页。/);
  assert.doesNotMatch(html, /polish:/);
  assert.match(html, /class="qbr-noteref"/);
  assert.match(html, /class="qbr-backlink"/);
  assert.match(html, /href="#note-001"/);
  assert.match(rebuild.result.polish.snapshotPath, /polish-精修\.md$/);
  assert.ok(fs.existsSync(rebuild.result.polish.snapshotPath));
  assert.equal(
    fs.readFileSync(rebuild.result.polish.snapshotPath, "utf8"),
    fs.readFileSync(build.result.polish.markdownPath, "utf8"),
    "the snapshot matches the polish.md used for this build",
  );
  const updated = readPolishBundle(build.result.polish.path);
  assert.match(updated.manifest.notes.find((note) => note.id === "note-002")?.text || "", /已修订/);
  assert.equal(updated.manifest.lastOutput, rebuild.output);
  assert.equal(updated.manifest.lastPolishSnapshot, rebuild.result.polish.snapshotPath);

  const again = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path, tag: "精修" },
  }), 15000);
  assert.equal(again.status, "done", again.error);
  assert.match(again.output, /-精修 \(1\)\.epub$/i, "an existing tagged output gets a new sequence");
  assert.match(again.result.polish.snapshotPath, /polish-精修 \(1\)\.md$/);
  assert.ok(fs.existsSync(again.result.polish.snapshotPath));
});

test("book-build backs up manually edited polish.md before regenerating", async () => {
  const dir = tempDir("qbr-polish-backup-");
  const source = path.join(dir, "book.md");
  const cacheRoot = path.join(dir, "cache");
  fs.writeFileSync(source, [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文 $^{①}$。",
    "",
    "注释:",
    "",
    "① 《测试资料》，1页。",
  ].join("\n"), "utf8");
  const queue = makeQueue(cacheRoot);
  const payload = { source, title: "测试书" };
  const first = await waitForTask(queue, queue.start({ kind: "book-build", title: "生成电子书", payload }), 15000);
  assert.equal(first.status, "done", first.error);
  const bundle = readPolishBundle(first.result.polish.path);
  savePolishMarkdown(first.result.polish.path, `${bundle.markdown}\n手工修改。\n`);

  const second = await waitForTask(queue, queue.start({ kind: "book-build", title: "重新生成电子书", payload }), 15000);
  assert.equal(second.status, "done", second.error);
  const backupPath = second.result.polish.backupPath;
  assert.ok(backupPath && fs.existsSync(backupPath), "manual polish.md is backed up");
  assert.match(fs.readFileSync(backupPath, "utf8"), /手工修改/);
  assert.ok(fs.existsSync(path.join(path.dirname(backupPath), "polish-session.json")));
  assert.match(second.detail, /已备份旧精修/);
  const regenerated = readPolishBundle(second.result.polish.path);
  assert.doesNotMatch(regenerated.markdown, /手工修改/);
});

test("book-polish accepts a manually deleted chapter heading and rebuilds the TOC", async () => {
  const dir = tempDir("qbr-polish-chapter-");
  const source = path.join(dir, "book.md");
  const cacheRoot = path.join(dir, "cache");
  fs.writeFileSync(source, [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文一 $^{①}$。",
    "",
    "## 康",
    "",
    "康的正文 $^{②}$。",
    "",
    "## 康熙六次南巡",
    "",
    "正文三 $^{③}$。",
    "",
    "注释:",
    "",
    "1、第一条，1页。",
    "",
    "2、第二条，2页。",
    "",
    "3、第三条，3页。",
  ].join("\n"), "utf8");
  const queue = makeQueue(cacheRoot);
  const build = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, title: "测试书" },
  }), 15000);
  assert.equal(build.status, "done", build.error);
  const bundle = readPolishBundle(build.result.polish.path);
  assert.equal(bundle.manifest.chapters.length, 3);
  savePolishMarkdown(build.result.polish.path, bundle.markdown.replace("## 康\n\n", ""));
  const rebuild = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path, tag: "删章节" },
  }), 15000);
  assert.equal(rebuild.status, "done", rebuild.error);
  const updated = readPolishBundle(build.result.polish.path);
  assert.equal(updated.manifest.chapters.length, 2);
  assert.deepEqual(updated.manifest.chapters.map((chapter) => chapter.title), ["第一章", "康熙六次南巡"]);
  assert.equal(updated.manifest.nav.some((item) => item.title === "康"), false);
  assert.equal(updated.manifest.nav.length, 2);
  const html = await chapterTexts(rebuild.output);
  assert.match(html, /康的正文/);
  assert.match(html, /康熙六次南巡/);
});

test("book-polish rebuilds after a note anchor is removed and prunes the stale manifest", async () => {
  const dir = tempDir("qbr-polish-invalid-");
  const source = path.join(dir, "book.md");
  const cacheRoot = path.join(dir, "cache");
  fs.writeFileSync(source, [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文 $^{㉞}$。",
    "",
    "注释:",
    "",
    "㉞ 《测试资料》，1页。",
  ].join("\n"), "utf8");
  const queue = makeQueue(cacheRoot);
  const build = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, title: "测试书" },
  }), 15000);
  assert.equal(build.status, "done", build.error);

  const bundle = readPolishBundle(build.result.polish.path);
  savePolishMarkdown(build.result.polish.path, bundle.markdown.replace(/<!--\s*polish:note[^>]*-->\n?/, ""));
  const rebuild = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path },
  }), 15000);
  assert.equal(rebuild.status, "done", rebuild.error);
  assert.ok(fs.existsSync(rebuild.output));
  const updated = readPolishBundle(build.result.polish.path);
  assert.deepEqual(updated.manifest.notes, [], "the missing note is removed from the manifest");
  assert.ok(Array.isArray(updated.manifest.markers));
});

test("book-polish uses a picked cover image left behind in the old template mode", async () => {
  const dir = tempDir("qbr-polish-cover-");
  const source = path.join(dir, "book.md");
  const coverPath = path.join(dir, "安妮封面.png");
  const cacheRoot = path.join(dir, "cache");
  // 1x1 transparent PNG. The extension is what matters here: the old polish
  // picker stored imagePath while leaving cover.mode on "template".
  const coverBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(coverPath, coverBytes);
  fs.writeFileSync(source, [
    "# 封面测试",
    "",
    "## 第一章",
    "",
    "正文。",
  ].join("\n"), "utf8");

  const queue = makeQueue(cacheRoot);
  const build = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, title: "封面测试" },
  }), 15000);
  assert.equal(build.status, "done", build.error);

  const manifest = JSON.parse(fs.readFileSync(build.result.polish.path, "utf8"));
  manifest.build.cover = { mode: "template", imagePath: coverPath, palette: "warm", fit: "contain" };
  fs.writeFileSync(build.result.polish.path, JSON.stringify(manifest, null, 2), "utf8");

  const rebuild = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path, tag: "封面" },
  }), 15000);
  assert.equal(rebuild.status, "done", rebuild.error);

  const zip = await JSZip.loadAsync(fs.readFileSync(rebuild.output));
  const embedded = zip.file("OEBPS/images/cover.png");
  assert.ok(embedded, "the picked PNG is embedded instead of the template JPEG");
  assert.deepEqual(await embedded.async("nodebuffer"), coverBytes);
  assert.match(await zip.file("OEBPS/cover.xhtml").async("string"), /images\/cover\.png/);
  assert.match(
    await zip.file("OEBPS/content.opf").async("string"),
    /id="cover-image" href="images\/cover\.png" media-type="image\/png"/,
  );
  const updated = readPolishBundle(build.result.polish.path);
  assert.equal(updated.manifest.build.cover.mode, "image", "the repaired cover mode is persisted for later rebuilds");
  assert.equal(updated.manifest.build.cover.imagePath, coverPath);
});

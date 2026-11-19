import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyPolishMarkdown,
  findPolishBundleForSource,
  forgetPolishNote,
  importPolishMarkdown,
  importPolishNotes,
  inspectPolishImport,
  listPolishBundles,
  parsePolishSnapshot,
  polishWorkspaceDir,
  readPolishBundle,
  repairPolishHeadings,
  resolvePolishAsset,
  revertPolishMarkdown,
  savePolishInfo,
  savePolishMarkdown,
  savePolishSession,
  validatePolishStructure,
} from "../src/main/polish-session.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-polish-"));
  const dir = path.join(root, "work", "book-1", "polish");
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "polish.json");
  const markdown = [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "<!-- polish:note note-001 page=52 label=\"㉞\" linked=true -->",
    "㉞ 《测试资料》，1页。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "polish.md"), markdown, "utf8");
  fs.writeFileSync(path.join(dir, "polish.baseline.md"), markdown, "utf8");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    buildId: "build-1",
    book: { title: "测试书" },
    chapters: [{ id: "ch-001", title: "第一章", format: "markdown" }],
    notes: [{ id: "note-001", page: 52, label: "㉞" }],
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "polish-report.json"), JSON.stringify({
    schemaVersion: 1,
    summary: { needsReview: 1, autoAccepted: 0 },
    points: [{ id: "point-001", noteId: "note-001", status: "open" }],
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "polish-session.json"), JSON.stringify({
    schemaVersion: 1,
    buildId: "build-1",
    ui: { filter: "review", selectedPointId: "point-001", scrollTop: 12 },
    pointStatus: {},
    files: {},
  }, null, 2), "utf8");
  return { root, dir, manifestPath, markdown };
}

test("repairPolishHeadings restores chapters from the baseline and records a backup", () => {
  const { root, dir, manifestPath } = fixture();
  try {
    const baseline = [
      "# 测试书",
      "## 前言",
      "## 第一章 内务府",
      "## 八旗与包衣",
      "## 曹家的兴起",
      "## 第二章 北京与苏州，诗歌与社交",
      "## 上等阶层",
      "## 附录一 原丝的价格",
      "## 参考书目",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "polish.baseline.md"), baseline, "utf8");
    const imported = [
      "# 测试书",
      "## 第 1 章",
      "## 前言",
      "## 内务府",
      "## 八旗与包衣",
      "## 曹家的兴起",
      "## 北京与苏州， 诗歌与社交",
      "## 上等阶层",
      "## 附录一 原丝的价格",
      "## 参考书目",
    ].join("\n");
    const result = repairPolishHeadings(manifestPath, imported);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const saved = fs.readFileSync(path.join(dir, "polish.md"), "utf8");
    assert.match(saved, /^## 封面$/m);
    assert.match(saved, /^## 第一章 内务府$/m);
    assert.match(saved, /^### 八旗与包衣$/m);
    assert.match(saved, /^## 第二章 北京与苏州，诗歌与社交$/m);
    assert.match(saved, /^## 附录一 原丝的价格$/m);
    assert.doesNotMatch(saved, /^## 八旗与包衣$/m);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.chapters.map((chapter) => chapter.title), [
      "封面", "前言", "第一章 内务府", "第二章 北京与苏州，诗歌与社交", "附录一 原丝的价格", "参考书目",
    ]);
    assert.ok(manifest.nav.some((item) => item.title === "八旗与包衣" && item.level === 2));
    assert.ok(manifest.nav.some((item) => item.title === "第一章 内务府" && item.level === 1));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPolishBundle loads the whole book and session", () => {
  const { root, manifestPath, markdown } = fixture();
  try {
    const bundle = readPolishBundle(manifestPath);
    assert.equal(bundle.manifest.book.title, "测试书");
    assert.equal(bundle.markdown, markdown);
    assert.equal(bundle.session.ui.selectedPointId, "point-001");
    assert.equal(bundle.session.files.markdownHash, bundle.hash);
    assert.equal(bundle.markdownChanged, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forgetPolishNote removes the note, its markers and report point", () => {
  const { root, manifestPath } = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.markers = [{ id: "marker-001", noteId: "note-001" }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    // 真实删除流程会先删掉 polish.md 里的注文；forgetPolishNote 只做清单清理。
    fs.writeFileSync(path.join(path.dirname(manifestPath), "polish.md"), "# 测试书\n\n## 第一章\n\n正文。\n", "utf8");
    forgetPolishNote(manifestPath, "note-001");
    const bundle = readPolishBundle(manifestPath);
    assert.deepEqual(bundle.manifest.notes, []);
    assert.deepEqual(bundle.manifest.markers, []);
    assert.deepEqual(bundle.report.points, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishSession updates progress from point statuses", () => {
  const { root, manifestPath } = fixture();
  try {
    const session = savePolishSession(manifestPath, {
      pointStatus: { "point-001": { status: "resolved", updatedAt: "2026-01-01T00:00:00Z" } },
      ui: { filter: "done" },
    });
    assert.equal(session.progress.reviewed, 1);
    assert.equal(session.progress.remaining, 0);
    assert.equal(session.ui.filter, "done");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishMarkdown updates hash and detects external edits", () => {
  const { root, manifestPath } = fixture();
  try {
    const saved = savePolishMarkdown(manifestPath, "# 测试书\n\n## 第一章\n\n改了。\n");
    assert.match(saved.hash, /^[a-f0-9]{64}$/);
    const bundle = readPolishBundle(manifestPath);
    assert.equal(bundle.session.files.markdownHash, saved.hash);
    assert.equal(bundle.markdownChanged, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishMarkdown drops a correction point after the note is linked", () => {
  const { root, manifestPath, markdown } = fixture();
  try {
    const linked = markdown.replace(
      "<!-- polish:note note-001",
      "正文 <sup>㉞</sup><!-- polish:marker marker-001 chapter=ch-001 label=\"㉞\" note=note-001 -->\n\n<!-- polish:note note-001",
    );
    const saved = savePolishMarkdown(manifestPath, linked);
    assert.deepEqual(saved.report.points, []);
    const bundle = readPolishBundle(manifestPath);
    assert.deepEqual(bundle.report.points, []);
    assert.equal(bundle.report.summary.needsReview, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("revertPolishMarkdown restores the baseline and clears point status", () => {
  const { root, manifestPath, markdown } = fixture();
  try {
    savePolishMarkdown(manifestPath, "# 测试书\n\n## 第一章\n\n临时修改。\n");
    savePolishSession(manifestPath, { pointStatus: { "point-001": { status: "ignored" } } });
    revertPolishMarkdown(manifestPath);
    const bundle = readPolishBundle(manifestPath);
    assert.equal(bundle.markdown, markdown);
    assert.deepEqual(bundle.session.pointStatus, {});
    assert.equal(bundle.report.points[0].status, "open");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importPolishNotes copies corrected note text from the latest backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-polish-import-"));
  try {
    const dir = path.join(root, "work", "book-1", "polish");
    const backupDir = path.join(dir, "backup-20260101T000000");
    fs.mkdirSync(backupDir, { recursive: true });
    const manifestPath = path.join(dir, "polish.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    const newMarkdown = [
      "# 测试书",
      "",
      "## 第一章",
      "",
      '<!-- polish:note note-001 chapter=ch-001 page=0 label="1" linked=true alignment=ordinal group="第一章" -->',
      "1、新注，OCR。",
      "",
    ].join("\n");
    const oldMarkdown = newMarkdown.replace("1、新注，OCR。", "1、旧注，已校对。");
    fs.writeFileSync(path.join(dir, "polish.md"), newMarkdown, "utf8");
    fs.writeFileSync(path.join(backupDir, "polish.md"), oldMarkdown, "utf8");
    const result = importPolishNotes(manifestPath, newMarkdown);
    assert.equal(result.ok, true);
    assert.equal(result.updates, 1);
    assert.match(result.markdown, /旧注，已校对/);
    assert.doesNotMatch(result.markdown, /新注，OCR/);
    assert.match(result.backupPath, /backup-20260101T000000/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishInfo updates book metadata and merges cover settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-polish-info-"));
  try {
    const dir = path.join(root, "work", "book-1", "polish");
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "polish.json");
    const markdown = "# 书\n\n## 第一章\n\n<!-- polish:note note-001 chapter=ch-001 label=\"1\" -->\n1、注文。\n";
    fs.writeFileSync(path.join(dir, "polish.md"), markdown, "utf8");
    fs.writeFileSync(path.join(dir, "polish.baseline.md"), markdown, "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      book: { title: "旧书名", author: "旧作者", language: "zh" },
      build: { title: "旧书名", author: "旧作者", language: "zh", out: "C:/old.epub", cover: { mode: "template", palette: "warm" } },
      chapters: [{ id: "ch-001", title: "第一章" }],
      notes: [{ id: "note-001", label: "1" }],
    }), "utf8");
    const bundle = savePolishInfo(manifestPath, {
      title: "新书名",
      author: "新作者",
      language: "en",
      identifier: "urn:isbn:9780000000000",
      cover: { mode: "image", imagePath: "C:/cover.jpg", fit: "cover" },
    });
    assert.equal(bundle.manifest.book.title, "新书名");
    assert.equal(bundle.manifest.book.author, "新作者");
    assert.equal(bundle.manifest.book.language, "en");
    assert.equal(bundle.manifest.build.title, "新书名");
    assert.equal(bundle.manifest.build.identifier, "urn:isbn:9780000000000");
    assert.deepEqual(bundle.manifest.build.cover, {
      mode: "image",
      palette: "warm",
      imagePath: "C:/cover.jpg",
      fit: "cover",
    });
    assert.equal(bundle.markdown, markdown, "metadata save must not touch the Markdown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishInfo repairs a legacy template cover that kept an image path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-polish-cover-"));
  try {
    const dir = path.join(root, "work", "book-1", "polish");
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "polish.json");
    const markdown = "# 书\n\n## 第一章\n\n正文。\n";
    fs.writeFileSync(path.join(dir, "polish.md"), markdown, "utf8");
    fs.writeFileSync(path.join(dir, "polish.baseline.md"), markdown, "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      book: { title: "书" },
      build: {
        title: "书",
        out: "C:/old.epub",
        cover: { mode: "template", imagePath: "D:/Pictures/安妮封面.png", palette: "warm", fit: "contain" },
      },
    }), "utf8");

    const repaired = savePolishInfo(manifestPath, {
      cover: { mode: "template", imagePath: "D:/Pictures/安妮封面.png", palette: "warm", fit: "contain" },
    });
    assert.equal(repaired.manifest.build.cover.mode, "image");
    assert.equal(repaired.manifest.build.cover.imagePath, "D:/Pictures/安妮封面.png");

    const explicitTemplate = savePolishInfo(manifestPath, {
      cover: { mode: "template", imagePath: "D:/Pictures/安妮封面.png" },
      coverModeExplicit: true,
    });
    assert.equal(explicitTemplate.manifest.build.cover.mode, "template");
    assert.equal(explicitTemplate.manifest.build.cover.imagePath, "", "an explicit template choice must not keep an unused image path");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("savePolishSession keeps the redesigned workspace UI state", () => {
  const { root, manifestPath } = fixture();
  try {
    savePolishSession(manifestPath, {
      ui: { filter: "notes", sideTab: "inspect", tocOpen: false, tocDepth: 3, hideComments: false },
    });
    const bundle = readPolishBundle(manifestPath);
    assert.equal(bundle.session.ui.filter, "notes");
    assert.equal(bundle.session.ui.sideTab, "inspect");
    assert.equal(bundle.session.ui.tocOpen, false);
    assert.equal(bundle.session.ui.tocDepth, 3);
    assert.equal(bundle.session.ui.hideComments, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePolishAsset turns relative preview images into file URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-polish-asset-"));
  try {
    const dir = path.join(root, "work", "book-1", "polish");
    const images = path.join(root, "extract", "mineru", "images");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, "page_0_image_0.jpg"), "jpg", "utf8");
    const manifestPath = path.join(dir, "polish.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      build: { baseDir: path.join(root, "extract") },
    }), "utf8");
    const resolved = resolvePolishAsset(manifestPath, "mineru/images/page_0_image_0.jpg");
    assert.match(resolved, /^file:\/\//);
    assert.match(resolved, /page_0_image_0\.jpg$/);
    assert.equal(resolvePolishAsset(manifestPath, "mineru/images/missing.jpg"), "");
    assert.equal(resolvePolishAsset(manifestPath, "https://example.com/a.jpg"), "https://example.com/a.jpg");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("polishWorkspaceDir only accepts a polish bundle directory", () => {
  const { root, dir, manifestPath } = fixture();
  try {
    assert.equal(polishWorkspaceDir(manifestPath), dir);
    assert.throws(() => polishWorkspaceDir(path.join(root, "not-polish.json")), /路径无效/);
    assert.throws(() => polishWorkspaceDir(path.join(root, "other", "polish.json")), /不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectPolishImport recognises a snapshot from the same build", () => {
  const { root, manifestPath, markdown } = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.build = { source: "D:/books/a.pdf" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const target = path.join(root, "same-book.md");
    copyPolishMarkdown(manifestPath, target, markdown.replace("1页", "1页（校对）"));
    const inspection = inspectPolishImport(manifestPath, target);
    assert.equal(inspection.ok, true);
    assert.equal(inspection.sameBook, true);
    assert.equal(inspection.confidence, "same");
    assert.equal(inspection.stats.notes, 1);
    const result = importPolishMarkdown(manifestPath, target, { force: false });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    assert.match(result.bundle.markdown, /1页（校对）/);
    assert.deepEqual(result.bundle.session.pointStatus, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importPolishMarkdown refuses another book unless forced", () => {
  const { root, manifestPath } = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.build = { source: "D:/books/a.pdf" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const other = path.join(root, "other-book.md");
    const otherMarkdown = [
      "# 另一本书",
      "",
      "## 完全不同的章节",
      "",
      "<!-- polish:note note-900 chapter=ch-900 page=1 label=\"1\" linked=false -->",
      "1、另一本书的注文。",
      "",
    ].join("\n");
    fs.writeFileSync(other, otherMarkdown, "utf8");
    const inspection = inspectPolishImport(manifestPath, other);
    assert.equal(inspection.ok, true);
    assert.equal(inspection.sameBook, false);
    const blocked = importPolishMarkdown(manifestPath, other, { force: false });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.needsForce, true);
    const forced = importPolishMarkdown(manifestPath, other, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.bundle.markdown, otherMarkdown);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validatePolishStructure catches missing notes and chapter changes", () => {
  const { root, manifestPath } = fixture();
  try {
    const ok = validatePolishStructure(manifestPath, [
      "# 测试书",
      "",
      "## 第一章",
      "",
      "<!-- polish:note note-001 page=52 label=\"㉞\" linked=true -->",
      "㉞ 《测试资料》，1页。",
    ].join("\n"));
    assert.equal(ok.ok, true);
    assert.equal(ok.split.chapters.length, 1);

    const missing = validatePolishStructure(manifestPath, "# 测试书\n\n## 第一章\n\n正文。\n");
    assert.equal(missing.ok, true, "a manually removed note stops blocking the rebuild");
    assert.deepEqual(missing.missingNotes, ["note-001"]);
    assert.match(missing.warnings.join("；"), /1 个注文已不在 polish.md/);

    const extraChapter = validatePolishStructure(manifestPath, [
      "# 测试书",
      "",
      "## 第一章",
      "<!-- polish:note note-001 page=52 label=\"㉞\" linked=true -->",
      "㉞ 《测试资料》，1页。",
      "",
      "## 第二章",
      "更多。",
    ].join("\n"));
    assert.equal(extraChapter.ok, true);
    assert.match(extraChapter.warnings.join("；"), /章节数从 1 变成 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validatePolishStructure does not treat live points as missing comments", () => {
  const { root, manifestPath } = fixture();
  try {
    fs.writeFileSync(path.join(path.dirname(manifestPath), "polish-report.json"), JSON.stringify({
      schemaVersion: 1,
      summary: { needsReview: 1 },
      points: [{ id: "point-live-unlinked-note-001", kind: "note-unlinked", noteId: "note-001" }],
    }, null, 2), "utf8");
    const result = validatePolishStructure(manifestPath, fs.readFileSync(path.join(path.dirname(manifestPath), "polish.md"), "utf8"));
    assert.deepEqual(result.missingPoints, []);
    assert.doesNotMatch(result.warnings.join("；"), /修正点注释已被删除/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listPolishBundles finds recent sessions under the cache root", () => {
  const { root, manifestPath } = fixture();
  try {
    const items = listPolishBundles(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].manifestPath, manifestPath);
    assert.equal(items[0].title, "测试书");
    assert.equal(items[0].remaining, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listPolishBundles reports live review counts from the current markdown", () => {
  const { root, manifestPath, markdown } = fixture();
  try {
    fs.writeFileSync(
      path.join(path.dirname(manifestPath), "polish.md"),
      markdown.replace(
        "<!-- polish:note note-001",
        "正文 <sup>㉞</sup><!-- polish:marker marker-001 chapter=ch-001 label=\"㉞\" note=note-001 -->\n\n<!-- polish:note note-001",
      ),
      "utf8",
    );
    const items = listPolishBundles(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].needsReview, 0);
    assert.equal(items[0].remaining, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPolishBundleForSource matches the absolute build source and copies markdown", () => {
  const { root, dir, manifestPath } = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.build = { source: "D:/books/a.pdf" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const found = findPolishBundleForSource(root, "a.pdf", "D:/books");
    assert.equal(found?.manifestPath, manifestPath);
    assert.equal(findPolishBundleForSource(root, "b.pdf", "D:/books"), null);

    const target = path.join(dir, "copy.md");
    copyPolishMarkdown(manifestPath, target);
    const copied = fs.readFileSync(target, "utf8");
    assert.match(copied, /^<!-- polish:snapshot [A-Za-z0-9+/=]+ -->/);
    const snapshot = parsePolishSnapshot(copied);
    assert.equal(snapshot.markdown, fs.readFileSync(path.join(dir, "polish.md"), "utf8"));
    assert.equal(snapshot.info?.kind, "uvreader-polish");
    assert.equal(snapshot.info?.buildId, "build-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

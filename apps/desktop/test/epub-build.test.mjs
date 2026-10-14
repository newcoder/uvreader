import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { BOOK_STYLE_DEFAULTS, buildEpub, buildNav, buildNcx, normalizeBookStyles, renderBookCss } from "../src/main/epub-build.js";

const chapter = (title, html) => ({ title, html });

test("normalizeBookStyles clamps user input", () => {
  const styles = normalizeBookStyles({ fontSize: 99, lineHeight: 0.5, margin: -3, indent: 9, align: "center", theme: "nope" });
  assert.equal(styles.fontSize, 28);
  assert.equal(styles.lineHeight, 1.2);
  assert.equal(styles.margin, 0);
  assert.equal(styles.indent, 4);
  assert.equal(styles.align, "justify", "unknown alignments fall back to justify");
  assert.equal(styles.theme, "follow");
  assert.equal(normalizeBookStyles({}).fontSize, BOOK_STYLE_DEFAULTS.fontSize);
});

test("renderBookCss emits a single-column reflow stylesheet", () => {
  const css = renderBookCss({ fontSize: 18, lineHeight: 1.8, margin: 6, indent: 2, theme: "warm" });
  assert.match(css, /body \{[\s\S]*font-size: 18px/);
  assert.match(css, /line-height: 1\.8/);
  assert.match(css, /margin: 6%/);
  assert.match(css, /text-indent: 2em/);
  assert.match(css, /background: #faf6ef/, "the warm theme sets paper colours");
  assert.match(css, /img \{ max-width: 100%/);
  const followed = renderBookCss({ theme: "follow" });
  assert.ok(!/background: #/.test(followed.split("body")[0]), "the follow theme leaves colours to the reader");
  const withFaces = renderBookCss({}, { fontFaces: [{ family: "QBR Wenkai", src: "fonts/wenkai.ttf" }] });
  assert.match(withFaces, /@font-face \{ font-family: 'QBR Wenkai'; src: url\('fonts\/wenkai\.ttf'\)/);
});

test("buildNcx numbers the reading order", () => {
  const ncx = buildNcx([{ title: "一", file: "chapter-001.xhtml" }, { title: "二", file: "chapter-002.xhtml" }], { title: "书", identifier: "urn:x" });
  assert.match(ncx, /navPoint id="navPoint-1" playOrder="1"[\s\S]*<text>一<\/text>/);
  assert.match(ncx, /navPoint id="navPoint-2" playOrder="2"/);
  assert.match(ncx, /dtb:uid" content="urn:x"/);
});

test("buildEpub writes a valid reflowable EPUB with chapters, nav and cover", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-epub-"));
  const out = path.join(dir, "书.epub");
  const cover = Buffer.from("fake-jpeg");
  const result = await buildEpub({
    book: { title: "测试书", author: "作者", language: "zh", identifier: "urn:test:1", modified: "2026-10-12T00:00:00Z" },
    styles: { theme: "paper" },
    chapters: [chapter("第一章", "<p>正文一</p>"), chapter("第二章", "<p>正文二</p>")],
    cover: { data: cover, fileName: "cover.jpg" },
    colophon: "由 UV Reader 生成",
  }, out);
  assert.equal(result.chapters, 2);
  assert.equal(result.hasCover, true);
  assert.ok(fs.existsSync(out));

  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const names = Object.keys(zip.files);
  assert.equal(names[0], "mimetype", "mimetype must be the first entry (stored)");
  assert.equal(await zip.file("mimetype").async("string"), "application/epub+zip");
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title>测试书<\/dc:title>/);
  assert.match(opf, /<dc:creator>作者<\/dc:creator>/);
  assert.match(opf, /<dc:identifier id="bookid">urn:test:1<\/dc:identifier>/);
  assert.match(opf, /<meta property="dcterms:modified">2026-10-12T00:00:00Z<\/meta>/);
  assert.match(opf, /properties="nav"/);
  assert.match(opf, /<item id="cover" href="cover.xhtml"/);
  assert.match(opf, /<itemref idref="chapter-1"\/>/);
  assert.match(opf, /<itemref idref="chapter-2"\/>/);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /<a href="chapter-001.xhtml">第一章<\/a>/);
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /<title>第一章<\/title>/);
  assert.match(first, /<p>正文一<\/p>/);
  assert.ok(zip.file("OEBPS/images/cover.jpg"), "the cover lands in images/");
  assert.match(await zip.file("OEBPS/cover.xhtml").async("string"), /<img src="images\/cover\.jpg"/);
  assert.match(await zip.file("OEBPS/colophon.xhtml").async("string"), /由 UV Reader 生成/);
});

test("buildEpub embeds font files with their licenses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-epub-fonts-"));
  const out = path.join(dir, "fonts.epub");
  await buildEpub({
    book: { title: "字体书" },
    styles: {},
    chapters: [chapter("一", "<p>字</p>")],
    fonts: [{ fileName: "qbr-wenkai.ttf", family: "QBR Wenkai", data: Buffer.from("ttf"), licenseText: "SIL OFL 1.1 文本", licenseName: "SIL OFL 1.1" }],
  }, out);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<item id="font-1" href="fonts\/qbr-wenkai\.ttf" media-type="font\/ttf"\/>/);
  const css = await zip.file("OEBPS/styles.css").async("string");
  assert.match(css, /@font-face \{ font-family: 'QBR Wenkai'; src: url\('fonts\/qbr-wenkai\.ttf'\)/);
  const licenses = Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/OFL-"));
  assert.equal(licenses.length, 1);
  assert.equal(await zip.file(licenses[0]).async("string"), "SIL OFL 1.1 文本");
  assert.match(await zip.file("OEBPS/colophon.xhtml").async("string"), /字体许可/);
});

test("buildEpub refuses empty chapters", async () => {
  await assert.rejects(buildEpub({ book: { title: "空" }, chapters: [] }, ""), /没有章节可写/);
});

test("the chapter title is written into the body, not just the nav", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbr-epub-title-")), "t.epub");
  await buildEpub({
    book: { title: "测试书", language: "zh" },
    chapters: [chapter("集合论的一种公理化 ①", "<p>正文一。</p>"), chapter("", "<p>没有标题的一章。</p>")],
    fonts: [],
  }, out);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /<h1 class="chapter-title">集合论的一种公理化 ①<\/h1>/, "标题要在正文里");
  assert.match(first, /<p>正文一。<\/p>/);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /集合论的一种公理化 ①/);
  const second = await zip.file("OEBPS/chapter-002.xhtml").async("string");
  assert.match(second, /<h1 class="chapter-title">第 2 章<\/h1>/, "没有标题的章节用「第 N 章」占位(与导航一致)");
});

test("buildNav nests levels instead of flattening them", () => {
  const nav = buildNav([
    { title: "第一章", file: "chapter-001.xhtml", level: 1 },
    { title: "1.1 小节", file: "chapter-002.xhtml", level: 2 },
    { title: "第二章", file: "chapter-003.xhtml", level: 1 },
  ]);
  assert.match(nav, /<li><a href="chapter-001\.xhtml">第一章<\/a><\/li>/);
  assert.match(nav, /<ol>\s*<li><a href="chapter-002\.xhtml">1\.1 小节<\/a><\/li>\s*<\/ol>/, "二级条目嵌在 <ol> 里");
  assert.equal((nav.match(/<ol>/g) || []).length, 2, "外层 + 一层嵌套");
  const ncx = buildNcx([
    { title: "第一章", file: "chapter-001.xhtml", level: 1 },
    { title: "1.1 小节", file: "chapter-002.xhtml", level: 2 },
  ], { title: "书", identifier: "urn:x" });
  assert.equal((ncx.match(/<navPoint/g) || []).length, 4, "NCX 也要有分组与条目");
});

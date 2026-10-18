import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";
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
  assert.ok(!/@font-face/.test(renderBookCss({})), "字体不再嵌入:样式里没有 @font-face");
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
  assert.ok(!/<itemref idref="nav"/.test(opf), "目录文档不进 spine(否则会被全文搜索当成正文)");
  assert.match(opf, /<item id="nav" href="nav\.xhtml" media-type="application\/xhtml\+xml" properties="nav"\/>/, "但仍在 manifest 里声名 nav");
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /<a href="chapter-001.xhtml">第一章<\/a>/);
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /<title>第一章<\/title>/);
  assert.match(first, /<p>正文一<\/p>/);
  assert.ok(zip.file("OEBPS/images/cover.jpg"), "the cover lands in images/");
  assert.match(await zip.file("OEBPS/cover.xhtml").async("string"), /<img src="images\/cover\.jpg"/);
  assert.match(await zip.file("OEBPS/colophon.xhtml").async("string"), /由 UV Reader 生成/);
});

test("buildEpub ignores font payloads (fonts are no longer embedded)", async () => {
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
  assert.ok(!/media-type="font\//.test(opf), "成品里没有字体条目");
  assert.ok(!/@font-face/.test(await zip.file("OEBPS/styles.css").async("string")), "样式里没有 @font-face");
  assert.equal(Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/")).length, 0);
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

test("buildNav nests levels the way readers parse them (li > ol)", () => {
  const nav = buildNav([
    { title: "第一章", file: "chapter-001.xhtml", level: 1 },
    { title: "1.1 小节", file: "chapter-002.xhtml", level: 2 },
    { title: "1.1.1 细节", file: "chapter-003.xhtml", level: 3 },
    { title: "1.2 又一小节", file: "chapter-004.xhtml", level: 2 },
    { title: "第二章", file: "chapter-005.xhtml", level: 1 },
  ]);
  const dom = new JSDOM(nav, { contentType: "application/xhtml+xml" });
  const doc = dom.window.document;
  const toc = doc.querySelector("nav");
  assert.equal(toc?.getAttributeNS("http://www.idpf.org/2007/ops", "type"), "toc", "目录写在 nav[epub:type=toc] 里");
  const top = toc.querySelector("ol");
  assert.equal(top?.parentElement?.localName, "nav", "最外层 <ol> 直接挂在 nav 下");
  for (const list of toc.querySelectorAll("ol ol")) {
    const parent = list.parentElement;
    assert.equal(parent?.localName, "li", `子级 <ol> 必须套在 <li> 里(实际父节点:${parent?.localName})`);
  }
  // 跟 foliate 的 parseNav 一样走一遍:$ol 的直接 li 孩子 + li 里那个 ol 的直接 li 孩子。
  const readList = (list) => [...list.querySelectorAll(":scope > li")].map((li) => ({
    label: li.querySelector(":scope > a")?.textContent || "",
    subitems: (() => {
      const inner = li.querySelector(":scope > ol");
      return inner ? readList(inner) : [];
    })(),
  }));
  const tree = readList(toc.querySelector("ol"));
  assert.deepEqual(tree.map((node) => node.label), ["第一章", "第二章"]);
  assert.deepEqual(tree[0].subitems.map((node) => node.label), ["1.1 小节", "1.2 又一小节"]);
  assert.deepEqual(tree[0].subitems[0].subitems.map((node) => node.label), ["1.1.1 细节"], "三级也读得到");
  assert.equal(tree[1].subitems.length, 0);
  const ncx = buildNcx([
    { title: "第一章", file: "chapter-001.xhtml", level: 1 },
    { title: "1.1 小节", file: "chapter-002.xhtml", level: 2 },
    { title: "第二章", file: "chapter-003.xhtml", level: 1 },
  ], { title: "书", identifier: "urn:x" });
  const ncxDom = new JSDOM(ncx, { contentType: "text/xml" });
  const points = [...ncxDom.window.document.querySelectorAll("navPoint")];
  assert.equal(points.length, 3, "每个条目一个 navPoint(不再有没标签的分组节点)");
  const first = ncxDom.window.document.querySelector("navPoint");
  assert.equal(first.querySelector("navLabel text")?.textContent, "第一章");
  assert.equal(first.querySelector(":scope > navPoint navLabel text")?.textContent, "1.1 小节", "子级嵌在父条目的 navPoint 里");
});

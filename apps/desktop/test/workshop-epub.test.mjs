import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { countRawFormulas } from "../src/main/text-book.js";
import { normalizeBookChapters, registerEpubRunners } from "../src/main/workshop-epub.js";
import { waitForTask } from "./wait-for-task.mjs";

function tempDir(prefix = "qbr-epub-run-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

function makeQueue(cacheRoot, _subsetter, extra = {}) {
  const dir = tempDir("qbr-epub-queue-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot, log: () => {}, ...extra });
  return { queue, dir };
}

async function writePoemEpub(file) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:poems</dc:identifier>
    <dc:title>漢語詩</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="pixel" href="images/pixel.png" media-type="image/png"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">漢詩</a></li>
  <li><a href="ch2.xhtml">學習</a></li>
</ol></nav></body></html>`);
  zip.file("OEBPS/style.css", 'p { line-height: 2; }\nbody { background-image: url("images/pixel.png"); }');
  zip.file("OEBPS/images/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  zip.file("OEBPS/ch1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><head><title>第五章</title></head><body><p>第五章</p><p>漢詩<br/>國家</p><img src="images/pixel.png" alt="pixel"/></body></html>`);
  zip.file("OEBPS/ch2.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><body><p>學習<br/>發展</p><ul><li>閱讀<br/>寫作</li></ul><table><tr><td>國家</td></tr></table></body></html>`);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(file, data);
  return data;
}

test("direct EPUB bilingual translation keeps the original chapter files and line breaks", async () => {
  const vault = tempDir("qbr-epub-translate-direct-");
  const source = path.join(vault, "poems.epub");
  const sourceBytes = await writePoemEpub(source);
  const aiRuntime = {
    stream: async () => ({
      ok: true,
      answer: JSON.stringify({ translations: [
        { id: "c0-b1", text: "第五章" },
        { id: "c0-b2", text: "Chinese poem\ncountry" },
        { id: "c1-b1", text: "study\ndevelopment" },
        { id: "c1-b2", text: "reading\nwriting" },
        { id: "c1-b3", text: "country" },
      ] }),
    }),
  };
  const { queue } = makeQueue(tempDir("qbr-epub-translate-direct-cache-"), null, { aiRuntime });
  const base = {
    source,
    settings: {},
    translation: {
      direction: "auto",
      mode: "stacked",
      config: { id: "test", base: "http://local", model: "test", key: "" },
    },
  };
  const task = await waitForTask(queue, queue.start({ kind: "book-build", title: "生成中英对照", payload: base }));
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /原格式/);
  assert.match(task.detail, /2 节/);
  assert.match(task.detail, /双语 5 段/);
  assert.match(task.output.replace(/\\/g, "/"), /poems（中英对照）\.epub$/);
  assert.deepEqual(fs.readFileSync(source), sourceBytes, "the source EPUB is left untouched");

  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  assert.ok(zip.file("OEBPS/ch1.xhtml"));
  assert.ok(!zip.file("OEBPS/chapter-001.xhtml"));
  const ch1 = await zip.file("OEBPS/ch1.xhtml").async("string");
  assert.match(ch1, /<p[^>]*>漢詩<br\/>國家<\/p>/);
  assert.match(ch1, /<p>第五章<\/p>/);
  assert.ok(!ch1.includes('class="qbr-epub-title-translation"'), "an unchanged chapter title is shown once");
  assert.match(ch1, /class="qbr-epub-translation"[^>]*>Chinese poem<br\/>country</);
  assert.match(ch1, /qbr-epub-translation/);
  const ch2 = await zip.file("OEBPS/ch2.xhtml").async("string");
  assert.match(ch2, /<li>閱讀<br\/>寫作<div class="qbr-epub-translation"[^>]*>reading<br\/>writing<\/div><\/li>/);
  assert.match(ch2, /<td>國家<div class="qbr-epub-translation"[^>]*>country<\/div><\/td>/);
  assert.match(await zip.file("OEBPS/nav.xhtml").async("string"), /漢詩/);
  assert.equal(await zip.file("OEBPS/style.css").async("string"), 'p { line-height: 2; }\nbody { background-image: url("images/pixel.png"); }');
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title>漢語詩（中英对照）<\/dc:title>/);
  assert.match(opf, /<dc:language>zh<\/dc:language>/);

  const side = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成左右对照",
    payload: { ...base, translation: { ...base.translation, mode: "side" } },
  }));
  assert.equal(side.status, "done", side.error);
  const sideZip = await JSZip.loadAsync(fs.readFileSync(side.output));
  const sideChapter = await sideZip.file("OEBPS/ch1.xhtml").async("string");
  assert.match(sideChapter, /class="qbr-epub-pair"/);
  assert.match(sideChapter, /class="qbr-epub-translation"/);

  const translatedOnly = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成译文电子书",
    payload: { ...base, translation: { ...base.translation, mode: "translated" } },
  }));
  assert.equal(translatedOnly.status, "done", translatedOnly.error);
  assert.match(translatedOnly.detail, /译文/);
  assert.match(translatedOnly.output.replace(/\\/g, "/"), /poems（English）\.epub$/);
  const translatedZip = await JSZip.loadAsync(fs.readFileSync(translatedOnly.output));
  const translatedChapter = await translatedZip.file("OEBPS/ch1.xhtml").async("string");
  assert.match(translatedChapter, /<p>Chinese poem<br\/>country<\/p>/);
  assert.ok(!translatedChapter.includes("漢詩"), "the source text is replaced in translation-only mode");
  const translatedOpf = await translatedZip.file("OEBPS/content.opf").async("string");
  assert.match(translatedOpf, /<dc:title>漢語詩（English）<\/dc:title>/);
  assert.match(translatedOpf, /<dc:language>en<\/dc:language>/);

  const preview = await waitForTask(queue, queue.start({
    kind: "book-preview",
    title: "试译开头",
    payload: {
      source,
      title: "",
      translation: base.translation,
    },
  }));
  assert.equal(preview.status, "done", preview.error);
  assert.equal(preview.output, "", "preview is ephemeral and does not create a book file");
  assert.match(preview.result.previewHtml, /<p>第五章<\/p>/);
  assert.match(preview.result.previewHtml, /class="qbr-epub-translation"/);
  assert.ok(!preview.result.previewHtml.includes('class="qbr-epub-title-translation"'));
  assert.match(preview.result.previewHtml, /data:image\/png;base64,/);
  assert.doesNotMatch(preview.result.previewHtml, /src="images\/pixel\.png"/);
  assert.match(preview.result.previewHtml, /background-image:\s*url\("data:image\/png;base64,/);
  assert.match(preview.detail, /试译 · 中文 → English/);
  assert.equal(preview.result.previewFiles, 2);

  const previewSide = await waitForTask(queue, queue.start({
    kind: "book-preview",
    title: "试译开头",
    payload: {
      source,
      title: "",
      translation: { ...base.translation, mode: "side", target: "de" },
    },
  }));
  assert.equal(previewSide.status, "done", previewSide.error);
  assert.match(previewSide.result.previewHtml, /class="qbr-epub-pair"/);
  assert.equal(previewSide.result.pair.id, "zh-de");
  assert.match(previewSide.detail, /试译 · 中文 → Deutsch/);
});

test("the book-build runner turns a txt into a readable EPUB", async () => {
  const vault = tempDir("qbr-epub-vault-");
  const source = path.join(vault, "我的小说.txt");
  fs.writeFileSync(source, "第一章 起风了\n\n第一段正文。\n\n第二章 雨\n\n第二段正文。", "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-cache-"), null);
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, styles: { indent: 3 }, tocTitle: "章节" },
  });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  const out = path.join(vault, "我的小说.epub");
  assert.equal(task.output.replace(/\\/g, "/"), out.replace(/\\/g, "/"));
  assert.ok(fs.existsSync(task.output));
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title>我的小说<\/dc:title>/);
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /<h1>章节<\/h1>/);
  assert.match(nav, /第一章 起风了/);
  const css = await zip.file("OEBPS/styles.css").async("string");
  assert.match(css, /text-indent: 3em/, "the panel's indent reached the stylesheet");
  assert.match(task.detail, /EPUB · 2 章/);
});

test("the book-build runner creates stacked and side-by-side bilingual chapters", async () => {
  const vault = tempDir("qbr-epub-bilingual-");
  const source = path.join(vault, "bilingual.txt");
  fs.writeFileSync(source, "unused", "utf8");
  const aiRequests = [];
  const aiRuntime = {
    stream: async (request) => {
      aiRequests.push(request);
      return {
        ok: true,
        answer: JSON.stringify({ translations: [
          { id: "c0-title", text: "第一章" },
          { id: "c0-b1", text: "你好。" },
          { id: "c0-b2", text: "世界。" },
        ] }),
      };
    },
  };
  const { queue } = makeQueue(tempDir("qbr-epub-bilingual-cache-"), null, { aiRuntime });
  const base = {
    source,
    settings: {},
    chapters: [{ title: "Chapter One", text: "Hello.\n\nWorld." }],
    translation: {
      direction: "en-zh",
      mode: "stacked",
      config: { id: "test", base: "http://local", model: "test", key: "" },
    },
  };
  const first = await waitForTask(queue, queue.start({ kind: "book-build", title: "生成双语电子书", payload: base }));
  assert.equal(first.status, "done", first.error);
  assert.match(first.output.replace(/\\/g, "/"), /bilingual（中英对照）\.epub$/);
  const firstZip = await JSZip.loadAsync(fs.readFileSync(first.output));
  const firstChapter = await firstZip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(firstChapter, /class="qbr-pair"/);
  assert.match(firstChapter, /Hello\./);
  assert.match(firstChapter, /你好。/);
  assert.match(firstChapter, /lang="en"/);
  assert.match(firstChapter, /lang="zh-Hans"/);
  assert.match(first.detail, /双语 3 段/);
  assert.match(firstChapter, /class="qbr-title-translation"/);

  const second = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成双语电子书",
    payload: { ...base, translation: { ...base.translation, mode: "side" } },
  }));
  assert.equal(second.status, "done", second.error);
  const secondZip = await JSZip.loadAsync(fs.readFileSync(second.output));
  const secondChapter = await secondZip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(secondChapter, /<body class="qbr-book-side">/);

  const third = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成译文电子书",
    payload: { ...base, translation: { ...base.translation, mode: "translated" } },
  }));
  assert.equal(third.status, "done", third.error);
  assert.match(third.output.replace(/\\/g, "/"), /bilingual（中文）\.epub$/);
  const thirdZip = await JSZip.loadAsync(fs.readFileSync(third.output));
  const thirdChapter = await thirdZip.file("OEBPS/chapter-001.xhtml").async("string");
  const thirdOpf = await thirdZip.file("OEBPS/content.opf").async("string");
  assert.match(thirdChapter, /<h1 class="chapter-title">第一章<\/h1>/);
  assert.ok(!thirdChapter.includes('class="qbr-pair"'), "translation-only output has no source/translation pairs");
  assert.ok(!thirdChapter.includes("Hello."), "translation-only output omits the source body");
  assert.match(thirdChapter, /你好。/);
  assert.match(thirdOpf, /<dc:title>bilingual（中文）<\/dc:title>/);
  assert.match(third.detail, /译文 3 段/);

  const automatic = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "自动识别语言",
    payload: { ...base, translation: { ...base.translation, direction: "auto", mode: "stacked" } },
  }));
  assert.equal(automatic.status, "done", automatic.error);
  assert.match(automatic.detail, /English → 简体中文/);
  assert.match(automatic.output.replace(/\\/g, "/"), /bilingual（中英对照）.*\.epub$/);
  assert.match(JSON.stringify(aiRequests.at(-1).messages), /目标语言：简体中文/);

  const chinese = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "自动识别中文",
    payload: {
      ...base,
      chapters: [{ title: "第一章", text: "今天天气很好。\n\n我们去看书。" }],
      translation: { ...base.translation, direction: "auto", mode: "stacked", classical: false },
    },
  }));
  assert.equal(chinese.status, "done", chinese.error);
  assert.match(chinese.detail, /中文 → English/);
  assert.match(chinese.output.replace(/\\/g, "/"), /bilingual（中英对照）.*\.epub$/);
  assert.match(JSON.stringify(aiRequests.at(-1).messages), /目标语言：English/);

  const classical = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "自动识别文言文",
    payload: {
      ...base,
      chapters: [{ title: "学而", text: "学而时习之，不亦说乎？" }],
      translation: { ...base.translation, direction: "auto", mode: "stacked", classical: true },
    },
  }));
  assert.equal(classical.status, "done", classical.error);
  assert.match(classical.detail, /文言文 → 现代中文/);
  assert.match(classical.output.replace(/\\/g, "/"), /bilingual（文白对照）.*\.epub$/);
  assert.match(JSON.stringify(aiRequests.at(-1).messages), /目标语言：现代中文/);

  const classicalWithLicense = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "文言文与英文版权页",
    payload: {
      ...base,
      chapters: [{
        title: "道德经",
        text: [
          "The Project Gutenberg eBook of this ebook is for the use of anyone anywhere at no cost.",
          "",
          "道可道，非常道。名可名，非常名。",
        ].join("\n"),
      }],
      translation: { ...base.translation, direction: "auto", mode: "stacked", classical: true },
    },
  }));
  assert.equal(classicalWithLicense.status, "done", classicalWithLicense.error);
  assert.match(classicalWithLicense.detail, /文言文 → 现代中文/);
  assert.match(JSON.stringify(aiRequests.at(-1).messages), /目标语言：现代中文/);
});

test("the book-build runner converts Chinese script without AI or bilingual pairs", async () => {
  const vault = tempDir("qbr-epub-script-");
  const source = path.join(vault, "script.md");
  fs.writeFileSync(source, "unused", "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-script-cache-"), null);
  const task = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成简繁转换电子书",
    payload: {
      source,
      settings: {},
      author: "鲁迅",
      chapters: [{
        title: "汉学",
        text: [
          "汉语 简体字 国家 学习 发展",
          "",
          "> 古语云：学而时习之。",
          "",
          "| 简体 | 繁体 |",
          "| --- | --- |",
          "| 国家 | 发展 |",
        ].join("\n"),
      }],
      translation: { mode: "script", script: "t" },
    },
  }));
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /简繁 繁體/);
  assert.match(task.output.replace(/\\/g, "/"), /script（繁體）\.epub$/);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(chapter, /<h1 class="chapter-title">漢學<\/h1>/);
  assert.match(chapter, /漢語 簡體字 國家 學習 發展/);
  assert.match(chapter, /古語云：學而時習之。/);
  assert.match(chapter, /<table>[\s\S]*國家[\s\S]*發展[\s\S]*<\/table>/);
  assert.ok(!chapter.includes('class="qbr-pair"'), "script conversion is not a bilingual layout");
  assert.match(opf, /<dc:language>zh-Hant<\/dc:language>/);
  assert.match(opf, /<dc:creator>魯迅<\/dc:creator>/);
  assert.match(opf, /<dc:title>script（繁體）<\/dc:title>/);
});

test("direct EPUB script conversion keeps the original chapter files and line breaks", async () => {
  const vault = tempDir("qbr-epub-script-direct-");
  const source = path.join(vault, "poems.epub");
  const sourceBytes = await writePoemEpub(source);
  const { queue } = makeQueue(tempDir("qbr-epub-script-direct-cache-"), null);
  const task = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成简繁转换电子书",
    payload: {
      source,
      settings: {},
      translation: { mode: "script", script: "s" },
    },
  }));
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /原格式/);
  assert.match(task.detail, /2 节/);
  assert.match(task.output.replace(/\\/g, "/"), /poems（简体）\.epub$/);
  assert.deepEqual(fs.readFileSync(source), sourceBytes, "the source EPUB is left untouched");

  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  assert.ok(zip.file("OEBPS/ch1.xhtml"));
  assert.ok(zip.file("OEBPS/ch2.xhtml"));
  assert.ok(!zip.file("OEBPS/chapter-001.xhtml"), "the original chapter files are preserved");
  assert.equal(await zip.file("OEBPS/style.css").async("string"), 'p { line-height: 2; }\nbody { background-image: url("images/pixel.png"); }');
  assert.match(await zip.file("OEBPS/ch1.xhtml").async("string"), /汉诗<br\/>国家/);
  assert.match(await zip.file("OEBPS/nav.xhtml").async("string"), /汉诗/);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:title>汉语诗（简体）<\/dc:title>/);
  assert.match(opf, /<dc:language>zh-Hans<\/dc:language>/);
});

test("the book-build runner honours chapters edited in the panel", async () => {
  const vault = tempDir("qbr-epub-vault3-");
  const source = path.join(vault, "原稿.txt");
  fs.writeFileSync(source, "第一章 原\n\n原文。\n", "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-cache3-"), null);
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: {
      source,
      settings: {},
      chapters: [
        { title: "改过的标题", text: "改过的正文。" },
        { title: "第二篇", text: "另一段。" },
      ],
    },
  });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /改过的标题/);
  assert.match(nav, /第二篇/);
  assert.ok(!nav.includes("第一章 原"), "the edited list replaces the auto-detected chapters");
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /<p>改过的正文。<\/p>/);
});

test("the book-build runner extracts office sources before building the epub", async () => {
  const vault = tempDir("qbr-epub-vault4-");
  const source = path.join(vault, "讲义.docx");
  fs.writeFileSync(source, "docx-bytes");
  const docvortex = {
    convert: async (_settings, request) => {
      fs.writeFileSync(request.out, "# 第一章 提取来的\n\n正文甲。\n\n# 第二章 继续\n\n正文乙。");
      return { ok: true, out: request.out };
    },
  };
  const dir = tempDir("qbr-epub-queue4-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot: path.join(dir, "cache"), subsetter: null, docvortex, log: () => {} });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.ok(fs.existsSync(path.join(vault, "讲义.epub")));
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /第一章 提取来的/);
  assert.match(nav, /第二章 继续/);
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /<p>正文甲。<\/p>/);
});

test("the book-build runner extracts pdf sources with the pdf_tool checkout", async () => {
  const vault = tempDir("qbr-epub-vault5-");
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const source = path.join(vault, "标准.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const outDir = call.args[call.args.indexOf("--out-dir") + 1];
    fs.writeFileSync(path.join(outDir, "标准_doc.md"), "# 第一章 标准\n\n正文。\n\n# 第二章 等级\n\n更多。");
    child.emit("close", 0);
  });
  const dir = tempDir("qbr-epub-queue5-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot: path.join(dir, "cache"), subsetter: null, spawnImpl, log: () => {} });
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: { ocrSidecarDir: vault }, title: "标准" },
  });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(calls.length, 1, "pdf_tool runs once, the wizard never shells out twice");
  assert.equal(calls[0].options.cwd, vault, "the checkout dir from the settings is used");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /第一章 标准/);
  assert.match(nav, /第二章 等级/);
});

test("the book-build runner no longer embeds fonts", async () => {
  const vault = tempDir("qbr-epub-vault2-");
  const source = path.join(vault, "有字体.md");
  fs.writeFileSync(source, "# 第一章\n\n正文 犇。", "utf8");
  const fontPath = path.join(vault, "Font.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const { queue } = makeQueue(tempDir("qbr-epub-cache2-"), {});
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, fonts: { files: [{ path: fontPath, family: "Test Font" }] } },
  });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.ok(!/media-type="font\//.test(opf), "成品不再嵌入字体(阅读器用自己的字体)");
  assert.equal(Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/")).length, 0);
});

test("the book-build runner embeds local images and renders formulas as MathML", async () => {
  const vault = tempDir("qbr-epub-vault6-");
  const imageDir = path.join(vault, "mineru", "images");
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, "fig1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13]));
  const source = path.join(vault, "论文.md");
  fs.writeFileSync(source, [
    "# 第一章 结果",
    "",
    "![图一](mineru/images/fig1.png)",
    "",
    "行内 $E = mc^2$ 与行间:",
    "",
    "$$",
    "a^2 + b^2 = c^2",
    "$$",
    "",
    "![缺图](mineru/images/missing.png)",
  ].join("\n"), "utf8");
  const batches = [];
  const mathRenderer = {
    renderMap: async (latexes) => {
      batches.push(latexes);
      return {
        ok: true,
        map: Object.fromEntries(latexes.map((latex) => [latex, `<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>${latex.length}</mi></math>`])),
      };
    },
  };
  const { queue } = makeQueue(tempDir("qbr-epub-cache6-"), null, { mathRenderer });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.deepEqual([...batches[0]].sort(), ["E = mc^2", "a^2 + b^2 = c^2"].sort(), "both formulas go out in one batch");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const image = await zip.file("OEBPS/images/image-1.png")?.async("nodebuffer");
  assert.ok(image?.length, "the referenced image is embedded");
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /href="images\/image-1\.png" media-type="image\/png"/);
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(chapter, /<img src="images\/image-1\.png" alt="图一"\/>/);
  assert.match(chapter, /<math /, "the inline formula becomes MathML");
  assert.match(chapter, /display="block"/, "the display formula is marked as block");
  assert.ok(!chapter.includes("missing.png"), "missing images are dropped instead of breaking");
  assert.match(task.detail, /1 图/);
  assert.match(task.detail, /2 公式/);
});

test("normalizeBookChapters cleans titles and drops title pages", () => {
  const long = "数学是数与形的艺术。".repeat(20); // ≥ 200 字,像真章节
  const chapters = [
    { title: "读读大师 走近数学", text: "——《数学家思想文库》总序" }, // 短:扉页
    { title: "**重点** 一章", text: "正文。" },
    { title: "读读大师 走近数学", text: long }, // 长:真章节
    { title: "数学在科学和社会中的作用", text: "扉页文字。" }, // 书名页
    { title: "集合论的一种公理化 $^{①}$", text: "正文。" },
  ];
  const result = normalizeBookChapters(chapters, "数学在科学和社会中的作用");
  assert.equal(result.dropped, 2, "短扉页与书名页都丢掉");
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["重点 一章", "读读大师 走近数学", "集合论的一种公理化 ①"]);
});

test("the nav drops repeated headers and cleans formula markers in titles", async () => {
  const vault = tempDir("qbr-epub-nav-");
  const source = path.join(vault, "页眉重复.md");
  fs.writeFileSync(source, [
    "# 读读大师 走近数学",
    "",
    "——《数学家思想文库》总序",
    "",
    "# 读读大师 走近数学",
    "",
    "数学是数与形的艺术。数学家们的创造性思维是鲜活的,既不会墨守成规,也不可能作为被生搬硬套的教条。学习了解数学家的数学思想,",
    "对理解数学本身、对理解科学方法都很有帮助,这也正是这套文库想要传达的东西。数学史上有许多值得一读再读的文字,",
    "它们把抽象的思想讲成了可以亲近的故事,读者由此看到数学是怎样长出来的。",
    "",
    "# 集合论的一种公理化 $^{①}$",
    "",
    "正文。",
  ].join("\n"), "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-nav-"), null, {});
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {}, title: "数学在科学和社会中的作用" } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /集合论的一种公理化 ①/, "标题里的 $^{①}$ 清成 ①");
  assert.ok(!nav.includes("$"), "导航里不该再出现 $ 之类符号");
  assert.equal((nav.match(/读读大师/g) || []).length, 1, "重复页眉只保留一次");
});

test("the printed table of contents is dropped by default", async () => {
  const vault = tempDir("qbr-epub-toc-");
  const source = path.join(vault, "带目录.md");
  fs.writeFileSync(source, [
    "# 目录",
    "",
    "第 1 章 起点 …… 1",
    "第 2 章 终点 …… 12",
    "2.1 中途 …… 12",
    "2.2 岔路 …… 14",
    "2.3 归途 …… 20",
    "",
    "# 第 1 章 起点",
    "",
    "正文一。",
    "",
    "# 第 2 章 终点",
    "",
    "正文二。",
  ].join("\n"), "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-toc-"), null, {});
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {}, title: "测试书" } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /去印刷目录 1 章/);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.ok(!nav.includes("……"), "导航里不该有印刷目录的条目");
  assert.equal((nav.match(/<li>/g) || []).length, 2, "导航只剩两章");
  assert.match(nav, /第 1 章 起点/);
  assert.match(nav, /第 2 章 终点/);

  // 关掉开关就保留(用户可能想留着做对照)。
  const second = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {}, title: "测试书", dropPrintedToc: false } });
  const kept = await waitForTask(queue, second);
  assert.equal(kept.status, "done", kept.error);
  const keptZip = await JSZip.loadAsync(fs.readFileSync(kept.output));
  const keptChapter = await keptZip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(keptChapter, /第 1 章 起点 …… 1/, "关掉开关时印刷目录会留着");
});

test("countRawFormulas ignores code blocks and flags leftovers", () => {
  assert.equal(countRawFormulas("<p><math></math></p><pre><code>$$\n a $$\n</code></pre>"), 0, "代码块里的 $$ 是刻意保留的");
  assert.equal(countRawFormulas("<p>$$a^2$$</p>"), 2, "一条未渲染的行间公式记 2(开合各一个 $$)");
  assert.equal(countRawFormulas("<p>…\\tag{5.16}$$</p>"), 2);
  assert.equal(countRawFormulas("<p>行内 \\(x\\) 与 \\[y\\]</p>"), 2);
});

test("the build report says when formulas could not be rendered", async () => {
  const vault = tempDir("qbr-epub-unrendered-");
  const source = path.join(vault, "漏渲染.md");
  fs.writeFileSync(source, "# 第一章\n\n剩下 $x^2$ 与\n\n$$y^2$$\n\n都没渲染。", "utf8");
  // 渲染器整个失败(比如 python 不在):成品里会留下 LaTeX 原文,报告要如实说。
  const mathRenderer = { renderMap: async () => ({ ok: false, error: "python 不在" }) };
  const { queue } = makeQueue(tempDir("qbr-epub-unrendered-"), null, { mathRenderer });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /未渲染 \d+/, "漏渲染要写在任务结果里");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.ok(countRawFormulas(chapter) > 0, "这份成品确实留着原始 LaTeX");
});

test("consecutive display blocks all render", async () => {
  // 中间稿里单行 $$…$$ 与成对行混用,旧收集方式会跨块错配,导致大段公式回退成原文。
  const vault = tempDir("qbr-epub-mathblocks-");
  const source = path.join(vault, "连续公式.md");
  fs.writeFileSync(source, [
    "# 第一章",
    "",
    "$$a^2 + b^2 = c^2$$",
    "",
    "$$",
    "\\frac {1}{f} = (1. 5 4 - 1) \\left(\\frac {1}{1 0 0} - \\frac {1}{- 2 0 . 0}\\right)",
    "$$",
    "",
    "$$c^2 = a^2 + b^2$$",
    "",
    "行内 $s_{o}=70\\ cm$ 收尾。",
  ].join("\n"), "utf8");
  const mathRenderer = {
    renderMap: async (latexes) => ({
      ok: true,
      map: Object.fromEntries(latexes.map((latex) => [latex, `<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mn>${latex.length}</mn></math>`])),
    }),
  };
  const { queue } = makeQueue(tempDir("qbr-epub-mathblocks-"), null, { mathRenderer });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.equal((chapter.match(/<math\b/g) || []).length, 4, "三条行间公式 + 一条行内公式都要渲染");
  assert.ok(!chapter.includes("$$"), "不能留下原始 $$ 公式");
  assert.ok(!chapter.includes("\\tag"), "\\tag 也不该出现在成品里");
  assert.match(chapter, /<p>行内 <math [^>]*>.*?<\/math> 收尾。<\/p>/, "行内公式仍在段落里");
});

test("a multi-line display formula still finds its MathML", async () => {
  // MinerU 的 $$…$$ 基本都跨行;段落在成书前会把换行压成空格,查公式表要归一化,
  // 否则整条公式查不中、回退成原始 LaTeX(实测《光学》2542 条全中招)。
  const vault = tempDir("qbr-epub-mathlines-");
  const source = path.join(vault, "跨行公式.md");
  fs.writeFileSync(source, [
    "# 第一章",
    "",
    "推导如下:",
    "",
    "$$",
    "\\frac {1}{f} = (n _ {l} - 1) \\left(\\frac {1}{R _ {1}} - \\frac {1}{R _ {2}}\\right)\\tag{5.16}",
    "$$",
    "",
    "到这里。",
  ].join("\n"), "utf8");
  const mathRenderer = {
    renderMap: async (latexes) => ({
      ok: true,
      map: Object.fromEntries(latexes.map((latex) => [latex, `<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mn>${latex.length}</mn></math>`])),
    }),
  };
  const { queue } = makeQueue(tempDir("qbr-epub-mathlines-"), null, { mathRenderer });
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const chapter = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(chapter, /<math /, "跨行 $$…$$ 也要渲染成 MathML");
  assert.ok(!chapter.includes("$$"), "不能留下原始 $$ 公式");
  assert.ok(!chapter.includes("\\tag"), "\\tag 也不该出现在成品里");
});

test("a fragment title in the chapter list is merged into the previous chapter", () => {
  const result = normalizeBookChapters([
    { title: "第一章 绪论", text: "光线的传播遵从" },
    { title: "的努力？", text: "惠更斯原理。" },
    { title: "第二章 波动", text: "正文。" },
  ], "测试书");
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["第一章 绪论", "第二章 波动"]);
  assert.match(result.chapters[0].text, /的努力？\s*惠更斯原理。/, "碎片标题的文字接回上一章、正文不丢");
  assert.equal(result.dropped, 1);
});

test("upstream toc entries win over the printed page", async () => {
  const vault = tempDir("qbr-epub-upstream-toc-");
  const source = path.join(vault, "论文.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  // 缓存命中时不该跑上游,但 pdf_tool 的解析在缓存判定之前,所以给个 stub checkout。
  fs.mkdirSync(path.join(vault, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(vault, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  const workRoot = path.join(vault, "work");
  fs.mkdirSync(workRoot, { recursive: true });
  // 上游给的目录:条目标题与正文标题不完全一致(带编号),仍应匹配上。
  const docJson = path.join(workRoot, "论文_doc.json");
  fs.writeFileSync(docJson, JSON.stringify({
    schema_version: 1,
    pages: [{ page: 1, page_role: "toc", toc_entries: [
      { title: "第一章 起点", page: 1, level: 1 },
      { title: "第二章 终点", page: 2, level: 1 },
    ] }],
  }), "utf8");
  const merged = path.join(workRoot, "merged.md");
  fs.writeFileSync(merged, "# 第一章 起点\n\n正文一。\n\n# 第二章 终点\n\n正文二。\n", "utf8");
  // 让缓存判定成立:产物比源文件新。
  const now = Date.now() / 1000 + 5;
  fs.utimesSync(merged, now, now);
  fs.utimesSync(docJson, now, now);

  const queue = createWorkshopQueue({ file: path.join(vault, "tasks.json"), onState: () => {}, log: { warn() {} } });
  const cacheRoot = path.join(vault, "cache");
  registerEpubRunners(queue, { vaultRoot: vault, cacheRoot, subsetter: null, docvortex: null, spawnImpl: () => { throw new Error("不该跑上游"); } });
  // 缓存目录由 runner 自己按「源路径+大小+mtime」算,这里直接把产物放进它的 work 目录。
  const crypto = await import("node:crypto");
  const stat = fs.statSync(source);
  const key = crypto.createHash("sha1").update(`${source}\n${stat.size}\n${stat.mtimeMs}`).digest("hex").slice(0, 8);
  const extractDir = path.join(cacheRoot, "work", `${path.basename(source).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${key}`, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.copyFileSync(merged, path.join(extractDir, "merged.md"));
  fs.copyFileSync(docJson, path.join(extractDir, "论文_doc.json"));

  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: { ocrSidecarDir: vault }, title: "测试书" } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.match(task.detail, /目录来自上游 2 条/);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /第一章 起点/);
  assert.match(nav, /第二章 终点/);
});

test("a cover fragment at the very start is dropped, a real short chapter is not", () => {
  const result = normalizeBookChapters([
    { title: "(第五版)", text: "<!--page:1 printed:1-->" },
    { title: "第1章 光学简史", text: "正文。".repeat(20) },
    { title: "1.1 开场白", text: "正文。".repeat(20) },
    { title: "序", text: "这是很长的序言正文。".repeat(20) },
  ], "光学");
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["第1章 光学简史", "1.1 开场白", "序"]);
  assert.equal(result.frontMatter, 1);
  // 书首之外的短小章节不动(可能是真章节,如「序」「附录」)。
  const kept = normalizeBookChapters([
    { title: "第1章 开头", text: "正文。".repeat(20) },
    { title: "序", text: "短。" },
  ], "书");
  assert.deepEqual(kept.chapters.map((chapter) => chapter.title), ["第1章 开头", "序"]);
});

test("a GB18030 txt source is decoded instead of shipping mojibake", async () => {
  const vault = tempDir("qbr-epub-gbk-");
  // 整份书稿都按 GB18030 写盘(旧站中文 TXT 的常见编码):标题「第一章 起风了」+ 正文「正文从这里开始。」
  const gbk = Buffer.from([
    0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xC6, 0xF0, 0xB7, 0xE7, 0xC1, 0xCB,
    0x0D, 0x0A,
    0xD5, 0xFD, 0xCE, 0xC4, 0xB4, 0xD3, 0xD5, 0xE2, 0xC0, 0xEF, 0xBF, 0xAA, 0xCA, 0xBC, 0xA1, 0xA3,
  ]);
  const source = path.join(vault, "凡人.txt");
  fs.writeFileSync(source, gbk);
  const { queue } = makeQueue(tempDir("qbr-epub-cache-gbk-"), null);
  const id = queue.start({ kind: "book-build", title: "生成电子书", payload: { source, settings: {} } });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /第一章 起风了/);
  assert.ok(!nav.includes("\uFFFD"), "目录里不该出现替换字符");
  const first = await zip.file("OEBPS/chapter-001.xhtml").async("string");
  assert.match(first, /正文从这里开始。/);
  assert.ok(!first.includes("\uFFFD"));
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { countRawFormulas } from "../src/main/text-book.js";
import { findPairing } from "../src/main/workshop-fonts.js";
import { normalizeBookChapters, prepareFonts, registerEpubRunners } from "../src/main/workshop-epub.js";
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

function fontBytesFetch(payload = "woff2-bytes") {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(payload).buffer, text: async () => "SIL OFL 1.1 许可文本" });
}

test("prepareFonts subsets local files and keeps the license", async () => {
  const dir = tempDir();
  const fontPath = path.join(dir, "MyFont.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    files: [{ path: fontPath, family: "My Font" }],
    chars: "甲乙丙",
    workDir: tempDir("qbr-subset-"),
    subsetter: {
      subset: async ({ outPath }) => {
        fs.writeFileSync(outPath, "subset-ttf");
        return { ok: true, path: outPath };
      },
    },
  });
  assert.equal(fonts.length, 1);
  assert.equal(fonts[0].fileName, "qbr-my-font.ttf");
  assert.equal(fonts[0].family, "QBR My Font");
  assert.equal(fonts[0].data.toString(), "subset-ttf");
  assert.match(fonts[0].licenseText, /SIL Open Font License/);
});

test("prepareFonts falls back to the original file when subsetting fails", async () => {
  const dir = tempDir();
  const fontPath = path.join(dir, "WenKai.woff2");
  fs.writeFileSync(fontPath, "full-woff2");
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    files: [{ path: fontPath, family: "WenKai" }],
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    subsetter: { subset: async () => ({ ok: false, error: "no fontTools" }) },
    log: () => {},
  });
  assert.equal(fonts[0].fileName, "WenKai.woff2", "the original file is embedded under its own name");
  assert.equal(fonts[0].data.toString(), "full-woff2");
});

test("prepareFonts downloads a pairing and skips fonts that fail", async () => {
  const fonts = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    pairing: findPairing("quiet"),
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    fetchImpl: fontBytesFetch(),
    subsetter: { subset: async ({ outPath }) => { fs.writeFileSync(outPath, "ttf"); return { ok: true, path: outPath }; } },
    log: () => {},
  });
  assert.equal(fonts.length, 3, "heading + body + latin");
  for (const font of fonts) assert.match(font.family, /^QBR /);
  const skipped = await prepareFonts({
    cacheDir: tempDir("qbr-fontcache-"),
    pairing: findPairing("quiet"),
    chars: "字",
    workDir: tempDir("qbr-subset-"),
    fetchImpl: async () => { throw new Error("offline"); },
    log: () => {},
  });
  assert.deepEqual(skipped, [], "no network means no embedded fonts, not a failure");
});

function makeQueue(cacheRoot, subsetter, extra = {}) {
  const dir = tempDir("qbr-epub-queue-");
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerEpubRunners(queue, { vaultRoot: "D:/vault", cacheRoot, subsetter, log: () => {}, ...extra });
  return { queue, dir };
}

test("the book-build runner turns a txt into a readable EPUB", async () => {
  const vault = tempDir("qbr-epub-vault-");
  const source = path.join(vault, "我的小说.txt");
  fs.writeFileSync(source, "第一章 起风了\n\n第一段正文。\n\n第二章 雨\n\n第二段正文。", "utf8");
  const { queue } = makeQueue(tempDir("qbr-epub-cache-"), null);
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, styles: { theme: "warm", fontSize: 18 } },
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
  assert.match(nav, /第一章 起风了/);
  const css = await zip.file("OEBPS/styles.css").async("string");
  assert.match(css, /background: #faf6ef/, "the warm theme reached the stylesheet");
  assert.match(task.detail, /EPUB · 2 章/);
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

test("the book-build runner embeds subsetted fonts", async () => {
  const vault = tempDir("qbr-epub-vault2-");
  const source = path.join(vault, "有字体.md");
  fs.writeFileSync(source, "# 第一章\n\n正文 犇。", "utf8");
  const fontPath = path.join(vault, "Font.woff2");
  fs.writeFileSync(fontPath, "font-bytes");
  const { queue } = makeQueue(tempDir("qbr-epub-cache2-"), {
    subset: async ({ outPath, chars }) => {
      fs.writeFileSync(outPath, `subset:${chars.includes("犇") ? "has-" : ""}chars`);
      return { ok: true, path: outPath };
    },
  });
  const id = queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, settings: {}, fonts: { files: [{ path: fontPath, family: "Test Font" }] } },
  });
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /media-type="font\/ttf"/);
  const fontFiles = Object.keys(zip.files).filter((name) => name.startsWith("OEBPS/fonts/") && name.endsWith(".ttf"));
  assert.equal(fontFiles.length, 1);
  assert.match(await zip.file(fontFiles[0]).async("string"), /has-chars/);
  assert.match(task.detail, /1 款字体/);
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

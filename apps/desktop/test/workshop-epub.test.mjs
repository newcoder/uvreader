import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { findPairing } from "../src/main/workshop-fonts.js";
import { prepareFonts, registerEpubRunners } from "../src/main/workshop-epub.js";
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

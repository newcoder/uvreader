import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBlocks, buildTextDoc, createPdfCleaner, furnitureRects, isMonospaceFont, writeTextProducts } from "../src/main/pdf-text.js";

const line = (text, options = {}) => ({
  text,
  font: options.font || "Times-Roman",
  size: options.size ?? 10,
  x1: options.x1 ?? 500,
  y0: options.y0 ?? 0,
  y1: options.y1 ?? 12,
  rotated: options.rotated ?? false,
});

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

const code = (text, options = {}) => line(text, { font: "Courier New", ...options });

test("monospace fonts are recognised as code", () => {
  for (const font of ["Courier New", "Consolas", "DejaVuSansMono", "JetBrains Mono", "CascadiaCode"]) {
    assert.equal(isMonospaceFont(font), true, font);
  }
  for (const font of ["Times-Roman", "SimSun", "Arial", "SourceHanSans"]) {
    assert.equal(isMonospaceFont(font), false, font);
  }
});

test("mixed CJK + Consolas lines stay text (exam papers do this)", () => {
  const mixed = (text, fonts) => ({ text, fonts, size: 12, x1: 500, y0: 0, y1: 12, rotated: false });
  const pages = [{
    lines: [
      mixed("认证时间:2021 年 9 月 19 日", { "DengXian-Regular": 8, Consolas: 12 }),
      mixed("def run(cfg):", { Consolas: 12 }),
      mixed("A. C++", { SimSun: 2, Consolas: 3 }),
    ],
  }];
  const blocks = buildBlocks(pages);
  assert.equal(blocks[0].type, "text", "数字用 Consolas 的中文行不是代码");
  assert.equal(blocks[1].type, "code", "整行等宽才是代码");
  assert.equal(blocks[2].type, "text", "混排正文不当代码");
});

test("headers, footers, page numbers and rotated watermarks are dropped", () => {
  const pages = Array.from({ length: 4 }, (_value, index) => ({
    height: 800,
    lines: [
      line("JOURNAL OF LIGHTWAVE TECHNOLOGY, VOL. 40", { y0: 20, y1: 32 }),
      line("Authorized licensed use limited to: HK PolyU", { y0: 700, y1: 712, rotated: true }),
      line(`第 ${index + 1} 页，共 4 页`, { y0: 760, y1: 774 }),
      line(`正文第 ${index + 1} 段。`, { y0: 200, y1: 212 }),
      line("1", { x1: 300, y0: 750, y1: 760 }),
    ],
  }));
  const blocks = buildBlocks(pages);
  const text = blocks.map((block) => block.text).join("\n");
  assert.ok(!text.includes("JOURNAL OF"), "跨页重复且在上边缘的页眉删掉");
  assert.ok(!text.includes("Authorized licensed"), "旋转水印删掉");
  assert.ok(!/第 \d+ 页/.test(text), "页码(全角标点样式)删掉");
  assert.ok(!/(^|\n)1(\n|$)/.test(text), "页码(纯数字)删掉");
  for (let index = 1; index <= 4; index += 1) assert.ok(text.includes(`正文第 ${index} 段`), "正文保留");
});

test("repeated lines in the body are not treated as furniture", () => {
  // 试卷里同一段代码在多个题目里重复出现,不能当页眉删掉。
  const pages = Array.from({ length: 6 }, (_value, index) => ({
    height: 800,
    lines: [
      line("CCF CSP-J 2021 第一轮C++语言试题", { y0: 770, y1: 781 }),
      line(`第 ${index + 1} 页，共 6 页`, { y0: 781, y1: 792 }),
      line("01 #include <iostream>", { y0: 200 + index * 5, y1: 212 + index * 5 }),
      line(`第 ${index + 1} 题的正文。`, { y0: 240, y1: 252 }),
    ],
  }));
  const blocks = buildBlocks(pages);
  const text = blocks.map((block) => block.text).join("\n");
  assert.ok(!text.includes("CCF CSP-J"), "页眉仍删掉");
  assert.ok(!/第 \d+ 页/.test(text), "页脚仍删掉");
  assert.equal((text.match(/#include <iostream>/g) || []).length, 6, "正文里重复的代码行全部保留");
  assert.ok(text.includes("第 6 题的正文。"));
});

test("a code block spanning a page break is joined into one block", () => {
  const pages = [
    {
      lines: [
        code("def run(cfg):", { y0: 100, y1: 112 }),
        code("    return cfg", { y0: 112, y1: 124 }),
        line("第 1 页"),
      ],
    },
    {
      lines: [
        line("第 2 页"),
        code("print(run({}))", { y0: 40, y1: 52 }),
      ],
    },
  ];
  const blocks = buildBlocks(pages);
  assert.equal(blocks.length, 1, `跨页代码块应合成一块:${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].text, "def run(cfg):\n    return cfg\nprint(run({}))", "代码的换行与缩进保持原样");
});

test("paragraphs split across pages are joined and hyphenation is repaired", () => {
  const pages = [
    { lines: [line("本地提取用固定规则:先把页眉页脚拿掉,再把被页边界切开的段落接回去 de-", { y0: 100, y1: 112 })] },
    { lines: [line("signed 保持一致。", { y0: 40, y1: 52 }), line("同一段的下一句。", { y0: 52, y1: 64 })] },
  ];
  const blocks = buildBlocks(pages);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.match(blocks[0].text, /designed 保持一致。同一段的下一句。/, "断词接回,页边界接续(CJK 不加空格)");
});

test("headings come out as headings with levels", () => {
  const pages = [{
    lines: [
      line("2. 试验方法", { size: 16, y0: 40, y1: 60 }),
      line("正文第一行。", { y0: 100, y1: 112 }),
      line("正文第二行。", { y0: 112, y1: 124 }),
      line("2.1 试样", { size: 13, y0: 160, y1: 178 }),
      line("更多正文。", { y0: 200, y1: 212 }),
    ],
  }];
  const blocks = buildBlocks(pages);
  const headings = blocks.filter((block) => block.type === "heading");
  assert.equal(headings.length, 2, JSON.stringify(blocks));
  assert.equal(headings[0].text, "2. 试验方法");
  assert.equal(headings[1].text, "2.1 试样");
  assert.equal(blocks.filter((block) => block.type === "text").length, 2);
});

test("the text-convert runner bridges the local extraction into DocVortex", async () => {
  const { createWorkshopQueue } = await import("../src/main/workshop.js");
  const { registerTextConvertRunner } = await import("../src/main/pdf-text.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-textconv-"));
  const source = path.join(dir, "讲义.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const converted = [];
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerTextConvertRunner(queue, {
    vaultRoot: dir,
    cacheRoot: dir,
    log: () => {},
    pdfText: {
      read: async () => ({
        ok: true,
        pages: [{ width: 595, height: 842, lines: [{ text: "def run():", fonts: { Consolas: 11 }, size: 10, x1: 100, y0: 0, y1: 12, rotated: false }] }],
      }),
    },
    docvortex: {
      convert: async (_settings, request) => {
        converted.push(request);
        fs.writeFileSync(request.out, "<html><body><p>ok</p></body></html>");
        return { ok: true, out: request.out };
      },
    },
  });
  const id = queue.start({ kind: "text-convert", title: "文本型文档", payload: { source, format: "markdown", settings: {} } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const task = queue.snapshot().tasks.find((row) => row.id === id);
  assert.equal(task.status, "done", task.error);
  assert.equal(path.basename(task.output), "讲义.md");
  assert.equal(converted.length, 1);
  assert.match(String(converted[0].source), /bridge\.html$/, "DocVortex 收到的是桥接 HTML");
  assert.match(fs.readFileSync(converted[0].source, "utf8"), /def run\(\):/, "本地提取的文字进了桥接 HTML");
});

test("furnitureRects locates headers, footers and watermarks for redaction", () => {
  const pages = [
    {
      height: 842,
      lines: [
        { text: "CCF CSP-J 2021 第一轮C++语言试题", fonts: { SimSun: 14 }, size: 9, x0: 200, x1: 400, y0: 769, y1: 781, rotated: false },
        { text: "第 1 页，共 2 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
        { text: "第一题的正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 300, y0: 200, y1: 212, rotated: false },
      ],
    },
    {
      height: 842,
      lines: [
        { text: "CCF CSP-J 2021 第一轮C++语言试题", fonts: { SimSun: 14 }, size: 9, x0: 200, x1: 400, y0: 769, y1: 781, rotated: false },
        { text: "第 2 页，共 2 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
        { text: "第二题的正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 300, y0: 200, y1: 212, rotated: false },
      ],
    },
  ];
  const rects = furnitureRects(pages);
  assert.equal(rects.length, 4, JSON.stringify(rects));
  assert.deepEqual(rects[0].rect, [200, 769, 400, 781]);
  assert.equal(rects[0].page, 1);
  assert.ok(!rects.some((item) => item.rect[1] === 200), "正文不进擦除清单");
});

test("createPdfCleaner redacts the furniture into a clean copy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-clean-"));
  const source = path.join(dir, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const job = JSON.parse(fs.readFileSync(call.args[2], "utf8"));
    fs.writeFileSync(job.out, "cleaned-pdf-bytes");
    child.emit("close", 0);
  });
  const cleaner = createPdfCleaner({
    spawnImpl,
    pdfText: {
      read: async () => ({
        ok: true,
        pages: [{
          height: 842,
          lines: [
            { text: "第 1 页，共 1 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
            { text: "正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 120, y0: 200, y1: 212, rotated: false },
          ],
        }],
      }),
    },
  });
  const workDir = path.join(dir, "work");
  const result = await cleaner.clean(source, { python: "python", workDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.removed, 1);
  assert.equal(path.basename(result.path), "试卷.pdf", "干净副本保持原文件名");
  assert.equal(fs.readFileSync(result.path, "utf8"), "cleaned-pdf-bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python");
  const job = JSON.parse(fs.readFileSync(path.join(workDir, "redact-job.json"), "utf8"));
  assert.deepEqual(job.rects, [{ page: 1, rect: [300, 781, 360, 792] }]);

  // 没有家具时直接返回原文件,不启动 Python
  const plain = createPdfCleaner({ spawnImpl, pdfText: { read: async () => ({ ok: true, pages: [{ height: 842, lines: [] }] }) } });
  const untouched = await plain.clean(source, { python: "python", workDir: path.join(dir, "work2") });
  assert.equal(untouched.ok, true);
  assert.equal(untouched.path, source);
  assert.equal(untouched.removed, 0);
});

test("furnitureRects locates headers, footers and watermarks for redaction", () => {
  const pages = [
    {
      height: 842,
      lines: [
        { text: "CCF CSP-J 2021 第一轮C++语言试题", fonts: { SimSun: 14 }, size: 9, x0: 200, x1: 400, y0: 769, y1: 781, rotated: false },
        { text: "第 1 页，共 2 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
        { text: "第一题的正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 300, y0: 200, y1: 212, rotated: false },
      ],
    },
    {
      height: 842,
      lines: [
        { text: "CCF CSP-J 2021 第一轮C++语言试题", fonts: { SimSun: 14 }, size: 9, x0: 200, x1: 400, y0: 769, y1: 781, rotated: false },
        { text: "第 2 页，共 2 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
        { text: "第二题的正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 300, y0: 200, y1: 212, rotated: false },
      ],
    },
  ];
  const rects = furnitureRects(pages);
  assert.equal(rects.length, 4, JSON.stringify(rects));
  assert.deepEqual(rects[0].rect, [200, 769, 400, 781]);
  assert.equal(rects[0].page, 1);
  assert.ok(!rects.some((item) => item.rect[1] === 200), "正文不进擦除清单");
});

test("createPdfCleaner redacts the furniture into a clean copy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-clean-"));
  const source = path.join(dir, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    const job = JSON.parse(fs.readFileSync(call.args[2], "utf8"));
    fs.writeFileSync(job.out, "cleaned-pdf-bytes");
    child.emit("close", 0);
  });
  const cleaner = createPdfCleaner({
    spawnImpl,
    pdfText: {
      read: async () => ({
        ok: true,
        pages: [{
          height: 842,
          lines: [
            { text: "第 1 页，共 1 页", fonts: { SimSun: 10 }, size: 9, x0: 300, x1: 360, y0: 781, y1: 792, rotated: false },
            { text: "正文。", fonts: { SimSun: 20 }, size: 12, x0: 55, x1: 120, y0: 200, y1: 212, rotated: false },
          ],
        }],
      }),
    },
  });
  const workDir = path.join(dir, "work");
  const result = await cleaner.clean(source, { python: "python", workDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.removed, 1);
  assert.equal(path.basename(result.path), "试卷.pdf", "干净副本保持原文件名");
  assert.equal(fs.readFileSync(result.path, "utf8"), "cleaned-pdf-bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python");
  const job = JSON.parse(fs.readFileSync(path.join(workDir, "redact-job.json"), "utf8"));
  assert.deepEqual(job.rects, [{ page: 1, rect: [300, 781, 360, 792] }]);

  // 没有家具时直接返回原文件,不启动 Python
  const plain = createPdfCleaner({ spawnImpl, pdfText: { read: async () => ({ ok: true, pages: [{ height: 842, lines: [] }] }) } });
  const untouched = await plain.clean(source, { python: "python", workDir: path.join(dir, "work2") });
  assert.equal(untouched.ok, true);
  assert.equal(untouched.path, source);
  assert.equal(untouched.removed, 0);
});

test("buildTextDoc and writeTextProducts produce §7 products", () => {
  const pages = [{ lines: [line("第一章 起风了", { size: 16, y0: 30, y1: 50 }), code("const a = 1;", { y0: 80, y1: 92 })] }];
  const doc = buildTextDoc(pages, { source: "D:/v/报告.pdf", title: "报告" });
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].blocks[0].type, "heading");
  assert.equal(doc.pages[0].blocks[1].type, "code");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdftext-"));
  const files = writeTextProducts(doc, { outDir, stem: "报告" });
  assert.ok(fs.existsSync(files.md) && fs.existsSync(files.html) && fs.existsSync(files.json) && fs.existsSync(files.audit));
  const markdown = fs.readFileSync(files.md, "utf8");
  assert.match(markdown, /^# 第一章 起风了/m);
  assert.match(markdown, /```[\s\S]*const a = 1;[\s\S]*```/, "代码写成围栏代码块");
  const audit = JSON.parse(fs.readFileSync(files.audit, "utf8"));
  assert.equal(audit.code, 1);
  // 同名再加序号
  const again = writeTextProducts(doc, { outDir, stem: "报告" });
  assert.match(path.basename(again.md), /^报告 \(\d+\)\.md$/);
});

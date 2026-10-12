import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBlocks, buildTextDoc, isMonospaceFont, writeTextProducts } from "../src/main/pdf-text.js";

const line = (text, options = {}) => ({
  text,
  font: options.font || "Times-Roman",
  size: options.size ?? 10,
  x1: options.x1 ?? 500,
  y0: options.y0 ?? 0,
  y1: options.y1 ?? 12,
  rotated: options.rotated ?? false,
});

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
    lines: [
      line("JOURNAL OF LIGHTWAVE TECHNOLOGY, VOL. 40", { y0: 20, y1: 32 }),
      line("Authorized licensed use limited to: HK PolyU", { y0: 700, y1: 712, rotated: true }),
      line(`第 ${index + 1} 页`),
      line(`正文第 ${index + 1} 段。`, { y0: 200, y1: 212 }),
      line("1", { x1: 300, y0: 750, y1: 760 }),
    ],
  }));
  const blocks = buildBlocks(pages);
  const text = blocks.map((block) => block.text).join("\n");
  assert.ok(!text.includes("JOURNAL OF"), "跨页重复的页眉删掉");
  assert.ok(!text.includes("Authorized licensed"), "旋转水印删掉");
  assert.ok(!/第 \d+ 页/.test(text), "页码(中文样式)删掉");
  assert.ok(!/(^|\n)1(\n|$)/.test(text), "页码(纯数字)删掉");
  for (let index = 1; index <= 4; index += 1) assert.ok(text.includes(`正文第 ${index} 段`), "正文保留");
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

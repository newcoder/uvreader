// 看 CSP2021 里哪些"家具"没被去掉(以及页眉页脚的实际文本长什么样)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTextDoc, createPdfTextReader, dropFurniture } from "./apps/desktop/src/main/pdf-text.js";

const pdf = "D:/projects/auto_chat/pdf_tool/test-docs/CSP2021.pdf";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-furniture-"));
const read = await createPdfTextReader().read(pdf, { python: "python", workDir: work });
console.log("页数:", read.pages.length);

// 每页前两行 / 后两行(最像家具的位置)
for (const [index, page] of read.pages.slice(0, 3).entries()) {
  const lines = page.lines || [];
  const head = lines.slice(0, 2).map((line) => `y=${line.y0}${line.rotated ? "[rot]" : ""} ${JSON.stringify(line.text.slice(0, 46))}`);
  const tail = lines.slice(-2).map((line) => `y=${line.y0}${line.rotated ? "[rot]" : ""} ${JSON.stringify(line.text.slice(0, 46))}`);
  console.log(`\n第 ${index + 1} 页 顶部: ${head.join(" | ")}`);
  console.log(`          底部: ${tail.join(" | ")}`);
}

// 跨页重复的行(阈值 30%)
const counts = new Map();
for (const page of read.pages) {
  const seen = new Set();
  for (const line of page.lines || []) {
    const key = String(line.text || "").trim().replace(/\s+/g, " ");
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}
const threshold = Math.max(2, Math.ceil(read.pages.length * 0.3));
console.log(`\n跨页重复(≥${threshold} 页)的行:`);
for (const [key, count] of [...counts].filter(([, count]) => count >= threshold)) console.log(`  ${count}× ${JSON.stringify(key.slice(0, 80))}`);

// 旋转的行(水印)
const rotated = [];
for (const [index, page] of read.pages.entries()) {
  for (const line of page.lines || []) if (line.rotated) rotated.push(`第 ${index + 1} 页: ${JSON.stringify(line.text.slice(0, 50))}`);
}
console.log("\n旋转文字(水印):", rotated.length ? "" : "无");
for (const line of rotated.slice(0, 6)) console.log("  ", line);

const cleaned = dropFurniture(read.pages);
const doc = buildTextDoc(read.pages, { source: pdf, title: "CSP2021" });
const all = doc.pages.flatMap((page) => page.blocks).map((block) => String(block.text ?? block.content ?? ""));
console.log("\n提取结果里仍像家具的行:");
for (const text of all) {
  if (/第\s*\d+\s*页|共\s*\d+\s*页|CSP-J\s*2021|第一轮C\+\+语言试题/.test(text)) console.log("  ", JSON.stringify(text.slice(0, 90)));
}
void cleaned;

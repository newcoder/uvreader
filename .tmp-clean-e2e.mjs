// 验证:转换前先清家具(红标擦除)→ DocVortex 拿到的副本里没有页眉/页脚/页码。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDocvortex, registerDocvortexRunners } from "./apps/desktop/src/main/docvortex.js";
import { createPdfCleaner, createPdfTextReader } from "./apps/desktop/src/main/pdf-text.js";
import { createWorkshopQueue } from "./apps/desktop/src/main/workshop.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-clean-e2e-"));
const source = path.join(work, "CSP2021.pdf");
fs.copyFileSync("D:/projects/auto_chat/pdf_tool/test-docs/CSP2021.pdf", source);

// 1) 先看清理本身:擦掉多少处家具、副本里还剩不剩页眉页脚
const cleaner = createPdfCleaner({ pdfText: createPdfTextReader() });
const cleaned = await cleaner.clean(source, { python: "python", workDir: path.join(work, "clean") });
console.log("清理结果:", cleaned.ok ? `${cleaned.removed} 处 → ${cleaned.path}` : `失败 ${cleaned.error}`);

const reader = createPdfTextReader();
const before = await reader.read(source, { python: "python", workDir: path.join(work, "raw") });
const after = await reader.read(cleaned.path, { python: "python", workDir: path.join(work, "raw2") });
const looksFurniture = (pages) => pages.flatMap((page) => page.lines || []).filter((line) => /第\s*\d+\s*页|共\s*\d+\s*页|CSP-J\s*2021/.test(String(line.text || ""))).length;
console.log(`副本里仍像页眉页脚的行: 清理前 ${looksFurniture(before.pages)} → 清理后 ${looksFurniture(after.pages)}`);
console.log(`文字量: 清理前 ${before.pages.reduce((sum, page) => sum + (page.lines || []).length, 0)} 行 → 清理后 ${after.pages.reduce((sum, page) => sum + (page.lines || []).length, 0)} 行`);

// 2) 走真实 runner:本地解析(DocVortex)转换 → md
const vault = work;
const queue = createWorkshopQueue({ file: path.join(work, "tasks.json"), onState: () => {}, log: { warn() {} } });
registerDocvortexRunners(queue, { docvortex: createDocvortex({}), vaultRoot: vault, cacheRoot: path.join(work, "cache"), log: () => {} });
const id = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "CSP2021.pdf", format: "markdown", settings: {} } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let task = null;
for (;;) {
  task = queue.snapshot().tasks.find((row) => row.id === id);
  if (task && task.status !== "running" && task.status !== "queued") break;
  await sleep(200);
}
console.log("\n本地解析转换:", task.status, task.error ? String(task.error).slice(0, 80) : path.basename(task.output));
if (task.status === "done") {
  const markdown = fs.readFileSync(task.output, "utf8");
  const furniture = (markdown.match(/第\s*\d+\s*页|共\s*\d+\s*页|CSP-J\s*2021/g) || []).length;
  console.log("产物里页眉页脚出现次数:", furniture);
  console.log("产物里还提到第一题:", markdown.includes("面向对象"));
  console.log("图片引用:", (markdown.match(/!\[/g) || []).length);
}
console.log("workdir:", work);

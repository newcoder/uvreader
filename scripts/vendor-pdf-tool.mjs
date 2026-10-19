// 把 pdf_tool 的**代码**快照 vendor 进仓库(引擎打包用;CI 不依赖另一个仓库)。
// 用法:node scripts/vendor-pdf-tool.mjs --from D:/projects/auto_chat/pdf_tool
// 只复制 .py 与小型数据目录,跳过 output/ test-docs/ pdfs/ docs/ __pycache__(那是测试产物与素材)。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const source = path.resolve(fromIndex >= 0 ? args[fromIndex + 1] : "D:/projects/auto_chat/pdf_tool");
const target = path.join(repoRoot, "engine", "vendor", "pdf_tool", "pdf_tool");

const SKIP_DIRS = new Set(["output", "test-docs", "pdfs", "docs", "__pycache__", ".pytest_cache", ".ruff_cache", "temp_output"]);

if (!fs.existsSync(path.join(source, "pdf_to_doc.py"))) {
  console.error(`✗ ${source} 里没有 pdf_to_doc.py(给 pdf_tool 包目录)`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
};
copyTree(source, target);

let commit = "";
try {
  commit = String(spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout || "").trim();
} catch { /* 不是 git 目录就算了 */ }
const sourceFile = path.join(repoRoot, "engine", "vendor", "pdf_tool", "SOURCE.txt");
fs.writeFileSync(sourceFile, [
  `来源: ${source}`,
  `commit: ${commit}`,
  `快照时间: ${new Date().toISOString()}`,
  "刷新:node scripts/vendor-pdf-tool.mjs --from <pdf_tool 包目录>",
  "说明:只保留代码与小型数据目录(output/ test-docs/ pdfs/ docs/ 不进仓库)。",
  "",
].join("\n"), "utf8");

let bytes = 0;
let files = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      bytes += fs.statSync(full).size;
      files += 1;
    }
  }
};
walk(path.join(repoRoot, "engine", "vendor", "pdf_tool"));
console.log(`✓ 已 vendor pdf_tool(${commit.slice(0, 8) || "无 commit"})→ ${path.relative(repoRoot, target)}`);
console.log(`  ${files} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB`);

#!/usr/bin/env node
// 把旧精修 polish.md 里人工校对过的注文正文迁移到新精修。
//
// 用法：
//   node scripts/import-polish-notes.mjs <旧 polish.md> <新 polish.md>
//   node scripts/import-polish-notes.mjs <新 polish.md> --write
//
// 不传旧文件时，自动使用新文件所在目录下最新的 backup-*/polish.md。
// 默认只生成 <新 polish.md>.imported.md，加 --write 才覆盖新文件，
// 覆盖前会保留一份 .before-import-<时间>.md。
import fs from "node:fs";
import path from "node:path";

import { mergePolishNoteTexts } from "../apps/desktop/src/shared/polish-markdown.js";

function latestBackup(newFile) {
  const dir = path.dirname(newFile);
  const backups = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map((entry) => path.join(dir, entry.name, "polish.md"))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return backups[0] || "";
}

const args = process.argv.slice(2).filter((arg) => arg !== "--write");
const write = process.argv.includes("--write");
let [oldArg, newArg] = args;
if (!newArg) {
  newArg = oldArg;
  oldArg = "";
}
if (!newArg) {
  console.error("用法: node scripts/import-polish-notes.mjs <旧 polish.md> <新 polish.md> [--write]");
  process.exit(1);
}
const newFile = path.resolve(newArg);
const oldFile = oldArg ? path.resolve(oldArg) : latestBackup(newFile);
if (!fs.existsSync(newFile)) {
  console.error(`找不到新精修文件: ${newFile}`);
  process.exit(1);
}
if (!oldFile || !fs.existsSync(oldFile)) {
  console.error("找不到旧精修文件；请显式传入旧 polish.md，或确认 backup-*/polish.md 存在");
  process.exit(1);
}
const result = mergePolishNoteTexts(fs.readFileSync(oldFile, "utf8"), fs.readFileSync(newFile, "utf8"));
if (!result.updates) {
  console.error("没有可迁移的注文正文");
  process.exit(1);
}
const outFile = write ? newFile : `${newFile}.imported.md`;
if (write) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const backup = `${newFile}.before-import-${stamp}.md`;
  fs.copyFileSync(newFile, backup);
  console.log(`已备份新文件: ${backup}`);
}
fs.writeFileSync(outFile, result.markdown, "utf8");
console.log(`旧文件: ${oldFile}`);
console.log(`新文件: ${newFile}`);
console.log(`输出:   ${outFile}`);
console.log(`注文:   旧 ${result.summary.oldNotes} / 新 ${result.summary.newNotes}，已更新 ${result.updates} 条`);
if (result.warnings.length) {
  console.log(`警告 ${result.warnings.length} 条:`);
  for (const warning of result.warnings) console.log(`  - ${warning}`);
}
if (!write) console.log("确认无误后，关闭精修页，再运行同一命令并加 --write 覆盖新文件。");

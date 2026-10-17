// 主进程的文件命名助手:同名不覆盖,按 §7 规则加序号(报告.md → 报告 (1).md)。
import fs from "node:fs";
import path from "node:path";

export function uniqueFile(target, exists = (file) => fs.existsSync(file)) {
  const value = String(target || "");
  if (!value || !exists(value)) return value;
  const ext = path.extname(value);
  const base = value.slice(0, value.length - ext.length);
  let index = 1;
  while (exists(`${base} (${index})${ext}`)) index += 1;
  return `${base} (${index})${ext}`;
}

// 删临时文件 / 临时目录一律走这两个助手:Node 24.12 + Windows 上
// `fs.rmSync(file, { force: true })` / `fs.rmdirSync(dir, { recursive: true })` 对
// **非 ASCII 名字**(中文书名、`.<源名>.bridge-*.html` 这类)会静默什么都不删 —— 不抛错、
// 文件还在,调用方却以为清干净了(实测:`rmSync` 不删、`unlinkSync` 删得了)。
// 两个助手都用确定会生效的 API,并且只把 ENOENT(本来就没有)当成功。
export function removeFile(file, { fsImpl = fs } = {}) {
  if (!file) return;
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function removeTree(dir, { fsImpl = fs } = {}) {
  if (!dir) return;
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTree(child, { fsImpl });
    else removeFile(child, { fsImpl });
  }
  fsImpl.rmdirSync(dir);
}

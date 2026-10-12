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

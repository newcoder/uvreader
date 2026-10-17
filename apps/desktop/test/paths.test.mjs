import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeFile, removeTree, uniqueFile } from "../src/main/paths.js";

test("uniqueFile numbers the target when it already exists", () => {
  const existing = new Set(["a.md", "a (1).md"]);
  assert.equal(uniqueFile("a.md", (file) => existing.has(file)), "a (2).md");
  assert.equal(uniqueFile("b.md", (file) => existing.has(file)), "b.md", "不冲突就不动名字");
  assert.equal(uniqueFile("", () => true), "");
  assert.equal(uniqueFile("dir/无扩展名", (file) => file === "dir/无扩展名"), "dir/无扩展名 (1)");
  assert.equal(uniqueFile("C:/v/报告.pdf", (file) => file === "C:/v/报告.pdf" || file === "C:/v/报告 (1).pdf"), "C:/v/报告 (2).pdf");
});

// Node 24.12 + Windows 的 fs.rmSync/rmdirSync 对非 ASCII 名字会静默不删(文件、目录都一样),
// 临时产物 / 缓存清理因此漏删。这两个助手用确定会生效的 API:
test("removeFile deletes files whose names are not ASCII", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-paths-file-"));
  const file = path.join(dir, ".论文.md.bridge-abc.html");
  fs.writeFileSync(file, "x", "utf8");
  removeFile(file);
  assert.equal(fs.existsSync(file), false, "非 ASCII 名字也要真的删掉");
  removeFile(file); // 已经没了:幂等,不抛
  removeFile(""); // 空路径:不抛
});

test("removeTree deletes a non-ASCII directory tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-paths-tree-"));
  const dir = path.join(root, "论文.md.assets");
  fs.mkdirSync(path.join(dir, "figures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "figure-1.png"), "x", "utf8");
  fs.writeFileSync(path.join(dir, "figures", "figure-2.png"), "x", "utf8");
  removeTree(dir);
  assert.equal(fs.existsSync(dir), false, "目录(含子目录里的文件)要真的删掉");
  removeTree(dir); // 已经没了:幂等,不抛
});

import assert from "node:assert/strict";
import test from "node:test";

import { uniqueFile } from "../src/main/paths.js";

test("uniqueFile numbers the target when it already exists", () => {
  const existing = new Set(["a.md", "a (1).md"]);
  assert.equal(uniqueFile("a.md", (file) => existing.has(file)), "a (2).md");
  assert.equal(uniqueFile("b.md", (file) => existing.has(file)), "b.md", "不冲突就不动名字");
  assert.equal(uniqueFile("", () => true), "");
  assert.equal(uniqueFile("dir/无扩展名", (file) => file === "dir/无扩展名"), "dir/无扩展名 (1)");
  assert.equal(uniqueFile("C:/v/报告.pdf", (file) => file === "C:/v/报告.pdf" || file === "C:/v/报告 (1).pdf"), "C:/v/报告 (2).pdf");
});

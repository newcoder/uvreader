import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { registerEpubRunners } from "../src/main/workshop-epub.js";
import { waitForTask } from "./wait-for-task.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("a source inside Spaces routes generated books and polish into the space", async () => {
  const root = tempDir("qbr-space-route-");
  const vault = path.join(root, "library");
  const source = path.join(vault, "Spaces", "论文研究", "books", "测试书.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    "# 测试书",
    "",
    "## 第一章",
    "",
    "正文。",
  ].join("\n"), "utf8");
  const queue = createWorkshopQueue({
    file: path.join(root, "tasks.json"),
    onState: () => {},
    log: { warn() {} },
  });
  registerEpubRunners(queue, { vaultRoot: vault, cacheRoot: path.join(root, "cache"), log: () => {} });

  const build = await waitForTask(queue, queue.start({
    kind: "book-build",
    title: "生成电子书",
    payload: { source, title: "测试书" },
  }), 15000);
  assert.equal(build.status, "done", build.error);
  const expected = path.join(vault, "Spaces", "论文研究", "exports", "测试书.epub");
  assert.equal(path.resolve(build.output), path.resolve(expected));

  const rebuild = await waitForTask(queue, queue.start({
    kind: "book-polish",
    title: "重建精修电子书",
    payload: { phase: "rebuild", manifestPath: build.result.polish.path, tag: "空间版" },
  }), 15000);
  assert.equal(rebuild.status, "done", rebuild.error);
  assert.deepEqual(
    path.resolve(rebuild.output).split(path.sep).slice(-2),
    ["polish", "测试书-空间版.epub"],
  );
});

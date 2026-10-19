import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkshopQueue } from "../src/main/workshop.js";
import { registerBookRunners } from "../src/main/workshop-book.js";
import { waitForTask } from "./wait-for-task.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeQueue(calibre, engine = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-book-queue-"));
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerBookRunners(queue, { calibre, vaultRoot: "D:/vault", engine, log: () => {} });
  return { queue, dir };
}

test("the calibre probe reports the detected command", async () => {
  const { queue } = makeQueue({
    probe: async () => ({ ok: true, detail: "ebook-convert (calibre 9.15.0)", command: "C:/Calibre2/ebook-convert.exe", args: [], kind: "common" }),
    convert: async () => ({ ok: true }),
  });
  const id = queue.start({ kind: "calibre-probe", title: "检测 Calibre", payload: {} });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.match(task.output, /calibre 9\.15\.0/);
  assert.match(task.detail, /ebook-convert\.exe/);
});

test("the probe fails with the actionable hint when Calibre is missing", async () => {
  const { queue } = makeQueue({
    probe: async () => ({ ok: false, detail: "未找到 Calibre(ebook-convert);安装后重试或填写路径" }),
    convert: async () => ({ ok: false }),
  });
  const id = queue.start({ kind: "calibre-probe", title: "检测 Calibre", payload: {} });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "failed");
  assert.match(task.error, /未找到 Calibre/);
});

test("ebook-convert resolves the vault path and lands the target format", async () => {
  const calls = [];
  const { queue } = makeQueue({
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      calls.push(request);
      return { ok: true, out: request.out };
    },
  });
  const id = queue.start({
    kind: "ebook-convert",
    title: "转为 AZW3",
    payload: { source: "Books/示例书库/Alice in Wonderland.epub", format: "azw3", out: "Books/示例书库/Alice in Wonderland.azw3" },
  });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.equal(task.output, path.join("D:/vault", "Books", "示例书库", "Alice in Wonderland.azw3"));
  assert.equal(calls[0].source, path.join("D:/vault", "Books", "示例书库", "Alice in Wonderland.epub"));
});

test("images-cbz packs images next to their folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-book-cbz-"));
  for (const name of ["1.jpg", "2.jpg"]) fs.writeFileSync(path.join(dir, name), `img:${name}`);
  const { queue } = makeQueue({ probe: async () => ({ ok: true }), convert: async () => ({ ok: true }) });
  const id = queue.start({
    kind: "images-cbz",
    title: "图片 → CBZ",
    payload: { images: [path.join(dir, "1.jpg").replace(/\\/g, "/"), path.join(dir, "2.jpg").replace(/\\/g, "/")], format: "cbz" },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  const out = path.join(path.dirname(dir), `${path.basename(dir)}.cbz`);
  assert.equal(task.output, out);
  assert.ok(fs.existsSync(out));
  assert.match(task.detail, /CBZ · 2 页/);
});

test("ebook-convert prefers the engine and leaves the local Calibre alone", async () => {
  const engineCalls = [];
  const engine = {
    runJob: async (settings, kind, args) => {
      engineCalls.push({ settings, kind, args });
      return { ok: true, result: { out: args.out, bytes: 1234 } };
    },
  };
  const local = [];
  const { queue } = makeQueue({
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      local.push(request);
      return { ok: true, out: request.out };
    },
  }, engine);
  const id = queue.start({
    kind: "ebook-convert",
    title: "转为 AZW3",
    payload: {
      settings: { engineUrl: "http://127.0.0.1:8760", engineToken: "t" },
      source: "Books/示例书库/Alice in Wonderland.epub",
      format: "azw3",
      out: "Books/示例书库/Alice in Wonderland.azw3",
    },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.equal(engineCalls.length, 1);
  assert.equal(engineCalls[0].kind, "ebook-convert", "Calibre 走引擎的 ebook-convert 作业");
  assert.equal(local.length, 0, "引擎成功时不该再跑本机 Calibre");
  assert.match(task.detail, /引擎/);
});

test("ebook-convert falls back to the local Calibre when the engine fails", async () => {
  const local = [];
  const { queue } = makeQueue({
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      local.push(request);
      return { ok: true, out: request.out };
    },
  }, { runJob: async () => ({ ok: false, error: "引擎没装 Calibre" }) });
  const id = queue.start({
    kind: "ebook-convert",
    title: "转为 MOBI",
    payload: {
      settings: { engineUrl: "http://127.0.0.1:8760" },
      source: "Books/示例书库/Alice in Wonderland.epub",
      format: "mobi",
      out: "Books/示例书库/Alice in Wonderland.mobi",
    },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.equal(local.length, 1, "引擎失败要回退本机");
});

test("without an engine url the local Calibre is used as before", async () => {
  let engineHits = 0;
  const local = [];
  const { queue } = makeQueue({
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      local.push(request);
      return { ok: true, out: request.out };
    },
  }, { runJob: async () => { engineHits += 1; return { ok: true }; } });
  const id = queue.start({
    kind: "ebook-convert",
    title: "转为 AZW3",
    payload: { settings: {}, source: "Books/示例书库/Alice in Wonderland.epub", format: "azw3", out: "Books/示例书库/Alice in Wonderland.azw3" },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.equal(engineHits, 0, "没配 engineUrl 就不该打引擎");
  assert.equal(local.length, 1);
});

test("images-epub packs a CBZ first and hands it to Calibre", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-book-epub-"));
  fs.writeFileSync(path.join(dir, "1.png"), "img");
  const calls = [];
  const { queue } = makeQueue({
    probe: async () => ({ ok: true }),
    convert: async (_settings, request) => {
      calls.push(request);
      fs.writeFileSync(request.out, "epub");
      return { ok: true, out: request.out };
    },
  });
  const id = queue.start({
    kind: "images-cbz",
    title: "图片 → EPUB",
    payload: { images: [path.join(dir, "1.png").replace(/\\/g, "/")], format: "epub" },
  });
  await sleep(80);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.match(task.output, /\.epub$/);
  assert.match(calls[0].source, /\.cbz$/);
  assert.equal(calls[0].out, task.output);
  assert.ok(fs.existsSync(task.output));
});

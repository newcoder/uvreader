import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkshopQueue } from "../src/main/workshop.js";
import {
  findLayoutCache,
  readMineruLayout,
  registerLayoutRunner,
  writeLayoutJson,
} from "../src/main/pdf-layout.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTask(queue, id, timeoutMs = 3000) {
  const terminal = new Set(["done", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = queue.snapshot().tasks.find((entry) => entry.id === id);
    if (task && terminal.has(task.status)) return task;
    if (Date.now() > deadline) return task;
    await sleep(10);
  }
}

function writeChunk(root, name, pages) {
  const dir = path.join(root, "mineru", "chunks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "middle_json.json"), JSON.stringify({
    pages: pages.map((page) => ({
      page_idx: page.page_idx,
      blocks: page.blocks,
    })),
  }), "utf8");
}

function layoutFor(page, text) {
  return [{
    page,
    blocks: [{
      type: "text",
      bbox: [0.1, 0.1, 0.9, 0.2],
      content: [{ type: "text", content: text }],
    }],
  }];
}

test("readMineruLayout restores global page numbers from chunk folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-read-"));
  writeChunk(root, "0001-0002", [
    { page_idx: 0, blocks: layoutFor(1, "第一页")[0].blocks },
    { page_idx: 1, blocks: layoutFor(2, "第二页")[0].blocks },
  ]);
  const layout = readMineruLayout(root);
  assert.equal(layout.pages.length, 2);
  assert.equal(layout.pages[0].page, 1);
  assert.equal(layout.pages[1].page, 2);
  assert.equal(layout.pages[0].blocks[0].text, "第一页");
  assert.deepEqual(layout.pages[0].blocks[0].bbox, [0.1, 0.1, 0.9, 0.2]);
});

test("readMineruLayout falls back to a global content_list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-content-"));
  fs.mkdirSync(path.join(root, "mineru"), { recursive: true });
  fs.writeFileSync(path.join(root, "mineru", "content_list.json"), JSON.stringify([
    { type: "text", text: "目录页", bbox: [100, 200, 900, 300], page_idx: 7 },
  ]), "utf8");
  const layout = readMineruLayout(root);
  assert.equal(layout.pages.length, 1);
  assert.equal(layout.pages[0].page, 8);
  assert.equal(layout.pages[0].blocks[0].text, "目录页");
  assert.deepEqual(layout.pages[0].blocks[0].bbox, [0.1, 0.2, 0.9, 0.3]);
});

test("readMineruLayout keeps nested index entries on separate lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-index-"));
  writeChunk(root, "0001-0001", [{
    page_idx: 0,
    blocks: [{
      type: "index",
      bbox: [0.05, 0.1, 0.45, 0.7],
      content: [
        { type: "text", content: [{ type: "text", content: "浣溪沙（泪浥红笺第几行）/66" }] },
        { type: "text", content: [{ type: "text", content: "浣溪沙（谁念西风独自凉）/68" }] },
      ],
    }],
  }]);
  const layout = readMineruLayout(root);
  assert.equal(layout.pages[0].blocks[0].text,
    "浣溪沙（泪浥红笺第几行）/66\n浣溪沙（谁念西风独自凉）/68");
});

test("findLayoutCache reuses a cache from a renamed source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-cache-"));
  const cacheDir = path.join(root, "图解纳兰词_家家争唱饮水词-abc123");
  writeChunk(cacheDir, "0001-0001", [
    { page_idx: 0, blocks: layoutFor(1, "旧缓存")[0].blocks },
  ]);
  const found = findLayoutCache(root, "D:/books/图解纳兰词 (1).pdf");
  assert.ok(found);
  assert.equal(found.workDir, cacheDir);
  assert.equal(found.layout.pages[0].blocks[0].text, "旧缓存");
  assert.equal(findLayoutCache(root, "D:/books/图解纳兰词 (1).pdf", 2), null,
    "a one-page trial cache must not be used for a two-page source");
  assert.ok(findLayoutCache(root, "D:/books/图解纳兰词 (1).pdf", 0, [1]));
  assert.equal(findLayoutCache(root, "D:/books/图解纳兰词 (1).pdf", 0, [1, 2]), null,
    "a requested page that is missing from the cache must reject it");
  assert.equal(findLayoutCache(root, "D:/books/another-book.pdf"), null);
});

test("the layout runner reuses cached MinerU data and calls the engine job", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-run-"));
  const cacheRoot = path.join(root, "cache");
  const cacheDir = path.join(cacheRoot, "扫描书_abc123");
  writeChunk(cacheDir, "0001-0002", [
    { page_idx: 0, blocks: layoutFor(1, "第一页")[0].blocks },
    { page_idx: 1, blocks: layoutFor(2, "第二页")[0].blocks },
  ]);
  const source = path.join(root, "扫描书.pdf");
  fs.writeFileSync(source, "%PDF-1.4\n", "utf8");
  const out = path.join(root, "扫描书-重排.pdf");
  const queue = createWorkshopQueue({
    file: path.join(root, "tasks.json"),
    onState: () => {},
    log: { warn() {} },
  });
  const calls = [];
  const engine = {
    health: async () => ({ ok: true, data: { capabilities: { jobKinds: ["layout-pdf"] } } }),
    runJob: async (_settings, kind, args) => {
      if (kind === "text-layer") {
        fs.writeFileSync(args.out, JSON.stringify(["", ""]), "utf8");
        return { ok: true, result: { pages: 2 } };
      }
      calls.push({ kind, args });
      fs.writeFileSync(args.out, "%PDF-1.4\n", "utf8");
      return { ok: true, result: { replaced: 2, kept: 0 } };
    },
  };
  const chain = {
    prepare: async () => {
      throw new Error("the cached layout should not trigger MinerU");
    },
  };
  registerLayoutRunner(queue, { chain, engine, vaultRoot: "", cacheRoot });
  const id = queue.start({
    kind: "layout-convert",
    title: "扫描版式文档",
    detail: source,
    payload: { source, format: "pdf", out, settings: {} },
  });
  const task = await waitForTask(queue, id, 5000);
  assert.equal(task.status, "done", task.error);
  assert.equal(task.output, out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "layout-pdf");
  assert.equal(calls[0].args.source, source);
  assert.equal(calls[0].args.out, out);
  assert.equal(calls[0].args.pages, "");
  assert.equal(calls[0].args.dpi, 216);
  assert.ok(fs.existsSync(calls[0].args.layout));
  const written = JSON.parse(fs.readFileSync(calls[0].args.layout, "utf8"));
  assert.equal(written.pages.length, 2);
  assert.equal(written.pages[1].page, 2);
});

test("the layout runner rejects non-PDF targets before doing work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-format-"));
  const source = path.join(root, "a.pdf");
  fs.writeFileSync(source, "%PDF-1.4\n", "utf8");
  const queue = createWorkshopQueue({ file: "", onState: () => {}, log: { warn() {} } });
  registerLayoutRunner(queue, {
    chain: { prepare: async () => ({ ok: true }) },
    engine: { runJob: async () => ({ ok: true }) },
    vaultRoot: "",
    cacheRoot: root,
  });
  const id = queue.start({
    kind: "layout-convert",
    title: "扫描版式文档",
    payload: { source, format: "docx", out: path.join(root, "a.docx"), settings: {} },
  });
  const task = await waitForTask(queue, id, 3000);
  assert.equal(task.status, "failed");
  assert.match(String(task.error), /PDF/);
});

test("the layout runner extracts a printed TOC and sends outline rows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-toc-run-"));
  const cacheRoot = path.join(root, "cache");
  const cacheDir = path.join(cacheRoot, "扫描书_toc123");
  writeChunk(cacheDir, "0001-0004", [
    {
      page_idx: 0,
      blocks: [
        { type: "paragraph_title", bbox: [0.4, 0.05, 0.6, 0.08], content: [{ type: "text", content: "目录" }] },
        { type: "text", bbox: [0.04, 0.2, 0.4, 0.22], content: [{ type: "text", content: "第一章 / 1" }] },
        { type: "text", bbox: [0.04, 0.3, 0.4, 0.32], content: [{ type: "text", content: "第二章 / 2" }] },
        { type: "text", bbox: [0.5, 0.2, 0.9, 0.22], content: [{ type: "text", content: "第三章 / 3" }] },
        { type: "text", bbox: [0.5, 0.3, 0.9, 0.32], content: [{ type: "text", content: "第四章 / 4" }] },
      ],
    },
    { page_idx: 1, blocks: [
      { type: "image", bbox: [0.1, 0.1, 0.5, 0.5] },
      { type: "page_number", bbox: [0.9, 0.95, 0.95, 0.97], content: [{ type: "text", content: "1" }] },
    ] },
    { page_idx: 2, blocks: [{ type: "page_number", bbox: [0.9, 0.95, 0.95, 0.97], content: [{ type: "text", content: "2" }] }] },
    { page_idx: 3, blocks: [{ type: "page_number", bbox: [0.9, 0.95, 0.95, 0.97], content: [{ type: "text", content: "3" }] }] },
  ]);
  const source = path.join(root, "扫描书.pdf");
  fs.writeFileSync(source, "%PDF-1.4\n", "utf8");
  const out = path.join(root, "扫描书-重排.pdf");
  const queue = createWorkshopQueue({ file: "", onState: () => {}, log: { warn() {} } });
  const calls = [];
  const engine = {
    health: async () => ({ ok: true, data: { capabilities: { jobKinds: ["layout-pdf"] } } }),
    runJob: async (_settings, kind, args) => {
      if (kind === "text-layer") {
        fs.writeFileSync(args.out, JSON.stringify(["", "", "", ""]), "utf8");
        return { ok: true, result: { pages: 4 } };
      }
      calls.push({ kind, args });
      fs.writeFileSync(args.out, "%PDF-1.4\n", "utf8");
      return { ok: true, result: { replaced: 4, kept: 0 } };
    },
  };
  const chain = { prepare: async () => { throw new Error("cache should have been reused"); } };
  registerLayoutRunner(queue, { chain, engine, vaultRoot: "", cacheRoot });
  const id = queue.start({
    kind: "layout-convert",
    title: "扫描版式文档",
    payload: { source, format: "pdf", out, settings: {} },
  });
  const task = await waitForTask(queue, id, 5000);
  assert.equal(task.status, "done", task.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.toc.length, 3, JSON.stringify(calls[0].args.toc));
  assert.deepEqual(calls[0].args.toc[0], { level: 1, title: "第一章", page: 2 });
  assert.equal(task.result?.toc?.offset, 1);
  assert.equal(task.result?.toc?.reliable, true);
  const sidecar = `${out.replace(/\.pdf$/i, "")}.figures.json`;
  assert.equal(task.result?.figures?.count, 1);
  assert.equal(task.result?.figures?.sidecar, sidecar);
  const figures = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  assert.equal(figures.version, 1);
  assert.deepEqual(figures.figures, [{ page: 2, bbox: [0.1, 0.1, 0.5, 0.5], name: "插图", type: "image" }]);
});

test("writeLayoutJson creates a readable layout next to the cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-layout-write-"));
  const target = writeLayoutJson(root, { pages: [{ page: 1, blocks: [] }] });
  assert.equal(target, path.join(root, "layout.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).pages[0].page, 1);
});

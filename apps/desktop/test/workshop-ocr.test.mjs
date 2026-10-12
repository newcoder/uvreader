import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerOcrRunners } from "../src/main/workshop-ocr.js";
import { createWorkshopQueue } from "../src/main/workshop.js";
import { uvtextPath } from "../src/shared/workshop-names.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const VAULT = "D:/vault";
const inVault = (...parts) => path.join(VAULT, ...parts);

test("uvtextPath keeps the suffix next to the extension and overwrites in place", () => {
  assert.equal(uvtextPath("Books/扫描件测试.pdf"), "Books/扫描件测试.uvtext.pdf");
  assert.equal(uvtextPath("Books\\扫描件测试.PDF"), "Books/扫描件测试.uvtext.PDF");
  assert.equal(uvtextPath("book"), "book.uvtext.pdf", "a missing extension defaults to .pdf");
  assert.equal(uvtextPath("Books/a.pdf"), uvtextPath("Books/a.pdf"), "re-exports reuse the same path");
});

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-workshop-ocr-"));
  const calls = { pages: [], closed: [], started: [] };
  const pdfOcr = {
    calls,
    openSession: async (_settings, source) => {
      calls.source = source;
      return { sessionId: "s1", pages: 3, ...(overrides.session || {}) };
    },
    page: async (_id, page) => {
      calls.pages.push(page);
      if (overrides.page) await overrides.page(page);
      return { lines: 5 };
    },
    closeSession: (id) => {
      calls.closed.push(id);
      return true;
    },
    start: (_settings, request, handlers) => {
      calls.started.push(request);
      overrides.start?.(request, handlers);
      return { jobId: request.jobId };
    },
    cancel: (jobId) => {
      calls.cancelled = jobId;
      return true;
    },
  };
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  const log = Object.assign(() => {}, { warn() {} });
  registerOcrRunners(queue, { pdfOcr, vaultRoot: VAULT, log });
  return { queue, ocr: pdfOcr, calls, dir };
}

function taskOf(queue, id) {
  return queue.snapshot().tasks.find((task) => task.id === id);
}

test("ocr-cache walks every page, resolves the vault path and closes the session", async () => {
  const { queue, calls } = setup();
  const id = queue.start({
    kind: "ocr-cache",
    title: "生成文字层",
    payload: { source: "Books/扫描件.pdf", settings: {} },
  });
  await sleep(60);
  const task = taskOf(queue, id);
  assert.equal(task.status, "done");
  assert.match(task.output, /3 页文字层已生成（15 行）/);
  assert.deepEqual(calls.pages, [1, 2, 3]);
  assert.deepEqual(calls.closed, ["s1"]);
  assert.equal(calls.source, inVault("Books", "扫描件.pdf"), "relative sources resolve against the vault");
});

test("ocr-export reports progress, resolves the output and lands the file", async () => {
  const { queue, calls } = setup({
    start: (_request, handlers) => {
      handlers.onProgress({ done: 1, total: 2 });
      setTimeout(() => handlers.onDone({ ok: true, stats: { lines_inserted: 12, skipped_text_pages: 1 } }), 5);
    },
  });
  const id = queue.start({
    kind: "ocr-export",
    title: "导出可搜索 PDF",
    payload: { source: "Books/扫描件.pdf", out: "Books/扫描件.uvtext.pdf", settings: {} },
  });
  await sleep(60);
  const task = taskOf(queue, id);
  assert.equal(task.status, "done");
  assert.equal(task.output, inVault("Books", "扫描件.uvtext.pdf"));
  assert.match(task.detail, /插入 12 行 · 跳过 1 页/);
  assert.equal(calls.started[0].source, inVault("Books", "扫描件.pdf"));
  assert.equal(calls.started[0].out, inVault("Books", "扫描件.uvtext.pdf"));
});

test("cancelling a cache task stops the walk and still closes the session", async () => {
  const { queue, calls } = setup({
    session: { pages: 50 },
    page: async () => { await sleep(15); },
  });
  const id = queue.start({ kind: "ocr-cache", title: "生成文字层", payload: { source: "Books/扫描件.pdf" } });
  await sleep(30);
  assert.equal(queue.cancel(id), true);
  await sleep(80);
  const task = taskOf(queue, id);
  assert.equal(task.status, "cancelled");
  assert.deepEqual(calls.closed, ["s1"]);
  assert.ok(calls.pages.length < 50, "the page walk stopped early");
});

test("cancelling an export job cancels the sidecar job", async () => {
  const { queue, calls } = setup({
    start: () => { /* never settles: the cancel path owns the job */ },
  });
  const id = queue.start({
    kind: "ocr-export",
    title: "导出可搜索 PDF",
    payload: { source: "Books/扫描件.pdf", out: "Books/扫描件.uvtext.pdf" },
  });
  await sleep(20);
  assert.equal(queue.cancel(id), true);
  await sleep(30);
  const task = taskOf(queue, id);
  assert.equal(task.status, "cancelled");
  assert.equal(calls.cancelled, calls.started[0].jobId, "the sidecar job is cancelled");
});

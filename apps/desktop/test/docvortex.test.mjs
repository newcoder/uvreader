import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { convertArgs, createDocvortex, docvortexCandidates, registerDocvortexRunners } from "../src/main/docvortex.js";
import { createWorkshopQueue } from "../src/main/workshop.js";
import { waitForTask } from "./wait-for-task.mjs";
import { convertPath } from "../src/shared/workshop-names.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal child_process.spawn stand-in: records the call and lets the test
// answer on the next tick, after the caller attached its listeners.
function fakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, killed: false };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { call.killed = true; };
    setImmediate(() => handler(call, child));
    return child;
  };
  return { spawnImpl, calls };
}

test("convertPath uses the target extension and numbers collisions", () => {
  assert.equal(convertPath("Books/报告.docx", "md"), "Books/报告.md");
  assert.equal(convertPath("Books\\报告.docx", "html"), "Books/报告.html");
  assert.equal(convertPath("报告", "pdf"), "报告.pdf");
  const taken = new Set(["Books/a.md", "Books/a (1).md"]);
  assert.equal(convertPath("Books/a.docx", "md", (candidate) => taken.has(candidate)), "Books/a (2).md");
  // 扩展名不变(如 PDF→PDF):源文件本身占位,落到 (1) 而不是覆盖。
  const source = new Set(["Books/报告.pdf"]);
  assert.equal(convertPath("Books/报告.pdf", "pdf", (candidate) => source.has(candidate)), "Books/报告 (1).pdf");
});

test("convertArgs builds the docvortex command line", () => {
  assert.deepEqual(
    convertArgs("D:/vault/a.docx", "markdown", "D:/vault/a.md"),
    ["convert", "D:/vault/a.docx", "--format", "markdown", "--output", "D:/vault/a.md", "--overwrite"],
  );
});

test("docvortexCandidates prefers a custom path, then PATH, then python", () => {
  assert.deepEqual(
    docvortexCandidates({ docvortexPath: "D:/tools/docvortex.exe", docvortexPython: "py" }).map((entry) => entry.kind),
    ["custom", "path", "python"],
  );
  const fallback = docvortexCandidates({ ocrPython: "python3" });
  assert.deepEqual(fallback.map((entry) => entry.kind), ["path", "python"]);
  assert.deepEqual(fallback[1].args, ["-m", "docvortex"]);
  assert.equal(fallback[1].command, "python3");
});

test("probe falls back through the candidates and reports the first that answers", async () => {
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    if (call.command === "docvortex") {
      child.stdout.emit("data", "docvortex, version 0.5.16\n");
      child.emit("close", 0);
      return;
    }
    child.emit("error", new Error("ENOENT"));
  });
  const docvortex = createDocvortex({ spawnImpl, probeTimeoutMs: 200 });
  const result = await docvortex.probe({});
  assert.equal(result.ok, true);
  assert.equal(result.kind, "path");
  assert.match(result.detail, /0\.5\.16/);
  assert.equal(calls[0].args.at(-1), "--version");
});

test("probe reports a hint when nothing answers", async () => {
  const { spawnImpl } = fakeSpawn((_call, child) => child.emit("error", new Error("ENOENT")));
  const docvortex = createDocvortex({ spawnImpl, probeTimeoutMs: 200 });
  const result = await docvortex.probe({});
  assert.equal(result.ok, false);
  assert.match(result.detail, /pip install docvortex/);
});

test("convert writes the output and surfaces a failing exit code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-"));
  const source = path.join(dir, "a.docx");
  const out = path.join(dir, "a.md");
  fs.writeFileSync(source, "docx");
  const { spawnImpl } = fakeSpawn((call, child) => {
    if (call.args.includes("--version")) {
      child.stdout.emit("data", "docvortex 0.5.16\n");
      child.emit("close", 0);
      return;
    }
    const outputArg = call.args[call.args.indexOf("--output") + 1];
    if (outputArg === out) {
      fs.writeFileSync(out, "# converted");
      child.emit("close", 0);
      return;
    }
    child.stderr.emit("data", "boom: bad file");
    child.emit("close", 1);
  });
  const docvortex = createDocvortex({ spawnImpl, probeTimeoutMs: 200 });
  const ok = await docvortex.convert({}, { source, format: "markdown", out });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(out, "utf8"), "# converted");

  const failed = await docvortex.convert({}, { source, format: "markdown", out: path.join(dir, "missing.md") });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /boom/);
});

test("cancelling a conversion kills the child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-cancel-"));
  const source = path.join(dir, "a.docx");
  fs.writeFileSync(source, "docx");
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    if (call.args.includes("--version")) {
      child.stdout.emit("data", "docvortex 0.5.16\n");
      child.emit("close", 0);
      return;
    }
    // The conversion never settles: the cancel path owns it.
  });
  const docvortex = createDocvortex({ spawnImpl, probeTimeoutMs: 200 });
  const controller = new AbortController();
  const pending = docvortex.convert({}, { source, format: "markdown", out: path.join(dir, "a.md"), signal: controller.signal });
  await sleep(30);
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls.at(-1).killed, true);
});

function fakeRunner(docvortex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-run-"));
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, { docvortex, vaultRoot: "D:/vault", log: () => {} });
  return { queue, dir };
}

test("the convert runner resolves the vault path and lands the output", async () => {
  const calls = [];
  const { queue } = fakeRunner({
    probe: async () => ({ ok: true, detail: "docvortex 0.5.16", command: "docvortex", args: [], kind: "path" }),
    convert: async (_settings, request) => {
      calls.push(request);
      return { ok: true, out: request.out };
    },
  });
  const id = queue.start({
    kind: "docvortex-convert",
    title: "文档互转",
    payload: { source: "Books/报告.docx", format: "markdown", out: "Books/报告.md" },
  });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done");
  assert.equal(task.output, path.join("D:/vault", "Books", "报告.md"));
  assert.equal(calls[0].source, path.join("D:/vault", "Books", "报告.docx"));
  assert.equal(calls[0].format, "markdown");
});

test("the convert runner numbers the output when it already exists", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-dup-"));
  fs.mkdirSync(path.join(vault, "Books"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Books", "报告.docx"), "docx");
  fs.writeFileSync(path.join(vault, "Books", "报告.md"), "先来的产物");
  const calls = [];
  const queue = createWorkshopQueue({ file: path.join(vault, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, {
    docvortex: {
      probe: async () => ({ ok: true }),
      convert: async (_settings, request) => {
        calls.push(request);
        return { ok: true, out: request.out };
      },
    },
    vaultRoot: vault,
    log: () => {},
  });
  const id = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "Books/报告.docx", format: "markdown" } });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(task.output, path.join(vault, "Books", "报告 (1).md"), "同名加序号,不覆盖已有产物");
  assert.equal(calls[0].out, task.output);
});

test("the convert runner cleans PDF furniture before DocVortex sees the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-clean-"));
  const source = path.join(dir, "试卷.pdf");
  fs.writeFileSync(source, "%PDF-1.4");
  fs.writeFileSync(path.join(dir, "讲义.docx"), "docx");
  const calls = [];
  let cleanedPath = "";
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, {
    docvortex: {
      probe: async () => ({ ok: true }),
      convert: async (_settings, request) => {
        calls.push(request);
        return { ok: true, out: request.out };
      },
    },
    vaultRoot: dir,
    cleaner: {
      clean: async () => {
        cleanedPath = path.join(dir, "clean-试卷.pdf");
        fs.writeFileSync(cleanedPath, "%PDF-clean");
        return { ok: true, path: cleanedPath, removed: 3 };
      },
    },
    log: () => {},
  });
  const first = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "试卷.pdf", format: "markdown", settings: {} } });
  await sleep(40);
  assert.equal((await waitForTask(queue, first)).status, "done");
  assert.equal(calls[0].source, cleanedPath, "PDF 先清理再交给 DocVortex(这条链路不经过 pdf_tool)");
  const second = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "讲义.docx", format: "markdown", settings: {} } });
  await sleep(40);
  assert.equal((await waitForTask(queue, second)).status, "done");
  assert.equal(calls[1].source, path.join(dir, "讲义.docx"), "非 PDF 原样交给 DocVortex");
});

test("the probe runner fails the task when docvortex is missing", async () => {
  const { queue } = fakeRunner({
    probe: async () => ({ ok: false, detail: "未找到 docvortex(可 pip install docvortex 或填写路径)" }),
    convert: async () => ({ ok: false, error: "unused" }),
  });
  const id = queue.start({ kind: "docvortex-probe", title: "检测 DocVortex", payload: {} });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "failed");
  assert.match(task.error, /pip install docvortex/);
});

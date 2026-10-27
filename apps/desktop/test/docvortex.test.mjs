import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { convertArgs, createDocvortex, docvortexCandidates, registerDocvortexRunners, removeTextSourceBridge, textSourceHtml, writeTextSourceBridge } from "../src/main/docvortex.js";
import JSZip from "jszip";
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
    ["custom", "path", "python-cli", "python"],
  );
  const fallback = docvortexCandidates({ ocrPython: "python3" });
  assert.deepEqual(fallback.map((entry) => entry.kind), ["path", "python-cli", "python"]);
  assert.deepEqual(fallback[1].args, ["-c", "from docvortex.cli import main; main()"]);
  assert.equal(fallback[1].command, "python3");
  assert.deepEqual(fallback[2].args, ["-m", "docvortex"]);
});

// Markdown / 纯文本 DocVortex 收不了(0.5.16 的原生输入里没有它们,直接给会报
// `Unsupported native input format: markdown|txt`):书坊先渲染成 HTML 再转换。
test("textSourceHtml renders Markdown with the math markers DocVortex reads", () => {
  const html = textSourceHtml("论文.md", [
    "\uFEFF# 标题一",
    "",
    "行内 $E = mc^2$ 与**粗体**",
    "",
    "$$",
    "\\int_0^1 x^2 dx",
    "$$",
    "",
    "- 列表项",
    "",
    "| 列1 | 列2 |",
    "| --- | --- |",
    "| a | b |",
  ].join("\n"));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>论文<\/title>/);
  assert.match(html, /<h1>标题一<\/h1>/, "带 BOM 时第一个标题也要认得出来");
  assert.match(html, /<script type="math\/tex">E = mc\^2<\/script>/, "行内公式写成 DocVortex 的 script 标签");
  assert.match(html, /<p><script type="math\/tex; mode=display">\\int_0\^1 x\^2 dx<\/script><\/p>/, "行间公式配 mode=display");
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(textSourceHtml("说明.txt", "\uFEFF第一段\n\n第二段"), /<p>第一段<\/p>\n<p>第二段<\/p>/);
});

test("writeTextSourceBridge lands the bridge beside the source so relative images resolve", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-bridge-"));
  const source = path.join(dir, "书稿.md");
  fs.writeFileSync(source, "# 一\n![图](images/fig-1.png)\n", "utf8");
  const bridge = writeTextSourceBridge(source, {});
  assert.equal(path.dirname(bridge), dir, "桥文件与源文件同目录(资源根才对)");
  assert.match(path.basename(bridge), /^\.书稿\.md\.bridge-[0-9a-z]+\.html$/);
  const html = fs.readFileSync(bridge, "utf8");
  assert.match(html, /<img src="images\/fig-1\.png"/, "图片引用保持相对路径");
  removeTextSourceBridge(bridge);
  assert.equal(fs.existsSync(bridge), false, "桥文件用完就删");
  assert.equal(writeTextSourceBridge(path.join(dir, "书稿.docx"), {}), "", "非文本源不写桥");
});

test("the convert runner sends Markdown through an HTML bridge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-bridge-"));
  fs.writeFileSync(path.join(dir, "说明书.md"), "# 一\n\n行内 $a^2$ 与正文\n", "utf8");
  const calls = [];
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, {
    docvortex: {
      probe: async () => ({ ok: true }),
      convert: async (_settings, request) => {
        calls.push({ ...request, body: fs.readFileSync(request.source, "utf8") });
        fs.writeFileSync(request.out, "converted");
        return { ok: true, out: request.out };
      },
    },
    vaultRoot: dir,
    cacheRoot: path.join(dir, "cache"),
    log: () => {},
  });
  const id = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "说明书.md", format: "docx" } });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(task.output, path.join(dir, "说明书.docx"));
  assert.match(calls[0].source, /\.说明书\.md\.bridge-[0-9a-z]+\.html$/, "DocVortex 收到 HTML 桥文件而不是 .md");
  assert.match(calls[0].body, /<h1>一<\/h1>/);
  assert.match(calls[0].body, /<script type="math\/tex">a\^2<\/script>/);
  assert.equal(fs.existsSync(calls[0].source), false, "转换完桥文件不留在用户目录里");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes("bridge")), []);
});

// DocVortex 的 HTML→DOCX 列表是「字面编号 + 缩进」的普通段落(没有 w:numPr):
// md/txt 桥出去的 docx 产物要换成真 Word 列表,其它链路不碰。
test("the convert runner restores real Word lists for text sources only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-number-"));
  const para = (text, indent) => `<w:p><w:pPr><w:ind w:left="${indent}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const docx = path.join(dir, "docvortex-out.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types/>');
  zip.file("word/numbering.xml", '<?xml version="1.0"?><w:numbering xmlns:w="w"></w:numbering>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${para("1. 第一项", 340)}${para("- 细则", 680)}${para("2. 第二项", 340)}</w:body></w:document>`);
  fs.writeFileSync(docx, await zip.generateAsync({ type: "nodebuffer" }));
  fs.writeFileSync(path.join(dir, "规格.md"), "# 规格\n\n1. 第一项\n- 细则\n\n2. 第二项\n", "utf8");
  fs.copyFileSync(docx, path.join(dir, "输入.docx"));
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, {
    docvortex: {
      probe: async () => ({ ok: true }),
      // 每次转换都把「DocVortex 那种产物」复制成结果。
      convert: async (_settings, request) => { fs.copyFileSync(docx, request.out); return { ok: true, out: request.out }; },
    },
    vaultRoot: dir,
    cacheRoot: path.join(dir, "cache"),
    log: () => {},
  });
  const read = async (file) => (await JSZip.loadAsync(fs.readFileSync(file))).file("word/document.xml").async("string");

  const bridged = queue.start({ kind: "docvortex-convert", payload: { source: "规格.md", format: "docx" } });
  await sleep(60);
  const first = await waitForTask(queue, bridged);
  assert.equal(first.status, "done", first.error);
  const restored = await read(first.output);
  assert.equal((restored.match(/<w:numPr>/g) || []).length, 3, "文本源产物:三个列表段落都换成真编号");
  assert.ok(!/w:t[^>]*>\s*\d+\.\s/.test(restored), "字面编号去掉");

  const other = queue.start({ kind: "docvortex-convert", payload: { source: "输入.docx", format: "docx" } });
  await sleep(60);
  const second = await waitForTask(queue, other);
  assert.equal(second.status, "done", second.error);
  const untouched = await read(second.output);
  assert.equal((untouched.match(/<w:numPr>/g) || []).length, 0, "docx → docx 不是我们的桥,不动它");
  assert.match(untouched, /w:t[^>]*>1\. 第一项</, "原样保留");
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

test("probe falls back to the python cli entry point when the executable is missing", async () => {
  const { spawnImpl } = fakeSpawn((call, child) => {
    if (call.command === "python" && call.args[0] === "-c") {
      child.stdout.emit("data", "docvortex, version 0.5.16\n");
      child.emit("close", 0);
      return;
    }
    child.emit("error", new Error("ENOENT"));
  });
  const docvortex = createDocvortex({ spawnImpl, probeTimeoutMs: 200 });
  const result = await docvortex.probe({ ocrPython: "python" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "python-cli");
  assert.match(result.detail, /0\.5\.16/);
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

test("the convert runner wraps an image in a temporary PDF before DocVortex OCR", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-docvortex-image-"));
  const source = path.join(dir, "试卷.png");
  fs.writeFileSync(source, "png");
  const calls = [];
  const { spawnImpl } = fakeSpawn((call, child) => {
    const out = call.args[call.args.length - 1];
    fs.writeFileSync(out, "%PDF-1.4 image");
    child.emit("close", 0);
  });
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerDocvortexRunners(queue, {
    docvortex: {
      probe: async () => ({ ok: true }),
      convert: async (_settings, request) => {
        calls.push({ ...request, existed: fs.existsSync(request.source) });
        return { ok: true, out: request.out };
      },
    },
    vaultRoot: dir,
    spawnImpl,
    log: () => {},
  });
  const id = queue.start({ kind: "docvortex-convert", title: "文档互转", payload: { source: "试卷.png", format: "markdown", settings: {} } });
  await sleep(40);
  const task = await waitForTask(queue, id);
  assert.equal(task.status, "done", task.error);
  assert.equal(calls[0].parseMode, "ocr");
  assert.match(path.basename(calls[0].source), /^uvreader-image-.*\.pdf$/);
  assert.equal(calls[0].existed, true, "the temporary PDF exists while DocVortex reads it");
  assert.equal(fs.existsSync(calls[0].source), false, "the temporary PDF is removed afterwards");
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

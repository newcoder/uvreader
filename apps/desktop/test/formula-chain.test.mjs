import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkshopQueue } from "../src/main/workshop.js";
import {
  createFormulaChain,
  formulaCacheDir,
  friendlyPdfToolError,
  pdfToolArgs,
  pdfToolScriptCommand,
  registerFormulaRunners,
  resolveMineruToken,
  tableModeFor,
} from "../src/main/workshop-formula.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function makePdfToolDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdftool-"));
  fs.mkdirSync(path.join(dir, "pdf_tool"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pdf_tool", "pdf_to_doc.py"), "# stub\n");
  return dir;
}

function writeDocJson(workDir, stem, blocks) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, `${stem}_doc.json`),
    JSON.stringify({ schema_version: 1, source: { stem }, pages: [{ page: 1, blocks }] }),
    "utf8",
  );
}

test("pdfToolScriptCommand needs a checkout with the converter entry", () => {
  assert.match(pdfToolScriptCommand({}).error, /pdf_tool/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-pdftool-empty-"));
  assert.match(pdfToolScriptCommand({ ocrSidecarDir: empty }).error, /pdf_tool/);
  const dir = makePdfToolDir();
  const target = pdfToolScriptCommand({ ocrSidecarDir: dir, ocrPython: "py" });
  assert.equal(target.command, "py");
  assert.equal(target.cwd, dir);
  assert.equal(target.script, path.join(dir, "pdf_tool", "pdf_to_doc.py"));
});

test("pdfToolArgs requests the MinerU JSON doc; credentials travel in the environment", () => {
  const base = pdfToolArgs("D:/pt/pdf_tool/pdf_to_doc.py", { source: "D:/v/a.pdf", outDir: "D:/work" });
  assert.deepEqual(base.slice(0, 7), ["D:/pt/pdf_tool/pdf_to_doc.py", "--pdf", "D:/v/a.pdf", "--mode", "mineru", "--formats", "json"]);
  assert.ok(base.includes("--out-dir") && base.includes("D:/work"));
  assert.ok(!base.some((arg) => String(arg).includes("mineru-token")), "the token never reaches the command line");
  const full = pdfToolArgs("s", { source: "a", outDir: "w", model: "pipeline", pages: "1-3" });
  assert.deepEqual(full.slice(full.indexOf("--pages")), ["--pages", "1-3", "--mineru-model", "pipeline"]);
});

test("resolveMineruToken prefers settings, then the process env, then the registry", () => {
  assert.equal(
    resolveMineruToken({ mineruToken: " from-settings " }, { env: { MINERU_API_KEY: "env" }, readEnv: () => "reg" }),
    "from-settings",
  );
  assert.equal(resolveMineruToken({}, { env: { MINERU_TOKEN: "env-token" }, readEnv: () => "reg" }), "env-token");
  assert.equal(resolveMineruToken({}, { env: {}, readEnv: (name) => (name === "MINERU_API_KEY" ? "reg-key" : "") }), "reg-key");
  assert.equal(resolveMineruToken({}, { env: {}, readEnv: () => "" }), "");
});

test("friendlyPdfToolError turns the missing-credential traceback into an action", () => {
  const message = friendlyPdfToolError("Traceback (most recent call last):\n  File \"pipeline.py\", line 153\nValueError: mode=mineru 需要 mineru_token");
  assert.match(message, /MinerU 凭据/);
  assert.match(message, /重启应用/);
  assert.equal(friendlyPdfToolError("解析超时（30s）\n  "), "解析超时（30s）");
});

test("formulaCacheDir is stable, page-aware and filesystem-safe", () => {
  const root = "C:/cache";
  const a = formulaCacheDir(root, "D:/docs/测试 文档.pdf");
  const b = formulaCacheDir(root, "D:/docs/测试 文档.pdf");
  assert.equal(a, b);
  assert.notEqual(a, formulaCacheDir(root, "D:/docs/测试 文档.pdf", "1-3"));
  assert.match(path.basename(a), /^测试_文档-[0-9a-f]{10}$/);
});

test("prepare runs pdf_tool, reads the Doc JSON and writes the formula HTML", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-work-"));
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    writeDocJson(workDir, "a", [
      { type: "text", text: "速度 $v = v_{0} + at$" },
      { type: "equation", text: "$$\nx = \\frac{a}{b}\n$$" },
    ]);
    child.stdout.emit("data", "mode=mineru ok");
    child.emit("close", 0);
  });
  const chain = createFormulaChain({ spawnImpl, textLayer: { read: async () => ({ ok: false, error: "stub" }) } });
  const result = await chain.prepare({
    settings: { ocrSidecarDir: dir, mineruToken: "tk" },
    source: "D:/vault/a.pdf",
    workDir,
  });
  assert.equal(result.ok, true);
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.match(html, /<script type="math\/tex">v = v_\{0\} \+ at<\/script>/);
  assert.match(html, /<script type="math\/tex; mode=display">x = \\frac\{a\}\{b\}<\/script>/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, dir);
  assert.equal(calls[0].options.env.MINERU_API_KEY, "tk", "the credential travels in the child environment");
  assert.ok(!calls[0].args.includes("--mineru-token"));
});

test("tableModeFor sends DOCX and PDF targets to the table screenshot", () => {
  assert.equal(tableModeFor("docx"), "image");
  assert.equal(tableModeFor("pdf"), "image");
  assert.equal(tableModeFor("DOCX"), "image");
  assert.equal(tableModeFor("html"), "table");
  assert.equal(tableModeFor("latex"), "table");
  assert.equal(tableModeFor(""), "table");
});

test("prepare gives DOCX/PDF targets a table screenshot instead of HTML tables", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-table-"));
  const { spawnImpl } = fakeSpawn((_call, child) => {
    writeDocJson(workDir, "t", [
      { type: "table", headers: ["a"], rows: [["1"]], image: { src: "mineru/images/t.jpg", alt: "表格" } },
    ]);
    child.emit("close", 0);
  });
  const chain = createFormulaChain({ spawnImpl, textLayer: { read: async () => ({ ok: false, error: "stub" }) } });
  const settings = { ocrSidecarDir: dir, mineruToken: "tk" };
  const asHtml = await chain.prepare({ settings, source: "D:/vault/t.pdf", workDir, format: "html" });
  assert.equal(asHtml.ok, true, asHtml.error);
  assert.match(fs.readFileSync(asHtml.htmlPath, "utf8"), /<table>/, "HTML 目标用真表格");
  const asDocx = await chain.prepare({ settings, source: "D:/vault/t.pdf", workDir, format: "docx" });
  assert.equal(asDocx.ok, true, asDocx.error);
  assert.match(fs.readFileSync(asDocx.htmlPath, "utf8"), /<img src="mineru\/images\/t\.jpg"/, "DOCX 目标用表格截图");
});

test("prepare reuses the cached MinerU doc instead of calling the cloud again", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-cache-"));
  const pdf = path.join(workDir, "a.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4");
  writeDocJson(workDir, "a", [{ type: "text", text: "缓存命中 $x$ 测试" }]);
  const { spawnImpl, calls } = fakeSpawn((call, child) => {
    writeDocJson(workDir, "a", [{ type: "text", text: "重新解析 $x$" }]);
    void call;
    child.emit("close", 0);
  });
  const chain = createFormulaChain({ spawnImpl, textLayer: { read: async () => ({ ok: false, error: "stub" }) } });
  const cached = await chain.prepare({ settings: { ocrSidecarDir: dir, mineruToken: "tk" }, source: pdf, workDir });
  assert.equal(cached.ok, true, cached.error);
  assert.equal(calls.length, 0, "命中缓存时不再调用 pdf_tool（MinerU 慢且计费）");
  assert.match(fs.readFileSync(cached.htmlPath, "utf8"), /缓存命中 <script type="math\/tex">x<\/script>/);
  const refreshed = await chain.prepare({ settings: { ocrSidecarDir: dir, mineruToken: "tk" }, source: pdf, workDir, refresh: true });
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.equal(calls.length, 1, "refresh 才重新解析");
  assert.match(fs.readFileSync(refreshed.htmlPath, "utf8"), /重新解析/);
});

test("prepare surfaces a failing pdf_tool exit and cancels cleanly", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-fail-"));
  const failing = fakeSpawn((_call, child) => {
    child.stderr.emit("data", "mineru: 缺少 token");
    child.emit("close", 2);
  });
  const chain = createFormulaChain({ spawnImpl: failing.spawnImpl });
  const failed = await chain.prepare({ settings: { ocrSidecarDir: dir }, source: "a.pdf", workDir });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /缺少 token/);

  const hanging = fakeSpawn(() => {});
  const controller = new AbortController();
  const pending = createFormulaChain({ spawnImpl: hanging.spawnImpl }).prepare({
    settings: { ocrSidecarDir: dir },
    source: "a.pdf",
    workDir,
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.equal(hanging.calls[0].killed, true);
});

function makeQueue(chain, docvortex, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-queue-"));
  const queue = createWorkshopQueue({ file: path.join(dir, "tasks.json"), onState: () => {}, log: { warn() {} } });
  registerFormulaRunners(queue, {
    chain,
    docvortex,
    vaultRoot: "D:/vault",
    cacheRoot: path.join(dir, "cache"),
    readEnv: options.readEnv || (() => ""),
    log: () => {},
  });
  return { queue, dir };
}

test("the formula runner chains pdf_tool output into DocVortex", async () => {
  const dir = makePdfToolDir();
  const calls = [];
  const chain = {
    prepare: async ({ workDir }) => {
      const htmlPath = path.join(workDir, "bridge.html");
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(htmlPath, "<html></html>", "utf8");
      return { ok: true, htmlPath, docPath: path.join(workDir, "a_doc.json") };
    },
  };
  const docvortex = {
    probe: async () => ({ ok: true, detail: "docvortex 0.5.16", command: "docvortex", args: [], kind: "path" }),
    convert: async (_settings, request) => {
      calls.push(request);
      return { ok: true, out: request.out };
    },
  };
  const { queue } = makeQueue(chain, docvortex);
  const id = queue.start({
    kind: "formula-convert",
    title: "公式文档",
    payload: { source: "Books/试卷.pdf", format: "docx", out: "Books/试卷.docx", settings: { ocrSidecarDir: dir } },
  });
  await sleep(40);
  const task = queue.snapshot().tasks.find((entry) => entry.id === id);
  assert.equal(task.status, "done");
  assert.equal(task.output, path.join("D:/vault", "Books", "试卷.docx"));
  assert.equal(calls[0].source.endsWith("bridge.html"), true);
  assert.equal(calls[0].format, "docx");
});

test("the formula probe reports a missing MinerU credential", async () => {
  const dir = makePdfToolDir();
  const { queue } = makeQueue(
    { prepare: async () => ({ ok: true }) },
    { probe: async () => ({ ok: true, detail: "docvortex" }), convert: async () => ({ ok: true }) },
  );
  const saved = { key: process.env.MINERU_API_KEY, token: process.env.MINERU_TOKEN };
  delete process.env.MINERU_API_KEY;
  delete process.env.MINERU_TOKEN;
  try {
    const id = queue.start({ kind: "formula-probe", title: "检测公式链路", payload: { settings: { ocrSidecarDir: dir } } });
    await sleep(40);
    const task = queue.snapshot().tasks.find((entry) => entry.id === id);
    assert.equal(task.status, "failed");
    assert.match(task.error, /MINERU_API_KEY/);
  } finally {
    if (saved.key !== undefined) process.env.MINERU_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.MINERU_TOKEN = saved.token;
  }
});

test("the formula probe passes when pdf_tool, credential and DocVortex are present", async () => {
  const dir = makePdfToolDir();
  const { queue } = makeQueue(
    { prepare: async () => ({ ok: true }) },
    { probe: async () => ({ ok: true, detail: "docvortex 0.5.16" }), convert: async () => ({ ok: true }) },
  );
  const saved = process.env.MINERU_API_KEY;
  process.env.MINERU_API_KEY = "tk";
  try {
    const id = queue.start({ kind: "formula-probe", title: "检测公式链路", payload: { settings: { ocrSidecarDir: dir } } });
    await sleep(40);
    const task = queue.snapshot().tasks.find((entry) => entry.id === id);
    assert.equal(task.status, "done");
    assert.match(task.output, /MinerU \+ DocVortex/);
  } finally {
    if (saved === undefined) delete process.env.MINERU_API_KEY;
    else process.env.MINERU_API_KEY = saved;
  }
});

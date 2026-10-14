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

test("prepare uses the local MinerU service without cloud credentials", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-local-"));
  const { spawnImpl, calls } = fakeSpawn((_call, child) => {
    writeDocJson(workDir, "l", [{ type: "text", text: "正文 $x$" }]);
    child.emit("close", 0);
  });
  const healthy = { ok: true, status: 200, json: async () => ({ status: "ok", version: "4.0.12" }) };
  const exe = path.join(dir, "mineru-kit.exe");
  fs.writeFileSync(exe, "stub");
  const chain = createFormulaChain({ spawnImpl, readEnv: () => "", fetchImpl: async () => healthy, textLayer: { read: async () => ({ ok: false, error: "stub" }) } });
  const result = await chain.prepare({
    settings: { ocrSidecarDir: dir, mineruSource: "local", mineruLocalUrl: "http://127.0.0.1:8123", mineruLocalExe: exe },
    source: "D:/vault/l.pdf",
    workDir,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.length, 1, "没有云端凭据也能跑本地");
  const index = calls[0].args.indexOf("--mineru-source");
  assert.ok(index > 0, "显式指定本地后端");
  assert.equal(calls[0].args[index + 1], "local");
  assert.equal(calls[0].options.env.MINERU_LOCAL_URL, "http://127.0.0.1:8123", "服务在跑就把地址交给 pdf_tool");
  assert.equal(calls[0].options.env.MINERU_LOCAL_CMD, path.join(dir, "mineru-kit.exe"), "程序路径同时也给:helper 靠它找 venv python");  assert.equal(calls[0].options.env.PYTHONUTF8, "1", "pdf_tool 的中文报错按 UTF-8 出来");
  assert.equal(calls[0].options.env.PYTHONIOENCODING, "utf-8");
  assert.ok(!calls[0].args.includes("--mineru-url"), "地址不进命令行");
});

test("prepare falls back to the mineru-kit CLI when the local service is down", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-cli-"));
  const { spawnImpl, calls } = fakeSpawn((_call, child) => {
    writeDocJson(workDir, "c", [{ type: "text", text: "正文 $y$" }]);
    child.emit("close", 0);
  });
  const exe = path.join(dir, "mineru-kit.exe");
  fs.writeFileSync(exe, "stub");
  const chain = createFormulaChain({
    spawnImpl,
    readEnv: () => "",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    textLayer: { read: async () => ({ ok: false, error: "stub" }) },
  });
  const result = await chain.prepare({
    settings: { ocrSidecarDir: dir, mineruSource: "local", mineruLocalExe: exe },
    source: "D:/vault/c.pdf",
    workDir,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls[0].options.env.MINERU_LOCAL_CMD, exe, "服务没起来就把程序路径交给 pdf_tool 的 CLI");
  assert.ok(!calls[0].options.env.MINERU_LOCAL_URL, "死地址不传下去");
});

test("a stale MINERU_LOCAL_URL in the environment never reaches pdf_tool", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-stale-"));
  const exe = path.join(dir, "mineru-kit.exe");
  fs.writeFileSync(exe, "stub");
  const { spawnImpl, calls } = fakeSpawn((_call, child) => {
    writeDocJson(workDir, "s", [{ type: "text", text: "正文 $z$" }]);
    child.emit("close", 0);
  });
  const saved = process.env.MINERU_LOCAL_URL;
  process.env.MINERU_LOCAL_URL = "http://127.0.0.1:8123";
  try {
    const chain = createFormulaChain({
      spawnImpl,
      readEnv: () => "",
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
      textLayer: { read: async () => ({ ok: false, error: "stub" }) },
    });
    const result = await chain.prepare({
      settings: { ocrSidecarDir: dir, mineruSource: "local", mineruLocalExe: exe },
      source: "D:/vault/s.pdf",
      workDir,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls[0].options.env.MINERU_LOCAL_URL, "", "继承来的死地址被显式清掉(否则 pdf_tool 会硬连)");
    assert.equal(calls[0].options.env.MINERU_LOCAL_CMD, exe, "退回 CLI");
  } finally {
    if (saved === undefined) delete process.env.MINERU_LOCAL_URL;
    else process.env.MINERU_LOCAL_URL = saved;
  }
});

test("prepare without a token or a local service asks for one", async () => {
  const dir = makePdfToolDir();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-formula-none-"));
  const chain = createFormulaChain({ spawnImpl: fakeSpawn(() => {}).spawnImpl, readEnv: () => "", textLayer: { read: async () => ({ ok: false, error: "stub" }) } });
  // 本机环境里可能就配了 MINERU_API_KEY:这条用例要的就是「都没有」的状态。
  const saved = { key: process.env.MINERU_API_KEY, token: process.env.MINERU_TOKEN };
  delete process.env.MINERU_API_KEY;
  delete process.env.MINERU_TOKEN;
  try {
    const result = await chain.prepare({ settings: { ocrSidecarDir: dir }, source: "D:/vault/x.pdf", workDir });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /MinerU 凭据/);
    assert.match(String(result.error), /本地 MinerU/);
  } finally {
    if (saved.key !== undefined) process.env.MINERU_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.MINERU_TOKEN = saved.token;
  }
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
  // 凭据固定成「有」,免得用例跟着跑测机器的环境变量走(CI 上没有凭据,
  // 会先在凭据检查那一步返回,走不到 pdf_tool 的失败分支)。
  const chain = createFormulaChain({ spawnImpl: failing.spawnImpl, readEnv: () => "" });
  const failed = await chain.prepare({ settings: { ocrSidecarDir: dir, mineruToken: "tk" }, source: "a.pdf", workDir });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /缺少 token/);

  const hanging = fakeSpawn(() => {});
  const controller = new AbortController();
  const pending = createFormulaChain({ spawnImpl: hanging.spawnImpl, readEnv: () => "" }).prepare({
    settings: { ocrSidecarDir: dir, mineruToken: "tk" },
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

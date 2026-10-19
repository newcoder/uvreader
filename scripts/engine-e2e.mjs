// 书坊引擎的端到端测试:起**真服务**(临时配置 + 随机端口),用**真客户端**把每类作业跑一遍。
//
// 覆盖:health / 令牌鉴权 / 配置往返(令牌不回显、能力随配置变) / math(含空壳修复)
//      text-layer / outline / pdf-text / redact / images-to-pdf / extract(假 pdf_tool)
//      convert(假 docvortex) / 取消 / 错误路径。
//
// 依赖:python 里要有 fastapi、uvicorn、pymupdf、pillow、latex2mathml。
// 用法:node scripts/engine-e2e.mjs [--python <解释器>] [--require]
//   --require: 依赖缺失时直接失败(CI 用;本地默认缺依赖就跳过)。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEngineClient, describeEngineHealth, engineCapabilityRows } from "../apps/desktop/src/main/engine-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const engineRoot = path.join(repoRoot, "engine");

const args = process.argv.slice(2);
const pythonFlag = args.indexOf("--python");
const python = pythonFlag >= 0 ? args[pythonFlag + 1] : (process.env.QBR_ENGINE_PYTHON || "python");
const requireDeps = args.includes("--require");

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// ── 依赖检查 ─────────────────────────────────────────────────────────
const deps = spawnSync(python, ["-c", "import fastapi, uvicorn, latex2mathml, fitz, PIL"], { timeout: 60_000 });
if (deps.status !== 0) {
  const message = `python(${python})里缺少引擎依赖(fastapi / uvicorn / latex2mathml / pymupdf / pillow)`;
  if (requireDeps) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  console.log(`… 跳过:${message}`);
  process.exit(0);
}

// ── 夹具 ─────────────────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-e2e-"));
const configFile = path.join(work, "engine-config.json");
const fixturePdf = path.join(work, "book.pdf");
const outlinePdf = path.join(work, "outline.pdf");
const dirtyPdf = path.join(work, "dirty.pdf");
const images = [path.join(work, "p1.png"), path.join(work, "p2.png")];
const stubPdfTool = path.join(work, "auto_chat");
const stubDocvortex = path.join(work, "stubs");

fs.mkdirSync(path.join(stubPdfTool, "pdf_tool"), { recursive: true });
fs.writeFileSync(path.join(stubPdfTool, "pdf_tool", "pdf_to_doc.py"), [
  "import json, sys",
  "out = sys.argv[sys.argv.index('--out-dir') + 1]",
  "open(out + '/book_doc.json', 'w', encoding='utf-8').write(json.dumps({'mode': 'stub'}))",
  "print('stub pdf_tool ok')",
].join("\n"), "utf8");
fs.mkdirSync(stubDocvortex, { recursive: true });
fs.writeFileSync(path.join(stubDocvortex, "docvortex.py"), [
  "import pathlib, sys",
  "out = sys.argv[sys.argv.index('--output') + 1]",
  "pathlib.Path(out).write_text('# converted', encoding='utf-8')",
  "print('stub docvortex ok')",
].join("\n"), "utf8");

const fixtureScript = `
import fitz, sys
book, outline, dirty = sys.argv[1], sys.argv[2], sys.argv[3]
doc = fitz.open()
for index in range(3):
    page = doc.new_page()
    page.insert_text((72, 72), f"page {index + 1} body text")
doc.save(book)
doc.close()
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 72), "outline page")
doc.set_toc([[1, "Chapter One", 1], [2, "Section 1.1", 1], [1, "Chapter Two", 1]])
doc.save(outline)
doc.close()
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 40), "HEADER NOISE")
page.insert_text((72, 200), "BODY KEEP")
doc.save(dirty)
doc.close()
`;
const fixture = spawnSync(python, ["-c", fixtureScript, fixturePdf, outlinePdf, dirtyPdf], { encoding: "utf8" });
if (fixture.status !== 0) {
  console.error("✗ 夹具生成失败:", fixture.stderr?.slice(-400));
  process.exit(1);
}
// 两张 1×1 PNG(不必依赖 Pillow 生成)。
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
for (const file of images) fs.writeFileSync(file, pngBytes);

// ── 起服务 ───────────────────────────────────────────────────────────
const port = await freePort();
const token = "e2e-token";
const settings = { engineUrl: `http://127.0.0.1:${port}`, engineToken: token };
const client = createEngineClient({ timeoutMs: 15_000 });
const child = spawn(python, ["-m", "engine", "serve", "--port", String(port), "--token", token], {
  cwd: engineRoot,
  // stubDocvortex 也放进引擎的 PYTHONPATH:`python -m docvortex` 会命中假模块(子进程继承)。
  env: { ...process.env, PYTHONPATH: [engineRoot, stubDocvortex].join(path.delimiter), ENGINE_CONFIG: configFile },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (chunk) => { serverLog += chunk; });
child.stderr.on("data", (chunk) => { serverLog += chunk; });

try {
  // ── health / 鉴权 ──────────────────────────────────────────────────
  let health = null;
  for (let i = 0; i < 80; i += 1) {
    health = await client.health(settings);
    if (health.ok) break;
    await sleep(250);
  }
  if (!health?.ok) {
    console.error(`✗ 引擎没起来:${health?.error}\n${serverLog.slice(-600)}`);
    process.exit(1);
  }
  check("health 上报版本与能力", Boolean(health.data.engineVersion) && Boolean(health.data.capabilities.python?.ok), describeEngineHealth(health.data));
  const kinds = health.data.capabilities.jobKinds || [];
  check("七类作业都在", ["text-layer", "outline", "images-to-pdf", "redact", "extract", "convert", "pdf-text"].every((kind) => kinds.includes(kind)), kinds.join(", "));
  check("能力项是 {ok, detail}", engineCapabilityRows(health.data).every((row) => typeof row.ok === "boolean" && typeof row.detail === "string"));

  const noToken = await client.health({ engineUrl: settings.engineUrl });
  check("不带令牌被拒", noToken.ok === false && /令牌/.test(String(noToken.error)), String(noToken.error));

  // ── 配置往返 ───────────────────────────────────────────────────────
  const before = await client.config(settings);
  check("配置可读", before.ok === true && before.data.config.hasMineruToken === false);
  const saved = await client.saveConfig(settings, {
    calibrePath: path.join(work, "nope", "ebook-convert"),
    mineruToken: "secret-token",
    pdfToolDir: stubPdfTool,
    unknown: "ignored",
  });
  check("配置写入后令牌不回显", saved.ok === true && saved.data.config.mineruToken === "" && saved.data.config.hasMineruToken === true);
  check("未知字段被忽略", !("unknown" in saved.data.config));
  check("能力随配置变化", saved.data.capabilities.calibre.ok === false && saved.data.capabilities.pdfTool.ok === true, saved.data.capabilities.pdfTool.detail);
  const disk = JSON.parse(fs.readFileSync(configFile, "utf8"));
  check("配置落在引擎侧", disk.mineruToken === "secret-token" && disk.pdfToolDir === stubPdfTool);

  // ── math ──────────────────────────────────────────────────────────
  const formula = "\\mathbb { } _ {j} \\lesssim \\varepsilon ^ { - (d - 1)}";
  const math = await client.math(settings, ["x^2 + y^2 = z^2", formula, "\\begin{array}{c} a \\\\ b \\end{array}\\tag{1.1}"]);
  check("math 全部出 MathML(含空壳修复)", math.ok === true && ["x^2 + y^2 = z^2", formula, "\\begin{array}{c} a \\\\ b \\end{array}\\tag{1.1}"].every((key) => String(math.data.mathml[key] || "").includes("<math")));

  // ── 作业矩阵 ───────────────────────────────────────────────────────
  const run = async (kind, jobArgs, { timeoutMs = 120_000, expect = true } = {}) => {
    const progress = [];
    const ran = await client.runJob(settings, kind, jobArgs, { onProgress: (item) => progress.push(item), intervalMs: 100, timeoutMs });
    if (expect) check(`${kind} 作业完成`, ran.ok === true, ran.ok ? "" : String(ran.error));
    return { ran, progress };
  };

  const layerOut = path.join(work, "layer.json");
  const layer = await run("text-layer", { source: fixturePdf, out: layerOut });
  const layerPages = layer.ran.ok ? JSON.parse(fs.readFileSync(layerOut, "utf8")) : [];
  check("text-layer 产物正确", layerPages.length === 3 && String(layerPages[0]).includes("page 1 body text"));
  check("text-layer 报了进度", layer.progress.some((item) => Number(item.total) === 3));

  const outline = await run("outline", { source: outlinePdf });
  check("outline 读到书签与层级", outline.ran.ok === true && outline.ran.result.count === 3 && outline.ran.result.entries[1].level === 2, JSON.stringify(outline.ran.result?.entries?.map((entry) => entry.title)));

  const textWork = path.join(work, "text-mode");
  const text = await run("pdf-text", { source: fixturePdf, workDir: textWork });
  const textPages = text.ran.ok ? JSON.parse(fs.readFileSync(path.join(textWork, "pdf-text.json"), "utf8")) : [];
  check("pdf-text 结构化行可用", text.ran.ok === true && Array.isArray(textPages) && Array.isArray(textPages[0].lines) && textPages[0].lines.length > 0);

  const redacted = path.join(work, "clean.pdf");
  const redact = await run("redact", { source: dirtyPdf, out: redacted, rects: [{ page: 1, rect: [60, 30, 260, 55] }] });
  const redactText = redact.ran.ok ? (await import("node:child_process")).execFileSync(python, ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);print(d[0].get_text())", redacted], { encoding: "utf8" }) : "";
  check("redact 擦掉标区、保留区外", redact.ran.ok === true && redact.ran.result.removed === 1 && !redactText.includes("HEADER") && redactText.includes("BODY KEEP"));

  const packed = path.join(work, "packed.pdf");
  const images2 = await run("images-to-pdf", { images, out: packed });
  check("images-to-pdf 每图一页", images2.ran.ok === true && images2.ran.result.pages === 2 && fs.existsSync(packed));

  const extractOut = path.join(work, "extract");
  const extract = await run("extract", { source: fixturePdf, outDir: extractOut, model: "vlm" });
  check("extract 跑通(假 pdf_tool)", extract.ran.ok === true && extract.ran.result.produced.includes("book_doc.json") && fs.existsSync(path.join(extractOut, "book_doc.json")));

  const converted = path.join(work, "converted.md");
  const convert = await client.runJob(settings, "convert", { source: fixturePdf, format: "markdown", out: converted, parseMode: "ocr" }, { intervalMs: 100, timeoutMs: 60_000 });
  check("convert 跑通(假 docvortex)", convert.ok === true && fs.existsSync(converted) && fs.readFileSync(converted, "utf8").includes("converted"), convert.ok ? "" : String(convert.error));

  // ── 取消 / 错误路径 ────────────────────────────────────────────────
  const slowPdf = path.join(work, "slow.pdf");
  spawnSync(python, ["-c", `
import fitz, sys
doc = fitz.open()
for index in range(120):
    page = doc.new_page()
    page.insert_text((72, 72), f"slow page {index + 1}")
doc.save(sys.argv[1])
doc.close()
`, slowPdf]);
  const submitted = await client.submit(settings, "text-layer", { source: slowPdf, out: path.join(work, "slow.json") });
  const cancelled = await client.cancel(settings, submitted.data.jobId);
  const cancelStatus = await client.status(settings, submitted.data.jobId);
  check("取消能转给引擎", submitted.ok === true && (cancelled.data.cancelled === true || cancelStatus.data.status === "done"), `cancel=${JSON.stringify(cancelled.data)} status=${cancelStatus.data.status}`);

  const badKind = await client.submit(settings, "nope", {});
  check("未知作业类型被拒", badKind.ok === false && /未知的作业类型/.test(String(badKind.error)));
  const missing = await client.runJob(settings, "text-layer", { source: path.join(work, "missing.pdf") }, { intervalMs: 100, timeoutMs: 30_000 });
  check("缺文件给可读错误", missing.ok === false && /找不到 PDF/.test(String(missing.error)));
} finally {
  child.kill();
  fs.rmSync(work, { recursive: true, force: true });
}

const passed = results.filter((row) => row.ok).length;
console.log(`\n引擎 e2e:${passed}/${results.length} 通过`);
if (failed) {
  console.error("失败项:", results.filter((row) => !row.ok).map((row) => row.name).join(", "));
  process.exit(1);
}

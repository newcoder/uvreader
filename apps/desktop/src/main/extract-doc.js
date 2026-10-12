// 书坊:内容提取(PDF / Office / OFD / 图片 → 内容)。
// PDF 走 pdf_tool(pdf_to_doc.py:auto/text/vision/mineru/blocks);Office/OFD/HTML/图片走 DocVortex。
// 产物按 §7 命名规则落在源文件旁: `<源名>.md` / `.html` / `.json` / `.audit.json` / `<源名>.assets/`。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EXTRACT_MODES, IMAGE_INPUTS, extractionKind } from "../shared/extract-formats.js";
import { splitMarkdownChapters, unwrapProseFences } from "../shared/markdown-fix.js";
import { blocksFromDoc, blocksToMarkdown } from "./formula-html.js";
import { mergeBlocksWithTextLayer } from "./text-merge.js";
import { createTextLayerReader } from "./text-layer.js";
import { pdfToolArgs, pdfToolScriptCommand } from "./workshop-formula.js";

export { EXTRACT_MODES, IMAGE_INPUTS, extractionKind };
export { splitMarkdownChapters, unwrapProseFences } from "../shared/markdown-fix.js";

function replaceAll(text, from, to) {
  return String(text).split(from).join(to);
}

function uniquePath(target, exists = (candidate) => fs.existsSync(candidate)) {
  if (!exists(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let index = 1;
  while (exists(`${base} (${index})${ext}`)) index += 1;
  return `${base} (${index})${ext}`;
}

// MinerU 的 markdown / html 写作器会丢掉 code 块的 caption(实测是正文前半段):
// 用同目录的 Doc JSON 把 caption 补回对应围栏内,再交给 unwrapProseFences 拆回完整段落。
export function patchMarkdownCaptions(markdown, blocks) {
  let out = String(markdown || "");
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (String(block?.type || "") !== "code") continue;
    const caption = String(block.caption || "").trim();
    const content = String(block.content ?? block.code ?? "").trim();
    if (!caption || content.length < 20) continue;
    const anchor = content.split("\n")[0].trim().slice(0, 40);
    if (anchor.length < 20) continue;
    if (out.includes(caption)) continue;
    const index = out.indexOf(anchor);
    if (index < 0) continue;
    out = `${out.slice(0, index)}${caption}\n${out.slice(index)}`;
  }
  return out;
}

// pdf_tool 的产物(<stem>_doc.md / .html / .json / _audit.json + mineru/ 资产)
// → §7 约定(<源名>.md / .html / .json / .audit.json / <源名>.assets/)。
export function adoptPdfToolOutputs(outDir, name, { renameAssets = true } = {}) {
  const files = {};
  // caption 补全用的块列表(pdf_tool 的 Doc JSON,读不到就算了)。
  let blocks = [];
  try {
    const docPath = path.join(outDir, `${name}_doc.json`);
    if (fs.existsSync(docPath)) blocks = blocksFromDoc(JSON.parse(fs.readFileSync(docPath, "utf8")));
  } catch { blocks = []; }
  const moves = [
    ["_doc.md", "md"],
    ["_doc.html", "html"],
    ["_doc.json", "json"],
    ["_audit.json", "audit"],
  ];
  const assetsFrom = path.join(outDir, "mineru");
  const assetsTo = path.join(outDir, `${name}.assets`);
  const assetsRenamed = renameAssets && fs.existsSync(assetsFrom) && !fs.existsSync(assetsTo);
  if (assetsRenamed) {
    try { fs.renameSync(assetsFrom, assetsTo); } catch { /* keep the old folder */ }
  }
  const assetPrefix = assetsRenamed ? `${name}.assets/` : "mineru/";
  for (const [suffix, key] of moves) {
    const from = path.join(outDir, `${name}${suffix}`);
    if (!fs.existsSync(from)) continue;
    const ext = suffix === "_audit.json" ? ".audit.json" : path.extname(suffix);
    const to = uniquePath(path.join(outDir, `${name}${ext}`));
    try { fs.renameSync(from, to); } catch { continue; }
    if (key === "md" || key === "html" || key === "json") {
      try {
        const text = fs.readFileSync(to, "utf8");
        let fixed = replaceAll(text, "mineru/", assetPrefix);
        // 提取工具偶尔把正文段落判成代码块(md 里是无语言围栏),caption 还会被写作器丢掉:
        // 先按 Doc JSON 补回 caption,再把「假代码块」拆回段落,便于阅读与再排版。
        if (key === "md") {
          fixed = patchMarkdownCaptions(fixed, blocks);
          fixed = unwrapProseFences(fixed);
        }
        if (fixed !== text) fs.writeFileSync(to, fixed, "utf8");
      } catch { /* leave as-is */ }
    }
    files[key] = to;
  }
  return files;
}

// 外部命令执行(spawn 可注入,便于单测)。
export function runExtractCommand(command, args, { cwd, env, signal, timeoutMs = 30 * 60_000, log = () => {}, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd: cwd || undefined, env: env ? { ...process.env, ...env } : undefined, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* gone */ }
      finish({ ok: false, cancelled: true, error: "任务已取消" });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish({ ok: false, error: `提取超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
    child.on("close", (code) => {
      if (code !== 0) log("extract command failed", code, out.trim().slice(-200));
      finish({ ok: code === 0, error: code === 0 ? "" : (out.trim().split("\n").filter(Boolean).pop() || `退出码 ${code}`) });
    });
  });
}

// 图片 → 单页 PDF:DocVortex 的 convert 只收文档(PDF),图片先经 Pillow 合成 PDF 再走它的 OCR。
export const IMAGE_TO_PDF_SCRIPT = `import sys
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode != "RGB":
    im = im.convert("RGB")
im.save(sys.argv[2], "PDF")
`;

// 跑 DocVortex 的 Python(Pillow 随 DocVortex 一起装)。
export function docvortexPython(settings = {}) {
  return String(settings.docvortexPython || settings.ocrPython || "").trim() || "python";
}

export function imageToPdf(source, outPath, { python = "python", signal, log = () => {}, spawnImpl = spawn } = {}) {
  return runExtractCommand(python, ["-c", IMAGE_TO_PDF_SCRIPT, source, outPath], {
    signal,
    log,
    timeoutMs: 60_000,
    spawnImpl,
  });
}

// pdf_tool 的 Doc JSON + PDF 文字层 → 互补后的 Markdown(正文逐字、公式 LaTeX)。
// 拿不到文字层(扫描件 / 没装 PyMuPDF)或定位失败时返回 "",调用方保留 MinerU 产物。
export async function mergePdfMarkdown({ docPath, source, python = "python", workDir = "", signal, textLayer = null, assetPrefix = "", log = () => {} } = {}) {
  if (!textLayer || !docPath || !fs.existsSync(docPath)) return "";
  try {
    const blocks = blocksFromDoc(JSON.parse(fs.readFileSync(docPath, "utf8")));
    const layer = await textLayer.read(source, { python, workDir, signal });
    if (!layer.ok) {
      log("text layer skipped", layer.error);
      return "";
    }
    const markdown = blocksToMarkdown(mergeBlocksWithTextLayer(blocks, layer.pages, { log }));
    return assetPrefix ? markdown.split("mineru/").join(assetPrefix) : markdown;
  } catch (error) {
    log("merged markdown failed", String(error?.message || error));
    return "";
  }
}

// 供向导调用:把任意来源转成 Markdown(中间产物放缓存目录,用户无感)。
export async function extractMarkdown(source, { kind, settings = {}, docvortex, workDir, signal, log = () => {}, spawnImpl = spawn, textLayer = null, refresh = false } = {}) {
  const resolvedKind = kind || extractionKind(source);
  // 提取产物里的「假代码块」(MinerU 把正文段落包进围栏)按段落还原,公式才会渲染。
  const readMarkdown = (file) => {
    const raw = fs.readFileSync(file, "utf8");
    const cleaned = unwrapProseFences(raw);
    if (cleaned !== raw) log("prose fences unwrapped", path.basename(file));
    return cleaned;
  };
  if (resolvedKind === "pdf") {
    const target = pdfToolScriptCommand(settings);
    if (target.error) return { ok: false, error: target.error };
    fs.mkdirSync(workDir, { recursive: true });
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    const mergedPath = path.join(workDir, "merged.md");
    const docCandidates = [path.join(workDir, `${stem}_doc.json`), path.join(workDir, `${stem}.json`)];
    const fresh = (file) => {
      try {
        return fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(source).mtimeMs - 1000;
      } catch {
        return false;
      }
    };
    // 复用:上次提取的合并稿还在缓存目录(且比 PDF 新)就直接用——MinerU 慢且计费。
    if (!refresh && fresh(mergedPath) && docCandidates.some(fresh)) {
      log("extract: reuse cached merged markdown", mergedPath);
      return { ok: true, markdown: fs.readFileSync(mergedPath, "utf8"), path: mergedPath };
    }
    const cachedDoc = docCandidates.find(fresh);
    if (!cachedDoc) {
      const args = pdfToolArgs(target.script, { source, outDir: workDir, model: String(settings.mineruModel || "").trim() || "vlm" });
      const modeIndex = args.indexOf("--mode");
      if (modeIndex >= 0) args[modeIndex + 1] = String(settings.extractMode || "auto");
      const formatsIndex = args.indexOf("--formats");
      if (formatsIndex >= 0) args[formatsIndex + 1] = "json,md,html";
      else args.push("--formats", "json,md,html");
      const token = String(settings.mineruToken || "").trim()
        || String(process.env.MINERU_API_KEY || process.env.MINERU_TOKEN || "").trim();
      const result = await runExtractCommand(target.command, args, {
        cwd: target.cwd,
        env: token ? { MINERU_API_KEY: token } : undefined,
        signal,
        log,
        spawnImpl,
      });
      if (!result.ok) return { ok: false, error: result.error };
    } else {
      log("extract: reuse cached doc json", cachedDoc);
    }
    const files = adoptPdfToolOutputs(workDir, stem, { renameAssets: false });
    if (!files.md && !cachedDoc) return { ok: false, error: "提取完成但没有找到 Markdown 产物" };
    // 文字层互补:正文逐字取 PDF 文字层(补 MinerU 丢的字),公式仍是 LaTeX。
    const merged = await mergePdfMarkdown({
      docPath: files.json || cachedDoc,
      source,
      python: docvortexPython(settings),
      workDir,
      signal,
      textLayer,
      log,
    });
    if (merged) {
      fs.writeFileSync(mergedPath, merged, "utf8");
      return { ok: true, markdown: merged, path: mergedPath };
    }
    return { ok: true, markdown: readMarkdown(files.md), path: files.md };
  }
  if (!docvortex) return { ok: false, error: "DocVortex 不可用" };
  fs.mkdirSync(workDir, { recursive: true });
  // 图片:先合成单页 PDF 再让 DocVortex 走 OCR(auto 分类不认图片,且它的 convert 只收文档)。
  if (resolvedKind === "image") {
    const pdf = path.join(workDir, "image.pdf");
    const made = await imageToPdf(source, pdf, { python: docvortexPython(settings), signal, log, spawnImpl });
    if (!made.ok) return { ok: false, error: `图片转 PDF 失败：${made.error}（需要 Pillow：pip install pillow）` };
    const out = path.join(workDir, "content.md");
    const result = await docvortex.convert(settings, { source: pdf, format: "markdown", out, parseMode: "ocr", signal });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, markdown: readMarkdown(out), path: out };
  }
  const out = path.join(workDir, "content.md");
  const result = await docvortex.convert(settings, { source, format: "markdown", out, signal });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, markdown: readMarkdown(out), path: out };
}

export function registerExtractRunners(workshop, { docvortex, vaultRoot = "", spawnImpl = spawn, textLayer = createTextLayerReader(), log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 自检:pdf_tool 目录 + DocVortex(+ 是否配置 MinerU 凭据)。
  workshop.register("extract-probe", async ({ payload, signal }) => {
    const settings = payload?.settings || {};
    const target = pdfToolScriptCommand(settings);
    if (target.error) throw new Error(target.error);
    const docvortexResult = await docvortex.probe(settings);
    if (signal.aborted) throw new Error("任务已取消");
    if (!docvortexResult.ok) throw new Error(String(docvortexResult.detail || "DocVortex 不可用"));
    const token = String(settings.mineruToken || "").trim()
      || String(process.env.MINERU_API_KEY || process.env.MINERU_TOKEN || "").trim();
    return {
      output: token ? "pdf_tool + DocVortex + MinerU" : "pdf_tool + DocVortex(PDF 无 MinerU 需文本模型凭据)",
      detail: `pdf_tool · ${path.basename(target.cwd)}`,
    };
  });

  // PDF 提取:pdf_tool(pdf_to_doc.py)→ 按 §7 改名落回源文件旁。
  workshop.register("extract-pdf", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const target = pdfToolScriptCommand(settings);
    if (target.error) throw new Error(target.error);
    const mode = String(payload?.mode || "auto");
    const outDir = path.dirname(source);
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    report({ label: `提取中（${mode}）` });
    const args = pdfToolArgs(target.script, { source, outDir, model: String(settings.mineruModel || "").trim() || "vlm" });
    const modeIndex = args.indexOf("--mode");
    if (modeIndex >= 0) args[modeIndex + 1] = mode;
    const formatsIndex = args.indexOf("--formats");
    if (formatsIndex >= 0) args[formatsIndex + 1] = "json,md,html";
    else args.push("--formats", "json,md,html");
    const token = String(settings.mineruToken || "").trim();
    const result = await runExtractCommand(target.command, args, {
      cwd: target.cwd,
      env: token ? { MINERU_API_KEY: token } : undefined,
      signal,
      log,
      spawnImpl,
    });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "提取失败"));
    const files = adoptPdfToolOutputs(outDir, stem);
    if (!files.md) throw new Error("提取完成但没有找到 Markdown 产物");
    // 文字层互补:正文逐字取 PDF 文字层(补 MinerU 丢的字),公式仍是 LaTeX;失败保留 MinerU 的 md。
    report({ label: "文字层校正" });
    const merged = await mergePdfMarkdown({
      docPath: files.json,
      source,
      python: docvortexPython(settings),
      workDir: outDir,
      signal,
      textLayer,
      log,
      assetPrefix: `${stem}.assets/`,
    });
    if (signal.aborted) throw new Error("任务已取消");
    if (merged) fs.writeFileSync(files.md, merged, "utf8");
    return { output: files.md, detail: `Markdown · ${Math.round(fs.statSync(files.md).size / 1024)} KB`, outputs: files };
  });

  // 图片 / Office / OFD / HTML / EPUB:DocVortex → Markdown / HTML / 结构化 JSON,落回源文件旁。
  workshop.register("extract-docvortex", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const dir = path.dirname(source);
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    // 图片:DocVortex 的 convert 只收文档,先把图片合成单页 PDF(临时文件,跑完删掉)再走它的 OCR。
    let input = source;
    let tempPdf = "";
    let parseMode = "";
    if (extractionKind(source) === "image") {
      report({ label: "图片转 PDF" });
      tempPdf = path.join(os.tmpdir(), `uvreader-image-${Date.now().toString(36)}.pdf`);
      const made = await imageToPdf(source, tempPdf, { python: docvortexPython(settings), signal, log, spawnImpl });
      if (!made.ok) throw new Error(`图片转 PDF 失败：${made.error}（需要 Pillow：pip install pillow）`);
      input = tempPdf;
      parseMode = "ocr";
    }
    const outputs = {};
    try {
      for (const [format, key] of [["markdown", "md"], ["html", "html"], ["structured_content", "json"]]) {
        report({ label: `提取 ${format}` });
        const out = uniquePath(path.join(dir, `${stem}.${key}`));
        const result = await docvortex.convert(settings, { source: input, format, out, parseMode, signal });
        if (signal.aborted) throw new Error("任务已取消");
        if (!result.ok) {
          if (key === "md") throw new Error(String(result.error || "提取失败"));
          log("extract format skipped", format, result.error);
          continue;
        }
        outputs[key] = out;
      }
    } finally {
      if (tempPdf) {
        try { fs.rmSync(tempPdf, { force: true }); } catch { /* 临时文件,忽略 */ }
      }
    }
    if (!outputs.md) throw new Error("提取完成但没有找到 Markdown 产物");
    return { output: outputs.md, detail: `Markdown · ${Math.round(fs.statSync(outputs.md).size / 1024)} KB`, outputs };
  });

  return { adoptPdfToolOutputs, splitMarkdownChapters };
}

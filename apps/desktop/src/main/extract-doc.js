// 书坊:内容提取(PDF / Office / OFD / 图片 → 内容)。
// PDF 走 pdf_tool(pdf_to_doc.py:auto/text/vision/mineru/blocks);Office/OFD/HTML/图片走 DocVortex。
// 产物按 §7 命名规则落在源文件旁: `<源名>.md` / `.html` / `.json` / `.audit.json` / `<源名>.assets/`。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { EXTRACT_MODES, IMAGE_INPUTS, extractionKind } from "../shared/extract-formats.js";
import { pdfToolArgs, pdfToolScriptCommand } from "./workshop-formula.js";

export { EXTRACT_MODES, IMAGE_INPUTS, extractionKind };

// 提取出的 Markdown → 章节:按 1–3 级标题分;标题缺失时交给调用方按长度分块。
export function splitMarkdownChapters(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const chapters = [];
  let current = { title: "", lines: [] };
  let inFence = false;
  const push = () => {
    const text = current.lines.join("\n").trim();
    if (text) chapters.push({ title: current.title, text });
    current = { title: "", lines: [] };
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const heading = !inFence && line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      push();
      current.title = heading[2].replace(/[#*`]/g, "").trim().slice(0, 80);
      continue;
    }
    current.lines.push(line);
  }
  push();
  return chapters;
}

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

// pdf_tool 的产物(<stem>_doc.md / .html / .json / _audit.json + mineru/ 资产)
// → §7 约定(<源名>.md / .html / .json / .audit.json / <源名>.assets/)。
export function adoptPdfToolOutputs(outDir, name, { renameAssets = true } = {}) {
  const files = {};
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
        const fixed = replaceAll(text, "mineru/", assetPrefix);
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

// 供向导调用:把任意来源转成 Markdown(中间产物放缓存目录,用户无感)。
export async function extractMarkdown(source, { kind, settings = {}, docvortex, workDir, signal, log = () => {}, spawnImpl = spawn } = {}) {
  const resolvedKind = kind || extractionKind(source);
  if (resolvedKind === "pdf") {
    const target = pdfToolScriptCommand(settings);
    if (target.error) return { ok: false, error: target.error };
    fs.mkdirSync(workDir, { recursive: true });
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
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
    const files = adoptPdfToolOutputs(workDir, stem, { renameAssets: false });
    if (!files.md) return { ok: false, error: "提取完成但没有找到 Markdown 产物" };
    return { ok: true, markdown: fs.readFileSync(files.md, "utf8"), path: files.md };
  }
  if (!docvortex) return { ok: false, error: "DocVortex 不可用" };
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, "content.md");
  const result = await docvortex.convert(settings, { source, format: "markdown", out, signal });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, markdown: fs.readFileSync(out, "utf8"), path: out };
}

export function registerExtractRunners(workshop, { docvortex, vaultRoot = "", spawnImpl = spawn, log = (...args) => console.log(...args) } = {}) {
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
    return { output: files.md, detail: `Markdown · ${Math.round(fs.statSync(files.md).size / 1024)} KB`, outputs: files };
  });

  // 图片 / Office / OFD / HTML / EPUB:DocVortex → Markdown / HTML / 结构化 JSON,落回源文件旁。
  workshop.register("extract-docvortex", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const dir = path.dirname(source);
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    const outputs = {};
    for (const [format, key] of [["markdown", "md"], ["html", "html"], ["structured_content", "json"]]) {
      report({ label: `提取 ${format}` });
      const out = uniquePath(path.join(dir, `${stem}.${key}`));
      const result = await docvortex.convert(settings, { source, format, out, signal });
      if (signal.aborted) throw new Error("任务已取消");
      if (!result.ok) {
        if (key === "md") throw new Error(String(result.error || "提取失败"));
        log("extract format skipped", format, result.error);
        continue;
      }
      outputs[key] = out;
    }
    if (!outputs.md) throw new Error("提取完成但没有找到 Markdown 产物");
    return { output: outputs.md, detail: `Markdown · ${Math.round(fs.statSync(outputs.md).size / 1024)} KB`, outputs };
  });

  return { adoptPdfToolOutputs, splitMarkdownChapters };
}

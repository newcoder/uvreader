// 书坊「公式优先」链路:pdf_tool(MinerU 云端)→ Doc v1 JSON → 带公式标记的 HTML
// → DocVortex 转 DOCX/EPUB(真 OMML / MathML)。见 docs/workshop.md §8.1。
//
// 公式质量来自 MinerU(本地 rapidocr 没有公式模型),渲染靠 DocVortex 现成的
// LaTeX→MathML→OMML 管线;桥只做 Doc JSON → HTML 的纯文本变换(formula-html.js)。
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { blocksFromDoc, blocksToHtml } from "./formula-html.js";
import { mergeBlocksWithTextLayer } from "./text-merge.js";
import { createTextLayerReader } from "./text-layer.js";
import { docvortexFormatExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

// Windows 下环境变量是在登录/进程启动时快照的:变量设好后没有重启应用,子进程
// 就看不到它。这里补一次注册表读取,免得用户为了一个凭据重启整个应用。
export function readWindowsEnv(name) {
  if (process.platform !== "win32") return "";
  const hives = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  for (const hive of hives) {
    try {
      const out = execFileSync("reg", ["query", hive, "/v", name], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = String(out).match(/REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)/);
      if (match) return match[1].trim();
    } catch {
      // not set in this hive
    }
  }
  return "";
}

// 凭据来源:设置 → 进程环境 → Windows 注册表(用户/机器级)。
export function resolveMineruToken(settings = {}, { env = process.env, readEnv = readWindowsEnv } = {}) {
  const fromSettings = String(settings.mineruToken || "").trim();
  if (fromSettings) return fromSettings;
  const fromEnv = String(env?.MINERU_API_KEY || env?.MINERU_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  return String(readEnv("MINERU_API_KEY") || readEnv("MINERU_TOKEN") || "").trim();
}

// pdf_tool 的失败尾部常是 Python traceback:把已知原因翻成可操作的话。
export function friendlyPdfToolError(text) {
  const raw = String(text || "");
  if (/mineru_token|MinerU token/i.test(raw)) {
    return "没有找到 MinerU 凭据：在「转换设置 → MinerU 凭据」填写，或设置环境变量 MINERU_API_KEY / MINERU_TOKEN（设置后需重启应用）";
  }
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] || raw).slice(0, 300);
}

function tail(text, limit = 300) {
  return String(text || "").trim().slice(-limit);
}

function stemOf(source) {
  const name = path.basename(String(source || ""));
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "doc";
}

// pdf_tool 的 PDF → Doc 入口(需要 checkout;打包 exe 只提供阅读器 sidecar)。
export function pdfToolScriptCommand(settings = {}) {
  const python = String(settings.ocrPython || "").trim() || "python";
  const dir = String(settings.ocrSidecarDir || "").trim() || String(process.env.QBR_OCR_SIDECAR || "").trim();
  if (!dir) return { error: "还没有配置 pdf_tool 目录（设置里的 OCR 程序目录）" };
  const script = path.join(dir, "pdf_tool", "pdf_to_doc.py");
  if (!fs.existsSync(script)) return { error: `这个目录里没有 pdf_tool：${dir}` };
  return { command: python, args: [], cwd: dir, script };
}

export function pdfToolArgs(script, { source, outDir, model = "vlm", pages = "" } = {}) {
  const args = [String(script), "--pdf", String(source), "--mode", "mineru",
    "--formats", "json", "--out-dir", String(outDir)];
  if (pages) args.push("--pages", String(pages));
  if (model) args.push("--mineru-model", String(model));
  return args;
}

// 每个源文件一个稳定的工作目录:重复转换可复用 MinerU 的解析产物(云端慢且计费)。
export function formulaCacheDir(root, source, pages = "") {
  const key = crypto.createHash("sha1").update(`${source}\n${pages}`).digest("hex").slice(0, 10);
  const stem = stemOf(source).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40) || "doc";
  return path.join(String(root || ""), `${stem}-${key}`);
}

export function createFormulaChain({ spawnImpl = spawn, timeoutMs = 30 * 60_000, readEnv = readWindowsEnv, textLayer = createTextLayerReader(), log = (...args) => console.log(...args) } = {}) {
  function runCommand(command, args, { cwd, env, signal } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd: cwd || undefined,
          env: env ? { ...process.env, ...env } : undefined,
          stdio: ["ignore", "pipe", "pipe"],
        });
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
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, cancelled: true, error: "任务已取消" });
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, error: `MinerU 解析超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
      child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : tail(out) || `pdf_tool 退出码 ${code}`, log: tail(out) }));
    });
  }

  // MinerU 解析 → Doc JSON → 公式 HTML;返回 {ok, htmlPath, docPath}。
  async function prepare({ settings = {}, source, workDir, pages = "", signal, report } = {}) {
    const target = pdfToolScriptCommand(settings);
    if (target.error) return { ok: false, error: target.error };
    fs.mkdirSync(workDir, { recursive: true });
    report?.({ label: "MinerU 云端解析" });
    log("formula chain: pdf_tool", target.command, target.script);
    const token = resolveMineruToken(settings, { readEnv });
    const args = pdfToolArgs(target.script, {
      source,
      outDir: workDir,
      model: String(settings.mineruModel || "").trim() || "vlm",
      pages,
    });
    // 凭据走子进程环境而不是命令行:不在进程列表里暴露。
    const parsed = await runCommand(target.command, args, {
      cwd: target.cwd,
      env: token ? { MINERU_API_KEY: token } : undefined,
      signal,
    });
    if (!parsed.ok) return { ok: false, error: friendlyPdfToolError(parsed.error), cancelled: parsed.cancelled };
    const docPath = path.join(workDir, `${stemOf(source)}_doc.json`);
    if (!fs.existsSync(docPath)) return { ok: false, error: "pdf_tool 没有生成 Doc JSON" };
    report?.({ label: "生成公式 HTML" });
    let blocks;
    try {
      blocks = blocksFromDoc(JSON.parse(fs.readFileSync(docPath, "utf8")));
    } catch (error) {
      return { ok: false, error: `Doc JSON 解析失败：${error?.message || error}` };
    }
    // 文字层互补:正文逐字取 PDF 文字层(补 MinerU 丢的字/符号),公式保留 MinerU 的 LaTeX。
    if (textLayer) {
      report?.({ label: "文字层校正" });
      const layer = await textLayer.read(source, { python: String(settings.ocrPython || "").trim() || "python", workDir, signal });
      if (layer.ok) blocks = mergeBlocksWithTextLayer(blocks, layer.pages, { log });
      else log("text layer skipped", layer.error);
    }
    if (signal?.aborted) return { ok: false, cancelled: true, error: "任务已取消" };
    const html = blocksToHtml(blocks, { title: stemOf(source) });
    const htmlPath = path.join(workDir, "bridge.html");
    fs.writeFileSync(htmlPath, html, "utf8");
    return { ok: true, htmlPath, docPath, log: parsed.log };
  }

  return { prepare, runCommand };
}

export function registerFormulaRunners(workshop, { chain, docvortex, vaultRoot = "", cacheRoot = "", readEnv = readWindowsEnv, log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 检测整条链路:pdf_tool 目录 + MinerU 凭据 + DocVortex。
  workshop.register("formula-probe", async ({ payload, signal }) => {
    const settings = payload?.settings || {};
    const target = pdfToolScriptCommand(settings);
    if (target.error) throw new Error(target.error);
    if (!resolveMineruToken(settings, { readEnv })) {
      throw new Error("没有找到 MinerU 凭据：在「转换设置 → MinerU 凭据」填写，或设置环境变量 MINERU_API_KEY / MINERU_TOKEN（设置后需重启应用）");
    }
    const result = await docvortex.probe(settings);
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.detail || "DocVortex 不可用"));
    return { output: "MinerU + DocVortex", detail: `pdf_tool · ${path.basename(target.cwd)}` };
  });

  // 公式优先:扫描件走 MinerU(LaTeX)→ HTML → DocVortex(DOCX 真公式 / EPUB MathML)。
  workshop.register("formula-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const format = String(payload?.format || "docx");
    const pages = String(payload?.pages || "");
    const out = payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, docvortexFormatExt(format)));
    const workDir = formulaCacheDir(cacheRoot, source, pages);
    const prepared = await chain.prepare({ settings, source, workDir, pages, signal, report });
    if (signal.aborted) throw new Error("任务已取消");
    if (!prepared.ok) throw new Error(String(prepared.error || "MinerU 解析失败"));
    report({ label: "DocVortex 转换" });
    log("formula chain:", prepared.htmlPath, "→", out);
    const result = await docvortex.convert(settings, { source: prepared.htmlPath, format, out, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "转换失败"));
    return { output: out, detail: `${format} · ${path.basename(out)}` };
  });

  return { pdfToolScriptCommand, formulaCacheDir };
}

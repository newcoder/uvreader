// 书坊「公式优先」链路:pdf_tool(MinerU 云端)→ Doc v1 JSON → 带公式标记的 HTML
// → DocVortex 转 DOCX/EPUB(真 OMML / MathML)。见 docs/workshop.md §8.1。
//
// 公式质量来自 MinerU(本地 rapidocr 没有公式模型),渲染靠 DocVortex 现成的
// LaTeX→MathML→OMML 管线;桥只做 Doc JSON → HTML 的纯文本变换(formula-html.js)。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { blocksFromDoc, blocksToHtml } from "./formula-html.js";
import { docvortexFormatExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

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

export function pdfToolArgs(script, { source, outDir, token = "", model = "vlm", pages = "" } = {}) {
  const args = [String(script), "--pdf", String(source), "--mode", "mineru",
    "--formats", "json", "--out-dir", String(outDir)];
  if (pages) args.push("--pages", String(pages));
  if (token) args.push("--mineru-token", String(token));
  if (model) args.push("--mineru-model", String(model));
  return args;
}

// 每个源文件一个稳定的工作目录:重复转换可复用 MinerU 的解析产物(云端慢且计费)。
export function formulaCacheDir(root, source, pages = "") {
  const key = crypto.createHash("sha1").update(`${source}\n${pages}`).digest("hex").slice(0, 10);
  const stem = stemOf(source).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40) || "doc";
  return path.join(String(root || ""), `${stem}-${key}`);
}

export function createFormulaChain({ spawnImpl = spawn, timeoutMs = 30 * 60_000, log = (...args) => console.log(...args) } = {}) {
  function runCommand(command, args, { cwd, signal } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command, args, { cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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
    const args = pdfToolArgs(target.script, {
      source,
      outDir: workDir,
      token: String(settings.mineruToken || "").trim(),
      model: String(settings.mineruModel || "").trim() || "vlm",
      pages,
    });
    const parsed = await runCommand(target.command, args, { cwd: target.cwd, signal });
    if (!parsed.ok) return parsed;
    const docPath = path.join(workDir, `${stemOf(source)}_doc.json`);
    if (!fs.existsSync(docPath)) return { ok: false, error: "pdf_tool 没有生成 Doc JSON" };
    report?.({ label: "生成公式 HTML" });
    let html;
    try {
      html = blocksToHtml(blocksFromDoc(JSON.parse(fs.readFileSync(docPath, "utf8"))), { title: stemOf(source) });
    } catch (error) {
      return { ok: false, error: `Doc JSON 解析失败：${error?.message || error}` };
    }
    const htmlPath = path.join(workDir, "bridge.html");
    fs.writeFileSync(htmlPath, html, "utf8");
    return { ok: true, htmlPath, docPath, log: parsed.log };
  }

  return { prepare, runCommand };
}

export function registerFormulaRunners(workshop, { chain, docvortex, vaultRoot = "", cacheRoot = "", log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 检测整条链路:pdf_tool 目录 + MinerU 凭据 + DocVortex。
  workshop.register("formula-probe", async ({ payload, signal }) => {
    const settings = payload?.settings || {};
    const target = pdfToolScriptCommand(settings);
    if (target.error) throw new Error(target.error);
    const token = String(settings.mineruToken || "").trim()
      || String(process.env.MINERU_API_KEY || process.env.MINERU_TOKEN || "").trim();
    if (!token) throw new Error("没有找到 MinerU 凭据（环境变量 MINERU_API_KEY / MINERU_TOKEN 或设置）");
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

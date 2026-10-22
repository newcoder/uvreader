// 书坊「公式优先」链路:pdf_tool(MinerU 云端)→ Doc v1 JSON → 带公式标记的 HTML
// → DocVortex 转 DOCX/EPUB(真 OMML / MathML)。见 docs/workshop.md §8.1。
//
// 公式质量来自 MinerU(本地 rapidocr 没有公式模型),渲染靠 DocVortex 现成的
// LaTeX→MathML→OMML 管线;桥只做 Doc JSON → HTML 的纯文本变换(formula-html.js)。
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { blocksFromDoc, blocksToHtml, tableModeFor } from "./formula-html.js";
import { rewriteHtmlMath } from "./html-math.js";
import { resolveLocalBackend, resolveMineruLocalUrl } from "./mineru-local.js";
import { uniqueFile } from "./paths.js";
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

// 本地 MinerU 常驻服务地址:实现已挪到 mineru-local.js(那里还有探测 / 服务生命周期),
// 这里只从它转出,保持既有导入路径可用。
export { resolveMineruLocalUrl } from "./mineru-local.js";

// pdf_tool 的失败尾部常是 Python traceback:把已知原因翻成可操作的话。
export function friendlyPdfToolError(text) {
  const raw = String(text || "");
  if (/mineru_token|MinerU token/i.test(raw)) {
    return "没有找到 MinerU 凭据：在「设置 → 书坊 → MinerU 凭据」填写，或设置环境变量 MINERU_API_KEY / MINERU_TOKEN（设置后需重启应用）";
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

// 表格怎么给(tableModeFor)已移到 formula-html.js:pdf-text.js 也要用,避免模块循环。
export { tableModeFor };

// pdf_tool 的 PDF → Doc 入口(需要 checkout;打包 exe 只提供阅读器 sidecar)。
export function pdfToolScriptCommand(settings = {}) {
  const python = String(settings.ocrPython || "").trim() || "python";
  const dir = String(settings.ocrSidecarDir || "").trim() || String(process.env.QBR_OCR_SIDECAR || "").trim();
  if (!dir) return { error: "还没有配置 pdf_tool 目录（设置里的 OCR 程序目录）" };
  const script = path.join(dir, "pdf_tool", "pdf_to_doc.py");
  if (!fs.existsSync(script)) return { error: `这个目录里没有 pdf_tool：${dir}` };
  return { command: python, args: [], cwd: dir, script };
}

export function pdfToolArgs(script, { source, outDir, model = "vlm", pages = "", mineruSource = "" } = {}) {
  const args = [String(script), "--pdf", String(source), "--mode", "mineru",
    "--formats", "json", "--out-dir", String(outDir)];
  if (pages) args.push("--pages", String(pages));
  if (model) args.push("--mineru-model", String(model));
  // 显式指定后端:local = 本地(常驻服务 / CLI);留空走 pdf_tool 的 auto 路由
  // (MINERU_LOCAL_URL > 云端 token > 本地 CLI)。
  const source_ = String(mineruSource || "").trim();
  if (source_ && source_ !== "auto") args.push("--mineru-source", source_);
  return args;
}

// 每个源文件一个稳定的工作目录:重复转换可复用 MinerU 的解析产物(云端慢且计费)。
export function formulaCacheDir(root, source, pages = "") {
  const key = crypto.createHash("sha1").update(`${source}\n${pages}`).digest("hex").slice(0, 10);
  const stem = stemOf(source).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40) || "doc";
  return path.join(String(root || ""), `${stem}-${key}`);
}

// 提取器的「块规则」变更时 +1:让旧 Doc JSON 失效(不依赖引擎版本探测成功)。
export const FORMULA_CACHE_VERSION = "2";

export function createFormulaChain({ spawnImpl = spawn, timeoutMs = 30 * 60_000, readEnv = readWindowsEnv, fetchImpl = (...args) => fetch(...args), textLayer = createTextLayerReader(), engine = null, log = (...args) => console.log(...args) } = {}) {
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
  // 缓存复用:MinerU 慢且计费,同一个源(同一缓存目录、Doc JSON 比 PDF 新)再转换时
  // 直接复用解析结果;refresh=true 才重新解析。
  async function prepare({ settings = {}, source, workDir, pages = "", signal, report, refresh = false, format = "" } = {}) {
    const target = pdfToolScriptCommand(settings);
    if (target.error) return { ok: false, error: target.error };
    fs.mkdirSync(workDir, { recursive: true });
    const stem = stemOf(source);
    const docPath = path.join(workDir, `${stem}_doc.json`);
    // 引擎升级后不能复用旧 Doc JSON(否则新提取器的修复永远看不到)。
    let engineVersion = "";
    if (engine && String(settings.engineUrl || "").trim()) {
      try {
        const health = await engine.health(settings);
        engineVersion = String(health?.engineVersion || "").trim();
      } catch { /* 探测失败不挡转换 */ }
    }
    const versionMark = path.join(workDir, "engine-version.txt");
    let cachedVersion = "";
    try {
      cachedVersion = fs.readFileSync(versionMark, "utf8").trim();
    } catch { /* 老缓存没有版本标记 */ }
    const engineStale = Boolean(engine && String(settings.engineUrl || "").trim())
      && (engineVersion ? cachedVersion !== engineVersion : cachedVersion !== "local");
    // 块规则变过(选项/代码块/家具):旧 Doc JSON 直接作废,不赌引擎版本探测。
    const formatMark = path.join(workDir, "cache-version.txt");
    let cachedFormat = "";
    try {
      cachedFormat = fs.readFileSync(formatMark, "utf8").trim();
    } catch { /* 老缓存没有格式版本 */ }
    const formatStale = cachedFormat !== FORMULA_CACHE_VERSION;
    if (formatStale) log("formula chain: cache format changed, re-parsing", cachedFormat || "(none)");
    if (engineStale) log("formula chain: engine changed, ignoring cached doc", `${cachedVersion || "(none)"} -> ${engineVersion || "local"}`, engineVersion ? "" : "(health unavailable)");
    const reusable = (() => {
      if (refresh || engineStale || formatStale || !fs.existsSync(docPath)) return false;
      try {
        return fs.statSync(docPath).mtimeMs >= fs.statSync(source).mtimeMs - 1000;
      } catch {
        return false;
      }
    })();
    let parsed = { ok: true, log: "" };
    let usedEngine = false;
    // 引擎优先(可独立部署的本地服务):pdf_tool 与 MinerU 凭据都在引擎侧配置,
    // 应用只发意图;引擎失败/没配就回退到本机 checkout(下面那段)。
    const runViaEngine = async () => {
      if (!engine || !String(settings.engineUrl || "").trim()) return false;
      report?.({ label: "书稿引擎解析" });
      const ran = await engine.runJob(settings, "extract", {
        source,
        outDir: workDir,
        model: String(settings.mineruModel || "").trim() || "vlm",
        mineruSource: String(settings.mineruSource || "") === "local" ? "local" : "",
        pages,
      }, { signal, onProgress: (progress) => report?.({ label: progress.label || "书稿引擎解析中…" }) });
      if (ran.cancelled) {
        parsed = { ok: false, cancelled: true, error: "任务已取消" };
        return true;
      }
      if (ran.ok) {
        parsed = { ok: true, log: ran.result?.log || "" };
        usedEngine = true;
        return true;
      }
      log("formula chain: engine extract failed, falling back to local pdf_tool", ran.error);
      return false;
    };
    if (reusable) {
      report?.({ label: "复用缓存的 MinerU 解析" });
      log("formula chain: reuse cached doc", docPath);
    } else if (await runViaEngine()) {
      // 引擎已经产出 Doc JSON(下面统一按 docPath 读)
    } else {
      const token = resolveMineruToken(settings, { readEnv });
      const backend = await resolveLocalBackend(settings, { fetchImpl, readEnv });
      if (!token && !backend.wantLocal) {
        return { ok: false, error: "没有找到 MinerU 凭据:在「设置 → 书坊 → MinerU 凭据」里填,或配置环境变量 MINERU_API_KEY / MINERU_TOKEN;也可以启动本地 MinerU 服务并填「本地 MinerU 服务」地址。" };
      }
      if (backend.wantLocal && !backend.url && !backend.exe) {
        return { ok: false, error: "选了本地 MinerU,但服务没在跑、也找不到 mineru-kit:在「设置 → 书坊 → 本地 MinerU 程序」里填完整路径(或点「启动服务」)。" };
      }
      report?.({ label: backend.url ? "本地 MinerU 服务解析" : backend.exe && backend.wantLocal ? "本地 MinerU(CLI)解析" : "MinerU 云端解析" });
      log("formula chain: pdf_tool", target.command, target.script);
      // 页眉页脚 / 页码 / 水印由 pdf_tool 侧清理(书坊不在这条链路上动手)。
      const args = pdfToolArgs(target.script, {
        source,
        outDir: workDir,
        model: String(settings.mineruModel || "").trim() || "vlm",
        pages,
        mineruSource: backend.wantLocal ? "local" : "",
      });
      // 凭据 / 本地地址走子进程环境而不是命令行:不在进程列表里暴露。
      // MINERU_LOCAL_URL 显式给(可能为空):把父进程继承来的地址挡掉,免得 pdf_tool 去连一个死地址。
      // PYTHONUTF8/PYTHONIOENCODING:让 pdf_tool(Python)的中文报错按 UTF-8 出来,不然在书坊里是乱码。
      const env = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", MINERU_LOCAL_URL: backend.url };
      if (token) env.MINERU_API_KEY = token;
      // 程序路径也要给:pdf_tool 的 helper 靠它(同目录 python)找 MinerU venv ——
      // 走常驻服务时同样需要,否则 helper 用系统 python 会报 No module named 'mineru'。
      if (backend.exe) env.MINERU_LOCAL_CMD = backend.exe;
      parsed = await runCommand(target.command, args, {
        cwd: target.cwd,
        env,
        signal,
      });
      if (!parsed.ok) return { ok: false, error: friendlyPdfToolError(parsed.error), cancelled: parsed.cancelled };
    }
    if (!fs.existsSync(docPath)) return { ok: false, error: "pdf_tool 没有生成 Doc JSON" };
    // 记下这份 Doc JSON 是哪个引擎版本产出的:升级后版本对不上就重新解析。
    try {
      fs.writeFileSync(versionMark, usedEngine ? engineVersion : "local", "utf8");
      fs.writeFileSync(formatMark, FORMULA_CACHE_VERSION, "utf8");
    } catch { /* 标记写不了不影响转换 */ }
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
      const layer = await textLayer.read(source, { python: String(settings.ocrPython || "").trim() || "python", workDir, signal, settings });
      if (layer.ok) blocks = mergeBlocksWithTextLayer(blocks, layer.pages, { log });
      else log("text layer skipped", layer.error);
    }
    if (signal?.aborted) return { ok: false, cancelled: true, error: "任务已取消" };
    const html = blocksToHtml(blocks, { title: stemOf(source), tableMode: tableModeFor(format) });
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
    if (!resolveMineruToken(settings, { readEnv })
      && !resolveMineruLocalUrl(settings, { readEnv })
      && String(settings.mineruSource || "") !== "local") {
      throw new Error("没有找到 MinerU 凭据或本地服务:在「设置 → 书坊 → MinerU 凭据」填写,或设置环境变量 MINERU_API_KEY / MINERU_TOKEN;本地服务填「本地 MinerU 服务」地址(设置后需重启应用)");
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
    // 同名不覆盖:本地文件也要按 §7 加序号(渲染层的书库判断看不到本地文件)。
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, docvortexFormatExt(format))));
    const workDir = formulaCacheDir(cacheRoot, source, pages);
    const prepared = await chain.prepare({ settings, source, workDir, pages, signal, report, format, refresh: payload?.refresh === true });
    if (signal.aborted) throw new Error("任务已取消");
    if (!prepared.ok) throw new Error(String(prepared.error || "MinerU 解析失败"));
    report({ label: "DocVortex 转换" });
    log("formula chain:", prepared.htmlPath, "→", out);
    const result = await docvortex.convert(settings, { source: prepared.htmlPath, format, out, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "转换失败"));
    if (format === "html") rewriteHtmlMath(out, { log });
    return { output: out, detail: `${format} · ${path.basename(out)}` };
  });

  return { pdfToolScriptCommand, formulaCacheDir };
}

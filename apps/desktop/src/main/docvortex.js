// 书坊文档互转(DocVortex):检测 CLI、构建命令、驱动转换。
// DocVortex 是外部工具(pip install docvortex):候选顺序=自定义路径 →
// PATH 上的 docvortex → 配置的 python -m docvortex。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { cleanedPdfFor, createPdfCleaner } from "./pdf-text.js";
import { restoreDocxLists } from "./docx-numbering.js";
import { escapeHtml, mathScript, stripMathDelimiters } from "./formula-html.js";
import { markdownToHtml, textToHtml } from "./text-book.js";
import { removeFile, uniqueFile } from "./paths.js";
import { DOCVORTEX_FORMATS, docvortexFormatExt, textSourceKind } from "../shared/workshop-formats.js";
import { decodeText } from "../shared/text-encoding.js";
import { convertPath } from "../shared/workshop-names.js";

export { DOCVORTEX_FORMATS };

export function docvortexCandidates(settings = {}) {
  const custom = String(settings.docvortexPath || "").trim();
  const python = String(settings.docvortexPython || settings.ocrPython || "").trim() || "python";
  const list = [];
  if (custom) list.push({ command: custom, args: [], kind: "custom" });
  list.push({ command: "docvortex", args: [], kind: "path" });
  // DocVortex 0.5.16 有 console entry point,但包没有 __main__,
  // 所以 `python -m docvortex` 在部分环境会失败;直接调 cli.main 更稳。
  list.push({ command: python, args: ["-c", "from docvortex.cli import main; main()"], kind: "python-cli" });
  list.push({ command: python, args: ["-m", "docvortex"], kind: "python" });
  return list;
}

export function convertArgs(source, target, out, { parseMode = "" } = {}) {
  const args = ["convert", String(source), "--format", String(target || "markdown"), "--output", String(out), "--overwrite"];
  const mode = String(parseMode || "").trim();
  if (mode) args.push("--parse-mode", mode);
  return args;
}

// Markdown / 纯文本 → DocVortex 能收的 HTML。
// 它 0.5.16 的原生输入(FileSuffix)只有 PDF / Office / ODF / HTML / EPUB / OFD:
// 直接把 .md / .txt 交给它会报 `Unsupported native input format: markdown|txt`。
// 桥接时:标题 / 列表 / 表格 / 代码走书坊自己的渲染器,公式写成它认识的
// `<script type="math/tex">`(DOCX 出真 OMML、EPUB 出 MathML),图片保持相对路径。
export function textSourceHtml(source, text, { title = "" } = {}) {
  const renderMath = (latex, display) => {
    const body = mathScript(stripMathDelimiters(latex), display);
    return display ? `<p>${body}</p>` : body;
  };
  const kind = textSourceKind(source);
  const body = kind === "markdown"
    ? markdownToHtml(text, { renderMath })
    : textToHtml(text);
  const base = String(source || "");
  const name = String(title || path.basename(base, path.extname(base)));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

// 桥文件写在源文件旁边:DocVortex 把 HTML 所在目录当资源根,Markdown 里的相对图片
// (images/fig1.png)这样才能被读到。目录不可写(只读盘 / 权限)时退回缓存目录,
// 代价是相对图片找不到 —— 记日志,不阻断转换。
export function writeTextSourceBridge(source, { cacheRoot = "", log = () => {} } = {}) {
  if (!textSourceKind(source)) return "";
  const html = textSourceHtml(source, decodeText(fs.readFileSync(source)));
  const name = `.${path.basename(source)}.bridge-${Date.now().toString(36)}.html`;
  const beside = path.join(path.dirname(source), name);
  try {
    fs.writeFileSync(beside, html, "utf8");
    return beside;
  } catch (error) {
    const dir = path.join(String(cacheRoot || process.env.TEMP || process.env.TMP || "/tmp"), "convert-bridge");
    fs.mkdirSync(dir, { recursive: true });
    const fallback = path.join(dir, name);
    fs.writeFileSync(fallback, html, "utf8");
    log("text bridge fell back to the cache dir (relative images may be skipped)", fallback, String(error?.message || error));
    return fallback;
  }
}

// 桥文件是实现细节,用完就删,别留在用户的目录里。
export function removeTextSourceBridge(file, { log = () => {} } = {}) {
  if (!file) return;
  // 清理失败不掩盖转换本身的错误,但要留日志:桥文件落在用户目录里,不能悄悄留下。
  try { removeFile(file); } catch (error) { log("text bridge cleanup failed", file, String(error?.message || error)); }
}

function tail(text, limit = 300) {
  return String(text || "").trim().slice(-limit);
}

export function createDocvortex({ spawnImpl = spawn, timeoutMs = 10 * 60_000, probeTimeoutMs = 8_000, engine = null } = {}) {
  // 逐个候选跑 `--version`;第一个成功的即解析结果。
  function probe(settings = {}) {
    const candidates = docvortexCandidates(settings);
    return new Promise((resolve) => {
      let index = 0;
      const attempt = () => {
        const candidate = candidates[index++];
        if (!candidate) {
          resolve({ ok: false, detail: "未找到 docvortex(可 pip install docvortex 或填写路径)" });
          return;
        }
        let child;
        try {
          child = spawnImpl(candidate.command, [...candidate.args, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
        } catch {
          attempt();
          return;
        }
        let out = "";
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch { /* already gone */ }
          if (ok) resolve({ ok: true, detail: out.trim().split("\n")[0] || "docvortex", ...candidate });
          else attempt();
        };
        const timer = setTimeout(() => finish(false), probeTimeoutMs);
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
      };
      attempt();
    });
  }

  function run(candidate, args, { signal } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(candidate.command, [...candidate.args, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
        finish({ ok: false, error: `转换超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
      child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : tail(out) || `docvortex 退出码 ${code}` }));
    });
  }

  async function convert(settings, { source, format, out, signal, parseMode = "" } = {}) {
    if (!fs.existsSync(source)) return { ok: false, error: `源文件不存在：${source}` };
    // 引擎优先(可独立部署):引擎按自己的配置调 DocVortex;失败/没配再回退本机 CLI。
    if (engine && String(settings.engineUrl || "").trim()) {
      const ran = await engine.runJob(settings, "convert", { source, format, out, parseMode }, { signal });
      if (ran.ok && ran.result?.out && fs.existsSync(ran.result.out)) return { ok: true, out: ran.result.out, via: "engine" };
      if (ran.cancelled) return { ok: false, error: "已取消", cancelled: true };
    }
    const resolved = await probe(settings);
    if (!resolved.ok) return { ok: false, error: resolved.detail };
    const result = await run(resolved, convertArgs(source, format, out, { parseMode }), { signal });
    if (!result.ok) return result;
    if (!fs.existsSync(out)) return { ok: false, error: "转换完成但没有生成文件" };
    return { ok: true, out };
  }

  return { probe, convert, run };
}

export function registerDocvortexRunners(workshop, { docvortex, vaultRoot = "", cacheRoot = "", cleaner = createPdfCleaner(), log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  // 检测 DocVortex 是否可用(面板里的「检测」按钮)。
  workshop.register("docvortex-probe", async ({ payload, signal }) => {
    const result = await docvortex.probe(payload?.settings || {});
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.detail || "DocVortex 不可用"));
    return { output: String(result.detail), detail: `${result.kind} · ${result.command}` };
  });

  // 文档互转:source/out 可以是书库相对路径或绝对路径。
  workshop.register("docvortex-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    const format = String(payload?.format || "markdown");
    // 同名不覆盖:本地文件也要按 §7 加序号(渲染层的书库判断看不到本地文件)。
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, docvortexFormatExt(format))));
    // 这条链路不经过 pdf_tool,PDF 的页眉页脚 / 页码 / 水印由我们先擦掉
    // (经过 pdf_tool 的链路由 pdf_tool 侧负责)。
    const input = await cleanedPdfFor(source, { cleaner, settings, cacheRoot, signal, log });
    const kind = textSourceKind(input);
    // Markdown / 纯文本 DocVortex 收不了(见 textSourceHtml):先渲染成 HTML 再转换。
    const label = kind === "markdown" ? "Markdown 渲染成 HTML" : kind === "text" ? "纯文本渲染成 HTML" : `转换为 ${format}`;
    report({ label });
    log("workshop convert", source, "→", out);
    let bridge = "";
    try {
      if (kind) bridge = writeTextSourceBridge(input, { cacheRoot, log });
      const result = await docvortex.convert(settings, { source: bridge || input, format, out, signal });
      if (signal.aborted) throw new Error("任务已取消");
      if (!result.ok) throw new Error(String(result.error || "转换失败"));
      // 文本源 → docx:DocVortex 的列表是「字面编号 + 缩进」的普通段落,产物里换成
      // 真 Word 列表(w:numPr) —— 编号可续、可改样式(见 docx-numbering.js)。
      if (kind && format === "docx") {
        const restored = await restoreDocxLists(out, { log });
        if (restored) log("docx lists restored", restored, path.basename(out));
      }
    } finally {
      removeTextSourceBridge(bridge, { log });
    }
    return { output: out, detail: `${format} · ${path.basename(out)}` };
  });

  return { convertPath };
}

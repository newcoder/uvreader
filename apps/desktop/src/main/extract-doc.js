// 书坊:内容提取(PDF / Office / OFD / 图片 → 内容)。
// PDF 走 pdf_tool(pdf_to_doc.py:auto/text/vision/mineru/blocks);Office/OFD/HTML/图片走 DocVortex。
// 产物按 §7 命名规则落在源文件旁: `<源名>.md` / `.html` / `.json` / `.audit.json` / `<源名>.assets/`。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EXTRACT_MODES, IMAGE_INPUTS, extractionKind } from "../shared/extract-formats.js";
import { textSourceKind } from "../shared/workshop-formats.js";
import { joinContinuationLines, joinSplitCodeFences, splitMarkdownChapters, unwrapProseFences } from "../shared/markdown-fix.js";
import { tocKey, tocLevel } from "../shared/printed-toc.js";
import { blocksFromDoc, blocksToMarkdown, cleanFootnoteText } from "./formula-html.js";
import { buildTextDoc, createPdfTextReader, writeTextProducts } from "./pdf-text.js";
import { removeTextSourceBridge, writeTextSourceBridge } from "./docvortex.js";
import { removeFile, removeTree } from "./paths.js";
import { mergeBlocksWithTextLayer } from "./text-merge.js";
import { createTextLayerReader } from "./text-layer.js";
import { resolveLocalBackend } from "./mineru-local.js";
import { pdfToolArgs, pdfToolScriptCommand, resolveMineruLocalUrl } from "./workshop-formula.js";

export { EXTRACT_MODES, IMAGE_INPUTS, extractionKind };
export { splitMarkdownChapters, unwrapProseFences, joinSplitCodeFences } from "../shared/markdown-fix.js";

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

// 递归拷贝目录(资产目录合并用;直接 copyFile,不依赖 fs.cpSync 的版本)。
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

// pdf_tool 的产物(<stem>_doc.md / .html / .json / _audit.json + mineru/ 资产)
// → §7 约定(<源名>.md / .html / .json / .audit.json / <源名>.assets/)。
// MinerU 的脚注(`page_footnote`)在转成 Doc JSON 时会被上游丢掉,但它的
// `*_content_list.json` 里还留着。这里把脚注捞回来,附在成品末尾的「注释」一节
// (正文里的 ①② 标记与这里一一对应,不再丢注解)。
export function collectPageFootnotes(workDir) {
  const notes = [];
  const seen = new Set();
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/_content_list\.json$/i.test(entry.name)) continue;
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      // 分块目录形如 0001-0200:页码要加上起始偏移(索引从 1 开始)。
      const chunk = path.basename(path.dirname(full)).match(/^(\d+)-(\d+)$/);
      const offset = chunk ? Number(chunk[1]) - 1 : 0;
      for (const block of Array.isArray(list) ? list : []) {
        if (!/(?:page_)?footnote$/i.test(String(block?.type || ""))) continue;
        const text = String(block?.text || "").replace(/\s*\n\s*/g, " ").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        notes.push({ page: (Number(block?.page_idx) || 0) + 1 + offset, text });
      }
    }
  };
  walk(workDir);
  return notes.sort((a, b) => a.page - b.page);
}

// 把脚注接到 Markdown 末尾(已有「注释」一节、或该条脚注已经在稿子里,就不重复加)。
// pdf_tool 新版会把脚注直接写进 md(引用块 + 页码),老版本才需要这里兜底。
export function appendFootnotes(markdown, notes) {
  const text = String(markdown || "");
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length || /^#{1,6}\s*注释\s*$/m.test(text)) return text;
  const compact = text.replace(/\s+/g, "");
  const missing = list.filter((note) => {
    const noteText = String(note?.text || "").replace(/\s+/g, "");
    if (!noteText) return false;
    // 拿前 24 个字判断:上游写进 md 时可能补了页码/标点。
    const probe = noteText.slice(0, 24);
    return probe.length < 6 || !compact.includes(probe);
  });
  if (!missing.length) return text;
  const body = missing
    .map((note) => ({ ...note, text: cleanFootnoteText(String(note.text || "").replace(/\s*\n\s*/g, " ").trim()) }))
    .filter((note) => note.text)
    .map((note) => `> ${note.text}`)
    .join("\n\n");
  if (!body) return text;
  return `${text.replace(/\s*$/, "")}\n\n## 注释\n\n${body}\n`;
}

// 上游(pdf_tool)给的目录条目:Doc JSON 里带 page_role:"toc" 的页 + toc_entries。
// 有就用它(比我们从 md 文本兜底解析准),没有返回空数组。
export function collectUpstreamTocEntries(docPath) {
  try {
    if (!docPath || !fs.existsSync(docPath)) return [];
    const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
    const entries = [];
    for (const page of Array.isArray(doc?.pages) ? doc.pages : []) {
      const list = Array.isArray(page?.toc_entries) ? page.toc_entries : null;
      if (!list) continue;
      for (const item of list) {
        const label = String(item?.title ?? item?.label ?? "").trim();
        if (!label) continue;
        entries.push({
          label,
          key: tocKey(label),
          page: Number(item?.page) || 0,
          level: Number(item?.level) > 0 ? Math.min(Number(item.level), 3) : tocLevel(label),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// 上游(pdf_tool e0bc735)把「页首被截断的半句」标成 continuation:true 并降级为正文。
// 取出这些块的文字,用来把它们接回上一段(md 里它们现在是独立段落)。
export function collectContinuations(docPath) {
  try {
    if (!docPath || !fs.existsSync(docPath)) return [];
    const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
    const out = [];
    for (const page of Array.isArray(doc?.pages) ? doc.pages : []) {
      for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
        const text = String(block?.text ?? "").replace(/\s*\n\s*/g, " ").trim();
        if (block?.continuation === true && text) out.push(text);
      }
    }
    return out;
  } catch {
    return [];
  }
}

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
  let assetPrefix = "mineru/";
  if (renameAssets && fs.existsSync(assetsFrom)) {
    try {
      if (fs.existsSync(assetsTo)) {
        // 同一份源提取过多次:目标 assets 目录已经在了(MinerU 每次的图名是内容哈希,
        // 可能和上次不同),把这次的新图并进去,否则 <源名>.assets/... 的链接会指空。
        copyDir(assetsFrom, assetsTo);
        removeTree(assetsFrom);
      } else {
        fs.renameSync(assetsFrom, assetsTo);
      }
      assetPrefix = `${name}.assets/`;
    } catch { assetPrefix = "mineru/"; }
  }
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
          // MinerU 按页切块:跨页的程序会变成两段围栏,这里并回一段。
          fixed = joinSplitCodeFences(fixed);
          // 上游转 Doc JSON 时丢了脚注,从 MinerU 的 content_list 里捞回来。
          fixed = appendFootnotes(fixed, collectPageFootnotes(outDir));
          // R2:上游标了 continuation 的半句接回上一段。
          fixed = joinContinuationLines(fixed, collectContinuations(path.join(outDir, `${name}_doc.json`)));
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

// 多张图片 → 一个 PDF(格式转换的「图片 → PDF」预设):每张图一页,尺寸按 150dpi 换算
// (不重采样,只影响页面物理尺寸,3000px 的扫描页≈10 英寸)。
export const IMAGES_TO_PDF_SCRIPT = `import sys
from PIL import Image
out = sys.argv[1]
pages = []
for path in sys.argv[2:]:
    im = Image.open(path)
    if im.mode != "RGB":
        im = im.convert("RGB")
    im.info["dpi"] = (150, 150)
    pages.append(im)
if not pages:
    raise SystemExit("no images to pack")
pages[0].save(out, "PDF", save_all=True, append_images=pages[1:], dpi=(150, 150), resolution=150.0)
`;

export function imagesToPdf(images, outPath, { python = "python", signal, log = () => {}, spawnImpl = spawn } = {}) {
  return runExtractCommand(python, ["-c", IMAGES_TO_PDF_SCRIPT, outPath, ...images.map((file) => String(file))], {
    signal,
    log,
    timeoutMs: 120_000,
    spawnImpl,
  });
}

// 提取产物的复用标记(MinerU 慢且计费):源文件 + 模式 + 模型一致才复用。
// 文本型再多比一个产物版本:提取器行为变了(如新增图的裁剪)就别复用旧产物。
const EXTRACT_VERSION = 2;

export function extractMarkPath(cacheRoot, source) {
  const root = String(cacheRoot || "");
  if (!root) return "";
  const key = crypto.createHash("sha1").update(path.resolve(String(source))).digest("hex").slice(0, 16);
  return path.join(root, "marks", `${key}.json`);
}

export function readExtractMark(cacheRoot, source, { mode, model, stat }) {
  const file = extractMarkPath(cacheRoot, source);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const mark = JSON.parse(fs.readFileSync(file, "utf8"));
    if (mark.mode !== mode || mark.model !== model) return null;
    // 文本型的产物格式随提取器一起演进(如新增图的裁剪):版本对不上就不再复用。
    if (mode === "text" && Number(mark.version || 1) !== EXTRACT_VERSION) return null;
    if (Number(mark.size) !== stat.size || Number(mark.mtimeMs) !== Math.round(stat.mtimeMs)) return null;
    const outputs = mark.outputs || {};
    if (!outputs.md || !Object.values(outputs).every((entry) => fs.existsSync(entry))) return null;
    return outputs;
  } catch {
    return null;
  }
}

export function writeExtractMark(cacheRoot, source, { mode, model, stat, outputs }) {
  const file = extractMarkPath(cacheRoot, source);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      source: path.resolve(String(source)),
      mode,
      model,
      version: EXTRACT_VERSION,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      outputs,
      at: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch { /* 标记写不了不影响提取 */ }
}

// pdf_tool 的 Doc JSON + PDF 文字层 → 互补后的 Markdown(正文逐字、公式 LaTeX)。
// 拿不到文字层(扫描件 / 没装 PyMuPDF)或定位失败时返回 "",调用方保留 MinerU 产物。
export async function mergePdfMarkdown({ docPath, source, python = "python", workDir = "", signal, textLayer = null, settings = {}, assetPrefix = "", log = () => {} } = {}) {
  if (!textLayer || !docPath || !fs.existsSync(docPath)) return "";
  try {
    const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
    // 文本型产物(engine=fitz-text)本身就是文字层提取的结果:再合一次只会把它改坏
    // (实测会把「（CSP-J1）」这类全角括号吃掉)。直接跳过,复用原产物。
    if (String(doc?.source?.engine || "") === "fitz-text") {
      log("text layer merge skipped: doc already comes from the text layer");
      return "";
    }
    const blocks = blocksFromDoc(doc);
    const layer = await textLayer.read(source, { python, workDir, signal, settings });
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
export async function extractMarkdown(source, { kind, settings = {}, docvortex, workDir, signal, log = () => {}, spawnImpl = spawn, textLayer = null, refresh = false, engine = null, report = null } = {}) {
  const resolvedKind = kind || extractionKind(source);
  // 提取产物里的「假代码块」(MinerU 把正文段落包进围栏)按段落还原,公式才会渲染。
  const readMarkdown = (file) => {
    const raw = fs.readFileSync(file, "utf8");
    let cleaned = unwrapProseFences(raw);
    cleaned = joinSplitCodeFences(cleaned);
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
      const cachedRaw = fs.readFileSync(mergedPath, "utf8");
      // 老缓存里没有脚注(上游 Doc JSON 丢了这个类型):复用顺手补上,缓存自愈。
      let cachedText = appendFootnotes(cachedRaw, collectPageFootnotes(workDir));
      // R2:上游标了 continuation 的半句接回上一段(老缓存里没有标记就什么都不做)。
      cachedText = joinContinuationLines(cachedText, collectContinuations(docCandidates.find(fresh)));
      if (cachedText !== cachedRaw) fs.writeFileSync(mergedPath, cachedText, "utf8");
      return { ok: true, markdown: cachedText, path: mergedPath, tocEntries: collectUpstreamTocEntries(docCandidates.find(fresh)) };
    }
    // refresh = 忽略缓存重新提取:连 Doc JSON 也不复用,真的再跑一次上游。
    const cachedDoc = refresh ? undefined : docCandidates.find(fresh);
    if (!cachedDoc) {
      // 引擎优先(可独立部署):pdf_tool 与 MinerU 凭据都在引擎侧配置;失败再回退本机 checkout。
      const viaEngine = engine && String(settings.engineUrl || "").trim()
        ? await engine.runJob(settings, "extract", {
          source,
          outDir: workDir,
          mode: String(settings.extractMode || "auto"),
          formats: "json,md,html",
          model: String(settings.mineruModel || "").trim() || "vlm",
          mineruSource: String(settings.mineruSource || "") === "local" ? "local" : "",
        }, { signal, onProgress: (progress) => report?.({ label: progress.label || "书稿引擎解析中…" }) })
        : null;
      if (viaEngine?.ok) {
        log("extract: pdf_tool via engine");
      } else {
        if (viaEngine?.cancelled) return { ok: false, cancelled: true, error: "任务已取消" };
        if (viaEngine) log("extract: engine failed, falling back to local pdf_tool", viaEngine.error);
        // 交给 pdf_tool 前先去掉页眉页脚 / 页码 / 水印。
        const args = pdfToolArgs(target.script, { source, outDir: workDir, model: String(settings.mineruModel || "").trim() || "vlm" });
        const modeIndex = args.indexOf("--mode");
        if (modeIndex >= 0) args[modeIndex + 1] = String(settings.extractMode || "auto");
        const formatsIndex = args.indexOf("--formats");
        if (formatsIndex >= 0) args[formatsIndex + 1] = "json,md,html";
        else args.push("--formats", "json,md,html");
        const token = String(settings.mineruToken || "").trim()
          || String(process.env.MINERU_API_KEY || process.env.MINERU_TOKEN || "").trim();
        const backend = await resolveLocalBackend(settings);
        // MINERU_LOCAL_URL 显式给(可能空):挡掉父进程继承来的死地址。
        const env = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", MINERU_LOCAL_URL: backend.url };
        if (token) env.MINERU_API_KEY = token;
        if (backend.exe) env.MINERU_LOCAL_CMD = backend.exe;
        const result = await runExtractCommand(target.command, args, {
          cwd: target.cwd,
          env,
          signal,
          log,
          spawnImpl,
        });
        if (!result.ok) return { ok: false, error: result.error };
      }
    } else {
      log("extract: reuse cached doc json", cachedDoc);
    }
    const files = adoptPdfToolOutputs(workDir, stem, { renameAssets: false });
    if (!files.md) return { ok: false, error: "提取完成但没有找到 Markdown 产物" };
    // 文字层互补:正文逐字取 PDF 文字层(补 MinerU 丢的字),公式仍是 LaTeX。
    const merged = await mergePdfMarkdown({
      docPath: files.json || cachedDoc,
      source,
      python: docvortexPython(settings),
      settings,
      workDir,
      signal,
      textLayer,
      log,
    });
    if (merged) {
      // 脚注在上面两步里都不会出现(上游 Doc JSON 丢了这个类型):写完合并稿再补。
      let withNotes = appendFootnotes(merged, collectPageFootnotes(workDir));
      // R2:上游标了 continuation 的半句接回上一段。
      withNotes = joinContinuationLines(withNotes, collectContinuations(files.json || cachedDoc));
      fs.writeFileSync(mergedPath, withNotes, "utf8");
      return { ok: true, markdown: withNotes, path: mergedPath, tocEntries: collectUpstreamTocEntries(files.json || cachedDoc) };
    }
    return { ok: true, markdown: readMarkdown(files.md), path: files.md, tocEntries: collectUpstreamTocEntries(files.json || cachedDoc) };
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
  // Markdown / 纯文本 DocVortex 收不了(见 docvortex.js 的 textSourceHtml):先渲染成 HTML。
  let bridge = "";
  try {
    if (textSourceKind(source)) bridge = writeTextSourceBridge(source, { cacheRoot: workDir, log });
    const result = await docvortex.convert(settings, { source: bridge || source, format: "markdown", out, signal });
    if (!result.ok) return { ok: false, error: result.error };
  } finally {
    removeTextSourceBridge(bridge, { log });
  }
  return { ok: true, markdown: readMarkdown(out), path: out };
}

export function registerExtractRunners(workshop, { docvortex, vaultRoot = "", cacheRoot = "", spawnImpl = spawn, textLayer = createTextLayerReader(), pdfText = createPdfTextReader(), engine = null, log = (...args) => console.log(...args) } = {}) {
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
    const localUrl = resolveMineruLocalUrl(settings);
    return {
      output: localUrl ? "pdf_tool + DocVortex + 本地 MinerU" : token ? "pdf_tool + DocVortex + MinerU" : "pdf_tool + DocVortex(PDF 无 MinerU 需文本模型凭据)",
      detail: `pdf_tool · ${path.basename(target.cwd)}`,
    };
  });

  // PDF 提取:文本型走本地确定性提取;其余走 pdf_tool(pdf_to_doc.py)→ 按 §7 改名落回源文件旁。
  workshop.register("extract-pdf", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const mode = String(payload?.mode || "auto");
    const model = String(settings.mineruModel || "").trim() || "vlm";
    // MinerU 的模型是首次使用时才下载(几百 MB~GB),下载期间任务只会停在「解析中」—— 先说清楚。
    if (mode === "mineru") report({ label: "MinerU 解析中(首次用某个模型会先下载,几百 MB~GB;期间会停在这里)" });
    const outDir = path.dirname(source);
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    const stat = fs.statSync(source);
    // 复用:同一份源 + 同样的模式 / 模型已有产物就直接用(MinerU 慢且计费,重跑不再等云端)。
    const cached = readExtractMark(cacheRoot, source, { mode, model, stat });
    // 「忽略缓存重新提取」时跳过复用(上游改了提取行为、脚注/表格修复要用新版跑一遍)。
    if (cached && payload?.refresh !== true) {
      report({ label: "复用已有的提取产物" });
      log("extract: reuse products", cached.md);
      const mergedCache = await mergePdfMarkdown({
        docPath: cached.json,
        source,
        python: docvortexPython(settings),
        settings,
        workDir: outDir,
        signal,
        textLayer,
        log,
        assetPrefix: `${stem}.assets/`,
      });
      if (signal.aborted) throw new Error("任务已取消");
      if (mergedCache) fs.writeFileSync(cached.md, mergedCache, "utf8");
      return { output: cached.md, detail: `Markdown · ${Math.round(fs.statSync(cached.md).size / 1024)} KB`, outputs: cached };
    }
    report({ label: `提取中（${mode}）` });
    // 文本型 PDF:我们自己用 PyMuPDF 确定性提取(先清页眉页脚 / 页码 / 水印,再聚块,
    // 跨页代码块与断句段落合并)——完全本地,不需要 pdf_tool checkout,也不跑 OCR。
    if (mode === "text") {
      report({ label: "本地取文本" });
      const work = path.join(cacheRoot || os.tmpdir(), "pdf-text", `${stem}-${Date.now().toString(36)}`);
      const read = await pdfText.read(source, { python: docvortexPython(settings), workDir: work, signal, engineSettings: settings });
      if (signal.aborted) throw new Error("任务已取消");
      if (!read.ok) throw new Error(`本地取文本失败：${read.error}`);
      const doc = buildTextDoc(read.pages, { source, title: stem, assetPrefix: `${stem}.assets/` });
      if (!doc.pages.length) throw new Error("这份 PDF 没有可提取的文本(扫描件请用「扫描视觉」或「MinerU 云端」)");
      const files = writeTextProducts(doc, {
        outDir,
        stem,
        assets: read.pages.flatMap((page) => (page.figures || []).map((figure) => ({
          name: figure.file,
          path: path.join(work, "assets", String(figure.file || "")),
        }))),
      });
      writeExtractMark(cacheRoot, source, { mode, model, stat, outputs: files });
      return { output: files.md, detail: `Markdown · ${Math.round(fs.statSync(files.md).size / 1024)} KB`, outputs: files };
    }
    // 引擎优先(可独立部署):pdf_tool 与 MinerU 凭据都在引擎侧配置;失败再回退本机 checkout。
    let viaEngine = null;
    if (engine && String(settings.engineUrl || "").trim()) {
      report({ label: "书稿引擎解析" });
      viaEngine = await engine.runJob(settings, "extract", {
        source,
        outDir,
        mode,
        formats: "json,md,html",
        model,
        mineruSource: String(settings.mineruSource || "") === "local" ? "local" : "",
      }, { signal, onProgress: (progress) => report?.({ label: progress.label || "书稿引擎解析中…" }) });
    }
    if (viaEngine?.ok) {
      log("extract: pdf_tool via engine");
    } else {
      if (viaEngine?.cancelled) throw new Error("任务已取消");
      if (viaEngine) log("extract: engine failed, falling back to local pdf_tool", viaEngine.error);
      const target = pdfToolScriptCommand(settings);
      if (target.error) throw new Error(target.error);
      // 交给 pdf_tool 前先去掉页眉页脚 / 页码 / 水印(MinerU 会丢一部分,文本 / vision 模式不会)。
      const args = pdfToolArgs(target.script, { source, outDir, model });
      const modeIndex = args.indexOf("--mode");
      if (modeIndex >= 0) args[modeIndex + 1] = mode;
      const formatsIndex = args.indexOf("--formats");
      if (formatsIndex >= 0) args[formatsIndex + 1] = "json,md,html";
      else args.push("--formats", "json,md,html");
      // 凭据 / 本地后端走子进程环境:MINERU_LOCAL_URL 显式给(可能空),挡掉父进程继承来的死地址;
      // PYTHONUTF8/PYTHONIOENCODING 让 pdf_tool(Python)的中文报错按 UTF-8 出来,不在书坊里乱码。
      const token = String(settings.mineruToken || "").trim();
      const backend = await resolveLocalBackend(settings);
      const env = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", MINERU_LOCAL_URL: backend.url };
      if (token) env.MINERU_API_KEY = token;
      if (backend.exe) env.MINERU_LOCAL_CMD = backend.exe;
      const result = await runExtractCommand(target.command, args, {
        cwd: target.cwd,
        env,
        signal,
        log,
        spawnImpl,
      });
      if (signal.aborted) throw new Error("任务已取消");
      if (!result.ok) throw new Error(String(result.error || "提取失败"));
    }
    const files = adoptPdfToolOutputs(outDir, stem);
    if (!files.md) throw new Error("提取完成但没有找到 Markdown 产物");
    // 文字层互补:正文逐字取 PDF 文字层(补 MinerU 丢的字),公式仍是 LaTeX;失败保留 MinerU 的 md。
    report({ label: "文字层校正" });
    const merged = await mergePdfMarkdown({
      docPath: files.json,
      source,
      python: docvortexPython(settings),
      settings,
      workDir: outDir,
      signal,
      textLayer,
      log,
      assetPrefix: `${stem}.assets/`,
    });
    if (signal.aborted) throw new Error("任务已取消");
    if (merged) fs.writeFileSync(files.md, merged, "utf8");
    writeExtractMark(cacheRoot, source, { mode, model, stat, outputs: files });
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
    // Markdown / 纯文本同理:渲染成 HTML 桥(源文件旁的临时文件,跑完删掉)。
    let input = source;
    let tempPdf = "";
    let bridge = "";
    let parseMode = "";
    if (extractionKind(source) === "image") {
      report({ label: "图片转 PDF" });
      tempPdf = path.join(os.tmpdir(), `uvreader-image-${Date.now().toString(36)}.pdf`);
      const made = await imageToPdf(source, tempPdf, { python: docvortexPython(settings), signal, log, spawnImpl });
      if (!made.ok) throw new Error(`图片转 PDF 失败：${made.error}（需要 Pillow：pip install pillow）`);
      input = tempPdf;
      parseMode = "ocr";
    } else if (textSourceKind(source)) {
      report({ label: "渲染成 HTML" });
      bridge = writeTextSourceBridge(source, { cacheRoot, log });
      input = bridge;
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
        try { removeFile(tempPdf); } catch { /* 临时文件,忽略 */ }
      }
      removeTextSourceBridge(bridge, { log });
    }
    if (!outputs.md) throw new Error("提取完成但没有找到 Markdown 产物");
    return { output: outputs.md, detail: `Markdown · ${Math.round(fs.statSync(outputs.md).size / 1024)} KB`, outputs };
  });

  // 图片 → PDF(格式转换的「图片 → PDF」预设):多张图各占一页,产物落在首图旁边。
  workshop.register("images-pdf", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const images = (Array.isArray(payload?.images) ? payload.images : [])
      .map(absolute)
      .filter((file) => file && fs.existsSync(file));
    if (!images.length) throw new Error("请先选择图片(PNG / JPG / WebP / BMP / TIFF)");
    const first = images[0];
    const out = uniquePath(payload?.out
      ? absolute(payload.out)
      : path.join(path.dirname(first), `${path.basename(first).replace(/\.[^.]+$/, "")}.pdf`));
    report({ label: `合成 ${images.length} 张图片`, total: images.length });
    log("images → pdf", images.length, "→", out);
    // 引擎优先、失败回退本机(与其它链路同一条规则;配了 engineUrl 才走引擎)。
    if (engine && String(settings.engineUrl || "").trim()) {
      const ran = await engine.runJob(settings, "images-to-pdf", { images, out }, {
        signal,
        onProgress: (item) => report({ label: String(item?.label || `合成 ${images.length} 张图片`), total: images.length }),
      });
      if (ran.ok) {
        report({ done: images.length, total: images.length });
        return { output: String(ran.result?.out || out), detail: `PDF · ${images.length} 页 · ${path.basename(out)}(引擎)` };
      }
      log("engine images-to-pdf failed, falling back to the local script:", ran.error);
    }
    const result = await imagesToPdf(images, out, { python: docvortexPython(settings), signal, log, spawnImpl });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "合成 PDF 失败"));
    report({ done: images.length, total: images.length });
    return { output: out, detail: `PDF · ${images.length} 页 · ${path.basename(out)}` };
  });

  return { adoptPdfToolOutputs, splitMarkdownChapters };
}

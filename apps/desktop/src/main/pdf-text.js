// 「文本型 PDF」的确定性提取(纯本地,不需要模型):PyMuPDF 取结构化行(字体 / 字号 /
// 位置)→ 先去页眉页脚 / 页码 / 水印 → 再聚块(按字号判标题、按等宽字体判代码,
// 空行间距分块),跨页的代码块与断句段落合并成一块。
//
// 为什么不用 pdf_tool 的 text 模式:那条路把分块后的文本交给模型结构化,跨页边界上
// 的代码块会被拆散,而且不做页眉页脚 / 水印清理。这里全部确定性,产物与其它链路同构
// (Doc v1 JSON → 同一套 .md / .html 渲染)。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { blocksToHtml, blocksToMarkdown } from "./formula-html.js";
import { uniqueFile } from "./paths.js";
import { tableModeFor } from "./workshop-formula.js";
import { docvortexFormatExt } from "../shared/workshop-formats.js";
import { convertPath } from "../shared/workshop-names.js";

export { blocksToHtml, blocksToMarkdown } from "./formula-html.js";

export const PDF_TEXT_SCRIPT = `import fitz, json, sys

def is_cjk(ch):
    code = ord(ch)
    return 0x3400 <= code <= 0x9fff or 0x3000 <= code <= 0x303f or 0xff00 <= code <= 0xffef

CLOSERS = ("）", ")", "，", "。", "、", "；", "：", "”", "’", ",", ".", ";", ":", "!", "?", "！", "？")

doc = fitz.open(sys.argv[1])
pages = []
for page in doc:
    lines = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        direction = block.get("dir", (1, 0))
        rotated = float(direction[0] or 0) < 0.7
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if str(s.get("text", "")).strip()]
            if not spans:
                continue
            # 行内拼接:相邻 span 之间的水平空隙超过阈值时补一个空格(中西文用不同阈值)
            parts = []
            previous = None
            fonts = {}
            for span in spans:
                if previous is not None:
                    text_span = str(span["text"])
                    prev_text = str(previous["text"])
                    gap = float(span["bbox"][0]) - float(previous["bbox"][2])
                    size = min(float(span["size"]), float(previous["size"]))
                    edge_cjk = is_cjk(prev_text[-1]) or (bool(text_span) and is_cjk(text_span[0]))
                    threshold = 0.4 * size if edge_cjk else 0.18 * size
                    if (
                        gap > threshold
                        and not prev_text.endswith(("(", "（", '"'))
                        and not text_span[:1].isspace()
                        and not text_span.startswith(CLOSERS)
                    ):
                        parts.append(" ")
                parts.append(span["text"])
                name = str(span.get("font", ""))
                fonts[name] = fonts.get(name, 0) + len(str(span["text"]))
                previous = span
            text = "".join(parts)
            x0, y0, x1, y1 = line["bbox"]
            lines.append({
                "text": text,
                "fonts": fonts,
                "size": round(max(float(span["size"]) for span in spans), 1),
                "x0": round(x0, 1),
                "x1": round(x1, 1),
                "y0": round(y0, 1),
                "y1": round(y1, 1),
                "rotated": rotated,
            })
    # 低不透明度文字 = 水印(如 100pt / opacity 0.1 的「山西」),单独收集供整行剔除。
    faint = []
    try:
        for span in page.get_texttrace():
            if float(span.get("opacity", 1) or 1) < 0.5:
                text = "".join(chr(char[0]) for char in span.get("chars", []) if char and char[0]).strip()
                if text:
                    faint.append(text)
    except Exception:
        faint = []
    pages.append({
        "width": round(page.rect.width, 1),
        "height": round(page.rect.height, 1),
        "lines": lines,
        "faint": faint,
    })
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(pages, fh, ensure_ascii=False)
`;

const MONO_RE = /mono|courier|consol|menlo|inconsolata|source ?code|fira ?code|jetbrains|cascadia|dejavu sans mono|liberation mono|nimbus mono|andale mono|anonymous/i;
// 代码特征:关键字 / 结构符号。注意别把 "C++" 的 "++" 算进来——试卷选项里到处都是它。
const CODE_TOKEN_RE = /\b(?:def|class|import|from|return|print|for|while|if|elif|else|function|const|let|var|int|float|double|char|bool|void|struct|enum|public|private|static|include|using|namespace|package|echo|printf|scanf|cout|cin|std|true|false|null|None|True|False|self|async|await|lambda|yield)\b|[{}]|\)\s*[:;{]|#include|\/\/|<!--|;\s*$/;
// 页码:纯数字 / 罗马数字 / 「第 N 页(共 M 页)」 / 「N / M」 / 「Page N of M」。
// 先去掉空格与各种标点再判,免得漏掉「第 1 页，共 12 页」这种全角标点。
const PAGE_NUMBER_BARE_RE = /^(?:第\d+页(?:共\d+页)?|\d{1,4}|\d{1,4}\/\d{1,4}|[ivxlcdm]{1,7}|page\d+(?:of\/?\d+)?|\d+of\d+|-?\d{1,4}-?)$/i;
const PAGE_NUMBER_STRIP_RE = /[\s，,。.、·:：;；\-–—/|()（）'【】[\]{}]+/g;
const SENTENCE_END_RE = /[.!?;:。！？；：]["'”’)\]]?$/;
const CJK_EDGE_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]$/;
const CJK_START_RE = /^[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

// 中文行拼接不加空格(英文行按单词间隔加空格)。
export function joinTextLines(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((acc, line) => {
    const value = String(line ?? "");
    if (!acc) return value;
    if (!value) return acc;
    return CJK_EDGE_RE.test(acc) && CJK_START_RE.test(value) ? `${acc}${value}` : `${acc} ${value}`;
  }, "");
}

export function isMonospaceFont(font) {
  return MONO_RE.test(String(font || ""));
}

// 一行里等宽字符的占比:整行都是等宽才算代码。
// 很多排版把数字 / 拉丁字母排成 Consolas、中文排成宋体(试卷、公文常见),
// 只看「主导字体」会把这类正文误判成代码。
export function monospaceShare(line) {
  const fonts = line?.fonts && typeof line.fonts === "object" ? line.fonts : null;
  if (fonts) {
    let mono = 0;
    let total = 0;
    for (const [name, count] of Object.entries(fonts)) {
      const weight = Number(count) || 0;
      total += weight;
      if (isMonospaceFont(name)) mono += weight;
    }
    return total ? mono / total : 0;
  }
  return isMonospaceFont(line?.font) ? 1 : 0;
}

export function looksLikePageNumber(text) {
  const key = String(text || "").trim();
  if (!key || key.length > 24) return false;
  return PAGE_NUMBER_BARE_RE.test(key.replace(PAGE_NUMBER_STRIP_RE, ""));
}

// 是否在页面的上下边缘(页眉 / 页脚区):默认上下各 8%。
export function inMargin(line, page, { ratio = 0.08 } = {}) {
  const height = Number(page?.height) || 0;
  if (!height) return false;
  const y0 = Number(line?.y0);
  const y1 = Number(line?.y1);
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return false;
  return y0 < height * ratio || y1 > height * (1 - ratio);
}

// 页眉 / 页脚 / 页码 / 水印的判定:旋转文字、**整行是低不透明度文字**(水印)、
// **在上下边缘且样式像页码**的行、**在上下边缘且跨页重复 ≥ max(2, 页数×30%)** 的行。
// 正文里重复出现的代码行、正文里的独立数字行(题号)都不会误删。
export function furnitureMatcher(pages, { ratio = 0.3 } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const threshold = Math.max(2, Math.ceil(list.length * ratio));
  const faint = new Set();
  for (const page of list) {
    for (const text of page?.faint || []) {
      const value = String(text || "").trim().replace(/\s+/g, " ");
      if (value) faint.add(value);
    }
  }
  const counts = new Map();
  for (const page of list) {
    const seen = new Set();
    for (const line of page?.lines || []) {
      const key = String(line.text || "").trim().replace(/\s+/g, " ");
      if (key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const isFurniture = (line, page) => {
    if (line.rotated) return true;
    const key = String(line.text || "").trim().replace(/\s+/g, " ");
    if (!key) return true;
    if (faint.has(key)) return true;
    const margin = !Number(page?.height) || inMargin(line, page);
    if (margin && looksLikePageNumber(key)) return true;
    return (counts.get(key) || 0) >= threshold && inMargin(line, page);
  };
  return { isFurniture, threshold };
}

export function dropFurniture(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const { isFurniture } = furnitureMatcher(list, options);
  return list.map((page) => ({
    ...page,
    lines: (page?.lines || []).filter((line) => !isFurniture(line, page)),
  }));
}

// 家具行的矩形:{ page: 1 基, rect: [x0, y0, x1, y1] }(用于在 PDF 上擦除)。
export function furnitureRects(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const { isFurniture } = furnitureMatcher(list, options);
  const out = [];
  list.forEach((page, index) => {
    for (const line of page?.lines || []) {
      if (!isFurniture(line, page)) continue;
      const x0 = Number(line.x0);
      const x1 = Number(line.x1);
      const y0 = Number(line.y0);
      const y1 = Number(line.y1);
      if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
      out.push({ page: index + 1, rect: [x0, y0, x1, y1] });
    }
  });
  return out;
}

// 行 → 块:等宽 = 代码(跨页也连成一块),字号大的短行 = 标题,其余按空行间距分段。
export function buildBlocks(pages) {
  const list = dropFurniture(pages);
  const all = list.flatMap((page) => (page.lines || []).map((line) => line));
  if (!all.length) return [];
  // 正文字号:按字符数取出现最多的字号
  const sizeWeight = new Map();
  for (const line of all) {
    const weight = String(line.text || "").trim().length;
    sizeWeight.set(line.size, (sizeWeight.get(line.size) || 0) + weight);
  }
  const bodySize = [...sizeWeight].sort((left, right) => right[1] - left[1])[0]?.[0] || 10;

  const blocks = [];
  // 逐行判定:整行等宽 **且**(有代码特征 或上下紧邻也是等宽行)才算代码。
  // 试卷/公文常把数字与拉丁字母排成 Consolas,单独一行不构成代码。
  const flat = [];
  for (const [pageIndex, page] of list.entries()) {
    for (const line of page.lines || []) {
      flat.push({ line, page: pageIndex + 1, size: Number(line.size) || 10, mono: monospaceShare(line) >= 0.85 });
    }
  }
  const tightGap = (left, right) => Math.abs(Number(right.line.y0) - Number(left.line.y1)) <= 0.7 * Math.max(left.size, right.size);
  for (let index = 0; index < flat.length; index += 1) {
    const entry = flat[index];
    const before = flat[index - 1];
    const after = flat[index + 1];
    const neighbor = (before && before.mono && tightGap(before, entry)) || (after && after.mono && tightGap(entry, after));
    entry.code = entry.mono && (CODE_TOKEN_RE.test(String(entry.line.text || "")) || Boolean(neighbor));
  }

  let current = null;
  let lastLine = null;
  const push = () => {
    if (!current) return;
    const text = (current.kind === "code" ? current.lines.join("\n") : joinTextLines(current.lines)).trim();
    if (text) blocks.push({ kind: current.kind, size: current.size, text, page: current.page, lines: current.lines.slice() });
    current = null;
  };

  for (let index = 0; index < flat.length; index += 1) {
    const entry = flat[index];
    const line = entry.line;
    const text = String(line.text || "");
    if (!text.trim()) continue;
    const kind = entry.code ? "code" : "text";
    const size = entry.size;
    const gap = lastLine ? Number(line.y0) - Number(lastLine.y1) : 0;
    const newPage = Boolean(lastLine) && lastLine.page !== entry.page;
    if (current) {
      const sizeJump = Math.abs(size - current.size) > 0.6;
      const kindChange = current.kind !== kind;
      const bigGap = gap > 0.7 * Math.max(size, current.size);
      // 跨页:代码块直接续上(页眉页脚已去掉);正文在上一行没断句时续上。
      const pageContinue = newPage && (
        (kind === "code" && current.kind === "code")
        || (kind === "text" && current.kind === "text" && !SENTENCE_END_RE.test(current.lines[current.lines.length - 1] || ""))
      );
      if (sizeJump || kindChange || bigGap || (newPage && !pageContinue)) push();
    }
    if (!current) current = { kind, size, lines: [], page: entry.page };
    // 断词:「de-」+「signed」合并;代码保持换行与缩进
    const previous = current.lines[current.lines.length - 1];
    if (current.kind === "text" && previous && /[\p{L}]-$/u.test(previous) && /^[\p{Ll}\p{Lo}]/u.test(text.trim())) {
      current.lines[current.lines.length - 1] = `${previous.slice(0, -1)}${text.trim()}`;
    } else {
      current.lines.push(text);
    }
    lastLine = { ...line, page: entry.page };
  }
  push();

  // 标题:单行、字号明显大于正文、不长、不以句末标点结尾
  return blocks
    .map((block) => {
      const base = { size: block.size, text: block.text, page: block.page };
      if (block.kind === "code") return { ...base, type: "code" };
      const single = block.lines.length === 1;
      const heading = single
        && block.size >= bodySize * 1.12
        && block.text.length <= 80
        && !SENTENCE_END_RE.test(block.text.trim());
      if (!heading) return { ...base, type: "text" };
      const level = block.size >= bodySize * 1.6 ? 1 : block.size >= bodySize * 1.3 ? 2 : 3;
      return { ...base, type: "heading", level };
    })
    .filter((block) => block.text.trim());
}

// 结构化页 → Doc v1(和其它链路同构,后续 .md / .html / 合并都能直接复用)。
export function buildTextDoc(pages, { source = "", title = "" } = {}) {
  const blocks = buildBlocks(pages);
  const pagesOut = new Map();
  for (const [index, block] of blocks.entries()) {
    const page = block.page || 1;
    if (!pagesOut.has(page)) pagesOut.set(page, []);
    pagesOut.get(page).push({
      id: `t${page}-b${pagesOut.get(page).length + 1}`,
      page,
      type: block.type,
      ...(block.level ? { level: block.level } : {}),
      ...(block.type === "code" ? { content: block.text } : { text: block.text }),
      index,
    });
  }
  return {
    schema_version: 1,
    source: { path: source, title, engine: "fitz-text" },
    pages: [...pagesOut].sort(([left], [right]) => left - right).map(([page, list]) => ({ page, blocks: list })),
  };
}

export function createPdfTextReader({ spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  async function read(pdfPath, { python = "python", workDir = "", signal } = {}) {
    const source = String(pdfPath || "");
    if (!source || !fs.existsSync(source)) return { ok: false, error: `找不到 PDF：${source}` };
    const base = String(workDir || path.dirname(source) || ".");
    try {
      fs.mkdirSync(base, { recursive: true });
      const outFile = path.join(base, "pdf-text.json");
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(python, ["-c", PDF_TEXT_SCRIPT, source, outFile], { stdio: ["ignore", "pipe", "pipe"] });
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
          finish({ ok: false, error: "读取 PDF 文本超时" });
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
        child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : (out.trim().slice(-200) || `退出码 ${code}`) }));
      });
      if (!result.ok) return result;
      if (!fs.existsSync(outFile)) return { ok: false, error: "没有生成文本结构文件" };
      const pages = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (!Array.isArray(pages) || !pages.length) return { ok: false, error: "PDF 没有文本页" };
      return { ok: true, pages };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { read };
}

// 在 PDF 上擦掉页眉 / 页脚 / 页码 / 水印,产出「干净副本」供**不经过 pdf_tool 的**消费方使用
// (即格式转换的「本地解析」DocVortex;经过 pdf_tool 的链路由 pdf_tool 侧清理)。
// 文件名保持不变,放在缓存目录;文字 / 图片 / 矢量一起擦,水印是图片也能去掉。
export const PDF_REDACT_SCRIPT = `import fitz, json, sys
job = json.load(open(sys.argv[1], encoding="utf-8"))
doc = fitz.open(job["source"])
rects = {}
for item in job.get("rects", []):
    rects.setdefault(int(item["page"]), []).append(tuple(item["rect"]))
for page_number, boxes in rects.items():
    page = doc[page_number - 1]
    for box in boxes:
        page.add_redact_annot(fitz.Rect(box))
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_PIXELS,
        graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )
doc.save(job["out"], garbage=3, deflate=True)
`;

export function createPdfCleaner({ pdfText = createPdfTextReader(), spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  // 返回 { ok, path, removed }:没有家具时 path 就是原文件;失败由调用方回退原文件。
  async function clean(source, { python = "python", workDir = "", signal } = {}) {
    const original = String(source || "");
    if (!original || !fs.existsSync(original)) return { ok: false, path: original, removed: 0, error: `找不到 PDF：${original}` };
    const read = await pdfText.read(original, { python, workDir, signal });
    if (!read.ok) return { ok: false, path: original, removed: 0, error: read.error };
    const rects = furnitureRects(read.pages);
    if (!rects.length) return { ok: true, path: original, removed: 0 };
    const base = String(workDir || path.dirname(original) || ".");
    try {
      fs.mkdirSync(base, { recursive: true });
      const jobFile = path.join(base, "redact-job.json");
      const outPdf = path.join(base, path.basename(original));
      fs.writeFileSync(jobFile, JSON.stringify({ source: original, out: outPdf, rects }), "utf8");
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(python, ["-c", PDF_REDACT_SCRIPT, jobFile], { stdio: ["ignore", "pipe", "pipe"] });
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
          finish({ ok: false, error: "清理 PDF 超时" });
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => { out += chunk; });
        child.stderr?.on("data", (chunk) => { out += chunk; });
        child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
        child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : (out.trim().slice(-200) || `退出码 ${code}`) }));
      });
      if (!result.ok || !fs.existsSync(outPdf)) {
        return { ok: false, path: original, removed: 0, error: result.error || "没有生成清理后的 PDF" };
      }
      return { ok: true, path: outPdf, removed: rects.length };
    } catch (error) {
      return { ok: false, path: original, removed: 0, error: String(error?.message || error) };
    }
  }

  return { clean };
}

// 给**不经过 pdf_tool 的**外部消费方(DocVortex 本地解析)喂 PDF 前,先去页眉页脚 / 页码 / 水印:
// 成功返回干净副本;没有家具或清理失败则返回原文件(绝不阻断)。
export async function cleanedPdfFor(source, { cleaner = null, settings = {}, cacheRoot = "", signal, log = () => {} } = {}) {
  const original = String(source || "");
  if (!cleaner || !/\.pdf$/i.test(original)) return original;
  const stem = path.basename(original).replace(/\.[^.]+$/, "");
  const workDir = path.join(String(cacheRoot || os.tmpdir()), "cleaned", `${stem}-${Date.now().toString(36)}`);
  const python = String(settings.ocrPython || settings.docvortexPython || "").trim() || "python";
  const result = await cleaner.clean(original, { python, workDir, signal });
  if (!result.ok) {
    log("pdf clean skipped", result.error);
    return original;
  }
  if (result.removed) log("pdf clean", stem, `${result.removed} 处家具 →`, result.path);
  return result.path;
}

// 写 §7 产物:<源名>.md / .html / .json / .audit.json(同名加序号)。
export function writeTextProducts(doc, { outDir, stem }) {
  const files = {};
  const target = (ext) => uniqueFile(path.join(outDir, `${stem}${ext}`));
  const markdown = blocksToMarkdown(doc.pages.flatMap((page) => page.blocks));
  files.md = target(".md");
  fs.writeFileSync(files.md, markdown, "utf8");
  files.html = target(".html");
  fs.writeFileSync(files.html, blocksToHtml(doc.pages.flatMap((page) => page.blocks), { title: stem }), "utf8");
  files.json = target(".json");
  fs.writeFileSync(files.json, JSON.stringify(doc, null, 2), "utf8");
  const blocks = doc.pages.flatMap((page) => page.blocks);
  files.audit = target(".audit.json");
  fs.writeFileSync(files.audit, JSON.stringify({
    ok: true,
    engine: "fitz-text",
    pages: doc.pages.length,
    blocks: blocks.length,
    headings: blocks.filter((block) => block.type === "heading").length,
    code: blocks.filter((block) => block.type === "code").length,
    text: blocks.filter((block) => block.type === "text").length,
    chars: blocks.reduce((sum, block) => sum + String(block.text || block.content || "").length, 0),
  }, null, 2), "utf8");
  return files;
}

// 格式转换的「文本型」链路:本地确定性提取 → 桥接 HTML → DocVortex 转目标格式。
// 与「公式优先」同构,只是解析结果来自 fitz(不需要 MinerU、不把文字裁成图片)。
export function registerTextConvertRunner(workshop, { docvortex, vaultRoot = "", cacheRoot = "", pdfText = createPdfTextReader(), log = (...args) => console.log(...args) } = {}) {
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };

  workshop.register("text-convert", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const format = String(payload?.format || "markdown");
    const out = uniqueFile(payload?.out
      ? absolute(payload.out)
      : absolute(convertPath(payload?.source, docvortexFormatExt(format))));
    const stem = path.basename(source).replace(/\.[^.]+$/, "");
    const python = String(settings.docvortexPython || settings.ocrPython || "").trim() || "python";
    const workDir = path.join(cacheRoot || process.env.TEMP || process.env.TMP || "/tmp", "pdf-text", `${stem}-${Date.now().toString(36)}`);

    report({ label: "本地取文本" });
    const read = await pdfText.read(source, { python, workDir, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!read.ok) throw new Error(`本地取文本失败：${read.error}`);
    const doc = buildTextDoc(read.pages, { source, title: stem });
    if (!doc.pages.length) throw new Error("这份 PDF 没有可提取的文本(扫描件请用「公式优先」或内容提取的「扫描视觉」)");

    report({ label: "DocVortex 转换" });
    fs.mkdirSync(workDir, { recursive: true });
    const htmlPath = path.join(workDir, "bridge.html");
    const blocks = doc.pages.flatMap((page) => page.blocks);
    fs.writeFileSync(htmlPath, blocksToHtml(blocks, { title: stem, tableMode: tableModeFor(format) }), "utf8");
    log("text convert", source, "→", out);
    const result = await docvortex.convert(settings, { source: htmlPath, format, out, signal });
    if (signal.aborted) throw new Error("任务已取消");
    if (!result.ok) throw new Error(String(result.error || "转换失败"));
    return { output: out, detail: `${format} · ${path.basename(out)}` };
  });

  return { writeTextProducts };
}

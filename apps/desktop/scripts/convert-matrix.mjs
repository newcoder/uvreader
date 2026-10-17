// 转换矩阵回归:把「格式转换 / 内容提取 / 电子书」的所有路径拉出来跑一遍。
//
//   npm run desktop:matrix              # 全跑(DocVortex / pdf_tool / Calibre 缺谁就 SKIP 谁)
//   QBR_MATRIX_MINERU=1 npm run desktop:matrix   # 追加内容提取的 MinerU 路径(需本地服务或 token)
//
// 每个组合都校验产物「非空 + 含源标记」,光有文件不算通过;失败以退出码 1 结束。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { createCalibre } from "../src/main/calibre.js";
import { createDocvortex, registerDocvortexRunners } from "../src/main/docvortex.js";
import { registerExtractRunners } from "../src/main/extract-doc.js";
import { createPdfTextReader, registerTextConvertRunner } from "../src/main/pdf-text.js";
import { createWorkshopQueue } from "../src/main/workshop.js";
import { registerBookRunners } from "../src/main/workshop-book.js";
import { DOCVORTEX_FORMATS } from "../src/shared/workshop-formats.js";

const PDF_FIXTURE = process.env.QBR_MATRIX_PDF || "D:/projects/auto_chat/pdf_tool/test-docs/CSP2021.pdf";
const PDF_MARKER = process.env.QBR_MATRIX_PDF_MARKER || "阅读程序";
const MARKER = "矩阵回归标记";
const ONLY = new Set((process.env.QBR_MATRIX_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-matrix-"));
const vaultRoot = path.join(work, "vault");
const cacheRoot = path.join(work, "cache");
const srcDir = path.join(vaultRoot, "src");
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(cacheRoot, { recursive: true });
// 样张拷进临时目录:提取产物是「就地产出」,不能写进 pdf_tool 的仓库目录。
const PDF_LOCAL = path.join(srcDir, "样张.pdf");
if (fs.existsSync(PDF_FIXTURE)) fs.copyFileSync(PDF_FIXTURE, PDF_LOCAL);

const results = [];
function record(kind, name, status, detail, ms) {
  results.push({ kind, name, status, detail, ms });
  const icon = status === "PASS" ? "PASS" : status === "SKIP" ? "SKIP" : "FAIL";
  console.log(`${icon.padEnd(4)} [${kind}] ${name} — ${detail}${ms ? ` (${ms}ms)` : ""}`);
}

// ---------------------------------------------------------------- 夹具
async function writeDocx(file) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>${MARKER}:这是一段用于转换矩阵的正文。</w:t></w:r></w:p>
  <w:p><w:r><w:t>第二段带公式 $E = mc^2$ 与代码 int main()。</w:t></w:r></w:p>
</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

function writeHtml(file, ext = "html") {
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><title>矩阵</title></head>
<body><h1>${MARKER}</h1><p>这是一个 HTML 源文件。</p><table><tr><th>列</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table></body></html>`);
  void ext;
}

function writeCsv(file, delimiter = ",") {
  fs.writeFileSync(file, `名称${delimiter}数量\n${MARKER}${delimiter}2\n乙${delimiter}3\n`);
}

// Markdown / 纯文本源:DocVortex 自己没有这两种原生输入,书坊先渲染成 HTML 桥
// (见 main/docvortex.js):标题 + 「1. 标题 + 紧跟正文」的列表后接段落 + 行内公式。
// 标记特意**只放在段落里**(标题不放):这样产物里还能找到标记,就说明列表后面的
// 段落没被 DocVortex 丢掉(<p> 落在 <ol> 里时它整段丢)。
function writeMarkdown(file) {
  fs.writeFileSync(file, `# 矩阵 Markdown 源

1. 列表后接正文:
${MARKER} 段落必须活下来。

行内公式 $E = mc^2$ 与第二段。

| 列 | 值 |
| --- | --- |
| a | 1 |
`, "utf8");
}

function writeText(file) {
  fs.writeFileSync(file, `${MARKER}:纯文本源文件。

第二段。
`, "utf8");
}

function rtfEscape(text) {
  return [...String(text)].map((ch) => (ch.codePointAt(0) < 128 ? ch : `\\u${ch.codePointAt(0)}?`)).join("");
}

function writeRtf(file) {
  // 手写兜底:非 ASCII 用 RTF 的 \uN? 转义(直接写 UTF-8 会被声明成 GBK 的 RTF 读成乱码)。
  fs.writeFileSync(file, `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil SimSun;}}\\f0\\fs24 ${rtfEscape(`${MARKER}:RTF 源文件。`)} \\par ${rtfEscape("第二段。")}}`);
}

async function writeOdt(file) {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file("META-INF/manifest.xml", `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
  zip.file("content.xml", `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:body><office:text><text:p>${MARKER}:ODT 源文件。</text:p><text:p>第二段。</text:p></office:text></office:body>
</office:document-content>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

function writeMhtml(file) {
  const html = `<html><body><h1>${MARKER}</h1><p>MHTML 源文件。</p></body></html>`;
  fs.writeFileSync(file, [
    "From: <Saved by UV Reader>",
    "Subject: matrix",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related; boundary=\"----BOUNDARY\"",
    "",
    "------BOUNDARY",
    "Content-Type: text/html; charset=\"utf-8\"",
    "Content-Transfer-Encoding: 8bit",
    "Content-Location: file:///matrix.htm",
    "",
    html,
    "------BOUNDARY--",
    "",
  ].join("\r\n"));
}

async function writeEpub(file) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>矩阵</dc:title><dc:identifier id="id">matrix-1</dc:identifier><dc:language>zh</dc:language></metadata>
  <manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`);
  zip.file("OEBPS/chapter1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body><h1>${MARKER}</h1><p>EPUB 源文件。</p></body></html>`);
  zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>矩阵</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>1</text></navLabel><content src="chapter1.xhtml"/></navPoint></navMap></ncx>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ---------------------------------------------------------------- 队列与 runner
const queue = createWorkshopQueue({ file: path.join(work, "tasks.json"), onState: () => {}, log: { warn() {} } });
const docvortex = createDocvortex();
const calibre = createCalibre();
registerDocvortexRunners(queue, { docvortex, vaultRoot });
registerBookRunners(queue, { calibre, vaultRoot });
registerExtractRunners(queue, { docvortex, vaultRoot, cacheRoot });
registerTextConvertRunner(queue, { docvortex, vaultRoot, cacheRoot });

function runTask(request, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const id = queue.start(request);
    const started = Date.now();
    const timer = setInterval(() => {
      const task = queue.snapshot().tasks.find((row) => row.id === id);
      if (task && ["done", "failed", "cancelled"].includes(task.status)) {
        clearInterval(timer);
        resolve(task);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve({ status: "timeout", error: `超过 ${timeoutMs}ms` });
      }
    }, 200);
  });
}

// 产物校验:文件存在、非空、并且(能拿到文本时)含源标记。
async function checkProduct(file, marker, { kind = "text" } = {}) {
  if (!fs.existsSync(file)) return `没有产物:${file}`;
  const size = fs.statSync(file).size;
  // 小源文件本来就产出小(49B 的 md 里内容是对的);只挡住空文件,内容靠标记校验。
  if (size < 16) return `产物太小(${size}B)`;
  try {
    if (kind === "text") {
      const text = fs.readFileSync(file, "utf8");
      return text.includes(marker) ? "" : `产物里没有源标记「${marker}」`;
    }
    if (kind === "docx") {
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      const xml = await zip.file("word/document.xml")?.async("string");
      return String(xml || "").includes(marker) ? "" : "docx 正文里没有源标记";
    }
    if (kind === "epub") {
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      let found = false;
      for (const name of Object.keys(zip.files)) {
        if (!/\.(x?html|opf|ncx|txt)$/i.test(name)) continue;
        const text = await zip.file(name)?.async("string");
        if (String(text || "").includes(marker)) { found = true; break; }
      }
      return found ? "" : "epub 里没有源标记";
    }
    if (kind === "binary") {
      return size >= 1024 ? "" : `产物太小(${size}B)`;
    }
    if (kind === "file") return "";
    if (kind === "pdf") {
      const read = await createPdfTextReader().read(file, { python: process.env.QBR_OCR_PYTHON || "python" });
      if (!read.ok) return `PDF 读不出文字:${read.error}`;
      const text = read.pages.flatMap((page) => page.lines.map((line) => line.text)).join("\n");
      return text.includes(marker) ? "" : "PDF 文字层里没有源标记";
    }
  } catch (error) {
    return `校验失败:${String(error?.message || error)}`;
  }
  return "";
}

async function convert(runner, label, payload, expects = {}) {
  const started = Date.now();
  const task = await runTask({ kind: runner, title: label, payload });
  const ms = Date.now() - started;
  if (task.status !== "done") {
    record(runner, label, "FAIL", String(task.error || task.status).slice(0, 160), ms);
    return false;
  }
  const problem = await checkProduct(task.output, expects.marker || MARKER, { kind: expects.kind || "text" });
  if (problem) {
    record(runner, label, "FAIL", problem.slice(0, 160), ms);
    return false;
  }
  const size = fs.existsSync(task.output) ? `${Math.round(fs.statSync(task.output).size / 1024)}KB` : "?";
  record(runner, label, "PASS", `${path.basename(task.output)} ${size}`, ms);
  return true;
}

// 产物扩展名里不能用 > : 等 Windows 非法字符(用了 DocVortex 直接 WinError 123)。
const outName = (source, format, ext) => `${source}_to_${format}.${ext}`;

// ---------------------------------------------------------------- ① DocVortex 互转矩阵
async function docvortexMatrix() {
  const probe = await docvortex.probe({});
  if (!probe.ok) {
    record("docvortex", "互转矩阵", "SKIP", `DocVortex 不可用:${String(probe.detail || "").slice(0, 80)}`);
    return;
  }
  const sources = [
    ["docx", path.join(srcDir, "矩阵.docx"), "docx"],
    ["rtf", path.join(srcDir, "矩阵.rtf"), "text"],
    ["odt", path.join(srcDir, "矩阵.odt"), "text"],
    ["html", path.join(srcDir, "矩阵.html"), "text"],
    ["htm", path.join(srcDir, "矩阵.htm"), "text"],
    ["mhtml", path.join(srcDir, "矩阵.mht"), "text"],
    ["csv", path.join(srcDir, "矩阵.csv"), "text"],
    ["tsv", path.join(srcDir, "矩阵.tsv"), "text"],
    ["md", path.join(srcDir, "矩阵.md"), "text"],
    ["txt", path.join(srcDir, "矩阵.txt"), "text"],
    ["epub", path.join(srcDir, "矩阵.epub"), "text"],
    ["pdf", PDF_LOCAL, "text"],
  ];
  const markers = { "pdf": PDF_MARKER };
  for (const [name, file] of sources) {
    const marker = markers[name] || MARKER;
    for (const format of DOCVORTEX_FORMATS) {
      if (ONLY.size && !ONLY.has(`dv:${name}->${format.id}`)) continue;
      const out = path.join(srcDir, "out", outName(name, format.id, format.ext));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await convert("docvortex-convert", `${name} → ${format.id}`, {
        source: file,
        format: format.id,
        out,
        settings: {},
      }, { marker, kind: format.id === "docx" ? "docx" : format.id === "pdf" ? "pdf" : "text" });
    }
  }
}

// ---------------------------------------------------------------- ② 文本型 PDF × 5 目标
// (「本地解析」的 PDF 路径已由上面 DocVortex 矩阵里的 pdf 源覆盖)
async function pdfModes() {
  if (!fs.existsSync(PDF_LOCAL)) {
    record("pdf", "文本型矩阵", "SKIP", `缺少 PDF 样张:${PDF_FIXTURE}`);
    return;
  }
  for (const format of DOCVORTEX_FORMATS) {
    if (ONLY.size && !ONLY.has(`pdf-text->${format.id}`)) continue;
    const out = path.join(srcDir, "out2", outName("pdf_text", format.id, format.ext));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await convert("text-convert", `文本型 → ${format.id}`, {
      source: PDF_LOCAL,
      format: format.id,
      out,
      settings: {},
    }, { marker: PDF_MARKER, kind: format.id === "docx" ? "docx" : format.id === "pdf" ? "pdf" : "text" });
  }
}

// ---------------------------------------------------------------- ③ 内容提取
async function extraction() {
  // pdf_tool 的目录:内容提取(MinerU)与 OCR 都需要;没配就按默认 checkout 走。
  const settings = {
    ocrSidecarDir: process.env.QBR_OCR_SIDECAR || "D:/projects/auto_chat",
    ocrPython: process.env.QBR_OCR_PYTHON || "python",
  };
  const docx = path.join(srcDir, "矩阵.docx");
  await convert("extract-docvortex", "docx 提取 → md/json", { source: docx, settings: {} });
  await convert("extract-pdf", "PDF 提取(文本型)", { source: PDF_LOCAL, mode: "text", settings }, { marker: PDF_MARKER });
  if (process.env.QBR_MATRIX_MINERU === "1") {
    await convert("extract-pdf", "PDF 提取(MinerU)", { source: PDF_LOCAL, mode: "mineru", settings }, { marker: PDF_MARKER });
  } else {
    record("extract-pdf", "PDF 提取(MinerU)", "SKIP", "设 QBR_MATRIX_MINERU=1 才跑(需要本地服务或云端 token)");
  }
  const images = [1, 2, 10].map((index) => {
    const file = path.join(srcDir, `page-${index}.png`);
    fs.writeFileSync(file, PNG_1PX);
    return file;
  });
  // 图片 → PDF(格式转换的「图片 → PDF」预设):每张一页。
  const pack = path.join(srcDir, "out3", "pages.pdf");
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  const packStarted = Date.now();
  const packTask = await runTask({ kind: "images-pdf", title: "images → pdf", payload: { images, out: pack } });
  if (packTask.status !== "done") {
    record("images-pdf", "图片 → PDF", "FAIL", String(packTask.error || packTask.status).slice(0, 120), Date.now() - packStarted);
  } else {
    const problem = await checkProduct(packTask.output, "", { kind: "file" });
    record("images-pdf", "图片 → PDF", problem ? "FAIL" : "PASS", problem || `${Math.round(fs.statSync(packTask.output).size / 1024)}KB`, Date.now() - packStarted);
  }
  const cbz = path.join(srcDir, "out3", "pages.cbz");
  fs.mkdirSync(path.dirname(cbz), { recursive: true });
  const started = Date.now();
  const task = await runTask({ kind: "images-cbz", title: "images → cbz", payload: { images, out: cbz } });
  if (task.status !== "done") {
    record("images-cbz", "图片 → CBZ", "FAIL", String(task.error || task.status).slice(0, 120), Date.now() - started);
  } else {
    try {
      const zip = await JSZip.loadAsync(fs.readFileSync(task.output));
      const names = Object.keys(zip.files).filter((name) => name.endsWith(".png"));
      record("images-cbz", "图片 → CBZ", zip.files && names.length === 3 ? "PASS" : "FAIL", `${names.length} 张 png`, Date.now() - started);
    } catch (error) {
      record("images-cbz", "图片 → CBZ", "FAIL", String(error?.message || error).slice(0, 120), Date.now() - started);
    }
  }
}

// ---------------------------------------------------------------- ④ 电子书互转(Calibre)
async function ebookMatrix() {
  const probe = await calibre.probe({});
  if (!probe.ok) {
    record("calibre", "电子书互转", "SKIP", `Calibre 不可用:${String(probe.detail || "").slice(0, 80)}`);
    return;
  }
  record("calibre", "Calibre 检测", "PASS", String(probe.detail || "ok").slice(0, 60));
  const epub = path.join(srcDir, "矩阵.epub");
  for (const format of ["azw3", "mobi", "epub"]) {
    if (ONLY.size && !ONLY.has(`calibre->${format}`)) continue;
    const out = path.join(srcDir, "out4", outName("epub", format, format));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await convert("ebook-convert", `epub → ${format}`, { source: epub, format, out, settings: {} }, { kind: format === "epub" ? "epub" : "binary" });
  }
}

// ---------------------------------------------------------------- 主流程
console.log(`矩阵工作目录:${work}`);
console.log(`PDF 样张:${PDF_FIXTURE}(标记「${PDF_MARKER}」)\n`);

await writeDocx(path.join(srcDir, "矩阵.docx"));
writeHtml(path.join(srcDir, "矩阵.html"));
writeHtml(path.join(srcDir, "矩阵.htm"), "htm");
writeRtf(path.join(srcDir, "矩阵.rtf"));
await writeOdt(path.join(srcDir, "矩阵.odt"));
writeMhtml(path.join(srcDir, "矩阵.mht"));
writeCsv(path.join(srcDir, "矩阵.csv"), ",");
writeCsv(path.join(srcDir, "矩阵.tsv"), "\t");
writeMarkdown(path.join(srcDir, "矩阵.md"));
writeText(path.join(srcDir, "矩阵.txt"));
await writeEpub(path.join(srcDir, "矩阵.epub"));

// RTF / ODT 交给 Calibre 从 EPUB 生成(编码正规;手写的那两份当兜底)。
// 极简 ODT 会让部分读取器只拿到几十字节,生成版才有代表性。
const calibreProbe = await calibre.probe({});
if (calibreProbe.ok) {
  for (const format of ["rtf", "odt"]) {
    const target = path.join(srcDir, `矩阵.${format}`);
    fs.rmSync(target, { force: true });
    const task = await runTask({ kind: "ebook-convert", title: "fixture", payload: { source: path.join(srcDir, "矩阵.epub"), format, out: target, settings: {} } });
    console.log(`夹具:epub → ${format} ${task.status === "done" ? `ok ${Math.round(fs.statSync(target).size / 1024)}KB` : `失败(${String(task.error || task.status).slice(0, 80)})`}`);
  }
} else {
  console.log(`夹具:Calibre 不可用,RTF/ODT 用手写兜底(${String(calibreProbe.detail || "").slice(0, 60)})`);
}

await docvortexMatrix();
await pdfModes();
await extraction();
await ebookMatrix();

const passed = results.filter((row) => row.status === "PASS").length;
const failed = results.filter((row) => row.status === "FAIL");
const skipped = results.filter((row) => row.status === "SKIP");
console.log(`\n=== 矩阵结果:通过 ${passed} · 失败 ${failed.length} · 跳过 ${skipped.length}(共 ${results.length})`);
if (failed.length) {
  for (const row of failed) console.log(`  ✗ [${row.kind}] ${row.name} — ${row.detail}`);
}
if (skipped.length) {
  for (const row of skipped) console.log(`  ∅ [${row.kind}] ${row.name} — ${row.detail}`);
}
console.log(`产物在 ${path.join(srcDir, "out")} / out2 / out3 / out4`);
process.exit(failed.length ? 1 : 0);

// 答题页原型:把转换出的 Markdown 原样渲染,只在题号/选项/（）/空位处注入控件。
//
// 用法:node scripts/quiz-paper-preview.mjs <paper.md> <out.html>
// 说明:这是给设计评审看的独立 HTML(判题按钮只统计作答数);应用内由同一套
// 规则 + 渲染器生成 DOM,提交后走 AI 判题。
import fs from "node:fs";
import path from "node:path";

const [mdPath, outPath] = process.argv.slice(2);
if (!mdPath || !outPath) {
  console.error("用法:node scripts/quiz-paper-preview.mjs <paper.md> <out.html>");
  process.exit(1);
}

const md = fs.readFileSync(mdPath, "utf8").replace(/\r\n?/g, "\n");
const lines = md.split("\n");

// C/C++/Java/JS/C# 的格式化交给 clang-format(WASM,离线可用);
// 装不上或格式化失败时退回下面的轻量缩进。
let clangFormat = null;
try {
  ({ format: clangFormat } = await import("@wasm-fmt/clang-format"));
} catch {
  clangFormat = null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 轻量 C++ 着色:注释、字符串、关键字;不引第三方库,离线也能用。
// 跨页拼接的代码常常一半有缩进、一半从行首开始:clang-format 不可用时的兜底。
function formatCode(code) {
  const lines = String(code || "").split("\n");
  const control = /^(?:for|while|if|else(?:\s+if)?|switch)\b/;
  const out = [];
  let level = 0;
  let pendingBody = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { out.push(""); continue; }
    if (trimmed.startsWith("#")) { out.push(trimmed); continue; }
    if (trimmed.startsWith("}")) level = Math.max(0, level - 1);
    const indent = level + (pendingBody ? 1 : 0);
    out.push(`${"    ".repeat(indent)}${trimmed}`);
    pendingBody = false;
    if (trimmed.endsWith("{")) {
      level += 1;
      continue;
    }
    if (control.test(trimmed) && !trimmed.endsWith(";")) pendingBody = true;
  }
  return out.join("\n");
}

const LANGUAGE_LABELS = { cpp: "C++", java: "Java", cs: "C#", js: "JavaScript", python: "Python" };
const LANGUAGE_FILES = { cpp: "main.cc", java: "Main.java", cs: "Main.cs", js: "main.js" };

function languageOf(text, fence) {
  const info = String(fence || "").toLowerCase().trim();
  if (["cpp", "c++", "cc", "cxx", "c", "h", "hpp"].includes(info)) return "cpp";
  if (info === "java") return "java";
  if (["cs", "csharp"].includes(info)) return "cs";
  if (["js", "javascript", "ts", "typescript"].includes(info)) return "js";
  if (["py", "python"].includes(info)) return "python";
  if (/#include|using namespace|std::|printf\s*\(|scanf\s*\(|int main\s*\(/.test(text)) return "cpp";
  if (/public\s+(?:final\s+)?class|System\.out\./.test(text)) return "java";
  return "other";
}

function formatBlock(text, fence) {
  const language = languageOf(text, fence);
  if (["cpp", "java", "cs", "js"].includes(language)) {
    if (clangFormat) {
      try {
        return {
          language,
          text: clangFormat(String(text), LANGUAGE_FILES[language], JSON.stringify({
            BasedOnStyle: "LLVM",
            IndentWidth: 4,
            ColumnLimit: 0,
            SortIncludes: false,
          })),
        };
      } catch { /* 落到兜底缩进 */ }
    }
    return { language, text: formatCode(text) };
  }
  return { language, text: String(text) };
}

function highlightCode(code, fence) {
  const formatted = formatBlock(code, fence);
  let html = escapeHtml(formatted.text);
  html = html.replace(/(\/\/[^\n]*)/g, '<span class="tok-com">$1</span>');
  html = html.replace(/(&quot;[^&\n]*?&quot;)/g, '<span class="tok-str">$1</span>');
  html = html.replace(/\b(include|using|namespace|const|int|unsigned|char|void|for|while|if|else|return|scanf|printf|memset|sizeof|main)\b/g, '<span class="tok-key">$1</span>');
  html = html.replace(/([①②③④⑤⑥⑦⑧⑨])/g, '<span class="blank">$1</span>');
  return { html, language: formatted.language };
}

function codeHtml(text, lang = "") {
  const { html, language } = highlightCode(text, lang);
  const label = LANGUAGE_LABELS[language] || "CODE";
  return `<div class="code-wrap"><div class="code-bar"><span>${escapeHtml(label)}</span><span class="code-dots">●●●</span></div><pre>${html}</pre></div>`;
}

function inline(value, baseDir) {
  let text = escapeHtml(value);
  // 图片:相对 md 的路径换成 file://,独立页面才能显示。
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => {
    const absolute = path.resolve(baseDir, decodeURI(src));
    return `<img src="${escapeHtml(`file://${absolute.replace(/\\/g, "/")}`)}" alt="${alt}">`;
  });
  // 公式留给 KaTeX 的 auto-render(离线时至少保留 $...$ 原文)。
  // 公式原样交给 KaTeX:md 里已经是标准 LaTeX(单反斜杠命令 + 双反斜杠换行),
  // 不要再“还原”反斜杠,否则矩阵的行会被压平。
  text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // 只还原 Markdown 的转义(星号/下划线等);不要动反斜杠对 —— LaTeX 的
  // `\\`(矩阵换行)必须原样留给 KaTeX。
  text = text.replace(/\\([*_`{}[\]()#+\-.!])/g, "$1");
  return text;
}

function optionRun(line) {
  const matches = [...line.matchAll(/(^|[\s）)。；;])([A-H])\s*[.、．)）]\s*/g)];
  if (matches.length < 2) return null;
  const labelStart = (match) => match.index + match[1].length;
  const head = line.slice(0, labelStart(matches[0])).trim();
  const options = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? labelStart(matches[index + 1]) : line.length;
    return { label: match[2], text: line.slice(start, end).trim() };
  });
  return { head, options };
}

const QUESTION = /^\s*(\d{1,3})\s*[.、．)）]\s*(.*)$/;

const blocks = [];
const units = [];
let section = "";
let paragraph = [];
let lastUnit = null;

function flushParagraph() {
  if (!paragraph.length) return;
  const text = paragraph.join("\n").trim();
  if (text) blocks.push({ kind: "p", text });
  paragraph = [];
}

function addUnit(number, stem) {
  flushParagraph();
  const unit = { number, stem, options: [], between: [], kind: "text", section, id: `u${units.length + 1}` };
  const run = optionRun(stem);
  if (run) {
    unit.stem = run.head;
    unit.options = run.options;
  }
  units.push(unit);
  lastUnit = unit;
  blocks.push({ kind: "unit", unit });
}

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const trimmed = line.trim();

  if (/^<!--\s*page:\s*\d+\s*-->$/i.test(trimmed)) {
    flushParagraph();
    lastUnit = null;
    blocks.push({ kind: "page", page: Number(trimmed.replace(/\D/g, "")) });
    continue;
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    flushParagraph();
    lastUnit = null;
    if (heading[1].length <= 2) section = heading[2].replace(/[（(].*$/, "").trim() || section;
    blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
    continue;
  }
  if (/^\s*```/.test(line)) {
    flushParagraph();
    const fence = line.trim().slice(3);
    const body = [];
    index += 1;
    while (index < lines.length && !/^\s*```/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    const codeBlock = { kind: "code", lang: fence, text: body.join("\n") };
    if (lastUnit && !lastUnit.options.length && lastUnit.stem.length <= 70) {
      lastUnit.between.push(codeBlock);
    } else {
      lastUnit = null;
      blocks.push(codeBlock);
    }
    continue;
  }
  if (!trimmed) {
    flushParagraph();
    continue;
  }
  const question = QUESTION.exec(line);
  const isOptionLine = /^\s*[A-H]\s*[.、．)）]\s+/.test(line);
  if (question && !isOptionLine) {
    addUnit(question[1], question[2] || "");
    continue;
  }
  if (isOptionLine && lastUnit) {
    const run = optionRun(line);
    if (run && run.options.length > 1) {
      lastUnit.options.push(...run.options);
      continue;
    }
    const single = /^\s*([A-H])\s*[.、．)）]\s*(.*)$/.exec(line);
    if (single) {
      lastUnit.options.push({ label: single[1], text: (single[2] || "").trim() });
      continue;
    }
  }
  if (lastUnit && lastUnit.kind === "true_false" && /^[（(]/.test(trimmed)) {
    paragraph.push(line);
    continue;
  }
  if (lastUnit && !lastUnit.options.length && lastUnit.stem.length <= 70) {
    lastUnit.between.push(line);
    continue;
  }
  paragraph.push(line);
}
flushParagraph();

// 选项行可能分多行(A/B/C/D 各一行),因此题型在全部行读完后统一判定。
for (const unit of units) {
  if (unit.options.length >= 2) unit.kind = "choice";
  else if (unit.between.some((entry) => entry?.kind === "code")) unit.kind = "program";
  else if (/[（(]\s*[）)]\s*$/.test(unit.stem)) unit.kind = "true_false";
  else if (/_{3,}/.test(unit.stem)) unit.kind = "blank";
  else if (/[（(]\s*[）)]/.test(unit.stem) && unit.stem.length < 120) unit.kind = "blank";
  else if (unit.stem.length > 70) unit.kind = "description";
  else unit.kind = "short";
}
const interactive = units.filter((unit) => ["choice", "true_false", "blank", "short"].includes(unit.kind));
interactive.forEach((unit, index) => { unit.card = index + 1; });

// 按小节/程序分组:答题卡显示卷面原题号,同一小节内题号不会重复。
const groups = [];
let currentGroup = null;
for (const unit of units) {
  const isProgram = unit.kind === "program" || unit.kind === "description";
  if (!currentGroup || unit.section !== currentGroup.section || isProgram) {
    const title = isProgram
      ? unit.stem.replace(/^\s*\d{1,3}[.、．)）]\s*/, "").slice(0, 26)
      : (unit.section || "试卷");
    currentGroup = { id: `g${groups.length + 1}`, title, section: unit.section };
    groups.push(currentGroup);
  }
  unit.group = currentGroup.id;
  unit.groupTitle = currentGroup.title;
}
const baseDir = path.dirname(path.resolve(mdPath));

function renderUnit(unit) {
  const number = unit.card;
  const head = `<div class="q-head"><span class="q-no" title="卷面第 ${escapeHtml(unit.number)} 题">${escapeHtml(unit.number)}</span><span class="q-type">${
    unit.kind === "choice" ? "选择题" : unit.kind === "true_false" ? "判断题" : unit.kind === "blank" ? "填空题" : "简答题"
  }</span><span class="q-mark" data-mark></span></div>`;
  let body = `<div class="q-stem">${inline(unit.stem, baseDir)}</div>`;
  for (const entry of unit.between || []) {
    if (typeof entry === "string") {
      body += `<div class="q-note">${inline(entry, baseDir)}</div>`;
    } else if (entry?.kind === "code") {
      body += codeHtml(entry.text, entry.lang);
    }
  }
  if (unit.kind === "choice") {
    body += `<div class="opts">${unit.options.map((option) => `
      <button type="button" class="opt" data-unit="${number}" data-value="${option.label}">
        <span class="opt-key">${option.label}</span><span class="opt-text">${inline(option.text, baseDir)}</span>
      </button>`).join("")}</div>`;
  } else if (unit.kind === "true_false") {
    body += `<div class="opts is-tf">
      <button type="button" class="opt" data-unit="${number}" data-value="T"><span class="opt-key">对</span></button>
      <button type="button" class="opt" data-unit="${number}" data-value="F"><span class="opt-key">错</span></button>
    </div>`;
  } else if (unit.kind === "blank") {
    body = `<div class="q-stem">${inline(unit.stem, baseDir).replace(/_{3,}|（\s*）|\(\s*\)/g, '<input class="blank-input" data-unit="' + number + '">')}</div>`;
  } else if (unit.kind === "short") {
    body += `<textarea class="short-input" data-unit="${number}" rows="3" placeholder="在这里作答"></textarea>`;
  }
  return `<section class="q-card" data-q="${number}" id="q${number}">${head}${body}</section>`;
}

let html = "";
let openCard = false;
let lastPage = 0;
for (const block of blocks) {
  if (block.kind === "heading") {
    if (openCard) { html += "</div>"; openCard = false; }
    html += block.level <= 3
      ? `<h${block.level} class="section-title">${inline(block.text, baseDir)}</h${block.level}>`
      : `<div class="sub-title">${inline(block.text, baseDir)}</div>`;
    continue;
  }
  if (block.kind === "unit") {
    if (block.unit.kind === "description" || block.unit.kind === "program") {
      if (openCard) { html += "</div>"; openCard = false; }
      html += `<p class="program-title">${inline(block.unit.stem, baseDir)}</p>`;
      for (const entry of block.unit.between || []) {
        if (typeof entry === "string") {
          html += `<p class="prose">${inline(entry, baseDir)}</p>`;
        } else if (entry?.kind === "code") {
          html += codeHtml(entry.text, entry.lang);
        }
      }
      continue;
    }
    if (!openCard) { html += '<div class="q-zone">'; openCard = true; }
    html += renderUnit(block.unit);
    continue;
  }
  if (block.kind === "code") {
    if (openCard) { html += "</div>"; openCard = false; }
    html += codeHtml(block.text, block.lang);
    continue;
  }
  if (block.kind === "page") {
    if (openCard) { html += "</div>"; openCard = false; }
    if (block.page !== lastPage) {
      lastPage = block.page;
      html += `<div class="page-sep">第 ${block.page} 页</div>`;
    }
    continue;
  }
  if (openCard) { html += "</div>"; openCard = false; }
  html += `<p class="prose">${inline(block.text, baseDir).replace(/\n/g, "<br>")}</p>`;
}
if (openCard) html += "</div>";

const paperTitle = path.basename(mdPath).replace(/\.[^.]+$/, "").replace(/_doc$/, "");
const cardGroups = [];
for (const unit of interactive) {
  let group = cardGroups.find((entry) => entry.id === unit.group);
  if (!group) {
    group = { id: unit.group, title: unit.groupTitle, units: [] };
    cardGroups.push(group);
  }
  group.units.push(unit);
}
const cards = cardGroups.map((group) => `
  <div class="card-group">${escapeHtml(group.title)}</div>
  <div class="grid">${group.units.map((unit) => `<button type="button" class="grid-btn" data-target="q${unit.card}">${escapeHtml(unit.number)}</button>`).join("")}</div>
`).join("");

const document = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(paperTitle)} · 答题页预览</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
:root{--paper:#f3f4f7;--surface:#fffefc;--surface-2:#f6f7fa;--ink:#262b33;--soft:#5d6573;--faint:#8a92a0;--primary:#2b3a55;--primary-deep:#1e2a40;--primary-soft:#eaeef6;--line:#e2e4ea;--line-strong:#cdd2dc;--accent:#b98a3e;--accent-soft:#f6edd9;--ok:#1e7a4a;--bad:#bf3b2b;--serif:"Noto Serif SC","Songti SC","SimSun",serif;--sans:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.7}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:14px;background:var(--primary-deep);color:#f4efe3;padding:10px 20px}
.topbar .title{font-family:var(--serif);font-weight:700;font-size:15px}
.topbar .sub{font-size:11px;color:#b9c4d2}
.topbar .spacer{flex:1}
.progress-pill{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:99px;padding:4px 12px;font-size:13px;font-variant-numeric:tabular-nums}
.layout{display:flex;gap:20px;max-width:1320px;margin:0 auto;padding:20px 18px 80px;align-items:flex-start}
main{flex:1;min-width:0;max-width:900px}
aside{width:230px;flex:none;position:sticky;top:72px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px}
aside h3{font-size:12px;color:var(--soft);letter-spacing:.06em;margin-bottom:8px}
.side-count{font-family:var(--serif);font-size:22px;color:var(--primary)}
.side-count span{font-size:11px;color:var(--faint);font-family:var(--sans)}
.side-bar{height:6px;background:#e8eaf0;border-radius:99px;overflow:hidden;margin:8px 0 12px}
.side-bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}
.grid + .grid{margin-top:4px}
.card-group{font-size:11px;color:var(--soft);margin:10px 0 5px;display:flex;align-items:center;gap:6px}
.card-group::after{content:"";flex:1;height:1px;background:var(--line)}
.grid-btn{aspect-ratio:1;border:1px solid var(--line-strong);background:var(--surface-2);border-radius:7px;font-size:12px;font-weight:600;color:var(--soft);cursor:pointer}
.grid-btn.done{background:var(--accent-soft);border-color:var(--accent);color:#7a5a1e}
.legend{display:flex;gap:10px;margin-top:12px;font-size:10.5px;color:var(--faint);flex-wrap:wrap}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:-1px;background:var(--accent-soft);border:1px solid var(--accent)}
.section-title{font-family:var(--serif);font-weight:700;font-size:18px;color:var(--primary-deep);margin:24px 4px 8px;display:flex;align-items:baseline;gap:8px}
.section-title.h2{font-size:19px}
.sub-title{font-size:13px;color:var(--soft);margin:14px 4px 4px;font-weight:600}
.prose{font-family:var(--serif);margin:6px 4px 10px;line-height:1.9;text-align:justify;color:#333a45}
.program-title{font-weight:600;color:var(--primary-deep);margin-top:18px}
.q-note{font-family:var(--serif);font-size:14px;line-height:1.8;color:#333a45;margin:6px 0}
.short-input{width:100%;margin-top:10px;border:1px solid var(--line-strong);border-radius:8px;padding:8px 10px;font-family:var(--serif);font-size:14px;background:#fff;color:var(--ink)}
.page-sep{text-align:center;font-size:10px;color:var(--faint);letter-spacing:.12em;margin:14px 0;border-top:1px dashed var(--line);padding-top:6px}
.code-wrap{background:#f7f8fb;border:1px solid var(--line);border-radius:9px;overflow:hidden;margin:10px 0}
.code-bar{display:flex;align-items:center;justify-content:space-between;padding:5px 12px;background:#eef0f5;border-bottom:1px solid var(--line);font-size:10px;color:var(--faint);letter-spacing:.06em;text-transform:uppercase}
.code-dots{letter-spacing:2px;font-size:7px;color:#c2c7d1}
.code-wrap pre{font-family:var(--mono);font-size:12.5px;line-height:1.62;padding:14px 16px;color:#2c3340;white-space:pre;overflow-x:auto}
.code-wrap .blank{display:inline-block;min-width:20px;text-align:center;color:#a1291c;font-weight:700;background:#fdeee9;border:1px dashed #d98a7c;border-radius:4px;padding:0 3px}
.tok-com{color:#7c8798;font-style:italic}
.tok-str{color:#1e7a4a}
.tok-key{color:#2b5b9e;font-weight:600}
.q-zone{display:flex;flex-direction:column;gap:10px;margin:10px 0 16px}
.q-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 18px;scroll-margin-top:84px}
.q-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.q-no{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 7px;border-radius:6px;background:var(--primary);color:#fff;font-weight:700;font-size:12px}
.q-type{font-size:10.5px;color:var(--faint);border:1px solid var(--line);border-radius:99px;padding:0 7px}
.q-mark{margin-left:auto;font-size:12px;color:var(--faint)}
.q-stem{font-family:var(--serif);font-size:15px;line-height:1.95;text-align:justify}
.q-stem img{max-width:100%;border-radius:6px;margin:8px 0}
.opts{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.opts.is-tf{flex-direction:row}
.opts.is-tf .opt{justify-content:center;font-weight:600}
.opt{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--line);border-radius:9px;padding:7px 12px;background:var(--surface-2);font-family:var(--serif);font-size:14.5px;line-height:1.7;text-align:left;cursor:pointer}
.opt:hover{border-color:var(--primary);background:#f0f3f9}
.opt.sel{border-color:var(--primary);background:var(--primary-soft)}
.opt-key{width:24px;height:24px;flex:none;border-radius:50%;border:1.5px solid var(--line-strong);display:flex;align-items:center;justify-content:center;font-family:var(--sans);font-weight:600;font-size:12px;color:var(--soft);margin-top:2px}
.opt.sel .opt-key{background:var(--primary);border-color:var(--primary);color:#fff}
.opt-text{flex:1;min-width:0}
.blank-input{border:1px solid var(--line-strong);border-radius:6px;background:#fff;padding:1px 8px;min-width:90px;font-family:var(--sans)}
.result{display:none;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.result.show{display:block}
.result h2{font-family:var(--serif);font-size:18px;color:var(--primary-deep);margin-bottom:6px}
.result p{font-size:13px;color:var(--soft)}
footer{max-width:900px;margin:0 auto 40px;padding:0 18px;font-size:11.5px;color:var(--faint)}
@media(max-width:920px){.layout{flex-direction:column}aside{width:100%;position:static;order:-1}main{width:100%}}
</style>
</head>
<body>
<header class="topbar">
  <div><div class="title">${escapeHtml(paperTitle)}</div><div class="sub">文档模式答题页预览 · 完整保留原文</div></div>
  <div class="spacer"></div>
  <div class="progress-pill" id="progress">已答 0 / ${interactive.length}</div>
  <button class="progress-pill" id="submit" style="cursor:pointer">交卷</button>
</header>
<div class="layout">
  <aside>
    <h3>答题卡</h3>
    <div class="side-count"><b id="doneCount">0</b> <span>/ ${interactive.length} 题已作答</span></div>
    <div class="side-bar"><i id="sideBar"></i></div>
    ${cards}
    <div class="legend"><span><i></i>已作答</span></div>
    <div class="legend" style="margin-top:8px;line-height:1.6">点击题号定位；交卷后由应用内 AI 判题并给解析。</div>
  </aside>
  <main>
    <section class="result" id="result">
      <h2>已交卷（原型）</h2>
      <p id="resultText"></p>
    </section>
    ${html}
  </main>
</div>
<footer>原型：正文来自转换后的 Markdown，控件由锚点注入；未改写任何题目内容。</footer>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})"></script>
<script>
const answers = new Map();
const total = ${interactive.length};
function refresh() {
  const done = answers.size;
  document.getElementById('progress').textContent = '已答 ' + done + ' / ' + total;
  document.getElementById('doneCount').textContent = String(done);
  document.getElementById('sideBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}
document.querySelectorAll('.opt').forEach((button) => {
  button.addEventListener('click', () => {
    const unit = button.dataset.unit;
    const multi = button.closest('.opts')?.dataset.multi === '1';
    const group = button.parentElement;
    if (!multi) group.querySelectorAll('.opt').forEach((other) => other.classList.remove('sel'));
    button.classList.toggle('sel');
    const selected = [...group.querySelectorAll('.opt.sel')].map((item) => item.dataset.value);
    if (selected.length) answers.set(unit, selected.join('')); else answers.delete(unit);
    refresh();
    const target = document.querySelector('[data-target="q' + button.closest('.q-card').dataset.q + '"]');
    if (target) target.classList.toggle('done', answers.has(unit));
  });
});
document.querySelectorAll('.blank-input').forEach((input) => {
  input.addEventListener('input', () => {
    const unit = input.dataset.unit;
    if (input.value.trim()) answers.set(unit, input.value); else answers.delete(unit);
    refresh();
  });
});
document.querySelectorAll('.short-input').forEach((input) => {
  input.addEventListener('input', () => {
    const unit = input.dataset.unit;
    if (input.value.trim()) answers.set(unit, input.value); else answers.delete(unit);
    refresh();
  });
});
document.querySelectorAll('.grid-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
document.querySelectorAll('.q-card').forEach((card) => {
  const button = document.querySelector('[data-target="q' + card.dataset.q + '"]');
  if (button) button.addEventListener('click', () => {});
});
document.getElementById('submit').addEventListener('click', () => {
  document.getElementById('result').classList.add('show');
  document.getElementById('resultText').textContent = '已作答 ' + answers.size + ' / ' + total + ' 题。原型页不判分；应用内会把这 ' + answers.size + ' 题交给 AI 判题并显示解析。';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, document, "utf8");
console.log(JSON.stringify({ units: units.length, interactive: interactive.length, blocks: blocks.length, out: path.resolve(outPath) }, null, 2));

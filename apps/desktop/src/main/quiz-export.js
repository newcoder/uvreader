// 文档模式答题页导出:Markdown → 自包含 HTML(答案/解析隐藏,本地判分)。
// 主进程和 scripts/quiz-paper-preview.mjs 共用同一套解析与渲染。
import fs from "node:fs";
import path from "node:path";

import temml from "temml";
import { buildSolveMessages, buildStructureMessages, normalizeSolve, parseJudgeJson, parseStructureStarts } from "../../../../packages/reader/src/quiz-judge.js";

export async function buildQuizPaper({
  markdown = "",
  baseDir: baseDirInput = "",
  bank = [],
  answers = null,
  solve = null,
  structure = null,
  title = "试卷",
  onProgress = () => {},
  signal = null,
  codeFormatter = null,
} = {}) {
  const md = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = absorbOrphanCode(md.split("\n"));

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
    if (typeof codeFormatter === "function") {
      try {
        return { language, text: codeFormatter(String(text), language) };
      } catch { /* 落到兜底缩进 */ }
    }
    return { language, text: formatCode(text) };
  }
  return { language, text: String(text) };
}

// 跨页时 MinerU 可能把代码第一行丢在围栏外(如 `01 #include <iostream>`):
// 开围栏时把紧邻的、看起来像代码的行吸进代码块,并去掉页边行号。
function absorbOrphanCode(lines) {
  const isCodeLine = (text) => /^\s*(?:\d{1,3}\s+)?(?:#\s*include|#\s*define|using\s+namespace|typedef\b|struct\b|class\b|int\s+[A-Za-z_]|long\s+[A-Za-z_]|char\s+[A-Za-z_]|void\s+[A-Za-z_]|double\s+[A-Za-z_]|const\b)/.test(text);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        const moved = [];
        let index = out.length - 1;
        while (index >= 0) {
          const text = out[index].trim();
          if (!text || /^<!--\s*page:\s*\d+\s*-->$/i.test(text)) {
            index -= 1;
            continue;
          }
          if (!isCodeLine(text)) break;
          moved.unshift(out[index].replace(/^\s*\d{1,3}\s+/, ""));
          out.splice(index, 1);
          index -= 1;
        }
        out.push(line);
        out.push(...moved);
        inFence = true;
      } else {
        out.push(line);
        inFence = false;
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

function unescapeCode(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
function highlightCode(code, fence) {
  const formatted = formatBlock(unescapeCode(code), fence);
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

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function imageSrc(src, baseDir) {
  const value = String(src || "");
  if (!value || /^(?:data:|https?:|file:|app:|\/\/)/i.test(value)) return value;
  try {
    const absolute = path.resolve(baseDir, decodeURIComponent(value));
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return value;
    const mime = IMAGE_MIME[path.extname(absolute).slice(1).toLowerCase()] || "application/octet-stream";
    return `data:${mime};base64,${fs.readFileSync(absolute).toString("base64")}`;
  } catch {
    return value;
  }
}

function mathHtml(tex, display) {
  try {
    let html = temml.renderToString(String(tex), { throwOnError: false, displayMode: display === true });
    // 浏览器不一定会把 [ ] 拉到矩阵高度:换成 CSS 边框,行距也更稳。
    html = html.replace(
      /(<mo fence="true"[^>]*>\s*\[\s*<\/mo>)(<mtable[\s\S]*?<\/mtable>)(<mo fence="true"[^>]*>\s*\]\s*<\/mo>)/g,
      (_match, _open, table) => `<mrow class="qbr-matrix">${table}</mrow>`,
    );
    html = html.replace(/<mtable/g, '<mtable rowspacing="0.4em"');
    return html;
  } catch {
    return `<span class="math-raw">${escapeHtml(tex)}</span>`;
  }
}

function inline(value, baseDir) {
  const tokens = [];
  const keep = (html) => `\u0000T${tokens.push(html) - 1}\u0000`;
  let text = String(value ?? "");
  // 公式转成 MathML(自包含,不依赖 CDN);图片内联成 data URL。
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => keep(mathHtml(tex, true)));
  text = text.replace(/\$([^$\n]+)\$/g, (_match, tex) => keep(mathHtml(tex, false)));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => keep(
    `<img src="${escapeHtml(imageSrc(src, baseDir))}" alt="${escapeHtml(alt)}">`,
  ));
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // 只还原 Markdown 的转义;数学/图片已经切出去了。
  text = text.replace(/\\([*_`{}[\]()#+\-.!])/g, "$1");
  // 圆圈数字(①②③)在题干/选项里也放大一些,避免看不清。
  text = text.replace(/([①②③④⑤⑥⑦⑧⑨⑩])/g, '<span class="circled">$1</span>');
  return text.replace(/\u0000T(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

function optionRun(line) {
  const matches = [...line.matchAll(/(^|[\s）)。；;.：:])([A-H])\s*[.、．)）]\s*/g)];
  if (!matches.length) return null;
  const labelStart = (match) => match.index + match[1].length;
  const head = line.slice(0, labelStart(matches[0])).trim();
  const options = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? labelStart(matches[index + 1]) : line.length;
    return { label: match[2], text: line.slice(start, end).trim() };
  });
  return { head, options };
}

const QUESTION = /^(\d{1,3})\s*[.、．)）]\s*(.*)$/;

function typeFromSectionText(text) {
  const value = String(text || "");
  // 「阅读程序 / 完善程序」是容器标题,不是题型。
  if (/阅读程序|完善程序/.test(value)) return "";
  if (/多选/.test(value)) return "multiple_choice";
  if (/判断/.test(value)) return "true_false";
  if (/单选|选择/.test(value)) return "single_choice";
  if (/填空/.test(value)) return "fill_blank";
  if (/程序/.test(value)) return "program";
  if (/计算/.test(value)) return "calculation";
  if (/证明/.test(value)) return "proof";
  if (/简答|问答/.test(value)) return "short_answer";
  return "";
}

// AI 结构识别(可选):只允许模型列出的行作为题目起点。伪代码/算法行即使
// 以数字开头,也不会被切成一题一行;模型漏太多时回落到规则。
let allowedStarts = null;
if (typeof structure === "function") {
  try {
    const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join("\n");
    const candidates = [];
    lines.forEach((line, index) => {
      if (QUESTION.test(line)) candidates.push(index + 1);
    });
    const raw = await structure(buildStructureMessages({ numbered, candidates }), { signal });
    const starts = parseStructureStarts(raw, { maxLine: lines.length, candidates });
    if (starts.length && starts.length >= Math.ceil(candidates.length * 0.5)) {
      allowedStarts = new Set(starts);
    }
  } catch { /* 结构识别失败就用规则 */ }
}

const blocks = [];
const units = [];
let section = "";
let sectionType = "";
let paragraph = [];
let lastUnit = null;
let lastContext = "";

function flushParagraph() {
  if (!paragraph.length) return;
  const text = paragraph.join("\n").trim();
  if (text) blocks.push({ kind: "p", text });
  paragraph = [];
}

function addUnit(number, stem) {
  flushParagraph();
  const unit = { number, stem, options: [], between: [], figures: [], context: lastContext, section, sectionType, kind: "text", id: `u${units.length + 1}` };
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
    // 跨页不丢上一题:选项/伪代码可能在后一页。
    blocks.push({ kind: "page", page: Number(trimmed.replace(/\D/g, "")) });
    continue;
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    flushParagraph();
    lastUnit = null;
    lastContext = "";
    const title = heading[2];
    const topLevel = heading[1].length <= 2 && /^[一二三四五六七八九十]+\s*[、.]/.test(title);
    if (topLevel) section = title.replace(/[（(].*$/, "").trim() || section;
    const sectionKind = typeFromSectionText(title);
    if (sectionKind) sectionType = sectionKind;
    else if (topLevel) sectionType = "";
    blocks.push({ kind: "heading", level: heading[1].length, text: title });
    continue;
  }
  // 「- 判断题 / - 单选题」在 MinerU 产物里是列表行,也当小节题型处理。
  if (/^[-*]\s*(?:判断题|单选题|多选题|选择题|填空题)\s*$/.test(trimmed)) {
    flushParagraph();
    sectionType = typeFromSectionText(trimmed);
    blocks.push({ kind: "heading", level: 4, text: trimmed.replace(/^[-*]\s*/, "") });
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
    if (lastUnit && !lastUnit.options.length) {
      lastUnit.between.push(codeBlock);
    } else {
      lastUnit = null;
      lastContext = codeBlock.text;
      blocks.push(codeBlock);
    }
    continue;
  }
  if (!trimmed) {
    flushParagraph();
    continue;
  }
  // 独立一行的插图:按位置判断归属——题干提到「如图/右图」且图在最后一项之后
  // 才归题干;夹在选项之间、紧跟在空选项后、或选项文字提到图,归选项。
  if (lastUnit && /^!\[[^\]]*\]\([^)\s]+\)$/.test(trimmed)) {
    const last = lastUnit.options[lastUnit.options.length - 1];
    const figureRef = (text) => /(?:如|见|下|上|右|左).{0,4}图|图所示|图中/.test(text);
    const stemRef = figureRef(String(lastUnit.stem || ""));
    const optionRef = last ? figureRef(String(last.text || "")) : false;
    const next = lines.slice(index + 1).find((entry) => entry.trim());
    const nextIsOption = Boolean(next && /^\s*[A-H]\s*[.、．)）]/.test(next));
    const optionImage = Boolean(last) && (optionRef || !String(last.text || "").trim() || nextIsOption || !stemRef);
    if (optionImage) {
      last.text = `${last.text || ""} ${trimmed}`.trim();
    } else {
      lastUnit.figures.push(trimmed);
    }
    continue;
  }
  const question = QUESTION.exec(line);
  const isOptionLine = /^\s*[A-H]\s*[.、．)）](?:\s|$)/.test(line);
  if (question && !isOptionLine) {
    if (allowedStarts && !allowedStarts.has(index + 1)
      && !/[（(]\s*[）)]/.test(trimmed)
      && !optionRun(trimmed)) {
      // 模型判定这行不是题干(例如伪代码步骤):并入上一题或段落。
      if (lastUnit && !lastUnit.options.length) lastUnit.between.push(trimmed);
      else paragraph.push(line);
      continue;
    }
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
  // 选项可能写在结论句里("请问…?（）。A. … B. …"):整行没有以 A 开头,也要拆出来。
  if (lastUnit && !lastUnit.options.length) {
    const inline = optionRun(trimmed);
    if (inline && inline.options.length >= 3) {
      if (inline.head) lastUnit.between.push(inline.head);
      lastUnit.options.push(...inline.options);
      continue;
    }
  }
  // 原文自带的答案/解析:挂到上一题,不要粘进选项。
  const answerMeta = /^(?:标准答案|参考答案|答案)\s*[:：]\s*(.*)$/.exec(trimmed);
  if (answerMeta && lastUnit) {
    lastUnit.inlineAnswer = answerMeta[1].trim();
    continue;
  }
  const analysisMeta = /^(?:试题解析|答案解析|解析)\s*[:：]\s*(.*)$/.exec(trimmed);
  if (analysisMeta && lastUnit) {
    lastUnit.inlineAnalysis = analysisMeta[1].trim();
    continue;
  }
  if (/^(?:试题编号|试题类型|试题难度|题型|难度|知识点|考点|来源|分值|考生答案|考生得分|得分|分数|是否评分|评价描述)\s*[:：]/.test(trimmed)) continue;
  // 选项文字可能分多行(例如 "A." 单独一行,下一行才是 4*9=):接到最后一个选项上。
  if (lastUnit && lastUnit.options.length && !isOptionLine) {
    const last = lastUnit.options[lastUnit.options.length - 1];
    last.text = `${last.text} ${trimmed}`.trim();
    continue;
  }
  if (lastUnit && lastUnit.kind === "true_false" && /^[（(]/.test(trimmed)) {
    paragraph.push(line);
    continue;
  }
  if (lastUnit && !lastUnit.options.length) {
    lastUnit.between.push(line);
    continue;
  }
  paragraph.push(line);
}
flushParagraph();

// 选项行可能分多行(A/B/C/D 各一行),因此题型在全部行读完后统一判定。
for (const unit of units) {
  if (unit.options.length >= 2) unit.kind = "choice";
  else if (unit.sectionType === "true_false" || /[（(]\s*[）)]\s*$/.test(unit.stem)) unit.kind = "true_false";
  else if (unit.sectionType === "single_choice" || unit.sectionType === "multiple_choice") unit.kind = "choice";
  else if (unit.between.some((entry) => entry?.kind === "code")) unit.kind = "program";
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
const baseDir = String(baseDirInput || process.cwd());

// ---- 答案(来自题库 JSON 或单独的 answers.json) -------------------------
function normalizeChoice(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-H]/g, "").split("").sort().join("");
}
function normalizeTruth(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["t", "true", "对", "正确", "√", "y", "yes", "1"].includes(text)) return "T";
  if (["f", "false", "错", "错误", "×", "x", "n", "no", "0"].includes(text)) return "F";
  return "";
}
function typeMatches(question, unit) {
  const type = String(question?.type || "");
  if (unit.kind === "choice") return type === "single_choice" || type === "multiple_choice";
  if (unit.kind === "true_false") return type === "true_false";
  if (unit.kind === "blank") return type === "fill_blank";
  return ["short_answer", "program", "calculation", "proof"].includes(type);
}
function applyAnswer(unit, answer, analysis) {
  const text = String(answer ?? "").trim();
  if (!text) return false;
  if (unit.kind === "choice") {
    const letters = normalizeChoice(text);
    if (!letters) return false;
    unit.answer = letters;
  } else if (unit.kind === "true_false") {
    const truth = normalizeTruth(text);
    if (!truth) return false;
    unit.answer = truth;
  } else if (unit.kind === "blank") {
    unit.answer = text;
  } else if (unit.kind === "short" || unit.kind === "program") {
    unit.reference = text;
  } else {
    return false;
  }
  if (analysis) unit.analysis = String(analysis);
  return true;
}

function attachAnswers() {
  const bankQuestions = Array.isArray(bank) ? bank : [];
  const byNumber = new Map();
  for (const question of bankQuestions) {
    const key = String(question.number || "");
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(question);
  }
  const override = answers && typeof answers === "object" ? answers : {};
  const used = new Set();
  for (const unit of units) {
    const candidates = (byNumber.get(String(unit.number)) || []).filter((question) => !used.has(question));
    const bankMatch = candidates.find((question) => typeMatches(question, unit)) || candidates[0];
    if (bankMatch) used.add(bankMatch);
    const raw = override[unit.number] ?? override[`q${unit.card}`] ?? override[unit.id];
    const entry = raw && typeof raw === "object" ? raw : (raw != null ? { answer: raw } : null);
    if (entry) {
      if (bankMatch?.type === "multiple_choice") unit.multi = true;
      applyAnswer(unit, entry.answer ?? entry.value ?? "", entry.analysis || "");
      continue;
    }
    // 原文自带的「标准答案/试题解析」优先,题库只补空缺。
    if (unit.inlineAnswer) {
      applyAnswer(unit, unit.inlineAnswer, unit.inlineAnalysis || bankMatch?.analysis || "");
      continue;
    }
    if (bankMatch) {
      if (bankMatch.type === "multiple_choice") unit.multi = true;
      applyAnswer(unit, bankMatch.answer, bankMatch.analysis || "");
    }
  }
}
attachAnswers();

// 没有标准答案/解析的题交给模型补齐;结果同样只进隐藏字段。
const aiStats = { answers: 0, analyses: 0, failed: 0 };
if (typeof solve === "function") {
  const pending = units.filter((unit) => ["choice", "true_false", "blank", "short"].includes(unit.kind)
    && (!unit.answer || !unit.analysis));
  let done = 0;
  for (const unit of pending) {
    if (signal?.aborted) break;
    const question = {
      type: unit.kind === "choice" ? (unit.multi ? "multiple_choice" : "single_choice") : unit.kind,
      stem: unit.stem,
      options: unit.options,
    };
    try {
      const raw = await solve(buildSolveMessages(question, {
        section: unit.section,
        context: unit.context || "",
        knownAnswer: unit.answer || "",
      }), { signal });
      const parsed = normalizeSolve(parseJudgeJson(raw));
      if (!parsed) {
        aiStats.failed += 1;
        continue;
      }
      if (!unit.answer && parsed.answer) {
        if (applyAnswer(unit, parsed.answer, parsed.analysis)) aiStats.answers += 1;
      } else if (!unit.analysis && parsed.analysis) {
        unit.analysis = parsed.analysis;
        aiStats.analyses += 1;
      }
      done += 1;
      onProgress(done, pending.length);
    } catch {
      if (signal?.aborted) break;
      aiStats.failed += 1;
    }
  }
}
const answeredBank = units.filter((unit) => unit.answer).length;

// Markdown 表格(题目里的干支表等):连续 "| ... |" 行 + 分隔行 → 真表格。
function tableRun(entries, start) {
  if (typeof entries[start] !== "string" || !entries[start].includes("|")) return null;
  if (!/^\s*\|?\s*:?-{3,}/.test(entries[start + 1] || "")) return null;
  const rows = [];
  let index = start;
  while (index < entries.length && typeof entries[index] === "string" && entries[index].includes("|")) {
    rows.push(entries[index]);
    index += 1;
  }
  return rows.length >= 2 ? { rows, end: index } : null;
}

function tableHtml(rows, baseDir) {
  const cells = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  let header = cells(rows[0]);
  let body = rows.slice(2).map(cells);
  const width = Math.max(header.length, ...body.map((row) => row.length));
  header = [...header, ...Array(width - header.length).fill("")];
  body = body.map((row) => [...row, ...Array(width - row.length).fill("")]);
  // 末尾整列为空(提取时多出来的 | | |):去掉,表格才不会多两列空白。
  let columns = width;
  while (columns > 0 && !header[columns - 1] && body.every((row) => !row[columns - 1])) columns -= 1;
  header = header.slice(0, columns);
  body = body.map((row) => row.slice(0, columns));
  const head = header.map((cell) => `<th>${inline(cell, baseDir)}</th>`).join("");
  const bodyHtml = body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, baseDir)}</td>`).join("")}</tr>`).join("");
  return `<div class="q-table-wrap"><table class="q-table"><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderUnit(unit) {
  const number = unit.card;
  const head = `<div class="q-head"><span class="q-no" title="卷面第 ${escapeHtml(unit.number)} 题">${escapeHtml(unit.number)}</span><span class="q-type">${
    unit.kind === "choice" ? "选择题" : unit.kind === "true_false" ? "判断题" : unit.kind === "blank" ? "填空题" : "简答题"
  }</span><span class="q-mark" data-mark></span></div>`;
  let body = `<div class="q-stem">${inline(unit.stem, baseDir)}</div>`;
  for (const figure of unit.figures || []) {
    body += `<div class="q-fig">${inline(figure, baseDir)}</div>`;
  }
  const between = unit.between || [];
  for (let index = 0; index < between.length; index += 1) {
    const table = tableRun(between, index);
    if (table) {
      body += tableHtml(table.rows, baseDir);
      index = table.end - 1;
      continue;
    }
    const entry = between[index];
    if (typeof entry !== "string") {
      if (entry?.kind === "code") body += codeHtml(entry.text, entry.lang);
      continue;
    }
    const pseudo = /^\s{2,}\S|^\s*(?:输入|输出|算法|伪代码)\b/.test(entry);
    if (!pseudo) {
      body += `<div class="q-note">${inline(entry, baseDir)}</div>`;
      continue;
    }
    const run = [entry];
    let next = index + 1;
    while (next < between.length && typeof between[next] === "string"
      && (/^\s{2,}\S/.test(between[next]) || /^\s*(?:输入|输出|算法|伪代码)\b/.test(between[next]))) {
      run.push(between[next]);
      next += 1;
    }
    body += `<pre class="q-pseudo">${escapeHtml(run.join("\n"))}</pre>`;
    index = next - 1;
  }
  if (unit.kind === "choice") {
    body += `<div class="opts"${unit.multi ? ' data-multi="1"' : ""}>${unit.options.map((option) => `
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
  const meta = [
    `data-kind="${unit.kind}"`,
    unit.answer ? `data-answer="${escapeHtml(unit.answer)}"` : "",
    unit.analysis ? `data-analysis="${escapeHtml(unit.analysis)}"` : "",
    unit.reference ? `data-reference="${escapeHtml(unit.reference)}"` : "",
  ].filter(Boolean).join(" ");
  return `<section class="q-card" data-q="${number}" id="q${number}" ${meta}>${head}${body}</section>`;
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
      for (const figure of block.unit.figures || []) {
        html += `<div class="q-fig">${inline(figure, baseDir)}</div>`;
      }
      const between = block.unit.between || [];
      for (let index = 0; index < between.length; index += 1) {
        const table = tableRun(between, index);
        if (table) {
          html += tableHtml(table.rows, baseDir);
          index = table.end - 1;
          continue;
        }
        const entry = between[index];
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

const paperTitle = String(title || "试卷").replace(/\.[^.]+$/, "").replace(/_doc$/, "");
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
.q-pseudo{font-family:var(--mono);font-size:12.5px;line-height:1.7;white-space:pre;overflow-x:auto;background:#f7f8fb;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0;color:#2c3340}
.q-table-wrap{overflow-x:auto;margin:8px 0}
.q-table{border-collapse:collapse;font-size:13px}
.q-table th,.q-table td{border:1px solid var(--line);padding:4px 9px;text-align:center;white-space:nowrap}
.q-table th{background:#f6f7fa;font-weight:600}
.short-input{width:100%;margin-top:10px;border:1px solid var(--line-strong);border-radius:8px;padding:8px 10px;font-family:var(--serif);font-size:14px;background:#fff;color:var(--ink)}
.page-sep{text-align:center;font-size:10px;color:var(--faint);letter-spacing:.12em;margin:14px 0;border-top:1px dashed var(--line);padding-top:6px}
.code-wrap{background:#f7f8fb;border:1px solid var(--line);border-radius:9px;overflow:hidden;margin:10px 0}
.code-bar{display:flex;align-items:center;justify-content:space-between;padding:5px 12px;background:#eef0f5;border-bottom:1px solid var(--line);font-size:10px;color:var(--faint);letter-spacing:.06em;text-transform:uppercase}
.code-dots{letter-spacing:2px;font-size:7px;color:#c2c7d1}
.code-wrap pre{font-family:var(--mono);font-size:12.5px;line-height:1.62;padding:14px 16px;color:#2c3340;white-space:pre;overflow-x:auto}
.code-wrap .blank{display:inline-block;min-width:24px;text-align:center;color:#a1291c;font-weight:700;font-size:15px;font-family:"Segoe UI Symbol","Noto Sans SC","Microsoft YaHei",sans-serif;line-height:1.35;background:#fdeee9;border:1px dashed #d98a7c;border-radius:6px;padding:1px 5px;vertical-align:-2px}
.circled{font-size:1.25em;font-weight:600;color:#a1291c;line-height:1;font-family:"Segoe UI Symbol","Noto Sans SC","Microsoft YaHei",sans-serif}
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
.result.show{display:block;animation:fadeIn .25s ease}
.result-top{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.ring{width:96px;height:96px;flex:none;border-radius:50%;background:conic-gradient(var(--accent) calc(var(--p,0) * 1%),#ede6d6 0);display:flex;align-items:center;justify-content:center}
.ring-inner{width:74px;height:74px;border-radius:50%;background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring-inner b{font-family:var(--serif);font-size:26px;line-height:1;color:var(--primary-deep)}
.ring-inner span{font-size:11px;color:var(--faint)}
.result-stats{flex:1;min-width:220px;display:grid;grid-template-columns:repeat(2,minmax(110px,1fr));gap:8px 18px}
.result-stats b{display:block;font-family:var(--serif);font-size:19px;color:var(--ink)}
.result-stats span{font-size:11.5px;color:var(--faint)}
.result p{margin-top:12px;font-size:12.5px;color:var(--soft);border-top:1px dashed var(--line);padding-top:10px}
.q-mark.correct{color:var(--ok)}
.q-mark.wrong{color:var(--bad)}
.q-card.correct{border-color:var(--ok)}
.q-card.wrong{border-color:var(--bad)}
.opt.good{border-color:var(--ok);background:var(--ok-soft,#e3f2e9)}
.opt.good .opt-key{background:var(--ok);border-color:var(--ok);color:#fff}
.opt.bad{border-color:var(--bad);background:var(--bad-soft,#fbe9e6)}
.opt.bad .opt-key{background:var(--bad);border-color:var(--bad);color:#fff}
.q-explain{display:none;margin-top:12px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0;padding:10px 14px;font-size:13.5px;line-height:1.85;color:#4c4129;white-space:pre-wrap}
.q-card.graded .q-explain{display:block}
.q-explain .ex-label{font-weight:700;color:#7a5a1e;margin-right:6px}
math{font-size:1.03em}
math mtable{border-collapse:collapse}
math mtr{line-height:1.7}
math mtd{padding-top:.18em;padding-bottom:.18em}
.qbr-matrix{display:inline-block;border-left:1.2px solid currentColor;border-right:1.2px solid currentColor;padding:0 .3em;vertical-align:middle}
.q-fig{display:flex;justify-content:center;padding:6px 0}
.q-fig img{max-width:100%;max-height:260px;border-radius:6px}
.opt-text img{max-width:100%;max-height:200px;border-radius:6px;margin-top:4px}
.math-raw{font-family:var(--mono);font-size:.9em;color:var(--bad)}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
footer{max-width:900px;margin:0 auto 40px;padding:0 18px;font-size:11.5px;color:var(--faint)}
@media(max-width:920px){.layout{flex-direction:column}aside{width:100%;position:static;order:-1}main{width:100%}}
</style>
</head>
<body>
<header class="topbar">
  <div><div class="title">${escapeHtml(paperTitle)}</div><div class="sub">文档模式答题页预览 · 完整保留原文</div></div>
  <div class="spacer"></div>
  <div class="progress-pill" id="timer">00:00</div>
  <div class="progress-pill" id="progress">已答 0 / ${interactive.length}</div>
  <button class="progress-pill" id="submit" style="cursor:pointer">交卷判分</button>
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
      <div class="result-top">
        <div class="ring" id="ring"><div class="ring-inner"><b id="score">0</b><span>分</span></div></div>
        <div class="result-stats">
          <div><b id="right">0</b><span>答对</span></div>
          <div><b id="wrong">0</b><span>答错 / 未答</span></div>
          <div><b id="rate">—</b><span>正确率</span></div>
          <div><b id="elapsed">—</b><span>用时</span></div>
        </div>
      </div>
      <p id="resultText"></p>
    </section>
    ${html}
  </main>
</div>
<footer>自包含答题页:正文来自转换后的 Markdown,答案来自题库或 answers.json,图片内联,公式为 MathML;未改写题目内容。</footer>
<script>
const answers = new Map();
const total = ${interactive.length};
const startAt = Date.now();
let finishedAt = 0;
const esc = function (value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
};
const letters = function (value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-H]/g, '').split('').sort().join('');
};
const truth = function (value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (['t', 'true', '对', '正确', '√', 'y', 'yes', '1'].indexOf(text) >= 0) return 'T';
  if (['f', 'false', '错', '错误', '×', 'x', 'n', 'no', '0'].indexOf(text) >= 0) return 'F';
  return text;
};
const plain = function (value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').trim();
};

function refresh() {
  const done = answers.size;
  document.getElementById('progress').textContent = '已答 ' + done + ' / ' + total;
  document.getElementById('doneCount').textContent = String(done);
  document.getElementById('sideBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}
function tick() {
  if (finishedAt) return;
  const seconds = Math.floor((Date.now() - startAt) / 1000);
  document.getElementById('timer').textContent =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
setInterval(tick, 1000);
tick();

document.querySelectorAll('.opt').forEach(function (button) {
  button.addEventListener('click', function () {
    const card = button.closest('.q-card');
    const unit = card.dataset.q;
    const multi = button.closest('.opts') && button.closest('.opts').dataset.multi === '1';
    const group = button.parentElement;
    if (!multi) group.querySelectorAll('.opt').forEach(function (other) { other.classList.remove('sel'); });
    button.classList.toggle('sel');
    const selected = [].slice.call(group.querySelectorAll('.opt.sel')).map(function (item) { return item.dataset.value; });
    if (selected.length) answers.set(unit, selected.join('')); else answers.delete(unit);
    refresh();
    const target = document.querySelector('[data-target="q' + unit + '"]');
    if (target) target.classList.toggle('done', answers.has(unit));
  });
});
document.querySelectorAll('.blank-input, .short-input').forEach(function (input) {
  input.addEventListener('input', function () {
    const unit = input.dataset.unit;
    if (input.value.trim()) answers.set(unit, input.value); else answers.delete(unit);
    refresh();
  });
});
document.querySelectorAll('.grid-btn').forEach(function (button) {
  button.addEventListener('click', function () {
    const target = document.getElementById(button.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function markCard(card, status) {
  card.classList.add('graded');
  if (status) card.classList.add(status);
  const mark = card.querySelector('.q-mark');
  if (mark) {
    mark.textContent = status === 'correct' ? '✓ 正确' : status === 'wrong' ? '✗ 错误' : '参考';
    mark.className = 'q-mark ' + (status || '');
  }
  card.querySelectorAll('.opt').forEach(function (opt) { opt.disabled = true; });
  const input = card.querySelector('.blank-input, .short-input');
  if (input) input.disabled = true;
}
function explain(card, expected, analysis) {
  const box = document.createElement('div');
  box.className = 'q-explain';
  const parts = [];
  if (expected) parts.push('<b>参考答案:</b> ' + esc(expected));
  if (analysis) parts.push(esc(analysis));
  box.innerHTML = '<span class="ex-label">解析</span>' + (parts.join('<br>') || '本题未提供解析。');
  card.appendChild(box);
}

function grade() {
  if (finishedAt) return;
  finishedAt = Date.now();
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let ungraded = 0;
  document.querySelectorAll('.q-card').forEach(function (card) {
    const kind = card.dataset.kind;
    const expected = String(card.dataset.answer || '').trim();
    const analysis = card.dataset.analysis || '';
    const reference = card.dataset.reference || '';
    const got = answers.get(card.dataset.q) || '';
    if (!expected) {
      if (reference) { markCard(card, ''); explain(card, reference, analysis); }
      ungraded += 1;
      return;
    }
    if (kind === 'short' || kind === 'program') {
      markCard(card, '');
      explain(card, reference || expected, analysis);
      ungraded += 1;
      return;
    }
    let ok = false;
    if (!got) unanswered += 1;
    else if (kind === 'choice') ok = letters(got) === letters(expected);
    else if (kind === 'true_false') ok = truth(got) === truth(expected);
    else ok = plain(got) === plain(expected);
    if (got) { if (ok) correct += 1; else wrong += 1; }
    markCard(card, ok ? 'correct' : 'wrong');
    if (!got) {
      const mark = card.querySelector('.q-mark');
      if (mark) { mark.textContent = '未答'; mark.className = 'q-mark wrong'; }
    }
    const shown = kind === 'true_false' ? (truth(expected) === 'T' ? '对' : '错') : expected;
    explain(card, shown, analysis);
    const map = document.querySelector('[data-target="q' + card.dataset.q + '"]');
    if (map) map.className = 'grid-btn ' + (ok && got ? 'right' : 'wrong');
  });
  const gradedTotal = correct + wrong + unanswered;
  const percent = gradedTotal ? Math.round(correct / gradedTotal * 100) : 0;
  document.getElementById('ring').style.setProperty('--p', String(percent));
  document.getElementById('score').textContent = String(percent);
  document.getElementById('right').textContent = String(correct);
  document.getElementById('wrong').textContent = String(wrong + unanswered);
  document.getElementById('rate').textContent = gradedTotal ? percent + '%' : '—';
  const elapsed = Math.max(0, Math.round((finishedAt - startAt) / 1000));
  document.getElementById('elapsed').textContent = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  const note = gradedTotal
    ? '客观题 ' + gradedTotal + ' 题：答对 ' + correct + '、答错 ' + wrong + '、未答 ' + unanswered +
      (ungraded ? '；另有 ' + ungraded + ' 题为主观题或未提供答案，请对照参考答案自评' : '') + '。'
    : '本卷没有可自动判分的答案；请在原文核对，或补充答案后重新生成。';
  document.getElementById('resultText').textContent = note;
  document.getElementById('result').classList.add('show');
  document.getElementById('submit').disabled = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.getElementById('submit').addEventListener('click', grade);
</script>
</body>
</html>`;

  return {
    html: document,
    stats: {
      units: units.length,
      interactive: interactive.length,
      answered: answeredBank,
      ai: aiStats,
      structure: allowedStarts ? "ai" : "rules",
      blocks: blocks.length,
    },
  };
}

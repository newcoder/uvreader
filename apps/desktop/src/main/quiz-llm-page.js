// LLM 答题页的应用主进程适配:提示词、HTML 提取、MathML/代码/图片收尾。
// 不依赖 jsdom:jsdom 打包进 Electron 主进程会去读 browser/default-stylesheet.css,
// 离线安装包没有这个文件,所以这里用受控的字符串处理,只改公式/代码/图片/答案块。
import fs from "node:fs";
import path from "node:path";

import temml from "temml";

import { QUIZ_LLM_PROMPT } from "../../../../packages/reader/src/quiz-llm-prompt.js";
import { QUIZ_LLM_PLAIN_PROMPT } from "../../../../packages/reader/src/quiz-llm-prompt-plain.js";
import { extractQuizManifest, plainQuizManifest, quizLayoutStyle, quizManifestGuardScript, quizManifestScript, repairQuizManifestFromHtml, validateQuizManifest } from "../../../../packages/reader/src/quiz-manifest.js";
import { cleanTemmlErrors } from "../shared/quiz-html.js";

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function buildQuizLlmPrompt(markdown, { plain = false } = {}) {
  const template = plain ? QUIZ_LLM_PLAIN_PROMPT : QUIZ_LLM_PROMPT;
  return template.replace("{{MARKDOWN}}", () => String(markdown || ""));
}

export function extractQuizLlmHtml(raw) {
  let value = String(raw || "").trim();
  const fence = /^```(?:html)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  if (fence) value = fence[1].trim();
  const start = value.search(/<!doctype\s+html/i);
  const html = start >= 0 ? value.slice(start) : value;
  const closes = [...html.matchAll(/<\/html\s*>/gi)];
  if (!closes.length) return html;
  const last = closes[closes.length - 1];
  const end = last.index + last[0].length;
  let page = html.slice(0, end);
  // Models sometimes append the structured manifest after </html> instead of
  // placing it in <head>. Keep that trailing script instead of dropping it.
  const tail = html.slice(end);
  const trailingManifest = /<script\b[^>]*\bid\s*=\s*(["'])quiz-manifest\1[^>]*>[\s\S]*?<\/script\s*>/i.exec(tail);
  if (trailingManifest) page += `\n${trailingManifest[0]}`;
  return `${page}\n`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

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
    if (trimmed.endsWith("{")) { level += 1; continue; }
    if (control.test(trimmed) && !trimmed.endsWith(";")) pendingBody = true;
  }
  return out.join("\n");
}

function renderMath(latex, displayMode, stats) {
  try {
    const html = temml.renderToString(unescapeHtml(latex), { displayMode, throwOnError: true });
    if (!html || /\btemml-error\b/i.test(html)) {
      stats.mathFailed += 1;
      return "";
    }
    return html;
  } catch {
    stats.mathFailed += 1;
    return "";
  }
}

const MATH_CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function mathTextFallback(latex) {
  // A malformed source often pairs dollars around prose ("... ABCD$ 中, $P A").
  // Drop the stray delimiters so the reader sees readable text, not markup.
  return String(latex).replace(/\$/g, "");
}

function looksLikeMath(latex) {
  const value = String(latex || "");
  // A stray dollar inside a matched run means the source has mismatched
  // delimiters; rendering it as math would only produce a red parse error.
  if (value.includes("$")) return false;
  // CJK prose between dollars is not math unless the model wrapped it in
  // \text{...}. This catches "中," fragments left by broken delimiters.
  if (MATH_CJK.test(value) && !/\\[a-zA-Z]*(?:text|mathrm|operatorname)/.test(value)) return false;
  return true;
}

function normalizeIsotope(text) {
  // OCR often writes an isotope as ^{90}39Y instead of ^{90}_{39}Y. Restrict
  // this to the common mass-number + atomic-number + element shape so normal
  // superscripts (x^2 y) are left alone.
  let value = String(text || "").replace(
    /\^\s*\{\s*(\d{1,3})\s*\}\s*(\d{1,3})\s*(?:\\mathrm\s*\{\s*([A-Za-z]{1,2})\s*\}|([A-Za-z]{1,2}))/g,
    (full, mass, atomic, wrapped, bare) => `^{${mass}}_{${atomic}}${wrapped ? `\\mathrm{${wrapped}}` : (bare || "")}`,
  );
  // "90 (^{90}_{39}Y)" is a duplicated mass number from OCR. The notation
  // inside the parentheses already carries it.
  value = value.replace(/\b\d{1,3}\s*\(\s*(\^\{\d{1,3}\}_\{\d{1,3}\}[A-Za-z]{1,2})\s*\)/g, "$1");
  return value;
}

function normalizeRawMath(value) {
  let text = unescapeHtml(value);
  text = text.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, " ");
  text = text.replace(/\\[ ,;:!]/g, " ");
  text = text.replace(/([\^_])\s*\{\s*([^{}]*?)\s*\}/g, (full, op, content) => `${op}{${content.replace(/\s+/g, "")}}`);
  text = text.replace(/([\^_])\s*([A-Za-z0-9])/g, "$1{$2}");
  // OCR often puts spaces between the digits of an isotope's atomic number.
  text = text.replace(/(\^\s*\{\s*\d+\s*\}\s*)((?:\d\s*)+)/g, (full, prefix, digits) => `${prefix}${digits.replace(/\s+/g, "")}`);
  text = normalizeIsotope(text);
  return text.replace(/\s+/g, " ").trim();
}

function fallbackRawMath(value) {
  let text = unescapeHtml(value);
  text = text.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, " ");
  text = normalizeIsotope(text);
  text = text.replace(/\\mathrm\s*\{\s*([^{}]*?)\s*\}/g, "$1");
  text = text.replace(/\\text\s*\{\s*([^{}]*?)\s*\}/g, "$1");
  text = text.replace(/\\operatorname\s*\{\s*([^{}]*?)\s*\}/g, "$1");
  text = text
    .replace(/\\rightarrow\b|\\to\b/g, "→")
    .replace(/\\leftarrow\b/g, "←")
    .replace(/\\times\b/g, "×")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\pm\b/g, "±")
    .replace(/\\(?:le|leq)\b/g, "≤")
    .replace(/\\(?:ge|geq)\b/g, "≥")
    .replace(/\\(?:ne|neq)\b/g, "≠")
    .replace(/\\approx\b/g, "≈")
    .replace(/\\infty\b/g, "∞");
  text = text.replace(/\\[a-zA-Z]+\s*/g, " ");
  text = text.replace(/\\[ ,;:!]/g, " ");
  const tokens = [];
  const stash = (html) => {
    const token = `%%QBR_MATH_${tokens.length}%%`;
    tokens.push(html);
    return token;
  };
  text = text.replace(/\^\s*\{\s*([^{}]*?)\s*\}/g, (full, content) => stash(`<sup>${escapeHtml(content.replace(/\s+/g, ""))}</sup>`));
  text = text.replace(/_\s*\{\s*([^{}]*?)\s*\}/g, (full, content) => stash(`<sub>${escapeHtml(content.replace(/\s+/g, ""))}</sub>`));
  text = text.replace(/\^\s*([A-Za-z0-9+\-])/g, (full, content) => stash(`<sup>${escapeHtml(content)}</sup>`));
  text = text.replace(/_\s*([A-Za-z0-9+\-])/g, (full, content) => stash(`<sub>${escapeHtml(content)}</sub>`));
  text = escapeHtml(text.replace(/[{}]/g, ""));
  for (let index = 0; index < tokens.length; index += 1) {
    text = text.replace(`%%QBR_MATH_${index}%%`, tokens[index]);
  }
  return text;
}

function repairMtextMath(html, stats) {
  return String(html || "").replace(/<math\b([^>]*)>([\s\S]*?)<\/math>/gi, (full, attrs, inner) => {
    const mtext = /^<mtext\b[^>]*>([\s\S]*?)<\/mtext>$/i.exec(String(inner || "").trim());
    if (!mtext) return full;
    const raw = unescapeHtml(mtext[1]);
    // A real <mtext> is just text; only repair blocks that still contain
    // LaTeX-like syntax copied from a failed OCR/formula pass.
    if (!/[\\^_{}]/.test(raw)) return full;
    const display = /display\s*=\s*["']block["']/i.test(attrs);
    const rendered = renderMath(normalizeRawMath(raw), display, stats);
    stats.mathRepaired += 1;
    if (rendered) return rendered;
    stats.mathFallback += 1;
    const fallback = fallbackRawMath(raw);
    return display
      ? `<div class="qbr-math-fallback" style="text-align:center">${fallback}</div>`
      : `<span class="qbr-math-fallback">${fallback}</span>`;
  });
}

function mathInText(text, stats) {
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  return text.replace(re, (full, display, inline, paren, bracket) => {
    const raw = String(display ?? inline ?? paren ?? bracket ?? "");
    const latex = raw.trim();
    if (!latex) return full;
    if (!looksLikeMath(latex)) return mathTextFallback(raw);
    const math = renderMath(latex, Boolean(display || bracket), stats);
    if (!math) return full;
    stats.math += 1;
    return math;
  });
}

function convertMathOutsideProtectedTags(html, stats) {
  const tagRe = /<[^>]+>/g;
  const skip = new Set(["script", "style", "pre", "code", "math", "textarea"]);
  let result = "";
  let cursor = 0;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    const text = html.slice(cursor, match.index);
    result += depth === 0 ? mathInText(text, stats) : text;
    const tag = match[0];
    result += tag;
    const nameMatch = /^<\s*\/?\s*([a-z0-9]+)/i.exec(tag);
    const name = String(nameMatch?.[1] || "").toLowerCase();
    if (name && skip.has(name)) {
      if (/^<\s*\//.test(tag)) depth = Math.max(0, depth - 1);
      else if (!/\/\s*>$/.test(tag)) depth += 1;
    }
    cursor = match.index + tag.length;
  }
  result += depth === 0 ? mathInText(html.slice(cursor), stats) : html.slice(cursor);
  return result;
}

function formatCodeBlocks(html, stats) {
  return html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (full, attrs, inner) => {
    const code = unescapeHtml(String(inner || "").replace(/<[^>]+>/g, ""));
    if (!code.trim()) return full;
    if (/算法\s|伪代码|输入:\s*数组/.test(code)) { stats.codeSkipped += 1; return full; }
    const hasCpp = /#\s*include|using\s+namespace|int\s+main\s*\(|\bfor\s*\(|\bwhile\s*\(/.test(code);
    const hasBlank = /[\u2460-\u2473\u2776-\u277f]/.test(code);
    if (!hasCpp && !hasBlank) return full;
    const formatted = hasCpp ? formatCode(code) : code;
    const decorated = escapeHtml(formatted).replace(/([\u2460-\u2473\u2776-\u277f])/g, '<span class="code-blank">$1</span>');
    if (decorated === escapeHtml(code)) return full;
    stats.code += formatted === code ? 0 : 1;
    return `<pre${attrs}>${decorated}</pre>`;
  });
}

function decorateBlanks(html, stats) {
  const blankRe = /[\u2460-\u2473\u2776-\u277f]/g;
  const count = (html.match(blankRe) || []).length;
  if (!count) return html;
  stats.blankSymbols = count;
  const style = `<style data-llm-code-blank>
.code-blank,.circled-blank{font-size:1.35em;line-height:1;vertical-align:-0.08em;font-family:"Segoe UI Symbol","Noto Sans SC","Microsoft YaHei",sans-serif;padding:0 .06em}
</style>`;
  let output = html.replace(/<\/head>/i, `${style}</head>`);
  if (!/<style data-llm-code-blank>/i.test(output)) output = `${style}${output}`;
  return output;
}

function inlineImages(html, { baseDir = "", dropImages = [] }, stats) {
  const drop = new Set((Array.isArray(dropImages) ? dropImages : []).map((item) => path.basename(String(item || ""))));
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!srcMatch) return tag;
    const src = unescapeHtml(srcMatch[1] ?? srcMatch[2] ?? "");
    if (!src || /^(?:data:|https?:|file:|app:|\/\/)/i.test(src)) return tag;
    const name = path.basename(src);
    if (drop.has(name)) {
      stats.imagesDropped += 1;
      return "";
    }
    try {
      const file = path.resolve(baseDir, decodeURIComponent(src));
      if (!fs.existsSync(file)) { stats.imagesMissing += 1; return tag; }
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = IMAGE_MIME[ext];
      if (!mime) { stats.imagesMissing += 1; return tag; }
      const data = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
      stats.imagesInlined += 1;
      return tag.replace(srcMatch[0], `src="${data}"`);
    } catch {
      stats.imagesMissing += 1;
      return tag;
    }
  });
}

function hideGenerated(html, stats) {
  let output = html;
  let count = 0;
  output = output.replace(/<([a-z][^>]*\bdata-source\s*=\s*(["'])generated\2[^>]*)>/gi, (full, attrs) => {
    count += 1;
    if (/\bhidden(?:\s|=|>)/.test(attrs)) return full;
    return `<${attrs} hidden>`;
  });
  if (!count) return output;
  stats.generatedHidden = count;
  const style = '<style data-llm-generated-hidden>[data-source="generated"]{display:none!important}</style>';
  const script = `<script data-llm-generated-reveal>(function(){
    var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-source="generated"]'));
    var covers = document.querySelectorAll('style[data-llm-generated-hidden]');
    function reveal(){ Array.prototype.forEach.call(covers, function(cover){ cover.remove(); }); blocks.forEach(function(b){ b.hidden=false; b.style.display=''; }); }
    function hide(){ Array.prototype.forEach.call(covers, function(cover){ cover.remove(); }); blocks.forEach(function(b){ b.hidden=true; b.style.display='none'; }); }
    document.addEventListener('click', function(event){
      var button = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!button) return;
      var text = button.textContent || '';
      if (/交卷|提交/.test(text)) setTimeout(reveal, 0);
      if (/重新答题|重置|重做/.test(text)) setTimeout(hide, 0);
    }, true);
  })();</script>`;
  output = output.replace(/<\/head>/i, `${style}</head>`);
  if (!/<style data-llm-generated-hidden>/i.test(output)) output = `${style}${output}`;
  output = output.replace(/<\/body>/i, `${script}</body>`);
  if (!/<\/body>/i.test(output)) output += script;
  return output;
}

const ANALYSIS_MARKER_RE = /【\s*(?:(?:参考|标准|正确)?答案|解析|详解|分析|小问[^】]*详解)\s*】/;
const SOLUTION_TAG_RE = /<(div|section)\b[^>]*\bclass\s*=\s*(?:"[^"]*\bsolution\b[^"]*"|'[^']*\bsolution\b[^']*')[^>]*>/i;
const QUESTION_SECTION_RE = /<section\b[^>]*\bclass\s*=\s*(?:"[^"]*\bq\b[^"]*"|'[^']*\bq\b[^']*')[^>]*>[\s\S]*?<\/section>/gi;

// 标记在标签外才算正文,避免把 data-analysis 属性里的标记当成未隐藏内容。
function textMarkerIndex(html) {
  const tagRe = /<[^>]*>/g;
  let cursor = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    const text = html.slice(cursor, match.index);
    const found = ANALYSIS_MARKER_RE.exec(text);
    if (found) return cursor + found.index;
    cursor = match.index + match[0].length;
  }
  const found = ANALYSIS_MARKER_RE.exec(html.slice(cursor));
  return found ? cursor + found.index : -1;
}

function closingTagIndex(html, start, tagName) {
  const re = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (/^<\//.test(match[0])) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

// 模型偶尔会把原文的【详解】整段留在题目里,再在答案块里写「见上文【详解】」。
// 不改写文字,只把题干后、答案块前的解析段落移进隐藏的答案块。
function liftInlineSolutions(html, stats) {
  return html.replace(QUESTION_SECTION_RE, (section) => {
    const solution = SOLUTION_TAG_RE.exec(section);
    if (!solution) return section;
    const before = section.slice(0, solution.index);
    const markerAt = textMarkerIndex(before);
    if (markerAt < 0) return section;
    const paragraphAt = before.lastIndexOf("<p", markerAt);
    if (paragraphAt < 0) return section;
    const paragraphOpen = before.indexOf(">", paragraphAt);
    if (paragraphOpen < 0 || paragraphOpen >= markerAt) return section;
    const prefix = before.slice(paragraphOpen + 1, markerAt).replace(/<[^>]*>/g, "").trim();
    if (prefix) return section;
    const movable = before.slice(paragraphAt).trim();
    if (!movable) return section;
    const closeAt = closingTagIndex(section, solution.index, solution[1].toLowerCase());
    if (closeAt < 0) return section;
    const openEnd = section.indexOf(">", solution.index) + 1;
    const inner = section.slice(openEnd, closeAt)
      .replace(/<p\b[^>]*>\s*(?:见上文|见解析|同上|略)(?:[^<]*)<\/p>/gi, "")
      .trimEnd();
    stats.inlineSolutions += 1;
    return `${before.slice(0, paragraphAt).trimEnd()}\n${section.slice(solution.index, openEnd)}${inner}\n${movable}\n${section.slice(closeAt)}`;
  });
}

function enhanceQuizUi(html) {
  if (/data-quiz-ui-enhance/i.test(html)) return html;
  const script = `<script data-quiz-ui-enhance>(function(){
    function buttonFrom(target){ return target && target.closest ? target.closest('button,[role="button"]') : null; }
    function findReset(){
      var buttons = document.querySelectorAll('button,[role="button"]');
      for (var i=0;i<buttons.length;i++) {
        if (/重新答题|重新作答|重置|重做/.test(buttons[i].textContent || '')) return buttons[i];
      }
      return null;
    }
    var reset = findReset();
    if (!reset) {
      var header = document.querySelector('header,.topbar,.top-bar,.toolbar,.quiz-header');
      if (header) {
        reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'quiz-reset-fallback';
        reset.textContent = '重新答题';
        reset.style.cssText = 'margin-left:8px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;padding:4px 12px;font:inherit;cursor:pointer';
        reset.addEventListener('click', function(){ location.reload(); });
        header.appendChild(reset);
      }
    }
    function moveResult(){
      var result = document.querySelector('#result,.result,.result-summary,.score-summary,.score-card');
      var nav = document.querySelector('aside,.answer-card,.question-nav,.question-navigation,#answer-card');
      if (!result || !nav || nav.contains(result)) return;
      var heading = nav.querySelector('h1,h2,h3,h4');
      nav.insertBefore(result, heading || nav.firstChild);
    }
    document.addEventListener('click', function(event){
      var button = buttonFrom(event.target);
      if (!button) return;
      if (/交卷|提交/.test(button.textContent || '')) {
        setTimeout(moveResult, 50);
        setTimeout(moveResult, 300);
      }
    }, true);
  })();</script>`;
  const output = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
  return output;
}

function addOptionValues(html, stats) {
  let count = 0;
  const output = String(html || "").replace(/<input\b([^>]*)>/gi, (tag, attrs) => {
    const data = /(?:^|\s)data-value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!data) return tag;
    const value = data[1] ?? data[2] ?? data[3] ?? "";
    const current = /(?:^|\s)value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const currentValue = current ? (current[1] ?? current[2] ?? current[3] ?? "") : "";
    if (currentValue === value) return tag;
    const selfClosing = /\/\s*$/.test(attrs);
    const body = attrs
      .replace(/\/\s*$/, "")
      .replace(/\s+value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
    count += 1;
    return `<input${body} value="${escapeHtml(value)}"${selfClosing ? " /" : ""}>`;
  });
  stats.optionValues = (stats.optionValues || 0) + count;
  return output;
}

function addMissingElements(html, stats) {
  const ids = [...html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  let output = html;
  for (const id of new Set(ids)) {
    if (new RegExp(`\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(output)) continue;
    const placeholder = `<div id="${escapeHtml(id)}" class="post-injected"></div>`;
    const scriptAt = output.search(/<script\b/i);
    output = scriptAt >= 0 ? `${output.slice(0, scriptAt)}${placeholder}${output.slice(scriptAt)}` : `${output}${placeholder}`;
    stats.missingElements += 1;
  }
  return output;
}

const ANSWER_CLASS_TOKEN = /^(?:solution|analysis|explanation|q-explain|answer|answer-block|answer-content|answer-panel|answer-line|quiz-answer|correct-answer)$/i;
const ANSWER_DATA = /\bdata-(?:quiz-)?(?:correct-)?answer(?:-for)?\b|\bdata-source\s*=\s*["']generated["']/i;
const VOID_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

function isAnswerAttrs(attrs) {
  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const className = classMatch ? (classMatch[2] ?? classMatch[3] ?? "") : "";
  if (className.split(/\s+/).some((token) => token && ANSWER_CLASS_TOKEN.test(token))) return true;
  return ANSWER_DATA.test(attrs);
}

function removeAnswerElements(html) {
  // A plain page must not leave a half-removed answer block behind. Walk tags
  // with a depth counter so nested <div> wrappers disappear with their parent.
  const tagRe = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?([a-zA-Z][\w:-]*)\b[^>]*>/gi;
  const ranges = [];
  let match;
  while ((match = tagRe.exec(html))) {
    if (match[1]) continue;
    const name = String(match[2] || "").toLowerCase();
    if (!name || match[0].startsWith("</") || VOID_TAG.test(name)) continue;
    const attrs = match[0].slice(1 + name.length, -1);
    if (!isAnswerAttrs(attrs)) continue;
    let depth = 1;
    let end = -1;
    const innerRe = new RegExp(`<\\/?${name}\\b[^>]*>`, "gi");
    innerRe.lastIndex = tagRe.lastIndex;
    let inner;
    while ((inner = innerRe.exec(html))) {
      if (/^<\//.test(inner[0])) {
        depth -= 1;
        if (depth === 0) {
          end = inner.index + inner[0].length;
          break;
        }
      } else if (!/\/\s*>$/.test(inner[0])) {
        depth += 1;
      }
    }
    if (end < 0) continue;
    ranges.push([match.index, end]);
    tagRe.lastIndex = end;
  }
  let output = html;
  for (const [start, end] of ranges.reverse()) output = `${output.slice(0, start)}${output.slice(end)}`;
  return output;
}

function stripPlainAnswers(html, stats) {
  const before = String(html || "");
  let output = removeAnswerElements(before);
  output = output.replace(/\sdata-(?:quiz-)?(?:correct-)?answer(?:-for)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  output = output.replace(/\sdata-correct\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  output = output.replace(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi, (full, quoted, doubleQuoted, singleQuoted) => {
    const value = doubleQuoted ?? singleQuoted ?? "";
    const cleaned = value.split(/\s+/)
      .filter((token) => token && !/^(?:correct|right|wrong|answer|solution|analysis)$/i.test(token))
      .join(" ");
    return cleaned ? `class="${cleaned}"` : "";
  });
  stats.answersRemoved = Math.max(0, before.length - output.length);
  return output;
}

export function postprocessQuizLlmHtml(html, { baseDir = "", dropImages = [], plain = false } = {}) {
  const stats = {
    math: 0,
    mathFailed: 0,
    mathRepaired: 0,
    mathFallback: 0,
    code: 0,
    codeSkipped: 0,
    generatedHidden: 0,
    missingElements: 0,
    imagesInlined: 0,
    imagesDropped: 0,
    imagesMissing: 0,
    blankSymbols: 0,
    inlineSolutions: 0,
    answersRemoved: 0,
    manifestRepaired: 0,
    optionValues: 0,
  };
  let output = String(html || "");
  let manifest = extractQuizManifest(output);
  if (plain) {
    output = stripPlainAnswers(output, stats);
    manifest = plainQuizManifest(manifest);
  }
  output = repairMtextMath(output, stats);
  output = convertMathOutsideProtectedTags(output, stats);
  output = cleanTemmlErrors(output);
  output = formatCodeBlocks(output, stats);
  output = decorateBlanks(output, stats);
  output = addOptionValues(output, stats);
  output = addMissingElements(output, stats);
  if (!plain) {
    output = liftInlineSolutions(output, stats);
    output = hideGenerated(output, stats);
  }
  output = enhanceQuizUi(output);
  output = inlineImages(output, { baseDir, dropImages }, stats);
  // Some models leave the first manifest entries empty even though the page
  // cards contain the stem and options. Recover those fields from the rendered
  // HTML before validating; this keeps a complete page from being discarded.
  if (manifest) {
    const repair = repairQuizManifestFromHtml(manifest, output);
    stats.manifestRepaired = repair.repaired;
  }
  // Keep the manifest byte-for-byte semantic after the HTML transforms above;
  // formatCodeBlocks/inlineImages must not rewrite JSON stored in the page.
  if (manifest) {
    const withoutManifest = output.replace(
      /<script\b[^>]*\bid\s*=\s*(["'])quiz-manifest\1[^>]*>[\s\S]*?<\/script\s*>/gi,
      "",
    );
    output = /<\/head>/i.test(withoutManifest)
      ? withoutManifest.replace(/<\/head>/i, `${quizManifestScript(manifest)}</head>`)
      : `${quizManifestScript(manifest)}${withoutManifest}`;
  }
  const validation = manifest
    ? validateQuizManifest(manifest, {
      html: output,
      checkHtml: true,
      checkContent: true,
      allowMissingAnswers: true,
      requireAnswers: !plain,
    })
    : { ok: false, errors: ["quiz-manifest is missing"] };
  stats.manifest = Boolean(manifest);
  stats.manifestQuestions = Array.isArray(manifest?.questions) ? manifest.questions.length : 0;
  stats.manifestErrors = validation.errors;
  stats.manifestContentErrors = validation.contentErrors || [];
  stats.manifestWarnings = validation.warnings || [];
  stats.manifestGrading = plain ? "ai" : "local";
  if (plain) {
    const plainStyle = `<style data-qbr-plain>
[data-qbr-grading="ai"] .solution,
[data-qbr-grading="ai"] .analysis,
[data-qbr-grading="ai"] .q-explain,
[data-qbr-grading="ai"] [data-source="generated"],
[data-qbr-grading="ai"] [data-quiz-answer] { display: none !important; }
</style>`;
    output = /<\/head>/i.test(output) ? output.replace(/<\/head>/i, `${plainStyle}</head>`) : `${plainStyle}${output}`;
    output = /<body\b/i.test(output)
      ? output.replace(/<body\b([^>]*)>/i, (tag, attrs) => `<body${/\bdata-qbr-grading\s*=/.test(attrs) ? attrs : `${attrs} data-qbr-grading="ai"`}>`)
      : output.replace(/<html\b([^>]*)>/i, (tag, attrs) => `<html${attrs} data-qbr-grading="ai">`);
  }
  if (!/data-qbr-quiz-layout/i.test(output)) {
    const layout = quizLayoutStyle();
    output = /<\/head>/i.test(output) ? output.replace(/<\/head>/i, `${layout}</head>`) : `${layout}${output}`;
  }
  if (manifest) {
    const guard = quizManifestGuardScript();
    output = /<\/body>/i.test(output) ? output.replace(/<\/body>/i, `${guard}</body>`) : `${output}${guard}`;
  }
  return { html: output, stats };
}

// LLM 答题页的应用主进程适配:提示词、HTML 提取、MathML/代码/图片收尾。
// 不依赖 jsdom:jsdom 打包进 Electron 主进程会去读 browser/default-stylesheet.css,
// 离线安装包没有这个文件,所以这里用受控的字符串处理,只改公式/代码/图片/答案块。
import fs from "node:fs";
import path from "node:path";

import temml from "temml";

import { QUIZ_LLM_PROMPT } from "../../../../packages/reader/src/quiz-llm-prompt.js";
import { extractQuizManifest, quizLayoutStyle, quizManifestGuardScript, quizManifestScript, validateQuizManifest } from "../../../../packages/reader/src/quiz-manifest.js";

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function buildQuizLlmPrompt(markdown) {
  return QUIZ_LLM_PROMPT.replace("{{MARKDOWN}}", () => String(markdown || ""));
}

export function extractQuizLlmHtml(raw) {
  let value = String(raw || "").trim();
  const fence = /^```(?:html)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  if (fence) value = fence[1].trim();
  const start = value.search(/<!doctype\s+html/i);
  const html = start >= 0 ? value.slice(start) : value;
  const end = html.search(/<\/html\s*>/i);
  if (end >= 0) return `${html.slice(0, end + "</html>".length)}\n`;
  return html;
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
    return temml.renderToString(unescapeHtml(latex), { displayMode, throwOnError: false });
  } catch {
    stats.mathFailed += 1;
    return "";
  }
}

function mathInText(text, stats) {
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  return text.replace(re, (full, display, inline, paren, bracket) => {
    const latex = String(display ?? inline ?? paren ?? bracket ?? "").trim();
    if (!latex) return full;
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

export function postprocessQuizLlmHtml(html, { baseDir = "", dropImages = [] } = {}) {
  const stats = {
    math: 0,
    mathFailed: 0,
    code: 0,
    codeSkipped: 0,
    generatedHidden: 0,
    missingElements: 0,
    imagesInlined: 0,
    imagesDropped: 0,
    imagesMissing: 0,
    blankSymbols: 0,
    inlineSolutions: 0,
  };
  let output = String(html || "");
  const manifest = extractQuizManifest(output);
  output = convertMathOutsideProtectedTags(output, stats);
  output = formatCodeBlocks(output, stats);
  output = decorateBlanks(output, stats);
  output = addMissingElements(output, stats);
  output = liftInlineSolutions(output, stats);
  output = hideGenerated(output, stats);
  output = enhanceQuizUi(output);
  output = inlineImages(output, { baseDir, dropImages }, stats);
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
    ? validateQuizManifest(manifest, { html: output, checkHtml: true, allowMissingAnswers: true })
    : { ok: false, errors: ["quiz-manifest is missing"] };
  stats.manifest = Boolean(manifest);
  stats.manifestErrors = validation.errors;
  stats.manifestWarnings = validation.warnings || [];
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

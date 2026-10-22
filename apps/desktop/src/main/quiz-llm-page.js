// LLM 答题页的应用主进程适配:提示词、HTML 提取、MathML/代码/图片收尾。
// 不依赖 jsdom:jsdom 打包进 Electron 主进程会去读 browser/default-stylesheet.css,
// 离线安装包没有这个文件,所以这里用受控的字符串处理,只改公式/代码/图片/答案块。
import fs from "node:fs";
import path from "node:path";

import temml from "temml";

import { QUIZ_LLM_PROMPT } from "../../../../packages/reader/src/quiz-llm-prompt.js";

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
    if (!/#\s*include|using\s+namespace|int\s+main\s*\(|\bfor\s*\(|\bwhile\s*\(/.test(code)) return full;
    const formatted = formatCode(code);
    if (formatted === code) return full;
    stats.code += 1;
    return `<pre${attrs}>${escapeHtml(formatted)}</pre>`;
  });
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
    document.addEventListener('click', function(event){
      var button = event.target && event.target.closest ? event.target.closest('button') : null;
      if (button && /交卷|提交/.test(button.textContent || '')) setTimeout(reveal, 0);
    }, true);
  })();</script>`;
  output = output.replace(/<\/head>/i, `${style}</head>`);
  if (!/<style data-llm-generated-hidden>/i.test(output)) output = `${style}${output}`;
  output = output.replace(/<\/body>/i, `${script}</body>`);
  if (!/<\/body>/i.test(output)) output += script;
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
  };
  let output = String(html || "");
  output = convertMathOutsideProtectedTags(output, stats);
  output = formatCodeBlocks(output, stats);
  output = addMissingElements(output, stats);
  output = hideGenerated(output, stats);
  output = inlineImages(output, { baseDir, dropImages }, stats);
  return { html: output, stats };
}

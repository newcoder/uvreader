#!/usr/bin/env node
// 把 LLM 生成的答题页做确定性收尾:公式 MathML + 代码缩进。
// 不修改原始 page.html;输出 page.post.html。
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import temml from "temml";

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

function replaceMath(node, doc, stats) {
  const raw = node.nodeValue;
  if (!raw || !(raw.includes("$") || raw.includes("\\(") || raw.includes("\\["))) return;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  let cursor = 0;
  let match;
  let changed = false;
  const holder = doc.createElement("span");
  while ((match = re.exec(raw))) {
    const latex = String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!latex) continue;
    try {
      const display = Boolean(match[1] || match[4]);
      const math = temml.renderToString(latex, { displayMode: display, throwOnError: false });
      holder.appendChild(doc.createTextNode(raw.slice(cursor, match.index)));
      const template = doc.createElement("template");
      template.innerHTML = math;
      holder.appendChild(template.content.cloneNode(true));
      cursor = match.index + match[0].length;
      changed = true;
      stats.math += 1;
    } catch {
      stats.mathFailed += 1;
    }
  }
  if (!changed) return;
  holder.appendChild(doc.createTextNode(raw.slice(cursor)));
  node.parentNode.replaceChild(holder, node);
}

function walk(node, doc, stats) {
  if (node.nodeType === 3) {
    const tag = String(node.parentElement?.tagName || "").toLowerCase();
    if (["script", "style", "pre", "code", "math", "textarea"].includes(tag)) return;
    replaceMath(node, doc, stats);
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = String(node.tagName || "").toLowerCase();
  if (["script", "style", "pre", "code", "math", "textarea"].includes(tag)) return;
  for (const child of [...node.childNodes]) walk(child, doc, stats);
}

function formatCodeBlocks(doc, stats) {
  for (const pre of [...doc.querySelectorAll("pre")]) {
    const code = pre.textContent || "";
    if (!code.trim()) continue;
    if (/算法\s|伪代码|输入:\s*数组/.test(code)) {
      stats.codeSkipped += 1;
      continue;
    }
    const looksCpp = /#\s*include|using\s+namespace|int\s+main\s*\(|\bfor\s*\(|\bwhile\s*\(/.test(code);
    if (!looksCpp) continue;
    const formatted = formatCode(code);
    if (formatted !== code) {
      pre.textContent = formatted;
      stats.code += 1;
    }
  }
}

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const outFlag = args.indexOf("--out");
const output = outFlag >= 0 ? args[outFlag + 1] : input.replace(/\.html?$/i, ".post.html");
if (!input || !fs.existsSync(input)) {
  console.error("用法: node scripts/quiz-llm-postprocess.mjs <page.html> [--out page.post.html]");
  process.exit(1);
}
const dom = new JSDOM(fs.readFileSync(input, "utf8"));
const doc = dom.window.document;
const stats = { math: 0, mathFailed: 0, code: 0, codeSkipped: 0 };
walk(doc.body, doc, stats);
formatCodeBlocks(doc, stats);
fs.writeFileSync(output, dom.serialize(), "utf8");
console.log(JSON.stringify({ input: path.resolve(input), output: path.resolve(output), ...stats }, null, 2));

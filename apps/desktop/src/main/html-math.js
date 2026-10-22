// Content extraction writes HTML for a human to open directly, but pdf_tool's
// HTML keeps MinerU's LaTeX as literal `$…$` text (unlike the Markdown preview,
// which renders it). Render those formulas to MathML in the exported file so
// opening the HTML needs no CDN, script, or Markdown preview.
//
// The reader's AI/quiz pages already use MathML; this module keeps content
// extraction on the same offline path. DocVortex still receives the bridge HTML
// with `<script type="math/tex">`, so only final products go through here.
import fs from "node:fs";

import temml from "temml";
import { escapeHtml, stripMathDelimiters } from "./formula-html.js";

const SKIP_TAGS = new Set(["script", "style", "pre", "code", "textarea", "title", "math"]);

function decodeMathEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function mathMl(tex, display) {
  const latex = stripMathDelimiters(decodeMathEntities(tex));
  if (!latex) return "";
  try {
    let html = temml.renderToString(latex, { throwOnError: false, displayMode: display === true });
    html = html.replace(/<mtable/g, '<mtable rowspacing="0.4em"');
    return html;
  } catch {
    return `<span class="math-raw">${escapeHtml(latex)}</span>`;
  }
}

// Replace the script tags produced by formula-html.js before scanning text
// nodes. The type attribute is the contract DocVortex understands.
function replaceMathScripts(html) {
  return String(html || "").replace(
    /<script\b[^>]*\btype\s*=\s*(["'])math\/tex([^"']*)\1[^>]*>([\s\S]*?)<\/script>/gi,
    (_match, _quote, mode, tex) => mathMl(tex, /mode\s*=\s*display/i.test(mode)),
  );
}

function isInlineMath(tex) {
  const value = decodeMathEntities(tex).trim();
  if (!value) return false;
  // MinerU wraps real formulas in `$…$`; prose with dollar amounts can look
  // like `$5 and $10`. A space-bearing token without any TeX/operator signal
  // is much more likely currency than a formula.
  if (!/\s/.test(value)) return true;
  return /[\\^_{}=+\-*/<>]/.test(value);
}

function renderTextSegment(text) {
  let out = "";
  let last = 0;
  // Display delimiters first: `$$…$$` may contain newlines, while inline math
  // is deliberately kept to one line so ordinary prose with a stray dollar is
  // not swallowed.
  const re = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\)/g;
  for (const match of String(text || "").matchAll(re)) {
    out += text.slice(last, match.index);
    const token = match[0];
    if (token.startsWith("$$") || token.startsWith("\\[")) {
      out += mathMl(token.slice(2, -2), true);
    } else if (token.startsWith("\\(")) {
      out += mathMl(token.slice(2, -2), false);
    } else if (isInlineMath(token.slice(1, -1))) {
      out += mathMl(token.slice(1, -1), false);
    } else {
      out += token;
    }
    last = match.index + token.length;
  }
  return out + text.slice(last);
}

// Walk outside tags and raw-text elements. Attributes and code blocks must not
// be touched; only visible text can contain MinerU's formula delimiters.
function renderTextNodes(html) {
  let out = "";
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt < 0) {
      out += renderTextSegment(html.slice(index));
      break;
    }
    out += renderTextSegment(html.slice(index, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) {
        out += html.slice(lt);
        break;
      }
      out += html.slice(lt, end + 3);
      index = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    const tag = html.slice(lt, gt + 1);
    out += tag;
    const match = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(tag);
    if (match && !match[1] && !/\/\s*>$/.test(tag)) {
      const name = match[2].toLowerCase();
      if (SKIP_TAGS.has(name)) {
        const closeStart = html.toLowerCase().indexOf(`</${name}`, gt + 1);
        if (closeStart >= 0) {
          const closeEnd = html.indexOf(">", closeStart);
          if (closeEnd >= 0) {
            out += html.slice(gt + 1, closeEnd + 1);
            index = closeEnd + 1;
            continue;
          }
        }
      }
    }
    index = gt + 1;
  }
  return out;
}

export function renderMathInHtml(html) {
  return renderTextNodes(replaceMathScripts(html));
}

// Rewrite one exported HTML file in place. A failed formula stays readable raw
// TeX rather than breaking the extraction task; the caller only logs failures.
export function rewriteHtmlMath(file, { log = () => {} } = {}) {
  if (!file || !/\.html?$/i.test(String(file))) return false;
  try {
    const before = fs.readFileSync(file, "utf8");
    const after = renderMathInHtml(before);
    if (after !== before) {
      fs.writeFileSync(file, after, "utf8");
      log("html math rendered", file);
    }
    return true;
  } catch (error) {
    log("html math render failed", file, String(error?.message || error));
    return false;
  }
}

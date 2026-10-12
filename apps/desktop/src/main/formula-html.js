// MinerU 的 Doc v1 JSON → 带公式标记的 HTML(DocVortex 桥)。
//
// DocVortex 识别静态 HTML 里的 `<script type="math/tex">`(行内)与
// `<script type="math/tex; mode=display">`(行间),经 latex2mathml → mathml2omml
// 写进 DOCX 真公式、EPUB 输出 MathML(见 docs/workshop.md §8.1)。本模块只做
// 纯文本变换,便于单测;图片保持相对路径,和 Doc JSON 同目录写出即可被解析。
import { looksLikeProseBlock } from "../shared/markdown-fix.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// MinerU 的公式块自带 $$…$$ / \[…\] / \(…\) 定界符,取内部 LaTeX。
export function stripMathDelimiters(value) {
  const text = String(value ?? "").trim();
  const pairs = [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

function scriptTag(latex, display) {
  // `</script` 会提前结束脚本元素;LaTeX 里不会出现,防御性转义。
  const body = String(latex).replace(/<\/script/gi, "<\\/script");
  return `<script type="math/tex${display ? "; mode=display" : ""}">${body}</script>`;
}

const INLINE_MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

// 文本里的 $…$ / $$…$$ → 行内/行间公式 script;其余部分转义。
export function wrapInlineMath(value) {
  const raw = String(value ?? "");
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(INLINE_MATH_RE)) {
    out += escapeHtml(raw.slice(last, match.index));
    out += scriptTag(stripMathDelimiters(match[0]), match[1] !== undefined);
    last = match.index + match[0].length;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

// PDF 的硬换行并回一段:「for\n10 min」→ 空格;「61.\n91」这种被断开的数字直接粘回。
export function joinProseLines(value) {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let out = "";
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    const glued = /[\d.]$/.test(out) && /^\d/.test(line);
    out += (glued ? "" : " ") + line;
  }
  return out;
}

// 块自带的 caption:MinerU 偶尔把段落的前半段塞进 code 块的 caption(两栏论文实测),
// 图片块则是图注——两者都要带上,否则内容会缺。
export function blockCaption(block) {
  return String(block?.caption || "").trim();
}

// MinerU 偶尔把正文段落判成 code 块:内容(含 caption)像正文时按段落渲染(里面的公式
// 照常转换),真代码保持 <pre><code>(有 caption 时先出一段说明)。
export function codeBlockHtml(block) {
  const content = String(block?.content ?? block?.code ?? "");
  const caption = blockCaption(block);
  const combined = caption ? [caption, content].filter(Boolean).join("\n") : content;
  if (looksLikeProseBlock(combined)) return `<p>${wrapInlineMath(joinProseLines(combined))}</p>`;
  const pre = `<pre><code>${escapeHtml(content)}</code></pre>`;
  return caption ? `<p>${wrapInlineMath(joinProseLines(caption))}</p>\n${pre}` : pre;
}

function cellText(cell) {
  if (cell && typeof cell === "object") return String(cell.text ?? cell.content ?? "");
  return String(cell ?? "");
}

function tableHtml(block) {
  const table = block.table && typeof block.table === "object" ? block.table : block;
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const head = headers.length
    ? `<thead><tr>${headers.map((cell) => `<th>${wrapInlineMath(cellText(cell))}</th>`).join("")}</tr></thead>`
    : "";
  const body = rows
    .map((row) => `<tr>${(Array.isArray(row) ? row : []).map((cell) => `<td>${wrapInlineMath(cellText(cell))}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function imageHtml(image, fallbackAlt = "") {
  const src = String(image?.src || "");
  if (!src) return "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(image?.alt || fallbackAlt)}">`;
}

function questionHtml(block) {
  const parts = [];
  const number = String(block.number || "").trim();
  const stem = String(block.stem ?? block.text ?? "");
  parts.push(`<p><b>${escapeHtml(number ? `${number}. ` : "")}</b>${wrapInlineMath(stem)}</p>`);
  const options = Array.isArray(block.options) ? block.options : Object.values(block.options || {});
  for (const option of options) {
    const text = option && typeof option === "object" ? String(option.text ?? option.option_text ?? "") : String(option ?? "");
    parts.push(`<p>${wrapInlineMath(text)}</p>`);
  }
  if (block.answer) parts.push(`<p>答案：${wrapInlineMath(block.answer)}</p>`);
  if (block.explanation) parts.push(`<p>解析：${wrapInlineMath(block.explanation)}</p>`);
  return parts.join("\n");
}

// Doc v1 的块 → HTML 片段(公式优先,图片兜底)。
export function blockToHtml(block) {
  const type = String(block?.type || "text");
  if (type === "heading") {
    const level = Math.min(Math.max(Number(block.level) || 2, 1), 6);
    return `<h${level}>${wrapInlineMath(block.text)}</h${level}>`;
  }
  if (type === "equation") {
    const latex = stripMathDelimiters(block.text ?? block.latex ?? "");
    const image = imageHtml(block.image, "公式");
    if (latex) return `<p>${scriptTag(latex, true)}</p>`;
    return image ? `<p>${image}</p>` : "";
  }
  if (type === "table") return tableHtml(block);
  if (type === "image") {
    const image = imageHtml(block.image, block.alt || "");
    if (!image) return "";
    const caption = blockCaption(block);
    return `<figure>${image}${caption ? `<figcaption>${wrapInlineMath(joinProseLines(caption))}</figcaption>` : ""}</figure>`;
  }
  if (type === "code") return codeBlockHtml(block);
  if (type === "question") return questionHtml(block);
  const text = block?.text ?? block?.content ?? "";
  return String(text).trim() ? `<p>${wrapInlineMath(text)}</p>` : "";
}

// Doc v1 → 扁平块(按页顺序;补上 1 基页码,文字层互补与补 caption 都要用)。
export function blocksFromDoc(doc) {
  const out = [];
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  for (let index = 0; index < pages.length; index += 1) {
    const blocks = Array.isArray(pages[index]?.blocks) ? pages[index].blocks : [];
    for (const block of blocks) {
      if (block && typeof block === "object") out.push({ ...block, page: Number(block.page) || index + 1 });
    }
  }
  return out;
}

export function blocksToHtml(blocks, { title = "" } = {}) {
  const body = (Array.isArray(blocks) ? blocks : [])
    .map((block) => blockToHtml(block))
    .filter((html) => html.trim());
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

// Doc v1 块 → Markdown(与 blocksToHtml 同一套语义:公式留 LaTeX、图片保持相对路径,
// 被判成 code 的正文按段落还原)。
export function blockToMarkdown(block) {
  const type = String(block?.type || "text");
  if (type === "heading") {
    const level = Math.min(Math.max(Number(block.level) || 2, 1), 6);
    const text = String(block.text || "").trim();
    return text ? `${"#".repeat(level)} ${text}` : "";
  }
  if (type === "equation") {
    const latex = stripMathDelimiters(block.text ?? block.latex ?? "");
    return latex ? `$$${latex}$$` : "";
  }
  if (type === "table") {
    const table = block.table && typeof block.table === "object" ? block.table : block;
    const headers = Array.isArray(table.headers) ? table.headers : [];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const lines = [];
    if (headers.length) lines.push(`| ${headers.map((cell) => cellText(cell)).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) lines.push(`| ${(Array.isArray(row) ? row : []).map((cell) => cellText(cell)).join(" | ")} |`);
    return lines.join("\n");
  }
  if (type === "image") {
    const src = String(block.image?.src || "");
    return src ? `![${String(block.image?.alt || block.alt || "")}](${src})` : "";
  }
  if (type === "code") {
    const content = String(block?.content ?? block?.code ?? "");
    const caption = blockCaption(block);
    const combined = caption ? [caption, content].filter(Boolean).join("\n") : content;
    return looksLikeProseBlock(combined) ? joinProseLines(combined) : `\`\`\`\n${content}\n\`\`\``;
  }
  const text = block?.text ?? block?.content ?? "";
  return String(text).trim();
}

export function blocksToMarkdown(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => blockToMarkdown(block))
    .filter((chunk) => chunk.trim())
    .join("\n\n");
}

// MinerU 的 Doc v1 JSON → 带公式标记的 HTML(DocVortex 桥)。
//
// DocVortex 识别静态 HTML 里的 `<script type="math/tex">`(行内)与
// `<script type="math/tex; mode=display">`(行间),经 latex2mathml → mathml2omml
// 写进 DOCX 真公式、EPUB 输出 MathML(见 docs/workshop.md §8.1)。本模块只做
// 纯文本变换,便于单测;图片保持相对路径,和 Doc JSON 同目录写出即可被解析。
import { looksLikeProseBlock } from "../shared/markdown-fix.js";

// 表格怎么给:HTML / LaTeX 目标用真表格,DOCX / PDF 用表格截图
// (DocVortex 的 docx 渲染器无法从 HTML 物化表格,pdf 会静默丢内容)。
export function tableModeFor(format) {
  return ["docx", "pdf"].includes(String(format || "").toLowerCase()) ? "image" : "table";
}

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

// DocVortex 认这类 script 标签:行内 `<script type="math/tex">`、行间 `…; mode=display`。
// 公式桥(文本 → HTML)与公式提取(path→HTML)都用它,别各写一份。
export function mathScript(latex, display) {
  // `</script` 会提前结束脚本元素;LaTeX 里不会出现,防御性转义。
  const body = String(latex).replace(/<\/script/gi, "<\\/script");
  return `<script type="math/tex${display ? "; mode=display" : ""}">${body}</script>`;
}

const INLINE_MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

// MinerU 的 page_footnote 有时只剩公式定界符(「||」—— 内容在上游就丢了):这类残片
// 在成品里只是噪声(实测 Notes_Boltzmann 8 处),清掉;其余文本原样保留。
export function cleanFootnoteText(text) {
  return String(text ?? "")
    .replace(/\|\|+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 文本里的 $…$ / $$…$$ → 行内/行间公式 script;其余部分转义。
export function wrapInlineMath(value) {
  const raw = String(value ?? "");
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(INLINE_MATH_RE)) {
    out += escapeHtml(raw.slice(last, match.index));
    out += mathScript(stripMathDelimiters(match[0]), match[1] !== undefined);
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

// 表格截图兜底:DocVortex 的 DOCX 渲染器不支持从 HTML 物化表格(直接报错),
// PDF 渲染器会静默丢掉表格内容——这两个目标改用 MinerU 给的表格截图。
function tableImageHtml(block) {
  const image = imageHtml(block.image, "表格");
  if (!image) return "";
  const caption = blockCaption(block);
  return `<figure>${image}${caption ? `<figcaption>${wrapInlineMath(joinProseLines(caption))}</figcaption>` : ""}</figure>`;
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
// tableMode:"table" 输出真表格(HTML/LaTeX 目标),"image" 输出表格截图(DOCX/PDF)。
export function blockToHtml(block, { tableMode = "table" } = {}) {
  const type = String(block?.type || "text");
  if (type === "heading") {
    const level = Math.min(Math.max(Number(block.level) || 2, 1), 6);
    return `<h${level}>${wrapInlineMath(block.text)}</h${level}>`;
  }
  if (type === "equation") {
    const latex = stripMathDelimiters(block.text ?? block.latex ?? "");
    const image = imageHtml(block.image, "公式");
    if (latex) return `<p>${mathScript(latex, true)}</p>`;
    return image ? `<p>${image}</p>` : "";
  }
  if (type === "table") {
    const image = tableMode === "image" ? tableImageHtml(block) : "";
    return image || tableHtml(block);
  }
  if (type === "image") {
    const image = imageHtml(block.image, block.alt || "");
    if (!image) return "";
    const caption = blockCaption(block);
    return `<figure>${image}${caption ? `<figcaption>${wrapInlineMath(joinProseLines(caption))}</figcaption>` : ""}</figure>`;
  }
  if (type === "code") return codeBlockHtml(block);
  if (type === "question") return questionHtml(block);
  // 脚注(MinerU 的 page_footnote):单独成引用块,别混进正文段落。
  if (type === "page_footnote" || type === "footnote") {
    const note = String(block?.text ?? "").trim();
    return note ? `<blockquote class="docvortex-footnote">${wrapInlineMath(note)}</blockquote>` : "";
  }
  const text = block?.text ?? block?.content ?? "";
  if (!String(text).trim()) return "";
  // PDF 的「程序清单」偶尔被判成 text 块:HTML 的 <p> 会把换行压成一行,
  // 至少要把原始换行保住(getBlockHtml 转 DOCX 时 <br> 也会变软换行)。
  const inline = wrapInlineMath(text);
  return `<p>${inline.includes("\n") ? inline.replace(/\n/g, "<br>") : inline}</p>`;
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

export function blocksToHtml(blocks, { title = "", tableMode = "table" } = {}) {
  const body = (Array.isArray(blocks) ? blocks : [])
    .map((block) => blockToHtml(block, { tableMode }))
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
export function blockToMarkdown(block, { tableMode = "table" } = {}) {
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
    // 电子书里表格截图更可靠(我们的流式排版不做复杂表格);.md 产物默认保留管道表格。
    if (tableMode === "image" && block.image?.src) return `![表格](${String(block.image.src)})`;
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
  // 脚注原样保留(引用块);上游丢内容只剩「||」的残片清掉。
  // 不再附「（第 N 页）」:页码是给"对回原书"用的内部信息,读者看到的是噪声(用户实测)。
  if (type === "page_footnote" || type === "footnote") {
    const note = cleanFootnoteText(String(block?.text ?? "").replace(/\s*\n\s*/g, " ").trim());
    if (!note) return "";
    return `> ${note}`;
  }
  const text = block?.text ?? block?.content ?? "";
  return String(text).trim();
}

export function blocksToMarkdown(blocks, { tableMode = "table" } = {}) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => blockToMarkdown(block, { tableMode }))
    .filter((chunk) => chunk.trim())
    .join("\n\n");
}

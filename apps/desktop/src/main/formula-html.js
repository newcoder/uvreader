// MinerU 的 Doc v1 JSON → 带公式标记的 HTML(DocVortex 桥)。
//
// DocVortex 识别静态 HTML 里的 `<script type="math/tex">`(行内)与
// `<script type="math/tex; mode=display">`(行间),经 latex2mathml → mathml2omml
// 写进 DOCX 真公式、EPUB 输出 MathML(见 docs/workshop.md §8.1)。本模块只做
// 纯文本变换,便于单测;图片保持相对路径,和 Doc JSON 同目录写出即可被解析。
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
    return image ? `<figure>${image}</figure>` : "";
  }
  if (type === "code") return `<pre><code>${escapeHtml(block.content ?? block.code ?? "")}</code></pre>`;
  if (type === "question") return questionHtml(block);
  const text = block?.text ?? block?.content ?? "";
  return String(text).trim() ? `<p>${wrapInlineMath(text)}</p>` : "";
}

// Doc v1 → 扁平块(按页顺序)。
export function blocksFromDoc(doc) {
  const out = [];
  for (const page of Array.isArray(doc?.pages) ? doc.pages : []) {
    for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
      if (block && typeof block === "object") out.push(block);
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

// 书坊:纯文本 / Markdown → 章节 HTML(电子书制作的输入适配)。
// 分章规则:识别「第X章/回/卷/篇」「Chapter N」「序章/楔子/后记…」等标题行;
// 没有标题时按长度分块,保证纯 txt 也能成书。

const HEADING_RE = /^(?:#{1,4}\s+)?(第[零一二三四五六七八九十百千万〇0-9]{1,10}[章节回卷篇部集幕]|Chapter\s+[0-9IVXLC]+|序章|序言|前言|引子|楔子|后记|尾声|终章|番外|附录|参考文献)(?:[\s:：.、-].*)?$/i;

export function isChapterHeading(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.length > 30) return false;
  return HEADING_RE.test(trimmed) || /^#{1,4}\s+\S/.test(trimmed);
}

function headingTitle(line) {
  return String(line || "").trim().replace(/^#{1,4}\s+/, "").replace(/[\s:：]+$/, "").slice(0, 80);
}

function chunkByLength(text, size = 4000) {
  const source = String(text || "").trim();
  const chapters = [];
  let index = 0;
  while (index < source.length) {
    let end = Math.min(source.length, index + size);
    if (end < source.length) {
      const next = source.indexOf("\n", end);
      if (next > 0 && next - end < 400) end = next;
    }
    chapters.push({ title: `第 ${chapters.length + 1} 部分`, body: source.slice(index, end).trim() });
    index = end;
  }
  return chapters.filter((chapter) => chapter.body);
}

export function splitTextChapters(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const chapters = [];
  let current = { title: "", lines: [] };
  let sawHeading = false;
  const push = () => {
    const body = current.lines.join("\n").trim();
    if (body) chapters.push({ title: current.title || `第 ${chapters.length + 1} 节`, body });
    current = { title: "", lines: [] };
  };
  for (const line of lines) {
    if (isChapterHeading(line)) {
      sawHeading = true;
      push();
      current.title = headingTitle(line);
      continue;
    }
    current.lines.push(line);
  }
  push();
  if (!sawHeading) {
    const chunks = chunkByLength(text);
    if (chunks.length) return chunks;
  }
  return chapters;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}"/>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return html;
}

// 数学片段:$…$ / $$…$$ / \(…\) / \[…\](渲染交给 renderMath;没有回调时保留原样)。
const MATH_SEGMENT_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

export function isMathSegment(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  // 用「整段锚定」的新正则判断,避免污染共享正则的 lastIndex(inlineWithMath 还要用它扫描)。
  return new RegExp(`^(?:${MATH_SEGMENT_RE.source})$`).test(raw);
}

function inlineWithMath(text, renderMath) {
  const raw = String(text ?? "");
  if (!renderMath || !raw.includes("$") && !raw.includes("\\(") && !raw.includes("\\[")) {
    return inlineMarkdown(raw);
  }
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(MATH_SEGMENT_RE)) {
    out += inlineMarkdown(raw.slice(last, match.index));
    const latex = String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    const display = match[1] !== undefined || match[2] !== undefined;
    const rendered = latex ? renderMath(latex, display) : "";
    out += rendered || escapeHtml(match[0]);
    last = match.index + match[0].length;
  }
  out += inlineMarkdown(raw.slice(last));
  return out;
}

// 纯文本段落 → HTML(空行分段,单换行并成一行)。
export function textToHtml(text) {
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return blocks
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean).join(""))
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

// 最小 Markdown → HTML:标题/段落/列表/引用/代码块/图片/链接/强调/管道表格。
// options.renderMath(latex, display) 返回公式 HTML;缺省时公式按原文保留。
export function markdownToHtml(markdown, options = {}) {
  const renderMath = typeof options.renderMath === "function" ? options.renderMath : null;
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // "ul" | "ol"
  let fence = null;
  let table = null; // { head: string[] | null, rows: string[][] }

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(" ");
    paragraph = [];
    // 整段就是一条行间公式时不包 <p>,直接输出块级公式。
    if (renderMath && isMathSegment(joined)) {
      const latex = joined.replace(/^\s*\$\$|\$\$\s*$|^\s*\\\[|\\\]\s*$/g, "").trim();
      const rendered = latex ? renderMath(latex, true) : "";
      if (rendered) {
        out.push(rendered);
        return;
      }
    }
    out.push(`<p>${inlineWithMath(joined, renderMath)}</p>`);
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeTable = () => {
    if (!table) return;
    const head = table.head || table.rows.shift() || [];
    const body = table.rows;
    const cell = (tag, value) => `<${tag}>${inlineWithMath(value, renderMath)}</${tag}>`;
    const headHtml = head.length ? `<thead><tr>${head.map((value) => cell("th", value)).join("")}</tr></thead>` : "";
    const bodyHtml = body
      .map((row) => `<tr>${head.map((_value, index) => cell("td", row[index] ?? "")).join("")}</tr>`)
      .join("");
    out.push(`<table>${headHtml}<tbody>${bodyHtml}</tbody></table>`);
    table = null;
  };
  const tableCells = (line) => {
    const match = line.trim().match(/^\|(.+)\|$/);
    if (!match) return null;
    return match[1].split("|").map((value) => value.trim());
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (fence) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
        fence = null;
      } else {
        fence.lines.push(raw);
      }
      continue;
    }
    const cells = tableCells(line);
    if (!cells && table) closeTable();
    if (cells) {
      flushParagraph();
      closeList();
      if (!table) table = { head: null, rows: [] };
      if (cells.every((value) => /^:?-{2,}:?$/.test(value))) table.head = table.rows.pop() || [];
      else table.rows.push(cells);
      continue;
    }
    const fenceStart = line.trim().match(/^```/);
    if (fenceStart) {
      flushParagraph();
      closeList();
      fence = { lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inlineWithMath(heading[2].trim(), renderMath)}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out.push("<hr/>");
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      out.push(`<blockquote><p>${inlineWithMath(quote[1], renderMath)}</p></blockquote>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.、]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ordered || bullet) {
      flushParagraph();
      const kind = ordered ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inlineWithMath((ordered || bullet)[1], renderMath)}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  flushParagraph();
  closeList();
  closeTable();
  return out.join("\n");
}

// 文本 → 章节(标题 + HTML 正文);markdown 输入按 markdown 渲染,否则纯文本段落。
export function textToChapters(text, { markdown = false, title = "" } = {}) {
  const chapters = splitTextChapters(text);
  return chapters.map((chapter, index) => ({
    title: chapter.title || title || `第 ${index + 1} 章`,
    text: chapter.body,
    html: markdown ? markdownToHtml(chapter.body) : textToHtml(chapter.body),
  }));
}

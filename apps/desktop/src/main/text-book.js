// 书坊:纯文本 / Markdown → 章节 HTML(电子书制作的输入适配)。
// 分章规则:识别「第X章/回/卷/篇」「Chapter N」「序章/楔子/后记…」等标题行;
// 没有标题时按长度分块,保证纯 txt 也能成书。

// Windows 记事本 / 部分导出工具会写 UTF-8 BOM:不剥掉的话第一个标题会被当成正文
// (md 的 `# 标题一` 落进段落、txt 的章节行分不出章)。
export function stripBom(text) {
  return String(text ?? "").replace(/^\uFEFF/, "");
}

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
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
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
  // 图注/链接文字里常带方括号(「!(b) [五]」「[引自 A. B. …]」),允许一层嵌套的 [ ]。
  html = html.replace(/!\[((?:[^[\]]|\[[^[\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}"/>`);
  html = html.replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
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

// 公式占位符用私用区字符:它不会出现在正文里,也不会被 Markdown 语法吃掉。
const MATH_SLOT = "\uE000";

function inlineWithMath(text, renderMath) {
  const raw = String(text ?? "");
  if (!renderMath || !raw.includes("$") && !raw.includes("\\(") && !raw.includes("\\[")) {
    return inlineMarkdown(raw);
  }
  // 图片 / 链接 / 强调都可能横跨公式,比如「![图 2.5 $\psi$ 对 $t$ 的变化](a.jpg)」。
  // 先把公式换成占位符、整行照常解析 Markdown,最后再把公式换回来;否则这类图片
  // 会被切成 `![图 2.5 ` + 公式 + ` 的变化](a.jpg)` 三段,图片引用直接消失。
  const rendered = [];
  const latexOnly = [];
  const masked = raw.replace(MATH_SEGMENT_RE, (whole, displayDollar, displayBracket, inlineDollar, inlineParen) => {
    const latex = String(displayDollar ?? displayBracket ?? inlineDollar ?? inlineParen ?? "").trim();
    const display = displayDollar !== undefined || displayBracket !== undefined;
    rendered.push((latex && renderMath(latex, display)) || escapeHtml(whole));
    latexOnly.push(escapeHtml(whole));
    return `${MATH_SLOT}${rendered.length - 1}${MATH_SLOT}`;
  });
  const html = inlineMarkdown(masked);
  // 属性值(alt / title)里放纯 LaTeX:MathML 塞进属性会把标签写坏。
  return html.replace(/alt="([^"]*)"|title="([^"]*)"|\uE000(\d+)\uE000/g, (whole, alt, title, index) => {
    if (index !== undefined) return rendered[Number(index)] || "";
    const value = alt ?? title ?? "";
    const name = alt !== undefined ? "alt" : "title";
    return `${name}="${value.replace(/\uE000(\d+)\uE000/g, (_slot, slot) => latexOnly[Number(slot)] || "")}"`;
  });
}

// 收集要送去渲染的公式:直接拿 markdownToHtml 跑一遍、把它请求的公式记下来,
// 这样「送去渲染的字符串」与「成书时查表的字符串」必然是同一批。
// 为什么必须这么做:中间稿里 `$$` 块有单行也有成对行两种写法,纯正则扫描会跨块
// 错配(把两个公式拼成一条怪物串),于是公式表里存的键和成书时查的键对不上,
// 上千条公式查不中、回退成原始 LaTeX(实测《光学》)。
export function collectMathFromMarkdown(markdown) {
  const seen = [];
  const collect = (latex) => {
    const value = String(latex ?? "").trim();
    if (value && !seen.includes(value)) seen.push(value);
    return "";
  };
  markdownToHtml(markdown, { renderMath: collect });
  return seen;
}

// 成品里还有多少公式没渲染成 MathML(用来判断「有没有漏」)。
// 代码块里的 $$ 是刻意保留的原文,不算漏;$$ / \tag{ / \( / \[ 都是漏渲染的信号。
export function countRawFormulas(html) {
  const prose = String(html || "")
    .replace(/<pre[\s\S]*?<\/pre>/gi, "")
    .replace(/<code[\s\S]*?<\/code>/gi, "");
  return (prose.match(/\$\$|\\tag\{|\\\(|\\\[/g) || []).length;
}

// 纯文本段落 → HTML(空行分段,单换行并成一行)。
export function textToHtml(text) {
  const blocks = stripBom(text).replace(/\r\n?/g, "\n").split(/\n{2,}/);
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
  const lines = stripBom(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // "ul" | "ol"
  let fence = null;
  let table = null; // { head: string[] | null, rows: string[][] }
  let displayQuote = null; // $$ 单独成行时的收集缓冲

  const flushParagraph = () => {
    if (!paragraph.length) return;
    // 段落不属于列表:先把列表收掉,否则 `<p>` 会落在 `<ol>`/`<ul>` 里 —— 不是合法
    // HTML,DocVortex 这类严格解析器会整段丢掉(中文技术稿「1. 标题 + 紧跟正文」很常见)。
    closeList();
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
  // $$ 单独成行的行间公式(中间可能夹着空行):渲染失败时把原文包回去,别丢内容。
  const pushDisplayMath = (latex) => {
    const value = String(latex || "").trim();
    if (!value) return;
    const rendered = renderMath ? renderMath(value, true) : "";
    out.push(rendered || `<p>${escapeHtml(`$$${value}$$`)}</p>`);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // pdf_tool 按页插入的锚点注释(<!--page:16--> / <!--page:16 printed:7-->):定位用,不进正文。
    if (/^<!--\s*page:\s*\d+(\s+printed:\s*\d+)?\s*-->$/.test(line.trim())) continue;
    if (displayQuote) {
      // $$ 单独成行时,行间的空行不该结束公式块(MinerU 会写成 $$ / 空行 / 公式 / 空行 / $$)。
      if (/^\s*\$\$\s*$/.test(line)) {
        pushDisplayMath(displayQuote.join(" "));
        displayQuote = null;
      } else if (line.trim()) {
        displayQuote.push(line.trim());
      }
      continue;
    }
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
    if (/^\s*\$\$\s*$/.test(line)) {
      // $$ 单独一行:开始收行间公式,直到下一个 $$ 行(空行不算结束)。
      flushParagraph();
      closeList();
      closeTable();
      displayQuote = [];
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
  if (displayQuote) pushDisplayMath(displayQuote.join(" "));
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

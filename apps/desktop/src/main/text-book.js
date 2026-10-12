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

// 纯文本段落 → HTML(空行分段,单换行并成一行)。
export function textToHtml(text) {
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return blocks
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean).join(""))
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

// 最小 Markdown → HTML:标题/段落/列表/引用/代码块/图片/链接/强调。
export function markdownToHtml(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // "ul" | "ol"
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
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
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
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
      out.push(`<blockquote><p>${inlineMarkdown(quote[1])}</p></blockquote>`);
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
      out.push(`<li>${inlineMarkdown((ordered || bullet)[1])}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  flushParagraph();
  closeList();
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

// 印刷目录(书里那几页「目录 / Contents」)的识别与去除。
//
// 电子书有自己的导航目录(EPUB nav),PDF 里那几页印刷目录就成了重复内容,而且
// 提取出来往往是「标题 …… 页码」的乱格式。这里给出纯函数的识别与去除:
//   - 整章都是目录 → 整章丢掉;
//   - 章节里夹着一段目录(如「前言 + 目录」)→ 只去掉那一段。
// 判定不看章节标题(有的书叫目录、目次、Contents,有的干脆没有标题),而是看内容:
// 大量短行以页码结尾(常带点线/省略号引导)。

const TOC_TITLE_RE = /^(目\s*录|目\s*次|contents|table of contents|inhalt|sommaire|índice)$/i;
// 「标题 …… 12」/「标题 ... 12」/「标题 ···· 12」:引导符后跟页码
const LEADER_RE = /(?:\.{2,}|…{2,}|·{2,}|_{2,}|-{2,})\s*\d{1,4}\s*$/;
// 「标题 12」:结尾是页码,且去掉页码后不像一句正文
const TRAILING_RE = /\s\d{1,4}\s*$/;
const SENTENCE_END_RE = /[。，、；：！？,.!?;:]$/;
const MAX_ENTRY_LENGTH = 120;

// 一行像不像目录条目。
export function looksLikeTocEntry(line) {
  const value = String(line || "").replace(/\s+$/, "").trim();
  if (!value || value.length > MAX_ENTRY_LENGTH) return false;
  if (/^#{1,6}\s/.test(value)) return false;
  if (/^[|>]/.test(value)) return false;
  const withoutPage = value.replace(TRAILING_RE, "").trim();
  if (!withoutPage) return false;
  if (LEADER_RE.test(value)) return true;
  if (!TRAILING_RE.test(value)) return false;
  if (SENTENCE_END_RE.test(withoutPage)) return false;
  return withoutPage.length >= 2;
}

function nonEmptyLines(text) {
  return String(text || "").split(/\r?\n/).filter((line) => line.trim());
}

// 一段文字里目录条目的比例。
export function tocRatio(text) {
  const lines = nonEmptyLines(text);
  if (!lines.length) return 0;
  return lines.filter((line) => looksLikeTocEntry(line)).length / lines.length;
}

// 整章是不是印刷目录:条目够多、比例够高;或标题就叫目录且不是空章。
// 没有「目录」标题时只在全书前置部分(前 20%)这么判 —— 后面章节里的
// 「编号 + 数字」很可能是正文/表格,不能当成目录误删。
export function isPrintedTocChapter(chapter, { frontMatter = false } = {}) {
  const title = String(chapter?.title || "").trim();
  const lines = nonEmptyLines(chapter?.text);
  if (!lines.length) return false;
  const entries = lines.filter((line) => looksLikeTocEntry(line)).length;
  if (TOC_TITLE_RE.test(title) && entries >= 2) return true;
  if (!frontMatter) return false;
  return entries >= 5 && entries / lines.length >= 0.5;
}

// 去掉章节里夹着的一段目录:只在「目录」标题行之后才删条目,别的地方一行不动
// (实测不加锚点会误删 46 章的正文行)。
export function stripTocBlock(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let removed = 0;
  let inBlock = false;
  for (const line of lines) {
    const isTitle = TOC_TITLE_RE.test(line.replace(/^#{1,6}\s*/, "").trim());
    if (isTitle) {
      inBlock = true;
      removed += 1;
      continue;
    }
    if (inBlock) {
      if (looksLikeTocEntry(line)) {
        removed += 1;
        continue;
      }
      if (!line.trim()) continue; // 目录条目之间常有空行
      inBlock = false;
    }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

// 章节数组 → 去掉印刷目录。返回 { chapters, dropped, removedLines }。
export function stripPrintedToc(chapters, { enabled = true } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!enabled) return { chapters: list, dropped: 0, removedLines: 0 };
  const kept = [];
  const frontLimit = Math.max(5, Math.ceil(list.length * 0.2));
  let dropped = 0;
  let removedLines = 0;
  list.forEach((chapter, index) => {
    if (isPrintedTocChapter(chapter, { frontMatter: index < frontLimit })) {
      dropped += 1;
      removedLines += nonEmptyLines(chapter.text).length;
      return;
    }
    const block = stripTocBlock(chapter.text);
    if (block.removed) removedLines += block.removed;
    kept.push(block.removed ? { ...chapter, text: block.text } : chapter);
  });
  // 全掉光了就还原(宁可留着难看,也不能出空书)。
  if (!kept.length) return { chapters: list, dropped: 0, removedLines: 0 };
  return { chapters: kept, dropped, removedLines };
}

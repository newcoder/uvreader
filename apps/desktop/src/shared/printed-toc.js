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

import { cleanChapterTitle } from "./markdown-fix.js";

// 解析印刷目录条目:把「1.1 开场白 …… 11」这类行拆成 { label, key, page, level }。
// label 保留原样(带编号,读者习惯看编号);key 去掉编号/点线/空白,用于和正文标题比对;
// level 由编号推断(第 N 章 / Chapter N → 1;N.M(.K…) → 深度 + 1;§ 或其它 → 2)。
export function parsePrintedTocEntries(text) {
  const entries = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "").trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    if (!looksLikeTocEntry(line)) continue;
    const page = Number((line.match(/(\d{1,4})\s*$/) || [])[1] || 0);
    const label = line
      .replace(/(?:\.{2,}|…{2,}|·{2,}|_{2,}|-{2,})\s*\d{1,4}\s*$/, "")
      .replace(/\s+\d{1,4}\s*$/, "")
      .trim();
    if (!label) continue;
    const key = tocKey(label);
    if (!key) continue;
    entries.push({ label, key, page, level: tocLevel(label) });
  }
  // 同一标题只留第一次出现(有的目录重复列小节)。
  const seen = new Set();
  return entries.filter((entry) => (seen.has(entry.key) ? false : (seen.add(entry.key), true)));
}

// 匹配用的键:去掉编号与**所有标点**(全角/半角、括号、点线),只留字母/数字/汉字,
// 这样「关于 EDVAC 报告的第一份草稿(节译)」与「…（节译）」也能对上。
export function tocKey(label) {
  return String(label || "")
    .replace(/^第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]\s*/, "")
    .replace(/^(?:chapter|part|section)\s+[0-9ivxlc]+[.、:]?\s*/i, "")
    .replace(/^[0-9]{1,3}(?:\.[0-9]{1,3})*[.、]?\s*/, "")
    .replace(/^§\s*[0-9]{1,3}[.、]?\s*/, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

// 层级:靠编号推断(印刷目录的缩进在纯文本里已经丢了)。**没有编号就按 1 级**,
// 宁可是平铺的目录,也不要猜错层级;上游给 toc_entries(带 level)时以它为准。
export function tocLevel(label) {
  const value = String(label || "").trim();
  if (/^第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]/.test(value)) return 1;
  if (/^(?:chapter|part)\s+[0-9ivxlc]+/i.test(value)) return 1;
  if (/^§/.test(value)) return 2; // § N 是节,不是章
  const numbered = value.match(/^([0-9]{1,3}(?:\.[0-9]{1,3})*)/);
  if (numbered) return Math.min(1 + (numbered[1].split(".").length - 1), 3);
  return 1;
}

// 页锚点有缺口时按相邻锚点插值(大纲页码精确,缺一格就少一条导航)。
export function fillPageGaps(pages) {
  const list = Array.isArray(pages) ? [...pages] : [];
  let lastKnown = 0;
  let lastIndex = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (!(list[index] > 0)) continue;
    if (lastIndex >= 0 && list[index] > lastKnown) {
      const span = index - lastIndex;
      for (let step = 1; step < span; step += 1) {
        list[lastIndex + step] = Math.round(lastKnown + ((list[index] - lastKnown) * step) / span);
      }
    }
    lastKnown = list[index];
    lastIndex = index;
  }
  return list;
}

// 章节标题 → 键(与 tocKey 同一套清洗,便于比对)。
export function chapterKey(title) {
  return tocKey(cleanChapterTitle(title));
}

// 标题相似度(二元组 Dice 系数,0~1):OCR 噪声下比全等更稳。
export function titleSimilarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length) + 0.25;
  const bigrams = (value) => {
    const out = new Set();
    for (let index = 0; index < value.length - 1; index += 1) out.add(value.slice(index, index + 2));
    return out;
  };
  const one = bigrams(left);
  const two = bigrams(right);
  let shared = 0;
  for (const gram of one) if (two.has(gram)) shared += 1;
  return (2 * shared) / (one.size + two.size || 1);
}

// 印刷页码提示:章节自带 <!--page:PDF printed:印刷--> 时,用它和目录条的页码交叉校验。
// 章节里的页锚点(pdf_tool 写的 <!--page:16 printed:7-->):分别取 PDF 页与印刷页码。
export function pdfPageOf(text) {
  const match = String(text || "").match(/<!--\s*page:\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function printedPageOf(text) {
  const match = String(text || "").match(/<!--\s*page:\s*\d+\s+printed:\s*(\d+)\s*-->/);
  return match ? Number(match[1]) : 0;
}

// 印刷目录条目 → 导航计划:按顺序在章节里找最佳匹配(单调前进,防止错位),
// 匹配不到的条目保守丢弃;目录之外的「前言/注释」这类章节保留在两端。
// pages(可选,与 chapters 一一对应)= 章节起始的**印刷页码**:页码对得上时给标题匹配加成,
// 于是 OCR 噪声把标题弄花也能靠页码定位(R1)。
export function buildNavPlan({ chapters = [], tocEntries = [], pages = [], minSimilarity = 0.6, pageTolerance = 2, pageFirst = false, orderFallback = false } = {}) {
  const list = (Array.isArray(chapters) ? chapters : []).map((chapter, index) => ({
    index,
    title: String(chapter?.title || ""),
    key: chapterKey(chapter?.title || ""),
    page: Number((Array.isArray(pages) ? pages : [])[index]) || 0,
  }));
  const items = [];
  const dropped = [];
  const used = new Set();
  const matchedIndexes = new Set();
  let cursor = 0;
  for (const entry of Array.isArray(tocEntries) ? tocEntries : []) {
    let best = null;
    // 全表搜索:游标只用来做「顺序偏好」,不做硬门槛 —— 否则一次错配会把游标推过头,
    // 后面标题完全相同的条目也匹配不上(实测《光学》丢了 182 条,多数是精确命中)。
    for (let index = 0; index < list.length; index += 1) {
      const candidate = list[index];
      if (!candidate.key) continue;
      // 一章只当一条目录条目的落点,否则会出现「第2章重复、第4章缺失」这种错乱。
      if (used.has(index)) continue;
      const title = candidate.key === entry.key
        ? 1
        : Math.max(titleSimilarity(candidate.key, entry.key), candidate.key.startsWith(entry.key) || entry.key.startsWith(candidate.key) ? 0.8 : 0);
      // R1:页码对得上(±容差)且标题也大致像 → 加成;若这一章的标题本身残缺(「第」这种
      // 被拆开的占位),也允许用页码认领它 —— 否则「第4章」这类条目会整条丢掉。
      const weakTitle = String(candidate.title || "").replace(/[^\p{L}\p{N}]/gu, "").length <= 2;
      const pageClose = entry.page > 0 && candidate.page > 0 && Math.abs(candidate.page - entry.page) <= pageTolerance;
      // pageFirst:页锚点来自 PDF 大纲(精确页码)时,以页码为主判据 —— 正文那一带的标题
      // 常常被上游拆坏,靠标题根本配不上。
      const pageHit = pageClose && (pageFirst || title >= 0.34 || weakTitle);
      const score = pageHit ? Math.min(1, Math.max(title, pageFirst ? 0.9 : 0.5) + (pageFirst ? 0 : 0.5) * (1 - Math.abs(candidate.page - entry.page) / (pageTolerance + 1))) : title;
      if (score < minSimilarity) continue;
      const rank = score + (index >= cursor ? 0.05 : 0); // 同等条件优先取靠后的那本(目录顺序)
      if (!best || rank > best.rank) best = { index, score, rank };
    }
    if (!best && orderFallback) {
      // 目录是读书顺序,正文也是读书顺序:实在判不出来就按顺序认领下一章。
      // (用户口径:页码不必对上原书 —— 我们只要一条能用的目录,所以宁可顺序兜底也别丢条目。)
      const next = list.findIndex((candidate) => candidate.index >= cursor && !used.has(candidate.index));
      if (next >= 0) best = { index: next, score: 0.5, rank: 0.5 };
    }
    if (!best) {
      dropped.push(entry.label);
      continue;
    }
    used.add(best.index);
    matchedIndexes.add(best.index);
    items.push({ title: entry.label, chapterIndex: best.index, level: entry.level });
    cursor = Math.max(cursor, best.index);
  }
  if (items.length < 2) return null; // 匹配太少就别用印刷目录,交回标题分章
  // 目录覆盖范围之外、且在两端的前言/附录:补进导航,免得整章从目录里消失。
  // 但封面类碎片(无标题 / 纯括号版次如「(第五版)」)不进导航 —— 正文里照旧保留。
  const coverish = (chapter) => {
    const title = String(chapter.title || "").trim();
    if (!title) return true;
    return /^[（(][^）)]{1,14}[）)]$/.test(title);
  };
  const first = items[0].chapterIndex;
  const last = items[items.length - 1].chapterIndex;
  const before = list.filter((chapter) => chapter.index < first && !matchedIndexes.has(chapter.index) && !coverish(chapter));
  const after = list.filter((chapter) => chapter.index > last && !matchedIndexes.has(chapter.index));
  const plan = [
    ...before.map((chapter) => ({ title: chapter.title, chapterIndex: chapter.index, level: 1 })),
    ...items,
    ...after.map((chapter) => ({ title: chapter.title, chapterIndex: chapter.index, level: 1 })),
  ];
  // 去重:同一章只留一条(前后附章可能与目录条目指向同一章)。
  // 注意:**不按标题去重** —— 大纲里「习题」「小结」反复出现是正常的(每章一份)。
  const seenTargets = new Set();
  const deduped = [];
  for (const item of plan) {
    if (seenTargets.has(item.chapterIndex)) continue;
    seenTargets.add(item.chapterIndex);
    deduped.push(item);
  }
  return { items: deduped, matched: items.length, dropped };
}

// 把导航计划的层级拍平(第一个条目必须是 1 级,层级跳跃不超过 1)。
export function normalizeNavLevels(items) {
  let previous = 0;
  return (Array.isArray(items) ? items : []).map((item, index) => {
    let level = Math.min(Math.max(Number(item?.level) || 1, 1), 3);
    if (index === 0) level = 1;
    else if (level > previous + 1) level = previous + 1;
    previous = level;
    return { ...item, level };
  });
}

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

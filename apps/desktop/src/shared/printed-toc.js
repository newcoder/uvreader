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

const CJK_DIGITS = { 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 「第 N 章 / 第 N 篇 / 第 N 卷」里的编号(0 = 没有编号)。阿拉伯数字与中文数字都认。
// 用途:有的书正文标题被上游拆得只剩「第 1 章」(标题键是空的),靠标题永远配不上;
// 但「第1章 光学简史」这条目录应该认领它 —— 编号是它们唯一共有的身份。
export function chapterNumber(label) {
  const match = String(label || "").match(/^第\s*([0-9０-９]{1,3}|[〇一二两三四五六七八九十百]{1,4})\s*[章篇卷部讲]/);
  if (!match) return 0;
  const raw = match[1].replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  let total = 0;
  let section = 0;
  for (const char of raw) {
    if (char === "百") { total += (section || 1) * 100; section = 0; continue; }
    if (char === "十") { total += (section || 1) * 10; section = 0; continue; }
    section = CJK_DIGITS[char] ?? 0;
  }
  return total + section;
}

// 标题本身能给出的分:完全相同 1;包含关系 0.8;相似度达阈值的按相似度(上限 0.95);
// 都没有但「第 N 章」编号相同 → 0.9(章节标题被拆成「第 1 章」时的唯一线索)。
export function titleScoreOf(candidate, entry, minSimilarity = 0.6) {
  if (entry?.key && candidate?.key) {
    if (candidate.key === entry.key) return 1;
    // 包含关系只有在重合部分够长时才算(否则「光学」会认领「光学简史」那一章)。
    const shorter = Math.min(candidate.key.length, entry.key.length);
    const longer = Math.max(candidate.key.length, entry.key.length);
    const overlaps = candidate.key.startsWith(entry.key) || entry.key.startsWith(candidate.key);
    if (overlaps && shorter >= 3 && shorter / longer >= 0.34) return 0.8;
    const similarity = titleSimilarity(candidate.key, entry.key);
    if (similarity >= minSimilarity) return Math.min(0.95, similarity);
  }
  // 注:「第 N 章」编号的认领只在 buildNavPlan 的第一步里做(那里要连页码一起看,
  // 否则书尾同名的一章会把条目抢走)。
  return 0;
}

// 标题相似度(二元组 Dice 系数,0~1):OCR 噪声下比全等更稳。
export function titleSimilarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    // 短片段不算命中:「光学」不该算作「光学简史」的包含关系(否则章级条目会认领错章)。
    if (shorter >= 3) return shorter / longer + 0.25;
  }
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

const LAST_PAGE_RE = /<!--\s*page:\s*(\d+)(?:\s+printed:\s*(\d+))?\s*-->/g;

function lastAnchorOf(text, printed) {
  const matches = [...String(text || "").matchAll(LAST_PAGE_RE)];
  const last = matches[matches.length - 1];
  if (!last) return 0;
  return Number((printed ? last[2] : last[1]) || 0);
}

export function lastPdfPageOf(text) {
  return lastAnchorOf(text, false);
}

export function lastPrintedPageOf(text) {
  return lastAnchorOf(text, true);
}

// 章首页码 = **上一章正文里最后一个页锚点**。为什么不取「本章第一个锚点」:
// 页锚点写在页首,而标题常在本页中间 —— 本章的第一个锚点往往是起始页的**下一页**
// (实测《光学》差 1~3 页,导致目录靠页码认领时整片顺移)。目录章(印刷目录)虽然
// 后面会被删掉,算页码时它必须在场,否则跨过它的那几页会算错。
export function chapterStartPages(chapters, { of = pdfPageOf, lastOf = lastPdfPageOf } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  return list.map((chapter, index) => {
    const own = of(chapter?.text);
    if (index === 0) return own;
    return lastOf(list[index - 1]?.text) || own;
  });
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
    number: chapterNumber(chapter?.title || ""),
    page: Number((Array.isArray(pages) ? pages : [])[index]) || 0,
  }));
  const entryList = Array.isArray(tocEntries) ? tocEntries : [];
  const entries = entryList.map((entry) => ({ ...entry, number: chapterNumber(entry?.label || "") }));
  const dropped = [];
  if (list.length < 2 || !entries.length) return null;
  const used = new Set();
  const assigned = new Array(entries.length).fill(-1);
  const lastIndex = list.length - 1;
  // 目录与正文都是读书顺序:「第 k 条目录」大致落在「第 k/n × 章数」的位置。
  // 只在多条候选同分时用来挑最合理的那个(重复出现的「习题」就靠它分开)。
  const expectedOf = (entryIndex) => Math.round((entryIndex / Math.max(1, entries.length - 1)) * lastIndex);
  // 同分时优先离「大致位置」近的候选;惩罚很小(≤0.2),不会压过页码/标题判据。
  const rankOf = (score, candidateIndex, entryIndex) => score
    - Math.min(0.2, (Math.abs(candidateIndex - expectedOf(entryIndex)) / Math.max(1, lastIndex)) * 0.2);
  const pick = (entryIndex, test) => {
    let best = null;
    for (const candidate of list) {
      if (used.has(candidate.index)) continue;
      const score = test(candidate, entries[entryIndex]);
      if (score <= 0) continue;
      const rank = rankOf(score, candidate.index, entryIndex);
      if (!best || rank > best.rank) best = { index: candidate.index, score, rank };
    }
    return best;
  };
  const claim = (entryIndex, best) => {
    if (!best) return false;
    used.add(best.index);
    assigned[entryIndex] = best.index;
    return true;
  };
  // 第一步:**标题(或「第 N 章」编号)对得上的先钉死**。靠页码认领的条目会抢走
  // 它们要的那一章 —— 实测《光学》「第1章 光学简史」抢了「1.2 初始时期」的章,
  // 后面的条目跟着整片顺移(用户看到的「跳歪」正是这样滚出来的)。
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const exact = (candidate, entry) => {
      if (entry.key && candidate.key && candidate.key === entry.key) return 1;
      if (entry.number && candidate.number && entry.number === candidate.number) {
        // 编号相同还要看页码:正文里常另有一章同名(附录、尾声里的「第5章」)。
        // 实测「第5章 几何光学」被书尾的一章「第5章」抢走,一点就跳到全书最后。
        const pagesKnown = entry.page > 0 && candidate.page > 0;
        const close = pagesKnown
          ? Math.abs(candidate.page - entry.page) <= Math.max(pageTolerance * 2, 4)
          : Math.abs(candidate.index - expectedOf(entryIndex)) <= Math.max(10, lastIndex * 0.1);
        return close ? (candidate.key && entry.key && candidate.key === entry.key ? 1 : 0.95) : 0;
      }
      return 0;
    };
    claim(entryIndex, pick(entryIndex, exact));
  }
  // 第二步:相似标题 + 页码提示(印刷目录的 OCR 噪声就靠这一步救)。
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    if (assigned[entryIndex] >= 0) continue;
    const best = pick(entryIndex, (candidate, entry) => {
      const title = titleScoreOf(candidate, entry, minSimilarity);
      const weakTitle = String(candidate.title || "").replace(/[^\p{L}\p{N}]/gu, "").length <= 2;
      const pageClose = entry.page > 0 && candidate.page > 0 && Math.abs(candidate.page - entry.page) <= pageTolerance;
      const pageHit = pageClose && (pageFirst || title >= 0.34 || weakTitle);
      if (!pageHit) return title;
      const base = pageFirst ? 0.85 : 0.5;
      const bonus = pageFirst ? 0.1 : 0.5;
      return Math.min(1, Math.max(title, base) + bonus * (1 - Math.abs(candidate.page - entry.page) / (pageTolerance + 1)));
    });
    claim(entryIndex, best && best.score >= minSimilarity ? best : null);
  }
  // 第二步半:章级条目在正文里常常没有自己的章节(上游把「第N章 …」的标题吃掉了)。
  // 这时指向它**下面第一节**所在的章节 —— 那正是这一章的起点(用户实测点「第1章」
  // 跳到 1.5,现在落到 1.1)。放在页码兜底之前,否则它先被页码抢走了。
  if (orderFallback) {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      if (assigned[entryIndex] >= 0) continue;
      const own = Number(entries[entryIndex].level) || 1;
      const next = entries.findIndex((entry, index) => index > entryIndex
        && (Number(entry.level) || 1) === own + 1
        && assigned[index] >= 0);
      if (next >= 0) assigned[entryIndex] = assigned[next];
    }
  }
  // 第三步:兜底 —— 判不出来的条目也要有落点(用户口径:页码不必对上原书,但要有一条能用的目录)。
  // 先按页码就近,再按「第 k/n × 章数」的相对位置就近,绝不落空。
  if (orderFallback) {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      if (assigned[entryIndex] >= 0) continue;
      const entry = entries[entryIndex];
      let pickIndex = -1;
      let pickDistance = Infinity;
      for (const candidate of list) {
        if (used.has(candidate.index)) continue;
        const distance = entry.page > 0 && candidate.page > 0
          ? Math.abs(candidate.page - entry.page)
          : Math.abs(candidate.index - expectedOf(entryIndex)) * (pageTolerance + 1);
        if (distance < pickDistance) {
          pickDistance = distance;
          pickIndex = candidate.index;
        }
        if (distance === 0) break;
      }
      if (pickIndex >= 0) claim(entryIndex, { index: pickIndex });
    }
  }
  const items = [];
  const matchedIndexes = new Set();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const index = assigned[entryIndex];
    if (index < 0) {
      dropped.push(entries[entryIndex].label);
      continue;
    }
    matchedIndexes.add(index);
    items.push({ title: entries[entryIndex].label, chapterIndex: index, level: entries[entryIndex].level });
  }
  if (items.length < 2) return null; // 匹配太少就别用印刷目录,交回标题分章
  // 目录覆盖范围之外、且在两端的前言/附录:补进导航,免得整章从目录里消失。
  // 但封面类碎片(无标题 / 纯括号版次如「(第五版)」)不进导航 —— 正文里照旧保留。
  const coverish = (chapter) => {
    const title = String(chapter.title || "").trim();
    if (!title) return true;
    return /^[（(][^）)]{1,14}[）)]$/.test(title);
  };
  const first = Math.min(...items.map((item) => item.chapterIndex));
  const last = Math.max(...items.map((item) => item.chapterIndex));
  const before = list.filter((chapter) => chapter.index < first && !matchedIndexes.has(chapter.index) && !coverish(chapter));
  const after = list.filter((chapter) => chapter.index > last && !matchedIndexes.has(chapter.index));
  const plan = [
    ...before.map((chapter) => ({ title: chapter.title, chapterIndex: chapter.index, level: 1 })),
    ...items,
    ...after.map((chapter) => ({ title: chapter.title, chapterIndex: chapter.index, level: 1 })),
  ];
  // 去重:同一章 + 同一条文字只留一条(前后附章可能与目录条目指向同一章)。
  // 不同文字的条目前允许指向同一章 —— 章级条目和它的第一节本来就该落在同一页
  // (跳「第1章」和跳「1.1」是一回事)。
  // 注意:**不按标题去重** —— 大纲里「习题」「小结」反复出现是正常的(每章一份)。
  const seenTargets = new Set();
  const deduped = [];
  for (const item of plan) {
    const key = `${item.chapterIndex}\u0000${String(item.title || "").trim()}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
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
  if (!enabled) return { chapters: list, dropped: 0, removedLines: 0, keptIndexes: new Set(list.map((_chapter, index) => index)) };
  const kept = [];
  const keptIndexes = new Set();
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
    keptIndexes.add(index);
  });
  // 全掉光了就还原(宁可留着难看,也不能出空书)。
  if (!kept.length) return { chapters: list, dropped: 0, removedLines: 0, keptIndexes: new Set(list.map((_chapter, index) => index)) };
  return { chapters: kept, dropped, removedLines, keptIndexes };
}

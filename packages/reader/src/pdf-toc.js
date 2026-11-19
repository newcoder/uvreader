// Generic PDF table-of-contents builder: score candidate TOC pages, parse the
// printed entries (single or dual page numbers, hierarchy), let the model turn
// the page text into a structured list, then merge everything back into the
// reader's navigation. Pure module: no host APIs, fully unit-tested.
const DOT_LEADERS = /[.…·]{2,}|[.…·](?:\s*[.…·]){2,}/g;
const HEADING = /^(目\s*录|contents?|table of contents)$/i;
const RUNNING_HEADER = /^(?:\d+\s+)?(?:CONTENTS?|目\s*录)$/i;
const RUNNING_HEADER_PREFIX = /^(?:\d+\s+)?(?:CONTENTS?|目\s*录)\s+(?=(?:\d|(?:CONTENTS?|目\s*录)\b))/i;

export function cleanTocLine(value) {
  return String(value || "").replace(DOT_LEADERS, " ").replace(/\s+/g, " ").trim();
}

// "4 CONTENTS 5.1 ..." and "Contents Contents 3" are running headers glued to
// the first printed row. Strip them before parsing, but keep a real title that
// merely begins with the word "Contents".
function stripTocRunningHeader(value) {
  let body = String(value || "").trim();
  if (!body || RUNNING_HEADER.test(body)) return "";
  for (let pass = 0; pass < 2; pass += 1) {
    const next = body.replace(RUNNING_HEADER_PREFIX, "").trim();
    if (next === body) break;
    body = next;
  }
  return /^\d+$/.test(body) ? "" : body;
}

// Candidate pages: a 目录/Contents heading, dotted leaders and a healthy share
// of lines ending in page numbers. Returns a ranked list with the reasons.
export function scoreTocPage(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.some((line) => HEADING.test(cleanTocLine(line)));
  // Short pages are noise unless they carry an explicit 目录/Contents heading.
  if (lines.length < 6 && !heading) return { score: 0, reason: "too-short" };
  let score = 0;
  const reasons = [];
  if (heading) { score += 40; reasons.push("heading"); }
  const leaders = (source.match(DOT_LEADERS) || []).length;
  if (leaders >= 3) { score += Math.min(20, leaders * 2); reasons.push("leaders"); }
  const numbered = lines.filter((line) => /(?:[（(]\d+[)）]\s*[/／]\s*[（(]\d+[)）]|\d+)\s*$/.test(cleanTocLine(line))).length;
  const ratio = numbered / lines.length;
  if (ratio >= 0.25) { score += Math.round(ratio * 40); reasons.push("numbered-lines"); }
  return { score, reason: reasons.join("+") || "plain" };
}

export function tocCandidates(pages, { minScore = 25 } = {}) {
  return (Array.isArray(pages) ? pages : [])
    .map((entry) => ({ page: Math.round(Number(entry?.page)) || 0, ...scoreTocPage(entry?.text) }))
    .filter((entry) => entry.page > 0 && entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.page - b.page);
}

// A printed table of contents is usually a run of neighbouring pages. The
// scan must report that whole run: ranking the pages by score and keeping only
// the top few silently drops the beginning (or end) of a long TOC.
export function tocPageRanges(candidates, { gap = 2 } = {}) {
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((item) => ({
      page: Math.round(Number(item?.page)) || 0,
      score: Math.round(Number(item?.score)) || 0,
    }))
    .filter((item) => item.page > 0)
    .sort((a, b) => a.page - b.page);
  const ranges = [];
  for (const item of ordered) {
    const last = ranges[ranges.length - 1];
    if (last && item.page - last.to <= Math.max(1, gap) + 1) {
      last.to = Math.max(last.to, item.page);
      last.score = Math.max(last.score, item.score);
      last.pages.push(item.page);
    } else {
      ranges.push({ from: item.page, to: item.page, count: 1, score: item.score, pages: [item.page] });
    }
  }
  for (const range of ranges) range.count = range.to - range.from + 1;
  return ranges;
}

// The best run is the one with the strongest TOC signals, not the longest run:
// a book's index is often longer than its contents but scores lower.
export function bestTocPageRange(candidates) {
  return [...tocPageRanges(candidates)].sort((a, b) => b.score - a.score || b.count - a.count || a.from - b.from)[0] || null;
}

function levelOf(title, raw) {
  const lead = (/^\s*/.exec(String(raw ?? ""))?.[0] || "").replace(/\t/g, "  ").length;
  if (/^\d+\.\d+\.\d+/.test(title)) return 3;
  if (/^\d+\.\d+/.test(title) || /^[（(][一二三四五六七八九十0-9]+[）)]/.test(title)) return 2;
  if (/^第[一二三四五六七八九十百零0-9]+[章节单元讲部篇]/.test(title)) return 1;
  if (lead >= 4) return 3;
  if (lead >= 2) return 2;
  return 1;
}

// One printed line → one entry. Handles `标题 …… 12`, `标题 1/82` and the
// bracketed dual form `标题 (1)/(82)`.
export function parseTocLine(line, raw) {
  const clean = cleanTocLine(line);
  if (!clean) return null;
  let page = null, page2 = null, body = clean;
  const dual = clean.match(/[（(](\d+)[)）]\s*[/／]\s*[（(](\d+)[)）]\s*$/) || clean.match(/(\d+)\s*[/／]\s*(\d+)\s*$/);
  if (dual) {
    page = Number(dual[1]); page2 = Number(dual[2]);
    body = clean.slice(0, dual.index);
  } else {
    const single = clean.match(/(\d+)\s*$/);
    if (!single) return null;
    page = Number(single[1]);
    body = clean.slice(0, single.index);
  }
  const title = cleanTocLine(body).replace(/[/／.…·:：\s]+$/, "").trim();
  if (!title) return null;
  return { level: levelOf(title, raw), title, page, page2 };
}

export function parseTocText(text) {
  const out = [];
  let pending = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    const clean = stripTocRunningHeader(cleanTocLine(trimmed));
    if (!clean) continue;
    const entry = parseTocLine(clean, raw);
    if (!entry) {
      // TOC pages often print 第X单元 on its own line above the numbered row,
      // and formulas split a title across two text-layer lines ("... ∑" then
      // "i∈I ai ... 64"). Hold the fragment and prepend it to the next row.
      if (clean.length <= 200 && !/^\d+$/.test(clean)) {
        const joined = pending ? `${pending} ${clean}` : clean;
        pending = joined.length > 240 ? clean : joined;
      }
      continue;
    }
    if (pending) {
      entry.title = cleanTocLine(`${pending} ${entry.title}`);
      pending = "";
    }
    out.push(entry);
  }
  return out;
}

// Printed → PDF offset from outline anchors ({ printed, pdf }): the majority
// difference wins and the agreement is reported so callers can demand a
// unanimous vote before trusting it.
export function inferTocOffset(anchors) {
  const values = (Array.isArray(anchors) ? anchors : [])
    .map((item) => ({ printed: Math.round(Number(item?.printed)) || 0, pdf: Math.round(Number(item?.pdf)) || 0 }))
    .filter((item) => item.printed > 0 && item.pdf > 0)
    .map((item) => item.pdf - item.printed);
  if (values.length < 2) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let offset = 0, agree = 0;
  for (const [value, count] of counts) if (count > agree) { offset = value; agree = count; }
  return { offset, agree, total: values.length };
}

export function applyTocOffset(entries, offset) {
  const shift = Math.round(Number(offset)) || 0;
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    pdfPage: entry?.page ? entry.page + shift : null,
    pdfPage2: entry?.page2 ? entry.page2 + shift : null,
  }));
}

// PDF.js text items → visual lines with coordinates. The text layer's own
// order can interleave two columns; grouping by baseline and keeping a large
// horizontal gap as a column break gives the printed reading order.
export function pdfTextLines(items, { pageWidth = 1000 } = {}) {
  const lines = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) lines.push(current);
    current = null;
  };
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.str || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const transform = Array.isArray(item?.transform) ? item.transform : null;
    const x = Number(transform?.[4]) || 0;
    const y = Number(transform?.[5]) || 0;
    const width = Math.max(0, Number(item?.width) || 0);
    const height = Math.abs(Number(item?.height) || 0);
    const isPageNumber = /^\d{1,4}$/.test(text);
    if (current) {
      const tolerance = Math.max(2, Math.max(current.height, height) * 0.6);
      const sameBaseline = Math.abs(current.y - y) <= tolerance;
      // A right-column item at the same baseline starts before the left line
      // ends; a large non-numeric gap is the gutter. A page number is allowed
      // to sit far to the right of its title.
      const nextColumn = x < current.x1 - 2;
      const gutter = x - current.x1 > pageWidth * 0.15 && !isPageNumber;
      if (!sameBaseline || nextColumn || gutter) flush();
    }
    if (!current) {
      current = { text, x0: x, x1: x + width, y, height };
    } else {
      current.text += `${x > current.x1 + 1 ? " " : ""}${text}`;
      current.x1 = Math.max(current.x1, x + width);
      current.height = Math.max(current.height, height);
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

function splitMergedTocRow(text) {
  // PDF.js sometimes merges two visual columns into one text item when their
  // baselines match: "左标题 / 1 右标题 / 37". Both halves must end in a page
  // number; otherwise this is just a title containing a number.
  const value = String(text || "").trim();
  if (!value) return null;
  const match = value.match(/^(.+?[/／]?\s*\d{1,4})\s+(\S.*)$/);
  if (!match) return null;
  const left = match[1].trim();
  const right = match[2].trim();
  const endsInPage = (part) => /(?:[/／]\s*|\s)\d{1,4}\s*$/.test(part);
  if (!endsInPage(left) || !endsInPage(right)) return null;
  return [left, right];
}

// A contents page is commonly two columns. Split at the widest gutter and
// return the left column top-to-bottom followed by the right column.
export function tocTextFromLines(lines, { pageWidth = 1000 } = {}) {
  const list = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line?.text || "").trim();
    if (!text) continue;
    const parts = splitMergedTocRow(text);
    if (parts) {
      list.push({ ...line, text: parts[0] });
      list.push({ ...line, text: parts[1], x0: Math.max(Number(line.x0) || 0, pageWidth * 0.5) });
    } else {
      list.push({ ...line, text });
    }
  }
  if (!list.length) return "";
  const xs = [...new Set(list.map((line) => Math.round((Number(line.x0) || 0) * 10) / 10))].sort((a, b) => a - b);
  let splitAt = null;
  let bestGap = 0;
  for (let index = 1; index < xs.length; index += 1) {
    const gap = xs[index] - xs[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitAt = (xs[index] + xs[index - 1]) / 2;
    }
  }
  let columns = [list];
  if (bestGap >= pageWidth * 0.14 && splitAt != null) {
    const left = list.filter((line) => (Number(line.x0) || 0) < splitAt);
    const right = list.filter((line) => (Number(line.x0) || 0) >= splitAt);
    if (left.length >= 2 && right.length >= 2) columns = [left, right];
  }
  const ordered = columns.map((column) => column
    .slice()
    .sort((left, right) => right.y - left.y || left.x0 - right.x0));
  // Drop a running book title/page header at the top of either column. A real
  // unnumbered chapter heading ("第一部分") is kept because it carries
  // hierarchy.
  for (const column of ordered) {
    const first = column[0];
    const second = column[1];
    if (first && second && !/\d\s*$/.test(String(first.text || ""))
      && !/^第.+[章节部篇]|^(?:chapter|part)\b/i.test(String(first.text || ""))) {
      column.shift();
    }
  }
  return ordered.map((column) => column.map((line) => String(line.text || "").trim()).join("\n")).join("\n");
}

// Footer page numbers are the reliable printed↔PDF anchor when the PDF has no
// outline (the common case for scans). Only pages after the contents run vote;
// TOC/front-matter page numbers often use a different sequence.
export function inferTocOffsetFromFooters(pages, { tocPages = [] } = {}) {
  const excluded = new Set((Array.isArray(tocPages) ? tocPages : []).map(Number));
  const votes = new Map();
  let total = 0;
  for (const item of Array.isArray(pages) ? pages : []) {
    const page = Math.round(Number(item?.page)) || 0;
    if (!page || excluded.has(page)) continue;
    const lines = String(item?.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let printed = 0;
    for (const line of [lines[lines.length - 1], ...lines.slice(-3), lines[0]]) {
      const match = line.match(/^(?:[-–—]\s*)?(\d{1,4})(?:\s*[-–—])?$/)
        || line.match(/^第\s*(\d{1,4})\s*页$/);
      if (match) {
        printed = Number(match[1]);
        break;
      }
    }
    if (!printed || printed >= page) continue;
    total += 1;
    const offset = page - printed;
    votes.set(offset, (votes.get(offset) || 0) + 1);
  }
  let best = null;
  for (const [offset, count] of votes) {
    if (!best || count > best.count) best = { offset, count };
  }
  if (!best || total < 3) return null;
  return { offset: best.offset, agree: best.count, total };
}

// The model sometimes keeps only a formula fragment from a two-line printed
// title ("i∈I ai" instead of "3.3 Indexed Families; the Sum Notation ∑ i∈I ai").
// The deterministic text-layer entry for the same page is the repair source.
export function repairTocTitles(entries, deterministic) {
  const byPage = new Map();
  for (const item of Array.isArray(deterministic) ? deterministic : []) {
    const page = Math.round(Number(item?.page)) || 0;
    const title = cleanTocLine(item?.title);
    if (!page || !title) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(title);
  }
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const page = Math.round(Number(entry?.pdfPage ?? entry?.page)) || 0;
    const candidates = byPage.get(page) || [];
    const title = cleanTocLine(entry?.title);
    if (!candidates.length || !title) return entry;
    const containing = candidates.find((candidate) => candidate !== title
      && (candidate.includes(title) || title.includes(candidate)));
    const formulaFragment = title.length <= 10 && /[∈∑∏√^_{}[\]\\]/u.test(title);
    const repaired = containing
      || (formulaFragment ? candidates.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), "") : "");
    return repaired && repaired.length > title.length ? { ...entry, title: repaired } : entry;
  });
}

// Levels may only grow one step at a time, pages must be plausible and mostly
// increasing; anything else is reported so the caller can ask the user.
export function validateTocEntries(entries, { totalPages = 0 } = {}) {
  const problems = [];
  let previousLevel = 1;
  let previousPage = 0;
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const where = `#${index + 1} ${entry?.title || ""}`.trim();
    if (!entry?.title) problems.push(`${where}: 缺少标题`);
    const level = Math.round(Number(entry?.level)) || 1;
    if (level > previousLevel + 1) problems.push(`${where}: 层级跳跃 ${previousLevel}→${level}`);
    previousLevel = Math.max(1, level);
    const page = Math.round(Number(entry?.pdfPage ?? entry?.page)) || 0;
    if (!page) problems.push(`${where}: 缺少页码`);
    else if (totalPages && page > totalPages) problems.push(`${where}: 页码超出范围 ${page}`);
    else if (previousPage && page < previousPage - 2) problems.push(`${where}: 页码倒退 ${previousPage}→${page}`);
    if (page) previousPage = page;
  });
  return { ok: problems.length === 0, problems };
}

// Outline labels often carry hints the TOC text does not ("试题*1 解答");
// remove them for both display and matching.
function stripOutlineHints(value) {
  const cleaned = cleanTocLine(value)
    .replace(/\s*试题\s*\*?\s*[0-9]*/g, " ")
    .replace(/\s*解答/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || cleanTocLine(value);
}

function titleKey(value) {
  return stripOutlineHints(value).replace(/\s+/g, "").toLowerCase();
}

// Merge the embedded outline with the generated entries: same-title items keep
// the generated (verified) pages and gain the missing ones, outline-only items
// such as 前言/附录 survive, and every record knows where it came from.
export function mergeTocEntries(existing, generated) {
  // Outline titles are canonical, so a generated entry whose answer page lands
  // on an outline destination adopts that title: OCR text layers sometimes
  // mis-order lines (a unit subtitle glued to the previous unit), and the
  // printed numbers still line up.
  const outlineByPage = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const page = Math.round(Number(item?.page)) || 0;
    const title = stripOutlineHints(item?.label || item?.title);
    if (page && title) outlineByPage.set(page, title);
  }
  const merged = [];
  const seen = new Map();
  const push = (entry) => {
    const key = titleKey(entry.title);
    if (key && seen.has(key)) {
      const current = seen.get(key);
      if (entry.page && !current.page) current.page = entry.page;
      if (entry.page2 && !current.page2) current.page2 = entry.page2;
      if (entry.level && (!current.level || entry.level < current.level)) current.level = entry.level;
      current.sources.add(entry.source);
      return;
    }
    const record = { ...entry, sources: new Set([entry.source]) };
    if (key) seen.set(key, record);
    merged.push(record);
  };
  // Generated entries come first so their verified pages win; the outline then
  // fills gaps (its label is kept when it is the fuller one).
  for (const item of Array.isArray(generated) ? generated : []) {
    const page = Math.round(Number(item?.pdfPage ?? item?.page)) || null;
    const page2 = Math.round(Number(item?.pdfPage2 ?? item?.page2)) || null;
    const generatedTitle = cleanTocLine(item?.title);
    const outlineTitle = outlineByPage.get(page2 || page);
    const title = outlineTitle && titleKey(outlineTitle) !== titleKey(generatedTitle) ? outlineTitle : generatedTitle;
    push({ title, level: Math.round(Number(item?.level)) || 1, page, page2, source: "toc" });
  }
  for (const item of Array.isArray(existing) ? existing : []) {
    const title = stripOutlineHints(item?.label || item?.title);
    const key = titleKey(title);
    const record = key ? seen.get(key) : null;
    if (record && title.length > record.title.length) record.title = title;
    push({ title, level: Math.round(Number(item?.level)) || 1, page: Math.round(Number(item?.page)) || null, page2: null, source: "outline" });
  }
  merged.sort((a, b) => (a.page || 0) - (b.page || 0) || a.level - b.level);
  for (const item of merged) item.sources = [...item.sources];
  return merged;
}

export const TOC_EXTRACTION_SYSTEM_PROMPT = [
  "你在为阅读器整理 PDF 的目录页。把目录页文本提取成结构化条目，只输出 JSON，不要解释。",
  "规则：",
  "1. 保持标题原文（含语言），去掉点线（……、···、...）和标题末尾的页码；标题折行要合并为一条。",
  "2. level 从 1 开始，子级最多比上一级深一级；依据缩进、编号（第X章/单元、1.1、1.1.1、（一））判断。",
  "3. page 是条目指向的页码（目录上印的数字）。一行有两个页码（如 (1)/(82)）时 page 填第一个、page2 填第二个；只有一个页码时 page2 填 null。",
  "4. 不编造标题或页码；看不清的条目标 \"confidence\": \"low\"。",
  "5. 目录可能是双栏；文本已按「左栏从上到下，再右栏从上到下」排好，按这个顺序输出，不要把两栏交叉；顶部的书名/页眉不是条目。",
  "6. 只输出：{\"entries\":[{\"level\":1,\"title\":\"…\",\"page\":1,\"page2\":82}]}",
].join("\n");

export function buildTocExtractionMessages(pages, { images = {} } = {}) {
  const list = (Array.isArray(pages) ? pages : []).map((item) => ({
    page: item?.page,
    text: String(item?.text || "").trim(),
    image: images?.[item?.page] || null,
  })).filter((item) => item.text || item.image?.data);
  if (!list.length) return [];
  const withImages = list.filter((item) => item.image?.data);
  if (!withImages.length) {
    const body = list.map((item) => `【第 ${item.page} 页】\n${item.text || "（无可用文字层）"}`).join("\n\n");
    return [
      { role: "system", content: TOC_EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: `目录页文本如下：\n\n${body}` },
    ];
  }
  // Vision models read the printed pages directly: the images are authoritative
  // for line order and the two page-number columns, the text layer is a hint. A
  // multi-page TOC is sent page by page, in order, each page's text right next
  // to its own image so the model never has to guess which image is which.
  const parts = [{
    type: "text",
    text: `目录共 ${list.length} 页，按页序附上文本与图片；文字层可能行序错乱，仅作参考，行序、试题/解答两列页码、标题折行都以图片为准；文字层与图片冲突时以图片为准。`,
  }];
  for (const item of list) {
    parts.push({ type: "text", text: `【第 ${item.page} 页】\n${item.text || "（无可用文字层）"}` });
    if (item.image?.data) parts.push({ type: "image", data: item.image.data, mimeType: item.image.mimeType || "image/jpeg" });
  }
  return [
    { role: "system", content: TOC_EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: parts },
  ];
}

export function parseTocExtractionReply(text, { max = 400 } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let payload = null;
  try { payload = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  const list = Array.isArray(payload?.entries) ? payload.entries : [];
  const out = [];
  for (const item of list) {
    const title = cleanTocLine(item?.title).replace(/[/／.…·:：\s]+$/, "").slice(0, 200);
    const page = Math.round(Number(item?.page));
    if (!title || !Number.isFinite(page) || page < 1) continue;
    const page2 = Math.round(Number(item?.page2));
    out.push({
      level: Math.min(4, Math.max(1, Math.round(Number(item?.level)) || 1)),
      title,
      page,
      page2: Number.isFinite(page2) && page2 >= 1 && page2 !== page ? page2 : null,
    });
    if (out.length >= max) break;
  }
  return out;
}

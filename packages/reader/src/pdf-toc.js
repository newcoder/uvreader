// Generic PDF table-of-contents builder: score candidate TOC pages, parse the
// printed entries (single or dual page numbers, hierarchy), let the model turn
// the page text into a structured list, then merge everything back into the
// reader's navigation. Pure module: no host APIs, fully unit-tested.
const DOT_LEADERS = /[.…·]{2,}/g;
const HEADING = /^(目\s*录|contents?|table of contents)$/i;

export function cleanTocLine(value) {
  return String(value || "").replace(DOT_LEADERS, " ").replace(/\s+/g, " ").trim();
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
  const title = cleanTocLine(body);
  if (!title) return null;
  return { level: levelOf(title, raw), title, page, page2 };
}

export function parseTocText(text) {
  const out = [];
  let pending = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    const entry = parseTocLine(trimmed, raw);
    if (!entry) {
      // TOC pages often print 第X单元 on its own line above the numbered row;
      // hold short heading-like lines and prepend them to the next entry.
      const clean = cleanTocLine(trimmed);
      if (clean && (/^第[一二三四五六七八九十百零0-9]+[章节单元讲部篇]/.test(clean) || clean.length <= 12)) {
        pending = pending ? `${pending} ${clean}` : clean;
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
  "5. 只输出：{\"entries\":[{\"level\":1,\"title\":\"…\",\"page\":1,\"page2\":82}]}",
].join("\n");

export function buildTocExtractionMessages(pages) {
  const list = (Array.isArray(pages) ? pages : []).filter((item) => String(item?.text || "").trim());
  if (!list.length) return [];
  const body = list.map((item) => `【第 ${item.page} 页】\n${String(item.text).trim()}`).join("\n\n");
  return [
    { role: "system", content: TOC_EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: `目录页文本如下：\n\n${body}` },
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
    const title = cleanTocLine(item?.title).slice(0, 200);
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

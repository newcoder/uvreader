// Printed-TOC extraction from MinerU layout blocks.
//
// Scanned books are recognised by MinerU into blocks with a normalised bbox.
// A contents page is mostly one-entry-per-block (or a structured `index` block),
// often in two columns. Reading the raw PDF text layer interleaves those
// columns; sorting the blocks by column first fixes the title/page pairs.
//
// This module is pure: give it the layout produced by `readMineruLayout()` and
// it returns PDF-page entries plus the printed→PDF offset found from the body's
// page-number blocks. It is deliberately not tied to one book.
import { tocKey, tocLevel } from "./printed-toc.js";

const TOC_HEADING_RE = /^(?:目\s*录|目\s*次|contents?|table\s+of\s+contents|inhalt|sommaire|índice)$/i;
const NON_ENTRY_RE = /^(?:图\s*解|插\s*图|目\s*录|contents?)$/i;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// One printed row → { title, page, page2 }. Handles:
//   标题 / 66     标题/66     标题 …… 66     标题 66
//   标题 (1)/(82)  标题 1/82
// Titles may contain slashes; only the final separator + digits are the page.
export function parseLayoutTocLine(text) {
  let value = clean(text);
  if (!value || NON_ENTRY_RE.test(value)) return null;
  // Collapse dotted leaders to a single separator before the page number.
  value = value.replace(/[.…·]{2,}\s*(\d{1,4})\s*$/, " $1");
  let page = 0;
  let page2 = null;
  let body = value;
  const dual = value.match(/[（(](\d{1,4})[)）]\s*[/／]\s*[（(](\d{1,4})[)）]\s*$/)
    || value.match(/(\d{1,4})\s*[/／]\s*(\d{1,4})\s*$/);
  if (dual) {
    page = Number(dual[1]);
    page2 = Number(dual[2]);
    body = value.slice(0, dual.index);
  } else {
    const single = value.match(/(?:[/／]|\s|[.…·]{2,})\s*(\d{1,4})\s*$/);
    if (!single) return null;
    page = Number(single[1]);
    body = value.slice(0, single.index);
  }
  body = body.replace(/[/／.…·:：,，;；\s]+$/, "").trim();
  if (body.length < 2 || body.length > 120) return null;
  if (!/[\p{L}\p{N}]/u.test(body)) return null;
  if (!Number.isFinite(page) || page < 1 || page > 2000) return null;
  return {
    title: body,
    page,
    page2: Number.isFinite(page2) && page2 >= 1 && page2 !== page ? page2 : null,
    level: tocLevel(body),
  };
}

function splitBlockText(block) {
  const lines = String(block?.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : [String(block?.text || "")];
}

function pageEntries(page) {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  const entries = [];
  let heading = false;
  let hasIndex = false;
  for (const block of blocks) {
    if (!block || block.type === "image" || block.type === "table") continue;
    const text = clean(block.text);
    if (!text) continue;
    if (TOC_HEADING_RE.test(text)) {
      heading = true;
      continue;
    }
    if (block.type === "index" || block.type === "list") hasIndex = true;
    const bbox = Array.isArray(block.bbox) ? block.bbox : [0, 0, 1, 1];
    for (const line of splitBlockText(block)) {
      const entry = parseLayoutTocLine(line);
      if (!entry) continue;
      entries.push({
        ...entry,
        x: Number(bbox[0]) || 0,
        y: Number(bbox[1]) || 0,
        width: Math.max(0, (Number(bbox[2]) || 1) - (Number(bbox[0]) || 0)),
      });
    }
  }
  return { entries, heading, hasIndex };
}

function splitColumns(entries) {
  if (entries.length < 4) return [entries];
  const xs = [...new Set(entries.map((entry) => Math.round(entry.x * 1000) / 1000))].sort((a, b) => a - b);
  let splitAt = null;
  let bestGap = 0;
  for (let index = 1; index < xs.length; index += 1) {
    const gap = xs[index] - xs[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitAt = (xs[index] + xs[index - 1]) / 2;
    }
  }
  // Two columns are separated by a clear gutter. A one-column TOC only has
  // indentation-sized gaps (usually < 0.08 of the page width).
  if (bestGap < 0.16 || splitAt == null) return [entries];
  const left = entries.filter((entry) => entry.x < splitAt);
  const right = entries.filter((entry) => entry.x >= splitAt);
  if (left.length < 2 || right.length < 2) return [entries];
  return [left, right];
}

// Sort a contents page into reading order: left column top-to-bottom, then the
// right column. `index` blocks carry their own line order.
export function orderTocPage(page) {
  const { entries, heading, hasIndex } = pageEntries(page);
  const columns = splitColumns(entries);
  const ordered = [];
  for (const column of columns) {
    column.sort((left, right) => left.y - right.y || left.x - right.x);
    ordered.push(...column);
  }
  // If one page repeats the same row (e.g. a running header), keep the first.
  const seen = new Set();
  const unique = ordered.filter((entry) => {
    const key = `${tocKey(entry.title)}\u0000${entry.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { entries: unique, heading, hasIndex };
}

function contiguousRuns(candidates) {
  const sorted = [...candidates].sort((left, right) => left.page - right.page);
  const runs = [];
  for (const item of sorted) {
    const last = runs[runs.length - 1];
    if (last && item.page - last.pages[last.pages.length - 1] <= 1) {
      last.pages.push(item.page);
      last.score += item.score;
      last.entries += item.entries;
      last.heading = last.heading || item.heading;
    } else {
      runs.push({ pages: [item.page], score: item.score, entries: item.entries, heading: item.heading });
    }
  }
  return runs;
}

// Find the printed contents run. A real TOC has many title/page rows and/or a
// 目录/Contents heading; a back-of-book index also has rows but no heading and
// sits after the body, so the earlier strong run wins.
export function detectTocPages(layout) {
  const pages = Array.isArray(layout?.pages) ? layout.pages : [];
  const candidates = [];
  for (const page of pages) {
    const ordered = orderTocPage(page);
    if (!ordered.entries.length) continue;
    const dense = ordered.entries.length >= 4 || (ordered.heading && ordered.entries.length >= 2);
    if (!dense) continue;
    const score = ordered.entries.length + (ordered.heading ? 12 : 0) + (ordered.hasIndex ? 6 : 0);
    candidates.push({
      page: Number(page.page) || 0,
      entries: ordered.entries.length,
      heading: ordered.heading,
      score,
    });
  }
  const runs = contiguousRuns(candidates.filter((item) => item.page > 0));
  if (!runs.length) return { pages: [], entries: [], pagesData: [] };
  // Prefer a run with a real heading; otherwise prefer an early strong run
  // over a later, longer back-of-book index. Only a clearly stronger later
  // run (2x) may win.
  const pool = runs.filter((run) => run.heading).length ? runs.filter((run) => run.heading) : runs;
  const bestScore = Math.max(...pool.map((run) => run.score));
  const chosen = pool
    .slice()
    .sort((left, right) => left.pages[0] - right.pages[0])
    .find((run) => run.score >= bestScore * 0.7)
    || pool.slice().sort((left, right) => right.score - left.score)[0];
  return chosen;
}

function printedNumber(text) {
  const value = clean(text).replace(/[^\d]/g, "");
  if (!value || value.length > 4) return 0;
  return Number(value);
}

// Printed page numbers are usually a `page_number` block at the foot. The
// offset is the majority `pdfPage - printedPage` across body pages. TOC and
// front-matter pages are excluded because their numbering often differs.
export function inferLayoutPageOffset(layout, tocPages = []) {
  const excluded = new Set((Array.isArray(tocPages) ? tocPages : []).map(Number));
  const votes = new Map();
  const samples = [];
  for (const page of Array.isArray(layout?.pages) ? layout.pages : []) {
    const number = Number(page?.page) || 0;
    if (!number || excluded.has(number)) continue;
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const block of blocks) {
      if (!block || !["page_number", "footer"].includes(String(block.type || ""))) continue;
      const printed = printedNumber(block.text);
      if (!printed || printed >= number) continue;
      const offset = number - printed;
      votes.set(offset, (votes.get(offset) || 0) + 1);
      samples.push({ pdf: number, printed, offset });
    }
  }
  let best = null;
  for (const [offset, count] of votes) {
    if (!best || count > best.count) best = { offset, count };
  }
  const total = samples.length;
  if (!best || total < 3) return { offset: 0, agree: best?.count || 0, total, confidence: 0 };
  return {
    offset: best.offset,
    agree: best.count,
    total,
    confidence: best.count / Math.max(1, total),
  };
}

// Build the final entries. `page` is the printed page; `pdfPage` is the page in
// the converted PDF (1-based), ready for PyMuPDF's set_toc.
export function extractTocFromLayout(layout, { pageCount = 0 } = {}) {
  const run = detectTocPages(layout);
  const tocPages = run.pages || [];
  if (!tocPages.length) {
    return { pages: [], entries: [], offset: 0, offsetInfo: { offset: 0, agree: 0, total: 0, confidence: 0 } };
  }
  const wanted = new Set(tocPages);
  const printed = [];
  for (const page of Array.isArray(layout?.pages) ? layout.pages : []) {
    const number = Number(page?.page) || 0;
    if (!wanted.has(number)) continue;
    printed.push(...orderTocPage(page).entries);
  }
  // Keep TOC order, de-duplicate titles, and drop impossible printed pages.
  const seen = new Set();
  const deduped = [];
  for (const entry of printed) {
    const key = `${tocKey(entry.title)}\u0000${entry.page}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  const offsetInfo = inferLayoutPageOffset(layout, tocPages);
  const offset = offsetInfo.offset;
  const totalPages = Number(pageCount) || Math.max(...(layout?.pages || []).map((page) => Number(page.page) || 0), 0);
  const entries = deduped
    .map((entry) => {
      const pdfPage = entry.page + offset;
      return {
        title: entry.title,
        level: entry.level || 1,
        page: entry.page,
        page2: entry.page2 || null,
        pdfPage: pdfPage > 0 && (!totalPages || pdfPage <= totalPages) ? pdfPage : null,
      };
    })
    .filter((entry) => entry.pdfPage);
  return {
    pages: tocPages,
    entries,
    offset,
    offsetInfo,
    printedCount: deduped.length,
    pdfCount: entries.length,
  };
}

// PyMuPDF's `Document.set_toc` rows: [level, title, page].
export function tocRowsForPdf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const page = Math.round(Number(entry?.pdfPage ?? entry?.page));
      const title = clean(entry?.title);
      if (!title || !Number.isFinite(page) || page < 1) return null;
      return [Math.min(3, Math.max(1, Math.round(Number(entry?.level)) || 1)), title, page];
    })
    .filter(Boolean);
}

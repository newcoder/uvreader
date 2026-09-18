// Table-of-contents construction and block/page lookup for the reader.
//
// Everything here is host-agnostic: the document parser comes from the passed
// window (or the global one), and the only shared dependency is the block
// selector used by both the reader and the PDF text layer.

import { READER_BLOCK_SELECTOR } from "./pdf-page-mode.js";

export function chapterForBlock(toc, block) {
  if (!toc || !toc.length || typeof block !== "number") return "";
  let best = "";
  for (const it of toc) {
    if (it.block <= block) best = it.label;
    else break;
  }
  return best;
}

export function pageForBlock(flow, block) {
  try {
    const blocks = flow ? flow.querySelectorAll(READER_BLOCK_SELECTOR) : null;
    const el = blocks && blocks[block];
    const holder = el && el.closest ? el.closest("[data-pdf-page-no]") : null;
    const p = holder ? parseInt(holder.getAttribute("data-pdf-page-no"), 10) : NaN;
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}

export function pdfTextLooksUnreadable(items) {
  const text = (items || []).map((it) => typeof it.str === "string" ? it.str : "").join(" ");
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 30) return false;
  const singles = tokens.filter((t) => t.length === 1).length;
  return singles / tokens.length > 0.7;
}

export function readerSearchTexts(flow) {
  return flow ? [...flow.querySelectorAll(READER_BLOCK_SELECTOR)].map((el) => el.textContent || "") : [];
}

const TOC_LABEL_LIMIT = 60;
const TOC_MIN_RELIABLE = 3;
const TOC_NOISE_FLOOR = 30;
const TOC_NOISE_PAGE_SHARE = 0.6;
const TOC_NOISE_BLOCKS_PER_PAGE = 12;
const TOC_TITLE_PREFIX_MIN = 12;
const TOC_HEADING_PATTERN = /^H[1-3]$/;
const TOC_LINE_CLASS = "qiaomu-reader-toc-line";
const TOC_TITLE_SELECTOR = ".qiaomu-reader-toc-t";
const TOC_PAGE_HOLDER_SELECTOR = "[data-pdf-page-no]";
const TOC_PAGE_NUMBER_ATTR = "data-pdf-page-no";
const TOC_PUNCTUATION_PATTERN = /[«»"'`.,:;!?()[\]—–-]/g;
const TOC_WHITESPACE_PATTERN = /\s+/g;

export function tocPageHolderOf(el) {
  return el && el.closest ? el.closest(TOC_PAGE_HOLDER_SELECTOR) : null;
}

export function tocPageValueOf(el) {
  const holder = tocPageHolderOf(el);
  return holder ? parseInt(holder.getAttribute(TOC_PAGE_NUMBER_ATTR), 10) : NaN;
}

export function tocPageAnchor(blocks, index) {
  const page = tocPageValueOf(blocks[index]);
  return Number.isNaN(page) ? null : page;
}

export function tocLooksLikeNoise(items, blocks) {
  if (!items || items.length < TOC_NOISE_FLOOR) return false;
  const anchored = new Set();
  for (const el of blocks) {
    const holder = tocPageHolderOf(el);
    if (holder) anchored.add(holder.getAttribute(TOC_PAGE_NUMBER_ATTR));
  }
  const budget = anchored.size
    ? Math.max(TOC_NOISE_FLOOR, anchored.size * TOC_NOISE_PAGE_SHARE)
    : Math.max(TOC_NOISE_FLOOR, blocks.length / TOC_NOISE_BLOCKS_PER_PAGE);
  return items.length > budget;
}

export function tocFirstBlockPerPage(blocks) {
  const firstOfPage = new Map();
  blocks.forEach((el, i) => {
    const page = tocPageValueOf(el);
    if (!isNaN(page) && !firstOfPage.has(page)) firstOfPage.set(page, i);
  });
  return firstOfPage;
}

export function tocItemsFromOutline(blocks, tocOutline) {
  if (!tocOutline || !tocOutline.length) return [];
  const firstOfPage = tocFirstBlockPerPage(blocks);
  const ascendingPages = [...firstOfPage.keys()].sort((a, b) => a - b);
  const resolveBlock = (page) => {
    const exact = firstOfPage.get(page);
    if (exact !== undefined) return exact;
    const next = ascendingPages.find((p) => p >= page);
    return next === undefined ? undefined : firstOfPage.get(next);
  };
  const mapped = [];
  for (const entry of tocOutline) {
    const block = resolveBlock(entry.page);
    if (block === undefined) continue;
    mapped.push({ label: String(entry.label).slice(0, TOC_LABEL_LIMIT), block, level: entry.level || 0 });
  }
  return mapped;
}

export function tocItemsFromHeadings(blocks) {
  const found = [];
  blocks.forEach((el, i) => {
    if (!TOC_HEADING_PATTERN.test(el.tagName)) return;
    const label = (el.textContent || "").trim().slice(0, TOC_LABEL_LIMIT);
    if (label) found.push({ label, block: i, level: 0 });
  });
  return found;
}

export function buildTocItems(pageHtml, tocOutline, win) {
  try {
    const Parser = (win && win.DOMParser) || globalThis.DOMParser;
    const doc = new Parser().parseFromString("<body>" + pageHtml + "</body>", "text/html");
    const blocks = [...doc.body.querySelectorAll(READER_BLOCK_SELECTOR)];
    const withPages = (items) => items.map((it) => ({ ...it, page: tocPageAnchor(blocks, it.block) }));
    const outlineItems = tocItemsFromOutline(blocks, tocOutline);
    if (outlineItems.length) return withPages(outlineItems);
    const usable = (items) => items.length > 0 && !tocLooksLikeNoise(items, blocks);
    const headings = tocItemsFromHeadings(blocks);
    if (usable(headings)) return withPages(headings);
    const printed = tocFromPrintedContents(blocks);
    if (usable(printed)) return withPages(printed);
    const bold = tocFromBoldParagraphs(blocks);
    if (usable(bold)) return withPages(bold);
    return [];
  } catch {
    return [];
  }
}

export function tocNorm(raw) {
  return String(raw || "").toLowerCase()
    .replace(TOC_PUNCTUATION_PATTERN, " ")
    .replace(TOC_WHITESPACE_PATTERN, " ")
    .trim();
}

export function tocPrintedLines(blocks) {
  const tocLines = [];
  blocks.forEach((el, i) => {
    if (!el.classList || !el.classList.contains(TOC_LINE_CLASS)) return;
    const titleEl = el.querySelector ? el.querySelector(TOC_TITLE_SELECTOR) : null;
    const label = ((titleEl ? titleEl.textContent : el.textContent) || "").trim();
    if (label) tocLines.push({ at: i, label });
  });
  return tocLines;
}

export function tocBodyAfterContents(blocks, cutoff) {
  const bodyTexts = [];
  blocks.forEach((el, i) => {
    if (i <= cutoff) return;
    if (el.classList && el.classList.contains(TOC_LINE_CLASS)) return;
    const text = tocNorm(el.textContent);
    if (text) bodyTexts.push({ i, text });
  });
  return bodyTexts;
}

export function tocTitleMatches(candidate, want) {
  if (candidate === want || candidate.startsWith(want + " ")) return true;
  return want.length >= TOC_TITLE_PREFIX_MIN && candidate.startsWith(want);
}

export function tocFromPrintedContents(blocks) {
  const tocLines = tocPrintedLines(blocks);
  if (tocLines.length === 0) return [];
  const bodyTexts = tocBodyAfterContents(blocks, tocLines[tocLines.length - 1].at);
  const matched = [];
  let searchFrom = 0;
  for (const { label } of tocLines) {
    const want = tocNorm(label);
    if (!want.length) continue;
    const hit = bodyTexts.findIndex((entry, k) => k >= searchFrom && tocTitleMatches(entry.text, want));
    if (hit === -1) continue;
    matched.push({ label: label.slice(0, TOC_LABEL_LIMIT), block: bodyTexts[hit].i, level: 0 });
    searchFrom = hit + 1;
  }
  return matched.length >= TOC_MIN_RELIABLE ? matched : [];
}

const TOC_BOLD_MAX_CHARS = 80;
const TOC_BOLD_MIN_CHARS = 3;
const TOC_BOLD_MIN_SINGLE_WORD = 12;
const TOC_SENTENCE_ENDING = /[.!?;:]$/;
const TOC_BOLD_WRAP_PATTERN = /^(B|STRONG)$/;
const TOC_PAGER_NOISE_PATTERN = /^[\dIVXLCМ.,\s—–-]+$/i;

export function tocBoldHeadingText(el) {
  const heading = (el.textContent || "").trim();
  if (!heading || heading.length > TOC_BOLD_MAX_CHARS || heading.length < TOC_BOLD_MIN_CHARS) return null;
  if (TOC_SENTENCE_ENDING.test(heading)) return null;
  const kids = [...(el.children || [])];
  const bold = kids.length === 1 && TOC_BOLD_WRAP_PATTERN.test(kids[0].tagName)
    && (kids[0].textContent || "").trim() === heading;
  if (!bold) return null;
  if (!/\s/.test(heading) && heading.length < TOC_BOLD_MIN_SINGLE_WORD) return null;
  return TOC_PAGER_NOISE_PATTERN.test(heading) ? null : heading;
}

export function tocFromBoldParagraphs(blocks) {
  const boldItems = [];
  blocks.forEach((el, i) => {
    if (el.tagName !== "P" || (el.classList && el.classList.contains(TOC_LINE_CLASS))) return;
    const text = tocBoldHeadingText(el);
    if (text) boldItems.push({ label: text.slice(0, TOC_LABEL_LIMIT), block: i, level: 0 });
  });
  const repeats = new Map();
  for (const it of boldItems) repeats.set(it.label, (repeats.get(it.label) || 0) + 1);
  const unique = boldItems.filter((it) => repeats.get(it.label) <= 2);
  if (unique.length > Math.max(1, blocks.length / TOC_NOISE_BLOCKS_PER_PAGE)) return [];
  return unique.length >= TOC_MIN_RELIABLE ? unique : [];
}

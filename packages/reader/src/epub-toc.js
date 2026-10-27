// A printed table-of-contents page inside a reflowable EPUB is just text:
// the file can have a blank nav/NCX even though the first pages show a normal
// contents list. This module finds those entries in the loaded section DOMs
// and matches them to body headings so the caller can create CFI targets.
// It is deliberately independent of the renderer and of the AI provider.
import { cleanTocLine, parseTocLine } from "./pdf-toc.js";

const TOC_HEADING = /^(table of contents?|contents|目录|目\s*录)$/i;
const BLOCK_SELECTOR = "p,li,tr,dt,dd";
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const CONTAINER_TAGS = new Set(["UL", "OL", "NAV", "TABLE", "U"]);
const MAX_TOC_ENTRIES = 200;
const MAX_TOC_SECTIONS = 16;

export function normalizeTocText(value) {
  return String(value || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, " ")
    .toLowerCase()
    .replace(/[.…·]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function printedTocTitle(value) {
  const clean = cleanTocLine(value);
  if (!clean) return "";
  const parsed = parseTocLine(clean);
  if (parsed) return parsed.title;
  // Some rows in a printed contents page have no page number at all.
  return clean.replace(/\s+\d{1,4}\s*$/, "").trim();
}

function hasTocHeading(el) {
  return !!(el && TOC_HEADING.test(cleanTocLine(el.textContent)));
}

function outermostTocHeadings(doc) {
  const all = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,div")]
    .filter(hasTocHeading);
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

function nextFlowElement(el) {
  let node = el;
  while (node && !node.nextElementSibling) node = node.parentElement;
  return node?.nextElementSibling || null;
}

function entryBlocks(container) {
  const blocks = [...container.querySelectorAll(BLOCK_SELECTOR)]
    .filter((el) => !el.querySelector(BLOCK_SELECTOR))
    .filter((el) => !el.querySelector("table,ul,ol"));
  if (blocks.length) return blocks;
  return [...container.querySelectorAll("a[href]")].filter((el) => cleanTocLine(el.textContent));
}

function containerLike(el) {
  if (!el || el.nodeType !== 1) return false;
  if (CONTAINER_TAGS.has(el.tagName)) return true;
  return /(?:^|[-_\s])(?:toc|contents?|table-of-contents|目录)(?:$|[-_\s])/i
    .test(`${el.id || ""} ${el.className || ""}`);
}

function entriesFromBlocks(blocks, { requirePageNumber = false } = {}) {
  const entries = [];
  const seen = new Set();
  for (const block of blocks) {
    const raw = cleanTocLine(block.textContent);
    if (!raw) continue;
    const anchor = block.matches("a[href]") ? block : block.querySelector("a[href]");
    // A fallback over sibling paragraphs has no container boundary. Without a
    // printed page number, dot leaders or a real link the following body
    // paragraphs look exactly like title lines, so only accept genuine TOC
    // rows there.
    if (requirePageNumber && !anchor && !/(?:[.…·]{2,}|\d)\s*$/.test(raw)) continue;
    const title = printedTocTitle(raw);
    if (!title || title.length < 2 || title.length > 180) continue;
    if (TOC_HEADING.test(title)) continue;
    if (/^\d+$/.test(title)) continue;
    const key = normalizeTocText(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      title,
      level: 1,
      href: anchor?.getAttribute("href") || "",
    });
    if (entries.length >= MAX_TOC_ENTRIES) break;
  }
  return entries;
}

function siblingBlocks(heading) {
  const blocks = [];
  for (let node = nextFlowElement(heading); node; node = node.nextElementSibling) {
    if (node.matches("h1,h2,h3,h4,h5,h6")) break;
    const nested = entryBlocks(node);
    const candidates = nested.length ? nested : [node];
    let useful = 0;
    for (const block of candidates) {
      const title = printedTocTitle(block.textContent);
      if (title.length >= 2) useful += 1;
      blocks.push(block);
      if (blocks.length >= MAX_TOC_ENTRIES) return blocks;
    }
    if (!useful && blocks.length > 2) break;
  }
  return blocks;
}

// Finds the first printed contents page. `sections` is
// [{ index, id, doc }] in spine order.
export function findPrintedToc(sections) {
  for (const section of (sections || []).slice(0, MAX_TOC_SECTIONS)) {
    if (!section?.doc) continue;
    for (const heading of outermostTocHeadings(section.doc)) {
      let container = null;
      for (let node = nextFlowElement(heading), tries = 0; node && tries < 4; node = node.nextElementSibling, tries += 1) {
        if (containerLike(node) && entryBlocks(node).length) {
          container = node;
          break;
        }
      }
      let entries = [];
      if (container) entries = entriesFromBlocks(entryBlocks(container));
      if (entries.length < 2) {
        entries = entriesFromBlocks(siblingBlocks(heading), { requirePageNumber: true });
      }
      // A real contents page almost always has several rows. Requiring two
      // avoids treating a stray "Contents" paragraph in body prose as a TOC.
      if (entries.length >= 2) {
        return {
          sectionIndex: section.index,
          sectionId: section.id == null ? "" : String(section.id),
          heading,
          container,
          entries,
        };
      }
    }
  }
  return null;
}

function candidateElements(sections, toc) {
  const out = [];
  for (const section of sections || []) {
    if (!section?.doc) continue;
    const nodes = [...section.doc.querySelectorAll(`${HEADING_SELECTOR},${BLOCK_SELECTOR}`)];
    for (const el of nodes) {
      if (section.index === toc.sectionIndex && toc.container?.contains(el)) continue;
      if (el.closest("nav[epub\\:type='toc'], nav[role='doc-toc']")) continue;
      if (el.querySelector(BLOCK_SELECTOR)) continue;
      const text = cleanTocLine(el.textContent);
      if (!text || text.length < 2 || text.length > 180) continue;
      const heading = el.matches(HEADING_SELECTOR);
      const bold = !heading && !!el.querySelector("b,strong");
      out.push({
        sectionIndex: section.index,
        sectionId: section.id == null ? "" : String(section.id),
        doc: section.doc,
        el,
        text,
        key: normalizeTocText(text),
        priority: heading ? 0 : bold ? 1 : 2,
      });
    }
  }
  return out;
}

function elementPath(el) {
  const path = [];
  let node = el;
  while (node?.parentElement) {
    path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    node = node.parentElement;
  }
  return path;
}

function resolveTocHref(sectionId, href) {
  const value = String(href || "").trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (value.startsWith("#")) return sectionId ? `${sectionId}${value}` : value;
  try {
    const base = new URL(`https://qbr.invalid/${sectionId || ""}`);
    return decodeURI(new URL(value, base).pathname.replace(/^\/+/, ""));
  } catch {
    return value;
  }
}

function findCandidate(candidates, wanted, from) {
  let best = null;
  for (let index = from; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate.key) continue;
    let score = -1;
    if (candidate.key === wanted) score = 0;
    else if (wanted.length >= 12 && candidate.key.startsWith(`${wanted} `)) score = 1;
    else if (candidate.key.length >= 12 && wanted.startsWith(`${candidate.key} `)) score = 2;
    else if (wanted.length >= 18 && candidate.key.startsWith(wanted)) score = 2;
    else if (wanted.length >= 18 && wanted.startsWith(candidate.key)) score = 3;
    if (score < 0) continue;
    const rank = score * 10 + candidate.priority;
    if (!best || rank < best.rank) best = { candidate, rank, index };
  }
  return best;
}

// Matches plain titles (for example a TOC generated from an AZW3) against body
// elements in another set of sections, such as an EPUB produced by Calibre.
// The converted EPUB has different section paths and no CFI from the original
// book, so the portable export needs section paths and anchor paths instead.
export function matchTocTitles(sections, titles = []) {
  const toc = findPrintedToc(sections);
  const candidates = candidateElements(sections, {
    sectionIndex: toc?.sectionIndex ?? -1,
    container: toc?.container || null,
  });
  const entries = [];
  let from = 0;
  for (const item of titles) {
    const title = String(item?.title || item?.label || "").trim();
    const wanted = normalizeTocText(title);
    if (!wanted) continue;
    const hit = findCandidate(candidates, wanted, from);
    if (!hit) continue;
    entries.push({
      title,
      level: Math.max(1, Number(item.level) || 1),
      sectionId: hit.candidate.sectionId == null ? "" : String(hit.candidate.sectionId),
      anchorPath: elementPath(hit.candidate.el),
      anchorText: cleanTocLine(hit.candidate.el.textContent).slice(0, 240),
      anchorId: `qbr-toc-${entries.length + 1}`,
    });
    from = hit.index + 1;
  }
  return entries;
}

// Matches every printed title to the first plausible body occurrence after
// the previous one. No page numbers are involved: the target is a CFI.
export function buildEpubToc(sections, { cfiFromRange = null } = {}) {
  const toc = findPrintedToc(sections);
  if (!toc) return { ok: false, reason: "no-printed-toc", entries: [], skipped: 0 };
  const candidates = candidateElements(sections, toc);
  const entries = [];
  let from = 0;
  let skipped = 0;
  for (const item of toc.entries) {
    const wanted = normalizeTocText(item.title);
    if (!wanted) continue;
    const hit = findCandidate(candidates, wanted, from);
    if (!hit) {
      const href = resolveTocHref(toc.sectionId, item.href);
      if (!href) {
        skipped += 1;
        continue;
      }
      entries.push({ title: item.title, level: Math.max(1, Number(item.level) || 1), cfi: "", href });
      continue;
    }
    let cfi = "";
    if (typeof cfiFromRange === "function") {
      try {
        const range = hit.candidate.doc.createRange();
        range.selectNodeContents(hit.candidate.el);
        cfi = String(cfiFromRange(hit.candidate.sectionIndex, range) || "");
      } catch {
        cfi = "";
      }
    }
    if (!cfi && !item.href) {
      skipped += 1;
      continue;
    }
    entries.push({
      title: item.title,
      level: Math.max(1, Number(item.level) || 1),
      cfi,
      // A section-level href would highlight the first generated row for every
      // chapter in the reader panel; the CFI is the precise target.
      href: cfi ? "" : resolveTocHref(toc.sectionId, item.href),
      sectionId: hit.candidate.sectionId == null ? "" : String(hit.candidate.sectionId),
      anchorPath: elementPath(hit.candidate.el),
      anchorText: cleanTocLine(hit.candidate.el.textContent).slice(0, 240),
      anchorId: `qbr-toc-${entries.length + 1}`,
    });
    from = hit.index + 1;
  }
  return {
    ok: entries.length > 0,
    reason: entries.length ? "" : "no-matching-headings",
    sectionIndex: toc.sectionIndex,
    sectionId: toc.sectionId,
    entries,
    skipped,
  };
}

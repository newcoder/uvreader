// 封面用的系统字体栈:不再下载/嵌入字体,能命中系统字体就用,否则回退衬线。
const COVER_FONTS = {
  heading: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', Georgia, serif",
  body: "'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif",
};

// 书坊:电子书制作向导的构建 runner(txt/md → 章节 → 字体子集 → EPUB)。
// 样式、字体搭配都来自面板;字体下载/子集失败时回退系统字体,不阻断生成。
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { buildEpub, BOOK_STYLE_DEFAULTS, collectBookImages } from "./epub-build.js";
import { createBookTranslator } from "./book-translate.js";
import { convertChineseScript, scriptTargetLabel } from "./book-script.js";
import { convertEpubScript } from "./epub-script.js";
import { translateEpub } from "./epub-translate.js";
import { appendTranslationSuffix, directionForSource, normalizeTranslationTarget, scriptOutputSuffix, splitTranslationBlocks, translationLanguagePair, translationOutputSuffix } from "../shared/book-translation.js";
import { buildPolishMarkdown, collectNoteTexts, derivePolishReport, noteLabelOf, parsePolishMarkdown, splitPolishMarkdown, stripPolishComments, tidyOcrText } from "../shared/polish-markdown.js";
import { spaceOutputPath, spaceRootForSource } from "../../../../packages/reader/src/space-paths.js";
import { detectBookLanguage, detectSourceLanguage } from "../shared/language-detect.js";
import { collectMathFromMarkdown, countRawFormulas, markdownToHtml, stripBom, textToChapters, textToHtml } from "./text-book.js";
import { decodeText } from "../shared/text-encoding.js";
import { extractMarkdown, extractionKind, splitMarkdownChapters } from "./extract-doc.js";
import { createMathRenderer, shareFormulaHtml } from "./math-render.js";
import { createTextLayerReader } from "./text-layer.js";
import { cleanChapterTitle, joinInlineFragment, looksLikeHeadingTitle, unwrapProseFences } from "../shared/markdown-fix.js";
import { buildNavPlan, chapterKey, chapterStartPages, fillPageGaps, isPrintedTocChapter, lastPrintedPageOf, normalizeNavLevels, parsePrintedTocEntries, printedPageOf, splitChaptersByToc, stripPageMarkers, stripPrintedToc, tocKey } from "../shared/printed-toc.js";
import { outlineToTocEntries } from "./pdf-outline.js";
import { forgetPolishNote, normalizePolishCover, readPolishBundle, savePolishManifest, savePolishSession, validatePolishStructure } from "./polish-session.js";
import { convertPath } from "../shared/workshop-names.js";
import { textSourceKind } from "../shared/workshop-formats.js";

// 精修产物用用户给的 tag 做后缀，原文件不覆盖。tag 只进文件名，不能带路径分隔符。
export function safePolishTag(value) {
  const text = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 40)
    .trim();
  return text || "精修";
}

function polishCommentAttrs(raw) {
  const attrs = {};
  for (const attr of String(raw || "").matchAll(/([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s>]+))/g)) {
    attrs[attr[1]] = attr[2] ?? attr[3] ?? "";
  }
  return attrs;
}

function escapeFootnoteText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// OCR sometimes leaves a space in the closing tag (`</su p>`); repair it before
// the marker/link regexes run, or the rest of the paragraph is escaped as text.
function normalizeSupMarkup(value) {
  return String(value || "")
    .replace(/<\s*sup\b([^>]*)>([\s\S]*?)<\s*\/\s*su\s*p\s*>/gi, "<sup$1>$2</sup>")
    .replace(/<\s*\/\s*su\s*p\s*>/gi, "</sup>");
}

function safeChapterFile(value, fallback) {
  const text = String(value || "");
  return /^chapter-\d{3}\.xhtml$/i.test(text) ? text : fallback;
}

// 把精修注释里的 marker/note 转成 EPUB 内部链接：正文标注 → 注释，注释编号 → 正文标注。
// 注释可能在后面的“注释”章节，所以 href 要带目标 xhtml 文件名。
function chapterIndexMatches(manifestChapters, chapters) {
  const oldList = Array.isArray(manifestChapters) ? manifestChapters : [];
  const oldTitles = oldList.map((chapter) => String(chapter?.title || "").trim());
  const newTitles = (Array.isArray(chapters) ? chapters : []).map((chapter) => String(chapter?.title || "").trim());
  const rows = oldTitles.length;
  const cols = newTitles.length;
  const dp = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      dp[row][col] = oldTitles[row - 1] === newTitles[col - 1]
        ? dp[row - 1][col - 1] + 1
        : Math.max(dp[row - 1][col], dp[row][col - 1]);
    }
  }
  const anchors = [];
  let row = rows;
  let col = cols;
  while (row > 0 && col > 0) {
    if (oldTitles[row - 1] === newTitles[col - 1]) {
      anchors.push([row - 1, col - 1]);
      row -= 1;
      col -= 1;
    } else if (dp[row - 1][col] >= dp[row][col - 1]) {
      row -= 1;
    } else {
      col -= 1;
    }
  }
  anchors.reverse();
  // 标题可能有手工改名。两个相同标题锚点之间的章节按顺序对齐，
  // 这样“康”被删掉时，后面的章节仍然整体前移，不会因为改名丢映射。
  const matches = new Map();
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldIndex, newIndex] of [...anchors, [rows, cols]]) {
    while (oldCursor < oldIndex && newCursor < newIndex) {
      matches.set(newCursor, oldCursor);
      oldCursor += 1;
      newCursor += 1;
    }
    if (oldIndex < rows && newIndex < cols) {
      matches.set(newIndex, oldIndex);
      oldCursor = oldIndex + 1;
      newCursor = newIndex + 1;
    } else {
      oldCursor = Math.max(oldCursor, oldIndex);
      newCursor = Math.max(newCursor, newIndex);
    }
  }
  return matches;
}

function alignChapterMeta(manifestChapters, chapters) {
  const oldList = Array.isArray(manifestChapters) ? manifestChapters : [];
  const titles = (Array.isArray(chapters) ? chapters : []).map((chapter) => String(chapter?.title || "").trim());
  if (!oldList.length) {
    return titles.map((title, index) => ({
      id: `ch-${String(index + 1).padStart(3, "0")}`,
      title,
      format: "markdown",
    }));
  }
  if (oldList.length === titles.length) return oldList;
  const matches = chapterIndexMatches(oldList, chapters);
  return titles.map((title, index) => {
    const oldIndex = matches.get(index);
    if (oldIndex != null) return { ...oldList[oldIndex], title: title || oldList[oldIndex].title };
    return {
      id: `ch-extra-${String(index + 1).padStart(3, "0")}`,
      title: title || `第 ${index + 1} 章`,
      format: "markdown",
    };
  });
}

// 目录是“书里的印刷目录”，不是从正文标题重新拼的。章节删/并后只改 href，
// 保留原条目的标题和层级（例如“第五章 两淮盐务”这种正文里没有的父条目）。
export function remapChapterNav(nav, manifestChapters, chapters, chapterFiles) {
  const oldList = Array.isArray(manifestChapters) ? manifestChapters : [];
  const items = Array.isArray(nav) ? nav : [];
  if (!items.length) return [];
  const matches = chapterIndexMatches(oldList, chapters);
  const oldToNew = new Map();
  for (const [newIndex, oldIndex] of matches) oldToNew.set(oldIndex, newIndex);
  const titleToNew = new Map();
  (Array.isArray(chapters) ? chapters : []).forEach((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    if (title && !titleToNew.has(title)) titleToNew.set(title, index);
  });
  return items.map((item) => {
    const rawFile = String(item?.file || "");
    const match = /chapter-(\d+)\.xhtml(?:#.*)?$/i.exec(rawFile);
    const fragment = /#.*$/.exec(rawFile)?.[0] || "";
    const oldIndex = match ? Number(match[1]) - 1 : -1;
    let newIndex = oldToNew.get(oldIndex);
    if (newIndex == null) newIndex = titleToNew.get(String(item?.title || "").trim());
    if (newIndex == null) return null;
    return {
      ...item,
      title: String(item?.title || "").trim() || chapters[newIndex]?.title || "",
      file: `${chapterFiles[newIndex]}${fragment}`,
    };
  }).filter(Boolean);
}

function buildChapterNav(chapters, chapterFiles, oldNav = []) {
  const levelsByTitle = new Map();
  for (const item of Array.isArray(oldNav) ? oldNav : []) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    const level = Math.min(3, Math.max(1, Number(item?.level) || 1));
    if (!levelsByTitle.has(title)) levelsByTitle.set(title, []);
    levelsByTitle.get(title).push(level);
  }
  return (Array.isArray(chapters) ? chapters : []).map((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    const queue = levelsByTitle.get(title) || [];
    return {
      title: title || `第 ${index + 1} 章`,
      file: chapterFiles[index],
      level: queue.length ? queue.shift() : 1,
    };
  });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chapterIndexFromFile(file) {
  const match = /chapter-(\d+)\.xhtml(?:#.*)?$/i.exec(String(file || ""));
  return match ? Number(match[1]) - 1 : -1;
}

function insideHtmlTag(html, tag, offset) {
  const before = String(html || "").slice(0, offset);
  return before.lastIndexOf(`<${tag}`) > before.lastIndexOf(`</${tag}>`);
}

function insideAuthorAffiliation(html, offset) {
  const before = String(html || "").slice(0, offset);
  const paragraph = before.lastIndexOf("<p");
  if (paragraph < 0 || paragraph < before.lastIndexOf("</p>")) return false;
  const block = before.slice(paragraph);
  return /Claire Lifan Chen|Ata Mahjoubfar|Li-Chia Tai|Ian K\. Blaby|Allen Huang|Kayvan Reza Niazi|Bahram Jalali/.test(block);
}

// PDF 大纲里的子目录经常只给标题和页码，没有真实 heading。EPUB 要能跳转，
// 就必须在正文里给这些标题补一个稳定锚点，并让 nav 指向 chapter-xxx.xhtml#id。
function findTitleOccurrence(html, title, { last = false } = {}) {
  const text = String(html || "");
  const bodyStart = text.search(/<body\b/i);
  if (text.trim() && bodyStart < 0 && !/<(?:h[1-6]|p|strong)\b/i.test(text)) return null;
  const parts = String(title || "").trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  const pattern = new RegExp(parts.join("\\s+"), "gi");
  pattern.lastIndex = bodyStart >= 0 ? bodyStart : 0;
  let best = null;
  let match;
  while ((match = pattern.exec(text))) {
    const offset = match.index;
    const lastOpen = text.lastIndexOf("<", offset);
    const lastClose = text.lastIndexOf(">", offset);
    if (lastOpen > lastClose) continue;
    const before = text.slice(Math.max(0, offset - 180), offset);
    let score = 40;
    if (/<(?:h[1-6]|strong)\b[^>]*>\s*$/i.test(before)) score = 100;
    else if (/<p\b[^>]*>\s*$/i.test(before)) score = 80;
    else if (/[.。!！?？]\s*$/.test(before)) score = 60;
    if (last) {
      // For a front-matter chapter that repeats its own title (序 appears in
      // the running header and again before the body), the last heading is the
      // real section; ordinary prose mentions score 40 and are ignored.
      if (score >= 80) best = { index: offset, score };
      continue;
    }
    if (!best || score > best.score) best = { index: offset, score };
    if (score >= 100) break;
  }
  return best;
}

export function addNavAnchors(navItems, chapters, { bookTitle = "" } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  const html = list.map((chapter) => String(chapter?.html || ""));
  const files = list.map((_chapter, index) => `chapter-${String(index + 1).padStart(3, "0")}.xhtml`);
  const used = new Map();
  const flatTitles = new Set([
    "additionalinformation",
    "supplementaryinformation",
    "authorcontributions",
    "competinginterests",
  ]);
  const frontTitles = new Set([
    "introduction",
    "引言",
    "导言",
    "前言",
    "序言",
    "绪论",
  ]);
  const nav = (Array.isArray(navItems) ? navItems : []).map((item, itemIndex) => {
    const title = String(item?.title || "").trim();
    if (!title) return { ...item };
    const existingFragment = /#([^#\s]+)$/.exec(String(item?.file || ""))?.[1];
    const fragmentIndex = chapterIndexFromFile(item?.file);
    if (existingFragment && fragmentIndex >= 0 && html[fragmentIndex]?.includes(`id="${existingFragment}"`)) {
      return { ...item };
    }
    const titleKey = tocKey(title);
    const oldIndex = chapterIndexFromFile(item?.file);
    // The article title is the book title; the PDF outline often numbers it on
    // the first page, not on the first body heading.
    if (Number(item?.level) === 1 && bookTitle && titleKey === tocKey(bookTitle)) {
      return { ...item, file: files[0] || item.file };
    }
    let best = null;
    for (let index = 0; index < html.length; index += 1) {
      if (tocKey(list[index]?.title) === titleKey) {
        const firstImage = html[index].search(/<img\b/i);
        const repeated = firstImage >= 0
          ? findTitleOccurrence(html[index], title, { last: true })
          : null;
        if (repeated && repeated.index > firstImage) {
          // 序 may start after the front-matter image plates; point at the real
          // heading instead of the chapter file's first page.
          const score = 220 + (index === oldIndex ? 25 : 0);
          if (!best || score > best.score) best = { index, offset: repeated.index, score };
          continue;
        }
        const score = 120 + (index === oldIndex ? 25 : 0);
        if (!best || score > best.score) best = { index, offset: 0, score, chapterStart: true };
      }
    }
    const consider = (index, bonus = 0, allowLowScore = false) => {
      if (index < 0 || index >= html.length) return;
      const found = findTitleOccurrence(html[index], title);
      if (!found) return;
      if (!allowLowScore && found.score < 80) return;
      const score = found.score + bonus;
      if (!best || score > best.score) best = { index, offset: found.index, score };
    };
    const frontSection = frontTitles.has(titleKey);
    if (oldIndex >= 0 && !frontSection) consider(oldIndex, 25, true);
    for (let index = 0; index < html.length; index += 1) {
      if (index !== oldIndex) consider(index, 0, flatTitles.has(titleKey));
    }
    if (!best && frontSection) {
      return { ...item, file: files[0] || item.file };
    }
    if (!best) {
      const fallback = oldIndex >= 0 ? oldIndex : 0;
      return { ...item, file: files[fallback] || item.file };
    }
    if (best.chapterStart) {
      return { ...item, file: files[best.index] };
    }
    const chapterTitle = String(list[best.index]?.title || "").trim();
    if (chapterTitle && tocKey(chapterTitle) === titleKey && best.offset === 0) {
      return { ...item, file: files[best.index] };
    }
    const anchorKey = `${best.index}:${titleKey}`;
    let anchorId = used.get(anchorKey);
    if (!anchorId) {
      anchorId = `nav-${String(itemIndex + 1).padStart(2, "0")}`;
      used.set(anchorKey, anchorId);
      html[best.index] = `${html[best.index].slice(0, best.offset)}<a id="${anchorId}"></a>${html[best.index].slice(best.offset)}`;
    }
    return { ...item, file: `${files[best.index]}#${anchorId}` };
  });
  list.forEach((chapter, index) => {
    chapter.html = html[index];
  });
  return nav;
}

// PDF 论文的参考文献列表通常只有 <ol><li>，正文用 <sup>N</sup> 引用。
// 给参考文献补 id，再把正文数字上标变成可点击链接；已有注文链接保持不变。
export function linkReferenceCitations(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const referenceTitles = new Set(["references", "reference", "bibliography", "参考文献", "引用文献", "参考资料"]);
  const refIndex = list.findIndex((chapter) => {
    const title = String(chapter?.title || "").trim();
    return tocKey(title) === "references" || referenceTitles.has(title.toLowerCase());
  });
  if (refIndex < 0) return;
  let refCount = 0;
  let refHtml = String(list[refIndex]?.html || "");
  refHtml = refHtml.replace(/<li\b([^>]*)>/gi, (whole, attrs) => {
    refCount += 1;
    return /\bid\s*=/i.test(attrs) ? whole : `<li${attrs} id="ref-${refCount}">`;
  });
  if (!refCount) return;
  list[refIndex].html = refHtml;
  const refFile = `chapter-${String(refIndex + 1).padStart(3, "0")}.xhtml`;
  const firstCitation = new Map();
  list.forEach((chapter, index) => {
    if (index === refIndex || index > refIndex) return;
    const chapterFile = `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
    let html = String(chapter?.html || "");
    html = html.replace(/<sup>([^<]*)<\/sup>/g, (whole, label, offset) => {
      if (!/^\s*\d+(?:\s*[,，]\s*\d+)*\s*$/.test(label)) return whole;
      if (insideHtmlTag(html, "a", offset) || insideHtmlTag(html, "blockquote", offset)) return whole;
      const numbers = label.split(/[,，]/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= refCount);
      if (!numbers.length) return whole;
      // The first page's 1-7 superscripts are author affiliations, not citations.
      if (index === 0 && insideAuthorAffiliation(html, offset) && numbers.every((value) => value <= 7)) return whole;
      return `<sup>${numbers.map((value) => {
        let anchor = "";
        if (!firstCitation.has(value)) {
          firstCitation.set(value, { file: chapterFile, id: `cite-${value}` });
          anchor = ` id="cite-${value}"`;
        }
        return `<a${anchor} class="qbr-citation" href="${refFile}#ref-${value}">${value}</a>`;
      }).join(",")}</sup>`;
    });
    chapter.html = html;
  });
  if (!firstCitation.size) return;
  let linkedRefHtml = list[refIndex].html;
  for (const [value, citation] of firstCitation) {
    const pattern = new RegExp(`(<li id="ref-${value}"[^>]*>)([\\s\\S]*?)(</li>)`);
    linkedRefHtml = linkedRefHtml.replace(pattern, (_whole, open, body, close) => (
      `${open}${body}<a class="qbr-citation-back" href="${citation.file}#${citation.id}" aria-label="返回正文">↩</a>${close}`
    ));
  }
  list[refIndex].html = linkedRefHtml;
}

export function linkPolishFootnotes(chapters, { chapterIds = [], chapterFiles = [], markdown = "" } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  const files = chapterFiles.map((file, index) => safeChapterFile(file, `chapter-${String(index + 1).padStart(3, "0")}.xhtml`));
  const parsed = parsePolishMarkdown(markdown || list.map((chapter) => chapter?.text || "").join("\n\n"));
  const noteById = new Map(parsed.notes.map((note) => [note.id, note]));
  const firstMarkerByNote = new Map();
  for (const marker of parsed.markers) {
    if (marker.note && !firstMarkerByNote.has(marker.note)) firstMarkerByNote.set(marker.note, marker);
  }
  const fileByChapter = new Map();
  const noteFileById = new Map();
  const markerFileById = new Map();
  list.forEach((chapter, index) => {
    fileByChapter.set(`ch-${String(index + 1).padStart(3, "0")}`, files[index]);
    const text = String(chapter?.text || "");
    for (const match of text.matchAll(/<!--\s*polish:note\s+([^\s]+)/g)) {
      if (!noteFileById.has(match[1])) noteFileById.set(match[1], files[index]);
    }
    for (const match of text.matchAll(/<!--\s*polish:marker\s+([^\s]+)/g)) {
      if (!markerFileById.has(match[1])) markerFileById.set(match[1], files[index]);
    }
  });
  chapterIds.forEach((id, index) => {
    if (id) fileByChapter.set(String(id), files[index]);
  });
  const hrefFor = (currentFile, targetFile, id) => {
    const target = targetFile || currentFile;
    return target === currentFile ? `#${id}` : `${target}#${id}`;
  };
  return list.map((chapter, index) => {
    const currentFile = files[index];
    const lines = (isPrintedTocChapter(chapter) ? normalizeSupMarkup(chapter?.text || "") : tidyOcrText(normalizeSupMarkup(chapter?.text || ""))).split("\n");
    const output = [];
    let pendingNote = null;
    for (const line of lines) {
      const noteMatch = /^\s*<!--\s*polish:note\s+([^\s]+)([^>]*)-->\s*$/.exec(line);
      if (noteMatch) {
        pendingNote = { id: noteMatch[1], attrs: polishCommentAttrs(noteMatch[2]) };
        continue;
      }
      if (pendingNote) {
        if (!line.trim() || /^\s*<!--/.test(line)) {
          output.push(line);
          continue;
        }
        const marker = firstMarkerByNote.get(pendingNote.id);
        const label = /^(\s*)(\d+)([、.．)）])(.*)$/.exec(line);
        if (marker && label) {
          const markerFile = markerFileById.get(marker.id)
            || fileByChapter.get(String(marker.chapter || ""))
            || currentFile;
          const href = hrefFor(currentFile, markerFile, marker.id);
          const noteBody = String(label[4] || "").replace(/^\s+/, "");
          output.push(`${label[1]}<a id="${escapeFootnoteText(pendingNote.id)}" class="qbr-backlink" epub:type="backlink" href="${escapeFootnoteText(href)}">[${escapeFootnoteText(label[2])}]</a>${noteBody ? ` ${noteBody}` : ""}`);
        } else {
          output.push(line);
        }
        pendingNote = null;
        continue;
      }
      output.push(line);
    }
    let text = normalizeSupMarkup(output.join("\n"));
    text = text.replace(/<sup>([^<]*)<\/sup>\s*<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g, (whole, label, markerId, rawAttrs) => {
      const attrs = polishCommentAttrs(rawAttrs);
      const note = noteById.get(attrs.note);
      if (!note) return `<sup>${label}</sup>`;
      const noteFile = noteFileById.get(note.id)
        || fileByChapter.get(String(note.chapter || ""))
        || currentFile;
      const href = hrefFor(currentFile, noteFile, note.id);
      return `<a id="${escapeFootnoteText(markerId)}" class="qbr-noteref" epub:type="noteref" href="${escapeFootnoteText(href)}"><sup>[${escapeFootnoteText(label)}]</sup></a>`;
    });
    return text;
  });
}

// 公式表的键:同一道公式在中间稿里有多种写法(MinerU 的 `s _ {o} = f` 与文字层
// 合并后的 `s_o=f`;`\tag{…}` 有时还会是被截断的 `\tag{5.16`),而渲染时编号本来就
// 会被去掉。键统一成「去掉 \tag + 忽略全部空白」,两侧用同一套(实测《光学》有
// 2542 条跨行公式、上千条两种写法,不归一会成片回退成原始 LaTeX)。
export const mathKey = (latex) => String(latex || "")
  .replace(/\\tag\{[^}]*\}?/g, "")
  .replace(/\s+/g, "");

export function normalizeMathMap(map) {
  const normalized = new Map();
  for (const [latex, mathml] of Object.entries(map || {})) {
    const key = mathKey(latex);
    if (key && !normalized.has(key)) normalized.set(key, mathml);
  }
  return normalized;
}

function attr(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

// Renders one translated chapter as alternating source/translation blocks.
// Non-translatable blocks (headings, code, images, tables, formulas) stay in
// the source exactly once, so the generated EPUB cannot lose them.
export function bilingualChapterHtml(chapter = {}, translated = {}, {
  mode = "stacked",
  sourceLang = "zh",
  targetLang = "en",
  renderMath = null,
  lineAlign = false,
} = {}) {
  const blocks = Array.isArray(translated.blocks) ? translated.blocks : [];
  const sourceHtml = (block) => (block.markdown
    ? markdownToHtml(block.source, { renderMath, preserveLineBreaks: lineAlign })
    : textToHtml(block.source, { preserveLineBreaks: lineAlign }));
  const translationHtml = (block) => (block.markdown
    ? markdownToHtml(block.translation, { renderMath, preserveLineBreaks: lineAlign })
    : textToHtml(block.translation, { preserveLineBreaks: lineAlign }));
  if (mode === "translated") {
    const onlyTranslation = blocks.map((block) => {
      if (block.translatable && block.translation) return translationHtml(block);
      // Code, tables and figures cannot be translated safely. Keep those
      // source blocks instead of silently deleting them from the translated
      // edition.
      return sourceHtml(block);
    }).join("\n");
    return {
      title: String(chapter.title || ""),
      text: String(chapter.text || ""),
      html: onlyTranslation,
    };
  }
  const translatedTitle = translated.translatedTitle
    ? `<p class="qbr-title-translation" lang="${attr(targetLang)}" xml:lang="${attr(targetLang)}">${textToHtml(translated.translatedTitle)}</p>`
    : "";
  const html = blocks.map((block) => {
    const original = sourceHtml(block);
    if (!block.translatable || !block.translation) return original;
    return `<div class="qbr-pair"><div class="qbr-source" lang="${attr(sourceLang)}" xml:lang="${attr(sourceLang)}">${original}</div><div class="qbr-translation" lang="${attr(targetLang)}" xml:lang="${attr(targetLang)}">${translationHtml(block)}</div></div>`;
  }).join("\n");
  return {
    title: String(chapter.title || ""),
    text: String(chapter.text || ""),
    html: `${translatedTitle}${translatedTitle ? "\n" : ""}${html}`,
  };
}

// 章节的「正文量」:去掉页锚点注释、图片、Markdown 标记后的字数。
function bodyChars(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#*`>|\s]/g, "").length;
}

// 版次/出版信息这类封面碎片(如「(第五版)」「第 2 版」「版权所有」):书首才有,别的地方别碰。
const FRONT_MATTER_TITLE = /^[（(][^）)]{1,12}[）)]$|第\s*\d+\s*版|版次|印刷|出版|ISBN|定价|版权|开本|字数|书号/i;

// 章节标题去噪 + 去掉「页眉/扉页」造成的重复短章:
//   - 标题清成纯文本(脚注标记 $^{①}$ 之类不进导航);
//   - 标题重复且正文很短(扉页/页眉/版权页)→ 丢掉;标题等于书名的也丢(书名页);
//   - 标题重复但正文够长 → 保留(真章节同名是可能的)。
export function normalizeBookChapters(chapters, bookTitle = "", { keepKeys = null } = {}) {
  const book = cleanChapterTitle(bookTitle).replace(/\s+/g, "").toLowerCase();
  const list = Array.isArray(chapters) ? chapters : [];
  const clean = list.map((chapter) => ({ chapter, title: cleanChapterTitle(chapter?.title || "") }));
  // 同名章节里「又有短页又有长章」的:短的那页是扉页/重复标题页,丢掉。
  const lengths = new Map();
  for (const { title, chapter } of clean) {
    const key = title.replace(/\s+/g, "").toLowerCase();
    if (!key) continue;
    const list = lengths.get(key) || [];
    list.push(String(chapter?.text || "").length);
    lengths.set(key, list);
  }
  const out = [];
  let dropped = 0;
  let frontMatter = 0;
  let index = 0;
  for (const { chapter, title } of clean) {
    const key = title.replace(/\s+/g, "").toLowerCase();
    const text = String(chapter?.text || "");
    const group = key ? lengths.get(key) || [] : [];
    const titlePage = key && group.length > 1 && text.trim().length < 200 && group.some((length) => length >= 200);
    // 封面/版次这类碎片:书首前 3 章里、标题看着像版次/出版信息、且正文几乎没内容(如「(第五版)」)。
    const junkFront = index < 3 && FRONT_MATTER_TITLE.test(title) && bodyChars(text) < 60;
    // 书名页(只有标题/作者)可以丢;但论文第一章常以书名/文章名开头,正文很长,
    // 不能再因为“标题等于书名”被误删。
    const bookTitlePage = Boolean(book && key === book && bodyChars(text) < 200);
    // 目录(大纲/目录页)认领过的章节一律保留 —— 否则「第13章」这类章节会被过滤掉,
    // 目录条目跟着变成「丢弃」(用户实测的缺章就是这么来的)。
    const claimed = keepKeys && key ? keepKeys.has(key) : false;
    if (!claimed && (titlePage || bookTitlePage || junkFront)) {
      dropped += 1;
      if (junkFront) frontMatter += 1;
      index += 1;
      continue;
    }
    // 半句碎片当标题(旧缓存/面板里可能还留着):标题文字接回上一章末尾,正文另起一段。
    if (title && !looksLikeHeadingTitle(title) && out.length) {
      const previous = out[out.length - 1];
      previous.text = `${joinInlineFragment(previous.text, title)}\n\n${text}`.trim();
      dropped += 1;
      index += 1;
      continue;
    }
    out.push({ ...chapter, title });
    index += 1;
  }
  // 全掉光就还原(宁可留着难看,也不能出空书)。
  if (!out.length) return { chapters: list, dropped: 0, frontMatter: 0 };
  return { chapters: out, dropped, frontMatter };
}

// HTML headings from a chapter, used to give front matter and image plates
// real navigation entries even when the stored TOC only knows chapter files.
const NAV_NOTE_HEADING_RE = /^【?\s*(?:注\s*释|注文|注解|脚注|尾注|章注|notes?|footnotes?|endnotes?)\s*】?\s*[:：]?$/i;

function htmlPlainText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function chapterNavHeadings(chapter, bookTitle = "") {
  const html = String(chapter?.html || "");
  const items = [];
  for (const match of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const title = htmlPlainText(match[2]);
    if (!title || title.length > 80 || NAV_NOTE_HEADING_RE.test(title)) continue;
    if (bookTitle && tocKey(title) === tocKey(bookTitle)) continue;
    if (items.length && tocKey(items[items.length - 1].title) === tocKey(title)) continue;
    const level = match[1] === "1" || /^(?:总\s*序|序|序\s*言|前\s*言|引\s*言|后\s*记|附\s*录)/.test(title) ? 1 : 2;
    items.push({ title, level, offset: match.index });
  }
  return items;
}

export function completeNavItems(navItems, chapters, { bookTitle = "" } = {}) {
  const nav = Array.isArray(navItems) ? navItems : [];
  const list = Array.isArray(chapters) ? chapters : [];
  if (!nav.length || !list.length) return nav;
  const byChapter = new Map();
  for (const item of nav) {
    const index = chapterIndexFromFile(item?.file);
    if (index < 0) continue;
    if (!byChapter.has(index)) byChapter.set(index, []);
    byChapter.get(index).push(item);
  }
  const first = Math.min(...byChapter.keys());
  const last = Math.max(...byChapter.keys());
  const bodyStart = list.findIndex((chapter) => /^第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]/.test(String(chapter?.title || "").trim()));
  const frontLimit = bodyStart >= 0 ? bodyStart : first;
  const result = [];
  for (let index = 0; index < list.length; index += 1) {
    const chapter = list[index] || {};
    const file = `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
    const existing = byChapter.get(index) || [];
    if (index > last) {
      if (chapter.title) result.push({ title: String(chapter.title).trim(), file, level: 1 });
      continue;
    }
    if (index >= frontLimit) {
      if (existing.length) result.push(...existing);
      else if (chapter.title) result.push({ title: String(chapter.title).trim(), file, level: 1 });
      continue;
    }
    const html = String(chapter.html || "");
    const firstImage = html.search(/<img\b/i);
    const chapterKey = tocKey(chapter.title);
    const headings = chapterNavHeadings(chapter, bookTitle);
    // A front-matter chapter often carries the next real section's title (the
    // PDF outline points 序 at the image plates before it). When the chapter
    // also contains image plates and internal headings, let the headings and
    // 图版 define the order instead of keeping a generic chapter-start entry.
    const chapterStart = existing.find((item) => (
      !/#/.test(String(item?.file || ""))
      && chapterKey
      && tocKey(item?.title) === chapterKey
    ));
    const dropChapterStart = Boolean(chapterStart && firstImage >= 0 && headings.length);
    const existingItems = dropChapterStart
      ? existing.filter((item) => item !== chapterStart)
      : existing;
    const titles = new Set(existingItems.map((item) => tocKey(item?.title)));
    if (existingItems.length) result.push(...existingItems);
    // Front matter can mix image plates and prose headings (总序, 图版说明).
    // Merge them by document position so the TOC follows the printed pages
    // instead of putting 图版 after 总序 just because it was detected later.
    const entries = headings
      .filter((heading) => !(dropChapterStart && chapterKey && tocKey(heading.title) === chapterKey && heading.offset < firstImage))
      .map((heading) => ({
        offset: heading.offset,
        item: { title: heading.title, file, level: heading.level },
      }));
    if (firstImage >= 0) {
      const figuresItem = existingItems.find((item) => tocKey(item?.title) === tocKey("图版"));
      if (figuresItem && !/#/.test(String(figuresItem.file || ""))) {
        figuresItem.file = `${file}#nav-figures`;
      }
      if (!figuresItem) {
        entries.push({
          offset: firstImage,
          item: { title: "图版", file: `${file}#nav-figures`, level: existingItems.length ? 2 : 1 },
        });
      }
      if (!html.includes('id="nav-figures"')) {
        chapter.html = html.replace(/<img\b/i, '<span id="nav-figures"></span><img');
      }
    }
    entries.sort((a, b) => a.offset - b.offset);
    if (!existingItems.length && !entries.length && chapter.title) {
      result.push({ title: String(chapter.title).trim(), file, level: 1 });
      titles.add(tocKey(chapter.title));
    }
    for (const entry of entries) {
      const key = tocKey(entry.item.title);
      if (!key || titles.has(key)) continue;
      titles.add(key);
      result.push(entry.item);
    }
  }
  return normalizeNavLevels(result);
}

export function firstMarkdownImage(text, sourceDir) {
  const match = String(text || "").match(/!\[[^\]]*\]\(([^)\s]+)/);
  if (!match) return "";
  const raw = match[1];
  if (/^https?:/i.test(raw) || raw.startsWith("data:")) return "";
  return path.isAbsolute(raw) ? raw : path.join(sourceDir, raw.replace(/[\\/]+/g, path.sep));
}

// 封面:指定图片 / 自动首图 / 模板生成(缺图时回退模板)。
// 没有可用目录(无大纲,或大纲只是页码标尺)时用正文标题当导航:mardown 的标题层级
// (h1/h2)就是导航层级。大纲里的顶层条目(作品名)当锚点:正文有同名标题就把它提为 1 级;
// 没有(如第二部作品名只在书签里)就按页码的**相对位置**插到对应章节 —— 页码顺序是对的,
// 相对位置可以信(用户口径)。《安妮·卡森诗选》正是这种:书签是页码标尺,正文标题才是目录。
export function chaptersToNavItems(chapters, { anchors = [], pages = [] } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  const items = [];
  list.forEach((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    if (!title || chapter?.syntheticTitle) return;
    items.push({ title, chapterIndex: index, level: Math.min(3, Math.max(1, Number(chapter?.level) || 1)) });
  });
  const known = (Array.isArray(pages) ? pages : []).filter((value) => value > 0);
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const label = String(anchor?.label || "").trim();
    if (!label) continue;
    const key = tocKey(label);
    const hit = items.find((item) => chapterKey(item.title) === key);
    if (hit) {
      hit.level = 1;
      continue;
    }
    const page = Number(anchor?.page) || 0;
    if (!(page > 0) || known.length < 4 || !list.length) continue;
    const ratio = known[known.length - 1] > known[0] ? (page - known[0]) / (known[known.length - 1] - known[0]) : 1;
    const index = Math.min(list.length - 1, Math.max(0, Math.round(ratio * (list.length - 1))));
    items.push({ title: label, chapterIndex: index, level: 1 });
  }
  return items
    .sort((a, b) => a.chapterIndex - b.chapterIndex || a.level - b.level)
    .map((item) => ({
      title: item.title,
      file: `chapter-${String(item.chapterIndex + 1).padStart(3, "0")}.xhtml`,
      level: item.level,
    }));
}

export async function resolveCover({ payload = {}, title = "", author = "", markdownText = "", sourceDir = "", _pairing = null, _cacheDir = "", coverRenderer = null, loadImage = null, log = () => {} } = {}) {
  const cover = payload.cover || {};
  const mode = String(cover.mode || "none");
  if (mode === "none") return null;
  const fit = String(cover.fit || "") === "cover" ? "cover" : "contain";
  const fromImage = async (imagePath) => {
    const image = loadImage ? await loadImage(imagePath) : null;
    if (!image?.data?.length) return null;
    const mediaType = image.mediaType || "image/jpeg";
    // File name and media type must always agree; readers reject a PNG that
    // claims to be cover.jpg (the fs fallback keeps the original format).
    const ext = {
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
      "image/tiff": ".tif",
      "image/jp2": ".jp2",
    }[mediaType] || ".jpg";
    return { data: image.data, mediaType, fileName: `cover${ext}`, fit };
  };
  if (mode === "image" && cover.imagePath) {
    const picked = await fromImage(cover.imagePath);
    if (picked) return picked;
    log("cover image missing", cover.imagePath);
  }
  if (mode === "auto") {
    const candidate = firstMarkdownImage(markdownText, sourceDir);
    if (candidate) {
      const picked = await fromImage(candidate);
      if (picked) return picked;
    }
  }
  if (!coverRenderer) return null;
  const stacks = COVER_FONTS;
  const rendered = await coverRenderer.render({
    title,
    author,
    subtitle: cover.subtitle,
    palette: cover.palette,
    headingFamily: stacks.heading,
    bodyFamily: stacks.body,
  });
  if (!rendered.ok) {
    log("cover render failed", rendered.error);
    return null;
  }
  return { data: rendered.data, mediaType: rendered.mediaType || "image/jpeg", fileName: "cover.jpg" };
}

const GENERIC_TOC_LABELS = new Set(["封面", "书名", "版权", "目录", "正文", "cover", "title", "copyright", "contents", "body"]);

// 有些扫描书的 PDF 大纲只有“封面/书名/版权/目录/正文”几条，真正的章节
// 目录在上游的 toc_entries 里。按“章节条目数量 + 非通用标题”给目录打分，
// 避免拿 6 条通用大纲覆盖 9 条印刷目录。
function tocEntriesQuality(entries = []) {
  let score = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const label = String(entry?.label || "").trim();
    const key = tocKey(label);
    if (!key) continue;
    if (GENERIC_TOC_LABELS.has(key)) score -= 3;
    else score += 1;
    if (/^第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]/.test(label)) score += 3;
    else if (/^(?:chapter|part)\s+/i.test(label)) score += 3;
  }
  return score + Math.min(Array.isArray(entries) ? entries.length : 0, 20) * 0.25;
}

export function pickPrimaryToc({ outlineEntries = [], upstreamToc = [], printedEntries = [] } = {}) {
  const choices = [];
  if (outlineEntries.length) choices.push({ source: "outline", entries: outlineEntries, score: tocEntriesQuality(outlineEntries) });
  if (upstreamToc.length) choices.push({ source: "upstream", entries: upstreamToc, score: tocEntriesQuality(upstreamToc) });
  if (printedEntries.length) choices.push({ source: "printed", entries: printedEntries, score: tocEntriesQuality(printedEntries) });
  if (!choices.length) return null;
  return choices.sort((left, right) => right.score - left.score)[0];
}

// 目录只做 P0 只读检查：把明显对不上的条目列进报告，不在精修里编辑。
function auditNavItems(navItems, chapters = []) {
  const issues = [];
  if (!Array.isArray(navItems)) return issues;
  const seen = new Set();
  const covered = new Set();
  for (const item of navItems) {
    const title = String(item?.title || "").trim();
    const file = String(item?.file || "");
    if (!title) issues.push({ kind: "empty-title", title, file });
    const match = /chapter-(\d+)\.xhtml(?:#.*)?$/i.exec(file);
    if (match && (Number(match[1]) < 1 || Number(match[1]) > chapters.length)) {
      issues.push({ kind: "missing-chapter", title, file });
    } else if (match) {
      covered.add(Number(match[1]) - 1);
    }
    const key = `${title}\n${file}`;
    if (title && seen.has(key)) issues.push({ kind: "duplicate-entry", title, file });
    if (title) seen.add(key);
  }
  (Array.isArray(chapters) ? chapters : []).forEach((chapter, index) => {
    if (covered.has(index)) return;
    issues.push({
      kind: "missing-chapter-entry",
      title: String(chapter?.title || "").trim(),
      file: `chapter-${String(index + 1).padStart(3, "0")}.xhtml`,
    });
  });
  return issues;
}

export function registerEpubRunners(workshop, { vaultRoot = "", cacheRoot = "", coverRenderer = null, readImage = null, docvortex = null, mathRenderer = createMathRenderer(), textLayer = createTextLayerReader(), outlineReader = null, engine = null, aiRuntime = null, spawnImpl = spawn, log = (...args) => console.log(...args) } = {}) {
  const translator = aiRuntime ? createBookTranslator({ aiRuntime, log }) : null;
  const absolute = (raw) => {
    const value = String(raw || "");
    return path.isAbsolute(value) ? value : path.join(vaultRoot, value);
  };
  // 指定图片:优先用注入的读图器(Electron nativeImage),否则按扩展名直读。
  const loadImage = async (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    if (readImage) {
      const loaded = await readImage(filePath).catch(() => null);
      if (loaded?.data?.length) return loaded;
    }
    const ext = path.extname(filePath).toLowerCase();
    // nativeImage converts most formats to JPEG. The raw fallback is only used
    // when that fails, so keep the original type instead of mislabelling bytes.
    const mediaType = {
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
    }[ext];
    if (!mediaType) return null;
    return { data: fs.readFileSync(filePath), mediaType, fileName: `cover${ext}` };
  };

  // txt / md → EPUB(向导的最小可用路径;后续接 Doc JSON 与封面)。
  workshop.register("book-build", async ({ payload, report, signal }) => {
    const settings = payload?.settings || {};
    const source = absolute(payload?.source);
    if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    const sourceKind = textSourceKind(source);
    const markdown = sourceKind === "markdown";
    const styles = { ...BOOK_STYLE_DEFAULTS, ...(payload?.styles || {}) };
    const translationMode = String(payload?.translation?.mode || "none");
    const translationRequested = translationMode === "stacked" || translationMode === "side" || translationMode === "translated";
    const scriptRequested = translationMode === "script";
    const sourceBase = path.basename(source).replace(/\.[^.]+$/, "");
    const customTitle = String(payload?.title || "").trim();
    // The final language suffix can only be added after the translated source
    // language has been detected (Chinese/English/German/文白).
    let title = customTitle || sourceBase;
    let out = payload?.out ? absolute(payload.out) : "";
    const outputCategory = translationRequested || scriptRequested ? "translations" : "exports";
    const outputPath = (suffix, base = sourceBase) => {
      const routed = spaceOutputPath(source, outputCategory, "epub", {
        base: appendTranslationSuffix(base, suffix),
        exists: (candidate) => fs.existsSync(absolute(candidate)),
      });
      if (routed) return absolute(routed);
      return absolute(convertPath(
        payload?.source,
        "epub",
        (candidate) => fs.existsSync(absolute(candidate)),
        appendTranslationSuffix(base, suffix),
      ));
    };

    // EPUB script conversion is a transparent copy: keep the original
    // chapter files, CSS, images and line breaks, and convert only text nodes.
    // The regular extract → Markdown → rebuild path flattens poetry lines.
    if (scriptRequested && /\.epub$/i.test(source)) {
      const directTarget = payload?.translation?.script === "s" ? "s" : "t";
      const nameSuffix = scriptOutputSuffix(directTarget);
      if (!out) out = outputPath(nameSuffix, convertChineseScript(sourceBase, directTarget));
      if (path.resolve(out) === path.resolve(source)) {
        throw new Error("输出路径不能覆盖原 EPUB，请换一个文件名");
      }
      report({ label: "读取 EPUB" });
      const converted = await convertEpubScript({
        source,
        out,
        target: directTarget,
        title: customTitle,
        report,
        signal,
      });
      report({ label: `简繁转换 · ${scriptTargetLabel(directTarget)}` });
      return {
        output: out,
        detail: `EPUB · 原格式 · ${converted.spineCount} 节 · ${converted.files} 个文件 · ${Math.round(fs.statSync(out).size / 1024)} KB · 简繁 ${scriptTargetLabel(directTarget)}`,
      };
    }

    report({ label: "读取内容" });
    const isText = Boolean(sourceKind);
    // 面板里编辑过的目录优先(改名/合并/拆分/排序);文本源按标题自动分章;
    // PDF / Office / OFD / 图片先内部提取(中间产物放缓存目录,用户无感)。
    const provided = Array.isArray(payload?.chapters) ? payload.chapters : [];
    // 工作目录按源文件稳定(路径 + 大小 + 修改时间):MinerU 的解析结果可以复用,
    // 重跑 / 换样式不会重新等云端解析。
    const sourceStat = fs.statSync(source);
    const workKey = crypto.createHash("sha1").update(`${source}\n${sourceStat.size}\n${sourceStat.mtimeMs}`).digest("hex").slice(0, 8);
    const workRoot = path.join(cacheRoot, "work", `${path.basename(source).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${workKey}`);
    // EPUB translation keeps the original chapter files and inline structure,
    // just like EPUB script conversion; rebuilding would flatten poetry lines.
    if (translationRequested && /\.epub$/i.test(source)) {
      const result = await translateEpub({
        source,
        out,
        outputPath,
        translator,
        mode: translationMode,
        direction: payload?.translation?.direction || "",
        target: payload?.translation?.target || "",
        classical: payload?.translation?.classical === true,
        glossary: payload?.translation?.glossary || "",
        lineAlign: payload?.translation?.lineAlign === true,
        customTitle,
        config: payload?.translation?.config || null,
        workRoot,
        signal,
        report,
        log,
      });
      const cached = result.stats.cachedChunks ? ` · 缓存 ${result.stats.cachedChunks} 块` : "";
      return {
        output: result.output,
        detail: `EPUB · 原格式 · ${result.spineCount} 节 · ${Math.round(fs.statSync(result.output).size / 1024)} KB · ${translationMode === "translated" ? "译文" : "双语"} ${result.stats.translatedBlocks} 段 · ${result.pair.sourceLabel} → ${result.pair.targetLabel}${cached}`,
      };
    }
    let text = "";
    let baseDir = path.dirname(source);
    // 上游(pdf_tool)给的目录条目:有就优先用(比从 md 文本兜底解析准)。
    let upstreamToc = [];
    let printedTocSplit = null;
    let rawChapters;
    // 目录优先级第一步:**PDF 自带大纲**(作者给的三级结构)。**必须在分章之前**读:
    // ① 章节过滤要靠它保住「目录认领过的章节」;② 分章要靠它保住「空章」(标题后紧跟
    // 下一级标题的文章标题页 —— 目录条目指的就是那里)。
    // 有的书(如《安妮·卡森诗选》)的 PDF 书签只是「每 20 页一个」的**页码标尺**,
    // 标题就是 001/020/…:那不是目录,过滤掉并改用正文标题(否则导航是一串数字)。
    let outlineEntries = [];
    let outlineIsPageRuler = false;
    if (outlineReader && /\.pdf$/i.test(String(source))) {
      const outline = await outlineReader.read(source, {
        python: String(settings.ocrPython || "").trim() || "python",
        workDir: path.join(workRoot, "outline"),
        signal,
        // 引擎配置(引擎可独立部署;给了就先走引擎,失败回退本机 python)
        engineSettings: settings,
      });
      if (outline.ok) {
        const stripped = stripPageMarkers(outlineToTocEntries(outline.outline));
        outlineEntries = stripped.entries;
        outlineIsPageRuler = stripped.ruler;
        if (stripped.dropped) log("book build outline page markers dropped", stripped.dropped, "条", stripped.ruler ? "(整份大纲是页码标尺)" : "");
      } else {
        log("book build pdf outline skipped", outline.error);
      }
      if (signal.aborted) throw new Error("任务已取消");
    }
    // 大纲只剩两三条(或本来就是页码标尺)时,它撑不起导航 —— 留着当「顶层锚点」,
    // 让正文标题来当目录(作品名 → 各节)。
    const outlineAnchors = outlineEntries.length >= 2 && outlineEntries.length <= 8 ? outlineEntries : [];
    if (outlineIsPageRuler || outlineEntries.length < 4) outlineEntries = [];
    // 目录点名要的标题键 + 判据:标题键相同、或标题键是目录键的超集
    // (「形式主义的数学基础 ① (1931)」 vs 目录里的「形式主义的数学基础」)。
    const outlineEntryKeys = new Set(outlineEntries.map((entry) => entry.key));
    const keepOutlineTitle = (value) => {
      const key = chapterKey(String(value || ""));
      if (!key) return false;
      for (const outlineKey of outlineEntryKeys) {
        if (!outlineKey) continue;
        if (key === outlineKey) return true;
        if (key.startsWith(outlineKey) && outlineKey.length >= Math.max(3, key.length * 0.5)) return true;
      }
      return false;
    };
    if (provided.length) {
      rawChapters = provided
        .map((chapter, index) => ({
          title: String(chapter?.title || (index === 0 ? title : `第 ${index + 1} 章`)).slice(0, 120),
          text: String(chapter?.text || ""),
          markdown: Boolean(markdown),
        }))
        .filter((chapter) => chapter.text.trim());
    } else if (isText) {
      // 编码按内容判(GB18030 的中文 TXT 很常见),不能一律 UTF-8。
      text = stripBom(decodeText(fs.readFileSync(source)));
      // 提取工具写出的 .md 里可能有「假代码块」(正文被包进围栏),先还原成段落。
      if (markdown) text = unwrapProseFences(text);
      // Markdown 有标题层级时按标题分章(与 PDF/Office 提取路径一致),否则按章节行 / 长度分。
      const found = markdown ? splitMarkdownChapters(text, { bookTitle: title, keepTitle: keepOutlineTitle }) : [];
      rawChapters = (found.length >= 2
        ? found.map((chapter, index) => ({ title: chapter.title || (index === 0 ? title : `第 ${index + 1} 章`), text: chapter.text }))
        : textToChapters(text, { markdown, title }).map((chapter) => ({ title: chapter.title, text: chapter.text })))
        .map((chapter) => ({ ...chapter, markdown: Boolean(markdown) }));
    } else {
      report({ label: "提取内容" });
      const extracted = await extractMarkdown(source, {
        kind: extractionKind(source),
        settings,
        docvortex,
        workDir: path.join(workRoot, "extract"),
        signal,
        log,
        spawnImpl,
        textLayer,
        engine,
        report,
        // 勾了「忽略缓存重新提取」就重跑上游(MinerU),否则复用缓存。
        refresh: payload?.refresh === true,
      });
      if (signal.aborted) throw new Error("任务已取消");
      if (!extracted.ok) throw new Error(String(extracted.error || "内容提取失败"));
      text = extracted.markdown;
      upstreamToc = Array.isArray(extracted.tocEntries) ? extracted.tocEntries : [];
      baseDir = path.dirname(extracted.path || source);
      const found = splitMarkdownChapters(text, { bookTitle: title, keepTitle: keepOutlineTitle });
      // 扫描书的正文标题常被 OCR 拆成页内小节（“寡妇”“彭”），按标题分章会
      // 得到一堆假章节。上游有印刷目录时，先按目录顺序回正文找落点重切。
      const tocSplit = upstreamToc.length >= 3
        ? splitChaptersByToc(text, upstreamToc)
        : null;
      if (tocSplit) log("book build chapters from printed toc", tocSplit.chapters.length, "matched", tocSplit.matched, "/", tocSplit.entries);
      printedTocSplit = tocSplit;
      const chapterSource = tocSplit?.chapters?.length ? tocSplit.chapters : found;
      rawChapters = (chapterSource.length
        ? chapterSource.map((chapter, index) => ({
          title: chapter.title || (index === 0 ? title : `第 ${index + 1} 章`),
          text: chapter.text,
          // 封面/无标题页的兜底标题只用于章节文件,不该进导航(见 buildNavPlan/chaptersToNavItems)。
          syntheticTitle: tocSplit ? false : !String(chapter.title || "").trim(),
        }))
        : textToChapters(text, { markdown: true, title }).map((chapter) => ({ title: chapter.title, text: chapter.text })))
        .map((chapter) => ({ ...chapter, markdown: true }));
    }
    if (!rawChapters.length) throw new Error("没有可写的内容");

    // 标题去噪 + 去掉页眉/扉页重复短章(提供的章节也照办:面板传过来的标题可能带
    // 脚注标记 $^{①}$,导航里就会看到这些符号)。
    const normalized = normalizeBookChapters(rawChapters, title, { keepKeys: outlineEntryKeys });
    const tocStrip = stripPrintedToc(normalized.chapters, { enabled: payload?.dropPrintedToc !== false });
    const bookChapters = tocStrip.chapters;
    if (tocStrip.dropped || tocStrip.removedLines) {
      log("book build printed toc dropped", tocStrip.dropped, "章", tocStrip.removedLines, "行");
    }
    if (normalized.dropped) log("book build repeated headers dropped", normalized.dropped, "章");
    if (normalized.frontMatter) log("book build cover fragments dropped", normalized.frontMatter, "章");

    // 公式(LaTeX → MathML)与图片(收进 EPUB):预览与成品都靠这两步。
    // 公式清单必须与下面 markdownToHtml 的请求完全一致:用同一个渲染器、按同样的
    // 「逐章」粒度收集(合并成一段收集会多出跨章边界的串,反而对不上)。
    const markdownChapters = bookChapters.filter((chapter) => chapter.markdown);
    const latexes = [...new Set(markdownChapters.flatMap((chapter) => collectMathFromMarkdown(chapter.text)))];
    let mathMap = null;
    if (latexes.length && mathRenderer) {
      report({ label: `渲染公式（${latexes.length}）` });
      const rendered = await mathRenderer.renderMap(latexes, {
        python: String(settings.ocrPython || "").trim() || "python",
        workDir: path.join(workRoot, "math"),
      });
      if (rendered.ok) mathMap = normalizeMathMap(rendered.map);
      else log("math render skipped", rendered.error);
      if (signal.aborted) throw new Error("任务已取消");
    }
    const renderMath = mathMap ? (latex, display) => shareFormulaHtml(mathMap.get(mathKey(latex)), display) : null;
    // 导航来源优先级已在上文定好:**PDF 自带大纲** > 上游 OCR 目录条目 > md 里的印刷目录 > 标题分章。
    const tocText = normalized.chapters.filter((chapter) => isPrintedTocChapter(chapter)).map((chapter) => chapter.text).join("\n");
    const printedEntries = tocText ? parsePrintedTocEntries(tocText) : [];
    let primaryToc = pickPrimaryToc({ outlineEntries, upstreamToc, printedEntries });
    // 已经用印刷目录重切过章节时，导航必须用同一份目录，否则章名和落点对不上。
    if (printedTocSplit && upstreamToc.length) primaryToc = { source: "upstream", entries: upstreamToc };
    const tocSource = primaryToc?.source || "";
    let navItems = null;
    let navSource = "";
    let navDropped = 0;
    if (tocSource) {
      const entries = primaryToc.entries;
      const usingPdfPages = tocSource === "outline";
      // 章首页码 = 上一章最后一个页锚点(标题常在本页中间,取本章第一个锚点会差 1~3 页;
      // 上一步删掉的印刷目录章也要参与计算,否则跨过它的几页会算错),再按删除情况对齐回章节表。
      const startPages = chapterStartPages(normalized.chapters, usingPdfPages ? {} : { of: printedPageOf, lastOf: lastPrintedPageOf })
        .filter((_page, index) => tocStrip.keptIndexes.has(index));
      // 页锚点有缺口时按相邻锚点插值(大纲页码精确,缺一格就少一条导航)。
      const pages = usingPdfPages ? fillPageGaps(startPages) : startPages;
      const plan = buildNavPlan({ chapters: bookChapters, tocEntries: entries, pages, pageTolerance: 2, pageFirst: usingPdfPages, orderFallback: usingPdfPages });
      if (plan) {
        navItems = normalizeNavLevels(plan.items).map((item) => ({
          title: item.title,
          file: `chapter-${String(item.chapterIndex + 1).padStart(3, "0")}.xhtml`,
          level: item.level,
        }));
        // 目录条目的标题比正文里的残缺占位好(上游把「第4章 …」拆成了「第」):
        // 用目录标题把章节名补齐,正文标题也就跟着对了。
        for (const item of plan.items) {
          const chapter = bookChapters[item.chapterIndex];
          if (!chapter) continue;
          const current = String(chapter.title || "").replace(/[^\p{L}\p{N}]/gu, "");
          if (current.length <= 2 && item.title) chapter.title = item.title;
        }
        navDropped = plan.dropped.length;
        navSource = tocSource;
        log("book build nav from toc", tocSource, plan.matched, "entries", navDropped, "dropped");
        if (plan.dropped.length) log("book build nav dropped", plan.dropped.slice(0, 10).map((label) => String(label).slice(0, 30)).join(" / "));
      } else {
        log("book build nav from toc skipped", "matched too few entries");
      }
    }
    // 没有可用目录(没有大纲 / 大纲只是页码标尺 / 大纲对不上正文):用正文标题当导航,
    // 大纲剩下的顶层条目(作品名)当锚点。这样《安妮·卡森诗选》这类书得到的是
    // 「作品 → 各节」的目录,而不是一串页码。
    if (!navItems) {
      const pdfPages = fillPageGaps(chapterStartPages(normalized.chapters).filter((_page, index) => tocStrip.keptIndexes.has(index)));
      navItems = normalizeNavLevels(chaptersToNavItems(bookChapters, { anchors: outlineAnchors, pages: pdfPages }));
      navSource = "headings";
      log("book build nav from headings", navItems.length, "条", outlineAnchors.length ? `(另用大纲顶层 ${outlineAnchors.length} 条当锚点)` : "");
    }

    let translationPair = null;
    let translatedBook = null;
    let scriptBook = null;
    let scriptTarget = "";
    if (translationRequested) {
      if (!translator) throw new Error("翻译需要桌面 AI 运行时");
      const manualDirection = String(payload?.translation?.direction || "").trim();
      let directionId = manualDirection && manualDirection !== "auto" ? manualDirection : "";
      const classical = payload?.translation?.classical === true;
      const requestedTarget = normalizeTranslationTarget(payload?.translation?.target);
      if (!directionId) {
        const sample = bookChapters
          .map((chapter) => `${chapter.title}\n${chapter.text || ""}`)
          .join("\n")
          .slice(0, 50_000);
        // Vote across chapters so a large English license/front-matter page
        // cannot make a Chinese body look English.
        const detected = detectBookLanguage(bookChapters);
        if (classical) {
          // 文言文 is an explicit user choice. A detected English/German
          // chapter may just be Project Gutenberg license text, so trust the
          // checkbox as long as the manuscript actually contains Han text.
          if (!/\p{Script=Han}/u.test(sample) || detected.language === "ja" || detected.language === "ko") {
            throw new Error("已勾选文言文，但没有识别到中文正文；请检查书稿或取消勾选");
          }
          if (requestedTarget && requestedTarget !== "zh") {
            throw new Error("文白对照的目标固定为现代中文，不能选择其它目标语言");
          }
          directionId = "wenyan-zh";
        } else {
          if (requestedTarget && detected.language === requestedTarget) {
            if (requestedTarget === "zh") {
              throw new Error("原文已经是中文。翻译目标不能与原文相同；如需简繁转换，请使用「简繁转换（本机）」或「转为简体/繁体」快捷按钮");
            }
            throw new Error(`原文已经是 ${requestedTarget === "en" ? "English" : "Deutsch"}，请选择其它目标语言`);
          }
          directionId = directionForSource({ language: detected.language, classical: false, target: requestedTarget });
          if (!directionId) {
            throw new Error(`无法自动识别可翻译的原文语言（识别为 ${detected.language || "未知"}）；目前支持中文、英文、德文`);
          }
        }
        log("book translate source detected", detected.language, detected.confidence);
      } else if (classical && directionId !== "wenyan-zh") {
        throw new Error("勾选了文言文，但翻译方向不是文白对照");
      }
      translationPair = translationLanguagePair(directionId);
      const nameSuffix = translationOutputSuffix({ mode: translationMode, direction: directionId });
      title = customTitle || appendTranslationSuffix(sourceBase, nameSuffix);
      if (!out) out = outputPath(nameSuffix);
      report({ label: `翻译正文 · ${translationPair.sourceLabel} → ${translationPair.targetLabel}` });
      translatedBook = await translator.translateBook({
        chapters: bookChapters,
        translation: {
          ...(payload.translation || {}),
          // Pass the detected/manual direction explicitly; the original
          // payload may say "auto", which the translator would otherwise
          // treat as the zh→en default.
          direction: directionId,
          bookTitle: customTitle || sourceBase,
        },
        workRoot,
        signal,
        report,
      });
      if (signal.aborted) throw new Error("任务已取消");
      styles.translationLayout = translationMode === "side" ? "side" : "stacked";
      if (translationMode === "translated" && navItems) {
        const titleForChapter = (file) => {
          const match = /chapter-(\d+)\.xhtml(?:#.*)?$/i.exec(String(file || ""));
          if (!match) return "";
          return translatedBook.chapters[Number(match[1]) - 1]?.translatedTitle || "";
        };
        navItems = navItems.map((item) => ({ ...item, title: titleForChapter(item.file) || item.title }));
      }
    } else if (scriptRequested) {
      scriptTarget = payload?.translation?.script === "s" ? "s" : "t";
      const sample = bookChapters
        .map((chapter) => `${chapter.title}\n${chapter.text || ""}`)
        .join("\n")
        .slice(0, 50_000);
      const detected = detectSourceLanguage(sample);
      // Short Chinese titles can fall below the detector's minimum sample
      // size, so require Han characters as the baseline and only reject a
      // confidently detected Japanese/Korean source.
      const hasHan = /\p{Script=Han}/u.test(sample);
      if (!hasHan || detected.language === "ja" || detected.language === "ko") {
        throw new Error(`简繁转换只支持中文书稿，当前识别为 ${detected.language || "未知"}`);
      }
      const nameSuffix = scriptOutputSuffix(scriptTarget);
      const titleBase = convertChineseScript(customTitle || sourceBase, scriptTarget);
      title = customTitle ? titleBase : appendTranslationSuffix(titleBase, nameSuffix);
      if (!out) out = outputPath(nameSuffix, convertChineseScript(sourceBase, scriptTarget));
      scriptBook = bookChapters.map((chapter, index) => ({
        title: convertChineseScript(chapter.title, scriptTarget),
        blocks: splitTranslationBlocks(chapter.text, {
          markdown: chapter.markdown,
          chapterIndex: index,
        }).map((block) => {
          // Deterministic conversion can rewrite Markdown table cells too;
          // the table syntax itself is untouched.
          const convertible = block.translatable || /^\s*\|/.test(block.source);
          return {
            ...block,
            translatable: convertible,
            translation: convertible ? convertChineseScript(block.source, scriptTarget) : "",
          };
        }),
      }));
      if (navItems) {
        navItems = navItems.map((item) => {
          const match = /chapter-(\d+)\.xhtml(?:#.*)?$/i.exec(String(item.file || ""));
          const index = match ? Number(match[1]) - 1 : -1;
          return { ...item, title: scriptBook[index]?.title || item.title };
        });
      }
      report({ label: `简繁转换 · ${scriptTargetLabel(scriptTarget)}` });
    } else if (!out) {
      out = outputPath("");
    }
    // 精修输入：整本书 Markdown + 检查报告。构建阶段先生成，既能写工作区，
    // 也能给首次生成的 EPUB 补上正文/注文的双向链接（不必等精修重建）。
    const polish = buildPolishMarkdown({
      title,
      chapters: bookChapters.map((chapter) => ({ title: chapter.title, text: chapter.text })),
      stripBold: settings.ocrScannedPdf === true,
    });
    const tocIssues = auditNavItems(navItems, bookChapters);
    polish.report.summary.tocIssues = tocIssues.length;
    polish.report.tocIssues = tocIssues;
    // 生成阶段也用和编辑阶段相同的实时检查，避免“生成时报一套、打开后又报一套”。
    polish.report = derivePolishReport(polish.markdown, polish.report, {
      nav: navItems,
      chapters: bookChapters.map((chapter, index) => ({
        id: `ch-${String(index + 1).padStart(3, "0")}`,
        title: chapter.title,
      })),
    });
    const markdownHash = crypto.createHash("sha256").update(polish.markdown).digest("hex");
    const polishChapterFiles = bookChapters.map((_chapter, index) => `chapter-${String(index + 1).padStart(3, "0")}.xhtml`);
    const polishChapterIds = bookChapters.map((_chapter, index) => `ch-${String(index + 1).padStart(3, "0")}`);
    // 首次生成也要有正文↔注文的双向链接。链接器需要隐藏注释来定位标记和注文，
    // 所以优先用 polish.md 拆出来的章节（内容和 bookChapters 一致，多了定位注释）；
    // 章节数对不上时退回原文，至少不破坏成品。
    const polishSplit = splitPolishMarkdown(polish.markdown, {
      chapterTitles: bookChapters.map((chapter) => chapter.title),
    });
    const linkChapters = polishSplit.chapters.length === bookChapters.length
      ? polishSplit.chapters
      : bookChapters;
    const linkedTexts = translatedBook || scriptBook
      ? null
      : linkPolishFootnotes(linkChapters, {
        chapterIds: polishChapterIds,
        chapterFiles: polishChapterFiles,
        markdown: polish.markdown,
      });
    const chaptersWithHtml = translatedBook
      ? translatedBook.chapters.map((translated, index) => {
        const sourceChapter = bookChapters[index];
        const output = bilingualChapterHtml(sourceChapter, translated, {
          mode: translationMode,
          sourceLang: translationPair.source,
          targetLang: translationPair.target,
          renderMath,
          lineAlign: payload?.translation?.lineAlign === true,
        });
        return {
          ...output,
          // A translation-only edition uses the translated chapter title for
          // both the visible heading and the navigation. Bilingual editions
          // keep the source title so the two texts stay recognizable.
          title: translationMode === "translated"
            ? (translated.translatedTitle || sourceChapter.title)
            : sourceChapter.title,
        };
      })
      : scriptBook
        ? scriptBook.map((converted, index) => {
          const sourceChapter = bookChapters[index];
          const output = bilingualChapterHtml(sourceChapter, converted, {
            mode: "translated",
            sourceLang: "zh",
            targetLang: scriptTarget === "s" ? "zh-Hans" : "zh-Hant",
            renderMath,
          });
          return { ...output, title: converted.title || sourceChapter.title };
        })
        : bookChapters.map((chapter, index) => {
          const linked = linkedTexts ? linkedTexts[index] : chapter.text;
          const text = linkedTexts ? stripPolishComments(linked) : linked;
          return {
            title: chapter.title,
            text,
            html: chapter.markdown ? markdownToHtml(text, { renderMath }) : textToHtml(text),
          };
        });
    const { chapters, images } = collectBookImages(chaptersWithHtml, { baseDir, log });
    // PDF 大纲的子目录通常只落在章节文件起始处。给标题在正文里补锚点，
    // 再给论文参考文献补可点击的引用链接。
    if (!translatedBook && !scriptBook) {
      if (navItems) {
        navItems = completeNavItems(navItems, chapters, { bookTitle: title });
        navItems = addNavAnchors(navItems, chapters, { bookTitle: title });
      }
      linkReferenceCitations(chapters);
    }
    if (signal.aborted) throw new Error("任务已取消");
    // 自报「有没有公式漏渲染」:成书后还剩多少原始 LaTeX,不用等用户翻书才发现。
    const unrendered = chapters.reduce((sum, chapter) => sum + countRawFormulas(chapter.html), 0);
    if (unrendered) log("book build raw formulas", unrendered, "个公式没能渲染成 MathML(成品里会显示 LaTeX 原文)");
    log("book build", source, "→", out, `${chapters.length} 章`);

    // 不再嵌入字体:阅读器用自己的字体,成品更小,也少一层下载/子集依赖。
    const fonts = [];
    if (signal.aborted) throw new Error("任务已取消");

    report({ label: "准备封面" });
    const author = String(payload?.author || "").trim();
    const outputAuthor = scriptBook ? convertChineseScript(author, scriptTarget) : author;
    const coverPayload = scriptBook
      ? {
        ...payload,
        cover: {
          ...(payload?.cover || {}),
          subtitle: convertChineseScript(payload?.cover?.subtitle || "", scriptTarget),
        },
      }
      : payload;
    const cover = await resolveCover({
      payload: coverPayload,
      title,
      author: outputAuthor,
      markdownText: text || rawChapters.map((chapter) => chapter.text).join("\n"),
      sourceDir: baseDir,
      cacheDir: path.join(cacheRoot, "library"),
      coverRenderer,
      loadImage,
      log,
    });
    if (signal.aborted) throw new Error("任务已取消");

    report({ label: "生成 EPUB" });
    const translatedDetail = translatedBook
      ? ` · ${translationMode === "translated" ? "译文" : "双语"} ${translatedBook.stats.translatedBlocks} 段 · ${translationPair.sourceLabel} → ${translationPair.targetLabel}${translatedBook.stats.cachedChunks ? ` · 缓存 ${translatedBook.stats.cachedChunks} 块` : ""}`
      : "";
    const scriptDetail = scriptBook
      ? ` · 简繁 ${scriptTargetLabel(scriptTarget)} ${scriptBook.reduce((sum, chapter) => sum + chapter.blocks.filter((block) => block.translatable).length, 0)} 段`
      : "";
    const result = await buildEpub({
      book: {
        title,
        author: outputAuthor,
        language: scriptBook
          ? (scriptTarget === "s" ? "zh-Hans" : "zh-Hant")
          : translationPair
            ? (translationMode === "translated" ? translationPair.target : translationPair.source)
            : String(payload?.language || "zh"),
        identifier: String(payload?.identifier || `urn:qbr:${Date.now().toString(36)}`),
        modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      },
      styles,
      chapters,
      fonts,
      images,
      cover,
      // 印刷目录匹配出来的导航(为空时 buildEpub 按章节标题生成,与旧行为一致)。
      nav: navItems,
      navTitle: scriptBook
        ? convertChineseScript(String(payload?.tocTitle || ""), scriptTarget)
        : String(payload?.tocTitle || "").trim(),
      navDepth: Math.min(3, Math.max(1, Number(payload?.tocDepth) || 3)),
      colophon: scriptBook
        ? convertChineseScript(String(payload?.colophon || "由 UV Reader 书坊生成"), scriptTarget)
        : String(payload?.colophon || "由 UV Reader 书坊生成"),
    }, out);
    if (signal.aborted) throw new Error("任务已取消");
    const formulaCount = mathMap ? [...mathMap.values()].filter(Boolean).length : 0;

    // 精修输入：整本书 Markdown + 检查报告 + 持久工作区。构建阶段只生成，不进入精修。
    const polishDir = path.join(workRoot, "polish");
    fs.mkdirSync(polishDir, { recursive: true });
    const buildId = crypto.randomUUID();
    const polishMarkdownPath = path.join(polishDir, "polish.md");
    const polishBaselinePath = path.join(polishDir, "polish.baseline.md");
    const polishReportPath = path.join(polishDir, "polish-report.json");
    const polishManifestPath = path.join(polishDir, "polish.json");
    const polishSessionPath = path.join(polishDir, "polish-session.json");
    // 重新生成会覆盖 polish.md；如果旧文件有手工修改，先自动备份一份，
    // 即使界面上的提醒被跳过也不会丢内容。
    let polishBackupPath = "";
    if (fs.existsSync(polishMarkdownPath)) {
      const previous = fs.readFileSync(polishMarkdownPath);
      const baseline = fs.existsSync(polishBaselinePath) ? fs.readFileSync(polishBaselinePath) : null;
      if (!baseline || !previous.equals(baseline)) {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
        const backupDir = path.join(polishDir, `backup-${stamp}`);
        fs.mkdirSync(backupDir, { recursive: true });
        for (const name of ["polish.md", "polish-report.json", "polish-session.json", "polish.json"]) {
          const from = path.join(polishDir, name);
          if (fs.existsSync(from)) fs.copyFileSync(from, path.join(backupDir, name));
        }
        polishBackupPath = path.join(backupDir, "polish.md");
      }
    }
    fs.writeFileSync(polishMarkdownPath, polish.markdown, "utf8");
    fs.writeFileSync(polishBaselinePath, polish.markdown, "utf8");
    fs.writeFileSync(polishReportPath, JSON.stringify({ ...polish.report, buildId, markdownHash }, null, 2), "utf8");
    fs.writeFileSync(polishManifestPath, JSON.stringify({
      schemaVersion: 1,
      buildId,
      createdAt: new Date().toISOString(),
      book: { title, author: String(payload?.author || ""), language: String(payload?.language || "zh") },
      // 重建时不再重新提取：用 polish.md 的正文 + 这里的版式/封面设置。
      build: {
        source,
        baseDir,
        out,
        title,
        author: String(payload?.author || ""),
        language: String(payload?.language || "zh"),
        identifier: String(payload?.identifier || ""),
        styles,
        cover: payload?.cover || {},
        tocTitle: String(payload?.tocTitle || ""),
        tocDepth: Number(payload?.tocDepth) || 3,
        colophon: String(payload?.colophon || ""),
        dropPrintedToc: payload?.dropPrintedToc !== false,
        translationMode,
      },
      chapters: bookChapters.map((chapter, index) => ({
        id: `ch-${String(index + 1).padStart(3, "0")}`,
        title: chapter.title,
        format: chapter.markdown ? "markdown" : "text",
      })),
      nav: navItems || [],
      notes: polish.notes,
      markers: polish.markers,
      stats: polish.report.summary,
      tocIssues,
      markdownHash,
    }, null, 2), "utf8");
    fs.writeFileSync(polishSessionPath, JSON.stringify({
      schemaVersion: 1,
      buildId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ui: { filter: "review", selectedPointId: "", scrollTop: 0 },
      stage: "notes",
      pointStatus: {},
      progress: { reviewed: 0, remaining: polish.report.summary.needsReview, ignored: 0 },
      files: { markdown: "polish.md", baseline: "polish.baseline.md", markdownHash, baselineHash: markdownHash },
    }, null, 2), "utf8");

    return {
      output: out,
      detail: `EPUB · ${result.chapters} 章 · ${Math.round(result.bytes / 1024)} KB${fonts.length ? ` · ${fonts.length} 款字体` : ""}${images.length ? ` · ${images.length} 图` : ""}${formulaCount ? ` · ${formulaCount} 公式` : ""}${translatedDetail}${scriptDetail}${tocStrip.dropped ? ` · 去印刷目录 ${tocStrip.dropped} 章` : ""}${navItems ? ` · 目录${navSource === "outline" ? "来自 PDF 大纲" : navSource === "upstream" ? "来自上游" : navSource === "printed" ? "来自印刷目录" : "来自正文标题"} ${navItems.length} 条${navDropped ? `(丢弃 ${navDropped})` : ""}` : ""}${normalized.dropped ? ` · 去重复页眉 ${normalized.dropped} 章` : ""}${unrendered ? ` · 未渲染 ${unrendered}` : ""}${polishBackupPath ? " · 已备份旧精修" : ""}`,
      result: {
        polish: {
          path: polishManifestPath,
          reportPath: polishReportPath,
          sessionPath: polishSessionPath,
          markdownPath: polishMarkdownPath,
          baselinePath: polishBaselinePath,
          needsReview: polish.report.summary.needsReview,
          autoAccepted: polish.report.summary.autoAccepted,
          tocIssues: tocIssues.length,
          backupPath: polishBackupPath,
        },
      },
    };
  });

  // 精修：audit 只检查结构；rebuild 以编辑后的 polish.md 为准重新生成 EPUB。
  // 工作区本身不是任务（见 polish-session.js）；这里只处理“检查/重建”这两个离散动作。
  workshop.register("book-polish", async ({ payload, report, signal }) => {
    const manifestPath = absolute(payload?.manifestPath || payload?.path || "");
    let bundle = readPolishBundle(manifestPath);
    const phase = String(payload?.phase || "audit");
    const points = Array.isArray(bundle.report?.points) ? bundle.report.points : [];
    const session = bundle.session;
    const validation = validatePolishStructure(manifestPath, bundle.markdown);
    const summary = bundle.report?.summary || {};
    const polish = {
      path: bundle.manifestPath,
      reportPath: bundle.reportPath,
      sessionPath: bundle.sessionPath,
      markdownPath: bundle.markdownPath,
      baselinePath: bundle.baselinePath,
      needsReview: points.length,
      autoAccepted: Number(summary.autoAccepted) || 0,
      reviewed: Number(session.progress?.reviewed) || 0,
      ignored: Number(session.progress?.ignored) || 0,
    };

    if (phase !== "rebuild") {
      const issue = validation.errors.length ? ` · ${validation.errors.length} 个结构问题` : "";
      return {
        detail: `结构检查 · 待确认 ${polish.needsReview} · 已确认 ${polish.reviewed}${issue}`,
        result: { polish, validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings } },
      };
    }

    const build = bundle.manifest?.build || {};
    if (String(build.translationMode || "none") !== "none") {
      throw new Error("翻译/简繁转换的电子书暂不支持精修复建；请先修正原书，再重新运行对应转换");
    }
    if (!validation.ok) {
      throw new Error(`精修结构校验未通过：${validation.errors.join("；")}`);
    }
    if (validation.missingNotes?.length) {
      // 手工合并/删除注文后，清单里可能还留着旧 ID。清理后再重建，
      // 下次打开始终看到的是当前 polish.md 的真实结构。
      for (const noteId of validation.missingNotes) forgetPolishNote(manifestPath, noteId);
      bundle = readPolishBundle(manifestPath);
    }
    const chapters = validation.split.chapters;
    if (!chapters.length) throw new Error("精修 Markdown 里没有可重建的章节");
    const oldChapterMeta = Array.isArray(bundle.manifest?.chapters) ? bundle.manifest.chapters : [];
    const chapterMeta = alignChapterMeta(oldChapterMeta, chapters);
    const chapterFiles = chapters.map((_chapter, index) => `chapter-${String(index + 1).padStart(3, "0")}.xhtml`);
    const chapterIds = chapters.map((_chapter, index) => String(
      chapterMeta[index]?.id || `ch-${String(index + 1).padStart(3, "0")}`,
    ));
    const linkedTexts = linkPolishFootnotes(chapters, {
      chapterIds,
      chapterFiles,
      markdown: bundle.markdown,
    });
    const baseDir = String(build.baseDir || (build.source ? path.dirname(build.source) : ""));
    const title = String(build.title || bundle.manifest?.book?.title || "");
    const author = String(build.author || bundle.manifest?.book?.author || "");

    report({ label: "整理精修正文" });
    const isTextChapter = (index) => chapterMeta[index]?.format === "text";
    const cleanText = (text) => stripPolishComments(String(text || "")).replace(/<!--[\s\S]*?-->/g, "");
    const markdownTexts = linkedTexts.filter((_text, index) => !isTextChapter(index));
    const latexes = [...new Set(markdownTexts.flatMap((text) => collectMathFromMarkdown(text)))];
    let mathMap = null;
    if (latexes.length && mathRenderer) {
      report({ label: `渲染公式（${latexes.length}）` });
      const rendered = await mathRenderer.renderMap(latexes, {
        python: String(payload?.settings?.ocrPython || "").trim() || "python",
        workDir: path.join(path.dirname(manifestPath), "math-rebuild"),
      });
      if (rendered.ok) mathMap = normalizeMathMap(rendered.map);
      else log("polish rebuild math skipped", rendered.error);
      if (signal.aborted) throw new Error("任务已取消");
    }
    const renderMath = mathMap ? (latex, display) => shareFormulaHtml(mathMap.get(mathKey(latex)), display) : null;
    const chaptersWithHtml = chapters.map((chapter, index) => {
      const text = cleanText(linkedTexts[index]);
      return {
        title: chapter.title,
        text,
        html: isTextChapter(index) ? textToHtml(text) : markdownToHtml(text, { renderMath }),
      };
    });
    const { chapters: htmlChapters, images } = collectBookImages(chaptersWithHtml, { baseDir, log });
    if (signal.aborted) throw new Error("任务已取消");

    report({ label: "准备封面" });
    const coverChoice = normalizePolishCover(build.cover || {});
    const cover = await resolveCover({
      payload: { cover: coverChoice, author },
      title,
      author,
      markdownText: chapters.map((chapter) => chapter.text).join("\n"),
      sourceDir: baseDir,
      cacheDir: path.join(cacheRoot, "library"),
      coverRenderer,
      loadImage,
      log,
    });
    if (signal.aborted) throw new Error("任务已取消");

    const originalOut = String(build.out || "");
    if (!originalOut) throw new Error("精修清单里没有记录输出路径，无法重建");
    const tag = safePolishTag(payload?.tag);
    const ext = path.extname(originalOut) || ".epub";
    const outputBase = path.basename(originalOut, ext);
    const spaceRoot = spaceRootForSource(build.source || originalOut);
    const outputDir = spaceRoot ? path.join(spaceRoot, "polish") : path.dirname(originalOut);
    const polishDir = path.dirname(manifestPath);
    let tagSuffix = `-${tag}`;
    let out = "";
    let polishSnapshotPath = "";
    for (let index = 0; ; index += 1) {
      if (index) tagSuffix = `-${tag} (${index})`;
      out = path.join(outputDir, `${outputBase}${tagSuffix}${ext}`);
      polishSnapshotPath = path.join(polishDir, `polish${tagSuffix}.md`);
      if (!fs.existsSync(out) && !fs.existsSync(polishSnapshotPath)) break;
    }
    const remappedNav = remapChapterNav(bundle.manifest?.nav, oldChapterMeta, chapters, chapterFiles);
    const nav = remappedNav.length
      ? remappedNav
      : buildChapterNav(chapters, chapterFiles, bundle.manifest?.nav);
    const completedNav = completeNavItems(nav, htmlChapters, { bookTitle: title });
    const anchoredNav = addNavAnchors(completedNav, htmlChapters, { bookTitle: title });
    linkReferenceCitations(htmlChapters);
    report({ label: "生成 EPUB" });
    const result = await buildEpub({
      book: {
        title,
        author,
        language: String(build.language || bundle.manifest?.book?.language || "zh"),
        identifier: String(build.identifier || `urn:qbr:${bundle.manifest?.buildId || Date.now().toString(36)}`),
        modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      },
      styles: { ...BOOK_STYLE_DEFAULTS, ...(build.styles || {}) },
      chapters: htmlChapters,
      fonts: [],
      images,
      cover,
      nav: anchoredNav,
      navTitle: String(build.tocTitle || ""),
      navDepth: Math.min(3, Math.max(1, Number(build.tocDepth) || 3)),
      colophon: String(build.colophon || "由 UV Reader 书坊生成"),
    }, out);
    if (signal.aborted) throw new Error("任务已取消");
    report({ label: "保存精修副本" });
    fs.writeFileSync(polishSnapshotPath, bundle.markdown, "utf8");

    const noteTexts = collectNoteTexts(bundle.markdown);
    const updatedNotes = (Array.isArray(bundle.manifest?.notes) ? bundle.manifest.notes : [])
      .filter((note) => noteTexts.has(note.id))
      .map((note) => {
        const text = noteTexts.get(note.id);
        return { ...note, label: noteLabelOf(text) || note.label, text };
      });
    const previousStatus = session.pointStatus || {};
    const updatedAt = new Date().toISOString();
    savePolishSession(manifestPath, {
      pointStatus: previousStatus,
      extra: {
        lastRebuildAt: updatedAt,
        lastOutput: out,
        lastPolishSnapshot: polishSnapshotPath,
        lastTag: tag,
        lastRebuildBytes: result.bytes,
      },
    });
    savePolishManifest(manifestPath, {
      markdownHash: crypto.createHash("sha256").update(bundle.markdown).digest("hex"),
      // Persist the repaired cover choice so later rebuilds and the book-info
      // dialog see the same state as the EPUB that was just produced.
      build: { ...(bundle.manifest?.build || {}), cover: coverChoice },
      chapters: chapterMeta.map((meta, index) => ({ ...meta, title: chapters[index]?.title || meta.title })),
      nav: anchoredNav,
      notes: updatedNotes,
      markers: (Array.isArray(bundle.manifest?.markers) ? bundle.manifest.markers : [])
        .filter((marker) => !marker.noteId || noteTexts.has(marker.noteId)),
      stats: { ...(bundle.manifest?.stats || {}), ...summary },
      lastRebuildAt: updatedAt,
      lastOutput: out,
      lastPolishSnapshot: polishSnapshotPath,
      lastTag: tag,
    });
    const reviewDetail = polish.needsReview
      ? `已确认 ${polish.reviewed}/${polish.needsReview}`
      : "无待确认修正点";
    return {
      output: out,
      detail: `精修重建 · ${tag} · ${result.chapters} 章 · ${Math.round(result.bytes / 1024)} KB · ${reviewDetail} · 已存 polish 副本`,
      result: {
        polish: {
          ...polish,
          rebuilt: true,
          output: out,
          tag,
          snapshotPath: polishSnapshotPath,
        },
      },
    };
  });

  // A small, ephemeral translation sample. It uses the same cache directory as
  // the full book so confirming the preview does not pay for those chunks again.
  workshop.register("book-preview", async ({ payload, report, signal }) => {
    const source = absolute(payload?.source);
    if (!source || !fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
    if (!/\.epub$/i.test(source)) throw new Error("试译预览目前只支持 EPUB 书稿");
    if (!translator) throw new Error("试译预览需要桌面 AI 运行时");
    const translation = payload?.translation || {};
    const mode = String(translation.mode || "stacked");
    if (!["stacked", "side", "translated"].includes(mode)) {
      throw new Error("试译预览只支持逐段翻译或双语对照");
    }
    const stat = fs.statSync(source);
    const key = crypto.createHash("sha1").update(`${source}\n${stat.size}\n${stat.mtimeMs}`).digest("hex").slice(0, 8);
    const workRoot = path.join(cacheRoot, "work", `${path.basename(source).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${key}`);
    report({ label: "准备试译" });
    const result = await translateEpub({
      source,
      out: "",
      outputPath: () => "",
      translator,
      mode,
      direction: translation.direction || "auto",
      target: translation.target || "",
      classical: translation.classical === true,
      glossary: translation.glossary || "",
      lineAlign: translation.lineAlign === true,
      customTitle: String(payload?.title || "").trim(),
      config: translation.config || null,
      workRoot,
      preview: true,
      previewFiles: 2,
      signal,
      report,
      log,
    });
    return {
      result: {
        previewHtml: result.previewHtml,
        title: result.title,
        pair: result.pair,
        previewFiles: result.previewFiles,
        stats: result.stats,
      },
      detail: `试译 · ${result.pair.sourceLabel} → ${result.pair.targetLabel} · ${result.stats.translatedBlocks} 段`,
    };
  });
}

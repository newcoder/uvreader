// 精修 Markdown 的生成与解析（纯函数，不依赖 Node/Electron）。
import { isPrintedTocChapter, tocKey } from "./printed-toc.js";
//
// 目标：把最终章节拼成整本书的 polish.md，并在注文/正文标记旁插入隐藏注释，
// 让 CodeMirror 工作区可以按 point/note/marker 精确定位。注释在 Markdown 预览里
// 不可见，不会影响阅读。

const CIRCLED = "[①-⑳㉑-㉟㊱-㊿]";
const BRACKETED_LABEL = "[〔【〖]\\s*(?:\\d{1,3}|[０-９]{1,3})\\s*[〕】〗]";
const SQUARE_LABEL = "\\[\\s*(?:\\d{1,3}|[０-９]{1,3})\\s*\\]";
const PAREN_LABEL = "[（(]\\s*(?:\\d{1,3}|[０-９]{1,3})\\s*[)）]";
const PLAIN_LABEL = "(?:\\d{1,3}|[０-９]{1,3})(?=[.．、)）：:\\]])";
const NOTE_LABEL_RE = new RegExp(`^(?:\\*{1,3}|＊{1,3}|[†‡]|${CIRCLED}|\\$\\^\\{[^}]*\\}\\$|${BRACKETED_LABEL}|${SQUARE_LABEL}|${PAREN_LABEL}|注\\s*(?:\\d{1,3}|[０-９]{1,3})|${PLAIN_LABEL})`);
const NOTE_HEADING_RE = /^(?:[【\[（(]\s*)?(?:注\s*释|注文|注解|脚注|尾注|章注|注|notes?|footnotes?|endnotes?)(?:\s*[】\]）)])?(?:\s*[（(][^）)]{0,20}[)）])?\s*[:：]?\s*$/i;
const NOTE_HINT = /页|同上|参见|《|卷/;
// 注释块里没有编号的段落，如果以这些词开头，通常是上一条注文的续写，
// 而不是新注文（OCR 把长注文拆成了多段）。
const CONTINUATION_START = /^(?:但是|但|而|而且|并且|因此|所以|这些|那些|这|那|它|他们|她们|其中|不过|然而|又|也|还|即)/;
const PAGE_RE = /<!--\s*page:(\d+)(?:\s+printed:(\d+))?\s*-->/g;
const CIRCLED_RE = /[①-⑳㉑-㉟㊱-㊿]/g;
const MARKER_RE = /\$\^\{([^}]*)\}\$|<sup\b[^>]*>([\s\S]*?)<\/sup>|\[(\d{1,3})\s*\]|[①-⑳㉑-㉟㊱-㊿]/gi;

// OCR sometimes writes a closing superscript tag with a space (`</su p>`) or
// attaches it to strong text. Normalise that before marker detection and HTML
// generation; otherwise the rest of the paragraph becomes literal escaped HTML.
function normalizeSupMarkup(value) {
  return String(value || "")
    .replace(/<\s*sup\b([^>]*)>([\s\S]*?)<\s*\/\s*su\s*p\s*>/gi, "<sup$1>$2</sup>")
    .replace(/<\s*\/\s*su\s*p\s*>/gi, "</sup>");
}

// OCR often splits two Chinese characters with a space and MinerU may also
// mark whole paragraphs as bold even when the scan has no bold face. Remove
// only spacing that is surrounded by CJK on both sides, so English words,
// numbers and intentional Latin/CJK spacing survive. Long bold spans (or
// sentence-length bold) are treated as OCR emphasis; short emphasis is kept
// unless the caller asks for `bold: "all"` (scanned books).
const CJK_CHARS = "\\p{Script=Han}，。！？；：、“”‘’（）《》〈〉【】〔〕…—·,.;:!?\\uFFFD";
const CJK_SPACE_RE = new RegExp(`(?<=[${CJK_CHARS}])[ \\t\\u00A0\\u3000]+(?=[${CJK_CHARS}])`, "gu");
const CJK_BOLD_LEFT_RE = new RegExp(`(?<=[${CJK_CHARS}])[ \\t]+(?=\\*\\*)`, "gu");
const CJK_BOLD_RIGHT_RE = new RegExp(`(?<=\\*\\*)[ \\t]+(?=[${CJK_CHARS}])`, "gu");

function mapOutsideInlineCode(line, mapper) {
  return String(line || "").split(/(`[^`]*`)/g).map((part) => (
    part.startsWith("`") && part.endsWith("`") ? part : mapper(part)
  )).join("");
}

function stripOcrBold(part, mode) {
  return part.replace(/\*\*([^*\n]+?)\*\*/g, (whole, inner) => {
    const plain = inner.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").trim();
    const compact = plain.replace(/\s+/g, "");
    if (!compact) return whole;
    if (mode === "all") return inner;
    if (compact.length > 32 || /[。！？；]/u.test(compact)) return inner;
    return whole;
  });
}

function joinOcrSoftLines(previous, next) {
  if (!previous || !next) return false;
  if (/^\s*(?:#{1,6}\s|```|~~~|<!--)/.test(previous)) return false;
  if (/^\s*(?:#{1,6}\s|```|~~~|<!--)/.test(next)) return false;
  if (/[。！？；.!?;]\s*[”’"']?\s*$/u.test(previous)) return false;
  const visible = previous.replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, "");
  if (visible.length < 24) return false;
  const endsOpen = /[\p{Script=Han}\uFFFD，、,;:：]\s*$/u.test(previous);
  const startsHan = /^\s*[\p{Script=Han}\uFFFD]/u.test(next);
  return endsOpen && startsHan;
}

export function tidyOcrText(markdown, { bold = "long" } = {}) {
  const rawLines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  let inFence = false;
  for (const line of rawLines) {
    if (/^\s*(```|~~~)/.test(line)) {
      lines.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines.length && joinOcrSoftLines(lines[lines.length - 1], line)) {
      lines[lines.length - 1] += line.trimStart();
      continue;
    }
    lines.push(line);
  }
  inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || /^\s*#{1,6}\s/.test(line)) return line;
    return mapOutsideInlineCode(line, (part) => {
      let cleaned = stripOcrBold(part, bold)
        .replace(CJK_BOLD_LEFT_RE, "")
        .replace(CJK_BOLD_RIGHT_RE, "")
        .replace(CJK_SPACE_RE, "");
      if (bold === "all") cleaned = cleaned.replace(/\*\*/g, "");
      return cleaned;
    });
  }).join("\n");
}

// The editor keeps <sup>N</sup> as the canonical marker so rebuilding stays
// stable. The rendered preview can turn a linked marker into a button that
// jumps to its note; unlinked markers stay as the blue [N] hint.
export function decoratePreviewNoterefs(html, noteIds = []) {
  let index = 0;
  return String(html || "").replace(/<sup>(\s*\d{1,3}\s*)<\/sup>/gi, (full, label) => {
    const text = `[${String(label).trim()}]`;
    const noteId = String(noteIds[index++] || "").trim();
    if (!noteId) return `<sup class="qbr-preview-noteref">${text}</sup>`;
    return `<button type="button" class="qbr-preview-noteref qbr-preview-noteref-button" data-note-id="${noteId.replace(/"/g, "&quot;")}" aria-label="查看注释 ${String(label).trim()}">${text}</button>`;
  });
}
const POLISH_COMMENT_RE = /<!--\s*polish:(?:point|note|marker)\b[\s\S]*?-->/g;
const PAGE_COMMENT_RE = /<!--\s*page:\d+(?:\s+printed:\d+)?\s*-->/g;

function parseCircled(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2460 && cp <= 0x2473) return cp - 0x2460 + 1;
  if (cp >= 0x3251 && cp <= 0x325f) return cp - 0x3251 + 21;
  if (cp >= 0x32b1 && cp <= 0x32bf) return cp - 0x32b1 + 36;
  return null;
}

export function noteLabelNumber(raw) {
  const text = String(raw || "").trim().replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
  if (!text || /^[*＊†‡]+$/.test(text)) return null;
  const digits = text.match(/\d+/);
  if (digits) return Number(digits[0]);
  const first = [...text][0];
  return first ? parseCircled(first) : null;
}

export function noteLabelOf(paragraph) {
  const match = String(paragraph || "").trim().match(NOTE_LABEL_RE);
  return match ? match[0] : "";
}

export function isNoteHeading(text) {
  const value = String(text || "").trim().replace(/^#{1,6}\s+/, "");
  return NOTE_HEADING_RE.test(value);
}

function fillEmptyMarkerLine(line) {
  const tokens = [...String(line || "").matchAll(/\[\s{0,2}(\d{1,3})?\s{0,2}\]/g)].map((match) => ({
    index: match.index,
    length: match[0].length,
    label: match[1] == null ? null : Number(match[1]),
  })).filter((token) => {
    const before = String(line || "")[token.index - 1];
    const after = String(line || "")[token.index + token.length];
    return before !== "!" && after !== "(";
  });
  if (!tokens.some((token) => token.label == null)) return String(line || "");
  const assignments = new Map();
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index].label != null) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < tokens.length && tokens[index].label == null) index += 1;
    const count = index - start;
    const previous = start > 0 ? tokens[start - 1].label : null;
    const next = index < tokens.length ? tokens[index].label : null;
    let labels = [];
    if (next != null && next - count >= 1 && (previous == null || next - count > previous)) {
      labels = Array.from({ length: count }, (_value, offset) => next - count + offset);
    } else if (previous != null && previous + count < (next ?? Number.POSITIVE_INFINITY)) {
      labels = Array.from({ length: count }, (_value, offset) => previous + 1 + offset);
    }
    for (let offset = 0; offset < count; offset += 1) {
      assignments.set(tokens[start + offset].index, labels[offset] ?? null);
    }
  }
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    if (!assignments.has(token.index)) continue;
    result += String(line || "").slice(cursor, token.index);
    const label = assignments.get(token.index);
    result += label == null ? "" : `[${label}]`;
    cursor = token.index + token.length;
  }
  result += String(line || "").slice(cursor);
  return result;
}

// OCR often loses the number inside a footnote marker, leaving `[]` in the
// body. Fill an unambiguous run from its neighbouring [N] (e.g. four `[]`
// before [5] become [1]..[4]); otherwise remove the empty bracket so the
// generated book never shows a bare `[]`. Note text after the notes heading is
// left untouched.
export function fillEmptyMarkerNumbers(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let inNotes = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (!inNotes && isNoteHeading(line)) {
      inNotes = true;
      return line;
    }
    if (inNotes) return line;
    return fillEmptyMarkerLine(line);
  }).join("\n");
}

// 书末注释常按章分组（“前言”“第一章: 观察者”…）。这些行在注释块里
// 不是注文，跳过后所有注文仍按原顺序排列。
export function isNoteGroupHeading(text) {
  const value = strippedText(text).replace(/^#{1,6}\s*/, "").trim();
  if (!value || value.length > 40 || noteLabelOf(value)) return false;
  if (/^[.·•\-—\s]+$/.test(value)) return true;
  if (/^(?:第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]|chapter\s+\d+|part\s+\d+)/i.test(value)) return true;
  if (/^注释(?:中的人名缩写)?$/.test(value)) return true;
  return /^(?:前言|序言|自序|后记|尾声|结局|附录|参考书目|参考文献|notes?|endnotes?|footnotes?)(?:\s|$|[:：])/i.test(value);
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function pageFromText(text) {
  let page = 0;
  PAGE_RE.lastIndex = 0;
  let match;
  while ((match = PAGE_RE.exec(String(text || "")))) {
    page = Number(match[2]) || Number(match[1]) || page;
  }
  return page;
}

function pagePrefixOf(text) {
  return (String(text || "").match(/^((?:\s*<!--\s*page:[^>]*-->\s*)+)/) || [])[1] || "";
}

function isFenceLine(line) {
  return /^\s*(```|~~~)/.test(line);
}

function splitParagraphs(text) {
  return String(text || "").split(/\n{2,}/);
}

function strippedText(text) {
  return String(text || "")
    .replace(POLISH_COMMENT_RE, "")
    .replace(PAGE_COMMENT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(text, limit = 80) {
  const value = strippedText(text);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function noteParagraphs(chapter) {
  const paragraphs = splitParagraphs(normalizeSupMarkup(chapter?.text || ""));
  const notes = [];
  const groups = [];
  const body = [];
  const headingIndex = paragraphs.findIndex((paragraph) => isNoteHeading(strippedText(paragraph)));
  // 书末注释被单独切成一章时，章节标题本身就是“注释/尾注/Notes”，
  // 正文里可能已经没有同名标题行了。
  const forcedNoteBlock = headingIndex < 0 && isNoteHeading(chapter?.title);
  let inFence = false;
  let inNoteBlock = false;
  let page = 0;

  if (headingIndex >= 0 || forcedNoteBlock) {
    // 显式“注释:”块：块内每个段落先按“一条注文”处理；没有编号、但明显是
    // 上一条断句/换页续写的段落并回上一条。这样编号丢失的注文也不会消失。
    // “人名缩写/缩略语”小节不是正文注文，跳过，不参与注号配对。
    let skipGroup = false;
    let currentGroup = null;
    let ended = false;
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const lines = String(paragraph || "").split("\n");
      const fence = lines.some(isFenceLine);
      if (inFence || fence) {
        if (fence) inFence = !inFence;
        if (index < headingIndex) body.push({ index, paragraph });
        continue;
      }
      const foundPage = pageFromText(paragraph);
      if (foundPage) page = foundPage;
      if (index < headingIndex || ended) {
        body.push({ index, paragraph });
        continue;
      }
      if (index === headingIndex) continue;
      const pagePrefix = pagePrefixOf(paragraph);
      const text = pagePrefix ? paragraph.slice(pagePrefix.length) : paragraph;
      const stripped = strippedText(text);
      if (!stripped) continue;
      // A real body heading after a notes block ends the block. Without this,
      // a front-matter “【注释】” block can swallow the following 序 as notes.
      const headingLine = /^\s*#{1,6}\s+/.test(text);
      if (headingLine && !isNoteHeading(text) && !isNoteGroupHeading(text)) {
        ended = true;
        body.push({ index, paragraph });
        continue;
      }
      if (isNoteGroupHeading(text)) {
        const groupTitle = strippedText(text).replace(/^#{1,6}\s*/, "").trim();
        skipGroup = /人名缩写|缩写|简称|缩略语|abbreviations?/i.test(groupTitle);
        currentGroup = skipGroup ? null : { title: groupTitle, notes: [] };
        if (currentGroup) groups.push(currentGroup);
        continue;
      }
      if (skipGroup) continue;
      const label = noteLabelOf(text);
      const previous = notes[notes.length - 1];
      const previousEnds = previous
        ? /[。！？.!?…]["'”’）)]*$/.test(previous.text.trim())
        : true;
      const continuation = Boolean(previous) && !label && (
        Boolean(pagePrefix)
        || !previousEnds
        || CONTINUATION_START.test(text.trim())
      );
      if (continuation) {
        previous.text = `${previous.text}\n${text.trim()}`.trim();
        previous.indices.push(index);
        if (!previous.page) previous.page = page || pageFromText(paragraph);
        continue;
      }
      if (!label && !NOTE_HINT.test(text)) {
        // An unlabelled paragraph that neither continues the previous note nor
        // looks like a citation/annotation is body text (author signature, date,
        // or the next section).
        ended = true;
        body.push({ index, paragraph });
        continue;
      }
      const note = {
        index,
        indices: [index],
        page: page || pageFromText(paragraph),
        label,
        number: noteLabelNumber(label),
        text: text.trim(),
        group: currentGroup?.title || "",
      };
      notes.push(note);
      if (currentGroup) currentGroup.notes.push(note);
    }
    body.sort((a, b) => a.index - b.index);
    return {
      notes,
      groups: groups.filter((group) => group.notes.length),
      bodyText: body.map((entry) => entry.paragraph).join("\n\n"),
      noteBlock: true,
    };
  }

  // 没有“注释:”标题：沿用“带编号且像注文”的保守判断；只有一两条时
  // 多半是正文编号列表，放回正文。
  const paragraphText = (index) => {
    const paragraph = paragraphs[index];
    const pagePrefix = pagePrefixOf(paragraph);
    return pagePrefix ? paragraph.slice(pagePrefix.length) : paragraph;
  };
  const nextNumberedNote = (index) => {
    for (let next = index + 1; next < paragraphs.length; next += 1) {
      if (!strippedText(paragraphs[next])) continue;
      return Boolean(noteLabelOf(paragraphText(next)));
    }
    return false;
  };
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const lines = String(paragraph || "").split("\n");
    const fence = lines.some(isFenceLine);
    if (inFence || fence) {
      if (fence) inFence = !inFence;
      body.push({ index, paragraph });
      inNoteBlock = false;
      continue;
    }
    const foundPage = pageFromText(paragraph);
    if (foundPage) page = foundPage;
    const pagePrefix = pagePrefixOf(paragraph);
    const text = pagePrefix ? paragraph.slice(pagePrefix.length) : paragraph;
    if (inNoteBlock && isNoteGroupHeading(text)) continue;
    const label = noteLabelOf(text);
    const isNote = Boolean(label) && (NOTE_HINT.test(text) || inNoteBlock);
    if (isNote) {
      notes.push({
        index,
        indices: [index],
        page: page || pageFromText(paragraph),
        label,
        number: noteLabelNumber(label),
        text: text.trim(),
      });
      inNoteBlock = true;
      continue;
    }
    const previous = notes[notes.length - 1];
    // 没有“注释”标题的注释块里，OCR 偶尔会丢掉某条注文的编号，正文段落
    // 因此夹在两条带号注文之间。若它后面紧跟下一条带号注文，就把它当作
    // 一条编号丢失的注文保留下来；真正的续写仍回并到上一条。
    if (inNoteBlock && previous && strippedText(text) && nextNumberedNote(index)) {
      const previousEnds = /[。！？!?…]["'”’）)]*$/.test(previous.text.trim());
      const continuation = Boolean(pagePrefix)
        || !previousEnds
        || CONTINUATION_START.test(text.trim());
      if (continuation) {
        previous.text = `${previous.text}\n${text.trim()}`.trim();
        previous.indices.push(index);
        if (!previous.page) previous.page = page || pageFromText(paragraph);
        continue;
      }
      notes.push({
        index,
        indices: [index],
        page: page || pageFromText(paragraph),
        label: "",
        number: null,
        text: text.trim(),
      });
      continue;
    }
    body.push({ index, paragraph });
    if (strippedText(text)) inNoteBlock = false;
  }
  let finalNotes = notes;
  // A notes block without a “注释” heading is only trusted when a run of
  // numbered paragraphs ends at a page boundary. Image captions and chronology
  // items are also numbered paragraphs, but prose/images follow them, so they
  // stay in the body instead of becoming fake notes.
  const nextContentAfter = (note) => {
    const last = note.indices?.[note.indices.length - 1] ?? note.index;
    for (let index = last + 1; index < paragraphs.length; index += 1) {
      const raw = String(paragraphs[index] || "");
      const text = strippedText(raw);
      if (!text) continue;
      return { raw, text };
    }
    return null;
  };
  const atPageBoundary = (note) => {
    const after = nextContentAfter(note);
    if (!after) return true;
    return /^<!--\s*page:/.test(after.raw.trim()) || /^<!--\s*page:/.test(after.text);
  };
  const accepted = [];
  const rejected = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (atPageBoundary(run[run.length - 1])) accepted.push(...run);
    else rejected.push(...run);
    run = [];
  };
  for (const note of notes) {
    if (run.length) {
      const previous = run[run.length - 1];
      const lastIndex = previous.indices?.[previous.indices.length - 1] ?? previous.index;
      if (note.index > lastIndex + 1) flushRun();
    }
    run.push(note);
  }
  flushRun();
  for (const note of rejected) {
    for (const index of note.indices || [note.index]) {
      body.push({ index, paragraph: paragraphs[index] });
    }
  }
  finalNotes = accepted;
  body.sort((a, b) => a.index - b.index);
  return {
    notes: finalNotes,
    groups: [],
    bodyText: body.map((entry) => entry.paragraph).join("\n\n"),
    noteBlock: finalNotes.length > 0,
  };
}

function searchableTerms(text) {
  const terms = new Set();
  for (const match of String(text || "").matchAll(/《[^》]{1,30}》/g)) terms.add(match[0]);
  for (const match of String(text || "").matchAll(/(?:1[6-9]|20)\d{2}\s*年?/g)) terms.add(match[0].trim());
  return [...terms].filter((term) => term.length >= 2);
}

// 没有同注号正文标记时，至少用书名/年份在同章正文里找一段语义片段；
// 找不到就退到章末正文，明确标为“未绑定标记”，不假装是精确链接。
function semanticContext(noteText, bodyText, fallbackSnippet) {
  const body = String(bodyText || "");
  const terms = searchableTerms(noteText).filter((term) => body.includes(term));
  if (terms.length) {
    const term = terms[0];
    const index = body.indexOf(term);
    return {
      before: body.slice(Math.max(0, index - 80), index),
      after: body.slice(index + term.length, index + term.length + 80),
      sharedTerms: terms.slice(0, 6),
      source: "semantic",
    };
  }
  if (fallbackSnippet) {
    return { before: fallbackSnippet, after: "", sharedTerms: [], source: "chapter" };
  }
  return { before: "", after: "", sharedTerms: [], source: "" };
}

function analyzeChapter(chapter) {
  const { notes, groups, bodyText, noteBlock } = noteParagraphs(chapter);
  const seen = new Map();
  let lastNumber = null;
  const analyzed = notes.map((note, order) => {
    const duplicate = Boolean(note.label) && seen.has(note.label);
    seen.set(note.label, (seen.get(note.label) || 0) + 1);
    const sequential = note.number == null || lastNumber == null
      ? null
      : note.number === lastNumber + 1;
    const previousNumber = lastNumber;
    if (note.number != null) lastNumber = note.number;
    return {
      ...note,
      order,
      previousNumber,
      sequential,
      duplicate,
    };
  });
  const byIndex = new Map(analyzed.map((note) => [note.index, note]));
  const analyzedGroups = groups.map((group) => ({
    title: group.title,
    notes: group.notes.map((note) => byIndex.get(note.index)).filter(Boolean),
  })).filter((group) => group.notes.length);
  return { notes: analyzed, groups: analyzedGroups, bodyText, noteBlock };
}

// 把一章正文里的正文标记预扫描成记录；序号在“部分”范围内统一重排，
// 原始圈号只作为参考信息，不再参与绑定。
function collectChapterMarkers(chapter, analysis, chapterId, chapterIndex) {
  const paragraphs = splitParagraphs(normalizeSupMarkup(chapter?.text || ""));
  const noteIndexes = new Set(analysis.notes.flatMap((note) => note.indices || [note.index]));
  const markers = [];
  let inFence = false;
  let page = 0;
  paragraphs.forEach((paragraph, index) => {
    const lines = String(paragraph || "").split("\n");
    const fence = lines.some(isFenceLine);
    if (inFence || fence) {
      if (fence) inFence = !inFence;
      return;
    }
    const foundPage = pageFromText(paragraph);
    if (foundPage) page = foundPage;
    if (noteIndexes.has(index)) return;
    const pagePrefix = pagePrefixOf(paragraph);
    const text = pagePrefix ? paragraph.slice(pagePrefix.length) : paragraph;
    MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MARKER_RE.exec(text))) {
      const label = stripHtmlTags(match[1] ?? match[2] ?? match[3] ?? match[0]);
      markers.push({
        chapterId,
        chapterIndex,
        page: page || 0,
        label,
        number: noteLabelNumber(label),
        form: match[1] != null ? "latex" : match[2] != null ? "sup" : match[3] != null ? "bracket" : "raw",
        before: snippet(text.slice(Math.max(0, match.index - 160), match.index), 60),
        after: snippet(text.slice(match.index + match[0].length, match.index + match[0].length + 160), 60),
      });
    }
  });
  return markers;
}

function insertMarkerComments(paragraph, markerQueue) {
  const text = String(paragraph || "");
  MARKER_RE.lastIndex = 0;
  let result = "";
  let cursor = 0;
  let match;
  while ((match = MARKER_RE.exec(text))) {
    result += text.slice(cursor, match.index);
    const marker = markerQueue.shift();
    if (marker) {
      result += `<sup>${marker.canonical}</sup>`;
      result += `<!-- polish:marker ${marker.id} chapter=${marker.chapterId} page=${marker.page} label=${JSON.stringify(String(marker.canonical))}${marker.noteId ? ` note=${marker.noteId}` : ""} -->`;
    } else {
      result += match[0];
    }
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor);
}

function addNoteComments(paragraph, state, analyzed) {
  const text = String(paragraph || "");
  const pagePrefix = pagePrefixOf(text);
  const body = pagePrefix ? text.slice(pagePrefix.length) : text;
  const page = analyzed.page || 0;
  const noteId = analyzed.id;
  const marker = analyzed.marker || null;
  const canonical = analyzed.canonical;
  const sourceText = analyzed.text || body;
  const rest = sourceText.replace(NOTE_LABEL_RE, "").replace(/^[\s.．、)）〕】〗\]]+/, "").trimStart();
  // 用顿号而不是 `1.`：Markdown 会把行首 `1.` 当成有序列表。
  // 不加空格：`1、 文本` 会被 markdownToHtml 当成有序列表。
  const noteText = `${canonical}、${rest}`.trim();
  const note = {
    id: noteId,
    chapterId: state.chapterId,
    page,
    label: String(canonical),
    number: canonical,
    text: noteText,
    source: "notes-block",
    linked: analyzed.linked,
    alignment: analyzed.alignment,
    markerId: marker?.id || null,
    reasons: analyzed.reasons,
  };
  state.notes.push(note);
  const groupAttr = analyzed.group ? ` group=${JSON.stringify(String(analyzed.group))}` : "";
  const comment = [
    `<!-- polish:note ${noteId} chapter=${state.chapterId} page=${page} label=${JSON.stringify(String(canonical))} linked=${analyzed.linked ? "true" : "false"} alignment=${analyzed.alignment || "none"}${groupAttr} -->`,
  ];
  if (analyzed.uncertain) {
    state.pointIndex += 1;
    const pointId = `point-${String(state.pointIndex).padStart(3, "0")}`;
    const semantic = semanticContext(noteText, state.bodyText, state.lastBodySnippet);
    const context = {
      noteText: noteText.slice(0, 260),
      before: semantic?.before || "",
      after: semantic?.after || "",
      sharedTerms: semantic?.sharedTerms || [],
      source: semantic?.source || "",
      markerChapterId: "",
      markerPage: 0,
    };
    const point = {
      id: pointId,
      kind: "note-unlinked",
      severity: "medium",
      chapterId: state.chapterId,
      page,
      noteId,
      markerId: null,
      title: `注号 ${canonical} 没有对应的正文标记`,
      reason: analyzed.reasons.join("；"),
      suggestions: [],
      context,
      status: "open",
    };
    state.points.push(point);
    comment.push(`<!-- polish:point ${pointId} kind=${point.kind} note=${noteId} page=${page} -->`);
  }
  return { text: `${pagePrefix}${comment.join("\n")}\n${noteText}`, note };
}

// 生成整本书 polish.md 和报告。chapters: [{ title, text }]。
export function buildPolishMarkdown({ title = "", chapters = [], stripBold = false } = {}) {
  const list = (Array.isArray(chapters) ? chapters : []).map((chapter) => ({
    ...(chapter || {}),
    text: isPrintedTocChapter(chapter)
      ? String(chapter?.text || "")
      : tidyOcrText(fillEmptyMarkerNumbers(chapter?.text || ""), { bold: stripBold ? "all" : "long" }),
  }));
  const parts = [];
  const bookTitle = String(title || "").trim();
  if (bookTitle) parts.push(`# ${bookTitle}`);

  // 第一遍：分析每章的注文/正文标记，并按“上一次注释块之后”的部分对齐。
  const chaptersInfo = list.map((chapter, index) => {
    const chapterId = `ch-${String(index + 1).padStart(3, "0")}`;
    const chapterIndex = String(index + 1).padStart(3, "0");
    const chapterTitle = String(chapter?.title || "").trim()
      || (index === 0 && bookTitle ? bookTitle : `第 ${index + 1} 章`);
    const analysis = analyzeChapter(chapter);
    const markers = collectChapterMarkers(chapter, analysis, chapterId, chapterIndex);
    // 分组注释对齐时不能被“疑似注文”误删正文标记；单独保留一份全量标记。
    const markersAll = collectChapterMarkers(chapter, { notes: [], noteBlock: false }, chapterId, chapterIndex);
    return { chapter, chapterId, chapterIndex, chapterTitle, analysis, markers, markersAll };
  });
  let noteIndex = 0;
  let repeatedReferences = 0;
  let partMarkers = [];
  let partBodyTexts = [];
  const sequenceIssues = [];
  const markerMapByNumber = (markers) => {
    const map = new Map();
    for (const marker of markers) {
      if (marker.number != null && !map.has(marker.number)) map.set(marker.number, marker);
    }
    return map;
  };
  // Partial note blocks (OCR lost some numbers) still have a stable offset in
  // many books: notes 1..7 may sit under body markers 44..50. Match exact labels
  // first, then apply a single consistent offset to the remaining notes. Never
  // guess when the observed offsets disagree.
  const matchNotesToMarkers = (notes, markers) => {
    const result = new Map();
    const byNumber = markerMapByNumber(markers);
    const used = new Set();
    const deltas = [];
    for (const note of notes) {
      if (note.number == null) continue;
      const marker = byNumber.get(note.number);
      if (!marker || used.has(marker)) continue;
      result.set(note, marker);
      used.add(marker);
      deltas.push(marker.number - note.number);
    }
    let offset = deltas.length && deltas.every((delta) => delta === deltas[0]) ? deltas[0] : null;
    if (offset == null && !deltas.length) {
      const guesses = [];
      const count = Math.min(notes.length, markers.length);
      for (let index = 0; index < count; index += 1) {
        if (notes[index].number == null || markers[index].number == null) continue;
        guesses.push(markers[index].number - notes[index].number);
      }
      if (guesses.length >= 2 && guesses.every((delta) => delta === guesses[0])) offset = guesses[0];
    }
    if (offset) {
      for (const note of notes) {
        if (result.has(note) || note.number == null) continue;
        const marker = byNumber.get(note.number + offset);
        if (!marker || used.has(marker)) continue;
        result.set(note, marker);
        used.add(marker);
      }
    }
    return result;
  };
  for (const info of chaptersInfo) {
    for (const note of info.analysis.notes) {
      noteIndex += 1;
      note.id = `note-${String(noteIndex).padStart(3, "0")}`;
    }
    for (const marker of info.markers) {
      marker.canonical = marker.number ?? partMarkers.length + 1;
      marker.id = `marker-${marker.chapterIndex}-${String(marker.canonical).padStart(3, "0")}`;
      partMarkers.push(marker);
    }
    if (info.analysis.bodyText) partBodyTexts.push(info.analysis.bodyText);
    // 书末注释按章分组：每组只和本章的正文标记对齐，不能把后面章节的
    // 注文按全局顺序接在前一章多出来的标记上。
    if (info.analysis.noteBlock && info.analysis.groups.length >= 2) {
      for (const group of info.analysis.groups) {
        // 不把“前言”组对到整本前置页：前置页里的 CIP/版权数字不是正文标记。
        // 但“第一章”这类章节组允许落在第一章（有些书没有单独的前置章）。
        const chapterLikeGroup = /^(?:第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]|chapter\s+\d+|part\s+\d+)/i.test(group.title);
        const target = chaptersInfo.find((candidate, index) => (
          (index > 0 || chapterLikeGroup)
          && candidate !== info
          && !candidate.analysis.noteBlock
          && noteGroupMatches(group.title, candidate.chapterTitle)
        ));
        const markers = target?.markersAll || [];
        // 第二遍写注释用的是 info.markers；对齐必须换到同一批对象上，
        // 否则 marker 注释里不会带 note=，重建时链接会全部丢掉。
        if (target) target.markers = markers;
        const sameCount = markers.length === group.notes.length;
        const renumber = sameCount;
        const matches = renumber ? null : matchNotesToMarkers(group.notes, markers);
        group.notes.forEach((note, index) => {
          const marker = renumber ? (markers[index] || null) : (matches.get(note) || null);
          note.canonical = renumber ? index + 1 : (note.number ?? index + 1);
          note.marker = marker;
          note.linked = Boolean(note.marker);
          note.alignment = note.marker ? "group" : "none";
          note.reasons = note.marker ? [] : [`“${group.title}”这一组正文没有足够的标记`];
          note.uncertain = !note.marker;
        });
        markers.forEach((marker, index) => {
          marker.canonical = renumber ? index + 1 : (marker.number ?? index + 1);
          marker.id = `marker-${marker.chapterIndex}-${String(marker.canonical).padStart(3, "0")}`;
          marker.noteId = "";
        });
        for (const note of group.notes) {
          if (note.marker) note.marker.noteId = note.id;
        }
        repeatedReferences += Math.max(0, markers.length - group.notes.length);
        const noteCount = group.notes.length;
        const markerCount = markers.length;
        const issues = [];
        if (noteCount !== markerCount) {
          const detail = markerCount > noteCount ? "多出的正文标记可能是重复引用" : "可能有注文没有正文标记";
          issues.push(`注文 ${noteCount} 条 / 正文标记 ${markerCount} 个，相差 ${Math.abs(markerCount - noteCount)}（${detail}）`);
        }
        const firstNote = noteLabelNumber(group.notes[0]?.label);
        const firstMarker = noteLabelNumber(markers[0]?.label);
        if (firstNote != null && firstMarker != null && firstNote !== firstMarker) {
          issues.push(`起始注号不一致：注文 ${firstNote} / 正文 ${firstMarker}`);
        }
        const diffs = [];
        for (let index = 0; index < Math.min(noteCount, markerCount); index += 1) {
          const noteNumber = noteLabelNumber(group.notes[index]?.label);
          const markerNumber = noteLabelNumber(markers[index]?.label);
          if (noteNumber != null && markerNumber != null) diffs.push(noteNumber - markerNumber);
        }
        if (diffs.length >= 4) {
          const counts = new Map();
          for (const diff of diffs) counts.set(diff, (counts.get(diff) || 0) + 1);
          const [dominant, count] = [...counts].sort((left, right) => right[1] - left[1])[0];
          if (dominant !== 0 && count >= Math.max(3, Math.ceil(diffs.length * 0.6))) {
            issues.push(`注文与正文注号整体偏移 ${dominant > 0 ? "+" : ""}${dominant}`);
          }
        }
        if (issues.length) {
          sequenceIssues.push({
            chapterId: target?.chapterId || info.chapterId,
            chapterTitle: group.title || target?.chapterTitle || info.chapterTitle,
            noteCount,
            markerCount,
            message: issues.join("；"),
          });
        }
      }
      for (const note of info.analysis.notes) {
        if (note.marker && !note.marker.noteId) note.marker.noteId = note.id;
      }
      partMarkers = [];
      partBodyTexts = [];
      continue;
    }
    if (info.analysis.noteBlock) {
      info.partBodyText = partBodyTexts.join("\n\n");
      info.strippedBodyText = strippedText(info.partBodyText);
      info.lastBodySnippet = snippet(info.partBodyText.slice(-500), 100);
      // 注文与正文标记优先按原始注号配对；只有两边都没有数字时才按顺序。
      // 这样 22–26 这种从页底开始的部分注文不会被重排成 1–5 后错配到正文 1–5。
      const sameCount = partMarkers.length === info.analysis.notes.length;
      const renumber = sameCount;
      const matches = renumber ? null : matchNotesToMarkers(info.analysis.notes, partMarkers);
      info.analysis.notes.forEach((note, index) => {
        const marker = renumber ? (partMarkers[index] || null) : (matches.get(note) || null);
        note.canonical = renumber ? index + 1 : (note.number ?? index + 1);
        note.marker = marker;
        note.linked = Boolean(note.marker);
        note.alignment = note.marker ? "ordinal" : "none";
        note.reasons = note.marker ? [] : ["本部分正文没有与该注文对应的标记"];
        note.uncertain = !note.marker;
      });
      if (renumber) {
        partMarkers.forEach((marker, index) => {
          marker.canonical = index + 1;
          marker.id = `marker-${marker.chapterIndex}-${String(marker.canonical).padStart(3, "0")}`;
        });
      } else {
        // Preserve original labels on markers too; the comment/HTML must show
        // the number the reader sees in the scan.
        for (const marker of partMarkers) {
          if (marker.number != null) {
            marker.canonical = marker.number;
            marker.id = `marker-${marker.chapterIndex}-${String(marker.canonical).padStart(3, "0")}`;
          }
        }
      }
      repeatedReferences += Math.max(0, partMarkers.length - info.analysis.notes.length);
      const noteCount = info.analysis.notes.length;
      const markerCount = partMarkers.length;
      const issues = [];
      if (noteCount !== markerCount) {
        issues.push(`注文 ${noteCount} 条 / 正文标记 ${markerCount} 个，相差 ${Math.abs(markerCount - noteCount)}`);
      }
      const firstNote = info.analysis.notes[0]?.number;
      const firstMarker = partMarkers[0]?.number;
      if (firstNote != null && firstMarker != null && firstNote !== firstMarker) {
        issues.push(`起始注号不一致：注文 ${firstNote} / 正文 ${firstMarker}`);
      }
      const diffs = [];
      for (let index = 0; index < Math.min(noteCount, markerCount); index += 1) {
        const noteNumber = info.analysis.notes[index]?.number;
        const markerNumber = partMarkers[index]?.number;
        if (noteNumber != null && markerNumber != null) diffs.push(noteNumber - markerNumber);
      }
      if (diffs.length >= 4) {
        const counts = new Map();
        for (const diff of diffs) counts.set(diff, (counts.get(diff) || 0) + 1);
        const [dominant, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
        if (dominant !== 0 && count >= Math.max(3, Math.ceil(diffs.length * 0.6))) {
          issues.push(`注文与正文注号整体偏移 ${dominant > 0 ? "+" : ""}${dominant}`);
        }
      }
      if (issues.length) {
        sequenceIssues.push({
          chapterId: info.chapterId,
          chapterTitle: info.chapterTitle,
          noteCount,
          markerCount,
          message: issues.join("；"),
        });
      }
      for (const note of info.analysis.notes) {
        if (note.marker && !note.marker.noteId) note.marker.noteId = note.id;
      }
      partMarkers = [];
      partBodyTexts = [];
    }
  }

  // 第二遍：写 Markdown、注释和报告点。
  const state = {
    pointIndex: 0,
    chapterId: "",
    notes: [],
    points: [],
    bodyText: "",
    lastBodySnippet: "",
  };
  for (const info of chaptersInfo) {
    state.chapterId = info.chapterId;
    state.bodyText = info.strippedBodyText || strippedText(info.analysis.bodyText);
    state.lastBodySnippet = info.lastBodySnippet || snippet(info.analysis.bodyText.slice(-500), 100);
    parts.push(`## ${info.chapterTitle}`);
    const paragraphs = splitParagraphs(normalizeSupMarkup(info.chapter?.text || ""));
    const noteByIndex = new Map();
    for (const note of info.analysis.notes) {
      for (const index of note.indices || [note.index]) noteByIndex.set(index, note);
    }
    const markerQueue = info.markers.slice();
    let inFence = false;
    const output = [];
    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
      const paragraph = paragraphs[paragraphIndex];
      const lines = String(paragraph || "").split("\n");
      const fence = lines.some(isFenceLine);
      if (inFence || fence) {
        output.push(paragraph);
        if (fence) inFence = !inFence;
        continue;
      }
      const analyzed = noteByIndex.get(paragraphIndex);
      if (analyzed) {
        if (paragraphIndex !== analyzed.index) continue;
        const result = addNoteComments(paragraph, state, analyzed);
        output.push(result.text);
        continue;
      }
      output.push(insertMarkerComments(paragraph, markerQueue));
    }
    parts.push(output.join("\n\n").trim());
  }

  const notes = state.notes;
  const points = state.points;
  const markers = chaptersInfo.flatMap((info) => info.markers);
  const markdown = `${parts.filter(Boolean).join("\n\n").replace(/\s+$/, "")}\n`;
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    summary: {
      notes: notes.length,
      autoAccepted: notes.length - points.length,
      needsReview: points.length,
      unlinkedNotes: points.filter((point) => point.kind === "note-unlinked").length,
      repeatedReferences,
      tocIssues: 0,
      chapterIssues: sequenceIssues.length,
    },
    points,
    sequenceIssues,
  };
  return { markdown, report, notes, markers };
}

// 解析 polish.md 里的 note/point/marker 注释，供重建/校验使用。
export function parsePolishMarkdown(markdown) {
  const text = normalizeSupMarkup(markdown);
  const noteRe = /<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g;
  const pointRe = /<!--\s*polish:point\s+([^\s]+)([^>]*)-->/g;
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  const notes = [];
  const points = [];
  const markers = [];
  for (const re of [noteRe, pointRe, markerRe]) {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text))) {
      const attrs = {};
      for (const attr of String(match[2] || "").matchAll(/([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s]+))/g)) {
        attrs[attr[1]] = attr[2] ?? attr[3] ?? "";
      }
      const item = { id: match[1], ...attrs };
      if (re === noteRe) notes.push(item);
      else if (re === pointRe) points.push(item);
      else markers.push(item);
    }
  }
  return { notes, points, markers };
}

const LIVE_POINT_KINDS = new Set([
  "note-unlinked",
  "note-unlabeled",
  "note-empty",
  "note-duplicate",
  "note-label-mismatch",
  "marker-label-mismatch",
  "notes-empty-block",
]);

function sameNoteLabel(left, right) {
  const a = noteLabelNumber(left);
  const b = noteLabelNumber(right);
  if (a != null && b != null) return a === b;
  return String(left || "").trim() === String(right || "").trim();
}

function noteBodyText(text) {
  return String(text || "").replace(NOTE_LABEL_RE, "").replace(/^[\s.．、)）〕】〗]+/, "").trim();
}

function noteGroupKey(value) {
  return String(value || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]\s*/, "")
    .replace(/^(?:chapter|part)\s+[0-9ivxlc]+[.、:]?\s*/i, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function noteGroupMatches(left, right) {
  const a = noteGroupKey(left);
  const b = noteGroupKey(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function pointIdPart(value) {
  return String(value || "").replace(/[^\w-]+/g, "_").slice(0, 80);
}

function livePolishPoint({ id, kind, title, reason, chapterId = "", chapterTitle = "", page = 0, noteId = "", markerId = "", noteText = "", label = "", suggestions = [], markerChapterId = "", markerPage = 0, markerChapterTitle = "" }) {
  return {
    id,
    kind,
    severity: "medium",
    chapterId,
    page: Number(page) || 0,
    noteId,
    markerId: markerId || null,
    label,
    title,
    reason,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    context: {
      noteText: String(noteText || "").slice(0, 260),
      before: "",
      after: "",
      sharedTerms: [],
      source: "note",
      markerChapterId: String(markerChapterId || ""),
      markerPage: Number(markerPage) || 0,
      markerChapterTitle: String(markerChapterTitle || ""),
      chapterTitle,
    },
    status: "open",
    live: true,
  };
}

function mergeExistingPoint(existing, next) {
  if (!existing) return next;
  return {
    ...existing,
    ...next,
    id: existing.id,
    status: existing.status || next.status || "open",
    suggestions: Array.isArray(existing.suggestions) && existing.suggestions.length
      ? existing.suggestions
      : next.suggestions,
    context: {
      ...(next.context || {}),
      ...(existing.context || {}),
      // 旧报告里的跨章定位通常为空；重新计算出的非空值要能覆盖它。
      markerChapterId: next.context?.markerChapterId || existing.context?.markerChapterId || "",
      markerChapterTitle: next.context?.markerChapterTitle || existing.context?.markerChapterTitle || "",
      noteText: next.context?.noteText || existing.context?.noteText || "",
    },
  };
}

// 按当前 polish.md 重算章节级别的注文/正文标记数量问题。
// 生成时和手动编辑后使用同一套规则，修好后“编号问题”会自己消失。
function auditSequenceIssues(markdown, manifest = {}, preparedSplit = null) {
  const split = preparedSplit || splitPolishMarkdown(markdown);
  const manifestChapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  const idByTitle = new Map();
  for (const chapter of manifestChapters) {
    const title = String(chapter?.title || "").trim();
    if (title && !idByTitle.has(title)) idByTitle.set(title, String(chapter.id || ""));
  }
  const issues = [];
  let partMarkers = [];
  split.chapters.forEach((chapter, index) => {
    const body = String(chapter?.text || "");
    const notes = [...body.matchAll(/<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g)]
      .map((match) => ({ id: match[1], ...polishCommentAttrs(match[2]) }));
    const markers = [...body.matchAll(/<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g)]
      .map((match) => ({ id: match[1], ...polishCommentAttrs(match[2]) }));
    if (!notes.length) {
      partMarkers.push(...markers);
      return;
    }
    const allMarkers = partMarkers.concat(markers);
    const noteCount = notes.length;
    const markerCount = allMarkers.length;
    const messages = [];
    if (noteCount !== markerCount) {
      const detail = markerCount > noteCount ? "多出的正文标记可能是重复引用" : "可能有注文没有正文标记";
      messages.push(`注文 ${noteCount} 条 / 正文标记 ${markerCount} 个，相差 ${Math.abs(markerCount - noteCount)}（${detail}）`);
    }
    const firstNote = noteLabelNumber(notes[0]?.label);
    const firstMarker = noteLabelNumber(allMarkers[0]?.label);
    if (firstNote != null && firstMarker != null && firstNote !== firstMarker) {
      messages.push(`起始注号不一致：注文 ${firstNote} / 正文 ${firstMarker}`);
    }
    const diffs = [];
    for (let cursor = 0; cursor < Math.min(noteCount, markerCount); cursor += 1) {
      const noteNumber = noteLabelNumber(notes[cursor]?.label);
      const markerNumber = noteLabelNumber(allMarkers[cursor]?.label);
      if (noteNumber != null && markerNumber != null) diffs.push(noteNumber - markerNumber);
    }
    if (diffs.length >= 4) {
      const counts = new Map();
      for (const diff of diffs) counts.set(diff, (counts.get(diff) || 0) + 1);
      const [dominant, count] = [...counts].sort((left, right) => right[1] - left[1])[0];
      if (dominant !== 0 && count >= Math.max(3, Math.ceil(diffs.length * 0.6))) {
        messages.push(`注文与正文注号整体偏移 ${dominant > 0 ? "+" : ""}${dominant}`);
      }
    }
    if (messages.length) {
      const title = String(chapter?.title || "").trim() || `第 ${index + 1} 章`;
      issues.push({
        chapterId: idByTitle.get(title) || String(manifestChapters[index]?.id || `ch-${String(index + 1).padStart(3, "0")}`),
        chapterTitle: title,
        noteCount,
        markerCount,
        message: messages.join("；"),
      });
    }
    partMarkers = [];
  });
  return issues;
}

const TOC_POINT_KINDS = new Set([
  "toc-empty-title",
  "toc-page-number",
  "toc-missing-chapter",
  "toc-duplicate-entry",
  "toc-level-jump",
  "toc-order",
  "toc-title-mismatch",
  "toc-missing-entry",
]);

function normalizeTocTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u3000:：,，.。;；!?！？"'“”‘’()（）《》〈〉·—–\-_/\\]/g, "");
}

function tocTitleMatches(left, right) {
  const a = normalizeTocTitle(left);
  const b = normalizeTocTitle(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // 书面目录常有“第五章 两淮盐务”这种父条目，正文标题只有“两淮盐务”；
  // 允许包含关系，但限制长度差，避免“前言”误配到很长的章节。
  if (b.length >= 2 && a.includes(b) && a.length - b.length <= 12) return true;
  if (a.length >= 2 && b.includes(a) && b.length - a.length <= 12) return true;
  return false;
}

// 目录是印刷目录的映射，最容易出现“条目还在、章节已改名/删除”和层级错误。
// 这里只报高置信度问题，并给出修改建议，不自动改目录。
function auditTocPoints(nav, chapters = [], manifest = {}) {
  const items = Array.isArray(nav) ? nav : [];
  const list = Array.isArray(chapters) ? chapters : [];
  if (!items.length || !list.length) return [];
  const manifestChapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  const idByTitle = new Map();
  for (const chapter of manifestChapters) {
    const title = String(chapter?.title || "").trim();
    if (title && !idByTitle.has(title)) idByTitle.set(title, String(chapter.id || ""));
  }
  const chapterIdAt = (index) => {
    const chapter = list[index];
    if (!chapter) return "";
    const title = String(chapter.title || "").trim();
    return idByTitle.get(title) || String(manifestChapters[index]?.id || `ch-${String(index + 1).padStart(3, "0")}`);
  };
  const points = [];
  const add = ({ key, kind, title, reason, suggestions = [], chapterId = "", chapterTitle = "", before = "", after = "", severity = "medium" }) => {
    points.push({
      id: `point-live-${key}`,
      kind,
      severity,
      chapterId,
      page: 0,
      noteId: "",
      markerId: null,
      label: "目录",
      title,
      reason,
      suggestions,
      context: {
        noteText: "",
        before,
        after,
        sharedTerms: [],
        source: "toc",
        markerChapterId: "",
        markerPage: 0,
        chapterTitle,
      },
      status: "open",
      live: true,
      tocKey: key,
    });
  };

  let previousLevel = 0;
  let furthestChapter = 0;
  const seen = new Map();
  items.forEach((item, index) => {
    const title = String(item?.title || "").trim();
    const file = String(item?.file || "");
    const match = /chapter-(\d+)\.xhtml$/i.exec(file);
    const chapterIndex = match ? Number(match[1]) - 1 : -1;
    const level = Number(item?.level) || 1;
    const chapter = chapterIndex >= 0 ? list[chapterIndex] : null;
    const chapterId = chapter ? chapterIdAt(chapterIndex) : "";
    const chapterTitle = String(chapter?.title || "").trim();
    const before = String(items[index - 1]?.title || "").trim();
    const after = String(items[index + 1]?.title || "").trim();
    const key = `toc-${index}`;

    if (!title) {
      add({
        key: `${key}-empty`,
        kind: "toc-empty-title",
        title: `目录第 ${index + 1} 条没有标题`,
        reason: "重建后会生成空条目或丢失层级。",
        suggestions: ["对照原书目录页补上标题；如果是 OCR 误行，删掉这一条。"],
        chapterId,
        chapterTitle,
        before,
        after,
        severity: "high",
      });
    }
    if (/^\d{1,4}$/.test(title)) {
      add({
        key: `${key}-page`,
        kind: "toc-page-number",
        title: `目录条目“${title}”像是页码，不是标题`,
        reason: "目录解析可能把页码单独当成了一条条目。",
        suggestions: ["核对原目录页；把页码并回上一条，或删除这条。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    if (/\s+\d{1,4}$/.test(title) && title.length > 4) {
      add({
        key: `${key}-trailing-page`,
        kind: "toc-page-number",
        title: `目录标题可能带上了页码：${title}`,
        reason: "标题末尾的数字更像印刷页码；它会显示在 EPUB 目录里。",
        suggestions: ["删掉标题末尾的页码，或确认它确实是标题的一部分。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    if (match && chapterIndex >= list.length) {
      add({
        key: `${key}-missing-chapter`,
        kind: "toc-missing-chapter",
        title: `目录条目“${title || file}”指向不存在的章节`,
        reason: `条目指向 ${file}，当前只有 ${list.length} 章。`,
        suggestions: ["删除这条目录，或把它改指到当前存在的章节。"],
        chapterId,
        chapterTitle,
        before,
        after,
        severity: "high",
      });
    }
    if (chapterIndex >= 0 && chapterIndex < furthestChapter) {
      add({
        key: `${key}-order`,
        kind: "toc-order",
        title: `目录顺序可能反了：${title}`,
        reason: `这一条指向第 ${chapterIndex + 1} 章，比上一条更靠前。`,
        suggestions: ["按原书目录页顺序调整；也可能是 OCR 把条目顺序读错。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    if (index === 0 && level > 1) {
      add({
        key: `${key}-level-start`,
        kind: "toc-level-jump",
        title: "目录从非一级条目开始",
        reason: `第一条的层级是 ${level}，缺少上级条目。`,
        suggestions: ["检查原目录缩进；必要时把第一条改成一级。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    if (level > previousLevel + 1) {
      add({
        key: `${key}-level-jump`,
        kind: "toc-level-jump",
        title: `目录层级从 ${previousLevel} 直接跳到 ${level}`,
        reason: "缺少中间层级会让 EPUB 导航缩进错乱。",
        suggestions: ["检查原目录缩进，补上父级条目，或把这一条改成上一级。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    previousLevel = level;
    if (chapterIndex >= 0) furthestChapter = Math.max(furthestChapter, chapterIndex);

    const duplicateKey = `${normalizeTocTitle(title)}\n${file}`;
    if (title && seen.has(duplicateKey)) {
      add({
        key: `${key}-duplicate`,
        kind: "toc-duplicate-entry",
        title: `目录条目重复：${title}`,
        reason: "同一条目出现了两次；重建后目录里会有两个一样的链接。",
        suggestions: ["保留一条；如果是父级和子级共用标题，改成不同的标题。"],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
    if (title) seen.set(duplicateKey, index);

    if (title && !file.includes("#") && !list.some((candidate) => tocTitleMatches(title, candidate.title))) {
      add({
        key: `${key}-title`,
        kind: "toc-title-mismatch",
        title: `目录标题找不到对应章节：${title}`,
        reason: chapterTitle
          ? `这一条指向的章节标题是“${chapterTitle}”，两者对不上。`
          : "当前正文里没有标题相同或包含该标题的章节。",
        suggestions: [
          "对照原书目录页和章节标题，确认是目录写错还是章节标题被 OCR 读错。",
          "如果是章节改名，重建前统一成同一个标题。",
        ],
        chapterId,
        chapterTitle,
        before,
        after,
      });
    }
  });

  // 只检查明显应该进目录的正文条目：有名字的第 N 章、附录。
  // 标题页、作者页、单纯的“第 1 章”这种不报，减少误报。
  const coveredIndexes = new Set();
  for (const item of items) {
    const match = /chapter-(\d+)\.xhtml$/i.exec(String(item?.file || ""));
    if (match) coveredIndexes.add(Number(match[1]) - 1);
  }
  list.forEach((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    if (!/^第\s*[一二三四五六七八九十百千0-9]+\s*章\s*\S+/.test(title) && !/^附录/.test(title)) return;
    if (coveredIndexes.has(index)) return;
    if (items.some((item) => tocTitleMatches(item?.title, title))) return;
    add({
      key: `toc-missing-${index}`,
      kind: "toc-missing-entry",
      title: `章节不在目录中：${title}`,
      reason: "这一章看起来是正文条目，但目录里没有对应项。",
      suggestions: ["如果原书目录包含这一章，补上目录条目；如果是正文误分章，合并或删除标题。"],
      chapterId: chapterIdAt(index),
      chapterTitle: title,
      severity: "high",
    });
  });
  return points;
}

// 修正点不是一次性快照:每次打开/保存都按当前 Markdown 重算。
// 已修好的点会消失；手工新增的未绑定注文、空注文、重复注号等会补进来。
export function derivePolishReport(markdown, report = {}, manifest = {}) {
  const text = String(markdown || "");
  const chapterTitles = (Array.isArray(manifest?.chapters) ? manifest.chapters : [])
    .map((chapter) => String(chapter?.title || "").trim())
    .filter(Boolean);
  const split = splitPolishMarkdown(text, { chapterTitles });
  const parsed = parsePolishMarkdown(text);
  const texts = collectNoteTexts(text);
  const sourcePoints = Array.isArray(report?.points) ? report.points : [];
  const usedPoints = new Set();
  const takeExisting = (predicate) => {
    for (const point of sourcePoints) {
      if (usedPoints.has(point?.id)) continue;
      if (predicate(point)) {
        usedPoints.add(point.id);
        return point;
      }
    }
    return null;
  };

  const markerByNote = new Map();
  for (const marker of parsed.markers) {
    if (!marker.note) continue;
    if (!markerByNote.has(marker.note)) markerByNote.set(marker.note, marker);
  }

  const notes = parsed.notes.map((note) => {
    const noteText = texts.get(note.id) || "";
    const commentLabel = String(note.label || "").trim();
    const textLabel = noteLabelOf(noteText);
    const marker = markerByNote.get(note.id) || null;
    return {
      id: note.id,
      chapterId: String(note.chapter || ""),
      group: String(note.group || ""),
      page: Number(note.page) || 0,
      text: noteText,
      body: noteBodyText(noteText),
      commentLabel,
      textLabel,
      label: commentLabel || textLabel,
      marker,
      linked: Boolean(marker),
    };
  });
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const manifestChapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  const idByTitle = new Map();
  for (const chapter of manifestChapters) {
    const title = String(chapter?.title || "").trim();
    if (title && !idByTitle.has(title)) idByTitle.set(title, String(chapter.id || ""));
  }
  const chapterIdAt = (chapter, index) => {
    const title = String(chapter?.title || "").trim();
    return idByTitle.get(title) || String(manifestChapters[index]?.id || `ch-${String(index + 1).padStart(3, "0")}`);
  };
  // 注释分组标题和正文标题常差一个“章”字或标点：
  // 「第四章: 争斗」vs「第四 争斗」，「结局: 审判」vs「结局 审判」。
  const noteGroupKey = (title) => tocKey(String(title || "").replace(/^第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]?\s*/, ""));
  const groupChapterByKey = new Map();
  split.chapters.forEach((chapter, index) => {
    const title = String(chapter?.title || "").trim();
    const key = noteGroupKey(title);
    if (!title || !key || groupChapterByKey.has(key)) return;
    groupChapterByKey.set(key, { id: chapterIdAt(chapter, index), title });
  });
  const chapterForGroup = (group) => groupChapterByKey.get(noteGroupKey(group)) || null;
  const points = [];
  const addPoint = (next, existing = null) => points.push(mergeExistingPoint(existing, next));

  for (const note of notes) {
    if (!note.linked) {
      const existing = takeExisting((point) => point?.noteId === note.id && (!point.kind || point.kind === "note-unlinked"));
      const groupChapter = note.group ? chapterForGroup(note.group) : null;
      const groupTitle = String(groupChapter?.title || note.group || "").trim();
      const where = groupTitle ? `“${groupTitle}”` : "本部分正文";
      addPoint(livePolishPoint({
        id: `point-live-unlinked-${note.id}`,
        kind: "note-unlinked",
        title: `${groupTitle ? `${groupTitle}：` : ""}${note.label ? `注号 ${note.label} 没有对应的正文标记` : "这条注文没有对应的正文标记"}`,
        reason: groupTitle
          ? `注释里的${where}分组有这条注文，但该章正文没有找到对应标记。`
          : "本部分正文没有与该注文对应的标记。",
        suggestions: [
          `在${where}的正文里找到对应句子，用“加标注”补上注号 ${note.label || ""}，再点“重新生成正文标记”按顺序对齐。`,
          "如果这条注文是 OCR 误行，直接用“删除注文”。",
        ],
        chapterId: note.chapterId,
        page: note.page,
        noteId: note.id,
        noteText: note.text,
        markerChapterId: groupChapter?.id || "",
        markerChapterTitle: groupTitle,
      }), existing);
    }

    if (!note.commentLabel) {
      const existing = takeExisting((point) => point?.kind === "note-unlabeled" && point.noteId === note.id);
      addPoint(livePolishPoint({
        id: `point-live-unlabeled-${note.id}`,
        kind: "note-unlabeled",
        title: note.textLabel ? `注文注释缺少编号（文本里是 ${note.textLabel}）` : "这条注文没有编号",
        reason: "隐藏注释里没有编号，重建时无法可靠关联正文标注。",
        suggestions: ["把光标放在这条注文上，用“手动补号”把编号写回注释。"],
        chapterId: note.chapterId,
        page: note.page,
        noteId: note.id,
        noteText: note.text,
      }), existing);
    }

    if (!note.body) {
      const existing = takeExisting((point) => point?.kind === "note-empty" && point.noteId === note.id);
      addPoint(livePolishPoint({
        id: `point-live-empty-${note.id}`,
        kind: "note-empty",
        title: note.label ? `注号 ${note.label} 没有注文正文` : "这条注文没有正文",
        reason: "只有注文定位注释，没有可重建的文本。",
        suggestions: ["补上注文正文；如果是 OCR 误行，删除这条注文。"],
        chapterId: note.chapterId,
        page: note.page,
        noteId: note.id,
        noteText: note.text,
      }), existing);
    }

    if (note.commentLabel && note.textLabel && !sameNoteLabel(note.commentLabel, note.textLabel)) {
      const existing = takeExisting((point) => point?.kind === "note-label-mismatch" && point.noteId === note.id);
      addPoint(livePolishPoint({
        id: `point-live-note-label-${note.id}`,
        kind: "note-label-mismatch",
        title: `注释编号 ${note.commentLabel} 与注文文本 ${note.textLabel} 不一致`,
        reason: `隐藏注释写的是 ${note.commentLabel}，注文文本开头是 ${note.textLabel}。`,
        suggestions: [
          `以原书为准，用“手动补号”把注释编号和文本统一成 ${note.commentLabel} 或 ${note.textLabel}。`,
          "重建会优先采用注文文本里的编号。",
        ],
        chapterId: note.chapterId,
        page: note.page,
        noteId: note.id,
        noteText: note.text,
      }), existing);
    }
  }

  // 有“注释/脚注/Notes”标题却一条注文都没识别出来：多半是格式没命中，
  // 这是当前解析能力最需要用户介入的地方。
  split.chapters.forEach((chapter, index) => {
    const body = String(chapter?.text || "");
    const hasHeading = body.split("\n").some((line) => isNoteHeading(line.trim()));
    if (!hasHeading) return;
    const noteCount = [...body.matchAll(/<!--\s*polish:note\b/g)].length;
    if (noteCount) return;
    const chapterId = chapterIdAt(chapter, index);
    const chapterTitle = String(chapter?.title || "").trim();
    const existing = takeExisting((point) => point?.kind === "notes-empty-block" && point.chapterId === chapterId);
    addPoint(livePolishPoint({
      id: `point-live-notes-empty-${pointIdPart(chapterId)}`,
      kind: "notes-empty-block",
      label: "注释",
      title: chapterTitle ? `“${chapterTitle}”有注释标题，但没有识别到注文` : "有注释标题，但没有识别到注文",
      reason: "注释块的编号或正文格式没有被识别；重建时这些注文会丢失。",
      suggestions: [
        "检查这一章的“注释/脚注”块，注文是否带编号（1、[1]、(1)、① 等）或是否被拆成普通段落。",
        "可以先手动给注文加编号，再用“手动补号”建立定位。",
      ],
      chapterId,
      chapterTitle,
    }), existing);
  });

  const labelGroups = new Map();
  for (const note of notes) {
    if (!note.label) continue;
    const number = noteLabelNumber(note.label);
    const key = `${note.chapterId}\u0000${note.group}\u0000${number == null ? note.label : number}`;
    if (!labelGroups.has(key)) labelGroups.set(key, []);
    labelGroups.get(key).push(note);
  }
  for (const group of labelGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const existing = takeExisting((point) => point?.kind === "note-duplicate"
      && point.chapterId === first.chapterId
      && sameNoteLabel(point.label, first.label));
    addPoint(livePolishPoint({
      id: `point-live-duplicate-${pointIdPart(first.chapterId)}-${pointIdPart(first.label)}`,
      kind: "note-duplicate",
      title: `注号 ${first.label} 在同一章重复 ${group.length} 次`,
      reason: "同一个注号对应多条注文，正文链接可能指到错误的一条。",
      suggestions: [
        "保留正确的一条，其余用“手动补号”改成后续编号。",
        "如果内容其实是同一条注文，用“与下一条合并”。",
      ],
      chapterId: first.chapterId,
      page: first.page,
      noteId: first.id,
      noteText: first.text,
    }), existing);
  }

  for (const marker of parsed.markers) {
    if (!marker.note) continue;
    const note = noteById.get(marker.note);
    if (!note || !marker.label || !note.label) continue;
    if (sameNoteLabel(marker.label, note.label)) continue;
    const existing = takeExisting((point) => point?.kind === "marker-label-mismatch" && point.markerId === marker.id);
    addPoint(livePolishPoint({
      id: `point-live-marker-label-${pointIdPart(marker.id)}`,
      kind: "marker-label-mismatch",
      title: `正文标注 ${marker.label} 与注文 ${note.label} 不一致`,
      reason: "正文里的标注编号和对应注文的编号不同。",
      suggestions: [
        "确认正文和注文哪边正确；如果正文正确，用“手动补号”改注文。",
        "改完后点“重新生成正文标记”，让两边编号重新对齐。",
      ],
      chapterId: marker.chapter || note.chapterId,
      page: Number(marker.page) || note.page,
      noteId: note.id,
      markerId: marker.id,
      noteText: note.text,
    }), existing);
  }

  const tocPoints = auditTocPoints(manifest?.nav, split.chapters, manifest);
  for (const point of tocPoints) {
    const existing = takeExisting((item) => item?.tocKey === point.tocKey || item?.id === point.id);
    addPoint(point, existing);
  }

  // 未知类型（以后新增的检查）保留；已知类型如果已经修好就不再显示。
  for (const point of sourcePoints) {
    if (!point?.id || usedPoints.has(point.id)) continue;
    if (!point.kind || LIVE_POINT_KINDS.has(point.kind) || TOC_POINT_KINDS.has(point.kind)) continue;
    if (point.noteId && !noteById.has(point.noteId)) continue;
    points.push(point);
  }

  const sequenceIssues = auditSequenceIssues(text, manifest, split);
  const issueNotes = new Set(points.map((point) => point.noteId).filter(Boolean));
  const countKind = (kind) => points.filter((point) => point.kind === kind).length;
  const linkedNotes = notes.filter((note) => note.linked).length;
  const summary = {
    ...(report?.summary || {}),
    notes: notes.length,
    autoAccepted: Math.max(0, notes.length - issueNotes.size),
    needsReview: points.length,
    unlinkedNotes: countKind("note-unlinked"),
    unlabeledNotes: countKind("note-unlabeled"),
    emptyNotes: countKind("note-empty"),
    duplicateNotes: countKind("note-duplicate"),
    noteLabelMismatches: countKind("note-label-mismatch"),
    markerLabelMismatches: countKind("marker-label-mismatch"),
    emptyNoteBlocks: countKind("notes-empty-block"),
    repeatedReferences: Math.max(0, parsed.markers.length - linkedNotes),
    chapterIssues: sequenceIssues.length,
    tocIssues: tocPoints.length,
  };
  return {
    ...(report || {}),
    schemaVersion: Number(report?.schemaVersion) || 1,
    points,
    summary,
    sequenceIssues,
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 从某条注文开始，把同一注释块后面的注文重排为 startNumber..；
// 通过 markerByNote（noteId → markerId）同步更新对应正文标记的 <sup> 和注释 label。
// “加编号”：接在当前注文上一条的编号后面。上一条也没编号时明确提示，
// 避免一下子把后面所有注文都排错。
export function nextPolishNoteNumber(markdown, noteId) {
  const parsed = parsePolishMarkdown(markdown);
  const index = parsed.notes.findIndex((note) => note.id === noteId);
  if (index < 0) return { ok: false, error: "找不到这条注文，请重新打开精修" };
  const note = parsed.notes[index];
  const chapter = String(note.chapter || "");
  let previous = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = parsed.notes[cursor];
    if (String(candidate.chapter || "") !== chapter) continue;
    previous = candidate;
    break;
  }
  if (!previous) return { ok: true, start: 1, previousId: "" };
  const rawLabel = String(previous.label || "").trim();
  const number = rawLabel ? Number(rawLabel) : NaN;
  if (!rawLabel || !Number.isFinite(number)) {
    return { ok: false, error: "上一条注文还没有编号，请先给上一条加编号" };
  }
  return {
    ok: true,
    start: Math.max(1, Math.floor(number) + 1),
    previousId: previous.id,
  };
}

export function renumberPolishNotes(markdown, noteId, startNumber, markerByNote = new Map()) {
  const text = String(markdown || "");
  const lines = text.split("\n");
  const noteRe = /^\s*<!--\s*polish:note\s+([^\s]+)([^>]*)-->/;
  const notes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(noteRe);
    if (!match) continue;
    const attrs = {};
    for (const attr of String(match[2] || "").matchAll(/([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s]+))/g)) {
      attrs[attr[1]] = attr[2] ?? attr[3] ?? "";
    }
    notes.push({ line: index, id: match[1], chapter: attrs.chapter || "", label: attrs.label || "" });
  }
  const startIndex = notes.findIndex((note) => note.id === noteId);
  if (startIndex < 0) return { markdown: text, changed: false, count: 0, labels: new Map() };
  const startLine = notes[startIndex].line;
  const chapter = notes[startIndex].chapter;
  let endLine = lines.length;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      endLine = index;
      break;
    }
  }
  const selected = notes.filter((note, index) => index >= startIndex && note.line < endLine && note.chapter === chapter);
  const markerUpdates = [];
  const labels = new Map();
  let offset = 0;
  for (const note of selected) {
    const newNumber = Number(startNumber) + offset;
    labels.set(note.id, newNumber);
    let comment = lines[note.line];
    if (/label="[^"]*"/.test(comment)) comment = comment.replace(/label="[^"]*"/, `label="${newNumber}"`);
    else comment = comment.replace(/-->$/, ` label="${newNumber}" -->`);
    lines[note.line] = comment;
    for (let index = note.line + 1; index < endLine; index += 1) {
      const current = lines[index];
      const trimmed = current.trim();
      if (!trimmed) continue;
      if (/^<!--/.test(trimmed)) continue;
      if (/^\s*\d+、/.test(current)) lines[index] = current.replace(/^(\s*)\d+、/, `$1${newNumber}、`);
      else if (!/^\s*#{1,6}\s/.test(current)) lines[index] = `${newNumber}、${current.trimStart()}`;
      break;
    }
    const markerId = typeof markerByNote.get === "function" ? markerByNote.get(note.id) : markerByNote[note.id];
    if (markerId) markerUpdates.push([markerId, newNumber]);
    offset += 1;
  }
  let output = lines.join("\n");
  for (const [markerId, newNumber] of markerUpdates) {
    const escaped = escapeRegExp(markerId);
    const supRe = new RegExp(`<sup>\\d+</sup>(<!--\\s*polish:marker\\s+${escaped}\\b[^>]*-->)`);
    output = output.replace(supRe, `<sup>${newNumber}</sup>$1`);
    const commentRe = new RegExp(`<!--\\s*polish:marker\\s+${escaped}\\b[^>]*-->`);
    output = output.replace(commentRe, (comment) => {
      if (/label="[^"]*"/.test(comment)) return comment.replace(/label="[^"]*"/, `label="${newNumber}"`);
      return comment.replace(/-->$/, ` label="${newNumber}" -->`);
    });
  }
  return {
    markdown: output,
    changed: output !== text,
    count: selected.length,
    labels,
  };
}

// 用户在编辑器里看到的编号：注文正文前缀（1、…）和正文 <sup>N</sup>。
// 自动顺延用它和上一次快照对比，找出刚被改过的那一条；注释里的 label
// 只作为兜底，因为定位注释默认是隐藏的。
export function collectPolishNumbers(markdown) {
  const text = String(markdown || "");
  const parsed = parsePolishMarkdown(text);
  const texts = collectNoteTexts(text);
  const notes = new Map();
  for (const note of parsed.notes) {
    const body = texts.get(note.id) || "";
    const bodyLabel = noteLabelOf(body.replace(/^(?:\s*<!--\s*page:[^>]*-->\s*)+/, ""));
    const bodyNumber = noteLabelNumber(bodyLabel);
    const commentNumber = noteLabelNumber(note.label);
    notes.set(note.id, {
      id: note.id,
      chapter: String(note.chapter || ""),
      label: bodyNumber ?? commentNumber,
      bodyLabel,
      bodyNumber,
      commentLabel: String(note.label || ""),
      commentNumber,
      raw: bodyLabel || String(note.label || ""),
    });
  }
  const markers = new Map();
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  let match;
  while ((match = markerRe.exec(text))) {
    const id = match[1];
    if (markers.has(id)) continue;
    const attrs = polishCommentAttrs(match[2]);
    const before = text.slice(Math.max(0, match.index - 160), match.index);
    const sup = /<sup\b[^>]*>([^<]*)<\/sup>\s*$/.exec(before);
    const supLabel = sup ? stripHtmlTags(sup[1]) : "";
    const supNumber = noteLabelNumber(supLabel);
    const commentNumber = noteLabelNumber(attrs.label);
    markers.set(id, {
      id,
      note: String(attrs.note || ""),
      chapter: String(attrs.chapter || ""),
      label: supNumber ?? commentNumber,
      supLabel,
      supNumber,
      commentLabel: String(attrs.label || ""),
      commentNumber,
      raw: supLabel || String(attrs.label || ""),
    });
  }
  return { notes, markers };
}

function setMarkerNumber(text, markerId, number) {
  const id = escapeRegExp(markerId);
  let output = String(text || "").replace(
    new RegExp(`<sup\\b[^>]*>[^<]*<\\/sup>(\\s*<!--\\s*polish:marker\\s+${id}\\b[^>]*-->)`),
    `<sup>${number}</sup>$1`,
  );
  output = output.replace(new RegExp(`<!--\\s*polish:marker\\s+${id}\\b[^>]*-->`), (comment) => {
    if (/label="[^"]*"/.test(comment)) return comment.replace(/label="[^"]*"/, `label="${number}"`);
    return comment.replace(/-->$/, ` label="${number}" -->`);
  });
  return output;
}

// 手工修改正文标记编号时，同一章后面的标记一起顺延。链接到注文的标记
// 由 renumberPolishNotes 处理；这里主要覆盖没有 note= 的重复引用/手工标记。
export function renumberPolishMarkers(markdown, markerId, startNumber) {
  const text = String(markdown || "");
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  const markers = [];
  let match;
  while ((match = markerRe.exec(text))) {
    markers.push({ id: match[1], attrs: polishCommentAttrs(match[2]) });
  }
  const start = markers.findIndex((marker) => marker.id === markerId);
  if (start < 0) return { markdown: text, changed: false, count: 0, labels: new Map() };
  const chapter = String(markers[start].attrs.chapter || "");
  const selected = markers.slice(start).filter((marker) => (
    !chapter || String(marker.attrs.chapter || "") === chapter
  ));
  const labels = new Map();
  let nextNumber = Math.max(1, Math.floor(Number(startNumber) || 1));
  for (const marker of selected) {
    const key = String(marker.attrs.note || `marker:${marker.id}`);
    if (labels.has(key)) continue;
    labels.set(key, nextNumber);
    nextNumber += 1;
  }
  let output = text;
  for (const marker of selected) {
    const key = String(marker.attrs.note || `marker:${marker.id}`);
    output = setMarkerNumber(output, marker.id, labels.get(key));
  }
  return { markdown: output, changed: output !== text, count: selected.length, labels };
}

// 按注文当前编号刷新对应正文标记的 <sup> 和 marker 注释 label。
// 用于第二步：注释编号确认后，正文标注自动跟随注释。
function setPolishCommentAttr(comment, key, value) {
  const pattern = new RegExp(`\\b${escapeRegExp(key)}=(?:"([^"]*)"|([^\\s>]+))`);
  const match = pattern.exec(comment);
  if (match) {
    if ((match[1] ?? match[2] ?? "") === String(value)) return comment;
    return comment.replace(pattern, `${key}="${value}"`);
  }
  return comment.replace(/\s*-->$/, ` ${key}="${value}" -->`);
}

function removePolishCommentAttr(comment, key) {
  return String(comment || "").replace(new RegExp(`\\s+${escapeRegExp(key)}=(?:"[^"]*"|[^\\s>]+)`), "");
}

function polishCommentAttrs(raw) {
  const attrs = {};
  for (const attr of String(raw || "").matchAll(/([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s>]+))/g)) {
    attrs[attr[1]] = attr[2] ?? attr[3] ?? "";
  }
  return attrs;
}

// 手工加标注时，对应的注文可能还没编号。先把它接在上一条后面，并把后续
// 注文一起顺延；否则第二步会拿位置号当临时编号，和真正的下一条撞号。
function normalizeMissingNoteLabels(markdown) {
  let text = String(markdown || "");
  for (let guard = 0; guard < 50; guard += 1) {
    const parsed = parsePolishMarkdown(text);
    const empty = parsed.notes.find((note) => !String(note.label || "").trim());
    if (!empty) return text;
    const chapter = String(empty.chapter || "");
    const index = parsed.notes.findIndex((note) => note.id === empty.id);
    let previous = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (String(parsed.notes[cursor].chapter || "") !== chapter) continue;
      previous = parsed.notes[cursor];
      break;
    }
    const previousLabel = String(previous?.label || "").trim();
    if (previous && !previousLabel) return text;
    const previousNumber = previous ? Number(previousLabel) : null;
    if (previous && !Number.isFinite(previousNumber)) return text;
    const start = previous ? Math.max(1, Math.floor(previousNumber) + 1) : 1;
    const markerByNote = new Map();
    for (const marker of parsed.markers) {
      if (marker.note) markerByNote.set(marker.note, marker.id);
    }
    const result = renumberPolishNotes(text, empty.id, start, markerByNote);
    if (!result.changed) return text;
    text = result.markdown;
  }
  return text;
}

// 书末注释章里的分组标题（“## 前言”“## 第一章: 观察者”…）。
function noteGroupsInText(text) {
  const groups = [];
  let current = { title: "", notes: [] };
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n");
    const notes = [...body.matchAll(/<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
      id: match[1],
      attrs: polishCommentAttrs(match[2]),
    }));
    if (notes.length) groups.push({ title: current.title, notes });
    buffer = [];
  };
  for (const line of String(text || "").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), notes: [] };
    } else {
      buffer.push(line);
    }
  }
  flush();
  return groups;
}

// 第二步：按阅读顺序把“注释块里的注文”和“这一部分正文里的标记”一一对齐。
// 不能只按 marker.note 更新：手工补进来的注文没有 note 链接，旧引擎生成的
// 空间里也可能留着错位链接。顺序对齐与生成时的规则一致，补号后才真正生效。
//
// 书末注释常按章分组（“## 前言”“## 第一章: 观察者”…）。分组时必须把每组
// 对到它自己那一章的正文标记；旧实现只处理了第一组，然后把剩余正文标记
// 全部丢掉，导致后面章节手工加的标注不会顺延（例：加了 10，后面还是 6、7）。
export function refreshPolishBodyMarkers(markdown, { chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const source = normalizeMissingNoteLabels(text);
  let output = source;
  const usedMarkers = new Set();
  const setNoteLinked = (noteId, linked, alignment = "ordinal") => {
    const escaped = escapeRegExp(noteId);
    const commentRe = new RegExp(`<!--\\s*polish:note\\s+${escaped}\\b[^>]*-->`);
    output = output.replace(commentRe, (comment) => {
      let next = setPolishCommentAttr(comment, "linked", linked ? "true" : "false");
      next = setPolishCommentAttr(next, "alignment", linked ? alignment : "none");
      return next;
    });
  };
  const updateMarker = (marker, label, noteId) => {
    const escaped = escapeRegExp(marker.id);
    const commentRe = new RegExp(`<!--\\s*polish:marker\\s+${escaped}\\b[^>]*-->`);
    const comment = output.match(commentRe)?.[0] || "";
    if (!comment) return;
    let next = setPolishCommentAttr(comment, "label", label);
    next = noteId
      ? setPolishCommentAttr(next, "note", noteId)
      : removePolishCommentAttr(next, "note");
    if (next !== comment) output = output.replace(comment, next);
    const supRe = new RegExp(`<sup>[^<]*</sup>(<!--\\s*polish:marker\\s+${escaped}\\b[^>]*-->)`);
    output = output.replace(supRe, `<sup>${label}</sup>$1`);
  };
  const applyAlignment = (notes, markers, alignment) => {
    notes.forEach((note, index) => {
      const marker = markers[index];
      if (!marker) {
        setNoteLinked(note.id, false);
        return;
      }
      const label = String(note.attrs?.label || "").trim() || String(index + 1);
      updateMarker(marker, label, note.id);
      setNoteLinked(note.id, true, alignment);
    });
    // 多出来的正文标记是重复引用；仍然按顺序给它们编号，但不绑定注文。
    for (let index = notes.length; index < markers.length; index += 1) {
      updateMarker(markers[index], String(index + 1), "");
    }
  };
  const finish = () => {
    const beforeMarkers = new Map(parsePolishMarkdown(text).markers.map((marker) => [
      marker.id,
      `${marker.label}\n${marker.note || ""}`,
    ]));
    let count = 0;
    for (const marker of parsePolishMarkdown(output).markers) {
      if (beforeMarkers.get(marker.id) !== `${marker.label}\n${marker.note || ""}`) count += 1;
    }
    return { markdown: output, changed: output !== text, count };
  };
  const chapterLike = (title) => /^(?:第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]|chapter\s+\d+|part\s+\d+)/i.test(String(title || ""));
  const findBodyTarget = (groupTitle, bodyList) => {
    const available = bodyList.filter((item) => item.markers.length && !item.markers.some((marker) => usedMarkers.has(marker.id)));
    const key = noteGroupKey(groupTitle);
    const exact = available.find((item) => noteGroupKey(item.title) === key);
    if (exact) {
      if (!chapterLike(groupTitle) && bodyList.length && exact === bodyList[0]) return null;
      return exact;
    }
    const fuzzy = available.filter((item) => noteGroupMatches(groupTitle, item.title));
    const preferred = !chapterLike(groupTitle) && bodyList.length
      ? fuzzy.filter((item) => item !== bodyList[0])
      : fuzzy;
    return preferred[0] || null;
  };

  // 有清单章节名时按真实章节对齐：正文里的 `## 彭` 这类页内小标题不是新章，
  // 它后面的标记仍属于上一章，必须一起算进去。
  const titles = (Array.isArray(chapterTitles) ? chapterTitles : [])
    .map((title) => String(title || "").trim())
    .filter(Boolean);
  if (titles.length) {
    const split = splitPolishMarkdown(source, { chapterTitles: titles });
    const notesIndex = split.chapters.findIndex((chapter) => isNoteHeading(chapter.title));
    if (notesIndex > 0) {
      const bodyList = split.chapters.slice(0, notesIndex).map((chapter, index) => ({
        index,
        title: String(chapter.title || "").trim(),
        markers: [...String(chapter.text || "").matchAll(/<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
          id: match[1],
          attrs: polishCommentAttrs(match[2]),
        })),
        notes: [...String(chapter.text || "").matchAll(/<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
          id: match[1],
          attrs: polishCommentAttrs(match[2]),
        })),
      })).filter((chapter) => chapter.markers.length || chapter.notes.length);
      // 正文里自带“注释:”的章节：先按本章自己的标记对齐。
      for (const chapter of bodyList) {
        if (!chapter.notes.length) continue;
        applyAlignment(chapter.notes, chapter.markers, "ordinal");
        for (const marker of chapter.markers) usedMarkers.add(marker.id);
      }
      const notesChapter = split.chapters[notesIndex];
      const groups = noteGroupsInText(notesChapter.text);
      if (groups.length) {
        for (const group of groups) {
          const grouped = group.title !== "" && !isNoteHeading(group.title) && isNoteGroupHeading(group.title);
          let markers;
          let alignment = "ordinal";
          if (grouped) {
            const target = findBodyTarget(group.title, bodyList);
            markers = target?.markers || [];
            alignment = "group";
            for (const marker of markers) usedMarkers.add(marker.id);
          } else {
            markers = bodyList
              .flatMap((chapter) => chapter.markers)
              .filter((marker) => !usedMarkers.has(marker.id));
            for (const marker of markers) usedMarkers.add(marker.id);
          }
          applyAlignment(group.notes, markers, alignment);
        }
        return finish();
      }
      const notes = [...String(notesChapter.text || "").matchAll(/<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
        id: match[1],
        attrs: polishCommentAttrs(match[2]),
      }));
      if (notes.length) {
        const markers = bodyList
          .flatMap((chapter) => chapter.markers)
          .filter((marker) => !usedMarkers.has(marker.id));
        for (const marker of markers) usedMarkers.add(marker.id);
        applyAlignment(notes, markers, "ordinal");
        return finish();
      }
    }
  }

  // 没有清单章节名时按 `##` 分段；适用于单章内联注释和简单的书末注释块。
  const segments = [];
  let start = 0;
  for (const match of source.matchAll(/^##\s+/gm)) {
    if (match.index > start) segments.push(source.slice(start, match.index));
    start = match.index;
  }
  segments.push(source.slice(start));
  const parsedSegments = segments.map((segment, index) => {
    const title = /^##\s+(.+?)\s*$/m.exec(segment)?.[1]?.trim() || "";
    return {
      index,
      title,
      segment,
      notes: [...segment.matchAll(/<!--\s*polish:note\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
        id: match[1],
        attrs: polishCommentAttrs(match[2]),
      })),
      markers: [...segment.matchAll(/<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g)].map((match) => ({
        id: match[1],
        attrs: polishCommentAttrs(match[2]),
      })),
    };
  });
  const bodySegments = parsedSegments.filter((item) => item.markers.length && !item.notes.length);
  for (const item of parsedSegments) {
    if (!item.notes.length) continue;
    // “## 注释”本身是注释块标题；只有“## 前言”“## 第一章: …”这类才是分组。
    // 同一段里既有正文标记又有注文时（单章内联“注释:”），按单块顺序对齐，
    // 不能把这一章误当成书末注释分组。
    const grouped = !item.markers.length && !isNoteHeading(item.title) && isNoteGroupHeading(item.title);
    let markers;
    let alignment = "ordinal";
    if (grouped) {
      const target = findBodyTarget(item.title, bodySegments);
      markers = target?.markers || [];
      alignment = "group";
      for (const marker of markers) usedMarkers.add(marker.id);
    } else {
      markers = bodySegments
        .filter((body) => body.index < item.index)
        .flatMap((body) => body.markers)
        .concat(item.markers)
        .filter((marker) => !usedMarkers.has(marker.id));
      for (const marker of markers) usedMarkers.add(marker.id);
    }
    applyAlignment(item.notes, markers, alignment);
  }
  return finish();
}

// 读取每条注文注释后面的实际文本；用户改过注号/注文后，重建用它刷新清单。
function markerContextAt(text, offset) {
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  let previous = null;
  let next = null;
  for (const match of String(text || "").matchAll(markerRe)) {
    const attrs = polishCommentAttrs(match[2]);
    const entry = { index: match.index, attrs };
    if (match.index < offset) previous = entry;
    else if (!next) next = entry;
  }
  const chosen = previous || next;
  return {
    chapter: String(chosen?.attrs?.chapter || ""),
    page: Number(chosen?.attrs?.page) || 0,
  };
}

function markerLabelAt(text, offset) {
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  const labels = [];
  for (const match of String(text || "").matchAll(markerRe)) {
    if (match.index >= offset) break;
    const attrs = polishCommentAttrs(match[2]);
    const number = Number(attrs.label);
    if (Number.isFinite(number)) labels.push(number);
  }
  if (labels.length) return Math.max(1, labels[labels.length - 1] + 1);
  const first = markerRe.exec(String(text || "").slice(offset));
  if (first) {
    const number = Number(polishCommentAttrs(first[2]).label);
    if (Number.isFinite(number)) return Math.max(1, number - 1);
  }
  return 1;
}

function markerTokenAt(text, offset) {
  const markerRe = /<!--\s*polish:marker\s+([^\s]+)([^>]*)-->/g;
  for (const match of String(text || "").matchAll(markerRe)) {
    const start = match.index;
    const end = start + match[0].length;
    const prefix = String(text || "").slice(0, start);
    const sup = /<sup>[^<]*<\/sup>$/.exec(prefix);
    const supStart = sup ? start - sup[0].length : start;
    if (offset < supStart || offset > end) continue;
    return {
      start: supStart,
      end,
      id: match[1],
      attrs: polishCommentAttrs(match[2]),
      hasSup: Boolean(sup),
    };
  }
  return null;
}

// 在正文光标处加一个标注，然后把这一部分的注文和正文标记按顺序重新对齐。
// 新标注先按前一个标注 +1 得到一个临时序号，最终序号以对齐后的注文为准。
export function insertPolishMarker(markdown, offset, { id = "", label = "", chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const at = Math.max(0, Math.min(text.length, Number(offset) || 0));
  if (markerTokenAt(text, at)) return { ok: false, error: "这里已经有一个标注，请换个位置", markdown: text };
  const openBefore = text.lastIndexOf("<!--", at);
  const closeBefore = text.lastIndexOf("-->", at);
  if (openBefore >= 0 && openBefore > closeBefore && text.indexOf("-->", at) >= at) {
    return { ok: false, error: "请把光标放到正文中，不要放进注释里", markdown: text };
  }
  const markerId = String(id || "").trim() || `marker-manual-${Date.now().toString(36)}`;
  if (new RegExp(`<!--\\s*polish:marker\\s+${escapeRegExp(markerId)}\\b`).test(text)) {
    return { ok: false, error: "标注编号冲突，请重试", markdown: text };
  }
  const context = markerContextAt(text, at);
  const nextLabel = String(label || "").trim() || String(markerLabelAt(text, at));
  const marker = `<sup>${nextLabel}</sup><!-- polish:marker ${markerId} chapter=${context.chapter} page=${context.page} label="${nextLabel}" -->`;
  const inserted = `${text.slice(0, at)}${marker}${text.slice(at)}`;
  const refreshed = refreshPolishBodyMarkers(inserted, { chapterTitles });
  const comment = new RegExp(`<!--\\s*polish:marker\\s+${escapeRegExp(markerId)}\\b([^>]*)-->`).exec(refreshed.markdown);
  const finalLabel = comment ? polishCommentAttrs(comment[1]).label : nextLabel;
  return {
    ok: true,
    markdown: refreshed.markdown,
    changed: refreshed.markdown !== text,
    count: refreshed.count,
    id: markerId,
    label: String(finalLabel || nextLabel),
    offset: at,
  };
}

// 删除光标处（或紧挨着）的标注，后续标注由顺序对齐自动减一。
export function deletePolishMarker(markdown, offset, { chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const at = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const token = markerTokenAt(text, at);
  if (!token) return { ok: false, error: "请把光标放到要删除的标注上", markdown: text };
  let removeStart = token.start;
  let removeEnd = token.end;
  if (removeStart > 0 && removeEnd < text.length
    && /\s/.test(text[removeStart - 1]) && /\s/.test(text[removeEnd])) {
    removeEnd += 1;
  }
  const next = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
  const refreshed = refreshPolishBodyMarkers(next, { chapterTitles });
  return {
    ok: true,
    markdown: refreshed.markdown,
    changed: refreshed.markdown !== text,
    count: refreshed.count,
    id: token.id,
    label: String(token.attrs.label || ""),
    offset: removeStart,
  };
}

function polishNoteEntry(text, noteId) {
  const id = escapeRegExp(noteId);
  const re = new RegExp(`(^|\\n)<!--\\s*polish:note\\s+${id}\\b[^>]*-->\\n?`);
  const match = re.exec(text);
  if (!match) return null;
  const start = match.index + (match[1] ? match[1].length : 0);
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const endMatch = /\n(?=\n|<!--\s*polish:(?:note|point|marker)\b|##\s|$)/.exec(rest);
  const bodyEnd = endMatch ? bodyStart + endMatch.index : text.length;
  return { start, end: bodyEnd, bodyStart, bodyEnd, body: text.slice(bodyStart, bodyEnd) };
}

function removeMarkerById(text, markerId) {
  const id = escapeRegExp(markerId);
  let output = text.replace(new RegExp(`<sup>[^<]*</sup><!--\\s*polish:marker\\s+${id}\\b[^>]*-->`), "");
  output = output.replace(new RegExp(`<!--\\s*polish:marker\\s+${id}\\b[^>]*-->`), "");
  return output;
}

function removePointCommentsForNote(text, noteId) {
  const id = escapeRegExp(noteId);
  return text.replace(/<!--\s*polish:point\s+[^\s]+[^>]*-->/g, (comment) => {
    const noteRe = new RegExp(`\\bnote=(?:"${id}"|${id})(?=\\s|$)`);
    return noteRe.test(comment) ? "" : comment;
  });
}

function noteNeighbors(parsed, noteId) {
  const index = parsed.notes.findIndex((note) => note.id === noteId);
  if (index < 0) return null;
  const chapter = String(parsed.notes[index].chapter || "");
  let previous = null;
  let next = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (String(parsed.notes[cursor].chapter || "") !== chapter) continue;
    previous = parsed.notes[cursor];
    break;
  }
  for (let cursor = index + 1; cursor < parsed.notes.length; cursor += 1) {
    if (String(parsed.notes[cursor].chapter || "") !== chapter) continue;
    next = parsed.notes[cursor];
    break;
  }
  return { target: parsed.notes[index], chapter, previous, next };
}

function markerMapOf(text) {
  const map = new Map();
  for (const marker of parsePolishMarkdown(text).markers) {
    if (marker.note) map.set(marker.note, marker.id);
  }
  return map;
}

function renumberFromNextNote(text, nextNote, previousLabel) {
  if (!nextNote) return text;
  const previousNumber = Number(String(previousLabel || "").trim());
  const start = Number.isFinite(previousNumber) ? Math.max(1, previousNumber + 1) : 1;
  const result = renumberPolishNotes(text, nextNote.id, start, markerMapOf(text));
  return result.changed ? result.markdown : text;
}

// 把一条误拆出来的注文并回上一条，并删掉它自己的正文标注。
export function mergePolishNoteIntoPrevious(markdown, noteId, { chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const parsed = parsePolishMarkdown(text);
  const neighbors = noteNeighbors(parsed, noteId);
  if (!neighbors) return { ok: false, error: "找不到这条注文" };
  if (!neighbors.previous) return { ok: false, error: "这是注释块第一条，前面没有可合并的注文" };
  const currentEntry = polishNoteEntry(text, noteId);
  if (!currentEntry) return { ok: false, error: "找不到这条注文的文本" };
  const continuation = currentEntry.body.trim().replace(/^\s*\d+[、.．)）]\s*/, "").trim();
  let next = `${text.slice(0, currentEntry.start)}${text.slice(currentEntry.end)}`;
  for (const marker of parsed.markers) {
    if (marker.note === noteId) next = removeMarkerById(next, marker.id);
  }
  next = removePointCommentsForNote(next, noteId);
  const previousEntry = polishNoteEntry(next, neighbors.previous.id);
  if (!previousEntry) return { ok: false, error: "找不到上一条注文的文本" };
  const previousText = previousEntry.body.trim();
  if (continuation) {
    const merged = previousText ? `${previousText}\n${continuation}` : continuation;
    next = `${next.slice(0, previousEntry.bodyStart)}${merged}${next.slice(previousEntry.bodyEnd)}`;
  }
  next = renumberFromNextNote(next, neighbors.next, neighbors.previous.label);
  return {
    ok: true,
    markdown: refreshPolishBodyMarkers(next, { chapterTitles }).markdown,
    previousId: neighbors.previous.id,
    previousLabel: String(neighbors.previous.label || ""),
    nextId: neighbors.next?.id || "",
  };
}

// 把下一条注文并进当前注文。用户在注文列表里选中 81、点“与下一条合并”时，
// 82 的文字会接在 81 后面；80 和 81 自己的文字都不会动。
export function mergePolishNoteIntoNext(markdown, noteId, { chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const parsed = parsePolishMarkdown(text);
  const neighbors = noteNeighbors(parsed, noteId);
  if (!neighbors) return { ok: false, error: "找不到这条注文" };
  const nextNote = neighbors.next;
  if (!nextNote) return { ok: false, error: "这是注释块最后一条，后面没有可合并的注文" };
  const nextEntry = polishNoteEntry(text, nextNote.id);
  if (!nextEntry) return { ok: false, error: "找不到下一条注文的文本" };
  const continuation = nextEntry.body.trim().replace(/^\s*\d+[、.．)）]\s*/, "").trim();
  let next = `${text.slice(0, nextEntry.start)}${text.slice(nextEntry.end)}`;
  for (const marker of parsed.markers) {
    if (marker.note === nextNote.id) next = removeMarkerById(next, marker.id);
  }
  next = removePointCommentsForNote(next, nextNote.id);
  const currentEntry = polishNoteEntry(next, neighbors.target.id);
  if (!currentEntry) return { ok: false, error: "找不到当前注文的文本" };
  const currentText = currentEntry.body.trim();
  if (continuation) {
    const merged = currentText ? `${currentText}\n${continuation}` : continuation;
    next = `${next.slice(0, currentEntry.bodyStart)}${merged}${next.slice(currentEntry.bodyEnd)}`;
  }
  const afterNextIndex = parsed.notes.findIndex((note) => note.id === nextNote.id) + 1;
  let following = null;
  for (let cursor = afterNextIndex; cursor < parsed.notes.length; cursor += 1) {
    if (String(parsed.notes[cursor].chapter || "") !== neighbors.chapter) continue;
    following = parsed.notes[cursor];
    break;
  }
  next = renumberFromNextNote(next, following, neighbors.target.label);
  return {
    ok: true,
    markdown: refreshPolishBodyMarkers(next, { chapterTitles }).markdown,
    currentId: neighbors.target.id,
    currentLabel: String(neighbors.target.label || ""),
    removedId: nextNote.id,
    removedLabel: String(nextNote.label || ""),
  };
}

export function deletePolishNote(markdown, noteId, { chapterTitles = [] } = {}) {
  const text = String(markdown || "");
  const parsed = parsePolishMarkdown(text);
  const neighbors = noteNeighbors(parsed, noteId);
  if (!neighbors) return { ok: false, error: "找不到这条注文" };
  const entry = polishNoteEntry(text, noteId);
  if (!entry) return { ok: false, error: "找不到这条注文的文本" };
  let next = `${text.slice(0, entry.start)}${text.slice(entry.end)}`;
  for (const marker of parsed.markers) {
    if (marker.note === noteId) next = removeMarkerById(next, marker.id);
  }
  next = removePointCommentsForNote(next, noteId);
  next = renumberFromNextNote(next, neighbors.next, neighbors.previous?.label || "");
  return {
    ok: true,
    markdown: refreshPolishBodyMarkers(next, { chapterTitles }).markdown,
    previousId: neighbors.previous?.id || "",
    nextId: neighbors.next?.id || "",
  };
}

export function collectNoteTexts(markdown) {
  const out = new Map();
  let id = "";
  let buffer = [];
  const flush = () => {
    if (!id) return;
    const text = buffer.join("\n").trim();
    if (text) out.set(id, text);
    id = "";
    buffer = [];
  };
  for (const line of String(markdown || "").replace(/\r\n/g, "\n").split("\n")) {
    const note = line.match(/^\s*<!--\s*polish:note\s+([^\s]+)/);
    if (note) {
      flush();
      id = note[1];
      continue;
    }
    if (!id) continue;
    if (/^\s*<!--\s*polish:(?:point|marker)\b/.test(line)) continue;
    if (!line.trim()) {
      if (buffer.some((item) => item.trim())) flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

function stripNoteBodyLabel(text) {
  const value = String(text || "").trim();
  const prefix = noteLabelOf(value);
  return (prefix ? value.slice(prefix.length) : value).replace(/^[\s.．、)）〕】〗]+/, "").trim();
}

function noteTextSimilarity(left, right) {
  const normalize = (value) => String(value || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/[\s\p{P}]/gu, "").toLowerCase();
  const grams = (value) => {
    const text = normalize(value);
    const set = new Set();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const a = grams(left);
  const b = grams(right);
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function splitMergedNoteBody(oldText, newNotes) {
  const body = stripNoteBodyLabel(oldText);
  const boundaries = [0];
  let cursor = 0;
  for (let index = 1; index < newNotes.length; index += 1) {
    const needleBody = stripNoteBodyLabel(newNotes[index]?.text);
    let at = -1;
    for (const size of [40, 30, 20, 14, 10, 8, 6]) {
      const needle = needleBody.slice(0, size);
      if (needle.length < 4) continue;
      const found = body.indexOf(needle, cursor);
      if (found >= 0) {
        at = found;
        break;
      }
    }
    if (at < 0) return null;
    boundaries.push(at);
    cursor = at;
  }
  boundaries.push(body.length);
  return boundaries.slice(0, -1).map((start, index) => stripNoteBodyLabel(body.slice(start, boundaries[index + 1])));
}

function noteImportRange(text, noteId) {
  const re = new RegExp(`(^|\\n)<!--\\s*polish:note\\s+${escapeRegExp(noteId)}\\b[^>]*-->\\n?`);
  const match = re.exec(text);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const endMatch = /\n(?=\n|<!--\s*polish:(?:note|point|marker)\b|##\s|$)/.exec(rest);
  const bodyEnd = endMatch ? bodyStart + endMatch.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);
  let textStart = bodyStart;
  for (const point of body.matchAll(/^\s*<!--\s*polish:point\b[^>]*-->\s*\n?/gm)) {
    textStart = bodyStart + point.index + point[0].length;
  }
  return { textStart, bodyEnd };
}

// 把旧精修里已经人工改好的注文正文迁移到新精修：按注释分组和阅读顺序对齐，
// 保留新精修的注文编号、正文链接和修正点，只替换注文正文。
// 如果旧文件里两条注文被合并过（数量少一条），自动找合并位置并拆回新文件的两条。
export function mergePolishNoteTexts(oldMarkdown, newMarkdown) {
  const oldText = String(oldMarkdown || "");
  const newText = String(newMarkdown || "");
  const oldTexts = collectNoteTexts(oldText);
  const newTexts = collectNoteTexts(newText);
  const oldEntries = parsePolishMarkdown(oldText).notes.map((note) => ({
    id: note.id,
    group: note.group || "",
    label: note.label || "",
    text: oldTexts.get(note.id) || "",
  }));
  const newEntries = parsePolishMarkdown(newText).notes.map((note) => ({
    id: note.id,
    group: note.group || "",
    label: note.label || "",
    text: newTexts.get(note.id) || "",
  }));
  const warnings = [];
  const updates = new Map();
  const groups = [...new Set(oldEntries.map((entry) => entry.group))];
  for (const group of groups) {
    const oldList = oldEntries.filter((entry) => entry.group === group);
    const newList = newEntries.filter((entry) => entry.group === group);
    if (!oldList.length || !newList.length) continue;
    const setBody = (entry, body) => {
      const clean = stripNoteBodyLabel(body);
      if (!clean) return;
      updates.set(entry.id, entry.label ? `${entry.label}、${clean}` : clean);
    };
    if (oldList.length === newList.length) {
      oldList.forEach((oldEntry, index) => setBody(newList[index], oldEntry.text));
      continue;
    }
    if (newList.length === oldList.length + 1) {
      let best = { index: 0, score: -1 };
      for (let index = 0; index < oldList.length; index += 1) {
        const joined = `${stripNoteBodyLabel(newList[index]?.text)}${stripNoteBodyLabel(newList[index + 1]?.text)}`;
        const score = noteTextSimilarity(oldList[index].text, joined);
        if (score > best.score) best = { index, score };
      }
      const mergeIndex = best.index;
      for (let index = 0; index < mergeIndex; index += 1) setBody(newList[index], oldList[index].text);
      const mergedNew = [newList[mergeIndex], newList[mergeIndex + 1]];
      const parts = splitMergedNoteBody(oldList[mergeIndex].text, mergedNew);
      if (parts) {
        parts.forEach((part, offset) => setBody(mergedNew[offset], part));
      } else {
        warnings.push(`第 ${mergeIndex + 1} 条合并注文无法自动拆分，已整条放到 ${mergedNew[0].id}`);
        setBody(mergedNew[0], oldList[mergeIndex].text);
      }
      for (let index = mergeIndex + 1; index < oldList.length; index += 1) {
        setBody(newList[index + 1], oldList[index].text);
      }
      continue;
    }
    warnings.push(`分组「${group}」注文数量不一致：旧 ${oldList.length} / 新 ${newList.length}，按顺序尽量对齐`);
    const count = Math.min(oldList.length, newList.length);
    for (let index = 0; index < count; index += 1) setBody(newList[index], oldList[index].text);
  }
  const ranges = [];
  for (const [noteId, text] of updates) {
    const range = noteImportRange(newText, noteId);
    if (range) ranges.push({ noteId, text, ...range });
    else warnings.push(`新精修里找不到注文 ${noteId}`);
  }
  ranges.sort((left, right) => right.textStart - left.textStart);
  let merged = newText;
  for (const range of ranges) {
    merged = `${merged.slice(0, range.textStart)}${range.text}${merged.slice(range.bodyEnd)}`;
  }
  return {
    markdown: merged,
    updates: ranges.length,
    warnings,
    summary: { oldNotes: oldEntries.length, newNotes: newEntries.length },
  };
}


// 去掉编辑器里仅供定位的注释，保留页锚点（重建导航还要用）。
export function stripPolishComments(markdown) {
  return String(markdown || "")
    .replace(POLISH_COMMENT_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

// 书末注释常按章分组（“## 前言”“## 第一章: 观察者”…）。这些分组标题和
// 真正的章节标题同级，但它们的正文里全是 polish:note 注文注释；真正的
// “参考书目/附录”章没有。按这个信号过滤，避免把注释章拆成十几章。
function isNoteGroupSection(lines, heading, nextLine, inNotes) {
  if (!inNotes || !isNoteGroupHeading(heading.title)) return false;
  const body = lines.slice(heading.line + 1, nextLine).join("\n");
  return /<!--\s*polish:note\b/.test(body);
}

function polishChapterHeadings(lines, chapterTitles = []) {
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (isFenceLine(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2], line: index });
  });
  const h1 = headings.filter((heading) => heading.level === 1);
  const h2 = headings.filter((heading) => heading.level === 2);
  const titleHeading = h1[0] || null;
  const candidates = h2.length ? h2 : h1.slice(titleHeading ? 1 : 0);
  const known = new Set((Array.isArray(chapterTitles) ? chapterTitles : [])
    .map((title) => String(title || "").trim())
    .filter(Boolean));
  const allowed = new Map();
  for (const title of (Array.isArray(chapterTitles) ? chapterTitles : [])) {
    const value = String(title || "").trim();
    if (value && known.has(value)) allowed.set(value, (allowed.get(value) || 0) + 1);
  }
  const used = new Map();
  const chapterHeadings = [];
  let inNotes = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const heading = candidates[index];
    const title = heading.title.trim();
    const nextLine = candidates[index + 1]?.line ?? lines.length;
    if (isNoteGroupSection(lines, heading, nextLine, inNotes)) continue;
    // 有清单章节名时只认清单里的标题；清单外的前置页小标题（出版说明、
    // 图书在版编目…）和注释分组标题不再拆章。用户改名后仍带“第 N 章”
    // 的标题按新章处理。
    const numbered = /^(?:第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]|(?:chapter|part)\s+[0-9ivxlc]+)/i.test(title);
    let boundary;
    if (known.size) {
      if (known.has(title)) {
        // 书籍目录里有几章就只切几章：重复的页眉/标题（例如前言里的“序”
        // 和正文真正的“序”）不能把同一章切成两半。清单明确列了两次同名
        // 章节时仍会按两次切分。
        boundary = (used.get(title) || 0) < (allowed.get(title) || 0);
      } else {
        boundary = !inNotes && numbered;
      }
    } else {
      boundary = true;
    }
    if (!boundary) continue;
    if (known.has(title)) used.set(title, (used.get(title) || 0) + 1);
    chapterHeadings.push(heading);
    inNotes = isNoteHeading(title);
  }
  return { titleHeading, chapterHeadings };
}

const NUMBERED_CHAPTER_RE = /^(?:第\s*[0-9０-９〇零一二三四五六七八九十百]{1,4}\s*[章节篇卷部讲]|(?:chapter|part)\s+[0-9ivxlc]+)/i;
const BACK_MATTER_HEADING_RE = /^(?:附录|参考书目|参考文献|索引|后记|译后记|跋|致谢)(?:\s|$|[:：]|[一二三四五六七八九十0-9])/i;

// 章节标题的比较键：去掉“第 N 章”和标点/空白，兼容导入旧稿时被改写的标题。
export function polishChapterKey(value) {
  return String(value || "")
    .replace(NUMBERED_CHAPTER_RE, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function markdownHeadings(lines, maxLevel = 2) {
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (isFenceLine(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match && match[1].length <= maxLevel) headings.push({ level: match[1].length, title: match[2].trim(), line: index });
  });
  return headings;
}

// 从基线/正常稿推导“真正的章节标题”。导入的旧精修稿常把章和节都写成
// `##`，所以不能把每个 ## 都当章：
// - 第一个编号章之前的 h1/h2 是前置页，保留为章；
// - 编号章是章，编号章之间的无编号 ## 是节；
// - 最后一个编号章之后的“附录/参考书目/后记…”是章，其余是节。
export function inferPolishChapterTitles(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const headings = markdownHeadings(lines, 2)
    .filter((heading) => !isNoteHeading(heading.title));
  if (!headings.length) return [];
  const firstTitle = headings[0]?.level === 1 ? 0 : -1;
  const candidates = headings.filter((heading, index) => index !== firstTitle);
  const firstNumbered = candidates.findIndex((heading) => NUMBERED_CHAPTER_RE.test(heading.title));
  if (firstNumbered < 0) {
    return candidates.filter((heading) => heading.level === 2).map((heading) => heading.title);
  }
  let lastNumbered = firstNumbered;
  candidates.forEach((heading, index) => {
    if (NUMBERED_CHAPTER_RE.test(heading.title)) lastNumbered = index;
  });
  return candidates
    .filter((heading, index) => {
      if (index <= firstNumbered) return true;
      if (NUMBERED_CHAPTER_RE.test(heading.title)) return true;
      if (index > lastNumbered && BACK_MATTER_HEADING_RE.test(heading.title)) return true;
      return false;
    })
    .map((heading) => heading.title);
}

// 把导入稿的标题层级恢复成基线结构。匹配上的标题保留为 ##（并用基线标题
// 作为规范名），其余 ## 降为 ###，这样目录有真正的章和节，而不是几十个平级章。
export function normalizePolishToc(markdown, { baselineMarkdown = "", chapterTitles = [] } = {}) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let expected = inferPolishChapterTitles(baselineMarkdown);
  if (!expected.length) expected = (Array.isArray(chapterTitles) ? chapterTitles : []).map(String).filter(Boolean);
  if (!expected.length) return { markdown: text, chapterTitles: [] };
  const headings = markdownHeadings(lines, 2);
  if (!headings.length) return { markdown: text, chapterTitles: expected };
  const firstChapterLike = headings.find((heading) => heading.level === 2);
  if (firstChapterLike && (/^第\s*1\s*章$/.test(firstChapterLike.title) || /^封面$/.test(firstChapterLike.title))
    && !expected.some((title) => polishChapterKey(title) === "封面")) {
    expected = ["封面", ...expected];
  }
  const titleLine = headings[0]?.level === 1 ? headings[0].line : -1;
  const used = new Set();
  const output = lines.slice();
  for (const heading of headings) {
    if (heading.line === titleLine) continue;
    let matched = -1;
    const title = heading.title.trim();
    if (/^第\s*1\s*章$/.test(title) || /^封面$/.test(title)) {
      matched = expected.findIndex((entry, index) => !used.has(index) && polishChapterKey(entry) === "封面");
    }
    if (matched < 0) {
      const key = polishChapterKey(title);
      matched = expected.findIndex((entry, index) => !used.has(index) && polishChapterKey(entry) === key);
    }
    if (matched >= 0) {
      used.add(matched);
      output[heading.line] = `## ${expected[matched]}`;
    } else {
      output[heading.line] = `### ${title}`;
    }
  }
  // If nothing matched the baseline, this is probably a different book (forced
  // import) or a completely renamed file; leave it untouched rather than
  // demoting all of its only chapter headings.
  if (!used.size) return { markdown: text, chapterTitles: expected, matched: 0 };
  return { markdown: output.join("\n"), chapterTitles: expected, matched: used.size };
}

// 左侧导航目录：当前 Markdown 的实时 outline。章 = ##，节 = ###，小节 = ####。
// 页内伪标题（额外的 ##）和注释分组标题不进入 outline，避免长书目录被撑爆。
export function buildPolishOutline(markdown, { chapterTitles = [] } = {}) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const { chapterHeadings } = polishChapterHeadings(lines, chapterTitles);
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (isFenceLine(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2].trim(), line: index });
  });
  const items = [];
  chapterHeadings.forEach((chapter, index) => {
    items.push({ title: chapter.title, level: 1, line: chapter.line, kind: "chapter" });
    if (isNoteHeading(chapter.title)) return;
    const nextLine = chapterHeadings[index + 1]?.line ?? lines.length;
    for (const heading of headings) {
      if (heading.line <= chapter.line || heading.line >= nextLine) continue;
      if (heading.level !== 3 && heading.level !== 4) continue;
      if (isNoteHeading(heading.title)) continue;
      items.push({ title: heading.title, level: heading.level - 1, line: heading.line, kind: "section" });
    }
  });
  return items;
}

// 把整本书 polish.md 拆成书题 + 章节，供重建和预览使用。
// 书题是第一行 `# …`；章节标题是 `## …`。若用户删掉了 `##`，退化为
// “第一个 `#` 是书题，其余 `#` 是章节”，避免整本变成一章。
export function splitPolishMarkdown(markdown, { chapterTitles = [] } = {}) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const { titleHeading, chapterHeadings } = polishChapterHeadings(lines, chapterTitles);
  if (!chapterHeadings.length) {
    const body = stripPolishComments(text).trim();
    return { title: titleHeading?.title || "", chapters: body ? [{ title: titleHeading?.title || "正文", text: body }] : [] };
  }
  const start = titleHeading ? titleHeading.line + 1 : 0;
  const chapters = chapterHeadings.map((heading, index) => {
    const from = Math.max(start, heading.line + 1);
    const to = chapterHeadings[index + 1]?.line ?? lines.length;
    return {
      title: heading.title,
      text: lines.slice(from, to).join("\n").replace(/^\n+|\n+$/g, ""),
    };
  });
  return { title: titleHeading?.title || "", chapters };
}

// 当前光标/选中点所在的章节，供右侧预览使用。
export function chapterAtOffset(markdown, offset = 0, { chapterTitles = [] } = {}) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const clamped = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const lines = text.split("\n");
  const lineStarts = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }
  const { chapterHeadings } = polishChapterHeadings(lines, chapterTitles);
  let current = null;
  for (const heading of chapterHeadings) {
    if (lineStarts[heading.line] <= clamped) current = heading;
    else break;
  }
  if (!current) return { title: "", text: "" };
  const next = chapterHeadings.find((heading) => heading.line > current.line);
  const body = lines.slice(current.line + 1, next?.line ?? lines.length).join("\n");
  return { title: current.title, text: stripPolishComments(body).trim() };
}

export function collectMarkerCandidates(markdown) {
  const text = String(markdown || "");
  const out = [];
  let match;
  const supRe = /\$\^\{([^}]*)\}\$/g;
  while ((match = supRe.exec(text))) {
    out.push({ kind: "sup", label: stripHtmlTags(match[1]), index: match.index });
  }
  const htmlSupRe = /<sup\b[^>]*>([\s\S]*?)<\/sup>/gi;
  while ((match = htmlSupRe.exec(text))) {
    out.push({ kind: "sup", label: stripHtmlTags(match[1]), index: match.index });
  }
  const bracketRe = /\[(\d{1,3})\s*\]/g;
  while ((match = bracketRe.exec(text))) {
    out.push({ kind: "sup", label: match[1], index: match.index });
  }
  CIRCLED_RE.lastIndex = 0;
  while ((match = CIRCLED_RE.exec(text))) {
    out.push({ kind: "raw", label: match[0], index: match.index });
  }
  return out;
}

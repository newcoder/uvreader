// DocVortex 的 HTML→DOCX 把列表画成「字面编号 / `-` + 缩进」的**普通段落**:
// 包里虽然带着 numbering.xml,但整份文档没有一个 `w:numPr` —— 编号是写死的文本,
// 在 Word 里不能续编号、不能改项目符号样式、不能升降层级。
//
// 这里对**书坊自己桥出去的文本源产物**(md / txt → docx)做后处理:识别这类段落、
// 去掉字面标记、补上真正的 Word 列表(`w:numPr` + numbering.xml 里追加 abstractNum/num),
// 编号连续、可继续编号、缩进与 DocVortex 原来画的一致。纯函数好测,zip 读写在最后。
import fs from "node:fs";
import JSZip from "jszip";

// DocVortex 的列表缩进单位:第 1 层 340 twips、第 2 层 680 …(实测 document.xml)。
const INDENT_UNIT = 340;
const MAX_LEVEL = 8;
const ORDERED_RE = /^(\d+)[.、]\s+/;
const BULLET_RE = /^[-*+•·]\s+/;
const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

// 段落里所有 w:t 的文字(标记检测用)。
export function paragraphText(paragraph) {
  return [...String(paragraph || "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1])
    .join("");
}

// 这个段落是 DocVortex 画出来的列表项吗?是就给出层级与标记信息。
export function listInfoOfParagraph(paragraph) {
  const text = paragraphText(paragraph);
  const indent = Number((/<w:ind\b[^>]*\bw:(?:left|start)="(\d+)"/.exec(String(paragraph || "")) || [])[1] || 0);
  const ordered = ORDERED_RE.exec(text);
  const bullet = ordered ? null : BULLET_RE.exec(text);
  const marker = ordered ? ordered[0] : bullet ? bullet[0] : "";
  // 普通正文(没缩进、或者开头不是标记)一律不动 —— 凸排的引用、代码块里的 "1. " 都不碰。
  if (!marker || indent < INDENT_UNIT) return null;
  return {
    text,
    marker,
    kind: ordered ? "ol" : "ul",
    level: Math.min(MAX_LEVEL, Math.max(0, Math.round(indent / INDENT_UNIT) - 1)),
    start: ordered ? Number(ordered[1]) || 1 : 1,
  };
}

// 段落清单(带在 document.xml 里的偏移,重写时从后往前替换)。
export function scanDocxParagraphs(xml) {
  return [...String(xml || "").matchAll(PARAGRAPH_RE)].map((match) => ({
    at: match.index,
    xml: match[0],
    list: listInfoOfParagraph(match[0]),
  }));
}

// 连续的列表段落成「一块」;块内每种 (kind, level) 各占一个编号序列。
// Word 里同一个 numId + ilvl 会自动续号,所以「1. 标题 / - 细则 / 2. 标题」能连起来;
// 普通段落打断列表(下一块从 1 重新开始,与 CommonMark 的语义一致)。
export function groupDocxLists(paragraphs) {
  const blocks = [];
  let block = null;
  for (const paragraph of paragraphs) {
    if (!paragraph.list) {
      block = null;
      continue;
    }
    if (!block) {
      block = { groups: [] };
      blocks.push(block);
    }
    const key = `${paragraph.list.kind}:${paragraph.list.level}`;
    let group = block.groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, kind: paragraph.list.kind, level: paragraph.list.level, start: paragraph.list.start, paragraphs: [] };
      block.groups.push(group);
    }
    group.paragraphs.push(paragraph);
    paragraph.group = group;
  }
  // 有序列表的字面编号必须连贯(1,2,3…):不连贯说明原文是刻意跳号,
  // 换成 Word 自动编号会改写语义 —— 这种组原样保留(留日志)。
  for (const { groups } of blocks) {
    for (const group of groups) {
      group.sequential = group.kind !== "ol"
        || group.paragraphs.every((paragraph, index) => paragraph.list.start === group.start + index);
      for (const paragraph of group.paragraphs) paragraph.list.usable = group.sequential;
    }
  }
  return blocks;
}

// 去掉段落开头的标记文字(可能被 DocVortex 拆进多个 w:t)。
function stripMarker(paragraph, count) {
  let left = count;
  return String(paragraph).replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (whole, value) => {
    if (left <= 0 || !value) return whole;
    const take = Math.min(left, value.length);
    left -= take;
    const index = whole.indexOf(value);
    return `${whole.slice(0, index)}${value.slice(take)}${whole.slice(index + value.length)}`;
  });
}

// pPr 里 numPr 必须排在 pStyle 之后(CT_PPr 的顺序),没有 pPr 就新建。
function insertNumPr(paragraph, numId, level) {
  const numPr = `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
  if (/<w:pPr(?:\s[^>]*)?\/>/.test(paragraph)) {
    return paragraph.replace(/<w:pPr(?:\s[^>]*)?\/>/, (tag) => `${tag.slice(0, -2)}>${numPr}</w:pPr>`);
  }
  if (/<w:pPr(?:\s[^>]*)?>/.test(paragraph)) {
    const style = /<w:pStyle\b[^>]*\/>/.exec(paragraph);
    if (style) return paragraph.replace(style[0], `${style[0]}${numPr}`);
    return paragraph.replace(/<w:pPr(?:\s[^>]*)?>/, (tag) => `${tag}${numPr}`);
  }
  return paragraph.replace(/^<w:p(?:\s[^>]*)?>/, (tag) => `${tag}<w:pPr>${numPr}</w:pPr>`);
}

// 缩进交给编号层级(numbering.xml 的 w:ind),段落自己的左缩进要去掉,否则会叠一层。
function dropListIndent(paragraph) {
  return paragraph.replace(/<w:ind\b([^>]*)\/>/g, (whole, attrs) => {
    const kept = attrs.replace(/\sw:(?:left|start)="[^"]*"/g, "");
    return kept.trim() ? `<w:ind${kept}/>` : "";
  });
}

// 应用编号:返回新的 document.xml。
export function rewriteDocxLists(xml, paragraphs, ids) {
  let text = String(xml || "");
  const targets = paragraphs
    .filter((paragraph) => paragraph.list && paragraph.list.usable && paragraph.group && ids.has(paragraph.group))
    .sort((a, b) => b.at - a.at);
  for (const paragraph of targets) {
    const numId = ids.get(paragraph.group);
    let body = dropListIndent(stripMarker(paragraph.xml, paragraph.list.marker.length));
    body = insertNumPr(body, numId, paragraph.list.level);
    text = text.slice(0, paragraph.at) + body + text.slice(paragraph.at + paragraph.xml.length);
  }
  return text;
}

function abstractNumXml(kind, id) {
  const levels = [];
  for (let ilvl = 0; ilvl <= MAX_LEVEL; ilvl += 1) {
    const ind = `<w:pPr><w:ind w:left="${INDENT_UNIT * (ilvl + 1)}" w:firstLine="0"/></w:pPr>`;
    const body = kind === "ol"
      ? `<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>`
      : `<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>`;
    levels.push(`<w:lvl w:ilvl="${ilvl}">${body}${ind}</w:lvl>`);
  }
  return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels.join("")}</w:abstractNum>`;
}

export function nextNumberingIds(numberingXml) {
  const abstract = [...String(numberingXml || "").matchAll(/<w:abstractNum w:abstractNumId="(\d+)"/g)].map((m) => Number(m[1]));
  const nums = [...String(numberingXml || "").matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => Number(m[1]));
  return { abstract: Math.max(-1, ...abstract) + 1, num: Math.max(0, ...nums) + 1 };
}

// 给每个组分配 numId(按组顺序),并把要追加的 abstractNum / w:num 片段拼出来。
export function planNumbering(groups, numberingXml = "") {
  const next = nextNumberingIds(numberingXml);
  const ids = new Map();
  const abstracts = [];
  const nums = [];
  const reusable = new Map(); // 同一种列表(ol/ul)复用一份 abstractNum(层级样式一致)
  let numId = next.num;
  for (const group of groups) {
    if (!group.sequential) continue;
    let abstractId = reusable.get(group.kind);
    if (abstractId === undefined) {
      abstractId = next.abstract + reusable.size;
      abstracts.push(abstractNumXml(group.kind, abstractId));
      reusable.set(group.kind, abstractId);
    }
    const override = group.start > 1 && group.kind === "ol"
      ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${group.start}"/></w:lvlOverride>`
      : "";
    nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/>${override}</w:num>`);
    ids.set(group, numId);
    numId += 1;
  }
  return { ids, abstracts, nums };
}

// 把片段插进 numbering.xml:abstractNum 必须排在所有 w:num 之前(schema 顺序)。
export function appendNumbering(numberingXml, { abstracts = [], nums = [] } = {}) {
  if (!abstracts.length && !nums.length) return numberingXml;
  let text = String(numberingXml || "");
  if (!text.trim()) {
    text = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>\n';
  }
  if (abstracts.length) {
    const firstNum = text.indexOf("<w:num ");
    if (firstNum >= 0) text = `${text.slice(0, firstNum)}${abstracts.join("")}${text.slice(firstNum)}`;
    else text = text.replace("</w:numbering>", `${abstracts.join("")}</w:numbering>`);
  }
  if (nums.length) text = text.replace("</w:numbering>", `${nums.join("")}</w:numbering>`);
  return text;
}

// 读 docx(zip)→ 换掉列表段落 → 写回。返回改掉的段落数(0 = 没有可改的)。
export async function restoreDocxLists(file, { log = () => {} } = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(file));
  } catch (error) {
    log("docx list restore skipped", String(error?.message || error));
    return 0;
  }
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) return 0;
  const xml = await documentFile.async("string");
  const paragraphs = scanDocxParagraphs(xml);
  const blocks = groupDocxLists(paragraphs);
  const groups = blocks.flatMap((block) => block.groups);
  const broken = groups.filter((group) => !group.sequential && group.kind === "ol");
  if (broken.length) log("docx list restore: non-sequential ordered list left as text", broken.length);
  const { ids, abstracts, nums } = planNumbering(groups, zip.file("word/numbering.xml") ? await zip.file("word/numbering.xml").async("string") : "");
  if (!ids.size) return 0;
  const numberingFile = zip.file("word/numbering.xml");
  const numbering = appendNumbering(numberingFile ? await numberingFile.async("string") : "", { abstracts, nums });
  zip.file("word/document.xml", rewriteDocxLists(xml, paragraphs, ids));
  zip.file("word/numbering.xml", numbering);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const count = paragraphs.filter((paragraph) => paragraph.list && paragraph.list.usable && ids.has(paragraph.group)).length;
  return count;
}

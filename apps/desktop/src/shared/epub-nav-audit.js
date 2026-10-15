// 导航目录结构审计:链接是否指得着、层级是否合法、NCX 是否与 nav 一致。
// 纯函数(输入都是字符串),体检脚本与测试共用同一套判据。
import { cleanChapterTitle } from "./markdown-fix.js";

const LINK_RE = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

function decode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// entries: [{ href, label }];depth 由 <ol>/</ol> 在标签之间的嵌套算出。
export function parseNav(navXhtml) {
  const html = String(navXhtml || "");
  const entries = [];
  for (const match of html.matchAll(LINK_RE)) {
    entries.push({ href: match[1], label: decode(match[2].replace(/<[^>]*>/g, "")).trim() });
  }
  let depth = 0;
  let maxDepth = 0;
  let balance = 0;
  for (const tag of html.matchAll(/<\/?ol\b[^>]*>/g)) {
    if (tag[0].startsWith("</")) {
      balance -= 1;
      depth = Math.max(0, depth - 1);
    } else {
      balance += 1;
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  return { entries, maxDepth, balanced: balance === 0 };
}

export function parseNcx(ncxXml) {
  const points = [...String(ncxXml || "").matchAll(/<content\s+src="([^"]+)"\s*\/?>/g)].map((match) => match[1]);
  return { points };
}

// 审计:结构问题返回 problems,统计返回 stats。
export function auditNav({ nav = "", ncx = "", fileNames = [], chapterFiles = [] } = {}) {
  const parsed = parseNav(nav);
  const ncxParsed = parseNcx(ncx);
  const files = new Set(fileNames);
  const problems = [];
  const stats = {
    entries: parsed.entries.length,
    maxDepth: parsed.maxDepth,
    linkedChapters: 0,
    unlinkedChapters: 0,
    duplicateLabels: 0,
  };

  if (!parsed.balanced) problems.push("<ol> 标签不配对(导航层级坏了)");
  if (!parsed.entries.length) problems.push("导航里一条链接都没有");
  // nav 里的 href 是相对路径(chapter-001.xhtml),而文件清单是 zip 里的完整路径(OEBPS/…),
  // 所以按「同路径或路径后缀」判定存在性。
  const exists = (href) => files.has(href) || [...files].some((name) => name.endsWith(`/${href}`));
  for (const entry of parsed.entries) {
    if (!exists(entry.href)) problems.push(`导航链接指向不存在的文件:${entry.href}`);
    if (!entry.label) problems.push(`导航条目没有文字:${entry.href}`);
    if (/[$\\^{}]/.test(entry.label)) problems.push(`导航条目里残留公式/标记:${entry.label}`);
  }
  const linked = new Set(parsed.entries.map((entry) => entry.href.split("/").pop()));
  for (const file of chapterFiles) {
    if (linked.has(file.split("/").pop())) stats.linkedChapters += 1;
    else stats.unlinkedChapters += 1;
  }
  const seen = new Map();
  for (const entry of parsed.entries) {
    const key = cleanChapterTitle(entry.label).replace(/\s+/g, "");
    if (key) seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [, count] of seen) if (count > 1) stats.duplicateLabels += 1;
  if (ncxParsed.points.length !== parsed.entries.length) {
    problems.push(`NCX(${ncxParsed.points.length} 条)与 nav(${parsed.entries.length} 条)不一致`);
  }
  return { ok: problems.length === 0, problems, stats };
}

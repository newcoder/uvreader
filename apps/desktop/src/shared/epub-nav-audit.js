// 导航目录结构审计:链接是否指得着、层级是否合法、NCX 是否与 nav 一致。
// 纯函数(输入都是字符串),体检脚本与测试共用同一套判据。
import { cleanChapterTitle } from "./markdown-fix.js";

const TAG_RE = /<(\/?)(ol|li|a)\b([^>]*)>/gi;

function decode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// entries: [{ href, label, depth }],depth = 该链接所在的 <ol> 嵌套深度。
// 顺带检查层级写法:子级 <ol> 必须是上一个 <li> 的**孩子**。写成兄弟节点是非法结构,
// 标准解析器(foliate/Calibre/ADE)只读 ol 的直接 li 孩子,子级条目会整片消失 ——
// 用户实测「目录面板只有一级」就是它(旧版的成书代码正是这么写的)。
export function parseNav(navXhtml) {
  const html = String(navXhtml || "");
  const entries = [];
  const problems = [];
  const stack = [];
  for (const match of html.matchAll(TAG_RE)) {
    const [, closing, rawTag, attrs] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (tag === "a") continue;
      const open = stack.pop();
      if (open !== tag) problems.push(`</${tag}> 与 <${open || "?"}> 不配对`);
      continue;
    }
    if (tag === "a") {
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || [])[1] || "";
      const rest = html.slice(match.index + match[0].length);
      const end = rest.indexOf("</a>");
      const label = decode(rest.slice(0, end < 0 ? 0 : end).replace(/<[^>]*>/g, "")).trim();
      entries.push({ href: decode(href), label, depth: stack.filter((name) => name === "ol").length });
      continue;
    }
    if (tag === "ol") {
      if (stack.length && stack[stack.length - 1] !== "li") {
        problems.push("子级 <ol> 没写在 <li> 里(标准阅读器会忽略这一层)");
      }
      stack.push("ol");
      continue;
    }
    stack.push("li");
  }
  const maxDepth = entries.reduce((max, entry) => Math.max(max, entry.depth), 0);
  return { entries, maxDepth, balanced: stack.length === 0, problems };
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
  for (const problem of parsed.problems || []) problems.push(`导航结构:${problem}`);
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

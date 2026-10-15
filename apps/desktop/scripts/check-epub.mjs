// EPUB 成品体检:任何 .epub 都能查,用来确认「图没丢、公式没漏、链接没断」。
//
//   node apps/desktop/scripts/check-epub.mjs "C:\\path\\to\\book.epub"
//   node apps/desktop/scripts/check-epub.mjs "book.epub" --json
//
// 退出码:0 = 通过,1 = 有问题(断链 / 未渲染的公式)。代码块里的 $$ 不算问题。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { countRawFormulas } from "../src/main/text-book.js";
import { auditNav } from "../src/shared/epub-nav-audit.js";

const file = process.argv[2];
const asJson = process.argv.includes("--json");
if (!file || !fs.existsSync(file)) {
  console.error("用法:node apps/desktop/scripts/check-epub.mjs <book.epub> [--json]");
  process.exit(2);
}

const zip = await JSZip.loadAsync(fs.readFileSync(file));
const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
const names = entries.map(([name]) => name);
const imageFiles = names.filter((name) => /\/images\/[^/]+\.(jpe?g|png|gif|webp|svg)$/i.test(name));
const pages = names.filter((name) => /\.x?html$/i.test(name) && !/(nav|toc|cover)\.x?html$/i.test(name));
const fonts = names.filter((name) => /\.(ttf|otf|woff2?)$/i.test(name));
const images = new Set(imageFiles.map((name) => name.split("/").pop()));

const report = {
  file: path.basename(file),
  bytes: fs.statSync(file).size,
  chapters: pages.length,
  images: imageFiles.length,
  fonts: fonts.length,
  mathml: 0,
  inlineMath: 0,
  unresolved: 0,        // 章节里指向缺失文件的 <img>
  rawFormulas: 0,       // 代码块以外的原始 LaTeX($$ / \tag / \( / \[)
  rawSamples: [],
  missingImages: [],
};

for (const page of pages) {
  const html = await zip.file(page).async("string");
  report.mathml += (html.match(/<math\b/g) || []).length;
  report.inlineMath += (html.match(/<math[^>]*display="inline"/g) || []).length;
  for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = match[1].replace(/^\.\//, "");
    if (!images.has(src.split("/").pop())) {
      report.unresolved += 1;
      if (report.missingImages.length < 5) report.missingImages.push(`${page}:${src}`);
    }
  }
  // 代码块里的公式是刻意保留的原文,不算漏渲染(同一套口径见 text-book.js)。
  const leftovers = countRawFormulas(html);
  report.rawFormulas += leftovers;
  if (leftovers && report.rawSamples.length < 5) {
    const prose = html.replace(/<pre[\s\S]*?<\/pre>/gi, "").replace(/<code[\s\S]*?<\/code>/gi, "");
    const at = prose.search(/\$\$|\\tag\{|\\\(|\\\[/);
    report.rawSamples.push(`${page}: ${JSON.stringify(prose.slice(Math.max(0, at - 40), at + 80).replace(/<[^>]*>/g, ""))}`);
  }
}

// 导航目录审计:链接指得着吗、层级合法吗、nav 与 NCX 一致吗。
const navName = names.find((name) => /nav\.xhtml$/i.test(name));
const ncxName = names.find((name) => /toc\.ncx$/i.test(name));
const chapters = names.filter((name) => /chapter-[^/]+\.x?html$/i.test(name));
const navAudit = auditNav({
  nav: navName ? await zip.file(navName).async("string") : "",
  ncx: ncxName ? await zip.file(ncxName).async("string") : "",
  fileNames: names,
  chapterFiles: chapters,
});

const ok = report.unresolved === 0 && report.rawFormulas === 0 && navAudit.ok;
if (asJson) {
  console.log(JSON.stringify({ ...report, nav: navAudit, ok }, null, 2));
} else {
  console.log(`${ok ? "✓" : "✗"} ${report.file}  ${(report.bytes / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  章节 ${report.chapters} · 图片 ${report.images}(断链 ${report.unresolved}) · 字体 ${report.fonts}`);
  console.log(`  MathML ${report.mathml}(行内 ${report.inlineMath}) · 未渲染公式 ${report.rawFormulas}`);
  console.log(`  导航 ${navAudit.stats.entries} 条(最大层级 ${navAudit.stats.maxDepth} · 覆盖章节 ${navAudit.stats.linkedChapters} · 未进导航 ${navAudit.stats.unlinkedChapters} · 重复标题 ${navAudit.stats.duplicateLabels})`);
  for (const sample of report.missingImages) console.log(`  断链: ${sample}`);
  for (const sample of report.rawSamples) console.log(`  未渲染: ${sample}`);
  for (const problem of navAudit.problems.slice(0, 6)) console.log(`  导航: ${problem}`);
}
process.exit(ok ? 0 : 1);

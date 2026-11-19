#!/usr/bin/env node
// Read-only audit for generated answer pages. Usage:
//   node scripts/check-quiz-pages.mjs [space-or-directory] [--json]
// Defaults to the "答题页测试" space under the desktop app's library.
import fs from "node:fs";
import path from "node:path";

import { extractQuizManifest, validateQuizManifest } from "../packages/reader/src/quiz-manifest.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const requested = args.find((arg) => !arg.startsWith("--"));
const appDataRoot = process.env.APPDATA || "";
const preferredRoot = path.join(appDataRoot, "uvreader-desktop", "library", "Spaces", "答题页测试");
const legacyRoot = path.join(appDataRoot, "qiaomu-reader-desktop", "library", "Spaces", "答题页测试");
const defaultRoot = fs.existsSync(preferredRoot) ? preferredRoot : legacyRoot;
const root = path.resolve(requested || process.env.QBR_QUIZ_DIR || defaultRoot);
if (!fs.existsSync(root)) {
  console.error(`找不到答题页目录：${root}`);
  process.exit(1);
}

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (/\.html?$/i.test(entry.name)) files.push(full);
  }
  return files;
}

const OCR_PATTERNS = [
  /\\mathrm\s*\{\s*i\s*\}\s*\\equiv/,
  /\\mid\s*\\mid/,
  /\\mathbf\s*\{\s*\\theta\s*\}/,
  /\\coprod/,
  /\\_\s*l\s*e\s*q\s*u\s*a\s*l\s*s/,
  /\\mathsf\s*\{\s*e\s*q\s*u\s*a\s*l\s*s/,
  /\\bar\s*\{\s*\\mathsf/,
];

const rows = [];
for (const file of collect(root).sort()) {
  let html = "";
  try {
    html = fs.readFileSync(file, "utf8");
  } catch (error) {
    rows.push({ file, error: `读取失败：${String(error?.message || error)}`, errors: ["读取失败"] });
    continue;
  }
  let manifest = null;
  try {
    manifest = extractQuizManifest(html);
  } catch (error) {
    rows.push({ file, error: `manifest 读取失败：${String(error?.message || error)}`, errors: ["manifest 读取失败"] });
    continue;
  }
  if (!manifest) continue; // ordinary HTML, not an answer page
  const plain = manifest.grading === "ai";
  const validation = validateQuizManifest(manifest, {
    html,
    checkHtml: true,
    checkContent: true,
    allowMissingAnswers: true,
    requireAnswers: !plain,
  });
  const rawMtext = [...html.matchAll(/<mtext\b[^>]*>([\s\S]*?)<\/mtext>/gi)]
    .filter((match) => /[\\^_{}]/.test(match[1])).length;
  const optionValueIssues = [...html.matchAll(/<input\b([^>]*)>/gi)].filter((match) => {
    const attrs = match[1];
    const data = /(?:^|\s)data-value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!data) return false;
    const value = data[1] ?? data[2] ?? data[3] ?? "";
    const current = /(?:^|\s)value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    return (current ? (current[1] ?? current[2] ?? current[3] ?? "") : "") !== value;
  }).length;
  const ocrWarnings = OCR_PATTERNS.reduce((count, pattern) => count + (html.match(pattern)?.length || 0), 0);
  const temmlErrors = (html.match(/temml-error/g) || []).length;
  const parseErrors = (html.match(/ParseError/g) || []).length;
  rows.push({
    file: path.relative(root, file).replace(/\\/g, "/"),
    bytes: Buffer.byteLength(html),
    questions: manifest.questions?.length || 0,
    grading: manifest.grading || "local",
    ok: validation.ok,
    errors: validation.errors || [],
    contentErrors: validation.contentErrors?.length || 0,
    warnings: validation.warnings?.length || 0,
    rawMtext,
    optionValueIssues,
    ocrWarnings,
    temmlErrors,
    parseErrors,
  });
}

const structural = rows.filter((row) => !row.ok || row.errors?.length || row.error);
if (asJson) {
  console.log(JSON.stringify({ root, pages: rows, structuralErrors: structural.length }, null, 2));
} else {
  console.log(`答题页审计：${root}`);
  console.log(`找到 ${rows.length} 个答题页，结构错误 ${structural.length} 个\n`);
  for (const row of rows) {
    const flags = [
      row.errors?.length ? `错误 ${row.errors.length}` : "",
      row.warnings ? `提示 ${row.warnings}` : "",
      row.contentErrors ? `内容差异 ${row.contentErrors}` : "",
      row.rawMtext ? `旧公式块 ${row.rawMtext}` : "",
      row.optionValueIssues ? `选项值缺失 ${row.optionValueIssues}` : "",
      row.ocrWarnings ? `疑似 OCR 公式 ${row.ocrWarnings}` : "",
      row.temmlErrors || row.parseErrors ? `旧 Temml 错误 ${row.temmlErrors + row.parseErrors}` : "",
    ].filter(Boolean).join(" · ");
    console.log(`${row.ok ? "✓" : "✗"} ${row.file}`);
    console.log(`  ${row.questions} 题 · ${row.grading === "ai" ? "AI 判分" : "本地判分"} · ${Math.round((row.bytes || 0) / 1024)} KB${flags ? ` · ${flags}` : ""}`);
    for (const error of (row.errors || []).slice(0, 4)) console.log(`  - ${error}`);
  }
  if (structural.length) console.log("\n结构错误需要重新生成或修复；其余标记是提示，页面可能仍可打开。");
}
process.exitCode = structural.length ? 1 : 0;

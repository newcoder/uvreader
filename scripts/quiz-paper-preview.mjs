// CLI:转换后的 Markdown → 自包含答题 HTML。
// 应用内走 apps/desktop/src/main/quiz-export.js 的同一个 buildQuizPaper。
//
// 用法:
//   node scripts/quiz-paper-preview.mjs <paper.md> <out.html> [--bank questions.json] [--answers answers.json]
import fs from "node:fs";
import path from "node:path";

import { format as clangFormat } from "@wasm-fmt/clang-format";

import { buildQuizPaper } from "../apps/desktop/src/main/quiz-export.js";

const args = process.argv.slice(2);
const [mdPath, outPath] = args;
if (!mdPath || !outPath) {
  console.error("用法:node scripts/quiz-paper-preview.mjs <paper.md> <out.html> [--bank questions.json] [--answers answers.json]");
  process.exit(1);
}
const bankPath = args.includes("--bank") ? args[args.indexOf("--bank") + 1] : "";
const answersPath = args.includes("--answers") ? args[args.indexOf("--answers") + 1] : "";

const markdown = fs.readFileSync(mdPath, "utf8");
const bank = bankPath ? JSON.parse(fs.readFileSync(bankPath, "utf8")).questions || [] : [];
const answers = answersPath ? JSON.parse(fs.readFileSync(answersPath, "utf8")) : null;
const title = path.basename(mdPath).replace(/\.[^.]+$/, "").replace(/_doc$/, "");
const files = { cpp: "main.cc", java: "Main.java", cs: "Main.cs", js: "main.js" };
const codeFormatter = (text, language) => clangFormat(
  String(text),
  files[language] || "main.cc",
  JSON.stringify({ BasedOnStyle: "LLVM", IndentWidth: 4, ColumnLimit: 0, SortIncludes: false }),
);

const result = await buildQuizPaper({
  markdown,
  baseDir: path.dirname(path.resolve(mdPath)),
  bank,
  answers,
  title,
  codeFormatter,
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result.html, "utf8");
console.log(JSON.stringify({ ...result.stats, out: path.resolve(outPath) }, null, 2));

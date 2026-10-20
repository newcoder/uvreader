// 题库 runner:源文件 → 内容提取(引擎优先)→ 规则解析 → 落盘。
//
// 产物(与 pdf_tool 的命名一致,落在源文件旁):
// - `<源名>_questions.json`:`uvreader.question-bank/v1`
// - `<源名>_questions.md`  :同一份内容的可读版
// - `<源名>_audit.json`    :解析警告 + 校验结果(给人看,不参与答题)
//
// 解析只走规则(shared/question-bank.js);模型兜底是后续阶段的事 ——
// 规则认不全时给 warning + 少给题,不猜答案。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { bankFromMarkdown, bankToMarkdown, validateBank } from "../shared/question-bank.js";

// 每个源一份独立的工作目录:提取产物里 `merged.md` 是**固定文件名**,
// 共用缓存根会让不同试卷互相串味(实测:CSP2019 的最后一题读到了另一篇光学论文)。
function workDirFor(cacheRoot, absolute) {
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return path.join(cacheRoot, "questions", `${path.basename(absolute)}-${hash}`);
}

// 题库产物写在源文件旁,但提取器给的图片链接是相对**缓存目录**的(mineru/images/…)
// → 把引用到的图片复制到 <源名>.assets/,并把文本/清单里的链接改写过去(否则图片显示不出来)。
function rebaseImages(bank, { extractedPath, outDir, stem }) {
  const sources = new Set();
  for (const question of bank.questions) {
    for (const match of String(question.stem || "").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) sources.add(match[1]);
    for (const option of question.options || []) {
      for (const match of String(option.text || "").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) sources.add(match[1]);
    }
    for (const match of String(question.analysis || "").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) sources.add(match[1]);
    for (const image of question.images || []) sources.add(String(image.src || ""));
  }
  if (!sources.size) return { copied: 0, missing: [] };
  const baseDir = path.dirname(extractedPath || "");
  const assetsDir = path.join(outDir, `${stem}.assets`);
  const mapping = new Map();
  const missing = [];
  for (const src of sources) {
    if (!src || /^(?:https?:)?\/\//i.test(src)) continue;
    if (/^[A-Za-z]:[\\/]/.test(src)) continue; // 已经是绝对路径,不动
    const from = path.resolve(baseDir, src);
    if (!fs.existsSync(from)) {
      missing.push(src);
      continue;
    }
    const name = path.basename(from);
    const to = path.join(assetsDir, name);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(from, to);
    mapping.set(src, `${stem}.assets/${name}`);
  }
  const rewrite = (text) => {
    let value = String(text || "");
    for (const [from, to] of mapping) value = value.split(`](${from})`).join(`](${to})`);
    return value;
  };
  for (const question of bank.questions) {
    question.stem = rewrite(question.stem);
    for (const option of question.options || []) option.text = rewrite(option.text);
    question.analysis = rewrite(question.analysis);
    for (const image of question.images || []) {
      if (mapping.has(image.src)) image.src = mapping.get(image.src);
    }
  }
  return { copied: mapping.size, missing };
}

export function registerQuestionRunners(workshop, {
  extractMarkdown,
  docvortex = null,
  textLayer = null,
  engine = null,
  vaultRoot = "",
  cacheRoot = "",
  log = (...args) => console.log(...args),
} = {}) {
  if (typeof extractMarkdown !== "function") throw new Error("题库 runner 需要 extractMarkdown");
  workshop.register("questions-extract", async ({ payload = {}, report = () => {}, signal }) => {
    const settings = payload?.settings || {};
    const source = String(payload?.source || "");
    if (!source) throw new Error("没有选择文件");
    const absolute = path.isAbsolute(source) ? source : path.join(vaultRoot, source);
    if (!fs.existsSync(absolute)) throw new Error(`找不到文件:${source}`);

    report({ label: "提取正文(引擎优先)…" });
    const extracted = await extractMarkdown(absolute, {
      settings,
      docvortex,
      workDir: workDirFor(cacheRoot || os.tmpdir(), absolute),
      // 数据提取页的「忽略缓存」对题库任务同样生效:勾了就真的重跑上游,而不是复用 merged.md。
      refresh: payload?.refresh === true,
      signal,
      log,
      textLayer,
      engine,
      report: (row) => report({ label: String(row?.label || "提取中…") }),
    });
    if (signal?.aborted) throw new Error("任务已取消");
    if (!extracted?.ok) throw new Error(String(extracted?.error || "提取失败"));

    report({ label: "解析题目…" });
    const { bank, warnings } = bankFromMarkdown(extracted.markdown, {
      file: path.basename(absolute),
      engine: engine && String(settings.engineUrl || "").trim() ? "engine" : "local",
    });
    const issues = validateBank(bank);
    const stem = path.basename(absolute).replace(/\.[^.]+$/, "");
    const outDir = path.dirname(absolute);
    // 图片链接改成源文件旁的 <stem>.assets/(否则相对缓存目录的 mineru/images/ 在产物旁边打不开)。
    const images = rebaseImages(bank, { extractedPath: extracted.path, outDir, stem });
    const bankPath = path.join(outDir, `${stem}_questions.json`);
    const markdownPath = path.join(outDir, `${stem}_questions.md`);
    const auditPath = path.join(outDir, `${stem}_audit.json`);
    fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2), "utf8");
    fs.writeFileSync(markdownPath, bankToMarkdown(bank), "utf8");
    fs.writeFileSync(auditPath, JSON.stringify({ warnings, issues, images, source: bank.source }, null, 2), "utf8");

    if (!bank.questions.length) {
      throw new Error(`没有识别出题目:${warnings.join(" / ") || "题号写法可能不支持(支持 1. / 1、/ 第 1 题)"}`);
    }
    if (issues.length) throw new Error(`题库校验没过(见 ${path.basename(auditPath)}):${issues.slice(0, 3).join(";")}`);
    const byType = Object.entries(bank.stats.by_type).map(([type, count]) => `${type} ${count}`).join(" · ");
    log("[questions] parsed", bank.stats.questions, "questions", bank.stats.by_type);
    return {
      output: bankPath,
      detail: `${bank.stats.questions} 题(${byType})${warnings.length ? ` · ${warnings.length} 条提示` : ""}`,
      result: {
        bank: bankPath,
        markdown: markdownPath,
        audit: auditPath,
        questions: bank.stats.questions,
        byType: bank.stats.by_type,
        warnings,
        images,
      },
    };
  });
}

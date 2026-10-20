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
import path from "node:path";

import { bankFromMarkdown, bankToMarkdown, validateBank } from "../shared/question-bank.js";

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
      workDir: cacheRoot || path.dirname(absolute),
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
    const bankPath = path.join(outDir, `${stem}_questions.json`);
    const markdownPath = path.join(outDir, `${stem}_questions.md`);
    const auditPath = path.join(outDir, `${stem}_audit.json`);
    fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2), "utf8");
    fs.writeFileSync(markdownPath, bankToMarkdown(bank), "utf8");
    fs.writeFileSync(auditPath, JSON.stringify({ warnings, issues, source: bank.source }, null, 2), "utf8");

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
      },
    };
  });
}

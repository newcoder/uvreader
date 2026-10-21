// 格式转换 → 答题页:PDF/Office → Markdown → 自包含答题 HTML。
// 答案优先取原文/题库;缺答案或解析时用主进程的 AI 运行时补齐(隐藏字段)。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { normalizeAiConfig } from "./workshop-ai.js";
import { buildQuizPaper } from "./quiz-export.js";

function workDirFor(cacheRoot, absolute) {
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return path.join(cacheRoot, "quiz", `${path.basename(absolute)}-${hash}`);
}

export function registerQuizRunners(workshop, {
  extractMarkdown,
  docvortex,
  textLayer = null,
  engine = null,
  vaultRoot = "",
  cacheRoot = "",
  aiRuntime = null,
  log = () => {},
} = {}) {
  workshop.register("quiz-export", async ({ payload = {}, report = () => {}, signal }) => {
    const settings = payload.settings || {};
    const source = String(payload.source || "");
    if (!source) throw new Error("请先选择文件");
    const absolute = path.isAbsolute(source) ? source : path.join(vaultRoot, source);
    if (!fs.existsSync(absolute)) throw new Error(`找不到文件:${source}`);
    const stem = path.basename(absolute).replace(/\.[^.]+$/, "");
    const outRaw = String(payload.out || `${stem}.quiz.html`);
    const out = path.isAbsolute(outRaw) ? outRaw : path.join(vaultRoot, outRaw);

    report({ label: "提取正文(引擎优先)…" });
    const extracted = await extractMarkdown(absolute, {
      settings,
      docvortex,
      workDir: workDirFor(cacheRoot || path.dirname(absolute), absolute),
      signal,
      log,
      textLayer,
      engine,
      refresh: payload.refresh === true,
      report: (row) => report({ label: String(row?.label || "提取中…") }),
    });
    if (signal?.aborted) throw new Error("已取消");
    if (!extracted?.ok) throw new Error(String(extracted?.error || "提取失败"));

    // 源文件旁的题库只补答案/解析,不参与正文。
    let bank = [];
    try {
      const bankPath = path.join(path.dirname(absolute), `${stem}_questions.json`);
      if (fs.existsSync(bankPath)) bank = JSON.parse(fs.readFileSync(bankPath, "utf8")).questions || [];
    } catch { bank = []; }

    const config = normalizeAiConfig(payload.config);
    const canAI = Boolean(aiRuntime && config.id && config.base && config.model
      && (!config.needsKey || config.key));
    const askAi = canAI
      ? async (messages, options = {}) => {
        const requestId = `quiz-ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const inner = options.signal;
        const onAbort = () => aiRuntime.abort(requestId);
        inner?.addEventListener?.("abort", onAbort, { once: true });
        try {
          const result = await aiRuntime.stream({
            requestId,
            config,
            messages,
            options: { timeoutMs: 120000 },
          });
          if (!result?.ok) throw new Error(result?.message || result?.reason || "AI 请求失败");
          return result.answer;
        } finally {
          inner?.removeEventListener?.("abort", onAbort);
        }
      }
      : null;

    report({ label: canAI ? "AI 识别题目 + 生成答案…" : "渲染答题页…" });
    const result = await buildQuizPaper({
      markdown: extracted.markdown,
      baseDir: path.dirname(extracted.path || absolute),
      dropImages: extracted.headerImages || [],
      bank,
      solve: askAi,
      structure: askAi,
      title: stem,
      signal,
      onProgress: (done, total) => report({ label: `AI 生成答案/解析 ${done} / ${total}` }),
    });
    if (signal?.aborted) throw new Error("已取消");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result.html, "utf8");
    const ai = result.stats.ai;
    const bits = [
      `${result.stats.units} 题`,
      `题目识别 ${result.stats.structure === "ai" ? "AI" : "规则"}`,
      `有答案 ${result.stats.answered} 题`,
    ];
    if (canAI) bits.push(`AI 补答案 ${ai.answers} · 补解析 ${ai.analyses}${ai.failed ? ` · 失败 ${ai.failed}` : ""}`);
    else bits.push("未配置 AI:仅用原文/题库答案");
    return { output: out, detail: bits.join(" · ") };
  });
}

// 格式转换 → AI 答题页(实验):提取 Markdown + 固定提示词 → 大模型生成整页 HTML,
// 再做 MathML/代码/图片收尾。与确定性 quiz-export 并行,不替换它。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { splitInlineAnswerMarkers } from "../shared/markdown-fix.js";
import { normalizeAiConfig } from "./workshop-ai.js";
import { buildQuizLlmPrompt, extractQuizLlmHtml, postprocessQuizLlmHtml } from "./quiz-llm-page.js";

function workDirFor(cacheRoot, absolute) {
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return path.join(cacheRoot, "quiz-llm", `${path.basename(absolute)}-${hash}`);
}

export function registerQuizLlmRunner(workshop, {
  extractMarkdown,
  docvortex,
  textLayer = null,
  engine = null,
  vaultRoot = "",
  cacheRoot = "",
  aiRuntime = null,
  log = () => {},
} = {}) {
  workshop.register("quiz-llm-export", async ({ payload = {}, report = () => {}, signal }) => {
    const settings = payload.settings || {};
    const source = String(payload.source || "");
    if (!source) throw new Error("请先选择文件");
    const absolute = path.isAbsolute(source) ? source : path.join(vaultRoot, source);
    if (!fs.existsSync(absolute)) throw new Error(`找不到文件:${source}`);
    const stem = path.basename(absolute).replace(/\.[^.]+$/, "");
    const outRaw = String(payload.out || `${stem}.AI答题页.html`);
    const out = path.isAbsolute(outRaw) ? outRaw : path.join(vaultRoot, outRaw);

    const config = normalizeAiConfig(payload.config);
    if (!aiRuntime || !config.id || !config.base || !config.model || (config.needsKey && !config.key)) {
      throw new Error("AI 答题页需要先配置模型:设置 → AI 助读");
    }

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

    const prompt = buildQuizLlmPrompt(splitInlineAnswerMarkers(extracted.markdown));
    const baseRequestId = `quiz-llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let requestId = "";
    const onAbort = () => { if (requestId) aiRuntime.abort(requestId); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const isCompletePage = (value) => /<html[\s>]/i.test(value)
      && /<body[\s>]/i.test(value)
      && /<\/html\s*>/i.test(value)
      && value.length >= 200;
    let raw = "";
    let page = "";
    let pageAttempts = 0;
    let lastStopReason = "";
    try {
      // Providers occasionally end a long stream before the closing tag. The
      // same request can succeed a moment later, so retry once automatically
      // instead of making the reader discover the failure and press 重试.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) throw new Error("已取消");
        pageAttempts = attempt;
        requestId = `${baseRequestId}-${attempt}`;
        report({
          label: attempt === 1
            ? "AI 生成答题页(约 1–3 分钟)…"
            : "上次输出不完整，正在自动重试(2/2)…",
        });
        const messages = [{ role: "user", content: prompt }];
        if (attempt > 1) {
          messages.unshift({
            role: "system",
            content: "上一次输出在 </html> 之前被截断。请重新输出一份完整、自包含的 HTML；CSS 和 JS 可以精简，但不要省略任何题目、选项、答案或解析。",
          });
        }
        const result = await aiRuntime.stream({
          requestId,
          config,
          messages,
          options: { timeoutMs: 600000, maxTokens: 120000 },
        });
        if (signal?.aborted) throw new Error("已取消");
        if (!result?.ok) throw new Error(String(result?.message || result?.reason || "AI 请求失败"));
        raw = String(result.answer || "");
        lastStopReason = String(result.stopReason || "");
        page = extractQuizLlmHtml(raw);
        if (isCompletePage(page)) break;
        log?.("[quiz-llm] incomplete page", JSON.stringify({
          attempt,
          chars: raw.length,
          stopReason: lastStopReason,
          head: raw.slice(0, 80).replace(/\s+/g, " "),
          tail: raw.slice(-160).replace(/\s+/g, " "),
        }));
      }
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
    if (!isCompletePage(page)) {
      throw new Error(`AI 连续 ${pageAttempts} 次返回的页面不完整(可能达到输出上限),未写入产物;请换一个输出上限更大的模型或重试`);
    }
    const processed = postprocessQuizLlmHtml(page, {
      baseDir: path.dirname(extracted.path || absolute),
      dropImages: extracted.headerImages || [],
    });
    if (!processed.stats.manifest) {
      throw new Error("AI 答题页缺少 quiz-manifest，未写入产物；请重试");
    }
    if (processed.stats.manifestErrors?.length) {
      throw new Error(`AI 答题页与 quiz-manifest 不一致：${processed.stats.manifestErrors.slice(0, 3).join("；")}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, processed.html, "utf8");
    const stats = processed.stats;
    const missingAnswers = Array.isArray(stats.manifestWarnings) ? stats.manifestWarnings.length : 0;
    return {
      output: out,
      detail: [
        `AI 生成 · ${stats.math} MathML`,
        `${stats.code} 代码块格式化`,
        `${stats.imagesInlined} 图片内联`,
        `${stats.generatedHidden} 生成答案隐藏`,
        `${stats.blankSymbols} 圆圈占位符`,
        missingAnswers ? `${missingAnswers} 题未提供答案` : "",
      ].filter(Boolean).join(" · "),
    };
  });
}

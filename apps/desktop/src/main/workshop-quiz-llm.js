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
    const requestId = `quiz-llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const onAbort = () => aiRuntime.abort(requestId);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    report({ label: "AI 生成答题页(约 1–3 分钟)…" });
    let raw = "";
    try {
      const result = await aiRuntime.stream({
        requestId,
        config,
        messages: [{ role: "user", content: prompt }],
        options: { timeoutMs: 600000, maxTokens: 120000 },
      });
      if (signal?.aborted) throw new Error("已取消");
      if (!result?.ok) throw new Error(String(result?.message || result?.reason || "AI 请求失败"));
      raw = String(result.answer || "");
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }

    const page = extractQuizLlmHtml(raw);
    if (!/<html[\s>]/i.test(page) || !/<body[\s>]/i.test(page) || !/<\/html\s*>/i.test(page) || page.length < 200) {
      throw new Error("AI 返回的页面不完整(可能达到输出上限),未写入产物;请提高 AI 最大输出或重试");
    }
    const processed = postprocessQuizLlmHtml(page, {
      baseDir: path.dirname(extracted.path || absolute),
      dropImages: extracted.headerImages || [],
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, processed.html, "utf8");
    const stats = processed.stats;
    return {
      output: out,
      detail: [
        `AI 生成 · ${stats.math} MathML`,
        `${stats.code} 代码块格式化`,
        `${stats.imagesInlined} 图片内联`,
        `${stats.generatedHidden} 生成答案隐藏`,
        `${stats.blankSymbols} 圆圈占位符`,
      ].join(" · "),
    };
  });
}

// 格式转换 → AI 答题页(实验):提取 Markdown + 固定提示词 → 大模型生成整页 HTML,
// 再做 MathML/代码/图片收尾。与确定性 quiz-export 并行,不替换它。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { splitInlineAnswerMarkers } from "../shared/markdown-fix.js";
import { spaceOutputPath } from "../../../../packages/reader/src/space-paths.js";
import { normalizeAiConfig } from "./workshop-ai.js";
import { buildQuizLlmPrompt, extractQuizLlmHtml, postprocessQuizLlmHtml } from "./quiz-llm-page.js";

function workDirFor(cacheRoot, absolute) {
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return path.join(cacheRoot, "quiz-llm", `${path.basename(absolute)}-${hash}`);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
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
    const plain = payload.plain === true || payload.mode === "plain";
    const source = String(payload.source || "");
    if (!source) throw new Error("请先选择文件");
    const absolute = path.isAbsolute(source) ? source : path.join(vaultRoot, source);
    if (!fs.existsSync(absolute)) throw new Error(`找不到文件:${source}`);
    const stem = path.basename(absolute).replace(/\.[^.]+$/, "");
    const suffix = plain ? "普通答题页.html" : "AI答题页.html";
    const routed = payload.out ? "" : spaceOutputPath(absolute, "quizzes", suffix, { exists: fs.existsSync });
    const outRaw = String(payload.out || routed || `${stem}.${suffix}`);
    const out = path.isAbsolute(outRaw) ? outRaw : path.join(vaultRoot, outRaw);

    const config = normalizeAiConfig(payload.config);
    if (!aiRuntime || !config.id || !config.base || !config.model || (config.needsKey && !config.key)) {
      throw new Error("AI 答题页需要先配置模型:设置 → AI 助读");
    }

    const startedAt = Date.now();
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
    const extractMs = Date.now() - startedAt;

    const prompt = buildQuizLlmPrompt(splitInlineAnswerMarkers(extracted.markdown), { plain });
    const baseRequestId = `quiz-llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let requestId = "";
    const onAbort = () => { if (requestId) aiRuntime.abort(requestId); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const isCompletePage = (value) => /<html[\s>]/i.test(value)
      && /<body[\s>]/i.test(value)
      && /<\/html\s*>/i.test(value)
      && value.length >= 200;
    const runGeneration = async (pass = 1, { feedback = "" } = {}) => {
      let raw = "";
      let page = "";
      let pageAttempts = 0;
      let lastStopReason = "";
      // Providers occasionally end a long stream before the closing tag. The
      // same request can succeed a moment later, so retry once automatically
      // instead of making the reader discover the failure and press 重试.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) throw new Error("已取消");
        pageAttempts = attempt;
        requestId = `${baseRequestId}-${pass}-${attempt}`;
        report({
          label: pass > 1
            ? "答题页数据不完整，正在重新生成(2/2)…"
            : attempt === 1
              ? "AI 生成答题页(约 1–3 分钟)…"
              : "上次输出不完整，正在自动重试(2/2)…",
        });
        const messages = [];
        if (pass > 1) {
          messages.push({
            role: "system",
            content: feedback || "上一次回答的 quiz-manifest 为空或缺少 questions。请重新输出完整 HTML，并确保 quiz-manifest.questions 是包含全部题目的非空数组。",
          });
        }
        if (attempt > 1) {
          messages.push({
            role: "system",
            content: "上一次输出在 </html> 之前被截断。请重新输出一份完整、自包含的 HTML；CSS 和 JS 可以精简，但不要省略任何题目、选项、答案或解析。",
          });
        }
        messages.push({ role: "user", content: prompt });
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
          pass,
          attempt,
          chars: raw.length,
          stopReason: lastStopReason,
          head: raw.slice(0, 80).replace(/\s+/g, " "),
          tail: raw.slice(-160).replace(/\s+/g, " "),
        }));
      }
      if (!isCompletePage(page)) {
        throw new Error(`AI 连续 ${pageAttempts} 次返回的页面不完整(可能达到输出上限),未写入产物;请换一个输出上限更大的模型或重试`);
      }
      return postprocessQuizLlmHtml(page, {
        baseDir: path.dirname(extracted.path || absolute),
        dropImages: extracted.headerImages || [],
        plain,
      });
    };
    try {
      let processed = await runGeneration(1);
      if (!processed.stats.manifest || !processed.stats.manifestQuestions) {
        log?.("[quiz-llm] manifest missing or empty; regenerating", JSON.stringify({
          questions: processed.stats.manifestQuestions || 0,
          errors: processed.stats.manifestErrors || [],
        }));
        try {
          processed = await runGeneration(2);
        } catch (error) {
          if (signal?.aborted) throw error;
          // A failed regeneration must not throw away a complete first page.
          log?.("[quiz-llm] regeneration failed; keeping the first page", JSON.stringify({
            error: String(error?.message || error),
          }));
        }
      }
      // The manifest is grading metadata. A complete page with question cards
      // is still readable when the model omitted it, so keep the page and say
      // what is missing instead of discarding the whole generation.
      const manifestMissing = !processed.stats.manifest || !processed.stats.manifestQuestions;
      // Empty manifest entries can be repaired from the page HTML, but a page
      // whose cards are also incomplete should get one targeted regeneration.
      // A completely empty/missing manifest already had its regeneration pass
      // above; do not spend a third request on it.
      if (!manifestMissing && processed.stats.manifestErrors?.length) {
        log?.("[quiz-llm] manifest structure errors; regenerating", JSON.stringify({
          errors: processed.stats.manifestErrors.slice(0, 8),
          repaired: processed.stats.manifestRepaired || 0,
        }));
        try {
          const retry = await runGeneration(2, {
            feedback: `上一次回答的 quiz-manifest 有结构错误：${processed.stats.manifestErrors.slice(0, 6).join("；")}。请重新输出完整 HTML，确保 questions 只包含真正可作答的题目；每道题必须有非空 stemHtml 或 stemText；选择题、多选题至少提供两个 options；不要把试卷标题、分数说明、小节标题或题号说明放进 questions。`,
          });
          if ((retry.stats.manifestErrors?.length || 0) < processed.stats.manifestErrors.length) processed = retry;
        } catch (error) {
          if (signal?.aborted) throw error;
          log?.("[quiz-llm] manifest regeneration failed; keeping the first page", JSON.stringify({
            error: String(error?.message || error),
          }));
        }
      }
      if (!manifestMissing && processed.stats.manifestErrors?.length) {
        throw new Error(`AI 答题页与 quiz-manifest 不一致：${processed.stats.manifestErrors.slice(0, 3).join("；")}`);
      }
      const hasCards = /data-quiz-id\s*=/i.test(processed.html);
      if (manifestMissing && !hasCards) {
        throw new Error("AI 答题页没有识别出题目，未写入产物；请重试或换一个输出上限更大的模型");
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, processed.html, "utf8");
      const stats = processed.stats;
      const missingAnswers = Array.isArray(stats.manifestWarnings) ? stats.manifestWarnings.length : 0;
      const contentNotes = Array.isArray(stats.manifestContentErrors) ? stats.manifestContentErrors.length : 0;
      const totalMs = Date.now() - startedAt;
      const aiMs = Math.max(0, totalMs - extractMs);
      log?.("[quiz-llm] timing", JSON.stringify({
        extractMs,
        aiMs,
        totalMs,
        questions: stats.manifestQuestions || 0,
        manifest: Boolean(stats.manifest),
      }));
      return {
        output: out,
        detail: [
          `${plain ? "普通答题页" : "AI 答题页"} · 提取 ${formatDuration(extractMs)} · AI ${formatDuration(aiMs)}`,
          `AI 生成 · ${stats.math} MathML`,
          `${stats.code} 代码块格式化`,
          `${stats.imagesInlined} 图片内联`,
          `${stats.generatedHidden} 生成答案隐藏`,
          `${stats.blankSymbols} 圆圈占位符`,
          stats.optionValues ? `${stats.optionValues} 个选项值已修复` : "",
          stats.manifestRepaired ? `${stats.manifestRepaired} 处题目数据已补齐` : "",
          missingAnswers ? `${missingAnswers} 题未提供答案` : "",
          contentNotes ? `${contentNotes} 题内容提示` : "",
          manifestMissing ? (plain ? "缺少评分数据，无法 AI 判分" : "缺少评分数据，页面仍可作答") : "",
        ].filter(Boolean).join(" · "),
      };
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
  });
}

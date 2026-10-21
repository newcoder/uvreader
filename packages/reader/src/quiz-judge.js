// Q3: judge and explain every answered question with the model.
//
// The paper may ship no standard answers at all, so the prompt asks the model
// to solve the question itself in that case and produce an explanation either
// way. Objective questions that do have a standard answer keep the
// deterministic verdict; the model analysis is still attached.
import { gradeQuestion, isAnswered } from "./quiz-attempt.js";

const JSON_RULES = "只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏。";

const TYPE_NAMES = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  true_false: "判断题",
  fill_blank: "填空题",
  short_answer: "简答题",
  program: "程序题",
  calculation: "计算题",
  proof: "证明题",
  unknown: "题目",
};

function optionLines(question) {
  return (question?.options || [])
    .map((option) => `${option.label}. ${option.text}`)
    .join("\n");
}

function answerText(value) {
  if (Array.isArray(value)) return value.join("");
  return String(value ?? "");
}

export function buildJudgeMessages(question, answer) {
  const standardAnswer = String(question?.answer || "").trim();
  const standardAnalysis = String(question?.analysis || "").trim();
  const parts = [
    `题型：${TYPE_NAMES[question?.type] || "题目"}`,
    "",
    "题目：",
    String(question?.stem || "").trim(),
  ];
  const options = optionLines(question);
  if (options) parts.push("", "选项：", options);
  parts.push("", "学生作答：", answerText(answer) || "(未作答)");
  if (standardAnswer) parts.push("", "标准答案：", standardAnswer);
  if (standardAnalysis) parts.push("", "标准解析：", standardAnalysis);
  return [
    {
      role: "system",
      content: `你是 CCF CSP 试卷的阅卷老师，负责判定作答并写出解析。${JSON_RULES}`,
    },
    {
      role: "user",
      content: [
        ...parts,
        "",
        "要求：",
        "1. 有标准答案时以标准答案为准；没有标准答案时，请自己解题得出正确答案。",
        "2. 判定学生作答：完全正确 correct、部分正确 partial、错误 wrong、未作答 blank。",
        "3. 写一段简洁的中文解析（不超过 200 字），说明关键步骤；学生答错时指出错在哪。",
        "4. JSON 字段：verdict、score（0 到 1 的数字）、answer（正确答案）、analysis（解析）。",
      ].join("\n"),
    },
  ];
}

// 生成答案(没有标准答案时):只输出 {answer, analysis};上下文(程序/小节)
// 一起给模型,阅读程序/完善程序才不会脱离代码猜。
export function buildSolveMessages(question, { context = "", section = "", knownAnswer = "" } = {}) {
  const parts = [
    `题型：${TYPE_NAMES[question?.type] || "题目"}`,
  ];
  if (section) parts.push(`小节：${section}`);
  parts.push("", "题目：", String(question?.stem || "").trim());
  const options = optionLines(question);
  if (options) parts.push("", "选项：", options);
  if (context) parts.push("", "相关程序/材料：", String(context).trim());
  if (knownAnswer) parts.push("", "已知答案（以此为准）：", String(knownAnswer).trim());
  return [
    {
      role: "system",
      content: `你是 CCF CSP 试卷的解题老师，负责给出正确答案和解析。${JSON_RULES}`,
    },
    {
      role: "user",
      content: [
        ...parts,
        "",
        "要求：",
        "1. 自己解题；选择题只给字母（多选按字母顺序），判断题给“对”或“错”，填空题给要填的内容，简答/程序题给参考答案要点。",
        "2. 解析不超过 200 字，说明关键步骤。",
        "3. JSON 字段：answer（答案）、analysis（解析）。",
        "4. 原文没有的信息不要编造；不确定时 answer 留空，并在 analysis 里说明。",
      ].join("\n"),
    },
  ];
}

export function normalizeSolve(raw) {
  if (!raw || typeof raw !== "object") return null;
  const answer = String(raw.answer ?? "").trim();
  const analysis = String(raw.analysis ?? "").trim();
  if (!answer && !analysis) return null;
  return { answer, analysis };
}

export function parseJudgeJson(text) {
  let value = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!value) return null;
  value = value.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, index + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const VERDICTS = new Set(["correct", "partial", "wrong", "blank"]);

export function normalizeJudge(raw) {
  if (!raw || typeof raw !== "object") return null;
  const verdict = String(raw.verdict || "").trim().toLowerCase();
  if (!VERDICTS.has(verdict)) return null;
  const score = Number(raw.score);
  return {
    verdict,
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
    answer: String(raw.answer ?? "").trim(),
    analysis: String(raw.analysis ?? "").trim(),
  };
}

// The deterministic verdict wins when a standard answer exists; otherwise the
// model's judgement is used. The analysis always comes from the model (it is
// the explanation the reader wants for every question).
export function mergeJudge(deterministic, ai) {
  const standard = deterministic?.status === "correct" || deterministic?.status === "wrong";
  const status = standard
    ? deterministic.status
    : (ai?.verdict === "blank" ? "unanswered" : ai?.verdict || deterministic?.status || "ungraded");
  return {
    status,
    source: standard ? "standard" : "ai",
    score: ai?.score ?? (status === "correct" ? 1 : status === "wrong" ? 0 : null),
    answer: ai?.answer || deterministic?.expected || "",
    analysis: ai?.analysis || "",
  };
}

// Judge every answered question. Unanswered ones are left alone (nothing to
// judge); deterministic results still cover them in the panel.
export async function judgeAttempt({ bank, attempt, complete, signal = null, onProgress = () => {}, concurrency = 2 } = {}) {
  const questions = (bank?.questions || []).filter((question) => isAnswered(attempt, question));
  const judgements = { ...(attempt?.judgements || {}) };
  const queue = questions.slice();
  let done = 0;
  let failed = 0;
  const total = queue.length;
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const question = queue.shift();
      const answer = (attempt.answers || {})[question.id];
      const deterministic = gradeQuestion(question, answer);
      try {
        const text = await complete(buildJudgeMessages(question, answer), { signal });
        const ai = normalizeJudge(parseJudgeJson(text));
        if (!ai) {
          failed += 1;
          continue;
        }
        judgements[question.id] = { ...mergeJudge(deterministic, ai), at: new Date().toISOString() };
        done += 1;
        onProgress(done, total, { ...judgements });
      } catch (error) {
        if (signal?.aborted) return;
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) }, worker));
  return { judgements, judged: done, failed, total, cancelled: signal?.aborted === true };
}
